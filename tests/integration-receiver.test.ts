import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {IntegrationCapture} from '../server/integration-capture.js';
import {AppControls,type AppControlServices} from '../server/app-controls.js';
import {McpConnections} from '../server/mcp-connections.js';
import {Telegram} from '../server/telegram.js';
import {IntegrationCredentials} from '../server/integration-credentials.js';
import {SyntheticVault} from './synthetic-vault.js';
import type {Agent,RunInteraction} from '../shared/types.js';
import type {AppActionScope} from '../server/app-actions.js';
const key='123456789:SYNTHETIC_RECEIVER_TOKEN_8736473827461';
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'relay-receiver-')),store=new Store(dir),agent=store.list<Agent>('agent')[0],vault=new SyntheticVault(),credentials=new IntegrationCredentials(store,vault);
 const entries:RunInteraction[]=[],abort=new AbortController();let answer!:()=>void;let external=0;
 const capture=new IntegrationCapture({interactions:()=>entries,remember:token=>credentials.secrets.add(token),answer:(_r,_id,value)=>{entries[0].status=value.decision==='deny'?'expired':'answered';answer();}});
 const scope:AppActionScope={runId:'synthetic-run',agentId:agent.id,signal:abort.signal,isActive:()=>!abort.signal.aborted,interact:async(request:Parameters<NonNullable<AppActionScope['interact']>>[0])=>{entries.push({...request,id:'synthetic-interaction',runId:'synthetic-run',provider:'openai',status:'pending'});await new Promise<void>(r=>answer=r);return {decision:'allow'};}};
 const mcp=new McpConnections(store,{credentials,fetch:async()=>{external++;throw Error('No external MCP request permitted');}}),telegram=new Telegram(store,{} as never,{credentials,fetch:async()=>Response.json({ok:true,result:{username:'synthetic_bot'}})});
 const controls=new AppControls(store,{secureCapture:capture,mcp,telegram} as AppControlServices);
 const request=()=>capture.request('session',{runId:scope.runId,interactionId:entries[0].id});
 return {store,agent,vault,scope,entries,controls,capture,telegram,request,external:()=>external,async close(){capture.close();await mcp.close();await telegram.stop();store.close();await rm(dir,{recursive:true,force:true,maxRetries:5});}};
}
for(const kind of ['mcp','telegram'] as const)test(kind+' host disclosure and apply share the immutable normalized receiver despite changed tool input',async()=>{
 const f=await fixture();try{
  const input:Record<string,unknown>=kind==='mcp'?{agentId:f.agent.id,name:'  Synthetic tools  ',url:'https://EXAMPLE.test:443/a/../mcp',authentication:'bearer'}:{allowedUserId:42,enabled:false};
  const action=f.controls.call(f.scope,'relay_app_control',{action:kind==='mcp'?'mcp.add':'telegram.connect',id:f.agent.id,input},()=>{});void action.catch(()=>{});
  assert.equal(f.entries.length,1);const first=f.request();assert.equal(first.receiver.kind,kind);assert.equal(first.receiver.agentName,f.agent.name);assert.equal(first.receiver.agentId,f.agent.id);assert.ok(Object.isFrozen(first.receiver));
  if(first.receiver.kind==='mcp'){assert.equal(first.receiver.name,'Synthetic tools');assert.equal(first.receiver.url,'https://example.test/mcp');input.url='https://substituted.invalid/mcp';input.name='Changed tools';input.agentId='changed-bot';}
  else {assert.equal(first.receiver.allowedUserId,42);assert.equal(first.receiver.enabled,false);assert.equal(first.receiver.url,'https://api.telegram.org/');input.allowedUserId=99;input.enabled=true;}
  const current=f.request();await assert.rejects(f.capture.submit('session',{nonce:first.nonce,token:key},new AbortController().signal),/session/);
  await assert.rejects(f.capture.submit('foreign-session',{nonce:current.nonce,token:key},new AbortController().signal),/session/);
  await assert.rejects(f.capture.submit('session',{nonce:current.nonce,token:key,receiver:{url:'https://substituted.invalid'}},new AbortController().signal),/Unknown/);
  await f.capture.submit('session',{nonce:current.nonce,token:key},new AbortController().signal);await action;
  const saved=f.store.list<any>(kind==='mcp'?'mcp-connection':'telegram')[0];assert.equal(saved.agentId??saved.id,f.agent.id);assert.equal(f.vault.values.get(saved.secretRef),key);
  if(kind==='mcp'){assert.equal(saved.url,'https://example.test/mcp');assert.equal(saved.name,'Synthetic tools');}else {assert.equal(saved.allowedUserId,42);assert.equal(saved.enabled,false);}
  assert.equal(f.external(),0);assert.ok(!JSON.stringify(f.entries).includes(key));assert.ok(!JSON.stringify(f.store.list(kind==='mcp'?'mcp-connection':'telegram')).includes(key));
  await assert.rejects(f.capture.submit('session',{nonce:current.nonce,token:key},new AbortController().signal),/session/);
 }finally{await f.close();}
});
for(const kind of ['mcp','telegram'] as const)test(kind+' changed local bot identity fails before any vault write',async()=>{
 const f=await fixture();try{const action=f.controls.call(f.scope,'relay_app_control',{action:kind==='mcp'?'mcp.add':'telegram.connect',id:f.agent.id,input:kind==='mcp'?{agentId:f.agent.id,name:'Tools',url:'https://example.test/mcp'}:{allowedUserId:42,enabled:false}},()=>{});void action.catch(()=>{});const challenge=f.request();f.store.put('agent',{...f.agent,name:'Replaced receiver'});await assert.rejects(f.capture.submit('session',{nonce:challenge.nonce,token:key},new AbortController().signal),/receiver changed/);assert.equal(f.vault.values.size,0);f.capture.close();await assert.rejects(action,/cancelled/);}finally{await f.close();}
});
test('Telegram changed API endpoint fails before receiving or storing the key',async()=>{const f=await fixture();try{const action=f.controls.call(f.scope,'relay_app_control',{action:'telegram.connect',id:f.agent.id,input:{allowedUserId:42,enabled:false}},()=>{});void action.catch(()=>{});const challenge=f.request();f.telegram.options.baseUrl='https://substituted.invalid';await assert.rejects(f.capture.submit('session',{nonce:challenge.nonce,token:key},new AbortController().signal),/receiver changed/);assert.equal(f.vault.values.size,0);f.capture.close();await assert.rejects(action,/cancelled/);}finally{await f.close();}});
test('invalid and secret-bearing receivers fail before issuing a challenge',async()=>{
 const f=await fixture();try{for(const url of ['https://name:password@example.test/mcp','https://example.test/mcp?api_key=hidden','https://example.test/mcp#secret','http://remote.invalid/mcp'])await assert.rejects(f.controls.call(f.scope,'relay_app_control',{action:'mcp.add',input:{agentId:f.agent.id,name:'Tools',url}},()=>{}));for(const allowedUserId of [undefined,0,-1,1.5,'42'])await assert.rejects(f.controls.call(f.scope,'relay_app_control',{action:'telegram.connect',id:f.agent.id,input:{allowedUserId,enabled:false}},()=>{}));await assert.rejects(f.capture.begin(f.scope,'mcp:'+f.agent.id,{} as never,async()=>{},()=>{}),/valid secure receiver/);assert.equal(f.entries.length,0);assert.equal(f.vault.values.size,0);}finally{await f.close();}
});
