import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.js';
import type { Agent, ProviderAdapter, ProviderEvent, ProviderId, ProviderRequest, Run } from '../shared/types.js';

const flush = async () => { for (let n = 0; n < 40; n++) await Promise.resolve(); };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-11-05T12:00:00Z') });
  t.mock.method(performance, 'now', () => Date.now());
  const root = await realpath(await mkdtemp(join(tmpdir(), 'relay-queue-budget-'))), workspace = join(root, 'work'); await mkdir(workspace);
  const started: { request: ProviderRequest; signal: AbortSignal; extraArgs: number }[] = [];
  let respond: ((request:ProviderRequest,signal:AbortSignal,provider:string,emit:(event:ProviderEvent)=>void)=>Promise<{text:string}>)|undefined;
  const adapters = Object.fromEntries(['openai', 'claude', 'cursor'].map(id => [id, {
    id, inspect: async () => ({ id, installed: true, authenticated: true, authMode: 'subscription', accountLabel: 'Fixture', plan: 'Fixture', models: [{ id: 'm', name: 'm', verified: false }] }),
    login: async () => ({ message: '' }), close: async () => {},
    stream: async (...args: [ProviderRequest, (event:ProviderEvent)=>void, AbortSignal, unknown?]) => {
      const [request, emit, signal] = args; started.push({ request, signal, extraArgs: args.length });
      if(respond)return respond(request,signal,id,emit);
      return new Promise<{ text: string }>((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  }])) as unknown as Record<ProviderId, ProviderAdapter>;
  const app = createApp({ dataDir: join(root, 'data'), adapters, port: 0 });
  app.store.saveSettings({ ...app.store.settings(), maxRunSeconds: 1, maxWorkSeconds: 1, maxModelCalls: 2 });
  app.store.saveBilling('openai', { mode: 'included', confirmed: true, automaticRouting: true, allowanceNote: 'Fixture' });
  await app.runs.refresh();
  const bot = app.store.put<Agent>('agent', { ...app.store.list<Agent>('agent')[0], mode: 'agent', workspace, routeMode: 'openai', model: 'm' });
  const conversation = app.store.conversations(bot.id)[0];
  return { app, bot, conversation, workspace, started, setResponder(value:NonNullable<typeof respond>){respond=value;},async close() { await app.close(); t.mock.timers.reset(); await rm(root, { recursive: true, force: true }); } };
}

for (const kind of ['workspace', 'capacity', 'safety-hold'] as const) test(`actual task queue ${kind} does not spend execution budget before admission`, async t => {
  const f = await fixture(t), gate = deferred();
  const blockers: Promise<unknown>[] = [];
  if (kind === 'safety-hold') f.app.scheduler.quarantine('synthetic-hold', f.workspace);
  else if (kind === 'workspace') blockers.push(f.app.scheduler.run(f.workspace, new AbortController().signal, () => gate.promise));
  else for (let n = 0; n < 2; n++) blockers.push(f.app.scheduler.run(undefined, new AbortController().signal, () => gate.promise));
  try {
    const { run } = f.app.runs.start(f.bot, f.conversation.id, 'Perform the fixture task', 'openai', 'm', 'agent');
    const active = f.app.runs.active.get(run.id)!;
    await flush(); assert.equal(f.app.scheduler.queuedCount, 1); assert.equal(f.started.length, 0);
    const task = f.app.tasks.forRun(run.id)!, originalDeadline = Date.parse(task.budget!.deadline);
    t.mock.timers.tick(5000); await flush();
    assert.equal(active.controller.signal.aborted, false, 'waiting must not abort the run');
    assert.equal(f.app.store.get<Run>('run', run.id)!.status, 'running'); assert.equal(f.started.length, 0);
    if (kind === 'safety-hold') f.app.scheduler.releaseQuarantine('synthetic-hold'); else gate.resolve();
    await Promise.all(blockers); await flush();
    assert.equal(f.started.length, 1); assert.ok(f.started[0].request.maxSeconds > 0.99, 'provider gets its unspent execution allowance');
    assert.equal(f.started[0].extraArgs, 4, 'host queue callback must not reach raw provider');
    const budget = f.app.tasks.forRun(run.id)!.budget!;
    assert.equal(Date.parse(budget.deadline), originalDeadline + 5000); assert.equal(budget.calls, 1); assert.equal(budget.maxCalls, 2);
    t.mock.timers.tick(999); await flush(); assert.equal(active.controller.signal.aborted, false);
    t.mock.timers.tick(1); await active.promise;
    assert.match(f.app.store.get<Run>('run', run.id)!.error!, /exceeded its time limit/); assert.equal(f.app.scheduler.activeCount, 0);
  } finally { gate.resolve(); if (kind === 'safety-hold') f.app.scheduler.releaseQuarantine('synthetic-hold'); await Promise.all(blockers); await f.close(); }
});

test('cancelling a long-queued task never dispatches or clears its safety hold', async t => {
  const f = await fixture(t); f.app.scheduler.quarantine('synthetic-hold', f.workspace);
  try {
    const { run } = f.app.runs.start(f.bot, f.conversation.id, 'Cancel this fixture', 'openai', 'm', 'agent'); await flush();
    t.mock.timers.tick(5000); await flush(); await f.app.runs.cancel(run.id);
    assert.equal(f.started.length, 0); assert.equal(f.app.store.get<Run>('run', run.id)!.status, 'cancelled');
    assert.equal(f.app.scheduler.queuedCount, 0); assert.equal(f.app.scheduler.listQuarantines().length, 1);
  } finally { f.app.scheduler.releaseQuarantine('synthetic-hold'); await f.close(); }
});

for(const stage of ['classifier','fallback'] as const)test(`actual tracked Chat excludes both ${stage} queues without renewing spent active time or calls`,async t=>{
  const f=await fixture(t),first=deferred(),second=deferred(),blockers:Promise<unknown>[]=[];
  f.app.store.saveSettings({...f.app.store.settings(),routingClassifier:stage==='classifier'?'openai':'rules'});
  f.app.store.saveBilling('claude',{mode:'included',confirmed:true,automaticRouting:true,allowanceNote:'Fixture'});
  f.app.store.put('agent',{...f.bot,mode:'chat',workspace:'',routeMode:'auto',model:''});
  for(let n=0;n<2;n++)blockers.push(f.app.scheduler.run(undefined,new AbortController().signal,()=>first.promise));
  f.setResponder(async(request,signal,_provider,emit)=>{
    if(f.started.length===1){
      t.mock.timers.tick(200);
      for(let n=0;n<2;n++)blockers.push(f.app.scheduler.run(undefined,new AbortController().signal,()=>second.promise));
      if(stage==='classifier'){emit({type:'status',message:'private-classifier-detail'});return{text:JSON.stringify({provider:'openai',model:'m',reason:'Fixture route'})};}
      throw new Error('Temporary network failure');
    }
    return new Promise((resolve,reject)=>{if(signal.aborted)return reject(signal.reason);signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
  });
  try{
    const task=f.app.tasks.create({agentId:f.bot.id,title:'Tracked fixture',prompt:stage==='classifier'?'Debug this complex fixture':'Hello fixture'});
    await f.app.tasks.tick();await flush();const current=f.app.tasks.get(task.id),runId=current.runId!,active=f.app.runs.active.get(runId)!;
    const deadline=Date.parse(current.budget!.deadline);
    assert.equal(f.app.scheduler.queuedCount,1);
    if(stage==='classifier')assert.ok(active.events.some(event=>event.type==='status'&&event.message==='Waiting for inference capacity…'),'classifier queue must expose trusted scheduler status');
    t.mock.timers.tick(5000);await flush();assert.equal(f.started.length,0);assert.equal(active.controller.signal.aborted,false);
    first.resolve();await flush();assert.equal(f.started.length,1);assert.equal(f.app.scheduler.queuedCount,1);
    t.mock.timers.tick(4000);await flush();assert.equal(active.controller.signal.aborted,false);assert.equal(f.started.length,1);
    second.resolve();await Promise.all(blockers);await flush();
    assert.equal(f.started.length,2);assert.ok(f.started[1].request.maxSeconds>0.799&&f.started[1].request.maxSeconds<=0.8);
    if(stage==='classifier'){assert.ok(active.events.some(event=>event.type==='status'&&event.message==='Working…'));assert.ok(!JSON.stringify(active.events).includes('private-classifier-detail'));}
    const budget=f.app.tasks.forRun(runId)!.budget!;assert.equal(Date.parse(budget.deadline),deadline+9000);assert.equal(budget.calls,2);assert.equal(budget.maxCalls,2);
    assert.throws(()=>f.app.tasks.reserveCall(runId),/budget reached/);
    t.mock.timers.tick(799);await flush();assert.equal(active.controller.signal.aborted,false);
    t.mock.timers.tick(1);await active.promise;assert.match(f.app.store.get<Run>('run',runId)!.error!,/exceeded its time limit/);
  }finally{first.resolve();second.resolve();await Promise.allSettled(blockers);await f.close();}
});

test('task queue settlement cannot renew expired, terminal, recovered or replaced attempts',async t=>{
  const f=await fixture(t),gate=deferred();const blocker=f.app.scheduler.run(f.workspace,new AbortController().signal,()=>gate.promise);
  try{
    const{run}=f.app.runs.start(f.bot,f.conversation.id,'Inspect identity guards','openai','m','agent');await flush();
    const task=f.app.tasks.forRun(run.id)!,original=task.budget!;
    // A second host wait cannot credit time after the task or its budget changed.
    for(const change of ['terminal','recovered','attempt','deadline'] as const){
      const settle=f.app.tasks.beginQueueWait(run.id);
      const changed={...task,...(change==='terminal'?{status:'cancelled' as const}:change==='recovered'?{recoveryRequired:true}:change==='attempt'?{attempt:task.attempt+1}:{budget:{...original,deadline:new Date(Date.parse(original.deadline)+1).toISOString()}})};
      f.app.store.put('task',changed);t.mock.timers.tick(100);assert.throws(()=>settle(true),/identity or budget changed/);
      assert.deepEqual(f.app.tasks.get(task.id).budget,changed.budget);f.app.store.put('task',task);
    }
    f.app.store.put('task',{...task,budget:{...original,deadline:new Date(Date.now()-1).toISOString()}});
    assert.throws(()=>f.app.tasks.beginQueueWait(run.id),/no longer active/);
    await f.app.runs.cancel(run.id);assert.equal(f.started.length,0);
  }finally{gate.resolve();await blocker;await f.close();}
});

test('provider-supplied waiting status cannot pause the active execution timeout',async t=>{
  const f=await fixture(t);
  f.setResponder(async(_request,signal,_provider,emit)=>{
    emit({type:'status',message:'Waiting for another job in this workspace…'});
    return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  });
  try{
    const{run}=f.app.runs.start(f.bot,f.conversation.id,'Test forged waiting label','openai','m','agent'),active=f.app.runs.active.get(run.id)!;await flush();
    assert.equal(f.started.length,1);t.mock.timers.tick(1000);await active.promise;
    assert.match(f.app.store.get<Run>('run',run.id)!.error!,/exceeded its time limit/);
  }finally{await f.close();}
});

test('failed task queue settlement fails closed before provider work and releases its slot',async t=>{
  const f=await fixture(t),gate=deferred(),blocker=f.app.scheduler.run(f.workspace,new AbortController().signal,()=>gate.promise);
  const original=f.app.runs.taskQueueWait!;
  f.app.runs.taskQueueWait=runId=>{const settle=original(runId);return continuing=>{if(continuing)throw new Error('Task queue settlement refused');settle(false);};};
  try{
    const{run}=f.app.runs.start(f.bot,f.conversation.id,'Settlement failure fixture','openai','m','agent'),active=f.app.runs.active.get(run.id)!;await flush();
    t.mock.timers.tick(5000);await flush();gate.resolve();await blocker;await active.promise;
    assert.equal(f.started.length,0);assert.equal(f.app.scheduler.activeCount,0);assert.equal(f.app.scheduler.queuedCount,0);
    assert.match(f.app.store.get<Run>('run',run.id)!.error!,/settlement refused/);
    t.mock.timers.tick(10000);await flush();assert.equal(f.app.runs.active.size,0);
  }finally{gate.resolve();await blocker;await f.close();}
});

test('pre-provider admission failure settles queue time before a bounded fallback',async t=>{
  const f=await fixture(t),gate=deferred(),blockers:Promise<unknown>[]=[];
  f.app.store.saveSettings({...f.app.store.settings(),routingClassifier:'rules'});
  f.app.store.saveBilling('claude',{mode:'included',confirmed:true,automaticRouting:true,allowanceNote:'Fixture'});
  f.app.store.put('agent',{...f.bot,mode:'chat',workspace:'',routeMode:'auto',model:''});
  for(let n=0;n<2;n++)blockers.push(f.app.scheduler.run(undefined,new AbortController().signal,()=>gate.promise));
  const put=f.app.store.put.bind(f.app.store);let fail=true;
  t.mock.method(f.app.store,'put',((kind:string,value:any)=>{if(kind==='inference-provider-lease'&&fail){fail=false;throw new Error('Temporary admission persistence failure');}return put(kind,value);}) as typeof f.app.store.put);
  try{
    const task=f.app.tasks.create({agentId:f.bot.id,title:'Admission fallback fixture',prompt:'Hello fixture'});await f.app.tasks.tick();await flush();
    const runId=f.app.tasks.get(task.id).runId!,active=f.app.runs.active.get(runId)!,deadline=Date.parse(f.app.tasks.get(task.id).budget!.deadline);
    t.mock.timers.tick(5000);await flush();gate.resolve();await Promise.all(blockers);await flush();
    assert.equal(f.started.length,1);assert.equal(f.app.store.get<Run>('run',runId)!.route!.provider,'claude');
    assert.equal(Date.parse(f.app.tasks.get(task.id).budget!.deadline),deadline+5000);assert.equal(f.app.tasks.get(task.id).budget!.calls,2);
    t.mock.timers.tick(999);await flush();assert.equal(active.controller.signal.aborted,false);t.mock.timers.tick(1);await active.promise;
    assert.match(f.app.store.get<Run>('run',runId)!.error!,/exceeded its time limit/);assert.equal(f.app.scheduler.activeCount,0);
  }finally{gate.resolve();await Promise.allSettled(blockers);await f.close();}
});
