import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { MacSecretVault, type KeychainEntryFactory } from '../server/mac-secret-vault.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'relay-keychain-'));
  const values = new Map<string, string>();
  const calls: Array<{ service: string; name: string; action: string }> = [];
  const factory: KeychainEntryFactory = (service, name) => {
    const key = `${service}\0${name}`;
    return {
      async getPassword() { calls.push({ service, name, action: 'get' }); return values.get(key) ?? null; },
      async setPassword(value) { calls.push({ service, name, action: 'set' }); values.set(key, value); },
      async deletePassword() { calls.push({ service, name, action: 'delete' }); return values.delete(key); },
    };
  };
  const make = (directory = dir, entryFactory = factory) => new MacSecretVault(directory,
    { platform: 'darwin', entryFactory });
  return { dir, values, calls, factory, make, cleanup() { rmSync(dir, { recursive: true, force: true }); } };
}

test('uses hashed per-data-directory namespaces and persists through keychain entries only', async () => {
  const f = fixture();
  try {
    const first = f.make();
    const second = f.make(join(f.dir, 'other'));
    assert.deepEqual(first.availability(), { available: true, protection: 'macos-keychain' });
    await first.set('token', 'first-secret');
    await second.set('token', 'second-secret');
    assert.equal(await f.make().get('token'), 'first-secret');
    assert.equal(await second.get('token'), 'second-secret');
    assert.equal(await first.has('token'), true);
    assert.equal(await first.has('absent'), false);
    const expectedService = `Relay-${createHash('sha256').update(resolve(f.dir)).digest('hex')}`;
    assert.equal(f.calls[0]!.service, expectedService);
    assert.equal(f.calls.every(call => !call.service.includes(f.dir)), true);
    assert.deepEqual(readdirSync(f.dir, { recursive: true }), []);
    await first.remove('token');
    assert.equal(await first.get('token'), null);
    assert.equal(await second.get('token'), 'second-secret');
  } finally { f.cleanup(); }
});

test('locked or refused keychain operations fail with generic errors and no disk fallback', async () => {
  const f = fixture();
  try {
    const locked: KeychainEntryFactory = () => ({
      async getPassword() { throw new Error('private-secret-in-native-error'); },
      async setPassword() { throw new Error('private-secret-in-native-error'); },
      async deletePassword() { throw new Error('private-secret-in-native-error'); },
    });
    const vault = f.make(f.dir, locked);
    await assert.rejects(vault.get('token'), { message: 'macOS Keychain operation unavailable' });
    await assert.rejects(vault.set('token', 'private-secret'), { message: 'macOS Keychain operation unavailable' });
    await assert.rejects(vault.remove('token'), { message: 'macOS Keychain operation unavailable' });
    const refused = f.make(f.dir, () => ({
      async getPassword() { return null; }, async setPassword() {}, async deletePassword() { return false; },
    }));
    await assert.rejects(refused.set('token', 'private-secret'));
    assert.deepEqual(readdirSync(f.dir, { recursive: true }), []);
  } finally { f.cleanup(); }
});

test('rejects credential-name abuse and oversized UTF-8 before invoking keychain', async () => {
  const f = fixture();
  try {
    const vault = f.make();
    for (const name of ['../token', 'Token', 'a/b', 'x'.repeat(65), '']) {
      await assert.rejects(vault.get(name));
      await assert.rejects(vault.set(name, 'secret'));
      await assert.rejects(vault.remove(name));
    }
    await assert.rejects(vault.set('token', 'é'.repeat(8193)));
    assert.equal(f.calls.length, 0);
    await vault.set('token', 'é'.repeat(8192));
    assert.equal(Buffer.byteLength((await vault.get('token'))!, 'utf8'), 16_384);
  } finally { f.cleanup(); }
});

test('serializes writes and reads through the same queue', async () => {
  const f = fixture();
  try {
    let release!: () => void;
    let signal!: () => void;
    const gate = new Promise<void>(resolveGate => { release = resolveGate; });
    const started = new Promise<void>(resolveStarted => { signal = resolveStarted; });
    const writes: string[] = [];
    const factory: KeychainEntryFactory = (service, name) => {
      const entry = f.factory(service, name);
      return {
        async getPassword() { return (await entry).getPassword(); },
        async setPassword(value) {
          writes.push(`start:${value}`);
          if (value === 'first') { signal(); await gate; }
          await (await entry).setPassword(value);
          writes.push(`end:${value}`);
        },
        async deletePassword() { return (await entry).deletePassword(); },
      };
    };
    const vault = f.make(f.dir, factory);
    const first = vault.set('token', 'first');
    const second = vault.set('token', 'second');
    const read = vault.get('token');
    await started;
    assert.deepEqual(writes, ['start:first']);
    release();
    await Promise.all([first, second]);
    assert.equal(await read, 'second');
    assert.deepEqual(writes, ['start:first', 'end:first', 'start:second', 'end:second']);
  } finally { f.cleanup(); }
});

test('checks cancellation before writing and rolls back a write cancelled during keychain operation', async () => {
  const f = fixture();
  try {
    const vault = f.make();
    await assert.rejects(vault.set('token', 'secret', () => { throw new Error('cancelled'); }));
    assert.equal(f.calls.length, 0);
    await vault.set('token', 'previous');
    let current = true;
    const factory: KeychainEntryFactory = async (service, name) => {
      const entry = await f.factory(service, name);
      return { ...entry, async setPassword(value) { await entry.setPassword(value); current = false; } };
    };
    const cancelled = f.make(f.dir, factory);
    await assert.rejects(cancelled.set('token', 'cancelled-secret', () => { if (!current) throw new Error('cancelled'); }));
    assert.equal(await vault.get('token'), 'previous');
  } finally { f.cleanup(); }
});

test('close rejects queued operations and rolls back a newly written secret before reporting failure', async () => {
  const f = fixture();
  try {
    let release!: () => void;
    let signal!: () => void;
    const gate = new Promise<void>(resolveGate => { release = resolveGate; });
    const started = new Promise<void>(resolveStarted => { signal = resolveStarted; });
    const factory: KeychainEntryFactory = async (service, name) => {
      const entry = await f.factory(service, name);
      return { ...entry, async setPassword(value) { signal(); await gate; await entry.setPassword(value); } };
    };
    const vault = f.make(f.dir, factory);
    const outcomes = Promise.allSettled([vault.set('token', 'secret'), vault.set('other', 'never-written')]);
    await started;
    vault.close();
    release();
    assert.deepEqual((await outcomes).map(outcome => outcome.status), ['rejected', 'rejected']);
    assert.equal(f.values.size, 0);
    assert.equal(vault.availability().available, false);
    await assert.rejects(vault.get('token'));
    assert.deepEqual(readdirSync(f.dir, { recursive: true }), []);
  } finally { f.cleanup(); }
});

test('unsupported platforms refuse operations without loading or invoking keyring', async () => {
  const f = fixture();
  try {
    const vault = new MacSecretVault(f.dir, { platform: 'win32', entryFactory: f.factory });
    assert.equal(vault.availability().available, false);
    await assert.rejects(vault.set('token', 'secret'));
    await assert.rejects(vault.get('token'));
    assert.equal(f.calls.length, 0);
  } finally { f.cleanup(); }
});
