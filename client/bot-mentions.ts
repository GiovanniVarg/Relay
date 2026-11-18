import type {Agent} from '../shared/types';
import type {RegisteredComputer} from './background-assignments';
/** Computers share picker resolution with bots, so display-name collisions use stable IDs. */
export function mergeMentionTargets(agents:Agent[],computers:RegisteredComputer[]=[]):Agent[]{
 return [...agents,...computers.map(computer=>({id:'computer/'+computer.id,name:computer.name,role:'Computer · '+(computer.online?(computer.ready?'Ready':'Not ready'):'Offline'),initials:computer.name.split(/\s+/).map(word=>word[0]??'').join('').slice(0,2)||'PC',color:'#657e70',instructions:'',memory:'',routeMode:'auto' as const,model:'',mode:'chat' as const,workspace:'',pinned:false,unread:false,lastMessage:'',createdAt:'',updatedAt:''}))];
}
export interface MentionTrigger {start:number;end:number;query:string;}
export function getMentionTrigger(value:string,start:number|null,end:number|null):MentionTrigger|null{
 if(start==null||start<0||start>value.length||end!==start)return null;
 const at=value.lastIndexOf('@',start-1);
 if(at<0||at>=start||(at>0&&!/\s/.test(value[at-1])))return null;
 const query=value.slice(at+1,start);
 return query.length>80||/[@:\r\n]/.test(query)?null:{start:at,end:start,query};
}
export function filterMentionAgents(agents:Agent[],query:string):Agent[]{
 const needle=query.trim().toLowerCase();return agents.filter(a=>`${a.name}\n${a.role??''}`.toLowerCase().includes(needle));
}
/** Exact stable IDs take precedence; display names must resolve uniquely. */
export function resolveMentionAgent<T extends {id:string;name:string}>(agents:T[],token:string):T|null{
 const exact=agents.find(a=>a.id===token);if(exact)return exact;
 const matches=agents.filter(a=>a.name.toLowerCase()===token.toLowerCase());return matches.length===1?matches[0]:null;
}
export function mentionToken(agent:Agent,agents:Agent[],suffix=': '):string{
 const usable=!/[@:\r\n]/.test(agent.name)&&agent.name===agent.name.trim()&&resolveMentionAgent(agents,agent.name)?.id===agent.id;
 return '@'+(usable?agent.name:agent.id)+suffix;
}
export function insertBotMention(value:string,trigger:MentionTrigger,agent:Agent,agents:Agent[],maxLength?:number,suffix=': '):{value:string;caret:number}|null{
 let end=trigger.end;
 // Complete a name when the caret is inside an existing multi-word mention.
 const typed=value.slice(trigger.start+1,end),name=agent.name;
 if(name.toLowerCase().startsWith(typed.toLowerCase())){
  let i=typed.length;while(i<name.length&&value[end]?.toLowerCase()===name[i].toLowerCase()){end++;i++;}
 }
 while(end<value.length&&!/[\s:@]/.test(value[end]))end++;
 if(value[end]===':'){end++;while(value[end]===' '||value[end]==='\t')end++;}
 else if(suffix.endsWith(' ')&&value[end]===' ')end++;
 const token=mentionToken(agent,agents,suffix),next=value.slice(0,trigger.start)+token+value.slice(end);
 return maxLength!=null&&maxLength>=0&&next.length>maxLength?null:{value:next,caret:trigger.start+token.length};
}