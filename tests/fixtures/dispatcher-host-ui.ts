import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium,type Browser} from 'playwright';
import {createApp} from '../../server/index.js';
import {PROVIDER_IDS} from '../../server/store.js';
import {fakeBrowserVault} from '../browser-vault-fixture.js';
import type {Agent,ProviderAdapter,ProviderId,ProviderRequest} from '../../shared/types.js';

/** Actual HTTP/Tasks/secure interaction flow, with every external service replaced by synthetic adapters. */
export async function dispatcherHostUi(){
 const root=await mkdtemp(join(tmpdir(),'relay-dispatcher-browser-')),workspace=join(root,'project');await mkdir(workspace);
 const vault=fakeBrowserVault(),calls:ProviderRequest[]=[],prompt='SYNTHETIC_CANONICAL_GOD_REQUEST_9013',key='SYNTHETIC_DIRECT_SECURE_KEY_8791';
 const adapters=Object.fromEntries(PROVIDER_IDS.map(id=>[id,{
  id,inspect:async()=>({id,installed:true,authenticated:true,authMode:'subscription',accountLabel:'Synthetic',plan:'Synthetic',models:[{id:'fixture-model',name:'Synthetic model',verified:false}]}),login:async()=>({message:'Synthetic only'}),close:async()=>{},
  stream:async(request:ProviderRequest)=>{calls.push(request);await request.appTools!.call('connect-typesafe','relay_typesafe_connect',{});await request.appTools!.call('report-outcome','relay_report_task_outcome',{state:'complete',summary:'Synthetic outcome recorded',remaining:[],evidence:[]});return{text:'SYNTHETIC_PRIVATE_WORKER_RESPONSE'};},
 }])) as unknown as Record<ProviderId,ProviderAdapter>;
 const app=createApp({dataDir:join(root,'data'),clientDir:resolve('dist/client'),port:0,taskPollMs:60000,adapters,secretVault:vault,typesafeOptions:{fetch:(async(url)=>{assert.ok(String(url).endsWith('/models'),'No paid decision calls allowed');return Response.json({models:[{name:'jev-fixture',description:'Synthetic'}]});}) as typeof fetch},restartForUpdate:async()=>{throw Error('No fixture restart allowed');}});
 let browser:Browser|undefined;
 try{
  const initial=app.store.list<Agent>('agent');for(const agent of initial.slice(1))app.store.remove('agent',agent.id);
  const agent=app.store.put<Agent>('agent',{...initial[0],name:'Synthetic Worker',role:'Synthetic secure setup',routeMode:'claude',model:'fixture-model',mode:'agent',workspace});
  for(const provider of PROVIDER_IDS){app.store.saveBilling(provider,{mode:'included',confirmed:true,automaticRouting:true,allowanceNote:'Synthetic'});app.store.saveModelPreferences(provider,{defaultModel:'fixture-model',allowedModels:['fixture-model']});}
  await app.runs.refresh();const port=await app.listen(0),base='http://127.0.0.1:'+port;
  browser=await chromium.launch({headless:true});const page=await browser.newPage(),errors:string[]=[],requests:{path:string;body:string}[]=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST')requests.push({path:new URL(r.url()).pathname,body:r.postData()||''});});
  await page.goto(base);await page.getByRole('button',{name:'Boss Chat',exact:true}).click();await page.getByRole('textbox',{name:'Message Boss Chat'}).fill(prompt);await page.getByRole('button',{name:'Send to Boss Chat',exact:true}).click();await page.getByText('Job1',{exact:true}).waitFor();
  assert.equal(app.tasks.list().length,1);const task=app.tasks.list()[0];assert.equal(task.agentId,agent.id);assert.equal(task.prompt,prompt);
  await page.getByRole('textbox',{name:'Message Boss Chat'}).focus();await app.tasks.tick();const working=app.tasks.get(task.id);assert.ok(working.runId);assert.ok(working.conversationId);
  const active=app.runs.active.get(working.runId!)!;assert.ok(active);await page.getByLabel('TypeSafe API key',{exact:true}).waitFor();assert.equal(await page.getByRole('textbox',{name:'Message Boss Chat'}).evaluate(el=>el===document.activeElement),true);await page.screenshot({path:'.data-browser-watch/dispatcher-actual-secure-question.png',fullPage:true});
  const human=app.store.messages(working.conversationId!).filter(m=>m.origin==='human'&&m.role==='user');assert.equal(human.length,1);assert.equal(human[0].content,prompt);
  await page.getByRole('button',{name:'Open assigned chat',exact:true}).click();const direct=page.locator('main.conversation-pane:not(.dispatcher)'),directInput=direct.getByLabel('TypeSafe API key',{exact:true});await directInput.waitFor();await directInput.fill(key);const previousInput=await directInput.elementHandle();await page.getByRole('button',{name:'Boss Chat',exact:true}).click();await page.locator('.dispatcher').waitFor();assert.equal(await previousInput!.evaluate(el=>el.isConnected),false,'Worker secure input must unmount on Boss Chat navigation');assert.equal(await directInput.count(),0);const godInput=page.locator('.dispatcher').getByLabel('TypeSafe API key',{exact:true});await godInput.waitFor();assert.equal(await godInput.inputValue(),'');
  await page.getByRole('button',{name:'Open assigned chat',exact:true}).click();await directInput.waitFor();await directInput.fill(key);let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),saving=new Promise<void>(r=>started=r);await page.route('**/api/integrations/typesafe/connect',async route=>{started();await gate;try{await route.continue();}catch{/* The aborted browser request must not reach the service. */}});await direct.getByRole('button',{name:'Connect TypeSafe',exact:true}).click();await saving;const aborted=page.waitForEvent('requestfailed',{predicate:r=>r.url().endsWith('/typesafe/connect'),timeout:5000});await page.getByRole('button',{name:'Boss Chat',exact:true}).click();await aborted;release();await page.unroute('**/api/integrations/typesafe/connect');assert.equal(vault.values.size,0);await godInput.waitFor();assert.equal(await godInput.inputValue(),'');
  await godInput.fill(key);await page.locator('.dispatcher').getByRole('button',{name:'Connect TypeSafe',exact:true}).click();await active.promise;await app.tasks.tick();await page.getByText('Finished',{exact:true}).waitFor();
  assert.equal(calls.length,1);assert.equal(app.tasks.get(task.id).outcome?.state,'complete');assert.equal(app.tasks.get(task.id).status,'done');assert.equal(vault.values.get('typesafe-api-key'),key);
  const dispatcherRequests=requests.filter(r=>r.path.startsWith('/api/dispatcher'));assert.equal(dispatcherRequests.filter(r=>r.path.endsWith('/submissions')).length,1);assert.ok(dispatcherRequests.every(r=>!r.body.includes(key)));assert.ok(requests.filter(r=>!r.path.endsWith('/typesafe/connect')).every(r=>!r.body.includes(key)));
  for(const kind of ['message','dispatcher-submission','dispatcher-selection','workspace-tool','integration'])assert.ok(!JSON.stringify(app.store.list(kind)).includes(key),kind);
  const storage=await page.evaluate(()=>JSON.stringify({...sessionStorage,...localStorage}));assert.ok(!storage.includes(key));assert.ok(!storage.includes(prompt));assert.equal(await page.evaluate(()=>sessionStorage.getItem('relay.dispatcher.ids')),'[]');assert.doesNotMatch(await page.locator('.dispatcher').innerText(),/SYNTHETIC_PRIVATE_WORKER_RESPONSE|SYNTHETIC_CANONICAL_GOD_REQUEST/);
  await page.getByRole('button',{name:'Open assigned chat',exact:true}).click();await page.getByText(prompt,{exact:true}).waitFor();assert.deepEqual(errors,[]);
 }finally{await browser?.close();await app.close();await rm(root,{recursive:true,force:true,maxRetries:5});}
}
