import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteJobs, type RemoteJobStore } from '../server/remote-jobs.js';
import { WorkerRuntime, createNativeWorkerExecutor, type NativeWorkerApp, type WorkerExecutor, type WorkerJournal, type WorkerJournalStore, type WorkerTransport, type WorkerExecutionSnapshot } from '../server/worker-runtime.js';
import type { RemoteInventory } from '../shared/remote-jobs.js';

class Records implements RemoteJobStore {
  data = new Map<string, Map<string, unknown>>();
  get<T>(kind: string, id: string) { return structuredClone(this.data.get(kind)?.get(id)) as T | undefined; }
  list<T>(kind: string) { return [...(this.data.get(kind)?.values() ?? [])].map(x => structuredClone(x) as T); }
  put<T extends { id: string }>(kind: string, value: T) { let table = this.data.get(kind); if (!table) this.data.set(kind, table = new Map()); table.set(value.id, structuredClone(value)); return value; }
  remove(kind: string, id: string) { this.data.get(kind)?.delete(id); }
  transaction<T>(fn: () => T) { return fn(); }
}
class Journal implements WorkerJournalStore {
  data = new Map<string, WorkerJournal>();
  get(id: string) { const value = this.data.get(id); return value ? structuredClone(value) : undefined; }
  put(value: WorkerJournal) { this.data.set(value.id, structuredClone(value)); }
}
const inventory: RemoteInventory = { protocolVersion: 1, name: 'Fake worker', platform: 'linux', providers: [{ id: 'openai', models: [{ id: 'fake', name: 'No inference test', available: true, modalities: ['text'] }] }], workspaces: ['home'] };
function fixture() {
  const store = new Records(), reports: unknown[] = [], authorized = new Set(['pc-a', 'pc-b']);
  const broker = new RemoteJobs(store, { authorizeWorker: id => authorized.has(id), assertWritable() {}, payload: async job => ({ instruction: job.prompt }), reportOutcome: async (...args) => { reports.push(args); } });
  const calls: { worker: string; action: string; body: unknown }[] = [];
  function transport(worker: string, intercept?: (action: string, value: unknown) => void): WorkerTransport {
    return { async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
      const url = new URL(path, 'https://192.168.1.1'), action = url.pathname.split('/').at(-1)!;
      calls.push({ worker, action, body: structuredClone(body) });
      let result: unknown;
      if (action === 'heartbeat') result = broker.heartbeat(worker, body as RemoteInventory);
      else if (action === 'poll') result = await broker.poll(worker, url.searchParams.get('instance')!);
      else {
        const jobId = url.pathname.split('/').at(-2)!, b = body as { leaseId: string; instanceId: string; event: Parameters<RemoteJobs['event']>[4]; receipt: Parameters<RemoteJobs['finish']>[4] };
        if (action === 'ack') result = broker.ack(worker, jobId, b.leaseId, b.instanceId);
        else if (action === 'started') result = broker.started(worker, jobId, b.leaseId, b.instanceId);
        else if (action === 'events') result = broker.event(worker, jobId, b.leaseId, b.instanceId, b.event);
        else if (action === 'finish') result = await broker.finish(worker, jobId, b.leaseId, b.instanceId, b.receipt);
        else throw new Error('Unexpected request ' + method);
      }
      intercept?.(action, result); return result as T;
    } };
  }
  function fakeExecutor() {
    let starts = 0, cancels = 0; const answers: unknown[] = [];
    let state: WorkerExecutionSnapshot = { state: 'running', progress: 'Working' };
    const executor: WorkerExecutor = { inventory: () => inventory, async start() { starts++; return { id: 'local-task-' + starts, snapshot: () => state, answer: (id, value) => { answers.push({ id, value }); }, async cancel() { cancels++; state = { state: 'cancelled', terminationConfirmed: true }; return { terminationConfirmed: true }; } }; } };
    return { executor, get starts() { return starts; }, get cancels() { return cancels; }, answers, setState(value: WorkerExecutionSnapshot) { state = value; } };
  }
  function enqueue(computerId: string) { return broker.enqueue({ taskId: 'task-' + computerId, attempt: 1, agentId: 'agent', computerId, prompt: 'Run without model inference', capsuleId: 'capsule' }); }
  return { broker, reports, authorized, calls, transport, fakeExecutor, enqueue };
}
const immediate = { heartbeatMs: 0, pollMs: 0, observeMs: 0 };
test('two worker runtimes execute only their targeted jobs and report into authoritative Tasks', async () => {
  const f = fixture(), a = f.fakeExecutor(), b = f.fakeExecutor();
  const ra = new WorkerRuntime(f.transport('pc-a'), a.executor, new Journal(), immediate), rb = new WorkerRuntime(f.transport('pc-b'), b.executor, new Journal(), immediate);
  await ra.tick(); await rb.tick(); const run = f.enqueue('pc-b');
  await ra.tick(); assert.equal(a.starts, 0); await rb.tick(); assert.equal(b.starts, 1);
  assert.equal(f.broker.snapshot(run.runId)?.status, 'running');
  b.setState({ state: 'complete', outcomeComplete: true, text: 'Fake result', summary: 'Authoritative local Task completed' });
  await rb.tick(); assert.equal(f.broker.snapshot(run.runId)?.status, 'complete'); assert.equal(f.reports.length, 1);
  assert.equal(a.starts, 0); assert.equal(b.starts, 1);
});
test('lost ack and started responses never launch the native executor twice', async () => {
  const f = fixture(), a = f.fakeExecutor(); let droppedAck = false, droppedStarted = false;
  const runtime = new WorkerRuntime(f.transport('pc-a', action => {
    if (action === 'ack' && !droppedAck) { droppedAck = true; throw new Error('Lost ack response'); }
    if (action === 'started' && !droppedStarted) { droppedStarted = true; throw new Error('Lost started response'); }
  }), a.executor, new Journal(), immediate);
  await runtime.tick(); f.enqueue('pc-a'); await runtime.tick(); assert.equal(a.starts, 0);
  await runtime.tick(); assert.equal(a.starts, 1); await runtime.tick(); assert.equal(a.starts, 1);
});
test('lost event and finish responses resend identical persisted messages with monotonic sequences', async () => {
  const f = fixture(), a = f.fakeExecutor(); let lostEvent = false, lostFinish = false;
  const journal = new Journal(), runtime = new WorkerRuntime(f.transport('pc-a', action => {
    if (action === 'events' && !lostEvent) { lostEvent = true; throw new Error('Lost event response'); }
    if (action === 'finish' && !lostFinish) { lostFinish = true; throw new Error('Lost finish response'); }
  }), a.executor, journal, immediate);
  await runtime.tick(); const run = f.enqueue('pc-a'); await runtime.tick(); assert.ok(journal.get('worker-active')?.pendingEvent);
  await runtime.tick(); const events = f.calls.filter(c => c.action === 'events'); assert.deepEqual(events[0].body, events[1].body);
  a.setState({ state: 'complete', outcomeComplete: true, text: 'Done' }); await runtime.tick(); assert.ok(journal.get('worker-active')?.pendingReceipt);
  await runtime.tick(); const receipts = f.calls.filter(c => c.action === 'finish'); assert.deepEqual(receipts[0].body, receipts[1].body);
  assert.equal(f.broker.snapshot(run.runId)?.status, 'complete'); assert.equal(f.reports.length, 1); assert.equal(a.starts, 1);
});
test('runtime restart reports unknown and never replays a launching or running execution', async () => {
  const f = fixture(), a = f.fakeExecutor(), journal = new Journal();
  const before = new WorkerRuntime(f.transport('pc-a'), a.executor, journal, { ...immediate, instanceId: 'old-instance' });
  await before.tick(); const run = f.enqueue('pc-a'); await before.tick(); assert.equal(a.starts, 1);
  const after = new WorkerRuntime(f.transport('pc-a'), a.executor, journal, { ...immediate, instanceId: 'new-instance' });
  await after.tick(); assert.equal(a.starts, 1); assert.equal(f.broker.snapshot(run.runId)?.status, 'error');
  assert.match(f.broker.snapshot(run.runId)?.error ?? '', /uncertain/);
});
test('restart retries a pending event before its unknown receipt without a sequence gap', async () => {
  const f = fixture(), a = f.fakeExecutor(), journal = new Journal(); let lost = false;
  const old = new WorkerRuntime(f.transport('pc-a', action => { if (action === 'events' && !lost) { lost = true; throw new Error('Lost response'); } }), a.executor, journal, { ...immediate, instanceId: 'old-instance' });
  await old.tick(); const run = f.enqueue('pc-a'); await old.tick();
  const fresh = new WorkerRuntime(f.transport('pc-a'), a.executor, journal, { ...immediate, instanceId: 'new-instance' });
  await fresh.tick(); assert.equal(journal.get('worker-active')?.phase, 'finished'); assert.equal(a.starts, 1); assert.equal(f.broker.snapshot(run.runId)?.status, 'error');
});
test('provider end without actual complete Task outcome cannot complete controller task', async () => {
  const f = fixture(), a = f.fakeExecutor(), runtime = new WorkerRuntime(f.transport('pc-a'), a.executor, new Journal(), immediate);
  await runtime.tick(); const run = f.enqueue('pc-a'); await runtime.tick();
  a.setState({ state: 'complete', outcomeComplete: false }); await runtime.tick();
  assert.equal(f.broker.snapshot(run.runId)?.status, 'error'); assert.equal(f.reports.length, 0);
});
test('revocation cancels only owned execution and stops the runtime', async () => {
  const f = fixture(), a = f.fakeExecutor(), journal = new Journal(), runtime = new WorkerRuntime(f.transport('pc-a'), a.executor, journal, immediate);
  await runtime.tick(); f.enqueue('pc-a'); await runtime.tick(); f.authorized.delete('pc-a'); await runtime.tick();
  assert.equal(runtime.stopped, true); assert.equal(a.cancels, 1); assert.equal(journal.get('worker-active')?.pendingReceipt?.terminationConfirmed, true);
  await runtime.tick(); assert.equal(a.starts, 1);
});
test('worker credential interaction never forwards its title, description, or fields', async () => {
  const f = fixture(), a = f.fakeExecutor(), runtime = new WorkerRuntime(f.transport('pc-a'), a.executor, new Journal(), immediate);
  await runtime.tick(); const run = f.enqueue('pc-a');
  a.setState({ state: 'running', question: { id: 'credential', revision: 1, localOnly: true, title: 'PRIVATE_TITLE', description: 'PRIVATE_DESCRIPTION', questions: [{ id: 'SECRET_FIELD', question: 'SECRET_PROMPT' }] } });
  await runtime.tick(); const event = f.calls.find(c => c.action === 'events'); assert.ok(event);
  assert.equal(JSON.stringify(event.body).includes('PRIVATE_'), false); assert.equal(JSON.stringify(event.body).includes('SECRET_'), false);
  assert.equal(f.broker.snapshot(run.runId)?.pendingInteractions[0]?.localOnly, true);
});
test('an offer cancelled before acknowledgement is discarded without launching or getting stuck', async () => {
  const f = fixture(), a = f.fakeExecutor(), journal = new Journal(); let cancelOffer = true;
  const runtime = new WorkerRuntime(f.transport('pc-a', (action, value) => {
    const poll = value as { job?: { runId: string } };
    if (action === 'poll' && poll?.job && cancelOffer) { cancelOffer = false; void f.broker.cancel(poll.job.runId); }
  }), a.executor, journal, immediate);
  await runtime.tick(); const run = f.enqueue('pc-a'); await runtime.tick();
  assert.equal(a.starts, 0); assert.equal(f.broker.snapshot(run.runId)?.status, 'cancelled'); assert.equal(journal.get('worker-active')?.phase, 'finished');
  f.enqueue('pc-a'); await runtime.tick(); assert.equal(a.starts, 1);
});

function nativeFixture() {
  const records = new Records(), billing: unknown[] = [], claimed: unknown[] = []; let sequence = 0;
  const provider = { id: 'openai' as const, authenticated: true, authMode: 'subscription', accountLabel: 'own-account', plan: 'own-plan', inferenceAvailable: true, models: [{ id: 'own-model', name: 'Own model', inputModalities: ['text'] }], billing: { mode: 'included', confirmed: true, automaticRouting: true }, modelPreferences: { defaultModel: 'own-model', allowedModels: ['own-model'] } };
  const app: NativeWorkerApp = {
    store: Object.assign(records, { createAgent(input: { name: string }) { return records.put('agent', { id: 'local-agent-' + ++sequence, ...input }); }, createConversation(agentId: string, title: string) { return records.put('conversation', { id: 'conversation-' + ++sequence, agentId, title }); } }),
    runs: { async refresh() {}, providers: () => [provider], attachments: { async createDraft() { return { id: 'attachment' }; }, claimDrafts(scope, ids, messageId) { claimed.push({ scope, ids, messageId }); } }, pendingInteractions: () => [], answerInteraction() {} },
    tasks: { create(input) { return records.put('task', { id: 'local-task-' + ++sequence, ...input, status: 'queued' }); }, get: id => records.get('task', id), async cancel(id) { const task = records.get<NonNullable<ReturnType<NativeWorkerApp['tasks']['get']>>>('task', id)!; return records.put('task', { ...task, status: 'cancelled', recoveryRequired: false }); } },
    appControls: { async billing(id, body) { billing.push({ id, body }); } },
  };
  return { app, records, billing, claimed, provider };
}
test('native executor preserves exact human instruction, owns its workspace and rejects unavailable manual models', async () => {
  const f = nativeFixture(), executor = await createNativeWorkerExecutor(f.app);
  assert.equal(f.billing.length, 0);
  await assert.rejects(executor.start({ instruction: 'Exact instruction', workspaceAlias: 'C:\\controller' }, 'bad-workspace'), /workspace/);
  await assert.rejects(executor.start({ instruction: 'Exact instruction', agentProfile: { id: 'remote-agent', name: 'Remote', routeMode: 'openai', model: 'controller-only-model' } }, 'bad-model'), /unavailable/);
  await executor.start({ instruction: 'Exact instruction\nwith newlines', context: { markdown: 'Separate reference context', references: [] }, agentProfile: { id: 'remote-agent', name: 'Remote', routeMode: 'openai', model: 'own-model' } }, 'native-job');
  const messages = f.records.list<{ content: string; origin: string }>('message');
  assert.equal(messages.length, 1); assert.equal(messages[0].content, 'Exact instruction\nwith newlines'); assert.equal(messages[0].origin, 'human');
  assert.match(f.records.list<{ text: string }>('remote-worker-context')[0].text, /Separate reference context/);
  assert.equal(f.records.list<{ workspace: string }>('agent').some(a => a.workspace === 'C:\\controller'), false);
});
test('subscription approval requires the explicit flag and an included authenticated subscription', async () => {
  const f = nativeFixture(); await createNativeWorkerExecutor(f.app, { subscriptionOnly: true }); assert.equal(f.billing.length, 1);
  assert.deepEqual(f.billing[0], { id: 'openai', body: { mode: 'included', confirmed: true, automaticRouting: true, allowanceNote: 'Worker subscription-only use', expectedAccount: { accountLabel: 'own-account', plan: 'own-plan' } } });
  const g = nativeFixture(); g.provider.authMode = 'api-key'; g.provider.billing.mode = 'metered'; await createNativeWorkerExecutor(g.app, { subscriptionOnly: true }); assert.equal(g.billing.length, 0);
});
