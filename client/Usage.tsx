import type {Run} from '../shared/types';
import {usageSummary} from '../shared/provider-usage';
export function RunUsage({run,advanced=false}:{run:Run|undefined;advanced?:boolean}) {
 if(!run?.usageObservation&&!run?.sessionUsage)return null;
 const turn=run.usageObservation,session=run.sessionUsage;
 return <div className="run-mode-note" aria-label="Reported provider usage">
  {turn&&<span>{usageSummary(turn)}</span>}
  {session?.availability==='reported'&&<span> · {usageSummary(session)}</span>}
  {advanced&&<small> · {turn?.source??session?.source} · observed {new Date((turn??session)!.observedAt).toLocaleString()} · remaining allowance unknown{session?' · session totals can lag; snapshots are not turn charges':''}</small>}
 </div>;
}
