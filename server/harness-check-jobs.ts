import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import type {Run} from '../shared/types.js';
import type {TaskPendingCheck,TaskCheckStatus} from '../shared/tasks.js';
import type {HarnessChanges} from './harness-changes.js';
import type {Tasks} from './tasks.js';
import type {Store} from './store.js';
import {HttpError,redactSecrets} from './security.js';
import {observeWindowsBoot,strictUtcMilliseconds,type BootObservation} from './provider-recovery.js';

export const CHECK_JOB_MAX_MS=65*60*1000;
interface CheckJob extends TaskCheckStatus {id:string;agentId:string;version:1;cleanup:'not_started'|'running'|'drained'|'unknown';executionStartedAt?:string;unsafeAt?:string;cleanupError?:string;}
type Owned={controller:AbortController;promise:Promise<void>;endedMonotonic?:number};
/** Accepted exact source checks belong to the host, never to a provider timeout. */
export class HarnessCheckJobs {
 private owned=new Map<string,Owned>();private closed=false;
 constructor(private store:Store,private changes:HarnessChanges,private tasks:Tasks,readonly hostInstanceId:string,private recovery:{observeBoot?:()=>Promise<BootObservation>;clock?:()=>number}={}){}
 unsafeCount(){return this.store.list<CheckJob>('source-check-job').filter(job=>job.cleanup==='running'||job.cleanup==='unknown'||!job.cleanup&&['accepted','running','unknown'].includes(job.state)).length;}
 busyCount(){return this.unsafeCount()+[...this.owned].filter(([id,owned])=>owned.endedMonotonic===undefined&&!['running','unknown'].includes(this.store.get<CheckJob>('source-check-job',id)?.cleanup??'')).length;}
 requestCheck(input:{runId:string;agentId:string;changeId:string;revision:string;receiptId:string}):TaskPendingCheck{
  if(this.closed)throw new HttpError(409,'Relay is closing');
  const requestId=createHash('sha256').update(input.receiptId).digest('hex'),old=this.store.get<CheckJob>('source-check-job',requestId);
  if(old){if(old.agentId!==input.agentId||old.runId!==input.runId||old.changeId!==input.changeId||old.revision!==input.revision||old.receiptId!==input.receiptId)throw new HttpError(409,'Check request identity changed');return this.acceptance(old);}
  if([...this.owned.values()].filter(job=>job.endedMonotonic===undefined).length>=2)throw new HttpError(409,'Two source checks already belong to this host. Wait for a result.');
  if(this.store.list<CheckJob>('source-check-job').some(job=>job.changeId===input.changeId&&(job.cleanup!=='drained'&&['accepted','running','unknown'].includes(job.state))))throw new HttpError(409,'This source change has a pending or unknown owned check. Inspect its saved task; it cannot be replayed.');
  const run=this.store.get<Run>('run',input.runId),task=this.tasks.forRun(input.runId);
  if(!run||run.status!=='running'||run.mode!=='agent'||run.agentId!==input.agentId||!task||task.agentId!==input.agentId||task.recoveryRequired||!['working','needs_input'].includes(task.status)||task.pendingCheck)throw new HttpError(409,'Check task authority expired or another check is pending');
  const job:CheckJob={id:requestId,requestId,version:1,...input,taskId:task.id,attempt:task.attempt,acceptedAt:new Date().toISOString(),hostInstanceId:this.hostInstanceId,state:'accepted',cleanup:'not_started'};
  const accepted=this.acceptance(job);
  this.store.transaction(()=>{
   const receipt=this.store.get<{id:string;runId:string;agentId:string;name:string;status:string}>('workspace-tool',input.receiptId);
   if(!receipt||receipt.runId!==input.runId||receipt.agentId!==input.agentId||receipt.name!=='relay_check_change'||receipt.status!=='pending')throw new HttpError(409,'Check receipt ownership changed');
   this.store.put('source-check-job',job);this.tasks.deferCheck(input.runId,accepted);
   this.store.put('workspace-tool',{...receipt,status:'complete',result:accepted});
  });
  const controller=new AbortController(),owned:Owned={controller,promise:Promise.resolve()};this.owned.set(requestId,owned);
  // Everything needed to recover acceptance is durable before any command starts.
  owned.promise=Promise.resolve().then(()=>this.execute(job,owned));void owned.promise.catch(()=>{});
  return accepted;
 }
 private acceptance(job:CheckJob):TaskPendingCheck&{message:string}{return{requestId:job.requestId,changeId:job.changeId,revision:job.revision,runId:job.runId,taskId:job.taskId,attempt:job.attempt,receiptId:job.receiptId,acceptedAt:job.acceptedAt,hostInstanceId:job.hostInstanceId,state:'accepted',message:'Exact source check accepted, not passed. End this provider turn now. This task will wait for its host-owned result. Do not poll, repeat the check, apply a change, or claim success from acceptance.'};}
 private async execute(job:CheckJob,owned:Owned){
  if(!owned.controller.signal.aborted)this.store.put('source-check-job',{...job,state:'running'});
  const timer=setTimeout(()=>owned.controller.abort(new Error('Owned source check exceeded its fixed host time limit')),CHECK_JOB_MAX_MS);
  let state:CheckJob['state']='unknown',error:string|null=null,terminationUnknown=false;
  try{
   if(owned.controller.signal.aborted)throw owned.controller.signal.reason;
   const result=await this.changes.check(job.changeId,{expectedRevision:job.revision,signal:owned.controller.signal,commandLifecycle:state=>{const latest=this.store.get<CheckJob>('source-check-job',job.id)!;this.store.put('source-check-job',{...latest,cleanup:state,...(state==='running'?{executionStartedAt:new Date().toISOString()}:state==='unknown'?{unsafeAt:new Date().toISOString()}: {})});}});
   state=result.status==='ready'&&result.revision===job.revision&&result.checkedRevision===job.revision?'ready':'unknown';
  }catch(failure){
   error=redactSecrets(failure instanceof Error?failure.message:'Owned check failed').slice(0,1000);
   terminationUnknown=!!failure&&typeof failure==='object'&&'code'in failure&&failure.code==='HARNESS_CHECK_OUTCOME_UNKNOWN';
   if(!owned.controller.signal.aborted){try{const current=await this.changes.get(job.changeId);state=!(failure instanceof HttpError)&&current.status==='failed'&&current.revision===job.revision&&current.error===(failure instanceof Error?failure.message:String(failure))?'failed':'unknown';}catch{state='unknown';}}
  }finally{
   clearTimeout(timer);owned.endedMonotonic=performance.now();
   const latest=this.store.get<CheckJob>('source-check-job',job.id)!;
   // Explicit cancellation is durable before drain and wins a completion race.
   this.store.put('source-check-job',{...latest,state:terminationUnknown?'unknown':latest.state==='cancelled'||latest.state==='unknown'?latest.state:state,cleanup:terminationUnknown?'unknown':'drained',...(terminationUnknown?{unsafeAt:new Date().toISOString()}:{}),error,endedAt:new Date().toISOString()});
  }
 }
 async requestStatus(check:TaskPendingCheck):Promise<TaskCheckStatus>{
  const job=this.store.get<CheckJob>('source-check-job',check.requestId);
  if(!job||job.hostInstanceId!==this.hostInstanceId||check.hostInstanceId!==this.hostInstanceId||job.taskId!==check.taskId||job.attempt!==check.attempt||job.runId!==check.runId||job.receiptId!==check.receiptId||job.changeId!==check.changeId||job.revision!==check.revision)return{...check,state:'unknown',error:'Check ownership or host changed'};
  const owned=this.owned.get(job.id);if(!owned)return{...check,state:'unknown',error:'The previous host check outcome must be inspected'};
  let current=false;if(job.state==='ready'||job.state==='failed'){try{const change=await this.changes.get(job.changeId);current=change.revision===job.revision&&(job.state==='ready'?change.status==='ready'&&change.checkedRevision===job.revision:change.status==='failed'&&change.error===job.error);}catch{}}
  return{...check,state:(job.state==='ready'||job.state==='failed')&&!current?'unknown':job.state,endedAt:job.endedAt,endedMonotonic:owned.endedMonotonic,current,error:job.cleanupError??job.error};
 }
 /** Existing host boot proof clears local process liveness only, never task authority. */
 async reconcileUnsafeChecks(runId?:string):Promise<void>{
  const clock=this.recovery.clock??Date.now;
  let observation:Promise<BootObservation>|undefined;
  for(const initial of this.store.list<CheckJob>('source-check-job')){
   if(runId&&initial.runId!==runId)continue;
   const active=this.owned.get(initial.id);if(active&&active.endedMonotonic===undefined)continue;
   if(initial.cleanup==='drained'){if(['accepted','running'].includes(initial.state)){this.store.put('source-check-job',{...initial,state:'unknown',error:'Relay restarted between source check commands. No commands were replayed.'});this.tasks.checkCleanupAttention?.(initial,'Relay restarted between check commands. Native cleanup is verified; inspect saved source results before starting further work. No check was replayed.');}continue;}
   if(initial.version===1&&initial.cleanup==='not_started'&&!initial.executionStartedAt){this.store.put('source-check-job',{...initial,state:'unknown',cleanup:'drained',error:'Relay restarted before the accepted check began. No commands were replayed.'});this.tasks.checkCleanupAttention?.(initial,'Relay restarted before source check commands began. No commands were replayed. Inspect the saved source change before further work.');continue;}
   const unsafeAt=initial.unsafeAt??initial.executionStartedAt??initial.acceptedAt;
   let job:CheckJob={...initial,state:'unknown',cleanup:'unknown',unsafeAt,cleanupError:'Source check process cleanup is unconfirmed. A full Windows Restart after its trusted boot baseline is required; restarting Relay, sleep and fast-start shutdown do not prove cleanup. No task or check is replayed.'};this.store.put('source-check-job',job);this.tasks.checkCleanupAttention?.(job,job.cleanupError!);
   const held=strictUtcMilliseconds(unsafeAt),before=clock();
   if(initial.version!==1||!job.id||job.requestId!==job.id||!job.taskId||!job.runId||!job.agentId||!job.changeId||!job.revision||!job.hostInstanceId||!Number.isSafeInteger(job.attempt)||job.attempt<1||held===undefined||held>before)continue;
   const hash=createHash('sha256').update(JSON.stringify([job.version,job.id,job.taskId,job.attempt,job.runId,job.agentId,job.changeId,job.revision,job.receiptId,job.hostInstanceId,job.executionStartedAt??null,job.unsafeAt])).digest('hex');
   observation??=(this.recovery.observeBoot??observeWindowsBoot)().catch(()=>({source:'unavailable' as const}));const value=await observation,after=clock();
   if(value.source!=='win32-operating-system')continue;
   const boot=strictUtcMilliseconds(value.bootedAt),observed=strictUtcMilliseconds(value.observedAt),validUptime=(text:unknown)=>typeof text==='string'&&/^[1-9]\d{0,19}$/.test(text)&&BigInt(text)<=BigInt(Number.MAX_SAFE_INTEGER)?BigInt(text):undefined,uptime=validUptime(value.uptimeMilliseconds);
   if(!Number.isFinite(before)||!Number.isFinite(after)||after<before||observed===undefined||observed<before-15000||observed>after||after-observed>15000||boot===undefined||boot>observed||uptime===undefined||Math.abs(boot+Number(uptime)-observed)>60000)continue;
   const baselineId='source-check-boot-'+job.id,baseline=this.store.get<{id:string;fingerprint:string;bootedAt:string;observedAt:string;maxUptimeMilliseconds:string}>('source-check-boot-baseline',baselineId);
   if(!baseline){this.store.put('source-check-boot-baseline',{id:baselineId,fingerprint:hash,bootedAt:value.bootedAt,observedAt:value.observedAt,maxUptimeMilliseconds:value.uptimeMilliseconds});continue;}
   const priorObserved=strictUtcMilliseconds(baseline.observedAt),priorBoot=strictUtcMilliseconds(baseline.bootedAt),priorUptime=validUptime(baseline.maxUptimeMilliseconds);
   if(baseline.fingerprint!==hash||priorObserved===undefined||priorBoot===undefined||priorBoot>priorObserved||priorObserved>observed||priorUptime===undefined)continue;
   if(boot<=held+1000||boot<=priorObserved+1000||uptime>=priorUptime){this.store.put('source-check-boot-baseline',{...baseline,observedAt:value.observedAt,maxUptimeMilliseconds:(uptime>priorUptime?uptime:priorUptime).toString()});continue;}
   this.store.transaction(()=>{const latest=this.store.get<CheckJob>('source-check-job',job.id);if(!latest||JSON.stringify(latest)!==JSON.stringify(job))return;this.store.put('source-check-cleanup-audit',{id:job.id,requestId:job.id,fingerprint:hash,method:'windows-kernel-boot',bootedAt:value.bootedAt,observedAt:value.observedAt,uptimeMilliseconds:value.uptimeMilliseconds,baselineObservedAt:baseline.observedAt,baselineMaxUptimeMilliseconds:baseline.maxUptimeMilliseconds,recoveredAt:new Date(after).toISOString()});job={...job,cleanup:'drained',cleanupError:undefined};this.store.put('source-check-job',job);this.tasks.checkCleanupAttention?.(job,'Windows kernel restart verified native process cleanup. Inspect the saved source check before further work; no task, check, budget or activation was resumed.');});
  }
 }
 async cancelForRun(runId:string,closing=false):Promise<void>{
  const jobs=this.store.list<CheckJob>('source-check-job').filter(job=>job.runId===runId&&job.hostInstanceId===this.hostInstanceId&&['accepted','running'].includes(job.state));
  for(const job of jobs){
   const owned=this.owned.get(job.id);this.store.put('source-check-job',{...job,state:closing?'unknown':'cancelled',error:closing?'Relay closed during its owned check':'Cancelled by user'});
   owned?.controller.abort(new Error(closing?'Relay is shutting down':'Cancelled by user'));
   if(owned){let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([owned.promise,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Owned check termination could not be confirmed')),5000);})]);if(this.store.get<CheckJob>('source-check-job',job.id)?.state==='unknown'&&!closing)throw new Error('Owned check termination could not be confirmed');}catch(error){const latest=this.store.get<CheckJob>('source-check-job',job.id)!;this.store.put('source-check-job',{...latest,state:'unknown'});throw error;}finally{if(timer)clearTimeout(timer);}}
  }
  await this.reconcileUnsafeChecks(runId);
  const unsafe=this.store.list<CheckJob>('source-check-job').find(job=>job.runId===runId&&(job.cleanup==='unknown'||job.cleanup==='running'));if(unsafe&&!closing)throw new Error(unsafe.cleanupError??'Owned check termination could not be confirmed');
 }
 async close(){this.closed=true;await Promise.all([...new Set(this.store.list<CheckJob>('source-check-job').filter(job=>job.hostInstanceId===this.hostInstanceId&&['accepted','running'].includes(job.state)).map(job=>job.runId))].map(runId=>this.cancelForRun(runId,true)));}
}
