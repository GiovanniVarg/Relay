import type {IncomingMessage,ServerResponse} from 'node:http';
import type {AttachmentScope,AttachmentUpload,OwnedAttachment} from '../shared/attachments.js';
import type {Conversation} from '../shared/types.js';
import {Attachments,AttachmentError} from './attachments.js';
import {HttpError,jsonBody,only} from './security.js';
/** Called only after host session/Origin/CSRF/update gates. Scope comes solely from a validated route. */
export async function attachmentApi(req:IncomingMessage,res:ServerResponse,url:URL,files:Attachments,segments:string[],send:(res:ServerResponse,status:number,value:unknown)=>void):Promise<boolean>{
 let scope:AttachmentScope,at:number;
 if(segments[1]==='conversations'&&segments[3]==='attachments'){
  const conversation=files.store.get<Conversation>('conversation',segments[2]);if(!conversation)throw new AttachmentError('scope','Attachment conversation not found');scope={agentId:conversation.agentId,conversationId:conversation.id};at=4;
 }else if(segments[1]==='groups'&&segments[3]==='attachments'){scope={surface:'group',roomId:segments[2]};at=4;}
 else if(segments[1]==='dispatcher'&&segments[2]==='drafts'&&segments[4]==='attachments'){scope={surface:'dispatcher',draftId:segments[3]};at=5;}
 else return false;
 const method=req.method??'GET',key=segments[at];
 if(segments.length===at&&method==='GET'){send(res,200,files.listDrafts(scope));return true;}
 if(segments.length===at&&method==='POST'){const body=await jsonBody(req,6*1024*1024);only(body,['name','mimeType','base64']);send(res,201,await files.createDraft({...body,...scope} as AttachmentUpload));return true;}
 if(key){
  const record=files.store.get<OwnedAttachment>('attachment',key),messageId=record?.messageId??undefined;
  if(url.searchParams.has('messageId')&&url.searchParams.get('messageId')!==messageId)throw new AttachmentError('scope','Attachment message ownership does not match');
  if(segments.length===at+1&&method==='DELETE'){files.deleteDraft(scope,key);send(res,200,{removed:true});return true;}
  if(segments.length===at+2&&segments[at+1]==='text'&&method==='GET'){send(res,200,files.readText(scope,key,messageId,Number(url.searchParams.get('offset')??0),Number(url.searchParams.get('limit')??12000)));return true;}
  if(segments.length===at+1&&method==='GET'){const descriptor=files.descriptor(scope,key,messageId),found=files.read(scope,key,messageId);res.writeHead(200,{'Content-Type':descriptor.contentType,...descriptor.headers});res.end(found.bytes);return true;}
 }
 throw new HttpError(404,'Attachment endpoint not found');
}
