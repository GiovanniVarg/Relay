import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import {randomUUID} from 'node:crypto';
import { createApp } from '../server/index.js';
import { PROVIDER_IDS } from '../server/store.js';
import type { Agent, Message, ProviderAdapter, ProviderId, ProviderRequest, ProviderResult } from '../shared/types.js';
import type { DispatcherSubmitResult } from '../shared/dispatcher.js';
import {png} from './fixtures/attachment-inputs.js';
import {requestImages} from '../server/attachment-context.js';

async function fixture(options: { jev?: boolean; images?: boolean; handle?: (request: ProviderRequest, signal: AbortSignal) => Promise<ProviderResult> } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'relay-dispatcher-host-')), workspace = join(root, 'project'); await mkdir(workspace);
  const calls: ProviderRequest[] = [];
  const selectorBodies: Record<string, unknown>[] = [], key = 'synthetic-managed-dispatcher-sentinel';
  let inspectHook = async () => {};
  const adapters = Object.fromEntries(PROVIDER_IDS.map(id => [id, {
    id, inspect: async () => { await inspectHook(); return { id, installed: true, authenticated: true, authMode: 'subscription', accountLabel: 'Fixture', plan: 'Fixture', models: [{ id: 'm', name: 'Fixture model', verified: false, ...(options.images?{inputModalities:['text','image'],inputModalitiesSource:'provider-catalog'}:{}) }] }; },
    login: async () => ({ message: 'fixture' }), close: async () => {},
    stream: async (request: ProviderRequest, _emit: unknown, signal: AbortSignal) => { calls.push(request); if (options.handle) return options.handle(request, signal); await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); }); return { text: '' }; },
  }])) as unknown as Record<ProviderId, ProviderAdapter>;
  const vault = { availability: () => ({ available: true, protection: 'fixture' }), has: async (name: string) => !!options.jev && name === 'typesafe-api-key', get: async (name: string) => options.jev && name === 'typesafe-api-key' ? key : null, set: async () => {}, remove: async () => {}, close: () => {} };
  const fakeDecision = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); selectorBodies.push(body);
    const labels = Object.keys(body.questions.recipient.criteria);
    return Response.json({ model: 'jev-fixture', answers: { fit: { type: 'noul', noul: .9 }, recipient: { type: 'choice', choice: labels[0], confidence: 1, probabilities: Object.fromEntries(labels.map((label, i) => [label, i === 0 ? 1 : 0])) } }, usage: { input_tokens: 10, output_tokens: 2 } });
  }) as typeof fetch;
  const app = createApp({ dataDir: join(root, 'data'), adapters, port: 0, taskPollMs: 60000, secretVault: vault, typesafeOptions: { fetch: fakeDecision } });
  if (options.jev) app.store.put('integration', { id: 'typesafe', enabled: true, model: 'jev-fixture', models: [{ name: 'jev-fixture', description: 'Fixture' }], validatedAt: new Date().toISOString() });
  await app.listen();
  for (const provider of PROVIDER_IDS) { app.store.saveBilling(provider, { mode: 'included', confirmed: true, automaticRouting: true, allowanceNote: '' }); app.store.saveModelPreferences(provider, { defaultModel: 'm', allowedModels: ['m'] }); }
  const first = app.store.list<Agent>('agent')[0], agent = app.store.put<Agent>('agent', { ...first, mode: 'chat', workspace, routeMode: 'claude', model: 'm' }); await app.runs.refresh();
  const base = 'http://127.0.0.1:' + app.security.port, bootstrap = await fetch(base + '/api/bootstrap'), cookie = bootstrap.headers.get('set-cookie')!.split(';')[0], csrf = (await bootstrap.json()).csrfToken;
  const api = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => fetch(base + '/api' + path, { method, headers: { Cookie: cookie, 'X-CSRF-Token': csrf, Origin: base, 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { app, agent, root, workspace, calls, api, base, cookie, key, selectorBodies, onInspect(fn: () => Promise<void>) { inspectHook = fn; }, async close() { await app.close(); await rm(root, { recursive: true, force: true }); } };
}

test('Boss HTTP attachment-only documents transfer into one human anchor and reach the assigned worker context',async()=>{
 const f=await fixture();try{
  const draftId=randomUUID(),path='/dispatcher/drafts/'+draftId+'/attachments',source='BOSS_SOURCE_DOCUMENT_746235';
  const uploaded=await f.api(path,'POST',{name:'review.txt',mimeType:'text/plain',base64:Buffer.from(source).toString('base64')});assert.equal(uploaded.status,201,await uploaded.clone().text());const file=await uploaded.json();
  assert.equal((await f.api(path,'POST',{name:'denied.txt',mimeType:'text/plain',base64:Buffer.from('denied').toString('base64')},{'X-CSRF-Token':''})).status,403);
  const input={submissionId:'document-only-http',prompt:'',agentId:f.agent.id,draftId,attachmentIds:[file.id]},response=await f.api('/dispatcher/submissions','POST',input);assert.equal(response.status,200,await response.clone().text());const accepted=await response.json();assert.equal(accepted.state,'accepted');
  const task=f.app.tasks.get(accepted.receipt.taskId),original=f.app.store.messages(task.conversationId!).find(message=>message.origin==='human')!;assert.equal(original.content,'');assert.equal(original.attachments![0].id,file.id);assert.deepEqual(task.inputMessageIds,[original.id]);
  assert.equal((await f.api(path+'/'+file.id)).status,404);assert.equal((await f.api('/conversations/'+task.conversationId+'/attachments/'+file.id)).status,200);
  assert.equal((await f.api('/dispatcher/submissions','POST',input)).status,200);assert.equal(f.app.tasks.list().length,1);
  await f.app.tasks.tick();for(let i=0;i<200&&!f.calls.length;i++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(f.calls.length,1);assert.match(JSON.stringify(f.calls[0]),new RegExp(source));assert.deepEqual(f.calls[0].inputMessageIds,[original.id]);assert.equal(f.app.store.messages(task.conversationId!).filter(message=>message.origin==='human').length,1);
  assert.doesNotMatch(JSON.stringify(f.app.dispatcher.status([task.id])),/BOSS_SOURCE|review.txt|extraction|attachmentIds|draftId/);await f.app.dispatcher.cancel(task.id);
 }finally{await f.close();}
});

test('Boss HTTP images require exact model evidence before claim and retain actual bytes through task dispatch',async()=>{
 for(const images of [false,true]){const f=await fixture({images});try{
  const draftId=randomUUID(),scope={surface:'dispatcher' as const,draftId},file=await f.app.runs.attachments.createDraft({...scope,name:'source.png',mimeType:'image/png',base64:png().toString('base64')});
  const response=await f.api('/dispatcher/submissions','POST',{submissionId:'image-evidence-'+images,prompt:'Inspect source',agentId:f.agent.id,draftId,attachmentIds:[file.id]});assert.equal(response.status,200,await response.clone().text());const result=await response.json();
  if(!images){assert.equal(result.state,'needs-recipient');assert.equal(f.app.tasks.list().length,0);assert.equal(f.app.runs.attachments.validateDrafts(scope,[file.id]).length,1);assert.equal(f.calls.length,0);continue;}
  assert.equal(result.state,'accepted');const task=f.app.tasks.get(result.receipt.taskId);assert.deepEqual(task.requiredInputModalities,['image']);await f.app.tasks.tick();for(let i=0;i<200&&!f.calls.length;i++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(f.calls.length,1);assert.deepEqual(Buffer.from(requestImages(f.calls[0])[0].data,'base64'),png());assert.deepEqual(f.calls[0].inputMessageIds,task.inputMessageIds);await f.app.dispatcher.cancel(task.id);
 }finally{await f.close();}}
});
test('dispatcher HTTP enforces host security, rejects secret/attachment fields and only addresses its own jobs', async () => {
  const f = await fixture();
  try {
    const input = { submissionId: 'security', prompt: 'Canonical private fixture', agentId: f.agent.id };
    assert.equal((await f.api('/dispatcher/submissions', 'POST', input, { Origin: 'https://evil.invalid' })).status, 403);
    const wrongHost = await new Promise<number>(resolve => { const req = request(f.base + '/api/dispatcher/submissions', { method: 'POST', headers: { Host: 'evil.invalid', 'Content-Type': 'application/json' } }, res => { res.resume(); resolve(res.statusCode!); }); req.end(JSON.stringify(input)); });
    assert.equal(wrongHost, 403);
    assert.equal((await f.api('/dispatcher/submissions', 'POST', input, { 'X-CSRF-Token': '' })).status, 403);
    for (const extra of [{ attachments: [] }, { apiKey: 'fixture-secret' }, { answers: {} }, { runId: 'foreign' }]) assert.equal((await f.api('/dispatcher/submissions', 'POST', { ...input, ...extra })).status, 400);
    assert.equal(f.app.tasks.list().length, 0);
    const ordinary = f.app.tasks.create({ agentId: f.agent.id, title: 'Ordinary', prompt: 'Ordinary private request' });
    assert.equal((await f.api('/dispatcher/jobs/' + ordinary.id + '/cancel', 'POST', {})).status, 404);
    assert.deepEqual(await (await f.api('/dispatcher/jobs?ids=' + ordinary.id)).json(), { receipts: [] });
    assert.equal((await f.api('/dispatcher/jobs?ids=' + Array.from({ length: 101 }, (_, i) => String(i)).join(','))).status, 400);
    assert.equal((await f.api('/dispatcher/submissions/missing')).status, 200);
    assert.deepEqual(await (await f.api('/dispatcher/submissions/missing')).json(), { state: 'not-found' });
    assert.equal((await f.api('/dispatcher/submissions', 'POST', input, { Cookie: '' })).status, 401);
  } finally { await f.close(); }
});
test('accepted HTTP retries own one real task and visible human request; cancellation follows task tree', async () => {
  const f = await fixture();
  try {
    const prompt = 'Exact human request for the owning bot', input = { submissionId: 'canonical', prompt, agentId: f.agent.id };
    const responses = await Promise.all([f.api('/dispatcher/submissions', 'POST', input), f.api('/dispatcher/submissions', 'POST', input)]);
    assert.deepEqual(responses.map(response => response.status), [200, 200]);
    const first = await responses[0].json() as DispatcherSubmitResult, second = await responses[1].json(); assert.deepEqual(first, second); assert.equal(first.state, 'accepted'); if (first.state !== 'accepted') return;
    assert.equal(f.app.tasks.list().length, 1); const taskId = first.receipt.taskId; assert.equal(f.app.tasks.get(taskId).prompt, prompt);
    assert.doesNotMatch(JSON.stringify(await (await f.api('/dispatcher/submissions/canonical')).json()), /Exact human|prompt|title|result|error/);
    await f.app.tasks.tick(); const task = f.app.tasks.get(taskId); assert.ok(task.runId); assert.ok(task.conversationId);
    const messages = f.app.store.messages(task.conversationId!); const human = messages.filter(message => message.role === 'user' && message.origin === 'human');
    assert.equal(human.length, 1); assert.equal(human[0].content, prompt); assert.equal(human[0].runId, null); assert.deepEqual(task.inputMessageIds, [human[0].id]);
    assert.ok(messages.some(message => message.origin === 'task-continuation'));
    assert.equal(f.app.store.list<Message>('message').filter(message => message.content === prompt && message.origin === 'human').length, 1);
    assert.doesNotMatch(JSON.stringify(f.app.store.list('dispatcher-submission')), /Exact human|instructions|summary|result/);
    const other = f.app.store.list<Agent>('agent').find(agent => agent.id !== f.agent.id)!;
    const child = f.app.tasks.delegate(taskId, other.id, 'Child fixture');
    const cancel = await f.api('/dispatcher/jobs/' + taskId + '/cancel', 'POST', {}); assert.equal(cancel.status, 200); assert.equal((await cancel.json()).status, 'cancelled');
    assert.equal(f.app.tasks.get(child.id).status, 'cancelled');
    assert.equal((await f.api('/dispatcher/jobs/' + taskId + '/cancel', 'POST', {})).status, 200);
    assert.equal((await f.api('/dispatcher/submissions', 'POST', { ...input, prompt: 'Conflicting' })).status, 409);
    assert.equal((await f.api('/dispatcher/submissions', 'POST', input)).status, 200); assert.equal(f.app.tasks.list().length, 2);
    assert.equal((await f.api('/dispatcher/jobs/' + taskId + '/cancel', 'POST', { answers: { key: 'fixture' } })).status, 400);
  } finally { await f.close(); }
});
test('excluded workspace is not offered and changed worker policy is rechecked before execution', async () => {
  const f = await fixture();
  try {
    const agent = f.app.store.put<Agent>('agent', { ...f.agent, mode: 'agent' });
    f.app.scheduler.quarantine('fixture-exclusion', f.app.scheduler.canonical(f.workspace));
    const excluded = await (await f.api('/dispatcher/submissions', 'POST', { submissionId: 'excluded', prompt: 'Inspect project', agentId: agent.id })).json(); assert.equal(excluded.state, 'needs-recipient'); assert.equal(f.app.tasks.list().length, 0);
    // This fixture release is a proven fake hold; no live exclusions are accessed.
    f.app.scheduler.releaseQuarantine('fixture-exclusion');
    const accepted = await (await f.api('/dispatcher/submissions', 'POST', { submissionId: 'recheck', prompt: 'Inspect project', agentId: agent.id })).json(); assert.equal(accepted.state, 'accepted');
    f.app.scheduler.quarantine('fixture-exclusion-2', f.app.scheduler.canonical(f.workspace));
    await f.app.tasks.tick(); const task = f.app.tasks.get(accepted.receipt.taskId); assert.equal(task.status, 'needs_input'); assert.equal(task.recoveryRequired, true); assert.equal(f.calls.length, 0);
    assert.equal(task.conversationId, accepted.receipt.conversationId);assert.ok(task.conversationId);assert.equal(f.app.store.messages(task.conversationId!).filter(message=>message.origin==='human').length,1);assert.equal(f.app.store.list('run').length,0);
  } finally { await f.close(); }
});
test('real TypeSafe host scope uses redacted bounded state and the owning task/human anchor share that canonical request', async () => {
  const f = await fixture({ jev: true });
  try {
    f.app.store.put('agent', { ...f.agent, instructions: 'PRIVATE_BOT_INSTRUCTIONS', memory: 'PRIVATE_BOT_MEMORY' });
    const response = await f.api('/dispatcher/submissions', 'POST', { submissionId: 'redacted-host', prompt: 'Inspect ' + f.key }); assert.equal(response.status, 200);
    const accepted = await response.json(); assert.equal(accepted.state, 'accepted'); assert.equal(accepted.receipt.selectionSource, 'jev'); assert.equal(f.selectorBodies.length, 1);
    assert.equal(f.app.store.list('run').length, 0); // Selection has no fake Run or fake agent.
    const canonical = f.app.runs.redactText('Inspect ' + f.key), task = f.app.tasks.get(accepted.receipt.taskId); assert.equal(canonical, 'Inspect [redacted]'); assert.equal(task.prompt, canonical);
    const payload = JSON.stringify(f.selectorBodies); assert.ok(!payload.includes(f.key)); assert.doesNotMatch(payload, /PRIVATE_BOT_|instructions.*PRIVATE|workspace|revision|inputMessageIds/);
    await f.app.tasks.tick(); const working = f.app.tasks.get(task.id), messages = f.app.store.messages(working.conversationId!);
    assert.equal(messages.find(message => message.origin === 'human')?.content, canonical);
    for (const kind of ['task', 'message', 'dispatcher-submission', 'dispatcher-selection', 'task-receipt']) assert.ok(!JSON.stringify(f.app.store.list(kind)).includes(f.key), kind);
    const { model: _model, ...decisionInput } = f.selectorBodies[0];
    assert.deepEqual(f.app.store.get('dispatcher-selection', 'redacted-host'), { id: 'redacted-host', submissionId: 'redacted-host', source: 'jev', configuredModel: 'jev-fixture', inputCharacters: JSON.stringify(decisionInput).length, inputBytes: Buffer.byteLength(JSON.stringify(decisionInput)), state: 'returned', reportedUsage: { inputTokens: 10, outputTokens: 2 } });
    await f.app.dispatcher.cancel(task.id);
  } finally { await f.close(); }
});
test('disconnect during host selection cannot accept work and read-only lookup never replays it', async () => {
  const f = await fixture(); let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), inspected = new Promise<void>(resolve => { started = resolve; });
  f.onInspect(async () => { started(); await gate; });
  try {
    const controller = new AbortController();
    const disconnected = new Promise<void>(resolve => { f.app.server.once('request', (_req, res) => { res.once('close', () => resolve()); }); });
    const pending = fetch(f.base + '/api/dispatcher/submissions', { method: 'POST', headers: { Cookie: f.cookie, Origin: f.base, 'Content-Type': 'application/json', 'X-CSRF-Token': f.app.security.sessions.values().next().value!.csrf }, body: JSON.stringify({ submissionId: 'disconnect', prompt: 'Do work', agentId: f.agent.id }), signal: controller.signal });
    await inspected; controller.abort(); await assert.rejects(pending); await disconnected; release();
    let state = 'pending';
    for (let i = 0; i < 100 && state === 'pending'; i++) { state = (await (await f.api('/dispatcher/submissions/disconnect')).json()).state; if (state === 'pending') await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.equal(state, 'unconfirmed'); assert.equal(f.app.tasks.list().length, 0);
    assert.equal((await f.api('/dispatcher/submissions', 'POST', { submissionId: 'disconnect', prompt: 'Do work', agentId: f.agent.id })).status, 409);
  } finally { release(); await f.close(); }
});
for (const failLead of [false, true]) test('HTTP receipt exposes a delegated worker question after the lead ' + (failLead ? 'fails' : 'ends') + ' and cancellation expires its original endpoint', async () => {
  let f!: Awaited<ReturnType<typeof fixture>>, workerId = '';
  f = await fixture({ handle: async request => {
    const task = f.app.tasks.forRun(request.runId)!;
    if (!task.parentTaskId) {
      await request.appTools!.call('delegate', 'relay_delegate_task', { agentId: workerId, title: 'Private worker title', prompt: 'Private worker request' });
      if (failLead) throw Error('Synthetic lead failure after delegation');
      return { text: 'Private lead response' };
    }
    await request.appTools!.call('ask', 'relay_ask_user', { question: 'Private worker question' });
    return { text: 'Private worker response' };
  } });
  try {
    f.app.store.put('agent', { ...f.agent, mode: 'agent' });
    const worker = f.app.store.list<Agent>('agent').find(agent => agent.id !== f.agent.id)!; workerId = worker.id;
    f.app.store.put('agent', { ...worker, mode: 'agent', routeMode: 'claude', model: 'm', workspace: f.workspace });
    const accepted = await (await f.api('/dispatcher/submissions', 'POST', { submissionId: 'worker-question', prompt: 'Private lead request', agentId: f.agent.id })).json(); assert.equal(accepted.state, 'accepted');
    const taskId = accepted.receipt.taskId; await f.app.tasks.tick(); const leadRun = f.app.tasks.get(taskId).runId!;
    await f.app.runs.active.get(leadRun)!.promise; await f.app.tasks.tick();
    const parent = f.app.tasks.get(taskId), child = f.app.tasks.get(parent.childTaskIds[0]); assert.equal(parent.status, failLead ? 'failed' : 'working'); assert.equal(parent.waitingForChildren, !failLead); assert.ok(child.runId);
    let question = f.app.runs.pendingInteractions(child.runId!)[0];
    for (let i = 0; i < 100 && !question; i++) { await new Promise(resolve => setTimeout(resolve, 5)); question = f.app.runs.pendingInteractions(child.runId!)[0]; }
    assert.ok(question); assert.equal(question.description, 'Private worker question');
    const body = await (await f.api('/dispatcher/jobs?ids=' + taskId)).json(), receipt = body.receipts[0];
    assert.equal(receipt.runId, leadRun); assert.equal(receipt.activeWork, true); assert.deepEqual(receipt.interactionTargets, [{ taskId: child.id, agentId: worker.id, runId: child.runId }]);
    assert.doesNotMatch(JSON.stringify(body), /Private|"(?:prompt|title|question|response|result)":/);
    const pending = await (await f.api('/runs/' + receipt.interactionTargets[0].runId + '/interactions')).json(); assert.equal(pending.interactions[0].id, question.id);
    const stopResponse = await f.api('/dispatcher/jobs/' + taskId + '/cancel', 'POST', {}); assert.equal(stopResponse.status, 200); const stopped = await stopResponse.json(); assert.equal(stopped.status, failLead ? 'failed' : 'cancelled'); assert.equal(stopped.activeWork, false); assert.equal(stopped.recoveryRequired, false); assert.deepEqual(stopped.interactionTargets, []);
    assert.deepEqual((await (await f.api('/dispatcher/jobs?ids=' + taskId)).json()).receipts[0].interactionTargets, []);
    assert.equal((await f.api('/runs/' + child.runId + '/interactions/' + question.id, 'POST', { decision: 'allow', answers: { answer: ['Late answer'] } })).status, 409);
  } finally { await f.close(); }
});
