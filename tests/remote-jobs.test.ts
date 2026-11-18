import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteJobs, type RemoteJobHooks, type RemoteJobStore } from '../server/remote-jobs.js';
import type { RemoteInventory, RemotePoll } from '../shared/remote-jobs.js';

// A clone-on-read store catches accidental dependence on mutation without put().
class MemoryStore implements RemoteJobStore {
  rows = new Map<string, Map<string, unknown>>();
  get<T>(kind: string, id: string): T | undefined { return structuredClone(this.rows.get(kind)?.get(id)) as T | undefined; }
  list<T>(kind: string): T[] { return [...(this.rows.get(kind)?.values() ?? [])].map(v => structuredClone(v) as T); }
  put<T extends { id: string }>(kind: string, value: T): T { let table = this.rows.get(kind); if (!table) this.rows.set(kind, table = new Map()); table.set(value.id, structuredClone(value)); return value; }
  remove(kind: string, id: string) { this.rows.get(kind)?.delete(id); }
  transaction<T>(fn: () => T): T { const saved = structuredClone(this.rows); try { return fn(); } catch (error) { this.rows = saved; throw error; } }
}
const inventory: RemoteInventory = { protocolVersion: 1, name: 'Office PC', platform: 'win32', providers: [{ id: 'openai', models: [{ id: 'worker-model', name: 'Worker model', available: true, modalities: ['text'] }] }], workspaces: ['projects'], defaultAgent: { id: 'agent', provider: 'openai', model: 'worker-model', ready: true } };
function fixture(overrides: Partial<RemoteJobHooks> = {}) {
  let now = 100000; const authorized = new Set(['pc-a', 'pc-b']); const store = new MemoryStore();
  const reports: unknown[] = [];
  const hooks: RemoteJobHooks = { authorizeWorker: id => authorized.has(id), assertWritable() {}, payload: async job => ({ prompt: job.prompt, workspace: 'projects' }), reportOutcome: async (...args) => { reports.push(args); }, clock: () => now, cancelTimeoutMs: 1, ...overrides };
  const jobs = new RemoteJobs(store, hooks);
  jobs.heartbeat('pc-a', inventory); jobs.heartbeat('pc-b', { ...inventory, name: 'Other PC' });
  function enqueue(computerId = 'pc-a') { return jobs.enqueue({ taskId: 'task', attempt: 1, agentId: 'agent', computerId, prompt: 'Build the fixture', capsuleId: 'capsule' }); }
  return { jobs, store, hooks, authorized, reports, enqueue, advance(ms: number) { now += ms; } };
}
function offered(poll: RemotePoll) { assert.ok(poll.job); assert.ok(poll.leaseId); return { id: poll.job.id, lease: poll.leaseId }; }
async function running(f: ReturnType<typeof fixture>) { const run = f.enqueue(); const offer = offered(await f.jobs.poll('pc-a', 'instance-1')); f.jobs.ack('pc-a', offer.id, offer.lease, 'instance-1'); f.jobs.started('pc-a', offer.id, offer.lease, 'instance-1'); return { ...offer, ...run }; }

test('target stays queued offline and never falls back to another computer', async () => {
  const f = fixture(); const run = f.enqueue(); f.advance(50000);
  assert.equal(f.jobs.computers().find(c => c.id === 'pc-a')?.online, false);
  assert.deepEqual(await f.jobs.poll('pc-b', 'other-instance'), {});
  assert.equal(f.jobs.snapshot(run.runId)?.status, 'routing');
  assert.equal((await f.jobs.poll('pc-a', 'instance-1')).job?.computerId, 'pc-a');
});
test('unaccepted offer expires, stale ack fails, replacement gets fresh lease', async () => {
  const f = fixture(); f.enqueue(); const first = offered(await f.jobs.poll('pc-a', 'instance-1'));
  f.advance(30001);
  assert.throws(() => f.jobs.ack('pc-a', first.id, first.lease, 'instance-1'), /expired/);
  const second = offered(await f.jobs.poll('pc-a', 'instance-2'));
  assert.equal(first.id, second.id); assert.notEqual(first.lease, second.lease);
  assert.throws(() => f.jobs.ack('pc-a', first.id, first.lease, 'instance-1'), /Wrong worker/);
});
test('role, lease, instance, and device ownership are enforced', async () => {
  const f = fixture(); f.enqueue(); const o = offered(await f.jobs.poll('pc-a', 'instance-1'));
  assert.throws(() => f.jobs.ack('pc-b', o.id, o.lease, 'instance-1'), /Wrong worker/);
  assert.throws(() => f.jobs.ack('pc-a', o.id, o.lease, 'wrong-instance'), /Wrong worker/);
  f.authorized.delete('pc-a');
  await assert.rejects(f.jobs.poll('pc-a', 'instance-1'), /not authorized/);
  assert.throws(() => f.jobs.ack('pc-a', o.id, o.lease, 'instance-1'), /not authorized/);
  assert.throws(() => f.jobs.heartbeat('pc-a', inventory), /not authorized/);
});
test('accepted lease survives controller restart and temporary disconnect, never relaunches', async () => {
  const f = fixture(); const r = await running(f); f.advance(900000);
  const restored = new RemoteJobs(f.store, f.hooks);
  assert.equal(restored.restoreKeepsWaiting({ id: 'task', runId: r.runId, attempt: 1 }), true);
  const resume = await restored.poll('pc-a', 'instance-1');
  assert.equal(resume.leaseId, r.lease); assert.equal(resume.payload, undefined);
  assert.equal(restored.snapshot(r.runId)?.status, 'running');
  assert.equal(restored.restoreKeepsWaiting({ id: 'wrong-task', runId: r.runId }), false);
});
test('new worker instance makes accepted execution unknown and fences retries until inspection', async () => {
  const f = fixture(); const r = await running(f); f.enqueue();
  assert.deepEqual(await f.jobs.poll('pc-a', 'instance-2'), {});
  assert.equal(f.jobs.snapshot(r.runId)?.status, 'error');
  assert.match(f.jobs.get(r.id)?.error ?? '', /inspect/);
  assert.deepEqual(await f.jobs.poll('pc-a', 'instance-2'), {});
  f.jobs.acknowledgeInspection(r.id, 'Operator checked the machine; the process has stopped.');
  assert.notEqual((await f.jobs.poll('pc-a', 'instance-2')).job?.id, r.id);
});
test('events enforce monotonic sequences, exact duplicates and bounded history', async () => {
  const f = fixture(); const r = await running(f);
  const e = { sequence: 1, type: 'progress' as const, text: 'Started' };
  f.jobs.event('pc-a', r.id, r.lease, 'instance-1', e);
  f.jobs.event('pc-a', r.id, r.lease, 'instance-1', e);
  assert.throws(() => f.jobs.event('pc-a', r.id, r.lease, 'instance-1', { ...e, text: 'Changed' }), /Changed duplicate/);
  assert.throws(() => f.jobs.event('pc-a', r.id, r.lease, 'instance-1', { ...e, sequence: 3 }), /gap/);
  for (let sequence = 2; sequence < 140; sequence++) f.jobs.event('pc-a', r.id, r.lease, 'instance-1', { ...e, sequence, text: 'x'.repeat(1000) });
  assert.ok(f.jobs.events(r.id).length <= 120); assert.ok(JSON.stringify(f.jobs.events(r.id)).length <= 24000);
  f.jobs.event('pc-a', r.id, r.lease, 'instance-1', e); // Durable digest survives log eviction.
});
test('complete reports to main Task while snapshot is still running and concurrent finishes are idempotent', async () => {
  const f = fixture(); const r = await running(f); let calls = 0;
  f.hooks.reportOutcome = async (taskId, runId, report) => {
    calls++; assert.equal(taskId, 'task'); assert.equal(runId, r.runId); assert.equal(f.jobs.snapshot(runId)?.status, 'running');
    assert.deepEqual(report.evidence, []); assert.match(report.summary, /host unverified/);
    await Promise.resolve();
  };
  const receipt = { sequence: 1, state: 'complete' as const, text: 'Result', summary: 'Done' };
  const finish = () => f.jobs.finish('pc-a', r.id, r.lease, 'instance-1', receipt);
  assert.deepEqual(await Promise.all([finish(), finish()]), ['complete', 'complete']); assert.equal(calls, 1);
  assert.equal(f.jobs.snapshot(r.runId)?.status, 'complete');
  await assert.rejects(f.jobs.finish('pc-a', r.id, r.lease, 'instance-1', { ...receipt, text: 'Changed' }), /Changed duplicate/);
});
test('failed authoritative report leaves execution nonterminal and retryable for the same receipt', async () => {
  const f = fixture(); const r = await running(f); let calls = 0;
  f.hooks.reportOutcome = async () => { if (++calls === 1) throw new Error('Task unavailable'); };
  const receipt = { sequence: 1, state: 'complete' as const, text: '', summary: '' };
  await assert.rejects(f.jobs.finish('pc-a', r.id, r.lease, 'instance-1', receipt), /Task unavailable/);
  assert.equal(f.jobs.snapshot(r.runId)?.status, 'running');
  await f.jobs.finish('pc-a', r.id, r.lease, 'instance-1', receipt);
  assert.equal(f.jobs.snapshot(r.runId)?.status, 'complete');
});
test('cancellation without confirmed termination becomes unknown and never requeues', async () => {
  const f = fixture(); const r = await running(f);
  await assert.rejects(f.jobs.cancel(r.runId), /unconfirmed/);
  assert.equal(f.jobs.get(r.id)?.state, 'unknown');
  assert.deepEqual(await f.jobs.poll('pc-a', 'instance-1'), {});
  const g = fixture(); const s = await running(g);
  assert.equal(await g.jobs.finish('pc-a', s.id, s.lease, 'instance-1', { sequence: 1, state: 'cancelled', text: '', summary: '' }), 'unknown');
});
test('confirmed worker stop resolves cancellation; queued cancellation cannot launch', async () => {
  const f = fixture({ cancelTimeoutMs: 100 }); const r = await running(f);
  const cancelling = f.jobs.cancel(r.runId);
  assert.equal((await f.jobs.poll('pc-a', 'instance-1')).cancelRequested, true);
  await f.jobs.finish('pc-a', r.id, r.lease, 'instance-1', { sequence: 1, state: 'cancelled', text: '', summary: '', terminationConfirmed: true });
  await cancelling; assert.equal(f.jobs.snapshot(r.runId)?.status, 'cancelled');
  const queued = f.enqueue(); await f.jobs.cancel(queued.runId);
  assert.deepEqual(await f.jobs.poll('pc-a', 'instance-1'), {});
});
test('questions only accept requested IDs/options; local credentials stay on the worker', async () => {
  const f = fixture(); const r = await running(f);
  f.jobs.event('pc-a', r.id, r.lease, 'instance-1', { sequence: 1, type: 'question', question: { id: 'question', revision: 1, title: 'Choose', description: '', questions: [{ id: 'choice', question: 'Select a branch', options: [{ id: 'main', label: 'Main' }] }] } });
  assert.throws(() => f.jobs.answer(r.id, 'question', 1, { choice: 'arbitrary-approval' }), /outside/);
  f.jobs.answer(r.id, 'question', 1, { choice: 'main' });
  assert.equal((await f.jobs.poll('pc-a', 'instance-1')).interactionAnswers?.[0].answers.choice, 'main');
  assert.deepEqual(await f.jobs.poll('pc-b', 'instance-2'), {});
  f.jobs.event('pc-a', r.id, r.lease, 'instance-1', { sequence: 2, type: 'question', question: { id: 'login', revision: 1, localOnly: true, title: 'secret-title', description: 'secret-description', questions: [] } });
  assert.throws(() => f.jobs.answer(r.id, 'login', 1, {}), /No matching/);
  assert.equal(JSON.stringify(f.jobs.get(r.id)).includes('secret-description'), false);
});
test('inventory and result bodies are bounded; host paths and extra credential fields are not stored', async () => {
  const f = fixture();
  assert.throws(() => f.jobs.heartbeat('pc-a', { ...inventory, workspaces: ['C:\\Users\\example'] }), /alias/);
  assert.throws(() => f.jobs.heartbeat('pc-a', { ...inventory, providers: [{ id: 'openai', models: Array.from({ length: 20001 }, () => inventory.providers[0].models[0]) }] }), /catalog/);
  f.jobs.heartbeat('pc-a', { ...inventory, password: 'never-store-this', hostPath: 'C:\\secret' } as RemoteInventory);
  assert.equal(JSON.stringify(f.jobs.computers()).includes('never-store-this'), false);
  const r = await running(f);
  await assert.rejects(f.jobs.finish('pc-a', r.id, r.lease, 'instance-1', { sequence: 1, state: 'complete', text: 'x'.repeat(64001), summary: '' }), /bounded/);
  f.jobs.revokeWorker('pc-a'); assert.equal(f.jobs.get(r.id)?.state, 'unknown');
  await assert.rejects(f.jobs.poll('pc-a', 'instance-1'), /not authorized/);
});

test('full remote model catalogs remain indexable past the old 250-model truncation',()=>{const f=fixture(),models=Array.from({length:1200},(_,i)=>({...inventory.providers[0].models[0],id:'model-'+i}));f.jobs.heartbeat('pc-a',{...inventory,providers:[{id:'openai',models}]});assert.equal(f.jobs.computers().find(c=>c.id==='pc-a')!.providers[0].models[1199].id,'model-1199');});
