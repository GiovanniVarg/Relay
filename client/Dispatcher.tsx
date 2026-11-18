import {scopedSessionStorage as sessionStorage} from './controller-scope';
import {resolveMentionAgent} from './bot-mentions';
import {AssignmentActivity} from './AssignmentActivity';
import {clearBossAssignmentSources,parseBackgroundAssignment,readBossAssignmentSources,rememberBossAssignmentSource,submitBackgroundAssignment,type RegisteredComputer} from './background-assignments';
import {MentionTextarea} from './MentionTextarea';
import {useCallback,useEffect,useRef,useState} from 'react';
import {ArrowUp,Menu,Plus,RefreshCw,Square} from 'lucide-react';
import type {Agent,InteractionAnswer,RunInteraction} from '../shared/types';
import type {DispatcherLookup,DispatcherReceipt,DispatcherSubmitResult} from '../shared/dispatcher';
import {RunInteractions,useRunInteractions,isSecureCredentialInteraction} from './Interactions';
import type {SecureCredentialApi} from './useSecureCredentialEntry';
import {VoiceInput} from './voice-input';
import {useDispatcherAttachments} from './useDispatcherAttachments';
import {AttachmentList} from './AttachmentList';
import './Dispatcher.css';
import {IconButton} from './UI';

const storageKey='relay.dispatcher.ids';
type Pointer={submissionId:string;taskId?:string};
type Target={taskId:string;agentId:string;runId:string};
type Waiting={jobId:string;target:Target;interaction:RunInteraction};
const opaque=(value:unknown):value is string=>typeof value==='string'&&/^[\w-]{1,100}$/.test(value);
function readPointers():Pointer[]{try{const data:unknown=JSON.parse(sessionStorage.getItem(storageKey)||'[]');return Array.isArray(data)?data.filter((p):p is Pointer=>!!p&&opaque(p.submissionId)&&(p.taskId===undefined||opaque(p.taskId))).map(p=>({submissionId:p.submissionId,...(p.taskId?{taskId:p.taskId}:{})})):[];}catch{return [];}}
function writePointers(pointers:Pointer[]){try{sessionStorage.setItem(storageKey,JSON.stringify(pointers.map(p=>({submissionId:p.submissionId,...(p.taskId?{taskId:p.taskId}:{})}))));return true;}catch{return false;}}
function targets(receipt:DispatcherReceipt):Target[]{return receipt.interactionTargets??(receipt.runId?[{taskId:receipt.taskId,agentId:receipt.agentId,runId:receipt.runId}]:[]);}
function active(receipt:DispatcherReceipt){return receipt.activeWork??(receipt.recoveryRequired||['queued','scheduled','working','needs_input'].includes(receipt.status)||targets(receipt).length>0);}
const statusLabel=(r:DispatcherReceipt)=>r.recoveryRequired?'Needs attention · recovery required':active(r)&&['failed','cancelled','done'].includes(r.status)?'Team still needs attention':({scheduled:'Scheduled',queued:'Queued',working:'Working',needs_input:'Waiting for your response',done:'Finished',failed:'Needs attention',cancelled:'Stopped'}[r.status]);

/** Only opaque submission/task pointers survive this RAM-only view. */
export function Dispatcher({api,agents,computers=[],onOpenWork,onOpenRoster}:{api:SecureCredentialApi;agents:Agent[];computers?:RegisteredComputer[];onOpenRoster?:()=>void;onOpenWork:(agentId:string,conversationId:string)=>void}){
 const [input,setInput]=useState(''),[jobs,setJobs]=useState<DispatcherReceipt[]>([]),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[generation,setGeneration]=useState(0);
 const [choice,setChoice]=useState<{prompt:string;candidates:Extract<DispatcherSubmitResult,{state:'needs-recipient'}>['candidates']}|null>(null);
 const [backgroundSources,setBackgroundSources]=useState(readBossAssignmentSources);
 const apiRef=useRef(api);apiRef.current=api;
 const transport=useCallback<SecureCredentialApi>((...args)=>apiRef.current(...args),[]);
 const attachments=useDispatcherAttachments(transport,setNotice);
 const pendingDrafts=useRef(new Map<string,{scope:string;version:number;attachmentIds:string[]}>());
 const inputRevision=useRef(0),jobNumbers=useRef(new Map<string,number>()),requestNumbers=useRef(new Map<string,number>());
 const jobLabel=(id:string)=>{if(!jobNumbers.current.has(id))jobNumbers.current.set(id,jobNumbers.current.size+1);return 'Job'+jobNumbers.current.get(id);};
 const requestLabel=(entry:RunInteraction)=>{const key=entry.runId+':'+entry.id;if(!requestNumbers.current.has(key))requestNumbers.current.set(key,requestNumbers.current.size+1);return 'Request'+requestNumbers.current.get(key);};
 const clearDraft=(version:number)=>{if(inputRevision.current===version){inputRevision.current++;setInput('');}};
 const pointers=useRef<Pointer[]>(readPointers()),jobsRef=useRef(jobs),epoch=useRef(0),revision=useRef(0),mounted=useRef(false),visible=useRef(true),locked=useRef(false),refreshing=useRef(false);
 const controllers=useRef(new Set<AbortController>()),waiting=useRef(new Map<string,Waiting[]>()),composer=useRef<HTMLTextAreaElement>(null);
 const current=(owner:number)=>mounted.current&&visible.current&&epoch.current===owner;
 function remember(value:Pointer){const next=pointers.current.filter(p=>p.submissionId!==value.submissionId);next.push(value);pointers.current=next;if(!writePointers(next))setNotice('Browser recovery storage is unavailable. Keep this view open until assignment is confirmed.');}
 function prune(receipts:DispatcherReceipt[]){const ended=new Set(receipts.filter(r=>!active(r)&&!r.recoveryRequired).map(r=>r.taskId));pointers.current=pointers.current.filter(p=>!p.taskId||!ended.has(p.taskId));writePointers(pointers.current);}
 function accept(receipt:DispatcherReceipt){revision.current++;remember({submissionId:receipt.submissionId,taskId:receipt.taskId});prune([receipt]);jobLabel(receipt.taskId);const next=[...jobsRef.current.filter(r=>r.taskId!==receipt.taskId),receipt];jobsRef.current=next;setJobs(next);}
 const register=useCallback((key:string,entries:Waiting[])=>{if(entries.length)waiting.current.set(key,entries);else waiting.current.delete(key);},[]);
 function reset(forget=true){epoch.current++;inputRevision.current++;setBackgroundSources([]);if(forget)clearBossAssignmentSources();if(forget){pointers.current=[];writePointers([]);jobNumbers.current.clear();requestNumbers.current.clear();}visible.current=false;for(const c of controllers.current)c.abort();controllers.current.clear();waiting.current.clear();locked.current=false;refreshing.current=false;setBusy(false);setInput('');setChoice(null);jobsRef.current=[];setJobs([]);setNotice(forget?'View cleared. Assignment IDs forgotten; accepted work continues in its assigned chat.':'Disconnected. Private entries cleared; use recover to check assigned work by ID.');setGeneration(v=>v+1);}
 async function refresh(){
  if(!mounted.current||!visible.current||refreshing.current)return;
  setBackgroundSources(readBossAssignmentSources());
  refreshing.current=true;const owner=epoch.current,version=revision.current,c=new AbortController();controllers.current.add(c);
  try{
   const found:DispatcherReceipt[]=[];
   for(const p of [...pointers.current].filter(p=>!p.taskId)){
    const result=await transport<DispatcherLookup>('/dispatcher/submissions/'+encodeURIComponent(p.submissionId),'GET',undefined,{signal:c.signal});
    if(!current(owner))return;
    if(result.state==='accepted'&&result.receipt){remember({submissionId:p.submissionId,taskId:result.receipt.taskId});found.push(result.receipt);const pending=pendingDrafts.current.get(p.submissionId);if(pending){attachments.accepted(pending.scope,pending.attachmentIds);clearDraft(pending.version);pendingDrafts.current.delete(p.submissionId);setChoice(null);}}
    else setNotice(result.state==='pending'?'Assignment is still being checked. No request has been replayed.':'Assignment is unconfirmed. Refresh to check again; no request has been replayed.');
   }
   const ids=[...new Set(pointers.current.flatMap(p=>p.taskId?[p.taskId]:[]))];
   for(let offset=0;offset<ids.length;offset+=100){const result=await transport<{receipts:DispatcherReceipt[]}>('/dispatcher/jobs?ids='+ids.slice(offset,offset+100).map(encodeURIComponent).join(','),'GET',undefined,{signal:c.signal});found.push(...result.receipts);}
   if(current(owner)&&version===revision.current){const retained=jobsRef.current.filter(r=>!active(r)&&!r.recoveryRequired);const next=[...new Map([...retained,...found].map(r=>[r.taskId,r])).values()];next.forEach(r=>jobLabel(r.taskId));prune(next);jobsRef.current=next;setJobs(next);}
  }catch{if(current(owner))setNotice('Could not refresh assigned work. Check again after Relay reconnects.');}
  finally{controllers.current.delete(c);if(current(owner))refreshing.current=false;}
 }
 useEffect(()=>{
  mounted.current=true;void refresh();const timer=window.setInterval(()=>{if(pointers.current.some(p=>!p.taskId)||jobsRef.current.some(active))void refresh();},2000);
  const events=['pagehide','offline','relay:runtime-disconnected','relay:before-runtime-reload'];const disconnect=()=>reset(false);for(const event of events)window.addEventListener(event,disconnect);
  return()=>{mounted.current=false;epoch.current++;for(const c of controllers.current)c.abort();controllers.current.clear();waiting.current.clear();window.clearInterval(timer);for(const event of events)window.removeEventListener(event,disconnect);};
 },[]);
 async function submit(prompt:string,agentId?:string,clearComposer=true){
  const draftVersion=clearComposer?inputRevision.current:-1,owner=epoch.current,c=new AbortController();controllers.current.add(c);const submissionId=crypto.randomUUID(),draftId=attachments.draftId,attachmentIds=attachments.items.map(item=>item.id);remember({submissionId});pendingDrafts.current.set(submissionId,{scope:draftId,version:draftVersion,attachmentIds});
  try{
   const result=await transport<DispatcherSubmitResult>('/dispatcher/submissions','POST',{submissionId,prompt,draftId,attachmentIds,...(agentId?{agentId}:{})},{signal:c.signal});
   if(!current(owner))return;
   pendingDrafts.current.delete(submissionId);
   if(result.state==='accepted'){accept(result.receipt);attachments.accepted(draftId,attachmentIds);clearDraft(draftVersion);setChoice(null);setNotice('Assigned. Progress and requests appear below; the full conversation stays with the bot.');}
   else {pointers.current=pointers.current.filter(p=>p.submissionId!==submissionId);writePointers(pointers.current);clearDraft(draftVersion);setChoice({prompt,candidates:result.candidates});setNotice(result.candidates.length?'Choose a bot for this request. Your attachments are kept.':'No bot is available. Your attachments are kept; review bot accounts and workspace permissions, then try again.');}
  }catch{if(current(owner)){setNotice('Checking whether the assignment was accepted. Your draft is kept. No request will be replayed.');await refresh();}}
  finally{controllers.current.delete(c);}
 }
 function selectJob(reference:string|undefined,candidates:DispatcherReceipt[]){if(!reference)return candidates.length===1?candidates[0]:undefined;const key=reference.trim().replace(/^@/,'').toLowerCase();const matches=candidates.filter(r=>jobLabel(r.taskId).toLowerCase()===key||r.taskId.toLowerCase()===key||r.agentId.toLowerCase()===key||agents.find(a=>a.id===r.agentId)?.name.toLowerCase()===key);return matches.length===1?matches[0]:undefined;}
 async function cancel(job:DispatcherReceipt){
  const owner=epoch.current,c=new AbortController();controllers.current.add(c);
  try{const result=await transport<DispatcherReceipt>('/dispatcher/jobs/'+encodeURIComponent(job.taskId)+'/cancel','POST',{},{signal:c.signal});if(current(owner)){accept(result);setNotice(result.recoveryRequired||active(result)?'Stop remains unconfirmed. This job needs attention.':'Stop confirmed for this job.');}}
  catch{if(current(owner))setNotice('Stop could not be confirmed. Refresh and review the assigned chat; remaining work may still be active.');}
  finally{controllers.current.delete(c);}
 }
 async function answer(text:string):Promise<boolean>{
  const draftVersion=inputRevision.current;
  const all=[...waiting.current.values()].flat().filter(w=>jobsRef.current.some(r=>r.taskId===w.jobId&&targets(r).some(t=>t.runId===w.target.runId&&t.taskId===w.target.taskId&&t.agentId===w.target.agentId)));
  if(!all.length&&!jobsRef.current.some(active)&&/^@[^:\n]+:\s*\S/.test(text))return false;
  let content=text,selected=all;const colon=text.indexOf(':');
  if(colon>0){
   const prefix=text.slice(0,colon).trim(),ref=prefix.replace(/^@/,'').toLowerCase();
   const label=/^(?:request|job)\d+$/i.test(ref)||prefix.startsWith('@');
   const known=[...jobNumbers.current.keys(),...[...requestNumbers.current.keys()].flatMap(key=>key.split(':')),...agents.flatMap(a=>[a.id,a.name])].some(value=>value.toLowerCase()===ref);
   const explicit=label||known||/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(ref);
   // URL schemes, drive letters and complete question-ID lines are answer content, not target prefixes.
   const questions=all.length===1?all[0].interaction.questions:undefined;
   const formatted=questions&&questions.length>1&&questions.every(q=>text.split('\n').some(line=>line.startsWith(q.id+':')));
   const literal=formatted||!label&&/^(?:[a-z][a-z0-9+.-]*:\/\/|[a-z]:[\\/])/i.test(text);
   if(!literal){
    const matches=all.filter(w=>[requestLabel(w.interaction),jobLabel(w.jobId),w.jobId,w.target.taskId,w.target.runId,w.interaction.id,w.target.agentId,agents.find(a=>a.id===w.target.agentId)?.name].some(value=>value?.toLowerCase()===ref));
    if(matches.length){selected=matches;content=text.slice(colon+1).trim();}
    else if(explicit){setNotice('That request reference is not current. Use the current Request number shown below, or refresh assigned work.');return true;}
   }
  }
  if(!all.length)return false;
  if(selected.length!==1){setNotice('Which job and request are you answering? Begin with the Request number shown below, followed by a colon.');return true;}
  const selectedRequest=selected[0],entry=selectedRequest.interaction;
  if(isSecureCredentialInteraction(entry)){setInput('');setNotice('Use the secure password form for that bot. Credentials cannot be sent as conversational answers.');return true;}
  let response:InteractionAnswer;
  if(entry.kind==='approval'){
   if(!/^(approve|allow|yes|no|deny)$/i.test(content)){setNotice('Reply approve or no to the exact permission request, or open its assigned chat.');return true;}
   response={decision:/^(no|deny)$/i.test(content)?'deny':'allow'};
  }else{
   const qs=entry.questions||[],answers:Record<string,string[]>=Object.create(null);
   for(const q of qs){const value=qs.length===1?content:content.split('\n').find(line=>line.startsWith(q.id+':'))?.slice(q.id.length+1).trim();if(!value){setNotice('Answer each question on its own line: question ID: answer.');return true;}answers[q.id]=q.multiple?value.split('|').map(s=>s.trim()).filter(Boolean):[value];}
   if(!qs.length){setNotice('This request changed. Refresh before answering.');return true;}response={decision:'allow',answers};
  }
  const owner=epoch.current,c=new AbortController();controllers.current.add(c);
  try{
   // Recheck task/run/interaction identity immediately before answering; the endpoint rejects stale answers too.
   const fresh=await transport<{receipts:DispatcherReceipt[]}>('/dispatcher/jobs?ids='+encodeURIComponent(selectedRequest.jobId),'GET',undefined,{signal:c.signal});
   const job=fresh.receipts.find(r=>r.taskId===selectedRequest.jobId);
   if(!current(owner))return true;
   if(!job||!targets(job).some(t=>t.runId===entry.runId&&t.taskId===selectedRequest.target.taskId&&t.agentId===selectedRequest.target.agentId)){setNotice('This job moved to another run. Refresh and answer its current request.');return true;}
   const snapshot=await transport<{interactions:RunInteraction[]}>('/runs/'+encodeURIComponent(entry.runId)+'/interactions','GET',undefined,{signal:c.signal});
   const exact=snapshot.interactions.find(q=>q.id===entry.id&&q.runId===entry.runId&&q.status==='pending');
   if(!current(owner))return true;
   if(!exact||JSON.stringify(exact)!==JSON.stringify(entry)){setNotice('This request changed. Review its current question before answering.');return true;}
   const result=await transport<{interaction:RunInteraction}>('/runs/'+encodeURIComponent(entry.runId)+'/interactions/'+encodeURIComponent(entry.id),'POST',response,{signal:c.signal});
   if(current(owner)){clearDraft(draftVersion);setNotice(result.interaction.status==='pending'?'Answer is unconfirmed. Review the current request.':'Answer accepted by the assigned bot.');window.dispatchEvent(new Event('relay:dispatcher-interaction-refresh'));}
  }catch{if(current(owner))setNotice('Answer could not be confirmed. Review the current request before trying again.');}
  finally{controllers.current.delete(c);}
  return true;
 }
 async function send(explicit?:{prompt:string;agentId:string}){
  if(locked.current||attachments.isUploading())return;const text=input.trim();if(!explicit&&!text&&!attachments.items.length)return;
  if(!visible.current){visible.current=true;setNotice('');}
  locked.current=true;setBusy(true);const owner=epoch.current,draftVersion=inputRevision.current;
  try{
   if(explicit){await submit(explicit.prompt,explicit.agentId,false);return;}
   if(/^(reset|clear(?: view)?)$/i.test(text)){reset();return;}
   if(/^(recover|refresh)$/i.test(text)){clearDraft(draftVersion);await refresh();return;}
   if(/^(discard|discard pending)$/i.test(text)){setChoice(null);clearDraft(draftVersion);setNotice('Pending request discarded.');return;}
   let assignmentRequested=false;
   try{assignmentRequested=parseBackgroundAssignment(input,agents,computers).tokens.length>0;}catch(failure){setNotice((failure as Error).message);return;}
   if(assignmentRequested){
    const source={kind:'boss' as const,id:attachments.draftId},ids=attachments.items.map(item=>item.id);
    setBackgroundSources(rememberBossAssignmentSource(source.id));
    try{
     const result=await submitBackgroundAssignment(transport,{source,content:input,attachmentIds:ids});
     attachments.accepted(source.id,ids);
     if(!current(owner))return;
     clearDraft(draftVersion);setChoice(null);setNotice(result.recoveryWarning||'Assigned. Background progress, questions, and results appear below. Each mentioned bot receives the same instruction.');
    }catch(failure){if(current(owner))setNotice((failure as Error).message);}
    return;
   }
   if(choice){const match=text.match(/^(?:assign\s+)?@?([^:\n]+)$/i),recipient=match?resolveMentionAgent(choice.candidates.map(a=>({...a,id:a.agentId})),match[1]):null;if(!recipient){setNotice('Which bot? Reply assign @Bot name using one of the available recipients, or discard.');return;}const pending=choice;await submit(pending.prompt,recipient.agentId);return;}
   const command=text.match(/^(stop|cancel|open)(?:\s+(.+?))?[.!]?$/i);
   if(command){const action=command[1].toLowerCase(),job=selectJob(command[2],jobsRef.current.filter(r=>action==='open'||active(r)));if(!job){setNotice('Which job? Use its exact job ID, for example Job1, or a bot name that has only one matching job.');return;}if(action==='open'){if(job.conversationId)onOpenWork(job.agentId,job.conversationId);else setNotice('The assigned chat is not available yet. Refresh shortly.');}else await cancel(job);if(current(owner))clearDraft(draftVersion);return;}
   const newJob=text.match(/^new:\s*([\s\S]*)$/i);
   if(!newJob&&await answer(text))return;
   if(!newJob&&jobsRef.current.some(active)){setNotice('Open the assigned chat to discuss changes. Free-form mid-run guidance is not delivered here. Start another job with new: followed by your request.');return;}
   const prompt=newJob?newJob[1]:text;
   await submit(prompt);
  }finally{if(current(owner)){locked.current=false;setBusy(false);}}
 }
 return <main className="conversation-pane dispatcher" aria-label="Boss Chat" data-attachment-input="boss-chat-attachments">
  <header className="chat-header"><div className="chat-heading">{onOpenRoster&&<IconButton label="Open agent roster" className="mobile-menu" onClick={onOpenRoster}><Menu size={19}/></IconButton>}<div><strong>Boss Chat</strong><span>Assign work to your bots</span></div></div><div className="header-actions"><button type="button" className="secondary small" onClick={()=>{visible.current=true;void refresh();}}><RefreshCw size={14}/>Recover jobs</button><button type="button" className="secondary small" onClick={()=>reset()}>Reset Boss Chat view</button></div></header>
  <div className="chat-scroll"><div className="dispatcher-content"><p className="subtle-text">Send a task, or use @Bot name: request. Progress stays here; full conversations stay with the assigned bots. Use stop, cancel job ID, or open job ID. Start another task with new: request.</p>
   {notice&&<p className="dispatcher-notice" role="status">{notice}</p>}
   {choice&&<section className="dispatcher-choice"><h3>Choose a bot</h3>{choice.candidates.map(a=><button className="secondary" key={a.agentId} disabled={busy} onClick={()=>void send({prompt:choice.prompt,agentId:a.agentId})}>Assign to {a.name}</button>)}<button className="secondary" disabled={busy} onClick={()=>{setChoice(null);setNotice('Pending request discarded.');}}>Discard request</button></section>}
   {jobs.map(job=><section className="dispatcher-job" key={job.taskId} aria-label={'Job '+job.taskId}><div className="dispatcher-job-heading"><div><strong><span>{jobLabel(job.taskId)}</span> · {agents.find(a=>a.id===job.agentId)?.name||'Assigned bot'}</strong><details className="dispatcher-reference"><summary>Assignment reference</summary><code>{job.taskId}</code></details></div><span role="status">{statusLabel(job)}</span></div><p className="subtle-text">{job.selectionSource==='jev'?'Selected by Jev':job.selectionSource==='explicit'?'You selected this bot':'Selected locally'}</p><div className="dispatcher-job-actions">{active(job)&&<button type="button" className="secondary small" onClick={()=>void cancel(job)}><Square size={12}/>Stop job</button>}<button type="button" className="secondary small" disabled={!job.conversationId} onClick={()=>job.conversationId&&onOpenWork(job.agentId,job.conversationId)}>Open assigned chat</button></div>
    {targets(job).map(target=><JobInteractions key={generation+':'+job.taskId+':'+target.taskId+':'+target.agentId+':'+target.runId} api={transport} jobId={job.taskId} target={target} name={agents.find(a=>a.id===target.agentId)?.name||'Assigned worker'} register={register} requestLabel={requestLabel} returnFocus={()=>composer.current?.focus({preventScroll:true})}/>)}
   </section>)}
   {backgroundSources.map(id=><AssignmentActivity key={id} source={{kind:'boss',id}} api={transport}/>)}
  </div></div>
  <div className="dispatcher-composer">
   <AttachmentList attachments={attachments.items} basePath={'/api'+attachments.basePath} label="Boss Chat attachments" disabled={busy||attachments.uploading} onRemove={attachments.remove}/>
   {attachments.uploading&&<small role="status">Validating and extracting attachment…</small>}
   <input id="boss-chat-attachments" type="file" aria-label="Boss Chat attachment files" accept=".png,.jpg,.jpeg,.webp,.txt,.pdf,.docx" multiple hidden disabled={busy||attachments.uploading} ref={attachments.input} onChange={event=>void attachments.upload(event.target.files)}/>
   <div className="composer simple-composer"><button type="button" data-attachment-button aria-label="Attach image or document to Boss Chat" disabled={busy||attachments.uploading} onClick={()=>attachments.input.current?.click()}><Plus size={20}/></button><MentionTextarea agents={choice?agents.filter(a=>choice.candidates.some(c=>c.agentId===a.id)):agents} computers={choice?[]:computers} scopeKey={"boss:"+generation+":"+String(!!choice)} mentionSuffix={choice?"":": "} onMentionChange={text=>{inputRevision.current++;setInput(text);}} ref={composer} aria-label="Message Boss Chat" placeholder="Give your bots a task…" rows={2} maxLength={16000} value={input} onChange={event=>{inputRevision.current++;setInput(event.target.value);}} onPaste={event=>{const files=Array.from(event.clipboardData.files);if(files.length){event.preventDefault();if(busy){setNotice('Wait for assignment to finish before attaching files. Your draft is kept.');return;}void attachments.upload(files);}}} onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();void send();}}}/><div className="composer-actions"><VoiceInput scopeKey={'god:'+generation} onTranscript={text=>{inputRevision.current++;setInput(value=>(value+(value?' ':'')+text).slice(0,16000));}}/><button type="button" className="send-button" aria-label="Send to Boss Chat" disabled={busy||attachments.uploading||!input.trim()&&!attachments.items.length} onClick={()=>void send()}><ArrowUp size={20}/></button></div></div><p className="subtle-text">Full requests and attachments move to the assigned bot chat. Only assignment and attachment draft IDs are kept here for recovery.</p></div>
 </main>;
}

function JobInteractions({api,jobId,target,name,register,requestLabel,returnFocus}:{api:SecureCredentialApi;jobId:string;target:Target;name:string;register:(key:string,entries:Waiting[])=>void;requestLabel:(entry:RunInteraction)=>string;returnFocus:()=>void}){
 const state=useRunInteractions(api),stateRef=useRef(state);stateRef.current=state;
 const [unavailable,setUnavailable]=useState(false);
 const key=jobId+':'+target.taskId+':'+target.runId;
 useEffect(()=>{let alive=true,running=false;const poll=async()=>{if(running)return;running=true;try{await stateRef.current.reconcile(target.runId);if(alive)setUnavailable(false);}catch{if(alive)setUnavailable(true);}finally{running=false;}};void poll();const timer=window.setInterval(()=>void poll(),2000);window.addEventListener('relay:dispatcher-interaction-refresh',poll);return()=>{alive=false;window.clearInterval(timer);window.removeEventListener('relay:dispatcher-interaction-refresh',poll);register(key,[]);};},[key]);
 useEffect(()=>{register(key,Object.values(state.entries).filter(i=>i.runId===target.runId&&i.status==='pending').map(interaction=>({jobId,target,interaction})));return()=>register(key,[]);},[state.entries,key,register]);
 return <div className="dispatcher-interactions"><p className="subtle-text">{name} · {target.taskId===jobId?'assigned bot':'delegated worker'}</p>{unavailable&&<p role="status">Current requests are unavailable. Refresh or open the assigned chat.</p>}{Object.values(state.entries).filter(i=>i.runId===target.runId&&i.status==='pending').map(entry=><p key={entry.id} className="subtle-text"><strong>{requestLabel(entry)}</strong> · {isSecureCredentialInteraction(entry)?'Use the secure password form below.':`Reply ${requestLabel(entry)}: your answer.`}</p>)}<RunInteractions runId={target.runId} state={state} returnFocus={returnFocus} autoFocus={false}/></div>;
}
