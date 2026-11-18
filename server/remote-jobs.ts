import { createHash, randomUUID } from 'node:crypto';
import type { RemoteFinish, RemoteInventory, RemoteJob, RemoteJobEvent, RemoteJobPayload, RemotePoll, RemoteQuestion } from '../shared/remote-jobs.js';

export interface RemoteJobStore {
  get<T>(kind: string, id: string): T | undefined;
  list<T>(kind: string): T[];
  put<T extends { id: string }>(kind: string, record: T): T;
  remove(kind: string, id: string): void;
  transaction<T>(fn: () => T): T;
}
export interface RemoteJobHooks {
  authorizeWorker(id: string): boolean;
  assertWritable(): void;
  payload(job: RemoteJob): Promise<RemoteJobPayload>;
  reportOutcome(taskId: string, runId: string, report: { state: 'complete'; summary: string; remaining: string[]; evidence: never[] }): Promise<void>;
  clock?: () => number;
  cancelTimeoutMs?: number;
}
interface Computer { id: string; inventory: RemoteInventory; lastSeenAt: number; revoked?: boolean }
const JOBS = 'remote-jobs', COMPUTERS = 'remote-computers', RUNS = 'remote-run-index', RECEIPTS = 'remote-event-receipts';
const providers = new Set(['openai', 'claude', 'cursor', 'opencode']);
const terminal = new Set(['complete', 'failed', 'cancelled', 'unknown', 'blocked']);
const active = new Set(['offered', 'accepted', 'running']);
export class RemoteJobError extends Error { constructor(message: string, public status = 409) { super(message); } }
function fail(message: string, status = 409): never { throw new RemoteJobError(message, status); }
function str(value: unknown, limit: number, empty = false): string {
  if (typeof value !== 'string' || value.length > limit || (!empty && !value.trim()) || /\u0000/.test(value)) fail('Invalid bounded string', 400);
  return value;
}
function num(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 0) fail('Invalid sequence or revision', 400); return Number(value); }
function identifier(value: unknown): string { const s = str(value, 128); if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(s)) fail('Invalid identifier', 400); return s; }
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
}
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function cleanInventory(input: RemoteInventory): RemoteInventory {
  if (!input || input.protocolVersion !== 1 || !Array.isArray(input.providers) || input.providers.length > 4 || !Array.isArray(input.workspaces) || input.workspaces.length > 20) fail('Invalid inventory', 400);
  let total = 0; const seen = new Set<string>();
  const result: RemoteInventory = { protocolVersion: 1, name: str(input.name, 80), platform: str(input.platform, 40), providers: [], workspaces: [] };
  result.providers = input.providers.map(p => {
    if (!providers.has(p.id) || seen.has(p.id) || !Array.isArray(p.models) || (total += p.models.length) > 20000) fail('Invalid provider catalog', 400);
    seen.add(p.id);
    return { id: p.id, models: p.models.map(m => {
      if (typeof m.available !== 'boolean' || (m.automatic!==undefined&&typeof m.automatic!=='boolean') || !Array.isArray(m.modalities) || m.modalities.length > 8) fail('Invalid model', 400);
      return { id: str(m.id, 160), name: str(m.name, 160), available: m.available,...(m.automatic===undefined?{}:{automatic:m.automatic}), modalities: m.modalities.map(x => str(x, 32)) };
    }) };
  });
  result.workspaces = input.workspaces.map(x => { const alias = str(x, 64); if (!/^[a-zA-Z0-9][a-zA-Z0-9_. -]*$/.test(alias) || alias === '..') fail('Workspace must be an alias', 400); return alias; });
  if (input.defaultAgent) {
    const a = input.defaultAgent;
    if (!providers.has(a.provider) || typeof a.ready !== 'boolean') fail('Invalid default agent', 400);
    result.defaultAgent = { id: identifier(a.id), provider: a.provider, model: str(a.model, 160), ready: a.ready, ...(a.reason === undefined ? {} : { reason: str(a.reason, 240, true) }) };
  }
  return result; // Deliberately whitelist; never persist host paths, credentials, or extra fields.
}
function cleanQuestion(q: RemoteQuestion): RemoteQuestion {
  if (!q || !Array.isArray(q.questions) || q.questions.length > 10) fail('Invalid question', 400);
  if (q.localOnly !== undefined && typeof q.localOnly !== 'boolean') fail('Invalid local interaction flag', 400);
  const base = { id: identifier(q.id), revision: num(q.revision) };
  str(q.title, 160); str(q.description, 2000, true);
  if (q.localOnly) return { ...base, localOnly: true, title: 'Local action required', description: 'Complete this interaction on the worker computer.', questions: [] };
  const seen = new Set<string>();
  return { ...base, title: str(q.title, 160), description: str(q.description, 2000, true), questions: q.questions.map(x => {
    const id = identifier(x.id); if (seen.has(id)) fail('Duplicate question ID', 400); seen.add(id);
    if (x.options && (!Array.isArray(x.options) || x.options.length > 20)) fail('Invalid options', 400);
    return { id, question: str(x.question, 1000), ...(x.options ? { options: x.options.map(o => ({ id: identifier(o.id), label: str(o.label, 160), ...(o.description === undefined ? {} : { description: str(o.description, 400, true) }) })) } : {}) };
  }) };
}

export class RemoteJobs {
  private finishing = new Map<string, Promise<unknown>>();
  private finalizing = new Set<string>();
  constructor(private store: RemoteJobStore, private hooks: RemoteJobHooks) {}
  private now() { return this.hooks.clock?.() ?? Date.now(); }
  private write() { this.hooks.assertWritable(); }
  private worker(id: string) {
    identifier(id);
    if (!this.hooks.authorizeWorker(id) || this.store.get<Computer>(COMPUTERS, id)?.revoked) fail('Worker is not authorized', 403);
  }
  private save(job: RemoteJob) { job.updatedAt = this.now(); this.store.put(JOBS, job); }
  private all() { return this.store.list<RemoteJob>(JOBS); }
  private owned(workerId: string, jobId: string, leaseId: string, instance: string) {
    this.worker(workerId); const j = this.get(jobId);
    if (!j || j.computerId !== workerId || j.leaseId !== leaseId || j.workerInstanceId !== instance) fail('Wrong worker, instance, or lease');
    return j;
  }
  private uncertain(j: RemoteJob, reason: string) { j.state = 'unknown'; j.error = reason; j.endedAt = this.now(); this.save(j); }
  heartbeat(workerId: string, inventory: RemoteInventory) {
    this.write(); this.worker(workerId);
    const cleaned = cleanInventory(inventory);
    this.store.put<Computer>(COMPUTERS, { id: workerId, inventory: cleaned, lastSeenAt: this.now() });
  }
  computers() {
    return this.store.list<Computer>(COMPUTERS).filter(c => !c.revoked && this.hooks.authorizeWorker(c.id)).map(c => ({ id: c.id, ...c.inventory, online: this.now() - c.lastSeenAt < 45000 }));
  }
  enqueue(input: { taskId: string; attempt: number; agentId: string; computerId: string; prompt: string; capsuleId: string; profile?: string }) {
    this.write(); this.worker(input.computerId);
    if (!this.store.get<Computer>(COMPUTERS, input.computerId)) fail('Unknown target computer', 400);
    const job: RemoteJob = { id: randomUUID(), runId: 'remote-' + randomUUID(), taskId: identifier(input.taskId), attempt: num(input.attempt), agentId: identifier(input.agentId), computerId: input.computerId, prompt: str(input.prompt, 64000), capsuleId: identifier(input.capsuleId), ...(input.profile === undefined ? {} : { profile: str(input.profile, 128) }), state: 'queued', createdAt: this.now(), updatedAt: this.now(), sequence: 0, events: [], interactionAnswers: [] };
    this.store.transaction(() => { this.store.put(JOBS, job); this.store.put(RUNS, { id: job.runId, jobId: job.id }); });
    return { runId: job.runId, conversationId: '' };
  }
  async poll(workerId: string, workerInstanceId: string): Promise<RemotePoll> {
    this.write(); this.worker(workerId); identifier(workerInstanceId);
    const c = this.store.get<Computer>(COMPUTERS, workerId);
    if (!c) fail('Worker inventory required', 400);
    c.lastSeenAt = this.now(); this.store.put(COMPUTERS, c);
    let job: RemoteJob | undefined;
    this.store.transaction(() => {
      const candidates = this.all().filter(j => j.computerId === workerId).sort((a, b) => a.createdAt - b.createdAt);
      for (const j of candidates) {
        if (j.state === 'offered' && j.leaseExpiresAt! <= this.now()) { j.state = 'queued'; delete j.leaseId; delete j.workerInstanceId; this.save(j); }
        else if ((j.state === 'accepted' || j.state === 'running') && j.workerInstanceId !== workerInstanceId) this.uncertain(j, 'Worker restarted; inspect the previous execution before retrying.');
      }
      // An uncertain execution fences this computer until explicit inspection/reconciliation.
      if (candidates.some(j => j.state === 'unknown' && j.inspectedAt === undefined)) return;
      job = candidates.find(j => active.has(j.state));
      if (job && job.workerInstanceId !== workerInstanceId) { job = undefined; return; }
      if (!job) {
        job = candidates.find(j => j.state === 'queued');
        if (job) { job.state = 'offered'; job.leaseId = randomUUID(); job.leaseExpiresAt = this.now() + 30000; job.workerInstanceId = workerInstanceId; this.save(job); }
      }
    });
    if (!job) return {};
    const selected = job as RemoteJob;
    const payload = selected.state === 'offered' ? await this.hooks.payload(structuredClone(selected)) : undefined;
    this.worker(workerId); // Authorization may have changed while attachments were resolved.
    const current = this.get(selected.id);
    if (!current || current.leaseId !== selected.leaseId || current.workerInstanceId !== workerInstanceId || !active.has(current.state)) return {};
    return { job: { id: current.id, runId: current.runId, taskId: current.taskId, attempt: current.attempt, agentId: current.agentId, computerId: current.computerId }, leaseId: current.leaseId, ...(payload === undefined ? {} : { payload }), cancelRequested: !!current.cancelRequested, interactionAnswers: current.interactionAnswers };
  }
  ack(workerId: string, jobId: string, leaseId: string, instance: string) {
    this.write(); const j = this.owned(workerId, jobId, leaseId, instance);
    if (j.state === 'accepted' || j.state === 'running') return;
    if (j.state !== 'offered' || j.leaseExpiresAt! <= this.now()) fail('Offer expired or is no longer launchable');
    j.state = 'accepted'; this.save(j);
  }
  started(workerId: string, jobId: string, leaseId: string, instance: string) {
    this.write(); const j = this.owned(workerId, jobId, leaseId, instance);
    if (j.state === 'running') return;
    if (j.state !== 'accepted') fail('Job must be accepted before launch');
    j.state = 'running'; this.save(j);
  }
  event(workerId: string, jobId: string, leaseId: string, instance: string, input: RemoteJobEvent) {
    this.write(); const j = this.owned(workerId, jobId, leaseId, instance);
    if (!input || !['status', 'tool', 'progress', 'delta', 'question'].includes(input.type)) fail('Invalid event', 400);
    const e: RemoteJobEvent = { sequence: num(input.sequence), type: input.type, ...(input.text === undefined ? {} : { text: str(input.text, 4000, true) }), ...(input.question === undefined ? {} : { question: cleanQuestion(input.question) }) };
    if (e.question?.localOnly) delete e.text;
    if ((e.type === 'question') !== !!e.question || canonical(input).length > 12000) fail('Invalid event body', 400);
    const key = j.id + ':' + e.sequence, hash = digest(input), old = this.store.get<{ id: string; digest: string }>(RECEIPTS, key);
    if (old) { if (old.digest !== hash) fail('Changed duplicate event'); return; }
    if (!['accepted', 'running'].includes(j.state) || this.finalizing.has(j.id) || e.sequence !== j.sequence + 1) fail('Event gap or inactive execution');
    if (e.question && j.pendingInteraction && e.question.id === j.pendingInteraction.id && e.question.revision <= j.pendingInteraction.revision) fail('Question revision must increase');
    this.store.transaction(() => {
      j.sequence = e.sequence; j.events.push(e);
      while (j.events.length > 120 || canonical(j.events).length > 24000) j.events.shift();
      if (e.question) { j.pendingInteraction = e.question; j.interactionAnswers = []; }
      this.store.put(RECEIPTS, { id: key, digest: hash }); this.save(j);
    });
  }
  answer(jobId: string, questionId: string, revision: number, answers: Record<string, string>) {
    this.write(); const j = this.get(jobId), q = j?.pendingInteraction;
    if (!j || !q || !['accepted', 'running'].includes(j.state) || q.id !== questionId || q.revision !== revision || q.localOnly) fail('No matching remote question');
    if (!answers || typeof answers !== 'object' || Array.isArray(answers) || Object.keys(answers).length !== q.questions.length) fail('Invalid answers', 400);
    const clean: Record<string, string> = {};
    for (const part of q.questions) { const value = str(answers[part.id], 2000, true); if (part.options?.length && !part.options.some(o => o.id === value)) fail('Answer is outside requested options', 400); clean[part.id] = value; }
    const next = { questionId, revision, answers: clean }, old = j.interactionAnswers.find(a => a.questionId === questionId && a.revision === revision);
    if (old && digest(old) !== digest(next)) fail('Question already answered');
    if (!old) { j.interactionAnswers.push(next); this.save(j); }
  }
  async finish(workerId: string, jobId: string, leaseId: string, instance: string, input: RemoteFinish) {
    const previous = this.finishing.get(jobId) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      this.write(); const j = this.owned(workerId, jobId, leaseId, instance);
      if (!input || !['complete', 'failed', 'cancelled', 'unknown'].includes(input.state)) fail('Invalid receipt', 400);
      if (input.terminationConfirmed !== undefined && typeof input.terminationConfirmed !== 'boolean') fail('Invalid termination proof', 400);
      const receipt: RemoteFinish = { sequence: num(input.sequence), state: input.state, text: str(input.text, 64000, true), summary: str(input.summary, 4000, true), ...(input.terminationConfirmed === undefined ? {} : { terminationConfirmed: input.terminationConfirmed }) };
      const hash = digest(input);
      if (j.receiptDigest) { if (j.receiptDigest !== hash) fail('Changed duplicate receipt'); return j.state; }
      if (!['accepted', 'running', 'unknown'].includes(j.state) || receipt.sequence !== j.sequence + 1) fail('Receipt gap or inactive execution');
      this.finalizing.add(j.id);
      try {
        if (receipt.state === 'complete') await this.hooks.reportOutcome(j.taskId, j.runId, { state: 'complete', summary: '[Worker report; host unverified] ' + receipt.summary, remaining: [], evidence: [] });
        // Re-read after await so cancellation or revocation is not overwritten by a stale object.
        const current = this.get(j.id)!;
        this.worker(workerId);
        current.state = receipt.state === 'cancelled' && !receipt.terminationConfirmed ? 'unknown' : receipt.state;
        current.sequence = receipt.sequence; current.text = receipt.text; current.summary = receipt.summary;
        current.error = current.state === 'unknown' ? 'Execution outcome is uncertain; inspect before retrying.' : current.state === 'failed' ? 'Remote execution failed.' : undefined;
        current.endedAt = this.now(); current.receiptDigest = hash; delete current.pendingInteraction; current.interactionAnswers = []; this.save(current);
        return current.state;
      } finally { this.finalizing.delete(j.id); }
    });
    this.finishing.set(jobId, operation);
    try { return await operation; } finally { if (this.finishing.get(jobId) === operation) this.finishing.delete(jobId); }
  }
  async cancel(runId: string) {
    this.write(); const j = this.byRun(runId); if (!j) fail('Unknown remote run', 404);
    if (j.state === 'unknown') fail('Inspect uncertain execution before retrying cancellation');
    if (terminal.has(j.state)) return;
    j.cancelRequested = true;
    if (j.state === 'queued' || j.state === 'offered') { j.state = 'cancelled'; j.endedAt = this.now(); this.save(j); return; }
    this.save(j);
    const deadline = Date.now() + Math.max(1, Math.min(this.hooks.cancelTimeoutMs ?? 10000, 10000));
    while (Date.now() < deadline) {
      const current = this.get(j.id)!;
      if (current.state === 'cancelled' || current.state === 'complete' || current.state === 'failed') return;
      if (current.state === 'unknown') fail('Termination is unconfirmed; inspect the worker');
      await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
    }
    const current = this.get(j.id)!;
    if (!terminal.has(current.state)) this.uncertain(current, 'Cancellation could not confirm termination; inspect the worker.');
    fail('Termination is unconfirmed; inspect the worker');
  }
  revokeWorker(workerId: string) {
    this.write(); identifier(workerId);
    this.store.transaction(() => {
      const c = this.store.get<Computer>(COMPUTERS, workerId); if (c) { c.revoked = true; this.store.put(COMPUTERS, c); }
      for (const j of this.all().filter(j => j.computerId === workerId)) {
        if (j.state === 'accepted' || j.state === 'running') this.uncertain(j, 'Worker was revoked; inspect execution before retrying.');
        else if (j.state === 'queued' || j.state === 'offered') { j.state = 'blocked'; j.error = 'Target worker was revoked.'; j.endedAt = this.now(); this.save(j); }
      }
    });
  }
  acknowledgeInspection(jobId: string, note: string) {
    this.write(); const j = this.get(jobId);
    if (!j || j.state !== 'unknown') fail('Only an uncertain execution can be inspected');
    j.inspectionNote = str(note, 2000); j.inspectedAt = this.now(); this.save(j);
  }
  get(id: string) { const j = this.store.get<RemoteJob>(JOBS, id); return j ? structuredClone(j) : undefined; }
  forTask(taskId: string) { return this.all().filter(j => j.taskId === taskId).map(j => structuredClone(j)); }
  events(id: string) { return this.get(id)?.events ?? []; }
  detail(id: string) { return this.get(id); }
  private byRun(runId: string) { const index = this.store.get<{ id: string; jobId: string }>(RUNS, runId); return index ? this.get(index.jobId) : undefined; }
  ownsRun(runId: string) { return !!this.byRun(runId); }
  count() { return this.all().length; }
  snapshot(runId: string) {
    const j = this.byRun(runId); if (!j) return undefined;
    const status = j.state === 'complete' ? 'complete' : j.state === 'cancelled' ? 'cancelled' : ['unknown', 'failed', 'blocked'].includes(j.state) ? 'error' : ['queued', 'offered'].includes(j.state) ? 'routing' : 'running';
    return { status, text: j.text ?? j.events.map(e => e.text ?? '').filter(Boolean).join('\n'), pendingInteractions: j.pendingInteraction ? [j.pendingInteraction] : [], error: j.error, endedAt: j.endedAt } as { status: 'routing' | 'running' | 'complete' | 'error' | 'cancelled'; text: string; pendingInteractions: RemoteQuestion[]; error?: string; endedAt?: number };
  }
  restoreKeepsWaiting(task: { id: string; runId?: string; activeRunId?: string; attempt?: number }) {
    const runId = task.runId ?? task.activeRunId; if (!runId) return false;
    const j = this.byRun(runId);
    return !!j && j.taskId === task.id && (task.attempt === undefined || task.attempt === j.attempt) && ['queued', 'offered', 'accepted', 'running'].includes(j.state);
  }
}
