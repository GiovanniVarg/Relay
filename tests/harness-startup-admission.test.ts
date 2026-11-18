import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server/index.js';
import {Store} from '../server/store.js';
import {Tasks} from '../server/tasks.js';
import {ProviderRecovery} from '../server/provider-recovery.js';
import type {Agent,ProviderAdapter,ProviderId,ProviderRequest} from '../shared/types.js';

const flush=async()=>{for(let n=0;n<60;n++)await Promise.resolve();};
test('removing an update hold does not spend a queued task attempt before provider recovery finishes',async t=>{
  const root=await mkdtemp(join(tmpdir(),'relay-startup-admission-')),hold=join(root,'startup.hold'),prior=process.env.RELAY_UPDATE_HOLD;
  const data=join(root,'data'),seeded=new Store(data),original=seeded.list<Agent>('agent')[0];
  const bot=seeded.put<Agent>('agent',{...original,routeMode:'openai',model:'m',mode:'chat',workspace:''});
  seeded.saveBilling('openai',{mode:'included',confirmed:true,automaticRouting:true,allowanceNote:'Fixture'});
  const seedTasks=new Tasks(seeded,{start:async()=>{throw Error('No seed dispatch');},snapshot:()=>undefined,cancel:async()=>{}});
  const task=seedTasks.create({agentId:bot.id,title:'Startup fixture',prompt:'Run only after recovery'});await seedTasks.close();seeded.close();
  await writeFile(hold,'fixture');process.env.RELAY_UPDATE_HOLD=hold;
  let release!:()=>void,recoveryCalls=0,calls=0;const gate=new Promise<void>(done=>release=done);
  t.mock.method(ProviderRecovery.prototype,'recoverAll',async()=>{recoveryCalls++;await gate;});
  t.mock.timers.enable({apis:['setInterval']});
  const adapters=Object.fromEntries(['openai','claude','cursor'].map(id=>[id,{
    id,inspect:async()=>({id,installed:true,authenticated:true,authMode:'subscription',accountLabel:'Fixture',plan:'Fixture',models:[{id:'m',name:'m',verified:false}]}),
    login:async()=>({message:''}),close:async()=>{},stream:async(request:ProviderRequest)=>{
      calls++;await request.appTools!.call('complete','relay_report_task_outcome',{state:'complete',summary:'Fixture complete',remaining:[],evidence:[]});return{text:'Fixture complete'};
    },
  }]))as unknown as Record<ProviderId,ProviderAdapter>;
  const app=createApp({dataDir:data,adapters,port:0});
  try{
    await app.listen(0);await app.tasks.tick();assert.equal(app.tasks.get(task.id).attempt,0);assert.equal(recoveryCalls,0);assert.equal(calls,0);
    await rm(hold);t.mock.timers.tick(500);await flush();assert.equal(recoveryCalls,1);
    await app.tasks.tick();const waiting=app.tasks.get(task.id);
    assert.equal(waiting.status,'queued','startup proof still pending must leave the ticket queued');
    assert.equal(waiting.attempt,0,'waiting for proof cannot consume an attempt');assert.equal(waiting.error,null);assert.equal(calls,0);
    release();await flush();await app.tasks.tick();await Promise.all([...app.runs.active.values()].map(active=>active.promise));await app.tasks.tick();
    const completed=app.tasks.get(task.id);assert.equal(completed.status,'done');assert.equal(completed.attempt,1);assert.equal(calls,1);
    assert.equal(completed.recoveryRequired,false);assert.equal(app.scheduler.listQuarantines().length,0);
  }finally{
    release();await app.close();t.mock.timers.reset();if(prior===undefined)delete process.env.RELAY_UPDATE_HOLD;else process.env.RELAY_UPDATE_HOLD=prior;
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});

test('ordinary startup cannot consume a task attempt while provider proof is still pending',async t=>{
  const root=await mkdtemp(join(tmpdir(),'relay-startup-proof-'));let release!:()=>void,entered!:()=>void,calls=0;
  const gate=new Promise<void>(done=>release=done),checking=new Promise<void>(done=>entered=done);
  t.mock.method(ProviderRecovery.prototype,'recoverAll',async()=>{entered();await gate;});
  const adapters=Object.fromEntries(['openai','claude','cursor'].map(id=>[id,{
    id,inspect:async()=>({id,installed:true,authenticated:true,authMode:'subscription',accountLabel:'Fixture',plan:'Fixture',models:[{id:'m',name:'m',verified:false}]}),
    login:async()=>({message:''}),close:async()=>{},stream:async(request:ProviderRequest)=>{
      calls++;await request.appTools!.call('complete','relay_report_task_outcome',{state:'complete',summary:'Proof fixture complete',remaining:[],evidence:[]});return{text:'Proof fixture complete'};
    },
  }]))as unknown as Record<ProviderId,ProviderAdapter>;
  const app=createApp({dataDir:join(root,'data'),adapters,port:0}),original=app.store.list<Agent>('agent')[0];
  const bot=app.store.put<Agent>('agent',{...original,routeMode:'openai',model:'m',mode:'chat',workspace:''});
  app.store.saveBilling('openai',{mode:'included',confirmed:true,automaticRouting:true,allowanceNote:'Fixture'});
  const task=app.tasks.create({agentId:bot.id,title:'Proof fixture',prompt:'Wait for startup proof'}),listening=app.listen(0);
  try{
    await checking;await app.tasks.tick();const waiting=app.tasks.get(task.id);
    assert.equal(waiting.status,'queued','incomplete startup proof must not turn queued work into a failure');
    assert.equal(waiting.attempt,0);assert.equal(waiting.error,null);assert.equal(calls,0);
    release();await listening;await app.tasks.tick();await Promise.all([...app.runs.active.values()].map(active=>active.promise));await app.tasks.tick();
    const completed=app.tasks.get(task.id);assert.equal(completed.status,'done');assert.equal(completed.attempt,1);assert.equal(calls,1);
  }finally{release();await listening;await app.close();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
