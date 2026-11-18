import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import QRCode from 'qrcode';
import { connectionDestination, connectionProfile, networkDownloads } from '../server/network-downloads.js';
import { NetworkCertificates } from '../server/network-certificates.js';
import { Store } from '../server/store.js';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'relay-downloads-')), store = new Store(directory), secrets = new Map<string, string>();
  const vault = { async get(name: string) { return secrets.get(name) ?? null; }, async set(name: string, value: string) { secrets.set(name, value); }, async remove(name: string) { secrets.delete(name); } };
  const material = await new NetworkCertificates(store, vault).material('192.168.1.7');
  const status = { listening: true, url: 'https://192.168.1.7:3443', publicCA: material.ca, fingerprint: material.rootFingerprint,
    controllerOrigins: ['https://controller.example'], code: 'INVITE-MUST-NOT-APPEAR', privateKey: material.key };
  return { directory, status, async cleanup() { store.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('QR destination contains only the public connection profile in an approved HTTPS fragment', async () => {
  const f = await fixture();
  try {
    const destination = new URL(connectionDestination(f.status, 'https://controller.example'));
    assert.equal(destination.origin, 'https://controller.example'); assert.equal(destination.search, '');
    const profile = JSON.parse(Buffer.from(destination.hash.slice('#connect='.length), 'base64url').toString());
    assert.deepEqual(Object.keys(profile).sort(), ['ca', 'fingerprint', 'url']);
    assert.deepEqual(profile, connectionProfile(f.status));
    assert.equal(JSON.stringify(profile).includes(f.status.code), false);
    assert.equal(JSON.stringify(profile).includes('PRIVATE KEY'), false);
    for (const origin of ['https://attacker.example', 'http://controller.example', 'https://controller.example/path', 'https://*.example', 'https://user@controller.example']) {
      assert.throws(() => connectionDestination(f.status, origin));
    }
    assert.throws(() => connectionDestination({ ...f.status, listening: false }, 'https://controller.example'));
  } finally { await f.cleanup(); }
});

test('protected-route helper returns the actual SVG encoder output and rejects extra QR parameters', async () => {
  const f = await fixture();
  try {
    let code = 0, headers: Record<string, unknown> = {}, body = '';
    const response = { writeHead(status: number, values: Record<string, unknown>) { code = status; headers = values; }, end(value: string) { body = value; } } as unknown as ServerResponse;
    const request = { method: 'GET' } as IncomingMessage;
    const options = { access: { status: () => f.status } as unknown as Parameters<typeof networkDownloads>[3]['access'], installation: f.directory };
    const url = new URL('http://localhost/api/network/connection-qr?origin=https%3A%2F%2Fcontroller.example');
    assert.equal(await networkDownloads(request, response, url, options), true);
    assert.equal(code, 200); assert.equal(headers['Content-Type'], 'image/svg+xml; charset=utf-8');
    assert.equal(headers['Cache-Control'], 'no-store'); assert.match(body, /^<svg\b/);
    assert.equal(body, await QRCode.toString(connectionDestination(f.status, 'https://controller.example'), { type: 'svg', errorCorrectionLevel: 'M', margin: 3, width: 240 }));
    await assert.rejects(networkDownloads(request, response, new URL(url + '&code=hidden'), options));
    await assert.rejects(networkDownloads(request, response, new URL(url + '&origin=https%3A%2F%2Fcontroller.example'), options));
    await assert.rejects(networkDownloads({ method: 'POST' } as IncomingMessage, response, url, options));
    assert.equal(await networkDownloads(request, response, new URL('http://localhost/elsewhere'), options), false);
  } finally { await f.cleanup(); }
});
