import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {ProviderAccounts} from '../server/provider-accounts.js';
import {InferenceScheduler,scheduleAdapters} from '../server/scheduler.js';
import type {AccountState} from '../shared/accounts.js';
import type {ProviderAdapter,ProviderId,ProviderRequest,ProviderResult} from '../shared/types.js';
const ids:ProviderId[]=['openai','claude','cursor','opencode','gemini','grok'];
const tick=()=>new Promise<void>(done=>setImmediate(done));
for(const additional of [false,true])test('scheduled '+(additional?'additional':'default')+' account forwards exactly four native arguments and retains queue callbacks in the scheduler',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'relay-account-queue-boundary-')),store=new Store(directory),rawCalls:unknown[][]=[];
 const raw=(id:ProviderId,label:string):ProviderAdapter=>({id,inspect:async()=>({id,installed:true,authenticated:true,authMode:'subscription',accountLabel:label,plan:'team',models:[{id:'small',name:'small',verified:false}]}),login:async()=>({message:'Synthetic official sign-in'}),stream:function(...args:Parameters<ProviderAdapter['stream']>):Promise<ProviderResult>{rawCalls.push(args);return Promise.resolve({text:'fixture answer',actualModel:args[0].model});},close:async()=>{}});
 const defaults=Object.fromEntries(ids.map(id=>[id,raw(id,'default-'+id)])) as unknown as Record<ProviderId,ProviderAdapter>;
 const pool=new ProviderAccounts(store,defaults,{createAdapters:(_directory,account)=>({...defaults,[account.providerId]:raw(account.providerId,account.accountId)})});
 const controller=new AbortController();let release!:()=>void;const blocker=new Promise<void>(done=>{release=done;});let hold:Promise<void>|undefined,pending:Promise<ProviderResult>|undefined;
 try {
  let state:AccountState;
  if(additional){state=pool.create({provider:'openai',name:'Additional'});await pool.login(state.accountId);state=await pool.inspect(state.accountId);await pool.saveModels(state.accountId,{defaultModel:'small',allowedModels:['small'],expectedConnectionScope:state.connectionScope});state=await pool.saveBilling(state.accountId,{mode:'included',confirmed:true,automaticRouting:true,allowanceNote:'Explicit fixture approval',expectedAccount:{accountLabel:state.accountLabel,plan:state.plan},expectedConnectionScope:state.connectionScope});}
  else state=await pool.inspect('default-openai');
  const scheduler=new InferenceScheduler(1),scheduled=scheduleAdapters(pool.adapters(),scheduler),settled:boolean[]=[],statuses:string[]=[];let queueStarts=0,checks=0;
  const beforeDispatch=()=>{checks++;},queueWait=()=>{queueStarts++;return(admitted:boolean)=>{settled.push(admitted);};},queueStatus=(status:string)=>{statuses.push(status);};
  const request:ProviderRequest={runId:additional?'additional-budget':'default-budget',conversationId:'conversation',accountId:state.accountId,model:'small',instructions:'fixture',history:[{role:'user',content:'hello'}],maxSeconds:5,expectedAccount:{accountLabel:state.accountLabel,plan:state.plan},expectedConnectionScope:state.connectionScope};
  hold=scheduler.run(undefined,controller.signal,()=>blocker);await tick();
  const emit=()=>{};pending=scheduled.openai.stream(request,emit,controller.signal,beforeDispatch,queueWait,queueStatus);await tick();
  assert.equal(queueStarts,1);assert.equal(scheduler.queuedCount,1);assert.deepEqual(settled,[]);assert.equal(rawCalls.length,0);assert.ok(statuses.includes('capacity'));
  release();await hold;assert.equal((await pending).text,'fixture answer');
  assert.deepEqual(settled,[true]);assert.equal(rawCalls.length,1);assert.equal(rawCalls[0].length,4);
  assert.equal(rawCalls[0][0],request);assert.equal(rawCalls[0][1],emit);assert.equal(rawCalls[0][2],controller.signal);assert.equal(rawCalls[0][3],beforeDispatch);
  assert.equal(rawCalls[0].includes(queueWait),false);assert.equal(rawCalls[0].includes(queueStatus),false);assert.ok(checks>=1);assert.equal(scheduler.activeCount,0);
 }finally{release();controller.abort();await hold?.catch(()=>{});await pending?.catch(()=>{});await pool.close();await Promise.all(Object.values(defaults).map(adapter=>adapter.close()));store.close();await rm(directory,{recursive:true,force:true});}
});
