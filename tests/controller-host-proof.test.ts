import assert from 'node:assert/strict';
import { randomBytes, verify, X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { request } from 'node:https';
import { NetworkCertificates } from '../server/network-certificates.js';
import { NetworkAccess } from '../server/network-access.js';
import { LocalNetworkTrust } from '../server/network-local-trust.js';
import { Security } from '../server/security.js';
import { Store } from '../server/store.js';
import { checkControllerHost, ControllerConnectionError, getLocalNetworkPermission } from '../client/controller-host.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'relay-host-proof-'));
  const store = new Store(dir), secrets = new Map<string, string>();
  let reads = 0;
  const vault = {
    async has(key: string) { return secrets.has(key); }, async get(key: string) { reads++; return secrets.get(key) ?? null; },
    async set(key: string, value: string) { secrets.set(key, value); }, async remove(key: string) { secrets.delete(key); },
    close() {}, availability() { return { available: true, protection: 'test' }; },
  };
  const certificates = new NetworkCertificates(store, vault);
  return { store, vault, certificates, secrets, reads: () => reads, cleanup() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const origin = 'https://192.168.1.20:3443';
const challenge = () => randomBytes(32).toString('base64url');
const payload = (url: string, nonce: string, fingerprint: string) => Buffer.from(JSON.stringify(['relay-host-proof-v1', url, nonce, fingerprint]));

test('proof binds fresh challenge, exact origin and CA; caches validated signing key and clears on close', async () => {
  const f = fixture();
  try {
    await f.certificates.material('192.168.1.20');
    const ca = f.certificates.publicCA()!, root = new X509Certificate(ca.certificate);
    const nonce = challenge(), proof = await f.certificates.hostProof(origin, nonce);
    const signature = Buffer.from(proof.signature, 'base64url');
    assert.equal(signature.length, 64);
    const valid = (url: string, value: string, fingerprint: string) => verify('sha256', payload(url, value, fingerprint), { key: root.publicKey, dsaEncoding: 'ieee-p1363' }, signature);
    assert.equal(valid(origin, nonce, ca.fingerprint), true);
    assert.equal(valid(origin, challenge(), ca.fingerprint), false);
    assert.equal(valid(origin.replace(':3443', ':3444'), nonce, ca.fingerprint), false);
    assert.equal(valid(origin, nonce, '0'.repeat(64)), false);
    const reads = f.reads();
    for (let i = 0; i < 3; i++) await f.certificates.hostProof(origin, challenge());
    assert.equal(f.reads(), reads);
    f.certificates.clearHostProof(); await f.certificates.hostProof(origin, challenge());
    assert.equal(f.reads(), reads + 1);
    for (const bad of ['', 'x'.repeat(31), 'x'.repeat(97), 'x'.repeat(31) + '=', '\n' + nonce]) await assert.rejects(f.certificates.hostProof(origin, bad));
    await assert.rejects(f.certificates.hostProof('https://evil.example', nonce));
    assert.equal(JSON.stringify(proof).includes('PRIVATE KEY'), false);
  } finally { f.cleanup(); }
});

test('browser verifies pinned DER and fresh signed CA proof, rejects replay/tamper/wrong origin/wrong CA', async () => {
  const f = fixture(), other = fixture();
  const originalFetch = globalThis.fetch;
  try {
    await f.certificates.material('192.168.1.20'); await other.certificates.material('192.168.1.20');
    const ca = f.certificates.publicCA()!, profile = { url: origin, ca: ca.certificate, fingerprint: ca.fingerprint };
    let replay: unknown, mode = 'valid', calls = 0;
    globalThis.fetch = ((url: string, init: RequestInit) => {
      calls++;
      assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
      const nonce = new URL(url).searchParams.get('challenge')!;
      return (async () => {
        const proof = await f.certificates.hostProof(mode === 'signed-other-origin' ? origin.replace(':3443', ':3444') : origin, nonce);
        let info: Record<string, unknown> = { protocol: 1, url: origin, publicCA: ca.certificate, fingerprint: ca.fingerprint, hostProof: proof };
        if (mode === 'replay') info.hostProof = replay;
        else if (mode === 'tamper') info.hostProof = { ...proof, signature: 'A'.repeat(86) };
        else if (mode === 'wrong-ca') info.publicCA = other.certificates.publicCA()!.certificate;
        else if (mode === 'wrong-origin') info.url = origin.replace(':3443', ':3444');
        else if (mode === 'legacy') delete info.hostProof;
        else if (mode === 'valid') replay = proof;
        return new Response(JSON.stringify(info), { headers: { 'Content-Type': 'application/json' } });
      })();
    }) as typeof fetch;
    const checking = checkControllerHost(profile);
    assert.equal(calls, 1, 'fetch starts synchronously during the button gesture');
    assert.equal((await checking).verified, true);
    assert.equal((await checkControllerHost(profile)).verified, true);
    for (const value of ['replay', 'tamper', 'wrong-ca', 'wrong-origin', 'signed-other-origin']) {
      mode = value; await assert.rejects(checkControllerHost(profile), (e: unknown) => e instanceof ControllerConnectionError && e.kind === 'identity-changed', value);
    }
    mode = 'legacy'; await assert.rejects(checkControllerHost(profile), (e: unknown) => e instanceof ControllerConnectionError && e.kind === 'host-update-required');
    await assert.rejects(checkControllerHost({ ...profile, fingerprint: '0'.repeat(64) }), (e: unknown) => e instanceof ControllerConnectionError && e.kind === 'identity-changed');
    globalThis.fetch = (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch;
    await assert.rejects(checkControllerHost(profile), (e: unknown) => e instanceof ControllerConnectionError && e.kind === 'trust-or-network');
    const signal = AbortSignal.abort(); await assert.rejects(checkControllerHost(profile, { signal }), (e: unknown) => e instanceof ControllerConnectionError && e.kind === 'aborted');
  } finally { globalThis.fetch = originalFetch; f.cleanup(); other.cleanup(); }
});

test('permission detection uses only the granular native descriptor and handles unsupported browsers', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const restore = () => { if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor); else Reflect.deleteProperty(globalThis, 'navigator'); };
  try {
    for (const state of ['granted', 'prompt', 'denied'] as const) {
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { permissions: { async query(input: { name: string }) { assert.equal(input.name, 'local-network'); return { state }; } } } });
      assert.equal(await getLocalNetworkPermission(), state);
    }
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { permissions: { async query() { throw new TypeError(); } } } });
    assert.equal(await getLocalNetworkPermission(), 'unknown');
  } finally { restore(); }
});

test('trust status reads only; install requires exact confirmation and canonical public CA, confirms using a fresh read', async () => {
  const f = fixture();
  try {
    await f.certificates.material('192.168.1.20'); const ca = f.certificates.publicCA()!;
    let installed = false; const calls: string[] = [];
    const trust = new LocalNetworkTrust(f.certificates, { platform: 'win32', operation: async (op, der, fingerprint) => {
      calls.push(op); assert.equal(fingerprint, ca.fingerprint); assert.equal(new X509Certificate(Buffer.from(der, 'base64')).ca, true);
      if (op === 'install') installed = true;
      return installed;
    } });
    assert.equal((await trust.status()).trusted, false); assert.deepEqual(calls, ['read']);
    await assert.rejects(trust.install('0'.repeat(64), true));
    await assert.rejects(trust.install(ca.fingerprint, false as true));
    assert.deepEqual(calls, ['read']);
    assert.equal((await trust.install(ca.fingerprint, true)).trusted, true); assert.deepEqual(calls, ['read', 'install', 'read']);
    const pending = new LocalNetworkTrust(f.certificates, { platform: 'win32', operation: async () => false });
    assert.equal((await pending.install(ca.fingerprint, true)).pending, true);
    const unsupported = new LocalNetworkTrust(f.certificates, { platform: 'linux', operation: async () => { throw new Error('Must not call'); } });
    assert.equal((await unsupported.install(ca.fingerprint, true)).supported, false);
  } finally { f.cleanup(); }
});

test('local trust management rejects remote, LAN-authenticated, missing CSRF, mismatched and extra confirmation inputs', async () => {
  const f = fixture(), security = new Security(3210); let installs = 0, writable = true;
  const access = new NetworkAccess(f.store, security, f.vault, {
    assertWritable() { if (!writable) throw new Error('readonly'); }, async handle() {}, async workerRequest() {}, async onRevoke() {},
  }, { localTrust: { platform: 'win32', operation: async op => { if (op === 'install') installs++; return false; } } });
  try {
    await access.certificates.material('192.168.1.20'); const ca = access.certificates.publicCA()!;
    security.sessions.set('test', { csrf: 'csrf', touched: Date.now() });
    const invoke = async (method: string, body: unknown, remote = '127.0.0.1', csrf = 'csrf', verified = false) => {
      const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as IncomingMessage;
      req.method = method; req.headers = { host: 'localhost:3210', cookie: 'relay_session_3210=test', 'content-type': 'application/json', 'x-csrf-token': csrf };
      Object.defineProperty(req, 'socket', { value: { remoteAddress: remote } });
      if (verified) Reflect.get(access, 'verified').set(req, {});
      const response = { writeHead() {}, end() {} } as unknown as ServerResponse;
      return access.manage(req, response, new URL('http://localhost:3210/api/network/local-trust'));
    };
    assert.equal(await invoke('GET', undefined), true); assert.equal(installs, 0);
    for (const remote of ['192.168.1.20', '::ffff:192.168.1.20']) await assert.rejects(invoke('POST', { fingerprint: ca.fingerprint, confirm: true }, remote));
    await assert.rejects(invoke('POST', { fingerprint: ca.fingerprint, confirm: true }, '127.0.0.1', 'csrf', true));
    await assert.rejects(invoke('POST', { fingerprint: ca.fingerprint, confirm: true }, '127.0.0.1', 'bad'));
    await assert.rejects(invoke('POST', { fingerprint: '0'.repeat(64), confirm: true }));
    await assert.rejects(invoke('POST', { fingerprint: ca.fingerprint, confirm: false }));
    await assert.rejects(invoke('POST', { fingerprint: ca.fingerprint, confirm: true, certificate: ca.certificate }));
    writable = false; await assert.rejects(invoke('POST', { fingerprint: ca.fingerprint, confirm: true })); writable = true;
    assert.equal(installs, 0); assert.equal(await invoke('POST', { fingerprint: ca.fingerprint, confirm: true }), true); assert.equal(installs, 1);
  } finally { await access.close(); f.cleanup(); }
});

test('network info preserves protocol1 legacy shape and accepts only a bounded challenge query', async () => {
  const f = fixture(), security = new Security(3210);
  const access = new NetworkAccess(f.store, security, f.vault, { assertWritable() {}, async handle() {}, async workerRequest() {}, async onRevoke() {} },
    { allowLoopbackTest: true, interfaces: () => [{ name: 'loopback', address: '127.0.0.1', netmask: '255.0.0.0' }] });
  try {
    const status = await access.enable({ address: '127.0.0.1', port: 0 });
    const get = (path: string) => new Promise<{ status: number; info: Record<string, unknown> }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: status.port, path, ca: access.certificates.publicCA()!.certificate }, res => {
        const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(Buffer.from(chunk))); res.once('end', () => resolve({ status: res.statusCode!, info: JSON.parse(Buffer.concat(chunks).toString()) }));
      }); req.once('error', reject); req.end();
    });
    assert.deepEqual(Object.keys((await get('/api/network/info')).info).sort(), ['fingerprint', 'protocol', 'publicCA', 'url']);
    const nonce = challenge(), result = await get('/api/network/info?challenge=' + nonce);
    assert.equal(result.status, 200); assert.equal((result.info.hostProof as { challenge: string }).challenge, nonce);
    for (const query of ['challenge=', 'challenge=bad', 'challenge=' + 'a'.repeat(97), 'challenge=' + nonce + '&challenge=' + nonce, 'other=' + nonce]) assert.equal((await get('/api/network/info?' + query)).status, 400);
  } finally { await access.close(); f.cleanup(); }
});
