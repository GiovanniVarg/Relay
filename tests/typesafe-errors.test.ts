import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { TypeSafeIntegration, type SecretVaultLike } from '../server/typesafe.js';
import { typesafeApi } from '../server/typesafe-api.js';
import { typeSafeErrorMessage, type TypeSafeErrorCode } from '../shared/typesafe-errors.js';

const key = 'synthetic-diagnostic-secret-never-show';
const models = { models: [{ name: 'jev-latest', description: 'Model', release_date: '2026-09-15' }] };
test('diagnostic messages accept only known codes, including hostile inherited property names', () => {
    for (const code of ['auth_rejected', 'rate_limited', 'service_unavailable', 'network_error', 'cancelled_or_timeout', 'invalid_catalog', 'storage_failed', 'request_expired', 'invalid_key_format', 'configuration_busy', 'unknown'] satisfies TypeSafeErrorCode[]) {
        assert.equal(typeof typeSafeErrorMessage(code), 'string');
    }
    for (const code of ['__proto__', 'constructor', 'toString', key, {}, null, undefined]) assert.equal(typeSafeErrorMessage(code), undefined);
});
async function fixture(fetcher: typeof fetch, failStorage = false, timeoutMs = 1000) {
    const root = await mkdtemp(join(tmpdir(), 'relay-typesafe-errors-'));
    const store = new Store(root);
    const values = new Map<string, string>();
    const vault: SecretVaultLike = {
        async has(name) { return values.has(name); }, async get(name) { return values.get(name); },
        async set(name, value, check) { check?.(); if (failStorage) throw Error('vault ' + key); values.set(name, value); },
        async remove(name) { values.delete(name); }, close() {},
        availability() { return { available: true, protection: 'synthetic encrypted backend' }; },
    };
    const service = new TypeSafeIntegration(store, vault, { fetch: fetcher, timeoutMs });
    await service.initialize();
    return { service, store, values, async close() { await service.close(); store.close(); await rm(root, { recursive: true, force: true }); } };
}

test('connection failures have closed diagnostic codes and trusted status messages without secret echoes', async () => {
    const cases = [
        { code: 'auth_rejected', status: 400, fetch: async () => Response.json({ detail: key }, { status: 401 }) },
        { code: 'auth_rejected', status: 400, fetch: async () => Response.json({ detail: key }, { status: 403 }) },
        { code: 'rate_limited', status: 502, fetch: async () => Response.json({ detail: key }, { status: 429 }) },
        { code: 'service_unavailable', status: 502, fetch: async () => Response.json({ detail: key }, { status: 500 }) },
        { code: 'network_error', status: 502, fetch: async () => { throw TypeError('TLS ' + key); } },
        { code: 'invalid_catalog', status: 502, fetch: async () => Response.json({ models: [{ name: null, description: null, secret: key }] }) },
        { code: 'storage_failed', status: 503, fetch: async () => Response.json(models), failStorage: true },
        { code: 'cancelled_or_timeout', status: 409, fetch: async () => new Promise<Response>(() => {}), timeoutMs: 10 },
    ];
    for (const sample of cases) {
        let calls = 0;
        const f = await fixture((async () => { calls++; return sample.fetch(); }) as typeof fetch, sample.failStorage, sample.timeoutMs);
        try {
            const { nonce } = f.service.credentialRequest('session', {});
            let failure: unknown;
            try { await f.service.connectCredential('session', { nonce, apiKey: key }); } catch (error) { failure = error; }
            assert.equal((failure as { code?: string })?.code, sample.code);
            assert.equal((failure as { status?: number })?.status, sample.status);
            assert.equal(f.service.status().error, (failure as Error).message);
            assert.equal(f.service.status().errorCode, sample.code);
            assert.equal(calls, 1);
            assert.equal(f.values.size, 0);
            assert.equal(JSON.stringify([f.service.status(), f.store.list('integration'), String(failure)]).includes(key), false);
        } finally { await f.close(); }
    }
});

test('expired session nonce, invalid key format and concurrent configuration get actionable codes', async () => {
    let release!: () => void;
    const f = await fixture((async () => { await new Promise<void>(resolve => release = resolve); return Response.json(models); }) as typeof fetch);
    try {
        const { nonce } = f.service.credentialRequest('session', {});
        await assert.rejects(f.service.connectCredential('another-session', { nonce, apiKey: key }), { code: 'request_expired', status: 403 });
        await assert.rejects(f.service.connectCredential('session', { nonce, apiKey: 'Bearer ' + key }), { code: 'invalid_key_format', status: 400 });
        const first = f.service.connectCredential('session', { nonce, apiKey: key });
        const next = f.service.credentialRequest('session', {});
        await assert.rejects(f.service.connectCredential('session', { nonce: next.nonce, apiKey: key }), { code: 'configuration_busy', status: 409 });
        release();
        await first;
    } finally { release?.(); await f.close(); }
});

test('connect HTTP response never forwards untrusted errors and classifies upstream authentication', async () => {
    const f = await fixture((async () => Response.json({ detail: key }, { status: 401 })) as typeof fetch);
    const server = createServer((req, res) => { void typesafeApi(req, res, new URL(req.url!, 'http://localhost'), f.service, 'session').catch(() => { res.writeHead(500); res.end('outer handler'); }); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const address = server.address() as { port: number };
        const url = `http://127.0.0.1:${address.port}/api/integrations/typesafe/connect`;
        const { nonce } = f.service.credentialRequest('session', {});
        const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce, apiKey: key }) });
        const result = await response.json() as { code?: string; error?: string };
        assert.equal(response.status, 400);
        assert.equal(result.code, 'auth_rejected');
        assert.equal(result.error, f.service.status().error);
        assert.equal(JSON.stringify(result).includes(key), false);
        for (const [input, code] of [[{ nonce, apiKey: '' }, 'invalid_key_format'], [{ nonce: '', apiKey: key }, 'request_expired']] as const) {
            const invalid = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
            assert.equal((await invalid.json() as { code?: string }).code, code);
        }
        f.service.connectCredential = async () => { throw Error(key); };
        const unexpected = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce, apiKey: key }) });
        const unknown = await unexpected.json() as { code?: string; error?: string };
        assert.equal(unknown.code, 'unknown');
        assert.equal(JSON.stringify(unknown).includes(key), false);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); await f.close(); }
});
