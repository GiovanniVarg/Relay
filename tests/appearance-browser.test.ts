import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createServer} from 'vite';
import {chromium,type Page,type Browser,type Locator} from 'playwright';

// Mounted App only. Every API request and SSE feed is synthetic; unknown APIs fail.
const enabled=process.env.RELAY_BROWSER_LIVE==='1';
const date='2026-11-13T12:00:00Z';
const agent={id:'a',name:'Mira',role:'Assistant',initials:'M',color:'#657e70',instructions:'',memory:'',routeMode:'openai',model:'fixture',mode:'agent',workspace:'C:\\fixture',pinned:false,unread:false,lastMessage:'',createdAt:date,updatedAt:date};
const other={...agent,id:'b',name:'Sol'};
const conversation={id:'c',agentId:'a',title:'Appearance fixture',createdAt:date,updatedAt:date};
const room={id:'g',title:'Studio',agentIds:['a','b'],mode:'roundtable',moderatorAgentId:null,createdAt:date,updatedAt:date};
const provider={id:'openai',installed:true,authenticated:true,authMode:'subscription',models:[{id:'fixture',name:'Fixture',verified:true,inputModalities:['text','image']}],billing:{confirmed:true,mode:'included',automaticRouting:true,allowanceNote:''},modelPreferences:{defaultModel:'fixture',allowedModels:null}};
const content='## Quiet radiance\n\nReadable **answers** and a [reference](https://example.test/reference).\n\n| State | Result |\n| --- | --- |\n| Ready | Complete |\n\n```typescript\nconst longLine = "'+ 'readable_'.repeat(32)+'";\n```\n\n> A useful note.';
const messages=[{id:'user',conversationId:'c',role:'user',content:'Please review this appearance.',status:'complete',createdAt:date},{id:'answer',conversationId:'c',role:'assistant',content,status:'complete',createdAt:date},{id:'error',conversationId:'c',role:'assistant',content:'Fixture failure: please retry.',status:'error',createdAt:date}];
const session={id:'appearance-terminal',shellId:'cmd',shellLabel:'Command Prompt',cwd:'C:\\fixture',context:'Mira',state:'live',cols:80,rows:24,sequence:0};
type Preference='light'|'dark'|'system';
const evidence='.data-ui-preview/quiet-radiance';

async function fixture(browser:Browser,url:string,options:{appearance?:Preference;cache?:string;blocked?:boolean;system?:'light'|'dark';holdBootstrap?:boolean;successOnly?:boolean}={}){
 const context=await browser.newContext({viewport:{width:1440,height:1000},colorScheme:options.system??'light'}),page=await context.newPage();
 const state={appearance:options.appearance??'light' as Preference,failSave:false,disconnected:false,startCount:0,currentSession:null as any,unexpected:[] as string[],errors:[] as string[],bootstrapHeld:options.holdBootstrap??false};
 let release!:()=>void;const bootstrapGate=new Promise<void>(resolve=>release=resolve);
 page.on('pageerror',error=>state.errors.push(error.message));
 await page.addInitScript(({cache,blocked,session})=>{
  (window as any).__name=(value:unknown)=>value; // tsx keepNames helper for serialized Playwright callbacks.
  // Seed once per browser context, never overwrite the saved value on reload.
  if(!sessionStorage.getItem('appearance-fixture-seeded')){localStorage.setItem('relay.agent','a');localStorage.setItem('relay.advanced','false');if(cache!==undefined)localStorage.setItem('relay.appearance',cache);sessionStorage.setItem('appearance-fixture-seeded','true');}
  if(blocked){const originalGet=Storage.prototype.getItem,originalSet=Storage.prototype.setItem;Storage.prototype.getItem=function(key){if(key==='relay.appearance')throw new DOMException('Blocked','SecurityError');return originalGet.call(this,key);};Storage.prototype.setItem=function(key,value){if(key==='relay.appearance')throw new DOMException('Blocked','SecurityError');return originalSet.call(this,key,value);};}
  (window as any).fixtureSources=[];
  (window as any).EventSource=class{onopen:any;onmessage:any;onerror:any;closed=false;handlers=new Map();constructor(public url:string){(window as any).fixtureSources.push(this);queueMicrotask(()=>{this.onopen?.();if(url.startsWith('/api/terminal/'))this.onmessage?.({data:JSON.stringify({type:'status',session,leaseId:'fixture-lease',nextInputSequence:1})});});}addEventListener(type:string,fn:any){this.handlers.set(type,fn);}close(){this.closed=true;}};
 },{cache:options.cache,blocked:options.blocked??false,session});
 await page.route('**/api/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname.slice(4),method=req.method();let value:any,status=200;
  if(path==='/bootstrap'){if(state.bootstrapHeld)await bootstrapGate;value={csrfToken:'fixture-csrf',version:'fixture',homeDirectory:'C:\\fixture',agents:[agent,other],conversations:[conversation],rooms:[room],providers:[provider],settings:{appearance:state.appearance,maxRunSeconds:60,maxModelCalls:3}};}
  else if(path==='/settings'&&method==='PATCH'){if(state.failSave){status=500;value={error:'Synthetic appearance save failed'};}else{state.appearance=req.postDataJSON().appearance??state.appearance;value={appearance:state.appearance,maxRunSeconds:60,maxModelCalls:3};}}
  else if(path==='/providers/refresh')value={providers:[provider]};
  else if(path==='/providers/openai/login')value={status:'pending',message:'Sign in using your provider account.',url:'https://auth.openai.com/fixture',command:'fixture sign-in'};
  else if(path==='/agents/a')value={agent,conversations:[conversation],files:[],telegram:{configured:false,enabled:false,running:false}};
  else if(path==='/conversations/c')value={conversation,messages:options.successOnly?messages.filter(message=>message.status!=='error'):messages,runs:[]};
  else if(path==='/conversations/c/attachments')value=[];
  else if(path==='/groups/g')value={room,messages:[{id:'group-answer',roomId:'g',agentId:'a',role:'assistant',authorName:'Mira',content,status:'complete',createdAt:date}],runs:[]};
  else if(path==='/groups/g/attachments'||path==='/groups//attachments')value=[];
  else if(method==='GET'&&/^\/dispatcher\/drafts\/[0-9a-f-]{36}\/attachments$/.test(path))value=[];
  else if(path==='/tasks')value={tasks:[]};
  else if(path==='/health'){if(state.disconnected){status=503;value={error:'Synthetic disconnection'};}else value={service:'relay',ok:true,instanceId:'fixture'};}
  else if(path==='/capabilities/a/browser')value={grant:{enabled:true},status:{granted:true,available:true,running:false,humanControl:false,url:null,sessionId:null}};
  else if(path==='/workspace')value={tasks:[],capabilities:[],routing:{usage:{costNote:'Provider cost unknown',sessions:[],dispatches:[]},reportedAllowance:[],availability:[],recent:[]},artifacts:[],knowledge:[],operation:{node:'fixture',installDirectory:'fixture',dataDirectory:'fixture'}};
  else if(path==='/mcp')value={connections:[]};
  else if(path==='/harness')value={changes:[],activation:null};
  else if(path==='/integrations/typesafe')value={configured:false,enabled:false,models:[],storage:{available:true}};
  else if(path==='/integrations/typesafe/credential-request')value={nonce:'fixture-nonce',expiresAt:new Date(Date.now()+600000).toISOString()};
  else if(path==='/herdr')value={configured:false,enabled:false};
  else if(path==='/terminal/shells')value={platform:'win32',engine:'ready',shells:[{id:'cmd',label:'Command Prompt'}]};
  else if(path==='/terminal')value={session:state.currentSession};
  else if(path==='/terminal/start'){state.startCount++;state.currentSession=session;value={session};status=201;}
  else if(path==='/terminal/appearance-terminal/resize')value={session:{...session,...req.postDataJSON()}};
  else if(path==='/terminal/appearance-terminal/input')value={nextInputSequence:req.postDataJSON().sequence+1};
  else if(/^\/runs\/[^/]+\/interactions$/.test(path))value={interactions:[]};
  else {state.unexpected.push(`${method} ${path}`);status=501;value={error:`Unexpected synthetic API ${method} ${path}`};}
  await route.fulfill({status,json:value});
 });
 return {page,state,release(){state.bootstrapHeld=false;release();},async open(){await page.goto(url);await page.getByRole('textbox',{name:'Message Mira',exact:true}).waitFor();},async close(){release();await context.close();}};
}
async function namedClick(page:Page,name:string){const target=page.getByRole('button',{name,exact:true});if(await page.getByRole('button',{name:/^Open (agent|workspace) roster$/}).isVisible()&&!(await page.locator('.roster').evaluate(el=>el.classList.contains('mobile-open'))))await page.getByRole('button',{name:/^Open (agent|workspace) roster$/}).click();await target.click();}
async function closeModal(page:Page){await page.getByRole('dialog').getByRole('button',{name:'Close dialog',exact:true}).click();if(await page.locator('.roster.mobile-open').count())await page.getByRole('button',{name:'Close workspace navigation',exact:true}).click();}
async function geometry(page:Page,label:string,targets:Locator[]=[]){
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${label}: page overflow`);
 for(const target of targets){await target.scrollIntoViewIfNeeded();const box=await target.boundingBox();assert.ok(box&&box.width>0&&box.height>0,`${label}: missing target`);assert.ok(box.x>=-1&&box.x+box.width<=page.viewportSize()!.width+1,`${label}: unreachable horizontal action ${await target.getAttribute('aria-label')??await target.innerText()}`);assert.ok(box.y>=-1&&box.y+box.height<=page.viewportSize()!.height+1,`${label}: unreachable vertical action`);}
}
// Composite alpha from the element through its ancestors, then compare actual text.
async function contrast(locator:Locator,label:string,minimum=4.5,property="color"){
 const ratio=await locator.evaluate((el,property)=>{const rgba=(s:string)=>{const v=s.match(/[\d.]+/g)?.map(Number)??[];return [v[0]??0,v[1]??0,v[2]??0,v[3]??1];};const over=(f:number[],b:number[])=>{const a=f[3]+b[3]*(1-f[3]);return [0,1,2].map(i=>(f[i]*f[3]+b[i]*b[3]*(1-f[3]))/a).concat(a);};let background=[255,255,255,1];const chain:Element[]=[];for(let node:Element|null=el;node;node=node.parentElement)chain.unshift(node);for(const node of chain)background=over(rgba(getComputedStyle(node).backgroundColor),background);const fg=over(rgba(getComputedStyle(el).getPropertyValue(property)),background);const lum=(c:number[])=>c.slice(0,3).map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;}).reduce((sum,x,i)=>sum+x*[.2126,.7152,.0722][i],0);return (Math.max(lum(fg),lum(background))+.05)/(Math.min(lum(fg),lum(background))+.05);},property);
 assert.ok(ratio>=minimum,`${label}: contrast ${ratio.toFixed(2)} < ${minimum}`);return ratio;
}
async function screenshot(page:Page,label:string,width:number){if(width===320||width===1440){await mkdir(evidence,{recursive:true});await page.screenshot({path:`${evidence}/${label}-${width}.png`,fullPage:true});}}
async function resolved(page:Page,theme:string){await page.waitForFunction(theme=>document.documentElement.dataset.theme===theme,theme);assert.equal(await page.locator('html').evaluate(el=>getComputedStyle(el).colorScheme),theme);}

test('supplemental advanced limits, integrations, disconnected states and roster fit',{skip:!enabled,timeout:90000},async()=>{
 const vite=await createServer({server:{port:0,host:'127.0.0.1'},logLevel:'error'});let browser:Browser|undefined;
 try{await vite.listen();browser=await chromium.launch({headless:true,channel:process.env.RELAY_TEST_BROWSER_CHANNEL});
  for(const theme of ['light','dark'] as const){const f=await fixture(browser,vite.resolvedUrls!.local[0],{appearance:theme,successOnly:true});const {page}=f;try{await f.open();await page.getByRole('heading',{name:'Quiet radiance',exact:true}).waitFor();await mkdir(evidence,{recursive:true});await page.screenshot({path:`${evidence}/preview-${theme}.png`,fullPage:true});
   await page.setViewportSize({width:320,height:1000});await page.getByRole('button',{name:/^Open (agent|workspace) roster$/}).click();await page.waitForFunction(()=>document.querySelector('.roster')!.getBoundingClientRect().left>=-.1);const rosterBox=await page.locator('.roster').boundingBox();assert.ok(rosterBox);
   for(const button of await page.locator('.brand-row button:visible').all()){const box=await button.boundingBox();assert.ok(box);assert.ok(box.x>=rosterBox.x-1&&box.x+box.width<=rosterBox.x+rosterBox.width+1,`320 roster header control is outside roster: ${await button.getAttribute('aria-label')}`);assert.ok(box.width>=44&&box.height>=44,'mobile roster controls preserve 44px touch targets');}
   await page.getByRole('button',{name:'Close workspace navigation',exact:true}).click();await page.evaluate(()=>localStorage.setItem('relay.advanced','true'));await page.reload();await page.getByRole('textbox',{name:'Message Mira',exact:true}).waitFor();
   for(const width of [320,1440]){await page.setViewportSize({width,height:1000});await namedClick(page,'Settings');await page.getByRole('button',{name:'Integrations',exact:true}).click();await page.getByRole('heading',{name:'Herdr workers',exact:true}).waitFor();await geometry(page,`${theme}/integrations/${width}`,[page.getByRole('button',{name:'Check again',exact:true})]);await contrast(page.locator('.herdr-status-heading strong'),'integration disconnected status');await screenshot(page,`${theme}-integrations`,width);await page.getByRole('button',{name:'Run limits',exact:true}).click();await geometry(page,`${theme}/run-limits/${width}`,[page.getByRole('spinbutton',{name:/^Maximum chat run time/}),page.getByRole('button',{name:'Save run limits',exact:true})]);await screenshot(page,`${theme}-run-limits`,width);await closeModal(page);}
   f.state.disconnected=true;await page.locator('.runtime-connection').waitFor();for(const width of [320,1440]){await page.setViewportSize({width,height:1000});await geometry(page,`${theme}/disconnected/${width}`);await contrast(page.locator('.runtime-connection'),'runtime disconnected status');await screenshot(page,`${theme}-disconnected`,width);}assert.deepEqual(f.state.unexpected,[]);assert.deepEqual(f.state.errors,[]);
  }finally{await f.close();}}
 }finally{await browser?.close();await vite.close();}
});

test('mounted App appearance surface matrix uses strict synthetic APIs',{skip:!enabled,timeout:240000},async()=>{
 const vite=await createServer({server:{port:0,host:'127.0.0.1'},logLevel:'error'});let browser:Browser|undefined;const audit:any[]=[];
 try{await vite.listen();browser=await chromium.launch({headless:true,channel:process.env.RELAY_TEST_BROWSER_CHANNEL});
  for(const theme of ['light','dark'] as const){const f=await fixture(browser,vite.resolvedUrls!.local[0],{appearance:theme,cache:theme});const {page}=f;
   try{await f.open();await resolved(page,theme);
    for(const width of [320,375,414,768,1440]){await page.setViewportSize({width,height:1000});
     await page.getByRole('heading',{name:'Quiet radiance',exact:true}).waitFor();await geometry(page,`${theme}/chat/${width}`,[page.getByRole('textbox',{name:'Message Mira',exact:true}),page.getByRole('button',{name:'Chat options',exact:true})]);
     const composer=page.getByRole('textbox',{name:'Message Mira',exact:true});await composer.focus();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');assert.equal(await composer.evaluate(el=>el===document.activeElement),true);assert.equal(await composer.evaluate(el=>el.matches(':focus-visible')),true);assert.ok(await composer.evaluate(el=>{return [el,el.closest('.composer')].filter(Boolean).some(node=>{const s=getComputedStyle(node!);return s.outlineStyle!=='none'&&parseFloat(s.outlineWidth)>0||s.boxShadow!=='none';});}),'keyboard focus has a visible indicator');
     await contrast(page.locator('#message-c-answer pre code'),'code text');await contrast(page.locator('#message-c-answer td').first(),'table text');
     audit.push({theme,width,surface:'chat',text:await contrast(page.locator('#message-c-answer .rich-text p').first(),'chat text'),link:await contrast(page.locator('#message-c-answer a'),'chat link'),error:await contrast(page.locator('#message-c-error .message-bubble'),'error text')});await screenshot(page,`${theme}-chat`,width);
     await page.getByRole('button',{name:'Chat options',exact:true}).click();await page.getByRole('button',{name:'Edit bot',exact:true}).click();await page.getByLabel('Name',{exact:true}).waitFor();await page.getByText('Advanced options',{exact:true}).click();const token=page.getByLabel('Bot token',{exact:true});await token.waitFor();await geometry(page,`${theme}/edit/${width}`,[token,page.getByRole('button',{name:'Save changes',exact:true})]);await contrast(token,'Telegram credential');await screenshot(page,`${theme}-edit-secure`,width);await closeModal(page);
     await namedClick(page,'Create bot');await geometry(page,`${theme}/create/${width}`,[page.getByLabel('Instructions',{exact:true}),page.getByRole('dialog').getByRole('button',{name:'Create bot',exact:true})]);await screenshot(page,`${theme}-create`,width);await closeModal(page);
     await namedClick(page,'Settings');await page.getByRole('combobox',{name:'Appearance',exact:true}).waitFor();await geometry(page,`${theme}/settings/${width}`,[page.getByRole('combobox',{name:'Appearance',exact:true})]);await page.getByRole('button',{name:'Account sign-in options',exact:true}).click();await page.getByText('Sign in using your provider account.',{exact:true}).waitFor();await screenshot(page,`${theme}-settings-login`,width);await page.getByLabel('TypeSafe API key',{exact:true}).waitFor();await geometry(page,`${theme}/typesafe/${width}`,[page.getByLabel('TypeSafe API key',{exact:true})]);await contrast(page.getByLabel('TypeSafe API key',{exact:true}),'TypeSafe credential');await screenshot(page,`${theme}-typesafe`,width);await closeModal(page);
     await namedClick(page,'Tasks & workspace');await page.getByRole('heading',{name:'Your workspace',exact:true}).waitFor();await geometry(page,`${theme}/workspace/${width}`,[page.getByRole('button',{name:'New task',exact:true})]);await screenshot(page,`${theme}-workspace`,width);await page.getByRole('button',{name:'Connections',exact:true}).click();await page.getByRole('button',{name:'Connect tool',exact:true}).click();await page.getByText('Authentication',{exact:true}).click();await geometry(page,`${theme}/connections/${width}`,[page.getByLabel('Bearer credential (optional)',{exact:true})]);await screenshot(page,`${theme}-connections-secure`,width);await page.getByRole('button',{name:'Change Relay',exact:true}).click();await page.getByRole('heading',{name:'Your harness can keep getting better.',exact:true}).waitFor();await geometry(page,`${theme}/change-relay/${width}`,[page.getByRole('button',{name:'New change',exact:true})]);await screenshot(page,`${theme}-change-relay`,width);await page.getByRole('button',{name:'Chats',exact:true}).click();
     await namedClick(page,'Boss Chat');await page.getByRole('textbox',{name:'Message Boss Chat',exact:true}).waitFor();await geometry(page,`${theme}/boss/${width}`,[page.getByRole('textbox',{name:'Message Boss Chat',exact:true})]);await screenshot(page,`${theme}-boss`,width);
     if(width<=768){const opener=page.getByRole('button',{name:/^Open (agent|workspace) roster$/});await opener.focus();await page.keyboard.press('Enter');await page.keyboard.press('Escape');assert.equal(await opener.evaluate(el=>el===document.activeElement),true);}
     if(width<=768)await page.getByRole('button',{name:/^Open (agent|workspace) roster$/}).click();await page.locator('.discussion-room-row').filter({hasText:'Studio'}).click();await page.getByRole('textbox',{name:'Discussion topic or follow-up'}).waitFor();await geometry(page,`${theme}/group/${width}`,[page.getByRole('textbox',{name:'Discussion topic or follow-up'})]);await screenshot(page,`${theme}-group`,width);
     if(width<=768)await page.getByRole('button',{name:/^Open (agent|workspace) roster$/}).click();await page.locator('.agent-row').filter({hasText:'Mira'}).click();await page.getByRole('textbox',{name:'Message Mira',exact:true}).waitFor();await page.getByRole('button',{name:'Open bot browser',exact:true}).click();await page.locator('.browser-panel').waitFor();await geometry(page,`${theme}/browser/${width}`,[page.getByRole('button',{name:'Close browser preview',exact:true})]);await screenshot(page,`${theme}-browser`,width);await page.getByRole('button',{name:'Close browser preview',exact:true}).click();
     await namedClick(page,'Open terminal');if(!f.state.currentSession)await page.getByRole('button',{name:'Start terminal',exact:true}).click();await page.getByRole('textbox',{name:'Terminal input',exact:true}).waitFor({state:'attached'});await geometry(page,`${theme}/terminal/${width}`,[page.getByRole('button',{name:'Close terminal panel',exact:true})]);await contrast(page.locator('.terminal-session-context [role="status"]'),'terminal status');await screenshot(page,`${theme}-terminal`,width);await page.getByRole('button',{name:'Close terminal panel',exact:true}).click();
    }
    assert.deepEqual(f.state.unexpected,[]);assert.deepEqual(f.state.errors,[]);
   }finally{await f.close();}
  }
  await mkdir(evidence,{recursive:true});await writeFile(`${evidence}/computed-audit.json`,JSON.stringify(audit,null,2));
 }finally{await browser?.close();await vite.close();}
});

test('mounted appearance reconciles first paint, system, saved preference and failed saves',{skip:!enabled,timeout:120000},async()=>{
 const vite=await createServer({server:{port:0,host:'127.0.0.1'},logLevel:'error'});let browser:Browser|undefined;
 try{await vite.listen();browser=await chromium.launch({headless:true,channel:process.env.RELAY_TEST_BROWSER_CHANNEL});const url=vite.resolvedUrls!.local[0];
  for(const sample of [{cache:'dark',expected:'dark',system:'light'},{cache:'nonsense',expected:'dark',system:'dark'},{cache:undefined,expected:'light',system:'light'},{cache:'dark',expected:'light',system:'light',blocked:true}] as const){
   const f=await fixture(browser,url,{appearance:'light',cache:sample.cache,system:sample.system,blocked:'blocked' in sample,holdBootstrap:true});try{
    // Pause the React module: this observes only the external blocking initializer.
    let resume!:()=>void;const moduleGate=new Promise<void>(done=>resume=done);await f.page.route('**/main.tsx',async route=>{await moduleGate;await route.continue();});const navigation=f.page.goto(url,{waitUntil:'commit'});await navigation;await resolved(f.page,sample.expected);assert.equal(await f.page.locator('script[src="/appearance-init.js"]:not([type="module"]):not([async]):not([defer])').count(),1);resume();await f.page.unroute('**/main.tsx');f.release();await f.page.getByRole('textbox',{name:'Message Mira',exact:true}).waitFor();await resolved(f.page,'light');assert.deepEqual(f.state.unexpected,[]);assert.deepEqual(f.state.errors,[]);
   }finally{await f.close();}
  }
  const f=await fixture(browser,url,{appearance:'system',cache:'system',system:'light'});try{const {page,state}=f;await f.open();await resolved(page,'light');await page.emulateMedia({colorScheme:'dark'});await resolved(page,'dark');const control=page.getByRole('button',{name:'Appearance: system. Change appearance',exact:true});await control.focus();await page.keyboard.press('Enter');await resolved(page,'light');await page.getByRole('button',{name:'Appearance: light. Change appearance',exact:true}).waitFor();assert.equal(state.appearance,'light');await page.emulateMedia({colorScheme:'dark'});await resolved(page,'light');assert.equal(await page.evaluate(()=>localStorage.getItem('relay.appearance')),'light');await page.reload();await page.getByRole('textbox',{name:'Message Mira',exact:true}).waitFor();await resolved(page,'light');
   await namedClick(page,'Settings');const select=page.getByRole('combobox',{name:'Appearance',exact:true});assert.equal(await select.inputValue(),'light');const secureDraft=page.getByLabel('TypeSafe API key',{exact:true});await secureDraft.fill('synthetic-theme-draft');await select.selectOption('dark');await resolved(page,'dark');await page.waitForFunction(()=>!document.querySelector<HTMLSelectElement>('select[aria-label="Appearance"]')?.disabled);assert.equal(await select.inputValue(),'dark');assert.equal(await secureDraft.inputValue(),'synthetic-theme-draft');assert.equal(await secureDraft.getAttribute('type'),'password');assert.equal(await page.evaluate(()=>Object.values(localStorage).concat(Object.values(sessionStorage)).some(value=>String(value).includes('synthetic-theme-draft'))),false);await secureDraft.fill('');state.failSave=true;await select.selectOption('light');await page.getByRole('alert').filter({hasText:'Could not save appearance:'}).waitFor();assert.equal(await select.inputValue(),'dark');await resolved(page,'dark');state.failSave=false;await closeModal(page);
   // Simulate an authoritative tool-side settings update; bootstrap refresh owns reconciliation.
   state.appearance='system';await page.reload();await page.getByRole('textbox',{name:'Message Mira',exact:true}).waitFor();await page.getByRole('button',{name:'Appearance: system. Change appearance',exact:true}).waitFor();await resolved(page,'dark');await page.emulateMedia({colorScheme:'light'});await resolved(page,'light');assert.deepEqual(state.unexpected,[]);assert.deepEqual(state.errors,[]);
  }finally{await f.close();}
 }finally{await browser?.close();await vite.close();}
});

test('mounted active xterm changes palette in place and accessibility preferences stay usable',{skip:!enabled,timeout:90000},async()=>{
 const vite=await createServer({server:{port:0,host:'127.0.0.1'},logLevel:'error'});let browser:Browser|undefined;
 try{await vite.listen();browser=await chromium.launch({headless:true,channel:process.env.RELAY_TEST_BROWSER_CHANNEL});const f=await fixture(browser,vite.resolvedUrls!.local[0],{appearance:'light'});try{const {page,state}=f;await f.open();await namedClick(page,'Open terminal');await page.getByRole('button',{name:'Start terminal',exact:true}).click();const input=page.getByRole('textbox',{name:'Terminal input',exact:true});await input.waitFor({state:'attached'});await input.evaluate(el=>(el as any).fixtureIdentity='original-xterm');await page.waitForFunction(()=>(window as any).fixtureSources.some((s:any)=>s.url.startsWith('/api/terminal/')));await page.evaluate(()=>{const source=(window as any).fixtureSources.find((s:any)=>s.url.startsWith('/api/terminal/'));source.onmessage({data:JSON.stringify({type:'output',sessionId:'appearance-terminal',sequence:1,data:'Retained output\r\n'})});});await page.waitForFunction(()=>document.querySelector('.terminal-output')?.textContent?.includes('Retained output'));const before=await page.locator('.xterm-scrollable-element').evaluate(el=>getComputedStyle(el).backgroundColor),feedCount=await page.evaluate(()=>(window as any).fixtureSources.filter((s:any)=>s.url.startsWith('/api/terminal/')).length);
  await page.getByRole('button',{name:'Appearance: light. Change appearance',exact:true}).click();await resolved(page,'dark');await page.waitForFunction(before=>getComputedStyle(document.querySelector('.xterm-scrollable-element')!).backgroundColor!==before,before);assert.equal(await input.evaluate(el=>(el as any).fixtureIdentity),'original-xterm');assert.equal(state.startCount,1);assert.equal(state.currentSession.id,'appearance-terminal');assert.equal(await page.evaluate(()=>(window as any).fixtureSources.filter((s:any)=>s.url.startsWith('/api/terminal/')).length),feedCount);assert.equal(await page.evaluate(()=>(window as any).fixtureSources.filter((s:any)=>s.url.startsWith('/api/terminal/')).every((s:any)=>!s.closed)),true);assert.match(await page.locator('.terminal-output').innerText(),/Retained output/);await screenshot(page,'dark-active-terminal',1440);
  await page.setViewportSize({width:320,height:1000});await geometry(page,'dark/active-terminal/320',[page.getByRole('button',{name:'Close terminal panel',exact:true})]);await screenshot(page,'dark-active-terminal',320);await page.getByRole('button',{name:'Close terminal panel',exact:true}).click();
  const cdp=await page.context().newCDPSession(page);await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'},{name:'prefers-reduced-transparency',value:'reduce'}]});assert.equal(await page.evaluate(()=>matchMedia('(prefers-reduced-motion: reduce)').matches&&matchMedia('(prefers-reduced-transparency: reduce)').matches),true);await namedClick(page,'Settings');const secure=page.getByLabel('TypeSafe API key',{exact:true});await secure.waitFor();assert.equal(await secure.evaluate(el=>getComputedStyle(el).backdropFilter),'none');await geometry(page,'reduced-transparency/secure/320',[secure]);await screenshot(page,'dark-reduced-secure',320);
  await page.emulateMedia({forcedColors:'active',reducedMotion:'reduce'});await secure.focus();await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement?.matches('button,input,select,textarea,a')),true);await geometry(page,'forced-colors/secure/320',[secure]);await page.evaluate(()=>new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done()))));await mkdir(evidence,{recursive:true});await writeFile(evidence+'/forced-colors-computed.json',JSON.stringify(await page.getByRole('button',{name:'Connect TypeSafe',exact:true}).evaluate(el=>{const s=getComputedStyle(el);return {color:s.color,background:s.backgroundColor,opacity:s.opacity,forcedColorAdjust:s.forcedColorAdjust,border:s.borderColor,disabled:(el as HTMLButtonElement).disabled};}),null,2));for(const button of [page.getByRole('button',{name:'Connect TypeSafe',exact:true}),page.getByRole('button',{name:'Save models',exact:true})]){const result=await button.evaluate(el=>{const sample=document.createElement('span');sample.style.cssText='color:'+((el as HTMLButtonElement).disabled?'GrayText':'ButtonText')+';background:ButtonFace';document.body.append(sample);const actual=getComputedStyle(el),expected=getComputedStyle(sample);const result={actual:[actual.color,actual.backgroundColor,actual.opacity,actual.forcedColorAdjust],expected:[expected.color,expected.backgroundColor,'1','auto']};sample.remove();return result;});assert.deepEqual(result.actual,result.expected,'forced colors uses settled native button palette');}await screenshot(page,'forced-colors-secure',320);assert.deepEqual(state.unexpected,[]);assert.deepEqual(state.errors,[]);
 }finally{await f.close();}}finally{await browser?.close();await vite.close();}
});















