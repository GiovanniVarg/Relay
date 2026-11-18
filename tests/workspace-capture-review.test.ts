import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {Store,id,now} from '../server/store.js';
import {AppActions} from '../server/app-actions.js';
import {Tasks} from '../server/tasks.js';
import {Knowledge} from '../server/knowledge.js';
import {AgentToolkit} from '../server/agent-toolkit.js';
import {Artifacts} from '../server/artifacts.js';
import {Browser} from '../server/browser.js';
import {Capabilities} from '../server/capabilities.js';
import type {Agent,Run,InteractionPrompt} from '../shared/types.js';

test('review: app-only Agent cannot capture home files without exact-path approval or after authority expires',async()=>{
 const root=await mkdtemp(join(tmpdir(),'relay-artifact-authority-')),workspace=join(root,'home'),store=new Store(join(root,'data'));await mkdir(join(workspace,'.codex'),{recursive:true});const secret=join(workspace,'.codex','auth.json');await writeFile(secret,'SYNTHETIC PRIVATE FIXTURE');const agent=store.list<Agent>('agent')[0],runId=id(),conversationId=store.conversations(agent.id)[0].id;
 store.put<Run>('run',{id:runId,agentId:agent.id,conversationId,messageId:id(),mode:'agent',status:'running',route:{provider:'cursor',model:'fixture',strategy:'manual',reason:'app-only'},error:null,startedAt:now(),endedAt:null,usage:null});
 const tasks=new Tasks(store,{start:async()=>{throw Error('No dispatch')},snapshot:()=>({status:'running'}),cancel:async()=>{}}),knowledge=new Knowledge(store),artifacts=new Artifacts(store),actions=new AppActions(store,{create:()=>{throw Error('No group')},accept:()=>{throw Error('No group')}}as never),toolkit=new AgentToolkit(store,actions,tasks,knowledge,{}as never,artifacts),controller=new AbortController();let active=true;const approvals:InteractionPrompt[]=[];
 const bound=(allow:boolean,expire=false)=>toolkit.bind({runId,agentId:agent.id,conversationId,workspace,signal:controller.signal,isActive:()=>active,interact:async prompt=>{approvals.push(prompt);if(expire)active=false;return{decision:allow?'allow':'deny'};}});
 try{
  await assert.rejects(bound(false).call('denied-file','relay_publish_artifact',{name:'output.txt',path:secret}),/denied/i);assert.equal(artifacts.list().length,0);assert.ok(approvals[0].details?.includes(secret));assert.ok(approvals[0].details?.includes('output.txt'));
  await assert.rejects(bound(true,true).call('expired-file','relay_publish_artifact',{name:'output.txt',path:secret}),/expired/i);assert.equal(artifacts.list().length,0);active=true;
  const text=await bound(false).call('safe-text','relay_publish_artifact',{name:'note.txt',content:'Written result'})as{id:string};assert.equal((await artifacts.read(text.id)).bytes.toString(),'Written result');assert.equal(approvals.length,2);
  assert.equal((await readdir(join(store.dataDir,'artifacts'))).length,1);
 }finally{await tasks.close();store.close();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

test('review: redirects, frames and WebSockets cannot reach the blocked application origin',{timeout:40000,skip:process.env.RELAY_BROWSER_LIVE!=='1'},async()=>{
 const root=await mkdtemp(join(tmpdir(),'relay-browser-origin-review-')),store=new Store(join(root,'data')),agent=store.list<Agent>('agent')[0],caps=new Capabilities(store);caps.setBrowserGrant(agent.id,true);let forbiddenCount=0,forbiddenUpgrades=0;
 const forbidden=createServer((_req,res)=>{forbiddenCount++;res.setHeader('Content-Type','text/html');res.end('<body>Private application fixture</body>');});forbidden.on('upgrade',(_req,socket)=>{forbiddenUpgrades++;socket.destroy();});await new Promise<void>(done=>forbidden.listen(0,'127.0.0.1',done));const blocked=`http://127.0.0.1:${(forbidden.address() as{port:number}).port}`;
 const server=createServer((req,res)=>{
  if(req.url==='/start'){res.writeHead(302,{Location:'/redirect'});res.end();return;}
  if(req.url==='/frames'){res.setHeader('Content-Type','text/html');res.end(`<body>Allowed frame fixture<p id="frame">pending</p><p id="ws">pending</p><iframe src="/start" onload="document.getElementById('frame').textContent='Frame finished'"></iframe><script>const socket=new WebSocket(${JSON.stringify(blocked.replace('http:','ws:')+'/private')});socket.onerror=()=>document.getElementById('ws').textContent='Socket finished';</script></body>`);return;}
  res.writeHead(302,{Location:blocked+'/private'});res.end();
 });await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const allowed=`http://127.0.0.1:${(server.address() as{port:number}).port}`;
 const browser=new Browser(store,caps,{blockedOrigins:()=>[blocked]});
 try{
  await assert.rejects(browser.open(agent.id,allowed+'/redirect'));assert.equal(forbiddenCount,0,'Forbidden application must receive no redirected request');
  await assert.rejects(browser.open(agent.id,allowed+'/start'));assert.equal(forbiddenCount,0,'A multihop redirect must remain fenced');
  await browser.open(agent.id,allowed+'/frames');let finished=false;for(let i=0;i<100;i++){const view=await browser.read(agent.id);if(view.text.includes('Frame finished')&&view.text.includes('Socket finished')){finished=true;break;}await new Promise(done=>setTimeout(done,20));}assert.equal(finished,true,'Both denied subresource attempts must settle');
  assert.equal(forbiddenCount,0,'Frame redirects must remain fenced');assert.equal(forbiddenUpgrades,0,'WebSocket upgrades must remain fenced');
 }finally{await browser.close();server.closeAllConnections();forbidden.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await new Promise<void>(done=>forbidden.close(()=>done()));store.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
