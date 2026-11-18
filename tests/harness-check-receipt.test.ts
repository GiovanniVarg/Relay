import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store,id,now} from '../server/store.js';
import {AgentToolkit} from '../server/agent-toolkit.js';
import {AppActions} from '../server/app-actions.js';
import {Tasks} from '../server/tasks.js';
import {HttpError} from '../server/security.js';
import type {Agent,Run} from '../shared/types.js';
async function fixture(mode='failed'){
 const dir=await mkdtemp(join(tmpdir(),'relay-check-receipt-')),store=new Store(dir),agent=store.list<Agent>('agent')[0],runId=id();
 store.put<Run>('run',{id:runId,agentId:agent.id,conversationId:'c',messageId:'m',mode:'agent',status:'running',route:null,error:null,startedAt:now(),endedAt:null,usage:null});
 let checks=0,active=true;const controller=new AbortController();let draft={id:'draft',title:'Known failure',revision:'one',status:'draft',checkLog:'',error:null as string|null};const key='fixture-stored-typesafe-key';
 const failure=mode==='guard'?new HttpError(409,'Source changed since approval'):Error('Check command exited 2');
 const changes={get:async()=>({...draft}),check:async()=>{checks++;draft={...draft,status:mode==='unknown'?'draft':'failed',checkLog:'TS2353 useful compiler diagnostic '+key,error:failure.message};if(mode==='cancelled')controller.abort();if(mode==='expired')active=false;throw failure;},read:async()=>{throw new HttpError(400,'Cannot read '+key);}};
 const tasks=new Tasks(store,{start:async()=>{throw Error('No inference');},snapshot:()=>({status:'running'}),cancel:async()=>{}});
 const toolkit=new AgentToolkit(store,new AppActions(store,{}as never),tasks,{}as never,{}as never,{}as never,undefined,{changes,initialize:async()=>{},assertAvailable:()=>{}}as never,{redact:(s:any)=>typeof s==='string'?s.replaceAll(key,'[redacted]'):JSON.parse(JSON.stringify(s).replaceAll(key,'[redacted]'))}as never);
 const bound=toolkit.bind({runId,agentId:agent.id,conversationId:'c',signal:controller.signal,isActive:()=>active,interact:async()=>({decision:'allow'})});
 return{store,bound,key,get checks(){return checks;},async close(){await tasks.close();store.close();await rm(dir,{recursive:true,force:true});}};
}
test('known failed checks return compiler diagnostics, complete receipt and never rerun same call',async()=>{const f=await fixture();try{const result=await f.bound.call('check','relay_check_change',{changeId:'draft'})as any;assert.equal(result.status,'failed');assert.match(result.checkLog,/TS2353/);assert.equal(result.checkLog.includes(f.key),false);assert.deepEqual(await f.bound.call('check','relay_check_change',{changeId:'draft'}),result);assert.equal(f.checks,1);assert.equal(f.store.list<any>('workspace-tool')[0].status,'complete');}finally{await f.close();}});
test('cancelled, expired, authority and uncertain check failures remain exceptions',async()=>{for(const mode of['cancelled','expired','guard','unknown']){const f=await fixture(mode);try{await assert.rejects(f.bound.call('check','relay_check_change',{changeId:'draft'}));assert.equal(f.store.list<any>('workspace-tool')[0].status,'pending');}finally{await f.close();}}});
test('bound tool errors redact stored keys before known-failure persistence while preserving HttpError identity and status',async()=>{const f=await fixture();try{await assert.rejects(f.bound.call('read','relay_read_change',{changeId:'draft',path:'file.ts'}),error=>{assert.ok(error instanceof HttpError);assert.equal(error.status,400);assert.equal(error.message.includes(f.key),false);assert.match(error.message,/redacted/);return true;});const receipt=f.store.list<any>('workspace-tool')[0];assert.equal(receipt.status,'failed');assert.equal(receipt.failure.kind,'known_no_effect');assert.equal(JSON.stringify(receipt).includes(f.key),false);assert.match(receipt.failure.message,/redacted/);}finally{await f.close();}});
