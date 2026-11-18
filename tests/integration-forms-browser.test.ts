import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium,type Browser,type Page} from 'playwright';

const sentinel='SYNTHETIC_FORM_SECRET_734819';
async function fixture(pendingRead=false){
 const source=`import{createElement as h}from'react';import{createRoot}from'react-dom/client';import{McpConnectionsPanel}from'/McpConnections.tsx';import{TelegramSection}from'/App.tsx';window.calls=[];window.reads=[];window.mode='fail';
 const api=async(path,method='GET',body,options)=>{
  if(method==='GET'){
   if(path.startsWith('/mcp'))return {connections:[]};
   if(!${pendingRead})return {};
   const read={path,aborted:!!options?.signal?.aborted,sensitive:options?.sensitive,signalPresent:!!options?.signal};window.reads.push(read);options?.signal?.addEventListener('abort',()=>read.aborted=true);
   return new Promise(resolve=>read.finish=telegram=>resolve({telegram}));
  }
  const call={path,method,body,sensitive:options?.sensitive,aborted:false};window.calls.push(call);options?.signal?.addEventListener('abort',()=>call.aborted=true);
  if(window.mode==='fail')throw Error('reflected '+body?.token);
  return new Promise(resolve=>window.finish=()=>resolve(path==='/mcp'?{id:'connected'}:{configured:true,enabled:body?.enabled??true,allowedUserId:body?.allowedUserId??123,botUsername:'current_bot'}));
 };
 const root=createRoot(document.getElementById('root'));window.mount=(agentId='bot')=>root.render(h('div',null,h(McpConnectionsPanel,{api,agentId}),h(TelegramSection,{api,agentId})));window.unmount=()=>root.render(null);window.mount();`;
 const vite=await createServer({server:{port:0,host:'127.0.0.1'},logLevel:'error',plugins:[{name:'synthetic-integration-forms',resolveId(id){if(id==='/synthetic-forms.tsx')return id;},load(id){if(id==='/synthetic-forms.tsx')return source;}}]});let browser:Browser|undefined;
 try{await vite.listen();browser=await chromium.launch({headless:true,channel:process.env.RELAY_TEST_BROWSER_CHANNEL});const page=await browser.newPage();const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));await page.route('**/synthetic-forms',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><div id="root"></div><script type="module" src="/synthetic-forms.tsx"></script></body></html>'}));await page.goto(vite.resolvedUrls!.local[0]+'synthetic-forms');await page.getByLabel('Bot token',{exact:true}).waitFor();return {page,errors,async close(){await browser?.close();await vite.close();}};}catch(error){await browser?.close();await vite.close();throw error;}
}
async function enter(page:Page,kind:'mcp'|'telegram'){
 if(kind==='mcp'){await page.getByRole('button',{name:'Connect tool',exact:true}).click();await page.getByLabel('Name',{exact:true}).fill('Synthetic tools');await page.getByLabel('HTTP MCP endpoint',{exact:true}).fill('https://example.test/mcp');await page.getByText('Authentication',{exact:true}).click();}
 else await page.getByLabel('Allowed Telegram user id',{exact:true}).fill('123');
 const input=page.getByLabel(kind==='mcp'?'Bearer credential (optional)':'Bot token',{exact:true});await input.fill(sentinel);return input;
}
for(const kind of ['mcp','telegram'] as const){
 test(`${kind} mounted failed save clears input and uses sensitive transport without reflecting credentials`,{timeout:30000,skip:process.env.RELAY_BROWSER_LIVE!=='1'},async()=>{const f=await fixture();try{const input=await enter(f.page,kind);await f.page.getByRole('button',{name:kind==='mcp'?'Connect':'Save Telegram',exact:true}).click();await f.page.getByRole('alert').waitFor();assert.equal(await input.inputValue(),'');assert.equal((await f.page.locator('body').innerText()).includes(sentinel),false);const calls=await f.page.evaluate(()=>(window as any).calls);assert.equal(calls.length,1);assert.equal(calls[0].sensitive,true);assert.equal(calls[0].body.token,sentinel);assert.ok(!calls.some((call:any)=>/messages|interactions/.test(call.path)));assert.equal(await f.page.evaluate(()=>JSON.stringify({...sessionStorage,...localStorage}).includes('SYNTHETIC_FORM_SECRET_734819')),false);assert.deepEqual(f.errors,[]);}finally{await f.close();}});
 test(`${kind} mounted lifecycle clears drafts and aborts saves on every disconnect and unmount`,{timeout:45000,skip:process.env.RELAY_BROWSER_LIVE!=='1'},async()=>{const f=await fixture();try{for(const event of ['offline','pagehide','relay:runtime-disconnected','relay:before-runtime-reload']){await f.page.reload();let input=await enter(f.page,kind);await f.page.evaluate(event=>window.dispatchEvent(new Event(event)),event);assert.equal(await input.inputValue(),'');await input.fill(sentinel);await f.page.evaluate(()=>(window as any).mode='pending');await f.page.getByRole('button',{name:kind==='mcp'?'Connect':'Save Telegram',exact:true}).click();await f.page.waitForFunction(()=>(window as any).calls.length===1);assert.equal(await input.inputValue(),'');await f.page.evaluate(event=>window.dispatchEvent(new Event(event)),event);assert.equal(await f.page.evaluate(()=>(window as any).calls[0].aborted),true);await input.fill('NEW_SYNTHETIC_ENTRY');await f.page.evaluate(()=>(window as any).finish());assert.equal(await input.inputValue(),'NEW_SYNTHETIC_ENTRY');}await f.page.reload();const input=await enter(f.page,kind);await f.page.evaluate(()=>(window as any).mode='pending');await f.page.getByRole('button',{name:kind==='mcp'?'Connect':'Save Telegram',exact:true}).click();await f.page.waitForFunction(()=>(window as any).calls.length===1);await f.page.evaluate(()=>(window as any).unmount());assert.equal(await f.page.evaluate(()=>(window as any).calls[0].aborted),true);await f.page.evaluate(()=>(window as any).finish());await f.page.evaluate(()=>(window as any).mount());await f.page.getByLabel('Bot token',{exact:true}).waitFor();assert.equal(await f.page.getByLabel('Bot token',{exact:true}).inputValue(),'');assert.equal(await input.count(),kind==='mcp'?0:1);assert.deepEqual(f.errors,[]);}finally{await f.close();}});
}
test('MCP toggling and Cancel clear drafts and cancel pending credential submissions',{timeout:30000,skip:process.env.RELAY_BROWSER_LIVE!=='1'},async()=>{const f=await fixture();try{await enter(f.page,'mcp');await f.page.getByRole('button',{name:'Connect tool',exact:true}).click();await f.page.getByRole('button',{name:'Connect tool',exact:true}).click();assert.equal(await f.page.getByLabel('Bearer credential (optional)',{exact:true}).inputValue(),'');await f.page.getByText('Authentication',{exact:true}).click();await f.page.getByLabel('Bearer credential (optional)',{exact:true}).fill(sentinel);await f.page.evaluate(()=>(window as any).mode='pending');await f.page.getByRole('button',{name:'Connect',exact:true}).click();await f.page.waitForFunction(()=>(window as any).calls.length===1);await f.page.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(await f.page.evaluate(()=>(window as any).calls[0].aborted),true);await f.page.evaluate(()=>(window as any).finish());await f.page.getByRole('button',{name:'Connect tool',exact:true}).click();assert.equal(await f.page.getByLabel('Bearer credential (optional)',{exact:true}).inputValue(),'');}finally{await f.close();}});

test('Telegram initial snapshots cannot overwrite new entries after lifecycle resets, edits, saves or scope changes',{timeout:90000,skip:process.env.RELAY_BROWSER_LIVE!=='1'},async()=>{
 const f=await fixture(true),page=f.page,token=page.getByLabel('Bot token',{exact:true}),userId=page.getByLabel('Allowed Telegram user id',{exact:true}),enabled=page.getByRole('checkbox',{name:'Enable bot',exact:true});
 const stale={configured:true,enabled:true,allowedUserId:123,botUsername:'stale_bot'};
 async function reload(){await page.reload();await token.waitFor();await page.waitForFunction(()=>(window as any).reads.length===1);}
 async function finish(index=0,value=stale){await page.evaluate(async({index,value})=>{(window as any).reads[index].finish(value);await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);},{index,value});}
 async function fresh(){await token.fill('NEW_SYNTHETIC_TOKEN_AFTER_RESET');await userId.fill('987');await enabled.uncheck();}
 async function preserved(){assert.equal(await token.inputValue(),'NEW_SYNTHETIC_TOKEN_AFTER_RESET');assert.equal(await userId.inputValue(),'987');assert.equal(await enabled.isChecked(),false);assert.equal(await page.getByText(/stale_bot/).count(),0);}
 try{
  for(const event of ['offline','pagehide','relay:runtime-disconnected','relay:before-runtime-reload']){
   await reload();await page.evaluate(event=>window.dispatchEvent(new Event(event)),event);await fresh();await finish();await preserved();assert.equal(await page.evaluate(()=>(window as any).reads[0].aborted),true);
  }
  for(const field of ['token','userId','enabled']){
   await reload();if(field==='token')await token.fill('NEW_SYNTHETIC_TOKEN_AFTER_RESET');else if(field==='userId')await userId.fill('987');else await enabled.uncheck();await finish();
   assert.equal(await token.inputValue(),field==='token'?'NEW_SYNTHETIC_TOKEN_AFTER_RESET':'');assert.equal(await userId.inputValue(),field==='userId'?'987':'');assert.equal(await enabled.isChecked(),field!=='enabled');assert.equal(await page.getByText(/stale_bot/).count(),0);assert.equal(await page.evaluate(()=>(window as any).reads[0].aborted),true);
  }
  await reload();await fresh();await page.evaluate(()=>(window as any).mode='pending');await page.getByRole('button',{name:'Save Telegram',exact:true}).click();await page.waitForFunction(()=>(window as any).calls.length===1);await page.evaluate(()=>(window as any).finish());await page.getByText(/current_bot/).waitFor();await finish();assert.equal(await userId.inputValue(),'987');assert.equal(await enabled.isChecked(),false);assert.equal(await token.inputValue(),'');assert.equal(await page.getByText(/stale_bot/).count(),0);
  for(const scope of ['agent change','unmount']){
   await reload();if(scope==='agent change')await page.evaluate(()=>(window as any).mount('other'));else{await page.evaluate(()=>(window as any).unmount());await token.waitFor({state:'detached'});await page.evaluate(()=>(window as any).mount());}
   await page.waitForFunction(()=>(window as any).reads.length===2);assert.equal(await page.evaluate(()=>(window as any).reads[0].aborted),true);await finish(1,{configured:true,enabled:false,allowedUserId:456,botUsername:'fresh_bot'});await finish();assert.equal(await userId.inputValue(),'456');assert.equal(await enabled.isChecked(),false);assert.equal(await token.inputValue(),'');assert.equal(await page.getByText(/fresh_bot/).count(),1);assert.equal(await page.getByText(/stale_bot/).count(),0);
  }
  assert.equal(await page.evaluate(()=>(window as any).reads.every((read:any)=>read.signalPresent)),true);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
