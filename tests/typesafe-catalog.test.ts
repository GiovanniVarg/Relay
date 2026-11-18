import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { TypeSafeIntegration, type SecretVaultLike } from '../server/typesafe.js';
import { typeSafeCatalogIssueMessage } from '../shared/typesafe-errors.js';

const key = 'synthetic-catalog-key-never-display';
const card = { name: 'jev-latest', description: 'Model', release_date: '2026-09-15' };
async function fixture(response: () => Response) {
    const root = await mkdtemp(join(tmpdir(), 'relay-typesafe-catalog-')), store = new Store(root);
    const values = new Map<string, string>(); let calls = 0;
    const vault: SecretVaultLike = { async has(n) { return values.has(n); }, async get(n) { return values.get(n); }, async set(n, v, check) { check?.(); values.set(n, v); }, async remove(n) { values.delete(n); }, close() {}, availability() { return { available: true, protection: 'synthetic encrypted backend' }; } };
    const service = new TypeSafeIntegration(store, vault, { fetch: (async () => { calls++; return response(); }) as typeof fetch });
    await service.initialize();
    return { service, store, values, calls: () => calls, async connect() { const { nonce } = service.credentialRequest('s', {}); return service.connectCredential('s', { nonce, apiKey: key }); }, async close() { await service.close(); store.close(); await rm(root, { recursive: true, force: true }); } };
}

test('OpenAPI string metadata and opaque model identities connect without undocumented format constraints', async () => {
    const name = 'account@jev preview (stable)', f = await fixture(() => Response.json({ models: [{ name, description: 'd'.repeat(2500), release_date: '2026-10-23T12:34:56.123456789+00:00' }] }));
    try {
        const status = await f.connect();
        assert.equal(status.configured, true);
        assert.equal(status.model, name);
        assert.equal(status.models[0].description, 'd'.repeat(2000));
        assert.equal(status.models[0].releaseDate?.length, 30);
        assert.equal((await f.service.updateModel({ model: name })).model, name);
        const restarted = new TypeSafeIntegration(f.store, { async has() { return true; }, async get() { return key; }, async set() {}, async remove() {}, close() {}, availability() { return { available: true }; } });
        await restarted.initialize();
        assert.equal(restarted.status().model, name);
        await restarted.close();
    } finally { await f.close(); }
});

test('irrelevant deeply nested provider extensions do not reject a usable catalog', async () => {
    let extra: unknown = 'ignored'; for (let i = 0; i < 30; i++) extra = { extra };
    const f = await fixture(() => Response.json({ models: [{ ...card, extra }], extra }));
    try { assert.equal((await f.connect()).configured, true); assert.equal(f.calls(), 1); } finally { await f.close(); }
});

test('runtime-tolerant ancillary metadata falls back without weakening operational identity checks', async () => {
    for (const fields of [{}, { description: null, release_date: null }, { description: { untrusted: key }, release_date: 42 }]) {
        const f = await fixture(() => Response.json({ models: [{ name: card.name, ...fields }] }));
        try { const status = await f.connect(); assert.equal(status.models[0].description, ''); assert.equal(status.models[0].releaseDate, undefined); assert.equal(JSON.stringify(f.store.list('integration')).includes(key), false); } finally { await f.close(); }
    }
});

test('presentation metadata is redacted before truncation and model names retain exact whitespace', async () => {
    const f = await fixture(() => Response.json({ models: [{ name: ' model ', description: 'x'.repeat(1995) + key, release_date: key }] }));
    try { const status = await f.connect(); assert.equal(status.model, ' model '); assert.equal(status.models[0].description.includes(key.slice(0, 5)), false); assert.equal(JSON.stringify([status, f.store.list('integration')]).includes(key), false); } finally { await f.close(); }
});

test('catalog accepts more than 100 valid identities while retaining the explicit 1000-model cap', async () => {
    const f = await fixture(() => Response.json({ models: Array.from({ length: 101 }, (_, i) => ({ ...card, name: 'model-' + i })) }));
    try { assert.equal((await f.connect()).models.length, 101); } finally { await f.close(); }
});

test('exact duplicate identities yield one choice and preserve the first model metadata', async () => {
    const f = await fixture(() => Response.json({ models: [card, { ...card, description: 'Duplicate description' }] }));
    try { const status = await f.connect(); assert.deepEqual(status.models, [{ name: card.name, description: card.description, releaseDate: card.release_date }]); } finally { await f.close(); }
});

test('catalog issue messages reject hostile inherited names and unknown provider values', () => {
    assert.equal(typeof typeSafeCatalogIssueMessage('model_name_limit'), 'string');
    for (const value of ['__proto__', 'constructor', 'toString', key, {}, undefined]) assert.equal(typeSafeCatalogIssueMessage(value), undefined);
});

test('catalog rejection reports only a closed issue, never body fields, values, or the candidate key', async () => {
    const cases = [
        ['response_missing', () => new Response(null, { status: 204 })],
        ['response_too_large', () => new Response('x'.repeat(131073))],
        ['invalid_json', () => new Response('{')],
        ['wrapper_shape', () => Response.json({ untrusted: key })],
        ['models_empty', () => Response.json({ models: [] })],
        ['model_count_limit', () => Response.json({ models: Array.from({ length: 1001 }, (_, i) => ({ name: String(i) })) })],
        ['model_entry_shape', () => Response.json({ models: [null] })],
        ['model_name_type', () => Response.json({ models: [{ name: null }] })],
        ['model_name_limit', () => Response.json({ models: [{ name: 'x'.repeat(513) }] })],
        ['model_name_control', () => Response.json({ models: [{ name: 'model\u0000' }] })],
        ['model_name_sensitive', () => Response.json({ models: [{ name: key }] })],
    ] as const;
    for (const [issue, response] of cases) {
        const f = await fixture(response);
        try {
            await assert.rejects(f.connect(), error => {
                assert.equal((error as { code?: string }).code, 'invalid_catalog');
                assert.equal((error as { catalogIssue?: string }).catalogIssue, issue);
                assert.equal(String(error).includes(key), false);
                return true;
            });
            assert.equal((f.service.status() as { catalogIssue?: string }).catalogIssue, issue);
            assert.equal(f.values.size, 0);
            assert.equal(f.calls(), 1);
            assert.equal(JSON.stringify(f.service.status()).includes(key), false);
        } finally { await f.close(); }
    }
});
