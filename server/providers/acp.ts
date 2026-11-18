import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ProviderAdapter, ProviderConnection, ProviderEvent, ProviderRequest, ProviderResult } from '../../shared/types.js';
import { createAppToolsBridge, type AppTools } from '../app-tools-bridge.js';
import { boundedPrompt, childEnvironment, OwnedProcess, safeError, toolSummary, workDirectory, type Command, type Launcher } from './process.js';
import { createAcpLauncher } from './acp-launcher.js';

export type AcpProvider = 'gemini' | 'grok';
export interface AcpIdentity { accountLabel: string; plan: string }
export interface AcpOptions { command?: () => Promise<Command | null>; launcher?: Launcher; kill?: (child: ChildProcessWithoutNullStreams) => Promise<void> }
const object = (value: unknown): value is Record<string, any> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** ACP is JSON-RPC over bounded JSONL. Native file, terminal and approval requests never gain authority here. */
export class AcpClient {
  private nextId = 0;
  private pending = new Map<number, { method: string; resolve(value: any): void; reject(error: Error): void }>();
  private incoming = new Set<string>();
  private closed = false;
  constructor(private send: (value: unknown) => void, private notification: (method: string, params: any) => void = () => {}, private terminal: () => void = () => {}, private permission?: (params: any) => Promise<unknown>) {}
  call(method: string, params: unknown): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Native ACP connection closed'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => { this.pending.set(id, { method, resolve, reject }); this.send({ jsonrpc: '2.0', id, method, params }); });
  }
  notify(method: string, params: unknown): void { if (!this.closed) this.send({ jsonrpc: '2.0', method, params }); }
  accept(value: any): void {
    if (this.closed) return;
    if (!object(value) || value.jsonrpc !== '2.0') throw new Error('Native ACP returned invalid protocol data');
    if (typeof value.method === 'string') {
      if (!Object.hasOwn(value, 'id')) { this.notification(value.method, value.params); return; }
      if (!(typeof value.id === 'string' && value.id.length <= 200 || Number.isSafeInteger(value.id))) throw new Error('Invalid native ACP request id');
      const key = JSON.stringify(value.id);
      if (this.incoming.has(key)) throw new Error('Native ACP returned a duplicate request id');
      if (this.incoming.size >= 1000) throw new Error('Native ACP request limit exceeded');
      this.incoming.add(key);
      if (value.method === 'session/request_permission' && this.permission) {
        void Promise.resolve().then(() => this.permission!(value.params)).then(result => { if (!this.closed) this.send({ jsonrpc: '2.0', id: value.id, result }); }, error => this.close(error instanceof Error ? error : new Error('Native approval failed')));
      } else if (value.method === 'session/request_permission') this.send({ jsonrpc: '2.0', id: value.id, result: { outcome: { outcome: 'cancelled' } } });
      else this.send({ jsonrpc: '2.0', id: value.id, error: { code: -32601, message: 'Relay does not expose native filesystem, terminal, or other client capabilities' } });
      return;
    }
    const pending = this.pending.get(value.id);
    if (!pending) throw new Error('Native ACP returned an unexpected response');
    this.pending.delete(value.id);
    if (pending.method === 'session/prompt') this.terminal();
    if (object(value.error)) pending.reject(new Error(safeError(value.error.message ?? 'Native ACP request failed')));
    else if (!Object.hasOwn(value, 'result') || value.result !== null && !object(value.result)) pending.reject(new Error('Native ACP returned an invalid response'));
    else pending.resolve(value.result ?? {});
  }
  close(error = new Error('Native ACP connection closed before completion')): void {
    this.terminal(); this.closed = true; for (const pending of this.pending.values()) pending.reject(error); this.pending.clear();
  }
}

export function acpEnvironment(home: string, provider: AcpProvider, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...childEnvironment(source), HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'), NO_BROWSER: 'true',
    ...(provider === 'gemini' ? { GEMINI_CLI_HOME: home, GEMINI_CLI_NO_RELAUNCH: 'true', GEMINI_FORCE_FILE_STORAGE: 'true', GEMINI_TELEMETRY_ENABLED: 'false' }
      : { GROK_HOME: join(home, '.grok'), GROK_DISABLE_AUTOUPDATER: '1', GROK_MEMORY: '0', GROK_SUBAGENTS: '0', GROK_GOAL: '0', GROK_WEB_FETCH: '0', GROK_WRITE_FILE: '0',
        GROK_CURSOR_SKILLS_ENABLED: '0', GROK_CURSOR_RULES_ENABLED: '0', GROK_CURSOR_AGENTS_ENABLED: '0', GROK_CURSOR_MCPS_ENABLED: '0', GROK_CURSOR_HOOKS_ENABLED: '0',
        GROK_CLAUDE_SKILLS_ENABLED: '0', GROK_CLAUDE_RULES_ENABLED: '0', GROK_CLAUDE_AGENTS_ENABLED: '0', GROK_CLAUDE_MCPS_ENABLED: '0', GROK_CLAUDE_HOOKS_ENABLED: '0' }) };
}
export async function findGeminiCommand(): Promise<Command | null> {
  for (const entry of (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean)) {
    const dir = resolve(entry.replace(/^"|"$/g, ''));
    for (const path of [join(dir, 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js'), join(dir, '..', '@google', 'gemini-cli', 'bundle', 'gemini.js')]) {
      if (await access(path).then(() => true, () => false)) return { file: process.execPath, args: [path] };
    }
  }
  return null;
}
function modelsOf(session: any): ProviderConnection['models'] {
  const values = session.models?.availableModels;
  if (!Array.isArray(values) || values.length > 200) throw new Error('Native ACP model catalog is unavailable');
  const seen = new Set<string>();
  return values.filter(item => object(item) && typeof item.modelId === 'string' && item.modelId.length <= 160 && !/^auto(?:$|[-_])/i.test(item.modelId)
    && !seen.has(item.modelId) && Boolean(seen.add(item.modelId))).map(item => ({ id: item.modelId, name: typeof item.name === 'string' ? item.name.slice(0, 160) : item.modelId, verified: false,
      ...(typeof item.description === 'string' ? { description: item.description.slice(0, 400) } : {}) }));
}
export interface AcpProfile {
  id: AcpProvider; title: string; authMethods: string[];
  identity(home: string): Promise<AcpIdentity | null>;
  command(): Promise<Command | null>;
  configure(home: string, runDir: string, app?: Awaited<ReturnType<typeof createAppToolsBridge>>, login?: boolean): Promise<NodeJS.ProcessEnv>;
  args(runDir: string, model?: string, app?: Awaited<ReturnType<typeof createAppToolsBridge>>): string[];
  validate(initialize: any): void;
  nativeAccount?(client: AcpClient, initialize: any, home: string): Promise<AcpIdentity>;
  modelUnavailable?(model: string): string | undefined;
  /** This provider is available only for an intentional native Agent run with a workspace and host approvals. */
  nativeAgent?: boolean;
  mcpInSettings?: boolean;
  loginArgs: string[];
}
export class AcpAdapter implements ProviderAdapter {
  readonly id: AcpProvider;
  private jobs = new Map<OwnedProcess, { prove(): Promise<void>; revoke(): void }>();
  constructor(private dataDir: string, private profile: AcpProfile, private options: AcpOptions = {}) { this.id = profile.id; }
  private get home(): string { return resolve(this.dataDir, this.id, 'home'); }
  private async open(model?: string, request?: ProviderRequest, emit: (event: ProviderEvent) => void = () => {}, signal = new AbortController().signal) {
    const command = await (this.options.command ?? this.profile.command)();
    if (!command) throw new Error(`Install the official ${this.profile.title} CLI before connecting`);
    const home = this.home;
    const runDir = await mkdtemp(join(await this.privateRuns(home), 'run-'));
    const nativeAgent = this.profile.nativeAgent && request?.mode === 'agent';
    const cwd = nativeAgent ? await workDirectory(request!) : join(runDir, 'workspace'); if (!nativeAgent) await mkdir(cwd, { mode: 0o700 });
    const appTools = (request as ProviderRequest & { appTools?: AppTools } | undefined)?.appTools;
    let bridge: Awaited<ReturnType<typeof createAppToolsBridge>> | undefined;
    let acceptingTools = false, revoked = false;
    const lifetime = new AbortController(), approvalSignal = AbortSignal.any([signal, lifetime.signal]);
    const revoke = () => { acceptingTools = false; revoked = true; lifetime.abort(); bridge?.revoke(); };
    let job: OwnedProcess | undefined, client: AcpClient | undefined; let sessionId = '', text = '';
    const ownership = this.options.launcher ? undefined : createAcpLauncher(runDir, this.id);
    try {
      if (appTools) bridge = await createAppToolsBridge({ definitions: appTools.definitions, call: (id, name, args) => {
        if (!acceptingTools || revoked || signal.aborted) return Promise.reject(new Error('Relay app actions are unavailable outside the active native prompt'));
        return appTools.call(id, name, args);
      } }, signal, runDir);
      const extraEnv = await this.profile.configure(home, runDir, bridge);
      client = new AcpClient(value => job!.write(value), (method, params) => {
        if (method !== 'session/update' || !sessionId || params?.sessionId !== sessionId) return;
        const update = params.update;
        if (update?.sessionUpdate === 'agent_message_chunk') {
          if (update.content?.type !== 'text' || typeof update.content.text !== 'string') throw new Error('Native ACP returned unsupported response content');
          text += update.content.text; if (text.length > 2 * 1024 * 1024) throw new Error('Native ACP response exceeded the safety limit'); emit({ type: 'delta', text: update.content.text });
        } else if (update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update') {
          if (nativeAgent) { emit({ type: 'tool', name: toolSummary(update.title ?? update.kind ?? 'Grok native tool'), summary: toolSummary(update.rawInput ?? update.status ?? '') }); return; }
          if (!bridge) throw new Error('Native ACP attempted a disabled tool; no native tools are permitted');
          // The only registered tools are the private facade; its host callback checks names, arguments and active-run authorization.
          emit({ type: 'tool', name: 'Relay app action', summary: 'Using the run-scoped Relay app tools' });
        } else if (update?.sessionUpdate === 'current_model_update' && request && update.currentModelId !== request.model)
          throw new Error('Native ACP changed model; no fallback is permitted');
      }, revoke, nativeAgent ? async params => {
        if (!acceptingTools || revoked || approvalSignal.aborted) return { outcome: { outcome: 'cancelled' } };
        if (!object(params) || params.sessionId !== sessionId || !object(params.toolCall) || typeof params.toolCall.toolCallId !== 'string' || !params.toolCall.toolCallId || params.toolCall.toolCallId.length > 200
          || !Array.isArray(params.options) || !params.options.length || params.options.length > 32 || params.options.some((option: any) => !object(option) || typeof option.optionId !== 'string' || option.optionId.length > 200)
          || new Set(params.options.map((option: any) => option.optionId)).size !== params.options.length)
          throw new Error('Native approval returned an invalid session or options');
        const allow = params.options.find((option: any) => option.optionId === 'allow-once' && option.kind === 'allow_once');
        const deny = params.options.find((option: any) => option.optionId === 'reject-once' && option.kind === 'reject_once');
        if (!allow || !deny) throw new Error('Native approval does not offer verified one-call options');
        const details = JSON.stringify(params.toolCall.rawInput ?? {}); if (details.length > 80_000) throw new Error('Native approval input exceeded the safety limit');
        const answer = await request!.interact!({ kind: 'approval', title: `${this.profile.title}: ${toolSummary(params.toolCall.title ?? params.toolCall.kind ?? 'Native tool')}`,
          description: 'Allow this native tool call once?', details }, approvalSignal);
        if (revoked || approvalSignal.aborted) return { outcome: { outcome: 'cancelled' } };
        if (!object(answer) || !['allow', 'deny'].includes(answer.decision)) throw new Error('The host returned an invalid native approval answer');
        return { outcome: { outcome: 'selected', optionId: answer.decision === 'allow' ? allow.optionId : deny.optionId } };
      } : undefined);
      job = new OwnedProcess(command, this.profile.args(runDir, model, bridge), cwd, { ...acpEnvironment(home, this.id), ...extraEnv }, request?.maxSeconds ?? 25,
        value => { try { client!.accept(value); } catch (error) { revoke(); throw error; } }, signal, this.options.launcher ?? ownership?.launcher, this.options.kill ?? ownership?.kill);
      this.jobs.set(job, { prove: async () => { await ownership?.prove(job!.child); }, revoke });
      void job.finished.then(() => { revoke(); client!.close(); }, error => { revoke(); client!.close(error); });
      const initialize = await client.call('initialize', { protocolVersion: 1, clientInfo: { name: this.profile.nativeAgent ? `Relay-${randomUUID()}` : 'Relay', version: '0.1.0' },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
      if (initialize.protocolVersion !== 1) throw new Error('Unsupported native ACP protocol version');
      this.profile.validate(initialize);
      const authMethod = this.profile.authMethods.find(id => initialize.authMethods?.some((method: any) => method?.id === id));
      if (!authMethod) throw new Error('Native subscription OAuth authentication is not available; API authentication is disabled');
      let nativeIdentity: AcpIdentity | null;
      if (this.profile.nativeAccount) nativeIdentity = await this.profile.nativeAccount(client, initialize, home);
      else { await client.call('authenticate', { methodId: authMethod, _meta: { headless: true } }); nativeIdentity = await this.profile.identity(home); }
      if (!nativeIdentity) throw new Error('Native subscription account identity is unavailable');
      const mcpServers = bridge && !this.profile.mcpInSettings ? [{ name: 'relay_app', command: bridge.mcpConfig.mcpServers.relay_app.command,
        args: bridge.mcpConfig.mcpServers.relay_app.args, env: [] }] : [];
      const session = await client.call('session/new', { cwd, mcpServers, ...(nativeAgent ? { _meta: { yoloMode: false, autoMode: false } } : {}) });
      if (typeof session.sessionId !== 'string' || !session.sessionId || session.sessionId.length > 200) throw new Error('Native ACP did not create a valid session');
      if (nativeAgent && (typeof session._meta?.currentWorkingDirectory !== 'string' || resolve(session._meta.currentWorkingDirectory).toLowerCase() !== resolve(cwd).toLowerCase()))
        throw new Error('Native ACP did not confirm the requested workspace; no prompt was sent');
      sessionId = session.sessionId;
      const catalog = modelsOf(session), unavailable = catalog.map(model => this.profile.modelUnavailable?.(model.id)).find(Boolean);
      const models = catalog.filter(model => !this.profile.modelUnavailable?.(model.id));
      return { job, client, session, models, unavailable, identity: nativeIdentity, get text() { return text; }, admit: () => { if (revoked) throw new Error('Native prompt capability was revoked'); acceptingTools = true; }, close: async () => { revoke(); client!.close(); let proved = false; try { await job!.stop(); await ownership?.prove(job!.child); proved = true; } finally { this.jobs.delete(job!); await bridge?.close(); if (proved) await rm(runDir, { recursive: true, force: true }); } } };
    } catch (error) {
      revoke(); client?.close(); let proved = !job; try { if (job) { await job.stop(); await ownership?.prove(job.child); proved = true; } } finally { if (job) this.jobs.delete(job); await bridge?.close(); if (proved) await rm(runDir, { recursive: true, force: true }); }
      throw error;
    }
  }
  private async privateRuns(home: string): Promise<string> { const root = join(home, '.relay-runs'); await mkdir(root, { recursive: true, mode: 0o700 }); return root; }
  async inspect(): Promise<ProviderConnection> {
    const base: ProviderConnection = { id: this.id, installed: false, authenticated: false, authMode: 'unknown', accountLabel: '', plan: '', models: [] };
    if (!await (this.options.command ?? this.profile.command)()) return { ...base, error: `Install the official ${this.profile.title} CLI, then use its isolated Relay login command.` };
    base.installed = true;
    const identity = await this.profile.identity(this.home);
    if (!identity) return { ...base, error: `Sign in through Relay's isolated ${this.profile.title} login command, then refresh. No plan entry is required.` };
    let opened: Awaited<ReturnType<AcpAdapter['open']>> | undefined;
    try {
      opened = await this.open();
      const current = await this.profile.identity(this.home); if (!current) throw new Error('Native OAuth profile changed or is unavailable');
      return { ...base, authenticated: true, authMode: 'subscription', ...opened.identity, models: opened.models, ...(opened.unavailable ? { error: opened.unavailable } : {}) };
    } catch (error) { return { ...base, error: safeError(error) }; }
    finally { await opened?.close(); }
  }
  async login() {
    if (this.jobs.size) throw new Error(`Wait for active ${this.profile.title} operations to finish before signing in`);
    const command = await (this.options.command ?? this.profile.command)();
    if (!command) throw new Error(`Install the official ${this.profile.title} CLI before connecting`);
    const home = this.home, cwd = join(home, 'workspace'); await mkdir(cwd, { recursive: true, mode: 0o700 });
    // configure writes only Relay-owned settings. The interactive native login itself runs in the user's terminal.
    const extraEnv = await this.profile.configure(home, home, undefined, true);
    const launcher = join(home, 'relay-login.mjs');
    await writeFile(launcher, `import {spawn} from 'node:child_process';\nconst child=spawn(${JSON.stringify(command.file)},${JSON.stringify([...command.args, ...this.profile.loginArgs])},{cwd:${JSON.stringify(cwd)},env:${JSON.stringify({ ...acpEnvironment(home, this.id), ...extraEnv })},stdio:'inherit',windowsHide:false});\nchild.on('error',()=>{console.error('Official native login could not start');process.exitCode=1;});\nchild.on('exit',code=>{process.exitCode=code??1;});\n`, { mode: 0o600 });
    const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
    return { command: `& ${quote(process.execPath)} ${quote(launcher)}`, message: `Run this isolated official ${this.profile.title} login command in a terminal, complete the native sign-in, then refresh connections. Relay does not import your personal CLI profile or require a plan name.` };
  }
  async stream(request: ProviderRequest, emit: (event: ProviderEvent) => void, signal: AbortSignal, beforeDispatch?: () => void): Promise<ProviderResult> {
    boundedPrompt(request);
    const unavailable = this.profile.modelUnavailable?.(request.model); if (unavailable) throw new Error(unavailable);
    const appTools = (request as ProviderRequest & { appTools?: AppTools }).appTools;
    if (this.profile.nativeAgent) {
      if (request.mode !== 'agent' || !request.workspace || !request.interact) throw new Error(`${this.profile.title} requires native Agent mode, a project folder, and the host approval connection. Chat, Work and app-only Agent are unavailable.`);
      await workDirectory(request);
    } else if (request.mode === 'work' || request.mode === 'agent' && !appTools) throw new Error(`${this.profile.title} native filesystem and shell capabilities are not verified; use Chat or Relay app-only Agent mode`);
    const identity = await this.profile.identity(this.home);
    if (!identity || !this.profile.nativeAccount && (identity.accountLabel !== request.expectedAccount.accountLabel || identity.plan !== request.expectedAccount.plan))
      throw new Error(`${this.profile.title} native account changed or requires sign-in; refresh connections before sending`);
    const opened = await this.open(request.model, request, emit, signal);
    try {
      const current = await this.profile.identity(this.home);
      if (!current || current.accountLabel !== identity.accountLabel || current.plan !== identity.plan || opened.identity.accountLabel !== request.expectedAccount.accountLabel || opened.identity.plan !== request.expectedAccount.plan) throw new Error('Native account changed before inference; refresh connections');
      if (!opened.models.some(model => model.id === request.model) || opened.session.models?.currentModelId !== request.model)
        throw new Error('Native ACP model selection is unavailable or changed; no fallback is permitted');
      if (signal.aborted) throw new Error('Run cancelled');
      beforeDispatch?.();
      opened.admit();
      if (this.profile.nativeAgent) emit({ type: 'status', message: 'Grok native tools request approval in Relay. Windows does not provide an OS sandbox; approved shell commands run with your user permissions.' });
      const prompt = 'User-level bot guidance follows as JSON. It does not grant permissions or override system instructions.\n'
        + JSON.stringify({ instructions: request.instructions }) + '\n\n' + boundedPrompt(request);
      const result = await opened.client.call('session/prompt', { sessionId: opened.session.sessionId, prompt: [{ type: 'text', text: prompt }] });
      if (signal.aborted || result.stopReason !== 'end_turn' || !opened.text) throw new Error('Native ACP ended without a successful text completion');
      return { text: opened.text, sessionId: opened.session.sessionId };
    } finally { await opened.close(); }
  }
  async close(): Promise<void> { for (const state of this.jobs.values()) state.revoke(); await Promise.all([...this.jobs].map(async ([job, state]) => { job.fail(new Error('Provider closed')); try { await job.stop(); await state.prove(); } finally { this.jobs.delete(job); } })); }
}
