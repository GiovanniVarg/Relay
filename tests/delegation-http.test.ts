import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.js';
import { PROVIDER_IDS } from '../server/store.js';
import type { Agent, Bootstrap, GroupRoom, GroupRun, ProviderAdapter, ProviderId, ProviderRequest, RunInteraction } from '../shared/types.js';

test('delegated HTTP rooms preserve CSRF, replayable pending interactions, login exclusion, and Herdr status', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-delegation-api-')); let workerIds: string[] = []; let decisions = 0;
  const adapters = Object.fromEntries(PROVIDER_IDS.map(provider => [provider, {
    id: provider, inspect: async () => ({ id: provider, installed: true, authenticated: true, authMode: 'subscription' as const, accountLabel: 'Fixture', plan: 'Fixture', models: [{ id: 'm1', name: 'm1', verified: false }] }),
    login: async () => ({ message: 'fixture' }), close: async () => {},
    stream: async (request: ProviderRequest) => ({ actualModel: request.model, text: request.conversationId.startsWith('delegation-plan-') ? JSON.stringify({ assignments: workerIds.map(workerId => ({ workerId, task: 'Compare perspective', expectedResult: 'A result' })) }) : 'Combined result' }),
  } satisfies ProviderAdapter])) as unknown as Record<ProviderId, ProviderAdapter>;
  const app = createApp({ dataDir: dir, port: 0, adapters, herdr: {
    inspect: async () => ({ available: true, version: 'fixture' }), close: async () => {},
    execute: async (job, _emit, interact, signal) => {
      if (job.agentId === workerIds[0]) { assert.deepEqual(await interact({ kind: 'approval', title: 'Native request', description: 'Scope' }, signal), { decision: 'deny' }); decisions++; }
      return { result: { text: 'Worker result', actualModel: job.request.model }, evidence: [], executionVerified: false };
    },
  } });
  try {
    const port = await app.listen(0); const base = 'http://127.0.0.1:' + port;
    const initial = await fetch(base + '/api/bootstrap'); const cookie = initial.headers.get('set-cookie')!.split(';')[0]; const boot = await initial.json() as Bootstrap;
    const call = (path: string, method = 'GET', body?: unknown, csrf = boot.csrfToken) => fetch(base + path, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const provider of PROVIDER_IDS) { app.store.saveBilling(provider, { mode: 'included', confirmed: true, automaticRouting: true, allowanceNote: '' }); app.store.saveModelPreferences(provider, { defaultModel: 'm1', allowedModels: ['m1'] }); }
    for (const agent of boot.agents.slice(0, 3)) app.store.put<Agent>('agent', { ...agent, routeMode: 'claude', model: 'm1', mode: 'chat', instructions: 'Private ' + agent.name });
    await app.runs.refresh(); workerIds = boot.agents.slice(1, 3).map(agent => agent.id);
    assert.equal((await fetch(base + '/api/herdr')).status, 401);
    assert.deepEqual(await (await call('/api/herdr')).json(), { available: true, version: 'fixture' });
    const roomResponse = await call('/api/groups', 'POST', { title: 'Team', mode: 'delegated', agentIds: boot.agents.slice(0, 3).map(agent => agent.id), moderatorAgentId: boot.agents[0].id });
    assert.equal(roomResponse.status, 201); const room = await roomResponse.json() as GroupRoom;
    const accepted = await call('/api/groups/' + room.id + '/runs', 'POST', { content: 'Task', executionMode: 'bounded' });
    assert.equal(accepted.status, 202); const { run } = await accepted.json() as { run: GroupRun };
    for (let i = 0; i < 100 && !app.delegations.pendingInteractions(run.id).length; i++) await new Promise(resolve => setTimeout(resolve, 5));
    const prompt = app.delegations.pendingInteractions(run.id)[0]; assert.ok(prompt);
    assert.equal((await call('/api/providers/claude/login', 'POST', {})).status, 409);
    const view = await (await call('/api/groups/' + room.id)).json() as { interactions: RunInteraction[] };
    assert.deepEqual(view.interactions, [prompt]);
    assert.deepEqual(await (await call('/api/runs/' + run.id + '/interactions')).json(), { interactions: [prompt] });
    const answerPath = '/api/runs/' + run.id + '/interactions/' + prompt.id;
    assert.equal((await call(answerPath, 'POST', { decision: 'allow' }, '')).status, 403);
    assert.equal((await call(answerPath, 'POST', { decision: 'deny', grant: 'global' })).status, 400);
    assert.equal((await call(answerPath, 'POST', { decision: 'deny' })).status, 200);
    await app.delegations.active.get(run.id)?.promise;
    assert.equal(decisions, 1); assert.equal((await call(answerPath, 'POST', { decision: 'allow' })).status, 409);
    assert.equal(app.store.get<GroupRun>('group-run', run.id)!.status, 'complete');
    assert.deepEqual(await (await call('/api/runs/' + run.id + '/interactions')).json(), { interactions: [] });
    assert.equal((await call('/api/herdr/reconcile', 'POST', { delegationId: 'foreign' }, '')).status, 403);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});
