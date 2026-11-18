import {useEffect,useState,type FormEvent} from 'react';
import {Plus,RefreshCw,Trash2} from 'lucide-react';
import type {McpConnection} from '../shared/mcp';
import {useSecureCredentialEntry,type SecureCredentialApi} from './useSecureCredentialEntry';
export function McpConnectionsPanel({api,agentId}:{api:SecureCredentialApi;agentId:string}){
 const[connections,setConnections]=useState<McpConnection[]>([]),[adding,setAdding]=useState(false),[name,setName]=useState(''),[url,setUrl]=useState(''),[error,setError]=useState('');
 const entry=useSecureCredentialEntry(agentId);
 const failure='Could not update connected tools. Reconnect to Relay and enter the credential again.';
 useEffect(()=>{const controller=new AbortController();setConnections([]);setAdding(false);setError('');void api<{connections:McpConnection[]}>(`/mcp?agentId=${encodeURIComponent(agentId)}`,'GET',undefined,{signal:controller.signal}).then(value=>{if(!controller.signal.aborted)setConnections(value.connections);}).catch(()=>{if(!controller.signal.aborted)setError('Connected tools are unavailable. Reconnect to Relay and try again.');});return()=>controller.abort();},[agentId]);
 async function reload(controller:AbortController){const result=await api<{connections:McpConnection[]}>(`/mcp?agentId=${encodeURIComponent(agentId)}`,'GET',undefined,{signal:controller.signal});if(entry.current(controller))setConnections(result.connections);}
 async function action(path:string,method='POST',body:unknown={}){if(entry.pending())return;const controller=entry.begin();setError('');try{await api(path,method,body,{signal:controller.signal,sensitive:true});if(entry.current(controller))await reload(controller);}catch{if(entry.current(controller))setError(failure);}finally{entry.finish(controller);}}
 function close(){entry.reset();setAdding(false);setError('');}
 async function submit(event:FormEvent){
  event.preventDefault();if(entry.pending())return;
  const candidate=entry.token,controller=entry.begin();setError('');
  try{
   const connection=await api<McpConnection>('/mcp','POST',{agentId,name,url,...(candidate?{token:candidate}:{})},{signal:controller.signal,sensitive:true});
   if(!entry.current(controller))return;
   setAdding(false);setName('');setUrl('');await reload(controller);
   if(!entry.current(controller))return;
   await api(`/mcp/${connection.id}/refresh`,'POST',{}, {signal:controller.signal,sensitive:true});
   if(entry.current(controller))await reload(controller);
  }catch{if(entry.current(controller))setError(failure);}finally{entry.finish(controller);}
 }
 return <section className="work-mcp"><div className="work-section-heading"><div><h3>Connected tools</h3><p>Add an HTTP MCP server for this bot. Tool actions request approval in the conversation.</p></div><button className="secondary" onClick={()=>{entry.reset();setError('');setAdding(value=>!value);}}><Plus size={14}/>Connect tool</button></div>{error&&<p className="work-alert" role="alert">{error}</p>}{connections.map(connection=><div className="work-mcp-row" key={connection.id}><div><strong>{connection.name}</strong><small>{connection.url}</small><span>{connection.status} · {connection.toolCount} tools{connection.hasToken?' · Credential saved':''}</span>{connection.error&&<p role="alert">{connection.error}</p>}</div><button className="icon-button" disabled={entry.busy} aria-label={'Refresh '+connection.name} onClick={()=>void action(`/mcp/${connection.id}/refresh`)}><RefreshCw size={15}/></button><button className="icon-button" disabled={entry.busy} aria-label={'Disconnect '+connection.name} onClick={()=>void action(`/mcp/${connection.id}`,'DELETE')}><Trash2 size={15}/></button></div>)}{adding&&<form className="work-form" autoComplete="off" onSubmit={submit}><label>Name<input required value={name} maxLength={100} disabled={entry.busy} onChange={e=>setName(e.target.value)} placeholder="My project tools"/></label><label>HTTP MCP endpoint<input required type="url" value={url} disabled={entry.busy} onChange={e=>setUrl(e.target.value)} placeholder="https://tools.example.com/mcp"/></label><details onToggle={event=>{if(!event.currentTarget.open)entry.reset();}}><summary>Authentication</summary><label>Bearer credential (optional)<input ref={entry.input} type="password" autoComplete="new-password" spellCheck={false} autoCapitalize="none" maxLength={8192} disabled={entry.busy} value={entry.token} onChange={e=>entry.setToken(e.target.value)}/></label><p className="subtle-text">Encrypted for your Windows account; never sent to a chat model. This form does not import another app’s sign-in or complete an OAuth flow.</p></details><div className="work-actions"><button className="primary" disabled={entry.busy}>{entry.busy?'Connecting…':'Connect'}</button><button className="secondary" type="button" onClick={close}>Cancel</button></div></form>}{!connections.length&&!adding&&<p className="subtle-text">No external tool servers connected. The built-in browser and Relay tools work independently.</p>}</section>;
}
