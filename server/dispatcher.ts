import { createHash } from 'node:crypto';
import type { DispatcherInput, DispatcherLookup, DispatcherReceipt, DispatcherSubmitResult } from '../shared/dispatcher.js';
import { CAPABILITY_IDS, type CapabilityId, type CapabilityRequirementFields } from '../shared/capabilities.js';
import type { MessageAttachment } from '../shared/attachments.js';
import type { TypeSafeDecisionRequest, TypeSafeDecisionResult } from '../shared/typesafe.js';
import type { Task } from '../shared/tasks.js';
import type { Conversation, Message, Run } from '../shared/types.js';
import { id, now, type Store } from './store.js';
import { attachmentReader } from './attachments.js';
import type { Tasks, TaskCancelScope } from './tasks.js';
import { HttpError, only, redactSecrets, stringValue } from './security.js';

export interface DispatcherCandidate {
  agentId: string; name: string; role: string;
  /** Host identity/policy fingerprint. Never sent to the selector or client. */
  revision: string; capabilities: CapabilityId[];
}
export interface DispatcherHooks {
  candidates(prompt: string, signal: AbortSignal, requirements?: CapabilityRequirementFields): Promise<DispatcherCandidate[]>;
  /** Synchronous final check, in the task/submission acceptance transaction. */
  revalidate(candidate: DispatcherCandidate, prompt: string, requirements?: CapabilityRequirementFields): boolean;
  /** Host checks actual per-model image support, both before and during acceptance. */
  admitAttachments?(candidate: DispatcherCandidate, prompt: string, requirements: CapabilityRequirementFields): void;
  enabled(): boolean;
  selectorModel?(): string;
  decide?(scope: { signal: AbortSignal; isActive(): boolean }, value: TypeSafeDecisionRequest): Promise<TypeSafeDecisionResult>;
  redact?(text: string): string;
  assertAvailable?(): void;
}
interface Submission {
  id: string; hash: string; state: 'pending' | 'unconfirmed' | 'accepted';
  taskId?: string; agentId?: string; selectionSource?: DispatcherReceipt['selectionSource'];
}
interface SelectionObservation {
  id: string; submissionId: string; source: 'jev'; configuredModel: string | null;
  inputCharacters: number; inputBytes: number;
  state: 'pending' | 'returned' | 'failed' | 'cancelled';
  reportedUsage: { inputTokens: number; outputTokens: number } | null;
}
type Input = DispatcherInput;
const KIND = 'dispatcher-submission';
// TypeSafeIntegration's state array limit is stricter than Choice's 255 options.
const MAX_SELECTOR_CANDIDATES = 100;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function dispatcherId(value: unknown): string {
  const result = stringValue(value, 'Submission ID', 100, 1);
  if (!/^[a-zA-Z0-9_-]+$/.test(result)) throw new HttpError(400, 'Submission ID must be opaque letters, digits, hyphens or underscores');
  return result;
}
const probability = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

/** A host router, not an executor or a second conversation. Only opaque metadata survives. */
export class Dispatcher {
  private inflight = new Map<string, { hash: string; controller: AbortController; promise: Promise<DispatcherSubmitResult> }>();
  private cancellations = new Map<string, Promise<DispatcherReceipt>>();
  private closed = false;
  constructor(private store: Store, private tasks: Tasks, private hooks: DispatcherHooks) {}
  private active(signal: AbortSignal) {
    if (this.closed || signal.aborted) throw new HttpError(409, 'Submission stopped before acceptance; inspect its submission status');
    this.hooks.assertAvailable?.();
  }
  private input(value: Input): Input {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Submission must be an object');
    only(value as unknown as Record<string, unknown>, ['submissionId', 'prompt', 'agentId', 'draftId', 'attachmentIds']);
    const submissionId = dispatcherId(value.submissionId), prompt = stringValue(value.prompt, 'Request', 16000);
    const draftId = value.draftId === undefined ? undefined : dispatcherId(value.draftId);
    const attachmentIds = value.attachmentIds ?? [];
    if (!Array.isArray(attachmentIds) || attachmentIds.length > 8 || new Set(attachmentIds).size !== attachmentIds.length || attachmentIds.some(key => typeof key !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(key))) throw new HttpError(400, 'Use up to eight distinct attachment IDs');
    if (attachmentIds.length && !draftId) throw new HttpError(400, 'Attachment draft ID is required');
    if (!prompt.trim() && !attachmentIds.length) throw new HttpError(400, 'Request or attachment is required');
    const agentId = value.agentId === undefined ? undefined : stringValue(value.agentId, 'Bot ID', 100, 1);
    return { submissionId, prompt, ...(agentId === undefined ? {} : { agentId }), ...(draftId === undefined ? {} : { draftId }), attachmentIds: [...attachmentIds] };
  }
  private redact(text: string) { return this.hooks.redact?.(redactSecrets(text)) ?? redactSecrets(text); }
  submit(value: Input, signal: AbortSignal): Promise<DispatcherSubmitResult> {
    try {
      const input = this.input(value), identity = { prompt: input.prompt, agentId: input.agentId ?? null };
      // Existing text-only receipts predate attachment staging. Preserve their exact canonical schema.
      const hash = digest(input.draftId === undefined && !input.attachmentIds?.length ? identity : { ...identity, draftId: input.draftId ?? null, attachmentIds: input.attachmentIds });
      const prior = this.store.get<Submission>(KIND, input.submissionId);
      if (prior) {
        if (prior.hash !== hash) throw new HttpError(409, 'Submission ID already used with different input');
        if (prior.state === 'accepted') return Promise.resolve({ state: 'accepted', receipt: this.receipt(prior) });
        const active = this.inflight.get(input.submissionId);
        if (active) return active.promise;
        throw new HttpError(409, 'Submission outcome is unconfirmed; inspect status and send a new request explicitly');
      }
      this.active(signal);
      this.store.put<Submission>(KIND, { id: input.submissionId, hash, state: 'pending' });
      const controller = new AbortController(), abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) controller.abort();
      // Install serialization before invoking any asynchronous host hook.
      const canonicalInput = { ...input, prompt: this.redact(input.prompt) };
      const promise = Promise.resolve().then(() => this.route(canonicalInput, hash, controller.signal)).catch(() => {
        // Upstream exceptions may contain private state. Never return or persist them.
        throw new HttpError(controller.signal.aborted || this.closed ? 409 : 503, 'Submission could not be confirmed; inspect submission status before sending a new request');
      }).finally(() => {
        signal.removeEventListener('abort', abort); this.inflight.delete(input.submissionId);
        if (!this.closed) {
          const latest = this.store.get<Submission>(KIND, input.submissionId);
          if (latest?.state === 'pending') this.store.put<Submission>(KIND, { id: input.submissionId, hash, state: 'unconfirmed' });
        }
      });
      this.inflight.set(input.submissionId, { hash, controller, promise });
      return promise;
    } catch (error) { return Promise.reject(error); }
  }
  private safeRoster(candidates: DispatcherCandidate[]): DispatcherCandidate[] {
    const ids = new Set<string>();
    return candidates.map(candidate => {
      const agentId = stringValue(candidate.agentId, 'Bot ID', 100, 1);
      if (ids.has(agentId)) throw new HttpError(503, 'Duplicate host candidate'); ids.add(agentId);
      return { agentId, name: this.redact(stringValue(candidate.name, 'Bot name', 200, 1)), role: this.redact(stringValue(candidate.role, 'Bot role', 1000)), revision: candidate.revision,
        capabilities: CAPABILITY_IDS.filter(capability => candidate.capabilities.includes(capability)) };
    });
  }
  private async route(input: Input, hash: string, signal: AbortSignal): Promise<DispatcherSubmitResult> {
    this.active(signal);
    const files = attachmentReader(this.store);
    const manifests = input.attachmentIds?.length ? files.validateDrafts({ surface: 'dispatcher', draftId: input.draftId! }, input.attachmentIds) : [];
    const requirements: CapabilityRequirementFields = manifests.some(item => item.kind === 'image') ? { requiredInputModalities: ['image'] } : {};
    const candidates = this.safeRoster(await this.hooks.candidates(input.prompt, signal, requirements)); this.active(signal);
    const needs = (reason: string): DispatcherSubmitResult => ({ state: 'needs-recipient', reason, candidates: candidates.map(({ agentId, name, role }) => ({ agentId, name, role })) });
    let candidate: DispatcherCandidate | undefined, selectionSource: DispatcherReceipt['selectionSource'];
    if (input.agentId !== undefined) {
      candidate = candidates.find(candidate => candidate.agentId === input.agentId); selectionSource = 'explicit';
      if (!candidate) return needs('The selected bot is unavailable. Choose an eligible recipient.');
    } else if (!candidates.length) return needs('No eligible bot is available.');
    else if (candidates.length > MAX_SELECTOR_CANDIDATES) return needs('The roster exceeds the selector state limit. Choose a recipient explicitly.');
    else if (!this.hooks.enabled()) {
      if (candidates.length !== 1) return needs('Local routing cannot establish a unique recipient. Choose a bot explicitly.');
      candidate = candidates[0]; selectionSource = 'local';
    } else {
      if (!this.hooks.decide) throw new HttpError(503, 'Selector is unavailable');
      const labels = new Map<string, DispatcherCandidate>();
      for (const item of candidates) {
        const base = item.name.slice(0, 80); let label = base, suffix = 1;
        while (labels.has(label)) label = base + '_' + suffix++;
        labels.set(label, item);
      }
      const questions: TypeSafeDecisionRequest['questions'] = {
        fit: { type: 'noul', instructions: 'Does the request fit the declared role and approved capabilities of any candidate?', criteria: { true: 'A candidate has a declared role and approved capabilities suitable for the request.', false: 'The request is unrelated to the available roles or requires capabilities no candidate has.' } },
        ...(candidates.length > 1 ? { recipient: { type: 'choice' as const, instructions: 'Which candidate declared role best matches the request?', criteria: Object.fromEntries([...labels].map(([label, item]) => [label, JSON.stringify({ role: item.role, capabilities: item.capabilities })])) } } : {}),
      };
      // Selection gets only bounded modality/size facts; file contents and names are untrusted worker context.
      const request = { state: { request: input.prompt, candidates: [...labels].map(([name, item]) => ({ name, role: item.role, capabilities: item.capabilities })), ...(manifests.length ? { attachments: { count: manifests.length, items: manifests.map(({ kind, mimeType, size }) => ({ kind, mimeType, size })) } } : {}) }, questions };
      const serialized = JSON.stringify(request), inputBytes = Buffer.byteLength(serialized);
      if (inputBytes > 65536) return needs('The complete roster exceeds the selector input limit. Choose a recipient explicitly.');
      const model = this.hooks.selectorModel?.();
      const observation: SelectionObservation = { id: input.submissionId, submissionId: input.submissionId, source: 'jev', configuredModel: model === undefined ? null : this.redact(stringValue(model, 'Selector model', 512, 1)), inputCharacters: serialized.length, inputBytes, state: 'pending', reportedUsage: null };
      this.store.put('dispatcher-selection', observation);
      let result: TypeSafeDecisionResult;
      try {
        result = await this.hooks.decide({ signal, isActive: () => !this.closed && !signal.aborted }, request);
        const usage = result.usage, validUsage = usage && [usage.inputTokens, usage.outputTokens].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 1000000000);
        if (!this.closed) this.store.put<SelectionObservation>('dispatcher-selection', { ...observation, state: 'returned', reportedUsage: validUsage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : null });
      } catch (error) {
        if (!this.closed) this.store.put<SelectionObservation>('dispatcher-selection', { ...observation, state: signal.aborted ? 'cancelled' : 'failed' });
        throw error;
      }
      this.active(signal);
      if (!this.hooks.enabled()) throw new HttpError(409, 'Selector configuration changed');
      const fit = result.answers.fit;
      if (!fit || fit.type !== 'noul' || !probability(fit.noul)) throw new HttpError(503, 'Invalid selector fit');
      if (fit.noul < .7) return needs('The selector could not establish a suitable recipient. Choose a bot explicitly.');
      if (candidates.length === 1) candidate = candidates[0];
      else {
        const choice = result.answers.recipient;
        if (!choice || choice.type !== 'choice' || !probability(choice.confidence) || !labels.has(choice.choice) || Object.keys(choice.probabilities).length !== labels.size || [...labels.keys()].some(key => !probability(choice.probabilities[key])) || Math.abs(Object.values(choice.probabilities).reduce((sum, value) => sum + value, 0) - 1) > .001) throw new HttpError(503, 'Invalid selector choice');
        candidate = labels.get(choice.choice);
      }
      selectionSource = 'jev';
    }
    if (!candidate) throw new HttpError(503, 'Recipient unavailable');
    this.active(signal);
    if (!this.hooks.revalidate(candidate, input.prompt, requirements)) return needs('The selected bot or policy changed. Choose a recipient again.');
    const admitAttachments = () => {
      if (!requirements.requiredInputModalities?.includes('image')) return;
      if (!this.hooks.admitAttachments) throw new HttpError(409, 'The selected bot has no verified image admission');
      this.hooks.admitAttachments(candidate!, input.prompt, requirements);
    };
    admitAttachments();
    const accepted = this.store.transaction(() => {
      this.active(signal);
      if (!this.hooks.revalidate(candidate!, input.prompt, requirements)) throw new HttpError(409, 'Recipient changed');
      admitAttachments();
      const conversation = this.store.createConversation(candidate!.agentId, 'Dispatched request');
      const message: Message = { id: id(), conversationId: conversation.id, role: 'user', content: input.prompt, runId: null, status: 'complete', createdAt: now(), origin: 'human' };
      this.store.put('message', message);
      let transferred: MessageAttachment[] = [];
      if (manifests.length) transferred = files.transferDrafts({ surface: 'dispatcher', draftId: input.draftId! }, input.attachmentIds!, { agentId: candidate!.agentId, conversationId: conversation.id }, message.id);
      if (transferred.length) this.store.put('message', { ...message, attachments: transferred });
      const created = this.tasks.create({ agentId: candidate!.agentId, title: 'Dispatched request', prompt: input.prompt.trim() ? input.prompt : 'Review the attached files.', ...requirements }, { requestKey: 'dispatcher:' + input.submissionId, withinTransaction: true });
      const task = this.store.put<Task>('task', { ...created, conversationId: conversation.id, inputMessageIds: [message.id] });
      const record: Submission = { id: input.submissionId, hash, state: 'accepted', taskId: task.id, agentId: candidate!.agentId, selectionSource };
      this.store.put(KIND, record);
      return this.project(record, task);
    });
    return { state: 'accepted', receipt: accepted };
  }
  private project(record: Submission, task: Task): DispatcherReceipt {
    if (record.state !== 'accepted' || record.taskId !== task.id || record.agentId !== task.agentId || !record.selectionSource) throw new HttpError(404, 'Dispatcher job not found');
    const tree = this.taskTree(task), held = new Set(this.store.list<{ runId?: string }>('inference-quarantine').flatMap(record => record.runId ? [record.runId] : []));
    const recoveryRequired = tree.some(node => node.recoveryRequired || !!node.runId && held.has(node.runId));
    return { submissionId: record.id, taskId: task.id, agentId: task.agentId, status: task.status, runId: task.runId, conversationId: task.conversationId, selectionSource: record.selectionSource, recoveryRequired, interactionTargets: this.interactionTargets(tree, held), activeWork: this.cancellations.has(task.id) || recoveryRequired || tree.some(node => ['queued', 'scheduled', 'working', 'needs_input'].includes(node.status) || ['running', 'routing'].includes(this.ownedRun(node)?.status ?? '')) };
  }
  private taskTree(root: Task): Task[] {
    const tree: Task[] = [], pending = [root], visited = new Set<string>();
    while (pending.length) {
      const task = pending.pop()!;
      if (visited.has(task.id)) continue; visited.add(task.id);
      tree.push(task);
      if (!Number.isSafeInteger(task.attempt) || task.attempt < 0 || task.id === root.id && (task.parentTaskId !== null || task.parentAttempt !== null)) continue;
      for (const childId of [...task.childTaskIds].reverse()) {
        const child = this.store.get<Task>('task', childId);
        if (child && child.parentTaskId === task.id && child.parentAttempt === task.attempt) pending.push(child);
      }
    }
    return tree;
  }
  private ownedRun(task: Task): Run | undefined {
    const run = task.runId ? this.store.get<Run>('run', task.runId) : undefined;
    const conversation = task.conversationId ? this.store.get<Conversation>('conversation', task.conversationId) : undefined;
    return run && task.runIds.includes(run.id) && run.agentId === task.agentId && run.conversationId === task.conversationId && conversation?.agentId === task.agentId ? run : undefined;
  }
  private interactionTargets(tree: Task[], held: Set<string>): NonNullable<DispatcherReceipt['interactionTargets']> {
    return tree.flatMap(task => {
      if (!['working', 'needs_input'].includes(task.status) || task.recoveryRequired || task.attempt < 1 || !Number.isSafeInteger(task.attempt) || !this.store.get('agent', task.agentId) || task.runId && held.has(task.runId)) return [];
      const run = this.ownedRun(task);
      return run && ['running', 'routing'].includes(run.status) ? [{ taskId: task.id, agentId: task.agentId, runId: run.id }] : [];
    });
  }
  private receipt(record: Submission) { return this.project(record, this.tasks.get(record.taskId!)); }
  lookup(submissionId: string): DispatcherLookup {
    const record = this.store.get<Submission>(KIND, dispatcherId(submissionId));
    if (!record) return { state: 'not-found' };
    if (record.state === 'accepted') { try { return { state: 'accepted', receipt: this.receipt(record) }; } catch { return { state: 'unconfirmed' }; } }
    return { state: record.state === 'pending' && this.inflight.has(submissionId) ? 'pending' : 'unconfirmed' };
  }
  status(taskIds: string[]): DispatcherReceipt[] {
    if (!Array.isArray(taskIds) || taskIds.length > 100 || taskIds.some(taskId => typeof taskId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(taskId))) throw new HttpError(400, 'Supply at most 100 opaque task IDs');
    const wanted = new Set(taskIds);
    return this.store.list<Submission>(KIND).filter(record => record.state === 'accepted' && wanted.has(record.taskId!)).flatMap(record => { try { return [this.receipt(record)]; } catch { return []; } });
  }
  cancel(taskId: string): Promise<DispatcherReceipt> {
    const existing = this.cancellations.get(taskId); if (existing) return existing;
    const pending = this.cancelTree(taskId).finally(() => { this.cancellations.delete(taskId); });
    this.cancellations.set(taskId, pending); return pending;
  }
  private async cancelTree(taskId: string): Promise<DispatcherReceipt> {
    const record = this.store.list<Submission>(KIND).find(record => record.state === 'accepted' && record.taskId === taskId);
    if (!record) throw new HttpError(404, 'Dispatcher job not found');
    this.receipt(record);
    const tree = this.taskTree(this.tasks.get(taskId)), snapshots = new Map(tree.map(task => [task.id, task]));
    const bound = (task: Task) => {
      const seen = new Set<string>(); let current: Task | undefined = task;
      const accepted = this.store.get<Submission>(KIND, record.id);
      if (accepted?.state !== 'accepted' || accepted.taskId !== taskId || accepted.agentId !== record.agentId) return false;
      while (current) {
        if (seen.has(current.id)) return false; seen.add(current.id);
        const snapshot = snapshots.get(current.id);
        if (!snapshot || current.agentId !== snapshot.agentId || current.attempt !== snapshot.attempt || current.runId !== snapshot.runId || current.conversationId !== snapshot.conversationId || current.parentTaskId !== snapshot.parentTaskId || current.parentAttempt !== snapshot.parentAttempt) return false;
        if (current.id === taskId) return current.agentId === record.agentId;
        const parent: Task | undefined = current.parentTaskId ? this.store.get<Task>('task', current.parentTaskId) : undefined;
        if (!parent || !parent.childTaskIds.includes(current.id) || current.parentAttempt !== parent.attempt) return false;
        current = parent;
      }
      return false;
    };
    const scope: TaskCancelScope = {
      visited: new Set(),
      allow: task => bound(task) && (['done', 'failed', 'cancelled'].includes(snapshots.get(task.id)!.status) || !task.runId || !!this.ownedRun(task)),
      child: (parent, child) => bound(parent) && bound(child) && child.parentTaskId === parent.id && child.parentAttempt === parent.attempt,
    };
    let failed = false;
    for (const task of tree) {
      try { await this.tasks.cancel(task.id, scope); } catch { failed = true; }
    }
    this.cancellations.delete(taskId); // Native stops settled; the final projection measures remaining tree work.
    const receipt = this.receipt(record);
    if (failed || receipt.recoveryRequired || receipt.activeWork) throw new HttpError(409, 'Task cancellation was requested but termination could not be confirmed; inspect job status');
    return receipt;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [submissionId, item] of this.inflight) {
      item.controller.abort();
      const latest = this.store.get<Submission>(KIND, submissionId);
      if (latest?.state === 'pending') this.store.put<Submission>(KIND, { id: submissionId, hash: item.hash, state: 'unconfirmed' });
      const observation = this.store.get<SelectionObservation>('dispatcher-selection', submissionId);
      if (observation?.state === 'pending') this.store.put<SelectionObservation>('dispatcher-selection', { ...observation, state: 'cancelled' });
    }
  }
}
