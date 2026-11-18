import {currentAppearance,subscribeAppearance} from './appearance';
import type {ResolvedAppearance} from '../shared/types';
import {useEffect,useRef,useState} from 'react';
import {Terminal as TerminalIcon,X} from 'lucide-react';
import type {Terminal,ITheme} from '@xterm/xterm';
import type {FitAddon} from '@xterm/addon-fit';
import {TERMINAL_LIMITS as L,type TerminalCatalog,type TerminalCurrent,type TerminalSession,type TerminalStarted,type TerminalStopped} from '../shared/terminal';
import {terminalFeed,parseTerminalSession,type TerminalApi,type TerminalFeedState} from './terminal-feed';

export function terminalTheme(_theme:ResolvedAppearance):ITheme{
 const css=getComputedStyle(document.documentElement),color=(name:string)=>css.getPropertyValue('--terminal-'+name).trim();
 const palette:ITheme={background:color('background'),foreground:color('foreground'),cursor:color('cursor'),selectionBackground:color('selection')};
 for(const name of ['black','red','green','yellow','blue','magenta','cyan','white'] as const){palette[name]=color(name);const bright=('bright'+name[0].toUpperCase()+name.slice(1)) as 'brightBlack'|'brightRed'|'brightGreen'|'brightYellow'|'brightBlue'|'brightMagenta'|'brightCyan'|'brightWhite';palette[bright]=color('bright-'+name);}
 return palette;
}

export function TerminalPanel({api,open,onClose,startAgentId,disconnected=false}:{api:TerminalApi;open:boolean;onClose:()=>void;startAgentId?:string;disconnected?:boolean}){
 const apiRef=useRef(api);apiRef.current=api;
 const [catalog,setCatalog]=useState<TerminalCatalog|null>(null),[shellId,setShellId]=useState(''),[session,setSession]=useState<TerminalSession|null>(null),[view,setView]=useState<TerminalFeedState|null>(null);
 const [loading,setLoading]=useState(true),[pending,setPending]=useState(''),[notice,setNotice]=useState(''),[stopResult,setStopResult]=useState<{sessionId:string;failed:boolean}|null>(null),[rendererVersion,setRendererVersion]=useState(0),[rendererError,setRendererError]=useState(false),[mobile,setMobile]=useState(false),[loadVersion,setLoadVersion]=useState(0),[needsRefresh,setNeedsRefresh]=useState(false);
 const pane=useRef<HTMLElement>(null),output=useRef<HTMLDivElement>(null),closeButton=useRef<HTMLButtonElement>(null),term=useRef<Terminal|null>(null),fit=useRef<FitAddon|null>(null),feed=useRef<ReturnType<typeof terminalFeed>|null>(null),fitNow=useRef<()=>void>(()=>{}),operation=useRef<object|null>(null),alive=useRef(false),openRef=useRef(open),runtimeRef=useRef(disconnected);
 openRef.current=open;runtimeRef.current=disconnected;
 const sessionRef=useRef(session),authorityEpoch=useRef(0);sessionRef.current=session;
 const acceptSession=(value:TerminalSession|null)=>{const current=value?feed.current?.acknowledgeSession(value):undefined,accepted=current?.id===value?.id?current??value:value;sessionRef.current=accepted;setSession(accepted);return accepted;};
 useEffect(()=>{
  alive.current=true;let cancelled=false;const epoch=authorityEpoch.current;setLoading(true);
  void Promise.all([apiRef.current<TerminalCatalog>('/terminal/shells'),apiRef.current<TerminalCurrent>('/terminal')]).then(([value,current])=>{
   if(cancelled||epoch!==authorityEpoch.current||runtimeRef.current)return;
   if(!value||typeof value.platform!=='string'||!Array.isArray(value.shells)||!['unchecked','ready','unavailable'].includes(value.engine)||!value.shells.every(shell=>typeof shell.id==='string'&&shell.id.length<=100&&typeof shell.label==='string'&&shell.label.length<=200))throw new Error('Terminal shell catalog is unavailable.');
   setCatalog(value);let preferred='';try{preferred=localStorage.getItem(`relay.terminal.shell.${value.platform}`)??'';}catch{}
   setShellId(value.shells.find(shell=>shell.id===preferred)?.id??value.shells[0]?.id??'');
   if(current.session){const existing=parseTerminalSession(current.session);if(!existing)throw new Error('Terminal session state is unavailable.');acceptSession(existing);setShellId(existing.shellId);if(loadVersion>0){if(feed.current)feed.current.reconnect();else setRendererVersion(value=>value+1);}}else{acceptSession(null);setView(null);}
   setNeedsRefresh(false);setNotice('');
  }).catch(()=>{if(!cancelled&&epoch===authorityEpoch.current){setNeedsRefresh(true);setNotice('Could not load terminal state. Use Refresh state to try again.');}}).finally(()=>{if(!cancelled&&epoch===authorityEpoch.current)setLoading(false);});
  const query=window.matchMedia('(max-width: 1049px)'),change=()=>setMobile(query.matches);query.addEventListener('change',change);change();
  return()=>{cancelled=true;alive.current=false;operation.current=null;query.removeEventListener('change',change);};
 },[loadVersion]);
 useEffect(()=>{
  if(!session)return;let cancelled=false;const epoch=authorityEpoch.current;let renderer:Terminal|undefined,addon:FitAddon|undefined,observer:ResizeObserver|undefined,resizeTimer:ReturnType<typeof setTimeout>|undefined;const disposables:{dispose():void}[]=[];
  setRendererError(false);setView(null);
  // Runtime packages and DOM access stay inside the mounted effect, keeping App SSR safe.
  void Promise.all([import('@xterm/xterm'),import('@xterm/addon-fit')]).then(([runtime,fitRuntime])=>{
   if(cancelled||!output.current||epoch!==authorityEpoch.current)return;
   renderer=new runtime.Terminal({cols:session.cols,rows:session.rows,scrollback:L.scrollback,disableStdin:true,cursorBlink:true,fontSize:13,fontFamily:'Consolas, "Cascadia Mono", monospace',theme:terminalTheme(currentAppearance()),windowOptions:{},linkHandler:{activate(){},hover(){},leave(){}}});
   addon=new fitRuntime.FitAddon();renderer.loadAddon(addon);renderer.open(output.current);renderer.textarea?.setAttribute('aria-label','Terminal input');term.current=renderer;fit.current=addon;
   // Output cannot write the clipboard, create hyperlinks, rename UI, or manipulate windows.
   for(const code of [0,1,2,8,52])disposables.push(renderer.parser.registerOscHandler(code,()=>true));
   const current=renderer;disposables.push({dispose:subscribeAppearance(()=>{current.options.theme=terminalTheme(currentAppearance());})});let inputReady=false;
   const active=terminalFeed(session,next=>{
    if(cancelled||term.current!==current||sessionRef.current?.id!==session.id)return;current.options.disableStdin=!next.canInput||runtimeRef.current;setView(next);sessionRef.current=next.session;setSession(next.session);if(next.canInput&&!inputReady)requestAnimationFrame(()=>{if(!cancelled)fitNow.current();});inputReady=next.canInput;
   },{write(data,done){current.write(data,done);},reset(){current.reset();}},(path,method,body)=>apiRef.current(path,method,body));
   feed.current=active;disposables.push(renderer.onData(data=>{if(!runtimeRef.current)active.input(data);}));
   const resize=()=>{
    if(cancelled||!openRef.current||!output.current?.clientWidth||!output.current.clientHeight)return;
    try{const dimensions=addon!.proposeDimensions();if(!dimensions)return;const cols=Math.max(L.minCols,Math.min(L.maxCols,dimensions.cols)),rows=Math.max(L.minRows,Math.min(L.maxRows,dimensions.rows));if(cols!==current.cols||rows!==current.rows)current.resize(cols,rows);active.resize(cols,rows);}catch{}
   };
   fitNow.current=resize;observer=new ResizeObserver(()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(resize,100);});observer.observe(output.current);resize();
   if(runtimeRef.current)active.disconnect();
  }).catch(()=>{if(!cancelled){setRendererError(true);setNotice('Terminal renderer is unavailable. Reconnect to reload it; Close session remains available.');}});
  return()=>{cancelled=true;clearTimeout(resizeTimer);observer?.disconnect();fitNow.current=()=>{};feed.current?.close();feed.current=null;disposables.forEach(item=>item.dispose());renderer?.dispose();if(term.current===renderer){term.current=null;fit.current=null;}};
 },[session?.id,rendererVersion]);
 useEffect(()=>{
  const disconnect=()=>{++authorityEpoch.current;operation.current=null;setPending('');setLoading(false);setNeedsRefresh(true);setStopResult(null);setNotice('Relay disconnected. Refresh state before starting or reconnecting a shell.');feed.current?.disconnect();if(term.current)term.current.options.disableStdin=true;};window.addEventListener('relay:runtime-disconnected',disconnect);if(disconnected)disconnect();return()=>window.removeEventListener('relay:runtime-disconnected',disconnect);
 },[disconnected]);
 useEffect(()=>{if(open){const frame=requestAnimationFrame(()=>fitNow.current());return()=>cancelAnimationFrame(frame);}},[open,mobile]);
 useEffect(()=>{
  if(!open||!mobile)return;closeButton.current?.focus({preventScroll:true});
  const keepFocus=(event:FocusEvent)=>{if(pane.current&&!pane.current.contains(event.target as Node))closeButton.current?.focus({preventScroll:true});};document.addEventListener('focusin',keepFocus);return()=>document.removeEventListener('focusin',keepFocus);
 },[open,mobile]);
 const live=!!session&&session.state!=='exited',canInput=!!view?.canInput&&!disconnected&&!pending;
 async function start(){
  if(operation.current||!shellId||live||disconnected||needsRefresh)return;const token={};operation.current=token;setPending('start');setNotice('');
  try{const result=await apiRef.current<TerminalStarted>('/terminal/start','POST',{shellId,...(startAgentId?{agentId:startAgentId}:{}),cols:80,rows:24});if(!alive.current||operation.current!==token)return;const value=parseTerminalSession(result.session);if(!value)throw new Error('Invalid session');acceptSession(value);setView(null);}
  catch(error){if(alive.current&&operation.current===token){setNeedsRefresh(true);setNotice((error as Error).message||'Could not confirm terminal Start. Refresh state before trying again.');}}
  finally{if(alive.current&&operation.current===token){operation.current=null;setPending('');}}
 }
 async function stop(){
  if(!session||operation.current||disconnected)return;const token={},id=session.id;operation.current=token;setPending('stop');setNotice('');setStopResult(null);feed.current?.revokeInput();
  try{const result=await apiRef.current<TerminalStopped>(`/terminal/${encodeURIComponent(id)}/stop`,'POST',{});if(!alive.current||operation.current!==token||sessionRef.current?.id!==id)return;const value=parseTerminalSession(result.session);if(!value||value.id!==id)throw new Error('Invalid session');acceptSession(value);setStopResult({sessionId:id,failed:false});}
  catch{if(alive.current&&operation.current===token&&sessionRef.current?.id===id)setStopResult({sessionId:id,failed:true});}
  finally{if(alive.current&&operation.current===token){operation.current=null;setPending('');}}
 }
 function reconnect(){if(disconnected||pending||needsRefresh)return;setNotice('');setStopResult(null);if(rendererError||view?.rendererFailed){setRendererVersion(value=>value+1);return;}feed.current?.reconnect();}
 const label=disconnected?'Relay disconnected':loading?'Loading terminal':pending==='start'?'Starting terminal':pending==='stop'?'Closing session':!session?'Ready to start':session.state==='exited'?'Shell exited':session.state==='uncertain'?'Shell state uncertain':session.state==='stopping'?'Closing session':view?.connection==='connected'?'Connected':view?.connection==='incomplete'?'Output incomplete':view?.connection==='disconnected'?'Disconnected':'Connecting';
 return <><div hidden={!open} className="terminal-panel-shade" onClick={onClose} aria-hidden="true"/>
  <aside hidden={!open} ref={pane} id="operator-terminal-panel" className="terminal-panel" aria-label="Terminal" role={open&&mobile?'dialog':undefined} aria-modal={open&&mobile?true:undefined} onKeyDown={event=>{
   if(event.key!=='Tab'||!mobile)return;const controls=Array.from(pane.current?.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled),input:not(:disabled),textarea:not(:disabled),[tabindex="0"]')??[]).filter(element=>element.getClientRects().length>0&&element.tabIndex>=0),first=controls[0],last=controls.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  }}>
   <header className="terminal-panel-heading"><div><TerminalIcon size={17}/><strong>Terminal</strong></div><button ref={closeButton} type="button" aria-label="Close terminal panel" onClick={onClose}><X size={18}/></button></header>
   <div className="terminal-toolbar"><label>Shell<select aria-label="Terminal shell" value={shellId} disabled={loading||live||!!pending} onChange={event=>{setShellId(event.target.value);if(catalog)try{localStorage.setItem(`relay.terminal.shell.${catalog.platform}`,event.target.value);}catch{}}}>{catalog?.shells.map(shell=><option key={shell.id} value={shell.id}>{shell.label}</option>)}</select></label>
    {!live&&<button type="button" className="secondary" disabled={loading||!shellId||!!pending||disconnected||needsRefresh||catalog?.engine==='unavailable'} onClick={()=>void start()}>Start terminal</button>}
    {(needsRefresh||view?.connection==='disconnected'||view?.connection==='incomplete')&&!loading&&<button type="button" className="secondary" disabled={disconnected||!!pending} onClick={()=>setLoadVersion(value=>value+1)}>Refresh state</button>}
   </div>
   <div className="terminal-session-context"><span role="status">{label}</span>{session&&<><code title={session.cwd}>{session.cwd}</code>{session.context&&<small>Started from {session.context}</small>}</>}</div>
   <div ref={output} className="terminal-output" aria-label="Terminal output"/>
   {!session&&<p className="terminal-empty">Choose a shell and start when you are ready.</p>}
   <div className="terminal-controls"><button type="button" className="secondary" disabled={!canInput||needsRefresh} onClick={()=>{feed.current?.input('\u0003');term.current?.focus();}}>Interrupt</button>{live&&<button type="button" className="secondary" disabled={!!pending||disconnected} onClick={()=>void stop()}>Close session</button>}{session&&(rendererError||view?.connection==='disconnected'||view?.connection==='incomplete')&&<button type="button" className="secondary" disabled={!!pending||disconnected||needsRefresh} onClick={reconnect}>Reconnect</button>}</div>
   {[...new Set([notice,session&&stopResult?.sessionId===session.id&&session.state!=='exited'?(stopResult.failed?'Could not confirm shell exit. Close session remains available.':'Shell exit is not confirmed. Close session remains available.'):'',view?.notice,catalog?.error,session?.warning].filter((message):message is string=>!!message))].map(message=><p key={message} className="terminal-notice" role="status">{message}</p>)}
   <p className="terminal-hint">Closing this panel leaves the shell running. Close session ends it.</p>
  </aside></>;
}
