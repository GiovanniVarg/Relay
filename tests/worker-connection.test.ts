import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { NetworkCertificates } from '../server/network-certificates.js';
import { NetworkDevices } from '../server/network-auth.js';
import { WorkerConnection, WorkerConnectionError, type WorkerPublicProfile } from '../server/worker-connection.js';

function memoryVault() {
  const values = new Map<string, string>();
  return { values, async get(key: string) { return values.get(key) ?? null; }, async set(key: string, value: string) { values.set(key, value); }, async remove(key: string) { values.delete(key); } };
}
async function fixture(certAddress = '127.0.0.1') {
  const directory = mkdtempSync(join(tmpdir(), 'relay-worker-connection-')), store = new Store(directory), certificateVault = memoryVault(), workerVault = memoryVault();
  const certificates = new NetworkCertificates(store, certificateVault, { allowLoopback: true }), material = await certificates.material(certAddress);
  const devices = new NetworkDevices(store), seen: { path: string; body: string; nonce: string }[] = [];
  let responseStatus = 200, redirect = false;
  const server = createServer({ key: material.key, cert: material.cert }, async (req, res) => {
    try {
      const parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part)); const body = Buffer.concat(parts), path = req.url!;
      const header = (name: string) => String(req.headers[name] ?? '');
      const proof = { method: req.method!, path, timestamp: Number(header('x-relay-timestamp')), nonce: header('x-relay-nonce'), body, signature: header('x-relay-signature') };
      seen.push({ path, body: body.toString(), nonce: proof.nonce });
      if (path === '/api/network/pair') { const device = devices.pair(JSON.parse(body.toString()), proof); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(device)); return; }
      devices.verify({ ...proof, deviceId: header('x-relay-device') }, 'worker');
      if (redirect) { res.writeHead(302, { location: 'https://8.8.8.8/private' }); res.end('{}'); return; }
      res.writeHead(responseStatus, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: responseStatus === 200, privateError: 'NOT_FOR_LOGS' }));
    } catch (error) { res.writeHead((error as { status?: number }).status ?? 500, { 'content-type': 'application/json' }); res.end('{}'); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const profile: WorkerPublicProfile = { url: 'https://127.0.0.1:' + address.port, ca: material.ca, fingerprint: material.rootFingerprint };
  const connection = () => new WorkerConnection(workerVault, { allowLoopbackForTests: true });
  return { store, workerVault, devices, seen, profile, connection, status(value: number) { responseStatus = value; }, redirect() { redirect = true; }, async cleanup() { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
test('real HTTPS pairing proves the P256 key and subsequent requests use fresh signed nonces', async () => {
  const f = await fixture();
  try {
    const worker = f.connection(), invite = f.devices.createInvite('worker');
    const paired = await worker.pair(f.profile, invite.code, 'Test worker');
    assert.ok(paired.deviceId); assert.equal(f.devices.get(paired.deviceId)?.role, 'worker');
    const body = JSON.parse(f.seen[0].body); assert.deepEqual(Object.keys(body.publicKey).sort(), ['crv', 'kty', 'x', 'y']);
    assert.equal(f.seen[0].body.includes('PRIVATE KEY'), false);
    const secret = f.workerVault.values.get('network-worker-identity')!; assert.match(secret, /PRIVATE KEY/); assert.ok(Buffer.byteLength(secret) < 16384);
    await worker.request('/api/network/worker/heartbeat', 'POST', { protocolVersion: 1 });
    await worker.request('/api/network/worker/heartbeat', 'POST', { protocolVersion: 1 });
    assert.notEqual(f.seen[1].nonce, f.seen[2].nonce);
    const restored = f.connection(); assert.equal(await restored.load(), true); assert.equal(restored.deviceId(), paired.deviceId);
    await restored.request('/api/network/worker/poll?instance=test-instance');
    await assert.rejects(restored.pair(f.profile, f.devices.createInvite('worker').code, 'Again'), /Clear/);
    await restored.clearIdentity(); assert.equal(await restored.load(), false);
  } finally { await f.cleanup(); }
});
test('controller invitations cannot create worker identities; revocation is distinct and errors expose no response body', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.connection().pair(f.profile, f.devices.createInvite('controller').code, 'Wrong role'), /worker identity/);
    assert.equal(f.workerVault.values.has('network-worker-identity'), false);
    const worker = f.connection(); await worker.pair(f.profile, f.devices.createInvite('worker').code, 'Right role');
    f.status(403);
    await assert.rejects(worker.request('/api/network/worker/poll?instance=x'), error => error instanceof WorkerConnectionError && error.status === 403 && !error.message.includes('NOT_FOR_LOGS'));
    f.status(200); f.redirect(); await assert.rejects(worker.request('/api/network/worker/poll?instance=x'), error => error instanceof WorkerConnectionError && error.status === 302);
  } finally { await f.cleanup(); }
});
test('profiles reject public addresses, HTTP, credentials, and a changed CA pin before any request', async () => {
  const f = await fixture();
  try {
    for (const url of ['http://192.168.1.2:3443', 'https://8.8.8.8', 'https://example.com', 'https://user:pass@192.168.1.2', 'https://127.0.0.1:3443']) {
      const connection = new WorkerConnection(memoryVault()); await assert.rejects(connection.pair({ ...f.profile, url }, 'ABCD-EFGH-JKLM', 'Test'), /profile/);
    }
    await assert.rejects(f.connection().pair({ ...f.profile, fingerprint: '0'.repeat(64) }, 'ABCD-EFGH-JKLM', 'Test'), /profile/);
    assert.equal(f.seen.length, 0);
  } finally { await f.cleanup(); }
});
test('standard TLS IP identity checks remain enabled even with the pinned root CA', async () => {
  const f = await fixture('127.0.0.2');
  try { await assert.rejects(f.connection().pair(f.profile, f.devices.createInvite('worker').code, 'Test'), /connection failed/); assert.equal(f.seen.length, 0); }
  finally { await f.cleanup(); }
});
test('oversized requests never reach HTTPS and a corrupt vaulted identity never silently re-pairs', async () => {
  const f = await fixture();
  try {
    const worker = f.connection(); await worker.pair(f.profile, f.devices.createInvite('worker').code, 'Test');
    await assert.rejects(worker.request('/api/network/worker/heartbeat', 'POST', { text: 'x'.repeat(8 * 1024 * 1024) }), /size limit/);
    assert.equal(f.seen.length, 1);
    f.workerVault.values.set('network-worker-identity', '{corrupt'); await assert.rejects(f.connection().load(), /explicitly clear/);
  } finally { await f.cleanup(); }
});
