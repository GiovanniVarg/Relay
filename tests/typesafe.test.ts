import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { TypeSafeIntegration, type SecretVaultLike } from '../server/typesafe.js';
const key = 'synthetic-typesafe-secret-123456789';
function vault(): SecretVaultLike & {
    values: Map<string, string>;
} { const values = new Map<string, string>(); return { values, async has(n) { return values.has(n); }, async get(n) { return values.get(n); }, async set(n, v, check) { check?.(); values.set(n, v); }, async remove(n) { values.delete(n); }, async close() { values.clear(); }, availability() { return { available: true, protection: 'test encrypted backend' }; } }; }
const models = { models: [{ name: 'jev-latest', description: 'Model', release_date: '2026-09-15' }] };
async function fixture(fetcher: typeof fetch, options: {
    timeoutMs?: number;
} = {}) { const root = await mkdtemp(join(tmpdir(), 'relay-typesafe-')); const store = new Store(root); const v = vault(); const service = new TypeSafeIntegration(store, v, { fetch: fetcher, ...options }); await service.initialize(); return { root, store, v, service, async close() { await service.close(); store.close(); await rm(root, { recursive: true, force: true }); } }; }
test('secure settings nonce validates catalog without inference and keeps key outside records/status', async () => { let calls = 0; const f = await fixture((async (url, init) => { calls++; assert.equal(url, 'https://api.typesafe.ai/v1/models'); assert.equal(init?.redirect, 'error'); assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer ' + key); return Response.json(models); }) as typeof fetch); try {
    const challenge = f.service.credentialRequest('session', {});
    const status = await f.service.connectCredential('session', { nonce: challenge.nonce, apiKey: key });
    assert.equal(status.configured, true);
    assert.equal(status.model, 'jev-latest');
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(f.store.list('integration')).includes(key), false);
    assert.equal(JSON.stringify(status).includes(key), false);
    assert.equal(f.v.values.get('typesafe-api-key'), key);
    await assert.rejects(f.service.connectCredential('session', { nonce: challenge.nonce, apiKey: key }), { status: 409 });
}
finally {
    await f.close();
} });
test('typed decisions validate IDs/types/probabilities and use only the selected fixed endpoint once', async () => { let calls = 0; const f = await fixture((async (url, init) => { calls++; if (String(url).endsWith('/models'))
    return Response.json(models); assert.equal(url, 'https://api.typesafe.ai/v1/systemone'); const body = JSON.parse(String(init?.body)); assert.equal(body.model, 'jev-latest'); assert.equal(body.questions.ok.type, 'noul'); return Response.json({ model: 'jev-1.13.0', answers: { ok: { type: 'noul', noul: .9 } }, usage: { input_tokens: 12, output_tokens: 3 } }); }) as typeof fetch); try {
    const c = f.service.credentialRequest('s', {});
    await f.service.connectCredential('s', { nonce: c.nonce, apiKey: key });
    const controller = new AbortController();
    const result = await f.service.decide({ runId: 'r', agentId: 'a', signal: controller.signal, isActive: () => true, interact: async () => ({ decision: 'deny' }) }, { state: 'Ticket', questions: { ok: { type: 'noul', instructions: 'Is it okay?' } } });
    assert.deepEqual(result.answers, { ok: { type: 'noul', noul: .9 } });
    assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 3 });
    assert.equal(calls, 2);
}
finally {
    await f.close();
} });
test('upstream failures never echo submitted keys and never retry', async () => { let calls = 0; const f = await fixture((async () => { calls++; throw Error('Bearer ' + key); }) as typeof fetch); try {
    const c = f.service.credentialRequest('s', {});
    await assert.rejects(f.service.connectCredential('s', { nonce: c.nonce, apiKey: key }), error => !String(error).includes(key));
    assert.equal(calls, 1);
    assert.equal(f.v.values.size, 0);
}
finally {
    await f.close();
} });
test('Choice and Score replies preserve explicit criteria and normalized usage', async () => { const f = await fixture((async (url) => String(url).endsWith('/models') ? Response.json(models) : Response.json({ model: 'jev-1.13.0', answers: { team: { type: 'choice', choice: 'builder', confidence: .6, probabilities: { builder: .8, reviewer: .2 } }, severity: { type: 'score', score: 1.4, confidence: .4, probabilities: { '0': 0, '1': .6, '2': .4 }, legend: { '0': 'Small', '1': 'Medium', '2': 'Large' } } }, usage: { input_tokens: 31, output_tokens: 6 } })) as typeof fetch); try {
    const c = f.service.credentialRequest('s', {});
    await f.service.connectCredential('s', { nonce: c.nonce, apiKey: key });
    const result = await f.service.decide({ runId: 'r', agentId: 'a', signal: new AbortController().signal, isActive: () => true, interact: async () => ({ decision: 'deny' }) }, { state: { ticket: 'Broken' }, questions: { team: { type: 'choice', instructions: 'Which team?', criteria: { builder: 'Build', reviewer: null } }, severity: { type: 'score', instructions: 'How severe?', criteria: ['Small', 'Medium', 'Large'] } } });
    assert.equal(result.answers.team.type, 'choice');
    assert.equal(result.answers.severity.type, 'score');
    assert.equal(result.usage.inputTokens, 31);
}
finally {
    await f.close();
} });
test('malformed answer IDs/types, nonfinite or out-of-range values fail without retries', async () => { for (const answer of [{ wrong: { type: 'noul', noul: .5 } }, { ok: { type: 'choice', choice: 'x' } }, { ok: { type: 'noul', noul: 2 } }, { ok: { type: 'noul', noul: null } }, { ok: { type: 'noul', noul: .5, extra: 'ignored?' } }]) {
    let calls = 0;
    const f = await fixture((async (url) => { calls++; return String(url).endsWith('/models') ? Response.json(models) : Response.json({ model: 'jev-latest', answers: answer, usage: { input_tokens: 1, output_tokens: 1 } }); }) as typeof fetch);
    try {
        const c = f.service.credentialRequest('s', {});
        await f.service.connectCredential('s', { nonce: c.nonce, apiKey: key });
        await assert.rejects(f.service.decide({ runId: 'r', agentId: 'a', signal: new AbortController().signal, isActive: () => true, interact: async () => ({ decision: 'deny' }) }, { state: 'Ticket', questions: { ok: { type: 'noul', instructions: 'Okay?' } } }));
        assert.equal(calls, 2);
    }
    finally {
        await f.close();
    }
} });
test('key redaction covers nested objects and JSON-escaped instruction strings', async () => { const special = 'synthetic-quote-"-slash-\\-secret'; const f = await fixture((async () => Response.json(models)) as typeof fetch); try {
    const c = f.service.credentialRequest('s', {});
    await f.service.connectCredential('s', { nonce: c.nonce, apiKey: special });
    const raw = JSON.stringify({ nested: { key: special } });
    assert.equal(f.service.redact(raw).includes(JSON.stringify(special).slice(1, -1)), false);
    assert.equal(JSON.stringify(f.service.redact({ nested: [special] })).includes('synthetic-quote'), false);
    await assert.rejects(f.service.decide({ runId: 'r', agentId: 'a', signal: new AbortController().signal, isActive: () => true, interact: async () => ({ decision: 'deny' }) }, { state: { key: special }, questions: { ok: { type: 'noul', instructions: 'Okay?' } } }), { status: 400 });
}
finally {
    await f.close();
} });
test('redirects and oversized catalog bodies are rejected without retry', async () => { for (const kind of ['redirect', 'size']) {
    let calls = 0;
    const f = await fixture((async () => { calls++; if (kind === 'size')
        return new Response('x'.repeat(131073)); const response = Response.json(models); Object.defineProperty(response, 'redirected', { value: true }); return response; }) as typeof fetch);
    try {
        const c = f.service.credentialRequest('s', {});
        await assert.rejects(f.service.connectCredential('s', { nonce: c.nonce, apiKey: key }), { status: 502 });
        assert.equal(calls, 1);
        assert.equal(f.v.values.size, 0);
    }
    finally {
        await f.close();
    }
} });
test('disconnect revokes paid dispatch immediately while encrypted credential removal is pending', async () => { let calls = 0; const f = await fixture((async () => { calls++; return Response.json(models); }) as typeof fetch); let release!: () => void; try {
    const c = f.service.credentialRequest('s', {});
    await f.service.connectCredential('s', { nonce: c.nonce, apiKey: key });
    f.v.remove = async () => { await new Promise<void>(resolve => release = resolve); };
    const removing = f.service.disconnect();
    assert.equal(f.service.status().configured, false);
    assert.equal(f.service.status().enabled, false);
    await assert.rejects(f.service.decide({ runId: 'r', agentId: 'a', signal: new AbortController().signal, isActive: () => true, interact: async () => ({ decision: 'deny' }) }, { state: 'Ticket', questions: { ok: { type: 'noul', instructions: 'Okay?' } } }), { status: 409 });
    assert.equal(calls, 1);
    assert.throws(() => f.service.credentialRequest('s', {}), { status: 409 });
    release();
    await removing;
    assert.equal(f.service.status().configured, false);
}
finally {
    release?.();
    await f.close();
} });
test('failed encrypted removal stays disabled in memory and durable configuration', async () => { const f = await fixture((async () => Response.json(models)) as typeof fetch); try {
    const c = f.service.credentialRequest('s', {});
    await f.service.connectCredential('s', { nonce: c.nonce, apiKey: key });
    f.v.remove = async () => { throw Error('disk failure ' + key); };
    await assert.rejects(f.service.disconnect(), error => !String(error).includes(key));
    assert.equal(f.service.status().configured, false);
    assert.equal(f.service.status().enabled, false);
    assert.equal(f.store.get<{
        enabled: boolean;
    }>('integration', 'typesafe')?.enabled, false);
}
finally {
    await f.close();
} });
test('a stalled upstream request times out once without retry or key disclosure', async () => { let calls = 0; const f = await fixture((async (url) => { calls++; return String(url).endsWith('/models') ? Response.json(models) : new Promise<Response>(() => { }); }) as typeof fetch, { timeoutMs: 20 }); try {
    const c = f.service.credentialRequest('s', {});
    await f.service.connectCredential('s', { nonce: c.nonce, apiKey: key });
    await assert.rejects(f.service.decide({ runId: 'r', agentId: 'a', signal: new AbortController().signal, isActive: () => true, interact: async () => ({ decision: 'deny' }) }, { state: 'Ticket', questions: { ok: { type: 'noul', instructions: 'Okay?' } } }), error => !String(error).includes(key) && /timed out/.test(String(error)));
    assert.equal(calls, 2);
}
finally {
    await f.close();
} });
test('decision concurrency is bounded and disabling revokes in-flight TypeSafe calls', async () => { let posts = 0; const f = await fixture((async (url) => { if (String(url).endsWith('/models'))
    return Response.json(models); posts++; return new Promise<Response>(() => { }); }) as typeof fetch); try {
    const c = f.service.credentialRequest('s', {});
    await f.service.connectCredential('s', { nonce: c.nonce, apiKey: key });
    const scope = { runId: 'r', agentId: 'a', signal: new AbortController().signal, isActive: () => true, interact: async () => ({ decision: 'deny' as const }) }, input = { state: 'Ticket', questions: { ok: { type: 'noul', instructions: 'Okay?' } } };
    const one = f.service.decide(scope, input), two = f.service.decide(scope, input);
    void one.catch(() => { });
    void two.catch(() => { });
    await assert.rejects(f.service.decide(scope, input), { status: 429 });
    assert.equal(posts, 2);
    assert.equal((await f.service.updateModel({ enabled: false })).enabled, false);
    await assert.rejects(one);
    await assert.rejects(two);
    assert.equal(posts, 2);
}
finally {
    await f.close();
} });
