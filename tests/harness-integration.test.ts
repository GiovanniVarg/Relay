import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../server/index.js';
import {AgentToolkit} from '../server/agent-toolkit.js';
import {Store,id,now} from '../server/store.js';
import {AppActions} from '../server/app-actions.js';
import {Tasks} from '../server/tasks.js';
import {Knowledge} from '../server/knowledge.js';
import {HarnessUpdates} from '../server/harness-updates.js';
import {ProviderRecovery} from '../server/provider-recovery.js';
import {SyntheticVault} from './synthetic-vault.js';
import type {Agent,Run,ProviderAdapter,ProviderId} from '../shared/types.js';
function adapters(onCall=()=>{}){return Object.fromEntries(['openai','claude','cursor'].map(id=>[id,{id,inspect:async()=>({id,installed:false,authenticated:false,authMode:'unknown',accountLabel:'',plan:'',models:[]}),login:async()=>({message:''}),close:async()=>{},stream:async()=>{onCall();throw Error('No inference in this fixture');}}])) as unknown as Record<ProviderId,ProviderAdapter>;}
test('harness HTTP requires local session/CSRF, edits with optimistic hashes and exposes no arbitrary commands',async()=>{
 const root=await mkdtemp(join(tmpdir(),'relay-self-http-')),install=join(root,'install');await mkdir(join(install,'client'),{recursive:true});await writeFile(join(install,'package.json'),'{"name":"fixture"}');await writeFile(join(install,'client','App.tsx'),'export const label="before";');
 const app=createApp({dataDir:join(root,'data'),installDirectory:install,harnessWorkspacesDirectory:join(root,'drafts'),adapters:adapters(),port:0});const port=await app.listen(0),base=`http://127.0.0.1:${port}`;
 try{
  assert.equal((await fetch(base+'/api/harness')).status,401);const response=await fetch(base+'/api/bootstrap'),boot=await response.json(),cookie=response.headers.get('set-cookie')!.split(';')[0];
  const request=(path:string,method='GET',body?:unknown,csrf=true)=>fetch(base+'/api/harness'+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json',...(csrf?{'X-CSRF-Token':boot.csrfToken}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  assert.equal((await request('','POST',{title:'Fixture'},false)).status,403);
  const created=await request('','POST',{title:'Improve the label'});assert.equal(created.status,201);const draft=await created.json();
  const file=await (await request('/'+draft.id+'/file?path=client%2FApp.tsx')).json();
  assert.equal((await request('/'+draft.id+'/file','PUT',{path:'client/App.tsx',content:'export const label="after";',expectedHash:file.hash})).status,200);
  assert.equal((await request('/'+draft.id+'/file','PUT',{path:'client/App.tsx',content:'stale',expectedHash:file.hash})).status,409);
  assert.equal((await request('/'+draft.id+'/file','PUT',{path:'../data/relay.sqlite',content:'no',expectedHash:null})).status,400);
  const diff=await (await request('/'+draft.id+'/diff')).json();assert.equal(diff.length,1);assert.match(diff[0].before,/before/);assert.match(diff[0].after,/after/);
  assert.equal((await request('/'+draft.id+'/check','POST',{})).status,400);
  assert.equal((await request('/'+draft.id+'/check','POST',{revision:draft.revision})).status,409);
  assert.equal((await request('/'+draft.id+'/shell','POST',{command:'anything'})).status,400);
  assert.equal((await request('/'+draft.id+'/apply','POST',{revision:draft.revision})).status,409);
 }finally{await app.close();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
test('startup hold blocks direct/group/provider dispatch and durable task capacity until verification',async()=>{
 const root=await mkdtemp(join(tmpdir(),'relay-self-hold-')),hold=join(root,'startup.hold'),previous=process.env.RELAY_UPDATE_HOLD;let calls=0;
 // Seed the existing installation before the candidate hold: held bootstrap must not create fixture records.
 const seeded=new Store(join(root,'data')),bots=seeded.list<Agent>('agent'),conversation=seeded.conversations(bots[0].id)[0],room=seeded.createRoom(bots.slice(0,2).map(a=>a.id),'Existing team');
 const seedTasks=new Tasks(seeded,{start:async()=>{throw Error('No seed dispatch');},snapshot:()=>undefined,cancel:async()=>{}}),task=seedTasks.create({agentId:bots[0].id,title:'Wait',prompt:'No execution before verification'});
 const rows=(store:Store)=>store.db.prepare('SELECT kind,id,data FROM records ORDER BY kind,id').all(),before=rows(seeded);await seedTasks.close();seeded.close();
 await writeFile(hold,'fixture');process.env.RELAY_UPDATE_HOLD=hold;
 const app=createApp({dataDir:join(root,'data'),adapters:adapters(()=>calls++),port:0});
 try{assert.deepEqual(rows(app.store),before);const port=await app.listen(0),base=`http://127.0.0.1:${port}`,health=await (await fetch(base+'/api/health')).json();assert.equal(health.updateHeld,true);const bootstrap=await fetch(base+'/api/bootstrap'),boot=await bootstrap.json(),cookie=bootstrap.headers.get('set-cookie')!.split(';')[0];const mutation=await fetch(base+'/api/settings',{method:'PATCH',headers:{Cookie:cookie,'X-CSRF-Token':boot.csrfToken,'Content-Type':'application/json'},body:JSON.stringify({maxRunSeconds:30})});assert.equal(mutation.status,503);
  assert.throws(()=>app.runs.start(bots[0],conversation.id,'No','auto','','agent'),/applying an update/);
  assert.throws(()=>app.groups.accept(room.id,'No'),/applying an update/);
  await assert.rejects(()=>app.runs.call('openai',{}as never,()=>{},new AbortController().signal,false),/applying an update/);
  await assert.rejects(()=>app.dispatcher.submit({submissionId:'held',prompt:'No',agentId:bots[0].id},new AbortController().signal),/applying an update/);
  await app.runs.refresh();await app.tasks.tick();assert.equal(app.tasks.get(task.id).status,'queued');assert.equal(app.tasks.get(task.id).attempt,0);assert.equal(app.runs.activeCount(),0);assert.equal(calls,0);assert.deepEqual(rows(app.store),before,'held construction, bootstrap, inspection and blocked dispatch must preserve every existing record exactly');
  await rm(hold);for(let i=0;i<200&&app.tasks.get(task.id).status==='queued';i++){await app.tasks.tick();await new Promise(done=>setTimeout(done,5));}
  const released=app.tasks.get(task.id);assert.equal(released.status,'needs_input');assert.equal(released.attempt,1);assert.equal(released.recoveryRequired,true);assert.equal(released.runId,null);assert.match(released.error!,/subscription|authenticated|connected|eligible|billing/i);assert.equal(calls,0);assert.equal((await (await fetch(base+'/api/health')).json()).updateHeld,false);
 }finally{await app.close();if(previous===undefined)delete process.env.RELAY_UPDATE_HOLD;else process.env.RELAY_UPDATE_HOLD=previous;await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
test('unheld startup keeps direct/group/provider/dispatcher admission fenced until recovery completes',async t=>{
 const root=await mkdtemp(join(tmpdir(),'relay-recovery-admission-'));let release!:()=>void,entered!:()=>void,calls=0;
 const gate=new Promise<void>(done=>release=done),inside=new Promise<void>(done=>entered=done);
 t.mock.method(ProviderRecovery.prototype,'recoverAll',async()=>{entered();await gate;});
 const app=createApp({dataDir:join(root,'data'),adapters:adapters(()=>calls++),secretVault:new SyntheticVault(),port:0});
 const listening=app.listen(0);
 try{
  await inside;assert.equal(app.updates.held(),false);
  const bots=app.store.list<Agent>('agent'),conversation=app.store.conversations(bots[0].id)[0],room=app.store.createRoom(bots.slice(0,2).map(a=>a.id),'Recovery fixture');
  const task=app.tasks.create({agentId:bots[0].id,title:'Wait for recovery',prompt:'No premature dispatch'});
  const before=app.store.db.prepare('SELECT kind,id,data FROM records ORDER BY kind,id').all();
  assert.throws(()=>app.runs.start(bots[0],conversation.id,'No','auto','','agent'),/Provider cleanup recovery is still checking/);
  assert.throws(()=>app.groups.accept(room.id,'No'),/Provider cleanup recovery is still checking/);
  await assert.rejects(()=>app.runs.call('openai',{}as never,()=>{},new AbortController().signal,false),/Provider cleanup recovery is still checking/);
  await assert.rejects(()=>app.dispatcher.submit({submissionId:'recovering',prompt:'No',agentId:bots[0].id},new AbortController().signal),/Provider cleanup recovery is still checking/);
  assert.equal(app.tasks.get(task.id).attempt,0);assert.equal(app.runs.activeCount(),0);assert.equal(calls,0);
  assert.deepEqual(app.store.db.prepare('SELECT kind,id,data FROM records ORDER BY kind,id').all(),before);
 }finally{release();await listening;await app.close();await rm(root,{recursive:true,force:true,maxRetries:5});}
});
test('startup admission stays fenced while guarded credential initialization has only partial redaction state',async()=>{
 const root=await mkdtemp(join(tmpdir(),'relay-credential-admission-')),dataDir=join(root,'data'),vault=new SyntheticVault();let release!:()=>void,entered!:()=>void,calls=0,writing='';
 const tokens=['synthetic-first-startup-secret','synthetic-later-startup-secret'];
 const seeded=new Store(dataDir);tokens.forEach((token,index)=>seeded.put('mcp-connection',{id:'legacy-'+index,token,hasToken:true}));seeded.close();
 const gate=new Promise<void>(done=>release=done),inside=new Promise<void>(done=>entered=done),set=vault.set.bind(vault);
 vault.set=async(...args)=>{if(!writing){writing=args[1];entered();await gate;}await set(...args);};
 const app=createApp({dataDir,adapters:adapters(()=>calls++),secretVault:vault,port:0}),listening=app.listen(0);
 try{
  await inside;assert.equal(app.updates.held(),false);
  const unknown=tokens.find(token=>token!==writing)!;assert.equal(app.credentials.secrets.redact(unknown),unknown,'the fixture must pause before the remaining secret is learned');
  const bots=app.store.list<Agent>('agent'),conversation=app.store.conversations(bots[0].id)[0],before=app.store.db.prepare('SELECT kind,id,data FROM records ORDER BY kind,id').all();
  assert.throws(()=>app.runs.start(bots[0],conversation.id,'No','auto','','agent'),error=>error instanceof Error&&'status' in error&&error.status===503&&/Provider cleanup recovery is still checking/.test(error.message));
  await assert.rejects(()=>app.dispatcher.submit({submissionId:'credentials-pending',prompt:'No',agentId:bots[0].id},new AbortController().signal),error=>error instanceof Error&&'status' in error&&error.status===503&&/Provider cleanup recovery is still checking/.test(error.message));
  assert.equal(app.runs.activeCount(),0);assert.equal(app.tasks.list().length,0);assert.equal(calls,0);assert.deepEqual(app.store.db.prepare('SELECT kind,id,data FROM records ORDER BY kind,id').all(),before);
  release();await listening;for(const token of tokens)assert.equal(app.credentials.secrets.redact(token),'[redacted]');
 }finally{release();await listening;await app.close();await rm(root,{recursive:true,force:true,maxRetries:5});}
});
async function toolkitFixture(automatic=false){
 const dir=await mkdtemp(join(tmpdir(),'relay-self-tools-')),store=new Store(dir),agent=store.list<Agent>('agent')[0],runId=id(),conversationId=store.conversations(agent.id)[0].id;
 store.put<Run>('run',{id:runId,agentId:agent.id,conversationId,messageId:id(),mode:'agent',status:'running',route:null,error:null,startedAt:now(),endedAt:null,usage:null});
 const tasks=new Tasks(store,{start:async()=>{throw Error('No dispatch');},snapshot:()=>({status:'running'}),cancel:async()=>{}}),actions=new AppActions(store,{}as never);let active=true,revision='one',checks=0,approvals=0,release!:(value:{decision:'allow'|'deny'})=>void;
 const approval=new Promise<{decision:'allow'|'deny'}>(done=>release=done),controller=new AbortController();
 let applied=0,grant=false,browserCalls=0;
 const harness={changes:{inspect:async()=>({available:true}),list:async()=>[],listPage:async()=>({changes:[],offset:0,limit:10,total:0,nextOffset:null}),get:async()=>({title:'Fixture',revision,checkedRevision:checks?revision:null,status:checks?'ready':'draft',workspaceDirectory:dir}),diff:async()=>[{path:'client/App.tsx',before:'before',after:'after'}],check:async(_id:string,options:{expectedRevision:string})=>{checks++;assert.equal(options.expectedRevision,revision);return{revision,status:'ready'};}},initialize:async()=>{},assertAvailable:()=>{},updates:{status:async()=>({status:'complete',changeId:'previous'}),requestApply:async(changeId:string,value:string,request:{runId:string;agentId:string;requestKey:string})=>{assert.equal(checks,1);assert.equal(value,revision);assert.equal(request.runId,runId);assert.equal(request.agentId,agent.id);assert.equal(request.requestKey,runId+':apply');applied++;return{changeId,revision,status:'queued'};},revert:async()=>({id:'revert-draft'})},ensureBrowserGrant:(owner:string)=>{assert.equal(owner,agent.id);grant=true;}};
 const browser={read:async(owner:string)=>{assert.equal(owner,agent.id);assert.equal(grant,true);browserCalls++;return {url:'https://fixture.invalid'};},open:async(owner:string)=>{assert.equal(owner,agent.id);assert.equal(grant,true);browserCalls++;return{url:'https://fixture.invalid'};}};
 const toolkit=new AgentToolkit(store,actions,tasks,new Knowledge(store),browser as never,{}as never,undefined,harness as never),bound=toolkit.bind({runId,agentId:agent.id,conversationId,signal:controller.signal,isActive:()=>active,confirm:async()=>{approvals++;return automatic?{decision:'allow'}:approval;},interact:async()=>{approvals++;return automatic?{decision:'allow'}:approval;}});
 return{bound,release,edit(){revision='two';},expire(){active=false;},get checks(){return checks;},get applied(){return applied;},get browserCalls(){return browserCalls;},get approvals(){return approvals;},async close(){await tasks.close();store.close();await rm(dir,{recursive:true,force:true});}};
}
test('manual approval callbacks still bind checks to the exact revision',async()=>{const f=await toolkitFixture();try{assert.equal(f.bound.definitions.some(t=>t.name==='relay_apply_change'),true);const pending=f.bound.call('changed-approval','relay_check_change',{changeId:'draft'});await new Promise(done=>setTimeout(done,20));f.edit();f.release({decision:'allow'});await assert.rejects(pending,/changed while approval/);assert.equal(f.checks,0);}finally{await f.close();}});
test('Agent tools check and queue requested activation entirely in the conversation',async()=>{const f=await toolkitFixture(true);try{const checked=await f.bound.call('check','relay_check_change',{changeId:'draft'})as{revision:string};const result=await f.bound.call('apply','relay_apply_change',{changeId:'draft',revision:checked.revision});assert.equal((result as{status:string}).status,'queued');assert.deepEqual(await f.bound.call('apply','relay_apply_change',{changeId:'draft',revision:checked.revision}),result);assert.equal(f.applied,1);assert.deepEqual(await f.bound.call('revert','relay_revert_change',{changeId:'previous'}),{id:'revert-draft'});const status=await f.bound.call('status','relay_harness_status',{})as{activation:{status:string}};assert.equal(status.activation.status,'complete');}finally{await f.close();}});

test('requested Agent browser tools enable only their own bot grant before guarded access',async()=>{const f=await toolkitFixture(true);try{await f.bound.call('read','relay_browser_read',{});await f.bound.call('open','relay_browser_open',{url:'https://fixture.invalid'});assert.equal(f.browserCalls,2);}finally{await f.close();}});

test('bot duplicate check calls share a single approval and execution',async()=>{const f=await toolkitFixture();try{const first=f.bound.call('once','relay_check_change',{changeId:'draft'}),second=f.bound.call('once','relay_check_change',{changeId:'draft'});await new Promise(done=>setTimeout(done,20));f.release({decision:'allow'});assert.deepEqual(await first,await second);assert.equal(f.checks,1);assert.equal(f.approvals,1);}finally{await f.close();}});
test('expired bot cannot execute an approved check',async()=>{const f=await toolkitFixture();try{const pending=f.bound.call('expired','relay_check_change',{changeId:'draft'});await new Promise(done=>setTimeout(done,20));f.expire();f.release({decision:'allow'});await assert.rejects(pending,/authority expired/);assert.equal(f.checks,0);}finally{await f.close();}});
test('updater preflight failure leaves the running process available and never requests shutdown',async()=>{
 const root=await mkdtemp(join(tmpdir(),'relay-preflight-')),install=join(root,'install'),snapshot=join(root,'snapshot');await mkdir(join(install,'scripts'),{recursive:true});await mkdir(snapshot);const {copyFile}=await import('node:fs/promises');await copyFile(join(process.cwd(),'scripts','activate-relay.mjs'),join(install,'scripts','activate-relay.mjs'));let restarts=0;
 const changes={get:async()=>({revision:'fixture'}),prepareApply:async()=>({revision:'fixture',snapshotDirectory:snapshot,sourceFiles:[{path:'package.json',hash:'invalid',size:0}],baseFiles:[],distFiles:[],dependencyFiles:[]})};
 const updates=new HarnessUpdates(changes as never,{installDirectory:install,dataDirectory:join(root,'data'),activeCount:()=>0,port:()=>3210,restart:async()=>{restarts++;}});
 try{await assert.rejects(updates.apply('fixture-change','fixture'),/preflight failed/);assert.equal(restarts,0);assert.equal(updates.held(),false);assert.equal((await updates.status())?.status,'failed');assert.doesNotThrow(()=>updates.assertAvailable());}finally{updates.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
