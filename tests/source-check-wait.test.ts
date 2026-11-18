import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {mkdtemp,mkdir,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server/index.js';
import type {Agent,ProviderAdapter,ProviderId,ProviderRequest,Run} from '../shared/types.js';
import type {HarnessChange} from '../shared/harness-changes.js';
import {taskEvidence} from '../server/task-evidence.js';
import {CHECK_JOB_MAX_MS} from '../server/harness-check-jobs.js';

const flush=async()=>{for(let n=0;n<100;n++)await Promise.resolve();};
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return{promise,resolve};};
const abortable=(promise:Promise<void>,signal?:AbortSignal)=>Promise.race([promise,new Promise<never>((_resolve,reject)=>{if(signal?.aborted)reject(signal.reason);else signal?.addEventListener('abort',()=>reject(signal.reason),{once:true});})]);

// Real host task, receipt, budget, approval and evidence; fake inference/check commands.
async function fixture(t:TestContext,{holdProvider=false,knownFailure=false,unknownStop=false,backwardBeforeEnd=false}={}){
 let monotonicOffset=0;t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.parse('2026-11-05T12:00:00Z')});t.mock.method(performance,'now',()=>Date.now()+monotonicOffset);
 const root=await realpath(await mkdtemp(join(tmpdir(),'relay-source-check-wait-'))),workspace=join(root,'work');await mkdir(workspace);
 const entered=deferred(),release=deferred(),providerRelease=deferred();let checks=0,providerCalls=0,checkSignal:AbortSignal|undefined,originRequest:ProviderRequest|undefined;const requests:ProviderRequest[]=[];
 let draft:HarnessChange={id:'exact-draft',title:'Synthetic exact revision',agentId:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),status:'draft',revision:'revision-one',checkedRevision:null,checkLog:'',error:null,workspaceDirectory:workspace,previewUrl:null};
 const adapters=Object.fromEntries(['openai','claude','cursor'].map(id=>[id,{
  id,inspect:async()=>({id,installed:true,authenticated:true,authMode:'subscription',accountLabel:'Fixture',plan:'Fixture',models:[{id:'m',name:'m',verified:false}]}),login:async()=>({message:''}),close:async()=>{},
  stream:async(value:ProviderRequest,_emit:unknown,signal:AbortSignal)=>{
   providerCalls++;requests.push(value);
   if(!originRequest){originRequest=value;t.mock.timers.tick(200);const accepted=await value.appTools!.call('approved-check','relay_check_change',{changeId:draft.id})as any;assert.equal(accepted.state,'accepted');assert.equal(accepted.checkedRevision,undefined);assert.equal(accepted.runId,value.runId);if(holdProvider)await abortable(providerRelease.promise,signal);if(backwardBeforeEnd){t.mock.timers.setTime(Date.now()-500);monotonicOffset+=500;}return{text:'Check accepted; waiting for the host result.'};}
   if(!knownFailure)await value.appTools!.call('report-result','relay_report_task_outcome',{state:'complete',summary:'Exact checks passed.',remaining:[],evidence:[{kind:'tool_receipt',id:originRequest.runId+':approved-check'}]});
   return{text:knownFailure?'Known check failure received; repair remains.':'Exact approved check completed.'};
  },
 }]))as unknown as Record<ProviderId,ProviderAdapter>;
 let app=createApp({dataDir:join(root,'data'),adapters,port:0,harnessWorkspacesDirectory:join(root,'drafts')});
 app.store.saveSettings({...app.store.settings(),maxRunSeconds:1,maxWorkSeconds:1,maxModelCalls:2});app.store.saveBilling('openai',{mode:'included',confirmed:true,automaticRouting:true,allowanceNote:'Fixture'});
 t.mock.method(app.changes,'initialize',async()=>{});t.mock.method(app.changes,'get',async()=>structuredClone(draft));
 t.mock.method(app.changes,'check',async(_id:string,options:{signal?:AbortSignal;expectedRevision?:string}={})=>{
  checks++;assert.equal(options.expectedRevision,'revision-one');checkSignal=options.signal;draft={...draft,status:'checking'};entered.resolve();
  try{await abortable(release.promise,options.signal);if(knownFailure){draft={...draft,status:'failed',error:'Synthetic compiler error',checkLog:'Synthetic compiler error'};throw Error('Synthetic compiler error');}draft={...draft,status:'ready',checkedRevision:'revision-one',checkLog:'Synthetic exact checks passed.'};return structuredClone(draft);}
  catch(error){if(options.signal?.aborted){draft={...draft,status:'failed',error:'Checks cancelled'};if(unknownStop)throw Object.assign(Error('Synthetic check termination unknown'),{code:'HARNESS_CHECK_OUTCOME_UNKNOWN'});}throw error;}
 });
 await app.runs.refresh();const bot=app.store.put<Agent>('agent',{...app.store.list<Agent>('agent')[0],mode:'agent',workspace,routeMode:'openai',model:'m'}),conversation=app.store.conversations(bot.id)[0];
 const{run}=app.runs.start(bot,conversation.id,'Check this exact fixture revision','openai','m','agent'),active=app.runs.active.get(run.id)!;await entered.promise;await flush();const taskId=app.tasks.forRun(run.id)!.id;
 return{get app(){return app;},run,active,taskId,release,providerRelease,requests,get checks(){return checks;},get providerCalls(){return providerCalls;},get checkSignal(){return checkSignal!;},get request(){return originRequest!;},get draft(){return draft;},edit(){draft={...draft,revision:'revision-two',checkedRevision:null,status:'draft'};},async restart(){await app.close();app=createApp({dataDir:join(root,'data'),adapters,port:0,harnessWorkspacesDirectory:join(root,'drafts')});},async close(){release.resolve();providerRelease.resolve();await app.close();t.mock.timers.reset();await rm(root,{recursive:true,force:true});}};
}

test('approved check outlasts inference budget; terminal host wait earns one exact bounded continuation',async t=>{
 const f=await fixture(t);try{
  await f.active.promise;const initial=f.app.tasks.get(f.taskId),deadline=Date.parse(initial.budget!.deadline),receiptId=f.run.id+':approved-check';assert.equal(f.app.store.get<Run>('run',f.run.id)!.status,'complete');assert.equal(initial.budget!.calls,1);assert.equal(initial.pendingCheck!.waitLease!.startedAt,f.app.store.get<Run>('run',f.run.id)!.endedAt);
  assert.equal(f.app.store.get<any>('workspace-tool',receiptId).status,'complete');assert.equal((await taskEvidence(f.app.store,initial,[{kind:'tool_receipt',id:receiptId}],async()=>f.draft))[0].assertion,'execution');
  t.mock.timers.tick(1200);await flush();assert.equal(f.checkSignal.aborted,false,'owned check survives the original inference deadline');f.release.resolve();await flush();assert.equal(f.app.store.list<any>('source-check-job')[0].state,'ready');
  t.mock.timers.tick(100);await f.app.tasks.tick();await flush();assert.equal(f.checks,1);assert.equal(f.providerCalls,2);assert.equal(f.app.tasks.get(f.taskId).budget!.calls,2);assert.equal(Date.parse(f.app.tasks.get(f.taskId).budget!.deadline),deadline+1200,'late polling earns no extra credit');assert.ok(f.requests[1].maxSeconds>0.69&&f.requests[1].maxSeconds<=0.7,'inference and post-check delay remain spent');
  assert.equal(f.app.store.list<any>('check-wait-settlement')[0].credit,1200);await f.app.tasks.tick();await flush();assert.equal(f.app.tasks.get(f.taskId).status,'done');assert.equal(f.app.tasks.get(f.taskId).outcome!.verification,'checks_passed');assert.equal(f.app.tasks.get(f.taskId).external,undefined,'a check-only original request does not acquire activation from its host wakeup');assert.equal(f.app.updates.pending(),false);assert.equal(f.app.store.list('activation-request').length,0);await f.app.tasks.tick();assert.equal(f.providerCalls,2);assert.equal(f.checks,1);assert.equal(f.app.store.list<any>('check-wait-settlement').length,1);
 }finally{await f.close();}
});

test('direct Stop after provider completion cancels its owned check without replay',async t=>{
 const f=await fixture(t);try{
  await f.active.promise;assert.equal(f.app.runs.active.has(f.run.id),false);await f.app.runs.cancel(f.run.id);assert.equal(f.checkSignal.aborted,true);assert.equal(f.app.tasks.get(f.taskId).status,'cancelled');assert.equal(f.app.store.list<any>('source-check-job')[0].state,'cancelled');assert.equal(f.app.store.get<any>('workspace-tool',f.run.id+':approved-check').status,'complete');await f.app.tasks.tick();assert.equal(f.checks,1);assert.equal(f.providerCalls,1);await assert.rejects(f.request.appTools!.call('approved-check','relay_check_change',{changeId:'exact-draft'}),/authority expired/);
 }finally{await f.close();}
});

test('unknown native stop remains recovery-required rather than clean cancellation',async t=>{
 const f=await fixture(t,{unknownStop:true});try{await f.active.promise;await assert.rejects(f.app.runs.cancel(f.run.id),/termination could not be confirmed/);assert.equal(f.app.tasks.get(f.taskId).recoveryRequired,true);assert.equal(f.app.store.list<any>('source-check-job')[0].state,'unknown');await f.app.tasks.tick();assert.equal(f.providerCalls,1);}finally{await f.close();}
});

test('active or failed provider inference receives no check waiting credit',async t=>{
 const f=await fixture(t,{holdProvider:true});try{
  const deadline=f.app.tasks.get(f.taskId).budget!.deadline;t.mock.timers.tick(500);await flush();await f.app.tasks.tick();assert.equal(f.app.tasks.get(f.taskId).budget!.deadline,deadline);assert.equal(f.app.tasks.get(f.taskId).pendingCheck!.waitLease,undefined);t.mock.timers.tick(500);await f.active.promise;assert.equal(f.app.store.get<Run>('run',f.run.id)!.status,'failed');assert.equal(f.checkSignal.aborted,false);f.release.resolve();await flush();await f.app.tasks.tick();assert.equal(f.providerCalls,1);assert.equal(f.app.tasks.get(f.taskId).recoveryRequired,true);assert.equal(f.app.tasks.get(f.taskId).budget!.deadline,deadline);
 }finally{await f.close();}
});

for(const finished of[false,true])test('restart never replays or credits '+(finished?'complete unsettled':'running')+' accepted checks',async t=>{
 const f=await fixture(t);try{await f.active.promise;const deadline=f.app.tasks.get(f.taskId).budget!.deadline;if(finished){f.release.resolve();await flush();}await f.restart();await f.app.tasks.tick();assert.equal(f.checks,1);assert.equal(f.providerCalls,1);assert.equal(f.app.tasks.get(f.taskId).status,'needs_input');assert.equal(f.app.tasks.get(f.taskId).recoveryRequired,true);assert.equal(f.app.tasks.get(f.taskId).budget!.deadline,deadline);assert.equal(f.app.store.list<any>('check-wait-settlement').length,0);assert.equal(f.app.store.get<any>('workspace-tool',f.run.id+':approved-check').status,'complete');}finally{await f.close();}
});

test('changed source invalidates terminal evidence and cannot requeue a saved check',async t=>{
 const f=await fixture(t);try{await f.active.promise;f.release.resolve();await flush();f.edit();await f.app.tasks.tick();assert.equal(f.providerCalls,1);assert.equal(f.checks,1);assert.equal(f.app.tasks.get(f.taskId).recoveryRequired,true);assert.equal(f.app.store.list<any>('check-wait-settlement').length,0);assert.notEqual((await taskEvidence(f.app.store,f.app.tasks.get(f.taskId),[{kind:'tool_receipt',id:f.run.id+':approved-check'}],async()=>f.draft))[0].assertion,'checks_passed');}finally{await f.close();}
});

test('known failed exact job can continue repairs under existing call cap without rerunning the check',async t=>{
 const f=await fixture(t,{knownFailure:true});try{await f.active.promise;t.mock.timers.tick(1200);f.release.resolve();await flush();await f.app.tasks.tick();await flush();assert.equal(f.app.store.list<any>('source-check-job')[0].state,'failed');assert.equal(f.providerCalls,2);assert.equal(f.checks,1);assert.equal(f.app.tasks.get(f.taskId).budget!.calls,2);const evidence=await taskEvidence(f.app.store,f.app.tasks.get(f.taskId),[{kind:'tool_receipt',id:f.run.id+':approved-check'}],async()=>f.draft);assert.equal(evidence[0].assertion,'checks_failed');await f.app.tasks.tick();assert.equal(f.app.tasks.get(f.taskId).status,'needs_input');assert.equal(f.providerCalls,2);}finally{await f.close();}
});

test('changed lifetime budget cannot receive a stale check wait credit',async t=>{
 const f=await fixture(t);try{await f.active.promise;const task=f.app.tasks.get(f.taskId);f.app.store.put('task',{...task,budget:{...task.budget!,calls:task.budget!.calls+1}});f.release.resolve();await flush();await f.app.tasks.tick();assert.equal(f.providerCalls,1);assert.equal(f.app.tasks.get(f.taskId).recoveryRequired,true);assert.equal(f.app.store.list<any>('check-wait-settlement').length,0);}finally{await f.close();}
});

test('accepted receipt cannot claim a foreign terminal check job as passed evidence',async t=>{
 const f=await fixture(t);try{await f.active.promise;f.release.resolve();await flush();const job=f.app.store.list<any>('source-check-job')[0];f.app.store.put('source-check-job',{...job,taskId:'foreign-task'});await assert.rejects(taskEvidence(f.app.store,f.app.tasks.get(f.taskId),[{kind:'tool_receipt',id:f.run.id+':approved-check'}],async()=>f.draft),/Owned exact source check evidence not found/);await f.app.tasks.tick();assert.equal(f.providerCalls,1);assert.equal(f.app.tasks.get(f.taskId).recoveryRequired,true);}finally{await f.close();}
});

test('fixed whole-job bound aborts host-owned check without changing provider caps',async t=>{
 const f=await fixture(t);try{await f.active.promise;t.mock.timers.tick(CHECK_JOB_MAX_MS);await flush();assert.equal(f.checkSignal.aborted,true);assert.equal(f.app.store.list<any>('source-check-job')[0].state,'unknown');await f.app.tasks.tick();assert.equal(f.providerCalls,1);assert.equal(f.app.tasks.get(f.taskId).recoveryRequired,true);assert.equal(f.app.tasks.get(f.taskId).budget!.calls,1);}finally{await f.close();}
});

test('task cancellation stops a check whose provider is already complete',async t=>{
 const f=await fixture(t);try{await f.active.promise;await f.app.tasks.cancel(f.taskId);assert.equal(f.checkSignal.aborted,true);assert.equal(f.app.tasks.get(f.taskId).status,'cancelled');assert.equal(f.app.tasks.get(f.taskId).recoveryRequired,false);await f.app.tasks.tick();assert.equal(f.providerCalls,1);assert.equal(f.checks,1);}finally{await f.close();}
});

for(const kind of['workspace-tool','app-action'])test('unrelated unknown '+kind+' receipt blocks check settlement and all automatic inference',async t=>{
 const f=await fixture(t);try{await f.active.promise;const task=f.app.tasks.get(f.taskId),deadline=task.budget!.deadline,accepted=f.app.store.get<any>('workspace-tool',f.run.id+':approved-check');f.app.store.put(kind,{id:'unrelated-unknown',runId:f.run.id,agentId:task.agentId,name:'relay_unknown_effect',status:'pending'});f.release.resolve();await flush();await f.app.tasks.tick();await flush();assert.equal(f.providerCalls,1);assert.equal(f.app.tasks.get(f.taskId).recoveryRequired,true);assert.equal(f.app.tasks.get(f.taskId).budget!.deadline,deadline);assert.equal(f.app.store.list('check-wait-settlement').length,0);assert.deepEqual(f.app.store.get('workspace-tool',accepted.id),accepted);assert.equal(f.app.store.get<any>(kind,'unrelated-unknown').status,'pending');}finally{await f.close();}
});

test('Stop revokes active provider authority synchronously before waiting for check cleanup',async t=>{
 const f=await fixture(t,{holdProvider:true}),drain=deferred(),original=f.app.runs.cancelOwned!;let cancelling:Promise<void>|undefined;
 f.app.runs.cancelOwned=async runId=>{await drain.promise;await original(runId);};
 try{cancelling=f.app.runs.cancel(f.run.id);void cancelling.catch(()=>{});assert.equal(f.active.controller.signal.aborted,true,'cancel() must abort provider authority before its first await');await assert.rejects(f.request.appTools!.call('post-stop','relay_checkpoint',{text:'Must not execute'}),/authority expired/);drain.resolve();await cancelling;assert.equal(f.checkSignal.aborted,true);}finally{drain.resolve();await cancelling?.catch(()=>{});await f.close();}
});
test('Stop preserves both owned cleanup and provider-settlement failures',async t=>{
 const f=await fixture(t,{holdProvider:true}),originalOwned=f.app.runs.cancelOwned!,originalProvider=f.active.promise,ownedFailure=Error('Synthetic owned cleanup failure'),providerFailure=Error('Synthetic provider settlement failure');
 f.app.runs.cancelOwned=async runId=>{await originalOwned(runId);throw ownedFailure;};f.active.promise=Promise.reject(providerFailure);
 try{await assert.rejects(f.app.runs.cancel(f.run.id),error=>{assert.ok(error instanceof AggregateError);assert.deepEqual(error.errors,[ownedFailure,providerFailure]);return true;});assert.equal(f.active.controller.signal.aborted,true);assert.equal(f.checkSignal.aborted,true);}finally{await originalProvider;await f.close();}
});
test('actual Runs settlement passes spent monotonic allowance across a pre-end wall rollback',async t=>{
 const f=await fixture(t,{backwardBeforeEnd:true});try{await f.active.promise;const task=f.app.tasks.get(f.taskId),origin=f.app.store.get<Run>('run',f.run.id)!;assert.equal(Date.parse(task.budget!.deadline)-Date.parse(origin.endedAt!),1300,'wall clock alone overstates the true 800ms remainder');assert.equal(task.pendingCheck!.waitLease!.remainingMilliseconds,800);f.release.resolve();await flush();await f.app.tasks.tick();await flush();assert.equal(f.providerCalls,2);assert.ok(f.requests[1].maxSeconds<=0.8);assert.equal(f.app.tasks.get(f.taskId).budget!.calls,2);}finally{await f.close();}
});
