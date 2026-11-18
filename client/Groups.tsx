import {MentionTextarea} from './MentionTextarea';
import {AssignmentActivity} from './AssignmentActivity';
import {hasBackgroundAssignment,parseBackgroundAssignment,registeredComputers,submitBackgroundAssignment} from './background-assignments';
import {connectionReady} from '../shared/provider-policy';
import {RichText} from './RichText';
import {MessageReply} from './MessageReply';
import {clipboardImages,focusReplySource,messageAnchor} from './chat-input';
import {AttachmentList} from './AttachmentList';
import {ATTACHMENT_LIMITS,type MessageAttachment} from '../shared/attachments';
import { isActiveProviderId } from '../shared/types';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowDown, ArrowUp, ArrowUpRight, Check, ChevronRight, Copy, FileText, Info, Lightbulb, LoaderCircle, Menu, MoreHorizontal, PanelRight, Pencil, Plus, Reply, Settings2, ShieldCheck, Square, Users, X } from 'lucide-react';
import type { Agent, Bootstrap, GroupEvent, GroupMessage, GroupRoom, GroupRun, ProviderState, RunInteraction } from '../shared/types';
import { Avatar, IconButton, Modal } from './UI';
import { useRunInteractions, isSecureCredentialInteraction } from './Interactions';
import { useSessionDrafts } from './RuntimeConnection';
import { mergeConversationMessages } from './ConversationMessages';
import { DelegationList, WorkerInteractions, groupEventBelongsToRun, useHerdrStatus } from './Delegations';
import { allowedCatalog, defaultModelLabel, modelIsAvailable, providerName } from './Models';

type API = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type RoomData = { room: GroupRoom; messages: GroupMessage[]; runs: GroupRun[]; interactions?: RunInteraction[] };
const running = (run: GroupRun) => run.status === 'running' || run.status === 'routing';
type ExecutionMode = 'bounded' | 'continuous' | 'smart';
// Match host stop commands; staged files remain drafts rather than becoming stop input.
const groupStopCommand=/^(?:stop|cancel|stop (?:this|the) (?:run|task|response|discussion|workers)|cancel (?:this|the) (?:run|task))[.!]?$/i;
function runProgress(run: GroupRun, moderated: boolean): string {
  const continuous = run.executionMode === 'continuous';
  const replies = continuous || run.totalReplies == null ? `${run.completedReplies} replies` : `${run.completedReplies} of ${moderated ? 'up to ' : ''}${run.totalReplies} replies`;
  const calls = continuous || run.maxModelCalls == null ? `${run.modelCalls} model calls` : `${run.modelCalls}/${run.maxModelCalls} model calls`;
  return `${replies} · ${calls}${moderated ? ` · ${run.moderatorCalls || 0} moderator calls` : ''}`;
}
function ElapsedTime({ run }: { run: GroupRun }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!running(run)) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [run.startedAt, run.endedAt, run.status]);
  const seconds = Math.max(0, Math.floor(((run.endedAt ? new Date(run.endedAt).getTime() : now) - new Date(run.startedAt).getTime()) / 1000));
  const minutes = Math.floor(seconds / 60);
  const formatted = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
  return <time className="discussion-elapsed" aria-label={`Elapsed time ${formatted}`}>{formatted} elapsed</time>;
}
function upsert<T extends { id: string }>(existing: T[], incoming: T[]): T[] {
  const updates = new Map(incoming.map(item => [item.id, item]));
  const known = new Set(existing.map(item => item.id));
  return [...existing.map(item => updates.get(item.id) || item), ...incoming.filter(item => !known.has(item.id))];
}
function agentCanRun(agent: Agent, providers: ProviderState[], worker = false): boolean {
  if (worker && (agent.mode === 'agent' || agent.mode === 'work') && !agent.workspace) return false;
  const ready = providers.filter(provider => connectionReady(provider)&&!provider.nativeAgentOnly&&!(worker&&agent.mode==='agent'&&provider.id==='cursor')&&allowedCatalog(provider).length);
  return agent.routeMode === 'auto'
    ? ready.some(provider => provider.billing.automaticRouting && modelIsAvailable(provider, ''))
    : ready.some(provider => provider.id === agent.routeMode && modelIsAvailable(provider, agent.model));
}

export function CreateDiscussion({ bootstrap, api, reload, close, created, advanced = false }: {
  bootstrap: Bootstrap; api: API; reload: () => Promise<Bootstrap>; close: () => void; created: (id: string) => void; advanced?: boolean;
}) {
  const [title, setTitle] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<'moderated' | 'roundtable' | 'delegated'>('moderated');
  const [moderatorId, setModeratorId] = useState('');
  const selectedModerator = selected.includes(moderatorId) ? moderatorId : selected[0] || '';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function reorder(index: number, direction: number) {
    setSelected(previous => { const next = [...previous]; [next[index], next[index + direction]] = [next[index + direction], next[index]]; return next; });
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (lock.current || selected.length < 2 || selected.length > 5) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const room = await api<GroupRoom>('/groups', 'POST', { ...(title.trim() ? { title: title.trim() } : {}), agentIds: selected, mode, moderatorAgentId: mode === 'roundtable' ? null : selectedModerator });
      await reload();
      if (mounted.current) created(room.id);
    } catch (failure) { setError((failure as Error).message); }
    finally { lock.current = false; setBusy(false); }
  }
  return <Modal title="New group" close={close}><form className="form-stack discussion-create" onSubmit={submit}>
    <p className="form-intro">Choose two to five bots.</p>
    <label>Group name <span className="optional-label">Optional</span><input value={title} maxLength={160} onChange={event => setTitle(event.target.value)} placeholder="Name your group" disabled={busy}/></label>
    <label>How bots work<select value={mode} disabled={busy} onChange={event => setMode(event.target.value as 'moderated' | 'roundtable' | 'delegated')}><option value="moderated">Moderated · an agent guides the discussion</option><option value="roundtable">Roundtable · everyone takes a turn</option><option value="delegated">Lead &amp; workers · assign tasks and combine results</option></select></label>
    <fieldset disabled={busy} className="discussion-agent-choices"><legend>Bots <span>{selected.length}/5</span></legend>{bootstrap.agents.map(agent => {
      const index = selected.indexOf(agent.id);
      return <label className={`discussion-agent-choice ${index >= 0 ? 'selected' : ''}`} key={agent.id}><input type="checkbox" checked={index >= 0} disabled={index < 0 && selected.length === 5} onChange={event => setSelected(previous => event.target.checked ? [...previous, agent.id] : previous.filter(id => id !== agent.id))}/><Avatar agent={agent}/><span><strong>{agent.name}</strong><small>{agent.role}</small></span>{index >= 0 && <span className="discussion-order">{mode === 'roundtable' ? index + 1 : <Check size={10}/>}</span>}</label>;
    })}</fieldset>
    {(mode === 'delegated' || advanced && mode === 'moderated') && <div className="discussion-moderator-setup"><label>{mode === 'delegated' ? 'Lead bot' : 'Moderator'}<select aria-label={mode === 'delegated' ? 'Lead bot' : 'Discussion moderator'} value={selectedModerator} disabled={busy || !selected.length} onChange={event => setModeratorId(event.target.value)}>{!selected.length && <option value="">Choose participants first</option>}{selected.map(id => <option key={id} value={id}>{bootstrap.agents.find(agent => agent.id === id)?.name}</option>)}</select></label><p>{mode === 'delegated' ? 'The lead assigns a task to each other bot and combines their results. Workers keep their own model, instructions, and permissions.' : 'The moderator chooses who speaks next and also participates. Its decisions use its saved model and count toward model calls.'}</p></div>}
    {advanced && selected.length > 1 && mode === 'roundtable' && <div className="discussion-order-list"><span className="section-label">REPLY ORDER</span>{selected.map((id, index) => <div key={id}><span>{index + 1}. {bootstrap.agents.find(agent => agent.id === id)?.name}</span><IconButton label={`Move ${bootstrap.agents.find(agent => agent.id === id)?.name} earlier`} disabled={busy || index === 0} onClick={() => reorder(index, -1)}><ArrowUp size={13}/></IconButton><IconButton label={`Move ${bootstrap.agents.find(agent => agent.id === id)?.name} later`} disabled={busy || index === selected.length - 1} onClick={() => reorder(index, 1)}><ArrowDown size={13}/></IconButton></div>)}</div>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <footer className="modal-footer"><button type="button" className="secondary" onClick={close}>Cancel</button><button className="primary" disabled={busy || selected.length < 2 || selected.length > 5}>{busy ? <LoaderCircle className="spin" size={14}/> : <Users size={14}/>} {busy ? 'Creating…' : 'Create group'}</button></footer>
  </form></Modal>;
}

export function GroupWorkspace({ bootstrap, roomId, api, reload, openRoster, openSettings, profileOpen, toggleProfile, editAgent, advanced, openOptions }: {
  bootstrap: Bootstrap; roomId: string; api: API; reload: () => Promise<Bootstrap>; openRoster: () => void; openSettings: () => void;
  profileOpen: boolean; toggleProfile: () => void; editAgent: (agent: Agent) => void; advanced: boolean; openOptions: () => void;
}) {
  const [replyDrafts,setReplyDrafts]=useSessionDrafts('relay.group-reply-drafts');
  const [rooms, setRooms] = useState<Record<string, RoomData>>({});
  const interactions = useRunInteractions(api);
  const [drafts, setDrafts] = useSessionDrafts('relay.group-drafts');
  const assignmentDraftVersions=useRef(new Map<string,number>());
  const editGroupDraft=(id:string,text:string)=>{assignmentDraftVersions.current.set(id,(assignmentDraftVersions.current.get(id)??0)+1);setDrafts(previous=>({...previous,[id]:text}));};
  const [attachmentDrafts,setAttachmentDrafts]=useState<Record<string,MessageAttachment[]>>({});
  const [uploading,setUploading]=useState<Record<string,boolean>>({});
  const uploadLocks=useRef(new Set<string>()),attachmentVersions=useRef(new Map<string,number>()),attachmentInput=useRef<HTMLInputElement>(null);
  const [roundCounts, setRoundCounts] = useState<Record<string, number>>({});
  const [replyBudgets, setReplyBudgets] = useState<Record<string, number>>({});
  const [executionModes, setExecutionModes] = useState<Record<string, ExecutionMode>>({});
  const [activities, setActivities] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [starting, setStarting] = useState<Record<string, boolean>>({});
  const [stopping, setStopping] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const locks = useRef(new Set<string>());
  const sources = useRef(new Map<string, EventSource>());
  const versions = useRef(new Map<string, number>());
  const cache = useRef(rooms); cache.current = rooms;
  const bottom = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const [copiedId, setCopiedId] = useState('');
  const composer = useRef<HTMLTextAreaElement>(null);
  const room = bootstrap.rooms.find(item => item.id === roomId) || rooms[roomId]?.room;
  const data = rooms[roomId];
  const messages = data?.messages || [];
  const active = data?.runs.find(running);
  const latest = data?.runs.at(-1);
  const executionMode = active ? active.executionMode ?? 'bounded' : executionModes[roomId] ?? (room?.mode === 'moderated' ? 'smart' : 'continuous');
  const delegated = (active?.mode ?? room?.mode) === 'delegated';
  const herdr = useHerdrStatus(api, delegated);
  const continuous = !delegated && executionMode === 'continuous';
  const smart = !delegated && executionMode === 'smart';
  const contextWindowed = (active ?? latest)?.contextWindowed === true;
  const moderated = (active?.mode ?? room?.mode ?? 'roundtable') === 'moderated';
  const moderatorAgentId = active?.moderatorAgentId ?? room?.moderatorAgentId;
  const moderator = bootstrap.agents.find(agent => agent.id === moderatorAgentId);
  const moderatorRoute = (active ?? latest)?.moderatorRoute;
  const speakerReason = (active ?? latest)?.nextSpeakerReason;
  const participants = (room?.agentIds || []).map(id => bootstrap.agents.find(agent => agent.id === id)).filter((agent): agent is Agent => !!agent);
  const unconfigured = participants.filter(agent => !agentCanRun(agent, bootstrap.providers, delegated && agent.id !== moderatorAgentId));
  const rounds = roundCounts[roomId] || 2;
  const maxReplies = replyBudgets[roomId] || 6;
  const draft = drafts[roomId] || '';
  const files=attachmentDrafts[roomId]??[],hasSubmission=!!draft.trim()||files.length>0;
  const stopSubmission=!!active&&groupStopCommand.test(draft.trim());
  useEffect(()=>{let current=true;const rid=roomId,version=attachmentVersions.current.get(rid)??0;void api<MessageAttachment[]>(`/groups/${encodeURIComponent(rid)}/attachments`).then(items=>{if(current&&(attachmentVersions.current.get(rid)??0)===version)setAttachmentDrafts(previous=>({...previous,[rid]:items}));}).catch(error=>{if(current)setErrors(previous=>({...previous,[rid]:(error as Error).message}));});return()=>{current=false;};},[roomId]);
  const replyToId=replyDrafts[roomId]||'';
  const replyTarget=messages.find(message=>message.id===replyToId);
  const clearReply=()=>{setReplyDrafts(previous=>({...previous,[roomId]:''}));composer.current?.focus();};
  const selectReply=(message:GroupMessage)=>{setReplyDrafts(previous=>({...previous,[roomId]:message.id}));composer.current?.focus();};
  const jumpToReply=(id:string)=>{following.current=false;setShowLatest(true);if(!focusReplySource(roomId,id))setErrors(previous=>({...previous,[roomId]:'The original message is no longer available.'}));};
  const replies = moderated ? maxReplies : participants.length * rounds;
  const maxCalls = Math.min(30, replies * bootstrap.settings.maxModelCalls * (moderated ? 2 : 1));
  const hasTopic = messages.some(message => message.content.trim()||message.attachments?.length);
  const pendingInteractions = active ? Object.values(interactions.entries).filter(entry => entry.runId === active.id && entry.status === 'pending').length : 0;
  const secureCredentialPending = !!active && Object.values(interactions.entries).some(entry=>entry.runId===active.id&&entry.status==='pending'&&isSecureCredentialInteraction(entry));
  const assignmentDraft=hasBackgroundAssignment(draft,bootstrap.agents,registeredComputers(bootstrap));
  const canStart = !!data && !loading[roomId] && !active && !starting[roomId] && !uploading[roomId] && !unconfigured.length && (!(moderated || delegated) || !!moderator) && participants.length >= 2 && (delegated ? herdr.status?.available === true && hasSubmission : hasSubmission || hasTopic);

  async function uploadFiles(input:File[]){
    const rid=roomId;if(secureCredentialPending||locks.current.has(rid)||uploadLocks.current.has(rid)||!input.length)return;uploadLocks.current.add(rid);setUploading(previous=>({...previous,[rid]:true}));attachmentVersions.current.set(rid,(attachmentVersions.current.get(rid)??0)+1);setErrors(previous=>({...previous,[rid]:''}));
    try{for(const file of input){if(file.size>ATTACHMENT_LIMITS.bytes)throw new Error('Each attachment must be4MiB or smaller.');const base64=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(new Error('Could not read attachment'));reader.onload=()=>resolve(String(reader.result).split(',')[1]??'');reader.readAsDataURL(file);});const mime=file.type||({txt:'text/plain',pdf:'application/pdf',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp'} as Record<string,string>)[file.name.split('.').at(-1)?.toLowerCase()??''];const item=await api<MessageAttachment>(`/groups/${encodeURIComponent(rid)}/attachments`,'POST',{name:file.name,mimeType:mime,base64});setAttachmentDrafts(previous=>({...previous,[rid]:[...(previous[rid]??[]),item]}));}}
    catch(error){setErrors(previous=>({...previous,[rid]:(error as Error).message}));}finally{uploadLocks.current.delete(rid);setUploading(previous=>({...previous,[rid]:false}));}
  }
  async function removeAttachment(id:string){const rid=roomId;if(locks.current.has(rid)||uploadLocks.current.has(rid))return;uploadLocks.current.add(rid);setUploading(previous=>({...previous,[rid]:true}));try{await api(`/groups/${encodeURIComponent(rid)}/attachments/${encodeURIComponent(id)}`,'DELETE');attachmentVersions.current.set(rid,(attachmentVersions.current.get(rid)??0)+1);setAttachmentDrafts(previous=>({...previous,[rid]:(previous[rid]??[]).filter(item=>item.id!==id)}));}catch(error){setErrors(previous=>({...previous,[rid]:(error as Error).message}));}finally{uploadLocks.current.delete(rid);setUploading(previous=>({...previous,[rid]:false}));}}

  function listen(run: GroupRun) {
    if (sources.current.has(run.id)) return;
    const rid = run.roomId;
    const source = new EventSource(`/api/group-runs/${run.id}/events`);
    sources.current.set(run.id, source);
    source.onmessage = event => {
      let incoming: GroupEvent;
      try { incoming = JSON.parse(event.data); } catch { return; }
      if (!groupEventBelongsToRun(incoming, run)) return;
      versions.current.set(rid, (versions.current.get(rid) || 0) + 1);
      if (incoming.type === 'snapshot') {
        setRooms(previous => { const current = previous[rid]; return current ? { ...previous, [rid]: { ...current, messages: mergeConversationMessages(current.messages, incoming.messages), runs: upsert(current.runs, [incoming.run]) } } : previous; });
        setActivities(previous => ({ ...previous, [rid]: running(incoming.run) ? incoming.run.mode === 'delegated' ? 'The lead is coordinating…' : 'Discussion in progress…' : '' }));
        if (running(incoming.run)) for (const interaction of incoming.interactions || []) if (interaction.runId === run.id && interaction.status === 'pending') interactions.receive(interaction);
        if (!running(incoming.run)) { interactions.finish(run.id); source.close(); sources.current.delete(run.id); }
      } else if (incoming.type === 'run') {
        setRooms(previous => { const current = previous[rid]; return current ? { ...previous, [rid]: { ...current, runs: upsert(current.runs, [incoming.run]) } } : previous; });
      } else if (incoming.type === 'message') {
        setRooms(previous => { const current = previous[rid]; return current ? { ...previous, [rid]: { ...current, messages: mergeConversationMessages(current.messages, [incoming.message]) } } : previous; });
      } else if (incoming.type === 'delta') {
        setRooms(previous => { const current = previous[rid]; return current ? { ...previous, [rid]: { ...current, messages: current.messages.map(message => message.id === incoming.messageId ? { ...message, content: message.content + incoming.text, status: 'streaming' } : message) } } : previous; });
      } else if (incoming.type === 'delegation') {
        setRooms(previous => { const current = previous[rid]; return current ? { ...previous, [rid]: { ...current, runs: current.runs.map(item => item.id === incoming.runId ? { ...item, delegations: upsert(item.delegations || [], [incoming.delegation]) } : item) } } : previous; });
      } else if (incoming.type === 'interaction') interactions.receive(incoming.interaction);
      else if (incoming.type === 'interactionResolved') interactions.resolve(incoming.runId, incoming.interactionId);
      else if (incoming.type === 'status') setActivities(previous => ({ ...previous, [rid]: incoming.message }));
      else if (incoming.type === 'done') {
        source.close(); sources.current.delete(run.id); interactions.finish(run.id);
        setRooms(previous => { const current = previous[rid]; return current ? { ...previous, [rid]: { ...current, runs: upsert(current.runs, [incoming.run]) } } : previous; });
        setActivities(previous => ({ ...previous, [rid]: '' }));
        void reload().catch(failure => setErrors(previous => ({ ...previous, [rid]: failure.message })));
      }
    };
    source.onopen = () => { if (run.mode === 'delegated') void interactions.reconcile(run.id).catch(failure => setErrors(previous => ({ ...previous, [rid]: failure.message }))); };
    source.onerror = () => setActivities(previous => ({ ...previous, [rid]: 'Connection interrupted. Reconnecting…' }));
  }
  useEffect(() => () => { sources.current.forEach(source => source.close()); sources.current.clear(); }, []);
  useEffect(() => {
    if (!roomId) return;
    const rid = roomId;
    const cached = cache.current[rid];
    if (cached?.runs.some(run => running(run) && sources.current.has(run.id))) return;
    let cancelled = false;
    const version = versions.current.get(rid) || 0;
    setLoading(previous => ({ ...previous, [rid]: true }));
    void api<RoomData>(`/groups/${rid}`).then(result => {
      if (cancelled || (versions.current.get(rid) || 0) !== version) return;
      setRooms(previous => ({ ...previous, [rid]: result }));
      for (const interaction of result.interactions || []) if (result.runs.some(run => run.id === interaction.runId && running(run))) interactions.receive(interaction);
      result.runs.filter(running).forEach(listen);
    }).catch(failure => { if (!cancelled) setErrors(previous => ({ ...previous, [rid]: failure.message })); })
      .finally(() => { if (!cancelled) setLoading(previous => ({ ...previous, [rid]: false })); });
    return () => { cancelled = true; };
  }, [roomId]);
  useEffect(() => { following.current = true; setShowLatest(false); setCopiedId(''); }, [roomId]);
  useEffect(() => {
    if (!roomId || !scroll.current) return;
    if (following.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    else setShowLatest(true);
  }, [roomId, messages.at(-1)?.content, messages.length, active?.completedReplies, active?.delegations?.map(record => record.status).join(','), pendingInteractions]);
  useEffect(() => {
    if (!copiedId) return;
    const timer = window.setTimeout(() => setCopiedId(''), 2000);
    return () => window.clearTimeout(timer);
  }, [copiedId]);
  function handleScroll() {
    const element = scroll.current;
    if (!element) return;
    following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    setShowLatest(!following.current);
  }
  function jumpToLatest() {
    following.current = true;
    setShowLatest(false);
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }
  async function copyReply(message: GroupMessage) {
    try { await navigator.clipboard.writeText(message.content); setCopiedId(message.id); }
    catch { setErrors(previous => ({ ...previous, [message.roomId]: 'Could not copy this reply. Select the text and copy it directly.' })); }
  }

  async function start() {
    const rid = roomId, submitted = draft, submittedReply=replyToId,submittedAttachments=stopSubmission?[]:files.map(file=>file.id);
    if(uploadLocks.current.has(rid)&&!stopSubmission)return;
    if(secureCredentialPending)return;
    let assignmentRequested=false;
    try{assignmentRequested=parseBackgroundAssignment(submitted,bootstrap.agents,registeredComputers(bootstrap)).tokens.length>0;}catch(failure){setErrors(previous=>({...previous,[rid]:(failure as Error).message}));return;}
    if(assignmentRequested){
      if(!data||loading[rid]||locks.current.has(rid))return;
      const submittedVersion=assignmentDraftVersions.current.get(rid)??0;
      locks.current.add(rid);setStarting(previous=>({...previous,[rid]:true}));setErrors(previous=>({...previous,[rid]:''}));
      try{
        const result=await submitBackgroundAssignment<GroupMessage>(api,{source:{kind:'group',id:rid},content:submitted,...(submittedReply?{replyToId:submittedReply}:{}),attachmentIds:submittedAttachments});
        versions.current.set(rid,(versions.current.get(rid)??0)+1);
        if(result.message)setRooms(previous=>{const current=previous[rid];return current?{...previous,[rid]:{...current,messages:mergeConversationMessages(current.messages,[result.message!])}}:previous;});
        setDrafts(previous=>previous[rid]===submitted&&(assignmentDraftVersions.current.get(rid)??0)===submittedVersion?{...previous,[rid]:''}:previous);
        setReplyDrafts(previous=>previous[rid]===submittedReply&&(assignmentDraftVersions.current.get(rid)??0)===submittedVersion?{...previous,[rid]:''}:previous);
        setAttachmentDrafts(previous=>({...previous,[rid]:(previous[rid]??[]).filter(file=>!submittedAttachments.includes(file.id))}));attachmentVersions.current.set(rid,(attachmentVersions.current.get(rid)??0)+1);
        if(result.recoveryWarning)setErrors(previous=>({...previous,[rid]:result.recoveryWarning!}));
      }catch(failure){setErrors(previous=>({...previous,[rid]:(failure as Error).message}));}
      finally{locks.current.delete(rid);setStarting(previous=>({...previous,[rid]:false}));}
      return;
    }
    if (active) {
      if (secureCredentialPending) return;
      if ((!submitted.trim()&&!submittedAttachments.length) || locks.current.has(rid)) return;
      locks.current.add(rid); setStarting(previous => ({ ...previous, [rid]: true })); setErrors(previous => ({ ...previous, [rid]: '' }));
      try {
        const pending = Object.values(interactions.entries).filter(entry => entry.runId === active.id && entry.status === 'pending');
        const result = await api<{ message: GroupMessage; questionMessage?: GroupMessage; questionMessages?: GroupMessage[]; interaction?: { id: string } }>(`/runs/${active.id}/message`, 'POST', { content: submitted.trim(),...(submittedAttachments.length?{attachmentIds:submittedAttachments}:{}), ...(submittedReply?{replyToId:submittedReply}:{}), ...(pending.length === 1 ? { interactionId: pending[0].id } : {}) });
        if (result.interaction) interactions.resolve(active.id, result.interaction.id);
        setRooms(previous => { const current = previous[rid]; return current ? { ...previous, [rid]: { ...current, messages: mergeConversationMessages(current.messages, [...(result.questionMessages ?? []), ...(result.questionMessage ? [result.questionMessage] : []), result.message]) } } : previous; });
        setDrafts(previous => previous[rid] === submitted ? { ...previous, [rid]: '' } : previous);
        setAttachmentDrafts(previous=>({...previous,[rid]:(previous[rid]??[]).filter(file=>!submittedAttachments.includes(file.id))}));attachmentVersions.current.set(rid,(attachmentVersions.current.get(rid)??0)+1);
        setReplyDrafts(previous=>previous[rid]===submittedReply?{...previous,[rid]:''}:previous);
      } catch (failure) { setErrors(previous => ({ ...previous, [rid]: (failure as Error).message })); }
      finally { locks.current.delete(rid); setStarting(previous => ({ ...previous, [rid]: false })); }
      return;
    }
    if (!canStart || locks.current.has(rid)) return;
    versions.current.set(rid, (versions.current.get(rid) || 0) + 1);
    locks.current.add(rid); setStarting(previous => ({ ...previous, [rid]: true })); setErrors(previous => ({ ...previous, [rid]: '' }));
    try {
      const result = await api<{ run: GroupRun; message: GroupMessage | null }>(`/groups/${rid}/runs`, 'POST', delegated ? { content: submitted.trim(),attachmentIds:submittedAttachments, ...(submittedReply?{replyToId:submittedReply}:{}) } : {attachmentIds:submittedAttachments, ...(submittedReply?{replyToId:submittedReply}:{}), ...(submitted.trim()||submittedAttachments.length ? { content: submitted.trim() } : {}), executionMode, ...(!continuous ? moderated ? { maxReplies } : { rounds } : {}) });
      setRooms(previous => { const current = previous[rid]; return current ? { ...previous, [rid]: { ...current, runs: upsert(current.runs, [result.run]), messages: result.message ? upsert(current.messages, [result.message]) : current.messages } } : previous; });
      setDrafts(previous => previous[rid] === submitted ? { ...previous, [rid]: '' } : previous);
      setAttachmentDrafts(previous=>({...previous,[rid]:(previous[rid]??[]).filter(file=>!submittedAttachments.includes(file.id))}));attachmentVersions.current.set(rid,(attachmentVersions.current.get(rid)??0)+1);
        setReplyDrafts(previous=>previous[rid]===submittedReply?{...previous,[rid]:''}:previous);
      listen(result.run);
      await reload();
    } catch (failure) { setErrors(previous => ({ ...previous, [rid]: (failure as Error).message })); }
    finally { locks.current.delete(rid); setStarting(previous => ({ ...previous, [rid]: false })); }
  }
  async function stop() {
    if (!active || stopping[active.id]) return;
    const run = active;
    setStopping(previous => ({ ...previous, [run.id]: true }));
    try { await api(`/group-runs/${run.id}/cancel`, 'POST', {}); }
    catch (failure) { setErrors(previous => ({ ...previous, [run.roomId]: (failure as Error).message })); }
    finally { setStopping(previous => ({ ...previous, [run.id]: false })); }
  }

  async function reconcileWorker(delegationId: string) {
    const rid = roomId;
    const result = await api<{ stopped: boolean; error?: string }>('/herdr/reconcile', 'POST', { delegationId });
    if (result.stopped) {
      const version = versions.current.get(rid) || 0;
      const fresh = await api<RoomData>(`/groups/${rid}`);
      if ((versions.current.get(rid) || 0) === version) setRooms(previous => ({ ...previous, [rid]: fresh }));
    }
    return result;
  }

  if (!roomId || !room) return null;
  const currentSpeaker = participants.find(agent => agent.id === active?.currentAgentId);
  const activityLabel = delegated ? activities[roomId] || (active?.phase === 'planning' ? (moderator?.name || 'The lead') + ' is assigning tasks…' : active?.phase === 'synthesizing' ? (moderator?.name || 'The lead') + ' is combining results…' : 'Workers are handling their assignments…') : active?.phase === 'moderating'
    ? `${moderator?.name || 'The moderator'} is choosing the next speaker…`
    : activities[roomId] || `${currentSpeaker?.name || 'The room'} is working…`;
  const simpleActivityLabel = activities[roomId] === 'Connection interrupted. Reconnecting…' ? 'Reconnecting…' : delegated ? active?.phase === 'planning' ? (moderator?.name || 'The lead') + ' is assigning tasks…' : active?.phase === 'synthesizing' ? (moderator?.name || 'The lead') + ' is combining results…' : 'Workers are working…' : active?.phase === 'moderating' ? (moderator?.name || 'The group') + ' is choosing a useful perspective…' : active?.phase === 'synthesizing' ? (moderator?.name || 'The moderator') + ' is bringing it together…' : (currentSpeaker?.name || 'The group') + ' is replying…';
  const sendLabel = assignmentDraft ? starting[roomId] ? 'Assigning background task' : 'Assign background task' : stopSubmission ? 'Send stop command' : delegated ? starting[roomId] ? 'Starting worker tasks' : 'Send task to lead bot' : active ? starting[roomId] ? 'Sending guidance' : 'Send guidance to group' : starting[roomId] ? 'Starting discussion' : hasTopic && !draft.trim() ? 'Continue discussion' : 'Send message to group';
  const kickoffPrompts = [
    { icon: Lightbulb, label: 'Review an idea', prompt: 'Review this idea from your different perspectives. Identify its strengths, risks, and the next useful step: ' },
    { icon: ShieldCheck, label: 'Test a decision', prompt: 'Help me pressure-test this decision. Make the strongest case for and against it, then explain what would change your recommendation: ' },
    { icon: FileText, label: 'Build a plan', prompt: 'Work together to turn this goal into a practical plan. Clarify the priorities, tradeoffs, and first steps: ' },
  ];

  return <>
    <main className="conversation-pane group-conversation" data-attachment-input="group-chat-attachments">
      <header className="chat-header">
        <div className="chat-heading">
          <IconButton label="Open workspace roster" className="mobile-menu" onClick={openRoster}><Menu size={19}/></IconButton>
          {advanced && <span className="discussion-symbol"><Users size={20}/></span>}
          <div>
            <strong title={room.title}>{room.title}</strong>
            <span>{delegated ? 'Led by ' + (moderator?.name || 'a bot') : advanced ? participants.length + ' participants · ' + (moderated ? 'Moderated by ' + (moderator?.name || 'an agent') : 'Roundtable') : participants.length + ' bots' + (smart ? ' · Smart discussion' : '')}</span>
          </div>
        </div>
        <div className="header-actions">
          {advanced && <><span className={`chat-mode ${active ? 'is-running' : ''}`}><span/>{active ? 'Running' : delegated ? 'Lead & workers' : 'Discussion'}</span><button type="button" className={`secondary small header-details-button ${profileOpen ? 'is-active' : ''}`} aria-label="Show discussion participants" aria-expanded={profileOpen} onClick={toggleProfile}><PanelRight size={16}/><span>Participants</span></button></>}
          <IconButton label="More options" onClick={openOptions}><MoreHorizontal size={20}/></IconButton>
        </div>
      </header>
      {errors[roomId] && <div role="alert" className="error-banner"><Info size={16}/><span>{errors[roomId]}</span><IconButton label="Dismiss discussion error" onClick={() => setErrors(previous => ({ ...previous, [roomId]: '' }))}><X size={15}/></IconButton></div>}
      <div className="chat-scroll" ref={scroll} onScroll={handleScroll}>
        <div className={`chat-content ${!messages.length ? 'empty-content' : ''}`}>
          {loading[roomId] && !data ? <div className="loading-state"><LoaderCircle className="spin" size={22}/><p>Opening the group…</p></div> : !messages.length ? !advanced ? <div className="simple-welcome"><h1>{delegated ? "Give the lead a task" : "Message the group"}</h1>{delegated && <p>Its workers contribute their own expertise.</p>}</div> : <div className="welcome discussion-welcome">
            <span className="welcome-kicker">{delegated ? "LEAD & WORKERS" : "SHARED PERSPECTIVES"}</span>
            <h1>{delegated ? "One goal, a team of bots." : "Bring your agents together."}</h1>
            <p>{delegated ? "Give the lead a goal. It assigns work, collects each bot’s result, and brings you one answer." : "Start with a question, a decision, or a goal. Your agents share the conversation and contribute their own perspectives."}</p>
            <div className="discussion-welcome-members" aria-label="Discussion participants">{participants.map(agent => <span key={agent.id} title={`${agent.name} · ${agent.role}`}><Avatar agent={agent}/><span>{agent.name}</span></span>)}</div>
            <div className="discussion-kickoffs">{kickoffPrompts.map(prompt => <button type="button" className="discussion-kickoff" key={prompt.label} onClick={() => { editGroupDraft(roomId,prompt.prompt); composer.current?.focus(); }}><prompt.icon size={16}/><span>{prompt.label}</span><ArrowUpRight size={14}/></button>)}</div>
            <span className="welcome-footnote"><ShieldCheck size={13}/>{delegated ? 'Each worker keeps its saved permissions. You can stop the task.' : <>Discussion tools are off. {continuous ? 'You choose when to stop.' : smart ? 'The moderator brings useful perspectives into one outcome.' : 'Your session ends within the selected limits.'}</>}</span>
          </div> : messages.filter(message => !Object.values(interactions.entries).some(entry => entry.runId === active?.id && entry.status === 'pending' && message.id === 'question-' + entry.id)).map(message => {
            const speaker = bootstrap.agents.find(agent => agent.id === message.agentId);
            return <article key={message.id} id={messageAnchor(roomId,message.id)} tabIndex={-1} aria-label={message.role==='user'?'Message from you':'Message from '+message.authorName} className={`message ${message.role}`}>
              <div className="message-meta">{speaker && <Avatar agent={speaker}/>}<strong>{message.role === 'user' ? 'You' : message.authorName}</strong>{advanced && <>{speaker && <span className="group-speaker-role" title={speaker.role}>{speaker.role}</span>}<time>{new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></>}</div>
              <div className={`message-bubble ${message.status === 'error' ? 'message-error' : ''}`}>{message.replyToId&&<MessageReply author={messages.find(item=>item.id===message.replyToId)?.role==='user'?'You':messages.find(item=>item.id===message.replyToId)?.authorName||'Bot'} message={messages.find(item=>item.id===message.replyToId)} onJump={()=>jumpToReply(message.replyToId!)}/>} {message.content ? <RichText content={message.content}/> : (message.status === 'streaming' ? <span className="stream-cursor"/> : message.status === 'cancelled' ? 'Reply stopped.' : message.attachments?.length ? '' : 'No response was returned.')}{message.status === 'streaming' && message.content && <span className="stream-cursor"/>}</div>
              {!!message.attachments?.length&&<AttachmentList attachments={message.attachments} basePath={'/api/groups/'+encodeURIComponent(roomId)+'/attachments'} messageId={message.id} label="Message attachments"/>}
              {message.status !== 'streaming' && <div className="message-actions">
                <button type="button" className="message-reply" aria-label={'Reply to '+(message.role==='user'?'your message':message.authorName)} title={active&&delegated&&!pendingInteractions?'Wait for this response to finish before replying':'Reply'} disabled={secureCredentialPending||!!active&&delegated&&!pendingInteractions} onClick={()=>selectReply(message)}><Reply size={15}/><span className="sr-only">Reply</span></button>
                {advanced && message.role==='assistant' && message.route && <details className="group-message-route"><summary>{providerName(message.route.provider)} · {message.route.model}</summary><p>{message.route.reason}</p></details>}
                {message.role==='assistant' && !!message.content && <button type="button" className="message-copy" aria-label={copiedId === message.id ? 'Reply copied' : `Copy reply from ${message.authorName}`} title={copiedId === message.id ? 'Copied' : 'Copy reply'} onClick={() => void copyReply(message)}>{copiedId === message.id ? <Check size={13}/> : <Copy size={13}/>}<span className={advanced ? '' : 'sr-only'} aria-live="polite">{copiedId === message.id ? 'Copied' : 'Copy'}</span></button>}
              </div>}
              {message.status === 'cancelled' && <div className="message-note">Stopped</div>}
              {message.role === 'assistant' && message.runId && <DelegationList runId={message.runId} records={data?.runs.find(run => run.id === message.runId)?.delegations || []} reconcile={reconcileWorker}/>}
            </article>;
          })}
          <AssignmentActivity source={{kind:'group',id:roomId}} api={api}/>
          {data?.runs.filter(run => run.mode === 'delegated' && !messages.some(message => message.role === 'assistant' && message.runId === run.id)).map(run => <DelegationList key={run.id} runId={run.id} records={run.delegations || []} reconcile={reconcileWorker}/>)}
          {active?.mode === 'delegated' && <WorkerInteractions runId={active.id} state={interactions} returnFocus={() => composer.current?.focus({ preventScroll: true })}/>}
          {!active && latest?.error && <div className="discussion-run-error" role="alert"><Info size={15}/><span>{latest.error}</span></div>}
          <div ref={bottom}/>
        </div>
      </div>
      {showLatest && <div className="jump-latest-wrap"><button type="button" className="jump-latest" onClick={jumpToLatest}><ArrowDown size={14}/>Jump to latest</button></div>}
      <div className="composer-area"><div className="composer-inner">
        {advanced && !delegated && <div className="discussion-session-panel">
          <div className="discussion-session-controls">
            <label>Session <select aria-label="Discussion session mode" value={executionMode} disabled={!!active || starting[roomId]} onChange={event => setExecutionModes(previous => ({ ...previous, [roomId]: event.target.value as ExecutionMode }))}>{moderated && <option value="smart">Smart · discuss and conclude</option>}<option value="continuous">Until stopped</option><option value="bounded">Bounded session</option></select></label>
            {!continuous && (moderated ? <label>Reply limit <select aria-label="Discussion reply limit" value={active?.totalReplies ?? maxReplies} disabled={!!active || starting[roomId]} onChange={event => setReplyBudgets(previous => ({ ...previous, [roomId]: Number(event.target.value) }))}>{Array.from({ length: 15 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}</select></label> : <label>Rounds <select aria-label="Discussion rounds" value={active?.rounds ?? rounds} disabled={!!active || starting[roomId]} onChange={event => setRoundCounts(previous => ({ ...previous, [roomId]: Number(event.target.value) }))}><option value={1}>1</option><option value={2}>2</option><option value={3}>3</option></select></label>)}
          </div>
          {active ? <div className="discussion-run-strip">
            <div className="discussion-active-status" role="status"><span className="working-dots"><i/><i/><i/></span><span>{activityLabel}</span></div>
            <div className="discussion-budget"><span>{runProgress(active, moderated)}</span><ElapsedTime run={active}/></div>
          </div> : <div className={`discussion-budget ${continuous ? 'continuous-budget' : ''}`}><span>{continuous ? 'Continues until you stop it or a provider needs attention.' : smart ? `Up to ${Math.max(0, replies - 1)} contributions and one outcome · up to ${maxCalls} model calls · 10 min maximum` : `${moderated ? 'Up to ' : ''}${replies} replies · up to ${maxCalls} model calls · 10 min maximum`}</span></div>}
          {moderated && !continuous && !active && <p className="moderation-budget-caption">Moderator decisions and routing count toward the limit. The moderator can finish early.</p>}
        </div>}
        {(!advanced || delegated) && active && <div className="simple-group-activity" role="status"><span className="working-dots"><i/><i/><i/></span><span>{simpleActivityLabel}</span></div>}
        {!active && latest?.pendingGuidance && <p className="discussion-context-note" role="status">Your latest guidance is saved and still needs a reply. Continue the discussion to apply it.</p>}
        {advanced && !delegated && contextWindowed && <p className="discussion-context-note"><Info size={13}/>Earlier replies stay in history. Agents use the topic and recent conversation.</p>}
        {advanced && moderated && speakerReason && <details className="moderation-decision" key={(active ?? latest)?.id}>
          <summary>{active?.phase === 'reply' && active.currentAgentId ? `Selected speaker · ${currentSpeaker?.name || 'participant'}` : `${moderator?.name || 'Moderator'} · latest decision`}</summary><p>{speakerReason}</p>
        </details>}
        {delegated && !active && !herdr.status?.available && <div className="herdr-setup-notice" role="status">{herdr.checking ? <LoaderCircle size={14} className="spin"/> : <Info size={14}/>}<span>{herdr.checking ? 'Checking worker runtime…' : 'Herdr is not ready. Review its setup in Advanced settings → Integrations.'}</span>{!herdr.checking && <button type="button" onClick={() => void herdr.refresh()}>Check again</button>}</div>}
        {replyToId&&<MessageReply author={replyTarget?.role==='user'?'You':replyTarget?.authorName||'Bot'} message={replyTarget} onCancel={clearReply}/>}
        <div className={`composer ${advanced ? '' : 'simple-composer'}`}>
          <input ref={attachmentInput} id="group-chat-attachments" type="file" hidden multiple accept="image/png,image/jpeg,image/webp,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" disabled={secureCredentialPending||uploading[roomId]||starting[roomId]} onChange={event=>{const selected=Array.from(event.target.files??[]);event.target.value='';void uploadFiles(selected);}}/>
          <button type="button" className="icon-button" aria-label="Attach image or document to group" title="Attach image or document to group" data-attachment-button="group-chat-attachments" disabled={secureCredentialPending||uploading[roomId]||starting[roomId]} onClick={()=>attachmentInput.current?.click()}>{uploading[roomId]?<LoaderCircle size={18} className="spin"/>:<Plus size={18}/>}</button>
          {active&&hasSubmission&&<button type="button" className="icon-button" aria-label={delegated?'Stop all workers':'Stop discussion'} title="Stop and keep staged attachments" disabled={stopping[active.id]} onClick={()=>void stop()}><Square size={16} fill="currentColor"/></button>}
          <MentionTextarea agents={bootstrap.agents} computers={registeredComputers(bootstrap)} scopeKey={roomId} onMentionChange={text=>editGroupDraft(roomId,text)} ref={composer} onPaste={event=>{const images=clipboardImages(event.clipboardData);if(images.length){event.preventDefault();void uploadFiles(images);}}} onKeyDownCapture={event=>{if(event.key==='Escape'&&replyToId){event.preventDefault();event.stopPropagation();clearReply();}}} disabled={secureCredentialPending} aria-label={delegated ? 'Task for the lead bot' : 'Discussion topic or follow-up'} placeholder={active ? pendingInteractions ? 'Reply to the bot here…' : delegated ? 'Guide remaining work…' : 'Guide the discussion…' : delegated ? 'What should the team accomplish?' : !advanced ? 'Message the group…' : hasTopic ? 'Add a follow-up, or continue where you left off…' : 'What should your agents discuss?'} value={draft} maxLength={16000} rows={advanced ? 2 : 1} onChange={event => editGroupDraft(roomId,event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void start(); } }}/>
          <div className={advanced ? 'composer-tools' : 'simple-composer-action'}>
            {advanced && <span className="discussion-order-caption" title={delegated ? 'Lead: ' + (moderator?.name || 'Not configured') : moderated ? 'Moderator: ' + (moderator?.name || 'Not configured') : participants.map(agent => agent.name).join(' → ')}>{delegated ? 'Lead: ' + (moderator?.name || 'Not configured') : moderated ? 'Moderator: ' + (moderator?.name || 'Not configured') : participants.map(agent => agent.name).join(' → ')}</span>}
            {active && !hasSubmission ? <button type="button" className={advanced ? 'discussion-start secondary discussion-stop' : 'send-button stop'} aria-label={stopping[active.id] ? delegated ? 'Stopping workers' : 'Stopping discussion' : delegated ? 'Stop all workers' : 'Stop discussion'} title={stopping[active.id] ? 'Stopping…' : delegated ? 'Stop all workers' : 'Stop discussion'} disabled={stopping[active.id]} onClick={() => void stop()}><Square size={advanced ? 13 : 16} fill="currentColor"/>{advanced && (stopping[active.id] ? 'Stopping…' : delegated ? 'Stop all workers' : 'Stop discussion')}</button> : <button type="button" className={advanced ? 'discussion-start primary' : 'send-button'} aria-label={sendLabel} title={sendLabel} disabled={secureCredentialPending || (uploading[roomId]&&!stopSubmission) || (assignmentDraft ? !data || loading[roomId] || starting[roomId] : active ? !hasSubmission || starting[roomId] : !canStart)} onClick={() => void start()}>{starting[roomId] ? <LoaderCircle size={17} className="spin"/> : <ArrowUp size={18}/>} {advanced && (starting[roomId] ? 'Starting…' : assignmentDraft?'Assign task':active?'Send guidance':delegated ? 'Assign task' : hasTopic ? 'Continue discussion' : 'Start discussion')}</button>}
          </div>
        </div>
        <AttachmentList attachments={files} basePath={'/api/groups/'+encodeURIComponent(roomId)+'/attachments'} disabled={secureCredentialPending||uploading[roomId]||starting[roomId]} onRemove={removeAttachment} label="Group draft attachments"/>
        <p className="group-attachment-note">{delegated?'Images and documents are shared with the lead and selected workers. New guidance applies to subsequent work.':'Images and documents are shared with this group’s participants.'}</p>
        {advanced ? <div className="composer-caption"><span>{unconfigured.length ? <button onClick={openSettings}>Set up accounts or routes for {unconfigured.map(agent => agent.name).join(', ')}</button> : 'Each agent uses its saved instructions, route, and model.'}</span><span>{delegated ? 'Workers keep their saved permissions' : 'Chat only · tools off'}</span></div> : !!unconfigured.length && <button type="button" className="simple-setup-notice" onClick={openSettings}>Finish setup to {delegated ? 'run workers' : 'chat'}</button>}
      </div></div>
    </main>
    {advanced && profileOpen && <div className="profile-mobile-shade" onClick={toggleProfile}/>}
    {advanced && <aside className={`profile-pane group-profile ${profileOpen ? 'profile-open' : ''}`} aria-label="Discussion participants">
      <div className="profile-top-actions"><IconButton label="Account settings" onClick={openSettings}><Settings2 size={17}/></IconButton><IconButton className="profile-close" label="Close participants" onClick={toggleProfile}><X size={18}/></IconButton></div>
      <div className="group-inspector-heading"><h2>Participants</h2><p>{participants.length} agents · {delegated ? 'Lead & workers' : moderated ? 'Moderated discussion' : 'Roundtable'}</p></div>
      <div className="profile-content">
        {(moderated || delegated) && moderator && <div className="moderator-profile-card">
          <span className="section-label">{delegated ? "LEAD" : "MODERATOR"}</span>
          <div><Avatar agent={moderator}/><span><strong title={moderator.name}>{moderator.name}</strong><small>{delegated ? 'Assigns work and combines results' : 'Chooses the next speaker'}</small></span><IconButton label={`Edit ${delegated ? 'lead' : 'moderator'} ${moderator.name}`} onClick={() => editAgent(moderator)}><Pencil size={14}/></IconButton></div>
          <p>{moderatorRoute ? `${providerName(moderatorRoute.provider)} · ${moderatorRoute.model}` : moderator.routeMode === 'auto' ? 'Auto route · saved model preferences' : `${providerName(moderator.routeMode)} · ${moderator.model || 'saved subscription default'}`}</p>
          <small>{delegated ? 'Coordinates one batch of worker tasks.' : continuous ? 'Guides the discussion until you stop it.' : 'Can finish early within the session limits.'}</small>
        </div>}
        <div className="section-heading"><span>{delegated ? 'TEAM BOTS' : moderated ? 'AGENTS IN THIS ROOM' : 'SPEAKING ORDER'}</span><span>{participants.length}</span></div>
        <div className="discussion-participants">{participants.map((agent, index) => {
          const lastMessage = [...messages].reverse().find(message => message.agentId === agent.id && message.route);
          const provider = bootstrap.providers.find(item => item.id === agent.routeMode);
          const isSpeaking = active?.phase !== 'moderating' && active?.currentAgentId === agent.id;
          return <section className={`discussion-participant ${isSpeaking ? 'is-speaking' : ''}`} key={agent.id}>
            <div className="participant-heading"><Avatar agent={agent}/><div><strong title={agent.name}>{agent.name}</strong><span title={agent.role}>{agent.role || 'Participant'}</span></div>{!moderated && !delegated && <span className="discussion-order" aria-label={`Position ${index + 1}`}>{index + 1}</span>}<IconButton label={`Edit ${agent.name}'s perspective and route`} onClick={() => editAgent(agent)}><Pencil size={14}/></IconButton></div>
            {(isSpeaking || (moderated || delegated) && agent.id === moderatorAgentId) && <div className="participant-badges">{isSpeaking && <span className="participant-speaking">Speaking</span>}{(moderated || delegated) && agent.id === moderatorAgentId && <span className="participant-moderator-badge">{delegated ? 'Lead' : 'Moderator'}</span>}</div>}
            <div className="participant-route">{lastMessage?.route ? `${providerName(lastMessage.route.provider)} · ${lastMessage.route.model}` : agent.routeMode === 'auto' ? 'Auto route · saved model preferences' : `${providerName(agent.routeMode)} · ${agent.model || defaultModelLabel(provider)}`}</div>
            <details className="participant-perspective"><summary>Instructions</summary><p>{agent.instructions || 'No instructions yet. Edit this agent to add a perspective.'}</p></details>
            {!agentCanRun(agent, bootstrap.providers) && <button type="button" className="participant-needs-setup" onClick={() => editAgent(agent)}><Info size={13}/>Route needs setup <ChevronRight size={13}/></button>}
          </section>;
        })}</div>
        <div className="profile-note"><ShieldCheck size={15}/><span>{delegated ? 'The lead collects task results. Each worker keeps its saved configuration and permissions.' : 'Agents share the transcript and use their own saved configuration. Discussion execution tools stay off.'}</span></div>
        {latest && <div className="discussion-run-summary"><span className="section-label">LATEST SESSION</span><p>{latest.status} · {delegated ? 'one task batch' : latest.executionMode === 'continuous' ? 'until stopped' : 'bounded'}<br/>{runProgress(latest, (latest.mode ?? room.mode) === 'moderated')}</p><ElapsedTime run={latest}/></div>}
      </div>
    </aside>}
  </>;
}
