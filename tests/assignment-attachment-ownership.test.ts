import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {assignmentHostFixture} from './fixtures/assignment-host-fixture.js';
import {png} from './fixtures/attachment-inputs.js';
import type {Message} from '../shared/types.js';
import type {OwnedAttachment} from '../shared/attachments.js';

for(const kind of ['conversation','group','boss'] as const)test(`real ${kind} attachments reach only selected assigned chats with verified owned bytes`,async()=>{
 const f=assignmentHostFixture();try{
  const {source,scope}=f.source(kind),selected=await f.files.createDraft({...scope,name:'selected.png',mimeType:'image/png',base64:png().toString('base64')}),unselected=await f.files.createDraft({...scope,name:'unselected.png',mimeType:'image/png',base64:png().toString('base64')});
  const bytes=f.files.read(scope,selected.id).bytes,request={requestId:randomUUID(),source,content:'@Worker: @Reviewer: inspect selected image',attachmentIds:[selected.id]};
  const result=await f.host.assignments.submit(request);assert.equal(result.assignments.length,2);assert.equal(!!result.message,kind!=='boss');
  const copies=result.assignments.map(assignment=>{
   const task=f.tasks.get(assignment.taskId);assert.equal(task.prompt,'inspect selected image');assert.equal(task.inputMessageIds?.length,1);assert.deepEqual(task.requiredInputModalities,['image']);
   const input=f.store.get<Message>('message',task.inputMessageIds![0])!;assert.equal(input.role,'user');assert.equal(input.content,task.prompt);assert.equal(input.conversationId,task.conversationId);assert.equal(input.attachments?.length,1);
   const file=input.attachments![0],owner={agentId:task.agentId,conversationId:task.conversationId!},read=f.files.read(owner,file.id,input.id);
   assert.deepEqual(read.bytes,bytes);assert.equal(createHash('sha256').update(read.bytes).digest('hex'),selected.sha256);assert.equal(file.id===unselected.id,false);
   const row=f.store.get<OwnedAttachment>('attachment',file.id)!;assert.equal(row.messageId,input.id);assert.equal(row.agentId,task.agentId);assert.equal('draftId'in row,false);assert.equal('roomId'in row,false);
   return {file,input,owner};
  });
  assert.notEqual(copies[0].file.id,copies[1].file.id);
  assert.throws(()=>f.files.read(copies[0].owner,copies[1].file.id,copies[1].input.id),/scope|not found/);
  if(kind==='boss'){
   assert.equal(copies[0].file.id,selected.id);assert.throws(()=>f.files.read(scope,selected.id),/scope|not found/);
   assert.equal(f.store.messages(f.conversation.id).length,0);assert.equal(f.store.groupMessages(f.room.id).length,0);
  }else{
   assert.ok(copies.every(copy=>copy.file.id!==selected.id));assert.deepEqual(f.files.read(scope,selected.id,result.message!.id).bytes,bytes);
   const sourceMessages=kind==='conversation'?f.store.messages(source.id):f.store.groupMessages(source.id);
   assert.equal(sourceMessages.length,1);assert.equal(sourceMessages[0].content,request.content);assert.equal(sourceMessages[0].attachments?.[0].id,selected.id);
  }
  assert.deepEqual(f.files.listDrafts(scope).map(file=>file.id),[unselected.id]);
  const capsule=f.host.assignments.contextForTask(result.assignments[0].taskId)!;assert.deepEqual(capsule.attachments,[{id:selected.id,hash:selected.sha256}]);assert.equal(JSON.stringify(capsule).includes(bytes.toString('base64')),false);
  const counts={tasks:f.store.list('task').length,conversations:f.store.list('conversation').length,files:readdirSync(f.files.root).length};
  assert.deepEqual(await f.host.assignments.submit(request),result);assert.deepEqual({tasks:f.store.list('task').length,conversations:f.store.list('conversation').length,files:readdirSync(f.files.root).length},counts);
 }finally{await f.close();}
});

test('foreign scope and tampered attachment bytes fail before source messages, tasks, or receipts commit',async()=>{
 const f=assignmentHostFixture();try{
  const direct=f.source('conversation'),group=f.source('group'),foreign=await f.files.createDraft({...group.scope,name:'foreign.png',mimeType:'image/png',base64:png().toString('base64')});
  const request={requestId:randomUUID(),source:direct.source,content:'@Worker: inspect this',attachmentIds:[foreign.id]};
  await assert.rejects(f.host.assignments.submit(request),/scope|not found/);assert.equal(f.store.list('task').length,0);assert.equal(f.store.messages(direct.source.id).length,0);assert.equal(f.host.assignments.lookup(request.requestId),undefined);
  const selected=await f.files.createDraft({...direct.scope,name:'changed.png',mimeType:'image/png',base64:png().toString('base64')});writeFileSync(join(f.files.root,selected.id+'.bin'),'changed bytes');
  await assert.rejects(f.host.assignments.submit({...request,requestId:randomUUID(),attachmentIds:[selected.id]}),/changed|integrity/);assert.equal(f.store.list('task').length,0);assert.equal(f.store.messages(direct.source.id).length,0);assert.equal(f.store.get<OwnedAttachment>('attachment',selected.id)?.messageId,null);
 }finally{await f.close();}
});

test('later task admission failure rolls back real source claims, tasks, and request records',async()=>{
 const f=assignmentHostFixture();try{
  const {source,scope}=f.source('group'),selected=await f.files.createDraft({...scope,name:'source.png',mimeType:'image/png',base64:png().toString('base64')}),request={requestId:randomUUID(),source,content:'@Worker: @Reviewer: inspect this',attachmentIds:[selected.id]};
  const conversations=f.store.list('conversation').length;f.state.rejectAgent=f.reviewer.id;
  await assert.rejects(f.host.assignments.submit(request),/admission rejection/);
  assert.equal(f.store.groupMessages(source.id).length,0);assert.equal(f.store.list('task').length,0);assert.equal(f.store.list('chat-assignment').length,0);assert.equal(f.store.list('chat-assignment-capsule').length,0);assert.equal(f.store.list('conversation').length,conversations);assert.equal(f.host.assignments.lookup(request.requestId),undefined);assert.equal(f.files.validateDrafts(scope,[selected.id]).length,1);
  f.state.rejectAgent=undefined;assert.equal((await f.host.assignments.submit(request)).assignments.length,2);
 }finally{await f.close();}
});
