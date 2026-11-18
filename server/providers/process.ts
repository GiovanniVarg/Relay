import {canonicalConversation} from '../context-wire.js';
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, mkdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export interface Command { file: string; args: string[] }
export type Launcher = (command: Command, args: string[], cwd: string, env: NodeJS.ProcessEnv) => ChildProcessWithoutNullStreams;
export const launch: Launcher = (command, args, cwd, env) => spawn(command.file, [...command.args, ...args], {
  cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: 'pipe',
});
const exists = async (file: string) => access(file, constants.F_OK).then(() => true, () => false);

/** Resolve known npm entries directly: a .cmd/.ps1 shim is never passed to a shell. */
export async function findCommand(name: 'codex' | 'claude'): Promise<Command | null> {
  const dirs = (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean);
  for (const directory of dirs) {
    const dir = resolve(directory.replace(/^"|"$/g, ''));
    const native = join(dir, process.platform === 'win32' ? `${name}.exe` : name);
    if (await exists(native)) return { file: native, args: [] };
    const pkg = name === 'codex' ? '@openai/codex' : '@anthropic-ai/claude-code';
    const roots = [join(dir, 'node_modules', pkg), join(dir, '..', pkg)];
    for (const root of roots) {
      if (name === 'codex' && process.platform === 'win32') {
        const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
        const triple = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
        for (const vendor of [join(root, 'node_modules', '@openai', `codex-win32-${arch}`, 'vendor'),
          join(root, '..', `codex-win32-${arch}`, 'vendor'), join(root, 'vendor')]) {
          const executable = join(vendor, triple, 'bin', 'codex.exe');
          if (await exists(executable)) return { file: executable, args: [] };
        }
      }
      if (name === 'claude' && await exists(join(root, 'bin', 'claude.exe'))) return { file: join(root, 'bin', 'claude.exe'), args: [] };
      const entry = join(root, name === 'codex' ? 'bin/codex.js' : 'cli.js');
      if (await exists(entry)) return { file: process.execPath, args: [entry] };
    }
  }
  return null;
}

/** Deliberately exclude API keys, alternate provider routes, NODE_OPTIONS and injected CLI configuration. */
export function childEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = /^(path|pathext|systemroot|windir|comspec|temp|tmp|home|userprofile|homedrive|homepath|appdata|localappdata|programfiles|programfiles\(x86\)|programdata|username|lang|lc_all|term)$/i;
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) if (allowed.test(key)) env[key] = value;
  if (!env.HOME) env.HOME = source.USERPROFILE ?? source.HOME;
  return env;
}

export function safeError(value: unknown): string {
  const message = value instanceof Error ? value.message : typeof value === 'string' ? value : 'Provider request failed';
  return message.replace(/\b(?:sk-[\w-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, '[redacted]')
    .replace(/((?:access|refresh|id)[_-]?token|api[_-]?key|authorization)(["'\s:=]+)[^\s,}"']+/gi, '$1$2[redacted]')
    .slice(0, 600);
}
export function providerOutcomeUnknown(message: string): Error & { code: 'PROVIDER_OUTCOME_UNKNOWN' } {
  const reason = message.replace(/^(?:Provider process-tree termination is unknown:\s*)+/, '');
  return Object.assign(new Error('Provider process-tree termination is unknown: ' + safeError(reason)), { code: 'PROVIDER_OUTCOME_UNKNOWN' as const });
}

export class JsonLines {
  private decoder = new StringDecoder('utf8');
  private buffer = '';
  private bufferBytes = 0;
  private bytes = 0;
  // Streaming is internal to protocols whose consumers separately bound retained state.
  // Other providers and short-lived/auth exchanges keep the cumulative limit.
  constructor(private onValue: (value: any) => void, private maxBytes = 4 * 1024 * 1024, private maxLine = 1024 * 1024,
    private mode: 'cumulative' | 'streaming' = 'cumulative') {}
  push(chunk: Buffer | string): void {
    if (this.mode === 'cumulative') {
      this.bytes += Buffer.byteLength(chunk);
      if (this.bytes > this.maxBytes) throw new Error('Provider output exceeded the safety limit');
    }
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    let start = 0, index: number;
    while ((index = text.indexOf('\n', start)) >= 0) {
      this.append(text.slice(start, index));
      const line = this.buffer.trim();
      this.buffer = ''; this.bufferBytes = 0;
      if (line) this.parse(line);
      start = index + 1;
    }
    this.append(text.slice(start));
  }
  end(): void {
    this.append(this.decoder.end());
    if (this.buffer.trim()) this.parse(this.buffer.trim());
    this.buffer = ''; this.bufferBytes = 0;
  }
  private append(text: string): void {
    const paired = this.buffer.length > 0 && text.length > 0 && /[\uD800-\uDBFF]/.test(this.buffer.at(-1)!) && /[\uDC00-\uDFFF]/.test(text[0]);
    const bytes = this.bufferBytes + Buffer.byteLength(text) - (paired ? 2 : 0);
    if (bytes > this.maxLine) throw new Error('Provider JSON line exceeded the safety limit');
    this.buffer += text; this.bufferBytes = bytes;
  }
  private parse(line: string): void {
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error('Provider returned malformed JSON'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Provider returned invalid protocol data');
    this.onValue(value);
  }
}

export async function killOwned(child: ChildProcessWithoutNullStreams): Promise<void> {
  const pid = child.pid;
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0 || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    const failed = await new Promise<boolean>(done => execFile(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, error => done(Boolean(error))));
    if (failed && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      throw providerOutcomeUnknown('The operating system refused provider process-tree termination');
    }
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}

export class OwnedProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly finished: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private readonly didClose: Promise<void>;
  private rejectFinished!: (error: Error) => void;
  private timer: NodeJS.Timeout;
  private abort: () => void;
  private signal?: AbortSignal;
  private closed = false;
  private failure?: Error;
  private stderrSize = 0;
  private killPromise?: Promise<void>;
  private queuedInputBytes = 0;
  private readonly maxQueuedInputBytes?: number;
  constructor(command: Command, args: string[], cwd: string, env: NodeJS.ProcessEnv, seconds: number,
    onValue: (value: any) => void, signal?: AbortSignal, launcher: Launcher = launch,
    private kill: (child: ChildProcessWithoutNullStreams) => Promise<void> = killOwned, outputFormat: 'jsonl' | 'json' = 'jsonl', outputLimits?:{total:number;line:number;mode?:'cumulative'|'streaming';inputQueueBytes?:number}) {
    if (signal?.aborted) throw new Error('Run cancelled');
    this.maxQueuedInputBytes = outputLimits?.inputQueueBytes;
    this.child = launcher(command, args, cwd, env);
    this.didClose = new Promise(done => this.child.once('close', () => done()));
    this.finished = new Promise((done, reject) => {
      this.rejectFinished = reject;
      this.child.once('error', () => this.fail(new Error('Provider process could not start')));
      this.child.once('close', (code, exitSignal) => {
        this.closed = true;
        this.cleanup();
        if (!this.failure) try {
          if (outputFormat === 'json') {
            let parsed: unknown;
            try { parsed = JSON.parse(jsonOutput); } catch { throw new Error('Provider returned malformed JSON'); }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Provider returned invalid protocol data');
            onValue(parsed);
          } else parser.end();
        } catch (error) { this.failure ??= error as Error; }
        if (this.failure) reject(this.failure); else done({ code, signal: exitSignal });
      });
    });
    // Consumers may be awaiting an RPC before awaiting exit. Never leave an unhandled rejection.
    void this.finished.catch(() => {});
    const parser = new JsonLines(onValue,outputLimits?.total,outputLimits?.line,outputLimits?.mode);
    const jsonDecoder = new StringDecoder('utf8');
    let jsonOutput = '';
    this.child.stdout.on('data', chunk => {
      if (this.failure) return;
      try {
        if (outputFormat === 'json') {
          jsonOutput += jsonDecoder.write(chunk);
          if (jsonOutput.length > 256 * 1024) throw new Error('Provider output exceeded the safety limit');
        } else parser.push(chunk);
      } catch (error) { this.fail(error as Error); }
    });
    this.child.stderr.on('data', chunk => {
      this.stderrSize += Buffer.byteLength(chunk);
      if (this.stderrSize > 256 * 1024) this.fail(new Error('Provider diagnostic output exceeded the safety limit'));
    });
    this.child.stdin.on('error', () => this.fail(new Error('Provider input pipe closed')));
    this.signal = signal;
    this.abort = () => this.fail(new Error('Run cancelled'));
    signal?.addEventListener('abort', this.abort, { once: true });
    this.timer = setTimeout(() => this.fail(new Error('Provider timed out')), Math.max(1, Math.min(seconds, 3600)) * 1000);
    this.timer.unref();
  }
  write(value: unknown): void {
    if (this.closed || this.failure) return;
    if (this.maxQueuedInputBytes === undefined) { this.child.stdin.write(`${JSON.stringify(value)}\n`); return; }
    let release = () => {};
    try {
      const frame = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
      if (this.queuedInputBytes + frame.length > this.maxQueuedInputBytes) { this.fail(new Error('Provider input queue exceeded the safety limit')); return; }
      this.queuedInputBytes += frame.length;
      let released = false;
      release = () => { if (!released) { released = true; this.queuedInputBytes -= frame.length; } };
      // A write callback releases this reservation only when Node has handled
      // that frame. A stalled reader cannot free capacity by completing more RPCs.
      this.child.stdin.write(frame, error => { release(); if (error) this.fail(new Error('Provider input pipe closed')); });
    } catch {
      release(); this.fail(new Error('Provider input could not be serialized or queued'));
    }
  }
  input(text: string): void { this.child.stdin.end(text); }
  fail(error: Error): void {
    if (this.failure || this.closed) return;
    this.failure = error;
    this.cleanup();
    if (this.maxQueuedInputBytes !== undefined) this.child.stdin.destroy();
    this.rejectFinished(error);
    this.killPromise ??= this.kill(this.child);
    void this.killPromise.catch(() => {});
  }
  async stop(): Promise<void> {
    this.cleanup();
    if (this.killPromise) await this.confirmKill();
    if (this.closed) return;
    if (!this.failure) {
      if (this.maxQueuedInputBytes !== undefined && this.queuedInputBytes) this.child.stdin.destroy();
      else this.child.stdin.end();
      await this.waitForClose(100);
    }
    if (!this.closed) { this.killPromise ??= this.kill(this.child); await this.confirmKill(); }
    if (!await this.waitForClose(5000)) throw providerOutcomeUnknown('Provider process did not stop after cancellation');
  }
  private async confirmKill(): Promise<void> {
    try { await this.killPromise; } catch (error) { throw providerOutcomeUnknown(safeError(error)); }
  }
  private async waitForClose(milliseconds: number): Promise<boolean> {
    if (this.closed) return true;
    let timer: NodeJS.Timeout | undefined;
    const result = await Promise.race([this.didClose.then(() => true), new Promise<boolean>(done => { timer = setTimeout(() => done(false), milliseconds); })]);
    clearTimeout(timer); return result;
  }
  private cleanup(): void { clearTimeout(this.timer); this.signal?.removeEventListener('abort', this.abort); }
}

export async function ensureWorkspace(dataDir: string, provider: string): Promise<string> {
  const path = resolve(dataDir, provider, 'workspace');
  await mkdir(path, { recursive: true });
  return path;
}

export function boundedPrompt(request: import('../../shared/types.js').ProviderRequest): string {
  if (request.instructions.length + request.history.reduce((n, item) => n + item.content.length, 0) > 80_000)
    throw new Error('Conversation exceeds the provider context limit');
  if (!request.history.length || request.history.at(-1)?.role !== 'user') throw new Error('Conversation must end in a user message');
  // JSON escaping keeps embedded fake role delimiters inside the original message's content.
  return canonicalConversation(request.history);
}

/** Work mode needs an absolute, existing directory (the server already realpath-validated it; this is defense in depth). */
export async function workDirectory(request: import('../../shared/types.js').ProviderRequest): Promise<string> {
  const path = request.workspace;
  if (!path || typeof path !== 'string' || !isAbsolute(path) || path.includes('\u0000')) throw new Error('Work mode requires an absolute workspace folder');
  const info = await stat(path).catch(() => null);
  if (!info?.isDirectory()) throw new Error('Work mode workspace folder does not exist');
  return path;
}

/** One-line, bounded, secret-redacted description of a tool call for progress display. */
export function toolSummary(value: unknown): string {
  const text = typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value) ?? '';
  return safeError(text.replace(/\s+/g, ' ').trim()).slice(0, 200);
}
