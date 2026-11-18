import {contextWireCharacters} from '../server/context-wire.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, PROVIDER_IDS, id, now } from '../server/store.js';
import { Runs } from '../server/runs.js';
import { Groups } from '../server/groups.js';
import { createApp } from '../server/index.js';
import type { Agent, Bootstrap, GroupEvent, GroupMessage, GroupRun, ProviderAdapter, ProviderConnection, ProviderId, ProviderRequest } from '../shared/types.js';

const billing = { mode: 'included' as const, confirmed: true, automaticRouting: true, allowanceNote: 'Fake account test' };
function connection(provider: ProviderId): ProviderConnection { return { id: provider, installed: true, authenticated: true, authMode: 'subscription', accountLabel: `${provider} test account`, plan: 'Test plan', models: (provider === 'openai' ? ['gpt-6-luna', 'gpt-6-astra'] : provider === 'claude' ? ['claude-test-model'] : ['cursor-test-model']).map(id => ({ id, name: id, verified: false })) }; }
type StreamHandler = (provider: ProviderId, request: ProviderRequest, emit: Parameters<ProviderAdapter['stream']>[1], signal: AbortSignal) => ReturnType<ProviderAdapter['stream']>;
function adapters(handler: StreamHandler = async (_provider, request, emit) => { emit({ type: 'delta', text: 'A useful contribution.' }); return { text: 'A useful contribution.', actualModel: request.model }; }): Record<ProviderId, ProviderAdapter> {
  return Object.fromEntries(PROVIDER_IDS.map(provider => [provider, { id: provider, inspect: async () => connection(provider), login: async () => ({ message: 'Fake login' }), close: async () => {}, stream: (request: ProviderRequest, emit: Parameters<ProviderAdapter['stream']>[1], signal: AbortSignal) => handler(provider, request, emit, signal) }])) as Record<ProviderId, ProviderAdapter>;
}
async function fixture(custom = adapters()) {
  const dir = await mkdtemp(join(tmpdir(), 'relay-groups-')); const store = new Store(dir); const runs = new Runs(store, custom); const groups = new Groups(store, runs);
  await runs.refresh(); for (const provider of PROVIDER_IDS) store.saveBilling(provider, billing); store.saveModelPreferences('cursor', { defaultModel: '', allowedModels: ['cursor-test-model'] });
  const agents = store.list<Agent>('agent').map((agent, i) => store.put('agent', { ...agent, routeMode: i === 1 ? 'claude' as const : 'openai' as const, model: '', instructions: `PRIVATE_RULE_${i}`, memory: `PRIVATE_MEMORY_${i}` }));
  return { dir, store, runs, groups, agents, async close() { await groups.close(); await runs.close(); store.close(); await rm(dir, { recursive: true, force: true }); } };
}
async function finished(groups: Groups, runId: string) { const active = groups.active.get(runId); if (active) await active.promise; return groups.store.get<GroupRun>('group-run', runId)!; }
function roundtable(groups: Groups, agentIds: unknown, title?: unknown) { return groups.create(agentIds, title, 'roundtable'); }
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

test('room creation validates 2–5 unique participants and does not create model calls or direct-chat messages', async () => {
  let calls = 0; const f = await fixture(adapters(async () => { calls++; return { text: 'unused' }; }));
  try {
    const ids = f.agents.slice(0, 2).map(agent => agent.id);
    for (const invalid of [undefined, [], [ids[0]], [ids[0], ids[0]], [ids[0], 'missing'], [...f.agents.map(agent => agent.id), 'sixth']]) assert.throws(() => roundtable(f.groups,invalid), /agents|agent/);
    const room = roundtable(f.groups,ids, 'Engineering roundtable'); assert.equal(room.title, 'Engineering roundtable'); assert.deepEqual(room.agentIds, ids);
    const other = new Store(f.dir); assert.deepEqual(other.get('group-room', room.id), room); other.close();
    assert.equal(f.store.list('message').length, 0); assert.equal(f.store.list('group-message').length, 0); assert.equal(calls, 0);
    assert.throws(() => f.groups.accept(room.id, undefined), /topic/);
    for (const rounds of [0, 4, 1.5, '2']) assert.throws(() => f.groups.accept(room.id, 'A topic', rounds), /Rounds/);
  } finally { await f.close(); }
});

test('roundtable preserves speaker order, independent private perspectives and attributed peer transcript with no synthetic users', async () => {
  const requests: ProviderRequest[] = []; let mutate = () => {};
  const f = await fixture(adapters(async (_provider, request, emit) => {
    requests.push(request); const text = `Contribution ${requests.length}`; emit({ type: 'delta', text }); if (requests.length === 1) mutate(); return { text, actualModel: request.model };
  }));
  try {
    const [first, second] = f.agents; second.name = 'Peer "name"\nwith labels'; f.store.put('agent', second);
    f.store.put('file', { id: id(), agentId: first.id, name: 'private.txt', content: 'PRIVATE_FILE_ALPHA', size: 18, createdAt: now() });
    mutate = () => { f.store.put('agent', { ...second, name: 'Renamed mid-run', instructions: 'NEW_PRIVATE_RULE', memory: 'NEW_PRIVATE_MEMORY', routeMode: 'cursor' }); };
    const room = roundtable(f.groups,[first.id, second.id]); const accepted = f.groups.accept(room.id, 'Discuss practical options', 2); const run = await finished(f.groups, accepted.run.id);
    assert.equal(run.status, 'complete'); assert.equal(run.completedReplies, 4); assert.equal(run.modelCalls, 4); assert.equal(run.maxModelCalls, 12);
    const messages = f.store.groupMessages(room.id); assert.equal(messages.filter(message => message.role === 'user').length, 1);
    assert.deepEqual(messages.filter(message => message.role === 'assistant').map(message => message.agentId), [first.id, second.id, first.id, second.id]);
    assert.deepEqual(messages.filter(message => message.role === 'assistant').map(message => message.authorName), [first.name, second.name, first.name, second.name]);
    assert.deepEqual(messages.filter(message => message.role === 'assistant').map(message => message.route!.provider), ['openai', 'claude', 'openai', 'claude']);
    assert.equal(requests.length, 4);
    requests.forEach((request, i) => {
      const owner = i % 2; assert.match(request.instructions, new RegExp(`PRIVATE_RULE_${owner}`)); assert.match(request.instructions, new RegExp(`PRIVATE_MEMORY_${owner}`)); assert.doesNotMatch(request.instructions, new RegExp(`PRIVATE_RULE_${1 - owner}|PRIVATE_MEMORY_${1 - owner}|NEW_PRIVATE`));
      if (owner === 0) assert.match(request.instructions, /PRIVATE_FILE_ALPHA/); else assert.doesNotMatch(request.instructions, /PRIVATE_FILE_ALPHA/);
      const transcript = JSON.parse(request.history[0].content) as { participants: Record<string, unknown>[]; transcript: { authorName: string; content: string }[] };
      assert.equal(transcript.transcript.length, i + 1); assert.equal(transcript.transcript[0].content, 'Discuss practical options');
      if (i > 0) { assert.equal(transcript.transcript.at(-1)!.content, `Contribution ${i}`); assert.equal(transcript.transcript.at(-1)!.authorName, i % 2 ? first.name : second.name); }
      assert.doesNotMatch(request.history[0].content, /PRIVATE_RULE|PRIVATE_MEMORY|PRIVATE_FILE|NEW_PRIVATE/);
      assert.deepEqual(Object.keys(transcript.participants[0]).sort(), ['agentId', 'name', 'role']);
    });
    assert.equal(f.store.get<Agent>('agent', second.id)!.name, 'Renamed mid-run'); assert.equal(f.store.list('message').length, 0);
  } finally { await f.close(); }
});

test('continuation and follow-up start new bounded runs without duplicating human messages', async () => {
  const f = await fixture();
  try {
    const room = roundtable(f.groups,f.agents.slice(0, 2).map(agent => agent.id));
    const first = f.groups.accept(room.id, 'Initial topic', 1); await finished(f.groups, first.run.id);
    const continuation = f.groups.accept(room.id, undefined, 1); assert.equal(continuation.message, null); await finished(f.groups, continuation.run.id);
    const followup = f.groups.accept(room.id, 'Now examine costs', 1); await finished(f.groups, followup.run.id);
    assert.deepEqual(f.store.groupMessages(room.id).filter(message => message.role === 'user').map(message => message.content), ['Initial topic', 'Now examine costs']);
    assert.equal(f.store.groupMessages(room.id).filter(message => message.role === 'assistant').length, 6); assert.equal(f.store.groupRuns(room.id).length, 3);
  } finally { await f.close(); }
});

test('each next actual call rechecks billing, selected models and start-account identity before sending', async () => {
  let revoke = () => {}; let calls = 0;
  const f = await fixture(adapters(async () => { calls++; revoke(); return { text: 'First contribution' }; }));
  try {
    const room = roundtable(f.groups,f.agents.slice(0, 2).map(agent => agent.id)); revoke = () => f.store.saveBilling('claude', { ...billing, confirmed: false });
    const accepted = f.groups.accept(room.id, 'A topic', 2); const run = await finished(f.groups, accepted.run.id);
    assert.equal(run.status, 'failed'); assert.equal(run.completedReplies, 1); assert.equal(run.modelCalls, 1); assert.match(run.error!, /revoked/); assert.equal(calls, 1);
    assert.equal(f.store.groupMessages(room.id).at(-1)!.status, 'error');
  } finally { await f.close(); }
  let change = () => {}; const custom = adapters(async () => { change(); return { text: 'First contribution' }; }); let account = 'openai test account';
  custom.openai.inspect = async () => ({ ...connection('openai'), accountLabel: account }); const g = await fixture(custom);
  try {
    const ids = [g.agents[0].id, g.agents[2].id]; const room = roundtable(g.groups,ids); change = () => { account = 'Replacement account'; };
    const accepted = g.groups.accept(room.id, 'A topic', 1); const run = await finished(g.groups, accepted.run.id); assert.equal(run.status, 'failed'); assert.equal(run.completedReplies, 1); assert.equal(run.modelCalls, 1); assert.match(run.error!, /account changed/); assert.equal(g.store.billing('openai').confirmed, false);
  } finally { await g.close(); }
});

test('classifier and fallback calls revalidate permissions and share both reply and group call limits', async () => {
  let change = () => {}; const seen: ProviderRequest[] = [];
  const f = await fixture(adapters(async (_provider, request) => { seen.push(request); change(); return { text: '{"provider":"openai","model":"gpt-6-astra","reason":"Review"}', actualModel: request.model }; }));
  try {
    for (const agent of f.agents.slice(0, 2)) f.store.put('agent', { ...agent, routeMode: 'auto' });
    const room = roundtable(f.groups,f.agents.slice(0, 2).map(agent => agent.id)); change = () => f.store.saveModelPreferences('openai', { defaultModel: '', allowedModels: ['gpt-6-luna'] });
    const accepted = f.groups.accept(room.id, 'Audit the architecture', 1); const run = await finished(f.groups, accepted.run.id);
    assert.equal(run.status, 'failed'); assert.equal(run.modelCalls, 1); assert.match(run.error!, /removed or disabled/); assert.equal(seen.length, 1); assert.match(seen[0].runId, /group-route-/);
  } finally { await f.close(); }
  let revokeFallback = () => {}; let calls = 0;
  const g = await fixture(adapters(async () => { calls++; revokeFallback(); throw new Error('Temporary overload'); }));
  try {
    for (const agent of g.agents.slice(0, 2)) g.store.put('agent', { ...agent, routeMode: 'auto' });
    const room = roundtable(g.groups,g.agents.slice(0, 2).map(agent => agent.id)); revokeFallback = () => g.store.saveBilling('claude', { ...billing, automaticRouting: false });
    const accepted = g.groups.accept(room.id, 'A topic', 1); const run = await finished(g.groups, accepted.run.id); assert.equal(run.status, 'failed'); assert.equal(run.modelCalls, 1); assert.match(run.error!, /revoked/); assert.equal(calls, 1);
  } finally { await g.close(); }
});

test('a policy write awaiting the same provider refresh is observed immediately before inference', async () => {
  let delayed = false; let calls = 0; const entered = gate(); const release = gate();
  const custom = adapters(async () => { calls++; return { text: 'Must not run' }; });
  custom.openai.inspect = async () => { if (delayed) { entered.resolve(); await release.promise; } return connection('openai'); };
  const f = await fixture(custom);
  try {
    delayed = true; const inspection = f.runs.refresh();
    const revocation = inspection.then(() => f.store.saveModelPreferences('openai', { defaultModel: '', allowedModels: [] }));
    const room = roundtable(f.groups,[f.agents[0].id, f.agents[2].id]); const accepted = f.groups.accept(room.id, 'A topic', 1);
    await entered.promise; release.resolve(); await revocation;
    const run = await finished(f.groups, accepted.run.id); assert.equal(run.status, 'failed'); assert.match(run.error!, /removed or disabled/); assert.equal(run.modelCalls, 0); assert.equal(calls, 0);
  } finally { release.resolve(); await f.close(); }
});

test('shared concurrency and cancellation retain the group slot until provider cleanup finishes', async () => {
  const entered = gate(); const cleaned = new Set<string>(); let callCount = 0;
  const f = await fixture(adapters(async (_provider, request, emit, signal) => { callCount++; emit({ type: 'delta', text: 'Partial' }); entered.resolve(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { setTimeout(() => { cleaned.add(request.runId); reject(new Error('aborted')); }, 30); }, { once: true })); }));
  try {
    const room = roundtable(f.groups,f.agents.slice(0, 2).map(agent => agent.id)); const accepted = f.groups.accept(room.id, 'A topic', 1); await entered.promise;
    assert.throws(() => f.groups.accept(room.id, 'Another topic', 1), /already active/);
    const directAgent = f.agents[2]; const conversation = f.store.conversations(directAgent.id)[0]; const direct = f.runs.accept(directAgent, conversation.id, 'Direct task', 'openai', '');
    while (callCount < 2) await new Promise(resolve => setTimeout(resolve, 1));
    const other = roundtable(f.groups,[f.agents[3].id, f.agents[4].id]); assert.throws(() => f.groups.accept(other.id, 'A topic', 1), /two-run limit/);
    assert.throws(() => f.runs.accept(f.agents[4], f.store.conversations(f.agents[4].id)[0].id, 'Third task', 'openai', ''), /two-run limit/);
    const cancelling = f.groups.cancel(accepted.run.id); assert.equal(f.runs.activeCount(), 2); assert.equal(cleaned.size, 0); await cancelling;
    assert.equal(f.runs.activeCount(), 1); assert.equal(f.store.get<GroupRun>('group-run', accepted.run.id)!.status, 'cancelled'); assert.equal(f.store.groupMessages(room.id).at(-1)!.status, 'cancelled'); assert.equal(cleaned.size, 1);
    await f.runs.cancel(direct.run.id); assert.equal(f.runs.activeCount(), 0); assert.equal(cleaned.size, 2);
  } finally { await f.close(); }
});

test('SSE snapshots include current content then only future deltas, and disconnect never cancels the discussion', async () => {
  const paused = gate(); const release = gate(); let count = 0;
  const f = await fixture(adapters(async (_provider, request, emit) => {
    count++; if (count === 1) { emit({ type: 'delta', text: 'Hello ' }); paused.resolve(); await release.promise; emit({ type: 'delta', text: 'peer' }); return { text: 'Hello peer', actualModel: request.model }; }
    emit({ type: 'delta', text: 'Reply' }); return { text: 'Reply', actualModel: request.model };
  }));
  try {
    const room = roundtable(f.groups,f.agents.slice(0, 2).map(agent => agent.id)); const accepted = f.groups.accept(room.id, 'A topic', 1); await paused.promise;
    const events: GroupEvent[] = []; const unsubscribe = f.groups.subscribe(accepted.run.id, event => events.push(event));
    assert.equal(events[0].type, 'snapshot'); const snapshot = events[0]; assert.equal(snapshot.type === 'snapshot' && snapshot.messages.at(-1)!.content, 'Hello ');
    unsubscribe(); assert.equal(f.groups.active.size, 1);
    const resumed: GroupEvent[] = []; f.groups.subscribe(accepted.run.id, event => resumed.push(event)); release.resolve(); await finished(f.groups, accepted.run.id);
    assert.equal(resumed[0].type, 'snapshot'); const firstSpeaker = f.store.groupMessages(room.id).find(message => message.role === 'assistant')!;
    assert.equal(resumed.filter(event => event.type === 'delta' && event.messageId === firstSpeaker.id).map(event => event.type === 'delta' ? event.text : '').join(''), 'peer');
    assert.equal(resumed.at(-1)!.type, 'done');
    const late: GroupEvent[] = []; f.groups.subscribe(accepted.run.id, event => late.push(event)); assert.deepEqual(late.map(event => event.type), ['snapshot', 'done']);
    assert.equal(late[0].type === 'snapshot' && late[0].messages.filter(message => message.role === 'assistant').map(message => message.content).join('|'), 'Hello peer|Reply');
  } finally { release.resolve(); await f.close(); }
});

test('context and output limits stop before another bot call and preserve the visible partial transcript', async () => {
  let calls = 0; const f = await fixture(adapters(async (_provider, request) => { calls++; return { text: 'x'.repeat(16000), actualModel: request.model }; }));
  try {
    for (const agent of f.agents.slice(0, 2)) f.store.put('file', { id: id(), agentId: agent.id, name: 'large.txt', content: 'private-source '.repeat(3800), size: 57000, createdAt: now() });
    const room = roundtable(f.groups,f.agents.slice(0, 2).map(agent => agent.id)); const accepted = f.groups.accept(room.id, 'A topic', 2); const run = await finished(f.groups, accepted.run.id);
    assert.equal(run.status, 'failed'); assert.match(run.error!, /80,000/); assert.equal(run.completedReplies, 2); assert.equal(calls, 2); assert.equal(f.store.groupMessages(room.id).filter(message => message.role === 'assistant').length, 2);
    f.store.put('file', { id: id(), agentId: f.agents[0].id, name: 'too-much.txt', content: 'p'.repeat(30000), size: 30000, createdAt: now() });
    const empty = roundtable(f.groups,f.agents.slice(0, 2).map(agent => agent.id)); assert.throws(() => f.groups.accept(empty.id, 'A topic', 1), /80,000/); assert.equal(f.store.groupMessages(empty.id).length, 0);
  } finally { await f.close(); }
  let outputCalls = 0; const g = await fixture(adapters(async () => { outputCalls++; return { text: 'x'.repeat(16001) }; }));
  try { const room = roundtable(g.groups,g.agents.slice(0, 2).map(agent => agent.id)); const accepted = g.groups.accept(room.id, 'A topic', 1); const run = await finished(g.groups, accepted.run.id); assert.equal(run.status, 'failed'); assert.match(run.error!, /16,000/); assert.equal(outputCalls, 1); assert.equal(run.completedReplies, 0); } finally { await g.close(); }
});

test('classifier and transient fallback cannot exceed the aggregate thirty-call budget', async () => {
  let calls = 0;
  const f = await fixture(adapters(async (provider, request) => {
    calls++; if (request.runId.startsWith('group-route-')) return { text: '{"provider":"openai","model":"gpt-6-astra","reason":"Review"}', actualModel: request.model };
    if (provider === 'openai') throw new Error('Temporary overload'); return { text: 'Recovered contribution', actualModel: request.model };
  }));
  try {
    for (const agent of f.agents) f.store.put('agent', { ...agent, routeMode: 'auto' });
    const room = roundtable(f.groups,f.agents.map(agent => agent.id)); const accepted = f.groups.accept(room.id, 'Audit this design', 3); const run = await finished(f.groups, accepted.run.id);
    assert.equal(run.status, 'failed'); assert.equal(run.maxModelCalls, 30); assert.equal(run.modelCalls, 30); assert.equal(calls, 30); assert.equal(run.completedReplies, 10); assert.equal(run.totalReplies, 15); assert.match(run.error!, /budget/);
  } finally { await f.close(); }
});

test('per-reply deadline aborts and waits for cleanup without allowing another participant to run', async () => {
  let cleaned = false; let calls = 0;
  const f = await fixture(adapters(async (_provider, _request, _emit, signal) => { calls++; return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { cleaned = true; reject(signal.reason); }, { once: true })); }));
  try { f.store.saveSettings({ ...f.store.settings(), maxRunSeconds: 1 }); const room = roundtable(f.groups,f.agents.slice(0, 2).map(agent => agent.id)); const accepted = f.groups.accept(room.id, 'A topic', 1); const run = await finished(f.groups, accepted.run.id); assert.equal(run.status, 'failed'); assert.match(run.error!, /time limit/); assert.equal(cleaned, true); assert.equal(calls, 1); } finally { await f.close(); }
});

test('restart marks active group runs interrupted and partial speaker messages error, with no automatic replay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-group-restart-'));
  try {
    let store = new Store(dir); const agents = store.list<Agent>('agent'); const room = store.createRoom(agents.slice(0, 2).map(agent => agent.id)); const runId = id();
    store.put<GroupRun>('group-run', { id: runId, roomId: room.id, status: 'running', rounds: 2, completedReplies: 0, totalReplies: 4, modelCalls: 1, maxModelCalls: 12, maxSeconds: 600, currentAgentId: agents[0].id, error: null, startedAt: now(), endedAt: null });
    store.put<GroupMessage>('group-message', { id: id(), roomId: room.id, runId, role: 'assistant', agentId: agents[0].id, authorName: agents[0].name, content: 'Actual partial output', createdAt: now(), status: 'streaming', route: null });
    store.close(); store = new Store(dir); assert.equal(store.get<GroupRun>('group-run', runId)!.status, 'interrupted'); assert.equal(store.groupMessages(room.id)[0].status, 'error'); assert.equal(store.groupMessages(room.id)[0].content, 'Actual partial output'); store.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('group HTTP routes share session/CSRF checks, bootstrap rooms, exact response shapes and login exclusion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-group-http-')); const started = gate();
  const app = createApp({ dataDir: dir, port: 0, adapters: adapters(async (_provider, _request, _emit, signal) => { started.resolve(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }) });
  const port = await app.listen(0); const base = `http://127.0.0.1:${port}`;
  try {
    const response = await fetch(base + '/api/bootstrap'); const cookie = response.headers.get('set-cookie')!.split(';')[0]; const bootstrap = await response.json() as Bootstrap;
    const request = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => fetch(base + path, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': bootstrap.csrfToken, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const agentIds = bootstrap.agents.slice(0, 2).map(agent => agent.id);
    assert.equal((await request('/api/groups', 'POST', { agentIds }, { 'X-CSRF-Token': '' })).status, 403);
    assert.equal((await request('/api/groups', 'POST', { agentIds }, { Origin: 'https://hostile.example' })).status, 403);
    const created = await request('/api/groups', 'POST', { title: 'Team discussion', agentIds, mode: 'roundtable' }); assert.equal(created.status, 201); const room = await created.json() as { id: string };
    const fresh = await (await request('/api/bootstrap')).json() as Bootstrap; assert.equal(fresh.rooms[0].id, room.id);
    const defaultRoom = await (await request('/api/groups', 'POST', { agentIds })).json() as { id: string; mode: string; moderatorAgentId: string };
    assert.equal(defaultRoom.mode, 'moderated'); assert.equal(defaultRoom.moderatorAgentId, agentIds[0]);
    assert.equal((await request('/api/groups', 'POST', { agentIds, mode: 'moderated', moderatorAgentId: bootstrap.agents[2].id })).status, 400);
    assert.equal((await request(`/api/groups/${defaultRoom.id}/runs`, 'POST', { content: 'A topic', maxReplies: 0 })).status, 400);
    const data = await (await request(`/api/groups/${room.id}`)).json() as { room: { id: string }; messages: unknown[]; runs: unknown[] }; assert.equal(data.room.id, room.id); assert.deepEqual(data.messages, []); assert.deepEqual(data.runs, []);
    assert.equal((await request(`/api/groups/${room.id}/runs`, 'POST', { content: 'A topic' })).status, 400);
    await app.runs.refresh(); app.store.saveBilling('openai', billing);
    const accepted = await request(`/api/groups/${room.id}/runs`, 'POST', { content: 'A topic', rounds: 1 }); assert.equal(accepted.status, 202); const { run } = await accepted.json() as { run: GroupRun }; await started.promise;
    assert.equal(run.executionMode, 'bounded'); assert.equal(run.maxSeconds, 600);
    assert.equal((await request('/api/providers/claude/login', 'POST', {})).status, 409);
    assert.equal((await request(`/api/group-runs/${run.id}/cancel`, 'POST', {})).status, 200);
    const stream = await (await request(`/api/group-runs/${run.id}/events`)).text(); const events = stream.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)) as GroupEvent); assert.deepEqual(events.map(event => event.type), ['snapshot', 'done']);
    assert.equal((await request(`/api/groups/${room.id}/runs`, 'POST', { executionMode: 'unknown' })).status, 400);
    const continuous = await request(`/api/groups/${room.id}/runs`, 'POST', { executionMode: 'continuous' }); assert.equal(continuous.status, 202); const continuousRun = (await continuous.json() as { run: GroupRun }).run;
    assert.equal(continuousRun.executionMode, 'continuous'); assert.equal(continuousRun.maxSeconds, null); assert.equal(continuousRun.totalReplies, null); assert.equal(continuousRun.maxModelCalls, null);
    assert.equal((await request(`/api/group-runs/${continuousRun.id}/cancel`, 'POST', {})).status, 200);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('new rooms default to a selected moderator while legacy rooms still execute roundtable turns', async () => {
  const f = await fixture();
  try {
    const ids = f.agents.slice(0, 2).map(agent => agent.id); const room = f.groups.create(ids);
    assert.equal(room.mode, 'moderated'); assert.equal(room.moderatorAgentId, ids[0]);
    assert.equal(f.groups.create(ids, undefined, 'moderated', ids[1]).moderatorAgentId, ids[1]);
    assert.throws(() => f.groups.create(ids, undefined, 'moderated', f.agents[2].id), /moderator/);
    assert.throws(() => f.groups.create(ids, undefined, 'unknown'), /mode/);
    for (const maxReplies of [0, 16, 1.5, '6']) assert.throws(() => f.groups.accept(room.id, 'A topic', undefined, maxReplies), /maxReplies/);
    const legacy = f.store.createRoom(ids); assert.equal(legacy.mode, undefined);
    const accepted = f.groups.accept(legacy.id, 'A topic', 1); const run = await finished(f.groups, accepted.run.id);
    assert.equal(run.status, 'complete'); assert.equal(run.mode, 'roundtable'); assert.equal(run.completedReplies, 2); assert.equal(run.moderatorCalls, 0);
  } finally { await f.close(); }
});

test('moderator chooses adaptive repeated speakers, can speak itself, and finishes early without control JSON in chat', async () => {
  const requests: ProviderRequest[] = []; const decisions: (string | null)[] = []; let moderatorCalls = 0; let change = () => {};
  const f = await fixture(adapters(async (_provider, request, emit) => {
    requests.push(request);
    if (request.runId.startsWith('group-moderator-')) {
      const speakerId = decisions[moderatorCalls++]; const text = JSON.stringify({ speakerId, reason: speakerId === null ? 'Discussion resolved.' : 'This peer can\nadvance the practical tradeoff.' }); emit({ type: 'delta', text }); if (moderatorCalls === 1) change(); return { text, actualModel: request.model };
    }
    const text = `Visible contribution ${requests.filter(request => !request.runId.startsWith('group-moderator-')).length}`; emit({ type: 'delta', text }); return { text, actualModel: request.model };
  }));
  try {
    const [moderator, peer] = f.agents; decisions.push(peer.id, peer.id, moderator.id, null);
    f.store.put('file', { id: id(), agentId: moderator.id, name: 'private-moderator.txt', content: 'MODERATOR_PRIVATE_FILE', size: 22, createdAt: now() });
    change = () => f.store.put('agent', { ...moderator, instructions: 'CHANGED_PRIVATE_RULE', memory: 'CHANGED_PRIVATE_MEMORY' });
    const room = f.groups.create([moderator.id, peer.id]); const accepted = f.groups.accept(room.id, 'Discuss useful options'); const events: GroupEvent[] = []; f.groups.subscribe(accepted.run.id, event => events.push(event)); const run = await finished(f.groups, accepted.run.id);
    assert.equal(run.status, 'complete'); assert.equal(run.totalReplies, 6); assert.equal(run.completedReplies, 3); assert.equal(run.modelCalls, 7); assert.equal(run.moderatorCalls, 4); assert.equal(run.phase, null); assert.equal(run.nextSpeakerReason, 'Discussion resolved.'); assert.equal(run.moderatorRoute?.provider, 'openai');
    const messages = f.store.groupMessages(room.id); assert.equal(messages.length, 4); assert.equal(messages[0].role, 'user'); assert.deepEqual(messages.slice(1).map(message => message.agentId), [peer.id, peer.id, moderator.id]); assert.equal(messages.some(message => /speakerId/.test(message.content)), false);
    const controls = requests.filter(request => request.runId.startsWith('group-moderator-')); assert.equal(controls.length, 4);
    controls.forEach((request, i) => { assert.match(request.instructions, /PRIVATE_RULE_0/); assert.match(request.instructions, /PRIVATE_MEMORY_0/); assert.match(request.instructions, /MODERATOR_PRIVATE_FILE/); assert.doesNotMatch(request.instructions, /PRIVATE_RULE_1|PRIVATE_MEMORY_1|CHANGED_PRIVATE/); const input = JSON.parse(request.history[0].content); assert.equal(input.transcript.length, i + 1); assert.doesNotMatch(request.history[0].content, /PRIVATE_RULE|PRIVATE_MEMORY|MODERATOR_PRIVATE/); });
    const peerCalls = requests.filter(request => !request.runId.startsWith('group-moderator-')).slice(0, 2); peerCalls.forEach(request => { assert.match(request.instructions, /PRIVATE_RULE_1|PRIVATE_MEMORY_1/); assert.doesNotMatch(request.instructions, /MODERATOR_PRIVATE|PRIVATE_RULE_0|PRIVATE_MEMORY_0/); });
    assert.equal(events.filter(event => event.type === 'delta').map(event => event.type === 'delta' ? event.text : '').join('|'), 'Visible contribution 1|Visible contribution 2|Visible contribution 3');
    assert.equal(events.filter(event => event.type === 'status').some(event => event.type === 'status' && event.message.includes('\n')), false);
    assert.equal(f.store.list('message').length, 0);
  } finally { await f.close(); }
});

test('malformed, foreign and oversized moderator decisions fail without executing a speaker or exposing control output', async () => {
  for (const output of ['not json', '[]', '{"speakerId":"foreign","reason":"Bad selection"}', '{"speakerId":null,"reason":""}', '{"speakerId":null,"reason":"Done","extra":true}', JSON.stringify({ speakerId: null, reason: 'x'.repeat(501) }), 'x'.repeat(4001)]) {
    let calls = 0; const f = await fixture(adapters(async (_provider, request, emit) => { calls++; emit({ type: 'delta', text: output }); return { text: output, actualModel: request.model }; }));
    try {
      const room = f.groups.create(f.agents.slice(0, 2).map(agent => agent.id)); const accepted = f.groups.accept(room.id, 'A topic'); const events: GroupEvent[] = []; f.groups.subscribe(accepted.run.id, event => events.push(event)); const run = await finished(f.groups, accepted.run.id);
      assert.equal(run.status, 'failed'); assert.equal(run.completedReplies, 0); assert.equal(run.modelCalls, 1); assert.equal(run.moderatorCalls, 1); assert.equal(calls, 1); assert.equal(f.store.groupMessages(room.id).length, 1); assert.equal(events.some(event => event.type === 'delta'), false);
    } finally { await f.close(); }
  }
});

test('a null moderator decision completes immediately and does not create a synthetic assistant message', async () => {
  const f = await fixture(adapters(async () => ({ text: '{"speakerId":null,"reason":"The available discussion is sufficient."}' })));
  try { const room = f.groups.create(f.agents.slice(0, 2).map(agent => agent.id)); const accepted = f.groups.accept(room.id, 'A topic'); const run = await finished(f.groups, accepted.run.id); assert.equal(run.status, 'complete'); assert.equal(run.completedReplies, 0); assert.equal(run.modelCalls, 1); assert.equal(f.store.groupMessages(room.id).length, 1); } finally { await f.close(); }
});

test('moderated aggregate cap includes control classifiers and fallbacks and reserves the final call for a speaker', async () => {
  let speakerId = ''; let decisions = 0; let calls = 0;
  const f = await fixture(adapters(async (provider, request) => {
    calls++;
    if (request.runId.startsWith('group-route-')) return { text: '{"provider":"openai","model":"gpt-6-astra","reason":"Review task"}', actualModel: request.model };
    if (request.runId.startsWith('group-moderator-')) {
      if (provider === 'openai') { decisions++; if (decisions <= 4) throw new Error('Temporary overload'); }
      return { text: JSON.stringify({ speakerId, reason: 'Add another concrete consideration.' }), actualModel: request.model };
    }
    if (provider === 'openai') throw new Error('Temporary overload'); return { text: 'One focused consideration.', actualModel: request.model };
  }));
  try {
    for (const agent of f.agents.slice(0, 2)) f.store.put('agent', { ...agent, routeMode: 'auto' }); speakerId = f.agents[1].id;
    const room = f.groups.create(f.agents.slice(0, 2).map(agent => agent.id)); const accepted = f.groups.accept(room.id, 'Audit this architecture', undefined, 6); const run = await finished(f.groups, accepted.run.id);
    assert.equal(run.status, 'failed'); assert.equal(run.maxModelCalls, 30); assert.equal(run.modelCalls, 29); assert.equal(run.moderatorCalls, 14); assert.equal(calls, 29); assert.equal(decisions, 5); assert.equal(run.completedReplies, 5); assert.match(run.error!, /speaker reply could not be reserved/);
  } finally { await f.close(); }
});

test('maxReplies ends moderation without an extra decision and each step honors its own one-call limit', async () => {
  let speakerId = ''; let decisions = 0;
  const f = await fixture(adapters(async (_provider, request) => {
    assert.equal(request.runId.startsWith('group-route-'), false);
    if (request.runId.startsWith('group-moderator-')) { decisions++; return { text: JSON.stringify({ speakerId, reason: 'Keep examining the question.' }) }; }
    return { text: 'Another focused contribution.' };
  }));
  try {
    f.store.saveSettings({ ...f.store.settings(), maxModelCalls: 1 }); for (const agent of f.agents.slice(0, 2)) f.store.put('agent', { ...agent, routeMode: 'auto' }); speakerId = f.agents[1].id;
    const room = f.groups.create(f.agents.slice(0, 2).map(agent => agent.id)); const accepted = f.groups.accept(room.id, 'Audit this architecture', undefined, 15); const run = await finished(f.groups, accepted.run.id);
    assert.equal(run.status, 'complete'); assert.equal(run.completedReplies, 15); assert.equal(run.totalReplies, 15); assert.equal(run.modelCalls, 30); assert.equal(run.moderatorCalls, 15); assert.equal(decisions, 15);
  } finally { await f.close(); }
});

test('the final two aggregate calls suppress routing classifiers and reserve one decision plus one speaker reply', async () => {
  let peerId = ''; let manualId = ''; let decisions = 0; const requests: ProviderRequest[] = [];
  const f = await fixture(adapters(async (provider, request) => {
    requests.push(request);
    if (request.runId.startsWith('group-route-')) return { text: '{"provider":"openai","model":"gpt-6-astra","reason":"Review"}', actualModel: request.model };
    if (request.runId.startsWith('group-moderator-')) {
      if (provider === 'openai') { decisions++; if (request.model === 'gpt-6-astra') throw new Error('Temporary overload'); }
      return { text: JSON.stringify({ speakerId: decisions === 5 ? manualId : peerId, reason: 'This perspective can advance the discussion.' }), actualModel: request.model };
    }
    if (provider === 'openai' && request.model === 'gpt-6-astra') throw new Error('Temporary overload');
    return { text: 'One focused contribution.', actualModel: request.model };
  }));
  try {
    for (const agent of f.agents.slice(0, 2)) f.store.put('agent', { ...agent, routeMode: 'auto' });
    peerId = f.agents[1].id; manualId = f.agents[2].id;
    const room = f.groups.create(f.agents.slice(0, 3).map(agent => agent.id)); const accepted = f.groups.accept(room.id, 'Audit the architecture', undefined, 6); const run = await finished(f.groups, accepted.run.id);
    assert.equal(run.status, 'complete'); assert.equal(run.completedReplies, 6); assert.equal(run.modelCalls, 30); assert.equal(run.moderatorCalls, 16); assert.equal(decisions, 6);
    assert.equal(requests.at(-2)!.runId.startsWith('group-moderator-'), true); assert.equal(requests.at(-2)!.model, 'gpt-6-luna'); assert.equal(requests.at(-1)!.runId.startsWith('group-route-'), false); assert.equal(requests.at(-1)!.model, 'gpt-6-luna');
  } finally { await f.close(); }
});

test('policy revoked after a moderation choice prevents the chosen speaker from executing', async () => {
  let speakerId = ''; let revoke = () => {}; let calls = 0;
  const f = await fixture(adapters(async (_provider, request) => { calls++; assert.match(request.runId, /^group-moderator-/); revoke(); return { text: JSON.stringify({ speakerId, reason: 'This peer should assess the tradeoff.' }) }; }));
  try { speakerId = f.agents[1].id; revoke = () => f.store.saveBilling('claude', { ...billing, confirmed: false }); const room = f.groups.create(f.agents.slice(0, 2).map(agent => agent.id)); const accepted = f.groups.accept(room.id, 'A topic'); const run = await finished(f.groups, accepted.run.id); assert.equal(run.status, 'failed'); assert.match(run.error!, /revoked/); assert.equal(run.modelCalls, 1); assert.equal(run.moderatorCalls, 1); assert.equal(calls, 1); assert.equal(f.store.groupMessages(room.id).at(-1)!.status, 'error'); } finally { await f.close(); }
});

test('cancelling a streamed moderator decision waits for cleanup and never publishes partial control JSON', async () => {
  const entered = gate(); let cleaned = false;
  const f = await fixture(adapters(async (_provider, request, emit, signal) => {
    assert.match(request.runId, /^group-moderator-/); emit({ type: 'delta', text: '{"speakerId":' }); entered.resolve();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => setTimeout(() => { cleaned = true; reject(signal.reason); }, 30), { once: true }));
  }));
  try {
    const room = f.groups.create(f.agents.slice(0, 2).map(agent => agent.id)); const accepted = f.groups.accept(room.id, 'A topic'); const events: GroupEvent[] = []; f.groups.subscribe(accepted.run.id, event => events.push(event)); await entered.promise;
    const cancellation = f.groups.cancel(accepted.run.id); assert.equal(cleaned, false); assert.equal(f.runs.activeCount(), 1); await cancellation;
    assert.equal(cleaned, true); assert.equal(f.runs.activeCount(), 0); assert.equal(f.store.get<GroupRun>('group-run', accepted.run.id)!.status, 'cancelled'); assert.equal(f.store.groupMessages(room.id).length, 1); assert.equal(events.some(event => event.type === 'delta'), false);
  } finally { await f.close(); }
});

function continuousInput(request: ProviderRequest) {
  const manifest = JSON.parse(request.history[0].content) as { participants: { agentId: string; name: string; role: string }[]; transcript: { role: string; agentId: string | null; authorName: string; contentIndex: number }[]; contextWindowed: boolean; contextNote?: string };
  return { ...manifest, transcript: manifest.transcript.map(entry => ({ ...entry, content: request.history[entry.contentIndex].content })) };
}

test('continuous moderated discussions exceed fifteen replies and thirty calls until the user stops', async () => {
  let speakerId = ''; let calls = 0;
  const f = await fixture(adapters(async (_provider, request) => {
    calls++; const input = continuousInput(request); assert.equal(input.transcript[0].content, 'Keep examining the topic'); assert.match(request.history.at(-1)!.content, /attribution manifest/);
    if (request.runId.startsWith('group-moderator-')) { assert.match(request.instructions, /never choose null/); return { text: JSON.stringify({ speakerId, reason: 'Continue with another useful angle.' }), actualModel: request.model }; }
    return { text: `Useful angle ${calls}`, actualModel: request.model };
  }));
  try {
    speakerId = f.agents[1].id; const room = f.groups.create(f.agents.slice(0, 2).map(agent => agent.id));
    const accepted = f.groups.accept(room.id, 'Keep examining the topic', undefined, undefined, 'continuous');
    assert.equal(accepted.run.executionMode, 'continuous'); assert.equal(accepted.run.totalReplies, null); assert.equal(accepted.run.maxModelCalls, null); assert.equal(accepted.run.maxSeconds, null);
    f.groups.subscribe(accepted.run.id, event => { if (event.type === 'run' && event.run.completedReplies >= 20 && event.run.status !== 'cancelled') void f.groups.cancel(accepted.run.id); });
    const run = await finished(f.groups, accepted.run.id); assert.equal(run.status, 'cancelled'); assert.equal(run.completedReplies, 20); assert.equal(run.modelCalls, 40); assert.equal(run.moderatorCalls, 20); assert.equal(calls, 40); assert.equal(f.store.groupMessages(room.id).filter(message => message.role === 'user').length, 1);
  } finally { await f.close(); }
});

test('continuous roundtables cycle indefinitely and yield to ordinary event-loop Stop requests', async () => {
  const f = await fixture();
  try {
    const room = roundtable(f.groups, f.agents.slice(0, 2).map(agent => agent.id)); const accepted = f.groups.accept(room.id, 'Keep going', 999, undefined, 'continuous');
    const reached = gate(); f.groups.subscribe(accepted.run.id, event => { if (event.type === 'run' && event.run.completedReplies >= 18) reached.resolve(); });
    await reached.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    await f.groups.cancel(accepted.run.id); const run = f.store.get<GroupRun>('group-run', accepted.run.id)!;
    assert.equal(run.status, 'cancelled'); assert.ok(run.completedReplies >= 18); assert.equal(run.moderatorCalls, 0); assert.equal(run.maxSeconds, null); assert.equal(run.maxModelCalls, null);
    const speakers = f.store.groupMessages(room.id).filter(message => message.role === 'assistant').map(message => message.agentId); speakers.forEach((speaker, i) => assert.equal(speaker, room.agentIds[i % 2]));
  } finally { await f.close(); }
});

test('continuous execution has no session timer or 600-second elapsed deadline', async t => {
  let clock = 1000; let calls = 0; const timers: number[] = []; const originalTimer = globalThis.setTimeout;
  t.mock.method(Date, 'now', () => clock);
  t.mock.method(globalThis, 'setTimeout', (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => { timers.push(delay ?? 0); return originalTimer(callback, delay, ...args); });
  const f = await fixture(adapters(async () => { calls++; if (calls === 1) clock += 601000; return { text: 'Another contribution after a logical time jump.' }; }));
  try {
    const room = roundtable(f.groups, f.agents.slice(0, 2).map(agent => agent.id)); const accepted = f.groups.accept(room.id, 'Keep going', undefined, undefined, 'continuous');
    f.groups.subscribe(accepted.run.id, event => { if (event.type === 'run' && event.run.completedReplies >= 2 && event.run.status !== 'cancelled') void f.groups.cancel(accepted.run.id); });
    const run = await finished(f.groups, accepted.run.id); assert.equal(run.status, 'cancelled'); assert.equal(run.completedReplies, 2); assert.equal(calls, 2); assert.equal(timers.includes(600000), false); assert.equal(timers.includes(180000), true);
  } finally { await f.close(); }
});

test('rolling continuous context preserves whole quote-heavy pins within the actual wire budget', async () => {
  const rawReply = '"\\\n\u0001'.repeat(1000); assert.equal(rawReply.length, 4000);
  let calls = 0; let checked = false;
  const f = await fixture(adapters(async (_provider, request) => {
    calls++; const input = continuousInput(request);
    assert.ok(contextWireCharacters(request.instructions,request.history)<=80000);assert.ok(request.instructions.length + request.history.reduce((sum, entry) => sum + entry.content.length, 0) <= 80000);
    assert.equal(input.transcript[0].content, 'ORIGINAL_HUMAN_TOPIC'); assert.ok(input.transcript.some(entry => entry.content === 'LATEST_HUMAN_FOLLOWUP'));
    assert.equal(input.contextWindowed, true); assert.match(input.contextNote!, /Do not invent/); assert.match(request.history.at(-1)!.content, /quoted discussion data/);
    if (!checked) { assert.equal(input.transcript.at(-1)!.content, rawReply); assert.equal(input.transcript.filter(entry => entry.content === rawReply).length, 1); checked = true; }
    assert.equal(input.transcript.filter(entry => entry.content === 'ORIGINAL_HUMAN_TOPIC').length, 1); assert.equal(input.transcript.filter(entry => entry.content === 'LATEST_HUMAN_FOLLOWUP').length, 1);
    return { text: 'A recent contribution.' };
  }));
  try {
    const ids = f.agents.slice(0, 2).map(agent => agent.id);
    for (const agent of f.agents.slice(0, 2)) { f.store.put('agent', { ...agent, name: '"\\\n'.repeat(20) }); f.store.put('file', { id: id(), agentId: agent.id, name: 'private.txt', content: 'p'.repeat(30000), size: 30000, createdAt: now() }); }
    const room = roundtable(f.groups, ids);
    const add = (role: 'user' | 'assistant', content: string) => f.store.put<GroupMessage>('group-message', { id: id(), roomId: room.id, runId: null, role, agentId: role === 'user' ? null : ids[0], authorName: role === 'user' ? 'You' : 'Earlier peer', content, createdAt: now(), status: 'complete', route: null });
    add('user', 'ORIGINAL_HUMAN_TOPIC'); for (let i = 0; i < 20; i++) add('assistant', `Old contribution ${i}: ` + 'o'.repeat(12000)); add('user', 'LATEST_HUMAN_FOLLOWUP'); for (let i = 20; i < 30; i++) add('assistant', `Old contribution ${i}: ` + 'o'.repeat(12000)); add('assistant', rawReply);
    const before = f.store.groupMessages(room.id).length;
    const accepted = f.groups.accept(room.id, undefined, undefined, undefined, 'continuous'); assert.equal(accepted.run.contextWindowed, true);
    f.groups.subscribe(accepted.run.id, event => { if (event.type === 'run' && event.run.completedReplies >= 2 && event.run.status !== 'cancelled') void f.groups.cancel(accepted.run.id); });
    const run = await finished(f.groups, accepted.run.id); assert.equal(run.status, 'cancelled'); assert.equal(run.contextWindowed, true); assert.equal(calls, 2); assert.equal(checked, true); assert.equal(f.store.groupMessages(room.id).length, before + 2);
    assert.equal(f.store.groupMessages(room.id).find(message => message.content === rawReply)!.content, rawReply);
  } finally { await f.close(); }
});

test('continuous startup reserves a whole reply and refuses to truncate oversized private or mandatory human context', async () => {
  let calls = 0; const f = await fixture(adapters(async () => { calls++; return { text: 'Must not execute' }; }));
  try {
    const room = f.groups.create(f.agents.slice(0, 2).map(agent => agent.id)); f.store.put('file', { id: id(), agentId: f.agents[0].id, name: 'huge.txt', content: 'p'.repeat(68000), size: 68000, createdAt: now() });
    assert.throws(() => f.groups.accept(room.id, 'Original topic', undefined, undefined, 'continuous'), /full reply|Reduce private/); assert.equal(f.store.groupMessages(room.id).length, 0); assert.equal(calls, 0);
    assert.throws(() => f.groups.accept(room.id, 'A topic', undefined, undefined, 'unknown'), /executionMode/);
  } finally { await f.close(); }
});

test('continuous moderators cannot return null and permission revocation still stops further actual calls', async () => {
  const f = await fixture(adapters(async () => ({ text: '{"speakerId":null,"reason":"Finished."}' })));
  try { const room = f.groups.create(f.agents.slice(0, 2).map(agent => agent.id)); const accepted = f.groups.accept(room.id, 'Keep going', undefined, undefined, 'continuous'); const run = await finished(f.groups, accepted.run.id); assert.equal(run.status, 'failed'); assert.match(run.error!, /only the user can stop/); assert.equal(run.completedReplies, 0); assert.equal(run.modelCalls, 1); } finally { await f.close(); }
  let revoke = () => {}; let calls = 0; const g = await fixture(adapters(async () => { calls++; revoke(); return { text: 'One allowed contribution.' }; }));
  try { const room = roundtable(g.groups, g.agents.slice(0, 2).map(agent => agent.id)); revoke = () => g.store.saveBilling('claude', { ...billing, confirmed: false }); const accepted = g.groups.accept(room.id, 'Keep going', undefined, undefined, 'continuous'); const run = await finished(g.groups, accepted.run.id); assert.equal(run.status, 'failed'); assert.match(run.error!, /revoked/); assert.equal(run.completedReplies, 1); assert.equal(calls, 1); } finally { await g.close(); }
});

test('continuous reconnect preserves partial output and Stop waits for cleanup without restarting the session', async () => {
  const entered = gate(); let cleaned = false;
  const f = await fixture(adapters(async (_provider, _request, emit, signal) => { emit({ type: 'delta', text: 'Actual partial contribution' }); entered.resolve(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => setTimeout(() => { cleaned = true; reject(signal.reason); }, 30), { once: true })); }));
  try {
    const room = roundtable(f.groups, f.agents.slice(0, 2).map(agent => agent.id)); const accepted = f.groups.accept(room.id, 'Keep going', undefined, undefined, 'continuous'); await entered.promise;
    const first: GroupEvent[] = []; const detach = f.groups.subscribe(accepted.run.id, event => first.push(event)); detach(); assert.equal(f.groups.active.size, 1);
    const second: GroupEvent[] = []; f.groups.subscribe(accepted.run.id, event => second.push(event)); assert.equal(second[0].type === 'snapshot' && second[0].messages.at(-1)!.content, 'Actual partial contribution');
    const cancellation = f.groups.cancel(accepted.run.id); assert.equal(cleaned, false); await cancellation; assert.equal(cleaned, true); assert.equal(second.at(-1)!.type, 'done'); assert.equal(f.store.get<GroupRun>('group-run', accepted.run.id)!.status, 'cancelled');
    const late: GroupEvent[] = []; f.groups.subscribe(accepted.run.id, event => late.push(event)); assert.deepEqual(late.map(event => event.type), ['snapshot', 'done']); assert.equal(late[0].type === 'snapshot' && late[0].run.executionMode, 'continuous'); assert.equal(late[0].type === 'snapshot' && late[0].run.maxModelCalls, null);
  } finally { await f.close(); }
});

test('continuous runs remain interrupted after restart and never resume or replay automatically', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-continuous-restart-')); let calls = 0;
  try {
    let store = new Store(dir); const agents = store.list<Agent>('agent'); const room = store.createRoom(agents.slice(0, 2).map(agent => agent.id), 'Continuous discussion', 'moderated', agents[0].id); const runId = id();
    store.put<GroupRun>('group-run', { id: runId, roomId: room.id, status: 'running', executionMode: 'continuous', mode: 'moderated', moderatorAgentId: agents[0].id, moderatorCalls: 20, phase: 'reply', rounds: 0, completedReplies: 19, totalReplies: null, modelCalls: 40, maxModelCalls: null, maxSeconds: null, currentAgentId: agents[1].id, error: null, startedAt: now(), endedAt: null });
    store.put<GroupMessage>('group-message', { id: id(), roomId: room.id, runId, role: 'assistant', agentId: agents[1].id, authorName: agents[1].name, content: 'Actual unfinished content', createdAt: now(), status: 'streaming', route: null }); store.close();
    store = new Store(dir); const runs = new Runs(store, adapters(async () => { calls++; return { text: 'Must not replay' }; })); const groups = new Groups(store, runs);
    const interrupted = store.get<GroupRun>('group-run', runId)!; assert.equal(interrupted.status, 'interrupted'); assert.equal(interrupted.phase, null); assert.equal(interrupted.executionMode, 'continuous'); assert.equal(interrupted.maxSeconds, null); assert.equal(groups.active.size, 0); assert.equal(calls, 0); assert.equal(store.groupMessages(room.id)[0].status, 'error');
    await groups.close(); await runs.close(); store.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('mandatory quote-heavy group context fails before inference when actual wire cannot fit without losing saved input',async()=>{let calls=0;const f=await fixture(adapters(async()=>{calls++;return{text:'Must not dispatch'};}));try{const ids=f.agents.slice(0,2).map(agent=>agent.id);for(const agent of f.agents.slice(0,2))f.store.put('file',{id:id(),agentId:agent.id,name:'private.txt',content:'p'.repeat(55000),size:55000,createdAt:now()});const room=roundtable(f.groups,ids),raw=String.fromCharCode(34,92,10,1).repeat(4000),stamp=now();const topic=f.store.put<GroupMessage>('group-message',{id:id(),roomId:room.id,runId:null,role:'user',agentId:null,authorName:'You',content:'ORIGINAL_HUMAN_TOPIC',createdAt:stamp,status:'complete',route:null}),reply=f.store.put<GroupMessage>('group-message',{id:id(),roomId:room.id,runId:null,role:'assistant',agentId:ids[0],authorName:'Peer',content:raw,createdAt:stamp,status:'complete',route:null});const accepted=f.groups.accept(room.id,undefined,undefined,undefined,'continuous'),run=await finished(f.groups,accepted.run.id);assert.equal(run.status,'failed');assert.equal(calls,0);assert.equal(f.store.get<GroupMessage>('group-message',topic.id)?.content,topic.content);assert.equal(f.store.get<GroupMessage>('group-message',reply.id)?.content,raw);}finally{await f.close();}});
