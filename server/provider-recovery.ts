import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { isActiveProviderId, type ProviderId, type Run } from '../shared/types.js';
import type { Store } from './store.js';
import { InferenceScheduler, quarantineFingerprint, type InferenceQuarantine, type ProviderRecoveryAudit } from './scheduler.js';

export type BootObservation = { source: 'win32-operating-system'; bootedAt: string; observedAt: string; uptimeMilliseconds: string } | { source: 'unavailable' };
interface BootBaseline { id: string; fingerprint: string; bootedAt: string; observedAt: string; maxUptimeMilliseconds: string; }
export type ProviderStopResult = { stopped: boolean; error?: string; bootRecoveryEligible?: boolean };
export type ProviderRegistryReconcile = (runId: string, provider: ProviderId) => Promise<ProviderStopResult>;
const restartRequirement = 'The exclusion remains reserved. Without durable owned-tree proof, a full Windows Restart newer than this exclusion is required. Restarting Relay, logoff, sleep and fast-start shutdown do not prove cleanup. No task was replayed.';
const uptimeValue = (value: unknown): bigint | undefined => {
  if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value)) return;
  const number = BigInt(value); return number <= 18446744073709551615n ? number : undefined;
};

/** Date.parse alone normalizes impossible dates. Accept only exact, canonical UTC milliseconds. */
export function strictUtcMilliseconds(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return;
  const parsed = Date.parse(value); if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) return;
  return parsed;
}

// Fixed host query only. LastBootUpTime is the kernel boot epoch: a resumed fast-start kernel
// retains its prior epoch. No executable, script, timestamp or proof comes from HTTP input.
const bootScript = "$ErrorActionPreference='Stop';Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class RelayKernelClock { [DllImport(\"kernel32.dll\")] public static extern ulong GetTickCount64(); }';$v=@(Get-CimInstance -ClassName Win32_OperatingSystem -Property LastBootUpTime);if($v.Count -ne 1 -or $v[0].LastBootUpTime -isnot [DateTime] -or $v[0].LastBootUpTime.Kind -eq [DateTimeKind]::Unspecified){exit 2};$b=$v[0].LastBootUpTime.ToUniversalTime().ToString(\"yyyy-MM-dd'T'HH:mm:ss.fff'Z'\",[Globalization.CultureInfo]::InvariantCulture);$u=[RelayKernelClock]::GetTickCount64().ToString([Globalization.CultureInfo]::InvariantCulture);[Console]::Out.Write((@{bootedAt=$b;uptimeMilliseconds=$u}|ConvertTo-Json -Compress))";
export async function observeWindowsBoot(): Promise<BootObservation> {
  if (process.platform !== 'win32') return { source: 'unavailable' };
  const before = Date.now();
  try {
    const output = await new Promise<string>((resolve, reject) => {
      execFile(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', bootScript], { windowsHide: true, timeout: 10000, maxBuffer: 1024, encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(stdout));
    });
    const value: unknown = JSON.parse(output), after = Date.now();
    if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'bootedAt,uptimeMilliseconds') return { source: 'unavailable' };
    const { bootedAt, uptimeMilliseconds } = value as { bootedAt: string; uptimeMilliseconds: string }, boot = strictUtcMilliseconds(bootedAt), uptime = uptimeValue(uptimeMilliseconds);
    if (boot === undefined || uptime === undefined || after < before || after - before > 15000 || boot > before || uptime > BigInt(Number.MAX_SAFE_INTEGER) || Math.abs(boot + Number(uptime) - after) > 60000) return { source: 'unavailable' };
    return { source: 'win32-operating-system', bootedAt, uptimeMilliseconds, observedAt: new Date(after).toISOString() };
  } catch { return { source: 'unavailable' }; }
}

/** All proof callbacks are host-owned dependencies; callers can select only an exclusion ID. */
export class ProviderRecovery {
  private pending = new Map<string, Promise<ProviderStopResult>>();
  constructor(private store: Pick<Store, 'get' | 'put'>, private scheduler: InferenceScheduler, private registry: ProviderRegistryReconcile, private observe: () => Promise<BootObservation> = observeWindowsBoot, private clock: () => number = Date.now) {}
  async recoverAll(): Promise<void> {
    let observation: Promise<BootObservation> | undefined;
    const observe = () => observation ??= this.observe().catch(() => ({ source: 'unavailable' as const }));
    for (const hold of this.scheduler.listQuarantines()) if (hold.source === 'provider') await this.reconcileUsing(hold.id, observe);
  }
  reconcile(id: string): Promise<ProviderStopResult> {
    return this.reconcileUsing(id, this.observe);
  }
  private reconcileUsing(id: string, observe: () => Promise<BootObservation>): Promise<ProviderStopResult> {
    const prior = this.pending.get(id); if (prior) return prior;
    const operation = this.recover(id, observe).finally(() => { this.pending.delete(id); });
    this.pending.set(id, operation); return operation;
  }
  private async recover(id: string, observe: () => Promise<BootObservation>): Promise<ProviderStopResult> {
    const hold = this.scheduler.listQuarantines().find(item => item.id === id);
    if (!hold || hold.source !== 'provider') return { stopped: false, error: 'This is not a provider exclusion.' };
    const heldAt = strictUtcMilliseconds(hold.createdAt), now = this.clock();
    if (!Number.isFinite(now) || heldAt === undefined || heldAt > now || !isActiveProviderId(hold.provider) || typeof hold.runId !== 'string' || !/^[A-Za-z0-9_-]{1,180}$/.test(hold.runId) || !hold.id.startsWith('provider-' + hold.runId + '-')) return this.retained(hold, 'Provider exclusion identity or creation time cannot be verified.');
    let registry: ProviderStopResult;
    try { registry = await this.registry(hold.runId, hold.provider); } catch { registry = { stopped: false }; }
    if (registry?.stopped === true) return this.release(hold, { method: 'owned-registry' });
    // Kernel reboot proves only local process cleanup. A host callback may have started a
    // remote operation, so absence of positive host eligibility must never fall through.
    if (registry?.bootRecoveryEligible !== true) return this.retained(hold, 'The host has not verified that this uncertainty is limited to local processes. Pending or unverified external operations require independent reconciliation; local boot evidence cannot settle them.', false);
    // Legacy boot recovery requires a durable ordinary run/provider binding. A missing run,
    // unfinished run, classifier identity or conflicting provider is not retrospectively invented.
    const run = this.store.get<Run>('run', hold.runId);
    if (!this.scheduler.isRecoveredProviderIntent(hold) && (!run || run.id !== hold.runId || run.route?.provider !== hold.provider || !['complete', 'failed', 'cancelled', 'interrupted'].includes(run.status))) return this.retained(hold, 'No matching stopped ordinary run/provider record or versioned host admission exists for boot recovery.');
    let observation: BootObservation;
    try { observation = await observe(); } catch { observation = { source: 'unavailable' }; }
    const checkedAt = this.clock();
    if (observation?.source !== 'win32-operating-system') return this.retained(hold, 'Host Windows kernel boot evidence is unavailable.');
    const boot = strictUtcMilliseconds(observation.bootedAt), observed = strictUtcMilliseconds(observation.observedAt), uptime = uptimeValue(observation.uptimeMilliseconds);
    // One second separates persisted millisecond hold times from the OS timestamp precision.
    if (!Number.isFinite(checkedAt) || checkedAt < now || observed === undefined || observed < now - 15000 || observed > checkedAt || checkedAt - observed > 15000 || boot === undefined || boot > observed || heldAt > checkedAt || uptime === undefined || uptime > BigInt(Number.MAX_SAFE_INTEGER) || Math.abs(boot + Number(uptime) - observed) > 60000) return this.retained(hold, 'Host boot timestamps or kernel uptime are invalid, stale or inconsistent.');
    const baselineId = 'provider-recovery-baseline-' + hold.id, hash = quarantineFingerprint(hold), baseline = this.store.get<BootBaseline>('provider-recovery-baseline', baselineId);
    const priorObserved = strictUtcMilliseconds(baseline?.observedAt), priorBoot = strictUtcMilliseconds(baseline?.bootedAt), priorUptime = uptimeValue(baseline?.maxUptimeMilliseconds);
    if (!baseline) {
      this.store.put('provider-recovery-baseline', { id: baselineId, fingerprint: hash, bootedAt: observation.bootedAt, observedAt: observation.observedAt, maxUptimeMilliseconds: observation.uptimeMilliseconds } satisfies BootBaseline);
      return this.retained(hold, 'A trusted boot/uptime baseline has been recorded for this exact exclusion. The first observation never releases it; a full Windows Restart after this observation is required.');
    }
    if (baseline.fingerprint !== hash || priorObserved === undefined || priorBoot === undefined || priorBoot > priorObserved || priorObserved > observed || priorUptime === undefined || priorUptime > BigInt(Number.MAX_SAFE_INTEGER)) return this.retained(hold, 'The persisted boot baseline identity or timestamps are invalid.');
    if (boot <= heldAt + 1000 || boot <= priorObserved + 1000 || uptime >= priorUptime) {
      this.store.put('provider-recovery-baseline', { ...baseline, observedAt: observation.observedAt, maxUptimeMilliseconds: (uptime > priorUptime ? uptime : priorUptime).toString() });
      return this.retained(hold, 'Windows has not proven a new kernel boot with decreased uptime after this exclusion’s trusted baseline.');
    }
    return this.release(hold, { method: 'windows-kernel-boot', bootedAt: observation.bootedAt, observedAt: observation.observedAt, uptimeMilliseconds: observation.uptimeMilliseconds, baselineObservedAt: baseline.observedAt, baselineMaxUptimeMilliseconds: baseline.maxUptimeMilliseconds, holdFingerprint: hash });
  }
  private retained(hold: InferenceQuarantine, detail: string, bootRecoveryEligible = true): ProviderStopResult {
    const error = detail + ' ' + (bootRecoveryEligible ? restartRequirement : 'The exclusion remains reserved. No task was replayed.');
    this.scheduler.describeProviderQuarantine(hold.id, error); return { stopped: false, error };
  }
  private release(hold: InferenceQuarantine, proof: Omit<ProviderRecoveryAudit, 'id' | 'exclusionId' | 'runId' | 'provider' | 'holdCreatedAt' | 'recoveredAt'>): ProviderStopResult {
    const audit: ProviderRecoveryAudit = { id: 'provider-recovery-' + hold.id, exclusionId: hold.id, runId: hold.runId!, provider: hold.provider!, holdCreatedAt: hold.createdAt, recoveredAt: new Date(this.clock()).toISOString(), ...proof };
    return this.scheduler.releaseProviderQuarantine(hold, audit) ? { stopped: true } : { stopped: false, error: 'The provider exclusion changed or its durable audit could not be committed. It remains reserved.' };
  }
}
