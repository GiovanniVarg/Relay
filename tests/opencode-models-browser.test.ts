import test from 'node:test';
import assert from 'node:assert/strict';
import {access,mkdir,mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,join,resolve,sep} from 'node:path';
import {chromium,type Browser} from 'playwright';
import {createApp} from '../server/index.js';
import {PROVIDER_IDS} from '../server/store.js';
import type {Agent,ModelInfo,ProviderAdapter,ProviderId,ProviderRequest} from '../shared/types.js';

// Opt-in mounts the production bundle against a real authenticated, entirely synthetic server.
test('mounted OpenCode catalog pages, exact model choices and scope-bound billing survive real app flows',
 {timeout:90000,skip:process.env.RELAY_BROWSER_LIVE!=='1'},async()=>{
  const clientDir=resolve('dist/client');
  await access(join(clientDir,'index.html')).catch(()=>{throw Error('Build the current production client before running this browser regression');});
  const dir=await mkdtemp(join(tmpdir(),'relay-opencode-models-browser-')),workspace=join(dir,'project'),evidence=resolve('../evidence');
  await mkdir(workspace);
  const originalScope='1'.repeat(64),replacementScope='2'.repeat(64);let scope=originalScope;
  const models:ModelInfo[]=Array.from({length:260},(_,index)=>{
   const backend=index%2?'local-b':'local-a',native='model-'+String(index).padStart(3,'0');
   return{id:backend+'/'+native,name:'Synthetic '+native,backendProviderId:backend,backendProviderName:backend==='local-a'?'Local Alpha':'Local Beta',nativeModelId:native,local:true,verified:false};
  });
  const target=models[257],calls:ProviderRequest[]=[],modelWrites:Record<string,unknown>[]=[];
  const adapters=Object.fromEntries(PROVIDER_IDS.map(provider=>[provider,{
   id:provider,
   inspect:async()=>provider==='opencode'?{id:provider,installed:true,authenticated:true,authMode:'managed' as const,accountLabel:'OpenCode managed profile',plan:'',connectionScope:scope,nativeAgentOnly:true,models}:{
    id:provider,installed:false,authenticated:false,authMode:'unknown' as const,accountLabel:'',plan:'',models:[]},
   login:async()=>({message:'Synthetic fixture: no login or credential access'}),close:async()=>{},
   stream:async(request:ProviderRequest)=>{
    assert.equal(provider,'opencode','No fallback provider or routing inference may run');
    calls.push(request);
    await request.appTools?.call('browser-fixture-outcome','relay_report_task_outcome',{state:'complete',summary:'Synthetic model selection completed',remaining:[],evidence:[]});
    return{text:'MOUNTED_OPENCODE_MODEL_OK'};
   },
  } satisfies ProviderAdapter])) as unknown as Record<ProviderId,ProviderAdapter>;
  const app=createApp({dataDir:join(dir,'data'),port:0,adapters,clientDir});let browser:Browser|undefined;
  try{
   await app.runs.refresh();
   app.store.saveBilling('opencode',{mode:'local',confirmed:true,automaticRouting:false,allowanceNote:'Synthetic loopback fixture only'});
   app.store.saveModelPreferences('opencode',{defaultModel:models[0].id,allowedModels:models.slice(0,205).map(model=>model.id)});
   const seed=app.store.list<Agent>('agent')[0],agent=app.store.put<Agent>('agent',{...seed,name:'Catalog Fixture',instructions:'Synthetic model picker regression',mode:'agent',workspace,routeMode:'auto',model:''});
   const port=await app.listen(0);browser=await chromium.launch({headless:true});
   const page=await browser.newPage({viewport:{width:1280,height:920}}),origin='http://127.0.0.1:'+port,errors:string[]=[];
   page.on('pageerror',error=>errors.push(error.message));
   page.on('response',response=>{if(response.status()>=400)errors.push(response.status()+' '+new URL(response.url()).pathname);});
   page.on('request',request=>{if(request.method()==='PATCH'&&new URL(request.url()).pathname==='/api/providers/opencode/models')modelWrites.push(request.postDataJSON());});
   await page.addInitScript(agentId=>{localStorage.setItem('relay.agent',agentId);localStorage.setItem('relay.room','');localStorage.setItem('relay.advanced','true');},agent.id);
   assert.equal((await page.request.get(origin+'/api/bootstrap')).status(),200);
   await page.goto(origin+'/');
   const settings=page.getByRole('dialog',{name:'Workspace settings'});
   async function openSettings(){
    await page.getByRole('button',{name:'Settings',exact:true}).click();await settings.waitFor();
    await settings.locator('.account-selector').getByRole('button',{name:/^OpenCode/}).click();
   }
   await openSettings();
   const catalog=settings.getByRole('region',{name:'OpenCode runtime models'}),search=catalog.getByRole('searchbox',{name:'Search model catalog'}),pagination=catalog.locator('.model-pagination').first();
   await search.waitFor();assert.match(await pagination.innerText(),/260 matches.*page 1 \/ 6/);
   assert.equal(await catalog.locator('.subscription-model-list .model-choice').count(),50);
   await pagination.getByRole('button',{name:'Next',exact:true}).click();
   assert.match(await pagination.innerText(),/page 2 \/ 6/);
   await catalog.locator('.subscription-model-list code').filter({hasText:models[50].id}).waitFor();
   await search.fill(target.id);
   const targetChoice=catalog.locator('label.model-choice').filter({hasText:target.id});
   await targetChoice.waitFor();assert.equal(await targetChoice.getByRole('checkbox').isChecked(),false);
   await targetChoice.getByRole('checkbox').check();await catalog.getByRole('button',{name:'Save models',exact:true}).click();
   await catalog.getByText('Model choices saved',{exact:true}).waitFor();
   const saved=app.store.modelPreferences('opencode');
   assert.deepEqual(saved.allowedModels,[...models.slice(0,205).map(model=>model.id),target.id]);
   assert.ok(modelWrites.length>0);assert.ok(modelWrites.every(body=>body.expectedConnectionScope===originalScope&&typeof body.expectedCatalogRevision==='string'));
   assert.ok(modelWrites.some(body=>Array.isArray(body.addModels)&&body.addModels.includes(target.id)));
   await page.keyboard.press('Escape');await settings.waitFor({state:'hidden'});
   await page.reload();await openSettings();await search.fill(target.id);
   assert.equal(await targetChoice.getByRole('checkbox').isChecked(),true,'saved exact choice persists through a production app reload');
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
   await mkdir(evidence,{recursive:true});await page.screenshot({path:join(evidence,'opencode-models-desktop.jpg'),type:'jpeg',fullPage:true});
   await page.keyboard.press('Escape');await settings.waitFor({state:'hidden'});
   await page.getByRole('group',{name:'Conversation mode'}).getByRole('button',{name:'Agent',exact:true}).click();
   await page.getByRole('combobox',{name:'Provider route',exact:true}).selectOption('opencode');
   await page.getByRole('searchbox',{name:'Conversation model search',exact:true}).fill(target.id);
   await page.getByRole('combobox',{name:'Conversation model',exact:true}).selectOption(target.id);
   const composer=page.getByRole('textbox',{name:'Message Catalog Fixture',exact:true});await composer.fill('Use the exact synthetic OpenCode selection.');await composer.press('Enter');
   await page.getByText('MOUNTED_OPENCODE_MODEL_OK',{exact:true}).waitFor();
   assert.equal(calls.length,1);assert.equal(calls[0].model,target.id);assert.equal(calls[0].mode,'agent');assert.equal(calls[0].workspace,await realpath(workspace));assert.equal(calls[0].expectedConnectionScope,originalScope);
   await openSettings();
   const providerCard=settings.locator('.provider-card').filter({has:page.getByRole('heading',{name:'OpenCode',exact:true})});
   const confirmation=providerCard.getByRole('checkbox',{name:'I verified this workspace’s billing and allowance',exact:true});
   await confirmation.uncheck();await providerCard.getByRole('button',{name:'Save usage permission',exact:true}).click();
   await providerCard.getByText('Billing settings saved',{exact:true}).waitFor();assert.equal(app.store.billing('opencode').confirmed,false);
   await confirmation.check();assert.equal(await confirmation.isChecked(),true);assert.equal(app.store.billing('opencode').confirmed,false,'billing confirmation is staged only');
   scope=replacementScope;
   await settings.getByRole('button',{name:'Refresh accounts',exact:true}).click();
   await page.waitForFunction(()=>{const card=[...document.querySelectorAll('.provider-card')].find(card=>card.querySelector('h3')?.textContent==='OpenCode');return (card?.querySelector('.billing-form input[type="checkbox"]') as HTMLInputElement|undefined)?.checked===false;});
   assert.equal(await confirmation.isChecked(),false,'same account with a changed native scope clears unsaved confirmation');
   const refreshed=app.runs.providers().find(provider=>provider.id==='opencode')!;
   assert.equal(refreshed.accountLabel,'OpenCode managed profile');assert.equal(refreshed.connectionScope,replacementScope);assert.equal(app.store.billing('opencode').confirmed,false);assert.equal(calls.length,1);
   await page.setViewportSize({width:390,height:844});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
   await page.screenshot({path:join(evidence,'opencode-models-narrow.jpg'),type:'jpeg',fullPage:true});
   assert.deepEqual(errors,[]);
   await writeFile(join(evidence,'opencode-models-browser-proof.json'),JSON.stringify({productionBundle:true,synthetic:true,catalogCount:models.length,enabledModels:saved.allowedModels?.length,selectedModel:target.id,providerCalls:calls.length,nativeMode:calls[0].mode,originalScope,refreshedScope:refreshed.connectionScope,stagedBillingReset:true,viewports:[1280,390],errors},null,2)+'\n');
  }catch(error){
   // Retain a bounded synthetic DOM/viewport proof if a real production locator or flow fails.
   const failedPage=browser?.contexts().flatMap(context=>context.pages())[0];
   if(failedPage)try{
    await mkdir(evidence,{recursive:true});await failedPage.screenshot({path:join(evidence,'opencode-models-failure.jpg'),type:'jpeg',fullPage:false,timeout:5000});
    const state=await failedPage.evaluate(()=>({url:location.href,bodyText:document.body.innerText.slice(0,24000),regions:[...document.querySelectorAll('section[aria-label],[role="dialog"]')].slice(0,40).map(element=>({role:element.getAttribute('role'),label:element.getAttribute('aria-label')}))}));
    await writeFile(join(evidence,'opencode-models-failure.json'),JSON.stringify({synthetic:true,error:String(error).slice(0,4000),...state},null,2)+'\n');
   }catch{/* Preserve the original assertion even if failure capture is unavailable. */}
   throw error;
  }finally{
   await browser?.close();await app.close();const absolute=resolve(dir);
   assert.ok(absolute.startsWith(resolve(tmpdir())+sep)&&basename(absolute).startsWith('relay-opencode-models-browser-'));
   await rm(absolute,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
 });
