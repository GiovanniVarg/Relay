import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.js';
import { Store, PROVIDER_IDS, id, now } from '../server/store.js';
import { chooseRoute, escalation, permitted, validateManual } from '../server/router.js';
import { createAdapters } from '../server/providers/index.js';
import type { Agent, Bootstrap, Message, ProviderAdapter, ProviderId, ProviderRequest, ProviderState, Run } from '../shared/types.js';

const allIds: ProviderId[] = ['openai', 'claude', 'cursor', 'opencode', 'gemini', 'grok'];
const activeIds = ['openai', 'claude', 'cursor', 'opencode']; const retiredIds = ['gemini', 'grok'] as const;
const nativeScope = 'a'.repeat(64);
const billing = { mode: 'included' as const, confirmed: true, automaticRouting: true, allowanceNote: 'Saved fixture' };
function state(id: ProviderId): ProviderState {
  if (id === 'opencode') return { id, installed: true, authenticated: true, authMode: 'managed', accountLabel: 'OpenCode managed profile', plan: '', connectionScope: nativeScope, nativeAgentOnly: true, models: ['fixture-a/m1', 'fixture-b/m1'].map(model => ({ id: model, name: model, local: true, verified: false })), billing: { ...billing, mode: 'local', automaticRouting: false }, modelPreferences: { defaultModel: 'fixture-a/m1', allowedModels: ['fixture-a/m1', 'fixture-b/m1'] } };
  return { id, installed: true, authenticated: true, authMode: 'subscription', accountLabel: 'Fixture', plan: 'Fixture', models: [{ id: 'm1', name: 'Fixture', verified: false }], billing, modelPreferences: { defaultModel: 'm1', allowedModels: ['m1'] } };
}
const settings = { maxRunSeconds: 30, maxWorkSeconds: 30, maxModelCalls: 3, openaiDefaultModel: '' };

test('active connection registry contains OpenAI, Claude, Cursor and OpenCode', () => { assert.deepEqual(PROVIDER_IDS, activeIds); });

test('retired states cannot become manual, automatic, classifier or fallback routes even with native permissions', async () => {
  for (const nativeAgent of [false, true]) {
    for (const provider of retiredIds) {
      const retired = state(provider);
      assert.equal(permitted(retired, false, nativeAgent), false); assert.equal(permitted(retired, true, nativeAgent), false);
      assert.throws(() => validateManual([retired], provider, 'm1', nativeAgent), /removed|retired/i);
      assert.throws(() => validateManual([retired], 'auto', '', nativeAgent), /Automatic routing/);
      assert.equal(escalation({ provider: 'openai', model: 'm1', reason: '', strategy: 'direct' }, [state('openai'), retired], new Error('Temporary network timeout')), undefined);
      let prompt = '';
      const chosen = await chooseRoute({ nativeAgent, mode: 'auto', model: '', content: 'Design this project', states: [state('openai'), retired], settings, signal: new AbortController().signal, remainingSeconds: () => 30,
        call: async (classifier, _model, instructions) => { assert.equal(classifier, 'openai'); prompt = instructions; return JSON.stringify({ provider, model: 'm1', reason: 'Stale output' }); } });
      assert.equal(chosen.provider, 'openai'); assert.equal(prompt.includes('"provider":"' + provider + '"'), false);
    }
  }
});

test('legacy bot routes migrate to Auto once without changing private configuration, history or saved provider settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-retired-migration-')); let store = new Store(join(root, 'data'));
  try {
    const agents = store.list<Agent>('agent').slice(0, 2).map((agent, i) => ({ ...agent, routeMode: retiredIds[i], model: 'saved-native-model', instructions: 'Private mission ' + i, memory: 'Private memory ' + i, workspace: 'Saved custom project ' + i, mode: 'chat' as const }));
    for (const agent of agents) store.put('agent', agent);
    const conversation = store.conversations(agents[0].id)[0]; const stamp = now(), runId = id();
    const message: Message = { id: id(), conversationId: conversation.id, role: 'assistant', content: 'Historical private response', runId, status: 'complete', createdAt: stamp };
    const run: Run = { id: runId, agentId: agents[0].id, conversationId: conversation.id, messageId: message.id, status: 'complete', route: { provider: 'grok', model: 'saved-native-model', reason: 'Historical choice', strategy: 'manual' }, error: null, startedAt: stamp, endedAt: stamp, usage: null, mode: 'agent' };
    store.put('message', message); store.put('run', run);
    for (const provider of retiredIds) { store.saveBilling(provider, billing); store.saveModelPreferences(provider, { defaultModel: 'saved-native-model', allowedModels: ['saved-native-model'] }); store.put('verified', { id: provider + ':saved-native-model' }); }
    store.saveModelPreferences('cursor', { defaultModel: 'grok-covered-by-cursor', allowedModels: ['grok-covered-by-cursor'] });
    const privateFile = join(root, 'data', 'grok', 'home', '.grok', 'auth.json'); await mkdir(join(root, 'data', 'grok', 'home', '.grok'), { recursive: true }); await writeFile(privateFile, 'private fixture bytes');
    store.remove('config', 'retired-connections-v1'); store.close(); store = new Store(join(root, 'data'));
    for (const agent of agents) assert.deepEqual(store.get<Agent>('agent', agent.id), { ...agent, routeMode: 'auto', model: '' });
    assert.deepEqual(store.get('message', message.id), message); assert.deepEqual(store.get('run', runId), run);
    for (const provider of retiredIds) { assert.deepEqual(store.billing(provider), billing); assert.deepEqual(store.modelPreferences(provider), { defaultModel: 'saved-native-model', allowedModels: ['saved-native-model'] }); assert.ok(store.get('verified', provider + ':saved-native-model')); }
    assert.deepEqual(store.modelPreferences('cursor'), { defaultModel: 'grok-covered-by-cursor', allowedModels: ['grok-covered-by-cursor'] }); assert.equal(await readFile(privateFile, 'utf8'), 'private fixture bytes');
    const chosen = { ...store.get<Agent>('agent', agents[0].id)!, routeMode: 'cursor' as const, model: 'grok-covered-by-cursor' }; store.put('agent', chosen); store.close(); store = new Store(join(root, 'data')); assert.deepEqual(store.get('agent', chosen.id), chosen);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('retired connection endpoints and route overrides reject before inspection, login, model calls or settings changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-retired-api-')); const calls: string[] = [];
  const adapters = Object.fromEntries(allIds.map(provider => [provider, { id: provider, inspect: async () => { calls.push('inspect:' + provider); return state(provider); }, login: async () => { calls.push('login:' + provider); return { message: 'Must not login' }; }, close: async () => {}, stream: async () => { calls.push('stream:' + provider); return { text: 'Must not run' }; } } satisfies ProviderAdapter])) as unknown as Record<ProviderId, ProviderAdapter>;
  const app = createApp({ dataDir: join(root, 'data'), port: 0, adapters }); const port = await app.listen(0); const base = `http://127.0.0.1:${port}`;
  try {
    await app.runs.refresh(); assert.deepEqual(calls.sort(), activeIds.map(provider => 'inspect:' + provider).sort()); calls.length = 0;
    // A stale process-local snapshot is filtered too, before it enters bootstrap.
    app.runs.states.push(state('gemini'), state('grok'));
    const initial = await fetch(base + '/api/bootstrap'); const cookie = initial.headers.get('set-cookie')!.split(';')[0]; const boot = await initial.json() as Bootstrap;
    assert.deepEqual(boot.providers.map(provider => provider.id), activeIds);
    const native = boot.providers.find(provider => provider.id === 'opencode')!;
    assert.equal(native.authMode, 'managed'); assert.equal(native.connectionScope, nativeScope); assert.equal(native.nativeAgentOnly, true);
    assert.deepEqual(native.models.map(model => model.id), ['fixture-a/m1', 'fixture-b/m1']); assert.ok(native.models.every(model => model.verified === false)); assert.equal(native.billing.confirmed, false);
    const request = (path: string, method: string, body: unknown) => fetch(base + '/api' + path, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': boot.csrfToken }, body: JSON.stringify(body) });
    for (const provider of retiredIds) {
      app.store.saveBilling(provider, billing); const preferences = { defaultModel: 'saved', allowedModels: ['saved'] }; app.store.saveModelPreferences(provider, preferences);
      for (const action of ['login', 'models', 'billing']) assert.equal((await request('/providers/' + provider + '/' + action, action === 'login' ? 'POST' : 'PATCH', {})).status, 404);
      assert.equal((await request('/agents/' + boot.agents[0].id, 'PATCH', { routeMode: provider, model: 'saved' })).status, 400);
      assert.equal((await request('/conversations/' + boot.conversations[0].id + '/messages', 'POST', { content: 'No execution', routeMode: provider, mode: 'agent' })).status, 400);
      assert.deepEqual(app.store.billing(provider), billing); assert.deepEqual(app.store.modelPreferences(provider), preferences);
    }
    for (const action of ['login', 'models', 'billing']) assert.equal((await request('/providers/unregistered/' + action, action === 'login' ? 'POST' : 'PATCH', {})).status, 404);
    assert.equal((await request('/agents/' + boot.agents[0].id, 'PATCH', { routeMode: 'unregistered', model: 'saved' })).status, 400);
    assert.equal((await request('/conversations/' + boot.conversations[0].id + '/messages', 'POST', { content: 'No execution', routeMode: 'unregistered', mode: 'agent' })).status, 400);
    assert.deepEqual(calls, []); assert.equal(app.store.list('run').length, 0); assert.equal(app.store.list('message').length, 0);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('direct and native stale calls cannot dispatch retired providers or enter groups', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-retired-native-')); const calls: string[] = []; const workspace = join(root, 'project'); await mkdir(workspace);
  const adapters = Object.fromEntries(allIds.map(provider => [provider, { id: provider, inspect: async () => state(provider), login: async () => ({ message: '' }), close: async () => {}, stream: async () => { calls.push(provider); return { text: 'Must not run' }; } } satisfies ProviderAdapter])) as unknown as Record<ProviderId, ProviderAdapter>;
  const app = createApp({ dataDir: join(root, 'data'), adapters });
  const records = () => app.store.db.prepare('SELECT * FROM records ORDER BY rowid').all();
  try {
    await app.runs.refresh(); const [initial, peer] = app.store.list<Agent>('agent');
    for (const provider of retiredIds) {
      app.store.saveBilling(provider, billing); app.runs.states.push(state(provider));
      const agent = app.store.put('agent', { ...initial, routeMode: provider, model: 'm1', mode: 'agent' as const, workspace });
      const conversation = app.store.conversations(agent.id)[0];
      for (const mode of ['chat', 'work', 'agent'] as const) {
        const before = records();
        assert.throws(() => app.runs.start(agent, conversation.id, 'No execution', provider, 'm1', mode), /removed|retired/i);
        const request: ProviderRequest = { runId: id(), conversationId: conversation.id, model: 'intentionally-nonexistent-model', instructions: '', history: [{ role: 'user', content: 'No execution' }], maxSeconds: 30, expectedAccount: { accountLabel: 'Fixture', plan: 'Fixture' }, mode, workspace, interact: async () => ({ decision: 'deny' }) };
        await assert.rejects(app.runs.call(provider, request, () => {}, new AbortController().signal, false), { status: 400, message: /removed|retired/i });
        assert.deepEqual(records(), before); assert.deepEqual(calls, []);
        assert.equal(app.store.list('run').length, 0); assert.equal(app.store.list('group-run').length, 0);
      }
      // A removed provider is rejected before any request/state/capability processing.
      for (const request of [undefined, null, {}] as unknown as ProviderRequest[]) {
        const before = records();
        await assert.rejects(app.runs.call(provider, request, () => {}, new AbortController().signal, false), { status: 400, message: /removed|retired/i });
        assert.deepEqual(records(), before); assert.deepEqual(calls, []);
      }
      const room = app.groups.create([agent.id, peer.id], 'Retired group', 'roundtable'); assert.throws(() => app.groups.accept(room.id, 'No execution'), /removed|retired/i);
    }
    assert.deepEqual(calls, []); assert.equal(app.store.list('run').length, 0); assert.equal(app.store.list('group-run').length, 0);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('production compatibility adapters are inert and never load native Google or Grok profiles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-retired-factory-'));
  try {
    const adapters = createAdapters(root);
    for (const provider of retiredIds) {
      assert.equal(adapters[provider].constructor.name, 'RetiredProviderAdapter');
      const state = await adapters[provider].inspect(); assert.equal(state.installed, false); assert.equal(state.authenticated, false); assert.deepEqual(state.models, []); assert.equal(state.inferenceAvailable, false);
      await assert.rejects(adapters[provider].login(), /removed|retired/i);
      await assert.rejects(adapters[provider].stream({} as ProviderRequest, () => {}, new AbortController().signal), /removed|retired/i);
    }
    await assert.rejects(readFile(join(root, 'grok', 'home', '.grok', 'config.toml'))); await assert.rejects(readFile(join(root, 'gemini', 'home', '.gemini', 'settings.json')));
    await Promise.all(Object.values(adapters).map(adapter => adapter.close()));
  } finally { await rm(root, { recursive: true, force: true }); }
});
