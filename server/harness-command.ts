import {spawn,execFile,type ChildProcess} from 'node:child_process';
import {join} from 'node:path';
import type {HarnessCommand} from './harness-changes.js';

export const checkTerminationUnknown=(reason:string)=>Object.assign(new Error('Source check termination is unknown: '+reason),{code:'HARNESS_CHECK_OUTCOME_UNKNOWN' as const});
export type CheckCommandLifecycle=(state:'running'|'drained'|'unknown')=>void;
const nativeLaunch=(command:HarnessCommand)=>spawn(command.executable,command.args,{cwd:command.cwd,env:command.env,windowsHide:true,stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});
async function nativeStopTree(pid:number):Promise<void>{
 if(process.platform==='win32')await new Promise<void>((done,fail)=>execFile(join(process.env.SystemRoot??'C:\\Windows','System32','taskkill.exe'),['/pid',String(pid),'/t','/f'],{windowsHide:true,timeout:5000},error=>error?fail(error):done()));
 else process.kill(-pid,'SIGKILL');
}
async function nativeGroupGone(pid:number):Promise<void>{
 if(process.platform==='win32')return;
 const until=Date.now()+5000;while(true){try{process.kill(-pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return;throw error;}if(Date.now()>=until)throw Error('Process group remains present');await new Promise(done=>setTimeout(done,25));}
}
/** A cancellation succeeds only after tree-stop proof AND owned pipe/process close. */
export async function runHarnessCommand(command:HarnessCommand,output:(text:string)=>void,children:Set<ChildProcess>,seams:{launch?:(command:HarnessCommand)=>ChildProcess;stopTree?:(pid:number)=>Promise<void>;groupGone?:(pid:number)=>Promise<void>;lifecycle?:CheckCommandLifecycle}={}):Promise<void>{
 if(command.signal?.aborted)throw new Error('Checks cancelled');
 seams.lifecycle?.('running');let child:ChildProcess;try{child=(seams.launch??nativeLaunch)(command);}catch(error){seams.lifecycle?.('drained');throw error;}children.add(child);
 await new Promise<void>((done,fail)=>{
  let settled=false,closed=false,stopPromise:Promise<void>|undefined,stopReason='Checks cancelled',resolveClose!:()=>void;
  const didClose=new Promise<void>(resolve=>resolveClose=resolve),pid=child.pid;
  const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);command.signal?.removeEventListener('abort',aborted);if(closed)children.delete(child);try{seams.lifecycle?.(error&&'code'in error&&error.code==='HARNESS_CHECK_OUTCOME_UNKNOWN'?'unknown':'drained');}catch(writeError){fail(error??writeError);return;}error?fail(error):done();};
  const stop=(reason:string)=>{
   if(stopPromise||settled)return;stopReason=reason;
   stopPromise=(async()=>{if(!pid||!Number.isSafeInteger(pid)||pid<=0)throw Error('Owned process identity unavailable');let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([Promise.all([(seams.stopTree??nativeStopTree)(pid),didClose]),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('Tree stop or process close timed out')),5000);})]);await(seams.groupGone??nativeGroupGone)(pid);}finally{if(timer)clearTimeout(timer);}})();
   void stopPromise.then(()=>finish(new Error(stopReason)),()=>{try{child.kill();}catch{}finish(checkTerminationUnknown('The owned process tree could not be confirmed stopped'));});
  };
  const timer=setTimeout(()=>stop('Check command exceeded its 15 minute limit'),15*60*1000),aborted=()=>stop('Checks cancelled');
  command.signal?.addEventListener('abort',aborted,{once:true});
  child.stdout?.on('data',chunk=>output(String(chunk)));child.stderr?.on('data',chunk=>output(String(chunk)));
  child.once('error',error=>{if(stopPromise)return;finish(child.pid?checkTerminationUnknown('Owned process failed before close'):error);});
  child.once('close',(code,signal)=>{closed=true;children.delete(child);resolveClose();if(stopPromise)return;finish(code===0&&!command.signal?.aborted?undefined:new Error(command.signal?.aborted?'Checks cancelled':`Check command exited ${code??signal}`));});
  // Cover abort delivered between spawn and listener installation.
  if(command.signal?.aborted)aborted();
 });
}
