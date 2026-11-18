import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'vite';
import {chromium,type Browser} from 'playwright';
import {createApp} from '../server/index.js';
import {HttpError} from '../server/security.js';
import type {Agent,Bootstrap,ProviderAdapter,ProviderId} from '../shared/types.js';

async function fixture(connected=false){
 const root=await mkdtemp(join(tmpdir(),'relay-login-session-')),calls:{provider:ProviderId;kind:'login'|'inference'}[]=[];
 let denyLogin=false;
 const adapter=(id:ProviderId):ProviderAdapter=>({
  id,inspect:async()=>{const authenticated=connected&&['openai','claude','cursor'].includes(id);return{id,installed:true,authenticated,authMode:authenticated?'subscription' as const:'unknown' as const,accountLabel:authenticated?'Synthetic connected account':'',plan:authenticated?'Synthetic':'',models:authenticated?[{id:'m1',name:'Synthetic model',verified:false}]:[]};},
  login:async()=>{calls.push({provider:id,kind:'login'});if(denyLogin){denyLogin=false;throw new HttpError(403,'Synthetic sign-in policy denied');}return{message:'SYNTHETIC_LOGIN_READY',...(id==='claude'?{command:'synthetic-command-never-executed'}:{url:id==='cursor'?'https://cursor.com/synthetic-never-opened':'https://auth.openai.com/synthetic-never-opened'})};},
  stream:async()=>{calls.push({provider:id,kind:'inference'});throw Error('Inference is forbidden in this fixture');},close:async()=>{},
 });
 const adapters:Record<ProviderId,ProviderAdapter>={openai:adapter('openai'),claude:adapter('claude'),cursor:adapter('cursor'),opencode:adapter('opencode'),gemini:adapter('gemini'),grok:adapter('grok')};
 const app=createApp({dataDir:join(root,'data'),adapters,port:0});
 if(connected){for(const provider of ['openai','claude','cursor'])app.store.saveModelPreferences(provider,{defaultModel:'m1',allowedModels:['m1']});const agent=app.store.list<Agent>('agent')[0];app.store.put('agent',{...agent,mode:'chat',routeMode:'auto',model:'',workspace:''});}
 await app.runs.refresh();const port=await app.listen(0),origin='http://127.0.0.1:'+port;
 return{app,origin,calls,denyNextLogin(){denyLogin=true;},async close(){await app.close();await rm(root,{recursive:true,force:true,maxRetries:5});}};
}
async function mounted(connected=false){
 const f=await fixture(connected);let browser:Browser|undefined;
 // Test-only development proxy preserves the upstream server's exact host/origin checks.
 const vite=await createServer({configFile:false,root:resolve('client'),logLevel:'error',server:{host:'127.0.0.1',port:0,proxy:{'/api':{target:f.origin,changeOrigin:true,configure(proxy){proxy.on('proxyReq',request=>request.setHeader('Origin',f.origin));}}}}});
 try{
  await vite.listen();browser=await chromium.launch({headless:true});const context=await browser.newContext(),page=await context.newPage(),origin=vite.resolvedUrls!.local[0],errors:string[]=[],posts:string[]=[];
  await page.addInitScript(()=>localStorage.setItem('relay.advanced','false'));
  page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.method()==='POST')posts.push(new URL(request.url()).pathname);});
  return{...f,page,context,origin,errors,posts,async close(){await browser?.close();await vite.close();await f.close();}};
 }catch(error){await browser?.close();await vite.close();await f.close();throw error;}
}
test('a replaced shared cookie with an old tab CSRF token rejects login before the adapter; origin checks remain strict',async()=>{
 const f=await fixture();try{
  async function session(){const response=await fetch(f.origin+'/api/bootstrap');return{cookie:response.headers.get('set-cookie')!.split(';')[0],value:await response.json() as Bootstrap};}
  const oldTab=await session(),newTab=await session(),path=f.origin+'/api/providers/openai/login';
  const rejected=await fetch(path,{method:'POST',headers:{Cookie:newTab.cookie,'Content-Type':'application/json','X-CSRF-Token':oldTab.value.csrfToken},body:'{}'});
  assert.equal(rejected.status,403);assert.match((await rejected.json() as {error:string}).error,/CSRF/);assert.deepEqual(f.calls,[]);
  const foreign=await fetch(path,{method:'POST',headers:{Cookie:newTab.cookie,Origin:'https://foreign.invalid','Content-Type':'application/json','X-CSRF-Token':newTab.value.csrfToken},body:'{}'});
  assert.equal(foreign.status,403);assert.deepEqual(f.calls,[]);
  const accepted=await fetch(path,{method:'POST',headers:{Cookie:newTab.cookie,'Content-Type':'application/json','X-CSRF-Token':newTab.value.csrfToken},body:'{}'});
  assert.equal(accepted.status,200);assert.deepEqual(f.calls,[{provider:'openai',kind:'login'}]);
 }finally{await f.close();}
});
test('mounted Connect refreshes an old tab session before one login POST for each subscription provider',{
 skip:process.env.RELAY_BROWSER_LIVE!=='1',timeout:60000,
},async()=>{
 const f=await mounted(),{page,context,origin}=f;
 try{
  for(const provider of [{id:'openai',name:'OpenAI'},{id:'claude',name:'Claude'},{id:'cursor',name:'Cursor'}]){
   await page.goto(origin);await page.getByRole('button',{name:'Finish setup to chat',exact:true}).waitFor();await page.getByRole('button',{name:'Settings',exact:true}).click();
   const settings=page.getByRole('dialog',{name:'Workspace settings'});await settings.locator('.account-selector').getByRole('button',{name:new RegExp('^'+provider.name)}).click();
   await context.clearCookies();assert.equal((await page.request.get(origin+'api/bootstrap')).status(),200);
   const before=f.calls.length,loginResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/providers/'+provider.id+'/login');
   await settings.getByRole('button',{name:'Connect '+provider.name,exact:true}).click();
   assert.equal((await loginResponse).status(),200,'a stale tab must refresh before its explicit login action');
   await settings.getByText('SYNTHETIC_LOGIN_READY',{exact:true}).waitFor();
   assert.deepEqual(f.calls.slice(before),[{provider:provider.id,kind:'login'}]);
  }
  assert.equal(f.posts.filter(path=>/\/providers\/(openai|claude|cursor)\/login$/.test(path)).length,3);
  assert.equal(f.calls.filter(call=>call.kind==='inference').length,0);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
test('mounted Refresh accounts refreshes an old tab session before one metadata POST',{
 skip:process.env.RELAY_BROWSER_LIVE!=='1',timeout:60000,
},async()=>{
 const f=await mounted(),{page}=f;try{
  await page.goto(f.origin);await page.getByRole('button',{name:'Finish setup to chat',exact:true}).waitFor();await page.getByRole('button',{name:'Settings',exact:true}).click();const settings=page.getByRole('dialog',{name:'Workspace settings'});
  await f.context.clearCookies();assert.equal((await page.request.get(f.origin+'api/bootstrap')).status(),200);const before=f.posts.filter(path=>path==='/api/providers/refresh').length;
  const refreshed=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/providers/refresh');await settings.getByRole('button',{name:'Refresh accounts',exact:true}).click();assert.equal((await refreshed).status(),200,'metadata refresh must obtain the current session first');
  assert.equal(f.posts.filter(path=>path==='/api/providers/refresh').length-before,1);assert.deepEqual(f.calls,[]);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
test('mounted login never posts after failed bootstrap and never replays a rejected login',{
 skip:process.env.RELAY_BROWSER_LIVE!=='1',timeout:60000,
},async()=>{
 const f=await mounted(),{page}=f;try{
  await page.goto(f.origin);await page.getByRole('button',{name:'Settings',exact:true}).click();const settings=page.getByRole('dialog',{name:'Workspace settings'}),connect=settings.getByRole('button',{name:'Connect OpenAI',exact:true});
  await page.route('**/api/bootstrap',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Synthetic bootstrap unavailable'})}));
  await connect.click();await settings.getByRole('alert').filter({hasText:'Synthetic bootstrap unavailable'}).waitFor();assert.deepEqual(f.calls,[]);assert.equal(f.posts.filter(path=>path.endsWith('/login')).length,0);
  await page.unroute('**/api/bootstrap');f.denyNextLogin();const rejected=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/providers/openai/login');await connect.click();assert.equal((await rejected).status(),403);
  await settings.getByRole('alert').filter({hasText:'Synthetic sign-in policy denied'}).waitFor();assert.deepEqual(f.calls,[{provider:'openai',kind:'login'}]);assert.equal(f.posts.filter(path=>path.endsWith('/login')).length,1);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
test('mounted connected accounts explain usage setup while billing and send gates remain closed',{
 skip:process.env.RELAY_BROWSER_LIVE!=='1',timeout:60000,
},async()=>{
 const f=await mounted(true),{page}=f;const preferences=()=>['openai','claude','cursor'].map(provider=>({provider,billing:f.app.store.billing(provider),models:f.app.store.modelPreferences(provider)})),before=preferences();
 try{
  await page.goto(f.origin);await page.getByRole('textbox',{name:/^Message /}).fill('Synthetic request must remain unsent');const send=page.getByRole('button',{name:'Send message',exact:true});assert.equal(await send.isDisabled(),true);assert.match(await send.getAttribute('title')??'',/Accounts connected/);
  await page.getByRole('button',{name:'Settings',exact:true}).click();const settings=page.getByRole('dialog',{name:'Workspace settings'});
  for(const name of ['OpenAI','Claude','Cursor']){
   await settings.locator('.account-selector').getByRole('button',{name:new RegExp('^'+name)}).click();const card=settings.locator('.provider-card').filter({has:page.getByRole('heading',{name,exact:true})});assert.match(await card.locator('.provider-state').innerText(),/Connected · approve usage/);assert.match(await card.locator('.provider-step-heading').first().innerText(),/Account connected/);
   assert.equal(await card.getByRole('checkbox',{name:'I verified this workspace’s billing and allowance',exact:true}).isChecked(),false);assert.equal(await card.getByRole('checkbox',{name:'Let Auto choose this account',exact:true}).isChecked(),false);
  }
  assert.deepEqual(preferences(),before);assert.deepEqual(f.calls,[]);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
