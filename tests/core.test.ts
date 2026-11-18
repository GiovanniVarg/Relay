import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createApp } from '../server/index.js';
import { Store, id, now, PROVIDER_IDS } from '../server/store.js';
import { Runs } from '../server/runs.js';
import { contextWireCharacters } from '../server/context-wire.js';
import { chooseRoute, dynamicAutoModel, escalation, permitted } from '../server/router.js';
import { Security, validPort } from '../server/security.js';
import type { Agent, Bootstrap, Message, ProviderAdapter, ProviderConnection, ProviderId, ProviderRequest, ProviderState, Run, RunEvent } from '../shared/types.js';

const included = { mode: 'included' as const, confirmed: true, automaticRouting: true, allowanceNote: 'Confirmed in provider account' };
const allModels = { defaultModel: '', allowedModels: null };
const confirmation = (provider: ProviderId, config = included) => ({ ...config, expectedAccount: { accountLabel: connection(provider).accountLabel, plan: connection(provider).plan } });
function connection(provider: ProviderId): ProviderConnection { return { id: provider, installed: true, authenticated: true, authMode: 'subscription', accountLabel: 'Test subscription', plan: 'Test', models: (provider === 'openai' ? ['gpt-6-luna', 'gpt-6-astra'] : provider === 'claude' ? ['claude-sonnet-test'] : ['cursor-fixed-test', 'auto']).map(id => ({ id, name: id, verified: false })) }; }
function adapters(handler?: (provider: ProviderId, request: ProviderRequest, emit: Parameters<ProviderAdapter['stream']>[1], signal: AbortSignal) => ReturnType<ProviderAdapter['stream']>): Record<ProviderId, ProviderAdapter> {
  return Object.fromEntries(PROVIDER_IDS.map(provider => [provider, { id: provider, inspect: async () => connection(provider), login: async () => ({ message: 'Test login' }), close: async () => {}, stream: async (request: ProviderRequest, emit: Parameters<ProviderAdapter['stream']>[1], signal: AbortSignal) => { if (handler) return handler(provider, request, emit, signal); emit({ type: 'delta', text: 'Actual ' }); emit({ type: 'delta', text: 'test output' }); return { text: 'Actual test output', actualModel: request.model }; } }])) as Record<ProviderId, ProviderAdapter>;
}
async function fixture(custom = adapters()) {
  const dir = await mkdtemp(join(tmpdir(), 'relay-test-')); const client = join(dir, 'client'); await mkdir(client); await writeFile(join(client, 'index.html'), '<!doctype html><title>Relay</title>');
  const app = createApp({ dataDir: join(dir, 'data'), adapters: custom, clientDir: client, port: 0 }); for (const agent of app.store.list<Agent>('agent')) app.store.put('agent', { ...agent, mode: 'chat' }); const port = await app.listen(0); const base = `http://127.0.0.1:${port}`;
  const initial = await fetch(`${base}/api/bootstrap`); const cookie = initial.headers.get('set-cookie')!.split(';')[0]; const bootstrap = await initial.json() as Bootstrap;
  const request = async (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => fetch(base + path, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': bootstrap.csrfToken, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { app, base, dir, cookie, bootstrap, request, async close() { await app.close(); await rm(dir, { recursive: true, force: true }); } };
}
async function runFixture(custom = adapters()) { const dir = await mkdtemp(join(tmpdir(), 'relay-runs-')); const store = new Store(dir); const runs = new Runs(store, custom); await runs.refresh(); store.saveBilling('openai', included); store.saveBilling('claude', included); const agent = store.put<Agent>('agent', { ...store.list<Agent>('agent')[0], mode: 'chat' }); const conversation = store.conversations(agent.id)[0]; return { store, runs, agent, conversation, async close() { await runs.close(); store.close(); await rm(dir, { recursive: true, force: true }); } }; }
async function finished(runs: Runs, runId: string) { const active = runs.active.get(runId); if (active) await active.promise; return runs.store.get<Run>('run', runId)!; }

test('HTTP security blocks hostile Host, origins, fetch metadata, missing session and CSRF before any model call', async () => {
  let calls = 0; const f = await fixture(adapters(async () => { calls++; return { text: 'should not run' }; }));
  try {
    assert.equal((await fetch(f.base + '/api/bootstrap', { headers: { Origin: 'https://attacker.example' } })).status, 403);
    assert.equal((await fetch(f.base + '/api/bootstrap', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    const hostileHost = await new Promise<number | undefined>((resolve, reject) => { const request = httpRequest(f.base + '/api/bootstrap', { headers: { Host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); }); request.on('error', reject); request.end(); });
    assert.equal(hostileHost, 403);
    assert.equal((await fetch(f.base + '/api/agents/' + f.bootstrap.agents[0].id)).status, 401);
    assert.equal((await f.request('/api/settings', 'PATCH', { maxRunSeconds: 30 }, { 'X-CSRF-Token': '' })).status, 403);
    assert.equal((await f.request('/api/settings', 'PATCH', { maxRunSeconds: 30 }, { 'X-CSRF-Token': 'é'.repeat(64) })).status, 403);
    assert.equal((await f.request('/api/settings', 'PATCH', { maxRunSeconds: 30 }, { Origin: `http://localhost:${f.app.security.port}` })).status, 403);
    assert.equal((await f.request('/api/settings', 'PATCH', { maxRunSeconds: 30 }, { 'Sec-Fetch-Site': 'same-site' })).status, 403);
    assert.equal((await f.request('/api/settings', 'PATCH', { maxRunSeconds: 30 }, { Origin: f.base, 'Sec-Fetch-Site': 'same-origin' })).status, 200);
    assert.equal((await f.request('/.data/relay.sqlite')).status, 404);
    assert.equal(calls, 0);
    const cookie = (await fetch(f.base + '/api/bootstrap')).headers.get('set-cookie')!; assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
  } finally { await f.close(); }
});

test('CRUD persists agent memory, conversations, text files and settings; all schemas reject invalid fields', async () => {
  const f = await fixture();
  try {
    assert.equal(f.bootstrap.agents.length, 5); assert.equal(f.bootstrap.conversations.length, 5);
    assert.equal(f.app.store.list<Message>('message').length, 0);
    const created = await f.request('/api/agents', 'POST', { name: 'Test', role: 'Engineer', instructions: 'Be exact' }); assert.equal(created.status, 201); const agent = await created.json() as Agent;
    assert.equal((await f.request(`/api/agents/${agent.id}`, 'PATCH', { memory: 'Durable fact', pinned: true })).status, 200);
    assert.equal((await f.request(`/api/agents/${agent.id}`, 'PATCH', { id: 'overwrite' })).status, 400);
    const conversation = await (await f.request(`/api/agents/${agent.id}/conversations`, 'POST', { title: 'Task' })).json() as { id: string };
    assert.equal((await f.request(`/api/conversations/${conversation.id}`)).status, 200);
    const file = await (await f.request(`/api/agents/${agent.id}/files`, 'POST', { name: 'notes.txt', content: 'Relevant source' })).json() as { id: string };
    const details = await (await f.request(`/api/agents/${agent.id}`)).json() as { agent: Agent; files: unknown[] }; assert.equal(details.agent.memory, 'Durable fact'); assert.equal(details.files.length, 1);
    assert.equal((await f.request(`/api/agents/${agent.id}/files/${file.id}`, 'DELETE')).status, 200);
    assert.equal((await f.request(`/api/agents/${agent.id}/files`, 'POST', { name: 'large.txt', content: 'é'.repeat(100001) })).status, 413);
    assert.equal((await f.request('/api/settings', 'PATCH', { maxModelCalls: 4 })).status, 400);
    assert.equal((await f.request('/api/settings', 'PATCH', { maxRunSeconds: 301 })).status, 400);
    assert.equal((await f.request('/api/settings', 'PATCH', { maxRunSeconds: 60, maxModelCalls: 2 })).status, 200);
    const other = new Store(join(f.dir, 'data')); assert.equal(other.get<Agent>('agent', agent.id)?.memory, 'Durable fact'); assert.equal(other.settings().maxRunSeconds, 60); other.close();
  } finally { await f.close(); }
});

test('manual sends require actual subscription auth and confirmed known billing; unsupported models never execute', async () => {
  let calls = 0; const custom = adapters(async () => { calls++; return { text: 'reply' }; }); const f = await fixture(custom);
  try {
    const path = `/api/conversations/${f.bootstrap.conversations[0].id}/messages`; const body = { content: 'Hi', routeMode: 'claude' };
    assert.equal((await f.request(path, 'POST', body)).status, 400);
    assert.equal((await f.request('/api/providers/claude/billing', 'PATCH', confirmation('claude'))).status, 200);
    custom.claude.inspect = async () => ({ ...connection('claude'), authMode: 'api-key' });
    assert.equal((await f.request(path, 'POST', body)).status, 400);
    custom.claude.inspect = async () => ({ ...connection('claude'), authMode: 'unknown' }); assert.equal((await f.request(path, 'POST', body)).status, 400);
    custom.claude.inspect = async () => connection('claude'); assert.equal((await f.request(path, 'POST', { ...body, model: 'invented' })).status, 400);
    assert.equal(calls, 0); assert.equal(f.app.store.list<Message>('message').length, 0);
    assert.equal(permitted({ ...connection('openai'), modelPreferences: allModels, billing: { ...included, mode: 'unknown' } }, false), false);
    assert.equal(permitted({ ...connection('openai'), modelPreferences: allModels, billing: { ...included, automaticRouting: false } }, true), false);
  } finally { await f.close(); }
});

test('streaming persists exact deltas; late SSE receives the same single response and terminal status', async () => {
  const f = await fixture();
  try {
    await f.request('/api/providers/openai/billing', 'PATCH', confirmation('openai'));
    const response = await f.request(`/api/conversations/${f.bootstrap.conversations[0].id}/messages`, 'POST', { content: 'Hello', routeMode: 'openai', model: 'gpt-6-luna' }); assert.equal(response.status, 202);
    const { run } = await response.json() as { run: Run }; assert.equal((await finished(f.app.runs, run.id)).status, 'complete');
    const text = await (await f.request(`/api/runs/${run.id}/events`)).text(); const events = text.split('\n').filter(s => s.startsWith('data: ')).map(s => JSON.parse(s.slice(6)) as RunEvent);
    assert.equal(events.filter(e => e.type === 'done').length, 1); assert.equal(events.filter(e => e.type === 'delta').map(e => e.type === 'delta' ? e.text : '').join(''), 'Actual test output');
    assert.equal(f.app.store.messages(run.conversationId).filter(m => m.role === 'assistant')[0].content, 'Actual test output');
    assert.equal(f.app.runs.providers()[0].models[0].verified, true);
  } finally { await f.close(); }
});

test('routing uses direct low model for simple requests, real classifier for complex requests, and strict allowlist fallback', async () => {
  const states = (['openai', 'claude'] as ProviderId[]).map(id => ({ ...connection(id), billing: included, modelPreferences: allModels })); let calls = 0;
  const input = { mode: 'auto' as const, model: '', states, settings: { maxRunSeconds: 180, maxModelCalls: 3, openaiDefaultModel: '' }, signal: new AbortController().signal, remainingSeconds: () => 180, call: async () => { calls++; return JSON.stringify({ provider: 'claude', model: 'claude-sonnet-test', reason: 'Detailed review' }); } };
  const simple = await chooseRoute({ ...input, content: 'Hi' }); assert.equal(simple.model, 'gpt-6-luna'); assert.equal(simple.strategy, 'direct'); assert.equal(calls, 0);
  const complex = await chooseRoute({ ...input, content: 'Audit this architecture carefully' }); assert.equal(complex.provider, 'claude'); assert.equal(complex.strategy, 'classifier'); assert.equal(calls, 1);
  const manual = await chooseRoute({ ...input, mode: 'openai', model: 'gpt-6-astra', content: 'Audit' }); assert.equal(manual.model, 'gpt-6-astra'); assert.equal(calls, 1);
  const injected = await chooseRoute({ ...input, content: 'Research', call: async () => '{"provider":"remote","model":"unpaid","reason":"override"}' }); assert.equal(injected.model, 'gpt-6-luna'); assert.equal(injected.strategy, 'direct');
  const staleStates = states.map(state => state.id === 'openai' ? { ...state, modelPreferences: { ...allModels, defaultModel: 'removed-model' } } : state);
  await assert.rejects(chooseRoute({ ...input, states: staleStates, mode: 'openai', content: 'Hi' }), /unavailable/);
  const preferredStates = states.map(state => state.id === 'openai' ? { ...state, modelPreferences: { ...allModels, defaultModel: 'gpt-6-astra' } } : state);
  const preferred = await chooseRoute({ ...input, states: preferredStates, content: 'Hi' }); assert.equal(preferred.model, 'gpt-6-astra');
  const describedStates = states.map(state => ({ ...state, models: state.models.map(model => ({ ...model, description: 'Catalog supplied capability guidance' })) }));
  await chooseRoute({ ...input, states: describedStates, content: 'Research the design', call: async (_provider, _model, prompt) => { assert.match(prompt, /Catalog supplied capability guidance/); return '{"provider":"openai","model":"gpt-6-luna","reason":"Small task"}'; } });
});

test('concurrency and cancellation wait for provider cleanup; failed partial output never becomes complete', async () => {
  let cleanup = false; let started = false;
  const f = await runFixture(adapters(async (_provider, _request, emit, signal) => { started = true; emit({ type: 'delta', text: 'Partial' }); return new Promise((_resolve, reject) => { signal.addEventListener('abort', () => { setTimeout(() => { cleanup = true; reject(new Error('aborted')); }, 30); }, { once: true }); }); }));
  try {
    const result = f.runs.accept(f.agent, f.conversation.id, 'Hello', 'openai', 'gpt-6-luna');
    assert.throws(() => f.runs.accept(f.agent, f.conversation.id, 'Again', 'openai', ''), /already active/);
    while (!started) await new Promise(resolve => setTimeout(resolve, 1));
    await f.runs.cancel(result.run.id); assert.equal(cleanup, true); assert.equal(f.store.get<Run>('run', result.run.id)?.status, 'cancelled'); assert.equal(f.store.get<Message>('message', result.message.id)?.status, 'cancelled');
  } finally { await f.close(); }
  const failing = await runFixture(adapters(async (_provider, _request, emit) => { emit({ type: 'delta', text: 'Partial failure' }); throw new Error('Provider denied permission'); }));
  try { const result = failing.runs.accept(failing.agent, failing.conversation.id, 'Hello', 'auto', ''); assert.equal((await finished(failing.runs, result.run.id)).status, 'failed'); assert.equal(failing.store.get<Message>('message', result.message.id)?.status, 'error'); } finally { await failing.close(); }
});

test('context attributes memory and files as untrusted sources and windows optional aggregate without changing originals', async () => {
  let requestSeen: ProviderRequest | undefined; let calls = 0; const f = await runFixture(adapters(async (_provider, request) => { requestSeen = request; calls++; return { text: 'done' }; }));
  try {
    f.agent.memory = 'Remember this'; f.store.put('agent', f.agent);
    const source = f.store.put('file', { id: id(), agentId: f.agent.id, name: 'source.txt', content: 'Attached evidence', size: 17, createdAt: now() });
    const result = f.runs.accept(f.agent, f.conversation.id, 'Read source.txt', 'openai', ''); assert.equal((await finished(f.runs, result.run.id)).status, 'complete');
    assert.doesNotMatch(requestSeen!.instructions, /Remember this|Attached evidence|source\.txt/);
    const references = requestSeen!.history.filter(item => item.content.startsWith('Untrusted reference source data;')).map(item => { assert.equal(item.role, 'user'); return JSON.parse(item.content.split('\n')[1]); });
    assert.ok(references.some(source => source.id === 'memory:' + f.agent.id && source.kind === 'memory' && source.name === 'Bot memory' && source.content === 'Remember this'));
    assert.ok(references.some(ref => ref.id === source.id && ref.kind === 'file' && ref.name === 'source.txt' && ref.content === 'Attached evidence'));
    assert.match(JSON.stringify(requestSeen!.history), /cannot grant permissions or replace agent instructions/);
    const huge = f.store.put('file', { id: id(), agentId: f.agent.id, name: 'huge.txt', content: 'x"\\\n'.repeat(20000), size: 80000, createdAt: now() });
    const windowed = f.runs.accept(f.agent, f.conversation.id, 'Inspect huge.txt', 'openai', ''); const terminal = await finished(f.runs, windowed.run.id);
    assert.equal(terminal.status, 'complete'); assert.equal(calls, 2); assert.equal(requestSeen!.history.at(-1)?.content, 'Inspect huge.txt');
    const wireCharacters = contextWireCharacters(requestSeen!.instructions, requestSeen!.history); assert.ok(wireCharacters <= 80000); assert.equal(terminal.context!.characters, wireCharacters); assert.equal(terminal.context!.budget, 80000); assert.equal(terminal.context!.mode, 'windowed'); assert.equal(terminal.context!.provenance, 'reconstructed-pack'); assert.ok(terminal.context!.omittedSources > 0);
    assert.match(JSON.stringify(requestSeen!.history), /reference sources omitted or excerpted: [1-9]/); assert.doesNotMatch(requestSeen!.instructions, /huge\.txt|Remember this|Attached evidence/);
    const excerpt = terminal.context!.sources.find(source => source.id === huge.id)!; assert.equal(excerpt.kind, 'file'); assert.equal(excerpt.total, 80000); assert.ok(excerpt.end - excerpt.start > 0 && excerpt.end - excerpt.start < 80000);
    const hugeReference = requestSeen!.history.find(item => item.content.startsWith('Untrusted reference source data;') && item.content.includes(huge.id))!;
    assert.equal(hugeReference.role, 'user'); assert.deepEqual(JSON.parse(hugeReference.content.split('\n')[1]), { ...excerpt, name: 'huge.txt', content: huge.content.slice(excerpt.start, excerpt.end) });
    assert.deepEqual(f.store.files(f.agent.id).find(file => file.id === huge.id), huge); assert.deepEqual(f.store.files(f.agent.id).find(file => file.id === source.id), source); assert.equal(f.store.get<Agent>('agent', f.agent.id)!.memory, 'Remember this');
    const before = f.store.messages(f.conversation.id);
    f.store.put('agent', { ...f.agent, instructions: 'mandatory'.repeat(10000) });
    assert.throws(() => f.runs.accept(f.agent, f.conversation.id, 'Hello', 'openai', ''), /Required agent instructions and current request exceed the 80,000/);
    f.store.put('agent', f.agent);
    assert.throws(() => f.runs.accept(f.agent, f.conversation.id, 'current'.repeat(12000), 'openai', ''), /Required agent instructions and current request exceed the 80,000/);
    assert.equal(calls, 2); assert.deepEqual(f.store.messages(f.conversation.id), before);
  } finally { await f.close(); }
});

test('only one transient execution escalation is allowed; policy failure never escalates and wrong actual model fails', async () => {
  const seen: ProviderId[] = []; const f = await runFixture(adapters(async (provider, request) => { seen.push(provider); if (provider === 'openai') throw new Error('Temporarily overloaded'); return { text: 'recovered', actualModel: request.model }; }));
  try { const result = f.runs.accept(f.agent, f.conversation.id, 'Hello', 'auto', ''); assert.equal((await finished(f.runs, result.run.id)).status, 'complete'); assert.deepEqual(seen, ['openai', 'claude']); } finally { await f.close(); }
  const denied: ProviderId[] = []; const g = await runFixture(adapters(async provider => { denied.push(provider); throw new Error('Authentication policy denied'); }));
  try { const result = g.runs.accept(g.agent, g.conversation.id, 'Hi', 'auto', ''); assert.equal((await finished(g.runs, result.run.id)).status, 'failed'); assert.deepEqual(denied, ['openai']); } finally { await g.close(); }
  const h = await runFixture(adapters(async () => ({ text: 'wrong model', actualModel: 'unsupported' })));
  try { const result = h.runs.accept(h.agent, h.conversation.id, 'Hi', 'openai', ''); assert.equal((await finished(h.runs, result.run.id)).status, 'failed'); } finally { await h.close(); }
});

test('classifier shares the three-call budget with execution and one eligible escalation', async () => {
  const seen: { provider: ProviderId; classifier: boolean }[] = [];
  const f = await runFixture(adapters(async (provider, request) => {
    assert.deepEqual(request.expectedAccount, { accountLabel: connection(provider).accountLabel, plan: connection(provider).plan });
    const classifier = request.conversationId.startsWith('route-'); seen.push({ provider, classifier });
    if (classifier) return { text: JSON.stringify({ provider: 'openai', model: 'gpt-6-astra', reason: 'Complex architecture' }), actualModel: request.model };
    if (provider === 'openai') throw new Error('Temporary capacity limit');
    return { text: 'Recovered after the only fallback', actualModel: request.model };
  }));
  try {
    const result = f.runs.accept(f.agent, f.conversation.id, 'Audit this architecture', 'auto', ''); assert.equal((await finished(f.runs, result.run.id)).status, 'complete');
    assert.deepEqual(seen, [{ provider: 'openai', classifier: true }, { provider: 'openai', classifier: false }, { provider: 'claude', classifier: false }]);
  } finally { await f.close(); }
});

test('message acceptance reloads edits saved during provider inspection and preserves the latest agent profile', async () => {
  let releaseInspection!: () => void; let inspectionStarted!: () => void;
  const inspectionEntered = new Promise<void>(resolve => { inspectionStarted = resolve; }); const inspectionGate = new Promise<void>(resolve => { releaseInspection = resolve; });
  let requestSeen: ProviderRequest | undefined;
  const custom = adapters(async (_provider, request) => { requestSeen = request; return { text: 'Confirmed updated instructions', actualModel: request.model }; });
  let delayInspection = false;
  custom.openai.inspect = async () => { if (delayInspection) { inspectionStarted(); await inspectionGate; } return connection('openai'); };
  const f = await fixture(custom);
  try {
    await f.request('/api/providers/openai/billing', 'PATCH', confirmation('openai'));
    delayInspection = true;
    const agent = f.bootstrap.agents[0]; const conversation = f.bootstrap.conversations.find(c => c.agentId === agent.id)!;
    const pending = f.request(`/api/conversations/${conversation.id}/messages`, 'POST', { content: 'Hello after refresh' });
    await inspectionEntered;
    const edit = { name: 'Edited while inspecting', instructions: 'Use the newly saved instructions', memory: 'New memory', pinned: true, role: 'Updated role', routeMode: 'openai', model: 'gpt-6-astra' };
    assert.equal((await f.request(`/api/agents/${agent.id}`, 'PATCH', edit)).status, 200);
    releaseInspection(); const accepted = await pending; assert.equal(accepted.status, 202); const result = await accepted.json() as { run: Run };
    const terminal = await finished(f.app.runs, result.run.id); assert.equal(terminal.status, 'complete'); assert.equal(terminal.route?.strategy, 'manual'); assert.equal(terminal.route?.model, 'gpt-6-astra');
    const saved = f.app.store.get<Agent>('agent', agent.id)!;
    for (const [key, value] of Object.entries(edit)) assert.equal((saved as unknown as Record<string, unknown>)[key], value);
    assert.equal(saved.lastMessage, 'Hello after refresh'); assert.match(requestSeen!.instructions, /newly saved instructions/); assert.doesNotMatch(requestSeen!.instructions, /New memory/);
    const memoryReference = requestSeen!.history.find(item => item.content.startsWith('Untrusted reference source data;') && item.content.includes('New memory'))!;
    assert.equal(memoryReference.role, 'user'); assert.deepEqual(JSON.parse(memoryReference.content.split('\n')[1]), { id: 'memory:' + agent.id, name: 'Bot memory', kind: 'memory', start: 0, end: 10, total: 10, content: 'New memory' });
    assert.deepEqual(requestSeen!.expectedAccount, { accountLabel: connection('openai').accountLabel, plan: connection('openai').plan });
  } finally { releaseInspection(); await f.close(); }
});

test('login is rejected while provider work is active', async () => {
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }); let loginCalls = 0;
  const custom = adapters(async (_provider, _request, _emit, signal) => { entered(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); });
  custom.claude.login = async () => { loginCalls++; return { message: 'Must not launch' }; };
  const f = await fixture(custom);
  try {
    await f.request('/api/providers/openai/billing', 'PATCH', confirmation('openai'));
    const response = await f.request(`/api/conversations/${f.bootstrap.conversations[0].id}/messages`, 'POST', { content: 'Hello', routeMode: 'openai' }); const { run } = await response.json() as { run: Run }; await started;
    assert.equal((await f.request('/api/providers/claude/login', 'POST', {})).status, 409); assert.equal(loginCalls, 0);
    assert.equal((await f.request(`/api/runs/${run.id}/cancel`, 'POST', {})).status, 200);
  } finally { await f.close(); }
});

test('refresh isolates provider errors and never performs inference', async () => {
  let sends = 0; const custom = adapters(async () => { sends++; return { text: 'unused' }; });
  custom.openai.inspect = async () => { throw new Error('CLI unavailable'); }; const f = await runFixture(custom);
  try { const states = await f.runs.refresh(); assert.match(states[0].error!, /CLI unavailable/); assert.equal(states[1].authenticated, true); assert.equal(sends, 0); } finally { await f.close(); }
});

test('refresh is single-flight and a positively changed account requires billing reconfirmation', async () => {
  let inspections = 0; const custom = adapters(); let label = 'First account';
  custom.openai.inspect = async () => { inspections++; await new Promise(resolve => setTimeout(resolve, 10)); return { ...connection('openai'), accountLabel: label }; };
  const f = await runFixture(custom);
  try {
    f.store.put('verified', { id: 'openai:gpt-6-luna' });
    const before = inspections; await Promise.all([f.runs.refresh(), f.runs.refresh(), f.runs.refresh()]); assert.equal(inspections - before, 1); assert.equal(f.store.billing('openai').confirmed, true);
    label = 'Different account'; const states = await f.runs.refresh(); assert.equal(states[0].billing.confirmed, false); assert.equal(states[0].billing.automaticRouting, false); assert.equal(states[0].models[0].verified, false);
    assert.throws(() => f.runs.accept(f.agent, f.conversation.id, 'Hi', 'openai', ''), /confirm its billing/);
  } finally { await f.close(); }
});

test('restart marks unfinished runs interrupted and assistant error without inference or replay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-restart-'));
  try {
    let store = new Store(dir); const agent = store.list<Agent>('agent')[0]; const conversation = store.conversations(agent.id)[0]; const runId = id(); const messageId = id();
    store.put<Message>('message', { id: messageId, conversationId: conversation.id, role: 'assistant', content: 'Partial saved text', createdAt: now(), runId, status: 'streaming' });
    store.put<Run>('run', { id: runId, agentId: agent.id, conversationId: conversation.id, messageId, status: 'running', route: null, error: null, startedAt: now(), endedAt: null, usage: null }); store.close(); store = new Store(dir);
    assert.equal(store.get<Run>('run', runId)?.status, 'interrupted'); assert.equal(store.get<Message>('message', messageId)?.status, 'error'); assert.equal(store.get<Message>('message', messageId)?.content, 'Partial saved text'); store.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('port parsing rejects invalid listen settings', () => { for (const value of ['0', '-1', '3210x', '65536', '3.2', '']) assert.throws(() => validPort(value)); assert.equal(validPort('3210'), 3210); });

test('subscription model preferences API validates exact provider catalog and persists independently of billing', async () => {
  let calls = 0; const custom = adapters(async () => { calls++; return { text: 'unused' }; }); const f = await fixture(custom);
  try {
    assert.deepEqual(f.bootstrap.providers.filter(provider => provider.id !== 'opencode').map(provider => provider.modelPreferences), [allModels, allModels, { defaultModel: '', allowedModels: [] }]);
    assert.deepEqual(f.bootstrap.providers.find(provider => provider.id === 'opencode')!.modelPreferences, { defaultModel: '', allowedModels: [] });
    const path = '/api/providers/openai/models';
    for (const body of [
      { defaultModel: '', allowedModels: ['gpt-6-luna', 'gpt-6-luna'] },
      { defaultModel: '', allowedModels: ['claude-sonnet-test'] },
      { defaultModel: 'unknown', allowedModels: null },
      { defaultModel: 'gpt-6-astra', allowedModels: ['gpt-6-luna'] },
      { defaultModel: '', allowedModels: Array.from({ length: 101 }, (_, i) => `model-${i}`) },
      { defaultModel: '', allowedModels: 'all' },
      { defaultModel: '', allowedModels: [123] },
      { defaultModel: '' }, { allowedModels: null },
      { defaultModel: '', allowedModels: null, unknown: true },
    ]) assert.equal((await f.request(path, 'PATCH', body)).status, 400, JSON.stringify(body));
    const preferences = { defaultModel: 'gpt-6-astra', allowedModels: ['gpt-6-astra'] };
    const updated = await f.request(path, 'PATCH', preferences); assert.equal(updated.status, 200); const state = await updated.json() as ProviderState; assert.deepEqual(state.modelPreferences, preferences); assert.equal(state.billing.confirmed, false);
    const refreshed = await (await f.request('/api/providers/refresh', 'POST', {})).json() as { providers: ProviderState[] }; assert.deepEqual(refreshed.providers[0].modelPreferences, preferences);
    const bootstrap = await (await f.request('/api/bootstrap')).json() as Bootstrap; assert.deepEqual(bootstrap.providers[0].modelPreferences, preferences);
    const other = new Store(join(f.dir, 'data')); assert.deepEqual(other.modelPreferences('openai'), preferences); other.close();
    custom.openai.inspect = async () => ({ ...connection('openai'), models: [{ id: 'new-catalog-model', name: 'New model', verified: false }] });
    const changed = await f.app.runs.refresh(); assert.deepEqual(changed[0].modelPreferences, preferences);
    assert.equal((await f.request(path, 'PATCH', { defaultModel: '', allowedModels: [] })).status, 200); assert.deepEqual(f.app.store.modelPreferences('openai').allowedModels, []);
    assert.equal((await f.request(path, 'PATCH', { defaultModel: '', allowedModels: null })).status, 200); assert.equal(f.app.store.modelPreferences('openai').allowedModels, null);
    assert.equal(calls, 0);
  } finally { await f.close(); }
});

test('legacy OpenAI default migrates once without overriding new preferences or silently replacing a missing model', async () => {
  const f = await runFixture();
  try {
    f.store.saveSettings({ ...f.store.settings(), openaiDefaultModel: 'gpt-6-astra' });
    assert.deepEqual(f.store.modelPreferences('openai'), { defaultModel: 'gpt-6-astra', allowedModels: null });
    const first = f.runs.accept(f.agent, f.conversation.id, 'Hi', 'openai', ''); assert.equal((await finished(f.runs, first.run.id)).route?.model, 'gpt-6-astra');
    f.store.saveSettings({ ...f.store.settings(), openaiDefaultModel: 'gpt-6-luna' }); assert.equal(f.store.modelPreferences('openai').defaultModel, 'gpt-6-astra');
    f.store.saveModelPreferences('openai', { defaultModel: '', allowedModels: ['gpt-6-luna'] });
    f.store.saveSettings({ ...f.store.settings(), openaiDefaultModel: 'removed-model' });
    assert.deepEqual(f.store.modelPreferences('openai'), { defaultModel: '', allowedModels: ['gpt-6-luna'] });
  } finally { await f.close(); }
  const missing = await runFixture();
  try {
    missing.store.saveSettings({ ...missing.store.settings(), openaiDefaultModel: 'removed-model' });
    assert.throws(() => missing.runs.accept(missing.agent, missing.conversation.id, 'Hi', 'openai', ''), /default model is unavailable/);
    assert.equal(missing.store.modelPreferences('openai').defaultModel, 'removed-model');
    const override = missing.runs.accept(missing.agent, missing.conversation.id, 'Hi', 'openai', 'gpt-6-luna'); assert.equal((await finished(missing.runs, override.run.id)).route?.model, 'gpt-6-luna');
    const automatic = missing.runs.accept(missing.agent, missing.conversation.id, 'Hi', 'auto', ''); assert.equal((await finished(missing.runs, automatic.run.id)).route?.provider, 'claude');
  } finally { await missing.close(); }
});

test('enabled models and subscription defaults constrain manual, direct, classifier invocation and classifier output', async () => {
  const seen: ProviderRequest[] = []; const f = await runFixture(adapters(async (_provider, request) => {
    seen.push(request);
    if (request.conversationId.startsWith('route-')) { assert.doesNotMatch(request.instructions, /gpt-6-luna|claude-sonnet-test/); assert.match(request.instructions, /gpt-6-astra/); return { text: '{"provider":"openai","model":"gpt-6-luna","reason":"Attempt disabled model"}', actualModel: request.model }; }
    return { text: 'Enabled model output', actualModel: request.model };
  }));
  try {
    f.store.saveModelPreferences('openai', { defaultModel: 'gpt-6-astra', allowedModels: ['gpt-6-astra'] }); f.store.saveModelPreferences('claude', { defaultModel: '', allowedModels: [] });
    assert.throws(() => f.runs.accept(f.agent, f.conversation.id, 'Hi', 'openai', 'gpt-6-luna'), /disabled/);
    const direct = f.runs.accept(f.agent, f.conversation.id, 'Hi', 'auto', ''); assert.equal((await finished(f.runs, direct.run.id)).route?.model, 'gpt-6-astra');
    const complex = f.runs.accept(f.agent, f.conversation.id, 'Audit this design', 'auto', ''); const final = await finished(f.runs, complex.run.id); assert.equal(final.status, 'complete'); assert.equal(final.route?.model, 'gpt-6-astra'); assert.equal(final.route?.strategy, 'direct');
    assert.deepEqual(seen.map(request => request.model), ['gpt-6-astra', 'gpt-6-astra', 'gpt-6-astra']);
    f.store.saveModelPreferences('openai', { defaultModel: '', allowedModels: [] });
    assert.throws(() => f.runs.accept(f.agent, f.conversation.id, 'Hi', 'openai', 'gpt-6-astra'), /disabled/);
    assert.throws(() => f.runs.accept(f.agent, f.conversation.id, 'Hi', 'auto', ''), /enabled default model/);
    assert.equal(seen.length, 3);
  } finally { await f.close(); }
});

test('fallback honors enabled model lists and defaults and skips disabled or missing-default providers', () => {
  const openai: ProviderState = { ...connection('openai'), billing: included, modelPreferences: allModels };
  const claude: ProviderState = { ...connection('claude'), models: [...connection('claude').models, { id: 'claude-opus-test', name: 'Opus', verified: false }], billing: included, modelPreferences: { defaultModel: 'claude-opus-test', allowedModels: ['claude-opus-test'] } };
  const route = { provider: 'openai' as const, model: 'gpt-6-luna', strategy: 'direct' as const, reason: 'Test' };
  assert.equal(escalation(route, [openai, claude], new Error('Temporary overload'))?.model, 'claude-opus-test');
  assert.equal(escalation(route, [openai, { ...claude, modelPreferences: { defaultModel: '', allowedModels: [] } }], new Error('Temporary overload')), undefined);
  assert.equal(escalation(route, [openai, { ...claude, modelPreferences: { defaultModel: 'removed-claude', allowedModels: null } }], new Error('Temporary overload')), undefined);
});

test('Cursor starts disabled and saves explicit subscription models with normal manual routing and persistence', async () => {
  const seen: ProviderRequest[] = []; const custom = adapters(async (_provider, request) => { seen.push(request); return { text: 'Cursor test response', actualModel: request.model }; }); const f = await fixture(custom);
  try {
    const cursor = f.bootstrap.providers.find(provider => provider.id === 'cursor')!;
    assert.deepEqual(cursor.modelPreferences, { defaultModel: '', allowedModels: [] }); assert.equal(cursor.billing.mode, 'unknown'); assert.equal(cursor.billing.confirmed, false);
    const conversation = f.bootstrap.conversations[0]; const path = `/api/conversations/${conversation.id}/messages`;
    assert.equal((await f.request(path, 'POST', { content: 'Hi', routeMode: 'cursor', model: 'cursor-fixed-test' })).status, 400);
    const preferences = { defaultModel: 'cursor-fixed-test', allowedModels: ['cursor-fixed-test'] };
    assert.equal((await f.request('/api/providers/cursor/models', 'PATCH', preferences)).status, 200);
    assert.equal((await f.request(path, 'POST', { content: 'Hi', routeMode: 'cursor' })).status, 400);
    assert.equal((await f.request('/api/providers/cursor/billing', 'PATCH', confirmation('cursor'))).status, 200);
    assert.equal((await f.request(`/api/agents/${conversation.agentId}`, 'PATCH', { routeMode: 'cursor', model: '' })).status, 200);
    const accepted = await f.request(path, 'POST', { content: 'Hi' }); assert.equal(accepted.status, 202); const { run } = await accepted.json() as { run: Run }; const terminal = await finished(f.app.runs, run.id);
    assert.equal(terminal.status, 'complete'); assert.equal(terminal.route?.provider, 'cursor'); assert.equal(terminal.route?.model, 'cursor-fixed-test');
    assert.deepEqual(seen[0].expectedAccount, { accountLabel: connection('cursor').accountLabel, plan: connection('cursor').plan });
    custom.cursor.inspect = async () => ({ ...connection('cursor'), authMode: 'api-key' });
    assert.equal((await f.request(path, 'POST', { content: 'Blocked API auth', routeMode: 'cursor' })).status, 400); assert.equal(seen.length, 1);
    const other = new Store(join(f.dir, 'data')); assert.deepEqual(other.modelPreferences('cursor'), preferences); assert.equal(other.billing('cursor').confirmed, true); other.close();
  } finally { await f.close(); }
});

test('Cursor included billing requires a fixed explicit whitelist and rejects dynamic Auto IDs and display aliases', async () => {
  let calls = 0; const custom = adapters(async (_provider, request) => { calls++; return { text: 'Metered explicit test', actualModel: request.model }; });
  custom.cursor.inspect = async () => ({ ...connection('cursor'), models: [...connection('cursor').models, { id: 'opaque-test-id', name: 'Auto (recommended)', verified: false }, { id: 'default', name: 'Default', verified: false }] });
  const f = await fixture(custom);
  try {
    const modelsPath = '/api/providers/cursor/models'; const billingPath = '/api/providers/cursor/billing'; const messagePath = `/api/conversations/${f.bootstrap.conversations[0].id}/messages`;
    assert.equal((await f.request(modelsPath, 'PATCH', { defaultModel: '', allowedModels: null })).status, 200);
    assert.equal((await f.request(billingPath, 'PATCH', confirmation('cursor'))).status, 400); assert.equal(f.app.store.billing('cursor').mode, 'unknown');
    for (const model of ['auto', 'opaque-test-id', 'default']) {
      assert.equal((await f.request(modelsPath, 'PATCH', { defaultModel: model, allowedModels: [model] })).status, 200);
      assert.equal((await f.request(billingPath, 'PATCH', confirmation('cursor'))).status, 400);
    }
    assert.equal((await f.request(modelsPath, 'PATCH', { defaultModel: '', allowedModels: ['cursor-fixed-test'] })).status, 200);
    assert.equal((await f.request(billingPath, 'PATCH', confirmation('cursor'))).status, 200);
    for (const preferences of [{ defaultModel: '', allowedModels: null }, { defaultModel: 'auto', allowedModels: ['auto'] }, { defaultModel: '', allowedModels: ['cursor-fixed-test', 'opaque-test-id'] }]) assert.equal((await f.request(modelsPath, 'PATCH', preferences)).status, 400);
    assert.equal((await f.request(messagePath, 'POST', { content: 'Hi', routeMode: 'cursor', model: 'auto' })).status, 400); assert.equal(calls, 0);
    f.app.store.saveModelPreferences('cursor', { defaultModel: '', allowedModels: null });
    assert.equal((await f.request(messagePath, 'POST', { content: 'Hi', routeMode: 'cursor', model: 'cursor-fixed-test' })).status, 400); assert.equal(calls, 0);
    assert.equal((await f.request(billingPath, 'PATCH', { ...confirmation('cursor'), mode: 'metered' })).status, 200);
    assert.equal((await f.request(modelsPath, 'PATCH', { defaultModel: 'auto', allowedModels: ['auto'] })).status, 200);
    const accepted = await f.request(messagePath, 'POST', { content: 'Hi', routeMode: 'cursor' }); assert.equal(accepted.status, 202); const { run } = await accepted.json() as { run: Run }; assert.equal((await finished(f.app.runs, run.id)).status, 'complete'); assert.equal(calls, 1);
  } finally { await f.close(); }
  for (const id of ['auto', 'AUTO-fast', 'cursor/auto', 'model-auto-selected', 'default', 'cursor/default']) assert.equal(dynamicAutoModel({ id, name: 'Model' }), true);
  assert.equal(dynamicAutoModel({ id: 'opaque', name: 'Default' }), true);
  assert.equal(dynamicAutoModel({ id: 'opaque', name: 'Auto recommended' }), true); assert.equal(dynamicAutoModel({ id: 'automation-model', name: 'Fixed model' }), false);
});

test('Cursor enabled models participate in classifier and fallback while unsafe included settings never route', async () => {
  const calls: { provider: ProviderId; model: string }[] = [];
  const f = await runFixture(adapters(async (provider, request) => {
    calls.push({ provider, model: request.model });
    if (request.conversationId.startsWith('route-')) {
      assert.match(request.instructions, /"provider":"cursor","model":"cursor-fixed-test"/); assert.doesNotMatch(request.instructions, /"model":"auto"/);
      return { text: '{"provider":"cursor","model":"cursor-fixed-test","reason":"Enabled subscription model"}', actualModel: request.model };
    }
    if (provider === 'openai') throw new Error('Temporary overload');
    return { text: 'Cursor allowed output', actualModel: request.model };
  }));
  try {
    f.store.saveBilling('cursor', included); f.store.saveModelPreferences('cursor', { defaultModel: 'cursor-fixed-test', allowedModels: ['cursor-fixed-test'] });
    f.store.saveBilling('claude', { ...included, automaticRouting: false });
    const complex = f.runs.accept(f.agent, f.conversation.id, 'Audit this design', 'auto', ''); const classified = await finished(f.runs, complex.run.id); assert.equal(classified.status, 'complete'); assert.equal(classified.route?.provider, 'cursor'); assert.equal(classified.route?.strategy, 'classifier');
    const simple = f.runs.accept(f.agent, f.conversation.id, 'Hello', 'auto', ''); const fallback = await finished(f.runs, simple.run.id); assert.equal(fallback.status, 'complete'); assert.equal(fallback.route?.provider, 'cursor');
    assert.deepEqual(calls.map(call => call.provider), ['openai', 'cursor', 'openai', 'cursor']);
    f.store.saveModelPreferences('openai', { defaultModel: '', allowedModels: [] });
    for (const unsafe of [{ defaultModel: '', allowedModels: null }, { defaultModel: 'auto', allowedModels: ['auto'] }]) {
      f.store.saveModelPreferences('cursor', unsafe);
      assert.throws(() => f.runs.accept(f.agent, f.conversation.id, 'Hi', 'auto', ''), /enabled default model/);
      assert.throws(() => f.runs.accept(f.agent, f.conversation.id, 'Hi', 'cursor', 'cursor-fixed-test'), /Cursor/);
    }
    f.store.saveModelPreferences('cursor', { defaultModel: 'cursor-fixed-test', allowedModels: ['cursor-fixed-test'] });
    f.store.saveBilling('cursor', { ...included, mode: 'unknown', confirmed: false });
    assert.throws(() => f.runs.accept(f.agent, f.conversation.id, 'Hi', 'cursor', ''), /confirm its billing/);
    assert.equal(calls.length, 4);
  } finally { await f.close(); }
});

test('subscription billing confirmation rejects stale account snapshots without confirming the replacement account', async () => {
  let calls = 0; const labels: Record<ProviderId, string> = { openai: 'Account A', claude: 'Account A', cursor: 'Account A', opencode: 'Account A', gemini: 'Account A', grok: 'Account A' };
  const custom = adapters(async () => { calls++; return { text: 'Must not run' }; });
  for (const provider of PROVIDER_IDS) custom[provider].inspect = async () => ({ ...connection(provider), accountLabel: labels[provider] });
  const f = await fixture(custom);
  try {
    await f.request('/api/providers/cursor/models', 'PATCH', { defaultModel: 'cursor-fixed-test', allowedModels: ['cursor-fixed-test'] });
    for (const provider of ['openai', 'claude', 'cursor'] as const) {
      const billingPath = `/api/providers/${provider}/billing`;
      const stale = { ...included, expectedAccount: { accountLabel: 'Account A', plan: 'Test' } };
      assert.equal((await f.request(billingPath, 'PATCH', stale)).status, 200);
      f.app.store.put('verified', { id: `${provider}:${connection(provider).models[0].id}` });
      labels[provider] = 'Account B';
      const rejected = await f.request(billingPath, 'PATCH', stale); assert.equal(rejected.status, 409, provider);
      assert.match((await rejected.json() as { error: string }).error, /account changed/);
      const persisted = f.app.store.billing(provider); assert.equal(persisted.confirmed, false); assert.equal(persisted.automaticRouting, false);
      assert.equal(f.app.store.get('verified', `${provider}:${connection(provider).models[0].id}`), undefined);
      const response = await f.request(`/api/conversations/${f.bootstrap.conversations[0].id}/messages`, 'POST', { content: 'Must be blocked', routeMode: provider }); assert.equal(response.status, 400);
      assert.equal((await f.request(billingPath, 'PATCH', { ...included, expectedAccount: { accountLabel: 'Account B', plan: 'Test' } })).status, 200);
      assert.equal(f.app.store.billing(provider).confirmed, true);
    }
    assert.equal(calls, 0); assert.equal(f.app.store.list<Message>('message').length, 0);
  } finally { await f.close(); }
});

test('billing confirmation requires strictly validated identified subscription snapshots; unconfirmed saves remain available', async () => {
  const custom = adapters(); const f = await fixture(custom);
  try {
    const path = '/api/providers/openai/billing';
    for (const body of [
      included,
      { ...included, expectedAccount: null },
      { ...included, expectedAccount: [] },
      { ...included, expectedAccount: { accountLabel: 'Test subscription' } },
      { ...included, expectedAccount: { accountLabel: '', plan: 'Test' } },
      { ...included, expectedAccount: { accountLabel: ' ', plan: 'Test' } },
      { ...included, expectedAccount: { accountLabel: 'Test subscription', plan: 123 } },
      { ...included, expectedAccount: { accountLabel: 'Test subscription', plan: 'Test', arbitrary: true } },
      { ...included, expectedAccount: { accountLabel: 'x'.repeat(501), plan: 'Test' } },
    ]) assert.equal((await f.request(path, 'PATCH', body)).status, 400, JSON.stringify(body));
    for (const overrides of [
      { authenticated: false }, { installed: false }, { authMode: 'api-key' as const }, { authMode: 'unknown' as const }, { accountLabel: '' },
    ]) {
      custom.openai.inspect = async () => ({ ...connection('openai'), ...overrides });
      assert.equal((await f.request(path, 'PATCH', confirmation('openai'))).status, 400);
      assert.equal(f.app.store.billing('openai').confirmed, false);
    }
    assert.equal((await f.request(path, 'PATCH', { ...included, confirmed: false })).status, 200);
    custom.openai.inspect = async () => connection('openai');
    assert.equal((await f.request(path, 'PATCH', confirmation('openai'))).status, 200);
    assert.equal(Object.hasOwn(f.app.store.billing('openai'), 'expectedAccount'), false);
    custom.openai.inspect = async () => ({ ...connection('openai'), plan: '' });
    assert.equal((await f.request(path, 'PATCH', { ...included, expectedAccount: { accountLabel: connection('openai').accountLabel, plan: '' } })).status, 200);
  } finally { await f.close(); }
});

test('a completed Cursor response remains a candidate when actual server model identity is unavailable', async () => {
  const f = await runFixture(adapters(async () => ({ text: 'Completed without server model attestation' })));
  try {
    f.store.saveBilling('cursor', included); f.store.saveModelPreferences('cursor', { defaultModel: 'cursor-fixed-test', allowedModels: ['cursor-fixed-test'] });
    const accepted = f.runs.accept(f.agent, f.conversation.id, 'Hello', 'cursor', ''); const run = await finished(f.runs, accepted.run.id);
    assert.equal(run.status, 'complete'); assert.equal(f.store.get('verified', 'cursor:cursor-fixed-test'), undefined);
    const model = f.runs.providers().find(state => state.id === 'cursor')!.models.find(model => model.id === 'cursor-fixed-test')!; assert.equal(model.verified, false);
  } finally { await f.close(); }
});

test('auto-route classifier failures identify chat routing and never fall through to work', async () => {
  let calls = 0;
  await assert.rejects(chooseRoute({ mode: 'auto', model: '', content: 'Audit this architecture',
    states: [{ ...connection('openai'), billing: included, modelPreferences: allModels }],
    settings: { maxRunSeconds: 180, maxModelCalls: 3, openaiDefaultModel: '' }, signal: new AbortController().signal,
    remainingSeconds: () => 180, call: async () => { calls++; throw new Error('Codex did not enforce the required sandbox (stage=chat thread/start; sandbox=readOnly; network=true; approval=never; backend=missing)'); },
  }), /Chat routing classifier failed: Codex did not enforce.*stage=chat thread\/start.*network=true/);
  assert.equal(calls, 1);
});

test('discovery-only connectors retain their catalog but cannot route or accept a prompt', async () => {
 let calls=0;const custom=adapters(async()=>{calls++;return {text:'Must not run'};});
 custom.claude.inspect=async()=>({...connection('claude'),inferenceAvailable:false,error:'This connection is temporarily unavailable for sending.'});
 const f=await fixture(custom);
 try{
  await f.app.runs.refresh();f.app.store.saveBilling('claude',included);
  const provider=f.app.runs.providers().find(p=>p.id==='claude')!;
  assert.ok(provider.authenticated);assert.ok(provider.models.length);assert.equal(provider.inferenceAvailable,false);assert.equal(permitted(provider,true),false);
  const response=await f.request(`/api/conversations/${f.bootstrap.conversations[0].id}/messages`,'POST',{content:'Test',routeMode:'claude'});
  assert.equal(response.status,400);assert.match((await response.json() as {error:string}).error,/unavailable for sending/);assert.equal(calls,0);assert.equal(f.app.store.list<Message>('message').length,0);
 } finally{await f.close();}
});
