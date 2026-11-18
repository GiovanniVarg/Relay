import test from 'node:test';
import assert from 'node:assert/strict';
import { appleMobileEnvironment, publicInstallProfile, requestPersistentControllerStorage } from '../client/controller-install';

test('Home Screen handoff retains pinned public host trust without copying controller credentials', () => {
  const input = {
    url: 'https://192.168.1.20:3443', ca: '-----BEGIN CERTIFICATE-----\nYWJj\n-----END CERTIFICATE-----', fingerprint: 'a'.repeat(64),
    transport: { kind: 'webtransport-v1' as const, endpoint: 'https://192.168.1.20:3443/relay', pin: 'b'.repeat(64),
      catalog: { payload: '{"sequence":1}', signature: 'c'.repeat(86), secret: 'not-public' } },
    privateKey: 'private-do-not-export', deviceId: 'paired-device', code: 'ABCD-EFGH-JKLM',
  };
  const text = publicInstallProfile(input), copied = JSON.parse(text);
  assert.equal(copied.transport.pin, input.transport.pin);
  assert.deepEqual(copied.transport.catalog, { payload: input.transport.catalog.payload, signature: input.transport.catalog.signature });
  assert.deepEqual(Object.keys(copied).sort(), ['ca', 'fingerprint', 'transport', 'url']);
  for (const secret of ['private-do-not-export', 'paired-device', 'ABCD-EFGH-JKLM', 'not-public']) assert.equal(text.includes(secret), false);
  assert.throws(() => publicInstallProfile({ ...input, transport: { ...input.transport, endpoint: 'https://attacker.invalid/relay' } }));
});

test('iPhone, desktop-UA iPad, and installed display mode choose the correct setup context', () => {
  assert.deepEqual(appleMobileEnvironment('iPhone', 'iPhone', 5, false, false), { ios: true, standalone: false });
  assert.deepEqual(appleMobileEnvironment('Macintosh', 'MacIntel', 5, false, true), { ios: true, standalone: true });
  assert.deepEqual(appleMobileEnvironment('Macintosh', 'MacIntel', 0, false, false), { ios: false, standalone: false });
  assert.deepEqual(appleMobileEnvironment('iPad', 'iPad', 5, true, false), { ios: true, standalone: true });
});

test('browser storage persistence is optional and never delays or rejects opening a paired workspace', async () => {
  assert.equal(requestPersistentControllerStorage(undefined), undefined);
  assert.equal(requestPersistentControllerStorage({ persist: async () => false }), undefined);
  assert.equal(requestPersistentControllerStorage({ persist: async () => { throw Error('Not permitted'); } }), undefined);
  assert.equal(requestPersistentControllerStorage({ persist() { throw Error('Unsupported'); } }), undefined);
  let requested = false;
  assert.equal(requestPersistentControllerStorage({ persist() { requested = true; return new Promise(() => {}); } }), undefined);
  assert.equal(requested, true);
  await new Promise(resolve => setImmediate(resolve));
});
