import {prepareImages,IMAGE_CHUNK_BYTES,manifestSha256,type ImageMetadata} from './images.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProviderRequest, ProviderEvent, ProviderImage } from '../../shared/types.js';
import type {WorkerInference} from './types.js';
import { childEnvironment, safeError } from '../providers/process.js';
import { HerdrRuntime, type RuntimeOptions } from './runtime.js';
import { registryKey, registrationProof } from './registry.js';
import { FrameReader, frame, encode, validateFrame, validateJob, unknownOutcome, record } from './protocol.js';
import type { Binding, Bootstrap, FrameType, HerdrRuntimeContract, HerdrStatus, WorkerJob, WorkerOutcome, PaneHandle } from './types.js';
export type { HerdrStatus, WorkerJob, WorkerOutcome } from './types.js';
const exec = promisify(execFile);
interface Receipt { delegationId: string; parentRunId: string; fingerprint: string; epoch: string; status: string; registryKey: string; pids: number[]; started: boolean; pane?: PaneHandle; outcome?: WorkerOutcome; error?: string }
export interface HerdrHostOptions extends RuntimeOptions {
  runtime?: HerdrRuntimeContract;
  providerDataDir?: string;
  /** Dependency injection for private fixtures only; never accepted from a job or browser. */
  workerCommand?: string[];
  startupTimeoutMs?: number; stopTimeoutMs?: number;
}
export function processGone(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; } catch (error: any) { return error.code === 'ESRCH'; }
}
async function waitGone(pids: number[], milliseconds: number): Promise<boolean> {
  const end = Date.now() + milliseconds;
  do { if (pids.length && pids.every(processGone)) return true; await new Promise(r => setTimeout(r, 40)); } while (Date.now() < end);
  return pids.length > 0 && pids.every(processGone);
}
async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const sid = (await exec('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true })).stdout.match(/S-1-[0-9-]+/)?.[0];
    if (!sid) throw Error('Could not establish private bridge file ownership');
    await exec('icacls.exe', [path, '/inheritance:r', '/grant:r', '*' + sid + ':(OI)(CI)F'], { windowsHide: true, timeout: 5000 });
  }
}
export class HerdrHost {
  private runtime: HerdrRuntimeContract;
  private active = new Map<string, { fingerprint: string; controller: AbortController; promise: Promise<WorkerOutcome> }>();
  private closed = false;
  constructor(private dataDir: string, private options: HerdrHostOptions = {}) { this.dataDir = resolve(dataDir); this.runtime = options.runtime ?? new HerdrRuntime(this.dataDir, options); }
  inspect(): Promise<HerdrStatus> { return this.runtime.inspect(); }
  private directory(id: string): string { return join(this.dataDir, 'herdr', 'jobs', createHash('sha256').update(id).digest('hex')); }
  execute(job: WorkerJob, emit: (event: ProviderEvent) => void, interact: NonNullable<ProviderRequest['interact']>, signal: AbortSignal, beforeStart?:()=>void, observe?: (value:WorkerInference)=>void, images?:readonly ProviderImage[]): Promise<WorkerOutcome> {
    let prepared:ReturnType<typeof prepareImages>;
    try { validateJob(job); prepared=prepareImages(job.request,images); } catch (error) { return Promise.reject(error); }
    if (this.closed || signal.aborted) return Promise.reject(Error('Delegation was cancelled'));
    const snapshot = structuredClone(job);
    const fingerprint = createHash('sha256').update(JSON.stringify(prepared.manifest?{job:snapshot,imageManifest:prepared.manifest}:snapshot)).digest('hex');
    const existing = this.active.get(job.delegationId);
    if (existing) return existing.fingerprint === fingerprint ? existing.promise : Promise.reject(Error('Delegation identity was reused with different configuration'));
    const controller = new AbortController();
    const abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true });
    const promise = this.run(snapshot, fingerprint, emit, interact, controller.signal,beforeStart,observe,prepared.images,prepared.manifest).finally(() => { signal.removeEventListener('abort', abort); this.active.delete(job.delegationId); });
    this.active.set(job.delegationId, { fingerprint, controller, promise }); return promise;
  }
  private async run(job: WorkerJob, fingerprint: string, emit: (event: ProviderEvent) => void, interact: NonNullable<ProviderRequest['interact']>, signal: AbortSignal, beforeStart?:()=>void, observe?: (value:WorkerInference)=>void, images:ProviderImage[]=[], imageManifest?:ImageMetadata[]): Promise<WorkerOutcome> {
    const directory = this.directory(job.delegationId), receiptPath = join(directory, 'receipt.json'), bootstrapPath = join(directory, 'bootstrap.json');
    let prior: Receipt | undefined;
    try { prior = JSON.parse(await readFile(receiptPath, 'utf8')); } catch (error: any) { if (error.code !== 'ENOENT') throw unknownOutcome('The owned delegation receipt cannot be read; no prompt was replayed'); }
    if (prior) {
      if (prior.delegationId !== job.delegationId || prior.parentRunId !== job.parentRunId || prior.fingerprint !== fingerprint) throw Error('Delegation identity was reused with different configuration');
      if (prior.status === 'complete' && prior.outcome) return structuredClone(prior.outcome);
      if (['failed','cancelled'].includes(prior.status)) throw Error(prior.error ?? 'This delegation already ended; no prompt was replayed');
      throw unknownOutcome('This delegation has interrupted or unknown execution; reconcile it before an explicit new assignment');
    }
    const status = await this.inspect(); if (!status.available) throw Error(status.error ?? 'Herdr is unavailable; no worker dispatched');
    await privateDirectory(directory);
    const binding: Binding = { delegationId: job.delegationId, parentRunId: job.parentRunId, epoch: randomUUID(), token: randomBytes(32).toString('hex'), expiresAt: Date.now() + (job.request.maxSeconds + 45) * 1000 };
    const receipt: Receipt = { delegationId: job.delegationId, parentRunId: job.parentRunId, fingerprint, epoch: binding.epoch, status: 'launching', registryKey: registryKey(binding.token), pids: [], started: false };
    let writes = Promise.resolve();
    const persist = () => { const value = JSON.stringify(receipt); writes = writes.then(() => writeFile(receiptPath, value, { mode: 0o600 })); return writes; };
    await persist();
    let resolveTerminal!: (value: { type: string; payload: any }) => void, rejectTerminal!: (reason: Error) => void;
    const terminal = new Promise<{ type: string; payload: any }>((done, reject) => { resolveTerminal = done; rejectTerminal = reject; }); void terminal.catch(() => {});
    let allowStart!: () => void; const launchReady = new Promise<void>(done => { allowStart = done; });
    let peer: Socket | undefined, pane: PaneHandle | undefined, sequence = 0, terminalSeen = false, startRevoked = false, protocolError: Error | undefined,inferenceStarted=false,inferenceCompleted=false;
    const transferAbort=new AbortController();let imagesSent=0,imagesAcknowledged=false;
    const expectedChunks=imageManifest?.reduce((n,m)=>n+m.chunks,0)??0;
    const resultChunks:string[]=[];let resultCharacters=0;
    const sockets = new Set<Socket>(), interactions = new Map<string, AbortController>(), usedInteractions = new Set<string>();
    const expire = () => { for (const c of interactions.values()) c.abort(); interactions.clear(); };
    const send = (type: FrameType, payload: unknown) => { if (peer && !peer.destroyed) peer.write(encode(frame(binding, ++sequence, type, payload))); };
    const fail = (error: Error) => { startRevoked = true; transferAbort.abort(); images.length=0; send('cancel', {}); protocolError ??= error; expire(); rejectTerminal(error); };
    const writeImage = async (type:FrameType,payload:unknown) => {
      if(signal.aborted||transferAbort.signal.aborted||startRevoked||!peer||peer.destroyed)throw Error('Image transfer cancelled');
      const socket=peer,encoded=encode(frame(binding,++sequence,type,payload));
      const writable=socket.write(encoded);if(type==='imageChunk')imagesSent++;
      if(writable)return;
      await new Promise<void>((done,reject)=>{const clean=()=>{socket.off('drain',drained);socket.off('close',closed);socket.off('error',closed);transferAbort.signal.removeEventListener('abort',closed);};const drained=()=>{clean();done();};const closed=()=>{clean();reject(Error('Image transfer interrupted'));};socket.once('drain',drained);socket.once('close',closed);socket.once('error',closed);transferAbort.signal.addEventListener('abort',closed,{once:true});if(transferAbort.signal.aborted||socket.destroyed)closed();});
    };
    const start = async () => {
      if(signal.aborted||startRevoked||protocolError||terminalSeen){send('cancel',{});return;}
      receipt.started=true;receipt.status='running';await persist();
      if(signal.aborted||startRevoked||protocolError||terminalSeen){send('cancel',{});return;}
      beforeStart?.();if(signal.aborted||startRevoked)throw Error('Delegation was cancelled');send('start',{});
    };
    const server = createServer(socket => {
      sockets.add(socket); let lastSeq = 0, authenticated = false; let pending = Promise.resolve();
      const reader = new FrameReader(value => {
        let message;
        try { message = validateFrame(value, binding, lastSeq, authenticated ? ['imagesReady','child','event','inference','resultChunk','interaction','interactionExpired','result','failed','stopped'] : ['ready']); }
        catch (error) { if (authenticated) fail(error as Error); socket.destroy(); return; }
        if (!authenticated) {
          if (peer) { socket.destroy(); return; }
          authenticated = true; peer = socket;
        }
        if(message.type==='imagesReady'&&(!imageManifest||imagesSent!==expectedChunks||imagesAcknowledged||startRevoked)){fail(Error('Unexpected image acknowledgment'));socket.destroy();return;}
        if (terminalSeen) { fail(Error('Duplicate or late terminal bridge message')); socket.destroy(); return; }
        lastSeq = message.seq;
        if (['result','failed','stopped'].includes(message.type)) terminalSeen = true;
        pending = pending.then(async () => {
          const p = message.payload;
          if (message.type === 'ready') {
            if (!this.options.runtime && process.platform === 'win32' && !p.conpty) throw Error('Herdr worker did not have a real ConPTY');
            receipt.pids.push(p.pid); receipt.status = 'ready'; await persist(); await launchReady;
            if (signal.aborted || startRevoked || protocolError || terminalSeen) { send('cancel', {}); return; }
            if(!imageManifest){await start();return;}
            await writeImage('imageInit',{images:imageManifest});
            for(let imageIndex=0;imageIndex<imageManifest.length;imageIndex++){
              const bytes=Buffer.from(images[imageIndex].data,'base64');
              try { for(let offset=0,chunkIndex=0;offset<bytes.length;offset+=IMAGE_CHUNK_BYTES,chunkIndex++)await writeImage('imageChunk',{imageIndex,chunkIndex,data:bytes.subarray(offset,offset+IMAGE_CHUNK_BYTES).toString('base64')}); }
              finally {bytes.fill(0);}
            }
            images.length=0;
          } else if(message.type==='imagesReady') {
            if(!imageManifest||imagesAcknowledged||p.manifestSha256!==manifestSha256(imageManifest))throw Error('Image acknowledgment mismatch');
            imagesAcknowledged=true;await start();
          } else if (message.type === 'child') {
            if (!receipt.pids.includes(p.pid)) { if (p.exited) throw Error('Foreign child process exit'); receipt.pids.push(p.pid); await persist(); }
          } else if (message.type === 'event') emit(structuredClone(p));
          else if (message.type === 'inference') {
            if(p.phase==='started'){if(inferenceStarted)throw Error('Duplicate worker inference start');inferenceStarted=true;}
            else {if(!inferenceStarted||inferenceCompleted)throw Error('Invalid worker inference completion');inferenceCompleted=true;}
            observe?.(structuredClone(p));
          }
          else if(message.type==='resultChunk'){
            if(!inferenceCompleted||p.index!==resultChunks.length||resultCharacters+p.text.length>256000)throw Error('Invalid or out-of-order worker result chunks');
            resultChunks.push(p.text);resultCharacters+=p.text.length;
          }
          else if (message.type === 'interaction') {
            if (signal.aborted || usedInteractions.has(p.id) || interactions.size >= 20) throw Error('Expired or duplicate worker interaction');
            usedInteractions.add(p.id); const controller = new AbortController(); interactions.set(p.id, controller);
            void interact(structuredClone(p.prompt), AbortSignal.any([signal, controller.signal])).then(answer => {
              if (!interactions.delete(p.id) || signal.aborted || controller.signal.aborted || terminalSeen) return;
              const candidate = frame(binding, sequence + 1, 'answer', { id: p.id, answer });
              validateFrame(candidate, binding, sequence, ['answer']); send('answer', candidate.payload);
            }).catch(error => { if (!controller.signal.aborted && !signal.aborted) fail(Error(safeError(error))); });
          } else if (message.type === 'interactionExpired') { interactions.get(p.id)?.abort(); interactions.delete(p.id); }
          else {
            if(message.type==='result'&&(resultChunks.length||p.textManifest)){
              const manifest=p.textManifest,text=resultChunks.join('');
              if(!manifest||p.result.text!==''||manifest.chunks!==resultChunks.length||manifest.characters!==resultCharacters||manifest.sha256!==createHash('sha256').update(text).digest('hex'))throw Error('Worker result chunk integrity mismatch');
              p.result.text=text;delete p.textManifest;
            }
            expire(); resolveTerminal({ type: message.type, payload: p });
          }
        }).catch(error => fail(error instanceof Error ? error : Error('Bridge protocol failure')));
      });
      socket.on('data', chunk => { try { reader.push(chunk); } catch (error) { if (authenticated) fail(error as Error); socket.destroy(); } });
      socket.on('error', () => { if (authenticated && !terminalSeen) fail(unknownOutcome('Worker connection failed; outcome is unknown')); });
      socket.on('close', () => { sockets.delete(socket); if (authenticated && !terminalSeen) fail(unknownOutcome('Worker disconnected before typed completion')); });
    });
    server.maxConnections = 16;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const abort = () => { startRevoked = true; transferAbort.abort(); images.length=0; expire(); send('cancel', {}); rejectTerminal(Error('Delegation was cancelled')); };
    signal.addEventListener('abort', abort, { once: true });
    try {
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
    const address = server.address(); if (!address || typeof address === 'string') throw Error('Private bridge listener failed');
    const bootstrap: Bootstrap = { ...binding, endpoint: { host: '127.0.0.1', port: address.port }, dataDir: resolve(this.options.providerDataDir ?? this.dataDir), job, ...(imageManifest?{imageManifest}:{}),
      ...(this.runtime.socketPath && this.runtime.binary ? { herdr: { socketPath: this.runtime.socketPath, binary: this.runtime.binary } } : {}) };
    if(Buffer.byteLength(JSON.stringify(bootstrap))>128*1024)throw Error('Worker bootstrap exceeds size limit');
    await writeFile(bootstrapPath, JSON.stringify(bootstrap), { flag: 'wx', mode: 0o600 });
    const development = import.meta.url.endsWith('.ts');
    const workerPath = fileURLToPath(new URL('./worker.' + (development ? 'ts' : 'js'), import.meta.url));
    const command = this.options.workerCommand ?? [process.execPath, ...(development ? ['--import', import.meta.resolve('tsx')] : []), workerPath];
    timer = setTimeout(() => fail(Error('Herdr worker timed out; the prompt was not replayed')), (job.request.maxSeconds * 1000) + (this.options.startupTimeoutMs ?? 15_000));
      if (signal.aborted) throw Error('Delegation was cancelled');
      pane = await this.runtime.start([...command, bootstrapPath], job.request.workspace ?? directory, childEnvironment());
      receipt.pane = pane; await persist(); allowStart();
      const ended = await terminal;
      const registry = await registrationProof(join(directory, 'children.jsonl'), receipt, receipt.registryKey);
      receipt.pids = [...new Set([...receipt.pids, ...registry.pids])]; await persist();
      if (!registry.valid || !registry.complete || !registry.cleanup || !await waitGone(receipt.pids, this.options.stopTimeoutMs ?? 5000)) throw unknownOutcome('Worker completion did not prove owned process termination');
      if (protocolError) throw protocolError;
      if (signal.aborted || ended.type === 'stopped') throw Error('Delegation was cancelled');
      if (ended.type === 'failed') { if (!ended.payload.cleanup) throw unknownOutcome('Provider cleanup could not be verified'); throw Error(safeError(ended.payload.error)); }
      const outcome = ended.payload as WorkerOutcome;
      if (outcome.result.actualModel !== undefined && outcome.result.actualModel !== job.request.model) throw Error('Worker returned an unexpected model');
      // Bridge claims alone are not independent artifact verification.
      outcome.executionVerified = false;
      receipt.status = 'complete'; receipt.outcome = outcome; await persist(); return structuredClone(outcome);
    } catch (error) {
      startRevoked = true; transferAbort.abort(); images.length=0; expire(); send('cancel', {});
      const registry = await registrationProof(join(directory, 'children.jsonl'), receipt, receipt.registryKey);
      receipt.pids = [...new Set([...receipt.pids, ...registry.pids])];
      const stopped = await waitGone(receipt.pids, this.options.stopTimeoutMs ?? 5000);
      if (!stopped && pane) await this.runtime.closePane(pane).catch(() => {});
      const proven = stopped || await waitGone(receipt.pids, 1000);
      const finalRegistry = await registrationProof(join(directory, 'children.jsonl'), receipt, receipt.registryKey);
      receipt.pids = [...new Set([...receipt.pids, ...finalRegistry.pids])];
      const ambiguous = !proven || !receipt.pids.every(processGone) || !finalRegistry.valid || !finalRegistry.complete || !finalRegistry.cleanup || (error as any)?.code === 'HERDR_OUTCOME_UNKNOWN';
      receipt.status = ambiguous ? 'unknown' : signal.aborted ? 'cancelled' : 'failed';
      receipt.error = ambiguous ? safeError('Owned worker outcome or termination is unknown; no prompt was replayed. ' + safeError(error)) : safeError(error);
      await persist();
      if (ambiguous) throw unknownOutcome(receipt.error);
      throw error;
    } finally {
      transferAbort.abort();images.length=0;clearTimeout(timer); signal.removeEventListener('abort', abort); expire(); allowStart();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(done => server.close(() => done()));
      await rm(bootstrapPath, { force: true });
      if (pane && receipt.pids.length && receipt.pids.every(processGone)) await this.runtime.closePane(pane).catch(() => {});
    }
  }
  async reconcile(delegationId: string): Promise<{ stopped: boolean; error?: string }> {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(delegationId)) return { stopped: false, error: 'Invalid delegation identity' };
    if (this.active.has(delegationId)) return { stopped: false, error: 'Delegation is still attached to an active worker' };
    try {
      const receipt = JSON.parse(await readFile(join(this.directory(delegationId), 'receipt.json'), 'utf8'));
      if (!record(receipt) || receipt.delegationId !== delegationId || !Array.isArray(receipt.pids) || !receipt.pids.length || !receipt.pids.every((pid: unknown) => typeof pid === 'number' && processGone(pid)))
        return { stopped: false, error: 'Owned process exit cannot be proved; live or reused PIDs are never killed during reconciliation' };
      const proof = await registrationProof(join(this.directory(delegationId), 'children.jsonl'), receipt as unknown as Receipt, receipt.registryKey);
      if (!proof.valid || !proof.complete || !proof.cleanup || !proof.pids.length || !proof.pids.every(processGone)) return { stopped: false, error: 'Durable provider registration or cleanup proof is incomplete' };
      return { stopped: true };
    } catch { return { stopped: false, error: 'No valid owned process receipt is available' }; }
  }
  async close(): Promise<void> {
    this.closed = true; for (const value of this.active.values()) value.controller.abort();
    const results = await Promise.allSettled([...this.active.values()].map(value => value.promise));
    const unknown = results.find(r => r.status === 'rejected' && r.reason?.code === 'HERDR_OUTCOME_UNKNOWN');
    if (unknown?.status === 'rejected') throw unknown.reason;
  }
}
