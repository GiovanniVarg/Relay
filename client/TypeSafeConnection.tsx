import {typeSafeErrorMessage,typeSafeCatalogIssueMessage} from '../shared/typesafe-errors';
import {useCallback,useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {Check,KeyRound,LoaderCircle,ShieldCheck} from 'lucide-react';
import type {TypeSafeCredentialChallenge,TypeSafeCredentialRequest,TypeSafeStatus} from '../shared/typesafe';

export type TypeSafeApi=<T>(path:string,method?:string,body?:unknown,request?:{signal?:AbortSignal;sensitive?:boolean})=>Promise<T>;
interface Props {api:TypeSafeApi;request?:TypeSafeCredentialRequest;resetKey?:string;onConnected?:(status:TypeSafeStatus)=>void;onCancel?:()=>Promise<void>;autoFocus?:boolean;}
/** The credential exists only in this component's password state and a direct, single-use HTTP request. */
export function TypeSafeConnection({api,request,resetKey='',onConnected,onCancel,autoFocus=true}:Props){
 const focusPolicy=useRef(autoFocus);focusPolicy.current=autoFocus;
 const id=useId(),inline=!!request,apiRef=useRef(api),connectedRef=useRef(onConnected);apiRef.current=api;connectedRef.current=onConnected;
 const [status,setStatus]=useState<TypeSafeStatus|null>(null),[apiKey,setApiKey]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[error,setError]=useState('');
 const [showEntry,setShowEntry]=useState(false),[attempt,setAttempt]=useState(0),[expired,setExpired]=useState(false),[challenge,setChallenge]=useState<TypeSafeCredentialChallenge|null>(null);
 const input=useRef<HTMLInputElement>(null),entryController=useRef<AbortController|null>(null),mounted=useRef(false),inFlight=useRef(false);
 const bindInput=useCallback((node:HTMLInputElement|null)=>{if(!node&&input.current){input.current.value='';input.current.defaultValue='';input.current.removeAttribute('value');}input.current=node;},[]);
 const requestKey=JSON.stringify([request?.runId??null,request?.interactionId??null,resetKey]);
 const entryVisible=inline||showEntry||!status?.configured;
 function clearKey(){setApiKey('');if(input.current)input.current.value='';}
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;entryController.current?.abort();if(input.current)input.current.value='';};},[]);
 useEffect(()=>{
  const controller=new AbortController();clearKey();setChallenge(null);setStatus(null);setNotice('');setError('');
  void apiRef.current<TypeSafeStatus>('/integrations/typesafe','GET',undefined,{signal:controller.signal}).then(value=>{if(!controller.signal.aborted){setStatus(value);setError([typeSafeErrorMessage(value.errorCode),value.errorCode==='invalid_catalog'?typeSafeCatalogIssueMessage(value.catalogIssue):undefined].filter(Boolean).join(' '));}}).catch(()=>{if(!controller.signal.aborted)setError('TypeSafe connection status is unavailable. Reopen secure entry after Relay reconnects.');});
  return()=>controller.abort();
 },[requestKey]);
 useEffect(()=>{
  const controller=new AbortController();entryController.current=controller;clearKey();setChallenge(null);setExpired(false);
  if(!entryVisible||!status?.storage.available)return()=>controller.abort();
  let timer:ReturnType<typeof setTimeout>|undefined;
  const reset=()=>{clearKey();setChallenge(null);setExpired(true);controller.abort();};
  controller.signal.addEventListener('abort',()=>{if(input.current)input.current.value='';},{once:true});
  window.addEventListener('offline',reset);window.addEventListener('pagehide',reset);window.addEventListener('relay:runtime-disconnected',reset);window.addEventListener('relay:before-runtime-reload',reset);
  void apiRef.current<TypeSafeCredentialChallenge>('/integrations/typesafe/credential-request','POST',request??{},{signal:controller.signal,sensitive:true}).then(value=>{
   if(controller.signal.aborted)return;
   const remaining=Date.parse(value.expiresAt)-Date.now();
   if(typeof value.nonce!=='string'||!value.nonce||!Number.isFinite(remaining)||remaining<=0){reset();return;}
   setChallenge(value);timer=setTimeout(reset,Math.min(remaining,2147483647));
   if(inline&&focusPolicy.current)requestAnimationFrame(()=>{if(!controller.signal.aborted)input.current?.focus();});
  }).catch(()=>{if(!controller.signal.aborted){clearKey();setError('This secure request is unavailable or has expired. Ask the bot to connect TypeSafe again.');setExpired(true);}});
  return()=>{controller.abort();if(timer)clearTimeout(timer);if(input.current)input.current.value='';window.removeEventListener('offline',reset);window.removeEventListener('pagehide',reset);window.removeEventListener('relay:runtime-disconnected',reset);window.removeEventListener('relay:before-runtime-reload',reset);};
 },[requestKey,entryVisible,status?.storage.available,attempt]);
 async function submit(event:FormEvent){
  event.preventDefault();if(inFlight.current||busy||!apiKey.trim()||!challenge||expired||entryController.current?.signal.aborted)return;
  const candidate=apiKey.trim(),controller=entryController.current;clearKey();inFlight.current=true;setBusy(true);setError('');setNotice('');
  try{
   const result=await apiRef.current<TypeSafeStatus>('/integrations/typesafe/connect','POST',{nonce:challenge.nonce,apiKey: candidate},{signal:controller?.signal,sensitive:true});
   if(!mounted.current||controller?.signal.aborted)return;
   clearKey();setStatus(result);setChallenge(null);setShowEntry(false);setNotice('TypeSafe connected. Your key was saved encrypted for this Windows account.');connectedRef.current?.(result);
  }catch(failure){
   if(mounted.current&&!controller?.signal.aborted){clearKey();setError([typeSafeErrorMessage((failure as {code?:unknown})?.code)??'TypeSafe setup failed before Relay returned a diagnostic. Check the local connection and try secure entry again.',(failure as {code?:unknown})?.code==='invalid_catalog'?typeSafeCatalogIssueMessage((failure as {catalogIssue?:unknown})?.catalogIssue):undefined].filter(Boolean).join(' '));setAttempt(previous=>previous+1);}
  }finally{inFlight.current=false;if(mounted.current)setBusy(false);}
 }
 async function manage(method:string,body?:unknown){
  if(inFlight.current)return;clearKey();inFlight.current=true;setBusy(true);setError('');setNotice('');
  try{const value=await apiRef.current<TypeSafeStatus>(method==='POST'?'/integrations/typesafe/test':'/integrations/typesafe',method,body);if(!mounted.current)return;setStatus(value);setShowEntry(false);setNotice(method==='DELETE'?'TypeSafe disconnected.':method==='POST'?'Connection checked.':'TypeSafe settings saved.');}
  catch(failure){if(mounted.current)setError([typeSafeErrorMessage((failure as {code?:unknown})?.code)??'Could not update the TypeSafe connection. Try again after Relay reconnects.',(failure as {code?:unknown})?.code==='invalid_catalog'?typeSafeCatalogIssueMessage((failure as {catalogIssue?:unknown})?.catalogIssue):undefined].filter(Boolean).join(' '));}
  finally{inFlight.current=false;if(mounted.current)setBusy(false);}
 }
 async function cancel(){clearKey();entryController.current?.abort();setChallenge(null);setExpired(true);if(onCancel){setBusy(true);try{await onCancel();}catch{if(mounted.current)setError('Could not stop this request. Use Stop in the chat.');}finally{if(mounted.current)setBusy(false);}}else setShowEntry(false);}
 const unavailable=!!status&&!status.storage.available;
 return <section className={`typesafe-connection ${inline?'typesafe-inline interaction-card':''}`} aria-labelledby={`${id}-title`} aria-busy={busy}>
  <div className="typesafe-heading"><span className="typesafe-symbol"><KeyRound size={18}/></span><div><h3 id={`${id}-title`}>{inline?'Connect TypeSafe securely':'TypeSafe'}</h3><p>{inline?'Enter the API key here, then press Enter.':'Optional typed decisions for your bots'}</p></div>{!inline&&<span className={`typesafe-state ${status?.configured?'connected':''}`}>{status?.configured?'Connected':status?'Not connected':'Checking…'}</span>}</div>
  <p className="typesafe-copy">TypeSafe decisions use API credits. Keys entered here are encrypted for this Windows account and sent directly to Relay, outside chat messages and answers.</p>
  {!inline&&status?.configured&&<div className="typesafe-config"><label className="check-label"><input type="checkbox" checked={status.enabled} disabled={busy||!status.storage.available} onChange={event=>void manage('PATCH',{enabled:event.target.checked})}/><span>Enable TypeSafe decisions</span></label>{status.models.length>0&&<label>Decision model<select aria-label="TypeSafe decision model" value={status.model} disabled={busy} onChange={event=>void manage('PATCH',{model:event.target.value})}>{status.models.map(model=><option key={model.name} value={model.name}>{model.name}</option>)}</select></label>}<div className="typesafe-actions"><button type="button" className="secondary small" disabled={busy} onClick={()=>void manage('POST',{})}>Check connection</button><button type="button" className="secondary small" disabled={busy||!status.storage.available} onClick={()=>{clearKey();setShowEntry(true);setAttempt(value=>value+1);}}>Replace key</button><button type="button" className="secondary small" disabled={busy} onClick={()=>void manage('DELETE')}>Disconnect</button></div>{status.validatedAt&&<p className="subtle-text">Last checked {new Date(status.validatedAt).toLocaleString()}</p>}</div>}
  {entryVisible&&<form className="typesafe-secure-form" onSubmit={submit} autoComplete="off"><label htmlFor={`${id}-key`}>TypeSafe API key<input ref={bindInput} id={`${id}-key`} name="typesafe-secure-key" type="password" autoComplete="new-password" spellCheck={false} autoCapitalize="none" maxLength={8192} value={apiKey} disabled={busy||unavailable||expired||!challenge} onChange={event=>{setApiKey(event.target.value);setError('');}} aria-describedby={`${id}-privacy`}/></label><p id={`${id}-privacy`} className="subtle-text"><ShieldCheck size={12}/>Paste the API key itself here. Leave out Authorization:, Bearer and surrounding quotes.</p><div className="typesafe-actions">{(inline||status?.configured)&&<button type="button" className="secondary small" disabled={busy} onClick={()=>void cancel()}>{inline?'Stop setup':'Cancel'}</button>}<button type="submit" className="primary small" disabled={busy||!apiKey.trim()||!challenge||unavailable||expired}>{busy?<LoaderCircle size={14} className="spin"/>:<ShieldCheck size={14}/>} {busy?'Connecting…':'Connect TypeSafe'}</button></div>{expired&&<p className="subtle-text" role="status">Secure entry expired or disconnected. Ask your bot to connect TypeSafe again.{!inline&&<button type="button" className="typesafe-retry" onClick={()=>setAttempt(value=>value+1)}>Try secure entry again</button>}</p>}</form>}
  {unavailable&&<p className="form-error" role="alert">Encrypted credential storage is unavailable. TypeSafe cannot be connected on this device.</p>}
  {error&&<p className="form-error" role="alert">{error}</p>}{notice&&<p className="typesafe-notice" role="status"><Check size={14}/>{notice}</p>}
 </section>;
}

