import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store,id,now} from '../server/store.js';
import {Tasks} from '../server/tasks.js';
import {HarnessCheckJobs} from '../server/harness-check-jobs.js';
import type {Agent,Run} from '../shared/types.js';

async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'relay-check-jobs-')),store=new Store(dir),agent=store.list<Agent>('agent')[0];let launches=0;
 const tasks=new Tasks(store,{start:async()=>{throw Error('No inference');},snapshot:runId=>store.get<Run>('run',runId),cancel:async()=>{}},{hostInstanceId:'host-one'});
 const changes={check:async()=>{launches++;throw Error('Unexpected command launch');},get:async()=>{throw Error('No source lookup');}},jobs=new HarnessCheckJobs(store,changes as never,tasks,'host-one');
 const request=(changeId:string)=>{const runId=id(),conversationId=store.conversations(agent.id)[0].id;store.put<Run>('run',{id:runId,agentId:agent.id,conversationId,messageId:id(),mode:'agent',status:'running',route:null,error:null,startedAt:now(),endedAt:null,usage:null});tasks.adopt({agentId:agent.id,runId,conversationId,title:'Fixture',prompt:'Check fixture'});const receiptId=runId+':check';store.put('workspace-tool',{id:receiptId,runId,agentId:agent.id,name:'relay_check_change',status:'pending',hash:'synthetic',createdAt:now()});return{runId,agentId:agent.id,changeId,revision:'one',receiptId};};
 return{store,jobs,request,get launches(){return launches;},async close(){await jobs.close();await tasks.close();store.close();await rm(dir,{recursive:true,force:true});}};
}
test('cancel-before-background-start launches no commands and releases bounded job capacity',async()=>{
 const f=await fixture();try{for(let n=0;n<4;n++){const input=f.request('change-'+n),accepted=f.jobs.requestCheck(input);await f.jobs.cancelForRun(input.runId);assert.equal((await f.jobs.requestStatus(accepted)).state,'cancelled');}assert.equal(f.launches,0);assert.equal(f.store.list<any>('source-check-job').length,4);}finally{await f.close();}
});
for(const state of['accepted','running','unknown'])test('old-host '+state+' same-change ownership cannot be bypassed by a new request',async()=>{
 const f=await fixture();try{f.store.put('source-check-job',{id:'prior',requestId:'prior',hostInstanceId:'old-host',changeId:'same-change',state});assert.throws(()=>f.jobs.requestCheck(f.request('same-change')),/pending or unknown owned check/);assert.equal(f.launches,0);}finally{await f.close();}
});
