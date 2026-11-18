import type {IncomingMessage,ServerResponse} from 'node:http';
import type {Terminals} from './terminal.js';
import {HttpError,jsonBody,only,stringValue} from './security.js';
import {TERMINAL_LIMITS as L,type TerminalEvent} from '../shared/terminal.js';
const send=(res:ServerResponse,status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
/** Ordered events: backpressure disconnects; it never skips terminal chunks. */
export function terminalStream(req:IncomingMessage,res:ServerResponse,manager:Terminals,owner:object,id:string,after:number,options:{blockedMs?:number}={}):void{
 let ended=false,unsubscribe:(()=>void)|undefined,blocked:ReturnType<typeof setTimeout>|undefined,heartbeat:ReturnType<typeof setInterval>|undefined;
 const clearBlocked=()=>{if(blocked)clearTimeout(blocked);blocked=undefined;};
 const detach=()=>{const off=unsubscribe;unsubscribe=undefined;off?.();};
 const cleanup=()=>{clearBlocked();if(heartbeat)clearInterval(heartbeat);heartbeat=undefined;res.removeListener('drain',drain);res.removeListener('finish',complete);res.removeListener('close',complete);req.removeListener('aborted',abort);detach();};
 const complete=()=>{ended=true;cleanup();};
 const drain=()=>{if(!ended)clearBlocked();};
 const deadline=()=>{if(!blocked)blocked=setTimeout(()=>end(true,true),options.blockedMs??L.blockedMs);};
 const end=(terminate=true,force=false)=>{
  if(ended&&!force)return;ended=true;detach();if(heartbeat)clearInterval(heartbeat);heartbeat=undefined;
  if(!terminate||res.destroyed||res.writableFinished){cleanup();return;}
  if(force){res.destroy();cleanup();return;}
  // Queued bytes are ordinary writes, not proof of a stalled peer. Preserve any
  // existing blocked deadline while end flushes the final frame/chunk terminator.
  deadline();if(!res.writableEnded)res.end();if(res.writableFinished)cleanup();
 };
 const abort=()=>end(true,true);
 const write=(frame:string)=>{if(ended)return;if(res.destroyed||res.writableEnded){end();return;}if(res.writableLength+Buffer.byteLength(frame)>L.streamBacklogBytes){end(true,true);return;}if(!res.headersSent)res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no'});if(!res.write(frame))deadline();};
 res.on('drain',drain);res.on('finish',complete);res.on('close',complete);req.on('aborted',abort);
 try{unsubscribe=manager.subscribe(owner,id,after,(event:TerminalEvent)=>write(`data: ${JSON.stringify(event)}\n\n`),end);if(ended){detach();return;}heartbeat=setInterval(()=>write(': heartbeat\n\n'),15000);heartbeat.unref();}catch(error){end(false);throw error;}
}
/** Invoked after exact host/origin/fetch-site/session and mutation CSRF checks. */
export async function terminalApi(req:IncomingMessage,res:ServerResponse,url:URL,manager:Terminals,owner:object):Promise<boolean>{
 const path=url.pathname,method=req.method??'GET';if(path!=='/api/terminal'&&!path.startsWith('/api/terminal/'))return false;
 if(path==='/api/terminal/shells'&&method==='GET'){send(res,200,await manager.catalog());return true;}
 if(path==='/api/terminal'&&method==='GET'){send(res,200,{session:manager.current(owner)});return true;}
 if(path==='/api/terminal/start'&&method==='POST'){const body=await jsonBody(req,L.bodyBytes);only(body,['shellId','agentId','cols','rows']);const session=await manager.start(owner,{shellId:stringValue(body.shellId,'Shell ID',100,1),...(body.agentId===undefined?{}:{agentId:stringValue(body.agentId,'Agent ID',100,1)}),cols:body.cols as number,rows:body.rows as number});send(res,201,{session});return true;}
 const match=/^\/api\/terminal\/([-a-zA-Z0-9]{1,100})\/(events|input|resize|stop)$/.exec(path);if(!match)throw new HttpError(404,'Terminal endpoint not found');const [,id,action]=match;
 if(action==='events'&&method==='GET'){const value=url.searchParams.get('after')??'0';if(!/^\d{1,16}$/.test(value))throw new HttpError(400,'Invalid terminal output cursor');terminalStream(req,res,manager,owner,id,Number(value));return true;}
 if(method==='POST'&&action!=='events'){
  // Body awaits before the manager's final owner/lease/sequence/maintenance boundary.
  const body=await jsonBody(req,L.bodyBytes);
  if(action==='input'){only(body,['leaseId','sequence','data']);send(res,200,await manager.input(owner,id,{leaseId:stringValue(body.leaseId,'Terminal lease',100,1),sequence:body.sequence as number,data:body.data as string}));return true;}
  if(action==='resize'){only(body,['leaseId','cols','rows']);send(res,200,{session:await manager.resize(owner,id,{leaseId:stringValue(body.leaseId,'Terminal lease',100,1),cols:body.cols as number,rows:body.rows as number})});return true;}
  only(body,[]);send(res,200,{session:await manager.stop(owner,id)});return true;
 }
 throw new HttpError(405,'Terminal method not allowed');
}
