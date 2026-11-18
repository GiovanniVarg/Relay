import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeOwnedProvider, reconcileProviderCall, validateProviderMessage, GuardedProviderAdapter, providerProcessGone } from '../server/providers/lifecycle.js';
import { providerOutcomeUnknown } from '../server/providers/process.js';
import { ChildRegistry } from '../server/herdr/registry.js';
import type { ProviderAdapter, ProviderRequest } from '../shared/types.js';
import {markOutcomeReconciliation} from '../server/outcome-reconciliation.js';

const request:ProviderRequest={runId:'run',conversationId:'conversation',model:'model',instructions:'private prompt',history:[{role:'user',content:'hello'}],maxSeconds:2,expectedAccount:{accountLabel:'account',plan:'team'}};
async function fixture(run:(directory:string)=>Promise<void>){const d=await mkdtemp(join(tmpdir(),'relay-provider-life-'));try{await run(d);}finally{await rm(d,{recursive:true,force:true});}}
test('ordinary ownership is established before adapters; normal root exit still drains',async()=>fixture(async directory=>{
 const order:string[]=[];
 const outcome=await executeOwnedProvider({provider:'openai',dataDir:directory,directory,request,signal:new AbortController().signal,emit:()=>{},registry:new ChildRegistry(join(directory,'children.jsonl'),{delegationId:'call',parentRunId:'run',epoch:'epoch'},'key'),
  createGuard:async()=>{order.push('guard');return{drain:async()=>{order.push('drain');return[];},release:async()=>{order.push('release');}};},
  createAdapter:(_id,_data,_launcher,kill)=>{order.push('adapter');return {id:'openai',inspect:async()=>({} as any),login:async()=>({message:''}),stream:async()=>{order.push('stream');await kill({} as any);return{text:'genuine',actualModel:'model'};},close:async()=>{order.push('close');}};}});
 assert.equal(outcome.result?.text,'genuine');assert.equal(outcome.cleanup,true);assert.deepEqual(order,['guard','adapter','stream','drain','close','drain','release']);
}));
test('guard failure forbids dispatch and missing final drain proof never yields success',async()=>fixture(async directory=>{
 let launched=0;const base={provider:'openai' as const,dataDir:directory,directory,request,signal:new AbortController().signal,emit:()=>{},registry:new ChildRegistry(join(directory,'children.jsonl'),{delegationId:'call',parentRunId:'run',epoch:'epoch'},'key'),createAdapter:()=>{launched++;return {} as ProviderAdapter;}};
 const outcome=await executeOwnedProvider({...base,createGuard:async()=>{throw Error('guard unavailable');}});
 assert.equal(launched,0);assert.equal(outcome.result,undefined);assert.match(String(outcome.error),/guard unavailable/);
 const failed=await executeOwnedProvider({...base,createGuard:async()=>({drain:async()=>{throw Error('missing proof');},release:async()=>{}}),createAdapter:()=>({id:'openai',stream:async()=>({text:'genuine'}),close:async()=>{},inspect:async()=>({} as any),login:async()=>({message:''})})});
 assert.equal(failed.cleanup,false);assert.equal(failed.result?.text,'genuine');
}));
test('missing durable receipt cannot reconcile and unknown prefix is idempotent',async()=>fixture(async directory=>{
 assert.equal((await reconcileProviderCall(directory,'run','openai')).stopped,false);
 assert.equal((await reconcileProviderCall(directory,'run','openai')).bootRecoveryEligible,true);
 const error=providerOutcomeUnknown(providerOutcomeUnknown('guard_failed').message);
 assert.equal(error.message.match(/Provider process-tree termination is unknown:/g)?.length,1);
}));
test('private IPC rejects duplicate sequences, methods, callbacks and oversized graphs',()=>{
 assert.throws(()=>validateProviderMessage({seq:1,type:'eval',data:{}},0,['answer']),/message/);
 assert.throws(()=>validateProviderMessage({seq:2,type:'answer',data:{}},0,['answer']),/message/);
 assert.throws(()=>validateProviderMessage({seq:1,type:'answer',data:{callback:()=>{}}},0,['answer']),/JSON/);
 assert.throws(()=>validateProviderMessage({seq:1,type:'answer',data:{value:'x'.repeat(3*1024*1024)}},0,['answer']),/limit/);
});
test('modern boot eligibility scans every valid receipt and refuses pending or missing callback state',async()=>fixture(async directory=>{
 const root=join(directory,'provider-calls',createHash('sha256').update('openai\0run').digest('hex'));
 const write=async(activeCallbacks:number|undefined)=>{const call=randomUUID(),path=join(root,call);await mkdir(path,{recursive:true});await writeFile(join(path,'receipt.json'),JSON.stringify({version:1,provider:'openai',delegationId:call,parentRunId:'run',epoch:randomUUID(),registryKey:'a'.repeat(64),workerPid:process.pid,status:'running',dispatchCommitted:true,...(activeCallbacks===undefined?{}:{activeCallbacks})}));};
 await write(0);const local=await reconcileProviderCall(directory,'run','openai');assert.equal(local.stopped,false);assert.equal(local.bootRecoveryEligible,true);
 await write(1);assert.equal((await reconcileProviderCall(directory,'run','openai')).bootRecoveryEligible,false);
 await rm(root,{recursive:true,force:true});await write(undefined);assert.equal((await reconcileProviderCall(directory,'run','openai')).bootRecoveryEligible,false);
}));
const windowsProbe=process.platform==='win32'&&process.env.RELAY_WINDOWS_PROVIDER_PROBE==='1';
test('owned worker restores only the host reconciliation brand, never a request JSON lookalike',{skip:!windowsProbe},async()=>fixture(async directory=>{
 const adapter=new GuardedProviderAdapter(directory,{id:'openai',inspect:async()=>({} as any),login:async()=>({message:''}),close:async()=>{},stream:async()=>{throw Error('direct forbidden');}} as ProviderAdapter,{workerPath:fileURLToPath(new URL('./fixtures/provider-lifecycle-worker.ts',import.meta.url))});
 try{for(const trusted of [false,true]){
  const report={...request,model:'report-marker',mode:'chat' as const,usagePurpose:'outcome-reconciliation' as const,outcomeReconciliation:true};
  const result=await adapter.stream(trusted?markOutcomeReconciliation(report):report,()=>{},new AbortController().signal);
  assert.deepEqual(JSON.parse(result.text),{marked:trusted,hasTools:false,hasInteraction:false});
 }}finally{await adapter.close();}
}));
async function onlyCall(directory:string){const run=(await readdir(join(directory,'provider-calls')))[0],call=(await readdir(join(directory,'provider-calls',run)))[0];return join(directory,'provider-calls',run,call);}
for(const action of ['cancel','deny'] as const)test('worker '+action+' before init proves no native dispatch without quarantine',{skip:!windowsProbe},async()=>fixture(async directory=>{
 const adapter=new GuardedProviderAdapter(directory,{id:'openai',inspect:async()=>({} as any),login:async()=>({message:''}),close:async()=>{},stream:async()=>{throw Error('direct forbidden');}} as ProviderAdapter,{workerPath:fileURLToPath(new URL('./fixtures/provider-lifecycle-worker.ts',import.meta.url))});
 const controller=new AbortController();let checked=0;
 await assert.rejects(adapter.stream(request,()=>{throw Error('pre-dispatch worker emitted an event');},controller.signal,()=>{checked++;if(action==='cancel')controller.abort();else throw Error('Fixture dispatch policy denied');}),error=>{assert.notEqual((error as any).code,'PROVIDER_OUTCOME_UNKNOWN');return action==='cancel'?/cancelled/.test(String(error)):/Fixture dispatch policy denied/.test(String(error));});
 assert.equal(checked,1);const call=await onlyCall(directory),receipt=JSON.parse(await readFile(join(call,'receipt.json'),'utf8'));
 assert.equal(receipt.dispatchCommitted,false);assert.equal(receipt.activeCallbacks,0);assert.equal(receipt.status,'stopped');assert.equal(providerProcessGone(receipt.workerPid),true);
 assert.ok(!(await readdir(call)).includes('tree-guard.ps1'));assert.ok(!(await readdir(call)).includes('children.jsonl'));assert.deepEqual(await reconcileProviderCall(directory,request.runId,'openai'),{stopped:true});
 for(const changed of [{dispatchCommitted:true},{dispatchCommitted:undefined},{activeCallbacks:1},{workerPid:process.pid}]){await writeFile(join(call,'receipt.json'),JSON.stringify({...receipt,...changed}));assert.equal((await reconcileProviderCall(directory,request.runId,'openai')).stopped,false);}
 await writeFile(join(call,'receipt.json'),JSON.stringify(receipt));await adapter.close();
}));
test('real Windows isolated worker drains grandchild after normal root exit and records reusable proof',{skip:!windowsProbe},async(t)=>fixture(async directory=>{
 let account='account';const direct={id:'openai',inspect:async()=>({id:'openai',installed:true,authenticated:true,authMode:'subscription',accountLabel:account,plan:'team',models:[{id:'normal',name:'Normal',verified:false}]}),login:async()=>({message:''}),close:async()=>{},stream:async()=>{throw Error('direct inference forbidden');}} as ProviderAdapter;
 const adapter=new GuardedProviderAdapter(directory,direct,{workerPath:fileURLToPath(new URL('./fixtures/provider-lifecycle-worker.ts',import.meta.url))});
 let descendant=0;const result=await adapter.stream({...request,model:'normal',maxSeconds:10},event=>{if(event.type==='status'&&event.message.startsWith('fixture-descendant:'))descendant=Number(event.message.split(':')[1]);},new AbortController().signal);
 assert.equal(result.text,'genuine fixture result');assert.ok(descendant>0);assert.equal(providerProcessGone(descendant),true);assert.deepEqual(await reconcileProviderCall(directory,request.runId,'openai'),{stopped:true});assert.equal((await adapter.inspect()).models[0].verified,true);account='changed-account';assert.equal((await adapter.inspect()).models[0].verified,false);
 const runs=await readdir(join(directory,'provider-calls')),calls=await readdir(join(directory,'provider-calls',runs[0])),call=join(directory,'provider-calls',runs[0],calls[0]);const receipt=await readFile(join(call,'receipt.json'),'utf8'),registry=await readFile(join(call,'children.jsonl'),'utf8');
 assert.ok(!receipt.includes('private prompt')&&!registry.includes('private prompt'));const identities=[...new Set(registry.trimEnd().split('\n').map(row=>JSON.parse(row).data.pid).filter(Boolean))] as number[];assert.ok(identities.includes(descendant),'surviving detached descendant must be observed in job drain');assert.ok(!identities.includes(process.pid));assert.ok(identities.every(providerProcessGone));t.diagnostic(JSON.stringify({hostPid:process.pid,ownedPids:identities,descendant,allGone:true}));await adapter.close();
}));
test('real Windows worker brokers only parent tool and approval functions',{skip:!windowsProbe},async()=>fixture(async directory=>{
 let calls=0,approvals=0;const adapter=new GuardedProviderAdapter(directory,{id:'openai',inspect:async()=>({} as any),login:async()=>({message:''}),close:async()=>{},stream:async()=>{throw Error('direct forbidden');}} as ProviderAdapter,{workerPath:fileURLToPath(new URL('./fixtures/provider-lifecycle-worker.ts',import.meta.url))});
 const result=await adapter.stream({...request,model:'callbacks',interact:async()=>{approvals++;return{decision:'allow'};},appTools:{definitions:[{name:'relay_fixture',description:'Fixture',inputSchema:{type:'object'}}],call:async(_id,_name,args)=>{calls++;return args;}}},()=>{},new AbortController().signal);
 assert.equal(result.text,'{"accepted":"allow"}');assert.equal(calls,1);assert.equal(approvals,1);await adapter.close();
}));
test('real Windows abort drains surviving descendants and does not fabricate a result',{skip:!windowsProbe},async(t)=>fixture(async directory=>{
 const adapter=new GuardedProviderAdapter(directory,{id:'openai',inspect:async()=>({} as any),login:async()=>({message:''}),close:async()=>{},stream:async()=>{throw Error('direct forbidden');}} as ProviderAdapter,{workerPath:fileURLToPath(new URL('./fixtures/provider-lifecycle-worker.ts',import.meta.url))});const controller=new AbortController();let descendant=0;
 await assert.rejects(adapter.stream({...request,model:'abort',maxSeconds:10},event=>{if(event.type==='status'&&event.message.startsWith('fixture-descendant:')){descendant=Number(event.message.split(':')[1]);controller.abort();}},controller.signal),error=>{assert.notEqual((error as any).code,'PROVIDER_OUTCOME_UNKNOWN');return /cancelled/.test(String(error));});
 assert.ok(descendant>0);assert.equal(providerProcessGone(descendant),true);assert.deepEqual(await reconcileProviderCall(directory,request.runId,'openai'),{stopped:true});t.diagnostic(JSON.stringify({abortDescendant:descendant,allGone:true}));await adapter.close();
}));
test('real Windows cancellation retains unknown until a running host app callback settles',{skip:!windowsProbe},async()=>fixture(async directory=>{
 const adapter=new GuardedProviderAdapter(directory,{id:'openai',inspect:async()=>({} as any),login:async()=>({message:''}),close:async()=>{},stream:async()=>{throw Error('direct forbidden');}} as ProviderAdapter,{workerPath:fileURLToPath(new URL('./fixtures/provider-lifecycle-worker.ts',import.meta.url))});const controller=new AbortController();let finish!:()=>void;
 const pending=adapter.stream({...request,model:'callbacks',interact:async()=>({decision:'allow'}),appTools:{definitions:[{name:'relay_fixture',description:'Fixture',inputSchema:{type:'object'}}],call:async()=>{controller.abort();await new Promise<void>(done=>finish=done);return{};}}},()=>{},controller.signal);
 await assert.rejects(pending,{code:'PROVIDER_OUTCOME_UNKNOWN'});const blocked=await reconcileProviderCall(directory,request.runId,'openai');assert.equal(blocked.stopped,false);assert.notEqual(blocked.bootRecoveryEligible,true);
 const run=(await readdir(join(directory,'provider-calls')))[0],call=(await readdir(join(directory,'provider-calls',run)))[0],receipt=join(directory,'provider-calls',run,call,'receipt.json');assert.equal(JSON.parse(await readFile(receipt,'utf8')).activeCallbacks,1);
 finish();for(let i=0;i<100&&JSON.parse(await readFile(receipt,'utf8')).activeCallbacks!==0;i++)await new Promise(done=>setTimeout(done,10));assert.deepEqual(await reconcileProviderCall(directory,request.runId,'openai'),{stopped:true});await adapter.close();
}));
