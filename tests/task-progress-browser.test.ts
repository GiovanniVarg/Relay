import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium,type Browser,type Page} from 'playwright';
import type {Agent,Conversation,Message,Run,RunEvent,RunInteraction} from '../shared/types.js';
import type {Task} from '../shared/tasks.js';

const date='2026-10-26T12:00:00.000Z';
const agent={id:'a',name:'Fixture bot',role:'Assistant',initials:'FB',color:'#657e70',instructions:'',memory:'',routeMode:'openai',model:'fixture',mode:'agent',workspace:'',pinned:false,unread:false,lastMessage:'',createdAt:date,updatedAt:date} as Agent;
const conversation={id:'c',agentId:'a',title:'Open chat',createdAt:date,updatedAt:date} as Conversation;
const run=(id:string,status:Run['status']='running'):Run=>({id,agentId:'a',conversationId:'c',messageId:'m'+id,status,mode:'agent',route:null,error:null,startedAt:date.replace('00.000',`${id.charCodeAt(0)-65}0.000`),endedAt:status==='running'?null:date,usage:null});
const message=(id:string,content:string,status:Message['status']='complete'):Message=>({id:'m'+id,conversationId:'c',role:'assistant',content,status,runId:id,createdAt:run(id).startedAt});
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {resolve,promise};}
async function emit(page:Page,event:RunEvent){await page.evaluate(event=>{(window as any).emitRun(event.type==='interaction'?event.interaction.runId:event.type==='route'||event.type==='done'?event.run.id:event.runId,event);},event);}

test('mounted chat discovers automatic runs, questions, replies, worker follow-up and already completed results', {timeout:45000,skip:process.env.RELAY_BROWSER_LIVE!=='1'},async()=>{
 const vite=await createServer({server:{port:0,host:'127.0.0.1'},logLevel:'error'});
 let browser:Browser|undefined;
 try{
  await vite.listen();browser=await chromium.launch({headless:true});
  const page=await browser.newPage();const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
   localStorage.setItem('relay.agent','a');
   const interval=window.setInterval.bind(window);window.setInterval=((fn:TimerHandler,ms?:number,...args:any[])=>interval(fn,ms===2500?40:ms,...args)) as typeof setInterval;
   const streams=new Map<string,any>();(window as any).runStreams=streams;
   (window as any).EventSource=class {onopen:any;onmessage:any;onerror:any;handlers=new Map();closed=false;constructor(public url:string){streams.set(url.split('/')[3],this);queueMicrotask(()=>this.onopen?.());}addEventListener(type:string,fn:any){this.handlers.set(type,fn);}close(){this.closed=true;}};
   (window as any).emitRun=(id:string,event:any)=>{const source=streams.get(id);if(!source||source.closed)throw Error('No active stream '+id);source.handlers.get(event.type)?.({data:JSON.stringify(event)});};
  });
  let data={conversation,messages:[message('A','Initial work','streaming')],runs:[run('A')]};
  let task={id:'ticket',agentId:'a',conversationId:'c',runId:'A',runIds:['A'],status:'working',updatedAt:date,waitingForChildren:false} as Task;
  const question:RunInteraction={id:'qB',runId:'B',kind:'question',provider:'openai',status:'pending',title:'Which target?',description:'Choose a target',questions:[{id:'target',question:'Which target?'}]};
  let pending:RunInteraction[]=[];const posts:{path:string;body:any}[]=[];let conversationReads=0,activeReads=0,maxReads=0;
  let holdNext:{started:ReturnType<typeof deferred>;release:ReturnType<typeof deferred>}|undefined;
  const otherAgent={...agent,id:'other',name:'Other bot'},otherConversation={...conversation,id:'other-c',agentId:'other'};
  const provider={id:'openai',installed:true,authenticated:true,authMode:'subscription',models:[{id:'fixture',name:'Fixture',verified:true}],billing:{confirmed:true,mode:'included',automaticRouting:true},modelPreferences:{defaultModel:'fixture',allowedModels:null}};
  await page.route('**/api/**',async route=>{
   const req=route.request(),path=new URL(req.url()).pathname.slice(4);let value:unknown={};
   if(req.method()==='POST'){const body=req.postDataJSON();posts.push({path,body});if(path==='/providers/refresh')value={providers:[provider]};else if(path==='/runs/B/message'){pending=[];value={message:{id:'replyB',conversationId:'c',role:'user',content:body.content,status:'complete',runId:null,createdAt:date},interaction:{id:'qB'}};}}
   else if(path==='/bootstrap')value={csrfToken:'fixture-only',version:'test',agents:[agent,otherAgent],conversations:[conversation,otherConversation],rooms:[],providers:[provider],settings:{maxRunSeconds:60,maxModelCalls:5,openaiDefaultModel:'fixture'}};
   else if(path==='/agents/a')value={agent,conversations:[conversation],files:[]};
   else if(path==='/agents/other')value={agent:otherAgent,conversations:[otherConversation],files:[]};
   else if(path==='/conversations/other-c')value={conversation:otherConversation,messages:[{...message('A','Other conversation'),id:'other-message',conversationId:'other-c',runId:null}],runs:[]};
   else if(path==='/conversations/c'){conversationReads++;activeReads++;maxReads=Math.max(maxReads,activeReads);value=structuredClone(data);const hold=holdNext;holdNext=undefined;if(hold){hold.started.resolve();await hold.release.promise;}activeReads--;}
   else if(path==='/tasks')value={tasks:[task]};
   else if(path==='/runs/B/interactions')value={interactions:pending};
   else if(path.endsWith('/interactions'))value={interactions:[]};
   else if(path==='/health')value={service:'relay',ok:true,instanceId:'fixture'};
   await route.fulfill({json:value});
  });
  await page.goto(vite.resolvedUrls!.local[0]);
  await page.getByText('Initial work',{exact:true}).waitFor();
  await page.waitForFunction(()=>(window as any).runStreams.has('A'));
  await emit(page,{type:'done',run:run('A','complete'),message:message('A','Initial turn finished')});
  data={conversation,messages:[message('A','Initial turn finished'),message('B','Automatic continuation','streaming'),{...message('B','Saved question transcript'),id:'question-qB'}],runs:[run('A','complete'),run('B')]};
  pending=[question];task={...task,runId:'B',runIds:['A','B'],updatedAt:'next'};
  await page.getByText('Automatic continuation',{exact:true}).waitFor({timeout:4000});
  await page.getByRole('heading',{name:'Which target?'}).waitFor({timeout:4000});
  await page.getByRole('button',{name:'Stop response',exact:true}).click();assert.ok(posts.some(p=>p.path==='/runs/B/cancel'));
  await page.getByRole('textbox',{name:'Message Fixture bot',exact:true}).fill('Target blue');
  await page.getByRole('button',{name:'Send message',exact:true}).click();
  await page.getByText('Target blue',{exact:true}).waitFor();
  await page.getByText('Saved question transcript',{exact:true}).waitFor();
  assert.deepEqual(posts.find(p=>p.path==='/runs/B/message')?.body,{content:'Target blue',interactionId:'qB'});
  assert.equal(posts.filter(p=>p.path.endsWith('/messages')).length,0);
  const late={started:deferred(),release:deferred()};holdNext=late;task={...task,updatedAt:'late-snapshot'};await late.started.promise;
  await emit(page,{type:'delta',runId:'B',text:'Streamed continuation'});
  await page.getByText('Streamed continuation',{exact:true}).waitFor();
  await emit(page,{type:'done',run:run('B','complete'),message:message('B','Continuation final')});
  late.release.resolve();await page.waitForTimeout(150);
  await page.getByText('Continuation final',{exact:true}).waitFor();
  assert.equal(await page.getByText('Saved question transcript',{exact:true}).count(),1);
  assert.equal(await page.getByText('Automatic continuation',{exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'Stop response',exact:true}).count(),0);
  data={conversation,messages:[message('A','Initial turn finished'),message('B','Continuation final'),message('C','Worker result synthesis','streaming')],runs:[run('A','complete'),run('B','complete'),run('C')]};
  task={...task,waitingForChildren:true,updatedAt:'waiting'};await page.waitForTimeout(100);
  task={...task,waitingForChildren:false,runId:'C',runIds:['A','B','C'],updatedAt:'child-completed'};
  await page.getByText('Worker result synthesis',{exact:true}).waitFor({timeout:4000});
  await page.waitForFunction(()=>(window as any).runStreams.has('C'));
  await emit(page,{type:'done',run:run('C','complete'),message:message('C','Worker final')});
  data={conversation,messages:[...data.messages.filter(m=>m.runId!=='C'),message('C','Worker final'),message('D','Finished before polling')],runs:[run('A','complete'),run('B','complete'),run('C','complete'),run('D','complete')]};
  task={...task,runId:'D',runIds:['A','B','C','D'],status:'done',updatedAt:'done'};
  await page.getByText('Finished before polling',{exact:true}).waitFor({timeout:4000});
  assert.equal(await page.locator('.message-bubble').filter({hasText:'Finished before polling'}).count(),1);
  assert.equal(await page.getByRole('button',{name:'Stop response',exact:true}).count(),0);
  const switched={started:deferred(),release:deferred()};holdNext=switched;
  data={...data,messages:[...data.messages,message('E','Old selection must discard this')],runs:[...data.runs,run('E','complete')]};task={...task,runIds:[...task.runIds,'E'],updatedAt:'switching'};
  await switched.started.promise;
  await page.locator('.agent-row').filter({hasText:'Other bot'}).click();
  await page.getByText('Other conversation',{exact:true}).waitFor();
  switched.release.resolve();data={...data,messages:data.messages.filter(m=>m.runId!=='E'),runs:data.runs.filter(r=>r.id!=='E')};task={...task,runIds:task.runIds.filter(id=>id!=='E'),updatedAt:'back'};
  await page.waitForTimeout(150);
  await page.locator('.agent-row').filter({hasText:'Fixture bot'}).click();
  await page.getByText('Finished before polling',{exact:true}).waitFor();
  assert.equal(await page.getByText('Old selection must discard this',{exact:true}).count(),0);
  assert.equal(maxReads,1);assert.ok(conversationReads>=4);assert.deepEqual(errors,[]);
 }finally{try{await browser?.close();}finally{await vite.close();}}
});
