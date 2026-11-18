import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../server/store.js';
import {HarnessCheckJobs} from '../server/harness-check-jobs.js';
import type {BootObservation} from '../server/provider-recovery.js';

const utc=(milliseconds:number)=>new Date(milliseconds).toISOString();
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'relay-check-boot-')),store=new Store(root);let now=Date.parse('2026-11-05T12:00:00Z'),observation:BootObservation={source:'unavailable'},launches=0;
 const jobs=new HarnessCheckJobs(store,{check:async()=>{launches++;throw Error('Must not execute');}}as never,{}as never,'new-host',{clock:()=>now,observeBoot:async()=>observation});
 const acceptedAt=utc(now-10000),job={version:1,id:'exact-request',requestId:'exact-request',taskId:'task',agentId:'agent',attempt:1,runId:'run',receiptId:'run:check',changeId:'draft',revision:'one',acceptedAt,hostInstanceId:'old-host',state:'unknown',cleanup:'unknown',executionStartedAt:acceptedAt,unsafeAt:utc(now-5000)};
 store.put('source-check-job',job);store.put('task',{id:'task',status:'needs_input',recoveryRequired:true,budget:{calls:1,maxCalls:2,deadline:utc(now-1000)},pendingCheck:{requestId:job.id}});
 const observe=(boot:number,at=now)=>{now=at;observation={source:'win32-operating-system',bootedAt:utc(boot),observedAt:utc(at),uptimeMilliseconds:String(at-boot)};};
 return{store,jobs,job,get now(){return now;},get launches(){return launches;},observe,setObservation(value:BootObservation){observation=value;},advance(amount:number){now+=amount;},async close(){await jobs.close();store.close();await rm(root,{recursive:true,force:true});}};
}
test('unknown cleanup holds activation through same boot; exact newer kernel proof clears liveness only',async()=>{
 const f=await fixture();try{
  const task=f.store.get<any>('task','task');assert.equal(f.jobs.unsafeCount(),1);f.observe(f.now-100000);await f.jobs.reconcileUnsafeChecks();assert.equal(f.jobs.unsafeCount(),1);assert.equal(f.store.list('source-check-boot-baseline').length,1);
  f.advance(10000);f.observe(f.now-110000);await f.jobs.reconcileUnsafeChecks();assert.equal(f.jobs.unsafeCount(),1,'app restart or unchanged kernel is not cleanup proof');
  f.advance(20000);f.observe(f.now-1000);await f.jobs.reconcileUnsafeChecks();assert.equal(f.jobs.unsafeCount(),0);assert.equal(f.store.list<any>('source-check-job')[0].state,'unknown');assert.equal(f.store.list('source-check-cleanup-audit').length,1);assert.deepEqual(f.store.get('task','task'),task);assert.equal(f.launches,0);
 }finally{await f.close();}
});
test('a first observation after reboot records a baseline rather than releasing unknown work',async()=>{
 const f=await fixture();try{f.observe(f.now-1000);await f.jobs.reconcileUnsafeChecks();assert.equal(f.jobs.unsafeCount(),1);assert.equal(f.store.list('source-check-cleanup-audit').length,0);}finally{await f.close();}
});
for(const bad of['missing','future','stale','inconsistent','same-uptime','fingerprint']as const)test('boot cleanup refuses '+bad+' proof',async()=>{
 const f=await fixture();try{
  f.observe(f.now-100000);await f.jobs.reconcileUnsafeChecks();f.advance(20000);
  if(bad==='missing')f.setObservation({source:'unavailable'});
  else if(bad==='future')f.setObservation({source:'win32-operating-system',bootedAt:utc(f.now+1000),observedAt:utc(f.now),uptimeMilliseconds:'1000'});
  else if(bad==='stale')f.setObservation({source:'win32-operating-system',bootedAt:utc(f.now-1000),observedAt:utc(f.now-20000),uptimeMilliseconds:'1000'});
  else if(bad==='inconsistent')f.setObservation({source:'win32-operating-system',bootedAt:utc(f.now-1000),observedAt:utc(f.now),uptimeMilliseconds:'900000'});
  else if(bad==='same-uptime')f.observe(f.now-120000);
  else{f.store.put('source-check-job',{...f.store.list<any>('source-check-job')[0],revision:'changed'});f.observe(f.now-1000);}
  await f.jobs.reconcileUnsafeChecks();assert.equal(f.jobs.unsafeCount(),1);assert.equal(f.store.list('source-check-cleanup-audit').length,0);assert.equal(f.launches,0);
 }finally{await f.close();}
});
test('cleanly drained interrupted results and never-started acceptance require no reboot or replay',async()=>{
 const f=await fixture();try{f.store.put('source-check-job',{...f.job,state:'unknown',cleanup:'drained'});assert.equal(f.jobs.unsafeCount(),0);f.store.put('source-check-job',{...f.job,state:'accepted',cleanup:'not_started',executionStartedAt:undefined,unsafeAt:undefined});await f.jobs.reconcileUnsafeChecks();assert.equal(f.jobs.unsafeCount(),0);assert.equal(f.store.list<any>('source-check-job')[0].state,'unknown');assert.equal(f.launches,0);}finally{await f.close();}
});
for(const cleanup of['not_started','drained'])test('restart during copy or between commands is not a native liveness hold: '+cleanup,async()=>{
 const f=await fixture();try{f.store.put('source-check-job',{...f.job,state:'running',cleanup,executionStartedAt:cleanup==='drained'?f.job.executionStartedAt:undefined,unsafeAt:undefined});await f.jobs.reconcileUnsafeChecks();assert.equal(f.jobs.unsafeCount(),0);assert.equal(f.store.list<any>('source-check-job')[0].state,'unknown');assert.equal(f.launches,0);assert.equal(f.store.list('source-check-boot-baseline').length,0);}finally{await f.close();}
});
