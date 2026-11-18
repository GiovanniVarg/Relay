import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { realpathSync } from 'node:fs';
import { Store, PROVIDER_IDS } from '../server/store.js';
import { validateWorkspace } from '../server/mode.js';
import { createApp, defaultDataDir } from '../server/index.js';
import type { Agent, Bootstrap, ProviderAdapter, ProviderId, ProviderRequest } from '../shared/types.js';

const home = homedir(); const canonicalHome = realpathSync.native(home);
const billing = { mode: 'included' as const, confirmed: true, automaticRouting: true, allowanceNote: 'Fixture' };
function adapters(calls: ProviderRequest[]): Record<ProviderId, ProviderAdapter> { return Object.fromEntries(PROVIDER_IDS.map(id => [id, { id, inspect: async () => ({ id, installed: true, authenticated: true, authMode: 'subscription' as const, accountLabel: 'Fixture', plan: 'Fixture', models: [{ id: 'm1', name: 'Fixture', verified: false }] }), login: async () => ({ message: 'Fixture' }), close: async () => {}, stream: async (request: ProviderRequest) => { calls.push(request); return { text: 'Fixture', actualModel: request.model }; } } satisfies ProviderAdapter])) as unknown as Record<ProviderId, ProviderAdapter>; }

test('new bots use detected home unless a workspace is explicitly provided or cleared', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-home-default-')); const store = new Store(join(root, 'data'));
  try {
    assert.ok(store.list<Agent>('agent').every(agent => agent.workspace === home));
    assert.equal(store.createAgent({ name: 'Default' }).workspace, home);
    assert.equal(store.createAgent({ name: 'Cleared', workspace: '' }).workspace, '');
    assert.equal(store.createAgent({ name: 'Custom', workspace: 'Saved custom folder' }).workspace, 'Saved custom folder');
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('home workspace migration fills blanks once and preserves private settings, custom folders and future choices', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-home-migration-')); let store = new Store(join(root, 'data'));
  try {
    const [blank, custom] = store.list<Agent>('agent');
    store.put('agent', { ...blank, workspace: '', instructions: 'Private mission', memory: 'Private memory', mode: 'chat' });
    store.put('agent', { ...custom, workspace: 'Saved project', mode: 'work' });
    store.saveBilling('grok', billing); store.saveModelPreferences('grok', { defaultModel: 'selected', allowedModels: ['selected'] });
    store.remove('config', 'workspace-home-v1'); store.close(); store = new Store(join(root, 'data'));
    const migrated = store.get<Agent>('agent', blank.id)!;
    assert.equal(migrated.workspace, home); assert.equal(migrated.mode, 'chat'); assert.equal(migrated.instructions, 'Private mission'); assert.equal(migrated.memory, 'Private memory');
    assert.equal(store.get<Agent>('agent', custom.id)!.workspace, 'Saved project'); assert.equal(store.get<Agent>('agent', custom.id)!.mode, 'work');
    assert.deepEqual(store.billing('grok'), billing); assert.deepEqual(store.modelPreferences('grok'), { defaultModel: 'selected', allowedModels: ['selected'] });
    store.put('agent', { ...migrated, workspace: '', mode: 'chat' }); store.close(); store = new Store(join(root, 'data'));
    assert.equal(store.get<Agent>('agent', blank.id)!.workspace, ''); assert.equal(store.get<Agent>('agent', blank.id)!.mode, 'chat');
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('only Agent permits exact canonical home; Work and data-folder boundaries remain intact', async () => {
  const data = join(home, '.relay-data');
  assert.equal(validateWorkspace(home, data, 'agent'), canonicalHome);
  assert.equal(validateWorkspace(join(home, '.'), data, 'agent'), canonicalHome);
  assert.throws(() => validateWorkspace(home, data), /whole home|project folder/);
  assert.throws(() => validateWorkspace(home, data, 'work'), /whole home|project folder/);
  assert.throws(() => validateWorkspace(parse(home).root, data, 'agent'), /root/);
  assert.throws(() => validateWorkspace(home, home, 'agent'), /data folder/);
  assert.throws(() => validateWorkspace(home, dirname(home), 'agent'), /data folder/);
  const root = await mkdtemp(join(tmpdir(), 'relay-home-boundary-')); await mkdir(join(root, 'data'));
  try { assert.throws(() => validateWorkspace(join(root, 'data'), join(root, 'data'), 'agent'), /data folder/); assert.throws(() => validateWorkspace(root, join(root, 'data'), 'agent'), /data folder/); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test('data defaults use detected home, honor overrides, retain legacy-only DB and reject ambiguous DBs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-data-path-')); const fakeHome = join(root, 'home'), cwd = join(root, 'cwd'); await mkdir(fakeHome); await mkdir(cwd);
  try {
    assert.equal(defaultDataDir(undefined, fakeHome, cwd), join(fakeHome, '.relay-data'));
    assert.equal(defaultDataDir('custom', fakeHome, cwd), join(cwd, 'custom'));
    await mkdir(join(cwd, '.data')); await writeFile(join(cwd, '.data', 'relay.sqlite'), 'fixture');
    assert.equal(defaultDataDir(undefined, fakeHome, cwd), join(cwd, '.data'));
    await mkdir(join(fakeHome, '.relay-data')); await writeFile(join(fakeHome, '.relay-data', 'relay.sqlite'), 'fixture');
    assert.throws(() => defaultDataDir(undefined, fakeHome, cwd), /RELAY_DATA_DIR/);
    assert.equal(defaultDataDir(join(fakeHome, '.relay-data'), fakeHome, cwd), join(fakeHome, '.relay-data'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Agent home edits and native requests work while switching the same folder to Work fails before messages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-home-http-')); const calls: ProviderRequest[] = [];
  const app = createApp({ dataDir: join(root, 'data'), adapters: adapters(calls), port: 0 }); const port = await app.listen(0); const base = `http://127.0.0.1:${port}`;
  try {
    const initial = await fetch(base + '/api/bootstrap'); const cookie = initial.headers.get('set-cookie')!.split(';')[0]; const boot = await initial.json() as Bootstrap;
    assert.equal(boot.homeDirectory, home); const agent = boot.agents[0]; assert.equal(agent.workspace, home);
    const call = (path: string, body: unknown) => fetch(base + '/api' + path, { method: 'PATCH', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': boot.csrfToken }, body: JSON.stringify(body) });
    assert.equal((await call('/agents/' + agent.id, { workspace: home, mode: 'agent' })).status, 200);
    assert.equal((await call('/agents/' + agent.id, { mode: 'work' })).status, 400);
    assert.equal((await call('/agents/' + agent.id, { mode: 'auto' })).status, 400);
    await app.runs.refresh(); for (const provider of PROVIDER_IDS) { app.store.saveBilling(provider, billing); app.store.saveModelPreferences(provider, { defaultModel: 'm1', allowedModels: ['m1'] }); }
    const conversation = app.store.conversations(agent.id)[0];
    for (const provider of ['openai', 'claude'] as const) {
      const accepted = app.runs.start(agent, conversation.id, 'Hello', provider, 'm1', 'agent'); await app.runs.active.get(accepted.run.id)?.promise;
      assert.equal(calls.at(-1)!.workspace, canonicalHome); assert.equal(calls.at(-1)!.mode, 'agent');
    }
    const before = app.store.messages(conversation.id).length;
    assert.throws(() => app.runs.start(agent, conversation.id, 'Write src/main.ts', 'openai', 'm1', 'work'), /whole home|project folder/);
    assert.throws(() => app.runs.start(agent, conversation.id, 'Write src/main.ts', 'openai', 'm1', 'auto'), /whole home|project folder/);
    assert.equal(app.store.messages(conversation.id).length, before);
    assert.equal((await call('/agents/' + agent.id, { workspace: home, mode: 'chat' })).status, 200);
    assert.equal((await call('/agents/' + agent.id, { workspace: '', mode: 'chat' })).status, 200);
    assert.equal(app.store.get<Agent>('agent', agent.id)!.workspace, '');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});