import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createNativeWorkerExecutor,type NativeWorkerApp} from '../server/worker-runtime.js';
import {createApp} from '../server/index.js';
import {requestImages} from '../server/attachment-context.js';
import type {Agent,Message,ProviderAdapter,ProviderId,ProviderRequest} from '../shared/types.js';
import {assignmentHostFixture} from './fixtures/assignment-host-fixture.js';
import {png} from './fixtures/attachment-inputs.js';

type NativeProvider=ReturnType<NativeWorkerApp['runs']['providers']>[number];
test('native inventory keeps the full deduplicated catalog across approved local accounts and pins manual routing locally',async()=>{
 const f=assignmentHostFixture();try{
  const models=Array.from({length:650},(_,index)=>({id:'model-'+index,name:'Model '+index,inputModalities:['text']}));
  const primary:NativeProvider={id:'openai',accountId:'default-openai',authenticated:false,authMode:'subscription',accountLabel:'Synthetic primary',plan:'Synthetic',models:[...models,{id:'shared',name:'Shared',inputModalities:['text']}],billing:{mode:'included',confirmed:true,automaticRouting:true},modelPreferences:{defaultModel:'model-0',allowedModels:null}};
  const sibling:NativeProvider={...primary,accountId:'worker-local-account',authenticated:true,models:[...models,{id:'shared',name:'Shared image model',inputModalities:['image']}],modelPreferences:{defaultModel:'model-649',allowedModels:['model-649','shared']}};
  const approvals:unknown[]=[];
  const app={store:f.store,tasks:f.tasks,runs:{refresh:async()=>{},providers:()=>[primary],accountProviders:()=>[primary,sibling],attachments:f.files,pendingInteractions:()=>[],answerInteraction(){}},appControls:{billing:async(...args:unknown[])=>{approvals.push(args);}}} as unknown as NativeWorkerApp;
  const executor=await createNativeWorkerExecutor(app),inventory=await executor.inventory();assert.equal(inventory.providers[0].models.length,651);assert.ok(inventory.providers[0].models.some(model=>model.id==='model-649'&&model.available));const shared=inventory.providers[0].models.find(model=>model.id==='shared')!;assert.equal(shared.available,true);assert.deepEqual(new Set(shared.modalities),new Set(['text','image']));assert.equal(inventory.defaultAgent?.ready,true);assert.equal(approvals.length,0);
  const execution=await executor.start({instruction:'Exact native instruction',agentProfile:{id:'controller-bot',name:'Controller bot',routeMode:'openai',model:'model-649'}},'native-catalog-job'),task=f.tasks.get(execution.id),agent=f.store.get<Agent>('agent',task.agentId)!;
  assert.equal(agent.accountId,'worker-local-account');assert.equal(agent.workspace,homedir());assert.equal(agent.model,'model-649');assert.equal(f.store.messages(task.conversationId!)[0].content,'Exact native instruction');
  await assert.rejects(executor.start({instruction:'Do not borrow another account',agentProfile:{id:'default-pin',name:'Pinned',routeMode:'openai',model:'model-649',accountId:'default-openai'}},'bad-default-pin'),/unavailable|approved/);
  await assert.rejects(executor.start({instruction:'Do not import a controller account',agentProfile:{id:'foreign-pin',name:'Pinned',routeMode:'openai',model:'model-649',accountId:'controller-extra-account'}},'bad-controller-pin'),/controller account|another computer/);
  assert.equal(f.state.localStarts.length,0);
 }finally{await f.close();}
});

test('actual native executor persists attachment manifests and actual Runs delivers owned image bytes to a synthetic provider',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'relay-native-owned-image-')),seen:ProviderRequest[]=[];
 const adapters=Object.fromEntries(['openai','claude','cursor','opencode'].map(id=>[id,{id,inspect:async()=>({id,installed:true,authenticated:true,authMode:'subscription',accountLabel:'Synthetic worker',plan:'Synthetic',models:[{id:'vision',name:'Synthetic vision',verified:true,inputModalities:['text','image'],inputModalitiesSource:'provider-catalog'}]}),stream:async(request:ProviderRequest)=>{
  if(request.usagePurpose==='outcome-reconciliation')return {text:JSON.stringify({state:'complete',summary:'Synthetic worker inspected the selected image',remaining:[],evidence:[]})};
  seen.push(request);if(request.appTools)await request.appTools.call('native-owned-image-outcome','relay_report_task_outcome',{state:'complete',summary:'Synthetic worker inspected the selected image',remaining:[],evidence:[]});return {text:'Synthetic image result'};
 },login:async()=>({message:''}),close:async()=>{}}])) as unknown as Record<ProviderId,ProviderAdapter>;
 const app=createApp({dataDir:dir,port:0,adapters,taskPollMs:60000});
 try{
  app.store.saveBilling('openai',{mode:'included',confirmed:true,automaticRouting:true,allowanceNote:'Synthetic test only'});await app.runs.refresh();
  const executor=await createNativeWorkerExecutor(app as unknown as NativeWorkerApp),bytes=png(),sha256=createHash('sha256').update(bytes).digest('hex'),instruction='Inspect this exact image\nwithout changing the human instruction';
  const execution=await executor.start({instruction,workspaceAlias:'home',context:{markdown:'Reference only',references:[{id:'source',role:'user',content:'Untrusted source snippet'}]},agentProfile:{id:'source-worker',name:'Remote image worker',routeMode:'openai',model:'vision'},attachments:[{name:'selected.png',mimeType:'image/png',base64:bytes.toString('base64'),sha256}]},'native-image-job');
  const queued=app.tasks.get(execution.id),input=app.store.get<Message>('message',queued.inputMessageIds![0])!;assert.equal(input.content,instruction);assert.equal(input.origin,'human');assert.equal(input.attachments?.length,1);assert.deepEqual(queued.requiredInputModalities,['image']);
  assert.deepEqual(app.runs.attachments.read({agentId:queued.agentId,conversationId:queued.conversationId!},input.attachments![0].id,input.id).bytes,bytes);
  for(let round=0;round<6&&app.tasks.get(queued.id).status!=='done';round++){await app.tasks.tick();await Promise.all([...app.runs.active.values()].map(run=>run.promise));}
  assert.ok(seen.length>0,'The synthetic adapter must actually receive a provider request');const imageRequest=seen.find(request=>requestImages(request).length>0)!;assert.ok(imageRequest,'The native provider request must carry the claimed image');assert.deepEqual(Buffer.from(requestImages(imageRequest)[0].data,'base64'),bytes);
  assert.equal(JSON.stringify(imageRequest.history).includes(bytes.toString('base64')),false);assert.equal(JSON.stringify(app.store.list('message')).includes(bytes.toString('base64')),false);assert.equal(app.tasks.get(queued.id).status,'done');assert.equal((await execution.snapshot()).state,'complete');
 }finally{await app.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
});
