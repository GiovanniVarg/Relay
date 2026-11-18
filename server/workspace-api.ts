import type {McpConnections} from './mcp-connections.js';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import type {Tasks} from './tasks.js';
import type {Knowledge} from './knowledge.js';
import type {Capabilities} from './capabilities.js';
import type {Browser} from './browser.js';
import type {Artifacts} from './artifacts.js';
import type {RoutingInsights} from './routing-insights.js';
import type {Runs} from './runs.js';
import {browserWatchStream} from './browser-watch.js';
import type {BrowserStopResult} from '../shared/browser-watch.js';
import {jsonBody,only,stringValue,HttpError} from './security.js';
import {isActiveProviderId} from '../shared/types.js';
interface Services{mcp:McpConnections;operation:{installDirectory:string;dataDirectory:string};tasks:Tasks;knowledge:Knowledge;capabilities:Capabilities;browser:Browser;artifacts:Artifacts;routing:RoutingInsights;runs:Runs}
const send=(res:ServerResponse,status:number,data:unknown)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
/** Called only after Relay's local session/CSRF checks. */
export async function workspaceApi(req:IncomingMessage,res:ServerResponse,url:URL,s:Services):Promise<boolean>{
 const path=url.pathname,method=req.method??'GET',parts=path.split('/').filter(Boolean),key=parts[2],action=parts[3];
 if(path==='/api/workspace'&&method==='GET'){
  const tasks=s.tasks.list();const agentIds=[...new Set(tasks.map(t=>t.agentId))];
  send(res,200,{tasks,capabilities:s.capabilities.matrix(s.runs.providers()),routing:s.routing.snapshot(),artifacts:s.artifacts.list(),knowledge:s.knowledge.list(undefined,true),browserProfiles:agentIds.map(agentId=>s.capabilities.browserGrant(agentId)),operation:{node:process.versions.node,...s.operation,localOnly:true,autostart:'Choose it in setup-relay.ps1; never enabled automatically'}});return true;
 }
 if(parts[1]==='tasks'){
  if(parts.length===2&&method==='GET'){send(res,200,{tasks:s.tasks.list(url.searchParams.get('agentId')??undefined)});return true;}
  if(parts.length===2&&method==='POST'){const body=await jsonBody(req);only(body,['agentId','title','prompt','dueAt','repeatMinutes','requiredCapabilities','requiredInputModalities']);send(res,201,s.tasks.create(body as unknown as Parameters<Tasks['create']>[0]));return true;}
  if(key&&parts.length===3&&method==='GET'){send(res,200,s.tasks.get(key));return true;}
  if(key&&parts.length===4&&method==='POST'){
   const body=await jsonBody(req);
   if(action==='resume'){only(body,[]);send(res,200,s.tasks.resume(key,true));return true;}
   if(action==='cancel'){only(body,[]);send(res,200,await s.tasks.cancel(key));return true;}
   if(action==='checkpoint'){only(body,['content']);send(res,200,s.tasks.checkpoint(key,stringValue(body.content,'Checkpoint',24000,1)));return true;}
  }
 }
 if(parts[1]==='knowledge'){
  if(parts.length===2&&method==='GET'){const aid=url.searchParams.get('agentId'),q=url.searchParams.get('q');send(res,200,{entries:aid&&q?s.knowledge.search(aid,q):s.knowledge.list(aid??undefined,true)});return true;}
  if(parts.length===2&&method==='POST'){const body=await jsonBody(req);only(body,['agentId','title','content','scope','kind']);send(res,201,s.knowledge.propose(body as unknown as Parameters<Knowledge['propose']>[0]));return true;}
  if(key&&parts.length===4&&method==='POST'){only(await jsonBody(req),[]);if(action==='approve'){send(res,200,s.knowledge.approve(key));return true;}if(action==='reject'){send(res,200,s.knowledge.reject(key));return true;}}
 }
 if(parts[1]==='capabilities'&&key&&parts.length===4&&action==='browser'){
  if(method==='GET'){send(res,200,{grant:s.capabilities.browserGrant(key),status:await s.browser.status(key)});return true;}
  if(method==='PATCH'){const body=await jsonBody(req);only(body,['enabled']);const grant=s.capabilities.setBrowserGrant(key,body.enabled as boolean);if(!grant.enabled)await s.browser.revoke(key);send(res,200,grant);return true;}
 }
 if(parts[1]==='browser'&&key&&parts.length===4&&method==='POST'){
  only(await jsonBody(req),[]);
  s.capabilities.browserGrant(key);
  if(action==='stop'){
   // Snapshot attribution before invoking any cancellation. Creator-owned peer tasks are excluded.
   const tasks=s.tasks.list(key).filter(task=>task.agentId===key&&['working','queued','needs_input'].includes(task.status));
   const taskIds=tasks.map(task=>task.id),runSnapshots=[...s.runs.active].filter(([,active])=>active.run.agentId===key),runIds=runSnapshots.map(([runId])=>runId);
   const reasons=new Set<string>();
   if(tasks.some(task=>task.recoveryRequired))reasons.add('task_recovery_required');
   if(tasks.some(task=>task.status==='working'&&!task.runId&&!task.waitingForChildren))reasons.add('pending_dispatch');
   // Invoke every stop including browser closure before waiting for any individual native stop.
   const attempt=(fn:()=>Promise<unknown>,reason:string)=>{try{return Promise.resolve(fn()).catch(()=>{reasons.add(reason);});}catch{reasons.add(reason);return Promise.resolve();}};
   const attempts=[attempt(()=>s.browser.revoke(key,'stop'),'browser_close_failed'),...taskIds.map(taskId=>attempt(()=>s.tasks.cancel(taskId),'task_cancellation_failed')),...runIds.map(runId=>attempt(()=>s.runs.cancel(runId),'run_cancellation_failed'))];
   let timer:ReturnType<typeof setTimeout>|undefined;
   try{await Promise.race([Promise.all(attempts),new Promise<void>(resolve=>{timer=setTimeout(()=>{reasons.add('cancellation_pending');resolve();},5000);})]);}finally{if(timer)clearTimeout(timer);}
   if(taskIds.some(taskId=>s.tasks.get(taskId).recoveryRequired))reasons.add('task_recovery_required');
   if(runSnapshots.some(([,active])=>active.run.status==='interrupted'||/unknown|unconfirmed|termination/i.test(active.run.error??'')))reasons.add('run_stop_uncertain');
   if(runIds.some(runId=>s.runs.active.has(runId)))reasons.add('run_cancellation_pending');
   const browser=await s.browser.status(key);
   const result:BrowserStopResult=reasons.size?{status:'stop_unconfirmed',browser,reasons:[...reasons],error:'Stop requested, but some work could not be confirmed stopped. Check Tasks for details.'}:{status:'stop_requested',browser};
   send(res,reasons.size?409:202,result);return true;
  }
  if(action==='takeover'){send(res,200,await s.browser.takeover(key));return true;}
  if(action==='return'){send(res,200,await s.browser.returnControl(key));return true;}
 }
 if(parts[1]==='browser'&&key&&parts.length===4&&action==='events'&&method==='GET'){
  s.capabilities.browserGrant(key);browserWatchStream(req,res,s.browser,key);return true;
 }
 if(parts[1]==='artifacts'){
  if(parts.length===2&&method==='GET'){send(res,200,{artifacts:s.artifacts.list(url.searchParams.get('agentId')??undefined)});return true;}
  if(key&&parts.length===4&&action==='verify'&&method==='POST'){only(await jsonBody(req),[]);send(res,200,await s.artifacts.verify(key));return true;}
  if(key&&parts.length===4&&action==='content'&&method==='GET'){const {artifact,bytes}=await s.artifacts.read(key);res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(artifact.name)}`,'Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; sandbox"});res.end(bytes);return true;}
 }
 if(parts[1]==='mcp'){
  if(parts.length===2&&method==='GET'){send(res,200,{connections:s.mcp.list(url.searchParams.get('agentId')??undefined)});return true;}
  if(parts.length===2&&method==='POST'){const body=await jsonBody(req);only(body,['agentId','name','url','token']);send(res,201,await s.mcp.add(body as unknown as Parameters<McpConnections['add']>[0]));return true;}
  if(key&&parts.length===3&&method==='DELETE'){await s.mcp.remove(key);send(res,200,{ok:true});return true;}
  if(key&&parts.length===4&&action==='refresh'&&method==='POST'){only(await jsonBody(req),[]);send(res,200,await s.mcp.refresh(key));return true;}
 }
 if(parts[1]==='routing'){
  if(parts.length===2&&method==='GET'){send(res,200,s.routing.snapshot());return true;}
  if(key&&parts.length===4&&action==='feedback'&&method==='POST'){const body=await jsonBody(req);only(body,['value']);send(res,200,s.routing.feedback(key,body.value,'direct-operator'));return true;}
  if(key&&parts.length===4&&action==='availability'&&method==='PATCH'){if(!isActiveProviderId(key))throw new HttpError(404,'Provider not found');send(res,200,s.routing.setAvailability(key,await jsonBody(req)));return true;}
 }
 return false;
}
