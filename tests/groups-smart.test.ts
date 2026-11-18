import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store, id, now, PROVIDER_IDS} from '../server/store.js';
import {Runs} from '../server/runs.js';
import {Groups} from '../server/groups.js';
import {replyToRun} from '../server/conversation-control.js';
import {contextWireCharacters} from '../server/context-wire.js';
import {InferenceScheduler, scheduleAdapters} from '../server/scheduler.js';
import type {Agent, GroupEvent, GroupMessage, GroupRun, ProviderAdapter, ProviderId, ProviderRequest} from '../shared/types.js';

type Handler = ProviderAdapter['stream'];
const gate = () => {let resolve!: () => void; const promise = new Promise<void>(done => {resolve = done;}); return {promise, resolve};};
async function fixture(handler: Handler) {
  const dir = await mkdtemp(join(tmpdir(), 'relay-smart-groups-')), store = new Store(dir);
  const adapters = Object.fromEntries(PROVIDER_IDS.map(provider => [provider, {id: provider, inspect: async () => ({id: provider, installed: true, authenticated: true, authMode: 'subscription', accountLabel: 'Fixture', plan: 'Included', models: [{id: 'm', name: 'Fixture model', verified: false}]}), login: async () => ({message: 'Fixture'}), close: async () => {}, stream: handler}])) as unknown as Record<ProviderId, ProviderAdapter>;
  for (const provider of PROVIDER_IDS) {store.saveBilling(provider, {mode: 'included', confirmed: true, automaticRouting: true, allowanceNote: ''}); store.saveModelPreferences(provider, {defaultModel: 'm', allowedModels: ['m']});}
  const runs = new Runs(store, adapters); await runs.refresh();
  const agents = store.list<Agent>('agent').slice(0, 3).map((agent, i) => store.put<Agent>('agent', {...agent, routeMode: 'openai', model: 'm', instructions: 'PRIVATE_PERSPECTIVE_' + i, memory: 'PRIVATE_MEMORY_' + i}));
  const groups = new Groups(store, runs), room = groups.create(agents.map(agent => agent.id));
  return {dir, store, runs, agents, groups, room, async close() {await groups.close(); await runs.close(); store.close(); await rm(dir, {recursive: true, force: true});}};
}
function input(request: ProviderRequest) {
  const manifest = JSON.parse(request.history[0].content) as {transcript: {id: string; agentId: string | null; contentIndex: number}[]; contextWindowed: boolean};
  return {...manifest, transcript: manifest.transcript.map(entry => ({...entry, content: request.history[entry.contentIndex].content}))};
}
async function settled(f: Awaited<ReturnType<typeof fixture>>, runId: string) {await f.groups.active.get(runId)?.promise; return f.store.get<GroupRun>('group-run', runId)!;}
function choice(speakerId: string | null, focus = '') {return JSON.stringify({speakerId, reason: speakerId ? 'A concrete unanswered tradeoff needs this perspective.' : 'The tradeoff is resolved.', focus});}

test('smart moderation targets a useful contribution and ends with a visible attributed outcome', async () => {
  const requests: ProviderRequest[] = []; let peer = '', decisions = 0;
  const f = await fixture(async request => {requests.push(request); if (request.runId.startsWith('group-moderator-')) return {text: choice(decisions++ === 0 ? peer : null, decisions === 1 ? 'Assess the deployment risk.' : '')}; return {text: request.runId.startsWith('group-summary-') ? 'Ship the small rollout; verify the rollback first.' : 'The rollback check is the remaining deployment risk.'};});
  try {
    peer = f.agents[1].id; const accepted = f.groups.accept(f.room.id, 'Should we ship?', undefined, 6, 'smart'), run = await settled(f, accepted.run.id);
    assert.equal(run.status, 'complete'); assert.equal(run.executionMode, 'smart'); assert.equal(run.modelCalls, 4); assert.equal(run.completedReplies, 2);
    const messages = f.store.groupMessages(f.room.id).filter(message => message.role === 'assistant');
    assert.deepEqual(messages.map(message => message.agentId), [peer, f.agents[0].id]); assert.equal(messages.at(-1)!.content, 'Ship the small rollout; verify the rollback first.');
    const speaker = requests.find(request => !request.runId.startsWith('group-moderator-') && !request.runId.startsWith('group-summary-'))!;
    assert.match(speaker.instructions, /Assess the deployment risk\./); assert.match(speaker.instructions, /PRIVATE_PERSPECTIVE_1/); assert.doesNotMatch(speaker.instructions, /PRIVATE_PERSPECTIVE_0|PRIVATE_MEMORY_0/); assert.match(speaker.instructions, /new|novel/i);
    assert.ok(requests.every(request => request.execution?.mode === 'chat' && request.execution?.surface === 'group'));
    assert.ok(requests.every(request => contextWireCharacters(request.instructions, request.history) <= 80000));
    assert.ok(messages.every(message => !message.content.includes('speakerId')));
  } finally {await f.close();}
});

test('a one-reply smart allowance produces a useful outcome without spending it on hidden choices', async () => {
  const requests: ProviderRequest[] = []; const f = await fixture(async request => {requests.push(request); return {text: 'Start with the smallest reversible change and verify it.'};});
  try {const accepted = f.groups.accept(f.room.id, 'Suggest a next step.', undefined, 1, 'smart'), run = await settled(f, accepted.run.id); assert.equal(run.status, 'complete'); assert.equal(run.modelCalls, 1); assert.equal(run.completedReplies, 1); assert.equal(run.moderatorCalls, 0); assert.match(requests[0].runId, /^group-summary-/); assert.equal(f.store.groupMessages(f.room.id).at(-1)!.agentId, f.agents[0].id);} finally {await f.close();}
});

test('smart reply budget reserves its final answer rather than ending on a peer contribution', async () => {
  let peer = ''; const requests: ProviderRequest[] = []; const f = await fixture(async request => {requests.push(request); return {text: request.runId.startsWith('group-moderator-') ? choice(peer, 'Explain one unresolved risk.') : request.runId.startsWith('group-summary-') ? 'Outcome: use a reversible rollout. Open question: load limits.' : 'One unresolved risk is load.'};});
  try {peer = f.agents[1].id; f.store.saveSettings({...f.store.settings(), maxModelCalls: 1}); const accepted = f.groups.accept(f.room.id, 'Plan a release.', undefined, 3, 'smart'), run = await settled(f, accepted.run.id); assert.equal(run.status, 'complete'); assert.equal(run.completedReplies, 3); assert.equal(run.modelCalls, 5); assert.match(requests.at(-1)!.runId, /^group-summary-/); assert.match(f.store.groupMessages(f.room.id).at(-1)!.content, /Open question/);} finally {await f.close();}
});

test('human guidance invalidates an in-flight moderator choice and is published exactly once', async () => {
  const entered = gate(), release = gate(); let first = '', second = '', decisions = 0; const requests: ProviderRequest[] = [];
  const f = await fixture(async request => {requests.push(request); if (request.runId.startsWith('group-moderator-')) {decisions++; if (decisions === 1) {entered.resolve(); await release.promise; return {text: choice(first, 'Explore an expensive implementation.')};} return {text: choice(decisions === 2 ? second : null, decisions === 2 ? 'Give the cheapest working option.' : '')};} return {text: request.runId.startsWith('group-summary-') ? 'Use the cheaper option.' : 'The cheaper option is sufficient.'};});
  try {
    first = f.agents[1].id; second = f.agents[2].id; const accepted = f.groups.accept(f.room.id, 'Plan the implementation.', undefined, 6, 'smart'), events: GroupEvent[] = []; f.groups.subscribe(accepted.run.id, event => events.push(event)); await entered.promise;
    const result = await replyToRun({runs: f.runs, store: f.store, groups: f.groups}, accepted.run.id, 'Keep it cheap; ask the third bot.'); assert.equal(result.action, 'guided'); release.resolve(); const run = await settled(f, accepted.run.id);
    assert.equal(run.status, 'complete'); assert.deepEqual(f.store.groupMessages(f.room.id).filter(message => message.role === 'assistant').map(message => message.agentId), [second, f.agents[0].id]);
    assert.equal(f.store.groupMessages(f.room.id).filter(message => message.content === 'Keep it cheap; ask the third bot.').length, 1);
    assert.equal(events.filter(event => event.type === 'message' && event.message.id === result.message.id).length, 1);
    assert.ok(input(requests.filter(request => request.runId.startsWith('group-moderator-'))[1]).transcript.some(message => message.content === 'Keep it cheap; ask the third bot.'));
  } finally {release.resolve(); await f.close();}
});

test('guidance arriving during provider refresh prevents a stale speaker from dispatching or leaving an empty bubble', async () => {
  const entered = gate(), release = gate(); let first = '', second = '', decisions = 0; const requests: ProviderRequest[] = [];
  const f = await fixture(async request => {requests.push(request); if (request.runId.startsWith('group-moderator-')) {decisions++; return {text: choice(decisions === 1 ? first : decisions === 2 ? second : null, decisions < 3 ? 'Answer the current constraint.' : '')};} return {text: request.runId.startsWith('group-summary-') ? 'Use the revised approach.' : 'The revised approach meets the constraint.'};});
  try {
    first = f.agents[1].id; second = f.agents[2].id; const refresh = f.runs.refresh.bind(f.runs); let held = false;
    f.runs.refresh = async () => {if (!held && [...f.groups.active.values()].some(active => active.run.phase === 'reply')) {held = true; entered.resolve(); await release.promise;} return refresh();};
    const accepted = f.groups.accept(f.room.id, 'Choose an approach.', undefined, 6, 'smart'); await entered.promise; await replyToRun({runs: f.runs, store: f.store, groups: f.groups}, accepted.run.id, 'New constraint: prefer the third bot.'); release.resolve(); const run = await settled(f, accepted.run.id);
    assert.equal(run.status, 'complete'); const messages = f.store.groupMessages(f.room.id).filter(message => message.role === 'assistant'); assert.deepEqual(messages.map(message => message.agentId), [second, f.agents[0].id]); assert.ok(messages.every(message => !!message.content && message.status === 'complete')); assert.equal(requests.filter(request => !request.runId.startsWith('group-moderator-') && !request.runId.startsWith('group-summary-')).length, 1);
  } finally {release.resolve(); await f.close();}
});

test('smart context windows long discussion history while preserving human topic, latest guidance and explicit reply target', async () => {
  const requests: ProviderRequest[] = []; const f = await fixture(async request => {requests.push(request); return {text: request.runId.startsWith('group-moderator-') ? choice(null) : 'Use the topic, latest constraint and referenced observation.'};});
  try {
    const add = (role: 'user' | 'assistant', content: string, status: GroupMessage['status'] = 'complete') => f.store.put<GroupMessage>('group-message', {id: id(), roomId: f.room.id, runId: null, role, agentId: role === 'user' ? null : f.agents[1].id, authorName: role === 'user' ? 'You' : f.agents[1].name, content, createdAt: now(), status, route: null});
    add('user', 'ORIGINAL_TOPIC'); const target = add('assistant', 'REFERENCED_OBSERVATION', 'cancelled'); for (let i = 0; i < 40; i++) add('assistant', '"\\\n'.repeat(1500));
    const accepted = f.groups.accept(f.room.id, 'LATEST_CONSTRAINT', undefined, 6, 'smart', target.id), run = await settled(f, accepted.run.id); assert.equal(run.status, 'complete'); assert.equal(run.contextWindowed, true);
    for (const request of requests) {const transcript = input(request).transcript; for (const text of ['ORIGINAL_TOPIC', 'LATEST_CONSTRAINT', 'REFERENCED_OBSERVATION']) assert.equal(transcript.filter(message => message.content === text).length, 1); assert.ok(contextWireCharacters(request.instructions, request.history) <= 80000); assert.doesNotMatch(JSON.stringify(request.history), /PRIVATE_PERSPECTIVE|PRIVATE_MEMORY/);}
    assert.equal(f.store.get<GroupMessage>('group-message', target.id)!.status, 'cancelled');
  } finally {await f.close();}
});

test('explicit existing discussion modes keep their contracts and smart is moderated only', async () => {
  const f = await fixture(async () => ({text: '{"speakerId":null,"reason":"Resolved."}'}));
  try {const room = f.groups.create(f.agents.slice(0, 2).map(agent => agent.id), 'Roundtable', 'roundtable'); assert.throws(() => f.groups.accept(room.id, 'A topic', undefined, undefined, 'smart'), /moderated/i); const accepted = f.groups.accept(f.room.id, 'A topic'); assert.equal(accepted.run.executionMode, 'bounded'); const run = await settled(f, accepted.run.id); assert.equal(run.status, 'complete'); assert.equal(run.completedReplies, 0);} finally {await f.close();}
});

test('a control-only public focus is rejected before any participant can be dispatched', async () => {
  let peer = '', calls = 0; const f = await fixture(async request => {calls++; return {text: request.runId.startsWith('group-moderator-') ? choice(peer, '\u0001') : 'This should never be dispatched.'};});
  try {peer = f.agents[1].id; const accepted = f.groups.accept(f.room.id, 'Review a plan.', undefined, 6, 'smart'), run = await settled(f, accepted.run.id); assert.equal(run.status, 'failed'); assert.equal(calls, 1); assert.equal(f.store.groupMessages(f.room.id).filter(message => message.role === 'assistant').length, 0);} finally {await f.close();}
});

test('guidance arriving during the final outcome remains visible and can be applied by continuing', async () => {
  const entered = gate(), release = gate(); let summaries = 0; const requests: ProviderRequest[] = [];
  const f = await fixture(async request => {requests.push(request); if (request.runId.startsWith('group-moderator-')) return {text: choice(null)}; if (summaries++ === 0) {entered.resolve(); await release.promise;} return {text: summaries === 1 ? 'Initial outcome.' : 'Outcome updated for the new constraint.'};});
  try {
    const accepted = f.groups.accept(f.room.id, 'Give a recommendation.', undefined, 1, 'smart'); await entered.promise;
    await replyToRun({runs: f.runs, store: f.store, groups: f.groups}, accepted.run.id, 'New constraint: finish within one day.'); release.resolve(); const first = await settled(f, accepted.run.id); assert.equal(first.status, 'complete'); assert.equal(first.pendingGuidance, true);
    const next = f.groups.accept(f.room.id, undefined, undefined, 1, 'smart'), completed = await settled(f, next.run.id); assert.equal(completed.pendingGuidance, false); assert.ok(input(requests.at(-1)!).transcript.some(message => message.content === 'New constraint: finish within one day.')); assert.equal(f.store.groupMessages(f.room.id).filter(message => message.content === 'New constraint: finish within one day.').length, 1);
  } finally {release.resolve(); await f.close();}
});

test('guidance accepted during the final roundtable reply is marked pending instead of silently lost', async () => {
  const entered = gate(), release = gate(); let replies = 0;
  const f = await fixture(async () => {if (++replies === 2) {entered.resolve(); await release.promise;} return {text: 'The current perspective.'};});
  try {const room = f.groups.create(f.agents.slice(0, 2).map(agent => agent.id), 'Roundtable', 'roundtable'), accepted = f.groups.accept(room.id, 'Compare options.', 1); await entered.promise; await replyToRun({runs: f.runs, store: f.store, groups: f.groups}, accepted.run.id, 'Also compare maintenance cost.'); release.resolve(); const run = await settled(f, accepted.run.id); assert.equal(run.status, 'complete'); assert.equal(run.pendingGuidance, true);} finally {release.resolve(); await f.close();}
});

for (const boundary of ['scheduler', 'native'] as const) for (const step of ['peer', 'outcome'] as const) {
  test(`new guidance supersedes a queued ${step} at the actual ${boundary} dispatch boundary`, async () => {
    const entered = gate(), release = gate(); const scheduler = new InferenceScheduler(1); let occupied: Promise<unknown> | undefined;
    let oldPeer = '', newPeer = '', decisions = 0, held = false; const actual: ProviderRequest[] = [];
    const f = await fixture(async (request, _emit, _signal, beforeDispatch) => {
      const moderator = request.runId.startsWith('group-moderator-'), outcome = request.runId.startsWith('group-summary-');
      if (boundary === 'native' && !held && (step === 'outcome' ? outcome : !moderator && !outcome)) {held = true; entered.resolve(); await release.promise;}
      beforeDispatch?.(); actual.push(request);
      if (moderator) {
        decisions++;
        if (boundary === 'scheduler' && step === 'peer' && decisions === 1) occupied = scheduler.run(undefined, new AbortController().signal, () => release.promise);
        return {text: choice(decisions === 1 ? oldPeer : decisions === 2 ? newPeer : null, decisions < 3 ? 'Check the current constraint.' : '')};
      }
      return {text: outcome ? 'The latest constraint is reflected in this outcome.' : 'The revised perspective.'};
    });
    try {
      oldPeer = f.agents[1].id; newPeer = f.agents[2].id;
      if (boundary === 'scheduler') {
        f.runs.adapters = scheduleAdapters(f.runs.adapters, scheduler);
        if (step === 'outcome') occupied = scheduler.run(undefined, new AbortController().signal, () => release.promise);
      }
      const accepted = f.groups.accept(f.room.id, 'Original topic.', undefined, step === 'outcome' ? 1 : 6, 'smart');
      if (boundary === 'scheduler') f.groups.subscribe(accepted.run.id, event => {if (event.type === 'status' && event.message === 'Waiting for inference capacity…') entered.resolve();});
      await entered.promise;
      await replyToRun({runs: f.runs, store: f.store, groups: f.groups}, accepted.run.id, 'NEW_GUIDANCE: choose the revised perspective.'); release.resolve(); const run = await settled(f, accepted.run.id); await occupied;
      assert.equal(run.status, 'complete'); assert.equal(run.pendingGuidance, false);
      const contributions = actual.filter(request => !request.runId.startsWith('group-moderator-'));
      assert.ok(contributions.every(request => JSON.stringify(request.history).includes('NEW_GUIDANCE')), 'no obsolete peer or outcome may reach actual inference');
      const messages = f.store.groupMessages(f.room.id).filter(message => message.role === 'assistant');
      assert.deepEqual(messages.map(message => message.agentId), step === 'peer' ? [newPeer, f.agents[0].id] : [f.agents[0].id]);
      assert.ok(messages.every(message => !!message.content && message.status === 'complete'), 'superseded queued work must not leave empty bubbles');
      assert.equal(scheduler.listQuarantines().length, 0); assert.equal(scheduler.activeCount, 0);
    } finally {release.resolve(); await occupied; await f.close();}
  });
}

for (const boundary of ['scheduler', 'native'] as const) {
  test(`auto routing preserves clean supersession through a queued ${boundary} classifier`, async () => {
    const entered = gate(), release = gate(), scheduler = new InferenceScheduler(1); let occupied: Promise<unknown> | undefined, held = false; const actual: ProviderRequest[] = [];
    const f = await fixture(async (request, _emit, _signal, beforeDispatch) => {
      if (boundary === 'native' && !held && request.usagePurpose === 'routing-classifier') {held = true; entered.resolve(); await release.promise;}
      beforeDispatch?.(); actual.push(request);
      return {text: request.usagePurpose === 'routing-classifier' ? '{"provider":"openai","model":"m","reason":"Selected"}' : 'The revised security design is ready for review.'};
    });
    try {
      for (const agent of f.agents) f.store.put('agent', {...agent, routeMode: 'auto', model: ''});
      if (boundary === 'scheduler') {f.runs.adapters = scheduleAdapters(f.runs.adapters, scheduler); occupied = scheduler.run(undefined, new AbortController().signal, () => release.promise);}
      const accepted = f.groups.accept(f.room.id, 'Security architecture audit tradeoff.', undefined, 1, 'smart');
      if (boundary === 'scheduler') {for (let i = 0; i < 100 && scheduler.queuedCount !== 1; i++) await new Promise(done => setTimeout(done, 2)); assert.equal(scheduler.queuedCount, 1);} else await entered.promise;
      await replyToRun({runs: f.runs, store: f.store, groups: f.groups}, accepted.run.id, 'NEW_GUIDANCE: revise the security design.'); release.resolve(); const run = await settled(f, accepted.run.id); await occupied;
      assert.equal(run.status, 'complete'); assert.equal(run.pendingGuidance, false); assert.equal(actual.length, 2); assert.equal(actual.filter(request => request.usagePurpose === 'routing-classifier').length, 1);
      assert.ok(actual.every(request => JSON.stringify(request.history).includes('NEW_GUIDANCE')));
      const messages = f.store.groupMessages(f.room.id).filter(message => message.role === 'assistant'); assert.equal(messages.length, 1); assert.equal(messages[0].content, 'The revised security design is ready for review.'); assert.equal(scheduler.listQuarantines().length, 0);
    } finally {release.resolve(); await occupied; await f.close();}
  });
}

for (const shape of ['replacement', 'same-error'] as const) test(`unknown classifier cleanup (${shape}) after a supersession guard still interrupts without rerouting`, async () => {
  const entered = gate(), release = gate(); let attempts = 0;
  const f = await fixture(async (_request, _emit, _signal, beforeDispatch) => {attempts++; entered.resolve(); await release.promise; try {beforeDispatch?.();} catch (error) {throw Object.assign(shape === 'same-error' ? error as Error : new Error('Owned cleanup remains unconfirmed.'), {code: 'PROVIDER_OUTCOME_UNKNOWN'});} return {text: 'Unexpected.'};});
  try {for (const agent of f.agents) f.store.put('agent', {...agent, routeMode: 'auto', model: ''}); const accepted = f.groups.accept(f.room.id, 'Security architecture audit tradeoff.', undefined, 1, 'smart'); await entered.promise; await replyToRun({runs: f.runs, store: f.store, groups: f.groups}, accepted.run.id, 'NEW_GUIDANCE: revise the security design.'); release.resolve(); const run = await settled(f, accepted.run.id); assert.equal(run.status, 'interrupted'); assert.equal(attempts, 1); assert.equal(run.pendingGuidance, true); assert.equal(f.store.groupMessages(f.room.id).filter(message => message.role === 'assistant').length, 0);} finally {release.resolve(); await f.close();}
});
