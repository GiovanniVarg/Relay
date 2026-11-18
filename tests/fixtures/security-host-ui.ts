import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium,type Browser} from 'playwright';
import {createApp} from '../../server/index.js';
import {PROVIDER_IDS} from '../../server/store.js';
import {SyntheticVault} from '../synthetic-vault.js';
import type {Agent,ProviderAdapter,ProviderId,ProviderRequest} from '../../shared/types.js';

/** Actual compiled App/HTTP/Tasks, usable against the separately compiled security fallback. */
export async function securityHostUi(kind:'mcp'|'telegram'|'workspace'|'discussion',factory=createApp,clientDir=resolve('dist/client')){
 const root=await mkdtemp(join(tmpdir(),'relay-security-ui-')),workspace=join(root,'project');await mkdir(workspace);
 const vault=new SyntheticVault(),calls:ProviderRequest[]=[],requests:{path:string;body:string}[]=[],key=kind==='telegram'?'123456789:SYNTHETIC_RECEIVER_CREDENTIAL_873647':'SYNTHETIC_SECURE_CREDENTIAL_8791',prompt='Synthetic canonical secure setup';let agentId='';
 const adapters=Object.fromEntries(PROVIDER_IDS.map(id=>[id,{
  id,inspect:async()=>({id,installed:true,authenticated:true,authMode:'subscription',accountLabel:'Synthetic',plan:'Synthetic',models:[{id:'fixture-model',name:'Synthetic',verified:false}]}),login:async()=>({message:'Synthetic'}),close:async()=>{},
  stream:async(request:ProviderRequest)=>{calls.push(request);if(kind==='workspace'||kind==='discussion')await request.appTools!.call('connect','relay_typesafe_connect',{});else await request.appTools!.call('connect','relay_app_control',kind==='mcp'?{action:'mcp.add',input:{agentId,name:'  Synthetic receiver  ',url:'https://EXAMPLE.test:443/a/../mcp',authentication:'bearer'}}:{action:'telegram.connect',id:agentId,input:{allowedUserId:42,enabled:false}});await request.appTools!.call('outcome','relay_report_task_outcome',{state:'complete',summary:'Synthetic complete',remaining:[],evidence:[]});return{text:'Synthetic completed'};},
 }])) as unknown as Record<ProviderId,ProviderAdapter>;
 const app=factory({dataDir:join(root,'data'),clientDir,port:0,taskPollMs:60000,adapters,secretVault:vault,telegramFetch:async()=>Response.json({ok:true,result:{username:'synthetic_bot'}}),typesafeOptions:{fetch:async()=>Response.json({models:[{name:'jev-fixture',description:'Synthetic'}]})}});
 let browser:Browser|undefined;
 try{
  const initial=app.store.list<Agent>('agent'),agent=app.store.put<Agent>('agent',{...initial[0],name:'Synthetic Worker',role:'Synthetic setup',routeMode:'claude',model:'fixture-model',mode:'agent',workspace});agentId=agent.id;
  app.groups.create([agent.id,initial[1].id],'Synthetic Discussion','roundtable');
  for(const provider of PROVIDER_IDS){app.store.saveBilling(provider,{mode:'included',confirmed:true,automaticRouting:true,allowanceNote:'Synthetic'});app.store.saveModelPreferences(provider,{defaultModel:'fixture-model',allowedModels:['fixture-model']});}
  await app.runs.refresh();const port=await app.listen(0),task=app.tasks.create({agentId,title:'Synthetic secure setup',prompt});await app.tasks.tick();const working=app.tasks.get(task.id);assert.ok(working.runId&&working.conversationId);const active=app.runs.active.get(working.runId!)!;assert.ok(active);
  browser=await chromium.launch({headless:true});const page=await browser.newPage(),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST')requests.push({path:new URL(r.url()).pathname,body:r.postData()||''});});
  await page.addInitScript(({agentId,conversationId})=>{localStorage.setItem('relay.agent',agentId);sessionStorage.setItem('relay.conversation',JSON.stringify({agentId,id:conversationId}));},{agentId,conversationId:working.conversationId!});
  await page.goto('http://127.0.0.1:'+port);const direct=page.locator('main.conversation-pane:not(.dispatcher)'),input=direct.getByLabel(kind==='mcp'||kind==='telegram'?'Integration token':'TypeSafe API key',{exact:true});await input.waitFor();await input.isEnabled().then(async enabled=>{if(!enabled)await page.waitForFunction(()=>!(document.querySelector('main.conversation-pane input[type=password]') as HTMLInputElement)?.disabled);});
  if(kind==='mcp'||kind==='telegram'){
   const card=input.locator('xpath=ancestor::section[1]'),text=await card.innerText();assert.ok(text.includes('Synthetic Worker'));assert.ok(text.includes(kind==='mcp'?'Connect MCP securely':'Connect Telegram securely'));
   if(kind==='mcp'){assert.ok(text.includes('Synthetic receiver'));assert.ok(text.includes('https://example.test/mcp'));}else {assert.ok(text.includes('https://api.telegram.org/'));assert.ok(text.includes('42'));assert.ok(text.includes('Disabled'));}
   await input.fill(key);await input.press('Enter');await active.promise;const saved=app.store.list<any>(kind==='mcp'?'mcp-connection':'telegram')[0];assert.equal(saved.agentId??saved.id,agentId);assert.equal(vault.values.get(saved.secretRef),key);if(kind==='mcp'){assert.equal(saved.name,'Synthetic receiver');assert.equal(saved.url,'https://example.test/mcp');assert.equal(saved.status,'needs_refresh');}else {assert.equal(saved.allowedUserId,42);assert.equal(saved.enabled,false);}
   const submit=requests.find(r=>r.path.endsWith('/credentials/connect'));assert.ok(submit);assert.deepEqual(Object.keys(JSON.parse(submit.body)).sort(),['nonce','token']);
  }else {
   const navigate=()=>page.getByRole('button',{name:kind==='workspace'?'Tasks & workspace':'Synthetic Discussion',exact:true}).click();const back=()=>page.locator('.agent-list').getByRole('button',{name:/Synthetic Worker/}).click();
   await input.fill(key);const handle=await input.elementHandle();await navigate();assert.equal(await handle!.evaluate(el=>el.isConnected),false);assert.deepEqual(await handle!.evaluate(el=>({value:(el as HTMLInputElement).value,defaultValue:(el as HTMLInputElement).defaultValue,attribute:el.getAttribute('value')})),{value:'',defaultValue:'',attribute:null});assert.equal(await input.count(),0);await back();await input.waitFor();assert.equal(await input.inputValue(),'');
   await input.fill(key);let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),saving=new Promise<void>(r=>started=r);await page.route('**/api/integrations/typesafe/connect',async route=>{started();await gate;try{await route.continue();}catch{}});await input.press('Enter');await saving;const aborted=page.waitForEvent('requestfailed',{predicate:r=>r.url().endsWith('/typesafe/connect'),timeout:5000});await navigate();await aborted;release();await page.unroute('**/api/integrations/typesafe/connect');await back();await input.waitFor();assert.equal(await input.inputValue(),'');assert.equal(vault.values.size,0);assert.ok(app.runs.active.has(working.runId!));
   await input.fill(key);await input.press('Enter');await active.promise;assert.equal(vault.values.get('typesafe-api-key'),key);
  }
  assert.equal(calls.length,1);assert.ok(app.store.messages(working.conversationId!).some(m=>m.content===prompt));for(const kind of ['message','app-action','task','workspace-tool','integration','mcp-connection','telegram'])assert.ok(!JSON.stringify(app.store.list(kind)).includes(key),kind);assert.ok(requests.filter(r=>!r.path.endsWith('/credentials/connect')&&!r.path.endsWith('/typesafe/connect')).every(r=>!r.body.includes(key)));assert.ok(!await page.evaluate(key=>JSON.stringify({...sessionStorage,...localStorage}).includes(key),key));assert.deepEqual(errors,[]);
 }finally{await browser?.close();await app.close();await rm(root,{recursive:true,force:true,maxRetries:5});}
}
