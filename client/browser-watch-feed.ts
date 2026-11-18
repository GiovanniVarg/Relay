import type {BrowserStatus} from '../shared/capabilities';
import type {BrowserWatchEvent,BrowserWatchAction,BrowserWatchPhase,BrowserWatchClearReason} from '../shared/browser-watch';

const maxJpeg=512*1024,maxEncoded=4*Math.ceil(maxJpeg/3),maxEvent=maxEncoded+20000;
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const id=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value);
const session=(value:unknown):value is string|null=>value===null||id(value);
const iso=(value:unknown):value is string=>typeof value==='string'&&value.length<=30&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const url=(value:unknown):value is string=>typeof value==='string'&&value.length<=8192&&!/[\u0000-\u001f\u007f]/.test(value);
export function parseBrowserStatus(value:unknown):BrowserStatus|null{
 if(!record(value)||!['granted','available','running','humanControl'].every(key=>typeof value[key]==='boolean')||!session(value.sessionId)||!(value.url===null||url(value.url)))return null;
 return {granted:value.granted as boolean,available:value.available as boolean,running:value.running as boolean,humanControl:value.humanControl as boolean,url:value.url as string|null,sessionId:value.sessionId};
}
/** Only validated JPEG bytes become image sources. Extra fields (including fill values) are discarded. */
export function parseBrowserWatchEvent(raw:unknown,agentId:string):BrowserWatchEvent|null{
 if(typeof raw!=='string'||raw.length>maxEvent)return null;
 let value:unknown;try{value=JSON.parse(raw);}catch{return null;}
 if(!record(value)||value.agentId!==agentId||!id(value.agentId)||!Number.isSafeInteger(value.sequence)||(value.sequence as number)<1||!iso(value.observedAt)||!session(value.sessionId))return null;
 const base={agentId,sequence:value.sequence as number,observedAt:value.observedAt,sessionId:value.sessionId};
 if(value.type==='status'){const status=parseBrowserStatus(value.status);return status&&status.sessionId===base.sessionId?{...base,type:'status',status}:null;}
 if(value.type==='frame'){
  if(!id(base.sessionId)||!url(value.url)||!iso(value.capturedAt)||typeof value.jpeg!=='string'||value.jpeg.length>maxEncoded||!value.jpeg.length||value.jpeg.length%4!==0||!/^\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(value.jpeg))return null;
  const bytes=value.jpeg.length/4*3-(value.jpeg.endsWith('==')?2:value.jpeg.endsWith('=')?1:0);
  if(bytes>maxJpeg)return null;
  return {...base,type:'frame',sessionId:base.sessionId,url:value.url,jpeg:value.jpeg,capturedAt:value.capturedAt};
 }
 if(value.type==='activity'&&['open','read','click','fill','screenshot','takeover','return','stop','revoke'].includes(value.action as string)&&['started','complete','failed'].includes(value.phase as string))return {...base,type:'activity',action:value.action as BrowserWatchAction,phase:value.phase as BrowserWatchPhase};
 if(value.type==='clear'&&['session_closed','session_replaced','revoked','shutdown','unavailable','navigation'].includes(value.reason as string))return {...base,type:'clear',reason:value.reason as BrowserWatchClearReason};
 return null;
}
type Frame=Extract<BrowserWatchEvent,{type:'frame'}>;
type Activity=Extract<BrowserWatchEvent,{type:'activity'}>;
export interface BrowserFeedState {status:BrowserStatus|null;frame:Frame|null;activities:Activity[];connection:'connecting'|'connected'|'reconnecting'|'disconnected';receivedAt:number|null;}
export const emptyBrowserFeed=():BrowserFeedState=>({status:null,frame:null,activities:[],connection:'connecting',receivedAt:null});
interface Source {onopen:((event:any)=>void)|null;onmessage:((event:any)=>void)|null;onerror:((event:any)=>void)|null;close():void;}
/** Each retry owns a fresh source/sequence. Closing invalidates queued callbacks as well as transport. */
export function browserWatchFeed(agentId:string,receive:(state:BrowserFeedState)=>void,create:()=>Source=()=>new EventSource(`/api/browser/${encodeURIComponent(agentId)}/events`),schedule:(tick:()=>void)=>()=>void=tick=>{const timer=setTimeout(tick,1500);return()=>clearTimeout(timer);}){
 let closed=false,generation=0,source:Source|null=null,cancelRetry:(()=>void)|null=null,state=emptyBrowserFeed();
 const publish=(next:BrowserFeedState)=>{if(!closed){state=next;receive(state);}};
 const connect=()=>{
  if(closed)return;const version=++generation;let sequence=0,established=false;
  const current=create();source=current;
  const valid=()=>!closed&&version===generation&&source===current;
  current.onopen=()=>{if(valid())publish({...state,connection:'connecting'});};
  current.onmessage=message=>{
   if(!valid())return;const event=parseBrowserWatchEvent(message.data,agentId);if(!event||event.sequence<=sequence||(!established&&event.type!=='status'))return;
   if(event.type==='status'){
    sequence=event.sequence;established=true;const reset=event.sessionId!==state.status?.sessionId||event.status.url!==state.status?.url||!event.status.granted||!event.status.running;
    publish({...state,status:event.status,connection:'connected',...(reset?{frame:null,receivedAt:null,activities:[]}: {})});return;
   }
   if(event.sessionId!==state.status?.sessionId)return;sequence=event.sequence;
   if(event.type==='frame'){
    if(!state.status?.granted||!state.status.running||!event.sessionId)return;
    publish({...state,frame:event,receivedAt:Date.now(),status:{...state.status,url:event.url}});
   }else if(event.type==='activity')publish({...state,activities:[...state.activities,event].slice(-40)});
   else if(event.type==='clear'){if(event.reason!=='navigation')established=false;publish({...state,frame:null,receivedAt:null,activities:[],status:state.status?{...state.status,url:null}:null});}
  };
  current.onerror=()=>{
   if(!valid())return;++generation;current.close();source=null;
   publish({...emptyBrowserFeed(),connection:'reconnecting'});cancelRetry=schedule(connect);
  };
 };
 receive(state);connect();
 return {close(){if(closed)return;closed=true;++generation;cancelRetry?.();source?.close();source=null;},disconnect(){if(closed)return;++generation;cancelRetry?.();source?.close();source=null;publish({...emptyBrowserFeed(),connection:'disconnected'});}};
}
