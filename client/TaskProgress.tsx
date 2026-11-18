import {useEffect,useState,useRef} from 'react';
import {taskStatusLabel,type Task} from '../shared/tasks';
import {taskProgressFeed} from './task-progress-feed';
export function useTaskProgress(api:<T>(path:string)=>Promise<T>,agentId:string,conversationId:string){
 const client=useRef(api);client.current=api;const [tasks,setTasks]=useState<Task[]>([]);
 useEffect(()=>{setTasks([]);if(!agentId||!conversationId)return;return taskProgressFeed(async()=>{const result=await client.current<{tasks:Task[]}>(`/tasks?agentId=${encodeURIComponent(agentId)}`);return result.tasks.filter(task=>task.conversationId===conversationId);},setTasks,tick=>{const timer=setInterval(tick,2500);return()=>clearInterval(timer);});},[agentId,conversationId]);
 return tasks.filter(task=>task.conversationId===conversationId&&task.agentId===agentId);
}
/** Host task metadata is a view, never an extra assistant turn or a native-session cursor. */
export function TaskProgress({task}:{task?:Task}){
 if(!task)return null;
 return <div className="subtle-text" role="status" aria-label="Task progress"><strong>{taskStatusLabel(task)}</strong>{task.outcome?.summary&&<span> · Assistant report: {task.outcome.summary}</span>}{(task.status==='needs_input'||task.recoveryRequired)&&<p>{task.error||task.outcome?.remaining.join(' · ')||'Inspect saved progress before continuing.'}</p>}</div>;
}
