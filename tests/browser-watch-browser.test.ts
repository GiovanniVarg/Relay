import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium,type Page} from 'playwright';
import {createCanvas} from '@napi-rs/canvas';
import {png} from './fixtures/attachment-inputs.js';
const date='2026-11-03T12:00:00.000Z';
const jpeg=createCanvas(2,2).toBuffer('image/jpeg').toString('base64');
const agent={id:'a',name:'Watch bot',role:'Assistant',initials:'WB',color:'#657e70',instructions:'',memory:'',routeMode:'openai',model:'fixture',mode:'agent',workspace:'',pinned:false,unread:false,lastMessage:'',createdAt:date,updatedAt:date};
const other={...agent,id:'b',name:'Other bot'},conversation={id:'c',agentId:'a',title:'Original chat',createdAt:date,updatedAt:date},second={...conversation,id:'c2',title:'Second chat'},otherChat={...conversation,id:'d',agentId:'b'};
const provider={id:'openai',installed:true,authenticated:true,authMode:'subscription',models:[{id:'fixture',name:'Fixture',verified:true,inputModalities:['text','image']}],billing:{confirmed:true,mode:'included',automaticRouting:true},modelPreferences:{defaultModel:'fixture',allowedModels:null}};
function deferred(){let resolve!:()=>void;return {promise:new Promise<void>(done=>{resolve=done;}),resolve:()=>resolve()};}
const snapshot=(sessionId:string|null=null,overrides:Record<string,unknown>={})=>({granted:true,available:true,running:!!sessionId,humanControl:false,url:sessionId?'https://example.test/current':null,sessionId,...overrides});
function status(sequence=1,sessionId:string|null='s',agentId='a',overrides:Record<string,unknown>={}){return {type:'status',sequence,sessionId,agentId,observedAt:date,status:snapshot(sessionId,overrides)};}
function frame(sequence=2,sessionId='s',agentId='a'){return {type:'frame',sequence,sessionId,agentId,observedAt:date,capturedAt:new Date().toISOString(),url:'https://example.test/current',jpeg};}
async function emit(page:Page,index:number,event:unknown){await page.evaluate(({index,event})=>{(window as any).watchSources[index].onmessage?.({data:JSON.stringify(event)});},{index,event});}
async function countSources(page:Page,count:number){await page.waitForFunction(count=>{const w=window as any;for(const source of w.watchAllSources)if(!source.closed&&!w.watchSources.includes(source))w.watchSources.push(source);return w.watchSources.length===count;},count);}

async function fixture(mobile=false){
 const vite=await createServer({server:{port:0,host:'127.0.0.1'},logLevel:'error'});await vite.listen();
 const browser=await chromium.launch({headless:true,channel:process.env.RELAY_TEST_BROWSER_CHANNEL});const page=await browser.newPage({viewport:mobile?{width:390,height:844}:{width:1440,height:960}});
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>{
  localStorage.setItem('relay.agent','a');
  const timeout=window.setTimeout.bind(window);window.setTimeout=((fn:TimerHandler,ms?:number,...args:any[])=>timeout(fn,ms===2000||ms===1500?60:ms,...args)) as typeof setTimeout;
  (window as any).watchSources=[];(window as any).watchAllSources=[];
  (window as any).EventSource=class{onopen:any;onmessage:any;onerror:any;closed=false;handlers=new Map();constructor(public url:string){if(url.startsWith('/api/browser/'))(window as any).watchAllSources.push(this);queueMicrotask(()=>this.onopen?.());}addEventListener(type:string,fn:any){this.handlers.set(type,fn);}close(){this.closed=true;}};
 });
 const state={a:snapshot(),b:snapshot(),stopStatus:202,holdStop:null as ReturnType<typeof deferred>|null,stopStarted:deferred(),holdPoll:null as {started:ReturnType<typeof deferred>;release:ReturnType<typeof deferred>;value:unknown}|null,pollReads:0};
 const posts:{path:string;csrf:string|undefined}[]=[];
 await page.route('**/api/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname.slice(4);let value:any={},code=200;
  if(req.method()==='POST')posts.push({path,csrf:req.headers()['x-csrf-token']});
  if(path==='/bootstrap')value={csrfToken:'synthetic-csrf',version:'test',agents:[agent,other],conversations:[conversation,second,otherChat],rooms:[{id:'group',title:'Fixture group',agentIds:['a','b'],mode:'round-robin',createdAt:date,updatedAt:date}],providers:[provider],settings:{maxRunSeconds:60,maxModelCalls:5}};
  else if(path==='/providers/refresh')value={providers:[provider]};
  else if(path==='/agents/a')value={agent,conversations:[conversation,second],files:[]};
  else if(path==='/agents/b')value={agent:other,conversations:[otherChat],files:[]};
  else if(path.startsWith('/conversations/')&&!path.endsWith('/attachments'))value={conversation:path==='/conversations/d'?otherChat:path==='/conversations/c2'?second:conversation,messages:[],runs:[]};
  else if(path.endsWith('/attachments')&&req.method()==='POST'){value={id:'image',name:req.postDataJSON().name,kind:'image',mimeType:'image/png',size:png().length,sha256:'fixture',width:2,height:2};code=201;}
  else if(path.endsWith('/attachments'))value=[];
  else if(path==='/capabilities/a/browser'||path==='/capabilities/b/browser'){
   state.pollReads++;value={grant:{enabled:true},status:path.includes('/a/')?state.a:state.b};
   const held=state.holdPoll;if(held&&path.includes('/a/')){state.holdPoll=null;held.started.resolve();await held.release.promise;value={grant:{enabled:true},status:held.value};}
  }
  else if(path.endsWith('/stop')){state.stopStarted.resolve();if(state.holdStop)await state.holdStop.promise;code=state.stopStatus;value=code===202?{status:'stop_requested',browser:state.a}:{status:'stop_unconfirmed',error:'Synthetic cancellation uncertainty',browser:state.a,reasons:['synthetic']};}
  else if(path.endsWith('/takeover')||path.endsWith('/return'))value=state.a;
  else if(path==='/tasks')value={tasks:[]};
  else if(path==='/health')value={service:'relay',ok:true,instanceId:'fixture'};
  else if(path.startsWith('/groups/'))value={room:{id:'group',title:'Fixture group',agentIds:['a','b'],mode:'roundtable'},messages:[],runs:[]};
  await route.fulfill({status:code,json:value});
 });
 await page.goto(vite.resolvedUrls!.local[0]);await page.getByRole('textbox',{name:'Message Watch bot',exact:true}).waitFor();
 return {page,state,posts,errors,async close(){await browser.close();await vite.close();}};
}

test('mounted browser viewer keeps composer, validates frames, isolates retries and reports controls honestly',{timeout:45000,skip:process.env.RELAY_BROWSER_LIVE!=='1'},async()=>{
 const f=await fixture();const {page,state}=f;
 try{
  await page.waitForTimeout(90);assert.equal(await page.evaluate(()=>(window as any).watchSources.length),0);
  const composer=page.getByRole('textbox',{name:'Message Watch bot',exact:true});await composer.fill('Keep this draft');await composer.evaluate(el=>(el as any).identity='original');
  await page.getByLabel('Message attachment files').setInputFiles({name:'draft.png',mimeType:'image/png',buffer:png()});await page.getByRole('link',{name:'draft.png',exact:true}).waitFor();
  await page.getByRole('button',{name:'Open bot browser',exact:true}).click();await countSources(page,1);await emit(page,0,frame());assert.equal(await page.locator('.browser-preview-image img').count(),0);
  await emit(page,0,status());await emit(page,0,frame());await page.locator('.browser-preview-image img').waitFor();
  await page.waitForFunction(()=>document.querySelector<HTMLImageElement>('.browser-preview-image img')?.naturalWidth===2);
  await emit(page,0,{...frame(3),capturedAt:'2020-01-01T00:00:00.000Z'});await page.getByText('Preview stale',{exact:true}).waitFor();
  await emit(page,0,frame(4,'wrong'));await emit(page,0,frame(4,'s','b'));assert.equal(await page.locator('.browser-preview-image img').count(),1);
  await emit(page,0,status(4,'new','a',{url:'https://example.test/new'}));assert.equal(await page.locator('.browser-preview-image img').count(),0);
  await emit(page,0,frame(5));assert.equal(await page.locator('.browser-preview-image img').count(),0);await emit(page,0,frame(6,'new'));
  await page.evaluate(()=>(window as any).watchSources[0].onerror());assert.equal(await page.locator('.browser-preview-image img').count(),0);await countSources(page,2);
  await emit(page,0,frame(100,'new'));await emit(page,1,frame(2,'new'));assert.equal(await page.locator('.browser-preview-image img').count(),0);await emit(page,1,status(1,'new'));await emit(page,1,frame(2,'new'));await page.locator('.browser-preview-image img').waitFor();
  await page.getByRole('button',{name:'Stop bot',exact:true}).click();await page.getByText('Stop requested',{exact:true}).waitFor();state.stopStatus=409;
  await page.getByRole('button',{name:'Stop bot',exact:true}).click();await page.getByText('Could not confirm stop',{exact:true}).waitFor();assert.equal(await page.locator('.browser-panel').getByText('Stopped',{exact:true}).count(),0);
  await page.getByRole('button',{name:'Take over',exact:true}).click();await page.getByText('Takeover requested',{exact:true}).waitFor();
  await emit(page,1,status(3,'new','a',{granted:false,humanControl:true}));await page.getByText('You have control',{exact:true}).first().waitFor();await page.getByRole('button',{name:'Return control',exact:true}).click();await page.getByText('Return requested',{exact:true}).waitFor();
  state.a=snapshot('new');await page.getByRole('button',{name:'Close browser preview',exact:true}).click();assert.equal(await composer.inputValue(),'Keep this draft');assert.equal(await composer.evaluate(el=>(el as any).identity),'original');assert.equal(await page.getByRole('link',{name:'draft.png',exact:true}).count(),1);
  await emit(page,1,status(100,'evil'));await page.waitForTimeout(160);assert.equal(await page.locator('.browser-panel').count(),0);assert.ok(await page.evaluate(()=>(window as any).watchSources.every((source:any)=>source.closed)));
  // The same bot's different conversation keeps session dismissal.
  await page.getByRole('button',{name:'Chat options',exact:true}).click();await page.getByRole('button',{name:'Chat history',exact:true}).click();await page.getByRole('button').filter({hasText:'Second chat'}).click();await page.waitForTimeout(100);assert.equal(await page.locator('.browser-panel').count(),0);
  await composer.focus();state.a=snapshot('fresh');await page.locator('.browser-panel').waitFor();assert.equal(await composer.evaluate(el=>el===document.activeElement),true);await countSources(page,3);await emit(page,2,status(1,'fresh'));await emit(page,2,frame(2,'fresh'));
  state.holdStop=deferred();state.stopStarted=deferred();await page.getByRole('button',{name:'Stop bot',exact:true}).click();await state.stopStarted.promise;
  await page.locator('.agent-row').filter({hasText:'Other bot'}).click();await page.getByRole('textbox',{name:'Message Other bot',exact:true}).waitFor();assert.equal(await page.locator('.browser-preview-image img').count(),0);
  await page.getByRole('button',{name:'Open bot browser',exact:true}).click();await countSources(page,4);await emit(page,3,status(1,'b-session','b'));state.holdStop.resolve();await page.waitForTimeout(80);assert.equal(await page.getByText('Could not confirm stop',{exact:true}).count(),0);
  assert.ok(f.posts.filter(post=>/^\/browser\//.test(post.path)).every(post=>post.csrf==='synthetic-csrf'));assert.equal(f.posts.some(post=>/\/grant|\/open|\/navigate|\/messages/.test(post.path)),false);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('hidden discovery discards a late bot poll; mobile stays manual, fits and traps only its own drawer',{timeout:30000,skip:process.env.RELAY_BROWSER_LIVE!=='1'},async()=>{
 const f=await fixture(true);const {page,state}=f;
 try{
  state.a=snapshot('mobile-session');await page.locator('.browser-activity-dot').waitFor();assert.equal(await page.locator('.browser-panel').count(),0);
  const composer=page.getByRole('textbox',{name:'Message Watch bot',exact:true});await composer.fill('Mobile draft');await page.getByRole('button',{name:'Open bot browser',exact:true}).click();await countSources(page,1);await emit(page,0,status(1,'mobile-session'));
  assert.equal(await page.getByRole('dialog',{name:'Watch bot browser',exact:true}).count(),1);assert.equal(await page.getByRole('button',{name:'Close browser preview',exact:true}).evaluate(el=>el===document.activeElement),true);
  await emit(page,0,status(2,'mobile-session','a',{url:'https://example.test/'+ 'path'.repeat(1000)}));
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=390));
  await page.keyboard.press('Shift+Tab');assert.equal(await page.getByRole('button',{name:'Take over',exact:true}).evaluate(el=>el===document.activeElement),true);
  await page.keyboard.press('Escape');assert.equal(await page.locator('.browser-panel').count(),0);assert.equal(await composer.inputValue(),'Mobile draft');assert.equal(await page.getByRole('button',{name:'Open bot browser',exact:true}).evaluate(el=>el===document.activeElement),true);
  const held={started:deferred(),release:deferred(),value:snapshot('late-a')};state.holdPoll=held;await held.started.promise;
  await page.getByRole('button',{name:'Open agent roster',exact:true}).click();await page.locator('.agent-row').filter({hasText:'Other bot'}).click();await page.getByRole('textbox',{name:'Message Other bot',exact:true}).waitFor();held.release.resolve();await page.waitForTimeout(100);assert.equal(await page.locator('.browser-activity-dot').count(),0);
  await page.getByRole('button',{name:'Open agent roster',exact:true}).click();await page.locator('.discussion-room-row').filter({hasText:'Fixture group'}).click();assert.equal(await page.getByRole('button',{name:'Open bot browser',exact:true}).count(),0);assert.equal(await page.locator('.browser-panel').count(),0);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

for(const reply of [202,409])test(`pending Stop survives browser retirement before HTTP ${reply}`,{timeout:30000,skip:process.env.RELAY_BROWSER_LIVE!=='1'},async()=>{
 const f=await fixture();const {page,state}=f;
 try{
  await page.getByRole('button',{name:'Open bot browser',exact:true}).click();await countSources(page,1);await emit(page,0,status());await emit(page,0,frame());
  state.stopStatus=reply;state.holdStop=deferred();state.stopStarted=deferred();
  await page.getByRole('button',{name:'Stop bot',exact:true}).click();await state.stopStarted.promise;
  await emit(page,0,{type:'clear',agentId:'a',sessionId:'s',sequence:3,observedAt:date,reason:'session_closed'});await emit(page,0,status(4,null,'a'));
  const stop=page.locator('.browser-panel-controls button').first();assert.equal(await stop.textContent(),'Requesting stop…','browser closure must not clear an unresolved Stop');assert.equal(await stop.isDisabled(),true,'browser closure must not re-enable an unresolved Stop');
  assert.equal(await page.locator('.browser-preview-image img').count(),0);assert.equal(await page.getByLabel('Current browser URL').textContent(),'No page open');
  if(reply===409){await emit(page,0,status(5,'replacement'));assert.equal(await page.getByRole('button',{name:'Requesting stop…',exact:true}).isDisabled(),true,'a new session must not silently discard an active uncertain Stop');}
  state.holdStop.resolve();await page.getByText(reply===202?'Stop requested':'Could not confirm stop',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Stop bot',exact:true}).isEnabled(),true);assert.equal(f.posts.filter(post=>post.path==='/browser/a/stop').length,1);
  assert.equal(await page.locator('.browser-preview-image img').count(),0,'an HTTP control result cannot restore pixels');assert.equal(await page.locator('.browser-panel').getByText('Stopped',{exact:true}).count(),0);
  if(reply===202){await emit(page,0,status(5,null,'a'));assert.equal(await page.getByText('Stop requested',{exact:true}).count(),1,'expected null-session retirement keeps the acknowledgement');}
  assert.deepEqual(f.errors,[]);
 }finally{state.holdStop?.resolve();await f.close();}
});

test('a late Stop error cannot cross panel close and reopen or runtime disconnect',{timeout:30000,skip:process.env.RELAY_BROWSER_LIVE!=='1'},async()=>{
 const f=await fixture();const {page,state}=f;
 try{
  await page.getByRole('button',{name:'Open bot browser',exact:true}).click();await countSources(page,1);await emit(page,0,status());
  state.stopStatus=409;state.holdStop=deferred();state.stopStarted=deferred();
  await page.getByRole('button',{name:'Stop bot',exact:true}).click();await state.stopStarted.promise;
  await emit(page,0,{type:'clear',agentId:'a',sessionId:'s',sequence:2,observedAt:date,reason:'session_closed'});await emit(page,0,status(3,null,'a'));
  await page.getByRole('button',{name:'Close browser preview',exact:true}).click();await page.getByRole('button',{name:'Open bot browser',exact:true}).click();await countSources(page,2);await emit(page,1,status(1,'reopened'));
  state.holdStop.resolve();await page.waitForTimeout(100);assert.equal(await page.getByText('Could not confirm stop',{exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'Stop bot',exact:true}).isEnabled(),true);
  state.holdStop=deferred();state.stopStarted=deferred();await page.getByRole('button',{name:'Stop bot',exact:true}).click();await state.stopStarted.promise;
  await page.evaluate(()=>window.dispatchEvent(new Event('relay:runtime-disconnected')));state.holdStop.resolve();await page.waitForTimeout(100);
  assert.equal(await page.getByText('Could not confirm stop',{exact:true}).count(),0);assert.equal(await page.locator('.browser-preview-image img').count(),0);assert.equal(await page.locator('.browser-preview-state').textContent(),'Disconnected');assert.deepEqual(f.errors,[]);
 }finally{state.holdStop?.resolve();await f.close();}
});

for(const initialMobile of [true,false])test(`open preview reconciles focus on resize ${initialMobile?'mobile to desktop':'desktop to mobile'}`,{timeout:30000,skip:process.env.RELAY_BROWSER_LIVE!=='1'},async()=>{
 const f=await fixture(initialMobile);const {page}=f;
 try{
  const composer=page.getByRole('textbox',{name:'Message Watch bot',exact:true});await composer.fill('Resize draft');await composer.evaluate(el=>(el as any).identity='resize-composer');
  await page.getByLabel('Message attachment files').setInputFiles({name:'resize.png',mimeType:'image/png',buffer:png()});await page.getByRole('link',{name:'resize.png',exact:true}).waitFor();
  await page.getByRole('button',{name:'Open bot browser',exact:true}).click();await countSources(page,1);await emit(page,0,status());await emit(page,0,frame());
  const panel=page.locator('.browser-panel'),close=page.getByRole('button',{name:'Close browser preview',exact:true});await panel.evaluate(el=>(el as any).identity='resize-panel');
  const sources=await page.evaluate(()=>(window as any).watchAllSources.length);
  if(initialMobile){
   assert.equal(await close.evaluate(el=>el===document.activeElement),true);await page.setViewportSize({width:1440,height:960});await page.waitForFunction(()=>!document.querySelector('.browser-panel')?.hasAttribute('aria-modal'));
   await composer.focus();assert.equal(await composer.evaluate(el=>el===document.activeElement),true);await page.keyboard.type(' plus typing');assert.equal(await composer.inputValue(),'Resize draft plus typing');
   await page.keyboard.press('Escape');assert.equal(await panel.count(),1,'desktop composer Escape does not close a separate preview');
  }else{
   await composer.focus();assert.equal(await composer.evaluate(el=>el===document.activeElement),true);await page.setViewportSize({width:390,height:844});await page.getByRole('dialog',{name:'Watch bot browser',exact:true}).waitFor();
   await page.waitForFunction(()=>document.querySelector('.browser-panel')?.contains(document.activeElement));assert.equal(await close.evaluate(el=>el===document.activeElement),true);
   await composer.focus();assert.equal(await panel.evaluate(el=>el.contains(document.activeElement)),true,'new mobile modal owns focus');await page.keyboard.press('Shift+Tab');assert.equal(await page.getByRole('button',{name:'Take over',exact:true}).evaluate(el=>el===document.activeElement),true);
  }
  assert.equal(await panel.evaluate(el=>(el as any).identity),'resize-panel');assert.equal(await composer.evaluate(el=>(el as any).identity),'resize-composer');assert.equal(await page.evaluate(()=>(window as any).watchAllSources.length),sources,'resize must not reconnect observation');assert.equal(await page.getByRole('link',{name:'resize.png',exact:true}).count(),1);
  if(initialMobile)await close.click();else await page.keyboard.press('Escape');assert.equal(await panel.count(),0);await page.waitForFunction(()=>document.querySelector('.browser-toggle')===document.activeElement);assert.equal(await composer.inputValue(),initialMobile?'Resize draft plus typing':'Resize draft');assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
