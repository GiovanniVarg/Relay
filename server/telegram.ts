import { IntegrationCredentials } from './integration-credentials.js';
import type { Agent, ChatMode, RunEvent, TelegramStatus } from '../shared/types.js';
import type { Store } from './store.js';
import type { Runs } from './runs.js';
import { HttpError, redactSecrets } from './security.js';
import { validateWorkspace } from './mode.js';
import { replyToRun } from './conversation-control.js';

/** Stored in kind 'telegram', keyed by agent id. The token never leaves the server. */
export interface TelegramRecord { id: string; token?: string; secretRef?: string; hasToken?: boolean; allowedUserId: number; enabled: boolean; offset: number; chatId?: number; botUsername: string; }
export interface TelegramOptions { fetch?: typeof fetch; pollSeconds?: number; progressMs?: number; baseUrl?: string; credentials?: IntegrationCredentials; }
interface Update { update_id: number; message?: { message_id: number; text?: string; from?: { id: number }; chat: { id: number; type: string } }; }
const MODES: ChatMode[] = ['chat', 'work', 'auto', 'agent'];
const HELP = 'Send a message to chat with this agent.\n/chat /work /auto /agent - set mode\n/mode - show mode\n/new - new conversation\n/stop - cancel the active run\n/status - run status\n/help - this text\nReply here to answer a question. Type stop to cancel the current task.';
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => { const t = setTimeout(done, ms); function done() { clearTimeout(t); signal.removeEventListener('abort', done); resolve(); } signal.addEventListener('abort', done); });
/** Split into Telegram-sized messages, preferring newline boundaries. */
export function chunk(text: string, size = 4096): string[] {
  const out: string[] = [];
  while (text.length > size) { let cut = text.lastIndexOf('\n', size); if (cut < size / 2) cut = size; out.push(text.slice(0, cut)); text = text.slice(cut).replace(/^\n/, ''); }
  if (text) out.push(text);
  return out;
}
export class TelegramBot {
  running = false; error: string | null = null; pending = new Set<Promise<void>>();
  private credentialRef?:string; private credentials:IntegrationCredentials;
  private abort = new AbortController(); private loop?: Promise<void>; private fetcher: typeof fetch;
  constructor(public store: Store, public runs: Runs, public agentId: string, private options: TelegramOptions = {}) { this.fetcher = options.fetch ?? fetch; this.credentials=options.credentials??new IntegrationCredentials(store); this.credentialRef=this.store.get<TelegramRecord>('telegram',agentId)?.secretRef; }
  private record() { const record=this.store.get<TelegramRecord>('telegram',this.agentId); return record?.secretRef&&record.secretRef===this.credentialRef&&!record.token?record:undefined; }
  async api<T = unknown>(method: string, body: Record<string, unknown>, signal?: AbortSignal, token = this.record() ? this.credentials.token(this.record()!) : undefined): Promise<T> {
    if (!token) throw new Error('Telegram is not configured');
    try {
      const res = await this.fetcher(`${this.options.baseUrl ?? 'https://api.telegram.org'}/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
      const data = await res.json() as { ok: boolean; result: T; description?: string };
      if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description ?? res.status}`);
      return data.result;
    } catch (error) { throw new Error(this.credentials.secrets.redact(redactSecrets(error instanceof Error ? error.message : String(error))).slice(0, 300)); }
  }
  start() { if (this.loop) return; this.running = true; this.loop = this.poll().finally(() => { this.running = false; }); }
  /** Does not await pending jobs: they finish when their runs do (Runs.close()/cancel ends them), so awaiting here could hang shutdown. */
  async stop() { this.abort.abort(); await this.loop; }
  async idle() { while (this.pending.size) await Promise.allSettled([...this.pending]); }
  private async poll() {
    const { signal } = this.abort; let delay = 1000;
    while (!signal.aborted) {
      try {
        const record = this.record(); if (!record?.enabled) return;
        const updates = await this.api<Update[]>('getUpdates', { offset: record.offset, timeout: this.options.pollSeconds ?? 25, allowed_updates: ['message'] }, signal);
        this.error = null; delay = 1000;
        for (const update of updates) {
          if (signal.aborted) break;
          const current = this.record(); if (!current || current.secretRef !== record.secretRef) break; // deleted or re-tokened meanwhile: never re-create or touch the record
          this.store.put('telegram', { ...current, offset: update.update_id + 1 }); // persist first: never replay a message (and its tool runs) after a crash
          await this.handle(update).catch(error => { this.error = redactSecrets(error instanceof Error ? error.message : String(error)); });
        }
      } catch (error) {
        if (signal.aborted) break;
        this.error = redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 300);
        await sleep(delay, signal); delay = Math.min(delay * 2, 60000);
      }
    }
  }
  private say(chatId: number, text: string) { return this.api('sendMessage', { chat_id: chatId, text }); }
  /** Handle one update. Only the allowlisted user in a private chat is ever answered. */
  async handle(update: Update) {
    const record = this.record(); const message = update.message;
    if (!record || !message?.text || message.from?.id !== record.allowedUserId || message.chat.type !== 'private') return;
    const chatId = message.chat.id; const text = message.text.trim(); if (!text) return;
    if (record.chatId !== chatId) this.store.put('telegram', { ...record, chatId });
    const agent = this.store.get<Agent>('agent', this.agentId); if (!agent) return;
    if (text.startsWith('/')) return this.command(agent, chatId, text);
    if (text.length > 16000) return void await this.say(chatId, 'Message is too long (16000 characters max).');
    const conversation = this.store.conversations(agent.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? this.store.createConversation(agent.id);
    try {
      const active = [...this.runs.active.values()].find(item => item.run.agentId === agent.id);
      if (active) {
        await replyToRun({ runs: this.runs, store: this.store }, active.run.id, text);
        return;
      }
      await this.runs.refresh();
      const { run } = this.runs.accept(agent, conversation.id, text, agent.routeMode, agent.model, agent.mode);
      const job: Promise<void> = this.follow(run.id, chatId).catch(() => {}).finally(() => this.pending.delete(job)); this.pending.add(job);
    } catch (error) { await this.say(chatId, error instanceof HttpError ? error.message.slice(0, 300) : 'Could not start the run.'); }
  }
  private async command(agent: Agent, chatId: number, text: string) {
    const name = text.split(/\s/)[0].slice(1).split('@')[0].toLowerCase();
    const mode = MODES.find(m => m === name);
    if (mode) {
      if (mode === 'work' && !agent.workspace) return void await this.say(chatId, 'No workspace is set for this agent. Set one in Relay first.');
      if ((mode === 'work' || mode === 'auto') && agent.workspace) {
        try { validateWorkspace(agent.workspace, this.store.dataDir, 'work'); }
        catch (error) { return void await this.say(chatId, error instanceof HttpError ? error.message : 'Choose a valid project folder in Relay before enabling this mode.'); }
      }
      this.store.put('agent', { ...agent, mode, updatedAt: new Date().toISOString() }); return void await this.say(chatId, `Mode: ${mode}`);
    }
    const active = [...this.runs.active.values()].find(a => a.run.agentId === agent.id);
    if (name === 'mode') return void await this.say(chatId, `Mode: ${agent.mode}\nWorkspace: ${agent.workspace ? 'set' : 'none'}`);
    if (name === 'new') { this.store.createConversation(agent.id); return void await this.say(chatId, 'Started a new conversation.'); }
    if (name === 'stop') { if (!active) return void await this.say(chatId, 'Nothing is running.'); await this.runs.cancel(active.run.id); return; }
    if (name === 'status') return void await this.say(chatId, active ? `Running (${active.run.mode ?? 'chat'} mode) since ${active.run.startedAt}${this.runs.pendingInteractions(active.run.id).length ? '\nAwaiting your answer. Reply here to continue, or type stop.' : ''}` : `Idle. Mode: ${agent.mode}`);
    await this.say(chatId, HELP);
  }
  /** Stream progress and the final reply. Questions can be answered in the same allowlisted private chat. */
  private async follow(runId: string, chatId: number) {
    const lines: string[] = []; const notifiedInteractions = new Set<string>(); let progressId = 0; let last = 0; let timer: ReturnType<typeof setTimeout> | undefined; let sending = Promise.resolve();
    const flush = () => { timer = undefined; last = Date.now(); const text = ['Working...', ...lines.slice(-6)].join('\n').slice(0, 4000);
      sending = sending.then(async () => { try { if (progressId) await this.api('editMessageText', { chat_id: chatId, message_id: progressId, text }); else progressId = (await this.api<{ message_id: number }>('sendMessage', { chat_id: chatId, text })).message_id; } catch {} }); };
    const typing = () => void this.api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {}); typing(); const interval = setInterval(typing, 4000);
    const done = await new Promise<Extract<RunEvent, { type: 'done' }>>(resolve => {
      let unsubscribe: (() => void) | undefined; let finished = false as boolean;
      unsubscribe = this.runs.subscribe(runId, event => {
        if (event.type === 'tool') { lines.push(`${event.name}: ${event.summary}`.slice(0, 200)); const wait = (this.options.progressMs ?? 3000) - (Date.now() - last); if (wait <= 0) flush(); else if (!timer) timer = setTimeout(flush, wait); }
        else if (event.type === 'interaction' && event.interaction.status === 'pending' && !notifiedInteractions.has(event.interaction.id)) {
          notifiedInteractions.add(event.interaction.id);
          sending = sending.then(async () => { try { const prompt = event.interaction;
            const questions = (prompt.questions ?? []).map(question => `${(prompt.questions?.length ?? 0) > 1 ? question.id + ': ' : ''}${question.question}${question.options?.length ? '\nOptions: ' + question.options.join(' / ') : ''}`).join('\n');
            const instruction = prompt.kind === 'approval' ? 'Reply yes or no here.' : (prompt.questions?.length ?? 0) > 1 ? 'Reply with one line per question as question ID: answer. Separate multiple choices with |.' : 'Reply here with your answer.';
            for (const part of chunk([redactSecrets(prompt.title), redactSecrets(questions), instruction, 'Type stop to end the task.'].filter(Boolean).join('\n'))) await this.say(chatId, part); } catch {} });
        }
        else if (event.type === 'done') { finished = true; unsubscribe?.(); resolve(event); }
      });
      if (finished) unsubscribe?.();
    });
    clearInterval(interval); if (timer) clearTimeout(timer); await sending;
    const reply = done.message.status === 'complete' ? done.message.content : done.run.status === 'cancelled' ? 'Stopped.' : `Run ${done.run.status}: ${redactSecrets(done.run.error ?? 'unknown error')}`.slice(0, 1000);
    for (const part of chunk(reply)) await this.say(chatId, part);
  }
}
/** One bot per enabled agent record. */
export class Telegram {
  bots = new Map<string, TelegramBot>();
  readonly credentials:IntegrationCredentials; private generations=new Map<string,number>(); private connecting=Promise.resolve(); private closed=false;
  constructor(public store: Store, public runs: Runs, public options: TelegramOptions = {}) { this.credentials=options.credentials??new IntegrationCredentials(store); this.options={...options,credentials:this.credentials}; }
  startAll() { for (const record of this.store.list<TelegramRecord>('telegram')) this.sync(record.id); }
  /** (Re)start or stop the agent's bot to match its stored record. */
  sync(agentId: string) {
    void this.bots.get(agentId)?.stop(); this.bots.delete(agentId);
    if (this.store.get<TelegramRecord>('telegram', agentId)?.enabled && !this.credentials.error('telegram',agentId) && this.store.get<TelegramRecord>('telegram',agentId)?.secretRef) { const bot = new TelegramBot(this.store, this.runs, agentId, this.options); this.bots.set(agentId, bot); bot.start(); }
  }
  async verify(token: string): Promise<string> {
    this.credentials.secrets.add(token); try { return (await new TelegramBot(this.store, this.runs, '', this.options).api<{ username?: string }>('getMe', {}, AbortSignal.timeout(10000), token)).username ?? ''; }
    catch { throw new HttpError(400, 'Telegram rejected this bot token'); }
  }
  status(agentId: string): TelegramStatus {
    const record = this.store.get<TelegramRecord>('telegram', agentId); const bot = this.bots.get(agentId);
    return this.credentials.secrets.redact({ configured: !!record, enabled: !!record?.enabled, botUsername: record?.botUsername ?? '', allowedUserId: record?.allowedUserId ?? null, running: !!bot?.running, error: this.credentials.error('telegram',agentId) ?? bot?.error ?? null });
  }
  async connect(agentId:string,token:string,allowedUserId:number,enabled:boolean,check:()=>void=()=>{}) {
    const version=(this.generations.get(agentId)??0)+1;this.generations.set(agentId,version);
    const guard=()=>{check();if(this.closed||this.generations.get(agentId)!==version)throw new HttpError(409,'Telegram setup was revoked or replaced');};
    const operation=this.connecting.then(async()=>{await this.credentials.initialize();guard();if(this.credentials.duplicate('telegram',agentId,token))throw new HttpError(400,'That bot token is already used by another agent');const botUsername=await this.verify(token);guard();const existing=this.store.get<TelegramRecord>('telegram',agentId),same=existing&&!existing.token&&!!existing.secretRef&&!this.credentials.error('telegram',agentId)&&this.credentials.token(existing)===token;await this.credentials.replace('telegram',{id:agentId,allowedUserId,enabled,offset:same?existing.offset:0,botUsername,...(same&&existing.allowedUserId===allowedUserId&&existing.chatId?{chatId:existing.chatId}:{})},token,guard);guard();this.sync(agentId);return this.status(agentId);});this.connecting=operation.then(()=>{},()=>{});return operation;
  }
  async remove(agentId:string) {this.generations.set(agentId,(this.generations.get(agentId)??0)+1);const stopped=this.bots.get(agentId)?.stop();this.bots.delete(agentId);await this.credentials.remove('telegram',agentId);await stopped;return this.status(agentId);}
  async stop() { this.closed=true;await this.connecting;await Promise.all([...this.bots.values()].map(b => b.stop())); this.bots.clear(); }
}
