import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {InferenceScheduler, scheduleAdapters} from '../server/scheduler.js';
import type {ProviderAdapter, ProviderEvent, ProviderId, ProviderRequest} from '../shared/types.js';

const deferred=()=>{let resolve!:()=>void;return {promise:new Promise<void>(r=>resolve=r),resolve:()=>resolve()};};
const tick=()=>new Promise(r=>setTimeout(r,10));
const request=(workspace?:string):ProviderRequest=>({runId:'synthetic-run',conversationId:'synthetic-chat',model:'synthetic-model',instructions:'Synthetic',history:[],maxSeconds:30,mode:workspace?'agent':'chat',workspace,expectedAccount:{accountLabel:'Synthetic',plan:'Synthetic'}});
function adapters(start:()=>Promise<{text:string}>){const adapter:ProviderAdapter={id:'openai',inspect:async()=>({id:'openai',installed:true,authenticated:false,authMode:'subscription',accountLabel:'Synthetic',plan:'Synthetic',models:[]}),login:async()=>({message:''}),close:async()=>{},stream:start};return {openai:adapter} as Record<ProviderId,ProviderAdapter>;}
const statuses=(events:ProviderEvent[])=>events.filter(e=>e.type==='status').map(e=>e.message);

test('scheduled adapter reports an overlapping safety hold without launching, clears on admission and keeps cleanup',async()=>{
 const root=await mkdtemp(join(tmpdir(),'relay-status-'));await mkdir(join(root,'child'));
 const scheduler=new InferenceScheduler(2);let starts=0;const events:ProviderEvent[]=[];const gate=deferred();
 // Synthetic exclusion only: no provider process exists in this fixture.
 scheduler.quarantine('synthetic-hold',scheduler.canonical(root),'provider',{runId:'synthetic-old',provider:'openai'});
 const adapter=scheduleAdapters(adapters(async()=>{starts++;assert.equal(statuses(events).at(-1),'Working…');await gate.promise;return {text:'Synthetic'};}),scheduler).openai;
 const pending=adapter.stream(request(join(root,'child')),e=>events.push(e),new AbortController().signal);
 try{
  await tick();assert.equal(starts,0);assert.equal(scheduler.queuedCount,1);assert.deepEqual(statuses(events),['Waiting for an unresolved safety hold…']);
  await tick();assert.equal(events.length,1,'unchanged wait reason is not repeated');
  scheduler.releaseQuarantine('synthetic-hold');await tick();assert.equal(starts,1);assert.equal(scheduler.activeCount,1);assert.deepEqual(statuses(events),['Waiting for an unresolved safety hold…','Working…']);
 }finally{gate.resolve();scheduler.releaseQuarantine('synthetic-hold');await pending;await rm(root,{recursive:true,force:true});}
 assert.equal(scheduler.activeCount,0);assert.equal(scheduler.queuedCount,0);
});

test('aborting a held scheduled adapter never dispatches or clears its exclusion',async()=>{
 const root=await mkdtemp(join(tmpdir(),'relay-status-'));const scheduler=new InferenceScheduler();let starts=0;const events:ProviderEvent[]=[];const controller=new AbortController();
 scheduler.quarantine('synthetic-hold',scheduler.canonical(root),'provider');
 const pending=scheduleAdapters(adapters(async()=>{starts++;return {text:'Synthetic'};}),scheduler).openai.stream(request(root),e=>events.push(e),controller.signal);
 try{await tick();assert.deepEqual(statuses(events),['Waiting for an unresolved safety hold…']);controller.abort(new Error('Synthetic abort'));await assert.rejects(pending,/Synthetic abort/);assert.equal(starts,0);assert.equal(scheduler.activeCount,1);assert.equal(scheduler.queuedCount,0);assert.equal(scheduler.listQuarantines().length,1);}finally{controller.abort();await pending.catch(()=>{});await rm(root,{recursive:true,force:true});}
});

test('ordinary capacity and workspace queues are distinct and update when blockers change',async()=>{
 const root=await mkdtemp(join(tmpdir(),'relay-status-'));const scheduler=new InferenceScheduler(2);const workspaceGate=deferred(),otherGate=deferred();const events:ProviderEvent[]=[];let starts=0;
 const a=scheduler.run(root,new AbortController().signal,()=>workspaceGate.promise),b=scheduler.run(undefined,new AbortController().signal,()=>otherGate.promise);
 const pending=scheduleAdapters(adapters(async()=>{starts++;return {text:'Synthetic'};}),scheduler).openai.stream(request(),e=>events.push(e),new AbortController().signal);
 try{await tick();assert.deepEqual(statuses(events),['Waiting for inference capacity…']);otherGate.resolve();await b;await pending;assert.equal(starts,1);assert.deepEqual(statuses(events),['Waiting for inference capacity…','Working…']);
 const workspaceEvents:ProviderEvent[]=[];const next=scheduleAdapters(adapters(async()=>({text:'Synthetic'})),scheduler).openai.stream(request(root),e=>workspaceEvents.push(e),new AbortController().signal);await tick();assert.deepEqual(statuses(workspaceEvents),['Waiting for another job in this workspace…']);
 scheduler.quarantine('synthetic-hold',scheduler.canonical(root),'provider');await tick();assert.equal(statuses(workspaceEvents).at(-1),'Waiting for an unresolved safety hold…');
 scheduler.releaseQuarantine('synthetic-hold');assert.equal(statuses(workspaceEvents).at(-1),'Waiting for another job in this workspace…');workspaceGate.resolve();await a;await next;assert.equal(statuses(workspaceEvents).at(-1),'Working…');
 }finally{workspaceGate.resolve();otherGate.resolve();scheduler.releaseQuarantine('synthetic-hold');await Promise.all([a,b,pending]);await rm(root,{recursive:true,force:true});}
});

test('status notification failure cannot prevent scheduled admission, work or cleanup',async()=>{
 const scheduler=new InferenceScheduler(1);const gate=deferred();let starts=0;const first=scheduler.run(undefined,new AbortController().signal,()=>gate.promise);
 const pending=scheduleAdapters(adapters(async()=>{starts++;return {text:'Synthetic'};}),scheduler).openai.stream(request(),()=>{throw Error('Synthetic UI failure');},new AbortController().signal);
 await tick();assert.equal(scheduler.queuedCount,1);assert.equal(starts,0);gate.resolve();await first;assert.deepEqual(await pending,{text:'Synthetic'});assert.equal(starts,1);assert.equal(scheduler.activeCount,0);assert.equal(scheduler.queuedCount,0);
});

test('rejected asynchronous notifications cannot erase an unknown provider outcome exclusion',async()=>{
 const scheduler=new InferenceScheduler(1);const gate=deferred();const first=scheduler.run(undefined,new AbortController().signal,()=>gate.promise);
 let notices=0;
 const pending=scheduler.run(undefined,new AbortController().signal,async()=>{throw Object.assign(Error('Synthetic unknown outcome'),{code:'PROVIDER_OUTCOME_UNKNOWN'});},'synthetic-provider',{runId:'synthetic-run',provider:'openai'},async()=>{notices++;throw Error('Synthetic disconnected UI');});
 const rejected=assert.rejects(pending,/Synthetic unknown outcome/);await tick();gate.resolve();await first;await rejected;await tick();assert.equal(notices,2);assert.equal(scheduler.activeCount,1);assert.equal(scheduler.queuedCount,0);assert.equal(scheduler.listQuarantines()[0].id,'synthetic-provider');
});

test('cleanup persistence failure updates an already queued adapter to a safety hold without launching it',async()=>{
 const store={list:<T>()=>[] as T[],put:<T>(_kind:string,value:T)=>value,remove:()=>{throw Error('Synthetic disk failure');}};
 const scheduler=new InferenceScheduler(1,store),gate=deferred(),controller=new AbortController();const events:ProviderEvent[]=[];let starts=0;
 const first=scheduler.run(undefined,new AbortController().signal,()=>gate.promise,'synthetic-first',{runId:'synthetic-first-run',provider:'openai'});
 const rejected=assert.rejects(first,/cleanup persistence failed/);
 const pending=scheduleAdapters(adapters(async()=>{starts++;return {text:'Synthetic'};}),scheduler).openai.stream(request(),e=>events.push(e),controller.signal);
 try{await tick();assert.equal(statuses(events).at(-1),'Waiting for inference capacity…');gate.resolve();await rejected;assert.equal(statuses(events).at(-1),'Waiting for an unresolved safety hold…');assert.equal(starts,0);assert.equal(scheduler.activeCount,1);assert.equal(scheduler.listQuarantines().length,1);}finally{gate.resolve();await rejected;controller.abort();await assert.rejects(pending);}
});
