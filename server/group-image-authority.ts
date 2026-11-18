import {isDeepStrictEqual} from 'node:util';
import type {Agent,GroupMessage,GroupRoom,GroupRun,ProviderRequest} from '../shared/types.js';
import type {Store} from './store.js';
import type {Attachments} from './attachments.js';
import {requestImages} from './attachment-context.js';
import {HttpError} from './security.js';
export interface GroupImageAuthority {roomId:string;parentGroupRunId:string;participantAgentId:string;isActive:()=>boolean;purpose?:'delegated-lead'|'delegated-worker';}
const bindings=new WeakMap<ProviderRequest,Readonly<GroupImageAuthority>>();
/** Host-only identity. Request JSON and usage-purpose strings cannot create a binding. */
export function bindGroupImageAuthority(request:ProviderRequest,authority:GroupImageAuthority):ProviderRequest {if(bindings.has(request))throw new Error('Group image request is already bound');bindings.set(request,Object.freeze({...authority}));return request;}
export function groupImageAuthority(request:ProviderRequest):Readonly<GroupImageAuthority>|undefined{return bindings.get(request);}
/** Shared source check for host-branded Chat calls and host-only native dispatch guards. */
export function assertGroupImageSources(store:Store,files:Attachments,request:ProviderRequest,authority:Readonly<GroupImageAuthority>):void {
 const room=store.get<GroupRoom>('group-room',authority.roomId),parent=store.get<GroupRun>('group-run',authority.parentGroupRunId);
 if(!authority.isActive()||!room||!parent||parent.roomId!==room.id||!['running','routing'].includes(parent.status)||!room.agentIds.includes(authority.participantAgentId)||!store.get<Agent>('agent',authority.participantAgentId))throw new HttpError(409,'Group image authority is no longer active or membership changed');
 if(authority.purpose==='delegated-worker'){
  const worker=parent.delegations?.find(record=>record.id===request.runId&&record.workerId===authority.participantAgentId&&record.parentRunId===parent.id);
  if(parent.mode!=='delegated'||room.mode!=='delegated'||request.execution?.surface!=='herdr'||!worker||!['running','attention'].includes(worker.status)||request.mode!==worker.mode||request.workspace!==(worker.workspace||undefined)||request.conversationId!=='delegation-worker-'+worker.id)throw new HttpError(409,'Delegated worker image authority is no longer active');
 }else{
  if(request.usagePurpose==='routing-classifier'||request.usagePurpose==='outcome-reconciliation'||request.execution?.surface!=='group'||request.execution?.mode!=='chat'||(request.mode!==undefined&&request.mode!=='chat')||request.execution?.workspace||request.workspace||request.appTools||request.interact||request.continuity)throw new HttpError(409,'Group image authority requires tool-free Chat');
  if(authority.purpose==='delegated-lead'){
   if(parent.mode!=='delegated'||room.mode!=='delegated'||(room.moderatorAgentId??room.agentIds[0])!==authority.participantAgentId||parent.moderatorAgentId!==authority.participantAgentId||request.runId!==parent.id||!['delegation-plan-'+parent.id,'delegation-synthesis-'+parent.id].includes(request.conversationId))throw new HttpError(409,'Delegated lead image authority requires the current moderator planning or synthesis call');
  }else if(parent.mode==='delegated')throw new HttpError(409,'Group image authority does not grant delegated lead access');
 }
 requestImages(request);
 for(const image of request.imageTable??[]){
  const original=store.get<GroupMessage>('group-message',image.messageId),source=files.read({surface:'group',roomId:room.id},image.attachmentId,image.messageId);
  if(!original||original.role!=='user'||original.status!=='complete'||original.roomId!==room.id||!original.attachments?.some(a=>isDeepStrictEqual(a,source.attachment))||!request.history.some(m=>m.role==='user'&&m.messageId===image.messageId&&m.imageRefs?.includes(image.attachmentId))||source.attachment.kind!=='image'||source.attachment.sha256!==image.sha256||source.attachment.mimeType!==image.mimeType||source.attachment.width!==image.width||source.attachment.height!==image.height||!source.bytes.equals(Buffer.from(image.data,'base64')))throw new HttpError(409,'Group image source, original message or wire bytes changed before dispatch');
 }
}
