import { createHash, randomUUID } from 'node:crypto';
import { homedir, hostname, platform } from 'node:os';
import { TYPESAFE_CREDENTIAL_PREFIX } from '../shared/typesafe.js';
import { INTEGRATION_CREDENTIAL_PREFIX } from '../shared/integration-credentials.js';
import type { RemoteFinish, RemoteInventory, RemoteJobEvent, RemoteJobPayload, RemotePoll, RemoteQuestion } from '../shared/remote-jobs.js';

export interface WorkerTransport { request<T = unknown>(path: string, method?: string, body?: unknown): Promise<T> }
export interface WorkerExecutionSnapshot {
  state: 'running' | 'complete' | 'failed' | 'cancelled' | 'unknown';
  text?: string; summary?: string; progress?: string; question?: RemoteQuestion;
  outcomeComplete?: boolean; terminationConfirmed?: boolean;
}
export interface WorkerExecution {
  id: string; snapshot(): Promise<WorkerExecutionSnapshot> | WorkerExecutionSnapshot;
  answer(questionId: string, answers: Record<string, string>): Promise<void> | void;
  cancel(): Promise<{ terminationConfirmed: boolean }>;
}
export interface WorkerExecutor { inventory(): Promise<RemoteInventory> | RemoteInventory; start(payload: RemoteJobPayload, requestKey: string): Promise<WorkerExecution> }
export interface WorkerJournal {
  id: string; jobId: string; job: NonNullable<RemotePoll['job']>; leaseId: string; instanceId: string;
  phase: 'accepted' | 'launching' | 'running' | 'finished' | 'unknown'; sequence: number;
  executionId?: string; pendingEvent?: RemoteJobEvent; pendingReceipt?: RemoteFinish;
  pendingEventHash?: string; pendingReceiptHash?: string;
  lastObservation?: string; answered?: string[];
}
export interface WorkerJournalStore { get(id: string): WorkerJournal | undefined; put(record: WorkerJournal): unknown }
const ACTIVE = 'worker-active';
function hash(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function bounded(value: string | undefined, max: number) { return (value ?? '').slice(0, max); }
export class WorkerRuntime {
  readonly instanceId: string;
  stopped = false;
  lastError?: string;
  private current?: WorkerJournal;
  private execution?: WorkerExecution;
  private payload?: RemoteJobPayload;
  private initialized = false;
  private lastHeartbeat = -Infinity;
  private lastPoll = -Infinity;
  private lastObservation = -Infinity;
  private ticking?: Promise<void>;
  constructor(private transport: WorkerTransport, private executor: WorkerExecutor, private journal: WorkerJournalStore, private options: { instanceId?: string; clock?: () => number; heartbeatMs?: number; pollMs?: number; observeMs?: number } = {}) { this.instanceId = options.instanceId ?? randomUUID(); }
  private now() { return this.options.clock?.() ?? Date.now(); }
  private save() { if (this.current) { this.journal.put(structuredClone(this.current)); this.journal.put({ ...structuredClone(this.current), id: ACTIVE }); } }
  private route(action: string) { return '/api/network/worker/jobs/' + encodeURIComponent(this.current!.jobId) + '/' + action; }
  private identity() { return { leaseId: this.current!.leaseId, instanceId: this.current!.instanceId }; }
  private receipt(state: RemoteFinish['state'], summary: string, text = '', terminationConfirmed?: boolean) {
    const j = this.current!; j.pendingReceipt = { sequence: (j.pendingEvent?.sequence ?? j.sequence) + 1, state, text: bounded(text, 64000), summary: bounded(summary, 4000), ...(terminationConfirmed === undefined ? {} : { terminationConfirmed }) };
    j.pendingReceiptHash = hash(j.pendingReceipt);
    if (state === 'unknown') j.phase = 'unknown'; this.save();
  }
  private initialize() {
    if (this.initialized) return; this.initialized = true;
    const old = this.journal.get(ACTIVE); if (!old || old.phase === 'finished') return;
    this.current = { ...old, id: old.jobId };
    // No execution handle or ephemeral payload survives restart. Never call start again.
    if (!this.current.pendingReceipt) {
      if (this.current.phase === 'accepted') this.receipt('cancelled', 'Worker restarted before launch; no process was started.', '', true);
      else this.receipt('unknown', 'Worker restarted; inspect the previous local execution before retrying.');
    }
  }
  private async flush() {
    const j = this.current; if (!j) return;
    if (j.pendingEvent) {
      if (j.pendingEventHash !== hash(j.pendingEvent)) throw new Error('Journal event integrity changed');
      await this.transport.request(this.route('events'), 'POST', { ...this.identity(), event: j.pendingEvent });
      j.sequence = j.pendingEvent.sequence; delete j.pendingEvent; delete j.pendingEventHash; this.save();
    }
    if (j.pendingReceipt) {
      if (j.pendingReceiptHash !== hash(j.pendingReceipt)) throw new Error('Journal receipt integrity changed');
      try { await this.transport.request(this.route('finish'), 'POST', { ...this.identity(), receipt: j.pendingReceipt }); }
      catch (error) {
        // A pre-launch journal proves this process never executed the offer. If the
        // controller never accepted its ack, its unaccepted lease can expire safely.
        if ((error as { status?: number })?.status !== 409 || j.phase !== 'accepted' || j.pendingReceipt.state !== 'cancelled' || !j.pendingReceipt.terminationConfirmed) throw error;
      }
      j.sequence = j.pendingReceipt.sequence; delete j.pendingReceipt; delete j.pendingReceiptHash; j.phase = 'finished'; this.save(); this.current = undefined; this.execution = undefined; this.payload = undefined;
    }
  }
  private async authorizedFailure() {
    this.stopped = true; this.lastError = 'Worker authorization was rejected; pair again after checking the controller.';
    if (!this.current) return;
    let confirmed = false; try { confirmed = (await this.execution?.cancel())?.terminationConfirmed === true; } catch { /* No termination proof. */ }
    this.receipt(confirmed ? 'cancelled' : 'unknown', confirmed ? 'Worker stopped after authorization was revoked.' : 'Worker authorization was revoked; termination is unconfirmed.', '', confirmed);
  }
  async tick() {
    if (this.ticking) return this.ticking;
    const operation = this.iteration(); this.ticking = operation;
    try { await operation; } finally { if (this.ticking === operation) this.ticking = undefined; }
  }
  private async iteration() {
    if (this.stopped) return; this.initialize();
    try {
      await this.flush();
      if (this.now() - this.lastHeartbeat >= (this.options.heartbeatMs ?? 15000)) {
        await this.transport.request('/api/network/worker/heartbeat', 'POST', await this.executor.inventory()); this.lastHeartbeat = this.now();
      }
      if (this.now() - this.lastPoll >= (this.options.pollMs ?? 15000)) {
        const poll = await this.transport.request<RemotePoll>('/api/network/worker/poll?instance=' + encodeURIComponent(this.instanceId)); this.lastPoll = this.now();
        if (poll.job && !this.current) {
          if (!poll.leaseId || !poll.payload) throw new Error('Accepted execution has no local execution handle');
          this.current = { id: poll.job.id, jobId: poll.job.id, job: poll.job, leaseId: poll.leaseId, instanceId: this.instanceId, phase: 'accepted', sequence: 0 };
          this.payload = poll.payload; this.save();
        }
        if (this.current && poll.job && poll.job.id !== this.current.jobId) throw new Error('Controller returned another active execution');
        if (this.execution && poll.cancelRequested) {
          let confirmed = false; try { confirmed = (await this.execution.cancel()).terminationConfirmed === true; } catch { /* Unknown is required. */ }
          this.receipt(confirmed ? 'cancelled' : 'unknown', confirmed ? 'Worker execution stopped.' : 'Worker could not confirm termination.', '', confirmed); await this.flush(); return;
        }
        if (this.execution && this.current) for (const answer of poll.interactionAnswers ?? []) {
          const key = hash(answer);
          if (!this.current.answered?.includes(key)) { await this.execution.answer(answer.questionId, answer.answers); (this.current.answered ??= []).push(key); this.current.answered = this.current.answered.slice(-120); this.save(); }
        }
      }
      if (this.current?.phase === 'accepted' && this.payload) {
        try { await this.transport.request(this.route('ack'), 'POST', this.identity()); }
        catch (error) {
          if ((error as { status?: number })?.status !== 409) throw error;
          // No launch intent or process exists: an expired/cancelled offer can be discarded safely.
          this.current.phase = 'finished'; this.save(); this.current = undefined; this.payload = undefined; return;
        }
        this.current.phase = 'launching'; this.save();
        try {
          this.execution = await this.executor.start(this.payload, 'remote-worker:' + this.current.jobId);
          this.current.executionId = this.execution.id; this.current.phase = 'running'; this.save(); this.payload = undefined;
        } catch { this.receipt('unknown', 'Local launch did not return a reliable execution handle; inspect before retrying.'); await this.flush(); return; }
      }
      if (this.current?.phase === 'running' && this.execution) {
        await this.transport.request(this.route('started'), 'POST', this.identity());
        if (this.now() - this.lastObservation < (this.options.observeMs ?? 1000)) return;
        this.lastObservation = this.now(); const state = await this.execution.snapshot();
        if (state.state !== 'running') {
          const outcome = state.state === 'complete' && state.outcomeComplete !== true ? 'unknown' : state.state;
          this.receipt(outcome, state.summary ?? (outcome === 'unknown' ? 'Local Task outcome requires inspection.' : 'Worker execution ended.'), state.text, state.terminationConfirmed); await this.flush(); return;
        }
        const localOnly = state.question && (state.question.localOnly || JSON.stringify(state.question).length > 10000);
        const question = localOnly ? { id: state.question!.id, revision: state.question!.revision, localOnly: true, title: 'Local action required', description: 'Complete this interaction on the worker computer.', questions: [] } satisfies RemoteQuestion : state.question;
        const event = question ? { type: 'question' as const, question } : state.progress ? { type: 'progress' as const, text: bounded(state.progress, 4000) } : undefined;
        if (event && hash(event) !== this.current.lastObservation) {
          this.current.pendingEvent = { sequence: this.current.sequence + 1, ...event }; this.current.pendingEventHash = hash(this.current.pendingEvent); this.current.lastObservation = hash(event); this.save(); await this.flush();
        }
      }
      this.lastError = undefined;
    } catch (error) {
      if ((error as { status?: number })?.status === 401 || (error as { status?: number })?.status === 403) await this.authorizedFailure();
      else this.lastError = 'Controller or local execution is temporarily unavailable; the job will not be launched again.';
    }
  }
  async stop() { this.stopped = true; if (this.execution && this.current) { let confirmed = false; try { confirmed = (await this.execution.cancel()).terminationConfirmed === true; } catch {} this.receipt(confirmed ? 'cancelled' : 'unknown', 'Worker runtime stopped.', '', confirmed); try { await this.flush(); } catch {} } }
  async run(signal?: AbortSignal) { while (!this.stopped && !signal?.aborted) { await this.tick(); if (!this.stopped && !signal?.aborted) await new Promise(resolve => setTimeout(resolve, 1000)); } if (signal?.aborted) await this.stop(); }
}

interface NativeProvider {
  id: 'openai' | 'claude' | 'cursor' | 'opencode'; accountId?:string; authenticated: boolean; authMode: string; accountLabel?: string; plan?: string; inferenceAvailable?: boolean;
  models: { id: string; name: string; inputModalities?: string[] }[];
  billing: { mode: string; confirmed: boolean; automaticRouting: boolean };
  modelPreferences: { defaultModel: string; allowedModels: string[] | null };
}
interface NativeRecord { id: string; [key: string]: unknown }
interface NativeTask extends NativeRecord { status: string; runId?: string | null; recoveryRequired?: boolean; result?: unknown; outcome?: { state: string; summary?: string } }
interface NativeInteraction { id: string; kind: string; title: string; description: string; details?: string; questions?: { id: string; question: string; options?: string[]; multiple?: boolean }[] }
export interface NativeWorkerApp {
  store: {
    get<T>(kind: string, id: string): T | undefined; list<T>(kind: string): T[];
    put<T extends { id: string }>(kind: string, value: T): T; transaction<T>(fn: () => T): T;
    createAgent(input: { name: string; role?: string; mode?: 'agent'; workspace?: string }): NativeRecord;
    createConversation(agentId: string, title: string): NativeRecord;
  };
  runs: {
    refresh(): Promise<unknown>; providers(): NativeProvider[]; accountProviders?():NativeProvider[];
    attachments: { createDraft(input: { agentId: string; conversationId: string; name: string; mimeType: string; base64: string }): Promise<{ id: string }>; claimDrafts(scope: { agentId: string; conversationId: string }, ids: string[], messageId: string): unknown };
    pendingInteractions(runId: string): NativeInteraction[];
    answerInteraction(runId: string, interactionId: string, value: { decision: 'allow' | 'deny'; answers?: Record<string, string[]> }): unknown;
  };
  tasks: { create(input: { agentId: string; title: string; prompt: string; requiredInputModalities?: string[] }, options: { requestKey: string; withinTransaction: true }): NativeTask; get(id: string): NativeTask | undefined; cancel(id: string): Promise<NativeTask> };
  appControls: { billing(providerId: NativeProvider['id'], body: { mode: 'included'; confirmed: true; automaticRouting: true; allowanceNote: string; expectedAccount: { accountLabel?: string; plan?: string } }): Promise<unknown> };
}
interface NativePayload extends RemoteJobPayload {
  instruction: string; workspaceAlias?: string;
  context?: { markdown?: string; references?: { id: string; role: string; content: string }[] };
  agentProfile?: { id: string; name: string; role?: string; instructions?: string; routeMode?: string; model?: string;accountId?:string };
  attachments?: { name: string; mimeType: string; base64: string; sha256: string }[];
}
function nativeText(value: unknown, max: number, fallback = '') { return typeof value === 'string' ? value.slice(0, max) : fallback; }
function available(p: NativeProvider, model: string) { return p.authenticated && p.billing.confirmed && p.inferenceAvailable !== false && p.models.some(m => m.id === model) && (p.modelPreferences.allowedModels === null || p.modelPreferences.allowedModels.includes(model)); }
export async function createNativeWorkerExecutor(app: NativeWorkerApp, options: { name?: string; subscriptionOnly?: boolean } = {}): Promise<WorkerExecutor> {
  await app.runs.refresh();
  if (options.subscriptionOnly) for (const p of app.runs.providers()) {
    if (['openai', 'claude', 'cursor'].includes(p.id) && p.authenticated && p.authMode === 'subscription' && p.billing.mode === 'included') {
      await app.appControls.billing(p.id, { mode: 'included', confirmed: true, automaticRouting: true, allowanceNote: 'Worker subscription-only use', expectedAccount: { accountLabel: p.accountLabel, plan: p.plan } });
    }
  }
  let defaultAgent = app.store.get<NativeRecord>('worker-config', 'default-agent');
  if (!defaultAgent) { const agent = app.store.createAgent({ name: 'Computer worker', mode: 'agent', workspace: homedir() }); defaultAgent = { id: 'default-agent', agentId: agent.id }; app.store.put('worker-config', defaultAgent); }
  return {
    async inventory() {
      await app.runs.refresh(); const providers = app.runs.providers();
      const all=app.runs.accountProviders?.()??providers;
      const ready = all.some(p => p.billing.automaticRouting && p.models.some(m => available(p, m.id)));
      const first = all.find(p => p.billing.automaticRouting && p.models.some(m => available(p, m.id)));
      return { protocolVersion: 1, name: nativeText(options.name, 80, hostname()), platform: platform(), workspaces: ['home'], providers: providers.map(p=>{const models=new Map<string,{id:string;name:string;available:boolean;automatic?:boolean;modalities:string[]}>();for(const account of all.filter(a=>a.id===p.id))for(const m of account.models){const prior=models.get(m.id);models.set(m.id,{id:m.id,name:m.name,available:!!prior?.available||available(account,m.id),automatic:!!prior?.automatic||account.billing.automaticRouting&&available(account,m.id),modalities:[...new Set([...(prior?.modalities??[]),...(m.inputModalities??['text'])])]});}return {id:p.id,models:[...models.values()]};}), ...(first ? { defaultAgent: { id: String(defaultAgent!.agentId), provider: first.id, model: first.models.find(m => available(first, m.id))!.id, ready } } : {}) } satisfies RemoteInventory;
    },
    async start(raw, requestKey) {
      const payload = raw as NativePayload;
      if (!payload || typeof payload.instruction !== 'string' || !payload.instruction.trim() || payload.instruction.length > 16000 || payload.workspaceAlias && payload.workspaceAlias !== 'home') throw new Error('Invalid worker instruction or workspace alias');
      const profile = payload.agentProfile;
      if (profile && (typeof profile.id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(profile.id))) throw new Error('Invalid worker agent profile');
      await app.runs.refresh();
      if(profile?.accountId&&!profile.accountId.startsWith('default-'))throw new Error('A controller account cannot be used on another computer. Choose Auto or this worker’s approved local accounts.');
      const route = profile?.routeMode ?? 'auto';let model=profile?.model??'';const providers = app.runs.accountProviders?.()??app.runs.providers();
      const needsImage=payload.attachments?.some(a=>a.mimeType.startsWith('image/'))??false;
      const usable=(p:NativeProvider,id:string)=>available(p,id)&&(!needsImage||p.models.find(m=>m.id===id)?.inputModalities?.includes('image')===true);
      const candidates=profile?.accountId?providers.filter(p=>(p.accountId??'default-'+p.id)===profile.accountId):providers;
      let selected:NativeProvider|undefined=profile?.accountId?candidates[0]:undefined;
      if(route!=='auto'){selected=candidates.find(p=>p.id===route&&(model?usable(p,model):p.models.some(m=>usable(p,m.id))));if(!selected)throw new Error('Requested worker model is unavailable or not approved');if(!model)model=selected.models.find(m=>usable(selected!,m.id))!.id;}
      else if (!candidates.some(p => p.billing.automaticRouting && p.models.some(m => usable(p, m.id)))) throw new Error('No worker model is approved for automatic execution');
      const mappingId = profile?.id ?? 'default', mapping = app.store.get<NativeRecord>('worker-agent-map', mappingId);
      let agent = mapping ? app.store.get<NativeRecord>('agent', String(mapping.agentId)) : app.store.get<NativeRecord>('agent', String(defaultAgent!.agentId));
      if (profile && !mapping) agent = app.store.createAgent({ name: nativeText(profile.name, 160, 'Computer worker'), role: nativeText(profile.role, 160), mode: 'agent', workspace: homedir() });
      if (!agent) throw new Error('Worker agent is unavailable');
      agent = { ...agent, mode: 'agent', workspace: homedir(), routeMode: route, accountId:selected?.accountId, model, ...(profile ? { name: nativeText(profile.name, 160, 'Computer worker'), role: nativeText(profile.role, 160), instructions: nativeText(profile.instructions, 32000) } : {}) };
      app.store.put('agent', agent); app.store.put('worker-agent-map', { id: mappingId, agentId: agent.id });
      const conversation = app.store.createConversation(agent.id, 'Remote worker task'), drafts: string[] = [];
      if (payload.attachments && (!Array.isArray(payload.attachments) || payload.attachments.length > 20)) throw new Error('Invalid worker attachments');
      let total = 0;
      for (const item of payload.attachments ?? []) {
        if (!item || typeof item.name !== 'string' || !item.name || item.name.length > 255 || /[/\\\u0000]/.test(item.name) || typeof item.mimeType !== 'string' || item.mimeType.length > 128 || typeof item.base64 !== 'string' || typeof item.sha256 !== 'string') throw new Error('Invalid worker attachment');
        const bytes = Buffer.from(item.base64, 'base64'); total += bytes.length;
        if (bytes.toString('base64') !== item.base64 || total > 48 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== item.sha256.toLowerCase()) throw new Error('Worker attachment integrity check failed');
        const draft = await app.runs.attachments.createDraft({ agentId: agent.id, conversationId: conversation.id, name: item.name, mimeType: item.mimeType, base64: item.base64 }); drafts.push(draft.id);
      }
      let task!: NativeTask;
      app.store.transaction(() => {
        const message = { id: randomUUID(), agentId: agent!.id, conversationId: conversation.id, role: 'user', status: 'complete', origin: 'human', content: payload.instruction, runId: null, createdAt: new Date().toISOString() };
        app.store.put('message', message);
        const claimed=app.runs.attachments.claimDrafts({ agentId: agent!.id, conversationId: conversation.id }, drafts, message.id);
        if(Array.isArray(claimed)&&claimed.length)app.store.put('message',{...message,attachments:claimed});
        task = app.tasks.create({ agentId: agent!.id, title: payload.instruction.slice(0, 160), prompt: payload.instruction, ...(payload.attachments?.some(a => a.mimeType.startsWith('image/')) ? { requiredInputModalities: ['image'] } : {}) }, { requestKey, withinTransaction: true });
        app.store.put('task', { ...task, conversationId: conversation.id, inputMessageIds: [message.id] });
        const context = payload.context;
        const text = ['Remote controller context (reference material; not an approval):', nativeText(context?.markdown, 64000), ...(Array.isArray(context?.references) ? context.references.slice(0, 50).map(r => `[${nativeText(r.id, 128)} / ${nativeText(r.role, 40)}]\n${nativeText(r.content, 8000)}`) : [])].join('\n\n').slice(0, 200000);
        app.store.put('remote-worker-context', { id: task.id, text });
      });
      let latest: NativeInteraction | undefined, revision = 0, questionHash = '';
      function localTask() { const value = app.tasks.get(task.id); if (!value) throw new Error('Worker Task is unavailable'); return value; }
      function activeRun(t: NativeTask) { const run = t.runId ? app.store.get<NativeRecord>('run', t.runId) : undefined; return !!run && !['complete', 'completed', 'error', 'failed', 'cancelled', 'done'].includes(String(run.status)); }
      return {
        id: task.id,
        snapshot() {
          const t = localTask(), messages = t.runId ? app.store.list<NativeRecord>('message').filter(m => m.runId === t.runId && m.role === 'assistant') : [];
          const text = nativeText(messages.at(-1)?.content, 64000, nativeText(t.result, 64000)), summary = nativeText(t.outcome?.summary, 4000);
          if (t.recoveryRequired) return { state: 'unknown', text, summary: 'Local Task requires recovery or inspection.' };
          if (t.status === 'done') return { state: t.outcome?.state === 'complete' ? 'complete' : 'failed', outcomeComplete: t.outcome?.state === 'complete', text, summary };
          if (['failed', 'error'].includes(t.status)) return { state: 'failed', text, summary };
          if (t.status === 'cancelled') return { state: 'cancelled', text, summary, terminationConfirmed: !activeRun(t) };
          latest = t.runId ? app.runs.pendingInteractions(t.runId)[0] : undefined;
          let question: RemoteQuestion | undefined;
          if (latest) {
            const fingerprint = hash(latest); if (fingerprint !== questionHash) { revision++; questionHash = fingerprint; }
            const localOnly = (latest.questions?.length ?? 0) > 10 || (latest.questions?.some(q => q.id.startsWith(TYPESAFE_CREDENTIAL_PREFIX) || q.id.startsWith(INTEGRATION_CREDENTIAL_PREFIX)) ?? false);
            question = localOnly ? { id: latest.id, revision, localOnly: true, title: 'Local action required', description: 'Complete this interaction in the worker setup window.', questions: [] } : { id: latest.id, revision, title: nativeText(latest.title, 160, 'Worker question'), description: [nativeText(latest.description, 2000), nativeText(latest.details, 2000)].filter(Boolean).join('\n\n').slice(0, 2000), questions: latest.kind === 'approval' ? [{ id: 'decision', question: 'Allow the requested action?', options: [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Deny' }] }] : (latest.questions ?? []).slice(0, 10).map(q => ({ id: q.id, question: nativeText(q.question, 1000), ...(q.options ? { options: q.options.slice(0, 20).map((label, index) => ({ id: 'option-' + index, label: nativeText(label, 160) })) } : {}) })) };
          }
          return { state: 'running', text, summary, progress: 'Local Task: ' + t.status, ...(question ? { question } : {}) };
        },
        answer(questionId, answers) {
          const t = localTask(), interaction = t.runId ? app.runs.pendingInteractions(t.runId).find(q => q.id === questionId) : undefined;
          if (!interaction || interaction.questions?.some(q => q.id.startsWith(TYPESAFE_CREDENTIAL_PREFIX) || q.id.startsWith(INTEGRATION_CREDENTIAL_PREFIX))) throw new Error('Interaction must be completed locally');
          if (interaction.kind === 'approval') { if (!['allow', 'deny'].includes(answers.decision)) throw new Error('Invalid approval decision'); app.runs.answerInteraction(t.runId!, questionId, { decision: answers.decision as 'allow' | 'deny' }); }
          else {
            const result: Record<string, string[]> = {};
            for (const q of interaction.questions ?? []) { let value = answers[q.id]; if (typeof value !== 'string') throw new Error('Missing question answer'); if (q.options) { const index = /^option-(\d+)$/.exec(value); if (!index || !q.options[Number(index[1])]) throw new Error('Invalid question option'); value = q.options[Number(index[1])]; } result[q.id] = [value]; }
            app.runs.answerInteraction(t.runId!, questionId, { decision: 'allow', answers: result });
          }
        },
        async cancel() { const stopped = await app.tasks.cancel(task.id); return { terminationConfirmed: !stopped.recoveryRequired && ['done', 'failed', 'error', 'cancelled'].includes(stopped.status) && !activeRun(stopped) }; },
      } satisfies WorkerExecution;
    },
  };
}
