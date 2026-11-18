import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import type { ModelPreferences } from '../shared/types.js';

const rows = (store: Store) => store.db.prepare('SELECT kind,id,data FROM records ORDER BY kind,id').all();
const changes = (store: Store) => store.db.prepare('SELECT total_changes() AS count').get()!.count;
const saved = (store: Store) => store.get<{ id: string; value: ModelPreferences }>('config', 'models-openai');
async function fixture() { const dir = await mkdtemp(join(tmpdir(), 'relay-model-migration-')); return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }; }

test('normal settings boundary migrates the first nonempty legacy default once and getters never write', async () => {
  const f = await fixture(); let store = new Store(f.dir);
  try {
    store.saveSettings({ ...store.settings(), openaiDefaultModel: '' });
    assert.equal(saved(store), undefined);
    const before = rows(store), count = changes(store);
    assert.deepEqual(store.modelPreferences('openai'), { defaultModel: '', allowedModels: null });
    store.modelPreferences('claude'); store.modelPreferences('cursor'); store.settings();
    assert.deepEqual(rows(store), before); assert.equal(changes(store), count);
    store.saveSettings({ ...store.settings(), openaiDefaultModel: 'gpt-6-astra' });
    assert.deepEqual(saved(store)?.value, { defaultModel: 'gpt-6-astra', allowedModels: null });
    store.saveSettings({ ...store.settings(), openaiDefaultModel: 'gpt-6-luna' });
    assert.equal(store.modelPreferences('openai').defaultModel, 'gpt-6-astra');
    const persisted = rows(store); store.close(); store = new Store(f.dir);
    assert.deepEqual(rows(store), persisted); assert.equal(store.modelPreferences('openai').defaultModel, 'gpt-6-astra');
  } finally { store.close(); await f.cleanup(); }
});

test('legacy disk settings remain byte-identical during held reads then migrate exactly once at release', async () => {
  const f = await fixture(); let store = new Store(f.dir);
  try {
    store.put('config', { id: 'settings', value: { ...store.settings(), openaiDefaultModel: 'legacy-exact-model' } });
    const before = rows(store); store.close(); store = new Store(f.dir, { deferRecovery: true });
    const heldChanges = changes(store);
    for (let n = 0; n < 3; n++) { assert.equal(store.modelPreferences('openai').defaultModel, 'legacy-exact-model'); store.modelPreferences('claude'); store.modelPreferences('cursor'); store.settings(); }
    assert.deepEqual(rows(store), before); assert.equal(changes(store), heldChanges); assert.equal(saved(store), undefined);
    store.recoverInterrupted();
    assert.deepEqual(saved(store)?.value, { defaultModel: 'legacy-exact-model', allowedModels: null });
    assert.deepEqual(rows(store).filter(row => row.id !== 'models-openai'), before);
    const migrated = rows(store), releasedChanges = changes(store);
    store.recoverInterrupted(); store.modelPreferences('openai');
    assert.deepEqual(rows(store), migrated); assert.equal(changes(store), releasedChanges);
    store.close(); store = new Store(f.dir); assert.deepEqual(rows(store), migrated);
  } finally { store.close(); await f.cleanup(); }
});

test('held saveSettings defers preference migration until release and blank legacy values do not freeze it', async () => {
  const f = await fixture(); const store = new Store(f.dir, { deferRecovery: true });
  try {
    store.saveSettings({ ...store.settings(), openaiDefaultModel: 'gpt-6-astra' }); assert.equal(saved(store), undefined);
    const held = rows(store), count = changes(store); store.modelPreferences('openai'); assert.deepEqual(rows(store), held); assert.equal(changes(store), count);
    store.recoverInterrupted(); assert.equal(saved(store)?.value.defaultModel, 'gpt-6-astra');
    store.saveSettings({ ...store.settings(), openaiDefaultModel: 'gpt-6-luna' }); assert.equal(saved(store)?.value.defaultModel, 'gpt-6-astra');
  } finally { store.close(); await f.cleanup(); }
});

for (const explicit of [{ defaultModel: 'custom-default', allowedModels: ['custom-default'] }, { defaultModel: '', allowedModels: [] }, { defaultModel: '', allowedModels: null }] satisfies ModelPreferences[]) {
  test('explicit preferences remain authoritative over legacy migration: ' + JSON.stringify(explicit), async () => {
    const f = await fixture(); let store = new Store(f.dir);
    try {
      store.saveModelPreferences('openai', explicit); store.saveSettings({ ...store.settings(), openaiDefaultModel: 'gpt-6-astra' });
      const before = rows(store); store.close(); store = new Store(f.dir, { deferRecovery: true });
      store.recoverInterrupted(); assert.deepEqual(rows(store), before); assert.deepEqual(store.modelPreferences('openai'), explicit);
      store.saveSettings({ ...store.settings(), openaiDefaultModel: 'gpt-6-luna' }); assert.deepEqual(store.modelPreferences('openai'), explicit);
    } finally { store.close(); await f.cleanup(); }
  });
}
