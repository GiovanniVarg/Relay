import type {Task} from '../shared/tasks';
/** One host poll for an open conversation. Concurrent ticks coalesce and disposal rejects stale replies. */
export function taskProgressFeed(load:()=>Promise<Task[]>,receive:(tasks:Task[])=>void,schedule:(tick:()=>void)=>()=>void){
 let busy=false,closed=false;
 const read=async()=>{if(busy||closed)return;busy=true;try{const tasks=await load();if(!closed)receive(tasks);}catch{}finally{busy=false;}};
 const stop=schedule(()=>{void read();});void read();return()=>{closed=true;stop();};
}
