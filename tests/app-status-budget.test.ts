import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store,id,now} from '../server/store.js';
import {AppActions} from '../server/app-actions.js';
import {AppControls,type AppControlServices} from '../server/app-controls.js';
import type {Agent,Message,Run} from '../shared/types.js';
import type {Task} from '../shared/tasks.js';

async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'relay-status-budget-')),store=new Store(dir),actor=store.list<Agent>('agent')[0],other=store.createAgent({name:'Other',instructions:'FOREIGN_MISSION'.repeat(1000)}),conversation=store.conversations(other.id)[0];
 const run:Run={id:id(),agentId:actor.id,conversationId:store.conversations(actor.id)[0].id,messageId:id(),mode:'agent',status:'running',route:null,error:null,startedAt:now(),endedAt:null,usage:null};store.put('run',run);
 const tasks:Task[]=[],services={tasks:{list:(agentId?:string)=>tasks.filter(t=>!agentId||t.agentId===agentId)},runs:{providers:()=>[]}} as unknown as AppControlServices;
 let active=true,calls=0;const tools=new AppActions(store,{} as never,async()=>{},new AppControls(store,services)).bind({runId:run.id,agentId:actor.id,signal:new AbortController().signal,isActive:()=>active});
 return {store,actor,other,conversation,tasks,async status(args:Record<string,unknown>){return await tools.call('status-'+(++calls),'relay_app_status',args) as any;},expire(){active=false;},async close(){store.close();await rm(dir,{recursive:true,force:true});}};
}
function task(agentId:string,index=0):Task{return {id:'task-'+index,agentId,title:'Job '+index,prompt:'PROMPT'.repeat(index===0?200000:10),status:'scheduled',dueAt:now(),repeatMinutes:30,parentTaskId:null,parentAttempt:null,childTaskIds:[],waitingForChildren:false,runId:null,conversationId:null,runIds:[],attempt:0,checkpoint:'CHECKPOINT'.repeat(index===0?100000:10),result:'RESULT'.repeat(index===0?200000:10),error:null,recoveryRequired:false,createdAt:now(),updatedAt:now(),completedAt:null};}
test('global task status is a bounded projection and preserves exact explicit foreign-task reads',async()=>{
 const f=await fixture();try{f.tasks.push(...Array.from({length:30},(_,i)=>task(f.other.id,i)));
 const result=await f.status({section:'tasks'});assert.ok(JSON.stringify(result).length<30000);assert.equal(result.tasks.length,10);assert.equal(result.pages.tasks.total,30);assert.equal(result.tasks[0].dueAt,f.tasks[0].dueAt);assert.equal(JSON.stringify(result).includes('RESULTRESULT'),false);
 const first=await f.status({section:'tasks',recordId:f.tasks[0].id,field:'result'});assert.equal(first.content,f.tasks[0].result.slice(0,12000));assert.equal(first.complete,false);assert.equal(first.total,f.tasks[0].result.length);
 const next=await f.status({section:'tasks',recordId:f.tasks[0].id,field:'result',offset:first.nextOffset,revision:first.revision,hash:first.hash});assert.equal(next.content,f.tasks[0].result.slice(12000,24000));
 await assert.rejects(f.status({section:'tasks',recordId:f.tasks[0].id,field:'result',offset:12000,revision:first.revision,hash:'stale'}),/hash changed/);
 await assert.rejects(f.status({section:'tasks',recordId:f.tasks[0].id,field:'result',offset:12000}),/pins/);
 f.tasks[0].result+='changed';await assert.rejects(f.status({section:'tasks',recordId:f.tasks[0].id,field:'result',offset:12000,revision:first.revision,hash:first.hash}),/changed/);
 await assert.rejects(f.status({section:'tasks',id:f.actor.id,recordId:f.tasks[0].id,field:'result'}),/not found/);
 }finally{await f.close();}
});
test('encoded metadata pages shrink truthfully and exact fields reconstruct without losing control characters',async()=>{
 const f=await fixture();try{f.tasks.push(...Array.from({length:30},(_,i)=>({...task(f.other.id,i+1),title:'\0'.repeat(160),outcome:{state:'blocked' as const,verification:'unverified' as const,summary:'\0'.repeat(100000),remaining:['\0'.repeat(100000)],evidence:[],runId:'r',recordedAt:now()}})));
 const page=await f.status({section:'tasks',limit:20});assert.ok(JSON.stringify(page).length<20000);assert.ok(page.tasks.length>0&&page.tasks.length<20);assert.equal(page.pages.tasks.nextOffset,page.tasks.length);assert.equal(page.pages.tasks.complete,false);assert.equal(page.tasks[0].outcome.summary.characters,100000);
 const original=('A\0😀Z').repeat(5000);f.tasks[0].checkpoint=original;let offset=0,revision:undefined|string,hash:undefined|string,reconstructed='';do{const part=await f.status({section:'tasks',recordId:f.tasks[0].id,field:'checkpoint',offset,...(revision===undefined?{}:{revision,hash})});assert.ok(part.content.length<=12000);reconstructed+=part.content;revision=part.revision;hash=part.hash;if(part.nextOffset===null){assert.equal(part.complete,false);break;}offset=part.nextOffset;}while(true);assert.equal(reconstructed,original);
 }finally{await f.close();}
});
test('bot status contains metadata only and pinned private fields remain explicitly readable',async()=>{
 const f=await fixture();try{f.store.put('agent',{...f.other,memory:'PRIVATE_MEMORY'.repeat(2000)});for(let i=0;i<25;i++)f.store.put('file',{id:'file-'+i,agentId:f.other.id,name:'File '+i,content:'PRIVATE_FILE'.repeat(16000),size:192000,createdAt:now()});
 const result=await f.status({section:'bot',id:f.other.id});assert.ok(JSON.stringify(result).length<30000);assert.equal(JSON.stringify(result).includes('PRIVATE_'),false);assert.equal(JSON.stringify(result).includes('FOREIGN_MISSION'),false);assert.equal(result.files.length,10);assert.equal(result.pages.files.total,25);
 const mission=await f.status({section:'bot',id:f.other.id,field:'instructions'});assert.equal(mission.content,f.other.instructions.slice(0,12000));assert.equal(mission.total,f.other.instructions.length);
 const file=await f.status({section:'bot',id:f.other.id,collection:'files',recordId:'file-0',field:'content'});assert.equal(file.content,'PRIVATE_FILE'.repeat(16000).slice(0,12000));
 await assert.rejects(f.status({section:'bot',id:f.actor.id,collection:'files',recordId:'file-0',field:'content'}),/not found/);
 const page=await f.status({section:'bot',id:f.other.id,collection:'files'});const next=await f.status({section:'bot',id:f.other.id,collection:'files',offset:page.pages.files.nextOffset,revision:page.pages.files.revision});assert.equal(next.files.length,10);assert.equal(next.files[0].id,'file-10');
 await assert.rejects(f.status({section:'bot',id:f.other.id,collection:'files',offset:10,revision:'stale'}),/changed/);
 f.expire();await assert.rejects(f.status({section:'bot',id:f.other.id,field:'memory'}),/expired|active/);
 }finally{await f.close();}
});
test('conversation, group and run defaults bound bodies and nested diagnostics; exact pages retain original authority',async()=>{
 const f=await fixture();try{const huge='HISTORY_BODY'.repeat(9000);for(let i=0;i<24;i++){f.store.put<Message>('message',{id:'message-'+i,conversationId:f.conversation.id,role:'user',content:huge,createdAt:new Date(Date.UTC(2026,0,1,0,0,i)).toISOString(),runId:null,status:'complete'});f.store.put<Run>('run',{id:'foreign-run-'+i,agentId:f.other.id,conversationId:f.conversation.id,messageId:'message-'+i,mode:'agent',status:'complete',route:null,error:huge,startedAt:new Date(Date.UTC(2026,0,1,0,0,i)).toISOString(),endedAt:now(),usage:null,context:{version:1,mode:'reconstructed',characters:1,budget:80000,historyTotal:1,historyIncluded:1,sourceTotal:10000,omittedHistory:0,omittedSources:0,hash:'context',sources:Array.from({length:1000},()=>({id:'source-'+('x'.repeat(100)),kind:'file',start:0,end:1,total:1}))}});}
 const room={id:'room',title:'Room',agentIds:[f.actor.id,f.other.id],createdAt:now(),updatedAt:now()};f.store.put('group-room',room);f.store.put('group-message',{id:'group-message',roomId:room.id,runId:null,role:'user',agentId:null,authorName:'Human',content:huge,createdAt:now(),status:'complete',route:null});
 for(let i=0;i<24;i++)f.store.put('group-message',{id:'recent-group-'+i,roomId:room.id,runId:null,role:'user',agentId:null,authorName:'Human',content:huge,createdAt:new Date(Date.UTC(2027,0,1,0,0,i)).toISOString(),status:'complete',route:null});
 for(const args of [{section:'conversation',id:f.conversation.id},{section:'group',id:room.id},{section:'runs',id:f.other.id}]){const result=await f.status(args);assert.ok(JSON.stringify(result).length<30000);assert.equal(JSON.stringify(result).includes('HISTORY_BODYHISTORY_BODY'),false);}
 const recentConversation=await f.status({section:'conversation',id:f.conversation.id});assert.equal(recentConversation.messages[0].id,'message-23');assert.equal(recentConversation.runs[0].id,'foreign-run-23');assert.equal(recentConversation.messages.length,10);const recentRuns=await f.status({section:'runs',id:f.other.id});assert.equal(recentRuns.runs[0].id,'foreign-run-23');
 const body=await f.status({section:'conversation',id:f.conversation.id,recordId:'message-0',field:'content'});assert.equal(body.content,huge.slice(0,12000));assert.equal(body.total,huge.length);
 const recentGroup=await f.status({section:'group',id:room.id});assert.equal(recentGroup.messages[0].id,'recent-group-23');assert.equal(recentGroup.messages.length,10);
 const group=await f.status({section:'group',id:room.id,recordId:'group-message',field:'content'});assert.equal(group.content,huge.slice(0,12000));
 const run=await f.status({section:'runs',id:f.other.id,recordId:'foreign-run-0',field:'record'});assert.equal(run.content,JSON.stringify(f.store.get('run','foreign-run-0')).slice(0,12000));assert.equal(run.complete,false);
 await assert.rejects(f.status({section:'conversation',id:f.conversation.id,recordId:'group-message',field:'content'}),/not found/);
 }finally{await f.close();}
});
