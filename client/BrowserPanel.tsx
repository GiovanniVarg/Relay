import {useEffect,useRef,useState} from 'react';
import {Monitor,X} from 'lucide-react';
import type {BrowserStatus} from '../shared/capabilities';
import {browserWatchFeed,emptyBrowserFeed,parseBrowserStatus} from './browser-watch-feed';
export type BrowserApi=<T>(path:string,method?:string,body?:unknown)=>Promise<T>;

/** Discovery does not subscribe to pixels, grant access, or launch a browser. */
export function useBrowserDiscovery(api:BrowserApi,scope:string,covered:boolean,disconnected:boolean){
 const apiRef=useRef(api);apiRef.current=api;
 const scopeRef=useRef(scope);scopeRef.current=scope;
 const dismissed=useRef(new Map<string,string>()),latest=useRef<{scope:string;status:BrowserStatus|null}>({scope:'',status:null});
 const [choice,setChoice]=useState({scope:'',open:false}),[snapshot,setSnapshot]=useState<{scope:string;status:BrowserStatus|null}>({scope:'',status:null});
 const open=!!scope&&choice.scope===scope&&choice.open;
 const visible=open&&!covered;
 useEffect(()=>{
  if(!scope||visible||disconnected)return;let closed=false,timer:ReturnType<typeof setTimeout>;
  const poll=async()=>{try{
   const response=await apiRef.current<{status:unknown}>(`/capabilities/${encodeURIComponent(scope)}/browser`),status=parseBrowserStatus(response.status);
   if(closed||scopeRef.current!==scope||!status)return;
   latest.current={scope,status};setSnapshot({scope,status});
   if(status.running&&status.sessionId&&dismissed.current.get(scope)!==status.sessionId&&!window.matchMedia('(max-width: 1049px)').matches)setChoice({scope,open:true});
  }catch{}finally{if(!closed)timer=setTimeout(()=>void poll(),2000);}};
  void poll();return()=>{closed=true;clearTimeout(timer);};
 },[scope,visible,disconnected]);
 const observe=(status:BrowserStatus)=>{if(scopeRef.current===scope){latest.current={scope,status};setSnapshot({scope,status});}};
 return {open,status:snapshot.scope===scope?snapshot.status:null,observe,
  show(){setChoice({scope,open:true});},
  hide(){setChoice({scope,open:false});},
  dismiss(){const current=latest.current;if(current.scope===scope&&current.status?.sessionId)dismissed.current.set(scope,current.status.sessionId);setChoice({scope,open:false});}};
}

export function BrowserPanel({api,agentId,agentName,open,onClose,onStatus,disconnected=false}:{api:BrowserApi;agentId:string;agentName:string;open:boolean;onClose:()=>void;onStatus?:(status:BrowserStatus)=>void;disconnected?:boolean}){
 const apiRef=useRef(api),statusCallback=useRef(onStatus);apiRef.current=api;statusCallback.current=onStatus;
 const [state,setState]=useState(emptyBrowserFeed),[clock,setClock]=useState(Date.now()),[notice,setNotice]=useState(''),[pending,setPending]=useState('');
 const [mobile,setMobile]=useState(()=>window.matchMedia('(max-width: 1049px)').matches);
 const pane=useRef<HTMLElement>(null),closeButton=useRef<HTMLButtonElement>(null),lease=useRef(0),request=useRef<object|null>(null),currentScope=useRef(''),currentSession=useRef<string|null|undefined>(undefined);
 const scope=open&&!disconnected?agentId:'';currentScope.current=scope;
 useEffect(()=>{
  const query=window.matchMedia('(max-width: 1049px)'),change=()=>setMobile(query.matches);
  query.addEventListener('change',change);change();return()=>query.removeEventListener('change',change);
 },[]);
 useEffect(()=>{
  ++lease.current;request.current=null;currentSession.current=undefined;setState(emptyBrowserFeed());setNotice('');setPending('');if(!scope)return;
  const feed=browserWatchFeed(agentId,next=>{if(currentScope.current===agentId){
   if(next.status&&currentSession.current!==next.status.sessionId){currentSession.current=next.status.sessionId;if(next.status.sessionId&&!request.current)setNotice('');}
   setState(next);if(next.status)statusCallback.current?.(next.status);
  }});
  const timer=setInterval(()=>setClock(Date.now()),1000);
  const disconnect=()=>{++lease.current;request.current=null;setPending('');setNotice('');feed.disconnect();};window.addEventListener('relay:runtime-disconnected',disconnect);
  return()=>{++lease.current;request.current=null;feed.close();clearInterval(timer);window.removeEventListener('relay:runtime-disconnected',disconnect);};
 },[scope]);
 useEffect(()=>{
  if(!open||!mobile)return;
  const previous=document.activeElement as HTMLElement|null;closeButton.current?.focus();
  const keepFocus=(event:FocusEvent)=>{if(pane.current&&!pane.current.contains(event.target as Node))closeButton.current?.focus();};
  document.addEventListener('focusin',keepFocus);return()=>{document.removeEventListener('focusin',keepFocus);if(previous?.isConnected)previous.focus({preventScroll:true});};
 },[open,mobile]);
 if(!open)return null;
 // A scope change never renders the previous bot's state, even before effect cleanup.
 const view=scope===agentId&&!disconnected?state:emptyBrowserFeed(),status=view.status;
 const stale=!!view.frame&&(clock-(view.receivedAt??0)>5000||clock-Date.parse(view.frame.capturedAt)>5000);
 const label=disconnected?'Disconnected':view.connection==='reconnecting'?'Reconnecting':view.connection==='disconnected'?'Disconnected':!status?'Waiting for browser':!status.available?'Browser engine unavailable':status.humanControl?'You have control':!status.granted?'Browser access off':!status.running?'Waiting for browser':stale?'Preview stale':'Bot control';
 async function control(action:'stop'|'takeover'|'return'){
  if(request.current)return;const version=lease.current,token={};request.current=token;setPending(action);setNotice('');
  // A Stop/takeover/return can retire its own session before HTTP completes. The
  // panel's current request owns only its notice; SSE alone owns status/pixels.
  const valid=()=>lease.current===version&&currentScope.current===agentId&&request.current===token;
  try{
   await apiRef.current(`/browser/${encodeURIComponent(agentId)}/${action}`,'POST',{});
   if(!valid())return;
   setNotice(action==='stop'?'Stop requested':action==='takeover'?'Takeover requested':'Return requested');
   // SSE remains the session authority; controls never restore a stale snapshot or old frame.
  }catch{
   if(valid())setNotice(action==='stop'?'Could not confirm stop':action==='takeover'?'Could not take over browser':'Could not return control');
  }finally{if(valid()){request.current=null;setPending('');}}
 }
 return <><div className="browser-panel-shade" onClick={onClose} aria-hidden="true"/>
  <aside ref={pane} id="bot-browser-panel" className="browser-panel" aria-label={`${agentName} browser`} role={mobile?'dialog':undefined} aria-modal={mobile?true:undefined} onKeyDown={event=>{if(event.key==='Tab'&&mobile){const buttons=Array.from(pane.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')??[]),first=buttons[0],last=buttons.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}}}>
   <header className="browser-panel-heading"><div><Monitor size={17}/><strong>{agentName} browser</strong></div><button ref={closeButton} type="button" aria-label="Close browser preview" onClick={onClose}><X size={18}/></button></header>
   <div className="browser-panel-body"><div className="browser-preview-state" role="status">{label}</div><p className="browser-page-url" aria-label="Current browser URL">{status?.url||'No page open'}</p>
    <div className="browser-preview-image">{view.frame?<img src={`data:image/jpeg;base64,${view.frame.jpeg}`} alt={`Current page in ${agentName}'s browser`}/>:<p>{label==='Bot control'?'Waiting for preview':label}</p>}</div>
    <p className="browser-preview-caption">Read-only preview · updates about once a second{view.frame&&<><br/><time dateTime={view.frame.capturedAt}>Last frame {new Date(view.frame.capturedAt).toLocaleTimeString()}</time></>}</p>
    <div className="browser-panel-controls"><button type="button" className="secondary" disabled={!!pending||disconnected} onClick={()=>void control('stop')}>{pending==='stop'?'Requesting stop…':'Stop bot'}</button>{status?.humanControl?<button type="button" className="secondary" disabled={!!pending||disconnected} onClick={()=>void control('return')}>Return control</button>:<button type="button" className="secondary" disabled={!!pending||disconnected||!status?.running||!status.granted} onClick={()=>void control('takeover')}>Take over</button>}</div>
    {notice&&<p role="status" className="browser-control-notice">{notice}</p>}
    <p className="browser-panel-hint">Take over opens a separate browser window for sign-in. The page reloads, so unsaved page changes may be lost.</p>
    <p className="browser-panel-hint">Closing this panel leaves the bot working.</p>
    {!!view.activities.length&&<section aria-label="Browser activity"><h3>Activity</h3><ol className="browser-activity">{view.activities.map(item=><li key={item.sequence}><span>{item.action} · {item.phase}</span><time dateTime={item.observedAt}>{new Date(item.observedAt).toLocaleTimeString()}</time></li>)}</ol></section>}
   </div>
  </aside></>;
}
