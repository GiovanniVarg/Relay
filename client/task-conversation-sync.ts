import type {Conversation,Message,Run} from '../shared/types';
import type {Task} from '../shared/tasks';
import {mergeConversationMessages} from './ConversationMessages';

export type ConversationSnapshot={conversation:Conversation;messages:Message[];runs:Run[]};
export const isLiveRun=(run:Run)=>run.status==='running'||run.status==='routing';
export const taskConversationRevision=(tasks:Task[])=>JSON.stringify(tasks.map(task=>[task.id,task.runId,task.runIds,task.status,task.updatedAt,task.waitingForChildren]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));

/** A selected conversation has one refresh in flight. New host revisions queue once;
 * failed reads retry on the next poll, and disposed selections cannot deliver replies. */
export function conversationRefresh<T>(load:()=>Promise<T>,receive:(value:T)=>void,onError:(error:unknown)=>void){
 let closed=false,busy=false,wanted:string|undefined,loaded:string|undefined;
 async function read(){
  if(closed||busy||wanted===loaded)return;
  busy=true;const key=wanted;
  try{const value=await load();if(!closed){receive(value);loaded=key;}}
  catch(error){if(!closed)onError(error);}
  finally{busy=false;if(!closed&&wanted!==key)void read();}
 }
 return {refresh(key:string){wanted=key;void read();},dispose(){closed=true;}};
}

/** HTTP snapshots add real saved rows. A live event received after the fetch began
 * owns that run's current reply/state; terminal records never regress to streaming. */
export function mergeTaskConversation(current:ConversationSnapshot|undefined,incoming:ConversationSnapshot,changedRuns:ReadonlySet<string>):ConversationSnapshot{
 if(!current)return incoming;
 const runs=new Map(current.runs.map(run=>[run.id,run]));
 for(const run of incoming.runs){const old=runs.get(run.id);if(!old||(!changedRuns.has(run.id)&&!(isLiveRun(run)&&!isLiveRun(old))))runs.set(run.id,run);}
 const messages=new Map(current.messages.map(message=>[message.id,message]));
 for(const message of incoming.messages){
  const old=messages.get(message.id);
  if(old&&((message.runId&&changedRuns.has(message.runId))||old.status!=='streaming'||(message.status==='streaming'&&old.content.startsWith(message.content))))continue;
  messages.set(message.id,message);
 }
 return {conversation:incoming.conversation,runs:[...runs.values()].sort((a,b)=>a.startedAt.localeCompare(b.startedAt)),messages:mergeConversationMessages([],[...messages.values()])};
}
