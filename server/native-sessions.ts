import {attachmentReader} from './attachments.js';
import {isDeepStrictEqual} from 'node:util';
import { contextHash } from './context-pack.js';
import type { Store } from './store.js';
import type { ProviderRequest } from '../shared/types.js';
export interface NativeSessionRecord {id:string;binding:string;state:'dirty'|'committed';runId:string;sessionId?:string;accountKey?:string;cursor?:string;attachmentPrefix?:string;deliveredReferences?:string[];deliveredManifestHash?:string;}
/** Host metadata never comes from message prose. Exact bytes, aliases and excerpt bounds all participate. */
function referenceSignature(message:ProviderRequest['history'][number]):string|undefined{
 const ref=message.contextReference;
 if(!ref||message.messageId||message.role!=='user'||message.attachments?.length||ref.hash!==contextHash(message.content)||!Number.isSafeInteger(ref.start)||!Number.isSafeInteger(ref.end)||ref.start<0||ref.end<ref.start)return;
 return contextHash([ref,message.content]);
}
const deliveredManifest=(history:ProviderRequest['history'])=>[...new Set(history.map(referenceSignature).filter((value):value is string=>!!value))].sort();
/** Dirty is durable before entering an adapter; only the final host transaction commits it. */
export class NativeSessions {
 constructor(private store:Store){}
 private prefix(conversationId:string,cursor:string|undefined){const rows=this.store.messages(conversationId);const index=rows.findIndex(m=>m.id===cursor);return contextHash(index<0?[]:rows.slice(0,index+1).filter(m=>m.attachments?.length).map(m=>({messageId:m.id,attachments:m.attachments})));}
 begin(request:ProviderRequest,agentId:string,references:string,previousMessageId?:string,delta?:ProviderRequest['history']):NonNullable<ProviderRequest['continuity']> {
  const id=contextHash([agentId,request.conversationId]),binding=contextHash({agentId,conversationId:request.conversationId,provider:'cursor',model:request.model,account:request.expectedAccount,...(request.accountId&&request.accountId!=='default-cursor'?{accountId:request.accountId,connectionScope:request.expectedConnectionScope??null}:{}),mode:request.mode??'chat',workspace:request.workspace??'',instructions:request.instructions,references,tools:request.appTools?.definitions??[],policy:'relay-cursor-v1'});
  const old=this.store.get<NativeSessionRecord>('native-session',id);
  const match=old?.state==='committed'&&old.binding===binding&&!!previousMessageId&&old.cursor===previousMessageId&&old.attachmentPrefix===this.prefix(request.conversationId,previousMessageId);
  if(match){const rows=this.store.messages(request.conversationId),index=rows.findIndex(m=>m.id===previousMessageId);for(const m of rows.slice(0,index+1))for(const a of m.attachments??[]){const found=attachmentReader(this.store).read({agentId,conversationId:request.conversationId},a.id,m.id);if(!isDeepStrictEqual(found.attachment,a))throw new Error('Committed attachment manifest changed before native resume');if(a.extraction)attachmentReader(this.store).readText({agentId,conversationId:request.conversationId},a.id,m.id,0,1);}}
  const committed=match&&old.deliveredReferences&&old.deliveredManifestHash===contextHash(old.deliveredReferences)?new Set(old.deliveredReferences):new Set<string>();
  let referenceMessages=0,avoidedCharacters=0;
  const selected=(delta??[request.history.at(-1)!]).filter(message=>{const signature=referenceSignature(message);if(!signature||!committed.has(signature))return true;referenceMessages++;avoidedCharacters+=message.content.length;return false;});
  this.store.put<NativeSessionRecord>('native-session',{id,binding,state:'dirty',runId:request.runId});
  return {agentId,binding,references,...(match?{sessionId:old.sessionId,accountKey:old.accountKey}:{}),delta:selected,localReuse:{referenceMessages,avoidedCharacters}};
 }
 commit(request:ProviderRequest,sessionId:string,accountKey:string,cursor:string){
  const id=contextHash([request.continuity!.agentId,request.conversationId]),old=this.store.get<NativeSessionRecord>('native-session',id);
  if(old?.state!=='dirty'||old.runId!==request.runId||old.binding!==request.continuity?.binding)throw new Error('Native session authority changed before commit');
  // Current full history is retained for a missing-checkpoint reconstruction. Its
  // manifest is valid whether the adapter resumed or reconstructed before send.
  // Do not carry a union from an old vendor session into a fresh fallback session.
  const deliveredReferences=deliveredManifest(request.history);
  this.store.put('native-session',{...old,state:'committed',sessionId,accountKey,cursor,attachmentPrefix:this.prefix(request.conversationId,cursor),deliveredReferences,deliveredManifestHash:contextHash(deliveredReferences)});
 }
}
