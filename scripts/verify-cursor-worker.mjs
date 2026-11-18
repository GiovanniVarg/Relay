// Explicit opt-in: one Cursor subscription call through an isolated Relay/Herdr team.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from '../dist/server/index.js';
import { HerdrHost, processGone } from '../dist/server/herdr/host.js';
import { CursorAdapter } from '../dist/server/providers/cursor.js';
import { childEnvironment, safeError } from '../dist/server/providers/process.js';
import { lowModel, permitted, enabledModels, dynamicAutoModel } from '../dist/server/router.js';
if(!process.argv.includes('--live'))throw Error('Pass --live to authorize one Cursor subscription worker acceptance call.');
const boot=await(await fetch('http://127.0.0.1:3210/api/bootstrap')).json();
const provider=boot.providers.find(p=>p.id==='cursor');
assert.ok(provider && permitted(provider,false),'Cursor must already be connected with confirmed billing.');
const model=lowModel(provider);
assert.ok(model && enabledModels(provider).some(m=>m.id===model&&!dynamicAutoModel(m)),'Select an enabled specific Cursor model first.');
const stamp=randomUUID().slice(0,8), root=resolve('.data-herdr-cursor','live-'+stamp);
await mkdir(root,{recursive:true});
const liveDataDir=join(homedir(),'.relay-data');
const inspector=new CursorAdapter(liveDataDir);
const connection=await inspector.inspect();
assert.equal(connection.authenticated,true);
assert.equal(connection.accountLabel,provider.accountLabel);
assert.equal(connection.plan,provider.plan);
assert.ok(connection.models.some(m=>m.id===model));
const session='relay-cursor-'+stamp, marker='RELAY_CURSOR_WORKER_'+stamp;
const runtimeOptions={session,providerDataDir:liveDataDir};
const host=new HerdrHost(root,runtimeOptions);
let workerId, leadCalls=0;
const adapters=Object.fromEntries(['openai','claude','cursor'].map(id=>[id,{
  id,inspect:async()=>id==='cursor'?{...connection,models:[...connection.models,{id:'fixture-lead',name:'Deterministic lead',verified:false}]}:
    {id,installed:false,authenticated:false,authMode:'unknown',accountLabel:'',plan:'',models:[]},
  login:async()=>{throw Error('Acceptance never changes sign-in')},close:async()=>{},
  stream:async request=>{
    assert.equal(id,'cursor');assert.equal(request.model,'fixture-lead');assert.equal(request.mode,'chat');leadCalls++;
    if(request.conversationId.startsWith('delegation-plan-'))return {text:JSON.stringify({assignments:[{workerId,task:'Reply with exactly the verification code in your configured bot guidance and nothing else. No tools or external access.',expectedResult:'The exact code from the worker bot guidance',dependsOn:[]}]})};
    assert.ok(request.conversationId.startsWith('delegation-synthesis-'));
    assert.ok(request.history.at(-1).content.includes(marker));
    return {text:'Collected Cursor worker result: '+marker};
  }
}]));
const app=createApp({port:0,dataDir:join(root,'store'),adapters,herdr:host});
let summary={passed:false,model,session};
try{
  await app.runs.refresh();
  app.store.saveBilling('cursor',{...provider.billing,automaticRouting:false});
  app.store.saveModelPreferences('cursor',{defaultModel:model,allowedModels:[model,'fixture-lead']});
  const lead=app.store.put('agent',{...app.store.createAgent({name:'Owned fixture lead'}),routeMode:'cursor',model:'fixture-lead',mode:'chat'});
  const worker=app.store.put('agent',{...app.store.createAgent({name:'Cursor reviewer'}),routeMode:'cursor',model,mode:'chat',instructions:'Your private verification code is '+marker+'. When asked for that code, return exactly the code and nothing else. No tools.'});
  workerId=worker.id;
  const room=app.store.createRoom([lead.id,worker.id],'Owned Cursor delegation acceptance','delegated',lead.id);
  const {run}=app.delegations.accept(room.id,'Collect one Cursor worker response for this owned acceptance fixture.');
  await app.delegations.active.get(run.id)?.promise;
  const ended=app.store.get('group-run',run.id);
  assert.equal(ended.status,'complete',JSON.stringify(ended.delegations?.map(d=>({status:d.status,error:d.error}))));
  assert.equal(leadCalls,2);
  assert.equal(ended.delegations.length,1);
  const task=ended.delegations[0];
  assert.equal(task.route.provider,'cursor');assert.equal(task.route.model,model);assert.equal(task.mode,'chat');
  assert.equal(task.result.trim(),marker);assert.equal(task.executionVerified,false);
  assert.equal(app.store.groupMessages(room.id).filter(m=>m.role==='assistant').length,1);
  assert.equal(app.store.get('verified','cursor:'+model),undefined);
  assert.equal(app.scheduler.activeCount,0);
  const receiptPath=join(root,'herdr','jobs',createHash('sha256').update(task.id).digest('hex'),'receipt.json');
  const receipt=JSON.parse(await readFile(receiptPath,'utf8'));
  assert.equal(receipt.status,'complete');assert.ok(receipt.pids.length>=2);
  assert.ok(receipt.pids.every(processGone),'An owned Cursor/guard process remained alive after completion');
  assert.equal(receipt.outcome.result.actualModel,undefined);
  assert.equal((await host.reconcile(task.id)).stopped,true);
  summary={passed:true,provider:'cursor',selectedModel:model,serverModelVerified:false,resultMarkerMatched:true,oneLeadReply:true,leadWasDeterministic:true,allOwnedProcessesGone:true,ownedProcessCount:receipt.pids.length,subscriptionCalls:1,billingMode:provider.billing.mode,root,session};
  console.log(JSON.stringify(summary));
}catch(error){
  summary={...summary,error:safeError(error)};throw error;
}finally{
  await app.close().catch(()=>{});await inspector.close().catch(()=>{});
  const runtime=join(root,'herdr','runtime');
  await promisify(execFile)(resolve('.data-herdr-tools','0.9.5','herdr.exe'),['--session',session,'session','stop',session,'--json'],{windowsHide:true,timeout:5000,env:{...childEnvironment(),HERDR_CONFIG_PATH:join(runtime,'config.toml'),APPDATA:join(runtime,'appdata'),LOCALAPPDATA:join(runtime,'localappdata'),XDG_CONFIG_HOME:join(runtime,'config')}}).catch(()=>{});
  await writeFile(join(root,'proof.json'),JSON.stringify(summary,null,2));
}
