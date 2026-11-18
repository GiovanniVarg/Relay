import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Agent, Bootstrap, ProviderAdapter, ProviderId, ProviderRequest } from '../shared/types.js';
import { createApp } from '../server/index.js';
import { PROVIDER_IDS, Store } from '../server/store.js';
import { validateWorkspace } from '../server/mode.js';
import { InferenceScheduler, scheduleAdapters } from '../server/scheduler.js';
import { OwnedProcess, childEnvironment, launch, providerOutcomeUnknown } from '../server/providers/process.js';
import { Delegations } from '../server/delegation/index.js';
import type { WorkerJob } from '../server/herdr/host.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 5));
const included = { mode: 'included' as const, confirmed: true, automaticRouting: true, allowanceNote: 'Fixture' };
async function until(check: () => boolean) { for (let i = 0; i < 200 && !check(); i++) await tick(); assert.ok(check(), 'Fixture did not reach the expected state'); }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'relay-dispatch-safety-')); const calls: ProviderRequest[] = []; let workerIds: string[] = [];
  const jobs: WorkerJob[] = [];
  let onWorker: (() => void) | undefined;
  let workerTask = 'Fixture task'; let routeFailure: Error | undefined;
  const adapters = Object.fromEntries(PROVIDER_IDS.map(provider => [provider, {
    id: provider, inspect: async () => ({ id: provider, installed: true, authenticated: true, authMode: 'subscription' as const, accountLabel: 'Fixture', plan: 'Fixture', models: [{ id: 'm1', name: 'Fixture', verified: false }] }),
    login: async () => ({ message: 'Fixture' }), close: async () => {},
    stream: async (request: ProviderRequest) => {
      calls.push(request);
      if (routeFailure && request.conversationId.startsWith('delegation-route-')) throw routeFailure;
      return { actualModel: request.model, text: request.conversationId.startsWith('delegation-plan-') ? JSON.stringify({ assignments: workerIds.map(workerId => ({ workerId, task: workerTask, expectedResult: 'Fixture result' })) }) : request.conversationId.includes('route-') ? JSON.stringify({ provider: 'openai', model: 'm1', reason: 'Fixture choice' }) : 'Fixture result' };
    },
  } satisfies ProviderAdapter])) as unknown as Record<ProviderId, ProviderAdapter>;
  const app = createApp({ dataDir: join(root, 'data'), port: 0, adapters, herdr: {
    inspect: async () => ({ available: true, version: 'fixture' }), close: async () => {}, reconcile: async () => ({ stopped: true }),
    execute: async job => { jobs.push(job); onWorker?.(); return { result: { text: 'Worker fixture result', ...(job.provider !== 'cursor' ? { actualModel: job.request.model } : {}) }, evidence: [], executionVerified: false }; },
  } });
  for (const provider of PROVIDER_IDS) { app.store.saveBilling(provider, included); app.store.saveModelPreferences(provider, { defaultModel: 'm1', allowedModels: ['m1'] }); }
  const [lead, worker] = ['Lead', 'Worker'].map(name => app.store.put<Agent>('agent', { ...app.store.createAgent({ name }), routeMode: 'openai', model: 'm1', mode: 'chat' }));
  workerIds = [worker.id]; await app.runs.refresh();
  const room = app.store.createRoom([lead.id, worker.id], 'Fixture team', 'delegated', lead.id);
  return { app, root, lead, worker, room, calls, jobs, workerHook(hook: () => void) { onWorker = hook; }, task(value: string) { workerTask = value; }, failWorkerClassifier() { workerTask = 'Design a fixture'; routeFailure = providerOutcomeUnknown('Fixture classifier cleanup was not proved'); }, async close() { await app.close(); await rm(root, { recursive: true, force: true }); } };
}
function occupy(scheduler: InferenceScheduler) {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const occupied = [scheduler.run(undefined, new AbortController().signal, () => gate), scheduler.run(undefined, new AbortController().signal, () => gate)];
  return { release, done: () => Promise.all(occupied) };
}

for (const kind of ['billing', 'model'] as const) test(`queued lead inference rechecks revoked ${kind} before reaching the adapter`, async () => {
  const f = await fixture(); const gates = occupy(f.app.scheduler);
  try {
    const { run } = f.app.delegations.accept(f.room.id, 'Fixture task');
    await until(() => f.app.scheduler.queuedCount === 1);
    if (kind === 'billing') f.app.store.saveBilling('openai', { ...included, confirmed: false });
    else f.app.store.saveModelPreferences('openai', { defaultModel: '', allowedModels: [] });
    gates.release(); await gates.done(); await f.app.delegations.active.get(run.id)?.promise;
    assert.equal(f.calls.length, 0); assert.equal(f.jobs.length, 0);
  } finally { gates.release(); await f.close(); }
});

test('queued automatic classifier checks routing permission while manual calls remain allowed', async () => {
  for (const automatic of [true, false]) {
    const f = await fixture(); const gates = occupy(f.app.scheduler);
    try {
      f.app.store.put('agent', { ...f.lead, routeMode: automatic ? 'auto' : 'openai', model: automatic ? '' : 'm1' });
      const { run } = f.app.delegations.accept(f.room.id, 'Design a fixture');
      await until(() => f.app.scheduler.queuedCount === 1);
      f.app.store.saveBilling('openai', { ...included, automaticRouting: false });
      gates.release(); await gates.done(); await f.app.delegations.active.get(run.id)?.promise;
      assert.equal(f.calls.length === 0, automatic);
      if (!automatic) assert.equal(f.app.store.get<any>('group-run', run.id).status, 'complete');
    } finally { gates.release(); await f.close(); }
  }
});

test('queued synthesis rechecks policy after workers finish', async () => {
  const f = await fixture(); let gates: ReturnType<typeof occupy> | undefined;
  f.workerHook(() => { gates = occupy(f.app.scheduler); });
  try {
    const { run } = f.app.delegations.accept(f.room.id, 'Fixture');
    await until(() => f.app.store.get<any>('group-run', run.id)?.phase === 'synthesizing' && f.app.scheduler.queuedCount === 1);
    f.app.store.saveBilling('openai', { ...included, confirmed: false });
    gates!.release(); await gates!.done(); await f.app.delegations.active.get(run.id)?.promise;
    assert.equal(f.calls.length, 1); assert.ok(f.calls[0].conversationId.startsWith('delegation-plan-')); assert.equal(f.jobs.length, 1);
  } finally { gates?.release(); await f.close(); }
});

for (const kind of ['direct', 'group'] as const) test(`queued ordinary ${kind} call honors a billing revocation`, async () => {
  const f = await fixture(); const gates = occupy(f.app.scheduler);
  try {
    const accepted = kind === 'direct'
      ? f.app.runs.start(f.lead, f.app.store.conversations(f.lead.id)[0].id, 'Fixture', 'openai', 'm1')
      : f.app.groups.accept(f.app.store.createRoom([f.lead.id, f.worker.id], 'Old group', 'roundtable').id, 'Fixture', 1);
    await until(() => f.app.scheduler.queuedCount === 1);
    f.app.store.saveBilling('openai', { ...included, confirmed: false });
    gates.release(); await gates.done();
    await (kind === 'direct' ? f.app.runs.active.get(accepted.run.id)?.promise : f.app.groups.active.get(accepted.run.id)?.promise);
    assert.equal(f.calls.length, 0);
  } finally { gates.release(); await f.close(); }
});

test('manual Cursor Chat worker dispatches its selected model without inventing model verification; the lead remains text-only', async () => {
  const f = await fixture();
  try {
    f.app.store.put('agent', { ...f.worker, routeMode: 'cursor' });
    f.app.store.put('agent', { ...f.lead, routeMode: 'cursor', mode: 'agent', workspace: f.root });
    const { run } = f.app.delegations.accept(f.room.id, 'Fixture'); await f.app.delegations.active.get(run.id)?.promise;
    const final = f.app.store.get<any>('group-run', run.id);
    assert.equal(final.status, 'complete'); assert.equal(f.jobs.length, 1); assert.equal(f.jobs[0].provider, 'cursor');
    assert.equal(f.jobs[0].request.model, 'm1'); assert.equal(f.jobs[0].request.mode, 'chat'); assert.equal(f.jobs[0].request.workspace, undefined);
    assert.equal(final.delegations[0].executionVerified, false); assert.equal(f.app.store.get('verified', 'cursor:m1'), undefined);
    assert.ok(f.calls.every(request => request.mode === 'chat' && request.workspace === undefined));
  } finally { await f.close(); }
});

test('automatic Chat workers can select Cursor when it is the only eligible subscription', async () => {
  const f = await fixture();
  try {
    f.app.store.put('agent', { ...f.lead, routeMode: 'cursor' });
    f.app.store.put('agent', { ...f.worker, routeMode: 'auto', model: '' });
    for (const provider of PROVIDER_IDS.filter(id => id !== 'cursor')) f.app.store.saveBilling(provider, { ...included, confirmed: false });
    const { run } = f.app.delegations.accept(f.room.id, 'Fixture'); await f.app.delegations.active.get(run.id)?.promise;
    assert.equal(f.app.store.get<any>('group-run', run.id).status, 'complete'); assert.equal(f.jobs[0].provider, 'cursor'); assert.equal(f.jobs[0].request.mode, 'chat');
  } finally { await f.close(); }
});

test('manual Cursor native Herdr modes fail without lead inference or a Chat downgrade', async () => {
  const f = await fixture(); const workspace = join(f.root, 'project'); await mkdir(workspace);
  try {
    for (const mode of ['work', 'agent'] as const) {
      f.app.store.put('agent', { ...f.worker, routeMode: 'cursor', mode, workspace });
      const rejected = f.app.delegations.accept(f.room.id, 'Discuss the options'); await f.app.delegations.active.get(rejected.run.id)?.promise;
      const final = f.app.store.get<any>('group-run', rejected.run.id); assert.equal(f.calls.length, 0); assert.equal(f.jobs.length, 0);
      assert.equal(final.status, 'failed'); assert.match(final.error, /No eligible workers/); assert.equal(final.delegations.length, 0);
    }
    f.app.store.put('agent', { ...f.worker, routeMode: 'cursor', mode: 'auto', workspace: '' });
    f.task('Implement src/fixture.ts');
    const { run } = f.app.delegations.accept(f.room.id, 'Fixture'); await f.app.delegations.active.get(run.id)?.promise;
    assert.equal(f.app.store.get<any>('group-run', run.id).status, 'complete'); assert.equal(f.jobs[0].request.mode, 'chat');
  } finally { await f.close(); }
});

test('Cursor Auto with a workspace rejects a native assignment before worker dispatch and retains Chat assignments', async () => {
  const f = await fixture(); const workspace = join(f.root, 'project'); await mkdir(workspace);
  try {
    // Auto has no native requirement until the lead supplies the actual assignment.
    f.app.store.put('agent', { ...f.worker, routeMode: 'cursor', mode: 'auto', workspace }); f.task('Implement src/fixture.ts');
    const native = f.app.delegations.accept(f.room.id, 'Fixture'); await f.app.delegations.active.get(native.run.id)?.promise;
    const rejected = f.app.store.get<any>('group-run', native.run.id); assert.equal(rejected.status, 'failed'); assert.equal(rejected.delegations.length, 1); assert.equal(rejected.delegations[0].mode, 'work'); assert.equal(rejected.delegations[0].status, 'failed'); assert.equal(rejected.delegations[0].route, null); assert.match(rejected.delegations[0].error, /Cursor native filesystem execution is unavailable/);
    assert.equal(f.jobs.length, 0); assert.equal(f.calls.length, 2); assert.equal(f.calls.filter(request => request.conversationId.startsWith('delegation-plan-')).length, 1); assert.equal(f.calls.filter(request => request.conversationId.startsWith('delegation-synthesis-')).length, 1); assert.equal(f.app.store.groupRuns(f.room.id).length, 1);
    f.task('Discuss the options'); const chat = f.app.delegations.accept(f.room.id, 'Fixture'); await f.app.delegations.active.get(chat.run.id)?.promise;
    const accepted = f.app.store.get<any>('group-run', chat.run.id); assert.equal(accepted.status, 'complete'); assert.equal(accepted.delegations[0].mode, 'chat'); assert.equal(accepted.delegations[0].status, 'complete'); assert.equal(f.app.store.groupRuns(f.room.id).length, 2);
    assert.equal(f.calls.length, 4); assert.equal(f.calls.filter(request => request.conversationId.startsWith('delegation-plan-')).length, 2); assert.equal(f.calls.filter(request => request.conversationId.startsWith('delegation-synthesis-')).length, 2); assert.equal(f.jobs.length, 1); assert.equal(f.jobs[0].provider, 'cursor'); assert.equal(f.jobs[0].request.mode, 'chat'); assert.equal(f.jobs[0].request.workspace, undefined); assert.equal(f.jobs[0].request.appTools, undefined);
  } finally { await f.close(); }
});

test('Auto mode still resolves from the lead assignment and excludes Cursor for tool work without routing private context', async () => {
  const f = await fixture(); const workspace = join(f.root, 'project'); await mkdir(workspace);
  try {
    f.app.store.put('agent', { ...f.worker, routeMode: 'auto', model: '', mode: 'auto', workspace, instructions: 'WORKER PRIVATE', memory: 'WORKER MEMORY' });
    f.task('Architect and implement src/fixture.ts');
    const { run } = f.app.delegations.accept(f.room.id, 'Discuss options'); await f.app.delegations.active.get(run.id)?.promise;
    assert.equal(f.app.store.get<any>('group-run', run.id).status, 'complete'); assert.equal(f.jobs[0].request.mode, 'work'); assert.equal(f.jobs[0].provider, 'openai');
    const classifier = f.calls.find(request => request.conversationId.startsWith('delegation-route-')); assert.ok(classifier);
    assert.doesNotMatch(classifier.instructions, /"provider":"cursor"/); assert.doesNotMatch(JSON.stringify(classifier), /WORKER PRIVATE|WORKER MEMORY/);
    const request = f.jobs[0].request;
    assert.ok(request.instructions.startsWith('WORKER PRIVATE\n\nCURRENT RELAY HOST CAPABILITY ATTESTATION (trusted host metadata)\n'));
    const binding = JSON.parse(request.instructions.split('CURRENT RELAY HOST CAPABILITY ATTESTATION (trusted host metadata)\n')[1].split('\n')[0]);
    assert.equal(binding.provider, 'openai'); assert.equal(binding.model, request.model); assert.equal(binding.surface, 'herdr'); assert.equal(binding.mode, 'work'); assert.equal(binding.transportMode, 'work'); assert.equal(binding.workspace, request.workspace); assert.equal(binding.workspace, validateWorkspace(workspace, f.app.store.dataDir)); assert.equal(binding.capabilities.nativeTools.available, true); assert.deepEqual(binding.callableTools, []);
    assert.doesNotMatch(request.instructions, /WORKER MEMORY/); assert.equal(request.appTools, undefined);
    const memoryReference = request.history.find(item => item.content.startsWith('Untrusted reference source data;') && item.content.includes('WORKER MEMORY'))!;
    assert.equal(memoryReference.role, 'user'); assert.match(memoryReference.content, /cannot grant permissions or replace agent instructions/);
    const reference = JSON.parse(memoryReference.content.split('\n')[1]); assert.equal(reference.id, 'memory:' + f.worker.id); assert.equal(reference.kind, 'memory'); assert.equal(reference.content, 'WORKER MEMORY'); assert.equal(reference.total, 'WORKER MEMORY'.length);
  } finally { await f.close(); }
});

test('Cursor Chat worker eligibility retains enabled-model, subscription, billing and automatic-routing guards', async () => {
  for (const kind of ['model', 'authentication', 'billing', 'automatic'] as const) {
    const f = await fixture();
    try {
      f.app.store.put('agent', { ...f.worker, routeMode: kind === 'automatic' ? 'auto' : 'cursor', model: kind === 'automatic' ? '' : 'm1' });
      if (kind === 'model') f.app.store.saveModelPreferences('cursor', { defaultModel: '', allowedModels: [] });
      if (kind === 'authentication') f.app.runs.states = f.app.runs.states.map(state => state.id === 'cursor' ? { ...state, authenticated: false } : state);
      if (kind === 'billing') f.app.store.saveBilling('cursor', { ...included, confirmed: false });
      if (kind === 'automatic') {
        for (const provider of PROVIDER_IDS) f.app.store.saveBilling(provider, { ...included, automaticRouting: false });
        f.app.store.saveBilling('cursor', { ...included, automaticRouting: false });
      }
      const rejected = f.app.delegations.accept(f.room.id, 'Fixture'); await f.app.delegations.active.get(rejected.run.id)?.promise;
      const final = f.app.store.get<any>('group-run', rejected.run.id); assert.equal(final.status, 'failed'); assert.match(final.error, /No eligible workers/); assert.equal(final.delegations.length, 0);
      assert.equal(f.calls.length, 0); assert.equal(f.jobs.length, 0);
    } finally { await f.close(); }
  }
});

test('unproved ordinary process cleanup retains a stable workspace exclusion across Relay restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-cleanup-safety-')); const workspace = join(root, 'workspace'); await mkdir(workspace);
  const store = new Store(join(root, 'data')); const scheduler = new InferenceScheduler(2, store); const controller = new AbortController();
  const owned = new OwnedProcess({ file: process.execPath, args: [] }, ['-e', 'setInterval(()=>{},1000)'], workspace, childEnvironment(), 60, () => {}, controller.signal, launch,
    async () => { throw new Error('Fixture OS refused termination'); });
  const adapter = { id: 'openai' as const, inspect: async () => { throw new Error('Unused'); }, login: async () => ({ message: 'Unused' }), close: async () => {},
    stream: async () => { try { await owned.finished; throw new Error('Unexpected completion'); } finally { await owned.stop(); } } } satisfies ProviderAdapter;
  const adapters = scheduleAdapters({ openai: adapter, claude: { ...adapter, id: 'claude' }, cursor: { ...adapter, id: 'cursor' }, opencode: { id: 'opencode', inspect: async () => ({ id: 'opencode', installed: false, authenticated: false, authMode: 'unknown', accountLabel: '', plan: '', models: [] }), login: async () => ({ message: 'Disabled synthetic OpenCode fixture' }), close: async () => {}, stream: async () => { throw new Error('Disabled synthetic OpenCode fixture must not dispatch'); } }, gemini: { ...adapter, id: 'gemini' }, grok: { ...adapter, id: 'grok' } }, scheduler);
  const request: ProviderRequest = { runId: 'owned-call', conversationId: 'fixture', model: 'm1', instructions: '', history: [{ role: 'user', content: 'Fixture' }], maxSeconds: 60, mode: 'work', workspace, expectedAccount: { accountLabel: 'Fixture', plan: 'Fixture' } };
  try {
    const task = adapters.openai.stream(request, () => {}, controller.signal);
    await tick(); controller.abort();
    await assert.rejects(task, { code: 'PROVIDER_OUTCOME_UNKNOWN' });
    assert.equal(owned.child.exitCode, null); assert.equal(owned.child.signalCode, null);
    const exclusion = scheduler.listQuarantines()[0]; assert.equal(exclusion.runId, request.runId); assert.equal(exclusion.provider, 'openai');
    const recovered = new InferenceScheduler(2, store); assert.equal(recovered.activeCount, 1); assert.equal(recovered.listQuarantines()[0].id, exclusion.id);
    const queued = new AbortController(); let invoked = false;
    const blocked = recovered.run(workspace, queued.signal, async () => { invoked = true; });
    await tick(); assert.equal(invoked, false); queued.abort(); await assert.rejects(blocked);
  } finally {
    owned.child.kill();
    await new Promise<void>(resolve => owned.child.exitCode !== null || owned.child.signalCode !== null ? resolve() : owned.child.once('close', () => resolve()));
    store.close(); await rm(root, { recursive: true, force: true });
  }
});

test('Advanced quarantine status and reconciliation never clear ordinary calls without durable tree proof', async () => {
  const f = await fixture();
  try {
    f.app.scheduler.quarantine('ordinary-owned-call', undefined, 'provider', { runId: 'owned-call', provider: 'openai' });
    const port = await f.app.listen(0); const base = 'http://127.0.0.1:' + port;
    const response = await fetch(base + '/api/bootstrap'); const cookie = response.headers.get('set-cookie')!.split(';')[0]; const bootstrap = await response.json() as Bootstrap;
    const status = await (await fetch(base + '/api/herdr', { headers: { Cookie: cookie } })).json() as any;
    assert.equal(status.quarantines[0].id, 'ordinary-owned-call'); assert.equal(status.quarantines[0].runId, 'owned-call');
    const result = await (await fetch(base + '/api/herdr/reconcile', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': bootstrap.csrfToken }, body: JSON.stringify({ delegationId: 'ordinary-owned-call' }) })).json() as any;
    assert.equal(result.stopped, false); assert.match(result.error, /durable owned-tree proof/); assert.equal(f.app.scheduler.activeCount, 1);
    assert.equal(f.app.store.list('inference-quarantine').length, 1);
  } finally { await f.close(); }
});

test('an explicitly reconciled Herdr exclusion can recover a crash between record update and lease removal', async () => {
  const f = await fixture();
  f.workerHook(() => { throw Object.assign(new Error('Fixture uncertain termination'), { code: 'HERDR_OUTCOME_UNKNOWN' }); });
  try {
    const { run } = f.app.delegations.accept(f.room.id, 'Fixture'); await f.app.delegations.active.get(run.id)?.promise;
    const record = f.app.store.get<any>('group-run', run.id).delegations[0];
    assert.equal(f.app.scheduler.activeCount, 1);
    f.app.store.put('delegation', { ...record, terminationUnconfirmed: false });
    assert.deepEqual(await f.app.delegations.reconcile(record.id), { stopped: true });
    assert.equal(f.app.scheduler.activeCount, 0); assert.equal(f.app.store.list('inference-quarantine').length, 0);
  } finally { await f.close(); }
});

test('unknown auto-worker classifier cleanup restores only its actual provider exclusion without a phantom worker lease', async () => {
  const f = await fixture();
  f.app.store.put('agent', { ...f.worker, routeMode: 'auto', model: '' }); f.failWorkerClassifier();
  try {
    const { run } = f.app.delegations.accept(f.room.id, 'Fixture'); await f.app.delegations.active.get(run.id)?.promise;
    const final = f.app.store.get<any>('group-run', run.id);
    assert.equal(final.status, 'interrupted'); assert.equal(final.delegations[0].status, 'interrupted');
    assert.equal(final.delegations[0].terminationUnconfirmed, false); assert.equal(f.jobs.length, 0);
    const actual = f.app.scheduler.listQuarantines(); assert.equal(actual.length, 1); assert.equal(actual[0].source, 'provider');
    const recoveredScheduler = new InferenceScheduler(2, f.app.store);
    new Delegations(f.app.store, f.app.runs, f.app.herdr, recoveredScheduler);
    assert.equal(recoveredScheduler.activeCount, 1); assert.equal(recoveredScheduler.listQuarantines()[0].id, actual[0].id);
  } finally { await f.close(); }
});

test('retired provider workers and disabled automatic workers fail without any lead inference', async () => {
 const f=await fixture();
 try {
  for(const provider of ['gemini','grok'] as const){
   f.app.store.put('agent',{...f.worker,routeMode:provider,mode:'chat'});
   const rejected=f.app.delegations.accept(f.room.id,'Fixture');await f.app.delegations.active.get(rejected.run.id)?.promise;
   const final=f.app.store.get<any>('group-run',rejected.run.id);assert.equal(final.status,'failed');assert.match(final.error,/No eligible workers/);assert.equal(final.delegations.length,0);
  }
  f.app.store.put('agent',{...f.worker,routeMode:'auto',model:'',mode:'chat'});
  for(const provider of ['openai','claude','cursor'] as const)f.app.store.saveBilling(provider,{...included,automaticRouting:false});
  const rejected=f.app.delegations.accept(f.room.id,'Fixture');await f.app.delegations.active.get(rejected.run.id)?.promise;
  const final=f.app.store.get<any>('group-run',rejected.run.id);assert.equal(final.status,'failed');assert.match(final.error,/No eligible workers/);
  assert.equal(f.calls.length,0);assert.equal(f.jobs.length,0);
  f.app.store.put('agent',{...f.lead,routeMode:'auto',model:''});assert.throws(()=>f.app.delegations.accept(f.room.id,'Fixture'),/Automatic routing/);assert.equal(f.calls.length,0);
 } finally {await f.close();}
});

test('ineligible candidates are omitted and a forced assignment cannot bypass the eligible roster',async()=>{
 const f=await fixture();try{
  f.app.store.put('agent',{...f.worker,routeMode:'cursor',mode:'work',workspace:''});
  const eligible=f.app.store.put<Agent>('agent',{...f.app.store.createAgent({name:'Eligible'}),routeMode:'openai',model:'m1',mode:'chat'});
  f.app.store.put('group-room',{...f.room,agentIds:[f.lead.id,f.worker.id,eligible.id]});
  const rejected=f.app.delegations.accept(f.room.id,'Fixture');await f.app.delegations.active.get(rejected.run.id)?.promise;
  const final=f.app.store.get<any>('group-run',rejected.run.id);assert.equal(final.status,'failed');assert.match(final.error,/unknown or duplicate worker/);assert.equal(final.delegations.length,0);
  assert.equal(f.calls.length,1);assert.match(f.calls[0].conversationId,/^delegation-plan-/);const roster=JSON.parse(f.calls[0].instructions.split('Selected worker capabilities: ')[1].split('\n')[0]);assert.deepEqual(roster.map((item:{workerId:string})=>item.workerId),[eligible.id]);assert.equal(f.jobs.length,0);
 }finally{await f.close();}
});

test('missing and Relay-data native workspaces make the sole candidate ineligible before lead inference',async()=>{
 for(const mode of ['work','agent'] as const)for(const kind of ['missing','relay-data'] as const){const f=await fixture();try{
  const workspace=kind==='missing'?join(f.root,'does-not-exist'):f.app.store.dataDir;f.app.store.put('agent',{...f.worker,mode,workspace});
  const rejected=f.app.delegations.accept(f.room.id,'Implement src/fixture.ts');await f.app.delegations.active.get(rejected.run.id)?.promise;
  assert.equal(f.calls.length,0);assert.equal(f.jobs.length,0);const final=f.app.store.get<any>('group-run',rejected.run.id);assert.equal(final.status,'failed');assert.match(final.error,/No eligible workers/);assert.equal(final.delegations.length,0);
 }finally{await f.close();}}
});
