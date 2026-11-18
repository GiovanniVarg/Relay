import type { InteractionAnswer, InteractionPrompt, ProviderId, RunInteraction, GroupEvent } from '../../shared/types.js';
import { interactionAnswer, interactionPrompt } from '../runs.js';
import { HttpError } from '../security.js';
import { id } from '../store.js';

type Pending = { value: RunInteraction; resolve: (answer: InteractionAnswer) => void; reject: (error: Error) => void; cleanup: () => void };
export class DelegationInteractions {
  private pending = new Map<string, Pending>();
  private resolved = new Set<string>();
  constructor(readonly runId: string, private emit: (event: GroupEvent) => void, private alive: () => boolean) {}
  ask(workerId: string, workerName: string, provider: ProviderId, value: InteractionPrompt, signal: AbortSignal): Promise<InteractionAnswer> {
    if (signal.aborted || !this.alive()) return Promise.reject(new Error('The worker interaction has expired'));
    if (this.pending.size >= 20 || this.resolved.size >= 1000) return Promise.reject(new Error('Worker interaction limit reached'));
    const prompt = interactionPrompt(value);
    const interaction: RunInteraction = { ...prompt, title: (workerName + ': ' + prompt.title).slice(0, 160), id: id(), runId: this.runId, provider, workerId, workerName, status: 'pending' };
    const abort = () => this.expire(interaction.id);
    const promise = new Promise<InteractionAnswer>((resolve, reject) => {
      this.pending.set(interaction.id, { value: interaction, resolve, reject, cleanup: () => signal.removeEventListener('abort', abort) });
    });
    signal.addEventListener('abort', abort, { once: true });
    void promise.catch(() => {});
    this.emit({ type: 'interaction', interaction: structuredClone(interaction) });
    return promise;
  }
  list() { return [...this.pending.values()].map(item => structuredClone(item.value)); }
  answer(interactionId: string, value: unknown): RunInteraction {
    if (!this.alive()) throw new HttpError(409, 'The worker interaction has expired');
    const pending = this.pending.get(interactionId);
    if (!pending) throw new HttpError(this.resolved.has(interactionId) ? 409 : 404, 'The worker interaction is unknown or already resolved');
    const answer = interactionAnswer(value, pending.value);
    pending.cleanup(); pending.value.status = 'answered'; this.pending.delete(interactionId); this.resolved.add(interactionId);
    this.emit({ type: 'interactionResolved', runId: this.runId, interactionId, status: 'answered' });
    pending.resolve(answer);
    return structuredClone(pending.value);
  }
  expire(interactionId: string) {
    const pending = this.pending.get(interactionId); if (!pending) return;
    pending.cleanup(); this.pending.delete(interactionId); this.resolved.add(interactionId);
    this.emit({ type: 'interactionResolved', runId: this.runId, interactionId, status: 'expired' });
    pending.reject(new Error('The worker interaction has expired'));
  }
  expireWorker(workerId: string) { for (const [key, item] of this.pending) if (item.value.workerId === workerId) this.expire(key); }
  expireAll() { for (const key of this.pending.keys()) this.expire(key); }
}
