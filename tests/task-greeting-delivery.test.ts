import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../server/index.js';
import type {Agent,Message,ProviderAdapter,ProviderId,ProviderEvent,ProviderRequest,Run} from '../shared/types.js';
import {png} from './fixtures/attachment-inputs.js';

async function fixture(toolEvent=false){
 const root=await mkdtemp(join(tmpdir(),'relay-greeting-')),requests:ProviderRequest[]=[];
 const adapters=Object.fromEntries(['openai','claude','cursor'].map(id=>[id,{
  id,inspect:async()=>({id,installed:true,authenticated:true,authMode:'subscription',accountLabel:'Fixture',plan:'Fixture',models:[{id:'m',name:'m',verified:false,inputModalities:['text','image'],inputModalitiesSource:'provider-catalog'}]}),
  login:async()=>({message:''}),close:async()=>{},stream:async(request:ProviderRequest,emit:(event:ProviderEvent)=>void)=>{
   requests.push(request);if(toolEvent)emit({type:'tool',name:'shell',summary:'Synthetic native tool'});return{text:'Yo! What can I help with?'};
  },
 }]))as unknown as Record<ProviderId,ProviderAdapter>;
 const app=createApp({dataDir:join(root,'data'),adapters,port:0});app.store.saveBilling('openai',{mode:'included',confirmed:true,automaticRouting:true,allowanceNote:'Fixture'});await app.runs.refresh();
 const bot=app.store.put<Agent>('agent',{...app.store.list<Agent>('agent')[0],workspace:'',mode:'agent',routeMode:'openai',model:'m'}),conversation=app.store.conversations(bot.id)[0];
 return{app,bot,conversation,requests,async close(){await app.close();await rm(root,{recursive:true,force:true});}};
}

test('actual Agent greeting replies once beside cancelled cart history without continuing old work',async()=>{
 const f=await fixture();try{
  const old=f.app.tasks.create({agentId:f.bot.id,title:'Old cart',prompt:'Add the old laptop to my cart'});await f.app.tasks.cancel(old.id);const oldRecord=structuredClone(f.app.tasks.get(old.id));
  f.app.store.put<Message>('message',{id:'old-cart-message',conversationId:f.conversation.id,role:'user',origin:'human',content:old.prompt,runId:null,status:'complete',createdAt:'2026-01-01T00:00:00.000Z'});
  const accepted=f.app.runs.start(f.bot,f.conversation.id,'yo yo','openai','m','agent'),task=f.app.tasks.forRun(accepted.run.id)!;assert.ok(task,'adoption precedes effects');
  await f.app.runs.active.get(accepted.run.id)!.promise;await f.app.tasks.tick();
  const result=f.app.tasks.get(task.id);assert.equal(result.status,'done');assert.equal(result.outcome?.verification,'unverified');assert.equal(result.runIds.length,1);assert.equal(f.requests.length,1);
  assert.equal(f.app.store.get<Run>('run',accepted.run.id)?.observedToolEvents,0);assert.deepEqual(f.app.tasks.get(old.id),oldRecord);
 }finally{await f.close();}
});

for(const variant of ['action-prefix','native-tool','image','reply','legacy-counter','app-receipt','constraints','scheduled']as const)test(`greeting shortcut rejects ${variant} and preserves unresolved task workflow`,async()=>{
 const f=await fixture(variant==='native-tool');try{
  const prompt=variant==='action-prefix'?'hi rename this bot':'hello!';
  const reply=variant==='reply'?f.app.store.put<Message>('message',{id:'reply-source',conversationId:f.conversation.id,role:'assistant',content:'Old question',runId:null,status:'complete',createdAt:'2026-01-01T00:00:00.000Z'}):undefined;
  const image=variant==='image'?await f.app.runs.attachments.createDraft({agentId:f.bot.id,conversationId:f.conversation.id,name:'input.png',mimeType:'image/png',base64:png().toString('base64')}):undefined;
  let runId:string,taskId:string;
  if(variant==='scheduled'){
   const task=f.app.tasks.create({agentId:f.bot.id,title:'Scheduled greeting',prompt});await f.app.tasks.tick();runId=f.app.tasks.get(task.id).runId!;taskId=task.id;
  }else{
   const accepted=f.app.runs.start(f.bot,f.conversation.id,prompt,'openai','m','agent',undefined,undefined,variant==='constraints'?{requiredCapabilities:{taskReporting:true}}:{},image?[image.id]:[],reply?.id);runId=accepted.run.id;taskId=f.app.tasks.forRun(runId)!.id;
  }
  await f.app.runs.active.get(runId)!.promise;
  if(variant==='legacy-counter'){const run=f.app.store.get<Run>('run',runId)!;delete run.observedToolEvents;f.app.store.put('run',run);}
  if(variant==='app-receipt')f.app.store.put('app-action',{id:'read-receipt',agentId:f.bot.id,runId,name:'relay_app_status',status:'complete'});
  await f.app.tasks.tick();assert.notEqual(f.app.tasks.get(taskId).status,'done');assert.ok(f.app.tasks.get(taskId).runIds.length>=1);
  if(variant==='native-tool')assert.ok((f.app.store.get<Run>('run',runId)?.observedToolEvents??0)>0);
 }finally{await f.close();}
});
