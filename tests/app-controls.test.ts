import {testCredentials} from './synthetic-vault.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store,id,now} from '../server/store.js';
import {AppActions} from '../server/app-actions.js';
import {AppControls,type AppControlServices} from '../server/app-controls.js';
import {Capabilities} from '../server/capabilities.js';
import {McpConnections} from '../server/mcp-connections.js';
import {Knowledge} from '../server/knowledge.js';
import {HttpError} from '../server/security.js';
import type {Agent,Run,ProviderState} from '../shared/types.js';
import {createAppToolSession} from '../server/app-tools-bridge.js';
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'relay-controls-')),store=new Store(dir),actor=store.list<Agent>('agent')[0];
 const runId=id();store.put<Run>('run',{id:runId,agentId:actor.id,conversationId:store.conversations(actor.id)[0].id,messageId:id(),mode:'agent',status:'running',route:null,error:null,startedAt:now(),endedAt:null,usage:null});
 let active=true;
 const provider:ProviderState={id:'openai',installed:true,authenticated:true,authMode:'subscription',accountLabel:'fixture@example.test',plan:'Enterprise',models:[{id:'m',name:'Model',verified:true}],billing:{mode:'unknown',confirmed:false,automaticRouting:false,allowanceNote:''},modelPreferences:{defaultModel:'m',allowedModels:null}};
 const services={dataDirectory:dir,runs:{providers:()=>[provider],refresh:async()=>[provider],activeCount:()=>1},groups:{create:()=>{},accept:()=>{}},activeCount:()=>1} as unknown as AppControlServices;
 services.capabilities=new Capabilities(store);services.mcp=new McpConnections(store,{credentials:testCredentials(store)});services.knowledge=new Knowledge(store);
 const controls=new AppControls(store,services),actions=new AppActions(store,services.groups,async()=>{},controls),scope={runId,agentId:actor.id,signal:new AbortController().signal,isActive:()=>active};
 return {store,actor,provider,scope,services,tools:actions.bind(scope),expire:()=>{active=false;},async close(){store.close();await rm(dir,{recursive:true,force:true});}};
}
test('appearance settings validate exact values for the shared PATCH handler and bounded chat tool and persist',async()=>{
 const f=await fixture();try{
  const controls=new AppControls(f.store,f.services),before=f.store.settings();assert.equal(before.appearance,'system');
  for(const appearance of ['light','dark','system'] as const){
   assert.equal(controls.settings({appearance}).appearance,appearance);
   await f.tools.call('appearance-'+appearance,'relay_app_control',{action:'settings.update',input:{appearance}});
   assert.deepEqual(f.store.settings(),{...before,appearance});
  }
  for(const appearance of ['DARK','unknown',null,4,{},['dark']]){
   assert.throws(()=>controls.settings({appearance}),(e:any)=>e.status===400&&/appearance/.test(e.message));
   await assert.rejects(f.tools.call('invalid-appearance-'+JSON.stringify(appearance),'relay_app_control',{action:'settings.update',input:{appearance}}),/appearance/);
  }
  controls.settings({appearance:'dark'});const reopened=new Store(f.store.dataDir);try{assert.equal(reopened.settings().appearance,'dark');}finally{reopened.close();}
 }finally{await f.close();}
});
test('agent status remains bounded for a full 20000-model catalog and points to complete paged search',async()=>{
 const f=await fixture();try{f.services.tasks={list:()=>[]} as never;f.provider.models=Array.from({length:20000},(_,i)=>({id:'backend/model-'+i,name:'Model '+i,description:'Discovered model metadata',verified:false}));f.provider.modelPreferences.allowedModels=f.provider.models.map(m=>m.id);const session=createAppToolSession(f.tools,new AbortController().signal);try{const result=await session.call('bounded-overview','relay_app_status',{section:'overview'}) as any;assert.ok(Buffer.byteLength(JSON.stringify(result))<64000);assert.equal(result.providers[0].catalog.total,20000);assert.equal(result.providers[0].catalog.searchAction,'provider.models.search');}finally{session.close();}}finally{await f.close();}
});
test('model preference edits accept bounded exact additions/removals without reposting the full selection',async()=>{
 const f=await fixture();try{f.provider.models=Array.from({length:305},(_,i)=>({id:'backend/model-'+i,name:'Model '+i,verified:false}));f.store.saveModelPreferences('openai',{defaultModel:'',allowedModels:[]});const addModels=f.provider.models.slice(0,100).map(m=>m.id);
 await f.tools.call('add-models','relay_app_control',{action:'provider.models',id:'openai',input:{defaultModel:'backend/model-2',addModels,removeModels:[]}});assert.equal(f.store.modelPreferences('openai').allowedModels?.length,100);
 await f.tools.call('remove-models','relay_app_control',{action:'provider.models',id:'openai',input:{defaultModel:'backend/model-2',addModels:[],removeModels:['backend/model-0']}});assert.equal(f.store.modelPreferences('openai').allowedModels?.length,99);
 }finally{await f.close();}
});
test('browser and herdr status failures remain uncertain runtime operations rather than classified store reads',async()=>{const f=await fixture();try{let started=0;f.services.browser={status:async()=>{started++;throw new HttpError(409,'Runtime inspection outcome unknown');}} as never;f.services.herdr={inspect:async()=>{started++;throw new HttpError(409,'Runtime inspection outcome unknown');}} as never;for(const section of['browser','herdr'])await assert.rejects(f.tools.call(section,'relay_app_status',{section,id:f.actor.id}),/outcome unknown/);assert.equal(started,2);const receipts=f.store.list<{status:string;failure?:unknown}>('app-action');assert.equal(receipts.length,2);assert.ok(receipts.every(receipt=>receipt.status==='pending'&&receipt.failure===undefined));}finally{await f.close();}});

test('model schema/runtime exclude takeover/return and model grant changes cannot bypass human ownership',async()=>{
 const f=await fixture();try{let called=0;f.services.browser={isHumanOwned:()=>true,takeover:async()=>{called++;},returnControl:async()=>{called++;},revoke:async()=>{called++;}} as never;
 const definition=f.tools.definitions.find(t=>t.name==='relay_app_control')!;
 assert.equal(JSON.stringify(definition).includes('browser.takeover'),false);assert.equal(JSON.stringify(definition).includes('browser.return'),false);
 for(const action of ['browser.takeover','browser.return'])await assert.rejects(f.tools.call(action,'relay_app_control',{action,id:f.actor.id}),/Unknown|Invalid|action/i);
 for(const enabled of [true,false])await assert.rejects(f.tools.call('grant-'+enabled,'relay_app_control',{action:'browser.grant',id:f.actor.id,input:{enabled}}),/human control/);
 assert.equal(f.services.capabilities.browserGrant(f.actor.id).enabled,false);assert.equal(called,0);
 }finally{await f.close();}
});
test('chat controls mutate bot settings and reuse receipts without duplicate conversations',async()=>{const f=await fixture();try{
 assert.ok(f.tools.definitions.some(t=>t.name==='relay_app_control'));
 await f.tools.call('edit','relay_app_control',{action:'bot.update',id:f.actor.id,input:{role:'Builder',pinned:true,model:'m',routeMode:'openai'}});
 assert.equal(f.store.get<Agent>('agent',f.actor.id)!.role,'Builder');
 const input={action:'conversation.create',id:f.actor.id,input:{title:'From chat'}};
 const first=await f.tools.call('conversation','relay_app_control',input);assert.deepEqual(await f.tools.call('conversation','relay_app_control',input),first);
 assert.equal(f.store.conversations(f.actor.id).filter(c=>c.title==='From chat').length,1);
 await assert.rejects(f.tools.call('edit','relay_app_control',{action:'bot.update',id:f.actor.id,input:{role:'Other'}}),/reused/);
 await assert.rejects(f.tools.call('bad','relay_app_control',{action:'bot.update',id:f.actor.id,input:{billing:true}}),/Unknown/);
 f.expire();await assert.rejects(f.tools.call('late','relay_app_control',{action:'bot.update',id:f.actor.id,input:{role:'No'}}),/active|expired/);
 }finally{await f.close();}});
test('provider controls enforce inspected catalog, account binding, and unknown billing',async()=>{const f=await fixture();try{
 await assert.rejects(f.tools.call('catalog','relay_app_control',{action:'provider.models',id:'openai',input:{defaultModel:'invented',allowedModels:null}}),/catalog/);
 await assert.rejects(f.tools.call('unknown','relay_app_control',{action:'provider.billing',id:'openai',input:{mode:'unknown',confirmed:true,automaticRouting:true,allowanceNote:'',expectedAccount:{accountLabel:f.provider.accountLabel,plan:f.provider.plan}}}),/known billing/);
 await assert.rejects(f.tools.call('stale','relay_app_control',{action:'provider.billing',id:'openai',input:{mode:'included',confirmed:true,automaticRouting:true,allowanceNote:'',expectedAccount:{accountLabel:'other',plan:f.provider.plan}}}),/account changed/);
 await f.tools.call('billing','relay_app_control',{action:'provider.billing',id:'openai',input:{mode:'included',confirmed:true,automaticRouting:true,allowanceNote:'Human stated included',expectedAccount:{accountLabel:f.provider.accountLabel,plan:f.provider.plan}}});
 assert.equal(f.store.billing('openai').confirmed,true);
 }finally{await f.close();}});

test('chat controls cover library, browser grants, memory review, and MCP without leaking credentials',async()=>{const f=await fixture();try{
 const call=(callId:string,action:string,input:Record<string,unknown>={},recordId=f.actor.id)=>f.tools.call(callId,'relay_app_control',{action,id:recordId,input});
 const file=await call('file','library.add',{name:'note.txt',content:'x'.repeat(100000)}) as {id:string};assert.equal(f.store.files(f.actor.id).length,1);
 await assert.rejects(call('foreign-file','library.remove',{fileId:file.id},'another-bot'),/File not found/);
 await call('remove-file','library.remove',{fileId:file.id});assert.equal(f.store.files(f.actor.id).length,0);
 await call('browser','browser.grant',{enabled:true});assert.equal(f.services.capabilities.browserGrant(f.actor.id).enabled,true);
 await assert.rejects(call('browser-type','browser.grant',{enabled:'yes'}),/true or false/);
 const note=f.services.knowledge.propose({agentId:f.actor.id,title:'Preference',content:'Prefer small changes'});
 await call('memory','knowledge.approve',{},note.id);assert.equal(f.services.knowledge.get(note.id).status,'approved');
 const token='MCP_SECRET_NOT_IN_RECEIPT';await assert.rejects(call('mcp-secret','mcp.add',{agentId:f.actor.id,name:'Example',url:'https://example.test/mcp',token}),/Unknown|secure/i);const connection=await call('mcp','mcp.add',{agentId:f.actor.id,name:'Example',url:'https://example.test/mcp',authentication:'none'}) as {id:string};
 assert.equal(JSON.stringify(f.store.list('app-action')).includes(token),false);
 assert.equal(JSON.stringify(await f.tools.call('mcp-status','relay_app_status',{section:'mcp'})).includes(token),false);
 await call('mcp-remove','mcp.remove',{},connection.id);assert.equal(f.services.mcp.list().length,0);
 await assert.rejects(call('proxy','http.request',{url:'http://localhost:3210/api/settings'}),/Unknown/);
 }finally{await f.close();}});
test('read catalog never spills private bot contexts in default roster and cancellation does not self-await',async()=>{const f=await fixture();try{
 f.store.put('agent',{...f.actor,instructions:'PRIVATE_MISSION',memory:'PRIVATE_MEMORY'});
 const roster=await f.tools.call('roster','relay_list_bots',{});assert.equal(JSON.stringify(roster).includes('PRIVATE_'),false);
 let cancelled=false;f.services.runs.cancel=async runId=>{assert.equal(runId,f.scope.runId);cancelled=true;};f.services.delegations={owns:()=>false} as unknown as AppControlServices['delegations'];
 const result=await f.tools.call('stop','relay_app_control',{action:'run.stop',id:f.scope.runId});assert.deepEqual(result,{accepted:true,status:'stop-requested'});
 assert.equal(cancelled,false);await new Promise(done=>setTimeout(done,20));assert.equal(cancelled,true);
 }finally{await f.close();}});
test('provider mutation rechecks authority after asynchronous catalog discovery',async()=>{const f=await fixture();try{
 let release!:()=>void;const gate=new Promise<void>(done=>{release=done;});f.services.runs.refresh=async()=>{await gate;return [f.provider];};
 const pending=f.tools.call('delayed','relay_app_control',{action:'provider.models',id:'openai',input:{defaultModel:'m',allowedModels:['m']}});f.expire();release();await assert.rejects(pending,/active|expired/);
 assert.deepEqual(f.store.modelPreferences('openai').allowedModels,null);
 }finally{await f.close();}});
test('interrupted completion receipts never replay an already performed app mutation',async()=>{const f=await fixture();try{
 const put=f.store.put.bind(f.store);f.store.put=((kind:string,value:any)=>{if(kind==='app-action'&&value.status==='complete')throw Error('receipt unavailable');return put(kind,value);}) as Store['put'];
 const input={action:'conversation.create',id:f.actor.id,input:{title:'Once despite receipt failure'}};
 await assert.rejects(f.tools.call('uncertain','relay_app_control',input),/receipt unavailable/);f.store.put=put;
 assert.equal(f.store.conversations(f.actor.id).filter(c=>c.title==='Once despite receipt failure').length,1);
 const restarted=new AppActions(f.store,f.services.groups,async()=>{},new AppControls(f.store,f.services));
 await assert.rejects(restarted.bind(f.scope).call('uncertain','relay_app_control',input),/unknown|interrupted|replay/);
 assert.equal(f.store.conversations(f.actor.id).filter(c=>c.title==='Once despite receipt failure').length,1);
 }finally{await f.close();}});


test('routing classifier settings have a compatible default and accept only explicit supported selectors through chat',async()=>{const f=await fixture();try{assert.equal(f.store.settings().routingClassifier,'openai');for(const value of['typesafe','rules','openai']){await f.tools.call('setting-'+value,'relay_app_control',{action:'settings.update',input:{routingClassifier:value}});assert.equal(f.store.settings().routingClassifier,value);}for(const value of['unknown',null,1,{},['typesafe']])await assert.rejects(f.tools.call('invalid-'+JSON.stringify(value),'relay_app_control',{action:'settings.update',input:{routingClassifier:value}}),/routingClassifier/);assert.equal(f.store.settings().routingClassifier,'openai');await f.tools.call('persist-typesafe','relay_app_control',{action:'settings.update',input:{routingClassifier:'typesafe'}});const reopened=new Store(f.store.dataDir);try{assert.equal(reopened.settings().routingClassifier,'typesafe');}finally{reopened.close();}}finally{await f.close();}});
