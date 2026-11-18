import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { Tasks } from '../server/tasks.js';
import { TypeSafeIntegration } from '../server/typesafe.js';
import { Dispatcher, type DispatcherHooks, type DispatcherCandidate } from '../server/dispatcher.js';
import type { Task, TaskRunSnapshot } from '../shared/tasks.js';
import type { Run } from '../shared/types.js';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'relay-dispatcher-'));
  const store = new Store(dir);
  const agent = store.createAgent({ name: 'Builder', role: 'Build software' });
  const cancelled: string[] = [], snapshots = new Map<string, TaskRunSnapshot>();
  const finishRun = (runId: string, status: Run['status'], error: string | null = null) => { snapshots.set(runId, { status, error }); const run = store.get<Run>('run', runId); if (run) store.put('run', { ...run, status, error, endedAt: new Date().toISOString() }); };
  let cancelHook = async (runId: string) => { const run = store.get<Run>('run', runId); finishRun(runId, run && !['running', 'routing'].includes(run.status) ? run.status : 'cancelled', run?.error); };
  const tasks = new Tasks(store, { start: async () => { throw Error('not used'); }, snapshot: runId => snapshots.get(runId), cancel: async runId => { cancelled.push(runId); await cancelHook(runId); } });
  let roster: DispatcherCandidate[] = [{ agentId: agent.id, name: agent.name, role: agent.role, revision: 'v1', capabilities: ['tasks'] }];
  const hooks: DispatcherHooks = { candidates: async () => roster, revalidate: candidate => roster.some(c => c.agentId === candidate.agentId && c.revision === candidate.revision), enabled: () => false };
  const dispatcher = new Dispatcher(store, tasks, hooks);
  return { store, tasks, hooks, dispatcher, agent, cancelled, snapshots, finishRun, onCancel(fn: (runId: string) => Promise<void>) { cancelHook = fn; }, setRoster: (value: DispatcherCandidate[]) => { roster = value; }, async close() { dispatcher.close(); await tasks.close(); store.close(); await rm(dir, { recursive: true, force: true }); } };
}
const signal = () => new AbortController().signal;
function fixtureRun(f: Awaited<ReturnType<typeof fixture>>, task: Task, runId: string, status: Run['status'] = 'running'): Task {
  const conversation = f.store.createConversation(task.agentId);
  const working = f.store.put<Task>('task', { ...task, status: 'working', attempt: task.attempt || 1, conversationId: conversation.id, runId, runIds: [...task.runIds, runId] });
  f.store.put<Run>('run', { id: runId, agentId: task.agentId, conversationId: conversation.id, messageId: 'message-' + runId, status, route: null, error: null, startedAt: new Date().toISOString(), endedAt: null, usage: null });
  return working;
}
test('receipt targets follow current delegated descendants after the lead turn ends and clear on cancellation', async () => {
  const f = await fixture();
  try {
    const accepted = await f.dispatcher.submit({ submissionId: 'tree', prompt: 'Private parent request' }, signal()); assert.equal(accepted.state, 'accepted'); if (accepted.state !== 'accepted') return;
    const parent = fixtureRun(f, f.tasks.get(accepted.receipt.taskId), 'lead-ended', 'complete');
    const worker = f.store.createAgent({ name: 'Worker' }), reviewer = f.store.createAgent({ name: 'Reviewer' });
    const child = fixtureRun(f, f.tasks.delegate(parent.id, worker.id, 'Private child request'), 'child-current');
    const grandchild = fixtureRun(f, f.tasks.delegate(child.id, reviewer.id, 'Private grandchild request'), 'grandchild-current', 'routing');
    const targets = [{ taskId: child.id, agentId: worker.id, runId: child.runId! }, { taskId: grandchild.id, agentId: reviewer.id, runId: grandchild.runId! }];
    const receipt = f.dispatcher.status([parent.id])[0]; assert.deepEqual(receipt.interactionTargets, targets); assert.equal(receipt.runId, 'lead-ended'); assert.equal(receipt.conversationId, parent.conversationId);
    const next = { ...f.store.get<Run>('run', child.runId!)!, id: 'child-next' }; f.store.put('run', next);
    f.store.put<Task>('task', { ...f.tasks.get(child.id), runId: next.id, runIds: [...child.runIds, next.id], attempt: child.attempt + 1 });
    assert.deepEqual(f.dispatcher.status([parent.id])[0].interactionTargets, [{ taskId: child.id, agentId: worker.id, runId: next.id }]); // Old-attempt grandchild and old still-running child Run disappear.
    assert.doesNotMatch(JSON.stringify(f.dispatcher.status([parent.id])), /Private parent|Private child|Private grandchild|title|prompt|result/);
    await f.dispatcher.cancel(parent.id); assert.deepEqual(f.dispatcher.status([parent.id])[0].interactionTargets, []);
  } finally { await f.close(); }
});
test('receipt targets reject foreign ancestry, ownership, old attempts, recovery holds and malformed cycles', async () => {
  const f = await fixture();
  try {
    const accepted = await f.dispatcher.submit({ submissionId: 'invalid-tree', prompt: 'Parent' }, signal()); if (accepted.state !== 'accepted') throw Error('not accepted');
    const parent = fixtureRun(f, f.tasks.get(accepted.receipt.taskId), 'lead-done', 'complete'), worker = f.store.createAgent({ name: 'Worker' });
    const valid = fixtureRun(f, f.tasks.delegate(parent.id, worker.id, 'Valid'), 'valid');
    const foreign = fixtureRun(f, f.tasks.create({ agentId: worker.id, title: 'Foreign', prompt: 'Foreign' }), 'foreign');
    const makeChild = (name: string) => fixtureRun(f, f.tasks.delegate(parent.id, worker.id, name), name);
    const wrongParent = makeChild('wrong-parent'); f.store.put('task', { ...wrongParent, parentTaskId: foreign.id });
    const oldAttempt = makeChild('old-attempt'); f.store.put('task', { ...oldAttempt, parentAttempt: parent.attempt - 1 });
    const wrongAgent = makeChild('wrong-agent'); f.store.put('run', { ...f.store.get<Run>('run', wrongAgent.runId!)!, agentId: f.agent.id });
    const wrongConversation = makeChild('wrong-conversation'); f.store.put('run', { ...f.store.get<Run>('run', wrongConversation.runId!)!, conversationId: parent.conversationId });
    const recovery = makeChild('recovery'); f.store.put('task', { ...recovery, recoveryRequired: true });
    const excluded = makeChild('excluded'); f.store.put('inference-quarantine', { id: 'fixture-hold', runId: excluded.runId });
    const obsolete = makeChild('obsolete'); f.store.put('run', { ...f.store.get<Run>('run', obsolete.runId!)!, status: 'complete' });
    const cancelled = makeChild('cancelled'); f.store.put('task', { ...cancelled, status: 'cancelled' });
    f.store.put('task', { ...f.tasks.get(parent.id), childTaskIds: [...f.tasks.get(parent.id).childTaskIds, foreign.id, valid.id] });
    f.store.put('task', { ...valid, childTaskIds: [parent.id] }); // Invalid back-edge and duplicate references must not gain authority.
    assert.deepEqual(f.dispatcher.status([parent.id])[0].interactionTargets, [{ taskId: valid.id, agentId: worker.id, runId: valid.runId! }]);
    f.store.put('task', { ...f.tasks.get(parent.id), parentTaskId: valid.id, parentAttempt: valid.attempt }); // A mutually matching root cycle fails closed for all descendant authority.
    assert.deepEqual(f.dispatcher.status([parent.id])[0].interactionTargets, []);
    f.store.put('task', { ...f.tasks.get(parent.id), recoveryRequired: true }); assert.deepEqual(f.dispatcher.status([parent.id])[0].interactionTargets, []);
  } finally { await f.close(); }
});
test('terminal lead and intermediate tasks retain current queued or live descendant work and cancellation', async () => {
  const f = await fixture();
  try {
    const accepted = await f.dispatcher.submit({ submissionId: 'terminal-tree', prompt: 'Parent' }, signal()); if (accepted.state !== 'accepted') throw Error('not accepted');
    const parent = fixtureRun(f, f.tasks.get(accepted.receipt.taskId), 'terminal-lead', 'failed'), worker = f.store.createAgent({ name: 'Worker' }), reviewer = f.store.createAgent({ name: 'Reviewer' });
    const child = fixtureRun(f, f.tasks.delegate(parent.id, worker.id, 'Child'), 'terminal-intermediate', 'failed');
    const grandchild = f.tasks.delegate(child.id, reviewer.id, 'Queued grandchild');
    const queued = f.tasks.delegate(parent.id, worker.id, 'Queued child'), scheduled = f.tasks.create({ agentId: worker.id, parentTaskId: parent.id, title: 'Later', prompt: 'Scheduled child', dueAt: new Date(Date.now() + 60000).toISOString() }, { actorAgentId: parent.agentId });
    f.store.put('task', { ...f.tasks.get(parent.id), status: 'failed' }); f.store.put('task', { ...child, childTaskIds: [grandchild.id], status: 'failed' });
    let receipt = f.dispatcher.status([parent.id])[0]; assert.equal(receipt.status, 'failed'); assert.equal(receipt.activeWork, true); assert.deepEqual(receipt.interactionTargets, []);
    fixtureRun(f, grandchild, 'live-grandchild'); receipt = f.dispatcher.status([parent.id])[0];
    assert.deepEqual(receipt.interactionTargets, [{ taskId: grandchild.id, agentId: reviewer.id, runId: 'live-grandchild' }]);
    const stopped = await f.dispatcher.cancel(parent.id); assert.equal(stopped.status, 'failed'); assert.equal(stopped.activeWork, false); assert.deepEqual(stopped.interactionTargets, []);
    assert.deepEqual(f.cancelled, ['live-grandchild']); assert.equal(f.tasks.get(child.id).status, 'failed');
    assert.equal(f.tasks.get(queued.id).status, 'cancelled'); assert.equal(f.tasks.get(scheduled.id).status, 'cancelled');
  } finally { await f.close(); }
});
test('scoped cancellation never follows unrelated, stale-attempt or cyclic child links', async () => {
  const f = await fixture();
  try {
    const accepted = await f.dispatcher.submit({ submissionId: 'safe-cancel', prompt: 'Parent' }, signal()); if (accepted.state !== 'accepted') throw Error('not accepted');
    const parent = fixtureRun(f, f.tasks.get(accepted.receipt.taskId), 'safe-lead'), worker = f.store.createAgent({ name: 'Worker' });
    const valid = fixtureRun(f, f.tasks.delegate(parent.id, worker.id, 'Valid'), 'safe-child');
    const stale = fixtureRun(f, f.tasks.delegate(parent.id, worker.id, 'Stale'), 'stale-child'); f.store.put('task', { ...stale, parentAttempt: parent.attempt - 1 });
    const foreign = fixtureRun(f, f.tasks.create({ agentId: worker.id, title: 'Foreign', prompt: 'Foreign' }), 'foreign-child');
    f.store.put('task', { ...f.tasks.get(parent.id), childTaskIds: [...f.tasks.get(parent.id).childTaskIds, foreign.id] });
    f.store.put('task', { ...valid, childTaskIds: [parent.id] });
    const stopped = await f.dispatcher.cancel(parent.id); assert.equal(stopped.activeWork, false);
    assert.deepEqual(new Set(f.cancelled), new Set(['safe-child', 'safe-lead'])); assert.equal(f.tasks.get(stale.id).status, 'working'); assert.equal(f.tasks.get(foreign.id).status, 'working');
  } finally { await f.close(); }
});
test('unknown descendant stops aggregate recovery attention without reviving a failed lead or clearing holds', async () => {
  const f = await fixture();
  try {
    const accepted = await f.dispatcher.submit({ submissionId: 'unknown-tree-stop', prompt: 'Parent' }, signal()); if (accepted.state !== 'accepted') throw Error('not accepted');
    const parent = fixtureRun(f, f.tasks.get(accepted.receipt.taskId), 'failed-stop-lead', 'failed'), worker = f.store.createAgent({ name: 'Worker' });
    const child = fixtureRun(f, f.tasks.delegate(parent.id, worker.id, 'Child'), 'unknown-child'); f.store.put('task', { ...f.tasks.get(parent.id), status: 'failed' });
    f.store.put('inference-quarantine', { id: 'unknown-hold', runId: child.runId });
    f.onCancel(async runId => { f.finishRun(runId, 'interrupted', 'Termination unknown'); });
    await assert.rejects(f.dispatcher.cancel(parent.id), { status: 409 });
    const receipt = f.dispatcher.status([parent.id])[0]; assert.equal(receipt.status, 'failed'); assert.equal(receipt.recoveryRequired, true); assert.equal(receipt.activeWork, true); assert.deepEqual(receipt.interactionTargets, []);
    assert.equal(f.tasks.get(parent.id).recoveryRequired, false); assert.equal(f.tasks.get(child.id).recoveryRequired, true); assert.ok(f.store.get('inference-quarantine', 'unknown-hold'));
  } finally { await f.close(); }
});
test('scoped cancellation does not stop a foreign run and does not claim that invalid remaining work stopped', async () => {
  const f = await fixture();
  try {
    const accepted = await f.dispatcher.submit({ submissionId: 'foreign-run-stop', prompt: 'Parent' }, signal()); if (accepted.state !== 'accepted') throw Error('not accepted');
    const parent = fixtureRun(f, f.tasks.get(accepted.receipt.taskId), 'own-lead'), worker = f.store.createAgent({ name: 'Worker' });
    const child = fixtureRun(f, f.tasks.delegate(parent.id, worker.id, 'Child'), 'foreign-owned-run');
    f.store.put('run', { ...f.store.get<Run>('run', child.runId!)!, agentId: f.agent.id });
    await assert.rejects(f.dispatcher.cancel(parent.id), { status: 409 }); assert.deepEqual(f.cancelled, ['own-lead']); assert.equal(f.tasks.get(child.id).status, 'working'); assert.equal(f.dispatcher.status([parent.id])[0].activeWork, true);
  } finally { await f.close(); }
});
test('scoped cancellation revalidates descendant attempts after awaited stops', async () => {
  const f = await fixture(); let release!: () => void, stopping!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), began = new Promise<void>(resolve => { stopping = resolve; });
  try {
    const accepted = await f.dispatcher.submit({ submissionId: 'cancel-race', prompt: 'Parent' }, signal()); if (accepted.state !== 'accepted') throw Error('not accepted');
    const parent = fixtureRun(f, f.tasks.get(accepted.receipt.taskId), 'race-lead'), worker = f.store.createAgent({ name: 'Worker' }), reviewer = f.store.createAgent({ name: 'Reviewer' });
    const child = fixtureRun(f, f.tasks.delegate(parent.id, worker.id, 'Child'), 'race-intermediate', 'failed'), grandchild = fixtureRun(f, f.tasks.delegate(child.id, reviewer.id, 'Grandchild'), 'race-old');
    f.store.put('task', { ...f.tasks.get(child.id), status: 'failed' });
    f.onCancel(async runId => { if (runId === 'race-lead') { stopping(); await gate; } f.finishRun(runId, 'cancelled'); });
    const cancellation = f.dispatcher.cancel(parent.id); await began;
    const run = { ...f.store.get<Run>('run', grandchild.runId!)!, id: 'race-new' }; f.store.put('run', run);
    f.store.put('task', { ...grandchild, attempt: grandchild.attempt + 1, runId: run.id, runIds: [...grandchild.runIds, run.id] }); release();
    await assert.rejects(cancellation, { status: 409 }); assert.deepEqual(f.cancelled, ['race-lead']); assert.equal(f.tasks.get(grandchild.id).status, 'working'); assert.equal(f.dispatcher.status([parent.id])[0].activeWork, true);
  } finally { release(); await f.close(); }
});
test('concurrent stops join the native stop and share unknown termination instead of acknowledging early', async () => {
  const f = await fixture(); let release!: () => void, stopping!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), began = new Promise<void>(resolve => { stopping = resolve; });
  try {
    const accepted = await f.dispatcher.submit({ submissionId: 'concurrent-stop', prompt: 'Parent' }, signal()); if (accepted.state !== 'accepted') throw Error('not accepted');
    const task = fixtureRun(f, f.tasks.get(accepted.receipt.taskId), 'concurrent-native-stop');
    f.onCancel(async runId => { stopping(); await gate; f.finishRun(runId, 'interrupted', 'Native stop unknown'); });
    const first = f.dispatcher.cancel(task.id); await began; const second = f.dispatcher.cancel(task.id); assert.strictEqual(first, second);
    assert.equal(f.tasks.get(task.id).status, 'cancelled'); assert.equal(f.dispatcher.status([task.id])[0].activeWork, true); assert.deepEqual(f.cancelled, [task.runId]);
    const settled = Promise.allSettled([first, second]); release();
    for (const result of await settled) { assert.equal(result.status, 'rejected'); if (result.status === 'rejected') assert.equal(result.reason.status, 409); }
    const receipt = f.dispatcher.status([task.id])[0]; assert.equal(receipt.recoveryRequired, true); assert.equal(receipt.activeWork, true);
  } finally { release(); await f.close(); }
});
for (const unknown of [false, true]) test('ordinary Task stop keeps dispatcher work active until its ' + (unknown ? 'unknown' : 'confirmed') + ' native outcome settles', async () => {
  const f = await fixture(); let release!: () => void, stopping!: () => void, ordinaryResult: Promise<PromiseSettledResult<Task>> | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; }), began = new Promise<void>(resolve => { stopping = resolve; });
  try {
    const accepted = await f.dispatcher.submit({ submissionId: unknown ? 'ordinary-unknown-stop' : 'ordinary-confirmed-stop', prompt: 'Parent' }, signal()); if (accepted.state !== 'accepted') throw Error('not accepted');
    const task = fixtureRun(f, f.tasks.get(accepted.receipt.taskId), 'ordinary-native-stop');
    f.onCancel(async runId => { stopping(); await gate; f.finishRun(runId, unknown ? 'interrupted' : 'cancelled', unknown ? 'Native stop unknown' : null); });
    ordinaryResult = f.tasks.cancel(task.id).then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason })); await began;
    assert.equal(f.tasks.get(task.id).status, 'cancelled'); assert.equal(f.store.get<Run>('run', task.runId!)?.status, 'running');
    assert.equal(f.dispatcher.status([task.id])[0].activeWork, true); assert.equal(f.dispatcher.status([task.id])[0].recoveryRequired, false);
    await assert.rejects(f.dispatcher.cancel(task.id), { status: 409 }); assert.deepEqual(f.cancelled, [task.runId]);
    release(); const settled = await ordinaryResult; assert.equal(settled.status, unknown ? 'rejected' : 'fulfilled');
    if (settled.status === 'rejected') assert.equal(settled.reason.status, 409);
    const receipt = f.dispatcher.status([task.id])[0]; assert.equal(receipt.activeWork, unknown); assert.equal(receipt.recoveryRequired, unknown);
    if (unknown) await assert.rejects(f.dispatcher.cancel(task.id), { status: 409 }); else assert.equal((await f.dispatcher.cancel(task.id)).activeWork, false);
  } finally { release(); await ordinaryResult; await f.close(); }
});
async function realSelectorFixture(size: number) {
  const f = await fixture(); let hookCalls = 0, fetchCalls = 0;
  const roster: DispatcherCandidate[] = Array.from({ length: size }, (_, index) => ({ agentId: index === 0 ? f.agent.id : 'candidate-' + index, name: 'Candidate ' + index, role: 'Build', revision: 'v1', capabilities: [] }));
  f.setRoster(roster);
  f.store.put('integration', { id: 'typesafe', enabled: true, model: 'jev-fixture', models: [{ name: 'jev-fixture', description: 'Fixture' }], validatedAt: null });
  const selector = new TypeSafeIntegration(f.store, { availability: () => ({ available: true, protection: 'fixture' }), has: async () => true, get: async () => 'synthetic-boundary-key', set: async () => {}, remove: async () => {}, close: () => {} }, {
    fetch: (async (_url, init) => {
      fetchCalls++; const body = JSON.parse(String(init?.body)), labels = Object.keys(body.questions.recipient.criteria);
      return Response.json({ model: 'jev-fixture', answers: { fit: { type: 'noul', noul: .1 }, recipient: { type: 'choice', choice: labels[0], confidence: 1, probabilities: Object.fromEntries(labels.map((label, index) => [label, index === 0 ? 1 : 0])) } }, usage: { input_tokens: 10, output_tokens: 2 } });
    }) as typeof fetch,
  });
  await selector.initialize();
  f.hooks.enabled = () => selector.status().enabled;
  f.hooks.decide = (scope, value) => { hookCalls++; return selector.decide(scope, value); };
  return { ...f, roster, hookCalls: () => hookCalls, fetchCalls: () => fetchCalls, async close() { await selector.close(); await f.close(); } };
}
for (const size of [100, 101, 255]) test('actual TypeSafe state limit handles a ' + size + '-candidate roster without truncation', async () => {
  const f = await realSelectorFixture(size);
  try {
    const result = await f.dispatcher.submit({ submissionId: 'boundary-' + size, prompt: 'Unrelated request' }, signal());
    assert.equal(result.state, 'needs-recipient'); if (result.state !== 'needs-recipient') return;
    assert.deepEqual(result.candidates.map(candidate => candidate.agentId), f.roster.map(candidate => candidate.agentId));
    assert.equal(f.hookCalls(), size === 100 ? 1 : 0); assert.equal(f.fetchCalls(), size === 100 ? 1 : 0);
    assert.equal(f.store.list('dispatcher-selection').length, size === 100 ? 1 : 0); assert.equal(f.tasks.list().length, 0);
  } finally { await f.close(); }
});
test('explicit recipients remain available above the actual selector state capacity without Jev calls', async () => {
  const f = await realSelectorFixture(255);
  try {
    for (const size of [101, 255]) {
      f.setRoster(f.roster.slice(0, size));
      const result = await f.dispatcher.submit({ submissionId: 'explicit-' + size, prompt: 'Build a fixture', agentId: f.agent.id }, signal());
      assert.equal(result.state, 'accepted'); if (result.state === 'accepted') { assert.equal(result.receipt.selectionSource, 'explicit'); assert.equal(result.receipt.agentId, f.agent.id); }
    }
    assert.equal(f.hookCalls(), 0); assert.equal(f.fetchCalls(), 0); assert.equal(f.store.list('dispatcher-selection').length, 0); assert.equal(f.tasks.list().length, 2);
  } finally { await f.close(); }
});
test('same-key concurrent submissions select once and accepted retries cannot reroute', async () => {
  const f = await fixture(); let calls = 0, release!: () => void;
  f.hooks.candidates = async () => { calls++; await new Promise<void>(r => { release = r; }); return [{ agentId: f.agent.id, name: 'Builder', role: 'Build', revision: 'v1', capabilities: [] }]; };
  try {
    const input = { submissionId: 'concurrent-1', prompt: 'Build a fixture' };
    const first = f.dispatcher.submit(input, signal()); const second = f.dispatcher.submit(input, signal());
    await new Promise(r => setImmediate(r)); assert.equal(calls, 1); assert.equal(f.dispatcher.lookup(input.submissionId).state, 'pending');
    await assert.rejects(f.dispatcher.submit({ ...input, prompt: 'Conflicting during selection' }, signal()), { status: 409 }); release();
    const a = await first, b = await second; assert.deepEqual(a, b); assert.equal(a.state, 'accepted'); assert.equal(f.tasks.list().length, 1);
    f.hooks.candidates = async () => { throw Error('must not select on response loss retry'); };
    assert.deepEqual(await f.dispatcher.submit(input, signal()), a);
    await assert.rejects(f.dispatcher.submit({ ...input, prompt: 'Different input' }, signal()), { status: 409 });
    assert.equal(f.dispatcher.lookup(input.submissionId).state, 'accepted');
  } finally { await f.close(); }
});
test('aborted selection, stale identity and failed decisions cannot accept or replay', async () => {
  const f = await fixture(); let release!: () => void;
  f.hooks.candidates = async () => { await new Promise<void>(r => { release = r; }); return [{ agentId: f.agent.id, name: 'Builder', role: 'Build', revision: 'v1', capabilities: [] }]; };
  try {
    const controller = new AbortController(), input = { submissionId: 'abort-1', prompt: 'Private fixture' };
    const pending = f.dispatcher.submit(input, controller.signal); await new Promise(r => setImmediate(r)); controller.abort(); release();
    await assert.rejects(pending); assert.equal(f.tasks.list().length, 0); assert.equal(f.dispatcher.lookup(input.submissionId).state, 'unconfirmed');
    await assert.rejects(f.dispatcher.submit(input, signal()), { status: 409 });
    f.hooks.candidates = async () => [{ agentId: f.agent.id, name: 'Builder', role: 'Build', revision: 'old', capabilities: [] }];
    const stale = await f.dispatcher.submit({ submissionId: 'stale-1', prompt: 'Build' }, signal()); assert.equal(stale.state, 'needs-recipient'); assert.equal(f.tasks.list().length, 0);
  } finally { await f.close(); }
});
test('zero, ambiguous and oversized rosters require explicit choice; one eligible bot uses local', async () => {
  const f = await fixture();
  try {
    f.setRoster([]); assert.equal((await f.dispatcher.submit({ submissionId: 'zero', prompt: 'Work' }, signal())).state, 'needs-recipient');
    const candidate = { agentId: f.agent.id, name: 'Builder', role: 'Build', revision: 'v1', capabilities: [] };
    f.setRoster([candidate, { ...candidate, agentId: 'other' }]); assert.equal((await f.dispatcher.submit({ submissionId: 'many', prompt: 'Work' }, signal())).state, 'needs-recipient');
    f.setRoster(Array.from({ length: 256 }, (_, i) => ({ ...candidate, agentId: String(i) }))); f.hooks.enabled = () => true;
    f.hooks.decide = async () => { throw Error('oversized selector must not run'); };
    assert.equal((await f.dispatcher.submit({ submissionId: 'oversized', prompt: 'Work' }, signal())).state, 'needs-recipient');
    f.setRoster([candidate]); f.hooks.enabled = () => false;
    const one = await f.dispatcher.submit({ submissionId: 'one', prompt: 'Exact canonical request' }, signal()); assert.equal(one.state, 'accepted');
    if (one.state === 'accepted') { assert.equal(one.receipt.selectionSource, 'local'); assert.equal(f.tasks.get(one.receipt.taskId).prompt, 'Exact canonical request'); }
  } finally { await f.close(); }
});
test('Jev uses fit plus bounded choice and does not serialize private selector data', async () => {
  const f = await fixture();
  const other = f.store.createAgent({ name: 'Researcher', role: 'Research' });
  f.setRoster([{ agentId: f.agent.id, name: 'Builder', role: 'Build', revision: 'v1', capabilities: ['tasks'] }, { agentId: other.id, name: 'Researcher', role: 'Research', revision: 'v1', capabilities: [] }]);
  f.hooks.enabled = () => true; let seen = '';
  f.hooks.decide = async (_scope, value) => { seen = JSON.stringify(value); return { model: 'fixture', answers: { fit: { type: 'noul', noul: .9 }, recipient: { type: 'choice', choice: 'Builder', confidence: 1, probabilities: { Builder: 1, Researcher: 0 } } }, usage: { inputTokens: 1, outputTokens: 1 } }; };
  try {
    const result = await f.dispatcher.submit({ submissionId: 'jev', prompt: 'Build private fixture' }, signal()); assert.equal(result.state, 'accepted'); assert.match(seen, /Build private fixture/); assert.doesNotMatch(seen, /revision/);
    assert.doesNotMatch(JSON.stringify(f.store.list('dispatcher-submission')), /Build private fixture|Researcher|probabilities/);
    assert.deepEqual(f.store.get('dispatcher-selection', 'jev'), { id: 'jev', submissionId: 'jev', source: 'jev', configuredModel: null, inputCharacters: seen.length, inputBytes: Buffer.byteLength(seen), state: 'returned', reportedUsage: { inputTokens: 1, outputTokens: 1 } });
    assert.doesNotMatch(JSON.stringify(f.store.list('dispatcher-selection')), /Build private fixture|Researcher|probabilities|Build software/);
    f.hooks.decide = async () => { throw Error('Build private fixture echoed in upstream failure'); };
    await assert.rejects(f.dispatcher.submit({ submissionId: 'failed', prompt: 'Build private fixture' }, signal()), error => !String(error).includes('Build private fixture'));
    assert.equal(f.store.get<{ reportedUsage: unknown }>('dispatcher-selection', 'failed')?.reportedUsage, null);
    f.hooks.decide = async () => ({ model: 'fixture', answers: { fit: { type: 'noul', noul: .1 }, recipient: { type: 'choice', choice: 'Builder', confidence: 1, probabilities: { Builder: 1, Researcher: 0 } } }, usage: { inputTokens: 1, outputTokens: 1 } });
    assert.equal((await f.dispatcher.submit({ submissionId: 'no-fit', prompt: 'Unrelated' }, signal())).state, 'needs-recipient');
  } finally { await f.close(); }
});
test('restart pending metadata is unconfirmed and status/cancel project only bound tasks', async () => {
  const f = await fixture();
  try {
    f.store.put('dispatcher-submission', { id: 'interrupted', hash: 'opaque', state: 'pending' });
    const restarted = new Dispatcher(f.store, f.tasks, f.hooks); assert.equal(restarted.lookup('interrupted').state, 'unconfirmed');
    const result = await restarted.submit({ submissionId: 'bound', prompt: 'Do work', agentId: f.agent.id }, signal()); assert.equal(result.state, 'accepted');
    const ordinary = f.tasks.create({ agentId: f.agent.id, title: 'Ordinary', prompt: 'Private' });
    assert.deepEqual(restarted.status([ordinary.id]), []); await assert.rejects(restarted.cancel(ordinary.id), { status: 404 });
    if (result.state === 'accepted') { const receipt = await restarted.cancel(result.receipt.taskId); assert.equal(receipt.status, 'cancelled'); assert.doesNotMatch(JSON.stringify(receipt), /Do work|prompt|title|result|error/); }
    restarted.close();
  } finally { await f.close(); }
});
test('normal credential redaction precedes selector/task storage while hashes preserve exact submission identity', async () => {
  const f = await fixture(), secret = 'synthetic-managed-sentinel';
  f.hooks.redact = text => text.replaceAll(secret, '[redacted]'); f.hooks.enabled = () => true;
  let seen = '';
  f.hooks.decide = async (_scope, value) => { seen = JSON.stringify(value); assert.deepEqual(Object.keys(value.questions), ['fit']); return { model: 'fixture', answers: { fit: { type: 'noul', noul: .9 } }, usage: { inputTokens: 1, outputTokens: 1 } }; };
  try {
    const input = { submissionId: 'redact', prompt: 'Inspect ' + secret };
    const result = await f.dispatcher.submit(input, signal()); assert.equal(result.state, 'accepted'); if (result.state !== 'accepted') return;
    assert.equal(f.tasks.get(result.receipt.taskId).prompt, 'Inspect [redacted]'); assert.ok(!seen.includes(secret));
    assert.ok(!JSON.stringify(f.store.list('dispatcher-submission')).includes(secret));
    assert.equal((await f.dispatcher.submit(input, signal())).state, 'accepted');
    await assert.rejects(f.dispatcher.submit({ ...input, prompt: 'Inspect [redacted]' }, signal()), { status: 409 });
  } finally { await f.close(); }
});
test('configuration changes and malformed decisions fail without interpreting them as recipient answers', async () => {
  const f = await fixture(); let enabled = true; f.hooks.enabled = () => enabled;
  f.hooks.decide = async () => { enabled = false; return { model: 'fixture', answers: { fit: { type: 'noul', noul: .9 } }, usage: { inputTokens: 1, outputTokens: 1 } }; };
  try {
    await assert.rejects(f.dispatcher.submit({ submissionId: 'changed-config', prompt: 'Build' }, signal()), { status: 503 }); assert.equal(f.tasks.list().length, 0);
    enabled = true; f.hooks.decide = async () => ({ model: 'fixture', answers: { fit: { type: 'noul', noul: Number.NaN } }, usage: { inputTokens: 1, outputTokens: 1 } });
    await assert.rejects(f.dispatcher.submit({ submissionId: 'bad-fit', prompt: 'Build' }, signal()), { status: 503 }); assert.equal(f.tasks.list().length, 0);
  } finally { await f.close(); }
});
test('aborted or closed Jev selection retains unknown usage rather than inventing free inference', async () => {
  const f = await fixture(); f.hooks.enabled = () => true; f.hooks.selectorModel = () => 'jev-fixture';
  let started!: () => void;
  f.hooks.decide = async scope => { started(); return await new Promise((_resolve, reject) => { scope.signal.addEventListener('abort', () => reject(Error('Untrusted upstream detail')), { once: true }); }); };
  try {
    for (const action of ['abort', 'close']) {
      const beginning = new Promise<void>(resolve => { started = resolve; }), controller = new AbortController();
      const pending = f.dispatcher.submit({ submissionId: 'selection-' + action, prompt: 'Private fixture' }, controller.signal);
      await beginning; if (action === 'abort') controller.abort(); else f.dispatcher.close(); await assert.rejects(pending, { status: 409 });
      const observation = f.store.get<{ state: string; reportedUsage: unknown; configuredModel: string }>('dispatcher-selection', 'selection-' + action)!;
      assert.equal(observation.state, 'cancelled'); assert.equal(observation.reportedUsage, null); assert.equal(observation.configuredModel, 'jev-fixture');
      assert.doesNotMatch(JSON.stringify(observation), /Private fixture|Untrusted upstream/);
    }
    assert.equal(f.tasks.list().length, 0);
  } finally { await f.close(); }
});
