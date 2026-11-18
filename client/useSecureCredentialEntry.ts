import {useEffect,useRef,useState} from 'react';

export type SecureCredentialApi=<T>(path:string,method?:string,body?:unknown,request?:{signal?:AbortSignal;sensitive?:boolean})=>Promise<T>;
/** Password-only state: never connect this entry to conversation draft persistence. */
export function useSecureCredentialEntry(scope:string){
 const [token,setToken]=useState(''),[busy,setBusy]=useState(false);
 const input=useRef<HTMLInputElement>(null),request=useRef<AbortController|null>(null);
 function clear(){setToken('');if(input.current)input.current.value='';}
 function reset(){clear();request.current?.abort();request.current=null;setBusy(false);}
 useEffect(()=>{
  reset();
  const events=['offline','pagehide','relay:runtime-disconnected','relay:before-runtime-reload'];
  for(const event of events)window.addEventListener(event,reset);
  return()=>{reset();for(const event of events)window.removeEventListener(event,reset);};
 },[scope]);
 function begin(){reset();const controller=new AbortController();request.current=controller;setBusy(true);return controller;}
 function current(controller:AbortController){return request.current===controller&&!controller.signal.aborted;}
 function pending(){return request.current!==null;}
 function finish(controller:AbortController){if(current(controller)){clear();request.current=null;setBusy(false);}}
 return {token,setToken,input,busy,clear,reset,begin,current,pending,finish};
}
