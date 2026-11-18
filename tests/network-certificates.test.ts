import assert from 'node:assert/strict';
import { X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Store } from '../server/store.js';
import { NetworkCertificates } from '../server/network-certificates.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'relay-certificates-'));
  const store = new Store(dir);
  const time = { now: Date.now() };
  const values = new Map<string, string>();
  const writes: string[] = [];
  const vault = {
    async get(name: string) { return values.get(name) ?? null; },
    async set(name: string, value: string) { writes.push(name); values.set(name, value); },
    async remove(name: string) { values.delete(name); },
  };
  const manager = () => new NetworkCertificates(store, vault, { clock: () => time.now });
  return { dir, store, time, values, writes, vault, manager, cleanup() {
    (store as unknown as { close?: () => void }).close?.();
    rmSync(dir, { recursive: true, force: true });
  } };
}

test('generates a verifiable private CA and IP/DNS leaf; stores no private PEM in config', async () => {
  const f = fixture();
  try {
    const manager = f.manager();
    assert.equal(manager.publicCA(), null);
    const material = await manager.material('192.168.1.20', 'relay.local');
    const root = new X509Certificate(material.ca);
    const leaf = new X509Certificate(material.cert);
    assert.equal(root.ca, true);
    assert.equal(root.verify(root.publicKey), true);
    assert.equal(leaf.ca, false);
    assert.equal(leaf.verify(root.publicKey), true);
    assert.equal(leaf.checkIP('192.168.1.20'), '192.168.1.20');
    assert.equal(leaf.checkHost('relay.local'), 'relay.local');
    assert.equal(leaf.checkIP('192.168.1.21'), undefined);
    assert.deepEqual(createPublicKey(createPrivateKey(material.key)).export({ type: 'spki', format: 'der' }),
      leaf.publicKey.export({ type: 'spki', format: 'der' }));
    assert.equal(manager.publicCA()?.fingerprint, material.rootFingerprint);
    assert.equal(JSON.stringify(f.store.list('config')).includes('PRIVATE KEY'), false);
    assert.equal(f.values.has('network-ca-key'), true);
    assert.equal(f.values.has('network-leaf-key'), true);
    assert.ok(Buffer.byteLength(f.values.get('network-ca-key')!) < 16_384);
  } finally { f.cleanup(); }
});

test('serializes concurrent initialization and preserves CA across restart and SAN renewal', async () => {
  const f = fixture();
  try {
    const manager = f.manager();
    const results = await Promise.all([manager.material('10.1.2.3'), manager.material('10.1.2.3')]);
    assert.equal(results[0]!.cert, results[1]!.cert);
    assert.equal(f.writes.length, 2);
    const changed = await f.manager().material('10.1.2.4', 'relay.local');
    assert.equal(changed.rootFingerprint, results[0]!.rootFingerprint);
    assert.notEqual(changed.fingerprint, results[0]!.fingerprint);
    assert.equal(new X509Certificate(changed.cert).checkIP('10.1.2.4'), '10.1.2.4');
    assert.equal(f.writes.length, 2);
    f.time.now += 80 * 86_400_000;
    const renewed = await f.manager().material('10.1.2.4', 'relay.local');
    assert.equal(renewed.rootFingerprint, changed.rootFingerprint);
    assert.notEqual(renewed.cert, changed.cert);
    assert.ok(Date.parse(renewed.expiresAt) > Date.parse(changed.expiresAt));
  } finally { f.cleanup(); }
});

test('missing or mismatched private keys fail closed without rotating CA', async () => {
  const f = fixture();
  try {
    const original = await f.manager().material('172.16.1.4');
    const oldCaKey = f.values.get('network-ca-key')!;
    f.values.delete('network-ca-key');
    await assert.rejects(f.manager().material('172.16.1.4'), /material unavailable/);
    assert.equal(f.manager().publicCA()?.fingerprint, original.rootFingerprint);
    f.values.set('network-ca-key', original.key);
    await assert.rejects(f.manager().material('172.16.1.4'), /material unavailable/);
    assert.equal(f.values.get('network-ca-key'), original.key);
    f.values.set('network-ca-key', oldCaKey);
    assert.equal((await f.manager().material('172.16.1.4')).rootFingerprint, original.rootFingerprint);
  } finally { f.cleanup(); }
});

test('orphaned keys, malformed state, and expired CA are never silently replaced', async () => {
  const f = fixture();
  try {
    f.values.set('network-ca-key', 'orphaned');
    await assert.rejects(f.manager().material('192.168.0.2'));
    assert.equal(f.values.get('network-ca-key'), 'orphaned');
    f.values.clear();
    const original = await f.manager().material('192.168.0.2');
    f.time.now += 3651 * 86_400_000;
    await assert.rejects(f.manager().material('192.168.0.2'));
    assert.equal(f.writes.length, 2);
    assert.ok(original.ca);
    f.time.now -= 3651 * 86_400_000;
    f.store.put('config', { id: 'network-certificates', version: 1, ca: 'bad', cert: 'bad', address: '192.168.0.2', hostname: null });
    await assert.rejects(f.manager().material('192.168.0.2'));
    assert.equal(f.writes.length, 2);
  } finally { f.cleanup(); }
});

test('only private IPv4 is accepted; loopback is explicit test-only opt-in', async () => {
  const f = fixture();
  try {
    for (const address of ['127.0.0.1', '0.0.0.0', '8.8.8.8', '172.32.0.1', '192.168.001.1', '10.0.0.256', '::1']) {
      await assert.rejects(f.manager().material(address));
    }
    for (const hostname of ['*.local', 'bad/name', '-bad.local', '127.0.0.1', 'a..local']) {
      await assert.rejects(f.manager().material('192.168.0.2', hostname));
    }
    assert.equal(f.writes.length, 0);
    const testOnly = new NetworkCertificates(f.store, f.vault, { clock: () => f.time.now, allowLoopback: true });
    const material = await testOnly.material('127.0.0.1', 'localhost');
    assert.equal(new X509Certificate(material.cert).checkIP('127.0.0.1'), '127.0.0.1');
  } finally { f.cleanup(); }
});

test('failed first-time vault write removes only newly generated keys and writes no public state', async () => {
  const f = fixture();
  try {
    const vault = { ...f.vault, async set(name: string, value: string) {
      f.values.set(name, value);
      if (name === 'network-leaf-key') throw new Error('denied');
    } };
    const manager = new NetworkCertificates(f.store, vault, { clock: () => f.time.now });
    await assert.rejects(manager.material('10.0.0.2'));
    assert.equal(f.values.size, 0);
    assert.equal(manager.publicCA(), null);
  } finally { f.cleanup(); }
});
