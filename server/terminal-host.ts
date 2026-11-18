import {release} from 'node:os';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {HOST_LIMITS as H,parentFrame,wireBytes,shellEnvironment,type HostFrame,type HostFault} from './terminal-host-protocol.js';
interface NativePty {write(data:string):void;resize(cols:number,rows:number):void;kill():void;pause():void;resume():void;on(event:string,fn:(error:unknown)=>void):unknown;onData(fn:(data:string)=>void):unknown;onExit(fn:(event:{exitCode:number;signal?:number})=>void):unknown}
export interface HostChannel {connected():boolean;send(frame:HostFrame,callback:(error?:Error|null)=>void):void;onMessage(fn:(message:unknown)=>void):void;onDisconnect(fn:()=>void):void;exit(code:number):void}
export interface NativeEngine {spawn(file:string,args:string[],options:Record<string,unknown>):NativePty}
const loadEngine=async():Promise<NativeEngine>=>{const packageName='node-pty';const mod=await import(packageName);const engine=mod.default??mod;if(typeof engine.spawn!=='function')throw Error();const build=Number(release().split('.')[2]);if(process.platform==='win32'&&(!Number.isInteger(build)||build<18309))throw Error();return engine;};
/** One private native owner. Only this helper deliberately exits; Relay never loads NAPI. */
export function runTerminalHost(channel:HostChannel,load:()=>Promise<NativeEngine>=loadEngine,platform=process.platform,limits:{stopMs?:number;flushMs?:number;hardMs?:number}={}){
 let engine:NativeEngine|undefined,pty:NativePty|undefined,committed=false,stopping=false,finalized=false,finishing=false,paused=false,incomplete=false,disconnected=false,lastRequest=1,sequence=0,lastSent=0,queuedWire=0,controls=0;
 let high='',inflight:{frame:Extract<HostFrame,{type:'output'}>;bytes:number}|undefined,nativeExit:{exitCode:number;signal?:number}|undefined;
 const queue:{frame:Extract<HostFrame,{type:'output'}>;bytes:number}[]=[];
 let stopTimer:ReturnType<typeof setTimeout>|undefined,flushTimer:ReturnType<typeof setTimeout>|undefined,hardTimer:ReturnType<typeof setTimeout>|undefined;
 const clear=(timer:ReturnType<typeof setTimeout>|undefined)=>{if(timer)clearTimeout(timer);};
 const exit=(code:number)=>{if(finalized)return;finalized=true;clear(stopTimer);clear(flushTimer);clear(hardTimer);channel.exit(code);};
 const hard=()=>{if(!hardTimer)hardTimer=setTimeout(()=>exit(1),limits.hardMs??H.hardMs);};
 const control=(frame:HostFrame,done?:()=>void)=>{if(!channel.connected()||controls>=H.controlCount){hard();return false;}controls++;try{channel.send(frame,error=>{controls--;if(error){hard();if(!stopping)stop();}else done?.();});return true;}catch{controls--;hard();if(!stopping)stop();return false;}};
 const fault=(code:HostFault)=>{if(code==='incomplete')incomplete=true;control({type:'fault',code});stop();};
 const pressure=()=>{const bytes=queuedWire+(inflight?.bytes??0),frames=queue.length+(inflight?1:0);if(!stopping&&!paused&&(bytes>=H.queueWire||frames>=H.pauseFrames)){paused=true;pty?.pause();}else if(paused&&!stopping&&bytes<=H.resumeWire&&frames<=H.resumeFrames){paused=false;pty?.resume();}};
 const finish=()=>{
  if(!nativeExit||finalized||finishing)return;if(queue.length||inflight)return;finishing=true;clear(flushTimer);hard();
  const event:HostFrame={type:'exit',sequence:lastSent,exitCode:nativeExit.exitCode,...(nativeExit.signal===undefined?{}:{signal:nativeExit.signal}),incomplete};
  if(!control(event,()=>exit(0))&&disconnected)exit(1);
 };
 const pump=()=>{if(finalized||inflight)return;const next=queue.shift();if(!next){pressure();finish();return;}queuedWire-=next.bytes;inflight=next;lastSent=next.frame.sequence;
  if(!channel.connected()){incomplete=true;stop();return;}try{channel.send(next.frame,error=>{if(error){incomplete=true;fault('transport');}});}catch{incomplete=true;fault('transport');}pressure();
 };
 const enqueue=(data:string)=>{
  if(finalized||(!data.length))return;const frame:Extract<HostFrame,{type:'output'}>={type:'output',sequence:sequence+1,data},bytes=wireBytes(frame);
  if(queuedWire+bytes>H.queueWire||queuedWire+bytes+(inflight?.bytes??0)>H.totalWire||queue.length+(inflight?1:0)>=H.frames){incomplete=true;fault('incomplete');return;}
  sequence++;queue.push({frame,bytes});queuedWire+=bytes;pressure();pump();
 };
 const output=(data:string)=>{if(finalized||typeof data!=='string'||(incomplete&&stopping))return;data=high+data;high='';const last=data.charCodeAt(data.length-1);if(last>=0xd800&&last<=0xdbff){high=data.slice(-1);data=data.slice(0,-1);}let chunk='',bytes=0;for(const char of data){const size=Buffer.byteLength(char);if(bytes+size>H.outputRaw){enqueue(chunk);chunk='';bytes=0;if(incomplete&&stopping)return;}chunk+=char;bytes+=size;}if(chunk)enqueue(chunk);};
 function stop(){if(stopping)return;stopping=true;hard();if(!committed||!pty){exit(0);return;}if(nativeExit){finish();return;}if(paused){paused=false;try{pty.resume();}catch{}}
  stopTimer=setTimeout(()=>{if(!nativeExit){control({type:'fault',code:'native'});exit(1);}},limits.stopMs??H.stopMs);try{pty.kill();}catch{control({type:'fault',code:'native'});}
 }
 channel.onDisconnect(()=>{disconnected=true;stop();});
 channel.onMessage(raw=>{
  if(finalized)return;if(!parentFrame(raw)){fault('protocol');return;}const message=raw;
  if(message.type==='stop'){stop();return;}
  if(message.type==='output-ack'){
   if(!inflight||inflight.frame.sequence!==message.sequence){fault('protocol');return;}inflight=undefined;pressure();pump();return;
  }
  if(message.type==='spawn'){
   if(!engine||committed||stopping){fault('protocol');return;}committed=true;
   try{const config=message.config;pty=engine.spawn(config.file,config.args,{cwd:config.cwd,env:shellEnvironment(config.env),cols:config.cols,rows:config.rows,name:config.name,...(platform==='win32'?{useConpty:true,useConptyDll:true}:{})});pty.on('error',()=>fault('native'));pty.onData(output);pty.onExit(event=>{
    if(nativeExit)return;nativeExit=event;clear(stopTimer);if(high){enqueue(high);high='';}
    flushTimer=setTimeout(()=>{if(finalized)return;incomplete=true;control({type:'fault',code:'incomplete'});queue.length=0;queuedWire=0;inflight=undefined;finish();},limits.flushMs??H.flushMs);finish();
   });control({type:'spawned',id:1});}catch{control({type:'fault',code:'native'});exit(1);}return;
  }
  if(!pty||stopping||nativeExit||message.id!==lastRequest+1){fault('protocol');return;}lastRequest=message.id;
  try{if(message.type==='input')pty.write(message.data);else pty.resize(message.cols,message.rows);control({type:'ack',id:message.id,ok:true});}catch{control({type:'ack',id:message.id,ok:false});fault('native');}
 });
 void load().then(value=>{if(finalized||stopping)return;engine=value;control({type:'ready'});}).catch(()=>{if(finalized)return;control({type:'fault',code:'unavailable'},()=>exit(1));hard();});
 return {stop,stats:()=>({queuedWire,inflightWire:inflight?.bytes??0,frames:queue.length+(inflight?1:0),paused,incomplete})};
}
const main=!!process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(main){
 const channel:HostChannel={connected:()=>!!process.connected,send:(frame,callback)=>{if(!process.send){callback(Error('No private channel'));return;}process.send(frame,callback);},onMessage:fn=>process.on('message',fn),onDisconnect:fn=>process.on('disconnect',fn),exit:code=>process.exit(code)};
 const host=runTerminalHost(channel);process.on('uncaughtException',()=>host.stop());process.on('unhandledRejection',()=>host.stop());
}
