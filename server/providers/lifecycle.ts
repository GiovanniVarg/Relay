import {validAccountDescriptor,type AccountDescriptor} from '../../shared/accounts.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fork, execFile, spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { open, mkdir, readFile, readdir, lstat, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import type { ProviderAdapter, ProviderId, ProviderRequest, ProviderResult, ProviderEvent } from '../../shared/types.js';
import { ChildRegistry, registrationProof, type RegistryIdentity } from '../herdr/registry.js';
import { WindowsTreeGuard } from '../herdr/tree-guard.js';
import { createAppToolSession, AppToolExecutionError } from '../app-tools-bridge.js';
import { CodexAdapter } from './codex.js';
import { ClaudeAdapter } from './claude.js';
import { CursorAdapter } from './cursor.js';
import { OpenCodeAdapter } from './opencode.js';
import { boundedPrompt, childEnvironment, launch, providerOutcomeUnknown, safeError, type Launcher } from './process.js';
import { assertCursorJson, cursorRequestData } from './cursor-session-runtime.js';
import { requestImages } from '../attachment-context.js';
import {isOutcomeReconciliation} from '../outcome-reconciliation.js';

const exec = promisify(execFile);
const record = (v:unknown):v is Record<string,any> => !!v && typeof v==='object' && !Array.isArray(v);
const id = (v:unknown):v is string => typeof v==='string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(v);
const activeCalls = new Map<string,number>();
export const PROVIDER_IPC_BYTES = 32 * 1024 * 1024;
export function validateProviderMessage(value:unknown,last:number,allowed:string[]):{seq:number;type:string;data:any} {
 assertCursorJson(value,record(value)&&value.type==='init'?PROVIDER_IPC_BYTES:2*1024*1024);
 if(!record(value)||Object.keys(value).some(k=>!['seq','type','data'].includes(k))||value.seq!==last+1||!allowed.includes(value.type)||!record(value.data))throw Error('Invalid provider worker message');
 return value as {seq:number;type:string;data:any};
}
export interface ProviderBootstrap extends RegistryIdentity {provider:ProviderId;dataDir:string;directory:string;account?:AccountDescriptor;registryKey:string;outcomeReconciliation?:true;request:Omit<ProviderRequest,'interact'|'appTools'> & {appTools?:{definitions:NonNullable<ProviderRequest['appTools']>['definitions']};hasInteraction?:boolean};}
interface Guard {drain():Promise<number[]>;release():Promise<void>;}
export interface OwnedOptions {account?:AccountDescriptor;provider:ProviderId;dataDir:string;directory:string;request:ProviderRequest;signal:AbortSignal;emit:(event:ProviderEvent)=>void;registry:ChildRegistry;
 createGuard?:(directory:string,track:(child:ChildProcessWithoutNullStreams)=>void)=>Promise<Guard>;
 createAdapter?:(provider:ProviderId,dataDir:string,launcher:Launcher,kill:(child:ChildProcessWithoutNullStreams)=>Promise<void>,account?:AccountDescriptor)=>ProviderAdapter;
}
/** Runs only inside the isolated worker. Never call the Windows guard in the Relay server. */
export async function executeOwnedProvider(o:OwnedOptions):Promise<{result?:ProviderResult;error?:unknown;cleanup:boolean}> {
 const children=new Set<ChildProcessWithoutNullStreams>(),closed=new Set<ChildProcessWithoutNullStreams>();
 const track=(child:ChildProcessWithoutNullStreams,launchId=randomUUID(),intentWritten=false)=>{if(!intentWritten)o.registry.append('intent',{launchId});o.registry.append('spawn',{launchId,pid:child.pid??null});children.add(child);child.once('close',()=>{o.registry.append('exit',{launchId,pid:child.pid??null});closed.add(child);});};
 const launcher:Launcher=(command,args,cwd,env)=>{const launchId=randomUUID();o.registry.append('intent',{launchId});const child=o.provider==='cursor'?spawn(command.file,[...command.args,...args],{cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe','ipc']}) as ChildProcessWithoutNullStreams:launch(command,args,cwd,env);track(child,launchId,true);return child;};
 let guard:Guard|undefined,adapter:ProviderAdapter|undefined,result:ProviderResult|undefined,error:unknown,nativeStarted=false,proved=false;
 try {
  if(o.signal.aborted)throw Error('Run cancelled');
  if(o.account&&(!validAccountDescriptor(o.account,o.provider)||o.request.accountId!==o.account.accountId||o.request.accountProfileGeneration!==o.account.profileGeneration))throw Error('Provider worker account mismatch');
  guard=await (o.createGuard??WindowsTreeGuard.create)(o.directory,child=>track(child));
  if(guard instanceof WindowsTreeGuard)o.registry.append('guard',{pid:guard.child.pid!});
  if(o.signal.aborted)throw Error('Run cancelled');
  const kill=async()=>{const pids=await guard!.drain();for(const pid of pids){const launchId=randomUUID();o.registry.append('intent',{launchId});o.registry.append('spawn',{launchId,pid});o.registry.append('exit',{launchId,pid});}};
  adapter=(o.createAdapter??((provider,dataDir,ownedLauncher,ownedKill,account)=>provider==='openai'?new CodexAdapter(dataDir,{launcher:ownedLauncher,kill:ownedKill}):provider==='claude'?new ClaudeAdapter(dataDir,{launcher:ownedLauncher,kill:ownedKill,isolatedProfile:!!account}):provider==='opencode'?new OpenCodeAdapter(dataDir,{launcher:ownedLauncher,kill:ownedKill}):new CursorAdapter(dataDir,{launcher:ownedLauncher,kill:ownedKill})))(o.provider,o.dataDir,launcher,kill,o.account);
  if(adapter.id!==o.provider)throw Error('Provider worker adapter mismatch');
  nativeStarted=true;result=await adapter.stream(o.request,o.emit,o.signal);
  if(result.actualModel!==undefined&&result.actualModel!==o.request.model)throw Error('Native adapter returned an unexpected model');
 }catch(e){error=e;}
 finally {
  try{await adapter?.close();}catch(e){error??=e;}
  if(guard)try{const pids=await guard.drain();for(const pid of pids){const launchId=randomUUID();o.registry.append('intent',{launchId});o.registry.append('spawn',{launchId,pid});o.registry.append('exit',{launchId,pid});}await guard.release();proved=true;}catch(e){error??=e;}
  else proved=!nativeStarted;
 }
 await Promise.all([...children].filter(child=>!closed.has(child)).map(child=>new Promise<void>(done=>{const timeout=setTimeout(done,5000);child.once('close',()=>{clearTimeout(timeout);done();});})));
 const cleanup=proved&&[...children].every(child=>closed.has(child));
 o.registry.append('complete',{cleanup,treeScope:guard?'windows-job':'not-started'});
 return {result,error,cleanup};
}
interface Receipt extends RegistryIdentity {version:1;provider:ProviderId;account?:AccountDescriptor;registryKey:string;workerPid?:number;activeCallbacks:number;dispatchCommitted:boolean;status:'launching'|'running'|'stopped'|'unknown';}
const runDirectory=(dataDir:string,runId:string,provider:ProviderId)=>join(resolve(dataDir),'provider-calls',createHash('sha256').update(provider+'\0'+runId).digest('hex'));
async function privateDirectory(path:string):Promise<void>{await mkdir(path,{recursive:true,mode:0o700});if(process.platform==='win32'){const sid=(await exec('whoami.exe',['/user','/fo','csv','/nh'],{windowsHide:true,timeout:5000})).stdout.match(/S-1-[0-9-]+/)?.[0];if(!sid)throw Error('Provider worker privacy could not be established');await exec('icacls.exe',[path,'/inheritance:r','/grant:r','*'+sid+':(OI)(CI)F'],{windowsHide:true,timeout:5000});}}
async function persist(path:string,value:unknown):Promise<void>{const temp=path+'.tmp';const file=await open(temp,'w',0o600);try{await file.writeFile(JSON.stringify(value));await file.sync();}finally{await file.close();}await rename(temp,path);}
export function providerProcessGone(pid:number):boolean{if(!Number.isSafeInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return false;}catch(e:any){return e.code==='ESRCH';}}
async function callProof(directory:string,receipt:Receipt):Promise<boolean>{
 try{
 const retained:Receipt=JSON.parse(await readFile(join(directory,'receipt.json'),'utf8'));
 if(retained.activeCallbacks!==0||retained.provider!==receipt.provider||retained.parentRunId!==receipt.parentRunId||retained.delegationId!==receipt.delegationId||retained.epoch!==receipt.epoch||retained.registryKey!==receipt.registryKey||retained.workerPid!==receipt.workerPid||retained.dispatchCommitted!==receipt.dispatchCommitted)return false;
 // The trusted worker cannot create a guard, adapter, or provider before receiving init.
 // This marker is durably set true before any init send, and is never reverted.
 if(retained.dispatchCommitted===false)return Number.isSafeInteger(retained.workerPid)&&Number(retained.workerPid)>0&&providerProcessGone(retained.workerPid!);
 if(retained.dispatchCommitted!==true)return false;
 const proof=await registrationProof(join(directory,'children.jsonl'),receipt,receipt.registryKey);
 if(!proof.valid||!proof.complete||!proof.cleanup||!receipt.workerPid||!proof.pids.includes(receipt.workerPid)||!proof.pids.every(providerProcessGone))return false;
 // Registry scope and spawn/exit identities must agree, in addition to authenticating records.
 const lines=(await readFile(join(directory,'children.jsonl'),'utf8')).trimEnd().split('\n').map(line=>JSON.parse(line).data);
 const launches=new Map<string,number|null>();let guardPid:number|undefined;
 for(const row of lines){if(row.kind==='spawn')launches.set(row.launchId,row.pid??null);if(row.kind==='exit'&&(!launches.has(row.launchId)||launches.get(row.launchId)!==(row.pid??null)))return false;if(row.kind==='guard')guardPid=row.pid;}
 const complete=lines.at(-1);if(complete.treeScope==='windows-job')return proof.kernelBound&&!!guardPid&&proof.pids.includes(guardPid);
 // No native launcher can run before a successful guard record. Partial guard setup may have a helper, never native children.
 return complete.treeScope==='not-started'&&!proof.kernelBound&&launches.size<=1;
 }catch{return false;}
}
export async function reconcileProviderCall(dataDir:string,runId:string,provider:ProviderId):Promise<{stopped:boolean;error?:string;bootRecoveryEligible?:boolean}>{
 if(!id(runId)||!['openai','claude','cursor','opencode'].includes(provider))return{stopped:false,error:'Invalid provider call identity'};
 const root=runDirectory(dataDir,runId,provider);if(activeCalls.has(root))return{stopped:false,error:'Provider call is still active'};
 try{const info=await lstat(root);if(!info.isDirectory()||info.isSymbolicLink())return{stopped:false,error:'Invalid provider call receipt root'};}catch(error:any){return{stopped:false,error:'No valid provider ownership receipt is available',bootRecoveryEligible:error.code==='ENOENT'};}
 try {
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.length > 10000) return { stopped: false, bootRecoveryEligible: false, error: 'Provider call receipt limit exceeded' };
  let stopped = entries.length > 0, bootRecoveryEligible = true;
  // Visit every attempt: an earlier local cleanup failure must not hide a later uncertain external callback.
  for (const entry of entries) {
   try {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !id(entry.name)) throw Error('Invalid provider call directory');
    const directory = join(root, entry.name), path = join(directory, 'receipt.json'), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) throw Error('Invalid provider call receipt');
    const r: Receipt = JSON.parse(await readFile(path, 'utf8'));
    if (r.version !== 1 || r.provider !== provider || r.account&&!validAccountDescriptor(r.account,provider) || r.parentRunId !== runId || r.delegationId !== entry.name
     || !id(r.epoch) || !/^[a-f0-9]{64}$/.test(r.registryKey)
     || !['launching', 'running', 'stopped', 'unknown'].includes(r.status)
     || (r.workerPid !== undefined && (!Number.isSafeInteger(r.workerPid) || r.workerPid <= 0))
     || (r.status !== 'launching' && r.workerPid === undefined)
     || typeof r.dispatchCommitted !== 'boolean'
     || !Number.isSafeInteger(r.activeCallbacks) || r.activeCallbacks < 0 || r.activeCallbacks > 1000)
     throw Error('Invalid provider call identity or callback state');
    if (r.activeCallbacks !== 0) bootRecoveryEligible = false;
    if (!await callProof(directory, r)) stopped = false;
   } catch { stopped = false; bootRecoveryEligible = false; }
  }
  return stopped ? { stopped: true } : { stopped: false, bootRecoveryEligible, error: 'Durable provider job ownership, callback completion or cleanup proof is incomplete' };
 } catch { return { stopped: false, bootRecoveryEligible: false, error: 'No valid provider ownership receipt is available' }; }
}
export interface GuardedAdapterOptions {account?:AccountDescriptor;/** Private fixtures only; never accepted from a request. */ workerPath?:string; stopTimeoutMs?:number;}
export class GuardedProviderAdapter implements ProviderAdapter {
 readonly id:ProviderId;private pending=new Set<{controller:AbortController;promise:Promise<ProviderResult>}>();private closing=false;private verified=new Set<string>();
 constructor(private dataDir:string,private direct:ProviderAdapter,private options:GuardedAdapterOptions={}){this.id=direct.id;}
 async inspect(){const connection=await this.direct.inspect();return{...connection,models:connection.models.map(model=>({...model,verified:model.verified||this.verified.has(JSON.stringify([connection.accountLabel,connection.plan,model.id,...(this.id==='opencode'?[connection.connectionScope]:[])]))}))};} login(){if(this.pending.size)throw Error('Wait for active provider operations before connecting another account');return this.direct.login();}
 stream(request:ProviderRequest,emit:(event:ProviderEvent)=>void,signal:AbortSignal,beforeDispatch?:()=>void):Promise<ProviderResult>{
  if(this.closing||signal.aborted)return Promise.reject(Error('Run cancelled'));const controller=new AbortController();const combined=AbortSignal.any([signal,controller.signal]);const promise=this.run(request,emit,combined,beforeDispatch).then(result=>{if(this.id!=='cursor'&&(this.id!=='opencode'||result.actualModel===request.model))this.verified.add(JSON.stringify([request.expectedAccount.accountLabel,request.expectedAccount.plan,request.model,...(this.id==='opencode'?[request.expectedConnectionScope]:[])]));return result;});const item={controller,promise};this.pending.add(item);void promise.finally(()=>this.pending.delete(item)).catch(()=>{});return promise;
 }
 private async run(request:ProviderRequest,emit:(event:ProviderEvent)=>void,signal:AbortSignal,beforeDispatch?:()=>void):Promise<ProviderResult>{
  boundedPrompt(request);requestImages(request);if(this.options.account&&(!validAccountDescriptor(this.options.account,this.id)||request.accountId!==this.options.account.accountId||request.accountProfileGeneration!==this.options.account.profileGeneration))throw Error('Provider account descriptor mismatch');if(!id(request.runId))throw Error('Invalid provider run identity');
  const root=runDirectory(this.options.account?resolve(this.dataDir,'..','..'):this.dataDir,request.runId,this.id),callId=randomUUID(),directory=join(root,callId);activeCalls.set(root,(activeCalls.get(root)??0)+1);
  let worker:ChildProcess|undefined,session:ReturnType<typeof createAppToolSession>|undefined;const rawCalls=new Set<Promise<unknown>>();
  const controller=new AbortController(),scoped=AbortSignal.any([signal,controller.signal]);
  const receipt:Receipt={version:1,provider:this.id,...(this.options.account?{account:this.options.account}:{}),delegationId:callId,parentRunId:request.runId,epoch:randomUUID(),registryKey:randomBytes(32).toString('hex'),status:'launching',activeCallbacks:0,dispatchCommitted:false};
  let receiptWrites=Promise.resolve();const saveReceipt=()=>{const snapshot={...receipt};receiptWrites=receiptWrites.then(()=>persist(join(directory,'receipt.json'),snapshot));return receiptWrites;};
  let seq=0,last=0,terminal:any,protocolFailure:unknown,total=0,ready=false,initDispatched=false;const interactions=new Map<string,AbortController>(),used=new Set<string>();let timer:NodeJS.Timeout|undefined;
  const send=(type:string,data:unknown)=>{if(!worker?.connected)return;const value={seq:++seq,type,data};assertCursorJson(value,type==='init'?PROVIDER_IPC_BYTES:2*1024*1024);worker.send(value,error=>{if(error)cancel();});};
  const cancel=()=>{controller.abort();for(const value of interactions.values())value.abort();interactions.clear();send('cancel',{});};
  const abort=()=>cancel();signal.addEventListener('abort',abort,{once:true});
  try{
   if(request.appTools){const original=request.appTools;session=createAppToolSession({definitions:original.definitions,call:(...args)=>{if(scoped.aborted)throw Error('Provider app authority expired');receipt.activeCallbacks++;const promise=(async()=>{await saveReceipt();try{if(scoped.aborted)throw Error('Provider app authority expired');return await original.call(...args);}finally{receipt.activeCallbacks--;await saveReceipt();}})();rawCalls.add(promise);void promise.finally(()=>rawCalls.delete(promise)).catch(()=>{});return promise;}},scoped);}
   const snapshot=()=>({...cursorRequestData(request),...(session?{appTools:{definitions:session.definitions}}:{}),hasInteraction:!!request.interact});
   const bootstrap:ProviderBootstrap={...receipt,dataDir:resolve(this.dataDir),directory,...(this.options.account?{account:this.options.account}:{}),...(isOutcomeReconciliation(request)?{outcomeReconciliation:true as const}:{}),request:snapshot()};
   assertCursorJson(bootstrap,PROVIDER_IPC_BYTES);await privateDirectory(directory);await saveReceipt();
   if(scoped.aborted)throw Error('Run cancelled');
   const development=import.meta.url.endsWith('.ts'),path=this.options.workerPath??fileURLToPath(new URL('./provider-worker.'+(development?'ts':'js'),import.meta.url));
   worker=fork(path,[],{execPath:process.execPath,execArgv:development?['--import',pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href]:[],env:childEnvironment(),windowsHide:true,stdio:['ignore','ignore','ignore','ipc'],serialization:'json'});
   receipt.workerPid=worker.pid;const persisted=saveReceipt();void persisted.catch(()=>{});
   const exited=new Promise<void>(done=>{worker!.once('close',()=>done());worker!.once('error',()=>{protocolFailure=Error('Provider worker could not start');done();});});
   worker.on('message',value=>{
    try{const message=validateProviderMessage(value,last,['ready','event','tool','interaction','expired','terminal']);last=message.seq;total+=Buffer.byteLength(JSON.stringify(value));if(total>32*1024*1024||terminal)throw Error('Provider worker output limit or terminal boundary violated');const p=message.data;
     if(message.type==='ready'){if(ready||p.pid!==worker!.pid)throw Error('Invalid provider worker readiness');ready=true;if(scoped.aborted){cancel();return;}void persisted.then(async()=>{if(scoped.aborted){cancel();return;}beforeDispatch?.();if(scoped.aborted){cancel();return;}bootstrap.request=snapshot();receipt.status='running';receipt.dispatchCommitted=true;await saveReceipt();if(scoped.aborted)cancel();else{initDispatched=true;send('init',bootstrap);}}).catch(error=>{protocolFailure=error instanceof Error?error:Error('Provider receipt persistence or dispatch check failed');cancel();});}
     else if(message.type==='event'){if(!initDispatched||!['delta','status','tool'].includes(p.type)||typeof(p.type==='delta'?p.text:p.type==='status'?p.message:p.name)!=='string')throw Error('Invalid provider event');emit(p);}
     else if(message.type==='tool'||message.type==='interaction'){
      if(!initDispatched||scoped.aborted||!id(p.id)||used.has(p.id)||interactions.size>=20||used.size>=1000)throw Error('Expired or duplicate provider callback');used.add(p.id);const c=new AbortController();interactions.set(p.id,c);
      if(message.type==='tool'&&(!session||typeof p.callId!=='string'||!p.callId||p.callId.length>200||typeof p.name!=='string'))throw Error('Unavailable provider app tool');
      if(message.type==='interaction'&&(!request.interact||!record(p.prompt)||!['approval','question'].includes(p.prompt.kind)||typeof p.prompt.title!=='string'||typeof p.prompt.description!=='string'))throw Error('Unavailable provider interaction');
      const answer=message.type==='tool'?session!.call(p.callId,p.name,p.args,c.signal):request.interact!(p.prompt,AbortSignal.any([scoped,c.signal]));
      void answer.then(value=>{if(!interactions.delete(p.id)||scoped.aborted||c.signal.aborted||terminal)return;send('answer',{id:p.id,value});}).catch(error=>{if(!interactions.delete(p.id)||scoped.aborted||c.signal.aborted||terminal)return;if(error instanceof AppToolExecutionError)send('answer',{id:p.id,error:safeError(error.cause),executionError:true});else{protocolFailure=Error('Provider callback failed or expired');cancel();}});
     }else if(message.type==='expired'){interactions.get(p.id)?.abort();interactions.delete(p.id);}
     else{if(!initDispatched||typeof p.cleanup!=='boolean'||(p.result!==undefined&&(!record(p.result)||typeof p.result.text!=='string'))||(p.error!==undefined&&typeof p.error!=='string'))throw Error('Invalid provider terminal result');terminal=p;controller.abort();}
    }catch(error){protocolFailure=error;cancel();}
   });
   worker.on('disconnect',()=>{if(!terminal){protocolFailure??=Error('Provider worker IPC disconnected before completion');cancel();}});
   // Cancellation remains cooperative to the guarded worker. Never kill the job owner before it records drain proof.
   const stopMs=this.options.stopTimeoutMs??30_000;let stopTimer:NodeJS.Timeout|undefined;let stopExpired!:()=>void;const stopDeadline=new Promise<void>(done=>stopExpired=done);
   const interrupted=()=>{stopTimer??=setTimeout(()=>{protocolFailure??=Error('Provider worker cancellation proof timed out');if(worker?.connected)worker.disconnect();stopExpired();},stopMs);};scoped.addEventListener('abort',interrupted,{once:true});if(scoped.aborted)interrupted();
   timer=setTimeout(()=>{protocolFailure??=Error('Provider worker deadline exceeded');cancel();},Math.min(3600,Math.max(1,request.maxSeconds))*1000+30_000);
   await Promise.race([exited,stopDeadline]);
   clearTimeout(stopTimer);scoped.removeEventListener('abort',interrupted);
   if(rawCalls.size){let settleTimer:NodeJS.Timeout|undefined;await Promise.race([Promise.allSettled([...rawCalls]),new Promise<void>(done=>{settleTimer=setTimeout(done,5000);})]);clearTimeout(settleTimer);}
   const proved=await callProof(directory,receipt);receipt.status=proved&&!rawCalls.size?'stopped':'unknown';await saveReceipt();
   if(rawCalls.size)throw providerOutcomeUnknown('Host app-tool callback completion is unconfirmed');
   if(proved&&receipt.dispatchCommitted===false){if(signal.aborted)throw Error('Run cancelled');if(protocolFailure)throw protocolFailure;throw Error('Provider worker ended before dispatch');}
   if(!proved||!terminal?.cleanup)throw providerOutcomeUnknown('Owned Windows job cleanup proof is unavailable');
   if(protocolFailure)throw protocolFailure;if(signal.aborted)throw Error('Run cancelled');if(terminal.error)throw Error(safeError(terminal.error));
   if(!terminal.result)throw Error('Provider ended without a successful result');if(terminal.result.actualModel!==undefined&&terminal.result.actualModel!==request.model)throw Error('Provider returned an unexpected model');return terminal.result;
  }catch(error){if(rawCalls.size)throw providerOutcomeUnknown('Host app-tool callback completion is unconfirmed');if(worker&&!await callProof(directory,receipt))throw providerOutcomeUnknown('Owned Windows job cleanup proof is unavailable');throw error;}
  finally{clearTimeout(timer);signal.removeEventListener('abort',abort);controller.abort();session?.close();for(const c of interactions.values())c.abort();const release=()=>{const count=(activeCalls.get(root)??1)-1;if(count)activeCalls.set(root,count);else activeCalls.delete(root);};if(rawCalls.size)void Promise.allSettled([...rawCalls]).then(release);else release();}
 }
 async close():Promise<void>{this.closing=true;for(const item of this.pending)item.controller.abort();const results=await Promise.allSettled([...this.pending].map(item=>item.promise));await this.direct.close();const unknown=results.find(r=>r.status==='rejected'&&r.reason?.code==='PROVIDER_OUTCOME_UNKNOWN');if(unknown?.status==='rejected')throw unknown.reason;}
}
