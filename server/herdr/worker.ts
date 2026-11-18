import type {AccountDescriptor} from '../../shared/accounts.js';
import {ImageAssembler,validateManifest,manifestSha256} from './images.js';
import {requestImages} from '../attachment-context.js';
import { readFile, lstat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { resolve, isAbsolute, dirname, join } from 'node:path';
import { ChildRegistry, registryKey } from './registry.js';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { InteractionAnswer, ProviderAdapter, ProviderId, ProviderResult, ProviderImage } from '../../shared/types.js';
import { CodexAdapter } from '../providers/codex.js';
import { ClaudeAdapter } from '../providers/claude.js';
import { CursorAdapter } from '../providers/cursor.js';
import { launch, JsonLines, safeError, type Launcher } from '../providers/process.js';
import { validateJob, validateFrame, FrameReader, frame, encode, record,resultFrames } from './protocol.js';
import { herdrCall } from './runtime.js';
import { WindowsTreeGuard } from './tree-guard.js';
import type { Bootstrap, FrameType } from './types.js';
export interface WorkerOptions {
  /** Explicit dependency injection for private fixtures, never loaded from the bootstrap/job. */
  createAdapter?: (provider: ProviderId, dataDir: string, launcher: Launcher,account?:AccountDescriptor) => ProviderAdapter;
}
const samePath = (a: string, b: string) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
async function readBootstrap(path: string): Promise<Bootstrap> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024) throw Error('Invalid private worker bootstrap');
  const b = JSON.parse(await readFile(path, 'utf8'));
  if (!record(b) || !record(b.endpoint) || b.endpoint.host !== '127.0.0.1' || !Number.isSafeInteger(b.endpoint.port) || b.endpoint.port < 1 || b.endpoint.port > 65535
    || typeof b.token !== 'string' || !/^[a-f0-9]{64}$/.test(b.token) || typeof b.epoch !== 'string' || !/^[a-z0-9-]{36}$/i.test(b.epoch)
    || !Number.isFinite(b.expiresAt) || b.expiresAt < Date.now() || b.expiresAt > Date.now() + 3_700_000
    || typeof b.dataDir !== 'string' || !isAbsolute(b.dataDir)) throw Error('Invalid private worker bootstrap');
  validateJob(b.job);if(b.imageManifest!==undefined)validateManifest(b.imageManifest);
  if (b.delegationId !== b.job.delegationId || b.parentRunId !== b.job.parentRunId) throw Error('Worker bootstrap identity mismatch');
  return b as Bootstrap;
}
export async function runWorker(path: string, options: WorkerOptions = {}): Promise<void> {
  const bootstrap = await readBootstrap(path);
  const registry = new ChildRegistry(join(dirname(path), 'children.jsonl'), bootstrap, registryKey(bootstrap.token));
  registry.append('worker', { pid: process.pid });
  let seq = 0, lastSeq = 0, started = false, disconnected = false;
  const controller = new AbortController();
  const assembler=bootstrap.imageManifest?new ImageAssembler(bootstrap.job.request,bootstrap.imageManifest):undefined;
  let imageTable:ProviderImage[]|undefined,imagesValidated=false;
  const pending = new Map<string, { done: (answer: InteractionAnswer) => void; reject: (reason: Error) => void; expire: () => void }>();
  const children = new Set<ChildProcessWithoutNullStreams>(), closed = new Set<ChildProcessWithoutNullStreams>();
  const evidence: string[] = [];
  let resolveStart!: () => void, rejectStart!: (error: Error) => void;
  const ready = new Promise<void>((done, reject) => { resolveStart = done; rejectStart = reject; }); void ready.catch(() => {});
  const socket = createConnection(bootstrap.endpoint);
  const send = (type: FrameType, payload: unknown) => { if (!disconnected && !socket.destroyed) {const encoded=encode(frame(bootstrap,seq+1,type,payload));socket.write(encoded);seq++;} };
  const expireAll = () => { for (const waiter of [...pending.values()]) waiter.expire(); };
  const abort = () => { imageTable=undefined;assembler?.clear();controller.abort(); rejectStart(Error('Worker cancelled')); expireAll(); };
  let reportSeq = Date.now() * 1000;
  const report = async (state: 'working' | 'blocked' | 'idle' | 'release', sessionId?: string) => {
    process.stdout.write('Relay bridge: ' + state + '\n');
    const h = bootstrap.herdr;
    if (!h || process.env.HERDR_ENV !== '1' || !process.env.HERDR_SOCKET_PATH || !process.env.HERDR_BIN_PATH
      || !samePath(process.env.HERDR_SOCKET_PATH, h.socketPath) || !samePath(process.env.HERDR_BIN_PATH, h.binary)
      || !/^w[a-z0-9]+:p[a-z0-9]+$/i.test(process.env.HERDR_PANE_ID ?? '')) return;
    const base = { pane_id: process.env.HERDR_PANE_ID, source: 'relay:bridge', agent: 'relay-worker', seq: ++reportSeq };
    try {
      if (state === 'release') await herdrCall(h.socketPath, 'pane.release_agent', base, 350);
      else await herdrCall(h.socketPath, 'pane.report_agent', { ...base, state, ...(sessionId ? { agent_session_id: sessionId } : {}), resume_argv: null }, 350);
    } catch { /* Visibility reports never grant authority or affect the provider result. */ }
  };
  const launcher: Launcher = (command, args, cwd, env) => {
    const launchId = crypto.randomUUID(); registry.append('intent', { launchId });
    const child = bootstrap.job.provider === 'cursor'
      ? spawn(command.file, [...command.args, ...args], { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe','pipe','pipe','ipc'] }) as ChildProcessWithoutNullStreams
      : launch(command, args, cwd, env);
    registry.append('spawn', { launchId, pid: child.pid ?? null });
    children.add(child);
    if (child.pid) send('child', { pid: child.pid, exited: false });
    child.once('close', () => { registry.append('exit', { launchId, pid: child.pid ?? null }); closed.add(child); if (child.pid) send('child', { pid: child.pid, exited: true }); });
    if (bootstrap.job.provider === 'openai') {
      const observer = new JsonLines(value => {
        const item = value.params?.item;
        if (value.method === 'item/completed' && item?.type === 'commandExecution')
          evidence.push('Native command status=' + String(item.status).slice(0,40) + '; exit=' + String(item.exitCode).slice(0,20) + '; artifacts not independently verified');
      });
      child.stdout.on('data', value => { try { observer.push(value); } catch { /* Main adapter validates the authoritative protocol. */ } });
    }
    return child;
  };
  const createAdapter = options.createAdapter ?? ((provider: ProviderId, dataDir: string, ownedLauncher: Launcher,account?:AccountDescriptor) => provider === 'openai'
    ? new CodexAdapter(dataDir, { launcher: ownedLauncher }) : provider === 'claude'
      ? new ClaudeAdapter(dataDir, { launcher: ownedLauncher,isolatedProfile:!!account }) : provider === 'cursor' ? new CursorAdapter(dataDir, { launcher: ownedLauncher }) : (()=>{throw Error('This provider has no verified Herdr worker transport');})());
  let adapter: ProviderAdapter | undefined, result: ProviderResult | undefined, failure: unknown, guard: WindowsTreeGuard | undefined, nativeStarted = false;
  const reader = new FrameReader(value => {
    const message = validateFrame(value, bootstrap, lastSeq, ['imageInit','imageChunk','start','answer','cancel']); lastSeq = message.seq;
    if (message.type === 'cancel') { abort(); return; }
    if(message.type==='imageInit'||message.type==='imageChunk'){
      if(!assembler||started||imagesValidated||controller.signal.aborted)throw Error('Unexpected image transfer');
      if(message.type==='imageInit')assembler.init(message.payload);else assembler.chunk(message.payload);
      if(assembler.complete){imageTable=assembler.finish();imagesValidated=true;assembler.clear();send('imagesReady',{manifestSha256:manifestSha256(bootstrap.imageManifest!)});}return;
    }
    if (message.type === 'start') { if (started || controller.signal.aborted || !!assembler&&!imagesValidated) throw Error('Worker cannot start twice or after cancellation'); started = true; resolveStart(); return; }
    const waiter = pending.get(message.payload.id);
    if (!waiter || controller.signal.aborted) throw Error('Unknown or expired worker approval answer');
    pending.delete(message.payload.id); waiter.done(message.payload.answer);
  });
  socket.on('data', chunk => { try { reader.push(chunk); } catch { failure = Error('Invalid parent bridge message'); abort(); socket.destroy(); } });
  socket.on('error', () => { disconnected = true; failure = Error('Parent bridge connection failed'); abort(); });
  socket.on('close', () => { disconnected = true; abort(); });
  const timer = setTimeout(abort, (bootstrap.job.request.maxSeconds + 20) * 1000);
  try {
    await new Promise<void>((done, reject) => { socket.once('connect', done); socket.once('error', reject); });
    send('ready', { pid: process.pid, conpty: process.stdout.isTTY === true });
    await ready;
    if (controller.signal.aborted) throw Error('Worker cancelled before dispatch');
    const guardLaunchId = crypto.randomUUID(); registry.append('intent', { launchId: guardLaunchId });
    guard = await WindowsTreeGuard.create(dirname(path), child => {
      registry.append('spawn', { launchId: guardLaunchId, pid: child.pid ?? null }); children.add(child);
      if (child.pid) send('child', { pid: child.pid, exited: false });
      child.once('close', () => { registry.append('exit', { launchId: guardLaunchId, pid: child.pid ?? null }); closed.add(child); if (child.pid) send('child', { pid: child.pid, exited: true }); });
    });
    registry.append('guard', { pid: guard.child.pid! });
    if (controller.signal.aborted) throw Error('Worker cancelled before native dispatch');
    await report('working'); nativeStarted = true;
    requestImages({...bootstrap.job.request,...(imageTable?{imageTable}:{})});
    const account=bootstrap.job.account,profileDirectory=account?join(bootstrap.dataDir,'accounts',account.accountId):bootstrap.dataDir;
    adapter = createAdapter(bootstrap.job.provider, profileDirectory, launcher,account);
    if (adapter.id !== bootstrap.job.provider) throw Error('Worker adapter provider mismatch');
    send('inference',{phase:'started'});
    result = await adapter.stream({ ...bootstrap.job.request, ...(imageTable?{imageTable}:{}), ...(bootstrap.job.request.mode === 'agent' ? {
      interact: (prompt, signal) => new Promise<InteractionAnswer>((done, reject) => {
        if (controller.signal.aborted || signal?.aborted) { reject(Error('Worker interaction expired')); return; }
        const id = crypto.randomUUID();
        const expire = () => { if (!pending.delete(id)) return; send('interactionExpired', { id }); reject(Error('Worker interaction expired')); };
        const clean = () => signal?.removeEventListener('abort', expire);
        pending.set(id, { done: answer => { clean(); void report('working'); done(answer); }, reject, expire: () => { clean(); expire(); } });
        signal?.addEventListener('abort', expire, { once: true });
        void report('blocked'); send('interaction', { id, prompt });
      })
    } : {}) }, event => {
      if(event.type==='delta'){for(let start=0;start<event.text.length;start+=65536)send('event',{type:'delta',text:event.text.slice(start,start+65536)});}
      else send('event',event);
    }, controller.signal);
    send('inference',{phase:'completed',result:{text:'',...(result.usage?{usage:result.usage}:{}),...(result.usageCounters?{usageCounters:result.usageCounters}:{}),...(result.sessionUsage?{sessionUsage:result.sessionUsage}:{}),...(result.actualModel?{actualModel:result.actualModel}:{}),...(result.sessionId?{sessionId:result.sessionId}:{})}});
    if (result.actualModel !== undefined && result.actualModel !== bootstrap.job.request.model) throw Error('Native adapter returned an unexpected model');
  } catch (error) { failure ??= error; }
  finally {
    imageTable=undefined;assembler?.clear();expireAll(); clearTimeout(timer);
    try { await adapter?.close(); } catch (error) { failure ??= error; }
    let treeProved = !nativeStarted;
    if (guard) {
      try {
        const descendants = await guard.drain();
        for (const pid of descendants) {
          const launchId = crypto.randomUUID(); registry.append('intent', { launchId }); registry.append('spawn', { launchId, pid }); registry.append('exit', { launchId, pid });
        }
        await guard.release(); treeProved = true;
      } catch (error) { failure ??= error; treeProved = false; }
    }
    await new Promise(done => setImmediate(done));
    const cleanup = treeProved && [...children].every(child => closed.has(child));
    registry.append('complete', { cleanup, treeScope: guard ? 'windows-job' : 'not-started' });
    if (!disconnected) {
      if (controller.signal.aborted) send('stopped', { cleanup });
      else if (failure || !result || !cleanup) send('failed', { error: safeError(failure ?? 'Provider termination could not be proved'), cleanup });
      else {
        try {
          const frames=resultFrames(bootstrap,seq,{result,executionVerified:false,evidence:evidence.length?evidence.slice(0,100):['Native adapter completed; no independent artifact verification was requested']});
          for(const item of frames)send(item.type,item.payload);
        }catch(error){send('failed',{error:safeError(error),cleanup});}
      }
    }
    await report('idle', result?.sessionId); await report('release');
    socket.end();
  }
}
if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  void runWorker(process.argv[2] ?? '').then(() => process.exit(0), () => { process.stderr.write('Relay bridge could not start safely\n'); process.exit(1); });
}
