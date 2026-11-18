import {fork,type ChildProcess} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {HOST_LIMITS as H,deferred,hostEnvironment,hostFrame,parentFrame,type ParentFrame,type HostFault,type HostFrame} from './terminal-host-protocol.js';
import type {PreparedPty,PtyHandle,PtyConfig} from './terminal.js';
export type HostChild=Pick<ChildProcess,'on'|'send'|'kill'|'disconnect'|'unref'|'connected'|'stdout'|'stderr'>;
interface Options {createChild?:()=>HostChild;readyMs?:number;rpcMs?:number;hardMs?:number}
const failure=()=>new Error('Native terminal connection is unavailable or uncertain');
/** Synchronous resource acquisition: no native module loads in this process. */
export function prepareNativePty(options:Options={}):PreparedPty{
 const ready=deferred<void>(),closed=deferred<void>(),started=deferred<void>();
 let child:HostChild|undefined,prepared=false,committed=false,disposing=false,isClosed=false,exitSent=false,stopped=false,faulted:HostFault|undefined,outputSequence=0,nextRequest=2,controlPending=0;
 let nativeExit:Extract<HostFrame,{type:'exit'}>|undefined,pending:{id:number;resolve:()=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}|undefined;
 let readyTimer:ReturnType<typeof setTimeout>|undefined,startTimer:ReturnType<typeof setTimeout>|undefined,hardTimer:ReturnType<typeof setTimeout>|undefined;
 const dataListeners=new Set<(data:string)=>void>(),exitListeners=new Set<(event:{exitCode:number;signal?:number})=>void>(),errorListeners=new Set<(warning?:string)=>void>();
 const warning=()=>faulted==='incomplete'?'Terminal output is incomplete. The native connection could not preserve final output.':'The native terminal connection failed. Input delivery or exit may be uncertain.';
 const clear=(timer:ReturnType<typeof setTimeout>|undefined)=>{if(timer)clearTimeout(timer);};
 const complete=()=>{if(!committed||!nativeExit||!isClosed||exitSent)return;exitSent=true;for(const fn of exitListeners)fn({exitCode:nativeExit.exitCode,...(nativeExit.signal===undefined?{}:{signal:nativeExit.signal})});};
 const fail=(code:HostFault)=>{if(!faulted||code==='incomplete'){faulted=code;for(const fn of errorListeners)fn(warning());}ready.reject(failure());started.reject(failure());if(pending){const item=pending;pending=undefined;clear(item.timer);item.reject(failure());}if(committed&&!stopped)stop();};
 const hardCleanup=()=>{if(hardTimer||isClosed)return;hardTimer=setTimeout(()=>{if(isClosed)return;try{child?.kill();}catch{}try{child?.disconnect();}catch{}child?.unref();fail('transport');},options.hardMs??H.hardMs);};
 const send=(value:ParentFrame)=>{if(!child?.connected||isClosed||controlPending>=H.controlCount){fail('transport');return false;}controlPending++;try{child.send(value,error=>{controlPending--;if(error)fail('transport');});return true;}catch{controlPending--;fail('transport');return false;}};
 function stop(){if(stopped||isClosed)return;stopped=true;hardCleanup();send({type:'stop'});}
 const dispose=()=>{if(!disposing){disposing=true;ready.reject(failure());if(committed)stop();else{hardCleanup();try{child?.kill();}catch{}if(!child){isClosed=true;closed.resolve();}}}return closed.promise;};
 const rpc=(value:{type:'input';data:string}|{type:'resize';cols:number;rows:number}):Promise<void>=>{
  if(!prepared||!committed||!startedDone||pending||faulted||disposing||stopped||isClosed||nextRequest>=Number.MAX_SAFE_INTEGER)throw failure();
  const frame={...value,id:nextRequest++} as ParentFrame;if(!parentFrame(frame))throw failure();const operation=deferred<void>();const id=(frame as {id:number}).id;
  pending={id,resolve:()=>operation.resolve(),reject:operation.reject,timer:setTimeout(()=>fail('transport'),options.rpcMs??H.rpcMs)};send(frame);return operation.promise;
 };
 let startedDone=false;
 const handle:PtyHandle={started:started.promise,write:data=>rpc({type:'input',data}),resize:(cols,rows)=>rpc({type:'resize',cols,rows}),kill:stop,onData:fn=>{dataListeners.add(fn);return {dispose:()=>{dataListeners.delete(fn);}};},onExit:fn=>{exitListeners.add(fn);if(exitSent&&nativeExit)queueMicrotask(()=>{if(exitListeners.has(fn))fn({exitCode:nativeExit!.exitCode,...(nativeExit!.signal===undefined?{}:{signal:nativeExit!.signal})});});return {dispose:()=>{exitListeners.delete(fn);}};},onError:fn=>{errorListeners.add(fn);if(faulted)queueMicrotask(()=>{if(errorListeners.has(fn))fn(warning());});return {dispose:()=>{errorListeners.delete(fn);}};}};
 const receive=(raw:unknown)=>{
  if(!hostFrame(raw)){fail('protocol');return;}const message=raw;
  if(isClosed&&message.type!=='exit')return;
  switch(message.type){
   case 'ready':if(prepared||committed||disposing){if(!disposing)fail('protocol');return;}prepared=true;clear(readyTimer);ready.resolve();return;
   case 'spawned':if(!committed||startedDone||nativeExit){fail('protocol');return;}startedDone=true;clear(startTimer);started.resolve();return;
   case 'ack':if(!pending||message.id!==pending.id){fail('protocol');return;}const operation=pending;pending=undefined;clear(operation.timer);if(!message.ok){operation.reject(failure());fail('native');}else operation.resolve();return;
   case 'output':if(!committed||nativeExit||message.sequence!==outputSequence+1){fail('protocol');return;}try{for(const fn of dataListeners)fn(message.data);}catch{fail('incomplete');return;}outputSequence=message.sequence;send({type:'output-ack',sequence:message.sequence});return;
   case 'fault':fail(message.code);return;
   case 'exit':if(!committed||!startedDone||nativeExit||message.sequence!==outputSequence){fail('protocol');return;}nativeExit=message;if(message.incomplete)fail('incomplete');hardCleanup();complete();return;
  }
 };
 try{
  child=options.createChild?.()??fork(fileURLToPath(new URL(import.meta.url.endsWith('.ts')?'./terminal-host.ts':'./terminal-host.js',import.meta.url)),[],{execPath:process.execPath,execArgv:import.meta.url.endsWith('.ts')?['--import',import.meta.resolve('tsx')]:[],env:hostEnvironment(process.env),windowsHide:true,silent:true,serialization:'json'});
  child.on('message',receive);child.on('error',()=>{fail('transport');if(!committed)void dispose();});child.on('disconnect',()=>{if(!isClosed&&!nativeExit){fail('transport');if(!committed)void dispose();}});child.on('close',()=>{isClosed=true;ready.reject(failure());started.reject(failure());clear(readyTimer);clear(startTimer);clear(hardTimer);if(pending){clear(pending.timer);pending.reject(failure());pending=undefined;}closed.resolve();if(!committed)ready.reject(failure());else if(!nativeExit)fail('transport');complete();});
  child.stdout?.on('data',()=>{});child.stderr?.on('data',()=>{});
  readyTimer=setTimeout(()=>{fail('unavailable');void dispose();},options.readyMs??H.readyMs);
 }catch{isClosed=true;closed.resolve();ready.reject(failure());}
 return {ready:ready.promise,dispose,spawn:(file:string,args:string[],config:PtyConfig)=>{
  if(!prepared||committed||disposing||isClosed||faulted)throw failure();const frame:ParentFrame={type:'spawn',id:1,config:{...config,file,args}};if(!parentFrame(frame))throw failure();committed=true;startTimer=setTimeout(()=>fail('transport'),options.readyMs??H.readyMs);send(frame);return handle;
 }};
}
