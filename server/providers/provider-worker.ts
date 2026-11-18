import {validAccountDescriptor} from '../../shared/accounts.js';
import { fileURLToPath } from 'node:url';
import { resolve, join, isAbsolute } from 'node:path';
import { ChildRegistry } from '../herdr/registry.js';
import { executeOwnedProvider, validateProviderMessage, type ProviderBootstrap, type OwnedOptions } from './lifecycle.js';
import { safeError, boundedPrompt } from './process.js';
import { requestImages } from '../attachment-context.js';
import { AppToolExecutionError } from '../app-tools-bridge.js';
import type { ProviderRequest } from '../../shared/types.js';
import {markOutcomeReconciliation} from '../outcome-reconciliation.js';

export async function runProviderWorker(options:Pick<OwnedOptions,'createAdapter'|'createGuard'>={}):Promise<void>{
 if(!process.send)throw Error('Provider worker requires its private fork channel');
 let seq=0,last=0,started=false;const controller=new AbortController();
 const pending=new Map<string,{done:(value:any)=>void;reject:(error:Error)=>void;clean:()=>void}>();
 const send=(type:string,data:unknown)=>{if(process.connected)process.send!({seq:++seq,type,data},()=>{});};
 const terminal=(data:unknown)=>new Promise<void>((done,reject)=>{if(!process.connected){done();return;}process.send!({seq:++seq,type:'terminal',data},error=>error?reject(error):done());});
 const abort=()=>{controller.abort();for(const p of pending.values()){p.clean();p.reject(Error('Provider callback expired'));}pending.clear();};
 let resolveInit!:(value:ProviderBootstrap)=>void,rejectInit!:(error:Error)=>void;const init=new Promise<ProviderBootstrap>((done,reject)=>{resolveInit=done;rejectInit=reject;});
 const receive=(value:unknown)=>{try{const m=validateProviderMessage(value,last,['init','cancel','answer']);last=m.seq;if(m.type==='cancel'){abort();rejectInit(Error('Run cancelled'));return;}
  if(m.type==='init'){if(started||controller.signal.aborted)throw Error('Duplicate or expired provider initialization');started=true;resolveInit(m.data as ProviderBootstrap);return;}
  const p=pending.get(m.data.id);if(!p||controller.signal.aborted)throw Error('Unknown or expired provider answer');pending.delete(m.data.id);p.clean();if(m.data.error)p.reject(m.data.executionError?new AppToolExecutionError(Error(safeError(m.data.error))):Error('Provider callback failed'));else p.done(m.data.value);
 }catch{abort();rejectInit(Error('Invalid provider parent message'));}};
 process.on('message',receive);process.once('disconnect',()=>{abort();rejectInit(Error('Provider parent disconnected'));});
 const timer=setTimeout(()=>{abort();rejectInit(Error('Provider initialization timed out'));},15_000);
 const ask=(type:'tool'|'interaction',data:unknown,signal?:AbortSignal)=>new Promise<any>((done,reject)=>{
  if(controller.signal.aborted||signal?.aborted||pending.size>=20){reject(Error('Provider callback expired'));return;}
  const id=crypto.randomUUID(),expire=()=>{const p=pending.get(id);if(!p)return;pending.delete(id);p.clean();send('expired',{id});reject(Error('Provider callback expired'));};
  pending.set(id,{done,reject,clean:()=>signal?.removeEventListener('abort',expire)});signal?.addEventListener('abort',expire,{once:true});send(type,{...(data as object),id});
 });
 try{
  send('ready',{pid:process.pid});const b=await init;clearTimeout(timer);
  if(!b||!['openai','claude','cursor','opencode'].includes(b.provider)||typeof b.directory!=='string'||!isAbsolute(b.directory)||typeof b.dataDir!=='string'||!isAbsolute(b.dataDir)||!/^\w{64}$/.test(b.registryKey)||b.request.runId!==b.parentRunId)throw Error('Invalid provider bootstrap');
  if(b.account&&(!validAccountDescriptor(b.account,b.provider)||b.request.accountId!==b.account.accountId||b.request.accountProfileGeneration!==b.account.profileGeneration))throw Error('Invalid provider account bootstrap');
  if(b.outcomeReconciliation!==undefined&&b.outcomeReconciliation!==true)throw Error('Invalid provider reporting bootstrap');
  if(b.outcomeReconciliation&&(b.request.mode!=='chat'||b.request.workspace||b.request.execution?.workspace||b.request.appTools||b.request.hasInteraction||b.request.continuity||b.request.imageTable?.length))throw Error('Provider reporting bootstrap contains native or tool authority');
  const registry=new ChildRegistry(join(b.directory,'children.jsonl'),b,b.registryKey);registry.append('worker',{pid:process.pid});
  const {appTools,hasInteraction,...wire}=b.request;
  const request:ProviderRequest={...wire,...(hasInteraction?{interact:(prompt,signal)=>ask('interaction',{prompt},signal)}:{}),...(appTools?{appTools:{definitions:appTools.definitions,call:(callId,name,args)=>ask('tool',{callId,name,args})}}:{})};
  if(b.outcomeReconciliation)markOutcomeReconciliation(request);
  boundedPrompt(request);requestImages(request);
  const outcome=await executeOwnedProvider({...options,provider:b.provider,dataDir:b.dataDir,directory:b.directory,account:b.account,request,signal:controller.signal,emit:event=>send('event',event),registry});
  abort();await terminal({cleanup:outcome.cleanup,...(outcome.error?{error:safeError(outcome.error)}:outcome.result?{result:outcome.result}:{error:'Provider ended without a successful result'})});
 }finally{clearTimeout(timer);abort();process.removeListener('message',receive);if(process.connected)process.disconnect();}
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(fileURLToPath(import.meta.url)))runProviderWorker().then(()=>process.exit(0),()=>process.exit(1));
