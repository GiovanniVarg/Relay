import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Store} from '../server/store.js';
import {Attachments} from '../server/attachments.js';
import {Tasks} from '../server/tasks.js';
import {Dispatcher,type DispatcherHooks,type DispatcherCandidate} from '../server/dispatcher.js';
import type {Agent,Message} from '../shared/types.js';
import type {TaskInput} from '../shared/tasks.js';
import {png} from './fixtures/attachment-inputs.js';

function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'relay-boss-files-')),store=new Store(dir,{deferRecovery:true});
 const agent=store.createAgent({name:'Worker',role:'Analyze documents'}),files=new Attachments(store);
 let admission=(_agent:Agent,_input:TaskInput)=>{};
 const tasks=new Tasks(store,{admit:(agent,input)=>admission(agent,input),start:async()=>{throw Error('not used');},snapshot:()=>undefined,cancel:async()=>{}});
 const candidate:DispatcherCandidate={agentId:agent.id,name:agent.name,role:agent.role,revision:'v1',capabilities:['tasks']};
 const hooks:DispatcherHooks={candidates:async()=>[candidate],revalidate:()=>true,enabled:()=>false,admitAttachments:()=>{}};
 const dispatcher=new Dispatcher(store,tasks,hooks),draftId=randomUUID(),scope={surface:'dispatcher' as const,draftId};
 return {store,agent,files,tasks,hooks,dispatcher,draftId,scope,onAdmit(fn:typeof admission){admission=fn;},async document(){return files.createDraft({...scope,name:'private-file.txt',mimeType:'text/plain',base64:Buffer.from('PRIVATE DOCUMENT CONTENT').toString('base64')});},async close(){dispatcher.close();await tasks.close();await files.close();store.close();rmSync(dir,{recursive:true,force:true});}};
}
const signal=()=>new AbortController().signal;

test('pre-upgrade accepted text-only submission retries preserve their original hash and receipt without routing again',async()=>{
 for(const explicit of [false,true]){const f=fixture();try{
  const submissionId='legacy-'+explicit,prompt='Original pre-upgrade request',agentId=explicit?f.agent.id:undefined;
  const task=f.tasks.create({agentId:f.agent.id,title:'Dispatched request',prompt});
  // This is the exact pre-attachment hash schema; do not derive it through the current Dispatcher.
  const hash=createHash('sha256').update(JSON.stringify({prompt,agentId:agentId??null})).digest('hex');
  const original={id:submissionId,hash,state:'accepted',taskId:task.id,agentId:f.agent.id,selectionSource:explicit?'explicit':'local'};
  f.store.put('dispatcher-submission',original);
  const before=f.dispatcher.lookup(submissionId);assert.equal(before.state,'accepted');
  f.hooks.candidates=async()=>{throw Error('Accepted legacy submissions must not reroute');};
  const input={submissionId,prompt,...(agentId?{agentId}:{})};
  assert.deepEqual(await f.dispatcher.submit(input,signal()),before);
  assert.deepEqual(await f.dispatcher.submit({...input,attachmentIds:[]},signal()),before);
  for(const changed of [{...input,prompt:'Changed request'},{...input,agentId:explicit?'other-recipient':f.agent.id},{...input,draftId:f.draftId},{...input,draftId:f.draftId,attachmentIds:[randomUUID()]}])await assert.rejects(f.dispatcher.submit(changed,signal()),{status:409});
  assert.equal(f.tasks.list().length,1);assert.equal(f.store.list<Message>('message').length,0);assert.deepEqual(f.store.get('dispatcher-submission',submissionId),original);
 }finally{await f.close();}}
});

test('Boss attachment-only acceptance atomically anchors the original human input and transfers identical IDs once',async()=>{
 const f=fixture();try{
  const item=await f.document(),input={submissionId:'only-file',prompt:'',draftId:f.draftId,attachmentIds:[item.id]};
  const result=await f.dispatcher.submit(input,signal());assert.equal(result.state,'accepted');if(result.state!=='accepted')return;
  const task=f.tasks.get(result.receipt.taskId),messages=f.store.messages(task.conversationId!);assert.equal(messages.length,1);
  assert.equal(messages[0].origin,'human');assert.equal(messages[0].role,'user');assert.equal(messages[0].content,'');assert.deepEqual(messages[0].attachments,[item]);assert.deepEqual(task.inputMessageIds,[messages[0].id]);assert.equal(task.status,'queued');
  assert.equal(f.files.read({agentId:f.agent.id,conversationId:task.conversationId!},item.id,messages[0].id).bytes.toString(),'PRIVATE DOCUMENT CONTENT');
  assert.equal((await f.dispatcher.submit(input,signal())).state,'accepted');assert.equal(f.tasks.list().length,1);assert.equal(f.store.messages(task.conversationId!).length,1);
  assert.doesNotMatch(JSON.stringify(f.store.list('dispatcher-submission')),/PRIVATE|private-file|attachmentIds|draftId/);
 }finally{await f.close();}
});

test('Boss chooser sees bounded modality metadata, retains drafts on ambiguity, and reuses draft scope for explicit retry',async()=>{
 const f=fixture();try{
  const item=await f.document();let chooser:any;
  f.hooks.enabled=()=>true;f.hooks.decide=async(_scope,value)=>{chooser=value;return {answers:{fit:{type:'noul',noul:.1}}} as any;};
  const first=await f.dispatcher.submit({submissionId:'ambiguous',prompt:'Review',draftId:f.draftId,attachmentIds:[item.id]},signal());assert.equal(first.state,'needs-recipient');
  assert.doesNotMatch(JSON.stringify(chooser),/PRIVATE|private-file|extraction|base64|sha256/);assert.deepEqual(chooser.state.attachments,{count:1,items:[{kind:'document',mimeType:'text/plain',size:item.size}]});
  assert.equal(f.files.validateDrafts(f.scope,[item.id]).length,1);assert.equal(f.tasks.list().length,0);
  const result=await f.dispatcher.submit({submissionId:'explicit',prompt:'Review',agentId:f.agent.id,draftId:f.draftId,attachmentIds:[item.id]},signal());assert.equal(result.state,'accepted');assert.equal(f.tasks.list().length,1);
 }finally{await f.close();}
});

test('Boss request keys bind ordered attachment IDs and draft ownership, and foreign batches never partly transfer',async()=>{
 const f=fixture();try{
  const a=await f.document(),b=await f.document(),input={submissionId:'bound',prompt:'Review',draftId:f.draftId,attachmentIds:[a.id,b.id]};
  const result=await f.dispatcher.submit(input,signal());assert.equal(result.state,'accepted');
  await assert.rejects(f.dispatcher.submit({...input,attachmentIds:[b.id,a.id]},signal()),{status:409});
  await assert.rejects(f.dispatcher.submit({...input,draftId:randomUUID()},signal()),{status:409});
  const c=await f.document();await assert.rejects(f.dispatcher.submit({submissionId:'foreign',prompt:'Review',draftId:randomUUID(),attachmentIds:[c.id]},signal()));assert.equal(f.files.validateDrafts(f.scope,[c.id]).length,1);
  await assert.rejects(f.dispatcher.submit({submissionId:'duplicate',prompt:'Review',draftId:f.draftId,attachmentIds:[c.id,c.id]},signal()));assert.equal(f.tasks.list().length,1);
 }finally{await f.close();}
});

test('Boss rejects unsupported image admission without claiming drafts and propagates required modalities to accepted task',async()=>{
 const f=fixture();try{
  const item=await f.files.createDraft({...f.scope,name:'source.png',mimeType:'image/png',base64:png().toString('base64')});
  f.hooks.admitAttachments=undefined;
  await assert.rejects(f.dispatcher.submit({submissionId:'unsupported',prompt:'Inspect',draftId:f.draftId,attachmentIds:[item.id]},signal()));assert.equal(f.files.validateDrafts(f.scope,[item.id]).length,1);assert.equal(f.tasks.list().length,0);
  let admitted=0;f.hooks.admitAttachments=(_candidate,_prompt,requirements)=>{assert.deepEqual(requirements.requiredInputModalities,['image']);admitted++;};
  const result=await f.dispatcher.submit({submissionId:'supported',prompt:'Inspect',draftId:f.draftId,attachmentIds:[item.id]},signal());assert.equal(result.state,'accepted');if(result.state==='accepted')assert.deepEqual(f.tasks.get(result.receipt.taskId).requiredInputModalities,['image']);assert.equal(admitted,2);
 }finally{await f.close();}
});

test('Boss ownership races roll back the human anchor, conversation, task and transfer',async()=>{
 const f=fixture();try{
  const item=await f.document(),before=f.store.conversations(f.agent.id).length;let validations=0;
  f.hooks.revalidate=()=>{if(++validations===2)f.store.put('attachment',{...f.store.get<any>('attachment',item.id),draftId:randomUUID()});return true;};
  await assert.rejects(f.dispatcher.submit({submissionId:'raced',prompt:'Review',draftId:f.draftId,attachmentIds:[item.id]},signal()));assert.equal(f.tasks.list().length,0);assert.equal(f.store.conversations(f.agent.id).length,before);assert.equal(f.store.list<Message>('message').length,0);assert.equal(f.files.validateDrafts(f.scope,[item.id]).length,1);
  // Re-deriving ownership under the write transaction catches changes after chooser preflight.
 }finally{await f.close();}
});

test('Boss task admission rejection after transfer rolls back every ownership and anchor mutation',async()=>{
 const f=fixture();try{
  const item=await f.document(),before=f.store.conversations(f.agent.id).length;
  f.onAdmit(()=>{throw Error('Task policy changed');});
  await assert.rejects(f.dispatcher.submit({submissionId:'admission-race',prompt:'Review',draftId:f.draftId,attachmentIds:[item.id]},signal()));
  assert.equal(f.tasks.list().length,0);assert.equal(f.store.conversations(f.agent.id).length,before);assert.equal(f.store.list<Message>('message').length,0);assert.equal(f.files.validateDrafts(f.scope,[item.id]).length,1);
  f.onAdmit(()=>{});const result=await f.dispatcher.submit({submissionId:'after-rejection',prompt:'Review',draftId:f.draftId,attachmentIds:[item.id]},signal());assert.equal(result.state,'accepted');
 }finally{await f.close();}
});

test('Boss competing submissions cannot claim one draft twice, while aborted selection keeps drafts recoverable',async()=>{
 const f=fixture();try{
  const item=await f.document();let release!:()=>void,entered=0;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  f.hooks.enabled=()=>true;f.hooks.decide=async()=>{entered++;await gate;return {answers:{fit:{type:'noul',noul:.9}}} as any;};
  const input={prompt:'Review',draftId:f.draftId,attachmentIds:[item.id]},first=f.dispatcher.submit({...input,submissionId:'racer-one'},signal()),second=f.dispatcher.submit({...input,submissionId:'racer-two'},signal());
  while(entered<2)await new Promise(resolve=>setImmediate(resolve));release();
  const results=await Promise.allSettled([first,second]);assert.equal(results.filter(result=>result.status==='fulfilled'&&result.value.state==='accepted').length,1);assert.equal(results.filter(result=>result.status==='rejected').length,1);assert.equal(f.tasks.list().length,1);assert.equal(f.store.list<Message>('message').length,1);
  const pending=await f.document(),controller=new AbortController();let resume!:()=>void;
  const hold=new Promise<void>(resolve=>{resume=resolve;});f.hooks.decide=async()=>{await hold;return {answers:{fit:{type:'noul',noul:.9}}} as any;};
  const aborted=f.dispatcher.submit({submissionId:'cancelled-choice',prompt:'Review',draftId:f.draftId,attachmentIds:[pending.id]},controller.signal);await new Promise(resolve=>setImmediate(resolve));controller.abort();resume();await assert.rejects(aborted);assert.equal(f.files.validateDrafts(f.scope,[pending.id]).length,1);assert.equal(f.tasks.list().length,1);
 }finally{await f.close();}
});
