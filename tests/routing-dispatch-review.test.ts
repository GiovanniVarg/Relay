import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {Runs} from '../server/runs.js';
import {InferenceScheduler,scheduleAdapters} from '../server/scheduler.js';
import {RoutingInsights} from '../server/routing-insights.js';
import type {ProviderAdapter,ProviderId,ProviderRequest} from '../shared/types.js';

test('review: declared exhaustion changed during queueing blocks automatic dispatch while a manual choice remains authoritative',async()=>{
 for(const automatic of[true,false]){
  const root=await mkdtemp(join(tmpdir(),'relay-availability-dispatch-')),store=new Store(root);let calls=0,release!:()=>void;
  const scheduler=new InferenceScheduler(1),gate=new Promise<void>(done=>release=done),lease=scheduler.run(undefined,new AbortController().signal,()=>gate);
  const state={id:'openai' as const,installed:true,authenticated:true,authMode:'subscription' as const,accountLabel:'Fixture',plan:'Fixture',models:[{id:'m',name:'m',verified:false}]};
  const adapter:ProviderAdapter={id:'openai',inspect:async()=>state,login:async()=>({message:''}),close:async()=>{},stream:async()=>{calls++;return{text:'Fixture result'};}};
  const raw=Object.fromEntries(['openai','claude','cursor','gemini','grok'].map(id=>[id,{...adapter,id}]))as unknown as Record<ProviderId,ProviderAdapter>;
  const runs=new Runs(store,scheduleAdapters(raw,scheduler));runs.states=[state];runs.insights=new RoutingInsights(store);store.saveBilling('openai',{mode:'included',confirmed:true,automaticRouting:true,allowanceNote:'Fixture'});store.saveModelPreferences('openai',{defaultModel:'m',allowedModels:['m']});
  const request:ProviderRequest={runId:'fixture',conversationId:'fixture',model:'m',instructions:'',history:[{role:'user',content:'Fixture'}],maxSeconds:30,mode:'chat',expectedAccount:{accountLabel:'Fixture',plan:'Fixture'}};
  try{
   const pending=runs.call('openai',request,()=>{},new AbortController().signal,automatic);const observed=pending.then(value=>({value,error:null}),error=>({value:null,error}));for(let i=0;i<100&&scheduler.queuedCount!==1;i++)await new Promise(done=>setTimeout(done,2));assert.equal(scheduler.queuedCount,1);
   runs.insights.setAvailability('openai',{state:'exhausted'});release();await lease;const result=await observed;
   if(automatic){assert.match(String(result.error),/exhausted/);assert.equal(calls,0);}else{assert.equal(result.error,null);assert.equal(calls,1);}
  }finally{release();await lease;await runs.close();store.close();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
 }
});
