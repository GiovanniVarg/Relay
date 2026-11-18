import type {IncomingMessage,ServerResponse} from 'node:http';
import type {HarnessChanges} from './harness-changes.js';
import type {HarnessUpdates} from './harness-updates.js';
import {HttpError,jsonBody,only,stringValue} from './security.js';

export interface HarnessServices {changes:HarnessChanges;updates:HarnessUpdates;initialize:()=>Promise<void>;installDirectory:string;dataDirectory:string;}
const send=(res:ServerResponse,status:number,data:unknown)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
/** Only called behind the ordinary local session and CSRF boundary. Agent activation uses the same trusted updater after its requesting turn completes. */
export async function harnessApi(req:IncomingMessage,res:ServerResponse,url:URL,s:HarnessServices){
 const parts=url.pathname.split('/').filter(Boolean);if(parts[1]!=='harness')return false;
 await s.initialize();const method=req.method??'GET',id=parts[2],action=parts[3];
 if(parts.length===2&&method==='GET'){send(res,200,{installDirectory:s.installDirectory,dataDirectory:s.dataDirectory,changes:await s.changes.list(),activation:await s.updates.status()});return true;}
 if(parts.length===2&&method==='POST'){s.updates.assertAvailable();const body=await jsonBody(req);only(body,['title']);send(res,201,await s.changes.create({title:stringValue(body.title,'Title',160,1)}));return true;}
 if(!id)throw new HttpError(404,'Relay change not found');
 if(parts.length===3&&method==='GET'){send(res,200,await s.changes.get(id));return true;}
 if(parts.length!==4)throw new HttpError(404,'Relay change endpoint not found');
 if(method==='GET'&&action==='files'){send(res,200,await s.changes.files(id));return true;}
 if(method==='GET'&&action==='file'){send(res,200,await s.changes.read(id,stringValue(url.searchParams.get('path'),'Path',1000,1)));return true;}
 if(method==='GET'&&action==='diff'){send(res,200,await s.changes.diff(id));return true;}
 s.updates.assertAvailable();
 if(action==='file'&&method==='PUT'){
  const body=await jsonBody(req);only(body,['path','content','expectedHash']);
  if(body.expectedHash!==null&&typeof body.expectedHash!=='string')throw new HttpError(400,'Expected hash must be a string, or null for a new file');
  send(res,200,await s.changes.write(id,{path:stringValue(body.path,'Path',1000,1),content:stringValue(body.content,'Content',200000),expectedHash:body.expectedHash as string|null}));return true;
 }
 if(action==='file'&&method==='DELETE'){const body=await jsonBody(req);only(body,['path','expectedHash']);send(res,200,await s.changes.remove(id,{path:stringValue(body.path,'Path',1000,1),expectedHash:stringValue(body.expectedHash,'Expected hash',100,1)}));return true;}
 if(method==='POST'){
  const body=await jsonBody(req);
  if(action==='apply'){only(body,['revision']);send(res,202,await s.updates.apply(id,stringValue(body.revision,'Revision',100,1)));return true;}
  if(action==='check'){only(body,['revision']);send(res,200,await s.changes.check(id,{expectedRevision:stringValue(body.revision,'Revision',100,1)}));return true;}
  only(body,[]);
  if(action==='preview'){send(res,200,await s.changes.preview(id));return true;}
  if(action==='revert'){send(res,201,await s.updates.revert(id));return true;}
 }
 throw new HttpError(404,'Relay change endpoint not found');
}
