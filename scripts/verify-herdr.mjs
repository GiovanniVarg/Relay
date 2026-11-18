import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { childEnvironment } from '../dist/server/providers/process.js';
import { createApp } from '../dist/server/index.js';
import { HerdrHost } from '../dist/server/herdr/host.js';
import { CodexAdapter } from '../dist/server/providers/codex.js';
const native = process.argv.includes('--native');
const stamp = crypto.randomUUID().slice(0,8);
const root = resolve('.data-herdr-wholeflow', (native ? 'native-' : 'synthetic-') + stamp);
const workspace = native ? await mkdtemp(join(homedir(),'Documents','relay-herdr-native-')) : join(root,'project');
await mkdir(workspace,{recursive:true});
await mkdir(root,{recursive:true});
const input = 'relay-herdr-wholeflow-' + crypto.randomUUID() + '\r\n';
await writeFile(join(workspace,'input.txt'), input);
const session = 'relay-proof-' + stamp;
const liveDir = join(homedir(),'.relay-data');
let actual, catalog, liveProvider;
if(native){
  const boot = await (await fetch('http://127.0.0.1:3210/api/bootstrap')).json();
  liveProvider = boot.providers.find(p=>p.id==='openai');
  assert.equal(liveProvider.billing.mode,'included');
  assert.equal(liveProvider.billing.confirmed,true);
  assert.ok(liveProvider.models.some(m=>m.id==='gpt-6-luna'));
  assert.ok(liveProvider.modelPreferences.allowedModels===null || liveProvider.modelPreferences.allowedModels.includes('gpt-6-luna'));
  actual = new CodexAdapter(liveDir);
  catalog = await actual.inspect();
  assert.equal(catalog.authenticated,true);
  assert.equal(catalog.accountLabel,liveProvider.accountLabel);
  assert.equal(catalog.plan,liveProvider.plan);
}else catalog={id:'openai',installed:true,authenticated:true,authMode:'subscription',accountLabel:'Synthetic owned fixture',plan:'Fixture',models:[]};
const workerModel = native ? 'gpt-6-luna' : 'fixture-worker';
let workers=[];
const ids=['openai','claude','cursor'];
const adapters=Object.fromEntries(ids.map(id=>[id,{
  id,inspect:async()=>({...catalog,id,models:[...catalog.models,{id:'fixture-lead',name:'Deterministic fixture lead',verified:false},...(!native?[{id:workerModel,name:workerModel,verified:false}]:[])]}),
  login:async()=>{throw Error('No sign in permitted during proof')},close:async()=>{},
  stream:async request=>{
    assert.equal(request.model,'fixture-lead');
    assert.equal(request.mode,'chat');
    if(request.conversationId.startsWith('delegation-plan-'))return {actualModel:request.model,text:JSON.stringify({assignments:workers.map((w,i)=>({
      workerId:w.id,
      task:native?'Use the shell in the current directory to run PowerShell: Get-Location; Copy-Item -LiteralPath input.txt -Destination output.txt; Get-Content -LiteralPath output.txt -Raw. Do not access any other directory or network. Execute the tool, then state the result briefly.':i?'Read output-1.txt, copy its exact bytes into output-2.txt, then report your reviewer perspective.':'Copy input.txt exact bytes into output-1.txt, then report your builder perspective.',
      expectedResult:native?'output.txt with input.txt exact bytes, and a successful native command exit.':i?'output-2.txt with matching bytes.':'output-1.txt with matching bytes.',
      dependsOn:i?[workers[0].id]:[]
    }))})};
    assert.ok(request.conversationId.startsWith('delegation-synthesis-'));
    assert.ok(request.history.at(-1).content.includes(workers[0].id));
    return {actualModel:request.model,text:'Owned proof: the lead collected the attributed worker results. Check external artifact assertions for actual execution.'};
  }
}]));
let workerCommand;
if(!native){
  const wrapper=join(root,'fixture-worker.mjs');
  await writeFile(wrapper, "import{runWorker}from"+JSON.stringify(new URL('../dist/server/herdr/worker.js',import.meta.url).href)+";import{killOwned}from"+JSON.stringify(new URL('../dist/server/providers/process.js',import.meta.url).href)+";"+
    "await runWorker(process.argv[2],{createAdapter(provider,dataDir,launcher){let child;return{id:provider,inspect:async()=>{throw Error('No account needed')},login:async()=>{throw Error('No login')},async stream(request,emit,signal){const second=request.history.at(-1).content.includes('output-2.txt');const src=second?'output-1.txt':'input.txt';const out=second?'output-2.txt':'output-1.txt';const code='require(\"node:fs\").copyFileSync('+JSON.stringify(src)+','+JSON.stringify(out)+');';child=launcher({file:process.execPath,args:[]},['-e',code],request.workspace,process.env);const codeExit=await new Promise(done=>child.once('close',done));if(codeExit!==0)throw Error('Owned copy process failed');return{text:(second?'Reviewer':'Builder')+' perspective: exact owned copy complete.',actualModel:request.model}},async close(){if(child)await killOwned(child)}}}});");
  workerCommand=[process.execPath,wrapper];
}
const host=new HerdrHost(root,{session,providerDataDir:native?liveDir:root,...(workerCommand?{workerCommand}:{})});
const app=createApp({port:0,dataDir:join(root,'store'),adapters,herdr:host});
let ended;
try{
  await app.runs.refresh();
  app.store.saveBilling('openai',{...liveProvider?.billing,mode:'included',confirmed:true,automaticRouting:false,allowanceNote:'Owned proof, explicit subscription route only'});
  app.store.saveModelPreferences('openai',{defaultModel:workerModel,allowedModels:[workerModel,'fixture-lead']});
  const lead=app.store.put('agent',{...app.store.createAgent({name:'Proof lead'}),routeMode:'openai',model:'fixture-lead',mode:'chat'});
  workers=Array.from({length:native?1:2},(_,i)=>app.store.put('agent',{...app.store.createAgent({name:i?'Proof reviewer':'Proof builder'}),routeMode:'openai',model:workerModel,mode:native?'agent':'work',workspace,instructions:'Perform only the owned fixture assignment. Keep your individual perspective. Do not access the network or any other directory.'}));
  const room=app.store.createRoom([lead.id,...workers.map(w=>w.id)],'Owned Herdr proof','delegated',lead.id);
  const {run}=app.delegations.accept(room.id,'Complete the owned input/output fixture and gather the worker perspectives.');
  await app.delegations.active.get(run.id)?.promise;
  ended=app.store.get('group-run',run.id);
  assert.equal(ended.status,'complete',JSON.stringify(ended.delegations?.map(d=>({status:d.status,error:d.error}))));
  assert.equal(ended.delegations.length,workers.length);
  assert.ok(ended.delegations.every(d=>d.status==='complete'&&d.executionVerified===false));
  for(const file of native?['output.txt']:['output-1.txt','output-2.txt']) assert.equal(await readFile(join(workspace,file),'utf8'),input);
  assert.equal(app.store.groupMessages(room.id).filter(m=>m.role==='assistant').length,1);
  assert.equal(app.scheduler.activeCount,0);
  if(native)assert.ok(ended.delegations[0].evidence.some(e=>e.includes('status=completed; exit=0')),JSON.stringify(ended.delegations[0].evidence));
  console.log(JSON.stringify({passed:true,kind:native?'included-subscription-native-worker':'two-real-Herdr-synthetic-workers',workers:workers.length,bytesMatched:true,oneLeadReply:true,executionVerifiedClaims:false,model:native?workerModel:'no model inference',root,workspace,session}));
}finally{
  await app.close().catch(()=>{});
  await actual?.close().catch(()=>{});
  const runtime=join(root,'herdr','runtime');
  await promisify(execFile)(resolve('.data-herdr-tools','0.9.5','herdr.exe'),['--session',session,'session','stop',session,'--json'],{windowsHide:true,timeout:5000,env:{...childEnvironment(),HERDR_CONFIG_PATH:join(runtime,'config.toml'),APPDATA:join(runtime,'appdata'),LOCALAPPDATA:join(runtime,'localappdata'),XDG_CONFIG_HOME:join(runtime,'config')}}).catch(()=>{});
  await writeFile(join(root,'proof.json'),JSON.stringify({kind:native?'native':'synthetic',status:ended?.status,workers:ended?.delegations?.map(d=>({status:d.status,evidence:d.evidence,error:d.error})),session,workspace},null,2));
}
