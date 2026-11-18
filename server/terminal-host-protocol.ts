import {isAbsolute} from 'node:path';
export const HOST_LIMITS={commandWire:128*1024,outputRaw:16*1024,queueWire:512*1024,totalWire:1024*1024,frames:512,pauseFrames:256,resumeWire:256*1024,resumeFrames:128,readyMs:10000,rpcMs:5000,stopMs:5000,flushMs:5000,hardMs:15000,controlCount:8} as const;
export interface PtyConfig {cwd:string;env:Record<string,string>;cols:number;rows:number;name:string}
export interface SpawnConfig extends PtyConfig {file:string;args:string[]}
export type ParentFrame={type:'spawn';id:1;config:SpawnConfig}|{type:'input';id:number;data:string}|{type:'resize';id:number;cols:number;rows:number}|{type:'stop'}|{type:'output-ack';sequence:number};
export type HostFault='unavailable'|'protocol'|'native'|'transport'|'incomplete';
export type HostFrame={type:'ready'}|{type:'spawned';id:1}|{type:'ack';id:number;ok:boolean}|{type:'output';sequence:number;data:string}|{type:'exit';sequence:number;exitCode:number;signal?:number;incomplete:boolean}|{type:'fault';code:HostFault};
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const keys=(x:Record<string,unknown>,allowed:string[])=>Object.keys(x).every(key=>allowed.includes(key));
const integer=(x:unknown,min=0):x is number=>Number.isSafeInteger(x)&&(x as number)>=min;
const text=(x:unknown,max:number):x is string=>typeof x==='string'&&x.length<=max&&!x.includes('\0');
export const dimensions=(cols:unknown,rows:unknown)=>integer(cols,20)&&(cols as number)<=500&&integer(rows,5)&&(rows as number)<=200;
export function wireBytes(value:unknown):number{try{return Buffer.byteLength(JSON.stringify(value))+64;}catch{return Infinity;}}
export function isSpawnConfig(x:unknown):x is SpawnConfig{return object(x)&&keys(x,['file','args','cwd','env','cols','rows','name'])&&text(x.file,4096)&&!!x.file&&isAbsolute(x.file)&&Array.isArray(x.args)&&x.args.length<=32&&x.args.every(a=>text(a,8192))&&text(x.cwd,4096)&&isAbsolute(x.cwd)&&object(x.env)&&Object.keys(x.env).length<=1024&&Object.entries(x.env).every(([k,v])=>k.length>0&&k.length<=512&&!/[=\0]/.test(k)&&text(v,65536))&&dimensions(x.cols,x.rows)&&x.name==='xterm-256color';}
export function parentFrame(x:unknown):x is ParentFrame{
 if(!object(x)||wireBytes(x)>HOST_LIMITS.commandWire)return false;
 switch(x.type){case 'spawn':return keys(x,['type','id','config'])&&x.id===1&&isSpawnConfig(x.config);case 'input':return keys(x,['type','id','data'])&&integer(x.id,2)&&typeof x.data==='string'&&x.data.length>0&&Buffer.byteLength(x.data)<=HOST_LIMITS.outputRaw;case 'resize':return keys(x,['type','id','cols','rows'])&&integer(x.id,2)&&dimensions(x.cols,x.rows);case 'stop':return keys(x,['type']);case 'output-ack':return keys(x,['type','sequence'])&&integer(x.sequence,1);default:return false;}
}
export function hostFrame(x:unknown):x is HostFrame{
 if(!object(x)||wireBytes(x)>HOST_LIMITS.commandWire)return false;
 switch(x.type){case 'ready':return keys(x,['type']);case 'spawned':return keys(x,['type','id'])&&x.id===1;case 'ack':return keys(x,['type','id','ok'])&&integer(x.id,2)&&typeof x.ok==='boolean';case 'output':return keys(x,['type','sequence','data'])&&integer(x.sequence,1)&&typeof x.data==='string'&&x.data.length>0&&Buffer.byteLength(x.data)<=HOST_LIMITS.outputRaw;case 'exit':return keys(x,['type','sequence','exitCode','signal','incomplete'])&&integer(x.sequence)&&Number.isInteger(x.exitCode)&&(x.signal===undefined||Number.isInteger(x.signal))&&typeof x.incomplete==='boolean';case 'fault':return keys(x,['type','code'])&&['unavailable','protocol','native','transport','incomplete'].includes(x.code as string);default:return false;}
}
/** User payload excludes host IPC and Relay controls; host bootstrap is stricter. */
export function shellEnvironment(source:NodeJS.ProcessEnv):Record<string,string>{return Object.fromEntries(Object.entries(source).filter(([key,value])=>value!==undefined&&!/^(RELAY_|NODE_CHANNEL_|NODE_UNIQUE_ID$)/i.test(key))) as Record<string,string>;}
export function hostEnvironment(source:NodeJS.ProcessEnv):Record<string,string>{return Object.fromEntries(Object.entries(shellEnvironment(source)).filter(([key])=>!/^(NODE_OPTIONS|NODE_PATH|ELECTRON_.*)$/i.test(key)));}
export function deferred<T>(){let resolve!:(value:T|PromiseLike<T>)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});void promise.catch(()=>{});return {promise,resolve,reject};}
