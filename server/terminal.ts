import {randomUUID} from 'node:crypto';
import {access,realpath,stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {homedir} from 'node:os';
import {isAbsolute,join} from 'node:path';
import {HttpError} from './security.js';
import {prepareNativePty} from './terminal-native.js';
import {shellEnvironment,type PtyConfig} from './terminal-host-protocol.js';
export type {PtyConfig} from './terminal-host-protocol.js';
import {TERMINAL_LIMITS as L,type TerminalCatalog,type TerminalEvent,type TerminalSession,type TerminalStart,type TerminalInput,type TerminalResize} from '../shared/terminal.js';

/** Local structural adapter deliberately compiles without the optional native package. */
export interface PtyHandle {started?:Promise<void>;write(data:string):void|Promise<void>;resize(cols:number,rows:number):void|Promise<void>;kill():void;onData(fn:(data:string)=>void):{dispose():void};onExit(fn:(event:{exitCode:number;signal?:number})=>void):{dispose():void};onError?(fn:(warning?:string)=>void):{dispose():void}}
export interface PtyFactory {spawn(file:string,args:string[],options:PtyConfig):PtyHandle}
/** spawn throws only before a handoff; every possibly delivered handoff returns its owned handle. */
export interface PreparedPty extends PtyFactory {ready:Promise<void>;dispose():Promise<void>}
export function adaptNativePty(pty:PtyHandle&{on(event:string,fn:(error:unknown)=>void):unknown}):PtyHandle{
 let listener:(()=>void)|undefined;
 // node-pty 1.1's legacy socket error channel throws without an external listener.
 // Keep an inert sink through native teardown; disposal releases the manager callback.
 pty.on('error',()=>listener?.());
 return {write:data=>pty.write(data),resize:(cols,rows)=>pty.resize(cols,rows),kill:()=>pty.kill(),onData:fn=>pty.onData(fn),onExit:fn=>pty.onExit(fn),onError:fn=>{listener=fn;return {dispose:()=>{if(listener===fn)listener=undefined;}};}};
}
export interface ShellDefinition {id:string;label:string;file:string;args:string[]}
export interface TerminalOptions {
 ownerAlive:(owner:object)=>boolean;assertAvailable:()=>void;
 resolveCwd?:(agentId?:string)=>Promise<{cwd:string;context:string|null}>;
 shells?:()=>Promise<ShellDefinition[]>;preparePty?:()=>PreparedPty;stopMs?:number;sweepMs?:number;
}
type Output=Extract<TerminalEvent,{type:'output'}>;
const WARNINGS={incomplete:'Terminal output is incomplete. The native connection could not preserve final output.',input:'Terminal input delivery is uncertain. Input disabled; it will never be resent.',native:'The native terminal connection failed. Input is disabled until exit is confirmed.',creation:'Terminal creation could not be confirmed. Its activity remains reserved.',prepared:'The prepared terminal host has not confirmed closure. Its activity remains reserved.',exit:'Terminal exit has not been confirmed. Its activity remains reserved.'} as const;
type WarningFact=keyof typeof WARNINGS;
interface Viewer {leaseId:string|null;send:(event:TerminalEvent)=>void;end:()=>void}
interface Entry {owner:object;session:TerminalSession;warnings:Set<WarningFact>;preparation?:PreparedPty;committed:boolean;rpcBusy:boolean;rpc?:Promise<unknown>;pty?:PtyHandle;viewer?:Viewer;replay:Output[];bytes:number;nextInput:number;cancelled:boolean;cancelStart:()=>void;cancelSignal:Promise<never>;pendingHigh:string;disposables:{dispose():void}[];exited:Promise<void>;ack:()=>void;stop?:Promise<void>}
export const nativePty=prepareNativePty;
export const terminalEnvironment=(source:NodeJS.ProcessEnv=process.env)=>shellEnvironment(source);
/** Fixed server catalog, independent of client PATH/executable input. */
export async function discoverShells(platform=process.platform,env:NodeJS.ProcessEnv=process.env):Promise<ShellDefinition[]>{
 const candidates:ShellDefinition[]=platform==='win32'?[{id:'windows-cmd',label:'Command Prompt',file:join(env.SystemRoot??'C:\\Windows','System32','cmd.exe'),args:[]},{id:'windows-powershell',label:'Windows PowerShell',file:join(env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),args:['-NoLogo']},...(env.ProgramFiles?[{id:'powershell-7',label:'PowerShell 7',file:join(env.ProgramFiles,'PowerShell','7','pwsh.exe'),args:['-NoLogo']}]:[])]:[{id:'bash',label:'Bash',file:'/bin/bash',args:[]},{id:'zsh',label:'Zsh',file:'/bin/zsh',args:[]},{id:'sh',label:'Shell',file:'/bin/sh',args:[]}];
 const found:ShellDefinition[]=[];for(const candidate of candidates){try{if(!(await stat(candidate.file)).isFile())continue;await access(candidate.file,platform==='win32'?constants.F_OK:constants.X_OK);found.push(candidate);}catch{}}return found;
}
export async function terminalCwd(path=homedir()):Promise<string>{if(!isAbsolute(path)||path.includes('\0')||!path.trim())throw new HttpError(400,'Terminal workspace must be an absolute folder');try{const cwd=await realpath(path);if(!(await stat(cwd)).isDirectory())throw Error();return cwd;}catch{throw new HttpError(400,'Terminal workspace folder does not exist');}}
export function terminalDimensions(cols:unknown,rows:unknown):{cols:number;rows:number}{if(!Number.isInteger(cols)||!Number.isInteger(rows)||(cols as number)<L.minCols||(cols as number)>L.maxCols||(rows as number)<L.minRows||(rows as number)>L.maxRows)throw new HttpError(400,'Invalid terminal dimensions');return {cols:cols as number,rows:rows as number};}
export class Terminals {
 private entries=new Map<object,Entry>();private starts=new Set<Promise<unknown>>();private closing=false;private engine:TerminalCatalog['engine']='unchecked';private timer:ReturnType<typeof setInterval>;private closePromise?:Promise<void>;
 constructor(private options:TerminalOptions){this.timer=setInterval(()=>{void this.sweep();},options.sweepMs??L.expirySweepMs);this.timer.unref();}
 private alive(owner:object){if(!this.options.ownerAlive(owner))throw new HttpError(401,'Terminal operator session expired');}
 private admission(owner:object){this.alive(owner);if(this.closing)throw new HttpError(503,'Relay is closing');this.options.assertAvailable();}
 activeCount(){return [...this.entries.values()].filter(e=>e.session.state!=='exited').length;}
 async catalog():Promise<TerminalCatalog>{const shells=await (this.options.shells??discoverShells)();return {platform:process.platform,shells:shells.map(({id,label})=>({id,label})),engine:this.engine,...(this.engine==='unavailable'?{error:'Native terminal engine is unavailable. Reinstall supported optional dependencies and restart Relay.'}:{})};}
 current(owner:object):TerminalSession|null{this.alive(owner);const entry=this.entries.get(owner);return entry?this.snapshot(entry):null;}
 get(owner:object,id:string):TerminalSession{return this.snapshot(this.owned(owner,id));}
 private owned(owner:object,id:string):Entry{this.alive(owner);const entry=this.entries.get(owner);if(!entry||entry.session.id!==id)throw new HttpError(404,'Terminal session not found');return entry;}
 private snapshot(entry:Entry):TerminalSession{return {...entry.session};}
 private warning(entry:Entry,fact?:WarningFact){const previous=entry.session.warning;if(fact)entry.warnings.add(fact);const message=(Object.keys(WARNINGS) as WarningFact[]).filter(key=>entry.warnings.has(key)).map(key=>WARNINGS[key]).join(' ');if(message)entry.session.warning=message;else delete entry.session.warning;return previous!==entry.session.warning;}
 start(owner:object,input:TerminalStart):Promise<TerminalSession>{
  try{this.admission(owner);terminalDimensions(input.cols,input.rows);if(typeof input.shellId!=='string'||input.shellId.length>100||(input.agentId!==undefined&&(typeof input.agentId!=='string'||!input.agentId||input.agentId.length>100)))throw new HttpError(400,'Invalid terminal Start');if(this.entries.get(owner)?.session.state!=='exited'&&this.entries.has(owner))throw new HttpError(409,'Close the existing terminal session first');if(this.activeCount()>=L.sessions)throw new HttpError(409,'Terminal session limit reached');}catch(error){return Promise.reject(error);}
  let ack!:()=>void,cancelStart!:()=>void;const cancelSignal=new Promise<never>((_,reject)=>{cancelStart=()=>reject(new HttpError(409,'Terminal Start was cancelled'));});const entry:Entry={owner,session:{id:randomUUID(),shellId:input.shellId,shellLabel:'Starting',cwd:'',context:null,state:'starting',cols:input.cols,rows:input.rows,sequence:0},warnings:new Set(),replay:[],bytes:0,nextInput:1,cancelled:false,committed:false,rpcBusy:false,cancelStart,cancelSignal,pendingHigh:'',disposables:[],exited:new Promise<void>(done=>ack=done),ack:()=>ack()};this.entries.set(owner,entry);
  const pending=this.startReserved(entry,input);this.starts.add(pending);void pending.finally(()=>this.starts.delete(pending)).catch(()=>{});return pending;
 }
 private checkStart(entry:Entry){this.admission(entry.owner);if(entry.cancelled||this.entries.get(entry.owner)!==entry)throw new HttpError(409,'Terminal Start was cancelled');}
 private async startReserved(entry:Entry,input:TerminalStart):Promise<TerminalSession>{
  try{
   const shells=await Promise.race([(this.options.shells??discoverShells)(),entry.cancelSignal]);this.checkStart(entry);const shell=shells.find(s=>s.id===input.shellId);if(!shell)throw new HttpError(400,'Terminal shell is unavailable');
   const location=await Promise.race([(this.options.resolveCwd??(async()=>({cwd:await terminalCwd(),context:null})))(input.agentId),entry.cancelSignal]);this.checkStart(entry);
   entry.preparation=(this.options.preparePty??prepareNativePty)();
   try{await Promise.race([entry.preparation.ready,entry.cancelSignal]);}catch(error){if(entry.cancelled)throw error;this.engine='unavailable';throw new HttpError(503,'Native terminal engine is unavailable');}this.checkStart(entry);
   Object.assign(entry.session,{shellLabel:shell.label,cwd:location.cwd,context:location.context});
   const pty=entry.preparation.spawn(shell.file,[...shell.args],{cwd:location.cwd,env:terminalEnvironment(process.env),cols:input.cols,rows:input.rows,name:'xterm-256color'});entry.committed=true;entry.pty=pty;
   entry.disposables.push(pty.onData(data=>this.output(entry,data)),pty.onExit(event=>this.exit(entry,event)));if(pty.onError)entry.disposables.push(pty.onError(warning=>{if(entry.session.state==='exited')return;const changed=this.warning(entry,warning===WARNINGS.incomplete?'incomplete':'native'),alreadyStopping=!!entry.stop||entry.session.state==='stopping';if(entry.viewer)entry.viewer.leaseId=null;void this.stopEntry(entry);if(changed&&alreadyStopping)this.status(entry);}));
   if(pty.started)await Promise.race([pty.started,entry.cancelSignal,entry.exited]);this.checkStart(entry);if(entry.session.state==='exited')return this.snapshot(entry);if(entry.session.state!=='starting')throw new HttpError(409,'Native terminal startup is uncertain');this.engine='ready';entry.session.state='live';if(entry.viewer)entry.viewer.leaseId=randomUUID();this.status(entry);return this.snapshot(entry);
  }catch(error){if(entry.committed){if(!entry.pty){try{void entry.preparation?.dispose().catch(()=>{});}catch{}}if(entry.session.state!=='exited'){this.warning(entry,'creation');await this.stopEntry(entry);}}else await this.disposePreparation(entry);throw error;}
 }
 private releaseUnspawned(entry:Entry){if(entry.committed)return;entry.session.state='exited';entry.ack();this.endViewer(entry);if(this.entries.get(entry.owner)===entry)this.entries.delete(entry.owner);}
 private async disposePreparation(entry:Entry){if(!entry.preparation){this.releaseUnspawned(entry);return;}let disposal:Promise<void>;try{disposal=entry.preparation.dispose();}catch{disposal=new Promise<void>(()=>{});}void disposal.then(()=>this.releaseUnspawned(entry)).catch(()=>{});let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([disposal,new Promise<void>(done=>timer=setTimeout(done,this.options.stopMs??5000))]);}catch{}finally{if(timer)clearTimeout(timer);}if(entry.session.state!=='exited'){entry.session.state='uncertain';this.warning(entry,'prepared');this.status(entry);}}
 subscribe(owner:object,id:string,after:number,send:Viewer['send'],end:Viewer['end']):()=>void{
  const entry=this.owned(owner,id);if(!Number.isSafeInteger(after)||after<0||after>entry.session.sequence)throw new HttpError(400,'Invalid terminal output cursor');if(entry.viewer||entry.rpcBusy)throw new HttpError(409,'Terminal is already connected or awaiting native input acknowledgment');if(this.closing)throw new HttpError(503,'Relay is closing');
  const viewer:Viewer={leaseId:entry.session.state==='live'?randomUUID():null,send,end};entry.viewer=viewer;this.status(entry);
  const oldest=entry.replay[0]?.sequence??entry.session.sequence+1;
  if(after<oldest-1)this.deliver(entry,{type:'gap',sessionId:id,sequence:entry.session.sequence,reason:'Complete terminal history is unavailable. View reset; following new output.'});
  else for(const event of entry.replay)if(event.sequence>after)this.deliver(entry,event);
  if(entry.session.state==='exited'){this.deliver(entry,{type:'exit',session:this.snapshot(entry)});this.endViewer(entry);}
  return ()=>{if(entry.viewer===viewer)this.endViewer(entry);};
 }
 private deliver(entry:Entry,event:TerminalEvent){try{entry.viewer?.send(event);}catch{this.endViewer(entry);}}
 private status(entry:Entry){this.deliver(entry,{type:'status',session:this.snapshot(entry),leaseId:entry.viewer?.leaseId??null,nextInputSequence:entry.nextInput});}
 private endViewer(entry:Entry){const viewer=entry.viewer;if(!viewer)return;entry.viewer=undefined;viewer.leaseId=null;try{viewer.end();}catch{}}
 private writer(owner:object,id:string,leaseId:string){const entry=this.owned(owner,id);this.admission(owner);if(entry.session.state!=='live'||!entry.pty||entry.rpcBusy)throw new HttpError(409,'Terminal input is disabled or awaiting native acknowledgment');if(!leaseId||entry.viewer?.leaseId!==leaseId)throw new HttpError(409,'Terminal controller changed. Reconnect explicitly');return entry;}
 input(owner:object,id:string,input:TerminalInput){
  if(typeof input.data!=='string'||!input.data.length||Buffer.byteLength(input.data)>L.inputBytes||!Number.isSafeInteger(input.sequence))throw new HttpError(400,'Invalid terminal input');const entry=this.writer(owner,id,input.leaseId);if(input.sequence!==entry.nextInput)throw new HttpError(409,'Terminal input sequence changed; input was not repeated');entry.nextInput++;
  return this.operation(entry,()=>entry.pty!.write(input.data),()=>({nextInputSequence:entry.nextInput}));
 }
 private operation<T>(entry:Entry,invoke:()=>void|Promise<void>,success:()=>T):T|Promise<T>{entry.rpcBusy=true;const failed=():never=>{if(entry.session.state!=='exited'){if(entry.session.state==='live')entry.session.state='uncertain';this.warning(entry,'input');if(entry.viewer)entry.viewer.leaseId=null;this.status(entry);}throw new HttpError(409,'Terminal operation delivery is uncertain; do not resend');};try{const result=invoke();if(result&&typeof result.then==='function'){const pending=result.then(success,failed).finally(()=>{if(entry.rpc===pending){entry.rpcBusy=false;entry.rpc=undefined;}});entry.rpc=pending;return pending;}entry.rpcBusy=false;return success();}catch{entry.rpcBusy=false;return failed();}}
 resize(owner:object,id:string,input:TerminalResize){const dimensions=terminalDimensions(input.cols,input.rows),entry=this.writer(owner,id,input.leaseId);return this.operation(entry,()=>entry.pty!.resize(dimensions.cols,dimensions.rows),()=>{if(entry.session.state==='live')Object.assign(entry.session,dimensions);return this.snapshot(entry);});}
 private output(entry:Entry,data:string){
  if(entry.session.state==='exited'||typeof data!=='string')return;data=entry.pendingHigh+data;entry.pendingHigh='';const last=data.charCodeAt(data.length-1);if(last>=0xd800&&last<=0xdbff){entry.pendingHigh=data.slice(-1);data=data.slice(0,-1);}let chunk='',bytes=0;
  for(const char of data){const size=Buffer.byteLength(char);if(bytes+size>L.outputChunkBytes){this.chunk(entry,chunk,bytes);chunk='';bytes=0;}chunk+=char;bytes+=size;}if(chunk)this.chunk(entry,chunk,bytes);
 }
 private chunk(entry:Entry,data:string,_bytes:number){const event:Output={type:'output',sessionId:entry.session.id,sequence:++entry.session.sequence,data};entry.replay.push(event);entry.bytes+=Buffer.byteLength(JSON.stringify(event))+64;while(entry.bytes>L.replayBytes||entry.replay.length>2048){entry.bytes-=Buffer.byteLength(JSON.stringify(entry.replay.shift()!))+64;}this.deliver(entry,event);}
 private exit(entry:Entry,event:{exitCode:number;signal?:number}){if(entry.session.state==='exited')return;if(entry.pendingHigh){this.chunk(entry,entry.pendingHigh,Buffer.byteLength(entry.pendingHigh));entry.pendingHigh='';}Object.assign(entry.session,{state:'exited',exitCode:event.exitCode,...(event.signal!==undefined?{signal:event.signal}:{})});for(const fact of ['native','creation','prepared','exit'] as const)entry.warnings.delete(fact);this.warning(entry);if(entry.viewer)entry.viewer.leaseId=null;entry.ack();for(const disposable of entry.disposables)disposable.dispose();entry.disposables=[];entry.pty=undefined;this.deliver(entry,{type:'exit',session:this.snapshot(entry)});this.endViewer(entry);if(!this.options.ownerAlive(entry.owner))this.entries.delete(entry.owner);}
 stop(owner:object,id:string):Promise<TerminalSession>{return this.stopEntry(this.owned(owner,id));}
 private stopEntry(entry:Entry):Promise<TerminalSession>{
  if(entry.session.state==='exited')return Promise.resolve(this.snapshot(entry));if(entry.stop)return entry.stop.then(()=>this.snapshot(entry));if(entry.session.state==='stopping')return Promise.resolve(this.snapshot(entry));entry.cancelled=true;if(entry.viewer)entry.viewer.leaseId=null;
  if(!entry.committed){entry.cancelStart();entry.stop=this.disposePreparation(entry);return entry.stop.then(()=>this.snapshot(entry));}
  entry.session.state='stopping';this.status(entry);try{entry.pty?.kill();}catch{}
  entry.stop=(async()=>{let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([entry.exited,new Promise<void>(done=>timer=setTimeout(done,this.options.stopMs??5000))]);}finally{if(timer)clearTimeout(timer);}if(entry.session.state!=='exited'){entry.session.state='uncertain';this.warning(entry,'exit');this.status(entry);}})();return entry.stop.then(()=>this.snapshot(entry));
 }
 async sweep(){const work:Promise<unknown>[]=[];for(const entry of this.entries.values())if(!this.options.ownerAlive(entry.owner)){this.endViewer(entry);if(entry.session.state==='exited')this.entries.delete(entry.owner);else work.push(this.stopEntry(entry));}await Promise.all(work);}
 close():Promise<void>{return this.closePromise??=(async()=>{this.closing=true;clearInterval(this.timer);for(const entry of this.entries.values()){entry.cancelled=true;if(entry.session.state==='starting')entry.cancelStart();this.endViewer(entry);}await Promise.allSettled([...this.starts]);await Promise.all([...this.entries.values()].map(entry=>this.stopEntry(entry)));})();}
}
