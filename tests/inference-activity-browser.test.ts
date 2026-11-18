import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium, type Page} from 'playwright';
import type {Task} from '../shared/tasks';

const date='2026-11-05T12:00:00Z';
const agent={id:'synthetic-agent',name:'Fixture',role:'Assistant',initials:'F',color:'#657e70',instructions:'',memory:'',routeMode:'openai',model:'synthetic-model',mode:'agent',workspace:'',pinned:false,unread:false,lastMessage:'',createdAt:date,updatedAt:date};
const conversation={id:'synthetic-chat',agentId:agent.id,title:'Synthetic',createdAt:date,updatedAt:date};
const run={id:'synthetic-run',agentId:agent.id,conversationId:conversation.id,messageId:'synthetic-answer',status:'running',route:null,error:null,startedAt:date,endedAt:null,mode:'agent'};
const provider={id:'openai',installed:true,authenticated:true,authMode:'subscription',models:[{id:'synthetic-model',name:'Synthetic',verified:true,inputModalities:['text']}],billing:{confirmed:true,mode:'included',automaticRouting:true},modelPreferences:{defaultModel:'synthetic-model',allowedModels:null}};
async function emit(page:Page,event:unknown){await page.evaluate(event=>{const w=window as any;const source=w.syntheticSources.find((s:any)=>s.url==='/api/runs/synthetic-run/events'&&!s.closed);source.handlers.get((event as any).type)?.({data:JSON.stringify(event)});},event);}
async function activity(page:Page,text:string){await page.waitForFunction(text=>document.querySelector('.activity')?.textContent===text,text,{timeout:3000});assert.equal(await page.locator('.activity').innerText(),text);}

test('mounted simple App shows queue reasons and admission, preserving reconnect, tools and pending question precedence',{timeout:45000,skip:process.env.RELAY_BROWSER_LIVE!=='1'},async()=>{
 const vite=await createServer({server:{port:0,host:'127.0.0.1'},logLevel:'error'});let browser;
 try{
  await vite.listen();browser=await chromium.launch({headless:true});const page=await browser.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{localStorage.setItem('relay.agent','synthetic-agent');localStorage.setItem('relay.advanced','false');const w=window as any;w.syntheticSources=[];w.EventSource=class{url:string;closed=false;handlers=new Map();onopen:any;onerror:any;constructor(url:string){this.url=url;w.syntheticSources.push(this);queueMicrotask(()=>this.onopen?.());}addEventListener(type:string,fn:any){this.handlers.set(type,fn);}close(){this.closed=true;}};});
  await page.route('**/api/**',async route=>{
   const path=new URL(route.request().url()).pathname.slice(4);let value:unknown={};
   if(path==='/bootstrap')value={csrfToken:'synthetic',agents:[agent],conversations:[conversation],rooms:[],providers:[provider],settings:{maxRunSeconds:60,maxModelCalls:5}};
   else if(path==='/providers/refresh')value={providers:[provider]};
   else if(path==='/agents/synthetic-agent')value={agent,conversations:[conversation],files:[]};
   else if(path==='/conversations/synthetic-chat')value={conversation,messages:[{id:'synthetic-input',conversationId:conversation.id,role:'user',content:'Synthetic',status:'complete',createdAt:date}],runs:[run]};
   else if(path.endsWith('/attachments'))value=[];
   else if(path.endsWith('/interactions'))value={interactions:[]};
   else if(path==='/tasks')value={tasks:[]};
   else if(path==='/health')value={service:'relay',ok:true,instanceId:'synthetic'};
   await route.fulfill({json:value});
  });
  await page.goto(vite.resolvedUrls!.local[0]);await activity(page,'Thinking…');
  const status=async(message:string)=>emit(page,{type:'status',runId:run.id,message});
  for(const label of ['Waiting for inference capacity…','Waiting for another job in this workspace…','Waiting for an unresolved safety hold…']){await status(label);await activity(page,label);}
  await status('Working…');await activity(page,'Working…');
  await status('Provider is preparing a response');await activity(page,'Thinking…');
  await page.evaluate(()=>{const s=(window as any).syntheticSources.find((s:any)=>s.url==='/api/runs/synthetic-run/events'&&!s.closed);s.onerror();});await activity(page,'Reconnecting…');
  await status('Waiting for an unresolved safety hold…');await activity(page,'Waiting for an unresolved safety hold…');
  await emit(page,{type:'tool',runId:run.id,name:'synthetic_tool',summary:'Synthetic'});await activity(page,'Waiting for an unresolved safety hold…');
  await status('Working…');await activity(page,'Working…');
  await emit(page,{type:'tool',runId:run.id,name:'synthetic_tool',summary:'New admitted work'});await activity(page,'Using tools…');
  await emit(page,{type:'interaction',runId:run.id,interaction:{id:'synthetic-question',runId:run.id,provider:'openai',kind:'question',status:'pending',title:'Synthetic question',description:'',questions:[{id:'answer',header:'Synthetic',question:'Synthetic?',options:['Yes','No']}],createdAt:date}});
  await activity(page,'Waiting for your response…');await status('Waiting for inference capacity…');await activity(page,'Waiting for your response…');
  await emit(page,{type:'interactionResolved',runId:run.id,interactionId:'synthetic-question',status:'answered'});await activity(page,'Waiting for inference capacity…');
  assert.deepEqual(errors,[]);
 }finally{await browser?.close();await vite.close();}
});

for(const advanced of [false,true])for(const action of ['button','stop','cancel']as const){
 test(`mounted ${advanced?'advanced':'simple'} App cancels an owned background check via ${action} after its provider completed`,{timeout:45000,skip:process.env.RELAY_BROWSER_LIVE!=='1'},async()=>{
  const vite=await createServer({server:{port:0,host:'127.0.0.1'},logLevel:'error'});let browser;
  let task:Task={id:'owned-check-task',agentId:agent.id,title:'Owned source check',prompt:'Check this exact source',status:'working',phase:'checking',dueAt:null,repeatMinutes:null,parentTaskId:null,parentAttempt:null,childTaskIds:[],waitingForChildren:false,runId:run.id,conversationId:conversation.id,runIds:[run.id],attempt:1,checkpoint:'',result:'',error:null,recoveryRequired:false,createdAt:date,updatedAt:date,completedAt:null,pendingCheck:{requestId:'synthetic-check',changeId:'synthetic-change',revision:'synthetic-revision',runId:run.id,taskId:'owned-check-task',attempt:1,receiptId:'synthetic-receipt',acceptedAt:date,hostInstanceId:'synthetic-host',state:action==='button'?'accepted':'running'}};
  const mutations:string[]=[],errors:string[]=[];
  try{
   await vite.listen();browser=await chromium.launch({headless:true});const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));
   await page.addInitScript(({advanced})=>{localStorage.setItem('relay.agent','synthetic-agent');localStorage.setItem('relay.advanced',String(advanced));const w=window as any;w.EventSource=class{addEventListener(){}close(){}};},{advanced});
   await page.route('**/api/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname.slice(4);let value:unknown={};
    if(request.method()!=='GET'&&/^\/(tasks|runs|conversations)(?:\/|$)/.test(path))mutations.push(request.method()+' '+path);
    const connection=action==='stop'?{...provider,authenticated:false}:provider;
    if(path==='/bootstrap')value={csrfToken:'synthetic',agents:[agent],conversations:[conversation],rooms:[],providers:[connection],settings:{maxRunSeconds:60,maxModelCalls:5}};
    else if(path==='/providers/refresh')value={providers:[connection]};
    else if(path==='/agents/synthetic-agent')value={agent,conversations:[conversation],files:[]};
    else if(path==='/conversations/synthetic-chat')value={conversation,messages:[{id:'synthetic-input',conversationId:conversation.id,role:'user',content:'Synthetic source check',status:'complete',createdAt:date}],runs:[{...run,status:'complete'}]};
    else if(path.endsWith('/attachments'))value=[];
    else if(path.endsWith('/interactions'))value={interactions:[]};
    else if(path==='/tasks')value={tasks:[task]};
    else if(path==='/runs/synthetic-run/cancel'&&request.method()==='POST'){task={...task,status:'cancelled',pendingCheck:{...task.pendingCheck!,state:'cancelled'}};value={cancelled:true};}
    else if(path==='/health')value={service:'relay',ok:true,instanceId:'synthetic'};
    await route.fulfill({json:value});
   });
   await page.goto(vite.resolvedUrls!.local[0]);await activity(page,'Running checks…');
   if(action==='button'){
    assert.equal(await page.getByRole('button',{name:'Stop response',exact:true}).count(),1,'an owned check must remain stoppable after the provider ends');
    await page.getByRole('button',{name:'Stop response',exact:true}).click();
   }else{const composer=page.getByRole('textbox',{name:'Message Fixture',exact:true});await composer.fill(action);await composer.press('Enter');}
   await page.waitForFunction(()=>document.querySelector('.activity')===null,null,{timeout:6000});
   assert.deepEqual(mutations,['POST /runs/synthetic-run/cancel']);assert.deepEqual(errors,[]);
   assert.equal(await page.getByRole('textbox',{name:'Message Fixture',exact:true}).inputValue(),'');
  }finally{await browser?.close();await vite.close();}
 });
}

test('mounted App never turns historical, recovery or stale check records into cancellation authority',{timeout:45000,skip:process.env.RELAY_BROWSER_LIVE!=='1'},async()=>{
 const vite=await createServer({server:{port:0,host:'127.0.0.1'},logLevel:'error'});let browser;
 const owned:Task={id:'check-task',agentId:agent.id,title:'Source check',prompt:'Synthetic',status:'working',phase:'checking',dueAt:null,repeatMinutes:null,parentTaskId:null,parentAttempt:null,childTaskIds:[],waitingForChildren:false,runId:run.id,conversationId:conversation.id,runIds:[run.id],attempt:1,checkpoint:'',result:'',error:null,recoveryRequired:false,createdAt:date,updatedAt:date,completedAt:null,pendingCheck:{requestId:'check',changeId:'change',revision:'revision',runId:run.id,taskId:'check-task',attempt:1,receiptId:'receipt',acceptedAt:date,hostInstanceId:'host',state:'running'}};
 let task=owned,active=false;
 const mutations:string[]=[],errors:string[]=[];
 try{
  await vite.listen();browser=await chromium.launch({headless:true});const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{localStorage.setItem('relay.agent','synthetic-agent');localStorage.setItem('relay.advanced','false');const w=window as any;w.EventSource=class{addEventListener(){}close(){}};});
  await page.route('**/api/**',async route=>{
   const request=route.request(),path=new URL(request.url()).pathname.slice(4);let value:unknown={};
   if(request.method()!=='GET'&&/^\/(tasks|runs|conversations)(?:\/|$)/.test(path))mutations.push(request.method()+' '+path);
   if(path==='/bootstrap')value={csrfToken:'synthetic',agents:[agent],conversations:[conversation],rooms:[],providers:[provider],settings:{maxRunSeconds:60,maxModelCalls:5}};
   else if(path==='/providers/refresh')value={providers:[provider]};
   else if(path==='/agents/synthetic-agent')value={agent,conversations:[conversation],files:[]};
   else if(path==='/conversations/synthetic-chat')value={conversation,messages:[{id:'input',conversationId:conversation.id,role:'user',content:'Synthetic',status:'complete',createdAt:date}],runs:[{...run,status:'complete'},...(active?[{...run,id:'actual-active-run',startedAt:'2026-11-05T13:00:00Z'}]:[])]};
   else if(path.endsWith('/attachments'))value=[];
   else if(path.endsWith('/interactions'))value={interactions:[]};
   else if(path==='/tasks')value={tasks:[task]};
   else if(path==='/health')value={service:'relay',ok:true,instanceId:'synthetic'};
   else if(path==='/conversations/synthetic-chat/messages'&&request.method()==='POST'){await route.fulfill({status:409,json:{error:'Synthetic task admission remains guarded'}});return;}
   await route.fulfill({json:value});
  });
  for(const variant of ['recovery','historical','unknown','stale-attempt']as const){
   task=variant==='recovery'?{...owned,status:'needs_input',recoveryRequired:true,error:'Inspect uncertain effects'}
    :variant==='historical'?{...owned,runId:'older-run',runIds:['older-run'],pendingCheck:{...owned.pendingCheck!,runId:'older-run'}}
    :variant==='unknown'?{...owned,pendingCheck:{...owned.pendingCheck!,state:'unknown'}}
    :{...owned,pendingCheck:{...owned.pendingCheck!,attempt:2}};
   const tasksLoaded=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/tasks');
   await page.goto(vite.resolvedUrls!.local[0]);await tasksLoaded;await page.getByRole('textbox',{name:'Message Fixture',exact:true}).waitFor();
   // Wait for the current synthetic task poll before asserting the absent control.
   if(variant==='recovery')await page.getByRole('alert').filter({hasText:'Inspect uncertain effects'}).waitFor();
   if(variant==='unknown'||variant==='stale-attempt')await activity(page,'Running checks…');
   assert.equal(await page.getByRole('button',{name:'Stop response',exact:true}).count(),0,variant+' must not acquire cancellation authority');
   const composer=page.getByRole('textbox',{name:'Message Fixture',exact:true});await composer.fill('cancel');await composer.press('Enter');
   await page.getByRole('alert').filter({hasText:'Synthetic task admission remains guarded'}).waitFor();
   assert.equal(mutations.filter(path=>path.includes('/cancel')).length,0,variant+' must not cancel an older or uncertain operation');
  }
  assert.deepEqual(mutations,Array(4).fill('POST /conversations/synthetic-chat/messages'));
  task=owned;active=true;await page.reload();await activity(page,'Thinking…');
  await page.getByRole('textbox',{name:'Message Fixture',exact:true}).fill('');
  await Promise.all([page.waitForResponse(response=>new URL(response.url()).pathname==='/api/runs/actual-active-run/cancel'),page.getByRole('button',{name:'Stop response',exact:true}).click()]);
  assert.equal(mutations.at(-1),'POST /runs/actual-active-run/cancel');assert.equal(mutations.filter(path=>path==='POST /runs/synthetic-run/cancel').length,0);
  assert.deepEqual(errors,[]);
 }finally{await browser?.close();await vite.close();}
});

test('mounted App separates current task attention from earlier review without mutating or replaying tasks',{timeout:60000,skip:process.env.RELAY_BROWSER_LIVE!=='1'},async()=>{
 const vite=await createServer({server:{port:0,host:'127.0.0.1'},logLevel:'error'});let browser;
 const otherConversation={...conversation,id:'other-chat',title:'Other conversation',updatedAt:'2026-11-04T12:00:00Z'};
 const task=(id:string,extra:Partial<Task>={}):Task=>({id,agentId:agent.id,title:id,prompt:'Synthetic original request '+id,status:'working',dueAt:null,repeatMinutes:null,parentTaskId:null,parentAttempt:null,childTaskIds:[],waitingForChildren:false,runId:run.id,conversationId:conversation.id,runIds:[run.id],attempt:1,checkpoint:'Saved checkpoint '+id,result:'',error:null,recoveryRequired:false,createdAt:date,updatedAt:date,completedAt:null,...extra});
 const tasks=[task('current-task'),task('earlier-failed',{status:'failed',runId:'old-failed',runIds:['old-failed'],error:'Historical timeout'}),task('earlier-recovery',{status:'cancelled',runId:'old-recovery',runIds:['old-recovery'],error:'Historical unknown effects',recoveryRequired:true}),task('foreign-task',{conversationId:otherConversation.id,status:'failed',runId:'foreign-run',runIds:['foreign-run'],error:'Foreign conversation error'})];
 let currentRun={...run},extraRuns:typeof currentRun[]=[];
 const forbiddenRequests:string[]=[];
 try{
  await vite.listen();browser=await chromium.launch({headless:true});const page=await browser.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{localStorage.setItem('relay.agent','synthetic-agent');localStorage.setItem('relay.advanced','false');const w=window as any;w.syntheticSources=[];w.EventSource=class{url:string;closed=false;handlers=new Map();onopen:any;constructor(url:string){this.url=url;w.syntheticSources.push(this);queueMicrotask(()=>this.onopen?.());}addEventListener(type:string,fn:any){this.handlers.set(type,fn);}close(){this.closed=true;}};});
  await page.route('**/api/**',async route=>{
   const request=route.request(),path=new URL(request.url()).pathname.slice(4);let value:unknown={};
   if(request.method()!=='GET'&&/^\/(tasks|runs|conversations)(?:\/|$)/.test(path))forbiddenRequests.push(request.method()+' '+path);
   if(path==='/bootstrap')value={csrfToken:'synthetic',agents:[agent],conversations:[conversation,otherConversation],rooms:[],providers:[provider],settings:{maxRunSeconds:60,maxModelCalls:5}};
   else if(path==='/providers/refresh')value={providers:[provider]};
   else if(path==='/agents/synthetic-agent')value={agent,conversations:[conversation,otherConversation],files:[]};
   else if(path==='/conversations/synthetic-chat')value={conversation,messages:[{id:'synthetic-input',conversationId:conversation.id,role:'user',content:'Synthetic current work',status:'complete',createdAt:date}],runs:[{...currentRun,id:'old-failed',startedAt:'2026-11-04T10:00:00Z',status:'failed'},{...currentRun,id:'old-recovery',startedAt:'2026-11-04T11:00:00Z',status:'cancelled'},currentRun,...extraRuns]};
   else if(path==='/conversations/other-chat')value={conversation:otherConversation,messages:[{id:'foreign-input',conversationId:otherConversation.id,role:'user',content:'Synthetic other work',status:'complete',createdAt:date}],runs:[{...currentRun,id:'foreign-run',conversationId:otherConversation.id,status:'failed'}]};
   else if(path.endsWith('/attachments'))value=[];
   else if(path.endsWith('/interactions'))value={interactions:[]};
   else if(path==='/tasks')value={tasks};
   else if(path==='/workspace')value={tasks,artifacts:[],knowledge:[],capabilities:[],routing:{},operation:{}};
   else if(path==='/health')value={service:'relay',ok:true,instanceId:'synthetic'};
   await route.fulfill({json:value});
  });
  const saved=JSON.stringify(tasks);
  await page.goto(vite.resolvedUrls!.local[0]);await activity(page,'Thinking…');
  await emit(page,{type:'tool',runId:run.id,name:'synthetic_tool',summary:'Current tool work'});await activity(page,'Using tools…');
  const review=()=>page.getByRole('button',{name:'2 earlier tasks need review · 1 requires recovery'});
  await page.waitForFunction(()=>document.querySelector('.task-attention')!==null);
  assert.equal(await page.locator('.task-attention[role="alert"]').count(),0,'old failures must not appear as current alerts beside live tool work');await review().waitFor();
  assert.equal(await page.getByText('Historical timeout',{exact:true}).count(),0);assert.equal(await page.getByText('Historical unknown effects',{exact:true}).count(),0);assert.equal(await page.getByText('Foreign conversation error',{exact:true}).count(),0);
  await review().click();await page.getByRole('main',{name:'Task workspace'}).waitFor();
  for(const id of ['earlier-failed','earlier-recovery']){
   await page.locator('.work-task-row').filter({hasText:id}).click();const details=page.getByRole('complementary',{name:'Task details'});await details.waitFor();
   assert.match(await details.innerText(),id==='earlier-failed'?/Historical timeout/:/Historical unknown effects/);
   if(id==='earlier-recovery')assert.match(await details.innerText(),/Stop unconfirmed · needs attention/);
   if(!await details.locator('details').evaluate(element=>(element as HTMLDetailsElement).open))await details.getByText('Progress & history',{exact:true}).click();
   assert.match(await details.innerText(),new RegExp('Saved checkpoint '+id));assert.match(await details.innerText(),/1 recorded runs · Updated/);
  }
  await page.getByRole('button',{name:'Chats',exact:true}).click();await activity(page,'Using tools…');await review().waitFor();
  assert.equal(JSON.stringify(tasks),saved);assert.deepEqual(forbiddenRequests,[]);
  tasks[0]={...tasks[0],phase:'checking'};await page.reload();await activity(page,'Running checks…');await review().waitFor();
  currentRun={...run,status:'complete'};await page.reload();await activity(page,'Running checks…');await review().waitFor();
  tasks[0]={...tasks[0],phase:'working'};
  // The active run owns current attention even when an older task was updated more recently.
  tasks[0]={...tasks[0],status:'failed',error:'Current provider failed'};tasks[1].updatedAt='2026-11-06T00:00:00Z';
  currentRun={...run,status:'failed'};await page.reload();await page.getByRole('alert').filter({hasText:'Current task · current-task'}).waitFor();
  assert.match(await page.locator('.task-attention[role="alert"]').innerText(),/Current provider failed/);await review().waitFor();
  tasks[0]={...tasks[0],runId:null,status:'needs_input',error:'Current execution budget exhausted'};await page.reload();
  await page.getByRole('alert').filter({hasText:'Current task · current-task'}).waitFor();assert.match(await page.locator('.task-attention[role="alert"]').innerText(),/Current execution budget exhausted/);await review().waitFor();
  tasks[0]={...tasks[0],runId:run.id};
  tasks[0]={...tasks[0],status:'needs_input',error:'Inspect the current saved effects',recoveryRequired:true};await page.reload();
  await page.getByRole('alert').filter({hasText:'Current task · current-task · Recovery required'}).waitFor();assert.match(await page.locator('.task-attention[role="alert"]').innerText(),/Inspect the current saved effects/);
  // A later successful direct run must not relabel an older task as the current failure.
  extraRuns=[{...run,id:'later-untracked',status:'complete',startedAt:'2026-11-05T13:00:00Z'}];await page.reload();
  await page.getByRole('button',{name:'3 earlier tasks need review · 2 require recovery'}).waitFor();assert.equal(await page.locator('.task-attention[role="alert"]').count(),0);
  await page.getByRole('button',{name:'Chat options',exact:true}).click();await page.getByRole('button',{name:'Chat history',exact:true}).click();await page.getByRole('button').filter({hasText:'Other conversation'}).click();
  await page.getByRole('alert').filter({hasText:'Current task · foreign-task'}).waitFor();assert.equal(await page.locator('.task-history-review').count(),0);assert.match(await page.locator('.task-attention[role="alert"]').innerText(),/Foreign conversation error/);
  assert.deepEqual(forbiddenRequests,[]);assert.deepEqual(errors,[]);
 }finally{await browser?.close();await vite.close();}
});
