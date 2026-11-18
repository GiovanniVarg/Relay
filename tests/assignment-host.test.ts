import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {assignmentHostFixture} from './fixtures/assignment-host-fixture.js';
import type {Assignment} from '../shared/chat-assignments.js';
import type {RemoteJob,RemoteInventory} from '../shared/remote-jobs.js';
import type {Message,RunEvent} from '../shared/types.js';
import type {Task} from '../shared/tasks.js';
import {Tasks} from '../server/tasks.js';

async function get(f:ReturnType<typeof assignmentHostFixture>,path:string){
 let status=0,body='';const response={writeHead(code:number){status=code;},end(value:string){body+=value;}} as unknown as ServerResponse;
 assert.equal(await f.host.api({method:'GET'} as IncomingMessage,response,new URL(path,'http://127.0.0.1:3210')),true);
 assert.equal(status,200);return JSON.parse(body);
}
async function submit(f:ReturnType<typeof assignmentHostFixture>,content='@Worker: inspect routing'){
 const request={requestId:randomUUID(),source:f.source('conversation').source,content};return {request,receipt:await f.host.assignments.submit(request)};
}

test('selected offline or unready computer remains in Tasks queue while unrelated local work can start',async()=>{
 const f=assignmentHostFixture();try{
  f.heartbeat();f.advance(46000);
  const {receipt}=await submit(f,'@Worker: @computer/'+f.computerId+': perform this on the selected machine'),assignment=receipt.assignments[0],queued=f.tasks.get(assignment.taskId);
  assert.equal(f.host.canDispatchRemote(queued),false);assert.equal(f.state.localValidations.length,0);
  const local=f.tasks.create({agentId:f.origin.id,title:'Independent local task',prompt:'Local fixture only'});
  await f.tasks.tick();assert.equal(f.tasks.get(queued.id).status,'queued');assert.deepEqual(f.state.localStarts,[local.id]);assert.deepEqual(f.remote.forTask(queued.id),[]);
  f.heartbeat({...f.inventory,defaultAgent:{...f.inventory.defaultAgent!,ready:false}});await f.tasks.tick();assert.equal(f.tasks.get(queued.id).status,'queued');assert.equal(f.state.remoteStarts.length,0);
  f.heartbeat();assert.equal(f.host.canDispatchRemote(f.tasks.get(queued.id)),true);await f.tasks.tick();
  const started=f.tasks.get(queued.id);assert.equal(started.status,'working');assert.match(started.runId!,/^remote-/);assert.deepEqual(f.state.remoteStarts,[queued.id]);assert.deepEqual(f.state.localStarts,[local.id]);assert.equal(f.remote.forTask(queued.id)[0].computerId,f.computerId);
  await f.tasks.tick();assert.equal(f.remote.forTask(queued.id).length,1);
 }finally{await f.close();}
});

test('readiness requires current authorization, available worker model, modalities, and an inspected uncertain execution',async()=>{
 const f=assignmentHostFixture();try{
  f.heartbeat();const {receipt}=await submit(f,'@Worker: @computer/'+f.computerId+': render'),task=f.tasks.get(receipt.assignments[0].taskId);
  assert.equal(f.host.canDispatchRemote(task),true);f.authorized.delete(f.computerId);assert.equal(f.host.canDispatchRemote(task),false);f.authorized.add(f.computerId);
  const unavailable:RemoteInventory={...f.inventory,providers:[{id:'openai',models:[{...f.inventory.providers[0].models[0],available:false}]}]};f.heartbeat(unavailable);assert.equal(f.host.canDispatchRemote(task),false);
  f.heartbeat({...f.inventory,providers:[{id:'openai',models:[{...f.inventory.providers[0].models[0],modalities:['text']}]}]});assert.equal(f.host.canDispatchRemote({...task,requiredInputModalities:['image']}),false);
  f.heartbeat();const remote=f.remote.enqueue({taskId:'uncertain-task',attempt:1,agentId:f.worker.id,computerId:f.computerId,prompt:'Do not replay',capsuleId:randomUUID()}),job=f.remote.forTask('uncertain-task')[0];f.store.put<RemoteJob>('remote-jobs',{...job,state:'unknown'});
  assert.ok(remote.runId);assert.equal(f.host.canDispatchRemote(task),false);f.store.put<RemoteJob>('remote-jobs',{...job,state:'unknown',inspectedAt:Date.now()});assert.equal(f.host.canDispatchRemote(task),true);
  assert.equal(f.host.canDispatchRemote(f.tasks.create({agentId:f.origin.id,title:'Local',prompt:'Local'})),false);assert.equal(f.state.localStarts.length,0);
 }finally{await f.close();}
});

test('real host preserves source instruction and request identity without inheriting bot policy or foreign history',async()=>{
 const f=assignmentHostFixture();try{
  const current=f.conversation.id,foreign=f.store.createConversation(f.origin.id);
  const message=(conversationId:string,content:string,origin:'human'|'task-continuation'='human'):Message=>({id:randomUUID(),conversationId,role:'user',content,origin,createdAt:new Date().toISOString(),runId:null,status:'complete'});
  const relevant=message(current,'Routing context SYNTHETIC_SECRET');f.store.put('message',relevant);f.store.put('message',message(current,'INTERNAL_CONTROL','task-continuation'));f.store.put('message',message(foreign.id,'FOREIGN_CONTEXT'));
  const request={requestId:randomUUID(),source:f.source('conversation').source,content:'  @Worker: inspect routing exactly  ',replyToId:relevant.id};
  const [a,b]=await Promise.all([f.host.assignments.submit(request),f.host.assignments.submit(request)]);assert.deepEqual(a,b);assert.equal(f.store.list('task').length,1);assert.equal(a.message?.content,request.content);
  const task=f.tasks.get(a.assignments[0].taskId);assert.equal(task.prompt,'inspect routing exactly');const context=f.host.context(task.id);assert.match(context,/untrusted/i);assert.match(context,/\[redacted\]/);for(const forbidden of ['SYNTHETIC_SECRET','FOREIGN_CONTEXT','INTERNAL_CONTROL','ORIGIN_PRIVATE_POLICY','WORKER_POLICY'])assert.equal(context.includes(forbidden),false,forbidden);
  assert.equal(f.store.messages(current).filter(item=>item.content===request.content).length,1);await assert.rejects(f.host.assignments.submit({...request,content:'@Worker: changed'}),/different assignment content/);
 }finally{await f.close();}
});

test('owned local progress is bounded, redacted, coalesced, and visible with paged current output',async()=>{
 const f=assignmentHostFixture();try{
  const {receipt}=await submit(f),assignment=receipt.assignments[0],run=f.bind(f.tasks.get(assignment.taskId));
  for(let index=0;index<105;index++)f.host.observe(run.id,{type:'tool',runId:run.id,name:'tool-'+index,summary:'SYNTHETIC_SECRET '+String(index)+' '+('x'.repeat(900))});
  const progress=f.store.get<{events:{name:string;summary:string}[];progress:string}>('assignment-progress',assignment.id)!;assert.equal(progress.events.length,80);assert.ok(progress.events.every(event=>event.name.length<=100&&event.summary.length<=500));assert.ok(progress.progress.length<=500);assert.equal(JSON.stringify(progress).includes('SYNTHETIC_SECRET'),false);
  const last={type:'status' as const,runId:run.id,message:'Still working'};f.host.observe(run.id,last);const stable=f.store.get('assignment-progress',assignment.id);f.host.observe(run.id,last);assert.deepEqual(f.store.get('assignment-progress',assignment.id),stable);
  f.host.observe(run.id,{type:'delta',runId:run.id,text:'DO_NOT_DUPLICATE_MODEL_BODY'});f.host.observe(run.id,{type:'interaction',interaction:{id:'question',runId:run.id,title:'DO_NOT_STORE_QUESTION',questions:[{id:'credential',question:'DO_NOT_STORE_SECRET_FORM'}]}} as unknown as RunEvent);
  const recorded=JSON.stringify(f.store.get('assignment-progress',assignment.id));for(const excluded of ['DO_NOT_DUPLICATE_MODEL_BODY','DO_NOT_STORE_QUESTION','DO_NOT_STORE_SECRET_FORM'])assert.equal(recorded.includes(excluded),false);
  assert.match(f.host.summary(assignment).progress!,/Waiting for your response/);
  const text='SYNTHETIC_SECRET '+('result '.repeat(5000)),output=f.store.get<Message>('message',run.messageId)!;f.store.put('message',{...output,content:text});
  const first=await get(f,'/api/assignments/'+assignment.id+'?offset=0&limit=12000'),second=await get(f,'/api/assignments/'+assignment.id+'?offset='+first.result.end+'&limit=12000');
  assert.equal(first.result.text.length,12000);assert.equal(first.result.text+second.result.text,text.replaceAll('SYNTHETIC_SECRET','[redacted]').slice(0,24000));assert.equal(first.result.truncated,true);assert.equal(first.events.length,80);assert.equal(JSON.stringify(first).includes('SYNTHETIC_SECRET'),false);assert.equal(first.localRuns[0].runId,run.id);
 }finally{await f.close();}
});

test('progress rejects foreign/stale run IDs and admits only current delegated descendants',async()=>{
 const f=assignmentHostFixture();try{
  const {receipt}=await submit(f),assignment=receipt.assignments[0],run=f.bind(f.tasks.get(assignment.taskId));
  f.host.observe(run.id,{type:'status',runId:'foreign-run',message:'Wrong source'});assert.equal(f.store.get('assignment-progress',assignment.id),undefined);
  const unrelated=f.tasks.create({agentId:f.reviewer.id,title:'Unrelated',prompt:'Unrelated'}),other=f.bind(unrelated);f.host.observe(other.id,{type:'status',runId:other.id,message:'Foreign task'});assert.equal(f.store.get('assignment-progress',assignment.id),undefined);
  const child=f.tasks.delegate(assignment.taskId,f.reviewer.id,'Review only this assignment'),childRun=f.bind(child);f.host.observe(childRun.id,{type:'status',runId:childRun.id,message:'Checking assigned work'});assert.match(f.host.summary(assignment).progress!,/Reviewer: Checking assigned work/);
  const saved=f.store.get('assignment-progress',assignment.id),current=f.tasks.get(child.id);f.store.put<Task>('task',{...current,parentAttempt:0});f.host.observe(childRun.id,{type:'status',runId:childRun.id,message:'Stale descendant'});assert.deepEqual(f.store.get('assignment-progress',assignment.id),saved);
  f.state.writable=false;assert.doesNotThrow(()=>f.host.observe(run.id,{type:'status',runId:run.id,message:'Host is closing'}));assert.deepEqual(f.store.get('assignment-progress',assignment.id),saved);
 }finally{await f.close();}
});

test('cancellation targets its assignment task and preserves sibling jobs and the source bubble',async()=>{
 const f=assignmentHostFixture();try{
  const {receipt}=await submit(f,'@Worker: @Reviewer: inspect independently');await f.host.assignments.cancel(receipt.assignments[0].id);
  assert.equal(f.tasks.get(receipt.assignments[0].taskId).status,'cancelled');assert.equal(f.tasks.get(receipt.assignments[1].taskId).status,'queued');assert.equal(f.store.messages(f.conversation.id).length,1);
  const list=await get(f,'/api/assignments?kind=conversation&id='+f.conversation.id);assert.equal(list.assignments.length,2);assert.equal(list.assignments.filter((item:Assignment)=>item.taskId===receipt.assignments[1].taskId).length,1);
 }finally{await f.close();}
});

test('Tasks restart observes a saved remote lease without redispatch and fences an uncertain execution',async()=>{
 const f=assignmentHostFixture();let restored:Tasks|undefined;try{
  f.heartbeat();const {receipt}=await submit(f,'@Worker: @computer/'+f.computerId+': preserve the accepted execution'),assignment=receipt.assignments[0];await f.tasks.tick();const accepted=f.tasks.get(assignment.taskId),job=f.remote.forTask(accepted.id)[0];assert.match(accepted.runId!,/^remote-/);await f.tasks.close();
  let starts=0;const hooks={start:async()=>{starts++;throw Error('Saved execution must not replay');},snapshot:(runId:string)=>{const value=f.remote.snapshot(runId);return value?{...value,status:value.status==='error'?'failed' as const:value.status,pendingInteractions:value.pendingInteractions.length,endedAt:value.endedAt?new Date(value.endedAt).toISOString():undefined}:undefined;},cancel:async()=>{},availableCapacity:()=>false,recoverRun:(task:Task)=>f.remote.restoreKeepsWaiting({...task,runId:task.runId??undefined})};
  restored=new Tasks(f.store,hooks);await restored.tick();assert.equal(restored.get(accepted.id).recoveryRequired,false);assert.equal(restored.get(accepted.id).runId,accepted.runId);assert.equal(f.remote.forTask(accepted.id).length,1);assert.equal(starts,0);
  await restored.close();f.store.put<RemoteJob>('remote-jobs',{...job,state:'unknown',error:'Inspect the existing execution'});restored=new Tasks(f.store,hooks);await restored.tick();assert.equal(restored.get(accepted.id).status,'needs_input');assert.equal(restored.get(accepted.id).recoveryRequired,true);assert.equal(starts,0);
 }finally{await restored?.close();await f.close();}
});

test('remote readiness uses the assigned manual model and automatic model permissions rather than the computer default',async()=>{const f=assignmentHostFixture();try{const fixture={...f.inventory,providers:[{id:'openai' as const,models:[{id:'text-default',name:'Text',available:true,automatic:true,modalities:['text']}]},{id:'claude' as const,models:[{id:'vision',name:'Vision',available:true,automatic:false,modalities:['text','image']}]}],defaultAgent:{...f.inventory.defaultAgent!,model:'text-default'}};f.heartbeat(fixture);const {receipt}=await submit(f,'@Worker: @computer/'+f.computerId+': examine');const task=f.tasks.get(receipt.assignments[0].taskId),image={...task,requiredInputModalities:['image' as const]};f.store.put('agent',{...f.worker,routeMode:'claude',model:'vision'});assert.equal(f.host.canDispatchRemote(image),true);f.store.put('agent',{...f.worker,routeMode:'openai',model:'text-default'});assert.equal(f.host.canDispatchRemote(image),false);f.store.put('agent',{...f.worker,routeMode:'auto',model:''});assert.equal(f.host.canDispatchRemote(image),false);fixture.providers[1].models[0].automatic=true;f.heartbeat(fixture);assert.equal(f.host.canDispatchRemote(image),true);}finally{await f.close();}});

test('remote admission and live readiness reject host account pins instead of silently switching accounts',async()=>{const f=assignmentHostFixture();try{f.heartbeat();f.store.put('agent',{...f.worker,accountId:'default-openai'});await assert.rejects(submit(f,'@Worker: @computer/'+f.computerId+': work'),/pinned/);assert.equal(f.tasks.list().length,0);f.store.put('agent',f.worker);const {receipt}=await submit(f,'@Worker: @computer/'+f.computerId+': work'),task=f.tasks.get(receipt.assignments[0].taskId);assert.equal(f.host.canDispatchRemote(task),true);f.store.put('agent',{...f.worker,accountId:'default-openai'});assert.equal(f.host.canDispatchRemote(task),false);await f.tasks.tick();assert.equal(f.remote.forTask(task.id).length,0);}finally{await f.close();}});
