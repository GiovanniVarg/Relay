import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {Tasks} from '../server/tasks.js';
import type {Agent,Run} from '../shared/types.js';
import type {TaskCheckStatus,TaskPendingCheck} from '../shared/tasks.js';

const utc=(time:number)=>new Date(time).toISOString();
async function fixture(t:TestContext,trustedRemaining=10000){
 const root=await mkdtemp(join(tmpdir(),'relay-check-clock-')),store=new Store(root),agent=store.list<Agent>('agent')[0];let wall=1000,mono=1000,starts=0,status:TaskCheckStatus|undefined;
 t.mock.method(performance,'now',()=>mono);let tasks!:Tasks;
 tasks=new Tasks(store,{snapshot:runId=>store.get<Run>('run',runId),cancel:async()=>{},checkStatus:async()=>status!,start:async task=>{starts++;const run={id:'next-run',agentId:agent.id,conversationId:task.conversationId!,messageId:'next-message',status:'routing' as const,route:null,error:null,startedAt:utc(wall),endedAt:null,usage:null};store.put('run',run);tasks.attachRun(task.id,run,task.attempt);tasks.reserveCall(run.id);return{runId:run.id,conversationId:run.conversationId};}},{clock:()=>wall,hostInstanceId:'host'});
 const run:Run={id:'origin-run',agentId:agent.id,conversationId:store.conversations(agent.id)[0].id,messageId:'message',mode:'agent',status:'running',route:null,error:null,startedAt:utc(0),endedAt:null,usage:null};store.put('run',run);let task=tasks.adopt({agentId:agent.id,runId:run.id,conversationId:run.conversationId,title:'Clock fixture',prompt:'Check exact source'});store.put('task',{...task,budget:{calls:1,maxCalls:2,deadline:utc(11000)}});
 const check:TaskPendingCheck={requestId:'job',changeId:'draft',revision:'one',runId:run.id,taskId:task.id,attempt:task.attempt,receiptId:run.id+':check',acceptedAt:utc(0),hostInstanceId:'host',state:'accepted'};store.put('workspace-tool',{id:check.receiptId,runId:run.id,agentId:agent.id,name:'relay_check_change',status:'complete',result:check});tasks.deferCheck(run.id,check);run.status='complete';run.endedAt=utc(wall);store.put('run',run);tasks.checkRunSettled(run,trustedRemaining);task=tasks.get(task.id);
 return{store,tasks,task,get starts(){return starts;},finish(jobWall:number,jobMono:number,monitorWall:number,monitorMono:number){wall=monitorWall;mono=monitorMono;status={...task.pendingCheck!,state:'ready',current:true,endedAt:utc(jobWall),endedMonotonic:jobMono};},remaining(){return Date.parse(tasks.get(task.id).budget!.deadline)-wall;},async close(){await tasks.close();store.close();await rm(root,{recursive:true,force:true});}};
}
test('backward wall clock cannot mint active time from an otherwise valid monotonic check wait',async t=>{const f=await fixture(t);try{f.finish(500,6000,600,6100);await f.tasks.tick();assert.equal(f.starts,1);assert.ok(f.remaining()<=9900,'original 10000ms minus 100ms post-check elapsed is the ceiling');assert.equal(f.tasks.get(f.task.id).budget!.calls,2);}finally{await f.close();}});
test('forward wall jump fails closed rather than extending remaining inference allowance',async t=>{const f=await fixture(t);try{f.finish(21000,6000,21100,6100);await f.tasks.tick();assert.equal(f.starts,0);assert.equal(f.tasks.get(f.task.id).status,'needs_input');assert.ok(f.remaining()<=9900);assert.equal(f.tasks.get(f.task.id).budget!.calls,1);}finally{await f.close();}});
test('normal clocks preserve exact host wait while charging post-check delay once',async t=>{const f=await fixture(t);try{f.finish(6000,6000,6100,6100);await f.tasks.tick();assert.equal(f.starts,1);assert.equal(f.remaining(),9900);assert.equal(f.store.list<any>('check-wait-settlement')[0].credit,5000);}finally{await f.close();}});
for(const backward of[false,true])test('job ending before provider completion never double-charges active inference: '+backward,async t=>{const f=await fixture(t);try{f.finish(500,500,backward?600:1100,1100);await f.tasks.tick();assert.equal(f.starts,1);assert.equal(f.remaining(),9900);assert.equal(f.store.list<any>('check-wait-settlement')[0].credit,0);}finally{await f.close();}});
for(const invalid of[NaN,Infinity,0,-1])test('invalid trusted remaining proof cannot open a waiting lease: '+invalid,async t=>{const f=await fixture(t,invalid);try{await f.tasks.tick();assert.equal(f.starts,0);assert.equal(f.tasks.get(f.task.id).recoveryRequired,true);assert.equal(f.tasks.get(f.task.id).pendingCheck!.waitLease,undefined);}finally{await f.close();}});
