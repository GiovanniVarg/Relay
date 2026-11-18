import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import {accountUsageKey} from '../server/provider-usage.js';
import {normalizeUsage} from '../shared/provider-usage.js';
import { RoutingInsights, classifyTask, measuredPreference,type RoutingObservation } from '../server/routing-insights.js';
import { chooseRoute, escalation } from '../server/router.js';
import {modelEvidence} from '../server/routing-evidence.js';
import type { ProviderState, Run } from '../shared/types.js';
const state=(id:'openai'|'claude',model='m1'):ProviderState=>({id,installed:true,authenticated:true,authMode:'subscription',accountLabel:'fixture',plan:'fixture',models:[{id:model,name:model,verified:false}],billing:{mode:'included',confirmed:true,automaticRouting:true,allowanceNote:''},modelPreferences:{defaultModel:model,allowedModels:[model]}});
const run=(id:string,provider:'openai'|'claude',status:Run['status']='complete',model='m1'):Run=>({id,agentId:'bot',conversationId:'chat',messageId:'message',status,route:{provider,model,reason:'Fixture',strategy:'manual'},error:null,startedAt:'2026-10-22T12:00:00Z',endedAt:'2026-10-22T12:00:10Z',usage:{inputTokens:20,outputTokens:10},mode:'chat',accountKey:accountUsageKey(state(provider))!});
const providers=()=>[state('openai'),state('claude')];
async function fixture(fn:(insights:RoutingInsights,store:Store)=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),'relay-insights-'));const store=new Store(dir);try{await fn(new RoutingInsights(store,providers),store);}finally{store.close();await rm(dir,{recursive:true,force:true});}}
const route=(states:ProviderState[],routing:ReturnType<RoutingInsights['snapshot']>,mode:'auto'|'openai'='auto')=>chooseRoute({content:'hello',mode,model:'',states,routing,settings:{maxRunSeconds:30,maxModelCalls:1,openaiDefaultModel:''},signal:new AbortController().signal,remainingSeconds:()=>30,call:async()=>{throw Error('No classifier needed');}});
test('host check observations are precise revision-check facts, separate from completion and human quality',async()=>fixture(async(insights)=>{insights.recordRun(run('pass','openai'),'coding');insights.recordChecks('pass',[{kind:'tool_receipt',id:'host',assertion:'checks_passed',changeId:'private-change',revision:'private-revision',current:true}]);insights.recordRun(run('failed-check','openai'),'coding');insights.recordChecks('failed-check',[{kind:'tool_receipt',id:'bad',assertion:'checks_failed',changeId:'private-change',revision:'private-revision'}]);insights.recordRun(run('unknown','openai'),'coding');const evidence=modelEvidence(state('openai'),'m1','coding',insights.snapshot());assert.ok('hostChecks'in evidence);if('hostChecks'in evidence)assert.deepEqual(evidence.hostChecks,{source:'host-relay-check-receipts',scope:'recorded-exact-revision-checks',passedSamples:1,failedSamples:1,unknownSamples:1});assert.equal('independentOutcome'in evidence?evidence.independentOutcome:null,'unknown');assert.ok(!JSON.stringify(evidence).includes('private-change'));assert.ok(!JSON.stringify(evidence).includes('private-revision'));}));

test('observations persist once, count actual tokens and human feedback without inventing allowance or cost',async()=>fixture(async(insights,store)=>{
 insights.recordRun(run('one','openai'),'general');insights.recordRun(run('one','openai'),'general');
 insights.feedback('one','unhelpful','direct-operator');const snapshot=insights.snapshot();assert.equal(snapshot.models[0].samples,1);assert.equal(snapshot.models[0].inputTokens,20);assert.equal(snapshot.models[0].unhelpful,1);assert.equal(snapshot.models[0].meanLatencyMs,10000);assert.deepEqual(snapshot.availability.map(item=>item.provider),['openai','claude','cursor','opencode']);assert.ok(snapshot.availability.every(item=>item.state==='unknown'&&item.source==='unknown'));assert.deepEqual(snapshot.availability.find(item=>item.provider==='opencode'),{provider:'opencode',state:'unknown',resetsAt:null,note:'',source:'unknown',updatedAt:null});assert.equal('cost' in snapshot.models[0],false);
 assert.equal(new RoutingInsights(store,providers).snapshot().models[0].unhelpful,1);assert.throws(()=>insights.feedback('missing','helpful'),/not found/i);
}));
test('current account alone supplies routing evidence; legacy observations and old declarations remain historical',async()=>fixture(async(insights,store)=>{
 insights.recordRun(run('bound','openai'));insights.recordRun({...run('legacy','openai'),accountKey:undefined});insights.setAvailability('openai',{state:'exhausted',note:'old-account-note'});
 assert.equal(insights.snapshot().models[0].samples,1);assert.equal(insights.snapshot().recent.length,2);
 insights.bindAccounts(()=>[{...state('openai'),accountLabel:'second'}]);let snapshot=insights.snapshot();assert.equal(snapshot.models.length,0);assert.equal(snapshot.availability[0].state,'unknown');assert.equal(snapshot.availability[0].note,'');
 insights.setAvailability('openai',{state:'available'});assert.equal(insights.snapshot().availability[0].state,'available');
 insights.bindAccounts(()=>[{...state('openai'),authenticated:false}]);snapshot=insights.snapshot();assert.equal(snapshot.availability[0].state,'unknown');assert.equal(snapshot.models.length,0);
 assert.equal(new RoutingInsights(store).snapshot().models.length,0);assert.equal(new RoutingInsights(store).snapshot().availability[0].source,'unknown');
 assert.throws(()=>new RoutingInsights(store).setAvailability('openai',{state:'available'}),/connected subscription/);
 store.put('routing-availability',{id:'claude',provider:'claude',state:'exhausted',source:'user',note:'legacy'});insights.bindAccounts(providers);assert.equal(insights.snapshot().availability.find(row=>row.provider==='claude')!.state,'unknown');
}));
test('agent snapshots are latest per session, never additive turn charges, including reported zero and unknown',async()=>fixture(async(insights)=>{
 const accountKey=accountUsageKey(state('openai'))!;
 for(let i=0;i<3;i++){const row=run('snapshot-'+i,'openai');row.usageObservation=normalizeUsage({inputTokens:i===0?0:20,outputTokens:10},{provider:'openai',accountKey,source:'provider-response',scope:'run',observedAt:`2026-10-26T12:00:0${i}Z`});row.sessionUsage=normalizeUsage({inputTokens:100,outputTokens:50,chargedCents:i===0?null:0},{provider:'openai',accountKey,source:'cursor-sdk',scope:'agent',sessionId:'shared-session',observedAt:`2026-10-26T12:00:0${i}Z`});insights.recordRun(row);}
 const snapshot=insights.snapshot();assert.equal(snapshot.usage.sessions.length,1);assert.equal(snapshot.usage.sessions[0].tokens.inputTokens,100);assert.equal(snapshot.usage.sessions[0].chargedCents,0);assert.equal(snapshot.usage.runs.length,3);assert.equal(snapshot.usage.runs.at(-1)!.tokens.inputTokens,0);assert.equal(snapshot.usage.remainingAllowance,null);assert.equal(snapshot.usage.resetAt,null);
}));
test('routing metrics retain known partial counters and distinguish unknown outputs from reported zero',async()=>fixture(async(insights)=>{
 const row=run('partial','openai'),accountKey=row.accountKey!;row.usage={inputTokens:0,outputTokens:0};row.usageObservation=normalizeUsage({inputTokens:7},{provider:'openai',accountKey,source:'provider-response',scope:'run',observedAt:'2026-10-26T12:00:00Z'});insights.recordRun(row);
 const model=insights.snapshot().models[0];assert.equal(model.inputTokens,7);assert.equal(model.inputReportedSamples,1);assert.equal(model.outputReportedSamples,0);assert.equal(model.usageReportedSamples,0);assert.equal(insights.snapshot().recent[0].outputTokens,null);
}));
test('auto routing learns task-kind reliability but honors manual routes and subscription defaults',async()=>fixture(async(insights)=>{
 for(let i=0;i<3;i++){insights.recordRun(run('a'+i,'openai','failed'),'general');insights.recordRun(run('b'+i,'claude'),'general');}
 assert.equal((await route([state('openai'),state('claude')],insights.snapshot())).provider,'claude');
 assert.equal((await route([state('openai'),state('claude')],insights.snapshot(),'openai')).provider,'openai');
 const withDefault=state('claude','preferred');withDefault.models.push({id:'m1',name:'Observed model',verified:false});withDefault.modelPreferences.allowedModels!.push('m1');
 insights.setAvailability('openai',{state:'exhausted'});assert.equal((await route([state('openai'),withDefault],insights.snapshot())).model,'preferred','A measured route must not replace the selected subscription default');
}));
test('declared exhaustion excludes automatic choices until reset, never enables billing or a disabled model',async()=>fixture(async(insights)=>{
 const baseline=state('openai');insights.setAvailability('openai',{state:'exhausted',resetsAt:'2099-01-01T00:00:00Z',note:'Checked dashboard'});
 assert.equal((await route([baseline,state('claude')],insights.snapshot())).provider,'claude');assert.equal(escalation({provider:'claude',model:'m1',reason:'',strategy:'direct'},[baseline,state('claude')],new Error('Temporary network timeout'),insights.snapshot()),undefined);assert.equal((await route([baseline,state('claude')],insights.snapshot(),'openai')).provider,'openai');
 insights.setAvailability('claude',{state:'exhausted',resetsAt:'2000-01-01T00:00:00Z'});assert.equal(insights.snapshot().availability.find(x=>x.provider==='claude')!.state,'unknown');
 insights.setAvailability('openai',{state:'available'});baseline.billing.confirmed=false;assert.equal((await route([baseline,state('claude')],insights.snapshot())).provider,'claude');
 assert.throws(()=>insights.setAvailability('grok' as never,{state:'available'}),/provider/i);assert.throws(()=>insights.setAvailability('openai',{state:'exhausted',resetsAt:'invalid'}),/reset/i);
}));
test('task categories are deterministic and samples remain separate across categories',async()=>fixture(async(insights)=>{
 assert.equal(classifyTask('Fix the TypeScript test failure'),'coding');assert.equal(classifyTask('Research competitor websites'),'research');assert.equal(classifyTask('Analyze this spreadsheet'),'analysis');assert.equal(classifyTask('hello'),'general');
 for(let i=0;i<3;i++){insights.recordRun(run('a'+i,'openai','failed'),'coding');insights.recordRun(run('b'+i,'claude'),'coding');}
 assert.equal((await route([state('openai'),state('claude')],insights.snapshot())).provider,'openai');
}));
test('all-retained observation windows aggregate many rows without argument-spread limits and sanitize legacy counters',()=>{
 const rows:RoutingObservation[]=Array.from({length:140000},(_,i)=>({id:String(i),provider:'openai',model:'m1',taskKind:'coding',accountKey:accountUsageKey(state('openai'))!,status:'complete',latencyMs:100,inputTokens:i===0?NaN:0,outputTokens:null,feedback:null,recordedAt:i===0?'2026-01-01T00:00:00Z':'2026-10-26T00:00:00Z'}));
 const fake={get:<T,>()=>undefined as T|undefined,put:<T extends{id:string}>(_kind:string,value:T)=>value,list:<T,>(kind:string)=>kind==='routing-observation'?rows as T[]:[]};const snapshot=new RoutingInsights(fake,providers).snapshot();const m=snapshot.models[0];assert.equal(m.samples,140000);assert.equal(m.firstObservedAt,'2026-01-01T00:00:00.000Z');assert.equal(m.lastObservedAt,'2026-10-26T00:00:00.000Z');assert.equal(m.inputReportedSamples,139999);assert.equal(m.outputReportedSamples,0);assert.equal(m.inputTokens,0);
});
test('rules keep explicit human preference separate from transport reliability and reject malformed aggregates',async()=>fixture(async(insights)=>{
 for(let i=0;i<3;i++){insights.recordRun(run('a-review'+i,'openai'),'general');insights.feedback('a-review'+i,'unhelpful','direct-operator');insights.recordRun(run('b-review'+i,'claude',i===0?'failed':'complete'),'general');insights.feedback('b-review'+i,'helpful','direct-operator');}
 const snapshot=insights.snapshot(),candidates=providers().map(s=>({provider:s.id as 'openai'|'claude',model:'m1',accountKey:accountUsageKey(s)}));const route=measuredPreference(candidates,snapshot,'general')!;assert.equal(route.provider,'claude');assert.match(route.reason,/human preference/);assert.match(route.reason,/correctness unknown/);snapshot.models[0].samples=Infinity;assert.equal(measuredPreference(candidates,snapshot,'general'),undefined);
}));
