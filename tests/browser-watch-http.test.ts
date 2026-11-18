import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.js';
import { workspaceApi } from '../server/workspace-api.js';
import type { Bootstrap, ProviderAdapter, ProviderId } from '../shared/types.js';
const adapters=Object.fromEntries(['openai','claude','cursor','gemini','grok'].map(id=>[id,{id,inspect:async()=>({id,installed:false,authenticated:false,authMode:'unknown',accountLabel:'',plan:'',models:[]}),close:async()=>{},login:async()=>({message:''}),stream:async()=>{throw Error('No inference')}}])) as unknown as Record<ProviderId,ProviderAdapter>;
test('real HTTP watch requires session, validates bot, streams after GET completion, cleans up and closes on app shutdown; Stop requires CSRF',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'relay-watch-http-')),app=createApp({dataDir:dir,adapters,port:0}),port=await app.listen(0),base=`http://127.0.0.1:${port}`;let closed=false;
 try{const bootstrap=await fetch(base+'/api/bootstrap'),boot=await bootstrap.json() as Bootstrap,cookie=bootstrap.headers.get('set-cookie')!.split(';')[0],aid=boot.agents[0].id,path=base+`/api/browser/${aid}`;
 assert.equal((await fetch(path+'/events')).status,401);assert.equal((await fetch(base+'/api/browser/unknown/events',{headers:{Cookie:cookie}})).status,404);
 for(const control of ['stop','takeover','return'])assert.equal((await fetch(path+'/'+control,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:'{}'})).status,403);
 assert.equal((await fetch(path+'/events',{headers:{Cookie:cookie,Origin:'https://foreign.test'}})).status,403);
 const stream=await fetch(path+'/events',{headers:{Cookie:cookie}});assert.equal(stream.status,200);assert.match(stream.headers.get('content-type')!,/text\/event-stream/);const reader=stream.body!.getReader(),first=await reader.read();assert.match(Buffer.from(first.value!).toString(),/"type":"status"/);await new Promise(done=>setTimeout(done,30));
 const stop=await fetch(path+'/stop',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':boot.csrfToken},body:'{}'});assert.equal(stop.status,202);assert.equal((await stop.json()).status,'stop_requested');await app.close();closed=true;let done=false;while(!done){done=(await reader.read()).done;}assert.equal(done,true);
 }finally{if(!closed)await app.close();await rm(dir,{recursive:true,force:true,maxRetries:5});}
});
test('Stop closes the browser before waiting on a slow native cancellation and returns bounded uncertainty',async()=>{
 const attempts:string[]=[];let release!:()=>void;
 const active=new Map([['run',{run:{id:'run',agentId:'bot',status:'running',error:null as string|null}}]]);
 const s:any={capabilities:{browserGrant:()=>({enabled:true})},tasks:{list:()=>[],get:()=>{}},runs:{active,cancel:async()=>{attempts.push('cancel');await new Promise<void>(done=>release=done);active.clear();}},browser:{revoke:async()=>{attempts.push('close');},status:async()=>({running:false})}};
 const server=createServer(async(req,res)=>{await workspaceApi(req,res,new URL(req.url!,'http://localhost'),s);});await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
 try{const pending=fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}/api/browser/bot/stop`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});await new Promise(done=>setTimeout(done,100));assert.deepEqual(attempts,['close','cancel']);const res=await pending;assert.equal(res.status,409);const body=await res.json();assert.ok(body.reasons.includes('cancellation_pending'));assert.ok(body.reasons.includes('run_cancellation_pending'));assert.match(body.error,/could not be confirmed/);}finally{release?.();await new Promise<void>(done=>server.close(()=>done()));}
});
test('Stop reports interrupted direct runs even when native cancel resolves normally',async()=>{
 const run={id:'run',agentId:'bot',status:'running',error:null as string|null},active=new Map([['run',{run}]]);
 const s:any={capabilities:{browserGrant:()=>({enabled:true})},tasks:{list:()=>[],get:()=>{}},runs:{active,cancel:async()=>{run.status='interrupted';run.error='Synthetic unconfirmed termination';active.clear();}},browser:{revoke:async()=>{},status:async()=>({running:false})}};
 const server=createServer(async(req,res)=>{await workspaceApi(req,res,new URL(req.url!,'http://localhost'),s);});await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
 try{const res=await fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}/api/browser/bot/stop`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(res.status,409);const body=await res.json();assert.deepEqual(body.reasons,['run_stop_uncertain']);assert.equal(JSON.stringify(body).includes('Synthetic'),false);}finally{await new Promise<void>(done=>server.close(()=>done()));}
});
test('every SSE event type disconnects at the one MiB writable limit without adding bytes',async()=>{
 const {browserWatchStream}=await import('../server/browser-watch.js');
 for(const type of ['status','clear','frame','activity']){const req=new EventEmitter();let listener!:(event:any)=>void,writes=0,removed=0,ended=0;const res=Object.assign(new EventEmitter(),{writableLength:0,destroyed:false,writeHead:()=>{},write:()=>{writes++;return true;},end:()=>{ended++;},destroy:()=>{ended++;}});browserWatchStream(req as never,res as never,{watch:(_id:string,fn:(event:any)=>void)=>{listener=fn;fn({type:'status',agentId:'bot',sequence:1,observedAt:'',sessionId:null,status:{}});return ()=>{removed++;};}} as never,'bot');res.writableLength=1024*1024;listener({type,agentId:'bot',sequence:2,observedAt:'',sessionId:null});assert.equal(writes,1);assert.equal(removed,1);assert.equal(ended,1);}
});
test('Stop snapshots exact assigned tasks and active run IDs, starts closure despite cancellation errors, preserves schedules and reports pending dispatch',async()=>{
 const attempts:string[]=[],tasks:any[]=[{id:'owned',agentId:'bot',status:'working',runId:'run',recoveryRequired:false},{id:'dispatch',agentId:'bot',status:'working',runId:null},{id:'foreign',agentId:'peer',creatorAgentId:'bot',status:'working',runId:'foreign-run'},{id:'future',agentId:'bot',status:'scheduled',runId:null},{id:'queued',agentId:'bot',status:'queued',runId:null}],active=new Map([['run',{run:{id:'run',agentId:'bot'}}],['other',{run:{id:'other',agentId:'peer'}}]]);
 const s:any={capabilities:{browserGrant:()=>({enabled:true})},tasks:{list:()=>tasks,get:(id:string)=>tasks.find(t=>t.id===id),cancel:async(id:string)=>{attempts.push('task:'+id);tasks.push({id:'late',agentId:'bot',status:'working'});if(id==='owned')throw Error('failed');}},runs:{active,cancel:async(id:string)=>{attempts.push('run:'+id);}},browser:{revoke:async()=>{attempts.push('close');},status:async()=>({running:false})}};
 const server=createServer(async(req,res)=>{try{if(!await workspaceApi(req,res,new URL(req.url!,'http://localhost'),s)){res.statusCode=404;res.end();}}catch(e){res.statusCode=500;res.end(String(e));}});await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
 try{const res=await fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}/api/browser/bot/stop`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(res.status,409);const body=await res.json();assert.equal(body.status,'stop_unconfirmed');assert.ok(body.reasons.some((r:string)=>r.includes('dispatch')));assert.deepEqual(new Set(attempts),new Set(['task:owned','task:dispatch','task:queued','run:run','close']));}finally{await new Promise<void>(done=>server.close(()=>done()));}
});
test('all SSE traffic is bounded; blocked clear/status disconnect, skipped frames and five second blocked activity deadline',async()=>{
 const { browserWatchStream }=await import('../server/browser-watch.js');
 for(const type of ['status','clear','frame','activity'] as const){
  const req=new EventEmitter(),writes:string[]=[];let listener!:(event:any)=>void,removed=0,ended=0;
  const res=Object.assign(new EventEmitter(),{writableLength:0,destroyed:false,writeHead:()=>{},write:(value:string)=>{writes.push(value);return false;},end:()=>{ended++;},destroy:()=>{ended++;}});
  browserWatchStream(req as never,res as never,{watch:(_id:string,fn:(event:any)=>void)=>{listener=fn;fn({type:'status',agentId:'bot',sequence:1,observedAt:'',status:{},sessionId:null});return ()=>{removed++;};}} as never,'bot');
  listener({type,agentId:'bot',sequence:2,observedAt:'',sessionId:null});
  if(type==='status'||type==='clear'){assert.equal(ended,1);assert.equal(removed,1);}else{assert.equal(writes.length,1);if(type==='activity'){await new Promise(done=>setTimeout(done,5100));assert.equal(ended,1);assert.equal(removed,1);}else{res.emit('close');assert.equal(removed,1);}}
 }
});
