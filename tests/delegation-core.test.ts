import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Agent, GroupRun, InteractionAnswer, ProviderAdapter, ProviderId, ProviderRequest } from '../shared/types.js';
import type { WorkerJob } from '../server/herdr/host.js';
import { Store, PROVIDER_IDS } from '../server/store.js';
import { Runs } from '../server/runs.js';
import { replyToRun } from '../server/conversation-control.js';
import { InferenceScheduler, scheduleAdapters } from '../server/scheduler.js';
import { Delegations, type DelegationHost } from '../server/delegation/index.js';

const included = { mode: 'included' as const, confirmed: true, automaticRouting: true, allowanceNote: 'Fixture' };
const wait = () => new Promise(resolve => setTimeout(resolve, 5));
async function fixture(workerCount=2) {
  const root = await mkdtemp(join(tmpdir(), 'relay-delegation-')); const workspace = join(root, 'project'); await mkdir(workspace);
  const store = new Store(join(root, 'data')); const scheduler = new InferenceScheduler();
  for (const provider of PROVIDER_IDS) { store.saveBilling(provider, included); store.saveModelPreferences(provider, { defaultModel: 'm1', allowedModels: ['m1'] }); }
  const lead = store.put<Agent>('agent', { ...store.createAgent({ name: 'Lead' }), instructions: 'LEAD PRIVATE', memory: 'LEAD MEMORY', routeMode: 'openai', model: 'm1', mode: 'chat' });
  const workers = ['Builder', 'Reviewer','Researcher','Analyst'].slice(0,workerCount).map((name, i) => store.put<Agent>('agent', { ...store.createAgent({ name }), instructions: name + ' PRIVATE', memory: name + ' MEMORY', role: name + ' PERSPECTIVE', routeMode: i ? 'openai' : 'claude', model: 'm1', mode: 'chat', workspace }));
  const room = store.createRoom([lead.id, ...workers.map(a => a.id)], 'Team', 'delegated', lead.id);
  const requests: ProviderRequest[] = []; const jobs: WorkerJob[] = [];
  let planner: () => string = () => JSON.stringify({ assignments: workers.map((worker, i) => ({ workerId: worker.id, task: 'Task ' + i, expectedResult: 'Result ' + i, dependsOn: i ? [workers[0].id] : [] })) });
  let local = async (request: ProviderRequest) => {
    requests.push(request);
    return { text: request.conversationId.startsWith('delegation-plan-') ? planner() : 'Combined verified fixture result.', actualModel: request.model };
  };
  const adapters = Object.fromEntries(PROVIDER_IDS.map(provider => [provider, {
    id: provider, inspect: async () => ({ id: provider, installed: true, authenticated: true, authMode: 'subscription' as const, accountLabel: 'Fixture', plan: 'Fixture', models: [{ id: 'm1', name: 'Model', verified: false }] }),
    login: async () => ({ message: 'fixture' }), close: async () => {},
    stream: (request: ProviderRequest) => local(request),
  } satisfies ProviderAdapter])) as unknown as Record<ProviderId, ProviderAdapter>;
  const runs = new Runs(store, scheduleAdapters(adapters, scheduler)); await runs.refresh();
  let worker: DelegationHost['execute'] = async job => ({ result: { text: job.agentId === workers[0].id ? 'Built fixture' : 'Reviewed fixture', actualModel: job.request.model }, evidence: ['Synthetic artifact checked'], executionVerified: true });
  let inspect: DelegationHost['inspect'] = async () => ({ available: true, version: 'fixture' });
  const host: DelegationHost = { inspect: () => inspect(), execute: async (...args) => { jobs.push(args[0]); return worker(...args); }, close: async () => {}, reconcile: async () => ({ stopped: true }) };
  const engine = new Delegations(store, runs, host, scheduler);
  return { root, workspace, store, runs, scheduler, engine, workers, lead, room, requests, jobs,
    planner: (fn: typeof planner) => { planner = fn; }, worker: (fn: typeof worker) => { worker = fn; }, inspect: (fn: typeof inspect) => { inspect = fn; },
    local: (fn: typeof local) => { local = fn; },
    async finish(runId: string) { await engine.active.get(runId)?.promise; return store.get<GroupRun>('group-run', runId)!; },
    async close() { await engine.close(); await runs.close(); store.close(); await rm(root, { recursive: true, force: true }); }
  };
}

test('lead dispatches distinct bot assignments through Herdr, joins dependencies and produces one summary', async () => {
  const f = await fixture();
  try {
    const { run } = f.engine.accept(f.room.id, 'Deliver a fixture');
    const final = await f.finish(run.id);
    assert.equal(final.status, 'complete'); assert.equal(f.jobs.length, 2); assert.equal(f.requests.length, 2);
    assert.equal(final.delegations?.length, 2);
    assert.ok(f.jobs[1].request.history.at(-1)!.content.includes('Built fixture'));
    assert.equal(f.jobs[0].provider, 'claude'); assert.equal(f.jobs[1].provider, 'openai');
    assert.ok(f.jobs[0].request.instructions.startsWith('Builder PRIVATE\n\n'));assert.ok(f.jobs[1].request.instructions.startsWith('Reviewer PRIVATE\n\n'));for(const job of f.jobs){assert.match(job.request.instructions,/CURRENT RELAY HOST CAPABILITY ATTESTATION/);assert.match(job.request.instructions,/"surface":"herdr"/);assert.match(job.request.instructions,/"callableTools":\[\]/);}
    assert.match(f.jobs[0].request.history[0].content, /Builder MEMORY/);
    assert.doesNotMatch(JSON.stringify(f.jobs[0]), /LEAD PRIVATE|LEAD MEMORY|Reviewer MEMORY|Reviewer PRIVATE/);
    assert.doesNotMatch(f.requests[0].instructions, /Builder PRIVATE|Reviewer PRIVATE/);
    assert.ok(f.requests.every(request => request.mode === 'chat' && request.workspace === undefined));
    assert.equal(f.store.groupMessages(f.room.id).filter(message => message.role === 'assistant').length, 1);
    assert.equal(f.store.groupMessages(f.room.id).at(-1)!.content, 'Combined verified fixture result.');
    assert.equal(f.scheduler.activeCount, 0);
  } finally { await f.close(); }
});

test('delegation routing classifier dispatches are accounted separately from inference',async()=>{
 const f=await fixture();
 try{
  f.store.put('agent',{...f.lead,routeMode:'auto'});
  const {run}=f.engine.accept(f.room.id,'Research and audit this complex architecture');
  await f.finish(run.id);
  const classifiers=f.requests.filter(request=>request.conversationId.startsWith('delegation-route-'));
  assert.ok(classifiers.length>0);
  assert.ok(classifiers.every(request=>request.usagePurpose==='routing-classifier'));
  const usage=f.store.list<{conversationId:string;purpose:string}>('provider-usage');
  assert.ok(usage.filter(row=>row.conversationId.startsWith('delegation-route-')).every(row=>row.purpose==='routing-classifier'));
  assert.ok(usage.some(row=>row.conversationId.startsWith('delegation-plan-')&&row.purpose==='inference'));
 }finally{await f.close();}
});

test('missing Herdr and invalid plans cannot start worker inference; clarification returns without dispatch', async () => {
  for (const kind of ['missing', 'bad-plan', 'question']) {
    const f = await fixture();
    try {
      if (kind === 'missing') f.inspect(async () => ({ available: false, error: 'Install private Herdr' }));
      if (kind === 'bad-plan') f.planner(() => '{"assignments":[]}');
      if (kind === 'question') f.planner(() => '{"question":"Which project?"}');
      const { run } = f.engine.accept(f.room.id, 'Task'); const final = await f.finish(run.id);
      assert.equal(final.status, kind === 'question' ? 'complete' : 'failed'); assert.equal(f.jobs.length, 0);
      if (kind === 'missing') assert.equal(f.requests.length, 0);
      if (kind === 'question') assert.equal(f.store.groupMessages(f.room.id).at(-1)!.content, 'Which project?');
    } finally { await f.close(); }
  }
});

test('native worker approval is run-bound, replay-safe, and appears in reconnect snapshots', async () => {
  const f = await fixture(); let answer: InteractionAnswer | undefined;
  f.planner(() => JSON.stringify({ assignments: f.workers.map(worker => ({ workerId: worker.id, task: 'Task', expectedResult: 'Result' })) }));
  f.worker(async (job, _emit, interact, signal) => {
    if (job.agentId === f.workers[0].id) answer = await interact({ kind: 'approval', title: 'Write fixture', description: 'Native scoped permission' }, signal);
    return { result: { text: 'Worker done', actualModel: job.request.model }, evidence: [], executionVerified: false };
  });
  try {
    const { run } = f.engine.accept(f.room.id, 'Task');
    for (let i = 0; i < 100 && !f.engine.pendingInteractions(run.id).length; i++) await wait();
    const prompt = f.engine.pendingInteractions(run.id)[0]; assert.ok(prompt); assert.equal(prompt.workerId, f.workers[0].id);
    const events: any[] = []; f.engine.subscribe(run.id, event => events.push(event))();
    assert.deepEqual(events[0].interactions, [prompt]);
    assert.throws(() => f.engine.answerInteraction('foreign', prompt.id, { decision: 'allow' }));
    assert.throws(() => f.engine.answerInteraction(run.id, prompt.id, { decision: 'yes' }));
    f.engine.answerInteraction(run.id, prompt.id, { decision: 'deny' });
    assert.throws(() => f.engine.answerInteraction(run.id, prompt.id, { decision: 'allow' }), { status: 409 });
    assert.equal((await f.finish(run.id)).status, 'complete'); assert.deepEqual(answer, { decision: 'deny' });
  } finally { await f.close(); }
});

test('failed prerequisites leave dependents unrun and synthesis reports a partial outcome', async () => {
  const f = await fixture(); f.worker(async () => { throw new Error('Worker failed before tool success'); });
  try {
    const { run } = f.engine.accept(f.room.id, 'Task'); const final = await f.finish(run.id);
    assert.equal(final.status, 'failed'); assert.equal(f.jobs.length, 1);
    assert.deepEqual(final.delegations!.map(record => record.status), ['failed', 'unrun']); assert.equal(f.requests.length, 2);
  } finally { await f.close(); }
});

test('revoking billing before dispatch fails closed, without worker fallback', async () => {
  const f = await fixture();
  f.planner(() => {
    f.store.saveBilling('claude', { ...included, confirmed: false });
    return JSON.stringify({ assignments: f.workers.map(worker => ({ workerId: worker.id, task: 'Task', expectedResult: 'Result' })) });
  });
  try {
    const { run } = f.engine.accept(f.room.id, 'Task'); const final = await f.finish(run.id);
    assert.equal(final.delegations![0].status, 'failed'); assert.equal(f.jobs.some(job => job.provider === 'claude'), false);
  } finally { await f.close(); }
});

test('ambiguous Stop retains workspace/inference exclusion until explicit host reconciliation', async () => {
  const f = await fixture();
  const first = f.store.put('agent', { ...f.workers[0], mode: 'agent' as const });
  f.workers[0] = first;
  f.worker(async (_job, _emit, _interact, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('Exit not confirmed'), { code: 'HERDR_OUTCOME_UNKNOWN' })), { once: true })));
  try {
    const { run } = f.engine.accept(f.room.id, 'Task');
    for (let i = 0; i < 100 && !f.jobs.length; i++) await wait();
    await f.engine.cancel(run.id);
    const final = f.store.get<GroupRun>('group-run', run.id)!;
    assert.equal(final.status, 'interrupted'); const record = final.delegations![0];
    assert.equal(record.terminationUnconfirmed, true); assert.equal(f.scheduler.activeCount, 1);
    assert.deepEqual(await f.engine.reconcile(record.id), { stopped: true }); assert.equal(f.scheduler.activeCount, 0);
    assert.equal(f.store.get<GroupRun>('group-run', run.id)!.delegations![0].terminationUnconfirmed, false);
    assert.equal(f.jobs.length, 1);
  } finally { await f.close(); }
});

test('Stop expires worker requests immediately but retains execution until provider cleanup completes', async () => {
  const f = await fixture(); let release!: () => void; const cleanup = new Promise<void>(resolve => { release = resolve; }); let stopped = false;
  f.worker(async (job, _emit, interact, signal) => {
    try { await interact({ kind: 'approval', title: 'Native command', description: 'Human decision' }, signal); }
    finally { await cleanup; }
    return { result: { text: 'Late result', actualModel: job.request.model }, evidence: [], executionVerified: false };
  });
  try {
    const { run } = f.engine.accept(f.room.id, 'Task');
    for (let i = 0; i < 100 && !f.engine.pendingInteractions(run.id).length; i++) await wait();
    assert.equal(f.engine.pendingInteractions(run.id).length, 1);
    const stop = f.engine.cancel(run.id).then(() => { stopped = true; });
    await wait(); assert.equal(stopped, false); assert.equal(f.scheduler.activeCount, 1);
    assert.deepEqual(f.engine.pendingInteractions(run.id), []);
    release(); await stop;
    assert.equal(f.store.get<GroupRun>('group-run', run.id)!.status, 'cancelled');
    assert.equal(f.scheduler.activeCount, 0); assert.equal(f.jobs.length, 1);
  } finally { release(); await f.close(); }
});

test('restart recovers ambiguous task identities without launching or replaying work', async () => {
  const f = await fixture();
  try {
    const record = { id: crypto.randomUUID(), parentRunId: crypto.randomUUID(), workerId: f.workers[0].id, workerName: f.workers[0].name, task: 'Old task', expectedResult: 'File', dependsOn: [], status: 'running' as const, mode: 'agent' as const, workspace: f.workspace, route: null, evidence: [], executionVerified: false };
    const old: GroupRun = { id: record.parentRunId, roomId: f.room.id, status: 'interrupted', rounds: 0, completedReplies: 0, totalReplies: 2, modelCalls: 1, maxModelCalls: null, maxSeconds: null, currentAgentId: null, error: null, startedAt: new Date().toISOString(), endedAt: null, mode: 'delegated', delegations: [record] };
    f.store.put('group-run', old);
    const recovered = new Delegations(f.store, f.runs, { inspect: async () => ({ available: false }), execute: async () => { throw new Error('Must not replay'); }, close: async () => {} }, f.scheduler);
    const run = f.store.get<GroupRun>('group-run', old.id)!;
    assert.equal(run.status, 'interrupted'); assert.equal(run.delegations![0].terminationUnconfirmed, true);
    assert.equal(f.scheduler.activeCount, 1); assert.equal(f.jobs.length, 0);
    assert.deepEqual(await recovered.reconcile(record.id), { stopped: false, error: 'The installed Herdr bridge cannot independently confirm this worker stopped.' });
    assert.equal(f.scheduler.activeCount, 1); await recovered.close();
  } finally { await f.close(); }
});


test('Agent workers authorize requested tools while Work workers retain manual approval', async () => {
  for (const mode of ['agent', 'work'] as const) {
    const f = await fixture(); let answer: InteractionAnswer | undefined;
    f.workers[0] = f.store.put('agent', { ...f.workers[0], mode });
    f.worker(async (job, _emit, interact, signal) => {
      if (job.agentId === f.workers[0].id) answer = await interact({ kind: 'approval', title: 'Requested file edit', description: '' }, signal);
      return { result: { text: 'Done', actualModel: job.request.model }, evidence: [], executionVerified: false };
    });
    try {
      const { run } = f.engine.accept(f.room.id, 'Edit the file');
      if (mode === 'work') {
        for (let i = 0; i < 100 && !f.engine.pendingInteractions(run.id).length; i++) await wait();
        assert.equal(answer, undefined);
        await replyToRun({ store: f.store, runs: f.runs, delegations: f.engine }, run.id, 'yes');
      }
      assert.equal((await f.finish(run.id)).status, 'complete');
      assert.deepEqual(answer, { decision: 'allow' });
      assert.equal(f.engine.pendingInteractions(run.id).length, 0);
    } finally { await f.close(); }
  }
});

test('Agent worker questions wait for typed group answers and preserve the human reply', async () => {
  const f = await fixture(); let answer: InteractionAnswer | undefined;
  f.workers[0] = f.store.put('agent', { ...f.workers[0], mode: 'agent' as const });
  f.worker(async (job, _emit, interact, signal) => {
    if (job.agentId === f.workers[0].id) answer = await interact({ kind: 'question', title: 'Which file?', description: '', questions: [{ id: 'file', question: 'File path?' }] }, signal);
    return { result: { text: 'Done', actualModel: job.request.model }, evidence: [], executionVerified: false };
  });
  try {
    const { run } = f.engine.accept(f.room.id, 'Edit the file');
    for (let i = 0; i < 100 && !f.engine.pendingInteractions(run.id).length; i++) await wait();
    assert.equal(answer, undefined);
    const result = await replyToRun({ store: f.store, runs: f.runs, delegations: f.engine }, run.id, 'src/main.ts');
    assert.equal(result.action, 'answered');
    assert.equal((await f.finish(run.id)).status, 'complete');
    assert.deepEqual(answer, { decision: 'allow', answers: { file: ['src/main.ts'] } });
    assert.ok(f.store.groupMessages(f.room.id).some(message => message.role === 'user' && message.authorName === 'You' && message.content === 'src/main.ts'));
    const reopened = new Store(f.store.dataDir);
    try {
      const messages = reopened.groupMessages(f.room.id);
      assert.deepEqual(messages.map(message => message.role), ['user', 'assistant', 'user', 'assistant']);
      assert.equal(messages[1].runId, null); assert.match(messages[1].content, /File path/);
      assert.equal(messages[2].content, 'src/main.ts');
      assert.ok(messages[1].createdAt < messages[2].createdAt && messages[2].createdAt < messages[3].createdAt);
    } finally { reopened.close(); }
  } finally { await f.close(); }
});

test('actual Delegations final parent guard rechecks automatic policy, allowlist and modality after worker boot',async()=>{for(const change of ['unchanged','automatic','allowlist','modality'] as const){const f=await fixture();let entered!:()=>void,release!:()=>void;const booted=new Promise<void>(done=>entered=done),hold=new Promise<void>(done=>release=done);let starts=0,guards=0;f.store.put('agent',{...f.workers[0],routeMode:'auto',model:''});f.planner(()=>JSON.stringify({assignments:f.workers.map((worker,index)=>({workerId:worker.id,task:'Read fixture',expectedResult:'text response',dependsOn:index?[f.workers[0].id]:[],requiredInputModalities:['text']}))}));f.worker(async(job,_emit,_interact,_signal,beforeStart)=>{entered();await hold;assert.equal(typeof beforeStart,'function');guards++;beforeStart!();starts++;return{result:{text:'Fixture complete',actualModel:job.request.model},evidence:[],executionVerified:false};});try{const {run}=f.engine.accept(f.room.id,'Read the worker fixture');await booted;const provider=f.jobs[0].provider;if(change==='automatic')f.store.saveBilling(provider,{...f.store.billing(provider),automaticRouting:false});if(change==='allowlist')f.store.saveModelPreferences(provider,{defaultModel:'m1',allowedModels:[]});if(change==='modality')f.runs.states=f.runs.states.map(state=>state.id===provider?{...state,models:state.models.map(model=>({...model,inputModalities:['image'],inputModalitiesSource:'provider-catalog'}))}:state);release();const result=await f.finish(run.id);if(change==='unchanged'){assert.equal(result.status,'complete');assert.equal(starts,2);assert.equal(guards,2);}else{assert.equal(result.status,'failed');assert.equal(starts,0);assert.equal(guards,1);assert.equal(f.jobs.length,1);}}finally{release();await f.close();}}});

test('team plans a useful subset and leaves unused selected workers genuinely undispatched',async()=>{
 const f=await fixture();try{
  f.planner(()=>JSON.stringify({assignments:[{workerId:f.workers[0].id,task:'Only useful task',expectedResult:'Useful result'}]}));
  const {run}=f.engine.accept(f.room.id,'Do one useful task');const final=await f.finish(run.id);
  assert.equal(final.status,'complete');assert.equal(f.jobs.length,1);assert.equal(final.totalReplies,2);assert.equal(final.completedReplies,2);assert.equal(final.delegations!.length,1);assert.equal(final.modelCalls,3);
 }finally{await f.close();}
});
test('team bounds huge own private references and long worker handoffs without dropping exact human constraints',async()=>{
 const f=await fixture();try{
  f.store.put('agent',{...f.workers[0],memory:'noise '.repeat(40000)+' RARENEEDLE important tail'});
  f.worker(async job=>({result:{text:job.agentId===f.workers[0].id?'Worker finding RARENEEDLE '+ 'x'.repeat(150000):'Review done',actualModel:job.request.model,usageCounters:{outputTokens:17}},evidence:[],executionVerified:false}));
  const goal='Find RARENEEDLE. Never change exact ROOT-CONSTRAINT-123.';const {run}=f.engine.accept(f.room.id,goal);const final=await f.finish(run.id);
  assert.equal(final.status,'failed');assert.equal(f.jobs.length,1);assert.equal(final.delegations![1].status,'unrun');
  for(const job of f.jobs){assert.ok(JSON.stringify(job.request).length<50000);assert.match(job.request.history.at(-1)!.content,/ROOT-CONSTRAINT-123/);}
  assert.match(f.jobs[0].request.history.map(m=>m.content).join(''),/RARENEEDLE important tail/);
  const joined=f.requests.at(-1)!;assert.ok(JSON.stringify(joined).length<50000);assert.match(JSON.stringify(joined),/resultTruncated/);
  const usage=f.store.list<any>('provider-usage').filter(row=>row.conversationId.startsWith('delegation-worker-'));assert.equal(usage.length,1);assert.ok(usage.every(row=>row.usage.accountKey&&row.usage.tokens.inputTokens===null&&row.usage.tokens.outputTokens===17));
  f.engine.subscribe(run.id,()=>{})();assert.equal(f.store.list<any>('provider-usage').filter(row=>row.conversationId.startsWith('delegation-worker-')).length,1);
 }finally{await f.close();}
});
test('every actual worker inference records missing usage once as unknown, with its live account identity',async()=>{
 const f=await fixture();try{
  const {run}=f.engine.accept(f.room.id,'One batch');await f.finish(run.id);
  const rows=f.store.list<any>('provider-usage').filter(row=>row.conversationId.startsWith('delegation-worker-'));assert.equal(rows.length,2);for(const row of rows){assert.ok(row.usage.accountKey);assert.equal(row.usage.availability,'unavailable');assert.equal(row.usage.tokens.inputTokens,null);assert.equal(row.usage.tokens.outputTokens,null);}
  f.engine.subscribe(run.id,()=>{})();assert.equal(f.store.list<any>('provider-usage').filter(row=>row.conversationId.startsWith('delegation-worker-')).length,2);
 }finally{await f.close();}
});
test('known started worker failure records unknown counters once and blocks dependent dispatch',async()=>{
 const f=await fixture();try{
  f.worker(async(_job,_emit,_interact,_signal,_beforeStart,observe)=>{observe?.({phase:'started'});throw Error('Native stream failed');});
  const {run}=f.engine.accept(f.room.id,'Batch');const final=await f.finish(run.id);assert.deepEqual(final.delegations!.map(r=>r.status),['failed','unrun']);assert.equal(f.jobs.length,1);
  const rows=f.store.list<any>('provider-usage').filter(row=>row.conversationId.startsWith('delegation-worker-'));assert.equal(rows.length,1);assert.equal(rows[0].usage.availability,'unavailable');assert.equal(rows[0].usage.tokens.outputTokens,null);assert.equal(final.modelCalls,3);
 }finally{await f.close();}
});
test('unknown worker execution prevents synthesis and descendants without silently losing dispatch usage',async()=>{
 const f=await fixture();try{
  f.worker(async(_job,_emit,_interact,_signal,_beforeStart,observe)=>{observe?.({phase:'started'});throw Object.assign(Error('Unknown outcome'),{code:'HERDR_OUTCOME_UNKNOWN'});});
  const {run}=f.engine.accept(f.room.id,'Batch');const final=await f.finish(run.id);assert.equal(final.status,'interrupted');assert.equal(f.jobs.length,1);assert.equal(f.requests.length,1);assert.equal(final.modelCalls,2);assert.equal(f.store.list<any>('provider-usage').filter(row=>row.conversationId.startsWith('delegation-worker-')).length,1);
 }finally{await f.close();}
});
test('unneeded selected worker with disabled model neither blocks lead nor incurs inference',async()=>{
 const f=await fixture();try{
  f.store.put('agent',{...f.workers[1],model:'disabled-model'});f.planner(()=>JSON.stringify({assignments:[{workerId:f.workers[0].id,task:'Useful task',expectedResult:'Useful result'}]}));
  const {run}=f.engine.accept(f.room.id,'Batch');const final=await f.finish(run.id);assert.equal(final.status,'complete');assert.equal(f.jobs.length,1);assert.equal(final.modelCalls,3);
 }finally{await f.close();}
});

test('team subset benchmark reports measured serialized characters and actual synthetic call counts',async t=>{
 const measures:Record<string,{modelCalls:number;serializedRequestCharacters:number}>={};
 for(const subset of [false,true]){const f=await fixture();try{
  if(subset)f.planner(()=>JSON.stringify({assignments:[{workerId:f.workers[0].id,task:'One useful task',expectedResult:'Result'}]}));
  const {run}=f.engine.accept(f.room.id,'Research the fixture');const final=await f.finish(run.id);
  measures[subset?'minimumSubset':'allWorkers']={modelCalls:final.modelCalls,serializedRequestCharacters:[...f.requests,...f.jobs.map(j=>j.request)].reduce((n,r)=>n+JSON.stringify(r).length,0)};
 }finally{await f.close();}}
 assert.equal(measures.allWorkers.modelCalls,4);assert.equal(measures.minimumSubset.modelCalls,3);assert.ok(measures.minimumSubset.serializedRequestCharacters<measures.allWorkers.serializedRequestCharacters);t.diagnostic(JSON.stringify({syntheticBenchmark:measures,tokenCounts:'not measured'}));
});

test('unused oversized worker instructions do not block useful dispatch',async()=>{
 const f=await fixture();try{
  f.store.put('agent',{...f.workers[1],instructions:'x'.repeat(80001)});f.planner(()=>JSON.stringify({assignments:[{workerId:f.workers[0].id,task:'Only useful task',expectedResult:'Useful result'}]}));
  const {run}=f.engine.accept(f.room.id,'Useful goal');assert.equal((await f.finish(run.id)).status,'complete');assert.equal(f.jobs.length,1);
 }finally{await f.close();}
});
test('long worker capsules preserve terminal conclusions and gate incomplete parent evidence',async()=>{
 const f=await fixture();try{
  f.worker(async job=>({result:{text:job.agentId===f.workers[0].id?'INTRO '+ 'x'.repeat(20000)+' TERMINAL CONCLUSION: blocker remains':'Review excerpt only',actualModel:job.request.model},evidence:[],executionVerified:false}));
  const {run}=f.engine.accept(f.room.id,'Review all evidence');const final=await f.finish(run.id);
  assert.equal(f.jobs.length,1);assert.equal(final.delegations![0].status,'complete');assert.equal(final.delegations![1].status,'unrun');assert.match(final.delegations![1].error!,/bounded handoff/);assert.match(f.requests.at(-1)!.history.at(-1)!.content,/TERMINAL CONCLUSION: blocker remains/);assert.equal(final.status,'failed');assert.match(final.error!,/incomplete|omitted|excerpt/i);
 }finally{await f.close();}
});

test('four escaped worker results fit the real synthesis envelope and yield an honest partial summary',async()=>{
 const f=await fixture(4);try{
  const full=String.fromCharCode(0).repeat(3200);f.planner(()=>JSON.stringify({assignments:f.workers.map(w=>({workerId:w.id,task:'Independent finding',expectedResult:'Finding'}))}));
  f.worker(async job=>({result:{text:full,actualModel:job.request.model},evidence:[],executionVerified:false}));
  const {run}=f.engine.accept(f.room.id,'Preserve exact ROOT-GOAL-123');const final=await f.finish(run.id);
  assert.equal(f.jobs.length,4);assert.equal(f.requests.length,2,'lead must receive bounded evidence and produce a summary');assert.ok(final.delegations!.every(r=>r.status==='complete'&&r.result===full));assert.equal(final.status,'failed');assert.match(final.error!,/incomplete/);assert.match(f.store.groupMessages(f.room.id).at(-1)!.content,/Partial review:/);
  const joined=f.requests.at(-1)!;assert.ok(contextWireCharacters(joined.instructions,joined.history)<=80000);assert.match(joined.history.at(-1)!.content,/ROOT-GOAL-123/);assert.match(joined.history.map(m=>m.content).join(''),/LEAD MEMORY/);assert.match(joined.history.at(-1)!.content,/\"resultTruncated\":true/);assert.equal(final.modelCalls,6);
 }finally{await f.close();}
});
import {contextWireCharacters} from '../server/context-wire.js';

test('encoded prerequisite evidence that needs truncation blocks the dependent before inference',async()=>{
 const f=await fixture(4);try{
  const full=String.fromCharCode(0).repeat(2300);f.planner(()=>JSON.stringify({assignments:f.workers.map((w,i)=>({workerId:w.id,task:'Task '+i,expectedResult:'Finding',dependsOn:i===3?f.workers.slice(0,3).map(w=>w.id):[]}))}));f.worker(async job=>({result:{text:full,actualModel:job.request.model},evidence:[],executionVerified:false}));
  const {run}=f.engine.accept(f.room.id,'Exact prerequisite review');const final=await f.finish(run.id);assert.equal(f.jobs.length,3);assert.equal(final.delegations![3].status,'unrun');assert.match(final.delegations![3].error!,/bounded|encoded|wire|retrieval/i);assert.equal(final.modelCalls,5);
 }finally{await f.close();}
});
