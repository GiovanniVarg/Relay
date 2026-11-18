import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Browser } from '../server/browser.js';
import { Capabilities } from '../server/capabilities.js';
import { Store } from '../server/store.js';
import type { Agent } from '../shared/types.js';
import type { BrowserContext } from 'playwright';

test('owned browser completes real localhost read/fill/click/screenshot and rejects self access, secrets and revoked grants', {timeout:45000,skip:process.env.RELAY_BROWSER_LIVE!=='1'}, async () => {
 const root=await mkdtemp(join(tmpdir(),'relay-browser-proof-'));const store=new Store(join(root,'data'));const agent=store.list<Agent>('agent')[0];const caps=new Capabilities(store);
 let forbiddenRequests=0;const forbidden=createServer((_req,res)=>{forbiddenRequests++;res.end('secret Relay data');});await new Promise<void>(done=>forbidden.listen(0,'127.0.0.1',done));const forbiddenPort=(forbidden.address() as {port:number}).port;
 const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<title>Browser fixture</title><h1>Local task fixture</h1><input id="name" placeholder="Name"><button id="submit" onclick="document.getElementById('result').textContent=document.getElementById('name').value">Save</button><p id="result"></p><label for="number">Credit card number</label><input id="number"><input id="secret" type="password"><a id="self" href="http://127.0.0.1:${forbiddenPort}/">Relay private</a><button id="fetch" onclick="fetch('http://127.0.0.1:${forbiddenPort}/secret').catch(()=>{})">Fetch blocked origin</button>`);});await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/`;
 const browser=new Browser(store,caps,{blockedOrigins:()=>[`http://127.0.0.1:${forbiddenPort}`]});
 try {
  await assert.rejects(browser.open(agent.id,url),/Grant/);caps.setBrowserGrant(agent.id,true);const view=await browser.open(agent.id,url);assert.equal(view.title,'Browser fixture');assert.ok(view.controls.some(control=>control.selector==='#name'));
  await browser.fill(agent.id,'#name','Relay browser worked');const result=await browser.click(agent.id,'#submit');assert.match(result.text,/Relay browser worked/);
  await assert.rejects(browser.fill(agent.id,'#secret','not-a-real-password'),/takeover/);await assert.rejects(browser.fill(agent.id,'#number','fixture'),/takeover/);
  await assert.rejects(browser.open(agent.id,`http://localhost:${forbiddenPort}/`),/Relay itself/);await browser.click(agent.id,'#fetch');assert.equal(forbiddenRequests,0);
  await assert.rejects(browser.click(agent.id,'#self'));assert.equal(forbiddenRequests,0);
  await browser.open(agent.id,url);const image=await browser.screenshot(agent.id);assert.equal(image.bytes.subarray(1,4).toString(),'PNG');
  caps.setBrowserGrant(agent.id,false);await browser.revoke(agent.id);await assert.rejects(browser.read(agent.id),/Grant/);assert.equal((await browser.status(agent.id)).running,false);
 }finally {await browser.close();await new Promise<void>(done=>server.close(()=>done()));await new Promise<void>(done=>forbidden.close(()=>done()));store.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});

test('browser profiles retain only their own cookies, takeover suspends agent actions, and cancellation drains navigation', {timeout:45000,skip:process.env.RELAY_BROWSER_LIVE!=='1'}, async()=>{
 const root=await mkdtemp(join(tmpdir(),'relay-browser-state-'));const store=new Store(join(root,'data'));const [agent,peer]=store.list<Agent>('agent');const caps=new Capabilities(store);caps.setBrowserGrant(agent.id,true);caps.setBrowserGrant(peer.id,true);
 let reached!:()=>void;const requested=new Promise<void>(done=>reached=done);
 const server=createServer((req,res)=>{if(req.url==='/slow'){reached();return;}res.setHeader('Set-Cookie','fixture=owned;Path=/');res.setHeader('Content-Type','text/html');res.end('<title>Cookie fixture</title><body>Cookie:'+String(req.headers.cookie||'none')+'</body>');});await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/`;
 const launches:boolean[]=[],contexts:BrowserContext[]=[];const options={blockedOrigins:()=>['http://127.0.0.1:3210'],launch:async(profile:string,settings:any)=>{launches.push(settings.headless);const {chromium}=await import('playwright');const context=await chromium.launchPersistentContext(profile,{...settings,headless:true});contexts.push(context);return context;}};
 let browser=new Browser(store,caps,options);
 try{
  assert.match((await browser.open(agent.id,url)).text,/Cookie:none/);await browser.close();browser=new Browser(store,caps,options);assert.match((await browser.open(agent.id,url)).text,/fixture=owned/);assert.match((await browser.open(peer.id,url)).text,/Cookie:none/);
  const human=await browser.takeover(agent.id);assert.equal(human.humanControl,true);assert.equal(launches.at(-1),false);await assert.rejects(browser.read(agent.id),/human control/);
  const context=contexts.at(-1)!,page=context.pages()[0],launchCount=launches.length;
  await page.evaluate(()=>{sessionStorage.setItem('human-verification','completed');(window as unknown as {verificationRuntime:object}).verificationRuntime={verified:true};const marker=document.createElement('p');marker.id='human-verification';marker.textContent='Human verification remains in this document';document.body.append(marker);});
  const runtime=await page.evaluateHandle(()=>(window as unknown as {verificationRuntime:object}).verificationRuntime);
  const returned=await browser.returnControl(agent.id);assert.equal(returned.humanControl,false);assert.equal(returned.sessionId,human.sessionId);assert.equal(returned.url,human.url);assert.equal(launches.length,launchCount);assert.equal(contexts.at(-1),context);assert.equal(context.pages()[0],page);assert.equal(page.isClosed(),false);assert.equal(await page.evaluate(()=>sessionStorage.getItem('human-verification')),'completed');assert.equal(await page.evaluate(value=>(window as unknown as {verificationRuntime:object}).verificationRuntime===value,runtime),true);assert.match((await browser.read(agent.id)).text,/Human verification remains in this document/);await runtime.dispose();
  const controller=new AbortController();const navigation=browser.open(agent.id,url+'slow',controller.signal);await requested;controller.abort(new Error('Fixture cancellation'));await assert.rejects(navigation);assert.equal((await browser.status(agent.id)).running,false);
 }finally{await browser.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));store.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
