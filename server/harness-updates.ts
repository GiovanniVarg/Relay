import {supervisorBinding} from './supervisor.js';
import {copyFile,mkdir,readFile,writeFile,lstat} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {randomUUID,randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {join,resolve,relative,isAbsolute,sep} from 'node:path';
import type {HarnessChanges} from './harness-changes.js';
import {HttpError,stringValue} from './security.js';

export interface ActivationStatus {status:string;changeId:string;revision?:string;runId?:string;requestId?:string;jobId?:string;message?:string;error?:string;backupDirectory?:string;newPid?:number;}
export interface ApplyRequest {runId:string;agentId:string;requestKey:string;}
export interface UpdateOptions {installDirectory:string;dataDirectory:string;instanceId?:string;port:()=>number;activeCount:()=>number;restart?:()=>Promise<void>;runState?:(runId:string)=>{agentId:string;mode?:string;status:string}|undefined;journal?:{get:(requestId:string)=>ActivationStatus|undefined;put:(status:ActivationStatus)=>unknown};}
/** The installed helper, never the proposed helper, owns recovery. Chat activation waits for its reply to finish. */
export class HarnessUpdates {
 private maintenance=false;
 private timer?:ReturnType<typeof setTimeout>;
 private queueTimer?:ReturnType<typeof setTimeout>;
 private queued?:ApplyRequest&{changeId:string;revision:string;receipt:ActivationStatus};
 private requests=new Map<string,{identity:string;receipt:ActivationStatus}>();
 private chatStatus?:ActivationStatus;
 private applyingRequest?:ActivationStatus;
 private closed=false;
 constructor(private changes:HarnessChanges,private options:UpdateOptions){}
 held(){return this.maintenance||!!(process.env.RELAY_UPDATE_HOLD&&existsSync(process.env.RELAY_UPDATE_HOLD));}
 pending(){return !!this.queued||this.maintenance;}
 cancelRequest(requestId:string):boolean {if(this.queued?.receipt.requestId!==requestId)return false;const receipt=this.queued.receipt;this.queued=undefined;this.chatStatus=this.record({...receipt,status:'cancelled',message:'The requesting task was stopped before activation began.'});if(this.queueTimer)clearTimeout(this.queueTimer);return true;}
 private record(status:ActivationStatus){if(status.requestId)this.options.journal?.put(structuredClone(status));return status;}
 /** Read the exact accepted job. A vanished process-local queue is unknown, never a replay instruction. */
 async requestStatus(external:{requestId:string;changeId:string;revision:string;runId:string;jobId?:string;status:string}){
  const saved=this.options.journal?.get(external.requestId);
  if(!saved||saved.changeId!==external.changeId||saved.revision!==external.revision||saved.runId!==external.runId||external.jobId&&saved.jobId!==external.jobId)return {...external,status:'unknown'};
  if(this.queued?.receipt.requestId===external.requestId)return {...external,...saved};
  if(saved.jobId&&/^[\da-f-]{36}$/.test(saved.jobId)){
   try{
    const directory=join(this.root(),'jobs',saved.jobId),phase=JSON.parse(await readFile(join(directory,'status.json'),'utf8')) as ActivationStatus&{dataPreserved?:boolean;recoveryRequired?:boolean},job=JSON.parse(await readFile(join(directory,'job.json'),'utf8')) as {id:string;changeId:string;revision?:string;requestId?:string;nonce?:string};
    if(phase.jobId!==saved.jobId||phase.changeId!==saved.changeId||job.id!==saved.jobId||job.changeId!==saved.changeId||job.revision!==saved.revision||job.requestId!==saved.requestId||phase.revision&&phase.revision!==saved.revision)return {...external,...saved,status:'unknown'};
    if(phase.recoveryRequired)return {...external,...saved,status:'unknown'};
    if(['complete','rolled_back'].includes(phase.status)){
     if(phase.dataPreserved!==true||typeof job.nonce!=='string'||!job.nonce)return {...external,...saved,status:'unknown'};
     if(existsSync(join(directory,'startup.hold')))return {...external,...saved,status:'pending'};
     try{if(await readFile(join(directory,'startup.hold.released'),'utf8')!==job.nonce)return {...external,...saved,status:'unknown'};}catch{return {...external,...saved,status:'pending'};}
     return {...external,...saved,status:phase.status};
    }
    if(['pending','waiting_for_shutdown','backing_up','installing','checking','restoring'].includes(phase.status))return {...external,...saved,status:'pending'};
    return {...external,...saved,status:['failed','cancelled'].includes(phase.status)?phase.status:'unknown'};
   }catch{return {...external,...saved,status:'unknown'};}
  }
  return {...external,...saved,status:['failed','cancelled'].includes(saved.status)?saved.status:'unknown'};
 }
 assertAvailable(){if(this.held())throw new HttpError(503,'Relay is applying an update. New work resumes after startup verification.');}
 private root(){return join(this.options.dataDirectory,'self-update');}
 async status():Promise<ActivationStatus|null>{
  if(this.queued||this.chatStatus?.status==='failed'||this.chatStatus?.status==='cancelled')return this.chatStatus??null;
  try {const key=(await readFile(join(this.root(),'latest'),'utf8')).trim();if(!/^[\da-f-]{36}$/.test(key))return this.chatStatus??null;const value=JSON.parse(await readFile(join(this.root(),'jobs',key,'status.json'),'utf8'));return value&&typeof value.status==='string'?value:this.chatStatus??null;}catch{return this.chatStatus??null;}
 }
 async requestApply(changeId:string,revision:string,request:ApplyRequest):Promise<ActivationStatus>{
  stringValue(changeId,'Change ID',100,1);stringValue(revision,'Revision',100,1);stringValue(request.requestKey,'Request key',500,1);this.assertAvailable();
  const owner=this.options.runState?.(request.runId);
  if(this.closed||!owner||owner.agentId!==request.agentId||owner.mode!=='agent'||owner.status!=='running')throw new HttpError(409,'Agent activation authority expired');
  const identity=JSON.stringify([changeId,revision,request.runId,request.agentId]),existing=this.requests.get(request.requestKey);
  if(existing){if(existing.identity!==identity)throw new HttpError(409,'Activation request key reused with different arguments');return structuredClone(existing.receipt);}
  if(this.queued)throw new HttpError(409,'A Relay change is already queued. Inspect its activation status.');
  if(!this.options.restart)throw new HttpError(409,'This embedded Relay server cannot restart itself. Start Relay with its normal launcher.');
  const current=await this.changes.get(changeId);
  if(current.revision!==revision||current.checkedRevision!==revision||current.status!=='ready')throw new HttpError(409,'This draft changed or has not passed checks for this exact revision.');
  // Revalidate after filesystem reads, including simultaneous requests. No queue is replayed after a crash.
  const live=this.options.runState?.(request.runId);this.assertAvailable();
  if(this.closed||!live||live.agentId!==request.agentId||live.mode!=='agent'||live.status!=='running')throw new HttpError(409,'Agent activation authority expired');
  const raced=this.requests.get(request.requestKey);if(raced){if(raced.identity!==identity)throw new HttpError(409,'Activation request key reused with different arguments');return structuredClone(raced.receipt);}
  if(this.queued)throw new HttpError(409,'A Relay change is already queued. Inspect its activation status.');
  const receipt:ActivationStatus={status:'queued',changeId,revision,runId:request.runId,requestId:randomUUID(),message:'Change accepted. Finish this reply; Relay applies the checked revision after all active work finishes. This is not a completed update.'};
  this.record(receipt);
  this.requests.set(request.requestKey,{identity,receipt});this.queued={...request,changeId,revision,receipt};this.chatStatus=receipt;this.scheduleQueue();return structuredClone(receipt);
 }
 private scheduleQueue(){if(this.closed||!this.queued)return;this.queueTimer=setTimeout(()=>{void this.drainQueue();},100);this.queueTimer.unref();}
 private async drainQueue(){
  const queued=this.queued;if(!queued||this.closed)return;
  try{
   const owner=this.options.runState?.(queued.runId);
   if(!owner||owner.agentId!==queued.agentId||owner.mode!=='agent'||!['running','complete'].includes(owner.status)){
    this.chatStatus=this.record({...queued.receipt,status:'cancelled',message:'Queued activation cancelled because its requesting turn did not finish successfully.'});this.queued=undefined;return;
   }
   if(owner.status!=='complete'||this.options.activeCount()){this.scheduleQueue();return;}
   const current=await this.changes.get(queued.changeId);
   if(this.closed||this.queued!==queued)return;
   if(current.revision!==queued.revision||current.checkedRevision!==queued.revision||current.status!=='ready')throw new HttpError(409,'Queued draft changed or its checks are stale. Check the current revision and request activation again.');
   // Recheck activity after asynchronous reads. apply() synchronously reserves maintenance before preparing files.
   const finalOwner=this.options.runState?.(queued.runId);
   if(finalOwner?.status!=='complete'||finalOwner.agentId!==queued.agentId||finalOwner.mode!=='agent')throw new HttpError(409,'Agent activation authority expired');
   if(this.options.activeCount()){this.scheduleQueue();return;}
   this.queued=undefined;this.applyingRequest=queued.receipt;this.chatStatus=this.record({...queued.receipt,...await this.apply(queued.changeId,queued.revision)});
  }catch(error){this.queued=undefined;this.chatStatus=this.record({...queued.receipt,status:'failed',error:error instanceof Error?error.message:String(error),message:'Queued activation stopped. The running Relay was kept open.'});}finally{this.applyingRequest=undefined;}
 }
 async apply(changeId:string,revision:string){
  stringValue(revision,'Revision',100,1);this.assertAvailable();
  if(this.queued)throw new HttpError(409,'A chat activation is already queued. Wait for its requesting turn to finish.');
  this.chatStatus=undefined;
  if(!this.options.restart)throw new HttpError(409,'This embedded Relay server cannot restart itself. Start Relay with its normal launcher.');
  if(this.options.activeCount())throw new HttpError(409,'Finish or stop active chats and group work before applying Relay changes.');
  this.maintenance=true;
  let statusFile:string|undefined;
  try {
   const current=await this.changes.get(changeId);if(current.revision!==revision)throw new HttpError(409,'This draft changed. Review and check the current revision before applying.');
   const snapshot=await this.changes.prepareApply(changeId);
   if(snapshot.revision!==revision)throw new HttpError(409,'The prepared source revision changed. Review and check the current draft again.');
   const key=randomUUID(),jobDirectory=join(this.root(),'jobs',key),backupDirectory=join(this.root(),'backups',key);
   const installedHelper=join(this.options.installDirectory,'scripts','activate-relay.mjs');
   if((await lstat(installedHelper)).isSymbolicLink())throw new HttpError(409,'Installed activation helper must be an ordinary local file.');
   // Private control files are never copied from a draft, and never exposed as writable source files.
   await mkdir(jobDirectory,{recursive:true});
   const helper=join(jobDirectory,'activate-relay.mjs'),jobFile=join(jobDirectory,'job.json'),statusPath=join(jobDirectory,'status.json'),holdPath=join(jobDirectory,'startup.hold');
   statusFile=statusPath;
   await copyFile(installedHelper,helper);
   const supervisor=await supervisorBinding(this.options.dataDirectory,this.options.installDirectory,this.options.port(),this.options.instanceId);
   const job={version:1,createdAt:new Date().toISOString(),...(supervisor?{supervisor}:{}),id:key,changeId,revision,...(this.applyingRequest?.requestId?{requestId:this.applyingRequest.requestId}:{}),installDirectory:resolve(this.options.installDirectory),dataDirectory:resolve(this.options.dataDirectory),snapshotDirectory:snapshot.snapshotDirectory,backupDirectory,statusPath,holdPath,port:this.options.port(),oldPid:process.pid,nonce:randomBytes(32).toString('hex'),sourceFiles:snapshot.sourceFiles,baseFiles:snapshot.baseFiles,distFiles:snapshot.distFiles,dependencyFiles:snapshot.dependencyFiles};
   await writeFile(jobFile,JSON.stringify(job,null,2),{flag:'wx'});
   const pending:ActivationStatus={...this.applyingRequest,status:'pending',changeId,revision,jobId:key,backupDirectory,message:'Restarting Relay. Keep this window open; it reconnects after verification.'};
   await writeFile(statusPath,JSON.stringify(pending));await writeFile(join(this.root(),'latest'),key);
   // Durable request -> exact revision/job association precedes spawning the trusted installed helper.
   this.record(pending);
   const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|HOME|LANG)$/i.test(name)));
   const child=spawn(process.execPath,[helper,'--job',jobFile],{cwd:jobDirectory,env,detached:true,windowsHide:true,stdio:'ignore'});
   await new Promise<void>((done,reject)=>{child.once('spawn',done);child.once('error',reject);});
   // Spawning is not proof of a valid update. Keep the current server alive until preflight succeeds.
   const until=Date.now()+120000;
   while(true){
    let phase:ActivationStatus|null=null;try{phase=JSON.parse(await readFile(statusPath,'utf8'));}catch{}
    if(phase?.status==='waiting_for_shutdown')break;
    if(child.exitCode!==null||child.signalCode!==null||phase?.status==='failed')throw new HttpError(409,phase?.error??'Updater preflight failed. Relay is still running.');
    if(Date.now()>until){child.kill();throw new HttpError(409,'Updater preflight timed out. Relay is still running.');}
    await new Promise(done=>setTimeout(done,100));
   }
   child.unref();
   this.timer=setTimeout(()=>{void this.options.restart!().catch(async error=>{this.maintenance=false;await writeFile(statusPath,JSON.stringify({...pending,status:'failed',error:'Relay could not close for update: '+String(error)}));});},350);
   return pending;
  }catch(error){this.maintenance=false;if(statusFile)await writeFile(statusFile,JSON.stringify({status:'failed',changeId,error:error instanceof Error?error.message:String(error),message:'Preflight stopped. The running Relay was kept open.'})).catch(()=>{});throw error;}
 }
 async revert(changeId:string){
  this.assertAvailable();const previous=await this.status();
  if(previous?.changeId!==changeId||previous.status!=='complete'||!previous.backupDirectory)throw new HttpError(409,'No successful update backup is available for this change.');
  const base=resolve(this.root(),'backups'),target=resolve(previous.backupDirectory),rel=relative(base,target);
  if(!rel||isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep)||(await lstat(target)).isSymbolicLink())throw new HttpError(409,'Invalid recovery backup path.');
  return this.changes.restoreDraft(join(target,'app'),'Revert: '+(await this.changes.get(changeId)).title);
 }
 close(){this.closed=true;if(this.timer)clearTimeout(this.timer);if(this.queueTimer)clearTimeout(this.queueTimer);this.queued=undefined;}
}
