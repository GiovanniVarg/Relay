import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {RoutingInsights} from '../server/routing-insights.js';
import {accountUsageKey} from '../server/provider-usage.js';
import {normalizeUsage} from '../shared/provider-usage.js';
import {normalizeCodexAllowance} from '../shared/provider-allowance.js';
import {chooseRoute,type RouteInput} from '../server/router.js';
import type {ProviderState,Run} from '../shared/types.js';
import type {TypeSafeDecisionRequest} from '../shared/typesafe.js';
const state=(id:'openai'|'claude',model='small'):ProviderState=>({id,installed:true,authenticated:true,authMode:'subscription',accountLabel:id+'-private@example.test',plan:'fixture',models:[{id:model,name:model,description:'Current catalog capability',verified:false}],billing:{mode:'included',confirmed:true,automaticRouting:true,allowanceNote:''},modelPreferences:{defaultModel:model,allowedModels:[model]}});
const row=(id:string,provider:'openai'|'claude'):Run=>({id,agentId:'bot',conversationId:'chat',messageId:'m',status:'complete',route:{provider,model:'small',reason:'',strategy:'manual'},startedAt:'2026-10-26T12:00:00Z',endedAt:'2026-10-26T12:00:10Z',usage:null,error:null,accountKey:accountUsageKey(state(provider))!});
async function fixture(fn:(insights:RoutingInsights,store:Store)=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),'relay-route-evidence-')),store=new Store(dir);try{await fn(new RoutingInsights(store,()=>[state('openai'),state('claude')]),store);}finally{store.close();await rm(dir,{recursive:true,force:true});}}
const input=(changes:Partial<RouteInput>={}):RouteInput=>({content:'Fix TypeScript code',mode:'auto',model:'',states:[state('openai'),state('claude')],settings:{maxRunSeconds:30,maxModelCalls:1,openaiDefaultModel:'',routingClassifier:'typesafe'},signal:new AbortController().signal,remainingSeconds:()=>30,call:async()=>{throw Error('No paid classifier');},...changes});
const answer=(choice='1')=>({model:'jev-fixture',answers:{route:{type:'choice' as const,choice,confidence:1,probabilities:{'0':0,'1':1}}},usage:{inputTokens:2,outputTokens:1}});
test('actual Jev state carries exact account/task/model counts, provenance, partial counters and independent unknown',async()=>fixture(async(insights)=>{
 for(let i=0;i<60;i++){const r=row('a'+i,'openai');r.usageObservation=normalizeUsage({inputTokens:i===0?0:7},{provider:'openai',accountKey:r.accountKey!,source:'provider-response',scope:'run',observedAt:'2026-10-26T12:00:10Z'});insights.recordRun(r,'coding');}
 insights.feedback('a0','helpful','direct-operator');insights.feedback('a0','unhelpful','direct-operator');insights.feedback('a0','unhelpful','direct-operator');
 insights.recordRun({...row('other-task','openai'),usage:{inputTokens:99999,outputTokens:99999}},'research');
 insights.recordRun({...row('other-account','openai'),accountKey:'old-account',usage:{inputTokens:99999,outputTokens:99999}},'coding');
 insights.recordRun({...row('other-model','openai'),route:{provider:'openai',model:'disabled',reason:'',strategy:'manual'}},'coding');
 let request!:TypeSafeDecisionRequest;const route=await chooseRoute(input({routing:insights.snapshot(),decide:async(_signal,r)=>{request=r;return answer();}}));
 const s=request.state as any,e=s.observations['0'];assert.equal(e.samples,60);assert.equal(e.providerTurn.completed,60);assert.equal(e.humanFeedback.helpful,0);assert.equal(e.humanFeedback.unhelpful,1);assert.equal(e.humanFeedback.missing,59);assert.equal(e.tokens.input.reportedSamples,60);assert.equal(e.tokens.input.total,413);assert.equal(e.tokens.output.reportedSamples,0);assert.equal(e.tokens.output.total,null);assert.equal(e.tokens.output.missingSamples,60);assert.equal(e.independentOutcome,'unknown');assert.equal(e.elapsed.meanFullRunElapsedMs,10000);assert.equal(e.source,'relay-run-observations');assert.equal(e.window.kind,'all-retained-current-account');assert.ok(e.window.firstObservedAt);assert.ok(e.window.lastObservedAt);assert.equal(s.observations['1'].status,'unknown');assert.equal(route.evidence?.sampleCount,60);assert.equal(route.evidence?.version,1);
 const encoded=JSON.stringify(request);assert.equal(e.humanFeedback.source,'direct-operator-channel');assert.equal(encoded.includes('private@example'),false);assert.equal(encoded.includes('old-account'),false);assert.equal(encoded.includes('99999'),false);assert.equal(encoded.includes('disabled'),false);assert.ok(Buffer.byteLength(encoded)<=65536);assert.match(request.questions.route.instructions,/completion.*correctness|completion.*verification/i);
}));
test('stale account snapshots, sparse data and malformed numeric evidence stay unknown without raw fields',async()=>fixture(async(insights)=>{
 insights.recordRun(row('sparse','openai'),'coding');const snapshot=insights.snapshot();const changed=state('openai');changed.accountLabel='new';let observed:any;
 await chooseRoute(input({states:[changed,state('claude')],routing:snapshot,decide:async(_s,r)=>{observed=r.state;return answer();}}));assert.deepEqual(observed.observations['0'],{status:'unknown',samples:0});
 const bad={...snapshot,models:snapshot.models.map(m=>({...m,samples:Infinity,helpful:-2,description:'password=should-never-forward'}))};await chooseRoute(input({routing:bad,decide:async(_s,r)=>{observed=r.state;return answer();}}));assert.equal(observed.observations['0'].status,'unknown');assert.ok(!JSON.stringify(observed).includes('should-never-forward'));
 await chooseRoute(input({routing:snapshot,decide:async(_s,r)=>{observed=r.state;return answer();}}));assert.equal((observed as any).observations['0'].status,'sparse');assert.equal((observed as any).observations['0'].tokens.input.total,null);
}));
test('Jev cannot select a route revoked during the decision',async()=>{
 const states=[state('openai'),state('claude')];let calls=0;const route=await chooseRoute(input({states,decide:async()=>{calls++;states[1].billing.confirmed=false;return answer();}}));assert.equal(route.provider,'openai');assert.equal(route.strategy,'direct');assert.equal(calls,1);
});
test('account/model/exhaustion changes after selection cannot bypass the second eligibility check',async()=>{
 for(const change of ['account','model','exhaustion','all-revoked']){
  const states=[state('openai'),state('claude')],routing={models:[],availability:[],recent:[]} as unknown as ReturnType<RoutingInsights['snapshot']>;
  const pending=chooseRoute(input({states,routing,decide:async()=>{
   if(change==='account')states[1].accountLabel='changed';if(change==='model')states[1].modelPreferences.allowedModels=[];
   if(change==='exhaustion')routing.availability.push({provider:'claude',state:'exhausted',resetsAt:null,note:'',source:'user',updatedAt:null,accountKey:accountUsageKey(states[1])!});
   if(change==='all-revoked')for(const s of states)s.billing.confirmed=false;
   return answer();
  }}));
  if(change==='all-revoked')await assert.rejects(pending,/permission|account changed/i);else assert.equal((await pending).provider,'openai');
 }
});
test('redaction precedes catalog trimming; overflow never sends partial catalog or over-limit request',async()=>{
 const a=state('openai'),b=state('claude');a.models[0].description='x'.repeat(490)+' password="private catalog secret"';let request:any,calls=0;
 await chooseRoute(input({states:[a,b],decide:async(_s,r)=>{request=r;calls++;return answer();}}));assert.equal(JSON.stringify(request).includes('private catalog secret'),false);
 a.models=Array.from({length:255},(_,i)=>({id:'model-'+i+'x'.repeat(160),name:'n'.repeat(160),description:'d'.repeat(500),verified:false}));a.modelPreferences={defaultModel:a.models[0].id,allowedModels:null};calls=0;const route=await chooseRoute(input({states:[a],decide:async(_s,r)=>{assert.ok(Buffer.byteLength(JSON.stringify(r))<=65536);assert.equal(Object.keys((r.questions.route as any).criteria).length,255);calls++;return answer('0');}}));assert.ok(calls<=1);if(!calls)assert.match(route.reason,/size|limit|64/i);
});
test('reported percentage windows are bounded source facts, never quota recovery or model quality; stale becomes unknown',async()=>{
 const states=[state('openai'),state('claude')],a=states[0],key=accountUsageKey(a)!;
 a.allowance=normalizeCodexAllowance({ordinaryUsageAllowed:true,rateLimitsByLimitId:{'private-limit-id':{primary:{usedPercent:100,windowDurationMins:300,resetsAt:Math.floor(Date.now()/1000)+600}}}},key);
 let payload:any;await chooseRoute(input({states,decide:async(_s,r)=>{payload=r.state;return answer();}}));const quota=payload.reportedAllowance.openai;assert.equal(quota.source,'codex-app-server');assert.equal(quota.windows[0].usedPercent,100);assert.equal(quota.ordinaryUsageAllowed,true);assert.equal(quota.maxAgeMs,300000);assert.ok(!JSON.stringify(payload).includes(key));assert.ok(!JSON.stringify(payload).includes('private-limit-id'));
 a.allowance.observedAt=new Date(Date.now()-300001).toISOString();await chooseRoute(input({states,decide:async(_s,r)=>{payload=r.state;return answer();}}));assert.deepEqual(payload.reportedAllowance.openai,{status:'unknown'});
});
