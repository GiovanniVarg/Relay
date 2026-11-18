import test from 'node:test';
import assert from 'node:assert/strict';
import type { ProviderRequest } from '../shared/types.js';
import { GoogleAccountAdapter } from '../server/providers/google.js';
import { createAdapters } from '../server/providers/index.js';

test('Google consumer connection reports unavailable without discovering a CLI or reading an OAuth profile', async () => {
  const adapter = new GoogleAccountAdapter();
  const state = await adapter.inspect();
  assert.equal(state.id, 'gemini'); assert.equal(state.installed, false); assert.equal(state.authenticated, false);
  assert.equal(state.inferenceAvailable, false); assert.equal(state.authMode, 'unknown');
  assert.equal(state.accountLabel, ''); assert.equal(state.plan, ''); assert.deepEqual(state.models, []);
  assert.match(state.error!, /June 18, 2026/); assert.match(state.error!, /Antigravity/); assert.match(state.error!, /third-party/);
  await adapter.close();
});

test('Google login action returns official guidance rather than an authentication command', async () => {
  const result = await new GoogleAccountAdapter().login();
  assert.equal(result.url, 'https://antigravity.google/docs/faq/');
  assert.equal(result.command, undefined); assert.match(result.message, /unavailable/i);
});

test('Google sending rejects before reading request contents or dispatching anything', async () => {
  const adapter = new GoogleAccountAdapter(); let dispatches = 0, events = 0;
  const input = new Proxy({}, { get() { throw new Error('Request must remain untouched'); } }) as ProviderRequest;
  await assert.rejects(adapter.stream(input, () => { events++; }, new AbortController().signal, () => { dispatches++; }), /Google.*unavailable|consumer.*June 18/i);
  assert.equal(dispatches, 0); assert.equal(events, 0);
});

test('Production legacy gemini entry is inert and cannot expose a Google setup or login action', async () => {
  const adapters = createAdapters('unused-fixture-data-directory');
  assert.equal(adapters.gemini.constructor.name, 'RetiredProviderAdapter');
  await assert.rejects(adapters.gemini.login(), /connection was removed/);
  assert.equal((await adapters.gemini.inspect()).inferenceAvailable, false);
});
