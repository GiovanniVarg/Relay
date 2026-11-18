import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../server/index.js';
import type {Bootstrap,ProviderAdapter,ProviderId} from '../shared/types.js';

test('workspace HTTP persists scheduled tasks, requires CSRF, reviews memory and keeps grants human-controlled',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'relay-workspace-http-'));
 const adapters=Object.fromEntries(['openai','claude','cursor','gemini','grok'].map(id=>[id,{id,inspect:async()=>({id,installed:false,authenticated:false,authMode:'unknown',accountLabel:'',plan:'',models:[]}),close:async()=>{},login:async()=>({message:''}),stream:async()=>{throw Error('No inference in this fixture')}}])) as unknown as Record<ProviderId,ProviderAdapter>;
 const app=createApp({dataDir:dir,adapters,port:0}); const port=await app.listen(0),base=`http://127.0.0.1:${port}`;
 try{
  const res=await fetch(base+'/api/bootstrap');const boot=await res.json() as Bootstrap,cookie=res.headers.get('set-cookie')!.split(';')[0];
  const api=async(path:string,method='GET',body?:unknown,csrf=true)=>fetch(base+'/api'+path,{method,headers:{Cookie:cookie,...(csrf?{'X-CSRF-Token':boot.csrfToken}:{}),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const aid=boot.agents[0].id;
  assert.equal((await api('/tasks','POST',{agentId:aid,title:'Tomorrow',prompt:'Inspect fixture',dueAt:new Date(Date.now()+86400000).toISOString()},false)).status,403);
  const created=await api('/tasks','POST',{agentId:aid,title:'Tomorrow',prompt:'Inspect fixture',dueAt:new Date(Date.now()+86400000).toISOString()});assert.equal(created.status,201);const task=await created.json();assert.equal(task.status,'scheduled');
  assert.equal((await (await api('/tasks')).json()).tasks.length,1);
  const proposed=await api('/knowledge','POST',{agentId:aid,title:'Preference',content:'Use concise reports',scope:'private',kind:'note'});assert.equal(proposed.status,201);const note=await proposed.json();
  assert.equal((await api(`/knowledge/${note.id}/approve`,'POST',{})).status,200);
  const found=await (await api(`/knowledge?agentId=${aid}&q=reports`)).json();assert.equal(found.entries.length,1);
  assert.equal((await api(`/capabilities/${aid}/browser`,'PATCH',{enabled:true})).status,200);
  const caps=await (await api('/workspace')).json();assert.ok(caps.capabilities);assert.ok(caps.routing);assert.equal(caps.tasks.length,1);
  assert.equal((await api(`/tasks/${task.id}/cancel`,'POST',{})).status,200);
  assert.equal((await (await api('/tasks')).json()).tasks[0].status,'cancelled');
 }finally{await app.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
