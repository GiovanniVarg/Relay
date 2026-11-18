import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.js';
import { InferenceScheduler, quarantineFingerprint, scheduleAdapters, type InferenceQuarantine } from '../server/scheduler.js';
import type { ProviderAdapter, ProviderId, ProviderRequest } from '../shared/types.js';
import { ProviderRecovery, strictUtcMilliseconds, type BootObservation } from '../server/provider-recovery.js';

const heldAt = '2026-11-04T18:48:08.969Z';
const firstNow = Date.parse('2026-11-04T20:00:00.000Z');
const oldBoot = '2026-11-01T12:00:00.000Z';
const runId = 'f726c17b-7876-4540-ab26-a4bb5bf6129b';
const leaseId = 'provider-' + runId + '-79dabcd7-49ec-468a-938d-3c42872dbeee';
const expectedAccount = { accountLabel: 'Fixture', plan: 'Fixture' };
const fixtureAdapter = (id: ProviderId, stream: ProviderAdapter['stream'] = async () => ({ text: 'Fixture' })): ProviderAdapter => ({
  id, stream, inspect: async () => ({ id, installed: true, authenticated: true, authMode: 'subscription', ...expectedAccount, models: [] }), login: async () => ({ message: 'Fixture' }), close: async () => {},
});
const fixtureAdapters = (selected: ProviderAdapter): Record<ProviderId, ProviderAdapter> => ({ openai: fixtureAdapter('openai'), claude: fixtureAdapter('claude'), cursor: fixtureAdapter('cursor'), opencode: { id: 'opencode', inspect: async () => ({ id: 'opencode', installed: false, authenticated: false, authMode: 'unknown', accountLabel: '', plan: '', models: [] }), login: async () => ({ message: 'Disabled synthetic OpenCode fixture' }), close: async () => {}, stream: async () => { throw new Error('Disabled synthetic OpenCode fixture must not dispatch'); } }, gemini: fixtureAdapter('gemini'), grok: fixtureAdapter('grok'), [selected.id]: selected });
const observation = (bootedAt: string, now: number): BootObservation => ({ source: 'win32-operating-system', bootedAt, observedAt: new Date(now).toISOString(), uptimeMilliseconds: String(now - Date.parse(bootedAt)) });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'relay-provider-recovery-')), store = new Store(root);
  const hold: InferenceQuarantine = { id: leaseId, runId, provider: 'openai', source: 'provider', createdAt: heldAt, reason: 'Unknown stop', workspace: root };
  store.put('inference-quarantine', hold);
  store.put('run', { id: runId, status: 'interrupted', route: { provider: 'openai' }, error: 'Original interrupted outcome' });
  store.put('harness-change', { id: 'avatar-draft', status: 'draft', checkedRevision: null });
  store.put('task', { id: 'saved-task', status: 'attention', prompt: 'Do not replay' });
  return { root, store, hold, scheduler: new InferenceScheduler(2, store), async close() { store.close(); await rm(root, { recursive: true, force: true }); } };
}

test('strict UTC rejects ambiguous offsets, impossible dates, normalized times and missing milliseconds', () => {
  for (const value of ['', '11/04/2026', '2026-02-30T12:00:00.000Z', '2026-11-04T18:48:08Z', '2026-11-04T18:48:08.969+00:00', '2026-11-04T24:00:00.000Z']) assert.equal(strictUtcMilliseconds(value), undefined);
  assert.equal(strictUtcMilliseconds(heldAt), Date.parse(heldAt));
});

test('first trusted observation never releases, even when kernel boot is newer than the hold', async () => {
  const f = await fixture();
  try {
    const r = new ProviderRecovery(f.store, f.scheduler, async () => ({ stopped: false, bootRecoveryEligible: true }), async () => observation('2026-11-04T19:00:00.000Z', firstNow), () => firstNow);
    assert.equal((await r.reconcile(leaseId)).stopped, false);
    assert.equal(f.scheduler.activeCount, 1); assert.equal(f.store.list('provider-recovery-baseline').length, 1);
    assert.match(f.scheduler.listQuarantines()[0].reason, /first observation never releases/);
    assert.equal(f.store.list('provider-recovery-audit').length, 0);
  } finally { await f.close(); }
});

test('boot recovery requires explicit host eligibility; pending callbacks, missing eligibility and failed reconciliation never query boot', async () => {
  for (const eligibility of ['true', 'false', 'missing', 'throw'] as const) {
    const f = await fixture(); let clock = firstNow, evidence = observation(oldBoot, clock), queries = 0, baselinePhase = false;
    const registry = async () => {
      if (baselinePhase || eligibility === 'true') return { stopped: false, bootRecoveryEligible: true };
      if (eligibility === 'throw') throw new Error('Registry verification failed');
      return eligibility === 'false' ? { stopped: false, bootRecoveryEligible: false } : { stopped: false };
    };
    const r = new ProviderRecovery(f.store, f.scheduler, registry, async () => { queries++; return evidence; }, () => clock);
    try {
      // A false/missing/failed host result cannot even establish a restart baseline.
      const first = await r.reconcile(leaseId);
      assert.equal(first.stopped, false); assert.equal(queries, eligibility === 'true' ? 1 : 0);
      assert.equal(f.store.list('provider-recovery-baseline').length, eligibility === 'true' ? 1 : 0);
      if (eligibility !== 'true') assert.doesNotMatch(first.error!, /Windows Restart|restart.*required/i);
      baselinePhase = true; await r.reconcile(leaseId); baselinePhase = false;
      const savedBaseline = f.store.list('provider-recovery-baseline'), previousQueries = queries;
      // Even with a valid pre-existing baseline and a new boot that would otherwise release,
      // unresolved remote callbacks remain held without querying or changing boot evidence.
      clock += 3600000; evidence = observation(new Date(clock - 60000).toISOString(), clock);
      const result = await r.reconcile(leaseId);
      assert.equal(result.stopped, eligibility === 'true');
      assert.equal(queries, previousQueries + (eligibility === 'true' ? 1 : 0));
      assert.equal(f.store.list('provider-recovery-audit').length, eligibility === 'true' ? 1 : 0);
      if (eligibility !== 'true') {
        assert.equal(f.scheduler.activeCount, 1); assert.deepEqual(f.store.list('provider-recovery-baseline'), savedBaseline);
        assert.match(result.error!, /external operations require independent reconciliation/); assert.doesNotMatch(result.error!, /Windows Restart|restart.*required/i);
      }
    } finally { await f.close(); }
  }
});

test('old/same/future/invalid/unavailable boot evidence and bad uptime never release a baseline hold', async () => {
  const f = await fixture(); let clock = firstNow, evidence: BootObservation = observation(oldBoot, clock);
  const r = new ProviderRecovery(f.store, f.scheduler, async () => ({ stopped: false, bootRecoveryEligible: true }), async () => evidence, () => clock);
  try {
    await r.reconcile(leaseId);
    for (const invalid of [
      { source: 'unavailable' }, observation(oldBoot, clock), observation(heldAt, clock),
      { ...observation(oldBoot, clock), bootedAt: new Date(clock + 1).toISOString() },
      { ...observation(oldBoot, clock), bootedAt: '2026-02-30T00:00:00.000Z' },
      { ...observation(oldBoot, clock), observedAt: new Date(clock + 1).toISOString() },
      { ...observation(oldBoot, clock), uptimeMilliseconds: '0' },
      { ...observation(oldBoot, clock), uptimeMilliseconds: '-1' },
      { ...observation(oldBoot, clock), uptimeMilliseconds: '1.5' },
      { ...observation(oldBoot, clock), uptimeMilliseconds: '18446744073709551616' },
      { ...observation(oldBoot, clock), uptimeMilliseconds: null },
      { ...observation(oldBoot, clock), uptimeMilliseconds: '100' },
      { ...observation(oldBoot, clock), source: 'caller' },
    ]) {
      evidence = invalid as BootObservation; assert.equal((await r.reconcile(leaseId)).stopped, false);
      assert.equal(f.scheduler.activeCount, 1); assert.equal(f.store.list('provider-recovery-audit').length, 0);
    }
    // Forward wall-clock movement within the same kernel does not lower its uptime.
    clock += 86400000; evidence = { source: 'win32-operating-system', bootedAt: new Date(Date.parse(oldBoot) + 86400000).toISOString(), observedAt: new Date(clock).toISOString(), uptimeMilliseconds: String(firstNow - Date.parse(oldBoot)) };
    assert.equal((await r.reconcile(leaseId)).stopped, false); assert.equal(f.scheduler.activeCount, 1);
  } finally { await f.close(); }
});

test('new kernel boot with lower per-hold uptime releases once with durable audit and no action replay', async () => {
  const f = await fixture(); let clock = firstNow, evidence = observation(oldBoot, clock), registryCalls = 0;
  const r = new ProviderRecovery(f.store, f.scheduler, async () => { registryCalls++; return { stopped: false, bootRecoveryEligible: true }; }, async () => evidence, () => clock);
  try {
    await r.reconcile(leaseId);
    const saved = ['run', 'task', 'harness-change'].map(kind => f.store.list(kind));
    clock += 3600000; evidence = observation(new Date(clock - 60000).toISOString(), clock);
    const results = await Promise.all([r.reconcile(leaseId), r.reconcile(leaseId)]); assert.ok(results.every(value => value.stopped));
    assert.equal(f.scheduler.activeCount, 0); assert.equal(f.store.list('inference-quarantine').length, 0);
    const audit = f.store.list<any>('provider-recovery-audit'); assert.equal(audit.length, 1); assert.equal(audit[0].method, 'windows-kernel-boot'); assert.equal(audit[0].provider, 'openai'); assert.equal(audit[0].runId, runId); assert.equal(audit[0].bootedAt, evidence.source === 'win32-operating-system' ? evidence.bootedAt : '');
    assert.equal(JSON.stringify(audit).includes(f.root), false); assert.deepEqual(['run', 'task', 'harness-change'].map(kind => f.store.list(kind)), saved);
    assert.equal((await r.reconcile(leaseId)).stopped, false); assert.equal(f.store.list('provider-recovery-audit').length, 1); assert.equal(registryCalls, 2);
  } finally { await f.close(); }
});

test('registry proof can reconcile without reboot; Herdr, invalid owner/provider/time and unbound legacy runs remain held', async () => {
  for (const change of ['none', 'herdr', 'run', 'provider', 'future', 'badtime', 'route', 'active'] as const) {
    const f = await fixture(); let callbacks = 0;
    try {
      if (change === 'herdr') f.store.put('inference-quarantine', { ...f.hold, source: 'herdr' });
      if (change === 'run') f.store.put('inference-quarantine', { ...f.hold, runId: 'wrong-owner' });
      if (change === 'provider') f.store.put('inference-quarantine', { ...f.hold, provider: 'remote-provider' });
      if (change === 'future') f.store.put('inference-quarantine', { ...f.hold, createdAt: new Date(firstNow + 1).toISOString() });
      if (change === 'badtime') f.store.put('inference-quarantine', { ...f.hold, createdAt: 'yesterday' });
      if (change === 'route') f.store.put('run', { id: runId, status: 'interrupted', route: { provider: 'claude' } });
      if (change === 'active') f.store.put('run', { id: runId, status: 'running', route: { provider: 'openai' } });
      const scheduler = new InferenceScheduler(2, f.store), r = new ProviderRecovery(f.store, scheduler, async () => { callbacks++; return { stopped: change === 'none', bootRecoveryEligible: true }; }, async () => observation(oldBoot, firstNow), () => firstNow);
      assert.equal((await r.reconcile(leaseId)).stopped, change === 'none'); assert.equal(scheduler.activeCount, change === 'none' ? 0 : 1);
      if (change === 'none') assert.equal(f.store.list<any>('provider-recovery-audit')[0].method, 'owned-registry');
      if (['herdr', 'run', 'provider', 'future', 'badtime'].includes(change)) assert.equal(callbacks, 0);
    } finally { await f.close(); }
  }
});

test('audit transaction failure rolls back persisted removal and keeps inference lease held', async () => {
  const f = await fixture();
  try {
    const scheduler = new InferenceScheduler(2, { list: f.store.list.bind(f.store), put: f.store.put.bind(f.store), remove: () => { throw new Error('disk failure'); }, transaction: f.store.transaction.bind(f.store) });
    const r = new ProviderRecovery(f.store, scheduler, async () => ({ stopped: true }), async () => ({ source: 'unavailable' }), () => firstNow);
    await assert.rejects(r.reconcile(leaseId), /disk failure/); assert.equal(scheduler.activeCount, 1); assert.equal(f.store.list('provider-recovery-audit').length, 0); assert.equal(f.store.list('inference-quarantine').length, 1);
  } finally { await f.close(); }
});

test('provider admission is durable before dispatch and reloaded as a hold; verified completion removes intent', async () => {
  const f = await fixture(); f.store.remove('inference-quarantine', leaseId);
  try {
    const scheduler = new InferenceScheduler(2, f.store);
    await scheduler.run(undefined, new AbortController().signal, async () => {
      const intents = f.store.list<any>('inference-provider-lease'); assert.equal(intents.length, 1); assert.equal(intents[0].admissionVersion, 1); assert.equal(intents[0].fingerprint, quarantineFingerprint(intents[0]));
      const restored = new InferenceScheduler(2, f.store); assert.equal(restored.activeCount, 1); assert.equal(restored.isRecoveredProviderIntent(restored.listQuarantines()[0]), true);
    }, leaseId, { runId, provider: 'openai' });
    assert.equal(f.store.list('inference-provider-lease').length, 0); assert.equal(scheduler.activeCount, 0);
  } finally { await f.close(); }
});

test('intent persistence failures settle promptly, prevent unsafe dispatch and retain uncertain durable ownership', async () => {
  for (const failure of ['admission', 'removal', 'quarantine'] as const) {
    const f = await fixture(); f.store.remove('inference-quarantine', leaseId); let calls = 0;
    try {
      const scheduler = new InferenceScheduler(2, { list: f.store.list.bind(f.store), transaction: f.store.transaction.bind(f.store), put: ((kind: string, value: { id: string }) => { if (kind === (failure === 'admission' ? 'inference-provider-lease' : failure === 'quarantine' ? 'inference-quarantine' : 'unused')) throw new Error('write unavailable'); return f.store.put(kind, value); }) as Store['put'], remove: (kind, id) => { if (failure === 'removal' && kind === 'inference-provider-lease') throw new Error('remove unavailable'); f.store.remove(kind, id); } });
      const result = scheduler.run(undefined, new AbortController().signal, async () => { calls++; if (failure === 'quarantine') throw Object.assign(new Error('unknown'), { code: 'PROVIDER_OUTCOME_UNKNOWN' }); return 'result'; }, leaseId, { runId, provider: 'openai' });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await assert.rejects(Promise.race([result, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('hung scheduler')), 1000); })]), /write unavailable|cleanup persistence failed/); }
      finally { if (timer) clearTimeout(timer); }
      assert.equal(calls, failure === 'admission' ? 0 : 1);
      assert.equal(scheduler.activeCount, failure === 'admission' ? 0 : 1);
      if (failure !== 'admission') assert.equal(new InferenceScheduler(2, f.store).activeCount, 1);
    } finally { await f.close(); }
  }
});

test('a baseline from a different exact hold or a future clock cannot release or replace the baseline', async () => {
  for (const change of ['scope', 'future'] as const) {
    const f = await fixture(); let clock = firstNow, evidence = observation(oldBoot, clock);
    try {
      let scheduler = f.scheduler, recovery = new ProviderRecovery(f.store, scheduler, async () => ({ stopped: false, bootRecoveryEligible: true }), async () => evidence, () => clock);
      await recovery.reconcile(leaseId); const baseline = f.store.list<any>('provider-recovery-baseline')[0];
      if (change === 'scope') { f.store.put('inference-quarantine', { ...f.hold, workspace: f.root + '-other' }); scheduler = new InferenceScheduler(2, f.store); }
      else f.store.put('provider-recovery-baseline', { ...baseline, observedAt: '2027-01-01T00:00:00.000Z' });
      const savedBaseline = f.store.list('provider-recovery-baseline'); clock += 3600000; evidence = observation(new Date(clock - 60000).toISOString(), clock);
      recovery = new ProviderRecovery(f.store, scheduler, async () => ({ stopped: false, bootRecoveryEligible: true }), async () => evidence, () => clock);
      assert.equal((await recovery.reconcile(leaseId)).stopped, false); assert.equal(scheduler.activeCount, 1); assert.deepEqual(f.store.list('provider-recovery-baseline'), savedBaseline);
    } finally { await f.close(); }
  }
});

test('versioned recovered host intents allow group/classifier boot recovery; unversioned identities cannot widen legacy scope', async () => {
  for (const valid of [true, false]) {
    const f = await fixture(); f.store.remove('inference-quarantine', leaseId); f.store.remove('run', runId);
    let clock = firstNow, evidence = observation(oldBoot, clock);
    try {
      const hold = { ...f.hold, admissionVersion: valid ? 1 : 2, fingerprint: quarantineFingerprint(f.hold) }; f.store.put('inference-provider-lease', hold);
      const scheduler = new InferenceScheduler(2, f.store), r = new ProviderRecovery(f.store, scheduler, async () => ({ stopped: false, bootRecoveryEligible: true }), async () => evidence, () => clock);
      await r.reconcile(leaseId); clock += 3600000; evidence = observation(new Date(clock - 60000).toISOString(), clock);
      assert.equal((await r.reconcile(leaseId)).stopped, valid); assert.equal(f.store.list('inference-provider-lease').length, valid ? 0 : 1);
    } finally { await f.close(); }
  }
});

test('recoverAll coalesces host boot observation and never touches remote Herdr exclusions', async () => {
  const f = await fixture(); let queries = 0;
  try {
    f.store.put('inference-quarantine', { ...f.hold, id: leaseId + '-second' }); f.store.put('inference-quarantine', { ...f.hold, id: 'herdr-remote', source: 'herdr' });
    const scheduler = new InferenceScheduler(4, f.store), r = new ProviderRecovery(f.store, scheduler, async () => ({ stopped: false, bootRecoveryEligible: true }), async () => { queries++; return observation(oldBoot, firstNow); }, () => firstNow);
    await r.recoverAll(); assert.equal(queries, 1); assert.equal(scheduler.activeCount, 3); assert.equal(f.store.list('provider-recovery-baseline').length, 2); assert.equal(scheduler.listQuarantines().find(item => item.id === 'herdr-remote')?.reason, 'Unknown stop');
  } finally { await f.close(); }
});

test('app-only Agent over chat transport reserves its host execution workspace and persists that same scope', async () => {
  const f = await fixture(); f.store.remove('inference-quarantine', leaseId); let release!: () => void;
  const gate = new Promise<void>(done => { release = done; }), starts: string[] = [];
  try {
    const scheduler = new InferenceScheduler(2, f.store);
    const raw = fixtureAdapter('cursor', async request => { starts.push(request.runId); if (request.runId === 'one') await gate; return { text: 'Fixture' }; });
    const adapters = scheduleAdapters(fixtureAdapters(raw), scheduler);
    const request = (id: string): ProviderRequest => ({ runId: id, conversationId: 'fixture', model: 'fixture', instructions: '', history: [], maxSeconds: 5, mode: 'chat', expectedAccount, execution: { mode: 'agent', surface: 'run', workspace: f.root } });
    const a = adapters.cursor.stream(request('one'), () => {}, new AbortController().signal);
    const b = adapters.cursor.stream(request('two'), () => {}, new AbortController().signal);
    await new Promise(resolve => setTimeout(resolve, 10)); assert.deepEqual(starts, ['one']); assert.equal(scheduler.queuedCount, 1);
    const intent = f.store.list<any>('inference-provider-lease')[0]; assert.equal(intent.workspace, scheduler.canonical(f.root));
    const recovered = new InferenceScheduler(2, f.store); assert.equal(recovered.listQuarantines()[0].workspace, scheduler.canonical(f.root));
    release(); await Promise.all([a, b]); assert.deepEqual(starts, ['one', 'two']);
  } finally { release(); await f.close(); }
});

test('scheduled adapters preserve the host admission recheck at the worker initialization boundary', async () => {
  let setup!: () => void, entered!: () => void, allowed = true, checks = 0, inference = 0;
  const gate = new Promise<void>(done => { setup = done; }), inside = new Promise<void>(done => { entered = done; });
  const adapter = fixtureAdapter('openai', async (_request, _emit, _signal, beforeDispatch) => { entered(); await gate; beforeDispatch?.(); inference++; return { text: 'Fixture' }; });
  const scheduler = new InferenceScheduler(), adapters = scheduleAdapters(fixtureAdapters(adapter), scheduler);
  const pending = adapters.openai.stream({ runId: 'admission-recheck', conversationId: 'fixture', model: 'fixture', instructions: '', history: [], maxSeconds: 5, mode: 'chat', expectedAccount }, () => {}, new AbortController().signal, () => { checks++; if (!allowed) throw new Error('Permission changed before native launch'); });
  await inside; allowed = false; setup(); await assert.rejects(pending, /Permission changed/);
  assert.equal(checks, 2); assert.equal(inference, 0); assert.equal(scheduler.activeCount, 0);
});
