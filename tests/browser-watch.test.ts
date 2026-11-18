import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { Capabilities } from '../server/capabilities.js';
import { Browser } from '../server/browser.js';
import { AppControls, type AppControlServices } from '../server/app-controls.js';
import { browserWatchFeed, type BrowserFeedState } from '../client/browser-watch-feed.js';
import type { Agent } from '../shared/types.js';
import { fakeBrowserVault } from './browser-vault-fixture.js';
const delay = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
async function fixture() {
 const root = await mkdtemp(join(tmpdir(), 'relay-watch-')), store = new Store(root), caps = new Capabilities(store), agent = store.list<Agent>('agent')[0];
 let launches=0, cookies=0, captures=0, navigations=0, current='about:blank', failLaunch=false;
 let cookieReader: () => Promise<[]> = async () => [], capture: () => Promise<Buffer> = async () => Buffer.from('jpeg'), navigation: () => Promise<void> = async () => {};
 const page = Object.assign(new EventEmitter(), { url:()=>current, isClosed:()=>false, setDefaultTimeout:()=>{}, setDefaultNavigationTimeout:()=>{}, goto:async(value:string)=>{navigations++;await navigation();current=value;page.emit('framenavigated', {url:()=>current});}, mainFrame:()=>null, screenshot:async(options:unknown)=>{captures++;assert.deepEqual(options,{type:'jpeg',quality:55,fullPage:false,timeout:2000});return capture();}, title:async()=>'', locator:()=>({evaluateAll:async()=>[],innerText:async()=>'',evaluate:async()=>false,fill:async()=>{}}) });
 const contexts: EventEmitter[]=[];
 const browser = new Browser(store,caps,{vault:fakeBrowserVault(),launch:async(profile)=>{launches++;if(failLaunch)throw Error('Synthetic launch failure');await mkdir(profile,{recursive:true});const context=Object.assign(new EventEmitter(),{route:async()=>{},addCookies:async()=>{},pages:()=>[page],cookies:async()=>{cookies++;return cookieReader();},close:async()=>{context.emit('close');}});contexts.push(context);return context as never;}});
 return {root,store,caps,agent,browser,page,contexts,counts:()=>({launches,cookies,captures,navigations}),capture:(fn:()=>Promise<Buffer>)=>capture=fn,navigation:(fn:()=>Promise<void>)=>navigation=fn,failLaunch:()=>{failLaunch=true;},cookies:(fn:()=>Promise<[]>)=>cookieReader=fn,async open(){caps.setBrowserGrant(agent.id,true);await browser.open(agent.id,'https://fixture.test/');},async close(){await browser.close();store.close();await rm(root,{recursive:true,force:true,maxRetries:5});}};
}
test('watch awaits a grant/session without launch, navigation, cookies or artifacts; status first and connection-local sequence',async()=>{
 const f=await fixture();try{const a:any[]=[],b:any[]=[];const off=f.browser.watch(f.agent.id,e=>a.push(e));await delay();assert.equal(a[0].type,'status');assert.equal(a[0].sequence,1);assert.equal(a[0].sessionId,null);assert.deepEqual(f.counts(),{launches:0,cookies:0,captures:0,navigations:0});const other=f.browser.watch(f.agent.id,e=>b.push(e));assert.equal(b[0].sequence,1);off();other();assert.deepEqual(await readdir(f.root),['relay.sqlite','relay.sqlite-shm','relay.sqlite-wal']);}finally{await f.close();}
});
test('two watchers share bounded capture outside a pending navigation and publish no fill values',async()=>{
 const f=await fixture();try{await f.open();const before=f.counts();let release!:()=>void;f.navigation(()=>new Promise(done=>release=done));const pending=f.browser.open(f.agent.id,'https://fixture.test/next');await delay();const a:any[]=[],b:any[]=[];const off=f.browser.watch(f.agent.id,e=>a.push(e)),other=f.browser.watch(f.agent.id,e=>b.push(e));await delay();assert.equal(a[0].type,'status');assert.equal(a.filter(e=>e.type==='frame').length,1);assert.equal(b.filter(e=>e.type==='frame').length,1);assert.equal(f.counts().captures,1);assert.equal(f.counts().cookies,before.cookies);release();await pending;await f.browser.fill(f.agent.id,'#private','synthetic visible text');assert.equal(JSON.stringify(a.filter(e=>e.type==='activity')).includes('synthetic'),false);assert.ok(a.some(e=>e.type==='activity'&&e.action==='fill'&&e.phase==='complete'));off();other();}finally{await f.close();}
});
test('withheld capture cannot survive revoke/regrant, and its lock lasts until actual settlement',async()=>{
 const f=await fixture();let resolve!:(value:Buffer)=>void;try{await f.open();f.capture(()=>new Promise(done=>resolve=done));const events:any[]=[];const off=f.browser.watch(f.agent.id,e=>events.push(e));await delay();f.caps.setBrowserGrant(f.agent.id,false);const revoke=f.browser.revoke(f.agent.id);f.caps.setBrowserGrant(f.agent.id,true);await revoke;await f.browser.open(f.agent.id,'https://fixture.test/new');await delay(1100);assert.equal(f.counts().captures,1);resolve(Buffer.from('old pixels'));await delay();assert.equal(events.filter(e=>e.type==='frame').length,0);assert.ok(events.some(e=>e.type==='clear'&&e.reason==='revoked'));off();}finally{await f.close();}
});
test('oversized captures are skipped; URL change during capture discards old pixels',async()=>{
 const f=await fixture();try{await f.open();f.capture(async()=>Buffer.alloc(512*1024+1));const events:any[]=[];const off=f.browser.watch(f.agent.id,e=>events.push(e));await delay();assert.equal(events.filter(e=>e.type==='frame').length,0);off();await delay(1050);let release!:(value:Buffer)=>void;f.capture(()=>new Promise(done=>release=done));const off2=f.browser.watch(f.agent.id,e=>events.push(e));await delay();await f.browser.open(f.agent.id,'https://fixture.test/changed');release(Buffer.from('wrong page'));await delay();assert.equal(events.filter(e=>e.type==='frame').length,0);assert.ok(events.some(e=>e.type==='clear'&&e.reason==='navigation'));off2();}finally{await f.close();}
});
test('shutdown closes context before capture drain and sends shutdown even with no final frame',async()=>{
 const f=await fixture();let settle!:(bytes:Buffer)=>void;try{await f.open();f.capture(()=>new Promise(done=>settle=done));const events:any[]=[];f.browser.watch(f.agent.id,e=>events.push(e));await delay();f.contexts[0].once('close',()=>settle(Buffer.from('closed')));await f.browser.close();assert.ok(events.some(e=>e.type==='clear'&&e.reason==='shutdown'));assert.equal(events.filter(e=>e.type==='frame').length,0);}finally{await f.close();}
});
test('human ownership survives revoke and regrant until operator Return without grant or launch',async()=>{
 const f=await fixture();try{await f.open();await f.browser.takeover(f.agent.id);f.caps.setBrowserGrant(f.agent.id,false);await f.browser.revoke(f.agent.id);assert.equal(f.browser.statusSnapshot(f.agent.id).humanControl,true);f.caps.setBrowserGrant(f.agent.id,true);await assert.rejects(f.browser.read(f.agent.id),/human control/);f.caps.setBrowserGrant(f.agent.id,false);const before=f.counts();await f.browser.returnControl(f.agent.id);assert.equal(f.browser.statusSnapshot(f.agent.id).humanControl,false);assert.equal(f.counts().launches,before.launches);assert.equal(f.caps.browserGrant(f.agent.id).enabled,false);}finally{await f.close();}
});
test('failed headed launch retains human ownership until operator Return',async()=>{
 const f=await fixture();try{await f.open();f.failLaunch();await assert.rejects(f.browser.takeover(f.agent.id),/Synthetic launch/);assert.equal(f.browser.statusSnapshot(f.agent.id).humanControl,true);await assert.rejects(f.browser.read(f.agent.id),/human control/);f.caps.setBrowserGrant(f.agent.id,false);await f.browser.returnControl(f.agent.id);assert.equal(f.browser.isHumanOwned(f.agent.id),false);}finally{await f.close();}
});
test('revoke/regrant during initial page initialization cannot install a stale session',async()=>{
 const f=await fixture();let release!:()=>void,entered!:()=>void;const started=new Promise<void>(done=>entered=done);try{let first=true;f.navigation(async()=>{if(first){first=false;entered();await new Promise<void>(done=>release=done);}});const opening=f.open();await started;f.caps.setBrowserGrant(f.agent.id,false);await f.browser.revoke(f.agent.id);f.caps.setBrowserGrant(f.agent.id,true);release();await assert.rejects(opening,/revoked|replaced/);assert.equal(f.browser.statusSnapshot(f.agent.id).sessionId,null);}finally{release?.();await f.close();}
});
test('Stop invalidates before cookie or close awaits; retiring sessions cannot begin another capture',async()=>{
 const f=await fixture();let release!:(value:[])=>void;try{await f.open();const events:any[]=[];const off=f.browser.watch(f.agent.id,e=>events.push(e));await delay();const before=f.counts().captures;f.cookies(()=>new Promise(done=>release=done));f.caps.setBrowserGrant(f.agent.id,false);const revoke=f.browser.revoke(f.agent.id);f.caps.setBrowserGrant(f.agent.id,true);await delay(1150);assert.equal(f.counts().captures,before);assert.ok(events.some(e=>e.type==='clear'&&e.reason==='revoked'));release([]);await revoke;off();}finally{release?.([]);await f.close();}
});
test('disconnect and reconnect cannot deliver a withheld frame from the previous observer',async()=>{
 const f=await fixture();let release!:(value:Buffer)=>void;try{await f.open();f.capture(()=>new Promise(done=>release=done));const old:any[]=[],fresh:any[]=[];const off=f.browser.watch(f.agent.id,e=>old.push(e));await delay();off();const off2=f.browser.watch(f.agent.id,e=>fresh.push(e));await delay(2200);assert.equal(f.counts().captures,1);release(Buffer.from('old observer'));await delay();assert.equal(old.filter(e=>e.type==='frame').length,0);assert.equal(fresh.filter(e=>e.type==='frame').length,0);assert.equal(fresh[0].sequence,1);off2();}finally{release?.(Buffer.from('cleanup'));await f.close();}
});
test('normal shutdown preserves private session-cookie persistence while the watcher never saves cookies',async()=>{
 const f=await fixture();try{await f.open();await f.browser.takeover(f.agent.id);const before=f.counts().cookies;const off=f.browser.watch(f.agent.id,()=>{});await delay();assert.equal(f.counts().cookies,before);off();await f.browser.close();assert.ok(f.counts().cookies>before);const stored=JSON.parse(await readFile(join(f.root,'browser',f.agent.id,'session-cookies.encrypted.json'),'utf8'));assert.equal(stored.protection,'aes-256-gcm');assert.equal(stored.version,1);}finally{await f.close();}
});
test('cancelled cookie collection cannot overwrite the durable encrypted session',async()=>{
 const f=await fixture();let release!:(value:[])=>void;
 try{await f.open();const target=join(f.root,'browser',f.agent.id,'session-cookies.encrypted.json'),before=await readFile(target,'utf8');f.cookies(()=>new Promise(done=>release=done));const controller=new AbortController(),pending=f.browser.read(f.agent.id,controller.signal),result=Promise.allSettled([pending]);await delay();controller.abort(new Error('Synthetic browser cancellation'));release([]);const [outcome]=await result;assert.equal(outcome.status,'rejected');assert.equal(await readFile(target,'utf8'),before);assert.equal((await readdir(join(f.root,'browser',f.agent.id))).some(name=>name.endsWith('.tmp')),false);}finally{release?.([]);await f.close();}
});

// Each launch owns a distinct context/page: control races must not depend on shared mock state.
async function ownershipFixture() {
 const root=await mkdtemp(join(tmpdir(),'relay-ownership-')),store=new Store(root),caps=new Capabilities(store),agent=store.list<Agent>('agent')[0];
 const modes:boolean[]=[],closed:number[]=[],pages:Array<{isClosed:()=>boolean;close:()=>void;state:Map<string,string>}> = [];
 let navigations=0;
 type Boundary='cookies'|'close'|'launch';
 let pending:{boundary:Boundary;entered:()=>void;wait:Promise<void>}|undefined;
 const boundary=async(name:Boundary)=>{if(pending?.boundary===name){const gate=pending;pending=undefined;gate.entered();await gate.wait;}};
 const browser=new Browser(store,caps,{vault:fakeBrowserVault(),launch:async(profile,options)=>{await mkdir(profile,{recursive:true});const index=modes.push(options.headless)-1;await boundary('launch');let current='about:blank',pageClosed=false;const state=new Map<string,string>();const page=Object.assign(new EventEmitter(),{url:()=>current,isClosed:()=>pageClosed,close:()=>{pageClosed=true;},state,setDefaultTimeout:()=>{},setDefaultNavigationTimeout:()=>{},goto:async(url:string)=>{navigations++;state.clear();current=url;},screenshot:async()=>Buffer.from('jpeg'),title:async()=>'',locator:()=>({evaluateAll:async()=>[],innerText:async()=>state.get('verification')??''})});pages.push(page);const context=Object.assign(new EventEmitter(),{route:async()=>{},addCookies:async()=>{},pages:()=>[page],cookies:async()=>{await boundary('cookies');return [];},close:async()=>{await boundary('close');page.close();closed.push(index);context.emit('close');}});return context as never;}});
 const controls=new AppControls(store,{browser,capabilities:caps} as AppControlServices);
 return {browser,caps,agent,modes,closed,pages,navigations:()=>navigations,modelGrant:(enabled:boolean)=>controls.call({agentId:agent.id,runId:'fixture',signal:new AbortController().signal,isActive:()=>true},'relay_app_control',{action:'browser.grant',id:agent.id,input:{enabled}},()=>{}),hold(name:Boundary){let entered!:()=>void,release!:()=>void;const started=new Promise<void>(done=>entered=done),wait=new Promise<void>(done=>release=done);pending={boundary:name,entered,wait};return {started,release};},async open(){caps.setBrowserGrant(agent.id,true);await browser.open(agent.id,'https://fixture.test/');await browser.takeover(agent.id);},async close(){await browser.close();store.close();await rm(root,{recursive:true,force:true,maxRetries:5});}};
}
const settledControls=(...controls:Promise<unknown>[])=>Promise.allSettled(controls);
function superseded(result:PromiseSettledResult<unknown>){assert.equal(result.status,'rejected');if(result.status==='rejected'){assert.equal(result.reason.status,409);assert.match(result.reason.message,/superseded|revoked|replaced/i);}}
test('healthy Return preserves the exact headed page, session ID and verification state without close, launch or navigation',async()=>{
 const f=await ownershipFixture();let release:()=>void=()=>{};
 try{
  await f.open();const page=f.pages.at(-1)!,status=f.browser.statusSnapshot(f.agent.id),modes=f.modes.length,closed=f.closed.length,navigations=f.navigations();page.state.set('verification','human verified this page');
  const gate=f.hold('cookies');release=gate.release;const returning=f.browser.returnControl(f.agent.id);await gate.started;
  assert.equal(f.browser.isHumanOwned(f.agent.id),true);await assert.rejects(f.browser.read(f.agent.id),/human control/);for(const enabled of [true,false])await assert.rejects(f.modelGrant(enabled),/human control/);
  release();const returned=await returning;assert.equal(returned.humanControl,false);assert.equal(returned.running,true);assert.equal(returned.sessionId,status.sessionId);assert.equal(returned.url,status.url);assert.equal(f.pages.at(-1),page);assert.equal(page.isClosed(),false);assert.equal(f.modes.length,modes);assert.equal(f.closed.length,closed);assert.equal(f.navigations(),navigations);assert.equal(f.modes.at(-1),false);assert.match((await f.browser.read(f.agent.id)).text,/human verified this page/);
 }finally{release();await f.close();}
});
test('bot actions queued before Takeover remain blocked until the current Return succeeds',async()=>{
 const f=await ownershipFixture();let release:()=>void=()=>{};
 try{
  f.caps.setBrowserGrant(f.agent.id,true);await f.browser.open(f.agent.id,'https://fixture.test/');const gate=f.hold('cookies');release=gate.release;const running=f.browser.read(f.agent.id);await gate.started;const queued=f.browser.read(f.agent.id),taken=f.browser.takeover(f.agent.id),results=settledControls(running,queued,taken);
  assert.equal(f.browser.isHumanOwned(f.agent.id),true);release();const outcomes=await results;for(const outcome of outcomes.slice(0,2)){assert.equal(outcome.status,'rejected');if(outcome.status==='rejected')assert.match(outcome.reason.message,/human control/);}assert.equal(outcomes[2].status,'fulfilled');await assert.rejects(f.browser.read(f.agent.id),/human control/);await f.browser.returnControl(f.agent.id);await f.browser.read(f.agent.id);
 }finally{release();await f.close();}
});
test('Return cannot release ownership if its live page closes while saving cookies',async()=>{
 const f=await ownershipFixture();let release:()=>void=()=>{};
 try{await f.open();const gate=f.hold('cookies');release=gate.release;const returning=f.browser.returnControl(f.agent.id),outcomes=settledControls(returning);await gate.started;f.pages.at(-1)!.close();release();const [outcome]=await outcomes;assert.equal(outcome.status,'rejected');if(outcome.status==='rejected')assert.match(outcome.reason.message,/closing|replaced/);assert.equal(f.browser.isHumanOwned(f.agent.id),true);await assert.rejects(f.browser.read(f.agent.id),/human control/);}finally{release();await f.close();}
});
test('Return discards a pre-handoff frame and keeps the same session observable with bot-control status',async()=>{
 const f=await fixture();let release!:(bytes:Buffer)=>void;
 try{await f.open();await f.browser.takeover(f.agent.id);const before=f.counts(),sessionId=f.browser.statusSnapshot(f.agent.id).sessionId,events:any[]=[];f.capture(()=>new Promise(done=>release=done));const off=f.browser.watch(f.agent.id,e=>events.push(e));await delay();await f.browser.returnControl(f.agent.id);release(Buffer.from('pre-handoff pixels'));await delay();assert.equal(events.filter(e=>e.type==='frame').length,0);f.capture(async()=>Buffer.from('returned live page'));await delay(1150);const frame=events.find(e=>e.type==='frame');assert.ok(frame);assert.equal(frame.sessionId,sessionId);assert.equal(frame.jpeg,Buffer.from('returned live page').toString('base64'));assert.ok(events.some(e=>e.type==='status'&&e.status.humanControl===false&&e.status.sessionId===sessionId));assert.equal(f.counts().launches,before.launches);assert.equal(f.counts().navigations,before.navigations);off();}finally{release?.(Buffer.from('cleanup'));await f.close();}
});
for(const failed of [false,true])test(`non-retiring Return reestablishes the real client feed after ${failed?'human-owned cookie save failure':'unchanged bot-owned status'}`,async()=>{
 const f=await fixture();let off:()=>void=()=>{},feed:ReturnType<typeof browserWatchFeed>|undefined;
 try{
  await f.open();if(failed)await f.browser.takeover(f.agent.id);const sessionId=f.browser.statusSnapshot(f.agent.id).sessionId,jpeg=Buffer.from('/9j/2Q==','base64'),events:any[]=[];f.capture(async()=>jpeg);
  let state!:BrowserFeedState;const source:any={onopen:null,onmessage:null,onerror:null,close(){}};feed=browserWatchFeed(f.agent.id,next=>{state=next;},()=>source);off=f.browser.watch(f.agent.id,event=>{events.push(event);source.onmessage({data:JSON.stringify(event)});});await delay();assert.ok(state.frame);
  if(failed){f.cookies(async()=>{throw Error('Synthetic cookie read failure');});await assert.rejects(f.browser.returnControl(f.agent.id),/Synthetic cookie read failure/);f.cookies(async()=>[]);}else await f.browser.returnControl(f.agent.id);
  assert.equal(f.browser.isHumanOwned(f.agent.id),failed);assert.equal(state.frame,null);await delay(1150);
  assert.ok(state.frame,'a fresh frame must reach the client after the non-retiring clear');assert.equal((state as BrowserFeedState).frame?.sessionId,sessionId);assert.equal(state.status?.humanControl,failed);assert.equal(state.status?.sessionId,sessionId);assert.equal(state.connection,'connected');assert.ok(state.activities.some(event=>event.action==='return'&&event.phase===(failed?'failed':'complete')));
  const cleared=events.findIndex(event=>event.type==='clear'&&event.reason==='session_replaced');assert.ok(cleared>=0);assert.equal(events[cleared+1].type,'status');assert.equal(events[cleared+1].sessionId,sessionId);assert.equal(events[cleared+1].status.humanControl,failed);
  if(failed)await assert.rejects(f.browser.read(f.agent.id),/human control/);
 }finally{f.cookies(async()=>[]);off();feed?.close();await f.close();}
});
test('Return without a grant closes the current session without launch or restoring access',async()=>{
 const f=await ownershipFixture();try{await f.open();const before=f.modes.length;f.caps.setBrowserGrant(f.agent.id,false);const status=await f.browser.returnControl(f.agent.id);assert.equal(status.humanControl,false);assert.equal(status.running,false);assert.equal(status.granted,false);assert.equal(f.modes.length,before);assert.equal(f.pages.at(-1)!.isClosed(),true);await assert.rejects(f.browser.read(f.agent.id),/Grant/);}finally{await f.close();}
});
test('shutdown supersedes a pending in-place Return without releasing human ownership',async()=>{
 const f=await ownershipFixture();let release:()=>void=()=>{};try{await f.open();const gate=f.hold('cookies');release=gate.release;const returning=f.browser.returnControl(f.agent.id),outcomes=settledControls(returning);await gate.started;const closing=f.browser.close();release();const [old]=await outcomes;superseded(old);await closing;assert.equal(f.browser.isHumanOwned(f.agent.id),true);assert.equal(f.browser.statusSnapshot(f.agent.id).running,false);}finally{release();await f.close();}
});
test('latest operator intent: Return then Takeover never releases the newer human latch',async()=>{
 const f=await ownershipFixture();try{await f.open();const returned=f.browser.returnControl(f.agent.id),taken=f.browser.takeover(f.agent.id);const outcomes=await settledControls(returned,taken);assert.equal(f.browser.isHumanOwned(f.agent.id),true);await assert.rejects(f.browser.read(f.agent.id),/human control/);for(const enabled of [true,false])await assert.rejects(f.modelGrant(enabled),/human control/);assert.equal(f.modes.at(-1),false);superseded(outcomes[0]);assert.equal(outcomes[1].status,'fulfilled');}finally{await f.close();}
});
for(const boundary of ['cookies','close','launch'] as const){
 test(`latest operator intent: delayed Return ${boundary} cannot clear or complete after a newer Takeover`,async()=>{
  const f=await ownershipFixture();let release:()=>void=()=>{};try{await f.open();
   // Healthy Return only saves cookies. Exercise close/launch on its cleanup/recovery paths.
   if(boundary==='close')f.caps.setBrowserGrant(f.agent.id,false);
   if(boundary==='launch')await f.browser.revoke(f.agent.id,'stop');
   const gate=f.hold(boundary);release=gate.release;const returning=f.browser.returnControl(f.agent.id);const returned=settledControls(returning);await gate.started;f.caps.setBrowserGrant(f.agent.id,true);const taken=f.browser.takeover(f.agent.id);assert.equal(f.browser.isHumanOwned(f.agent.id),true);await assert.rejects(f.browser.read(f.agent.id),/human control/);for(const enabled of [true,false])await assert.rejects(f.modelGrant(enabled),/human control/);release();const [old]=await returned,[latest]=await settledControls(taken);assert.equal(f.browser.isHumanOwned(f.agent.id),true);await assert.rejects(f.browser.read(f.agent.id),/human control/);for(const enabled of [true,false])await assert.rejects(f.modelGrant(enabled),/human control/);assert.equal(f.modes.at(-1),false);superseded(old);assert.equal(latest.status,'fulfilled');}finally{release();await f.close();}
 });
}
test('latest operator intent: Takeover then Return leaves bot control and rejects superseded Takeover',async()=>{
 const f=await ownershipFixture();try{await f.open();const taking=f.browser.takeover(f.agent.id),returning=f.browser.returnControl(f.agent.id);const outcomes=await settledControls(taking,returning);assert.equal(f.browser.isHumanOwned(f.agent.id),false);assert.equal(f.modes.at(-1),true);await f.browser.read(f.agent.id);superseded(outcomes[0]);assert.equal(outcomes[1].status,'fulfilled');}finally{await f.close();}
});
test('latest operator intent: delayed headed launch is closed before the newer Return takes control',async()=>{
 const f=await ownershipFixture();let release:()=>void=()=>{};try{await f.open();const gate=f.hold('launch');release=gate.release;const taking=f.browser.takeover(f.agent.id),taken=settledControls(taking);await gate.started;const abandoned=f.modes.length-1,returning=f.browser.returnControl(f.agent.id);release();const [old]=await taken,[latest]=await settledControls(returning);superseded(old);assert.equal(latest.status,'fulfilled');assert.ok(f.closed.includes(abandoned));assert.equal(f.browser.isHumanOwned(f.agent.id),false);assert.equal(f.modes.at(-1),true);await f.browser.read(f.agent.id);}finally{release();await f.close();}
});
test('latest operator intent: superseded Returns in a control sequence cannot erase the last Takeover',async()=>{
 const f=await ownershipFixture();try{await f.open();const controls=[f.browser.returnControl(f.agent.id),f.browser.takeover(f.agent.id),f.browser.returnControl(f.agent.id),f.browser.takeover(f.agent.id)];const outcomes=await settledControls(...controls);assert.equal(f.browser.isHumanOwned(f.agent.id),true);assert.equal(f.modes.at(-1),false);await assert.rejects(f.browser.read(f.agent.id),/human control/);outcomes.slice(0,-1).forEach(superseded);assert.equal(outcomes.at(-1)?.status,'fulfilled');}finally{await f.close();}
});
for(const boundary of ['cookies','launch'] as const)for(const reason of ['revoke','stop'] as const){
 test(`latest operator intent: ${reason}/regrant cancels a Return waiting on ${boundary} without clearing ownership`,async()=>{
  const f=await ownershipFixture();let release:()=>void=()=>{};try{await f.open();if(boundary==='launch')await f.browser.revoke(f.agent.id,'stop');const gate=f.hold(boundary);release=gate.release;const returning=f.browser.returnControl(f.agent.id),returned=settledControls(returning);await gate.started;f.caps.setBrowserGrant(f.agent.id,false);await f.browser.revoke(f.agent.id,reason);f.caps.setBrowserGrant(f.agent.id,true);release();const [old]=await returned;superseded(old);assert.equal(f.browser.isHumanOwned(f.agent.id),true);assert.equal(f.browser.statusSnapshot(f.agent.id).running,false);await assert.rejects(f.browser.read(f.agent.id),/human control/);}finally{release();await f.close();}
 });
}
