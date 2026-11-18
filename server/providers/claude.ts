import {claudeTextEnvelope,claudeNativeEnvelope,assertWireBudget} from '../context-wire.js';
import {validTurnUsage,reportedUsageCounters} from '../../shared/provider-usage.js';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import { resolve } from 'node:path';
import type { InteractionPrompt, ModelInfo, ProviderAdapter, ProviderConnection, ProviderEvent, ProviderRequest, ProviderResult } from '../../shared/types.js';
import { boundedPrompt, childEnvironment, launch, killOwned, ensureWorkspace, findCommand, OwnedProcess, safeError, toolSummary, workDirectory, type Command, type Launcher } from './process.js';
import { createAppToolsBridge } from '../app-tools-bridge.js';
import {claudeImageModel, CLAUDE_IMAGE_CONTRACT} from '../../shared/claude-image-contract.js';

export const CLAUDE_SAFE_ARGS = ['--safe-mode', '--restricted', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  '--disable-slash-commands', '--setting-sources', '', '--settings', '{"disableAllHooks":true}', '--no-chrome'];
// Work mode (verified against claude 2.1.292 by real calls): --tools names the only built-in tools offered; --allowedTools pre-approves them so
// nothing prompts (--permission-mode dontAsk + --permission-prompts none deny everything else). File access is path-scoped to the working
// directory with Read(./**) / Edit(./**) (Edit rules cover Write and NotebookEdit; Read rules cover Glob/Grep); a bare Read/Edit would allow any
// path. --restricted additionally confines file tools, and --disallowedTools denies web tools, common network clients, and reads/edits of Relay's
// data dir, .env files and common secret folders under ~. MCP, hooks, plugins, skills, settings files, Task/subagents and the browser stay off
// through the unchanged safe args.
// LIMITATION: Claude Code has no OS sandbox on Windows. Bash is NOT confined to the workspace (a shell command can still read or write
// anywhere the user can) and the Bash deny rules are best-effort pattern matches a determined model could evade. Only the file tools are scoped.
export const CLAUDE_WORK_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'NotebookEdit'];
export const CLAUDE_WORK_ALLOWED = ['Read(./**)', 'Edit(./**)', 'Bash'];
const SECRET_PATHS = ['~/.ssh/**', '~/.aws/**', '~/.claude/**', '~/.config/**', '**/.env', '**/.env.*'];
export const CLAUDE_WORK_DENIED = ['WebFetch', 'WebSearch', 'Task', 'Agent', 'Bash(curl *)', 'Bash(wget *)', 'Bash(Invoke-WebRequest *)', 'Bash(Invoke-RestMethod *)',
  'Bash(iwr *)', 'Bash(irm *)', 'Bash(ssh *)', 'Bash(scp *)', 'Bash(nc *)', 'Bash(ncat *)', 'Bash(telnet *)', 'Bash(ftp *)', 'Bash(git push *)', 'Bash(npm publish *)',
  ...SECRET_PATHS.flatMap(path => [`Read(${path})`, `Edit(${path})`])];
/** Deny rules for Relay's own data dir (absolute-path rule syntax: // + forward slashes, drive letter without colon on Windows). */
export function claudeWorkDenied(dataDir: string): string[] {
  const abs = '//' + resolve(dataDir).replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d: string) => d.toLowerCase()) + '/**';
  return [...CLAUDE_WORK_DENIED, `Read(${abs})`, `Edit(${abs})`];
}
export function claudeSafeArgs(mode: 'chat' | 'work' = 'chat'): string[] {
  const args = [...CLAUDE_SAFE_ARGS];
  if (mode === 'work') args.splice(args.indexOf('--tools') + 1, 1, CLAUDE_WORK_TOOLS.join(','));
  return args;
}
// Session settings take precedence over user/project settings. Verify the effective settings again
// inside the inference process: managed policy can override these values and must fail closed.
export const CLAUDE_AGENT_ENV = {
  ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: '', ANTHROPIC_CUSTOM_HEADERS: '', CLAUDE_CODE_OAUTH_TOKEN: '',
  CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '0', CLAUDE_CODE_USE_FOUNDRY: '0',
};
export const CLAUDE_AGENT_SETTINGS = { apiKeyHelper: '', env: CLAUDE_AGENT_ENV };
export const CLAUDE_AGENT_ARGS = ['--setting-sources', 'user,project,local', '--settings', JSON.stringify(CLAUDE_AGENT_SETTINGS)];
export function assertNativeClaudeSettings(value: any): void {
  const effective = value?.effective;
  if (!effective || effective.apiKeyHelper !== '' || !effective.env || typeof effective.env !== 'object')
    throw new Error('Claude native subscription routing could not be enforced; no prompt was sent');
  for (const [key, expected] of Object.entries(CLAUDE_AGENT_ENV)) if (effective.env[key] !== expected)
    throw new Error('Claude native configuration overrides the subscription route; no prompt was sent');
  const credentialRoute = /anthropic|(?:api.?key|auth.?token|oauth|bedrock|vertex|foundry)|(?:aws|google|azure).*(?:credential|token|endpoint)/i;
  for (const [key, configured] of Object.entries(effective.env)) if (credentialRoute.test(key) && !Object.hasOwn(CLAUDE_AGENT_ENV, key) && configured)
    throw new Error('Claude native configuration contains an unsupported credential or provider override; no prompt was sent');
}
const CHAT_PROMPT = 'You are a helpful text-only assistant. The input JSON envelope contains agent instructions and canonical conversation history. Apply agentInstructions as guidance. Preserve the original roles inside conversation content. Do not execute tools.';
const WORK_PROMPT = 'You are a coding assistant working inside the current directory (the project folder). The input JSON envelope contains agent instructions and canonical conversation history; apply agentInstructions as guidance and preserve the original roles. Use your tools to complete the final user request, stay inside the current directory, never use the network, and finish with a short plain-text summary of what you did.';
const aliases = ['sonnet', 'opus', 'haiku'];
export interface ClaudeOptions {
  isolatedProfile?:boolean;
  command?: () => Promise<Command | null>; launcher?: Launcher;
  kill?: (child: ChildProcessWithoutNullStreams) => Promise<void>;
}

export class ClaudeStream {
  text = '';
  result?: ProviderResult;
  private sawDelta = false;
  private assistantText = '';
  private assistantModel?: string;
  private imageAssistantWitness = false;
  constructor(private emit: (event: ProviderEvent) => void, private expectedAlias?: string, private allowTools: boolean | 'native' | 'app' = false,
    private appToolNames: ReadonlySet<string> = new Set(), private expectedImageModel?: string) {}
  confirmPrimaryModel(model: unknown): void {
    if (!this.expectedImageModel || model === undefined) return;
    if (model !== this.expectedImageModel) throw new Error('Claude selected an unexpected image model; no fallback is permitted');
  }
  accept(value: any): void {
    if (this.allowTools === 'native' && value.parent_tool_use_id != null) return;
    if (this.result) {
      if (this.allowTools !== 'native') throw new Error('Claude returned data after its terminal result');
      if (!['assistant', 'stream_event', 'result'].includes(value.type)) {
        if (value.type === 'system' && value.subtype === 'init') this.confirmPrimaryModel(value.model);
        return;
      }
      this.result = undefined; this.text = ''; this.sawDelta = false; this.assistantText = '';
      // A native continuation is a new response. Reset before observing its first event.
      if (this.expectedImageModel) { this.imageAssistantWitness = false; this.assistantModel = undefined; }
    }
    if (value.type === 'assistant') {
      this.confirmPrimaryModel(value.message?.model);
      if (this.expectedImageModel && value.message?.model === this.expectedImageModel) this.imageAssistantWitness = true;
    }
    if (value.type === 'system' && value.subtype === 'init') this.confirmPrimaryModel(value.model);
    if (value.type === 'error') throw new Error(safeError(value.error?.message ?? value.message ?? 'Claude request failed'));
    if (value.type === 'stream_event') {
      const event = value.event;
      // message_start carries the primary assistant Message, including its serving model.
      // Explicit fallback blocks/iterations are documented model boundaries, not subagent usage.
      if (this.expectedImageModel) {
        if (event?.type === 'message_start') {
          this.confirmPrimaryModel(event.message?.model);
          this.imageAssistantWitness = event.message?.role === 'assistant' && event.message?.model === this.expectedImageModel;
        }
        if ((event?.type === 'content_block_start' && event.content_block?.type === 'fallback')
          || (event?.type === 'message_delta' && Array.isArray(event.usage?.iterations) && event.usage.iterations.some((part:any)=>part.type === 'fallback_message')))
          throw new Error('Claude changed the image model through fallback; no fallback is permitted');
      }
      if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use' && !this.allowTools) throw new Error('Claude attempted a tool call; tools are disabled');
      if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
        this.sawDelta = true; this.text += event.delta.text; this.emit({ type: 'delta', text: event.delta.text });
      }
    } else if (value.type === 'assistant') {
      if (typeof value.message?.model === 'string') this.assistantModel = value.message.model;
      const content = value.message?.content;
      if (this.expectedImageModel && ((Array.isArray(content) && content.some((part:any)=>part.type === 'fallback'))
        || (Array.isArray(value.message?.usage?.iterations) && value.message.usage.iterations.some((part:any)=>part.type === 'fallback_message'))))
        throw new Error('Claude changed the image model through fallback; no fallback is permitted');
      if (Array.isArray(content)) {
        for (const part of content) if (part.type === 'tool_use') {
          if (!this.allowTools) throw new Error('Claude attempted a tool call; tools are disabled');
          const name = String(part.name ?? '');
          if (this.allowTools !== 'native' && !this.appToolNames.has(name) && !(this.allowTools !== 'app' && CLAUDE_WORK_TOOLS.includes(name))) throw new Error(`Claude attempted a disallowed tool (${name.slice(0, 60)}); the run was stopped`);
          const input = part.input ?? {};
          this.emit({ type: 'tool', name, summary: toolSummary(input.command ?? input.file_path ?? input.notebook_path ?? input.pattern ?? input) });
        }
        this.assistantText += content.filter((part: any) => part.type === 'text').map((part: any) => part.text ?? '').join('');
      }
      if (value.error) throw new Error(safeError(value.error));
    } else if (value.type === 'result') {
      if (value.is_error || value.subtype !== 'success') throw new Error(safeError(value.errors?.join('; ') ?? value.result ?? 'Claude did not complete successfully'));
      if (this.expectedImageModel && Array.isArray(value.usage?.iterations) && value.usage.iterations.some((part:any)=>part.type === 'fallback_message'))
        throw new Error('Claude changed the image model through fallback; no fallback is permitted');
      // Aggregate usage can include native subagents. Without an exact assistant witness,
      // only a single unambiguous concrete model is sufficient evidence.
      if (this.expectedImageModel && !this.imageAssistantWitness) {
        const models = Object.keys(value.modelUsage ?? {});
        if (models.length !== 1 || models[0] !== this.expectedImageModel)
          throw new Error('Claude did not confirm the pinned image model; no fallback is permitted');
      }
      const full = typeof value.result === 'string' ? value.result : this.assistantText;
      // Work mode: text streams across several assistant turns but result.result is only the final message, which is authoritative.
      if (this.allowTools && full && !full.startsWith(this.text)) { this.text = full; if (!this.sawDelta) this.emit({ type: 'delta', text: full }); }
      else if (!this.sawDelta) { this.text = full; if (full) this.emit({ type: 'delta', text: full }); }
      else if (full && full !== this.text) {
        if (!full.startsWith(this.text)) throw new Error('Claude final response did not match the streamed response');
        const suffix = full.slice(this.text.length); this.text = full;
        if (suffix) this.emit({ type: 'delta', text: suffix });
      }
      if (!this.text) throw new Error('Claude completed without response text');
      const usage = value.usage;
      const concreteModel = this.assistantModel ?? Object.keys(value.modelUsage ?? {})[0];
      if (!this.expectedImageModel && this.expectedAlias && (!concreteModel || !new RegExp(`^claude-${this.expectedAlias}(?:[-.]|$)`).test(concreteModel)))
        throw new Error('Claude selected an unexpected model family; no fallback is permitted');
      this.result = { text: this.text, sessionId: typeof value.session_id === 'string' ? value.session_id : undefined,
        usageCounters:reportedUsageCounters(usage?{inputTokens:usage.input_tokens,outputTokens:usage.output_tokens,cachedInputTokens:usage.cache_read_input_tokens,cacheWriteTokens:usage.cache_creation_input_tokens}:undefined),
        usage: validTurnUsage(usage ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, cachedInputTokens: usage.cache_read_input_tokens } : undefined),
        actualModel: this.expectedAlias ?? concreteModel };
    }
  }
  finish(code: number | null): ProviderResult {
    if (code !== 0) throw new Error('Claude process exited unsuccessfully');
    if (!this.result) throw new Error('Claude process ended before a successful result');
    return this.result;
  }
}

export function claudeAuth(value: any): Pick<ProviderConnection, 'authenticated' | 'authMode' | 'accountLabel' | 'plan'> {
  const subscription = value.loggedIn === true && value.authMethod === 'claude.ai' && value.apiProvider === 'firstParty';
  return { authenticated: subscription, authMode: subscription ? 'subscription' : /api.?key/i.test(String(value.authMethod)) ? 'api-key' : 'unknown',
    accountLabel: subscription && typeof value.email === 'string' ? value.email.slice(0, 180) : '',
    plan: subscription && typeof value.subscriptionType === 'string' ? value.subscriptionType.slice(0, 80) : '' };
}

const object = (value: unknown): value is Record<string, any> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
// Wire messages are taken from the official CLI control protocol (also used by Anthropic's
// open-source Python SDK query.py); this adapter launches only the user's installed CLI.
class ClaudeNativeControl {
  private nextId = 0;
  private pending = new Map<string, { resolve(value: any): void; reject(error: Error): void }>();
  private incoming = new Map<string, AbortController>();
  private seenIds = new Set<string>();
  private closed = false;
  private accepting = false;
  private sessionState?: string;
  private tasks = new Set<string>();
  private endQueued = false;
  constructor(private job: () => OwnedProcess, private parser: ClaudeStream, private request: ProviderRequest,
    private emit: (event: ProviderEvent) => void, private signal: AbortSignal, private revokeAppTools: () => void = () => {}) {}
  open(): void { this.accepting = true; }
  end(error = new Error('Claude native connection closed')): void {
    this.closed = true; this.accepting = false;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const pending of this.incoming.values()) pending.abort(); this.incoming.clear();
  }
  call(subtype: string, extra: Record<string, unknown> = {}): Promise<any> {
    if (this.closed || this.signal.aborted) return Promise.reject(new Error('Claude native connection closed'));
    const request_id = `relay-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      this.pending.set(request_id, { resolve, reject });
      this.job().write({ type: 'control_request', request_id, request: { subtype, ...extra } });
    });
  }
  accept(value: any): void {
    if (this.closed) return;
    if (value.type === 'control_response') {
      const response = value.response;
      const pending = this.pending.get(response?.request_id);
      if (!pending) throw new Error('Claude returned an unexpected control response');
      this.pending.delete(response.request_id);
      if (response.subtype !== 'success' || !object(response.response)) pending.reject(new Error('Claude rejected or returned a malformed native control response'));
      else pending.resolve(response.response);
      return;
    }
    if (value.type === 'control_cancel_request') {
      const pending = this.incoming.get(value.request_id);
      this.incoming.delete(value.request_id); pending?.abort(); this.maybeEnd(); return;
    }
    if (value.type === 'control_request') {
      if (typeof value.request_id !== 'string' || !value.request_id || this.seenIds.has(value.request_id)) throw new Error('Claude returned an invalid or duplicate permission request');
      if (this.seenIds.size >= 1000) throw new Error('Claude permission request limit exceeded');
      this.seenIds.add(value.request_id);
      const controller = new AbortController(); this.incoming.set(value.request_id, controller);
      void this.handle(value.request, AbortSignal.any([this.signal, controller.signal])).then(response => {
        if (!this.closed && !this.signal.aborted && this.incoming.has(value.request_id)) {
          this.job().write({ type: 'control_response', response: { subtype: 'success', request_id: value.request_id, response } });
          this.incoming.delete(value.request_id); this.maybeEnd();
        }
      }, error => {
        if (!this.closed && this.incoming.has(value.request_id)) {
          this.job().write({ type: 'control_response', response: { subtype: 'error', request_id: value.request_id, error: safeError(error) } });
          this.job().fail(new Error(safeError(error)));
        }
      });
      return;
    }
    if (value.type === 'system') {
      if (value.subtype === 'session_state_changed') this.sessionState = value.state;
      if (typeof value.task_id === 'string') {
        if (value.subtype === 'task_started' && ['local_agent', 'local_workflow'].includes(value.task_type)) this.tasks.add(value.task_id);
        if (value.subtype === 'task_notification' || (value.subtype === 'task_updated' && ['completed', 'failed', 'stopped'].includes(value.patch?.status))) this.tasks.delete(value.task_id);
      }
    }
    this.parser.accept(value);
    this.maybeEnd();
  }
  private maybeEnd(): void {
    if (!this.accepting || !this.parser.result || this.sessionState !== 'idle' || this.tasks.size || this.incoming.size || this.endQueued) return;
    this.endQueued = true;
    // Re-check after the current stdout batch: a continuation may already be queued behind idle.
    setImmediate(() => {
      this.endQueued = false;
      if (!this.closed && !this.signal.aborted && this.parser.result && this.sessionState === 'idle' && !this.tasks.size && !this.incoming.size) {
        this.revokeAppTools();
        this.job().child.stdin.end();
      }
    });
  }
  private async handle(value: any, signal: AbortSignal): Promise<unknown> {
    if (!this.accepting || !object(value) || value.subtype !== 'can_use_tool' || typeof value.tool_name !== 'string' || !object(value.input))
      throw new Error('Claude requested an unsupported host action; the run was stopped');
    const input = value.input;
    let prompt: InteractionPrompt;
    if (value.tool_name === 'AskUserQuestion') {
      if (!Array.isArray(input.questions) || !input.questions.length || input.questions.length > 4 || input.questions.some((q: any) => !object(q) || typeof q.question !== 'string' || !q.question || !Array.isArray(q.options) || q.options.some((o: any) => typeof o?.label !== 'string')))
        throw new Error('Claude returned malformed user questions');
      if (new Set(input.questions.map((q: any) => q.question)).size !== input.questions.length) throw new Error('Claude question identifiers must be unique');
      prompt = { kind: 'question', title: 'Claude needs input', description: 'Answer the questions to continue.',
        questions: input.questions.map((q: any, index: number) => ({ id: `claude-q-${index}`, question: q.question, options: q.options.map((o: any) => o.label), multiple: q.multiSelect === true })) };
    } else prompt = { kind: 'approval', title: `Claude: ${toolSummary(value.display_name ?? value.tool_name)}`, description: toolSummary(value.description ?? value.decision_reason ?? 'Allow this tool call once?'), details: JSON.stringify(input) };
    const answer = await this.request.interact!(prompt, signal);
    if (this.closed || signal.aborted) throw new Error('Run cancelled');
    if (!object(answer) || !['allow', 'deny'].includes(answer.decision)) throw new Error('The host returned an invalid Claude approval answer');
    if (answer.decision !== 'allow') return { behavior: 'deny', message: 'The user declined this request.' };
    if (prompt.questions) {
      if (!object(answer.answers) || Object.keys(answer.answers).length !== prompt.questions.length) throw new Error('The host returned invalid Claude question answers');
      const answers = Object.fromEntries(prompt.questions.map((q, index) => {
        const values = Object.hasOwn(answer.answers!, q.id) ? answer.answers![q.id] : undefined;
        if (!Array.isArray(values) || !values.length || (!q.multiple && values.length !== 1) || values.some(v => typeof v !== 'string' || v.length > 20_000)) throw new Error('The host returned invalid Claude question answers');
        return [input.questions[index].question, q.multiple ? values : values[0]];
      }));
      return { behavior: 'allow', updatedInput: { ...input, answers } };
    }
    return { behavior: 'allow', updatedInput: input };
  }
}

export class ClaudeAdapter implements ProviderAdapter {
  readonly id = 'claude' as const;
  private active = new Set<OwnedProcess>();
  private loginChild?:ChildProcessWithoutNullStreams;
  private environment():NodeJS.ProcessEnv {const env=childEnvironment();if(this.options.isolatedProfile){const home=resolve(this.dataDir,'claude','home');Object.assign(env,{HOME:home,USERPROFILE:home,APPDATA:resolve(home,'AppData','Roaming'),LOCALAPPDATA:resolve(home,'AppData','Local'),XDG_CONFIG_HOME:resolve(home,'.config'),CLAUDE_CONFIG_DIR:resolve(home,'.claude')});}return env;}
  private verified = new Set<string>();
  constructor(private dataDir: string, private options: ClaudeOptions = {}) {}
  private command() { return this.options.command?.() ?? findCommand('claude'); }
  private models(): ModelInfo[] { return aliases.map(id => ({ id, name: `Claude ${id[0].toUpperCase()}${id.slice(1)}`, verified: this.verified.has(id),
    description:`Images use ${claudeImageModel(id)}; text uses the ${id} alias.`, inputModalities:['text','image'], inputModalitiesSource:'official-model-docs', imageModelBinding:{model:claudeImageModel(id)!,contract:CLAUDE_IMAGE_CONTRACT} })); }
  async inspect(signal?: AbortSignal): Promise<ProviderConnection> {
    const base: ProviderConnection = { id: this.id, installed: false, authenticated: false, authMode: 'unknown', accountLabel: '', plan: '', models: this.models() };
    const command = await this.command();
    if (!command) return { ...base, error: 'Install the official Claude Code CLI to connect a subscription.' };
    base.installed = true;
    let job: OwnedProcess | undefined;
    try {
      const cwd = await ensureWorkspace(this.dataDir, this.id);
      let status: any;
      job = new OwnedProcess(command, [...CLAUDE_SAFE_ARGS, 'auth', 'status', '--json'], cwd, this.environment(), 20,
        value => { status = value; }, signal, this.options.launcher, this.options.kill, 'json');
      this.active.add(job);
      job.child.stdin.end();
      const exit = await job.finished;
      if (!status || exit.code !== 0) return { ...base, error: 'Claude sign-in is not verified yet. Sign in from Connections, then refresh this account.' };
      const auth = claudeAuth(status);
      return { ...base, ...auth, ...(!auth.authenticated ? { error: 'Claude account subscription login is required; API credentials are not accepted.' } : {}) };
    } catch (error) { return { ...base, error: safeError(error) }; }
    finally { if (job) { this.active.delete(job); await job.stop(); } }
  }
  async login() {
    if(this.active.size||this.loginChild)throw new Error('Wait for this Claude account’s active operations before signing in');
    const command=await this.command();if(!command)throw new Error('Install the official Claude Code CLI before connecting this account');
    const cwd=await ensureWorkspace(this.dataDir,this.id),env=this.environment();if(this.options.isolatedProfile)await mkdir(env.CLAUDE_CONFIG_DIR!,{recursive:true});
    const child=(this.options.launcher??launch)(command,['auth','login'],cwd,env);this.loginChild=child;
    const stop=()=>void (this.options.kill??killOwned)(child).catch(()=>{});const timer=setTimeout(stop,300000);timer.unref();
    let bytes=0;const drain=(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>256*1024)stop();};child.stdout.on('data',drain);child.stderr.on('data',drain);child.stdin.on('error',()=>{});child.stdin.end();
    const clear=()=>{clearTimeout(timer);if(this.loginChild===child)this.loginChild=undefined;};child.once('close',clear);child.once('error',clear);
    await new Promise<void>((done,reject)=>{child.once('spawn',()=>done());child.once('error',()=>reject(new Error('Official Claude sign-in could not start')));if(child.pid)done();});
    return {message:this.options.isolatedProfile?'Official Claude sign-in started for this isolated profile. Complete the browser sign-in, then refresh this account. On macOS, profile credential isolation must still be verified; the inspected identity is checked before every dispatch.':'Official Claude sign-in started. Complete the browser sign-in, then refresh this account. Your existing default Claude profile stays in use; Relay never receives your credentials.'};
  }
  async stream(request: ProviderRequest, emit: (event: ProviderEvent) => void, signal: AbortSignal): Promise<ProviderResult> {
    if (request.mode === 'agent') return this.streamNative(request, emit, signal);
    const work = request.mode === 'work';
    const prompt = boundedPrompt(request);
    const wireInput=claudeNativeEnvelope(claudeTextEnvelope(request.instructions,prompt),request);assertWireBudget(JSON.stringify(claudeNativeEnvelope(claudeTextEnvelope(request.instructions,prompt))).length+1);
    const auth = await this.inspect(signal);
    if (signal.aborted) throw new Error('Run cancelled');
    if (!auth.authenticated || auth.authMode !== 'subscription') throw new Error(auth.error ?? 'Claude subscription authentication is required');
    if (request.expectedAccount?.accountLabel !== auth.accountLabel || request.expectedAccount?.plan !== auth.plan)
      throw new Error('Claude account or plan changed after billing approval; refresh connections and confirm billing again');
    if (!aliases.includes(request.model)) throw new Error('Unsupported Claude model alias');
    const imageModel = request.imageTable?.length ? claudeImageModel(request.model) : undefined;
    const command = await this.command();
    if (!command) throw new Error('Claude CLI is unavailable');
    const cwd = work ? await workDirectory(request) : await ensureWorkspace(this.dataDir, this.id);
    const bridge = request.appTools ? await createAppToolsBridge(request.appTools, signal, resolve(this.dataDir, 'app-tool-bridges')) : undefined;
    const parser = new ClaudeStream(emit, request.model, work || (bridge ? 'app' : false), new Set(bridge?.toolNames), imageModel);
    const safeArgs = claudeSafeArgs(work ? 'work' : 'chat');
    if (bridge) {
      // Verified against main-process initialize/mcp_status: safe-mode suppresses even
      // explicitly supplied MCP. Every other app-only restriction stays explicit here.
      safeArgs.splice(safeArgs.indexOf('--safe-mode'), 1);
      safeArgs[safeArgs.indexOf('--mcp-config') + 1] = JSON.stringify(bridge.mcpConfig);
    }
    let job: OwnedProcess | undefined;
    try {
      job = new OwnedProcess(command, [...safeArgs, '--no-session-persistence', '--include-partial-messages', '--input-format', 'stream-json', '--output-format', 'stream-json',
        '--verbose', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', ...(work || bridge ? ['--allowedTools', [...(work ? CLAUDE_WORK_ALLOWED : []), ...(bridge?.toolNames ?? [])].join(',')] : []),
        ...(work ? ['--disallowedTools', claudeWorkDenied(this.dataDir).join(',')] : []),
        '--model', imageModel ?? request.model, '--system-prompt', work ? WORK_PROMPT : bridge ? 'You are a helpful assistant. Apply the input guidance and use supplied Relay workspace tools for requested tasks, coordination, knowledge, artifacts and browser work when available. Agent mode carries the human task through app and browser actions without repeated approval prompts; ask essential questions in chat. Native shell and filesystem tools are unavailable.' : imageModel ? CHAT_PROMPT.replace('text-only ', '') : CHAT_PROMPT, '-p'], cwd, this.environment(), request.maxSeconds, value => {
          try { parser.accept(value); if (parser.result) bridge?.revoke(); }
          catch (error) { bridge?.revoke(); throw error; }
        }, signal, this.options.launcher, this.options.kill);
      this.active.add(job);
      job.input(JSON.stringify(wireInput)+'\n');
      const exit = await job.finished;
      const result = parser.finish(exit.code);
      this.verified.add(request.model);
      return result;
    } finally { await bridge?.close(); if (job) { this.active.delete(job); await job.stop(); } }
  }
  private async streamNative(request: ProviderRequest, emit: (event: ProviderEvent) => void, signal: AbortSignal): Promise<ProviderResult> {
    const prompt = boundedPrompt(request);
    const wireInput=claudeNativeEnvelope(prompt,request);assertWireBudget(JSON.stringify(claudeNativeEnvelope(prompt)).length+1+request.instructions.length);
    const cwd = await workDirectory(request);
    if (!request.interact) throw new Error('Claude native mode requires a host approval connection');
    if (!aliases.includes(request.model)) throw new Error('Unsupported Claude model alias');
    const imageModel = request.imageTable?.length ? claudeImageModel(request.model) : undefined;
    const command = await this.command();
    if (!command) throw new Error('Claude CLI is unavailable');
    // Verify authentication with the very same cwd and settings sources as the native run.
    let authValue: any;
    const authJob = new OwnedProcess(command, [...CLAUDE_AGENT_ARGS, 'auth', 'status', '--json'], cwd, this.environment(), 20,
      value => { authValue = value; }, signal, this.options.launcher, this.options.kill, 'json');
    this.active.add(authJob);
    try {
      authJob.child.stdin.end();
      const exit = await authJob.finished;
      const auth = claudeAuth(authValue ?? {});
      if (exit.code !== 0 || !auth.authenticated || auth.authMode !== 'subscription') throw new Error('Claude native mode requires Claude subscription authentication with the active project configuration');
      if (auth.accountLabel !== request.expectedAccount.accountLabel || auth.plan !== request.expectedAccount.plan)
        throw new Error('Claude account or plan changed after billing approval; refresh connections and confirm billing again');
    } finally { this.active.delete(authJob); await authJob.stop(); }
    const parser = new ClaudeStream(emit, request.model, 'native', new Set(), imageModel);
    const bridge = request.appTools ? await createAppToolsBridge(request.appTools, signal, resolve(this.dataDir, 'app-tool-bridges')) : undefined;
    let job!: OwnedProcess;
    const control = new ClaudeNativeControl(() => job, parser, request, emit, signal, () => bridge?.revoke());
    const env = this.environment(); env.CLAUDE_CODE_SDK_READS_SESSION_STATE = '1';
    try {
    job = new OwnedProcess(command, [...CLAUDE_AGENT_ARGS, ...(bridge ? ['--mcp-config', JSON.stringify(bridge.mcpConfig), '--allowedTools', bridge.toolNames.join(',')] : []), '--no-session-persistence', '--include-partial-messages', '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--verbose', '--permission-mode', 'manual', '--permission-prompts', 'host', '--tools', 'default', '--model', imageModel ?? request.model,
      '--append-system-prompt', request.instructions, '-p'], cwd, env, request.maxSeconds, value => {
        try { control.accept(value); } catch (error) { bridge?.revoke(); throw error; }
      }, signal, this.options.launcher, this.options.kill);
    this.active.add(job);
    void job.finished.then(() => control.end(), error => control.end(error));
      const initialized = await control.call('initialize', { hooks: null });
      parser.confirmPrimaryModel(initialized.model);
      const normalizePlan = (plan: unknown) => typeof plan === 'string' ? plan.toLowerCase().replace(/^claude[\W_]+/, '').replace(/[^a-z0-9]/g, '') : '';
      if (initialized.current_permission_mode !== 'default' || initialized.account?.apiProvider !== 'firstParty'
        || initialized.account?.email !== request.expectedAccount.accountLabel || !normalizePlan(initialized.account?.subscriptionType)
        || normalizePlan(initialized.account.subscriptionType) !== normalizePlan(request.expectedAccount.plan))
        throw new Error('Claude native process did not confirm the approved subscription account and manual permissions; no prompt was sent');
      assertNativeClaudeSettings(await control.call('get_settings'));
      if (signal.aborted) throw new Error('Run cancelled');
      control.open();
      emit({ type: 'status', message: process.platform === 'win32' ? 'Claude native tools use your CLI permissions. Windows does not provide an OS sandbox for Claude Code.' : 'Claude native tools use your CLI permissions and sandbox configuration.' });
      job.write(wireInput);
      const exit = await job.finished;
      const result = parser.finish(exit.code);
      this.verified.add(request.model);
      return result;
    } finally { control.end(); await bridge?.close(); if (job) { this.active.delete(job); await job.stop(); } }
  }
  async close(): Promise<void> { if(this.loginChild){await (this.options.kill??killOwned)(this.loginChild);this.loginChild=undefined;} await Promise.all([...this.active].map(job => { job.fail(new Error('Provider closed')); return job.stop(); })); this.active.clear(); }
}
