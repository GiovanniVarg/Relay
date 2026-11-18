import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {Tasks} from '../server/tasks.js';
import type {Agent} from '../shared/types.js';
import type {Task,TaskRunSnapshot} from '../shared/tasks.js';

async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'relay-blocked-polling-')),store=new Store(directory),agent=store.list<Agent>('agent')[0],starts:Task[]=[],snapshots=new Map<string,TaskRunSnapshot>();
 let now=Date.parse('2026-11-10T12:00:00Z');
 const tasks=new Tasks(store,{async start(task){starts.push(structuredClone(task));const runId='run-'+starts.length;snapshots.set(runId,{status:'running'});return{runId,conversationId:task.conversationId??'conversation'};},snapshot:runId=>snapshots.get(runId),async cancel(runId){snapshots.set(runId,{status:'cancelled'});}},{clock:()=>now});
 const metrics={receiptReads:0,receiptCharacters:0,taskWrites:0},list=store.list.bind(store),put=store.put.bind(store);
 store.list=<T>(kind:string):T[]=>{const rows=list<T>(kind);if(kind==='workspace-tool'||kind==='app-action'){metrics.receiptReads++;metrics.receiptCharacters+=JSON.stringify(rows).length;}return rows;};
 store.put=<T extends{id:string}>(kind:string,value:T):T=>{if(kind==='task')metrics.taskWrites++;return put(kind,value);};
 const reset=()=>{metrics.receiptReads=0;metrics.receiptCharacters=0;metrics.taskWrites=0;};
 async function tick(){now+=1000;await tasks.tick();}
 async function blocked(){const created=tasks.create({agentId:agent.id,title:'Blocked task',prompt:'Wait for the missing human decision'});await tick();const task=tasks.get(created.id);store.put('workspace-tool',{id:'large-receipt',agentId:agent.id,runId:task.runId!,name:'relay_read_file',status:'complete',result:{text:'x'.repeat(512*1024)}});await tasks.reportOutcome(task.id,task.runId!,{state:'blocked',summary:'Need a human decision',remaining:['Provide the missing decision'],evidence:[]});return tasks.get(task.id);}
 return{store,tasks,agent,starts,snapshots,metrics,reset,tick,blocked,async close(){await tasks.close();store.close();await rm(directory,{recursive:true,force:true});}};
}

test('settled explicit blocked task stops rereading receipt payloads and saving on repeated ticks',async t=>{
 const f=await fixture();try{
  const task=await f.blocked(),runId=task.runId!;f.snapshots.set(runId,{status:'complete',text:'Waiting for your decision.'});f.reset();await f.tick();const first={...f.metrics},settled=f.tasks.get(task.id);
  assert.ok(first.receiptReads>0);assert.ok(first.receiptCharacters>512*1024);assert.equal(first.taskWrites,1);
  f.reset();for(let n=0;n<4;n++)await f.tick();t.diagnostic(JSON.stringify({firstSettlement:first,fourParkedTicks:f.metrics}));
  assert.deepEqual(f.metrics,{receiptReads:0,receiptCharacters:0,taskWrites:0});assert.deepEqual(f.tasks.get(task.id),settled);
  assert.equal(settled.status,'needs_input');assert.equal(settled.phase,'waiting');assert.equal(settled.runId,null);assert.equal(settled.recoveryRequired,false);assert.equal(settled.outcome?.runId,runId);assert.deepEqual(settled.runIds,[runId]);assert.equal(f.starts.length,1);
 }finally{await f.close();}
});

test('explicit resume dispatches once and a new blocked run still receives its first full settlement',async()=>{
 const f=await fixture();try{
  const task=await f.blocked();f.snapshots.set(task.runId!,{status:'complete',text:'First blocked reply'});await f.tick();f.tasks.resume(task.id);await f.tick();const resumed=f.tasks.get(task.id);assert.equal(f.starts.length,2);assert.notEqual(resumed.runId,task.runId);assert.equal(resumed.attempt,2);
  await f.tasks.reportOutcome(task.id,resumed.runId!,{state:'blocked',summary:'Need the next decision',remaining:['Next decision'],evidence:[]});
  // resume retains waiting phase; it cannot stand in for observing this new run.
  assert.equal(f.tasks.get(task.id).phase,'waiting');f.snapshots.set(resumed.runId!,{status:'complete',text:'Second blocked reply'});f.reset();await f.tick();assert.ok(f.metrics.receiptReads>0);assert.equal(f.metrics.taskWrites,1);assert.equal(f.tasks.get(task.id).result,'Second blocked reply');assert.equal(f.tasks.get(task.id).runId,null);assert.equal(f.starts.length,2);
 }finally{await f.close();}
});

test('blocked report and waiting phase do not park an active run or bypass its late unknown receipt',async()=>{
 const f=await fixture();try{
  const task=await f.blocked();f.store.put('task',{...task,status:'needs_input',phase:'waiting'});f.reset();await f.tick();assert.equal(f.tasks.get(task.id).status,'working');assert.equal(f.tasks.get(task.id).runId,task.runId);assert.equal(f.metrics.taskWrites,1);
  f.store.put('workspace-tool',{id:'late-pending-write',agentId:f.agent.id,runId:task.runId!,name:'relay_write_file',status:'pending'});f.snapshots.set(task.runId!,{status:'complete',text:'Turn ended after reporting blocked'});f.reset();await f.tick();const settled=f.tasks.get(task.id);assert.ok(f.metrics.receiptReads>0);assert.equal(settled.recoveryRequired,true);assert.equal(settled.runId,task.runId);assert.match(settled.error??'',/unknown/);assert.equal(f.starts.length,1);
 }finally{await f.close();}
});

test('stale blocked outcome does not park a different current run as explicitly blocked',async()=>{
 const f=await fixture();try{
  const task=await f.blocked();f.store.put('task',{...task,status:'needs_input',phase:'waiting',outcome:{...task.outcome!,runId:'older-run'}});f.snapshots.set(task.runId!,{status:'complete',text:'Current turn needs its own outcome'});await f.tick();const settled=f.tasks.get(task.id);assert.equal(settled.recoveryRequired,true);assert.match(settled.error??'',/recorded for this run/);assert.notEqual(settled.error,task.outcome!.summary);assert.equal(f.starts.length,1);
 }finally{await f.close();}
});
