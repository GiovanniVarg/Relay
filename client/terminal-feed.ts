import {TERMINAL_LIMITS as L,type TerminalEvent,type TerminalSession} from '../shared/terminal';

export type TerminalApi=<T>(path:string,method?:string,body?:unknown)=>Promise<T>;
interface Source {onopen:((event:any)=>void)|null;onmessage:((event:any)=>void)|null;onerror:((event:any)=>void)|null;close():void}
export interface TerminalRenderer {write(data:string,done:()=>void):void;reset():void}
export interface TerminalFeedState {
 session:TerminalSession;connection:'connecting'|'connected'|'disconnected'|'incomplete'|'exited';canInput:boolean;
 renderedSequence:number;pendingRenderBytes:number;pendingInputBytes:number;notice:string;rendererFailed:boolean;outputComplete:boolean;
}
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const integer=(value:unknown,min=0):value is number=>Number.isSafeInteger(value)&&(value as number)>=min;
const identifier=(value:unknown):value is string=>typeof value==='string'&&/^[-a-zA-Z0-9]{1,100}$/.test(value);
const bytes=(data:string)=>new TextEncoder().encode(data).byteLength;
export function parseTerminalSession(value:unknown):TerminalSession|null{
 if(!record(value)||!identifier(value.id)||typeof value.shellId!=='string'||value.shellId.length>100||typeof value.shellLabel!=='string'||value.shellLabel.length>200||typeof value.cwd!=='string'||value.cwd.length>32768||!(value.context===null||typeof value.context==='string'&&value.context.length<=1000)||!['starting','live','stopping','uncertain','exited'].includes(value.state as string)||!integer(value.sequence)||!integer(value.cols,L.minCols)||value.cols>L.maxCols||!integer(value.rows,L.minRows)||value.rows>L.maxRows||!(value.warning===undefined||typeof value.warning==='string'&&value.warning.length<=2000)||!(value.exitCode===undefined||Number.isSafeInteger(value.exitCode))||!(value.signal===undefined||Number.isSafeInteger(value.signal)))return null;
 return {id:value.id,shellId:value.shellId,shellLabel:value.shellLabel,cwd:value.cwd,context:value.context as string|null,state:value.state as TerminalSession['state'],cols:value.cols,rows:value.rows,sequence:value.sequence,...(value.warning===undefined?{}:{warning:value.warning as string}),...(value.exitCode===undefined?{}:{exitCode:value.exitCode as number}),...(value.signal===undefined?{}:{signal:value.signal as number})};
}
export function parseTerminalEvent(raw:unknown,sessionId:string):TerminalEvent|null{
 if(typeof raw!=='string'||raw.length>L.bodyBytes)return null;let value:unknown;try{value=JSON.parse(raw);}catch{return null;}if(!record(value))return null;
 if(value.type==='status'||value.type==='exit'){
  const session=parseTerminalSession(value.session);if(!session||session.id!==sessionId)return null;
  if(value.type==='exit')return {type:'exit',session};
  if(!(value.leaseId===null||identifier(value.leaseId))||!integer(value.nextInputSequence,1))return null;
  return {type:'status',session,leaseId:value.leaseId,nextInputSequence:value.nextInputSequence};
 }
 if(value.sessionId!==sessionId||!integer(value.sequence))return null;
 if(value.type==='output'&&value.sequence>0&&typeof value.data==='string'&&bytes(value.data)<=L.outputChunkBytes)return {type:'output',sessionId,sequence:value.sequence,data:value.data};
 if(value.type==='gap'&&typeof value.reason==='string'&&value.reason.length<=2000)return {type:'gap',sessionId,sequence:value.sequence,reason:value.reason};
 return null;
}
/** Split at Unicode code point boundaries, counting exactly the transport's UTF-8 bytes. */
function inputChunks(data:string):string[]{const chunks:string[]=[];let chunk='',size=0;for(const point of data){const length=bytes(point);if(size+length>L.inputBytes){chunks.push(chunk);chunk='';size=0;}chunk+=point;size+=length;}if(chunk)chunks.push(chunk);return chunks;}

/** Renderer lifetime and connection authority are deliberately separate generations.
 * An offline write may finish parsing into this VT. No next source opens until it does.
 * A replacement renderer always creates a new feed at cursor zero. */
export function terminalFeed(initial:TerminalSession,receive:(state:TerminalFeedState)=>void,renderer:TerminalRenderer,api:TerminalApi,create:(after:number)=>Source=after=>new EventSource(`/api/terminal/${encodeURIComponent(initial.id)}/events?after=${after}`)){
 let state:TerminalFeedState={session:initial,connection:'connecting',canInput:false,renderedSequence:0,pendingRenderBytes:0,pendingInputBytes:0,notice:'',rendererFailed:false,outputComplete:false};
 let closed=false,rendererGeneration=0,connectionGeneration=0,source:Source|null=null,lease:string|null=null,nextInput=1,seen=0,established=false,hasOutput=false,reconnectRequested=false,inputRevoked=false,exitSequence:number|null=null,finalExitObserved=false,clientNotice='',historyNotice='';
 type Chunk={sequence:number;data:string;bytes:number};type Rpc={kind:'input'|'resize';generation:number;bytes:number};let renderQueue:Chunk[]=[],inflight:Chunk|null=null,inputQueue:string[]=[],rpc:Rpc|null=null,pendingResize:{cols:number;rows:number}|null=null;
 const messages=(...values:(string|undefined)[])=>[...new Set(values.filter((value):value is string=>!!value))].join(' ');
 // Backend warnings are current opaque facts, never a durable copy in client notices.
 const publish=(patch:Partial<TerminalFeedState>={})=>{if(!closed){if(patch.notice!==undefined)clientNotice=patch.notice;state={...state,...patch};state.notice=messages(historyNotice,clientNotice,state.session.warning);receive(state);}};
 const disconnect=(notice:string,connection:TerminalFeedState['connection']='disconnected')=>{
  ++connectionGeneration;source?.close();source=null;lease=null;inputQueue=[];pendingResize=null;reconnectRequested=false;renderQueue=[];exitSequence=null;
  publish({connection,canInput:false,pendingInputBytes:0,pendingRenderBytes:inflight?.bytes??0,notice,outputComplete:false});
 };
 const fail=(notice:string)=>disconnect(notice,'incomplete');
 const lifecycle=(session:TerminalSession,fromStream=false)=>{
  if(session.id!==initial.id||finalExitObserved&&!fromStream||state.session.state==='exited'&&session.state!=='exited'||['stopping','uncertain'].includes(state.session.state)&&session.state==='live')return false;
  if(session.state!=='live'){lease=null;inputQueue=[];pendingResize=null;}
  const missingExit=session.state==='exited'&&!source&&exitSequence===null;
  publish({session,...(missingExit?{connection:'incomplete' as const,outputComplete:false}:{}),...(session.state!=='live'?{canInput:false,pendingInputBytes:0}:{}),notice:messages(clientNotice,missingExit?'Final output is incomplete. Reconnect to recover available output.':undefined)});return true;
 };
 const rendererFailure=()=>{++rendererGeneration;inflight=null;fail('Terminal rendering failed. Output is incomplete. Reconnect to replace the renderer and request complete available history.');publish({rendererFailed:true});};
 const pumpRender=()=>{
  if(closed||inflight||!renderQueue.length)return;const chunk=renderQueue.shift()!;inflight=chunk;const generation=rendererGeneration;let acknowledged=false;
  try{renderer.write(chunk.data,()=>{
   if(acknowledged||closed||generation!==rendererGeneration||inflight!==chunk)return;acknowledged=true;inflight=null;
   const remaining=state.pendingRenderBytes-chunk.bytes;publish({renderedSequence:chunk.sequence,pendingRenderBytes:remaining,outputComplete:exitSequence!==null&&chunk.sequence===exitSequence&&remaining===0});
   if(reconnectRequested&&!renderQueue.length){connect();return;}pumpRender();
  });}catch{rendererFailure();}
 };
 const pumpRpc=()=>{
  if(closed||rpc||!state.canInput||!lease||inputRevoked||!inputQueue.length&&!pendingResize)return;
  const data=inputQueue.shift(),dimensions=data===undefined?pendingResize:null,sequence=nextInput,authority=lease,generation=connectionGeneration;
  if(dimensions)pendingResize=null;const request:Rpc={kind:data===undefined?'resize':'input',generation,bytes:data===undefined?0:bytes(data)};rpc=request;
  const valid=()=>!closed&&generation===connectionGeneration&&lease===authority&&!inputRevoked;
  const path=`/terminal/${encodeURIComponent(initial.id)}/${request.kind}`,body=data===undefined?{leaseId:authority,...dimensions!}:{leaseId:authority,sequence,data};
  let result:Promise<any>;try{result=api(path,'POST',body);}catch{result=Promise.reject(new Error('Terminal operation failed'));}
  void result.then(value=>{
   if(!valid())return;if(request.kind==='input'){
    if(value?.nextInputSequence!==sequence+1){disconnect('Input could not be confirmed. Pending characters were discarded. Reconnect explicitly.');return;}
    nextInput=value.nextInputSequence;publish({pendingInputBytes:state.pendingInputBytes-request.bytes});
   }
  }).catch(()=>{if(valid())disconnect(request.kind==='input'?'Input could not be confirmed. Pending characters were discarded and will not be resent. Reconnect explicitly.':'Terminal resize could not be confirmed. Reconnect explicitly.');}).finally(()=>{if(rpc===request){rpc=null;pumpRpc();}});
 };
 const connect=()=>{
  if(closed||state.rendererFailed)return;
  if(inflight||renderQueue.length){reconnectRequested=true;publish({notice:'Waiting for terminal rendering to finish before reconnecting…'});pumpRender();return;}
  reconnectRequested=false;source?.close();const generation=++connectionGeneration;lease=null;inputQueue=[];pendingResize=null;seen=state.renderedSequence;established=false;hasOutput=false;inputRevoked=false;exitSequence=null;
  publish({connection:'connecting',canInput:false,pendingInputBytes:0,notice:'',outputComplete:false});let current:Source;
  try{current=create(state.renderedSequence);source=current;}catch{disconnect('Could not connect to the terminal. Reconnect explicitly.');return;}
  const valid=()=>!closed&&generation===connectionGeneration&&source===current;
  current.onmessage=message=>{
   if(!valid())return;const event=parseTerminalEvent(message.data,initial.id);if(!event){fail('Invalid terminal stream. Output may be incomplete. Reconnect explicitly.');return;}
   if(event.type==='status'){
    if(established&&!inputRevoked&&event.leaseId!==null&&event.leaseId!==lease){fail('Unexpected terminal authority change. Reconnect explicitly.');return;}
    if(!established)nextInput=event.nextInputSequence;
    established=true;lease=inputRevoked?null:event.leaseId;
    if(!lease||event.session.state!=='live'){inputQueue=[];pendingResize=null;publish({pendingInputBytes:0});}
    // HTTP Stop may acknowledge exit before older ordered SSE status reaches the browser.
    if(!lifecycle(event.session,true)){lease=null;return;}
    publish({connection:'connected',canInput:!!lease&&!inputRevoked&&event.session.state==='live',notice:!lease&&!inputRevoked&&event.session.state==='live'?'Terminal is controlled by another connection.':''});pumpRpc();return;
   }
   if(!established){fail('Terminal stream did not establish authority. Reconnect explicitly.');return;}
   if(event.type==='gap'){
    if(hasOutput||inflight||renderQueue.length){fail('Terminal replay reset arrived out of order. Reconnect explicitly.');return;}
    try{renderer.reset();}catch{rendererFailure();return;}seen=event.sequence;historyNotice='Earlier output is unavailable. The terminal view was reset; showing future output.';publish({renderedSequence:event.sequence});return;
   }
   if(event.type==='exit'){
    ++connectionGeneration;current.close();source=null;lease=null;inputQueue=[];pendingResize=null;exitSequence=event.session.sequence;
    finalExitObserved=true;
    const missing=seen!==exitSequence;publish({session:event.session,connection:missing?'incomplete':'exited',canInput:false,pendingInputBytes:0,outputComplete:!missing&&state.renderedSequence===exitSequence&&state.pendingRenderBytes===0,notice:messages(clientNotice,`Shell exited${event.session.exitCode===undefined?'':` (${event.session.exitCode})`}.`,missing?'Final output is incomplete. Reconnect to recover available output.':undefined)});return;
   }
   if(event.sequence!==seen+1){fail('Terminal output has a gap. Reconnect explicitly.');return;}
   const size=bytes(event.data);if(state.pendingRenderBytes+size>L.pendingRenderBytes){fail('Terminal output exceeded the rendering limit. Output is incomplete. Reconnect explicitly.');return;}
   hasOutput=true;seen=event.sequence;renderQueue.push({sequence:event.sequence,data:event.data,bytes:size});publish({pendingRenderBytes:state.pendingRenderBytes+size});pumpRender();
  };
  current.onerror=()=>{if(valid())disconnect('Terminal connection unavailable. It may already be connected in another Relay tab. Reconnect explicitly; pending input will not be resent.');};
 };
 publish();connect();
 return {
  acknowledgeSession(session:TerminalSession){if(!closed)lifecycle(session);return state.session;},
  revokeInput(){if(closed)return;inputRevoked=true;lease=null;inputQueue=[];pendingResize=null;publish({canInput:false,pendingInputBytes:0});},
  input(data:string){if(closed||!state.canInput||inputRevoked||!data)return;const size=bytes(data),staleBytes=rpc&&rpc.generation!==connectionGeneration?rpc.bytes:0;if(state.pendingInputBytes+size+staleBytes>L.pendingInputBytes){disconnect('Too much pending input. Characters were discarded and will not be resent. Reconnect explicitly.');return;}inputQueue.push(...inputChunks(data));publish({pendingInputBytes:state.pendingInputBytes+size});pumpRpc();},
  resize(cols:number,rows:number){if(closed||!state.canInput||!lease)return;cols=Math.max(L.minCols,Math.min(L.maxCols,Math.floor(cols)));rows=Math.max(L.minRows,Math.min(L.maxRows,Math.floor(rows)));if(!Number.isFinite(cols)||!Number.isFinite(rows))return;
   pendingResize={cols,rows};pumpRpc();
  },
  reconnect(){if(closed||source)return;connect();},
  disconnect(){if(!closed)disconnect('Relay disconnected. Reconnect explicitly when it is available.');},
  close(){if(closed)return;closed=true;++rendererGeneration;++connectionGeneration;source?.close();source=null;lease=null;renderQueue=[];inflight=null;inputQueue=[];},
 };
}
