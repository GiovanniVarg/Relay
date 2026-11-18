import {useEffect,useRef,useState} from 'react';
import type {Task} from '../shared/tasks';
type Api=<T>(path:string,method?:string,body?:unknown)=>Promise<T>;
/** Stays mounted while chatting; only the human's explicit browser preference enables notifications. */
export function useTaskNotifications(api:Api,onOpen:()=>void){
 const apiRef=useRef(api),openRef=useRef(onOpen);apiRef.current=api;openRef.current=onOpen;
 const [enabled,setEnabled]=useState(()=>localStorage.getItem('relay.taskNotifications')==='true');
 useEffect(()=>{const changed=()=>setEnabled(localStorage.getItem('relay.taskNotifications')==='true');window.addEventListener('relay-notification-preference',changed);return()=>window.removeEventListener('relay-notification-preference',changed);},[]);
 useEffect(()=>{if(!enabled||typeof Notification==='undefined'||Notification.permission!=='granted')return;let alive=true,busy=false;const states=new Map<string,string>();let initialized=false;
  const poll=async()=>{if(busy)return;busy=true;try{const value=await apiRef.current<{tasks:Task[]}>('/tasks');if(!alive)return;for(const task of value.tasks){const previous=states.get(task.id);if(initialized&&previous!==task.status&&['done','needs_input','failed'].includes(task.status)){const notification=new Notification(task.title,{body:task.status==='done'?'Task finished. Review its result and outputs.':'Your task needs attention.'});notification.onclick=()=>{window.focus();openRef.current();notification.close();};}states.set(task.id,task.status);}initialized=true;}catch{}finally{busy=false;}};
  void poll();const timer=setInterval(()=>void poll(),3000);return()=>{alive=false;clearInterval(timer);};
 },[enabled]);
}
