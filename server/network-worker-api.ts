import type {IncomingMessage,ServerResponse} from 'node:http';
import type {DeviceRecord} from './network-auth.js';
import type {RemoteJobs} from './remote-jobs.js';
import {RemoteJobError} from './remote-jobs.js';
import type {RemoteInventory,RemoteJobEvent,RemoteFinish} from '../shared/remote-jobs.js';
import {HttpError,only,stringValue} from './security.js';

function body(bytes:Buffer):Record<string,unknown>{if(bytes.length>8*1024*1024)throw new HttpError(413,'Worker request is too large');try{const result=JSON.parse(bytes.toString('utf8'));if(!result||typeof result!=='object'||Array.isArray(result))throw Error();return result;}catch{throw new HttpError(400,'Expected a worker JSON object');}}
const send=(res:ServerResponse,value:unknown)=>{res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
/** Only the HTTPS listener calls this after authenticating the exact signed worker bytes. */
export async function networkWorkerApi(device:DeviceRecord,req:IncomingMessage,res:ServerResponse,url:URL,raw:Buffer,jobs:RemoteJobs,assertAvailable:()=>void):Promise<void>{
 if(device.role!=='worker'||device.revokedAt!==null)throw new HttpError(403,'Worker access is required');assertAvailable();const method=req.method??'GET',path=url.pathname.slice('/api/network/worker'.length);
 try{
  if(path==='/heartbeat'&&method==='POST'){const input=body(raw);only(input,['protocolVersion','name','platform','providers','workspaces','defaultAgent']);send(res,jobs.heartbeat(device.id,input as unknown as RemoteInventory));return;}
  if(path==='/poll'&&method==='GET'){if([...url.searchParams.keys()].some(key=>key!=='instance')||url.searchParams.getAll('instance').length!==1)throw new HttpError(400,'Supply one worker instance');send(res,await jobs.poll(device.id,stringValue(url.searchParams.get('instance'),'Worker instance',128,1)));return;}
  const action=/^\/jobs\/([a-zA-Z0-9_.:-]{1,128})\/(ack|started|events|finish)$/.exec(path);if(!action||method!=='POST')throw new HttpError(404,'Worker endpoint not found');const input=body(raw),leaseId=stringValue(input.leaseId,'Lease ID',128,1),instance=stringValue(input.instanceId,'Worker instance',128,1);
  if(action[2]==='ack'||action[2]==='started'){only(input,['leaseId','instanceId']);send(res,action[2]==='ack'?jobs.ack(device.id,action[1],leaseId,instance):jobs.started(device.id,action[1],leaseId,instance));return;}
  if(action[2]==='events'){only(input,['leaseId','instanceId','event']);send(res,jobs.event(device.id,action[1],leaseId,instance,input.event as RemoteJobEvent));return;}
  only(input,['leaseId','instanceId','receipt']);send(res,await jobs.finish(device.id,action[1],leaseId,instance,input.receipt as RemoteFinish));
 }catch(error){if(error instanceof RemoteJobError)throw new HttpError(error.status,error.message);throw error;}
}

/** Browser-facing metadata/actions remain behind the ordinary controller session/CSRF guard. */
export async function networkComputerApi(req:IncomingMessage,res:ServerResponse,url:URL,jobs:RemoteJobs):Promise<boolean>{
 if(url.pathname==='/api/network/computers'&&req.method==='GET'){send(res,{computers:jobs.computers().map(c=>({id:c.id,name:c.name,platform:c.platform,online:c.online,ready:!!c.defaultAgent?.ready,modelCount:c.providers.reduce((n,p)=>n+p.models.length,0)}))});return true;}
 const models=/^\/api\/network\/computers\/([a-f0-9-]{36})\/models$/.exec(url.pathname);if(models&&req.method==='GET'){const c=jobs.computers().find(c=>c.id===models[1]);if(!c)throw new HttpError(404,'Computer not found');send(res,{providers:c.providers});return true;}return false;
}
