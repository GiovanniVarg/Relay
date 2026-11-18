import { mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ProviderAdapter, ProviderConnection, ProviderEvent, ProviderRequest, ProviderResult } from '../../shared/types.js';
import { boundedPrompt, childEnvironment, killOwned, OwnedProcess, safeError, type Command, type Launcher } from './process.js';
import type { CursorOperation, CursorWorkerEvent } from './cursor-worker.js';
import { createAppToolSession } from '../app-tools-bridge.js';
import { assertCursorJson, boundedCursorAppTools, cursorRequestData, CURSOR_WIRE_BYTES, CURSOR_WORKER_HEAP_MIB } from './cursor-session-runtime.js';

export function cursorEnvironment(home: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = childEnvironment(source);
  return { ...env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'),
    CURSOR_CONFIG_DIR: join(home, '.cursor'), CURSOR_DATA_DIR: join(home, '.cursor'), NO_OPEN_BROWSER: '1' };
}
export interface CursorAdapterOptions { command?: Command; launcher?: Launcher; kill?: ConstructorParameters<typeof OwnedProcess>[8] }
const launchWorker: Launcher = (command, args, cwd, env) => spawn(command.file, [...command.args, ...args], {
  cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
}) as ChildProcessWithoutNullStreams;
async function stopWorker(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (child.connected) {
    try { child.send({ type: 'cancel' }, () => {}); } catch { /* Fall back to owned process-tree termination. */ }
    let timer: NodeJS.Timeout | undefined;
    const closed = await Promise.race([new Promise<boolean>(done => child.once('close', () => done(true))),
      new Promise<boolean>(done => { timer = setTimeout(() => done(false), 1500); })]);
    clearTimeout(timer);
    if (closed) return;
  }
  await killOwned(child);
}
export class CursorAdapter implements ProviderAdapter {
  readonly id = 'cursor' as const;
  private active = new Set<OwnedProcess>();
  private loginJob?: OwnedProcess;
  constructor(private dataDir: string, private options: CursorAdapterOptions = {}) {}
  private async start(operation: CursorOperation, seconds: number, onValue: (value: CursorWorkerEvent) => void, signal?: AbortSignal): Promise<OwnedProcess> {
    const payload = operation.operation === 'stream' ? { ...operation, usageDeadlineAt: Date.now() + seconds * 1000 } : operation;
    assertCursorJson(payload, CURSOR_WIRE_BYTES); const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized, 'utf8') > CURSOR_WIRE_BYTES) throw new Error('Cursor operation exceeds the wire safety limit');
    const home = resolve(this.dataDir, this.id, 'home'), cwd = join(home, 'workspace');
    await Promise.all([mkdir(cwd, { recursive: true }), mkdir(join(home, '.cursor'), { recursive: true }),
      mkdir(join(home, 'AppData', 'Local'), { recursive: true }), mkdir(join(home, 'AppData', 'Roaming'), { recursive: true })]);
    const development = import.meta.url.endsWith('.ts');
    const worker = fileURLToPath(new URL(`./cursor-worker.${development ? 'ts' : 'js'}`, import.meta.url));
    const command = this.options.command ?? { file: process.execPath, args: ['--max-old-space-size=' + CURSOR_WORKER_HEAP_MIB, ...(development ? ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href] : []), worker] };
    const job = new OwnedProcess(command, [], cwd, cursorEnvironment(home), seconds, onValue, signal,
      this.options.launcher ?? launchWorker, this.options.kill ?? stopWorker);
    this.active.add(job);
    job.input(serialized); return job;
  }
  private async dispose(job: OwnedProcess): Promise<void> { this.active.delete(job); await job.stop(); }
  async inspect(): Promise<ProviderConnection> {
    const base: ProviderConnection = { id: this.id, installed: false, authenticated: false, authMode: 'unknown', accountLabel: '', plan: '', models: [] };
    try { createRequire(import.meta.url).resolve('@cursor/sdk'); } catch { return { ...base, error: 'Install Relay’s official Cursor SDK dependency to connect Cursor.' }; }
    base.installed = true;
    let job: OwnedProcess | undefined;
    try {
      let state: Extract<CursorWorkerEvent, { type: 'inspection' }> | undefined;
      job = await this.start({ operation: 'inspect' }, 30, value => {
        if (value.type === 'error') throw new Error(value.error);
        if (value.type === 'inspection') state = value;
      });
      const exit = await job.finished;
      if (exit.code !== 0 || !state) throw new Error('Cursor connector ended before reporting account status');
      return { ...base, authenticated: state.authenticated, authMode: state.authenticated ? 'subscription' : 'unknown',
        accountLabel: state.accountLabel, plan: state.plan, models: state.models, error: state.error };
    } catch (error) { return { ...base, error: safeError(error) }; }
    finally { if (job) await this.dispose(job); }
  }
  async login() {
    if (this.active.size) throw new Error('Wait for active Cursor operations to finish before connecting another account');
    let resolveUrl!: (value: string) => void;
    const urlPromise = new Promise<string>(done => { resolveUrl = done; });
    const job = await this.start({ operation: 'login' }, 300, value => {
      if (value.type === 'error') throw new Error(value.error);
      if (value.type === 'login-url') {
        const url = new URL(value.url);
        if (url.protocol !== 'https:' || !['cursor.com', 'www.cursor.com'].includes(url.hostname)) throw new Error('Cursor returned an unexpected login URL');
        resolveUrl(url.href);
      }
    });
    this.loginJob = job;
    try {
      const url = await Promise.race([urlPromise, job.finished.then(() => { throw new Error('Cursor login ended before returning a sign-in URL'); })]);
      void job.finished.finally(async () => { if (this.loginJob === job) this.loginJob = undefined; await this.dispose(job); }).catch(() => {});
      return { url, message: 'Sign in on the official Cursor page. Cursor creates an expiring user credential for Relay; it is stored locally and uses your Cursor plan. Confirm your model allowance separately.' };
    } catch (error) { this.loginJob = undefined; await this.dispose(job); throw new Error(safeError(error)); }
  }
  async stream(request: ProviderRequest, emit: (event: ProviderEvent) => void, signal: AbortSignal): Promise<ProviderResult> {
    assertCursorJson(cursorRequestData(request), CURSOR_WIRE_BYTES);
    boundedPrompt(request);
    if (this.loginJob) throw new Error('Complete Cursor browser sign-in and refresh connections before sending');
    const appTools = request.appTools ? createAppToolSession(boundedCursorAppTools(request.appTools), signal) : undefined;
    if (appTools && request.mode !== 'chat') { appTools.close(); throw new Error('Cursor Relay app tools support app-only Chat transport; native Agent tools are unavailable'); }
    const wireRequest = cursorRequestData(request);
    let result: ProviderResult | undefined; let workerReportedError = false;
    const incomplete = () => Object.assign(new Error('Cursor local worker exited before a successful result; provider execution or effects may remain unknown'), {code:'PROVIDER_OUTCOME_UNKNOWN' as const});
    let job: OwnedProcess | undefined;
    try {
    job = await this.start({ operation: 'stream', request: { ...wireRequest, ...(appTools ? { appTools: { definitions: appTools.definitions } } : {}) } as ProviderRequest }, request.maxSeconds, value => {
      try {
      assertCursorJson(value);
      if (value.type === 'error') { workerReportedError = true; throw new Error(value.error); }
      if (value.type === 'delta') emit({ type: 'delta', text: value.text });
      if (value.type === 'tool') emit({ type: 'tool', name: value.name, summary: value.summary });
      if (value.type === 'app-tool-call') {
        if (!appTools || result) throw new Error('Cursor requested an unavailable Relay app tool after terminal output');
        void appTools.call(value.callId, value.name, value.args).then(result => {
          if (!signal.aborted && job?.child.connected) job.child.send({ type: 'app-tool-result', callId: value.callId, ok: true, value: result }, () => {});
        }, () => { if (!signal.aborted && job?.child.connected) job.child.send({ type: 'app-tool-result', callId: value.callId, ok: false }, () => {}); });
      }
      if (value.type === 'result') {
        if (result) throw new Error('Cursor returned more than one terminal result');
        result = { text: value.text, usage: value.usage, usageCounters:value.usageCounters, sessionId: value.sessionId, sessionUsage:value.sessionUsage, ...(value.continuity?{continuity:value.continuity}:{}) };
        appTools?.close();
      }
      } catch (error) { appTools?.close(); throw error; }
    }, signal);
      const exit = await job.finished;
      if (!result) throw incomplete();
      if (exit.code !== 0) throw new Error('Cursor connector ended before a successful result');
      return result;
    } catch (error) {
      if (job && !result && !workerReportedError && !signal.aborted && (job.child.exitCode !== null || job.child.signalCode !== null)) throw incomplete();
      throw error;
    } finally { appTools?.close(); if (job) await this.dispose(job); }
  }
  async close(): Promise<void> { await Promise.all([...this.active].map(job => { job.fail(new Error('Provider closed')); return this.dispose(job); })); this.loginJob = undefined; }
}
