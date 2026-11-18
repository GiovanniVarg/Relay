import {scopedLocalStorage as localStorage, scopedSessionStorage as sessionStorage} from './controller-scope';
import {MentionTextarea} from './MentionTextarea';
import {AssignmentActivity} from './AssignmentActivity';
import {hasBackgroundAssignment,parseBackgroundAssignment,registeredComputers,submitBackgroundAssignment} from './background-assignments';
import {AppearanceControl} from './AppearanceControl';
import {RelayMark} from './RelayMark';
import {normalizeAppearance,readCachedAppearance,useAppearance} from './appearance';
import {AttachmentChips,MessageAttachments} from './AttachmentChips';
import {Dispatcher} from './Dispatcher';
import {RichText} from './RichText';
import './RichText.css';
import {MessageReply} from './MessageReply';
import {clipboardImages,clipboardHasImages,focusReplySource,messageAnchor} from './chat-input';
import {ATTACHMENT_LIMITS} from '../shared/attachments';
import {VoiceInput} from './voice-input';
import type {MessageAttachment} from '../shared/attachments';
import {typeSafeErrorMessage,typeSafeCatalogIssueMessage} from '../shared/typesafe-errors';
import {RunUsage} from './Usage';
import {TaskProgress,useTaskProgress} from './TaskProgress';
import {BrowserPanel,useBrowserDiscovery} from './BrowserPanel';
import {TerminalPanel} from './TerminalPanel';
import {allowanceSummary} from '../shared/provider-allowance';
import {useTaskNotifications} from './useTaskNotifications';
import {Workspace} from './Workspace';
import { isActiveProviderId } from '../shared/types';
import {connectionReady,connectionBillingReady} from '../shared/provider-policy';
import { INFERENCE_STATUS, inferenceWaitingMessage } from '../shared/inference-status';
import { useEffect, useRef, useState, type ReactNode, type FormEvent, type ClipboardEvent } from 'react';
import { ArrowDown, ArrowUp, ArrowUpRight, Check, ChevronDown, ChevronRight, CircleHelp, Clock3, Copy, FileText, History, Info, LoaderCircle, Menu, MessageSquare, MoreHorizontal, MousePointer2, PanelRight, Pencil, Pin, Plus, RefreshCw, Reply, Search, Settings2, ShieldCheck, Smartphone, Sparkles, Square, Terminal, Trash2, Upload, Users, X, Zap } from 'lucide-react';
import type { Agent, Appearance, Bootstrap, ChatMode, Conversation, LibraryFile, LoginResult, Message, ProviderState, RouteMode, Run, RunEvent, Settings, TelegramStatus } from '../shared/types';
import { Avatar, IconButton, Modal } from './UI';
import { AvatarPhotoField } from './AvatarPhotoField';
import { CreateDiscussion, GroupWorkspace } from './Groups';
import { allowedCatalog, ModelPicker, modelIsAvailable, providerName, providerSetupUrl, SubscriptionModels } from './Models';
import { RunInteractions, useRunInteractions,isSecureCredentialInteraction } from './Interactions';
import {TypeSafeConnection} from './TypeSafeConnection';
import {NetworkPanel} from './NetworkPanel';
import {AccountChoice,AccountConnections} from './AccountConnections';
import type {AccountState} from '../shared/accounts';
import {useSecureCredentialEntry,type SecureCredentialApi} from './useSecureCredentialEntry';
import { HerdrSettings } from './Delegations';
import { useRuntimeConnection, useSessionDrafts } from './RuntimeConnection';
import { mergeConversationMessages } from './ConversationMessages';
import {conversationRefresh,mergeTaskConversation,taskConversationRevision} from './task-conversation-sync';

type ConversationData = { conversation: Conversation; messages: Message[]; runs: Run[] };
type AgentData = { agent: Agent; conversations: Conversation[]; files: LibraryFile[]; telegram?: TelegramStatus };
type Api = SecureCredentialApi;
const modeLabel = (mode: string) => mode[0].toUpperCase() + mode.slice(1);
const activeRun = (run: Run) => run.status === 'routing' || run.status === 'running';
const ready = (p: ProviderState, nativeAgent = false) => connectionReady(p,nativeAgent)&&allowedCatalog(p).length>0;
const reportedAllowanceUnavailable = (p: ProviderState) => p.allowance?.availability === 'reported' && p.allowance.ordinaryUsageAllowed === false;
const accountStatus = (p: ProviderState): string => p.error?.startsWith('Refresh providers to inspect') ? 'Not checked' : p.inferenceAvailable === false ? 'Unavailable' : !p.installed ? 'Connector missing' : !p.authenticated ? 'Not connected' : reportedAllowanceUnavailable(p) ? 'Connected · allowance unavailable' : !connectionBillingReady(p) ? 'Connected · approve usage' : !p.models.length ? 'Connected · refresh models' : !allowedCatalog(p).length ? 'Connected · enable models' : p.nativeAgentOnly ? 'Native Agent' : p.billing.automaticRouting ? 'Ready for Auto' : 'Ready · manual only';
const accountNextAction = (p: ProviderState): string => p.error?.startsWith('Refresh providers to inspect') ? 'Refresh accounts to check sign-in.' : !p.installed ? 'Install the provider connector, then refresh accounts.' : !p.authenticated ? `Connect ${providerName(p.id)} to sign in.` : reportedAllowanceUnavailable(p) ? 'Check your provider dashboard or choose another account. Saving usage permission does not restore allowance.' : p.inferenceAvailable === false ? 'Review the connection error below.' : !connectionBillingReady(p) ? 'Approve usage in Relay below before sending messages.' : !p.models.length ? 'Refresh accounts to load the model catalog.' : !allowedCatalog(p).length ? 'Enable a model below before sending messages.' : !p.billing.automaticRouting ? 'Choose this account manually in chat. To let Auto choose it, enable the Auto option below.' : 'Use Auto in chat, or select this account and an enabled model.';
const shortDate = (date: string) => new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const safeStorage={getItem(key:string){try{return localStorage.getItem(key);}catch{return null;}},setItem(key:string,value:string){try{localStorage.setItem(key,value);}catch{}},removeItem(key:string){try{localStorage.removeItem(key);}catch{}}};
const colors = ['#657e70', '#6c7193', '#927562', '#6b8990', '#8e7388', '#918759'];

export function App() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [cachedAppearance]=useState(readCachedAppearance);
  const appearance=bootstrap?normalizeAppearance(bootstrap.settings.appearance):cachedAppearance;
  useAppearance(appearance);
  const [appearancePending,setAppearancePending]=useState(false),[appearanceError,setAppearanceError]=useState('');
  const appearanceSaving=useRef(false),bootstrapRevision=useRef(0);
  async function saveAppearance(value:Appearance){
    if(appearanceSaving.current)return;appearanceSaving.current=true;setAppearancePending(true);setAppearanceError('');
    try{await api('/settings','PATCH',{appearance:value});await reload();}
    catch(error){setAppearanceError('Could not save appearance: '+(error as Error).message);}
    finally{appearanceSaving.current=false;setAppearancePending(false);}
  }
  const [agentId, setAgentId] = useState(() => safeStorage.getItem('relay.agent') || '');
  const [conversationId, setConversationId] = useState('');
  const [roomId, setRoomId] = useState('');
  const taskProgress=useTaskProgress(api,agentId,roomId?'':conversationId);
  const [workspaceOpen,setWorkspaceOpen]=useState(false);
  const [dispatcherOpen,setDispatcherOpen]=useState(false);
  const [terminalOpen,setTerminalOpen]=useState(false);
  const terminalOpenerRef=useRef<HTMLButtonElement>(null);
  const terminalIntent=useRef(0),terminalSelection=useRef(terminalOpen);terminalSelection.current=terminalOpen;
  const requestedConversation=useRef<{agentId:string;id:string}|null>((() => { try { const value=JSON.parse(sessionStorage.getItem('relay.conversation') || 'null'); return value && typeof value.agentId==='string' && typeof value.id==='string' && value.agentId.length<=100 && value.id.length<=100 ? value : null; } catch { return null; } })());
  const selectionRestored = useRef(false);
  const [editorAgentId, setEditorAgentId] = useState('');
  const [agentData, setAgentData] = useState<Record<string, AgentData>>({});
  const [sessions, setSessions] = useState<Record<string, ConversationData>>({});
  const [drafts, setDrafts] = useSessionDrafts('relay.chat-drafts');
  const [replyDrafts,setReplyDrafts]=useSessionDrafts('relay.reply-drafts');
  const attachingLock=useRef(false);
  const [attachmentDrafts,setAttachmentDrafts]=useState<Record<string,MessageAttachment[]>>({});
  const [attaching,setAttaching]=useState(false);
  const attachmentInput=useRef<HTMLInputElement>(null),draftAliases=useRef(new Map<string,string>()),creatingConversation=useRef(new Map<string,Promise<string>>());
  const committedAttachments=useRef(new Set<string>()),draftRevisions=useRef(new Map<string,number>());
  const editDraft=(key:string,text:string)=>{draftRevisions.current.set(key,(draftRevisions.current.get(key)??0)+1);setDrafts(previous=>({...previous,[key]:text}));};
  const resolveDraftKey=(key:string)=>draftAliases.current.get(key)??key;
  const runtimeStatus = useRuntimeConnection();
  useEffect(()=>{if(runtimeStatus)window.dispatchEvent(new Event('relay:runtime-disconnected'));},[runtimeStatus]);
  const [activities, setActivities] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [advanced, setAdvanced] = useState(() => safeStorage.getItem('relay.advanced') === 'true');
  const [tab, setTab] = useState<'details' | 'library' | 'computer'>('details');
  const [dialog, setDialog] = useState<'create' | 'edit' | 'settings' | 'history' | 'group-create' | 'options' | 'files' | 'network' | 'phone' | null>(() => ['127.0.0.1','localhost','[::1]','::1'].includes(location.hostname) && new URLSearchParams(location.search).get('setup') === 'phone-trust' ? 'phone' : null);
  useEffect(() => { const next = new URL(location.href); if (next.searchParams.get('setup') === 'phone-trust') { next.searchParams.delete('setup'); history.replaceState(history.state, '', next.pathname + next.search + next.hash); } }, []);
  const [rosterOpen, setRosterOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [routeMode, setRouteMode] = useState<RouteMode>('auto');
  const [accountId,setAccountId]=useState('');
  const [model, setModel] = useState('');
  const [chatMode, setChatMode] = useState<ChatMode>('agent');
  const [tools, setTools] = useState<Record<string, { name: string; summary: string }[]>>({});
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [discovering, setDiscovering] = useState(true);
  const initialRefreshStarted = useRef(false);
  const tokenRef = useRef('');
  const renewingSession=useRef<Promise<void>|null>(null);
  const streams = useRef(new Map<string, EventSource>());
  const streamText = useRef(new Map<string, string>());
  const runRevisions = useRef(new Map<string,number>());
  const conversationSync = useRef<ReturnType<typeof conversationRefresh> | null>(null);
  const liveClient = useRef({api,listen}); liveClient.current={api,listen};
  const bottomRef = useRef<HTMLDivElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const rosterOpenerRef = useRef<HTMLElement | null>(null);
  const profileOpenerRef = useRef<HTMLElement | null>(null);
  const followLatest = useRef(true);
  const previousConversation = useRef('');
  const [showLatest, setShowLatest] = useState(false);
  const [copiedMessage, setCopiedMessage] = useState('');
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const selectedRef = useRef({ agentId, conversationId, roomId });
  selectedRef.current = { agentId, conversationId, roomId };
  const agentReady = bootstrap?.agents.some(agent => agent.id === agentId) === true;
  const browserScope=agentReady&&!roomId&&!workspaceOpen&&!dispatcherOpen?agentId:'';
  const profileVisible=advanced&&profileOpen&&!workspaceOpen&&!dispatcherOpen;
  const terminalVisible=terminalOpen&&!profileVisible;
  const browserWatch=useBrowserDiscovery(api,browserScope,profileVisible,!!runtimeStatus);
  const browserVisible=browserWatch.open&&!profileVisible&&!terminalVisible;
  const browserOpenerRef=useRef<HTMLButtonElement>(null);
  function closeBrowser(){browserWatch.dismiss();requestAnimationFrame(()=>browserOpenerRef.current?.focus({preventScroll:true}));}
  function openTerminal(){++terminalIntent.current;terminalSelection.current=true;setRosterOpen(false);setProfileOpen(false);setTerminalOpen(true);}
  useEffect(()=>{const openSetupTerminal=()=>{setDialog(null);openTerminal();};window.addEventListener('relay:open-terminal',openSetupTerminal);return()=>window.removeEventListener('relay:open-terminal',openSetupTerminal);},[]);
  function closeTerminal(){terminalSelection.current=false;setTerminalOpen(false);requestAnimationFrame(()=>{const visible=(element:HTMLElement)=>element.getClientRects().length>0&&getComputedStyle(element).visibility!=='hidden';const opener=terminalOpenerRef.current;if(opener&&visible(opener))opener.focus({preventScroll:true});else Array.from(document.querySelectorAll<HTMLElement>('button[aria-label="Open agent roster"], .roster-search input')).find(visible)?.focus({preventScroll:true});});}
  useEffect(() => { if (agentId && conversationId) { try { sessionStorage.setItem('relay.conversation', JSON.stringify({ agentId, id: conversationId })); } catch {} } }, [agentId, conversationId]);
  useEffect(() => { safeStorage.setItem('relay.advanced', String(advanced)); if (!advanced) setProfileOpen(false); }, [advanced]);

  async function api<T>(path: string, method = 'GET', body?: unknown,request?:{signal?:AbortSignal;sensitive?:boolean}): Promise<T> {
    const response = await fetch(`/api${path}`, { method, signal:request?.signal, credentials: 'same-origin', headers: { ...(method === 'GET' ? {} : { 'X-CSRF-Token': tokenRef.current }), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json();
    if(response.status===401&&request?.sensitive)throw Object.assign(new Error(typeSafeErrorMessage('request_expired')), {status:401,code:'request_expired'});
    if(response.status===401&&path!=='/bootstrap'){
      if(!renewingSession.current)renewingSession.current=fetch('/api/bootstrap',{credentials:'same-origin'}).then(async result=>{if(!result.ok)throw new Error('Relay is restarting. Wait for it to reconnect.');const value=await result.json() as Bootstrap;tokenRef.current=value.csrfToken;setBootstrap(value);}).finally(()=>{renewingSession.current=null;});
      await renewingSession.current;
      if(method==='GET')return api<T>(path,method,body,request);
      throw new Error('Relay reconnected after restart. Review the current state and try this action again.');
    }
    if (!response.ok) {
      const safeCode=typeSafeErrorMessage(data.code)?data.code:request?.sensitive&&response.status===403?'request_expired':undefined;
      throw Object.assign(new Error(request?.sensitive?typeSafeErrorMessage(safeCode)??'Secure credential request failed.':data.error || `Request failed (${response.status})`), {status:response.status,...(safeCode?{code:safeCode}:{}),...(safeCode==='invalid_catalog'&&typeSafeCatalogIssueMessage(data.catalogIssue)?{catalogIssue:data.catalogIssue}:{})});
    }
    return data as T;
  }
  const interactions = useRunInteractions(api);
  useTaskNotifications(api,()=>setWorkspaceOpen(true));
  async function reload() {
    const revision=++bootstrapRevision.current;
    const data = await api<Bootstrap>('/bootstrap');
    if(revision!==bootstrapRevision.current)return data;
    tokenRef.current = data.csrfToken;
    setBootstrap(data);
    setAgentId(current => data.agents.some(a => a.id === current) ? current : data.agents[0]?.id || '');
    return data;
  }
  async function loadAgent(id: string) {
    const data = await api<AgentData>(`/agents/${id}`);
    setAgentData(prev => ({ ...prev, [id]: data }));
    return data;
  }
  function listen(run: Run) {
    if (streams.current.has(run.id) || selectedRef.current.conversationId!==run.conversationId || selectedRef.current.agentId!==run.agentId || selectedRef.current.roomId) return;
    const source = new EventSource(`/api/runs/${run.id}/events`);
    streams.current.set(run.id, source);
    streamText.current.set(run.id, '');
    const receive = (event: MessageEvent) => {
      if(streams.current.get(run.id)!==source)return;
      let data: RunEvent;
      try { data = JSON.parse(event.data); } catch { return; }
      const cid = run.conversationId;
      if (data.type === 'delta' || data.type === 'tool') setActivities(prev => prev[cid] === INFERENCE_STATUS.admitted ? { ...prev, [cid]: '' } : prev);
      if(data.type==='route'||data.type==='delta'||data.type==='done')runRevisions.current.set(run.id,(runRevisions.current.get(run.id)||0)+1);
      if (data.type === 'route') {
        setSessions(prev => { const session = prev[cid]; return session ? { ...prev, [cid]: { ...session, runs: [...session.runs.filter(r => r.id !== data.run.id), data.run] } } : prev; });
      } else if (data.type === 'delta') {
        const content = (streamText.current.get(run.id) || '') + data.text;
        streamText.current.set(run.id, content);
        setSessions(prev => { const session = prev[cid]; if (!session) return prev; const existing = session.messages.find(m => m.id===run.messageId); if(existing&&existing.status!=='streaming')return prev; const message: Message = { id: run.messageId, conversationId: cid, role: 'assistant', content:existing?.content.startsWith(content)?existing.content:content, createdAt: run.startedAt, runId: run.id, status: 'streaming' }; return { ...prev, [cid]: { ...session, messages: mergeConversationMessages(session.messages,[message]) } }; });
      } else if (data.type === 'tool') setTools(prev => ({ ...prev, [data.runId]: [...(prev[data.runId] || []).slice(-199), { name: data.name, summary: data.summary }] }));
      else if (data.type === 'status') setActivities(prev => ({ ...prev, [cid]: data.message }));
      else if (data.type === 'interaction' && data.interaction.runId === run.id) interactions.receive(data.interaction);
      else if (data.type === 'interactionResolved' && data.runId === run.id) interactions.resolve(data.runId, data.interactionId);
      else if (data.type === 'done') {
        source.close(); streams.current.delete(run.id); streamText.current.delete(run.id);
        interactions.finish(run.id);
        setSessions(prev => { const session = prev[cid]; return session ? { ...prev, [cid]: { ...session, runs: [...session.runs.filter(r => r.id !== data.run.id), data.run], messages: mergeConversationMessages(session.messages, [data.message]) } } : prev; });
        setActivities(prev => ({ ...prev, [cid]: '' }));
        void reload().catch(e => setError(e.message));
      }
    };
    source.onopen = () => { if(streams.current.get(run.id)===source)streamText.current.set(run.id, ''); };
    source.onmessage = receive;
    for (const name of ['route', 'delta', 'status', 'tool', 'interaction', 'interactionResolved', 'done']) source.addEventListener(name, receive as EventListener);
    source.onerror = () => { if(streams.current.get(run.id)===source)setActivities(prev => ({ ...prev, [run.conversationId]: 'Connection interrupted. Reconnecting…' })); };
    // A saved question can predate discovery of an automatic continuation.
    void interactions.reconcile(run.id).catch(()=>{});
  }
  useEffect(() => {
    void reload().then(async () => {
      if (initialRefreshStarted.current) return;
      initialRefreshStarted.current = true;
      try {
        const result = await api<{ providers: ProviderState[] }>('/providers/refresh', 'POST', {});
        setBootstrap(previous => previous ? { ...previous, providers: result.providers } : previous);
      } catch (failure) { setError((failure as Error).message); }
      finally { setDiscovering(false); }
    }).catch(failure => { setError(failure.message); setDiscovering(false); });
    return () => { streams.current.forEach(stream => stream.close()); streams.current.clear(); };
  }, []);
  useEffect(() => {
    if (!bootstrap || selectionRestored.current) return;
    selectionRestored.current = true;
    const rememberedRoom = safeStorage.getItem('relay.room');
    if (rememberedRoom && bootstrap.rooms.some(room => room.id === rememberedRoom)) setRoomId(rememberedRoom);
    else safeStorage.removeItem('relay.room');
  }, [!!bootstrap]);
  useEffect(() => {
    if (!selectionRestored.current) return;
    if (roomId) safeStorage.setItem('relay.room', roomId);
    else safeStorage.removeItem('relay.room');
  }, [roomId]);
  useEffect(() => {
    if (!agentId || !agentReady || !tokenRef.current) return;
    safeStorage.setItem('relay.agent', agentId);
    setConversationId('');
    let cancelled = false;
    void loadAgent(agentId).then(data => { if (!cancelled) { const requested=requestedConversation.current;const match=requested?.agentId===agentId&&data.conversations.some(c=>c.id===requested.id)?requested.id:null;setConversationId(match??[...data.conversations].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0]?.id??'');if(requested?.agentId===agentId)requestedConversation.current=null; } }).catch(e => setError(e.message));
    return () => { cancelled = true; };
  }, [agentId, agentReady]);
  useEffect(() => {
    const a = bootstrap?.agents.find(a => a.id === agentId);
    if (a) { setRouteMode(a.routeMode); setAccountId(a.accountId??''); setModel(a.model); setChatMode(a.mode || 'agent'); }
  }, [agentId, bootstrap?.agents.find(a => a.id === agentId)?.mode, bootstrap?.agents.find(a => a.id === agentId)?.routeMode, bootstrap?.agents.find(a => a.id === agentId)?.model,bootstrap?.agents.find(a=>a.id===agentId)?.accountId]);
  useEffect(() => {
    const owner=sessions[conversationId]?.conversation.agentId ?? bootstrap?.conversations.find(item=>item.id===conversationId)?.agentId;
    if (!conversationId || !agentId || roomId || (owner && owner!==agentId)) return;
    const cid=conversationId,aid=agentId;
    const controller=new AbortController();
    const sync=conversationRefresh(async()=>{
      const before=new Map(runRevisions.current);
      const data=await liveClient.current.api<ConversationData>(`/conversations/${encodeURIComponent(cid)}`,'GET',undefined,{signal:controller.signal});
      return {data,before};
    },({data,before})=>{
      if(selectedRef.current.conversationId!==cid||selectedRef.current.agentId!==aid||selectedRef.current.roomId||data.conversation.id!==cid||data.conversation.agentId!==aid)return;
      const changed=new Set([...runRevisions.current].filter(([id,revision])=>revision!==(before.get(id)||0)).map(([id])=>id));
      setSessions(prev=>({...prev,[cid]:mergeTaskConversation(prev[cid],data,changed)}));
    },error=>setError((error as Error).message));
    conversationSync.current=sync;sync.refresh('initial');
    return()=>{
      sync.dispose();controller.abort();if(conversationSync.current===sync)conversationSync.current=null;
      streams.current.forEach(stream=>stream.close());streams.current.clear();streamText.current.clear();
    };
  }, [agentId,conversationId,roomId]);
  useEffect(()=>{conversationSync.current?.refresh(taskConversationRevision(taskProgress));},[taskProgress]);
  useEffect(()=>{
    if(roomId)return;
    for(const run of sessions[conversationId]?.runs??[]){
      if(activeRun(run))liveClient.current.listen(run);
      else{const stream=streams.current.get(run.id);if(stream){stream.close();streams.current.delete(run.id);streamText.current.delete(run.id);interactions.finish(run.id);}}
    }
  },[sessions,conversationId,roomId]);
  const agent = bootstrap?.agents.find(a => a.id === agentId);
  const session = sessions[conversationId];
  const runs = session?.runs || [];
  const workingRun = runs.find(activeRun);
  const currentTaskRun = workingRun || runs.at(-1);
  const currentTask = taskProgress.find(task=>task.runId===currentTaskRun?.id)
    || (!workingRun&&currentTaskRun ? taskProgress.find(task=>task.runId===null&&task.runIds.at(-1)===currentTaskRun.id) : undefined);
  const needsTaskAttention = (task:typeof taskProgress[number])=>task.status==='needs_input'||task.status==='failed'||task.recoveryRequired;
  const earlierAttention = taskProgress.filter(task=>task.id!==currentTask?.id&&needsTaskAttention(task));
  const earlierRecovery = earlierAttention.filter(task=>task.recoveryRequired).length;
  const currentTaskChecking = currentTask?.status==='working'&&currentTask.phase==='checking';
  const pendingCheck = currentTask?.pendingCheck;
  const checkStopRunId = currentTaskChecking&&!currentTask.recoveryRequired&&pendingCheck
    &&['accepted','running'].includes(pendingCheck.state)&&pendingCheck.runId===currentTask.runId
    &&pendingCheck.taskId===currentTask.id&&pendingCheck.attempt===currentTask.attempt ? pendingCheck.runId : null;
  const stopRunId = workingRun?.id || checkStopRunId;
  const latestRoute = [...runs].reverse().find(r => r.route)?.route;
  const draftKey = conversationId || `new-${agentId}`;
  const draft = drafts[draftKey] || '';
  const checkStopRequested = !workingRun&&!!checkStopRunId&&/^(stop|cancel)$/i.test(draft.trim());
  const replyToId=replyDrafts[draftKey]||'';
  const replyTarget=session?.messages.find(message=>message.id===replyToId&&message.origin!=='task-continuation');
  const clearReply=()=>{setReplyDrafts(previous=>({...previous,[draftKey]:''}));composerRef.current?.focus();};
  const selectReply=(message:Message)=>{setReplyDrafts(previous=>({...previous,[draftKey]:message.id}));composerRef.current?.focus();};
  const jumpToReply=(id:string)=>{followLatest.current=false;setShowLatest(true);if(!focusReplySource(conversationId,id))setError('The original message is no longer available.');};
  const hasWorkspace = !!agent?.workspace;
  const effMode: ChatMode = !hasWorkspace && chatMode === 'work' ? 'chat' : chatMode;
  const agentSetupNeeded = false;
  const nativeAgentContext = effMode === 'agent' && hasWorkspace;
  const accountStates:ProviderState[]=bootstrap?.accounts??bootstrap?.providers??[];
  const eligible = accountStates.filter(p => (!accountId||(p as AccountState).accountId===accountId)&&ready(p,nativeAgentContext));
  const accountsConnected = bootstrap?.providers.some(p => p.installed && p.authenticated) === true;
  const selectedProvider = accountId?bootstrap?.accounts?.find(p=>p.accountId===accountId&&p.id===routeMode):bootstrap?.providers.find(provider => provider.id === routeMode);
  const selectedModelAvailable = routeMode === 'auto' || modelIsAvailable(selectedProvider, model);
  const canRoute = !agentSetupNeeded && (routeMode === 'auto' ? eligible.some(p => p.billing.automaticRouting && modelIsAvailable(p, '')) : eligible.some(p => p.id === routeMode)) && selectedModelAvailable;
  const nativeAgentSetupNeeded = selectedProvider?.nativeAgentOnly && !nativeAgentContext;
  const modelHelp = nativeAgentSetupNeeded ? !hasWorkspace ? 'Choose a project folder for native Agent' : 'Choose Agent mode for this connection' : selectedProvider?.inferenceAvailable === false ? selectedProvider.error || 'Sending is unavailable for this connection' : discovering ? 'Checking subscription models…'
    : selectedProvider && !selectedProvider.authenticated ? `Connect ${providerName(selectedProvider.id)} to load models`
    : selectedProvider?.authenticated && !connectionBillingReady(selectedProvider) ? 'Account connected · approve usage in Settings'
    : selectedProvider && !selectedProvider.models.length ? 'No models found · refresh this connection'
    : !selectedModelAvailable ? 'Choose an available model in subscription settings'
    : routeMode === 'auto' && eligible.length ? 'Choose an account manually, or let Auto choose it in Settings'
    : accountsConnected && !bootstrap?.providers.some(p => p.authenticated && connectionBillingReady(p)) ? 'Accounts connected · approve usage in Settings'
    : accountsConnected ? 'Accounts connected · enable a model in Settings' : 'Connect an account in Settings to send';
  const files = agentData[agentId]?.files || [];
  const conversations = bootstrap?.conversations.filter(c => c.agentId === agentId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) || [];
  const displayMode = workingRun?.mode || effMode;
  const modeDescription = displayMode === 'chat' ? 'Text conversation. Execution tools are off.' : displayMode === 'agent' ? 'Ask for the outcome in chat. Agent mode carries out requested app and project actions without repeated approval prompts. Reply to questions here, or type stop. Claude on Windows has no OS sandbox.' : displayMode === 'work' ? 'Tools run from the workspace folder without approval prompts. Claude on Windows has no OS sandbox.' : hasWorkspace ? 'Relay chooses Chat or Work for each message.' : 'No workspace is configured, so messages use Chat.';
  const humanApprovalPending = workingRun && Object.values(interactions.entries).some(item => item.runId === workingRun.id && item.humanRequired);
  const pendingInteractions = workingRun ? Object.values(interactions.entries).filter(item => item.runId === workingRun.id).length : 0;
  const secureCredentialPending=!!workingRun&&Object.values(interactions.entries).some(item=>item.runId===workingRun.id&&item.status==='pending'&&isSecureCredentialInteraction(item));
  const assignmentDraft=hasBackgroundAssignment(draft,bootstrap?.agents??[],registeredComputers(bootstrap));
  function openRoster() {
    rosterOpenerRef.current = document.activeElement as HTMLElement;
    setRosterOpen(true);
    requestAnimationFrame(() => {
      if (advanced || searchOpen) searchRef.current?.focus();
      else document.querySelector<HTMLElement>('.roster-close')?.focus();
    });
  }
  function closeRoster() {
    setRosterOpen(false);
    if (rosterOpen) requestAnimationFrame(() => {
      const opener = rosterOpenerRef.current;
      if (opener?.isConnected && opener.getClientRects().length > 0 && getComputedStyle(opener).visibility !== 'hidden') opener.focus();
      else Array.from(document.querySelectorAll<HTMLElement>('.conversation-pane .mobile-menu, .roster-search input')).find(button => button.getClientRects().length > 0 && getComputedStyle(button).visibility !== 'hidden')?.focus();
    });
  }
  function closeProfile() {
    setProfileOpen(false);
    requestAnimationFrame(() => {
      const opener = profileOpenerRef.current;
      if (opener?.isConnected && opener.getClientRects().length > 0) opener.focus();
      else Array.from(document.querySelectorAll<HTMLElement>('.conversation-pane .header-details-button, .conversation-pane button[aria-label="Toggle agent profile"]')).find(button => button.getClientRects().length > 0)?.focus();
    });
  }
  function showProfile() {
      profileOpenerRef.current = document.activeElement as HTMLElement;
      browserWatch.hide();
      terminalSelection.current=false;
      setTerminalOpen(false);
      setRosterOpen(false);
      setProfileOpen(true);
      if (window.matchMedia('(max-width: 1049px)').matches) requestAnimationFrame(() => Array.from(document.querySelectorAll<HTMLElement>('.profile-pane.profile-open .profile-close')).find(button => button.getClientRects().length > 0)?.focus());
  }
  function toggleProfile() {if(profileVisible)closeProfile();else showProfile();}
  function jumpToLatest() {
    followLatest.current = true; setShowLatest(false);
    const scroll = chatScrollRef.current;
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  }
  useEffect(() => {
    if (roomId) return;
    if (previousConversation.current !== conversationId) {
      previousConversation.current = conversationId;
      followLatest.current = true; setShowLatest(false);
    }
    if (!session?.messages.length) {
      if (chatScrollRef.current) chatScrollRef.current.scrollTop = 0;
      setShowLatest(false);
      return;
    }
    if (followLatest.current) jumpToLatest();
    else setShowLatest(true);
  }, [roomId, conversationId, session?.messages.at(-1)?.content, workingRun?.status, pendingInteractions]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (dialog) return;
      if ((event.target as HTMLElement).closest?.('#operator-terminal-panel')) return;
      if (event.key === 'Escape') {
        if(browserVisible&&(window.matchMedia('(max-width: 1049px)').matches||document.getElementById('bot-browser-panel')?.contains(event.target as Node)||event.target===browserOpenerRef.current)){event.preventDefault();closeBrowser();}
        else if (rosterOpen) { event.preventDefault(); closeRoster(); }
        else if (profileVisible) { event.preventDefault(); closeProfile(); }
        return;
      }
      const target = event.target as HTMLElement;
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || target.closest('input, textarea, select, [contenteditable="true"]')) return;
      event.preventDefault();
      setSearchOpen(true);
      if (window.matchMedia('(max-width: 768px)').matches) openRoster();
      requestAnimationFrame(() => searchRef.current?.focus());
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [dialog, rosterOpen, profileVisible, advanced, searchOpen, browserVisible]);
  useEffect(() => {
    if (!copiedMessage) return;
    const timer = window.setTimeout(() => setCopiedMessage(''), 2000);
    return () => window.clearTimeout(timer);
  }, [copiedMessage]);
  async function copyMessage(message: Message) {
    try { await navigator.clipboard.writeText(message.content); setCopiedMessage(message.id); }
    catch { setError('Could not copy this response. Select the text and copy it manually.'); }
  }

  async function newConversation() {
    if (!agent) return;
    const aid = agent.id;
    try {
      const conversation = await api<Conversation>(`/agents/${aid}/conversations`, 'POST', {});
      await reload();
      if (selectedRef.current.agentId === aid && !selectedRef.current.roomId) {
        setConversationId(conversation.id);
        setDialog(null);
        composerRef.current?.focus();
      }
    } catch (e) { setError((e as Error).message); }
  }
  async function ensureInputConversation(aid:string,key:string,existing:string){
    if(existing)return existing;
    const pending=creatingConversation.current.get(key);if(pending)return pending;
    const promise=(async()=>{const conversation=await api<Conversation>('/agents/'+aid+'/conversations','POST',{});const cid=conversation.id;draftAliases.current.set(key,cid);draftRevisions.current.set(cid,draftRevisions.current.get(key)??0);
      setDrafts(previous=>({...previous,[cid]:previous[key]??previous[cid]??'',[key]:''}));
      setAttachmentDrafts(previous=>({...previous,[cid]:[...(previous[cid]??[]),...(previous[key]??[])],[key]:[]}));
      setSessions(previous=>({...previous,[cid]:{conversation,messages:[],runs:[]}}));
      if(selectedRef.current.agentId===aid&&!selectedRef.current.conversationId&&!selectedRef.current.roomId){selectedRef.current={agentId:aid,conversationId:cid,roomId:''};setConversationId(cid);}return cid;})();
    creatingConversation.current.set(key,promise);try{return await promise;}finally{creatingConversation.current.delete(key);}
  }
  async function attachInput(list:FileList|File[]|null){
    if(!list?.length||!agent||workingRun&&!assignmentDraft||secureCredentialPending||attachingLock.current)return;
    const aid=agent.id,key=draftKey,existing=conversationId;
    attachingLock.current=true;setAttaching(true);setError('');
    try{
      const files=Array.from(list),current=attachmentDrafts[key]??[];
      if(current.filter(item=>item.kind==='image').length+files.filter(file=>file.type.startsWith('image/')).length>ATTACHMENT_LIMITS.images)throw new Error('Attach up to '+ATTACHMENT_LIMITS.images+' images per message.');
      for(const file of files)if(file.size>ATTACHMENT_LIMITS.bytes)throw new Error(file.name+' exceeds 4 MiB. Choose a smaller file.');
      const cid=await ensureInputConversation(aid,key,existing);
      for(const file of files){
        const base64=await new Promise<string>((done,reject)=>{const reader=new FileReader();reader.onload=()=>done(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('Could not read '+file.name+'. Try attaching the file again.'));reader.readAsDataURL(file);});
        const mimeType=file.type||(/\.txt$/i.test(file.name)?'text/plain':/\.docx$/i.test(file.name)?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':/\.pdf$/i.test(file.name)?'application/pdf':'');
        const item=await api<MessageAttachment>('/conversations/'+cid+'/attachments','POST',{name:file.name,mimeType,base64});
        setAttachmentDrafts(previous=>({...previous,[cid]:[...(previous[cid]??[]).filter(a=>a.id!==item.id),item]}));
      }
    }catch(e){setError('Could not attach file: '+(e as Error).message);}
    finally{attachingLock.current=false;setAttaching(false);if(attachmentInput.current)attachmentInput.current.value='';}
  }
  function pasteImage(event:ClipboardEvent<HTMLTextAreaElement>){
    const files=clipboardImages(event.clipboardData);if(!files.length){if(clipboardHasImages(event.clipboardData)){event.preventDefault();setError('Use a PNG, JPEG, or WebP image. Other clipboard image formats are not supported.');}return;}
    event.preventDefault();
    if(workingRun&&!assignmentDraft||secureCredentialPending){setError('Images can be attached after this response finishes. Add an explicit bot or computer mention to assign a separate task. Your draft is kept.');return;}
    if(attachingLock.current){setError('Wait for the current upload to finish, then paste the image again.');return;}
    void attachInput(files);
  }
  useEffect(()=>{if(!conversationId||!agentId)return;const cid=conversationId;let alive=true;void api<MessageAttachment[]>('/conversations/'+cid+'/attachments').then(items=>{if(alive&&Array.isArray(items))setAttachmentDrafts(previous=>({...previous,[cid]:[...new Map([...(previous[cid]??[]),...items.filter(a=>!committedAttachments.current.has(a.id))].map(a=>[a.id,a])).values()]}));}).catch(()=>{});return()=>{alive=false;};},[agentId,conversationId]);
  async function send() {
    if (secureCredentialPending || !agent || (!draft.trim()&&!(attachmentDrafts[draftKey]?.length)) || sending || attaching || attachingLock.current) return;
    let assignmentRequested=false;
    try{assignmentRequested=parseBackgroundAssignment(draft,bootstrap?.agents??[],registeredComputers(bootstrap)).tokens.length>0;}catch(failure){setError((failure as Error).message);return;}
    if(!assignmentRequested&&!workingRun&&!canRoute&&!checkStopRequested)return;
    const aid = agent.id, content = draft.trim(), submittedText=draft,submittedRevision=draftRevisions.current.get(draftKey)??0, originalKey = draftKey,submittedReply=replyToId,submittedIds=(attachmentDrafts[draftKey]??[]).map(a=>a.id);
    setError(''); setSending(true); followLatest.current = true; setShowLatest(false);
    try {
      if (checkStopRequested&&checkStopRunId) {
        await api(`/runs/${checkStopRunId}/cancel`,'POST',{});
        setDrafts(previous=>previous[originalKey]===submittedText&&(draftRevisions.current.get(originalKey)??0)===submittedRevision?{...previous,[originalKey]:''}:previous);
        return;
      }
      if(assignmentRequested){
        const cid=await ensureInputConversation(aid,originalKey,conversationId);
        const result=await submitBackgroundAssignment<Message>(api,{source:{kind:'conversation',id:cid},content:submittedText,...(submittedReply?{replyToId:submittedReply}:{}),attachmentIds:submittedIds});
        if(result.message)setSessions(previous=>{const current=previous[cid];return current?{...previous,[cid]:{...current,messages:mergeConversationMessages(current.messages,[result.message!])}}:previous;});
        for(const id of submittedIds)committedAttachments.current.add(id);
        setReplyDrafts(previous=>{const key=resolveDraftKey(originalKey);return previous[key]===submittedReply&&(draftRevisions.current.get(key)??0)===submittedRevision?{...previous,[key]:''}:previous;});
        setDrafts(previous=>{const key=resolveDraftKey(originalKey);return previous[key]===submittedText&&(draftRevisions.current.get(key)??0)===submittedRevision?{...previous,[key]:''}:previous;});
        setAttachmentDrafts(previous=>({...previous,[cid]:(previous[cid]??[]).filter(item=>!submittedIds.includes(item.id))}));
        if(result.recoveryWarning)setError(result.recoveryWarning);
        return;
      }
      if (workingRun) {
        if(!content)return;
        const pending = Object.values(interactions.entries).filter(entry => entry.runId === workingRun.id && entry.status === 'pending');
        const result = await api<{ message: Message; questionMessage?: Message; questionMessages?: Message[]; interaction?: { id: string } }>(`/runs/${workingRun.id}/message`, 'POST', { content, ...(submittedReply?{replyToId:submittedReply}:{}), ...(pending.length === 1 ? { interactionId: pending[0].id } : {}) });
        if (result.interaction) interactions.resolve(workingRun.id, result.interaction.id);
        setSessions(previous => { const current = previous[conversationId]; return current ? { ...previous, [conversationId]: { ...current, messages: mergeConversationMessages(current.messages, [...(result.questionMessages ?? []), ...(result.questionMessage ? [result.questionMessage] : []), result.message]) } } : previous; });
        setDrafts(previous => previous[originalKey]?.trim() === content ? { ...previous, [originalKey]: '' } : previous);
        setReplyDrafts(previous=>previous[originalKey]===submittedReply?{...previous,[originalKey]:''}:previous);
        return;
      }
      const cid = await ensureInputConversation(aid,originalKey,conversationId);
      const result = await api<{ run: Run; message: Message;inputMessage?:Message }>(`/conversations/${cid}/messages`, 'POST', { content, ...(submittedReply?{replyToId:submittedReply}:{}), attachmentIds:submittedIds,routeMode, accountId:accountId||null, mode: effMode, model: routeMode === 'auto' ? '' : model });
      setSessions(previous=>{const current=previous[cid];return current?{...previous,[cid]:{...current,messages:mergeConversationMessages(current.messages,[...(result.inputMessage?[result.inputMessage]:[]),result.message]),runs:[...current.runs.filter(r=>r.id!==result.run.id),result.run]}}:previous;});
      setReplyDrafts(previous=>previous[originalKey]===submittedReply?{...previous,[originalKey]:''}:previous);
      for(const id of submittedIds)committedAttachments.current.add(id);
      setDrafts(previous=>{const key=resolveDraftKey(originalKey);return previous[key]===submittedText&&(draftRevisions.current.get(key)??0)===submittedRevision?{...previous,[key]:''}:previous;});
      setAttachmentDrafts(previous=>({...previous,[cid]:(previous[cid]??[]).filter(a=>!submittedIds.includes(a.id))}));
      setActivities(prev => ({ ...prev, [cid]: 'Choosing a route…' }));
      listen(result.run);
      try{const conversation=await api<ConversationData>('/conversations/'+cid);setSessions(prev=>({...prev,[cid]:conversation}));await reload();}catch(e){setError('Message sent; conversation refresh failed. '+(e as Error).message);}
    } catch (e) { setError((e as Error).message); } finally { setSending(false); }
  }
  async function mutateAgent(patch: Partial<Agent>) {
    if (!agent) return;
    await api(`/agents/${agent.id}`, 'PATCH', patch); await reload(); await loadAgent(agent.id);
  }
  async function upload(list: FileList | null) {
    if (!list || !agent) return;
    const selectedTerminalIntent=terminalIntent.current;
    setUploading(true); setError('');
    try {
      for (const file of Array.from(list)) {
        if (!/\.(txt|md|json|csv)$/i.test(file.name)) throw new Error('Choose a .txt, .md, .json, or .csv text file.');
        if (file.size > 200_000) throw new Error(`${file.name} exceeds the 200 KB file limit.`);
        await api(`/agents/${agent.id}/files`, 'POST', { name: file.name, content: await file.text() });
      }
      await loadAgent(agent.id); await reload(); setTab('library'); if (advanced&&selectedTerminalIntent===terminalIntent.current&&!terminalSelection.current) showProfile();
    } catch (e) { setError((e as Error).message); } finally { setUploading(false); if (uploadRef.current) uploadRef.current.value = ''; }
  }
  const closeDialog = () => { setDialog(null); setEditorAgentId(''); };
  const dictationControl = !secureCredentialPending&&agent&&<VoiceInput scopeKey={agentId+':'+draftKey} onTranscript={text=>{const key=resolveDraftKey(draftKey);draftRevisions.current.set(key,(draftRevisions.current.get(key)??0)+1);setDrafts(previous=>({...previous,[key]:((previous[key]??'')+((previous[key]??'')?' ':'')+text).slice(0,16000)}));}}/>;

  return <div className={`app-shell ${advanced ? 'advanced-mode' : 'simple-mode'} ${profileVisible ? 'inspector-visible' : ''}`}>
    {appearanceError && dialog!=='settings' && <div className="appearance-save-error form-error" role="alert">{appearanceError}</div>}
    {runtimeStatus && <div className="runtime-connection" role="status" style={{ position: 'fixed', zIndex: 1000, bottom: 12, left: '50%', transform: 'translateX(-50%)', maxWidth: 'min(90vw, 640px)', padding: '10px 16px', border: '1px solid var(--line)', borderRadius: 12, background: 'var(--surface)', color: 'var(--text)', fontSize: 13 }}>{runtimeStatus}</div>}
    {rosterOpen && <div className="mobile-shade" onClick={closeRoster}/>}
    <aside aria-label="Workspace navigation" className={`roster ${rosterOpen ? 'mobile-open' : ''}`}>
      <div className="brand-row"><a className="brand" href="/" aria-label="Relay home"><span className="brand-mark"><RelayMark/></span>Relay{advanced && <span className="local-label">LOCAL</span>}</a><div className="brand-actions"><AppearanceControl icon preference={appearance} pending={appearancePending} onChange={value=>void saveAppearance(value)}/>{!advanced && <IconButton label={searchOpen ? 'Close search' : 'Search chats'} onClick={() => { setSearchOpen(value => !value); if (searchOpen) setSearch(''); else requestAnimationFrame(() => searchRef.current?.focus()); }}><Search size={17}/></IconButton>}<IconButton label="Create bot" onClick={() => setDialog('create')}><Plus size={19}/></IconButton><IconButton label="Close workspace navigation" className="roster-close" onClick={closeRoster}><X size={18}/></IconButton></div></div>
      {advanced && <div className="roster-label">AGENTS <span>{bootstrap?.agents.length || '—'}</span></div>}
      <div className="roster-search" hidden={!advanced && !searchOpen}><Search size={14}/><input ref={searchRef} aria-label="Search agents and discussions" placeholder="Search workspace" value={search} onChange={e => setSearch(e.target.value)}/><span>/</span></div>
      <div className="agent-list">{bootstrap?.agents.filter(a => `${a.name} ${a.role}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => Number(b.pinned) - Number(a.pinned)).map(a => <button key={a.id} className={`agent-row ${a.id === agentId && !roomId && !dispatcherOpen ? 'selected' : ''}`} onClick={() => { setDispatcherOpen(false); setWorkspaceOpen(false); setRoomId(''); setAgentId(a.id); closeRoster(); }}><Avatar agent={a}/><span className="agent-row-text"><span className="agent-row-title"><strong>{a.name}{advanced && a.pinned && <Pin size={11} className="agent-pin" aria-label="Pinned"/>}</strong>{advanced && <span className="role-badge">{a.role}</span>}</span>{a.lastMessage && <span className="preview">{a.lastMessage}</span>}</span>{a.unread && <span className="unread-dot" aria-label="Unread messages"/>}</button>)}{bootstrap && !bootstrap.agents.filter(a => `${a.name} ${a.role}`.toLowerCase().includes(search.toLowerCase())).length && <p className="list-empty">{advanced ? 'No agents found.' : 'No bots found.'}</p>}</div>
      <section className="discussion-roster" aria-label="Discussions"><div className="section-heading"><span>{advanced ? 'DISCUSSIONS' : 'Groups'}</span><IconButton label={advanced ? 'Create discussion' : 'Create group'} onClick={() => setDialog('group-create')}><Plus size={14}/></IconButton></div><div className="discussion-room-list">{bootstrap?.rooms.filter(room => room.title.toLowerCase().includes(search.toLowerCase())).map(room => <button className={`discussion-room-row ${room.id === roomId ? 'selected' : ''}`} key={room.id} onClick={() => { setDispatcherOpen(false); setWorkspaceOpen(false); setRoomId(room.id); closeRoster(); }}><Users size={15}/><span><strong>{room.title}</strong>{advanced && <small>{room.agentIds.length} participants{room.mode === 'delegated' ? ' · lead & workers' : room.mode === 'moderated' ? ' · moderated' : ''}</small>}</span></button>)}</div><button hidden={!advanced} className="create-discussion-button" onClick={() => setDialog('group-create')} disabled={!bootstrap || bootstrap.agents.length < 2}><Plus size={13}/>Create discussion</button></section>
      <button className={`workspace-entry ${dispatcherOpen ? 'selected' : ''}`} onClick={()=>{setDispatcherOpen(true);setWorkspaceOpen(false);setRoomId('');closeRoster();}}><Sparkles size={17}/><span>Boss Chat</span></button>
      <button className={`workspace-entry ${workspaceOpen ? 'selected' : ''}`} onClick={()=>{setDispatcherOpen(false);setWorkspaceOpen(true);closeRoster();}}><Clock3 size={17}/><span>Tasks & workspace</span></button>
      <button ref={terminalOpenerRef} type="button" className={`workspace-entry terminal-entry ${terminalVisible?'selected':''}`} aria-label="Open terminal" aria-expanded={terminalVisible} aria-controls="operator-terminal-panel" onClick={openTerminal}><Terminal size={17}/><span>Terminal</span></button>
      <div className="roster-bottom"><div className="roster-settings-actions"><button className="sidebar-settings" onClick={() => setDialog('settings')}><Settings2 size={17}/><span>Settings</span></button><IconButton label="Connect your phone" className="sidebar-phone" onClick={() => setDialog('phone')}><Smartphone size={17}/></IconButton></div><button type="button" className="advanced-toggle" role="switch" aria-checked={advanced} onClick={() => setAdvanced(value => !value)}><span>Advanced</span><span className="toggle-track"><span/></span></button></div>
    </aside>

    {dispatcherOpen&&bootstrap&&<Dispatcher api={api} agents={bootstrap.agents} computers={registeredComputers(bootstrap)} onOpenRoster={openRoster} onOpenWork={(aid,cid)=>{requestedConversation.current={agentId:aid,id:cid};setRoomId('');setAgentId(aid);setConversationId(cid);setDispatcherOpen(false);void reload();}}/>}
    {workspaceOpen&&bootstrap&&<Workspace api={api} bootstrap={bootstrap} advanced={advanced} onBack={()=>setWorkspaceOpen(false)} onAccounts={()=>setDialog('settings')} onConversation={(aid,cid)=>{requestedConversation.current={agentId:aid,id:cid};setRoomId('');setAgentId(aid);setConversationId(cid);setWorkspaceOpen(false);void reload();}}/>}
    <main className="conversation-pane" data-attachment-input="direct-chat-attachments" style={{ display: roomId || workspaceOpen || dispatcherOpen ? 'none' : undefined }}>
      <header className="chat-header"><div className="chat-heading"><IconButton label="Open agent roster" className="mobile-menu" onClick={openRoster}><Menu size={19}/></IconButton>{agent && <><Avatar agent={agent}/><div><strong>{agent.name}</strong>{advanced && <span>{agent.role}</span>}</div></>}</div><div className="header-actions">{browserScope&&<button ref={browserOpenerRef} type="button" className="browser-toggle" aria-label="Open bot browser" aria-expanded={browserVisible} aria-controls="bot-browser-panel" onClick={()=>{if(browserVisible)closeBrowser();else{setTerminalOpen(false);setProfileOpen(false);browserWatch.show();}}}><PanelRight size={15}/><span>Browser</span>{!browserVisible&&browserWatch.status?.running&&<span className="browser-activity-dot" aria-label="Browser active"/>}</button>}{advanced ? <><span className={'chat-mode mode-' + displayMode} title={modeDescription}><span/>{modeLabel(displayMode)}{workingRun ? ' · running' : ' mode'}</span><IconButton label="Conversation history" onClick={() => setDialog('history')}><History size={18}/></IconButton><IconButton label="New conversation" onClick={newConversation}><MessageSquare size={18}/></IconButton><IconButton label="Toggle agent profile" className={profileOpen ? 'is-active' : ''} onClick={toggleProfile}><PanelRight size={18}/></IconButton></> : (displayMode === 'agent' || displayMode === 'work' || displayMode === 'auto' && hasWorkspace) && <button type="button" className="simple-tool-status" title={modeDescription + ' Edit bot to change access.'} onClick={() => setDialog('edit')}>{displayMode === 'agent' ? 'Agent mode' : displayMode === 'work' ? 'Tools on' : 'Auto tools'}</button>}<IconButton label="Chat options" onClick={() => setDialog('options')}><MoreHorizontal size={20}/></IconButton></div></header>
      {error && <div role="alert" className="error-banner"><Info size={16}/><span>{error}</span><IconButton label="Dismiss error" onClick={() => setError('')}><X size={15}/></IconButton></div>}
      <div className="chat-scroll" ref={chatScrollRef} onScroll={event => { const scroll = event.currentTarget; followLatest.current = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80; setShowLatest(!followLatest.current && !!session?.messages.length); }}><div className={`chat-content ${!session?.messages.length ? 'empty-content' : ''}`}>
        {!bootstrap ? <div className="loading-state"><LoaderCircle className="spin" size={22}/><p>{error ? 'Workspace unavailable' : 'Opening your workspace…'}</p>{error && <button className="secondary" onClick={() => { setError(''); void reload().catch(e => setError(e.message)); }}>Try again</button>}</div> : !agent ? <div className={advanced ? "welcome" : "simple-empty"}>{advanced && <span className="welcome-kicker">YOUR WORKSPACE</span>}<h1>Create your first bot</h1><p>Give it a name and tell it how to help.</p><button className="primary" onClick={() => setDialog('create')}><Plus size={16}/>Create bot</button></div> : !session?.messages.length ? !advanced ? <div className="simple-empty"><h1>Message {agent.name}</h1><p>Ask a question, create a bot, or bring a group together.</p></div> : <div className="welcome"><span className="welcome-kicker">NEW CONVERSATION</span><h1>What are we working on?</h1><p>Ask {agent.name} a question, share context, or start with a task below.</p><div className="suggestions">{[{ icon: Sparkles, title: 'Plan a task', body: 'Help me turn an idea into a practical plan. Start by asking what I want to accomplish.' }, { icon: FileText, title: 'Draft a brief', body: 'Help me draft a concise brief. Ask me for the audience, goal, and context.' }, { icon: CircleHelp, title: 'Review a decision', body: 'Help me review a decision. Ask me about the options, constraints, and tradeoffs.' }].map(s => <button key={s.title} onClick={() => { setDrafts(prev => ({ ...prev, [draftKey]: s.body })); composerRef.current?.focus(); }}><s.icon size={17}/><strong>{s.title}</strong><span>{s.body}</span><ArrowUpRight size={14} className="suggestion-arrow"/></button>)}</div>{!canRoute && <button className="onboarding-callout" onClick={() => setDialog('settings')}><span className="callout-icon"><ShieldCheck size={19}/></span><span><strong>{discovering ? 'Checking your accounts…' : modelHelp}</strong><small>Sign-in, usage permission and enabled models are separate. Auto uses only accounts you allow.</small></span><ChevronRight size={17}/></button>}<div className="welcome-footnote"><span className="tiny-status"/> History and files stored on this computer</div></div> : <><div className="conversation-date"><span/>{shortDate(session.conversation.createdAt)}<span/></div>{session.messages.filter(message => message.origin!=='task-continuation' && !Object.values(interactions.entries).some(entry => entry.runId === workingRun?.id && entry.status === 'pending' && message.id === 'question-' + entry.id)).map(message => <article key={message.id} id={messageAnchor(conversationId,message.id)} tabIndex={-1} aria-label={message.role==='user'?'Message from you':'Message from '+agent.name} className={`message ${message.role}`}><div className="message-meta">{message.role === 'assistant' && <Avatar agent={agent}/>}<strong>{message.role === 'user' ? 'You' : agent.name}</strong><time>{new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></div><div className={`message-bubble ${message.status === 'error' ? 'message-error' : ''}`}>{message.replyToId && <MessageReply author={session.messages.find(item=>item.id===message.replyToId)?.role==='user'?'You':agent.name} message={session.messages.find(item=>item.id===message.replyToId&&item.origin!=='task-continuation')} onJump={()=>jumpToReply(message.replyToId!)}/>} {message.content ? <RichText content={message.content}/> : (message.status === 'streaming' ? <span className="stream-cursor"/> : message.status === 'cancelled' ? 'Response stopped.' : 'No response was returned.')}{message.status === 'streaming' && message.content && <span className="stream-cursor"/>}<MessageAttachments attachments={message.attachments} basePath={'/api/conversations/'+message.conversationId+'/attachments'}/></div>{advanced && message.role === 'assistant' && runs.find(r => r.id === message.runId)?.mode && <div className="run-mode-note">{modeLabel(runs.find(r => r.id === message.runId)!.mode!)} mode</div>}{advanced && message.role === 'assistant' && message.runId && !!tools[message.runId]?.length && <ToolLines items={tools[message.runId]} collapsed={!advanced}/>}{advanced && message.role === 'assistant' && <RunUsage run={runs.find(r => r.id === message.runId)} advanced={advanced}/>}{advanced&&message.role==='assistant'&&message.runId&&message.id===runs.at(-1)?.messageId&&<TaskProgress task={taskProgress.find(task=>task.runIds.includes(message.runId!))}/>} {message.status === 'error' && runs.find(r => r.id === message.runId)?.error && <div className="message-run-error" role="alert">{runs.find(r => r.id === message.runId)?.error}</div>}{message.status === 'cancelled' && message.content && <div className="message-note">Stopped</div>}{message.status !== 'streaming' && <div className="message-actions"><button type="button" className="message-reply" aria-label={'Reply to '+(message.role==='user'?'your message':agent.name)} title={workingRun&&!pendingInteractions?'Wait for this response to finish before replying':'Reply'} disabled={secureCredentialPending||!!workingRun&&!pendingInteractions} onClick={()=>selectReply(message)}><Reply size={15}/><span className="sr-only">Reply</span></button>{message.role==='assistant' && message.content && <button className="message-copy" aria-label={copiedMessage === message.id ? 'Response copied' : 'Copy response'} title={copiedMessage === message.id ? 'Copied' : 'Copy response'} onClick={() => void copyMessage(message)}>{copiedMessage === message.id ? <Check size={13}/> : <Copy size={13}/>}<span role="status">{copiedMessage === message.id ? 'Copied' : 'Copy'}</span></button>}</div>}</article>)}</>}
        {!roomId&&!workspaceOpen&&!dispatcherOpen&&conversationId&&<AssignmentActivity source={{kind:'conversation',id:conversationId}} api={api}/>}
        {!advanced&&currentTask&&needsTaskAttention(currentTask)&&<div className="task-attention" role="alert"><strong>Current task · {currentTask.title}{currentTask.recoveryRequired?' · Recovery required':''}: </strong>{currentTask.error||currentTask.outcome?.remaining.join(' · ')||'This task needs your attention. Open Workspace to review its progress.'}</div>}
        {!advanced&&earlierAttention.length>0&&<button type="button" className="task-attention task-history-review" onClick={()=>setWorkspaceOpen(true)}>{earlierAttention.length} earlier task{earlierAttention.length===1?' needs':'s need'} review{earlierRecovery>0?` · ${earlierRecovery} ${earlierRecovery===1?'requires':'require'} recovery`:''}</button>}
        {workingRun && !roomId && !workspaceOpen && !dispatcherOpen && <RunInteractions runId={workingRun.id} state={interactions} resetKey={bootstrap?.csrfToken} returnFocus={() => requestAnimationFrame(() => composerRef.current?.focus({ preventScroll: true }))}/>}
        {(workingRun || currentTaskChecking) && <div className="activity" role="status"><span className="working-dots"><i/><i/><i/></span><span>{pendingInteractions ? 'Waiting for your response…' : currentTaskChecking ? 'Running checks…' : advanced ? activities[conversationId] || 'Working…' : /interrupted|reconnect/i.test(activities[conversationId] || '') ? 'Reconnecting…' : inferenceWaitingMessage(activities[conversationId]) || (activities[conversationId] === INFERENCE_STATUS.admitted ? INFERENCE_STATUS.admitted : workingRun&&tools[workingRun.id]?.length ? 'Using tools…' : 'Thinking…')}</span></div>}{workingRun && advanced && !session?.messages.some(m => m.role === 'assistant' && m.runId === workingRun.id) && !!tools[workingRun.id]?.length && <ToolLines items={tools[workingRun.id]} collapsed={!advanced}/>}<div ref={bottomRef}/>
      </div></div>
      {showLatest && <div className="jump-latest-wrap"><button className="jump-latest" onClick={jumpToLatest}><ArrowDown size={14}/>Jump to latest</button></div>}
      <div className="composer-area"><div className="composer-inner">
        {!advanced && agent && !canRoute && <button type="button" className="simple-setup-action" title={modelHelp} onClick={() => setDialog(agentSetupNeeded || nativeAgentSetupNeeded ? 'edit' : 'settings')}>{nativeAgentSetupNeeded ? modelHelp : selectedProvider?.inferenceAvailable === false ? 'Unavailable · review setup' : agentSetupNeeded ? 'Configure Agent mode' : discovering ? 'Checking accounts…' : accountsConnected ? modelHelp : 'Finish setup to chat'}<ChevronRight size={13}/></button>}
        {advanced && files.length > 0 && <button className="context-chip" onClick={() => { setTab('library'); showProfile(); }}><FileText size={13}/>{files.length} library file{files.length !== 1 ? 's' : ''} included<ChevronRight size={13}/></button>}
        {replyToId&&<MessageReply author={replyTarget?.role==='user'?'You':agent?.name||'bot'} message={replyTarget} onCancel={clearReply}/>}
        <AttachmentChips attachments={attachmentDrafts[draftKey]??[]} basePath={'/api/conversations/'+conversationId+'/attachments'} disabled={sending} onRemove={id=>void api('/conversations/'+conversationId+'/attachments/'+id,'DELETE').then(()=>setAttachmentDrafts(previous=>({...previous,[draftKey]:(previous[draftKey]??[]).filter(a=>a.id!==id)}))).catch(e=>setError(e.message))}/>
        {attaching&&<small role="status">Validating and extracting attachment…</small>}
        {workingRun&&!assignmentDraft&&!!attachmentDrafts[draftKey]?.length&&<small role="status">Attachments are kept for your next message. Replies to this active run send text only.</small>}
        {!advanced ? <div className="composer simple-composer"><IconButton label="Attach image or document" disabled={!agent || attaching || !!workingRun&&!assignmentDraft || secureCredentialPending} onClick={() => attachmentInput.current?.click()}>{attaching ? <LoaderCircle size={18} className="spin"/> : <Plus size={20}/>}</IconButton><MentionTextarea agents={bootstrap?.agents??[]} computers={registeredComputers(bootstrap)} scopeKey={draftKey+":"+String(!!(roomId||workspaceOpen||dispatcherOpen))} onMentionChange={text=>editDraft(draftKey,text)} ref={composerRef} onPaste={pasteImage} onKeyDownCapture={event=>{if(event.key==='Escape'&&replyToId){event.preventDefault();event.stopPropagation();clearReply();}}} aria-label={agent ? 'Message ' + agent.name : 'Message'} placeholder={secureCredentialPending?'Use the secure entry above':workingRun ? pendingInteractions ? humanApprovalPending ? 'Type approve or no' : 'Reply here…' : 'Working… type stop to cancel' : checkStopRunId ? 'Running checks… type stop to cancel' : agent ? 'Message ' + agent.name : 'Create a bot to begin'} value={draft} maxLength={16000} disabled={!agent || secureCredentialPending} rows={1} onChange={event => { editDraft(draftKey,event.target.value); event.target.style.height = 'auto'; event.target.style.height = Math.min(event.target.scrollHeight, 160) + 'px'; }} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }}/><div className="composer-actions">{dictationControl}{stopRunId && (secureCredentialPending || !draft.trim()) ? <button type="button" className="send-button stop" aria-label="Stop response" title="Stop response" onClick={() => void api('/runs/' + stopRunId + '/cancel', 'POST', {}).catch(e => setError(e.message))}><Square size={14} fill="currentColor"/></button> : <button type="button" className="send-button" aria-label="Send message" title={checkStopRequested ? 'Stop checks' : !canRoute ? modelHelp : 'Send message'} disabled={secureCredentialPending || (!draft.trim()&&!attachmentDrafts[draftKey]?.length) || attaching || !agent || (!assignmentDraft && !workingRun && !canRoute && !checkStopRequested) || sending} onClick={() => void send()}>{sending ? <LoaderCircle size={18} className="spin"/> : <ArrowUp size={20}/>}</button>}</div></div> : <div className="composer">
          <MentionTextarea agents={bootstrap?.agents??[]} computers={registeredComputers(bootstrap)} scopeKey={draftKey+":"+String(!!(roomId||workspaceOpen||dispatcherOpen))} onMentionChange={text=>editDraft(draftKey,text)} ref={composerRef} onPaste={pasteImage} onKeyDownCapture={event=>{if(event.key==='Escape'&&replyToId){event.preventDefault();event.stopPropagation();clearReply();}}} aria-label={agent ? 'Message ' + agent.name : 'Message'} placeholder={secureCredentialPending?'Use secure TypeSafe entry above':workingRun ? pendingInteractions ? humanApprovalPending ? 'Type approve or no' : 'Reply here…' : 'Working… type stop to cancel' : checkStopRunId ? 'Running checks… type stop to cancel' : agent ? 'Message ' + agent.name + '…' : 'Create an agent to begin…'} value={draft} maxLength={16000} disabled={!agent || secureCredentialPending} rows={2} onChange={e => { editDraft(draftKey,e.target.value); e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px'; }} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}/>
          <div className="composer-tools">
            <div className="composer-options">
              <IconButton label="Attach image or document" disabled={!agent || attaching || !!workingRun&&!assignmentDraft || secureCredentialPending} onClick={() => attachmentInput.current?.click()}>{attaching ? <LoaderCircle size={17} className="spin"/> : <Plus size={18}/>}</IconButton>
              <div className="composer-control"><span className="composer-control-label">Mode</span><div className="mode-switch" role="group" aria-label="Conversation mode">{(['chat', 'work', 'agent', 'auto'] as const).map(m => <button type="button" key={m} aria-pressed={effMode === m} className={effMode === m ? 'selected' : ''} disabled={m === 'work' && !hasWorkspace} title={m === 'work' && !hasWorkspace ? 'Set a workspace folder in Edit bot to enable ' + modeLabel(m) + ' mode' : m === 'agent' ? 'Manage bots and groups · optional project tools' : m === 'chat' ? 'Text only, tools off' : m === 'work' ? 'Tools run from the workspace folder without approval prompts' : 'Pick Chat or Work per message'} onClick={() => setChatMode(m)}>{modeLabel(m)}</button>)}</div></div>
              <label className="composer-control provider-control"><span className="composer-control-label">Provider</span><select aria-label="Provider route" value={routeMode} onChange={e => { setRouteMode(e.target.value as RouteMode); setAccountId(''); setModel(''); }}><option value="auto">Auto route</option><option value="openai">OpenAI</option><option value="claude">Claude</option><option value="cursor">Cursor</option><option value="opencode">OpenCode · native Agent</option></select></label>
              <AccountChoice api={api} value={accountId} provider={routeMode==='openai'||routeMode==='claude'||routeMode==='cursor'?routeMode:undefined} onChange={item=>{setAccountId(item?.accountId??'');if(item&&routeMode!=='auto')setRouteMode(item.id);setModel('');}}/><label className="composer-control model-control"><span className="composer-control-label">Model</span><ModelPicker provider={selectedProvider} auto={routeMode === 'auto'} value={model} onChange={setModel} compact label="Conversation model"/></label>
            </div>
            <div className="composer-actions">{dictationControl}{stopRunId && (secureCredentialPending || !draft.trim()) ? <button className="send-button stop" aria-label="Stop response" title="Stop response" onClick={() => void api('/runs/' + stopRunId + '/cancel', 'POST', {}).catch(e => setError(e.message))}><Square size={13} fill="currentColor"/>Stop</button> : <button className="send-button" title={checkStopRequested ? 'Stop checks' : !canRoute ? modelHelp : 'Send message · Enter'} disabled={secureCredentialPending || (!draft.trim()&&!attachmentDrafts[draftKey]?.length) || attaching || !agent || (!assignmentDraft && !workingRun && !canRoute && !checkStopRequested) || sending} onClick={() => void send()}>{sending ? <LoaderCircle size={16} className="spin"/> : <ArrowUp size={17}/>}{sending ? 'Sending' : 'Send'}</button>}</div>
          </div>
        </div>}
        {advanced && <div className="composer-caption"><span>{!canRoute ? <button onClick={() => setDialog(agentSetupNeeded || nativeAgentSetupNeeded ? 'edit' : 'settings')}>{modelHelp}</button> : latestRoute ? providerName(latestRoute.provider) + ' · ' + latestRoute.model : 'Enter to send · Shift + Enter for a new line'}</span><span>{effMode === 'chat' ? 'Chat · tools off' : effMode === 'agent' ? 'Agent · app tools on' : effMode === 'work' ? 'Work · tools on · no approval prompts' : hasWorkspace ? 'Auto · chooses Chat or Work' : 'Auto · Chat only'}{!hasWorkspace && <> · <button onClick={() => setDialog('edit')}>Set workspace</button></>}</span></div>}
      </div></div>
    </main>
    {browserScope&&browserVisible&&agent&&<BrowserPanel key={agentId} api={api} agentId={agentId} agentName={agent.name} open onClose={closeBrowser} onStatus={browserWatch.observe} disconnected={!!runtimeStatus}/> }
    <TerminalPanel api={api} open={terminalVisible} onClose={closeTerminal} startAgentId={!roomId&&!workspaceOpen?agent?.id:undefined} disconnected={!!runtimeStatus}/>

    {profileVisible && !roomId && <div className="profile-mobile-shade" onClick={closeProfile}/>}
    <aside className={`profile-pane ${profileVisible ? 'profile-open' : ''}`} aria-label="Agent profile" style={{ display: workspaceOpen || dispatcherOpen || roomId || !advanced ? 'none' : undefined }}>{agent && <><div className="profile-top-actions"><IconButton label={agent.pinned ? 'Unpin agent' : 'Pin agent'} onClick={() => void mutateAgent({ pinned: !agent.pinned }).catch(e => setError(e.message))}><Pin size={16} fill={agent.pinned ? 'currentColor' : 'none'}/></IconButton><IconButton label="Edit agent" onClick={() => setDialog('edit')}><MoreHorizontal size={20}/></IconButton><IconButton label="Close agent profile" className="profile-close" onClick={closeProfile}><X size={18}/></IconButton></div><div className="profile-identity"><Avatar agent={agent} large/><h2>{agent.name}</h2><span>{agent.role}</span><span className="profile-status">Agent configuration</span></div><nav className="profile-tabs" role="tablist" aria-label="Agent sections">{(['details', 'library', 'computer'] as const).map(t => <button key={t} aria-selected={tab === t} role="tab" className={tab === t ? 'selected' : ''} onClick={() => setTab(t)}>{t === 'computer' ? 'Activity' : t[0].toUpperCase() + t.slice(1)}</button>)}</nav><div className="profile-content">{tab === 'details' ? <><div className="section-heading"><span>ABOUT THIS AGENT</span><button onClick={() => setDialog('edit')} aria-label="Edit agent details"><Pencil size={13}/></button></div><p className="profile-description">{agent.instructions || 'Give this agent instructions to shape how it thinks, writes, and helps you.'}</p><div className="detail-section"><span className="section-label">ROUTING</span><div className="route-card"><span className="route-card-icon"><Zap size={15}/></span><div><strong>{latestRoute ? providerName(latestRoute.provider) : routeMode === 'auto' ? 'Automatic' : providerName(routeMode)}</strong><span>{latestRoute?.model || model || 'Provider default'}</span></div></div><p className="subtle-text">{latestRoute?.reason || 'Auto chooses from your connected, confirmed accounts. A manual selection takes priority.'}</p></div><div className="detail-section"><div className="section-heading"><span>MEMORY</span><button onClick={() => setDialog('edit')} aria-label="Edit agent memory"><Pencil size={13}/></button></div><p className="memory-text">{agent.memory || 'Add preferences or background to include in every conversation.'}</p></div><div className="profile-note"><ShieldCheck size={15}/><span>Chats and files stay in this local workspace. Your selected provider processes each request.</span></div></> : tab === 'library' ? <><div className="section-heading"><span>AGENT CONTEXT</span><span>{files.length} FILES</span></div><p className="subtle-text">Text files in this library are included as context with this agent’s messages.</p><button className="upload-button" disabled={uploading} onClick={() => uploadRef.current?.click()}><Upload size={16}/>{uploading ? 'Adding files…' : 'Add text files'}<span>TXT, MD, JSON, CSV · up to 200 KB</span></button><div className="file-list">{files.map(file => <div className="file-row" key={file.id}><FileText size={19}/><div><strong title={file.name}>{file.name}</strong><span>{Math.max(1, Math.round(file.size / 1000))} KB · {shortDate(file.createdAt)}</span></div><IconButton label={`Remove ${file.name}`} onClick={() => void api(`/agents/${agentId}/files/${file.id}`, 'DELETE').then(() => loadAgent(agentId)).then(() => reload()).catch(e => setError(e.message))}><Trash2 size={14}/></IconButton></div>)}{!files.length && <div className="sidebar-empty"><FileText size={27}/><strong>No files yet</strong><span>Add a brief, reference notes, or useful background.</span></div>}</div></> : <><div className="computer-card"><Terminal size={22}/><strong>{modeLabel(displayMode)} mode{workingRun ? ' · running' : ''}</strong><p>{modeDescription}</p>{hasWorkspace && <code className="workspace-path">{agent.workspace}</code>}<span className="read-only-badge"><ShieldCheck size={13}/>{displayMode === 'agent' ? 'App tools enabled · native tools depend on the provider and folder' : displayMode === 'work' ? 'Tools enabled without approvals' : displayMode === 'auto' && hasWorkspace ? 'Tools depend on the message' : 'Execution tools off'}</span></div><div className="section-heading"><span>THIS CONVERSATION</span><Clock3 size={13}/></div>{!runs.length ? <p className="subtle-text">Runs will appear here when you send a message.</p> : <div className="run-list">{[...runs].reverse().map(run => <div className="run-row" key={run.id}><span className={`run-dot ${run.status}`}/><div><strong>{run.route ? providerName(run.route.provider) : 'Routing'}{run.mode ? ` · ${modeLabel(run.mode)}` : ''}</strong><span>{run.route?.model || 'Choosing a model'}</span><RunUsage run={run} advanced/>{run.error && <p className="run-error">{run.error}</p>}</div><span>{run.status}</span></div>)}</div>}</>}</div></>}</aside>
    {bootstrap && !workspaceOpen && !dispatcherOpen && <GroupWorkspace advanced={advanced} openOptions={() => setDialog('options')} bootstrap={bootstrap} roomId={roomId} api={api} reload={reload} openRoster={openRoster} openSettings={() => setDialog('settings')} profileOpen={profileVisible} toggleProfile={toggleProfile} editAgent={item => { setEditorAgentId(item.id); setDialog('edit'); }}/>}
    {dialog === 'group-create' && bootstrap && <CreateDiscussion advanced={advanced} bootstrap={bootstrap} api={api} reload={reload} close={closeDialog} created={id => { setRoomId(id); setRosterOpen(false); closeDialog(); }}/>}
    <input id="direct-chat-attachments" aria-label="Message attachment files" type="file" accept=".png,.jpg,.jpeg,.webp,.txt,.pdf,.docx" multiple hidden ref={attachmentInput} onChange={e=>void attachInput(e.target.files)}/>
    <input type="file" accept=".txt,.md,.json,.csv" multiple hidden ref={uploadRef} onChange={e => void upload(e.target.files)}/>

    {(dialog === 'create' || dialog === 'edit') && <AgentEditor homeDirectory={bootstrap?.homeDirectory} advanced={advanced} api={api} providers={bootstrap?.accounts || bootstrap?.providers || []} agent={dialog === 'edit' ? bootstrap?.agents.find(item => item.id === (editorAgentId || agentId)) : undefined} close={closeDialog} save={async values => { if (dialog === 'edit') { const id = editorAgentId || agentId; await api(`/agents/${id}`, 'PATCH', values); await reload(); await loadAgent(id); } else { const created = await api<Agent>('/agents', 'POST', { name: values.name, role: values.role, instructions: values.instructions, color: values.color }); await reload(); setRoomId(''); setAgentId(created.id); } closeDialog(); }} />}
    {dialog === 'options' && <Modal title={roomId ? 'Group options' : 'Chat options'} close={closeDialog} initialFocus="dialog"><div className="chat-options">
      {roomId && !workspaceOpen && bootstrap && <div className="chat-options-members">{bootstrap.rooms.find(room => room.id === roomId)?.agentIds.map(id => { const member = bootstrap.agents.find(item => item.id === id); const room = bootstrap.rooms.find(item => item.id === roomId); return member && <div key={id}><Avatar agent={member}/><span><strong>{member.name}</strong><small>{member.role}{room?.moderatorAgentId === id ? room.mode === 'delegated' ? ' · Lead' : ' · Moderator' : ''}</small></span></div>; })}</div>}
      {!roomId && <><button onClick={() => void newConversation()}><MessageSquare size={17}/>New chat</button><button onClick={() => setDialog('history')}><History size={17}/>Chat history</button><button disabled={!agent} onClick={() => setDialog('edit')}><Pencil size={17}/>Edit bot</button><button disabled={!agent} onClick={() => setDialog('files')}><FileText size={17}/>Files{files.length > 0 && <span className="option-value">{files.length}</span>}</button></>}
      <button onClick={() => setDialog('network')}><Users size={17}/>Devices & computers</button><button onClick={() => setDialog('settings')}><Settings2 size={17}/>Settings</button><button onClick={() => { setAdvanced(value => !value); closeDialog(); }}><PanelRight size={17}/>{advanced ? 'Turn off Advanced mode' : 'Turn on Advanced mode'}</button>
    </div></Modal>}
    {dialog === 'files' && agent && <Modal title={'Files for ' + agent.name} close={closeDialog}><div className="files-dialog"><p className="subtle-text">These files are included when you message {agent.name}.</p><button className="secondary" disabled={uploading} onClick={() => uploadRef.current?.click()}><Plus size={16}/>{uploading ? 'Adding files…' : 'Add text files'}</button><div className="file-list">{files.map(file => <div className="file-row" key={file.id}><FileText size={18}/><div><strong>{file.name}</strong><span>{Math.max(1, Math.round(file.size / 1000))} KB</span></div><IconButton label={'Remove ' + file.name} onClick={() => void api('/agents/' + agentId + '/files/' + file.id, 'DELETE').then(() => loadAgent(agentId)).then(() => reload()).catch(e => setError(e.message))}><Trash2 size={16}/></IconButton></div>)}</div>{!files.length && <p className="subtle-text">No files yet. Add a TXT, MD, JSON, or CSV file up to 200 KB.</p>}{error && <p className="form-error" role="alert">{error}</p>}</div></Modal>}
    {dialog === 'history' && <Modal title="Conversations" close={closeDialog}><button className="new-conversation-button" onClick={newConversation}><Plus size={17}/>Start a new conversation</button><div className="history-list">{conversations.map(c => <button key={c.id} className={c.id === conversationId ? 'selected' : ''} onClick={() => { if (selectedRef.current.agentId === c.agentId) { setConversationId(c.id); setDialog(null); } }}><MessageSquare size={17}/><div><strong>{c.title || 'New conversation'}</strong><span>{shortDate(c.updatedAt)}</span></div>{c.id === conversationId && <Check size={16}/>}</button>)}{!conversations.length && <p className="subtle-text">Your conversations with {agent?.name} will appear here.</p>}</div></Modal>}
    {dialog==='phone'&&<Modal title="Connect your phone" close={closeDialog} initialFocus="dialog"><NetworkPanel api={api} phoneOnly/></Modal>}
    {dialog==='network'&&<Modal title="Devices & computers" close={closeDialog} wide><NetworkPanel api={api}/></Modal>}
    {dialog === 'settings' && bootstrap && <WorkspaceSettings appearance={appearance} appearancePending={appearancePending} appearanceError={appearanceError} saveAppearance={saveAppearance} advanced={advanced} bootstrap={bootstrap} api={api} reload={reload} close={closeDialog}/>}
  </div>;
}

function ToolLines({ items, collapsed = false }: { items: { name: string; summary: string }[]; collapsed?: boolean }) {
  const lines = <div className="tool-lines" aria-label="Tool activity">{items.length > 8 && <small>{items.length - 8} earlier steps</small>}{items.slice(-8).map((t, i) => <div key={i}><Terminal size={10}/><b>{t.name}</b><span title={t.summary}>{t.summary}</span></div>)}</div>;
  return collapsed ? <details className="tool-disclosure"><summary><Terminal size={12}/>{items.length} tool step{items.length === 1 ? '' : 's'}</summary>{lines}</details> : lines;
}

function AgentEditor({ api, agent, providers, homeDirectory, advanced, close, save }: { homeDirectory?: string; api: Api; agent?: Agent; providers: ProviderState[]; advanced: boolean; close: () => void; save: (values: Partial<Agent>) => Promise<void> }) {
  const [values, setValues] = useState({ name: agent?.name || '', role: agent?.role || '', instructions: agent?.instructions || '', memory: agent?.memory || '', routeMode: agent?.routeMode || 'auto' as RouteMode, accountId:agent?.accountId??'', model: agent?.model || '', color: agent?.color || colors[0], mode: (agent?.mode || 'agent') as ChatMode, workspace: agent?.workspace || '' });
  // undefined = keep the saved thumbnail, a data URL = new photo, null = remove the photo.
  const [avatar, setAvatar] = useState<string | null | undefined>(undefined);
  const [showAdvanced, setShowAdvanced] = useState(advanced);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const workspaceRef = useRef<HTMLInputElement>(null);
  const update = (key: keyof typeof values, value: string) => setValues(prev => ({ ...prev, [key]: value }));
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError('');
    try { await save({ ...values, accountId:values.accountId, ...(agent && avatar !== undefined ? { avatar } : {}) }); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <Modal title={agent ? 'Edit ' + agent.name : advanced ? 'Create an agent' : 'Create a bot'} close={close}><form onSubmit={submit} className="form-stack">
    <div className="form-pair"><label>Name<input autoFocus required maxLength={60} value={values.name} onChange={e => update('name', e.target.value)} placeholder="e.g. Atlas"/></label><label>Role<input maxLength={80} value={values.role} onChange={e => update('role', e.target.value)} placeholder="e.g. Research partner"/></label></div>
    <label>Instructions<textarea rows={4} value={values.instructions} onChange={e => update('instructions', e.target.value)} placeholder="What should this bot help with?"/></label>
    <details className="editor-advanced" open={showAdvanced} onToggle={event => setShowAdvanced(event.currentTarget.open)}><summary>Advanced options</summary><div className="editor-advanced-content">
      <fieldset className="avatar-colors"><legend>Avatar color</legend>{colors.map(color => <button type="button" key={color} aria-label={'Avatar color ' + color} aria-pressed={values.color === color} style={{ background: color }} className={values.color === color ? 'selected' : ''} onClick={() => update('color', color)}>{values.color === color && <Check size={15}/>}</button>)}</fieldset>
      {agent && <AvatarPhotoField agent={agent} color={values.color} value={avatar} onChange={setAvatar}/>}
      {agent && <>
        <label>Memory<textarea rows={3} value={values.memory} onChange={e => update('memory', e.target.value)} placeholder="Background and preferences to keep in mind across conversations."/></label>
        <AccountChoice api={api} value={values.accountId} onChange={item=>setValues(previous=>({...previous,accountId:item?.accountId??'',routeMode:item?item.id:previous.routeMode,model:''}))}/><div className="form-pair"><label>Preferred route<select value={values.routeMode} onChange={e => setValues(previous => ({ ...previous, routeMode: e.target.value as RouteMode, accountId:'',model: '' }))}><option value="auto">Automatic</option><option value="openai">OpenAI</option><option value="claude">Claude</option><option value="cursor">Cursor</option><option value="opencode">OpenCode · native Agent</option></select></label><label>Model<ModelPicker provider={values.accountId?(providers as AccountState[]).find(p=>p.accountId===values.accountId):providers.find(provider => provider.id === values.routeMode)} auto={values.routeMode === 'auto'} value={values.model} onChange={value => update('model', value)} label="Agent model"/></label></div>
        <div className="form-pair"><label>Working folder<input ref={workspaceRef} value={values.workspace} aria-required={values.mode === 'work'} onChange={e => update('workspace', e.target.value)} placeholder={homeDirectory || "Absolute working folder path"} spellCheck={false}/></label><label>Default mode<select value={values.mode} onChange={e => update('mode', e.target.value)}><option value="chat">Chat · tools off</option><option value="work">Work · tools on</option><option value="agent">Agent · app tools on</option><option value="auto">Auto · pick per message</option></select></label></div>
        {values.mode === 'agent' ? <div className="editor-mode-help"><p>Create bots and start groups from chat. OpenAI and Claude can carry out requested project actions from the working folder without repeated approval prompts.</p><p>New bots start in your detected home folder. You can choose another folder or clear it for app-only Agent mode. Cursor uses app tools only here. Claude on Windows has no OS sandbox.</p></div> : <p className="subtle-text">Work runs tools from the workspace folder without approval prompts. Claude on Windows has no OS sandbox. Auto chooses Chat or Work.</p>}
        <TelegramSection api={api} agentId={agent.id}/>
      </>}
    </div></details>
    {error && <p className="form-error" role="alert">{error}</p>}<footer className="modal-footer"><button type="button" className="secondary" onClick={close}>Cancel</button><button className="primary" disabled={busy}>{busy ? <LoaderCircle size={15} className="spin"/> : agent ? <Check size={15}/> : <Plus size={15}/>} {agent ? 'Save changes' : advanced ? 'Create agent' : 'Create bot'}</button></footer>
  </form></Modal>;
}

export function TelegramSection({ api, agentId }: { api: Api; agentId: string }) {
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const entry=useSecureCredentialEntry(agentId),{token,busy}=entry;
  const [userId, setUserId] = useState(''), [enabled, setEnabled] = useState(true);
  const [error, setError] = useState('');
  const initialStatus=useRef<AbortController|null>(null);
  function invalidateInitialStatus(){initialStatus.current?.abort();initialStatus.current=null;}
  const apply = (s: TelegramStatus) => { setStatus(s); setUserId(s.allowedUserId ? String(s.allowedUserId) : ''); setEnabled(s.configured ? s.enabled : true); entry.clear(); };
  useEffect(() => {
    invalidateInitialStatus();const controller=new AbortController();initialStatus.current=controller;
    setStatus(null);setUserId('');setEnabled(true);setError('');
    const events=['offline','pagehide','relay:runtime-disconnected','relay:before-runtime-reload'];
    for(const event of events)window.addEventListener(event,invalidateInitialStatus);
    void api<AgentData>(`/agents/${agentId}`,'GET',undefined,{signal:controller.signal,sensitive:true}).then(d=>{if(initialStatus.current===controller&&!controller.signal.aborted&&d.telegram)apply(d.telegram);}).catch(()=>{}).finally(()=>{if(initialStatus.current===controller)initialStatus.current=null;});
    return()=>{controller.abort();if(initialStatus.current===controller)initialStatus.current=null;for(const event of events)window.removeEventListener(event,invalidateInitialStatus);};
  },[agentId]);
  async function run(fn: (controller:AbortController) => Promise<TelegramStatus | void>) { if(entry.pending())return;invalidateInitialStatus();const controller=entry.begin();setError('');try { const r = await fn(controller); if (entry.current(controller)&&r) apply(r); } catch { if(entry.current(controller))setError('Could not update Telegram securely. Reconnect to Relay and enter the token again.'); } finally {entry.finish(controller);} }
  const idOk = /^\d+$/.test(userId.trim());
  return <fieldset className="telegram-section"><legend>Telegram bot</legend>
    <p className="subtle-text">Chat with this agent from Telegram. Create a bot with @BotFather and paste its token once; it is encrypted for your Windows account and never sent to a chat model. Only the user id below can talk to it.</p>
    {status?.configured && <p className="telegram-status"><span className={`run-dot ${status.running ? 'running' : status.error ? 'error' : ''}`}/>{status.botUsername ? '@' + status.botUsername : 'Bot'} · token configured · {status.running ? 'running' : status.enabled ? 'not running' : 'disabled'}{status.error && <em> · {status.error}</em>}</p>}
    <div className="form-pair"><label>Bot token<input ref={entry.input} type="password" autoComplete="new-password" spellCheck={false} autoCapitalize="none" maxLength={8192} disabled={busy} value={token} onChange={e => {invalidateInitialStatus();entry.setToken(e.target.value);}} placeholder={status?.configured ? 'Configured · paste to replace' : '123456:ABC…'}/></label><label>Allowed Telegram user id<input inputMode="numeric" value={userId} disabled={busy} onChange={e => {invalidateInitialStatus();setUserId(e.target.value);}} placeholder="Numeric id, e.g. 123456789"/></label></div>
    <label className="check-label"><input type="checkbox" checked={enabled} disabled={busy} onChange={e => {invalidateInitialStatus();setEnabled(e.target.checked);}}/><span>Enable bot</span></label>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="telegram-actions">{status?.configured && <button type="button" className="secondary small" disabled={busy} onClick={() => void run(async controller => { await api(`/agents/${agentId}/telegram`, 'DELETE',undefined,{signal:controller.signal,sensitive:true});if(entry.current(controller)){setStatus(null);setUserId('');setEnabled(true);} })}>Remove bot</button>}<button type="button" className="secondary small" disabled={busy || !idOk || (!status?.configured && !token.trim())} onClick={() => {const candidate=token.trim();void run(controller => api<TelegramStatus>(`/agents/${agentId}/telegram`, 'PUT', { ...(candidate ? { token: candidate } : {}), allowedUserId: Number(userId.trim()), enabled },{signal:controller.signal,sensitive:true}));}}>{busy ? <LoaderCircle size={13} className="spin"/> : <Check size={13}/>} Save Telegram</button></div>
  </fieldset>;
}

function WorkspaceSettings({ bootstrap, api, reload, close, advanced, appearance, appearancePending, appearanceError, saveAppearance }: { appearanceError:string; appearance:Appearance; appearancePending:boolean; saveAppearance:(value:Appearance)=>Promise<void>; advanced: boolean; bootstrap: Bootstrap; api: <T>(path: string, method?: string, body?: unknown) => Promise<T>; reload: () => Promise<Bootstrap>; close: () => void }) {
  const [settings, setSettings] = useState<Settings>(bootstrap.settings);
  const [section, setSection] = useState<'accounts' | 'limits' | 'integrations'>('accounts');
  const [providerId, setProviderId] = useState(bootstrap.providers[0]?.id || 'openai');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false);
  const statusLabel = accountStatus;
  return <Modal title="Workspace settings" close={close} wide initialFocus="dialog">
    <nav hidden={!advanced} className="settings-nav" aria-label="Settings sections"><button type="button" aria-pressed={section === 'accounts'} className={section === 'accounts' ? 'selected' : ''} onClick={() => setSection('accounts')}><ShieldCheck size={16}/>Accounts & models</button><button type="button" aria-pressed={section === 'limits'} className={section === 'limits' ? 'selected' : ''} onClick={() => setSection('limits')}><Clock3 size={16}/>Run limits</button><button type="button" aria-pressed={section === 'integrations'} className={section === 'integrations' ? 'selected' : ''} onClick={() => setSection('integrations')}><Users size={16}/>Integrations</button></nav>
    <div className="settings-scroll">{appearanceError&&<p className="form-error" role="alert">{appearanceError}</p>}<AppearanceControl preference={appearance} pending={appearancePending} onChange={value=>void saveAppearance(value)}/>
      <section hidden={advanced && section !== 'accounts'}>
        <AccountConnections api={api} onChange={()=>void reload()}/>
        {bootstrap.providers.filter(p=>p.id==='opencode').map(p=><ProviderCard key={p.id} provider={p} api={api} reload={reload}/>)}
        <TypeSafeConnection api={api} resetKey={bootstrap.csrfToken}/>
      </section>
      <section className="limits-section" hidden={!advanced || section !== 'limits'}>
        <div className="settings-section-header"><div><h3>Run limits</h3><p>Set time and call limits for each conversation turn. Discussion limits are set in each discussion.</p></div></div>
        <form onSubmit={async e => { e.preventDefault(); setBusy(true); setError(''); try { await api('/settings', 'PATCH', { maxRunSeconds: settings.maxRunSeconds, maxModelCalls: settings.maxModelCalls, maxWorkSeconds: settings.maxWorkSeconds ?? 900, routingClassifier: settings.routingClassifier ?? 'openai' }); await reload(); setSaved(true); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>
          <div className="form-pair"><label>Maximum chat run time (seconds)<input type="number" min={1} max={300} required value={settings.maxRunSeconds} onChange={e => { setSaved(false); setSettings(previous => ({ ...previous, maxRunSeconds: Number(e.target.value) })); }}/><small>1–300 seconds per chat turn</small></label><label>Model call budget<input type="number" min={1} max={3} required value={settings.maxModelCalls} onChange={e => { setSaved(false); setSettings(previous => ({ ...previous, maxModelCalls: Number(e.target.value) })); }}/><small>1–3 model calls per turn</small></label></div>
          <label>Automatic model selector<select aria-label="Automatic model selector" value={settings.routingClassifier ?? 'openai'} onChange={e => { setSaved(false); setSettings(previous => ({ ...previous, routingClassifier: e.target.value as Settings['routingClassifier'] })); }}><option value="typesafe">Jev · TypeSafe API credits</option><option value="openai">OpenAI subscription classifier</option><option value="rules">Rules · no classifier inference</option></select><small>Jev uses separate TypeSafe API credits. Manual model choices always win; unavailable Jev falls back to rules.</small></label>
          <label className="work-time-limit">Maximum Work / Agent run time (seconds)<input type="number" min={1} max={3600} required value={settings.maxWorkSeconds ?? 900} onChange={e => { setSaved(false); setSettings(previous => ({ ...previous, maxWorkSeconds: Number(e.target.value) })); }}/><small>Agent can manage Relay without a project folder. Native project tools use the configured folder. 1–3600 seconds.</small></label>
          <div className="limits-footer"><span role="status">{saved && <><Check size={14}/>Settings saved</>}</span><button className="primary" disabled={busy} type="submit">{busy ? 'Saving…' : 'Save run limits'}</button></div>
        </form>
      </section>
      {error && <p role="alert" className="form-error">{error}</p>}
      {advanced && section === 'integrations' && <HerdrSettings api={api}/>}
      <div hidden={!advanced} className="settings-end">Relay {bootstrap.version} · Local workspace · Execution mode is set per agent</div>
    </div>
  </Modal>;
}

export function ProviderCard({ provider, api, reload }: { provider: ProviderState; api: <T>(path: string, method?: string, body?: unknown) => Promise<T>; reload: () => Promise<Bootstrap> }) {
  const [billing, setBilling] = useState(provider.billing);
  const notChecked = provider.error?.startsWith('Refresh providers to inspect') === true;
  const [login, setLogin] = useState<LoginResult | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false);
  const persistedBilling = JSON.stringify(provider.billing);
  const accountIdentity = JSON.stringify([provider.accountLabel, provider.plan, provider.authMode, provider.authenticated,provider.connectionScope??null]);
  useEffect(() => { setBilling(provider.billing); setSaved(false); }, [persistedBilling, accountIdentity]);
  useEffect(() => { setLogin(null); setError(''); }, [accountIdentity]);
  const loginUrl = providerSetupUrl(provider.id, login?.url || '');
  if (!isActiveProviderId(provider.id)) return null;
  return <section className="provider-card"><div className="provider-header"><div className={`provider-symbol ${provider.id}`}>{provider.id === 'openai' ? <Sparkles size={20}/> : provider.id === 'cursor' ? <MousePointer2 size={21}/> : '✳'}</div><div><h3>{providerName(provider.id)}</h3><p>{provider.accountLabel || 'No account connected'}</p></div><span className={`provider-state ${ready(provider, true) && !reportedAllowanceUnavailable(provider) ? 'ready' : ''}`}><span/>{accountStatus(provider)}</span></div><p className="subtle-text">{accountNextAction(provider)}</p><h4 className="provider-step-heading"><span>1</span>{provider.authenticated ? 'Account connected' : 'Connect your account'}</h4><div className="provider-facts"><span>Connector <strong>{notChecked ? 'Not checked' : provider.installed ? 'Installed' : 'Not installed'}</strong></span><span>Authentication <strong>{notChecked ? 'Not checked' : provider.authenticated ? provider.authMode : 'Not signed in'}</strong></span>{provider.nativeAgentOnly && <span>Capability <strong>Native Agent</strong></span>}<span>Plan <strong>{provider.plan || 'Not reported'}</strong></span>{provider.quota && <span>Allowance <strong>{provider.quota}</strong></span>}</div>{provider.nativeAgentOnly && <p className="provider-warning">Direct Agent runs require a project folder. Agent mode carries out requested tools without repeated approval prompts; it is not an OS sandbox. Chat, Work and groups are unavailable for this connection.</p>}{provider.error && <p className="provider-warning">{provider.error}</p>}<button className="secondary small" disabled={busy} onClick={async () => { setBusy(true); setError(''); try { await reload(); setLogin(await api<LoginResult>(`/providers/${provider.id}/login`, 'POST', {})); await reload(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>{busy ? <LoaderCircle size={13} className="spin"/> : <ArrowUpRight size={13}/>} {provider.authenticated ? 'Account sign-in options' : `Connect ${providerName(provider.id)}`}</button>{login && <div className="login-instructions"><p>{login.message}</p>{login.command && <code>{login.command}</code>}{provider.id==='opencode'&&<button type="button" className="secondary small" onClick={()=>window.dispatchEvent(new Event('relay:open-terminal'))}>Open Relay terminal</button>}{loginUrl && <a className="primary small" href={loginUrl} target="_blank" rel="noopener noreferrer">{provider.id==='opencode'?'Open official setup instructions':'Continue to sign in'} <ArrowUpRight size={13}/></a>}{login.url && !loginUrl && <p>Setup URL was not a trusted {providerName(provider.id)} HTTPS address. Refresh the connection and review setup again.</p>}<small>After signing in, use Refresh to check your connection.</small></div>}{provider.id === 'cursor' && <div className="cursor-allowance-note"><strong>Verify your Cursor Ultra allowance</strong><p>Browser sign-in creates a credential managed by the official Cursor SDK, billed to your Cursor plan. No API key entry is needed.</p><p>Legacy and newer Ultra plans can have different allowances. Relay shows its observed tokens and any provider-reported historical charges in your conversations and workspace. Remaining allowance is unknown unless you verify it separately. Select only the covered models below. A plan name alone does not confirm billing.</p><a href="https://cursor.com/dashboard" target="_blank" rel="noopener noreferrer">Open Cursor dashboard <ArrowUpRight size={12}/></a></div>}<p className="subtle-text">{allowanceSummary(provider.allowance)}{provider.allowance && <> · {provider.allowance.source} · observed {new Date(provider.allowance.observedAt).toLocaleString()}</>}</p><h4 className="provider-step-heading"><span>2</span>Approve usage in Relay</h4><p className="subtle-text">This permission is saved only in Relay. It does not buy a plan or link a payment method. Your provider handles billing. Subscriptions have limits; check which models and usage your plan covers. Provider overage charges may apply.</p><form className="billing-form" onSubmit={async e => { e.preventDefault(); setBusy(true); setError(''); setSaved(false); try { await api(`/providers/${provider.id}/billing`, 'PATCH', { ...billing, ...(billing.confirmed ? { expectedAccount: { accountLabel: provider.accountLabel, plan: provider.plan },...(provider.connectionScope?{expectedConnectionScope:provider.connectionScope}:{}) } : {}) }); await reload(); setSaved(true); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}><label>How this account’s usage is billed<select value={billing.mode} onChange={e => setBilling(b => ({ ...b, mode: e.target.value as typeof b.mode, confirmed: false }))}><option value="unknown">Not approved — sending disabled</option>{provider.id!=='opencode'&&<option value="included">Covered by my subscription allowance</option>}{provider.id==='opencode'&&<option value="local">Local endpoint · cost may apply upstream</option>}<option value="metered">Metered usage — provider charges may apply</option></select></label><label>Allowance notes<textarea rows={2} placeholder="Record the plan, workspace, and allowance you verified." value={billing.allowanceNote} onChange={e => setBilling(b => ({ ...b, allowanceNote: e.target.value }))}/></label><label className="check-label"><input type="checkbox" checked={billing.confirmed} disabled={billing.mode === 'unknown'} onChange={e => setBilling(b => ({ ...b, confirmed: e.target.checked }))}/><span>I verified this workspace’s billing and allowance</span></label><label className="check-label"><input type="checkbox" checked={billing.automaticRouting} onChange={e => setBilling(b => ({ ...b, automaticRouting: e.target.checked }))}/><span>Let Auto choose this account</span></label><p className="subtle-text">Auto chooses among your enabled models on approved accounts. Leave this off to choose this account manually.</p><div className="billing-footer"><span>{saved && <><Check size={13}/>Usage permission saved</>}</span><button className="secondary small" disabled={busy}>Save usage permission</button></div></form><h4 className="provider-step-heading"><span>3</span>Enable models for Relay</h4><SubscriptionModels key={accountIdentity+(provider.connectionScope??'')} provider={provider} api={api} reload={reload}/>{error && <p role="alert" className="form-error">{error}</p>}</section>;
}
