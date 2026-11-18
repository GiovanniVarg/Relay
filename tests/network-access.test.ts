import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { NetworkAccess } from '../server/network-access.js';
import { bodyHash, signingPayload, type DeviceRecord, type DeviceRole } from '../server/network-auth.js';
import { Security, jsonBody } from '../server/security.js';
import { Store } from '../server/store.js';

function keypair() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  return { privateKey: pair.privateKey, publicKey: { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! } };
}
function signed(key: KeyObject, method: string, path: string, body = Buffer.alloc(0), id?: string) {
  const timestamp = Date.now(), nonce = randomBytes(18).toString('base64url');
  const signature = sign('sha256', Buffer.from(signingPayload(method, path, timestamp, nonce, bodyHash(body))),
    { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return { 'x-relay-timestamp': String(timestamp), 'x-relay-nonce': nonce, 'x-relay-signature': signature,
    ...(id ? { 'x-relay-device': id } : {}) };
}
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'relay-network-access-'));
  const store = new Store(dir), base = new Security(3210), secrets = new Map<string, string>();
  const revoked: Array<{ id: string; session?: object }> = [];
  let mutation: Record<string, unknown> | undefined;
  const vault = {
    async has(name: string) { return secrets.has(name); }, async get(name: string) { return secrets.get(name) ?? null; },
    async set(name: string, value: string) { secrets.set(name, value); }, async remove(name: string) { secrets.delete(name); },
    close() {}, availability() { return { available: true, protection: 'test' }; },
  };
  let access!: NetworkAccess;
  access = new NetworkAccess(store, base, vault, {
    assertWritable() {},
    async handle(req, res, security) {
      security.validate(req);
      const url = new URL(req.url!, 'http://localhost');
      if (url.pathname === '/bootstrap') {
        const session = security.bootstrap(req, res);
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ csrf: session.csrf })); return;
      }
      if (url.pathname.startsWith('/api/')) {
        security.session(req);
        if (!['GET', 'HEAD'].includes(req.method!)) security.mutation(req);
        if (await access.manage(req, res, url)) return;
        if (url.pathname === '/api/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: connected\n\n'); return; }
        if (url.pathname === '/api/mutate') mutation = await jsonBody(req);
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true })); return;
      }
      res.end('<p>Pair this device</p>');
    },
    async workerRequest(device, _req, res) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ worker: device.id })); },
    async onRevoke(id, session) { revoked.push({ id, session }); },
  }, { allowLoopbackTest: true, interfaces: () => [{ name: 'test-loopback', address: '127.0.0.1', netmask: '255.0.0.0' }] });
  const status = await access.enable({ address: '127.0.0.1', port: 0, controllerOrigins: ['https://controller.example'] });
  const ca = access.certificates.publicCA()!.certificate;
  const request = (method: string, path: string, body = Buffer.alloc(0), headers: Record<string, string> = {}, options: RequestOptions = {}) =>
    new Promise<{ status: number; body: Buffer; headers: IncomingMessage['headers'] }>((resolve, reject) => {
      const req = httpsRequest({ hostname: '127.0.0.1', servername: '127.0.0.1', port: status.port, method, path, ca,
        headers: { 'content-type': 'application/json', 'content-length': String(body.length), ...headers }, ...options }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(Buffer.from(chunk)));
        res.once('error', reject);
        res.once('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks), headers: res.headers }));
      });
      req.once('error', reject); req.end(body);
    });
  const pair = async (role: DeviceRole = 'controller') => {
    const key = keypair(), invite = access.devices.createInvite(role);
    const input = { code: invite.code, name: 'Test device', platform: 'test', publicKey: key.publicKey };
    const body = Buffer.from(JSON.stringify(input)), path = '/api/network/pair';
    const response = await request('POST', path, body, signed(key.privateKey, 'POST', path, body));
    assert.equal(response.status, 201, response.body.toString());
    return { key, device: JSON.parse(response.body.toString()) as DeviceRecord };
  };
  return { access, store, base, status, ca, request, pair, revoked, mutation: () => mutation, async cleanup() {
    await access.close();
    (store as unknown as { close?: () => void }).close?.();
    rmSync(dir, { recursive: true, force: true });
  } };
}

test('real HTTPS trusts the configured CA, rejects untrusted clients, and protects bootstrap/health', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('GET', '/api/network/info')).status, 200);
    await assert.rejects(f.request('GET', '/api/network/info', Buffer.alloc(0), {}, { ca: undefined }));
    assert.equal((await f.request('GET', '/bootstrap')).status, 401);
    assert.equal((await f.request('GET', '/api/health')).status, 401);
    assert.equal(f.base.sessions.size, 0);
    assert.equal((await f.request('GET', '/')).status, 200);
    const { key, device } = await f.pair();
    const response = await f.request('GET', '/bootstrap', Buffer.alloc(0), signed(key.privateKey, 'GET', '/bootstrap', Buffer.alloc(0), device.id));
    assert.equal(response.status, 200);
    assert.equal(response.headers['set-cookie'], undefined);
    assert.equal(f.base.sessions.size, 1);
    const token = [...f.base.sessions.keys()][0]!;
    assert.match(token, /^[a-f0-9]{64}$/);
    assert.notEqual(token, device.id);
    assert.equal(response.body.toString().includes(token), false);
    assert.equal('publicKey' in f.access.status().devices[0]!, false);
    assert.equal(JSON.stringify(f.access.status()).includes('PRIVATE KEY'), false);
  } finally { await f.cleanup(); }
});

test('signed controllers preserve JSON/CSRF behavior; workers cannot enter controller APIs', async () => {
  const f = await fixture();
  try {
    const controller = await f.pair(), worker = await f.pair('worker');
    const bootstrap = await f.request('GET', '/bootstrap', Buffer.alloc(0), signed(controller.key.privateKey, 'GET', '/bootstrap', Buffer.alloc(0), controller.device.id));
    const csrf = JSON.parse(bootstrap.body.toString()).csrf as string;
    const body = Buffer.from('{"action":"read"}'), path = '/api/mutate';
    assert.equal((await f.request('POST', path, body, signed(controller.key.privateKey, 'POST', path, body, controller.device.id))).status, 403);
    const response = await f.request('POST', path, body, { ...signed(controller.key.privateKey, 'POST', path, body, controller.device.id), 'x-csrf-token': csrf });
    assert.equal(response.status, 200);
    assert.deepEqual(f.mutation(), { action: 'read' });
    assert.equal((await f.request('GET', '/api/health', Buffer.alloc(0), signed(worker.key.privateKey, 'GET', '/api/health', Buffer.alloc(0), worker.device.id))).status, 401);
    const workerPath = '/api/network/worker/poll';
    assert.equal((await f.request('GET', workerPath, Buffer.alloc(0), signed(worker.key.privateKey, 'GET', workerPath, Buffer.alloc(0), worker.device.id))).status, 200);
    assert.equal((await f.request('GET', workerPath, Buffer.alloc(0), signed(controller.key.privateKey, 'GET', workerPath, Buffer.alloc(0), controller.device.id))).status, 401);
  } finally { await f.cleanup(); }
});

test('rejects tampered bodies and replay before app execution', async () => {
  const f = await fixture();
  try {
    const { key, device } = await f.pair();
    const path = '/api/health', headers = signed(key.privateKey, 'GET', path, Buffer.alloc(0), device.id);
    assert.equal((await f.request('GET', path, Buffer.alloc(0), headers)).status, 200);
    assert.equal((await f.request('GET', path, Buffer.alloc(0), headers)).status, 401);
    const original = Buffer.from('{"action":"read"}'), changed = Buffer.from('{"action":"edit"}');
    assert.equal((await f.request('POST', '/api/mutate', changed,
      signed(key.privateKey, 'POST', '/api/mutate', original, device.id))).status, 401);
    assert.equal(f.mutation(), undefined);
    const certificatePath = '/api/network/certificate';
    const certificate = await f.request('GET', certificatePath, Buffer.alloc(0), signed(key.privateKey, 'GET', certificatePath, Buffer.alloc(0), device.id));
    assert.equal(certificate.status, 200);
    assert.equal(certificate.headers['content-type'], 'application/x-x509-ca-cert');
    assert.equal(new X509Certificate(certificate.body).ca, true);
  } finally { await f.cleanup(); }
});

test('enforces Host, Origin, Fetch Metadata, forwarding headers, and exact CORS preflights', async () => {
  const f = await fixture();
  try {
    const invalidHeaders: Array<Record<string, string>> = [
      { host: `localhost:${f.status.port}` }, { origin: 'https://attacker.example' },
      { 'sec-fetch-site': 'cross-site' }, { forwarded: 'for=127.0.0.1' },
      { 'x-forwarded-host': '127.0.0.1' }, { 'x-relay-owner': 'spoof' },
    ];
    for (const headers of invalidHeaders) assert.equal((await f.request('GET', '/api/network/info', Buffer.alloc(0), headers)).status, 403);
    const headers = { origin: 'https://controller.example', 'sec-fetch-site': 'cross-site',
      'access-control-request-method': 'POST', 'access-control-request-headers': 'Content-Type, X-Relay-Signature, X-CSRF-Token' };
    const cors = await f.request('OPTIONS', '/api/mutate', Buffer.alloc(0), headers);
    assert.equal(cors.status, 204);
    assert.equal(cors.headers['access-control-allow-origin'], 'https://controller.example');
    assert.equal(cors.headers['access-control-allow-private-network'], 'true');
    assert.equal(cors.headers['access-control-allow-credentials'], undefined);
    assert.equal((await f.request('OPTIONS', '/api/mutate', Buffer.alloc(0), { ...headers, origin: 'https://attacker.example' })).status, 403);
    assert.equal((await f.request('OPTIONS', '/api/mutate', Buffer.alloc(0), { ...headers, 'access-control-request-headers': 'Authorization' })).status, 403);
    assert.equal((await f.request('OPTIONS', '/api/mutate', Buffer.alloc(0), { ...headers, 'access-control-request-method': 'TRACE' })).status, 403);
  } finally { await f.cleanup(); }
});

test('revocation closes authenticated SSE and removes the stable native session mapping', async () => {
  const f = await fixture();
  let stream: IncomingMessage | undefined;
  try {
    const first = await f.pair(), manager = await f.pair();
    const bootstrap = await f.request('GET', '/bootstrap', Buffer.alloc(0), signed(manager.key.privateKey, 'GET', '/bootstrap', Buffer.alloc(0), manager.device.id));
    const csrf = JSON.parse(bootstrap.body.toString()).csrf as string;
    stream = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = httpsRequest({ hostname: '127.0.0.1', port: f.status.port, path: '/api/events', ca: f.ca,
        headers: signed(first.key.privateKey, 'GET', '/api/events', Buffer.alloc(0), first.device.id) }, res => {
        res.once('data', () => resolve(res)); res.once('error', () => {});
      }); req.once('error', reject); req.end();
    });
    assert.equal(f.base.sessions.size, 2);
    const closed = new Promise<void>(resolve => stream!.once('close', resolve));
    const path = `/api/network/devices/${first.device.id}`;
    const response = await f.request('DELETE', path, Buffer.alloc(0), {
      ...signed(manager.key.privateKey, 'DELETE', path, Buffer.alloc(0), manager.device.id), 'x-csrf-token': csrf,
    });
    assert.equal(response.status, 200);
    await closed;
    assert.equal(f.base.sessions.size, 1);
    assert.equal(f.revoked[0]?.id, first.device.id);
    assert.ok(f.revoked[0]?.session);
    assert.equal((await f.request('GET', '/api/health', Buffer.alloc(0),
      signed(first.key.privateKey, 'GET', '/api/health', Buffer.alloc(0), first.device.id))).status, 401);
  } finally { stream?.destroy(); await f.cleanup(); }
});

test('has no plaintext fallback, restricts bindings, and close preserves enabled configuration', async () => {
  const f = await fixture();
  try {
    const plaintextStatus = await new Promise<number | null>(resolve => {
      const req = httpRequest({ hostname: '127.0.0.1', port: f.status.port, path: '/api/network/info' }, res => {
        res.resume(); resolve(res.statusCode ?? null);
      }); req.once('error', () => resolve(null)); req.end();
    });
    assert.notEqual(plaintextStatus, 200);
    await assert.rejects(f.access.enable({ address: '0.0.0.0' }));
    await assert.rejects(f.access.enable({ address: '8.8.8.8' }));
    await assert.rejects(f.access.enable({ address: '192.168.1.12' }));
    await assert.rejects(f.access.enable({ address: '127.0.0.1', port: 443 }));
    await assert.rejects(f.access.enable({ address: '127.0.0.1', port: 80 }));
    await assert.rejects(f.access.enable({ address: '127.0.0.1', controllerOrigins: ['https://controller.example/path'] }));
    await assert.rejects(f.access.enable({ address: '127.0.0.1', controllerOrigins: ['https://*.example'] }));
    await f.access.close();
    assert.equal(f.access.status().listening, false);
    assert.equal(f.store.get<{ enabled: boolean }>('config', 'network-access')?.enabled, true);
  } finally { await f.cleanup(); }
});

test('signed query values allow source paths while encoded path delimiters are rejected',async()=>{
const f=await fixture();try{const {key,device}=await f.pair();for(const path of ['/api/read?path=client%2FApp.tsx','/api/read?path=C%3A%5CUsers%5CProject']){const response=await f.request('GET',path,Buffer.alloc(0),signed(key.privateKey,'GET',path,Buffer.alloc(0),device.id));assert.equal(response.status,200);}for(const path of ['/api%2Fread','/api%5Cread','/api%00read'])assert.equal((await f.request('GET',path,Buffer.alloc(0),signed(key.privateKey,'GET',path,Buffer.alloc(0),device.id))).status,400);}finally{await f.cleanup();}});
