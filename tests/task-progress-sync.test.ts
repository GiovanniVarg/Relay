import test from 'node:test';
import assert from 'node:assert/strict';
import {conversationRefresh,mergeTaskConversation,taskConversationRevision,type ConversationSnapshot} from '../client/task-conversation-sync.js';
import type {Task} from '../shared/tasks.js';

function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const settle=()=>new Promise(done=>setImmediate(done));

test('conversation refresh coalesces host revisions, queues the latest, retries errors and discards disposed replies',async()=>{
 const pending:ReturnType<typeof deferred<string>>[]=[],received:string[]=[],errors:unknown[]=[];
 const feed=conversationRefresh(()=>{const next=deferred<string>();pending.push(next);return next.promise;},value=>received.push(value),error=>errors.push(error));
 feed.refresh('A');for(let i=0;i<100;i++)feed.refresh('B');feed.refresh('C');assert.equal(pending.length,1);
 pending[0].resolve('A');await settle();assert.deepEqual(received,['A']);assert.equal(pending.length,2);
 pending[1].resolve('C');await settle();feed.refresh('C');assert.equal(pending.length,2);
 feed.refresh('D');pending[2].reject(Error('temporary read failure'));await settle();assert.equal(errors.length,1);
 feed.refresh('D');assert.equal(pending.length,4);feed.dispose();pending[3].resolve('late');await settle();feed.refresh('E');assert.equal(pending.length,4);assert.deepEqual(received,['A','C']);
});

const snapshot=(status='running',content='old'):ConversationSnapshot=>({conversation:{id:'chat',agentId:'bot'} as any,runs:[{id:'B',agentId:'bot',conversationId:'chat',messageId:'reply',status,startedAt:'2026-10-26T00:00:00Z'} as any],messages:[{id:'reply',runId:'B',role:'assistant',status:status==='running'?'streaming':'complete',content,createdAt:'2026-10-26T00:00:00Z',conversationId:'chat'}]});

test('late snapshots preserve newer SSE replies and terminal state while adding real questions, replies and completed runs',()=>{
 const current=snapshot('complete','New final from SSE');
 const incoming=snapshot();incoming.runs.push({...incoming.runs[0],id:'C',messageId:'resultC',status:'complete'});
 incoming.messages.push({...incoming.messages[0],id:'question-q',content:'Saved question',status:'complete'},{...incoming.messages[0],id:'human',runId:null,role:'user',content:'Human answer',status:'complete'},{...incoming.messages[0],id:'resultC',runId:'C',content:'Already completed result',status:'complete'});
 const merged=mergeTaskConversation(current,incoming,new Set(['B']));
 assert.equal(merged.runs.find(r=>r.id==='B')?.status,'complete');assert.equal(merged.messages.find(m=>m.id==='reply')?.content,'New final from SSE');
 assert.deepEqual(merged.messages.map(m=>m.id),['reply','question-q','human','resultC']);assert.equal(merged.runs.find(r=>r.id==='C')?.status,'complete');
 const replay=mergeTaskConversation(snapshot('running','A long live reply'),snapshot('running','A long'),new Set());assert.equal(replay.messages[0].content,'A long live reply');
 const terminal=mergeTaskConversation(current,snapshot(),new Set());assert.equal(terminal.runs[0].status,'complete');assert.equal(terminal.messages[0].content,'New final from SSE');
 assert.equal(mergeTaskConversation(snapshot(),snapshot('complete','Host terminal result'),new Set()).messages[0].content,'Host terminal result');
});

test('task identity revisions discover child-result and completed-before-poll runs without depending on model text',()=>{
 const task={id:'task',runId:'A',runIds:['A'],status:'working',updatedAt:'same',waitingForChildren:true} as Task;
 const initial=taskConversationRevision([task]);
 assert.notEqual(initial,taskConversationRevision([{...task,runId:'B',runIds:['A','B'],waitingForChildren:false}]));
 assert.notEqual(initial,taskConversationRevision([{...task,status:'done'}]));
 assert.equal(initial,taskConversationRevision([{...task,result:'Model text has no authority to create a run'}]));
});
