import type {Feedback,RoutingObservation} from '../server/routing-insights';
const label=(vote:Feedback)=>vote==='helpful'?'Helpful':'Missed';
/** Button selection reflects the operator channel, separately from agent/legacy reports. */
export function RoutingFeedback({row,onFeedback}:{row:RoutingObservation;onFeedback:(value:Feedback)=>void}){
 return <>
  <span>{row.operatorFeedback&&<small>Direct operator feedback: {label(row.operatorFeedback)}</small>}{row.agentFeedback&&<small>Agent recorded: {label(row.agentFeedback)}</small>}{row.feedback&&!row.operatorFeedback&&!row.agentFeedback&&<small>Unverified feedback: {label(row.feedback)}</small>}</span>
  <button aria-label={'Mark '+row.model+' result helpful'} aria-pressed={row.operatorFeedback==='helpful'} onClick={()=>onFeedback('helpful')}>Helpful</button>
  <button aria-label={'Mark '+row.model+' result unhelpful'} aria-pressed={row.operatorFeedback==='unhelpful'} onClick={()=>onFeedback('unhelpful')}>Missed</button>
 </>;
}
