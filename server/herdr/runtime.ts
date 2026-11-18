import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { createConnection } from 'node:net';
import { childEnvironment, safeError } from '../providers/process.js';
import { unknownOutcome } from './protocol.js';
import type { HerdrRuntimeContract, HerdrStatus, PaneHandle } from './types.js';
const exec = promisify(execFile);
export const HERDR_VERSION = '0.9.5';
export const HERDR_WINDOWS_SHA256 = 'cd877c8744296f4a38a2703bf13cf11728973649ec54959959c4587ffe5368b2';
export const HERDR_ARCHIVE_SHA256 = 'd2c6c9c971c43a0bfdde8c692a9a1a7a45c3e4807cd01ae45662b4734fac1cbf';
export const HERDR_RELEASE_URL = 'https://github.com/herdrdev/herdr/releases/download/v0.9.5/herdr-windows-x86_64.zip';
export function nativeEndpoint(path: string): string { return process.platform === 'win32' && !path.startsWith('\\\\.\\pipe\\') ? '\\\\.\\pipe\\' + path : path; }
export async function herdrCall(socketPath: string, method: string, params: unknown, timeout = 5000): Promise<any> {
  return new Promise((done, reject) => {
    const socket = createConnection(nativeEndpoint(socketPath)); let buffer = Buffer.alloc(0);
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { socket.destroy(); reject(Error('Herdr API timed out; command was not retried')); }, timeout);
    const fail = (error: unknown) => { clearTimeout(timer); socket.destroy(); reject(error); };
    socket.once('error', fail);
    socket.once('connect', () => socket.write(JSON.stringify({ id, method, params }) + '\n'));
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 4 * 1024 * 1024) return fail(Error('Herdr response exceeds the size limit'));
      const n = buffer.indexOf(10); if (n < 0) return;
      try {
        const response = JSON.parse(buffer.subarray(0, n).toString('utf8'));
        if (response.id !== id || !response.result || response.error) throw Error('Herdr rejected ' + method + ': ' + String(response.error?.code ?? 'invalid response'));
        clearTimeout(timer); socket.end(); done(response.result);
      } catch (error) { fail(error); }
    });
    socket.once('close', () => { clearTimeout(timer); reject(Error('Herdr disconnected before acknowledgement; command was not retried')); });
  });
}
export interface RuntimeOptions { binary?: string; session?: string }
export class HerdrRuntime implements HerdrRuntimeContract {
  readonly binary: string;
  readonly socketPath: string;
  private root: string;
  private session: string;
  private env: NodeJS.ProcessEnv;
  constructor(dataDir: string, options: RuntimeOptions = {}) {
    this.binary = resolve(options.binary ?? join('.data-herdr-tools', HERDR_VERSION, process.platform === 'win32' ? 'herdr.exe' : 'herdr'));
    this.root = resolve(dataDir, 'herdr', 'runtime');
    this.session = options.session ?? 'relay-' + createHash('sha256').update(resolve(dataDir)).digest('hex').slice(0, 12);
    if (!/^relay-[a-z0-9-]{1,48}$/.test(this.session)) throw Error('Herdr requires a dedicated Relay session name');
    this.env = { ...childEnvironment(), HERDR_CONFIG_PATH: join(this.root, 'config.toml'),
      APPDATA: join(this.root, 'appdata'), LOCALAPPDATA: join(this.root, 'localappdata'),
      XDG_CONFIG_HOME: join(this.root, 'config') };
    const base = join(this.env.XDG_CONFIG_HOME!, 'herdr');
    this.socketPath = join(base, 'sessions', this.session, 'herdr.sock');
  }
  async inspect(): Promise<HerdrStatus> {
    try {
      const bytes = await readFile(this.binary);
      if (process.platform !== 'win32' || process.arch !== 'x64') return { available: false, error: 'This private Herdr build supports Windows x64; configure a verified platform release before delegation.' };
      if (createHash('sha256').update(bytes).digest('hex') !== HERDR_WINDOWS_SHA256) throw Error('Private Herdr binary checksum does not match the pinned official release');
      const version = (await exec(this.binary, ['--version'], { env: this.env, windowsHide: true, timeout: 5000 })).stdout.trim();
      if (version !== 'herdr ' + HERDR_VERSION) throw Error('Unsupported Herdr version');
      const schema = JSON.parse((await exec(this.binary, ['api','schema','--json'], { env: this.env, windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 })).stdout);
      const methods = JSON.stringify(schema.schemas?.request);
      if (!['workspace.create','layout.apply','pane.close','pane.report_agent','pane.report_agent_session','pane.release_agent','session.snapshot'].every(m => methods?.includes(JSON.stringify(m))))
        throw Error('Herdr is missing required bridge API capabilities');
      return { available: true, version: HERDR_VERSION };
    } catch { return { available: false, error: 'Verified private Herdr 0.9.5 is unavailable. Install it with scripts/install-herdr.ps1 or configure its pinned binary; no worker was dispatched.' }; }
  }
  private async ensure(): Promise<void> {
    const status = await this.inspect(); if (!status.available) throw Error(status.error);
    try { await herdrCall(this.socketPath, 'ping', {}, 1000); return; } catch { /* Only the dedicated private session may be started. */ }
    await mkdir(this.root, { recursive: true });
    await writeFile(join(this.root, 'config.toml'), 'onboarding = false\n[terminal]\ndefault_shell = "C:/Windows/System32/cmd.exe"\n[update]\nversion_check = false\nmanifest_check = false\n[session]\nresume_agents_on_restore = false\n');
    const server = spawn(this.binary, ['--session', this.session, 'server'], { cwd: this.root, env: this.env, windowsHide: true, detached: false, stdio: 'ignore' });
    let spawnError = false; server.once('error', () => { spawnError = true; }); server.unref();
    for (let i = 0; i < 60 && !spawnError; i++) {
      try { await herdrCall(this.socketPath, 'ping', {}, 500); return; } catch { await new Promise(r => setTimeout(r, 100)); }
    }
    throw Error('Private Herdr session could not start; no worker was dispatched');
  }
  async start(command: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<PaneHandle> {
    await this.ensure();
    let workspaceId: string | undefined;
    try {
      const created = await herdrCall(this.socketPath, 'workspace.create', { cwd, label: 'Relay worker', focus: false });
      workspaceId = created.workspace?.workspace_id;
      if (typeof workspaceId !== 'string' || !/^w[a-z0-9]+$/i.test(workspaceId)) throw Error('Herdr returned an invalid workspace');
      const layout = await herdrCall(this.socketPath, 'layout.apply', { workspace_id: workspaceId, tab_label: 'Relay bridge', focus: false,
        root: { type: 'pane', cwd, label: 'Relay worker', command, env: Object.fromEntries(Object.entries(env).filter((p): p is [string,string] => typeof p[1] === 'string')) } });
      const paneId = layout.layout?.focused_pane_id;
      if (typeof paneId !== 'string' || !paneId.startsWith(workspaceId + ':p')) throw Error('Herdr returned an invalid worker pane');
      if (created.root_pane?.pane_id) await herdrCall(this.socketPath, 'pane.close', { pane_id: created.root_pane.pane_id }).catch(() => {});
      return { workspaceId, paneId };
    } catch (error) { throw unknownOutcome('Herdr launch acknowledgement is ambiguous; the worker command was not retried. ' + safeError(error)); }
  }
  async closePane(pane: PaneHandle): Promise<void> { await herdrCall(this.socketPath, 'pane.close', { pane_id: pane.paneId }); }
}
