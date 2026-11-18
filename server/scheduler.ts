import { realpathSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, relative, sep } from 'node:path';
import type { ProviderAdapter, ProviderId } from '../shared/types.js';
import type { Store } from './store.js';
import { INFERENCE_STATUS, type InferenceQueueStatus } from '../shared/inference-status.js';

type Lease = { id: string; workspace?: string };
export interface InferenceQuarantine extends Lease { createdAt: string; reason: string; source: 'herdr' | 'provider'; runId?: string; provider?: ProviderId }
export interface ProviderRecoveryAudit { id: string; exclusionId: string; runId: string; provider: ProviderId; method: 'windows-kernel-boot' | 'owned-registry'; recoveredAt: string; holdCreatedAt: string; bootedAt?: string; observedAt?: string; uptimeMilliseconds?: string; baselineObservedAt?: string; baselineMaxUptimeMilliseconds?: string; holdFingerprint?: string; }
type ProviderAdmission = InferenceQuarantine & { admissionVersion: 1; fingerprint: string };
export const quarantineFingerprint = (hold: InferenceQuarantine) => createHash('sha256').update(JSON.stringify([hold.id, hold.createdAt, hold.provider, hold.runId, hold.workspace ?? null])).digest('hex');
type Waiter = Lease & { signal: AbortSignal; start: () => void; reject: (error: unknown) => void; abort: () => void; onStatus?: (status: InferenceQueueStatus) => void; status?: InferenceQueueStatus };
export const unknownInferenceOutcome = (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && ['HERDR_OUTCOME_UNKNOWN', 'PROVIDER_OUTCOME_UNKNOWN'].includes(String(error.code)));
const overlaps = (a?: string, b?: string) => {
  if (!a || !b) return false;
  const within = (parent: string, child: string) => { const r = relative(parent, child); return !r || (r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r)); };
  return within(a, b) || within(b, a);
};

/** Shared inference leases. A lease includes any tool workspace until real provider cleanup completes. */
export class InferenceScheduler {
  private active = new Map<string, Lease>();
  private waiting: Waiter[] = [];
  private quarantines = new Map<string, InferenceQuarantine>();
  private providerIntents = new Map<string, ProviderAdmission>();
  private recoveredProviderIntents = new Map<string, string>();
  constructor(readonly capacity = 2, private store?: Pick<Store, 'list' | 'put' | 'remove'> & Partial<Pick<Store, 'transaction'>>) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Invalid inference capacity');
    for (const lease of store?.list<InferenceQuarantine>('inference-quarantine') ?? []) {
      this.quarantines.set(lease.id, lease); this.active.set(lease.id, lease);
    }
    // An interrupted server cannot know whether its isolated provider worker has finished
    // draining. Reconstruct its durable admission intent before accepting any new work.
    for (const lease of store?.list<ProviderAdmission>('inference-provider-lease') ?? []) {
      this.providerIntents.set(lease.id, lease);
      const existing = this.quarantines.get(lease.id);
      if (lease.admissionVersion === 1 && lease.fingerprint === quarantineFingerprint(lease) && (!existing || quarantineFingerprint(existing) === lease.fingerprint)) this.recoveredProviderIntents.set(lease.id, lease.fingerprint);
      if (existing) continue;
      const held = { ...lease, source: 'provider' as const, reason: 'Relay stopped before provider cleanup was confirmed. Recheck owned-tree proof; a legacy call requires a newer full Windows Restart.' };
      this.quarantines.set(held.id, held); this.active.set(held.id, held);
    }
  }
  get activeCount() { return this.active.size; }
  get queuedCount() { return this.waiting.length; }
  canonical(workspace?: string): string | undefined {
    if (!workspace) return;
    const path = realpathSync.native(workspace); return process.platform === 'win32' ? path.toLowerCase() : path;
  }
  quarantine(id: string, workspace?: string, source: InferenceQuarantine['source'] = 'herdr', owner?: Pick<InferenceQuarantine, 'runId' | 'provider'>) {
    const lease: InferenceQuarantine = this.quarantines.get(id) ?? { ...(source === 'provider' ? this.providerIntents.get(id) : undefined), id, workspace: process.platform === 'win32' ? workspace?.toLowerCase() : workspace, source, ...owner, createdAt: this.providerIntents.get(id)?.createdAt ?? new Date().toISOString(), reason: source === 'herdr' ? 'Worker termination is unconfirmed.' : 'Provider process-tree termination is unconfirmed. Restarting Relay does not clear this exclusion. Recheck durable owned-tree proof; legacy calls without proof require a full Windows Restart newer than this exclusion. Logoff, sleep and fast-start shutdown are insufficient.' };
    this.quarantines.set(id, lease); this.active.set(id, lease); this.store?.put('inference-quarantine', lease); this.updateWaitingStatus();
  }
  listQuarantines() { return [...this.quarantines.values()].map(lease => ({ ...lease })); }
  isRecoveredProviderIntent(hold: InferenceQuarantine): boolean { return this.recoveredProviderIntents.get(hold.id) === quarantineFingerprint(hold); }
  describeProviderQuarantine(id: string, reason: string) {
    const lease = this.quarantines.get(id); if (lease?.source !== 'provider') return;
    const updated = { ...lease, reason }; this.store?.put('inference-quarantine', updated); this.quarantines.set(id, updated); this.active.set(id, updated);
  }
  /** Host recovery only: commit the audit and removal together before allowing queued inference. */
  releaseProviderQuarantine(expected: InferenceQuarantine, audit: ProviderRecoveryAudit): boolean {
    const lease = this.quarantines.get(expected.id);
    if (!lease || lease.source !== 'provider' || lease.runId !== expected.runId || lease.provider !== expected.provider || lease.createdAt !== expected.createdAt || lease.workspace !== expected.workspace || audit.exclusionId !== lease.id || audit.runId !== lease.runId || audit.provider !== lease.provider || audit.holdCreatedAt !== lease.createdAt) return false;
    // Persistent stores must support an atomic audit/removal; otherwise retain the lease.
    if (!this.store?.transaction) return false;
    this.store.transaction(() => {
      this.store!.put('provider-recovery-audit', audit);
      // Account lifecycle holds must settle under the same proof and transaction.
      // Clearing only inference quarantine strands the profile after kernel-boot recovery.
      for (const accountLease of this.store!.list<{id:string;kind:string;runId:string;provider:ProviderId}>('provider-account-lease')) {
        if (accountLease.kind === 'provider' && accountLease.runId === lease.runId && accountLease.provider === lease.provider) this.store!.remove('provider-account-lease', accountLease.id);
      }
      this.store!.remove('inference-quarantine', lease.id);
      this.store!.remove('inference-provider-lease', lease.id);
    });
    this.quarantines.delete(lease.id); this.providerIntents.delete(lease.id); this.recoveredProviderIntents.delete(lease.id); this.active.delete(lease.id); this.drain(); return true;
  }
  /** Only call after an external owner has independently confirmed its process tree is stopped. */
  releaseQuarantine(id: string) { if (!this.quarantines.delete(id)) return; this.store?.remove('inference-quarantine', id); this.active.delete(id); this.drain(); }
  async run<T>(workspace: string | undefined, signal: AbortSignal, work: () => Promise<T>, leaseId?: string, owner?: Pick<InferenceQuarantine, 'runId' | 'provider'>, onStatus?: (status: InferenceQueueStatus) => void): Promise<T> {
    const canonical = this.canonical(workspace);
    if (signal.aborted) throw signal.reason ?? new Error('Run cancelled');
    const id = leaseId ?? 'inference-' + randomUUID();
    if (this.active.has(id) || this.waiting.some(item => item.id === id)) throw new Error('An inference lease with this identity already exists');
    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter = { id, workspace: canonical, signal, reject, abort: () => {}, start: () => {}, onStatus };
      waiter.abort = () => { const at = this.waiting.indexOf(waiter); if (at >= 0) { this.waiting.splice(at, 1); signal.removeEventListener('abort', waiter.abort); reject(signal.reason ?? new Error('Run cancelled')); this.drain(); } };
      waiter.start = () => {
        signal.removeEventListener('abort', waiter.abort); this.active.set(id, { id, workspace: canonical });
        this.notifyStatus(waiter, 'admitted');
        void Promise.resolve().then(() => {
          if (signal.aborted) throw signal.reason ?? new Error('Run cancelled');
          if (owner) {
            const lease: InferenceQuarantine = { id, workspace: canonical, source: 'provider', ...owner, createdAt: new Date().toISOString(), reason: 'Provider cleanup has not yet been confirmed.' };
            const intent: ProviderAdmission = { ...lease, admissionVersion: 1, fingerprint: quarantineFingerprint(lease) };
            this.providerIntents.set(id, intent); this.store?.put('inference-provider-lease', intent);
          }
          return work();
        }).then(value => {
          try { this.store?.remove('inference-provider-lease', id); this.providerIntents.delete(id); this.active.delete(id); resolve(value); this.drain(); }
          catch { this.retainPersistenceFailure(id, canonical, owner); reject(Object.assign(new Error('Inference cleanup persistence failed; its exclusion remains reserved.'), { code: owner ? 'PROVIDER_OUTCOME_UNKNOWN' : 'HERDR_OUTCOME_UNKNOWN' })); }
        }, error => {
          // Unknown means a process may still be consuming inference or writing. Keep the lease until proven stopped.
          try {
            if (unknownInferenceOutcome(error)) this.quarantine(id, canonical, (error as { code: string }).code === 'HERDR_OUTCOME_UNKNOWN' ? 'herdr' : 'provider', owner);
            else { this.store?.remove('inference-provider-lease', id); this.providerIntents.delete(id); this.active.delete(id); }
            reject(error); this.drain();
          } catch { this.retainPersistenceFailure(id, canonical, owner); reject(Object.assign(new Error('Inference cleanup persistence failed; its exclusion remains reserved.'), { code: owner ? 'PROVIDER_OUTCOME_UNKNOWN' : 'HERDR_OUTCOME_UNKNOWN' })); }
        });
      };
      this.waiting.push(waiter); signal.addEventListener('abort', waiter.abort, { once: true });
      if (signal.aborted) waiter.abort(); else this.drain();
    });
  }
  private retainPersistenceFailure(id: string, workspace?: string, owner?: Pick<InferenceQuarantine, 'runId' | 'provider'>) {
    const lease: InferenceQuarantine = this.quarantines.get(id) ?? this.providerIntents.get(id) ?? { id, workspace, source: owner ? 'provider' : 'herdr', ...owner, createdAt: new Date().toISOString(), reason: 'Inference cleanup persistence failed. This exclusion remains reserved.' };
    this.quarantines.set(id, lease); this.active.set(id, lease); this.updateWaitingStatus();
  }
  private notifyStatus(waiter: Waiter, status: InferenceQueueStatus) {
    if (waiter.status === status) return;
    waiter.status = status;
    // Activity is observational: a failed subscriber must never own lease/cleanup semantics.
    try { void Promise.resolve(waiter.onStatus?.(status)).catch(() => {}); } catch {}
  }
  private updateWaitingStatus() {
    for (const waiter of [...this.waiting]) {
      const blocked = [...this.active.values()].filter(active => overlaps(active.workspace, waiter.workspace));
      const held = blocked.some(active => this.quarantines.has(active.id)) || this.active.size >= this.capacity && this.quarantines.size > 0;
      this.notifyStatus(waiter, held ? 'safety-hold' : blocked.length ? 'workspace' : 'capacity');
    }
  }
  private drain() {
    while (this.active.size < this.capacity) {
      const index = this.waiting.findIndex(waiter => ![...this.active.values()].some(active => overlaps(active.workspace, waiter.workspace)));
      if (index < 0) break;
      const [waiter] = this.waiting.splice(index, 1);
      if (waiter.signal.aborted) { waiter.signal.removeEventListener('abort', waiter.abort); waiter.reject(waiter.signal.reason ?? new Error('Run cancelled')); continue; }
      waiter.start();
    }
    this.updateWaitingStatus();
  }
}

export function scheduleAdapters(adapters: Record<ProviderId, ProviderAdapter>, scheduler: InferenceScheduler): Record<ProviderId, ProviderAdapter> {
  return Object.fromEntries(Object.entries(adapters).map(([id, adapter]) => [id, {
    id: adapter.id,
    inspect: () => adapter.inspect(), login: () => adapter.login(), close: () => adapter.close(),
    stream: async (request, emit, signal, beforeDispatch, queueWait, queueStatus) => {
      const settle = queueWait?.(); let waiting = true;
      const finish = (admitted: boolean) => { if (waiting) { waiting = false; settle?.(admitted); } };
      try {
        return await scheduler.run((request.execution?.mode ?? request.mode ?? 'chat') !== 'chat' ? request.execution?.workspace ?? request.workspace : undefined, signal, () => {
          // Settle trusted queue time before the admission policy/budget recheck. Do not
          // pass the queue callback to the provider or infer lifecycle from its text.
          finish(true); beforeDispatch?.(); return adapter.stream(request, emit, signal, beforeDispatch);
        }, 'provider-' + request.runId + '-' + randomUUID(), { runId: request.runId, provider: adapter.id }, status => { queueStatus?.(status); emit({ type: 'status', message: INFERENCE_STATUS[status] }); });
      } finally { finish(false); }
    },
  } satisfies ProviderAdapter])) as Record<ProviderId, ProviderAdapter>;
}
