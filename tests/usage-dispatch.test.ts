import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../server/store.js';
import {Runs} from '../server/runs.js';
import {RoutingInsights} from '../server/routing-insights.js';
import {accountUsageKey} from '../server/provider-usage.js';
import {normalizeUsage,type UsageDispatch} from '../shared/provider-usage.js';
import type {ProviderAdapter,ProviderId,ProviderRequest,ProviderResult,ProviderConnection,Run} from '../shared/types.js';
async function fixture(fn:(value:{store:Store;runs:Runs;insights:RoutingInsights;request:ProviderRequest;state:ProviderConnection;setResponse:(value:ProviderResult)=>void;calls:()=>number})=>Promise<void>){
 const dir=await mkdtemp(join(tmpdir(),'relay-usage-dispatch-')),store=new Store(dir);let called=0,result:ProviderResult={text:'Done',usage:{inputTokens:0,outputTokens:2}};
 const state:ProviderConnection={id:'openai',installed:true,authenticated:true,authMode:'subscription',accountLabel:'fixture-account',plan:'fixture',models:[{id:'m',name:'m',verified:false}]};
 const adapters=Object.fromEntries(['openai','claude','cursor','gemini','grok'].map(provider=>[provider,{id:provider,inspect:async()=>({...state,id:provider}),login:async()=>({message:''}),close:async()=>{},stream:async()=>{called++;return result;}}])) as unknown as Record<ProviderId,ProviderAdapter>;
 const runs=new Runs(store,adapters),insights=new RoutingInsights(store);runs.states=[state];runs.insights=insights;
 store.saveBilling('openai',{mode:'included',confirmed:true,automaticRouting:true,allowanceNote:''});store.saveModelPreferences('openai',{defaultModel:'m',allowedModels:['m']});
 const request:ProviderRequest={runId:'group-or-worker-step',conversationId:'discussion',model:'m',instructions:'',history:[{role:'user',content:'test'}],maxSeconds:5,expectedAccount:{accountLabel:state.accountLabel,plan:state.plan}};
 try{await fn({store,runs,insights,request,state,setResponse:value=>{result=value;},calls:()=>called});}finally{await runs.close();store.close();await rm(dir,{recursive:true,force:true});}
}
test('shared provider calls persist measured group/worker usage without creating normal runs; classifier provenance is separate',async()=>fixture(async({store,runs,insights,request})=>{
 await runs.call('openai',request,()=>{},new AbortController().signal,false);
 await runs.call('openai',{...request,usagePurpose:'routing-classifier'},()=>{},new AbortController().signal,false);
 assert.equal(store.list<Run>('run').length,0);assert.equal(store.list<UsageDispatch>('provider-usage').length,2);
 const snapshot=insights.snapshot();assert.equal(snapshot.usage.runs.length,1);assert.equal(snapshot.usage.runs[0].tokens.inputTokens,0);assert.equal(snapshot.usage.dispatches.length,2);assert.deepEqual(snapshot.usage.dispatches.map(row=>row.purpose).sort(),['inference','routing-classifier']);
 assert.ok(!JSON.stringify(snapshot).includes('fixture-account'));assert.equal(snapshot.usage.remainingAllowance,null);
}));
test('partial and cache-only counters survive the shared call while legacy whole-turn usage remains absent',async()=>fixture(async({runs,insights,request,setResponse})=>{
 for(const usageCounters of [{inputTokens:7},{cachedInputTokens:3},{inputTokens:0,outputTokens:0}]){
  setResponse({text:'Done',usageCounters});const result=await runs.call('openai',request,()=>{},new AbortController().signal,false);
  assert.equal(result.usageObservation!.availability,'reported');assert.deepEqual(Object.fromEntries(Object.entries(result.usageObservation!.tokens).filter(([,value])=>value!==null)),usageCounters);
 }
 assert.equal(insights.snapshot().usage.runs.length,3);
}));
test('admission failure cannot write usage; replacement accounts/logout exclude old dispatches and declarations',async()=>fixture(async({store,runs,insights,request,state,calls})=>{
 runs.admissionGuard=()=>{throw Error('Update hold');};await assert.rejects(runs.call('openai',request,()=>{},new AbortController().signal,false),/Update hold/);assert.equal(calls(),0);assert.equal(store.list('provider-usage').length,0);
 runs.admissionGuard=()=>{};await runs.call('openai',request,()=>{},new AbortController().signal,false);insights.setAvailability('openai',{state:'exhausted'});
 runs.states=[{...state,accountLabel:'replacement'}];assert.equal(insights.snapshot().usage.runs.length,0);assert.equal(insights.snapshot().availability[0].state,'unknown');
 runs.states=[{...state,authenticated:false}];assert.equal(insights.snapshot().usage.dispatches.length,0);
 const replacement=new RoutingInsights(store);runs.states=[state];runs.insights=replacement;assert.equal(replacement.snapshot().usage.runs.length,1);runs.insights=undefined;assert.equal(new RoutingInsights(store).snapshot().usage.runs.length,0);
}));
test('classifier usage never binds the normal run when same/different final provider fails admission',async()=>fixture(async({store,runs,insights,request})=>{
 for(const finalProvider of ['openai','claude'] as const){
  const owner:Run={id:'owner-'+finalProvider,agentId:'bot',conversationId:'chat',messageId:'message',status:'routing',route:null,error:null,startedAt:'2026-10-26T12:00:00Z',endedAt:null,usage:null};store.put('run',owner);
  runs.admissionGuard=()=>{};await runs.call('openai',{...request,runId:owner.id,usagePurpose:'routing-classifier'},()=>{},new AbortController().signal,true);
  assert.equal(store.get<Run>('run',owner.id)!.accountKey,undefined);
  runs.admissionGuard=()=>{throw Error('Final inference admission hold');};await assert.rejects(runs.call(finalProvider,{...request,runId:owner.id},()=>{},new AbortController().signal,true),/admission hold/);
  const failed={...store.get<Run>('run',owner.id)!,status:'failed' as const,route:{provider:finalProvider,model:'m',strategy:'direct' as const,reason:''},endedAt:'2026-10-26T12:00:01Z'};insights.recordRun(failed,'coding');
 }
 assert.equal(insights.snapshot().models.length,0);assert.equal(insights.snapshot().usage.dispatches.length,2);assert.ok(insights.snapshot().usage.dispatches.every(row=>row.purpose==='routing-classifier'));assert.equal(insights.snapshot().usage.runs.length,0);
}));
test('session totals deduplicate across shared calls and normal run evidence, and malformed telemetry is sanitized',async()=>fixture(async({store,runs,insights,request,state,setResponse})=>{
 const accountKey=accountUsageKey(state)!,sessionUsage=normalizeUsage({inputTokens:100,outputTokens:10,chargedCents:0},{provider:'openai',accountKey,source:'cursor-sdk',scope:'agent',sessionId:'session',observedAt:'2026-10-26T12:00:00Z'});
 setResponse({text:'Done',sessionId:'session',usage:{inputTokens:4,outputTokens:1},sessionUsage});await runs.call('openai',request,()=>{},new AbortController().signal,false);await runs.call('openai',request,()=>{},new AbortController().signal,false);
 const dispatch=store.list<UsageDispatch>('provider-usage')[0];insights.recordRun({id:request.runId,agentId:'bot',conversationId:'discussion',messageId:'message',status:'complete',route:{provider:'openai',model:'m',strategy:'manual',reason:''},error:null,startedAt:'2026-10-26T12:00:00Z',endedAt:'2026-10-26T12:00:01Z',usage:{inputTokens:4,outputTokens:1},accountKey,usageObservation:dispatch.usage,sessionUsage});
 const snapshot=insights.snapshot();assert.equal(snapshot.usage.runs.length,2);assert.equal(snapshot.usage.sessions.length,1);assert.equal(snapshot.usage.sessions[0].tokens.inputTokens,100);assert.equal(snapshot.usage.sessions[0].chargedCents,0);
 setResponse({text:'Done',sessionId:'session',sessionUsage:{...sessionUsage,accountKey:'different-account'},usage:{inputTokens:-1,outputTokens:Infinity}});const result=await runs.call('openai',request,()=>{},new AbortController().signal,false);assert.equal(result.sessionUsage,undefined);assert.equal(result.usage,undefined);assert.equal(result.usageObservation!.tokens.inputTokens,null);
}));
