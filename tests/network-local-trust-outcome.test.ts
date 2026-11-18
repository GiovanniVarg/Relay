import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { NetworkCertificates } from '../server/network-certificates.js';
import { LocalNetworkTrust, LocalTrustOperationError } from '../server/network-local-trust.js';
import { Store } from '../server/store.js';

test('trust outcomes preserve known timeout, keep generic errors unconfirmed and never expose raw errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-trust-outcome-')), store = new Store(dir), secrets = new Map<string, string>();
  const vault = { async get(key: string) { return secrets.get(key) ?? null; }, async set(key: string, value: string) { secrets.set(key, value); }, async remove(key: string) { secrets.delete(key); } };
  const certificates = new NetworkCertificates(store, vault);
  try {
    await certificates.material('192.168.1.20'); const fingerprint = certificates.publicCA()!.fingerprint;
    for (const [failure, expected] of [[new LocalTrustOperationError('timeout', ['before-add']), 'timeout'], [new Error('raw private diagnostic'), 'unconfirmed']] as const) {
      const calls: string[] = [];
      const trust = new LocalNetworkTrust(certificates, { platform: 'win32', operation: async op => { calls.push(op); if (op === 'install') throw failure; return false; } });
      const result = await trust.install(fingerprint, true);
      assert.equal(result.trusted, false); assert.equal(result.pending, true); assert.equal(result.reason, expected);
      assert.deepEqual(calls, ['install', 'read']);
      assert.equal(JSON.stringify(result).includes('raw private diagnostic'), false);
      assert.equal('stages' in result, false);
    }
    const alreadyTrusted = new LocalNetworkTrust(certificates, { platform: 'win32', operation: async op => { if (op === 'install') throw new LocalTrustOperationError('timeout'); return true; } });
    const trusted = await alreadyTrusted.install(fingerprint, true);
    assert.equal(trusted.trusted, true); assert.equal(trusted.pending, false); assert.equal('reason' in trusted, false);
    const readTimeout = new LocalNetworkTrust(certificates, { platform: 'win32', operation: async () => { throw new LocalTrustOperationError('timeout'); } });
    assert.equal((await readTimeout.status()).reason, 'timeout');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
