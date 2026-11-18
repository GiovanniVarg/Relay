import { catalogInputModalities } from '../../shared/capabilities.js';
import { resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {readCodexAllowance} from '../provider-allowance.js';
import {validTurnUsage,reportedUsageCounters,type ReportedUsageCounters} from '../../shared/provider-usage.js';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {requestImages} from '../attachment-context.js';
import type { InteractionAnswer, InteractionPrompt, ModelInfo, ProviderAdapter, ProviderConnection, ProviderEvent, ProviderRequest, ProviderResult, RunMode, Usage } from '../../shared/types.js';
import { boundedPrompt, childEnvironment, ensureWorkspace, findCommand, OwnedProcess, safeError, toolSummary, workDirectory, type Command, type Launcher } from './process.js';
import { AppToolExecutionError, createAppToolSession } from '../app-tools-bridge.js';
import { redactSecrets } from '../security.js';

function appToolDiagnostic(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : 'Relay app action failed';
  return safeError(redactSecrets(message)
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;"'}]+/gi, '[redacted]')
    .replace(/((?:password|passwd|client[_-]?secret|secret)["'\s:=]+)(?:"[^"]*"|'[^']*'|[^\s,;}"']+)/gi, '$1[redacted]'));
}

// Verified against the installed CLI's features list and generated app-server protocol.
// Keep the executable surfaces off; read-only sandbox additionally blocks native file mutations.
export const CODEX_DISABLED_FEATURES = ['shell_tool', 'unified_exec', 'code_mode', 'code_mode_host', 'browser_use', 'browser_use_external',
  'computer_use', 'image_generation', 'apps', 'plugins', 'hooks', 'multi_agent', 'multi_agent_v2', 'view_image', 'sleep_tool',
  'goals', 'memories', 'workspace_dependencies', 'skill_search', 'skill_mcp_dependency_install', 'shell_snapshot', 'realtime_conversation',
  'tool_suggest', 'recommended_plugins'];
export const CODEX_CONFIG: Record<string, unknown> = {
  forced_login_method: 'chatgpt', cli_auth_credentials_store: 'file', approval_policy: 'never', sandbox_mode: 'read-only',
  web_search: 'disabled', project_doc_max_bytes: 0, 'agents.enabled': false, 'apps._default.enabled': false,
  'plugins._default.enabled': false, mcp_servers: {}, suppress_unstable_features_warning: true,
  ...Object.fromEntries(CODEX_DISABLED_FEATURES.map(feature => [`features.${feature}`, false])),
};
function toml(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) return '{}';
  return JSON.stringify(value);
}
// Work mode enables shell/exec and their code-mode host; other capabilities stay off. Containment is the
// OS-level workspace-write sandbox (writes only inside the workspace + temp), network off, approvals never.
// Models with tool_mode=code_mode_only (including gpt-6-luna) need the host to invoke shell/exec.
export const CODEX_WORK_FEATURES = ['shell_tool', 'unified_exec', 'code_mode_host'];
export const CODEX_WORK_CONFIG: Record<string, unknown> = {
  ...CODEX_CONFIG, sandbox_mode: 'workspace-write', 'sandbox_workspace_write.network_access': false,
  // MXC is the native Windows sandbox; the legacy elevated backend can hang shell commands.
  ...(process.platform === 'win32' ? { 'windows.sandbox': 'mxc' } : {}),
  ...Object.fromEntries(CODEX_WORK_FEATURES.map(feature => [`features.${feature}`, true])),
};
const codexArgs = (config: Record<string, unknown>) => ['app-server', '--stdio', '--strict-config',
  ...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${toml(value)}`])];
export const CODEX_SAFE_ARGS = codexArgs(CODEX_CONFIG);
export const CODEX_WORK_ARGS = codexArgs(CODEX_WORK_CONFIG);
// code_mode_only models require the typed function host for dynamic tools. Shell, exec,
// generic code_mode and every other native capability remain disabled in app-only runs.
export const CODEX_APP_CONFIG: Record<string, unknown> = { ...CODEX_CONFIG, 'features.code_mode_host': true };
export const CODEX_APP_ARGS = codexArgs(CODEX_APP_CONFIG);
// Native mode preserves CLI features, project instructions, skills and MCP configuration.
// Only the account route, sandbox and human approval policy are imposed by Relay.
export const CODEX_AGENT_CONFIG: Record<string, unknown> = {
  forced_login_method: 'chatgpt', cli_auth_credentials_store: 'file', model_provider: 'openai',
  approval_policy: 'on-request', sandbox_mode: 'workspace-write', 'sandbox_workspace_write.network_access': false,
  ...(process.platform === 'win32' ? { 'windows.sandbox': 'mxc' } : {}),
};
export const CODEX_AGENT_ARGS = codexArgs(CODEX_AGENT_CONFIG);

export function assertSafeCodexConfig(config: any, mode: RunMode = 'chat', appTools = false): void {
  const native = mode === 'agent';
  const work = mode !== 'chat';
  if (config?.forced_login_method !== 'chatgpt' || config?.approval_policy !== (native ? 'on-request' : 'never') || config?.sandbox_mode !== (work ? 'workspace-write' : 'read-only') || (!native && config?.web_search !== 'disabled'))
    throw new Error('Codex cannot enforce the required subscription-only sandbox configuration');
  if (work && process.platform === 'win32' && config.windows?.sandbox !== 'mxc')
    throw new Error('Codex requires the Windows MXC sandbox backend. Update the official Codex CLI (0.162.0+) and verify Windows sandbox support; no turn started.');
  if (work && config.sandbox_workspace_write?.network_access !== false) throw new Error('Codex cannot disable network access in the workspace sandbox');
  if (native) {
    // config/read includes the built-in default URL even when no endpoint override exists.
    if (config.model_provider !== 'openai' || Object.keys(config.model_providers?.openai ?? {}).length
      || (config.chatgpt_base_url != null && config.chatgpt_base_url !== 'https://chatgpt.com/backend-api/'))
      throw new Error('Codex native mode requires the built-in OpenAI subscription route without endpoint overrides');
    return;
  }
  if (work) for (const feature of CODEX_WORK_FEATURES) if (config.features?.[feature] !== true)
    throw new Error(`Codex cannot enable the required work capability (${feature}); update the official CLI`);
  if (appTools && !work && config.features?.code_mode_host !== true) throw new Error('Codex cannot enable the required Relay app-tool host runner');
  for (const feature of CODEX_DISABLED_FEATURES) if (!(work && CODEX_WORK_FEATURES.includes(feature)) && !(appTools && !work && feature === 'code_mode_host') && config.features?.[feature] !== false)
    throw new Error(`Codex cannot disable the ${feature} capability; update the official CLI`);
  if (Object.values(config.mcp_servers ?? {}).some((server: any) => server?.enabled !== false)) throw new Error('Codex external tools must be disabled');
}

// Only fixed protocol values may enter diagnostics; never serialize a response/config.
function policyValue(value: unknown, allowed: readonly string[]): string {
  return value === undefined || value === null ? 'missing' : typeof value === 'string' && allowed.includes(value) ? value : 'unknown';
}
function policyDiagnostic(thread: any, backend: unknown, work: boolean, native = false): string {
  const sandbox = policyValue(thread?.sandbox?.type, ['readOnly', 'workspaceWrite', 'dangerFullAccess', 'externalSandbox']);
  const network = typeof thread?.sandbox?.networkAccess === 'boolean' ? String(thread.sandbox.networkAccess) : thread?.sandbox?.networkAccess == null ? 'missing' : 'unknown';
  const approval = policyValue(thread?.approvalPolicy, ['never', 'on-request', 'on-failure', 'untrusted']);
  return `stage=${native ? 'agent' : work ? 'work' : 'chat'} thread/start; sandbox=${sandbox}; network=${network}; approval=${approval}; backend=${policyValue(backend, ['mxc', 'elevated', 'unelevated', 'disabled'])}`;
}

type RpcMessage = { id?: number | string; method?: string; params?: any; result?: any; error?: { message?: string } };
const record = (value: unknown): value is Record<string, any> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function interactionDecision(value: InteractionAnswer): 'allow' | 'deny' {
  if (!record(value) || !['allow', 'deny'].includes(value.decision)) throw new Error('The host returned an invalid approval answer');
  return value.decision;
}
function questionAnswers(answer: InteractionAnswer, questions: NonNullable<InteractionPrompt['questions']>): Record<string, string[]> {
  if (!record(answer.answers) || Object.keys(answer.answers).length !== questions.length) throw new Error('The host returned an invalid question answer');
  for (const q of questions) {
    const values = Object.hasOwn(answer.answers, q.id) ? answer.answers[q.id] : undefined;
    if (!Array.isArray(values) || !values.length || (!q.multiple && values.length !== 1) || values.some(v => typeof v !== 'string' || v.length > 20_000))
      throw new Error('The host returned an invalid question answer');
  }
  return answer.answers;
}
// The allow response is the requested profile itself, never client-supplied permissions or a session grant.
function requestedPermissions(value: unknown): Record<string, unknown> | undefined {
  if (!record(value) || Object.keys(value).some(k => !['network', 'fileSystem'].includes(k))) return;
  const granted: Record<string, unknown> = {};
  if (value.network != null) {
    if (!record(value.network) || Object.keys(value.network).some(k => k !== 'enabled') || ![true, false, null].includes(value.network.enabled)) return;
    granted.network = { enabled: value.network.enabled };
  }
  if (value.fileSystem != null) {
    const fs = value.fileSystem;
    if (!record(fs) || Object.keys(fs).some(k => !['read', 'write', 'globScanMaxDepth', 'entries'].includes(k))) return;
    if (['read', 'write'].some(k => fs[k] != null && (!Array.isArray(fs[k]) || fs[k].some((p: unknown) => typeof p !== 'string' || p.length > 10_000)))) return;
    if (fs.globScanMaxDepth != null && (!Number.isSafeInteger(fs.globScanMaxDepth) || fs.globScanMaxDepth < 0)) return;
    // Newer entry profiles have special path semantics. Decline until the host can display them faithfully.
    if (fs.entries != null) return;
    granted.fileSystem = { read: fs.read ?? null, write: fs.write ?? null, ...(fs.globScanMaxDepth == null ? {} : { globScanMaxDepth: fs.globScanMaxDepth }) };
  }
  return granted;
}
async function codexInteraction(message: RpcMessage, threadId: string, turnId: string,
  interact: NonNullable<ProviderRequest['interact']>, emit: (event: ProviderEvent) => void, signal: AbortSignal,
  fileChanges: (itemId: string) => unknown): Promise<unknown> {
  const p = message.params;
  if (!record(p) || p.threadId !== threadId || p.turnId !== turnId) throw new Error('Codex requested an interaction outside the active thread and turn');
  const ask = async (prompt: InteractionPrompt) => {
    const answer = await interact(prompt, signal);
    if (signal.aborted) throw new Error('Run cancelled');
    interactionDecision(answer);
    return answer;
  };
  if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') {
    if (typeof p.itemId !== 'string') throw new Error('Codex returned a malformed approval request');
    const command = message.method === 'item/commandExecution/requestApproval';
    const changes = command ? undefined : fileChanges(p.itemId);
    const rawDetails = JSON.stringify(command ? { command: p.command, cwd: p.cwd, kind: p.kind, network: p.networkApprovalContext }
      : { itemId: p.itemId, grantRoot: p.grantRoot ?? null, reason: p.reason ?? null,
        ...(changes ? { fileChanges: changes } : { patchDetails: 'Patch details unavailable from runtime' }) });
    const details = rawDetails.length < 16_000 ? rawDetails : rawDetails.slice(0, 15_800) + '\n[Patch details truncated to fit the approval display; review the complete patch in the native runtime before allowing.]';
    const answer = await ask({ kind: 'approval', title: command ? 'Codex command approval' : 'Codex file change approval',
      description: toolSummary(p.reason ?? (command ? 'Allow this command once?' : 'Allow this file change once?')),
      details });
    return { decision: answer.decision === 'allow' ? 'accept' : 'decline' };
  }
  if (message.method === 'item/permissions/requestApproval') {
    const permissions = requestedPermissions(p.permissions);
    if (!permissions) { emit({ type: 'status', message: 'Codex requested an unsupported permission profile; it was declined.' }); return { permissions: {}, scope: 'turn' }; }
    const answer = await ask({ kind: 'approval', title: 'Codex additional permissions', description: toolSummary(p.reason ?? 'Allow the displayed permissions for this turn?'),
      details: JSON.stringify({ cwd: p.cwd, permissions }) });
    return { permissions: answer.decision === 'allow' ? permissions : {}, scope: 'turn' };
  }
  if (message.method === 'item/tool/requestUserInput') {
    if (!Array.isArray(p.questions) || !p.questions.length || p.questions.length > 16 || p.questions.some(q => !record(q) || typeof q.id !== 'string' || !q.id || typeof q.question !== 'string' || q.isSecret))
      throw new Error('Codex requested an unsupported or malformed user question');
    if (new Set(p.questions.map(q => q.id)).size !== p.questions.length) throw new Error('Codex question identifiers must be unique');
    const questions = p.questions.map(q => ({ id: q.id, question: q.question,
      ...(Array.isArray(q.options) ? { options: q.options.map((o: any) => { if (typeof o?.label !== 'string') throw new Error('Codex returned malformed question options'); return o.label; }) } : {}) }));
    const answer = await ask({ kind: 'question', title: 'Codex needs input', description: 'Answer the questions to continue.', questions });
    const answers = answer.decision === 'allow' ? questionAnswers(answer, questions) : Object.fromEntries(questions.map(q => [q.id, []]));
    return { answers: Object.fromEntries(questions.map(q => [q.id, { answers: answers[q.id] }])) };
  }
  if (message.method === 'mcpServer/elicitation/request') {
    const schema = p.requestedSchema;
    const unsupported = () => { emit({ type: 'status', message: 'Codex MCP requested an unsupported form or URL interaction; it was declined.' }); return { action: 'decline', content: null }; };
    if (p.mode !== 'form' || !record(schema) || schema.type !== 'object' || !record(schema.properties) || Object.keys(schema).some(k => !['$schema', 'type', 'properties', 'required'].includes(k))) return unsupported();
    const entries = Object.entries(schema.properties);
    if (!entries.length || entries.length > 16 || entries.some(([, spec]) => !record(spec) || !['string', 'boolean'].includes(spec.type) || Object.keys(spec).some(k => !['type', 'title', 'description', 'enum', 'default'].includes(k)) || (spec.enum != null && (!Array.isArray(spec.enum) || spec.enum.some((v: unknown) => typeof v !== 'string'))))) return unsupported();
    if (schema.required != null && (!Array.isArray(schema.required) || schema.required.some((k: unknown) => typeof k !== 'string' || !Object.hasOwn(schema.properties, k)))) return unsupported();
    const questions = entries.map(([id, spec]) => ({ id, question: String(spec.description ?? spec.title ?? id), options: spec.type === 'boolean' ? ['true', 'false'] : spec.enum }));
    const answer = await ask({ kind: 'question', title: `Codex MCP: ${toolSummary(p.serverName)}`, description: toolSummary(p.message), questions });
    if (answer.decision !== 'allow') return { action: 'decline', content: null };
    const answers = questionAnswers(answer, questions);
    const content = Object.fromEntries(entries.map(([id, spec]) => {
      const value = answers[id][0];
      if ((spec.type === 'boolean' && !['true', 'false'].includes(value)) || (spec.enum && !spec.enum.includes(value))) throw new Error('The host returned an invalid MCP form answer');
      return [id, spec.type === 'boolean' ? value === 'true' : value];
    }));
    return { action: 'accept', content };
  }
  // Dynamic host tools, auth refresh, attestation and unknown future requests are never fabricated.
  throw new Error(`Codex requested an unsupported host method (${toolSummary(message.method)}); the run was stopped`);
}
// Classify only the observed startup signature. Raw stderr stays private, bounded and
// is discarded at exit; paths, credentials and protocol payloads never enter diagnostics.
class CodexProcessExitError extends Error {
  constructor(phase: string, code: number | null, signal: NodeJS.Signals | null, category: string,
    readonly retryInitialize: boolean) {
    const safeSignal = signal === null ? 'none' : ['SIGABRT', 'SIGALRM', 'SIGBUS', 'SIGFPE', 'SIGHUP', 'SIGILL', 'SIGINT',
      'SIGKILL', 'SIGPIPE', 'SIGQUIT', 'SIGSEGV', 'SIGTERM', 'SIGTRAP', 'SIGUSR1', 'SIGUSR2', 'SIGBREAK'].includes(signal) ? signal : 'unknown';
    super(`Codex process ended before request completion (phase=${phase}; exitCode=${Number.isSafeInteger(code) ? code : 'unknown'}; signal=${safeSignal}; category=${category})`);
  }
}
function startupBackoff(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new Error('Run cancelled')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

const CODEX_RETAINED_BYTES = 4 * 1024 * 1024;
const CODEX_QUEUED_INPUT_BYTES = 4 * 1024 * 1024;
const CODEX_RETAINED_ENTRIES = 4096;
const CODEX_PENDING_REQUESTS = 64;
const CODEX_PENDING_SERVER_REQUESTS = 32;
const utf8Bytes = (value: string) => Buffer.byteLength(value, 'utf8');
// JSON deltas may split a surrogate pair. Account the joined UTF8 representation
// exactly without rescanning the whole accumulated response on every token.
function appendedBytes(previous: string, suffix: string): number {
  const paired = previous.length > 0 && suffix.length > 0 && /[\uD800-\uDBFF]/.test(previous.at(-1)!) && /[\uDC00-\uDFFF]/.test(suffix[0]);
  return utf8Bytes(suffix) - (paired ? 2 : 0);
}
class CodexRetainedState {
  private bytes = 0;
  private entries = 0;
  resize(bytes: number, entries = 0): void {
    const nextBytes = this.bytes + bytes, nextEntries = this.entries + entries;
    if (!Number.isSafeInteger(nextBytes) || !Number.isSafeInteger(nextEntries) || nextBytes < 0 || nextEntries < 0
      || nextBytes > CODEX_RETAINED_BYTES || nextEntries > CODEX_RETAINED_ENTRIES)
      throw new Error('Codex retained state exceeded the safety limit');
    this.bytes = nextBytes; this.entries = nextEntries;
  }
}
function itemId(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Codex returned an invalid item identifier');
  return value;
}
type RetainedFileChange = {id:string;changes:{path:string;kind:Record<string,unknown>;diff:string}[];bytes:number;pins:number;mapped:boolean;released:boolean;terminal:boolean};

export class CodexRpc {
  readonly job: OwnedProcess;
  readonly failed: Promise<never>;
  readonly retained = new CodexRetainedState();
  sandboxBackend: unknown;
  private nextId = 1;
  private pending = new Map<number, { method:string;bytes:number;resolve(value: any): void; reject(error: Error): void }>();
  private listeners = new Set<(message: RpcMessage) => void>();
  private deadError?: Error;
  private serverRequest?: (message: RpcMessage, signal: AbortSignal) => Promise<unknown>;
  private serverIds = new Set<number | string>();
  private serverRequests = new Map<number | string, { controller: AbortController; threadId: unknown; bytes:number }>();
  private phase = 'starting';
  private pristineInitialize = true;
  constructor(command: Command, args: string[], cwd: string, env: NodeJS.ProcessEnv, seconds: number, signal?: AbortSignal, launcher?: Launcher,
    kill?: (child: ChildProcessWithoutNullStreams) => Promise<void>, imageWire=0) {
    // Every valid frame closes the retry boundary, even frames removed for image privacy.
    this.job = new OwnedProcess(command, args, cwd, env, seconds, value=>{this.pristineInitialize=false;if(imageWire){if(['item/started','item/completed'].includes(value.method)&&value.params?.item?.type==='userMessage')return;const turn=value.method==='turn/completed'?value.params?.turn:this.pending.get(value.id)?.method==='turn/start'?value.result?.turn:undefined;if(Array.isArray(turn?.items))turn.items=turn.items.filter((item:any)=>item.type!=='userMessage');if(Buffer.byteLength(JSON.stringify(value))>1024*1024)throw new Error('Provider non-image protocol frame exceeded the safety limit');}this.accept(value);},signal,launcher,kill,'jsonl',{total:CODEX_RETAINED_BYTES,line:1024*1024+imageWire,mode:'streaming',inputQueueBytes:CODEX_QUEUED_INPUT_BYTES+imageWire});
    const decoder = new StringDecoder('utf8');
    let tail = '', sqliteInitialization = false;
    const diagnostic = (chunk: Buffer | string) => {
      tail = (tail + (typeof chunk === 'string' ? chunk : decoder.write(chunk))).slice(-2048);
      sqliteInitialization ||= /(?:^|\n)Error: failed to initialize sqlite state runtime under [^\r\n]+: failed to initialize state runtime at [^\r\n]+/.test(tail);
    };
    this.job.child.stderr.on('data', diagnostic);
    this.failed = this.job.finished.then(({ code, signal }) => {
      const retry = code === 1 && signal === null && sqliteInitialization && this.pristineInitialize
        && this.phase === 'initialize' && [...this.pending.values()].some(pending => pending.method === 'initialize');
      const error = new CodexProcessExitError(this.phase, code, signal, sqliteInitialization ? 'sqlite-state-initialization' : 'unclassified', retry);
      this.rejectAll(error); throw error;
    }, error => { this.rejectAll(error); throw error; }).finally(() => {
      tail = ''; decoder.end(); this.job.child.stderr.removeListener('data', diagnostic);
    });
    void this.failed.catch(() => {});
  }
  private accept(message: RpcMessage): void {
    if (message.method && message.id !== undefined) {
      if (this.serverRequest && !this.serverIds.has(message.id)) {
        if (!(typeof message.id === 'string' || Number.isSafeInteger(message.id))) throw new Error('Codex returned an invalid request identifier');
        if (this.serverRequests.size >= CODEX_PENDING_SERVER_REQUESTS) throw new Error('Codex host request queue exceeded the safety limit');
        const bytes = utf8Bytes(JSON.stringify(message));
        this.retained.resize(bytes + utf8Bytes(String(message.id)), 2);
        this.serverIds.add(message.id);
        const controller = new AbortController();
        const entry = { controller, threadId: message.params?.threadId, bytes };
        this.serverRequests.set(message.id, entry);
        void this.serverRequest(message, controller.signal).then(result => {
          this.releaseServerRequest(message.id!, entry);
          if (!this.deadError && !controller.signal.aborted) this.job.write({ id: message.id, result });
        }, error => {
          this.releaseServerRequest(message.id!, entry);
          if (!this.deadError && !controller.signal.aborted) {
            this.job.write({ id: message.id, error: { code: -32602, message: safeError(error) } });
            this.job.fail(new Error(safeError(error)));
          }
        });
        return;
      }
      this.job.write({ id: message.id, error: { code: -32601, message: 'Relay does not execute tools or accept approval requests' } });
      this.job.fail(new Error('Codex requested an unsupported tool or approval; the run was stopped'));
      return;
    }
    if (message.method === 'serverRequest/resolved') {
      const pending = this.serverRequests.get(message.params?.requestId);
      if (pending && pending.threadId === message.params?.threadId) {
        // Keep the reservation until the host callback settles. A callback that
        // ignores cancellation must not allow an unbounded replacement queue.
        pending.controller.abort();
      }
    }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      this.retained.resize(-pending.bytes, -1);
      if (message.error) pending.reject(new Error(safeError(message.error.message ?? 'Codex RPC request failed')));
      else {
        if (pending.method === 'initialize') this.phase = 'initialized';
        else if (pending.method === 'turn/start') this.phase = 'turn/running';
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method) for (const listener of this.listeners) listener(message);
  }
  request(method: string, params: unknown = {}): Promise<any> {
    if (this.deadError) return Promise.reject(this.deadError);
    if (this.pending.size >= CODEX_PENDING_REQUESTS) return Promise.reject(new Error('Codex pending request queue exceeded the safety limit'));
    const bytes = utf8Bytes(method) + 16;
    try { this.retained.resize(bytes, 1); } catch (error) { return Promise.reject(error); }
    if (method !== 'initialize' || this.nextId !== 1) this.pristineInitialize = false;
    this.phase = ['initialize', 'config/read', 'account/read', 'account/login/start', 'model/list', 'account/rateLimits/read',
      'thread/start', 'turn/start', 'command/exec'].includes(method) ? method : 'other-request';
    const id = this.nextId++;
    return new Promise((resolve, reject) => { this.pending.set(id, { method,bytes,resolve, reject }); this.job.write({ id, method, params }); });
  }
  notify(method: string): void { this.pristineInitialize = false; this.job.write({ method, params: {} }); }
  listen(listener: (message: RpcMessage) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  handleRequests(handler: (message: RpcMessage, signal: AbortSignal) => Promise<unknown>): void { this.serverRequest = handler; }
  private releaseServerRequest(id: number | string, entry: {bytes:number}): void {
    if (this.serverRequests.get(id) !== entry) return;
    this.serverRequests.delete(id); this.retained.resize(-entry.bytes, -1);
  }
  private rejectAll(error: Error) {
    this.deadError = error;
    for (const pending of this.pending.values()) { this.retained.resize(-pending.bytes, -1); pending.reject(error); } this.pending.clear();
    for (const pending of this.serverRequests.values()) pending.controller.abort();
  }
  async close(): Promise<void> { this.rejectAll(new Error('Codex connection closed')); this.listeners.clear(); await this.job.stop(); }
}

export class CodexTurn {
  text = '';
  ended = false;
  usage?: Usage;
  usageCounters?:ReportedUsageCounters;
  private items = new Map<string, string>();
  private completed = new Set<string>();
  private turnId?: string;
  private buffered: {message:RpcMessage;bytes:number}[] = [];
  private resolve!: (value: ProviderResult) => void;
  private reject!: (error: Error) => void;
  readonly result = new Promise<ProviderResult>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
  private announced = new Set<string>();
  private fileChanges = new Map<string, RetainedFileChange>();
  // Native runtimes can publish completed patch details before asking approval.
  // Keep the latest such snapshot, rather than every completed patch in the turn.
  private completedFile?: RetainedFileChange;
  constructor(private threadId: string, private model: string, private emit: (event: ProviderEvent) => void, private allowTools: boolean | 'native' = false,
    private appToolNames: ReadonlySet<string> = new Set(), private retained = new CodexRetainedState()) { void this.result.catch(() => {}); }
  fileChangeDetails(itemId: string): unknown { return this.fileChanges.get(itemId)?.changes; }
  pinFileChangeDetails(id: unknown): {details:unknown;release():void} {
    const entry = typeof id === 'string' ? this.fileChanges.get(id) : undefined;
    if (!entry) return {details:undefined,release:()=>{}};
    entry.pins++;
    let released = false;
    return {details:entry.changes,release:()=>{
      if (released) return;
      released = true; entry.pins--;
      if (entry.terminal && !entry.pins && entry.mapped) this.retireFileDetails(entry.id,entry);
      else this.releaseFileDetails(entry);
    }};
  }
  private releaseFileDetails(entry: RetainedFileChange): void {
    if (entry.mapped || entry.pins || entry.released) return;
    entry.released = true; this.retained.resize(-entry.bytes, -1);
  }
  private retireFileDetails(id: string, entry: RetainedFileChange): void {
    if (this.fileChanges.get(id) === entry) this.fileChanges.delete(id);
    if (this.completedFile === entry) this.completedFile = undefined;
    entry.mapped = false; this.releaseFileDetails(entry);
  }
  private announce(id: unknown): boolean {
    const key = itemId(id);
    if (this.announced.has(key)) return false;
    this.retained.resize(utf8Bytes(key), 1); this.announced.add(key); return true;
  }
  private checkItem(item: any, terminal = false): void {
    if (!item || ['agentMessage', 'userMessage', 'reasoning', 'plan'].includes(item.type)) return;
    if (item.type === 'dynamicToolCall') {
      if (item.namespace !== 'relay_app' || !this.appToolNames.has(item.tool)) throw new Error('Codex attempted a disabled tool (unavailable Relay app tool)');
      if (this.announce(item.id)) this.emit({ type: 'tool', name: item.tool, summary: 'Relay app action' });
      return;
    }
    const nativeItems = ['hookPrompt', 'functionCallOutput', 'commandExecution', 'fileChange', 'mcpToolCall', 'collabAgentToolCall',
      'subAgentActivity', 'webSearch', 'imageView', 'sleep', 'imageGeneration', 'enteredReviewMode', 'exitedReviewMode', 'contextCompaction'];
    if (!this.allowTools || !(this.allowTools === 'native' ? nativeItems : ['commandExecution', 'fileChange']).includes(item.type))
      throw new Error(`Codex attempted a disabled tool (${String(item.type).slice(0, 60)}); the run was stopped`);
    // checkItem is called only after accept has matched this turn's thread and turn identifiers.
    if (this.allowTools === 'native' && item.type === 'fileChange' && typeof item.id === 'string' && Array.isArray(item.changes)) {
      const previous = this.fileChanges.get(item.id);
      if (item.changes.every((change: any) => typeof change?.path === 'string' && typeof change.diff === 'string' && record(change.kind)
        && ['add', 'delete', 'update'].includes(change.kind.type) && (change.kind.type !== 'update' || change.kind.move_path == null || typeof change.kind.move_path === 'string'))) {
        const changes = item.changes.map((change: any) => ({ path: change.path, diff: change.diff,
          kind: change.kind.type === 'update' ? { type: 'update', move_path: change.kind.move_path ?? null } : { type: change.kind.type } }));
        const serialized = JSON.stringify(changes);
        const bytes = utf8Bytes(serialized) + utf8Bytes(item.id);
        if (this.completedFile && this.completedFile.id !== item.id) this.retireFileDetails(this.completedFile.id,this.completedFile);
        let entry = previous;
        if (!previous || JSON.stringify(previous.changes) !== serialized) {
          const reclaim = previous && !previous.pins;
          this.retained.resize(bytes - (reclaim ? previous.bytes : 0), reclaim ? 0 : 1);
          if (previous) { previous.mapped = false; if (reclaim) previous.released = true; }
          entry = {id:item.id,changes,bytes,pins:0,mapped:true,released:false,terminal:false};
          this.fileChanges.set(item.id,entry);
        }
        if (terminal) { entry!.terminal = true; this.completedFile = entry; }
      } else if (previous) this.retireFileDetails(item.id,previous);
    }
    if (!this.announce(item.id)) return;
    if (item.type === 'commandExecution') this.emit({ type: 'tool', name: 'shell', summary: toolSummary(item.command) });
    else if (item.type === 'fileChange') this.emit({ type: 'tool', name: 'edit', summary: toolSummary(Array.isArray(item.changes) ? item.changes.map((c: any) => c?.path).filter(Boolean).join(', ') : '') });
    else this.emit({ type: 'tool', name: item.type === 'mcpToolCall' ? `${item.server}/${item.tool}` : item.type,
      summary: toolSummary(item.command ?? item.path ?? item.tool ?? item.kind ?? item.text ?? item.type) });
  }
  start(turnId: string): void {
    this.turnId = turnId;
    const buffered = this.buffered; this.buffered = [];
    for (const item of buffered) { this.retained.resize(-item.bytes, -1); this.accept(item.message); }
  }
  accept(message: RpcMessage): void {
    const p = message.params;
    if (!p || p.threadId !== this.threadId) return;
    if (!this.turnId) {
      if (this.buffered.length >= 1000) throw new Error('Codex notification queue exceeded the safety limit');
      const bytes = utf8Bytes(JSON.stringify(message)); this.retained.resize(bytes, 1); this.buffered.push({message,bytes}); return;
    }
    if ((p.turnId ?? p.turn?.id) !== this.turnId) return;
    const method = message.method;
    if (method === 'item/agentMessage/delta' && typeof p.delta === 'string') {
      const id = itemId(p.itemId);
      if (this.completed.has(id)) return;
      const previous = this.items.get(id) ?? '';
      this.retained.resize(appendedBytes(previous,p.delta) + appendedBytes(this.text,p.delta) + (this.items.has(id) ? 0 : utf8Bytes(id)), this.items.has(id) ? 0 : 1);
      this.items.set(id, previous + p.delta);
      this.text += p.delta; this.emit({ type: 'delta', text: p.delta });
    } else if (method === 'item/started' || method === 'item/completed') {
      const item = p.item;
      this.checkItem(item,method === 'item/completed');
      if (method === 'item/completed' && item?.type === 'agentMessage') this.completeItem(item);
    } else if (method === 'thread/tokenUsage/updated') {
      const usage = p.tokenUsage?.total;
      this.usage = validTurnUsage(usage);
      this.usageCounters=reportedUsageCounters(usage?{...usage,cacheWriteTokens:usage.cacheWriteInputTokens,reasoningTokens:usage.reasoningOutputTokens}:undefined);
    } else if (method === 'error') {
      if (!p.willRetry) { this.ended = true; this.reject(new Error(safeError(p.error?.message ?? 'Codex request failed'))); }
    } else if (method === 'turn/completed') {
      this.ended = true;
      const turn = p.turn;
      if (turn?.status !== 'completed') { this.reject(new Error(safeError(turn?.error?.message ?? `Codex turn ${turn?.status ?? 'failed'}`))); return; }
      for (const item of turn.items ?? []) {
        this.checkItem(item,true);
        if (item.type === 'agentMessage') this.completeItem(item);
      }
      if (!this.text) { this.reject(new Error('Codex completed without response text')); return; }
      this.resolve({ text: this.text, sessionId: this.threadId, actualModel: this.model, usage: this.usage,usageCounters:this.usageCounters });
    }
  }
  private completeItem(item: any): void {
    const id = itemId(item.id);
    if (this.completed.has(id)) return;
    const previous = this.items.get(id) ?? '';
    const full = typeof item.text === 'string' ? item.text : previous;
    if (!full.startsWith(previous)) throw new Error('Codex final response did not match its streamed response');
    const suffix = full.slice(previous.length);
    this.retained.resize(utf8Bytes(full) - utf8Bytes(previous) + appendedBytes(this.text,suffix) + utf8Bytes(id) + (this.items.has(id) ? 0 : utf8Bytes(id)), this.items.has(id) ? 1 : 2);
    if (suffix) { this.text += suffix; this.emit({ type: 'delta', text: suffix }); }
    this.items.set(id, full); this.completed.add(id);
  }
}

const WORK_INSTRUCTIONS = 'You are a coding assistant working in the current directory (the project folder). Use your shell and file-edit tools to complete the final user request, stay inside this folder, never use the network, and finish with a short plain-text summary of what you did.';
export interface CodexOptions { command?: () => Promise<Command | null>; launcher?: Launcher; kill?: (child: ChildProcessWithoutNullStreams) => Promise<void> }
export class CodexAdapter implements ProviderAdapter {
  readonly id = 'openai' as const;
  private active = new Set<CodexRpc>();
  private connectionGeneration = 0;
  private loginConnection?: CodexRpc;
  private verified = new Set<string>();
  private catalog: ModelInfo[] = [];
  constructor(private dataDir: string, private options: CodexOptions = {}) {}
  private command() { return this.options.command?.() ?? findCommand('codex'); }
  private async connect(seconds = 25, signal?: AbortSignal, work?: string, native = false, appTools = false,imageWire=0): Promise<CodexRpc> {
    const generation = this.connectionGeneration;
    const command = await this.command();
    if (!command) throw new Error('Install the official Codex CLI to connect your ChatGPT account');
    const cwd = work ?? await ensureWorkspace(this.dataDir, this.id);
    const env = childEnvironment();
    env.CODEX_HOME = resolve(this.dataDir, this.id);
    for (let attempt = 1; ; attempt++) {
      if (generation !== this.connectionGeneration) throw new Error('Run cancelled');
      const rpc = new CodexRpc(command, native ? CODEX_AGENT_ARGS : work ? CODEX_WORK_ARGS : appTools ? CODEX_APP_ARGS : CODEX_SAFE_ARGS, cwd, env, seconds, signal, this.options.launcher, this.options.kill,imageWire);
      this.active.add(rpc);
      try {
        await rpc.request('initialize', { clientInfo: { name: 'relay_local_harness', title: 'Relay', version: '0.1.0' }, capabilities: appTools ? { experimentalApi: true } : {} });
        rpc.notify('initialized');
        const effective = await rpc.request('config/read', { cwd, includeLayers: false });
        assertSafeCodexConfig(effective?.config, native ? 'agent' : work ? 'work' : 'chat', appTools);
        rpc.sandboxBackend = effective?.config?.windows?.sandbox;
        return rpc;
      } catch (error) {
        this.active.delete(rpc);
        // stop() must confirm closure. An uncertain cleanup aborts without replacement.
        await rpc.close();
        if (!(error instanceof CodexProcessExitError) || !error.retryInitialize || attempt >= 3) throw error;
        await startupBackoff(attempt * 100, signal);
      }
    }
  }
  private async dispose(rpc: CodexRpc): Promise<void> { this.active.delete(rpc); await rpc.close(); }
  async inspect(): Promise<ProviderConnection> {
    const base: ProviderConnection = { id: this.id, installed: false, authenticated: false, authMode: 'unknown', accountLabel: '', plan: '', models: this.catalog.map(m => ({ ...m, verified: this.verified.has(m.id) })) };
    if (!await this.command()) return { ...base, error: 'Install the official Codex CLI to connect your ChatGPT account.' };
    base.installed = true;
    let rpc: CodexRpc | undefined;
    try {
      rpc = await this.connect();
      const result = await rpc.request('account/read', { refreshToken: true });
      const account = result?.account;
      if (account?.type !== 'chatgpt') return { ...base, authMode: account?.type === 'apiKey' ? 'api-key' : 'unknown',
        error: 'Sign in with ChatGPT using Connect OpenAI. Relay uses its own isolated official CLI profile.' };
      const values:any[]=[],cursors=new Set<string>();let cursor:string|undefined;
      do{
        const page=await rpc.request('model/list',{limit:100,includeHidden:false,...(cursor?{cursor}:{})});
        if(!Array.isArray(page?.data)||values.length+page.data.length>20000)throw new Error('Codex model catalog exceeds the supported discovery bound');
        values.push(...page.data);const next=page.nextCursor;
        if(next!==undefined&&next!==null&&(typeof next!=='string'||!next||next.length>1024||cursors.has(next)))throw new Error('Codex returned an invalid or repeated model catalog cursor');
        cursor=next??undefined;if(cursor)cursors.add(cursor);
      }while(cursor);
      const ids=new Set<string>(),observedAt=new Date().toISOString();
      this.catalog = values.filter((model: any) => typeof model.model === 'string' && !model.hidden&&!ids.has(model.model)&&Boolean(ids.add(model.model))).map((model: any) => ({
        id: model.model, name: String(model.displayName ?? model.model), description: String(model.description ?? ''), verified: this.verified.has(model.model),provenance:{source:'codex:model/list',observedAt},...(Number.isSafeInteger(model.contextWindow)&&model.contextWindow>0?{contextWindow:model.contextWindow}:{}), ...(catalogInputModalities(model.inputModalities) ? { inputModalities: catalogInputModalities(model.inputModalities), inputModalitiesSource: 'provider-catalog' as const } : {}),
      }));
      const state:ProviderConnection={ ...base, authenticated: true, authMode: 'subscription', accountLabel: String(account.email ?? '').slice(0, 180),plan: String(account.planType ?? '').slice(0, 80), models: this.catalog };
      return {...state,allowance:await readCodexAllowance(rpc,state)};
    } catch (error) { return { ...base, error: safeError(error) }; }
    finally { if (rpc) await this.dispose(rpc); }
  }
  async login() {
    if (this.loginConnection) await this.dispose(this.loginConnection);
    const rpc = await this.connect(300);
    this.loginConnection = rpc;
    try {
      const login = await rpc.request('account/login/start', { type: 'chatgpt' });
      const url = new URL(login.authUrl);
      if (url.protocol !== 'https:' || !['auth.openai.com', 'auth.chatgpt.com', 'chatgpt.com'].includes(url.hostname)) throw new Error('Codex returned an unexpected login URL');
      const remove = rpc.listen(message => {
        if (message.method === 'account/login/completed') { remove(); this.loginConnection = undefined; void this.dispose(rpc); }
      });
      void rpc.job.finished.finally(() => { this.active.delete(rpc); if (this.loginConnection === rpc) this.loginConnection = undefined; }).catch(() => {});
      return { url: url.href, message: 'Open the official sign-in page to connect your ChatGPT account. Credentials remain in Relay’s isolated Codex profile.' };
    } catch (error) { this.loginConnection = undefined; await this.dispose(rpc); throw new Error(safeError(error)); }
  }
  async stream(request: ProviderRequest, emit: (event: ProviderEvent) => void, signal: AbortSignal): Promise<ProviderResult> {
    const prompt = boundedPrompt(request);
    if (!/^[a-zA-Z0-9][\w.:-]{0,120}$/.test(request.model)) throw new Error('Invalid OpenAI model');
    const native = request.mode === 'agent';
    const work = request.mode === 'work' || native ? await workDirectory(request) : undefined;
    if (native && !request.interact) throw new Error('Codex native mode requires a host approval connection');
    const appTools = request.appTools ? createAppToolSession(request.appTools, signal) : undefined;
    const rpc = await this.connect(request.maxSeconds, signal, work, native, Boolean(appTools),requestImages(request).reduce((n,image)=>n+image.data.length+200,0));
    try {
      const auth = await rpc.request('account/read', { refreshToken: true });
      if (auth?.account?.type !== 'chatgpt') throw new Error('ChatGPT subscription authentication expired or is unavailable; reconnect OpenAI');
      if (request.expectedAccount?.accountLabel !== String(auth.account.email ?? '').slice(0, 180)
        || request.expectedAccount?.plan !== String(auth.account.planType ?? '').slice(0, 80))
        throw new Error('OpenAI account or plan changed after billing approval; refresh connections and confirm billing again');
      const cwd = work ?? await ensureWorkspace(this.dataDir, this.id);
      const approvalPolicy = native ? 'on-request' : 'never';
      const thread = await rpc.request('thread/start', { model: request.model, modelProvider: 'openai', cwd, sandbox: work ? 'workspace-write' : 'read-only',
        approvalPolicy, ephemeral: true, ...(appTools ? { dynamicTools: [{ type: 'namespace', name: 'relay_app', description: 'Relay app actions', tools: appTools.definitions.map(tool => ({ type: 'function', ...tool })) }] } : {}),
        ...(!native ? { baseInstructions: work ? WORK_INSTRUCTIONS : appTools ? 'You are a helpful assistant. Use the supplied Relay workspace tools for requested tasks, coordination, knowledge, artifacts and browser work when available. Agent mode carries the human task through app and browser actions without repeated approval prompts; ask essential questions in chat. You have no native filesystem or shell tools.' : 'You are a helpful text-only assistant. You have no executable tools. Answer in text.' } : {}),
        developerInstructions: request.instructions, config: native ? CODEX_AGENT_CONFIG : work ? CODEX_WORK_CONFIG : appTools ? CODEX_APP_CONFIG : CODEX_CONFIG });
      if (!thread?.thread?.id || thread.sandbox?.type !== (work ? 'workspaceWrite' : 'readOnly') || thread.sandbox.networkAccess !== false || thread.approvalPolicy !== approvalPolicy)
        throw new Error(`Codex did not enforce the required sandbox (${policyDiagnostic(thread, rpc.sandboxBackend, Boolean(work), native)}). No turn started. Check the official CLI sandbox configuration before retrying.`);
      if (thread.modelProvider !== 'openai' || thread.model !== request.model) throw new Error('Codex selected an unexpected provider or model; no fallback is permitted');
      const turn = new CodexTurn(thread.thread.id, thread.model, emit, native ? 'native' : Boolean(work), new Set(appTools?.definitions.map(tool => tool.name)),rpc.retained);
      let startedTurn: string | undefined;
      let resolveTurn!: (id: string) => void;
      let rejectTurn!: (error: Error) => void;
      const turnReady = new Promise<string>((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
      void turnReady.catch(() => {});
      if (native || appTools) rpc.handleRequests(async (message, interactionSignal) => {
        try {
        const turnId = startedTurn ?? await turnReady;
        if (signal.aborted) throw new Error('Run cancelled');
        if (message.method === 'item/tool/call') {
          const p = message.params;
          if (!appTools || turn.ended || !record(p) || p.threadId !== thread.thread.id || p.turnId !== turnId || p.namespace !== 'relay_app') throw new Error('Codex app-tool call is outside the active thread and turn');
          try {
            const value = await appTools.call(p.callId, p.tool, p.arguments, interactionSignal);
            return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] };
          } catch (error) {
            if (!(error instanceof AppToolExecutionError) || signal.aborted || interactionSignal.aborted || turn.ended) throw error;
            const guidance = p.tool === 'relay_check_change'
              ? 'Inspect relay_harness_status for this draft’s checkLog and read the failing source with relay_read_change. Repair it and check again with a new call ID.'
              : 'Inspect the action’s current status before an explicit new request. A failure does not prove that no side effect occurred; do not replay uncertain actions.';
            return { success: false, contentItems: [{ type: 'inputText', text: appToolDiagnostic(error.cause) + '\n' + guidance }] };
          }
        }
        if (!native) throw new Error('Codex requested a disabled host action in app-only mode');
        const fileDetails = message.method === 'item/fileChange/requestApproval' ? turn.pinFileChangeDetails(message.params?.itemId) : undefined;
        try { return await codexInteraction(message, thread.thread.id, turnId, request.interact!, emit, AbortSignal.any([signal, interactionSignal]),
          itemId => fileDetails ? fileDetails.details : turn.fileChangeDetails(itemId)); }
        finally { fileDetails?.release(); }
        } catch (error) { appTools?.close(); throw error; }
      });
      const remove = rpc.listen(message => {
        try { turn.accept(message); if (turn.ended) appTools?.close(); }
        catch (error) { appTools?.close(); throw error; }
      });
      try {
        const started = await rpc.request('turn/start', { threadId: thread.thread.id, model: request.model,
          approvalPolicy, sandboxPolicy: work ? { type: 'workspaceWrite', writableRoots: [work], networkAccess: false } : { type: 'readOnly', networkAccess: false }, input: [{ type: 'text', text: prompt, text_elements:[] },...requestImages(request).map(image=>({type:'image',url:'data:'+image.mimeType+';base64,'+image.data}))] });
        if (!started?.turn?.id) throw new Error('Codex did not return a turn identifier');
        startedTurn = started.turn.id; resolveTurn(started.turn.id);
        turn.start(started.turn.id);
        if (turn.ended) appTools?.close();
        const result = await Promise.race([turn.result, rpc.failed]);
        this.verified.add(request.model);
        return result;
      } finally { rejectTurn(new Error('Codex turn ended')); remove(); }
    } catch (error) { throw new Error(safeError(error)); }
    finally { appTools?.close(); await this.dispose(rpc); }
  }
  async close(): Promise<void> { this.connectionGeneration++; await Promise.all([...this.active].map(rpc => this.dispose(rpc))); this.loginConnection = undefined; }
}
