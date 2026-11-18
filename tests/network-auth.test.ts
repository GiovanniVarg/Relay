import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../server/store.js';
import { NetworkDevices, bodyHash, signingPayload, type DeviceRole, type RequestProof } from '../server/network-auth.js';

function keys() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  return { privateKey: pair.privateKey, publicKey: { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! } };
}

function proof(key: KeyObject, timestamp: number, options: Partial<RequestProof> = {}): RequestProof {
  const request = { method: 'GET', path: '/api/session', timestamp,
    nonce: randomBytes(18).toString('base64url'), body: Buffer.alloc(0), ...options };
  const signature = sign('sha256', Buffer.from(signingPayload(request.method, request.path,
    request.timestamp, request.nonce, bodyHash(request.body))),
  { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return { ...request, signature };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'relay-network-auth-'));
  const time = { now: 1_800_000_000_000 };
  const stores: Store[] = [];
  const reopen = () => {
    const store = new Store(dir);
    stores.push(store);
    return new NetworkDevices(store, { clock: () => time.now });
  };
  const auth = reopen();
  return { dir, time, auth, reopen, cleanup() {
    for (const store of stores) (store as unknown as { close?: () => void }).close?.();
    rmSync(dir, { recursive: true, force: true });
  } };
}

function pairDevice(auth: NetworkDevices, now: number, role: DeviceRole = 'controller') {
  const key = keys();
  const invite = auth.createInvite(role);
  const input = { code: invite.code, name: 'Test device', platform: 'test', publicKey: key.publicKey };
  const pairingProof = proof(key.privateKey, now, { method: 'POST', path: '/api/network/pair', body: Buffer.from(JSON.stringify(input)) });
  return { key, input, pairingProof, device: auth.pair(input, pairingProof) };
}

test('pairing stores public metadata, single-use invite, and authenticates P1363 proof', () => {
  const f = fixture();
  try {
    const { key, input, pairingProof, device } = pairDevice(f.auth, f.time.now);
    assert.equal(device.role, 'controller');
    assert.equal(f.auth.list().length, 1);
    assert.equal('nonces' in device, false);
    assert.equal('highWater' in device, false);
    assert.deepEqual(device.publicKey, key.publicKey);
    assert.throws(() => f.auth.pair(input, pairingProof));
    assert.equal(f.auth.verify({ deviceId: device.id, ...proof(key.privateKey, f.time.now) }).id, device.id);
  } finally { f.cleanup(); }
});

test('private, extra, malformed, and noncanonical JWK fields fail without consuming invite', () => {
  const f = fixture();
  try {
    const key = keys();
    const invite = f.auth.createInvite('worker');
    const input = { code: invite.code, name: 'Worker', platform: 'test', publicKey: key.publicKey };
    const p = proof(key.privateKey, f.time.now, { method: 'POST', path: '/api/network/pair', body: Buffer.from(JSON.stringify(input)) });
    for (const invalid of [
      { ...key.publicKey, d: 'secret' }, { ...key.publicKey, ext: true },
      { ...key.publicKey, x: key.publicKey.x + '=' }, { ...key.publicKey, crv: 'P-384' },
      { ...key.publicKey, x: 'A'.repeat(43), y: 'A'.repeat(43) },
    ]) assert.throws(() => f.auth.pair({ ...input, publicKey: invalid }, p));
    assert.equal(f.auth.pair(input, p).role, 'worker');
  } finally { f.cleanup(); }
});

test('wrong role rejects before consuming nonce; duplicate key cannot change roles', () => {
  const f = fixture();
  try {
    const { key, device } = pairDevice(f.auth, f.time.now, 'worker');
    const p = { deviceId: device.id, ...proof(key.privateKey, f.time.now) };
    assert.throws(() => f.auth.verify(p, 'controller'));
    assert.equal(f.auth.verify(p, 'worker').id, device.id);
    const invite = f.auth.createInvite('controller');
    const input = { code: invite.code, name: 'Changed role', platform: 'test', publicKey: key.publicKey };
    assert.throws(() => f.auth.pair(input, proof(key.privateKey, f.time.now,
      { method: 'POST', path: '/api/network/pair', body: Buffer.from(JSON.stringify(input)) })));
  } finally { f.cleanup(); }
});

test('replay protection survives opening a fresh store and independent auth instance', () => {
  const f = fixture();
  try {
    const { key, device } = pairDevice(f.auth, f.time.now);
    const p = { deviceId: device.id, ...proof(key.privateKey, f.time.now) };
    f.auth.verify(p);
    assert.throws(() => f.auth.verify(p));
    const restarted = f.reopen();
    assert.throws(() => restarted.verify(p));
    assert.equal(restarted.verify({ deviceId: device.id, ...proof(key.privateKey, f.time.now) }).id, device.id);
  } finally { f.cleanup(); }
});

test('expired invites and incorrect pairing route or signature cannot pair', () => {
  const f = fixture();
  try {
    const key = keys();
    const invite = f.auth.createInvite('controller');
    assert.match(invite.code, /^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){2}$/);
    const input = { code: invite.code, name: 'Test', platform: 'test', publicKey: key.publicKey };
    assert.throws(() => f.auth.pair(input, proof(key.privateKey, f.time.now)));
    const valid = proof(key.privateKey, f.time.now, { method: 'POST', path: '/api/network/pair', body: Buffer.from(JSON.stringify(input)) });
    assert.throws(() => f.auth.pair(input, { ...valid, signature: 'A'.repeat(86) }));
    f.time.now = invite.expiresAt;
    assert.throws(() => f.auth.pair(input, proof(key.privateKey, f.time.now,
      { method: 'POST', path: '/api/network/pair', body: valid.body })));
  } finally { f.cleanup(); }
});

test('revocation persists and prevents further authentication and old-key re-enrollment', () => {
  const f = fixture();
  try {
    const { key, device } = pairDevice(f.auth, f.time.now);
    f.auth.revoke(device.id);
    assert.equal(f.auth.get(device.id)?.revokedAt, f.time.now);
    assert.throws(() => f.reopen().verify({ deviceId: device.id, ...proof(key.privateKey, f.time.now) }));
    const input = { code: f.auth.createInvite('controller').code, name: 'Again', platform: 'test', publicKey: key.publicKey };
    assert.throws(() => f.auth.pair(input, proof(key.privateKey, f.time.now,
      { method: 'POST', path: '/api/network/pair', body: Buffer.from(JSON.stringify(input)) })));
  } finally { f.cleanup(); }
});

test('body, route, timestamp, nonce, and signature encoding are authenticated', () => {
  const f = fixture();
  try {
    const { key, device } = pairDevice(f.auth, f.time.now);
    const p = { deviceId: device.id, ...proof(key.privateKey, f.time.now,
      { method: 'POST', path: '/api/action', body: Buffer.from('{"action":"read"}') }) };
    for (const invalid of [
      { ...p, body: Buffer.from('{"action":"write"}') }, { ...p, path: '/api/other' },
      { ...p, timestamp: p.timestamp + 1 }, { ...p, nonce: 'another-nonce-123456' },
      { ...p, signature: p.signature + '=' }, { ...p, nonce: 'short' },
    ]) assert.throws(() => f.auth.verify(invalid));
    assert.equal(f.auth.verify(p).id, device.id);
  } finally { f.cleanup(); }
});

test('timestamp high-water prevents replay after nonce pruning and clock rewind', () => {
  const f = fixture();
  try {
    const { key, device } = pairDevice(f.auth, f.time.now);
    const old = { deviceId: device.id, ...proof(key.privateKey, f.time.now) };
    f.auth.verify(old);
    f.time.now += 180_001;
    f.auth.verify({ deviceId: device.id, ...proof(key.privateKey, f.time.now) });
    f.time.now = old.timestamp;
    const restarted = f.reopen();
    assert.throws(() => restarted.verify(old));
    assert.throws(() => restarted.verify({ deviceId: device.id, ...proof(key.privateKey, f.time.now) }));
  } finally { f.cleanup(); }
});

test('outstanding invites are bounded and expired invites release capacity', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 10; i++) f.auth.createInvite('controller');
    assert.throws(() => f.auth.createInvite('controller'));
    f.time.now += 300_000;
    assert.doesNotThrow(() => f.auth.createInvite('controller'));
  } finally { f.cleanup(); }
});
