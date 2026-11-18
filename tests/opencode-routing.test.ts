import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Runs} from '../server/runs.js';
import {Store} from '../server/store.js';
import type {Agent,ProviderAdapter,ProviderConnection,ProviderId,ProviderRequest} from '../shared/types.js';
test('ordinary Relay direct Agent runs preserve OpenCode workspace, native mode and immutable connection scope',async()=>{
 const root=await mkdtemp(join(tmpdir(),'relay-open-route-')),data=join(root,'data'),workspace=join(root,'project');await mkdir(workspace);const store=new Store(data),scope='a'.repeat(64);
 const connection:ProviderConnection={id:'opencode',installed:true,authenticated:true,authMode:'managed',accountLabel:'OpenCode managed profile',plan:'',connectionScope:scope,nativeAgentOnly:true,models:[{id:'local/probe',name:'Probe',local:true,verified:false}]};let received:ProviderRequest|undefined;
 const adapters=Object.fromEntries(['openai','claude','cursor','opencode','gemini','grok'].map(id=>[id,{id,inspect:async()=>id==='opencode'?connection:{id,installed:false,authenticated:false,authMode:'unknown',accountLabel:'',plan:'',models:[]},login:async()=>({message:'fixture'}),close:async()=>{},stream:async(request:ProviderRequest)=>{received=request;assert.equal(request.mode,'agent');assert.equal(request.workspace,await realpath(workspace));assert.equal(request.expectedConnectionScope,scope);return{text:'fixture response',actualModel:request.model};}}])) as unknown as Record<ProviderId,ProviderAdapter>;
 const runs=new Runs(store,adapters);try{store.saveBilling('opencode',{mode:'local',confirmed:true,automaticRouting:false,allowanceNote:'fixture loopback'});store.saveModelPreferences('opencode',{defaultModel:'local/probe',allowedModels:['local/probe']});await runs.refresh();const original=store.list<Agent>('agent')[0],agent={...original,routeMode:'opencode' as const,model:'local/probe',mode:'agent' as const,workspace};store.put('agent',agent);const conversation=store.conversations(agent.id)[0],started=runs.start(agent,conversation.id,'fixture task','opencode','local/probe','agent');await runs.active.get(started.run.id)?.promise;const run=store.get<{status:string;error:string}>('run',started.run.id)!;assert.equal(run.status,'complete',run.error);assert.ok(received);}finally{await runs.close();store.close();await rm(root,{recursive:true,force:true});}
});
