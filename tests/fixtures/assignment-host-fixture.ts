import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {Store,now} from '../../server/store.js';
import {Attachments} from '../../server/attachments.js';
import {Tasks} from '../../server/tasks.js';
import {RemoteJobs} from '../../server/remote-jobs.js';
import {AssignmentHost} from '../../server/assignment-host.js';
import type {Runs} from '../../server/runs.js';
import type {Message,Run} from '../../shared/types.js';
import type {Task,TaskRunSnapshot} from '../../shared/tasks.js';
import type {RemoteInventory} from '../../shared/remote-jobs.js';
import type {AssignmentSource} from '../../shared/chat-assignments.js';
import type {AttachmentScope} from '../../shared/attachments.js';

/** Real SQLite, real protected attachment files, real Tasks/RemoteJobs; only model execution is replaced. */
export function assignmentHostFixture(){
 const dir=mkdtempSync(join(tmpdir(),'relay-assignment-host-')),store=new Store(dir,{deferRecovery:true});
 const origin=store.createAgent({name:'Origin',instructions:'ORIGIN_PRIVATE_POLICY'}),worker=store.createAgent({name:'Worker',instructions:'WORKER_POLICY'}),reviewer=store.createAgent({name:'Reviewer'});
 const conversation=store.conversations(origin.id)[0],room={id:randomUUID(),title:'Assignment source',agentIds:[origin.id,worker.id,reviewer.id],mode:'roundtable' as const,createdAt:now(),updatedAt:now()};store.put('group-room',room);
 const bossId=randomUUID(),computerId=randomUUID(),authorized=new Set<string>([computerId]);let clock=Date.now();
 const state={writable:true,rejectAgent:undefined as string|undefined,refreshes:0,localValidations:[] as {agentId:string;images:boolean}[],localStarts:[] as string[],remoteStarts:[] as string[],guided:[] as {runId:string;content:string}[]};
 const files=new Attachments(store);let host!:AssignmentHost,tasks!:Tasks;
 const remote=new RemoteJobs(store,{authorizeWorker:id=>authorized.has(id),assertWritable(){if(!state.writable)throw Error('Host writes paused');},payload:job=>host.payload(job),reportOutcome:async(taskId,runId,report)=>{await tasks.reportOutcome(taskId,runId,report);},clock:()=>clock,cancelTimeoutMs:1});
 const inventory:RemoteInventory={protocolVersion:1,name:'Render PC',platform:'win32',providers:[{id:'openai',models:[{id:'worker-model',name:'Worker model',available:true,modalities:['text','image']}]}],workspaces:['home'],defaultAgent:{id:'native-worker',provider:'openai',model:'worker-model',ready:true}};
 tasks=new Tasks(store,{
  admit(agent){if(agent.id===state.rejectAgent)throw Error('Synthetic task admission rejection');},
  availableCapacity:task=>!task||!host.assignments.forTask(task.id)?.computerId||host.canDispatchRemote(task),
  start:async task=>{
   const assignment=host.assignments.forTask(task.id);
   if(assignment?.computerId){state.remoteStarts.push(task.id);const accepted=remote.enqueue({taskId:task.id,attempt:task.attempt,agentId:task.agentId,computerId:assignment.computerId,prompt:task.prompt,capsuleId:assignment.capsuleId});return {...accepted,conversationId:task.conversationId!};}
   state.localStarts.push(task.id);const run=makeRun(task);return {runId:run.id,conversationId:run.conversationId};
  },
  snapshot:runId=>{const value=remote.snapshot(runId);if(value)return {...value,pendingInteractions:value.pendingInteractions.length,endedAt:value.endedAt?new Date(value.endedAt).toISOString():undefined} as TaskRunSnapshot;const run=store.get<Run>('run',runId);return run?{status:run.status,text:store.get<Message>('message',run.messageId)?.content,error:run.error}:undefined;},
  cancel:async runId=>{if(remote.ownsRun(runId)){await remote.cancel(runId);return;}const run=store.get<Run>('run',runId);if(run)store.put('run',{...run,status:'cancelled',endedAt:now()});},
 },{clock:()=>clock});
 host=new AssignmentHost(store,tasks,{attachments:files,refresh:async()=>{state.refreshes++;}} as unknown as Runs,remote,{
  assertAvailable(){if(!state.writable)throw Error('Host writes paused');},
  validateLocal(agent,_prompt,requirements){state.localValidations.push({agentId:agent.id,images:requirements.requiredInputModalities?.includes('image')??false});},
  redact:text=>text.replaceAll('SYNTHETIC_SECRET','[redacted]'),
  guide:async(runId,content)=>{state.guided.push({runId,content});return {accepted:true};},
 });
 function makeRun(task:Task){
  const conversationId=task.conversationId??store.createConversation(task.agentId).id,messageId=randomUUID();
  const run:Run={id:randomUUID(),agentId:task.agentId,conversationId,messageId,status:'running',route:null,error:null,startedAt:now(),endedAt:null,usage:null,mode:'chat',inputMessageIds:task.inputMessageIds};
  store.put('run',run);store.put<Message>('message',{id:messageId,conversationId,role:'assistant',content:'',createdAt:now(),status:'streaming',runId:run.id});return run;
 }
 function bind(task:Task){
  const run=makeRun(task),current=store.put('task',{...task,conversationId:run.conversationId,status:'working' as const,attempt:Math.max(1,task.attempt),recoveryRequired:false,runId:null});
  tasks.attachRun(current.id,run,current.attempt);return run;
 }
 function source(kind:AssignmentSource['kind']):{source:AssignmentSource;scope:AttachmentScope}{
  if(kind==='conversation')return {source:{kind,id:conversation.id},scope:{agentId:origin.id,conversationId:conversation.id}};
  if(kind==='group')return {source:{kind,id:room.id},scope:{surface:'group',roomId:room.id}};
  return {source:{kind,id:bossId},scope:{surface:'dispatcher',draftId:bossId}};
 }
 return {dir,store,files,tasks,remote,host,origin,worker,reviewer,conversation,room,bossId,computerId,authorized,inventory,state,source,bind,
  heartbeat(value:RemoteInventory=inventory){remote.heartbeat(computerId,value);},advance(ms:number){clock+=ms;},
  async close(){await tasks.close();await files.close();store.close();rmSync(dir,{recursive:true,force:true});}
 };
}
