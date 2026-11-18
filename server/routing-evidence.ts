import type {ProviderState,RouteEvidenceSummary} from '../shared/types.js';
import {currentAllowance} from '../shared/provider-allowance.js';
import {accountUsageKey} from './provider-usage.js';
import type {ModelInsight,RoutingSnapshot,TaskKind} from './routing-insights.js';

const count=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const number=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=Number.MAX_SAFE_INTEGER;
const date=(value:unknown)=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
export function validInsight(row:ModelInsight):boolean {
 return [row.samples,row.completed,row.failed,row.helpful,row.unhelpful,row.inputReportedSamples,row.outputReportedSamples,row.usageReportedSamples,row.agentHelpful??0,row.agentUnhelpful??0,row.unverifiedFeedbackSamples??0,row.checksPassedSamples??0,row.checksFailedSamples??0,row.checksUnknownSamples??0].every(count)&&row.samples>0&&row.completed+row.failed===row.samples&&row.helpful+row.unhelpful<=row.samples&&(row.agentHelpful??0)+(row.agentUnhelpful??0)<=row.samples&&(row.unverifiedFeedbackSamples??0)<=row.samples&&(row.checksPassedSamples??0)<=row.samples&&(row.checksFailedSamples??0)<=row.samples&&(row.checksUnknownSamples??0)<=row.samples&&row.inputReportedSamples<=row.samples&&row.outputReportedSamples<=row.samples&&row.usageReportedSamples<=Math.min(row.inputReportedSamples,row.outputReportedSamples)&&[row.meanLatencyMs,row.inputTokens,row.outputTokens].every(number)&&!!date(row.firstObservedAt)&&!!date(row.lastObservedAt)&&Date.parse(row.firstObservedAt!)<=Date.parse(row.lastObservedAt!);
}
export function modelEvidence(state:ProviderState,model:string,kind:TaskKind,snapshot?:RoutingSnapshot) {
 const key=accountUsageKey(state);
 const row=key?snapshot?.models.find(row=>row.provider===state.id&&row.model===model&&row.taskKind===kind&&row.accountKey===key):undefined;
 if(!row||!validInsight(row))return {status:'unknown' as const,samples:0};
 const tokens=(total:number,reported:number)=>({total:reported?total:null,reportedSamples:reported,missingSamples:row.samples-reported});
 return {status:row.samples<3?'sparse' as const:'observed' as const,samples:row.samples,source:'relay-run-observations' as const,
  window:{kind:'all-retained-current-account' as const,firstObservedAt:date(row.firstObservedAt),lastObservedAt:date(row.lastObservedAt)},
  providerTurn:{completed:row.completed,failed:row.failed},humanFeedback:{source:'direct-operator-channel' as const,helpful:row.helpful,unhelpful:row.unhelpful,missing:row.samples-row.helpful-row.unhelpful},agentRecordedFeedback:{helpful:row.agentHelpful??0,unhelpful:row.agentUnhelpful??0},unverifiedFeedbackSamples:row.unverifiedFeedbackSamples??0,
  hostChecks:{source:'host-relay-check-receipts' as const,scope:'recorded-exact-revision-checks' as const,passedSamples:row.checksPassedSamples??0,failedSamples:row.checksFailedSamples??0,unknownSamples:row.checksUnknownSamples??row.samples},independentOutcome:'unknown' as const,elapsed:{meanFullRunElapsedMs:row.meanLatencyMs},tokens:{input:tokens(row.inputTokens,row.inputReportedSamples),output:tokens(row.outputTokens,row.outputReportedSamples)}};
}
export type ModelEvidence=ReturnType<typeof modelEvidence>;
/** Whitelist numeric provider facts; no IDs, account identities, notes or raw metadata leave the host. */
export function allowanceEvidence(state:ProviderState,at=Date.now()) {
 const allowance=currentAllowance(state.allowance,accountUsageKey(state),at);
 if(!allowance||allowance.availability!=='reported')return {status:'unknown' as const};
 return {status:'reported' as const,source:'codex-app-server' as const,observedAt:date(allowance.observedAt),maxAgeMs:300000,
  ordinaryUsageAllowed:typeof allowance.ordinaryUsageAllowed==='boolean'?allowance.ordinaryUsageAllowed:null,
  windows:allowance.buckets.slice(0,20).flatMap(bucket=>bucket.windows.slice(0,2).filter(window=>number(window.usedPercent)&&window.usedPercent<=100).map(window=>({kind:window.kind==='secondary'?'secondary':'primary',usedPercent:window.usedPercent,windowDurationMins:number(window.windowDurationMins)?window.windowDurationMins:null,resetsAt:number(window.resetsAt)?window.resetsAt:null})))};
}
export function evidenceSummary(observations:Record<string,ModelEvidence>,kind:TaskKind,selected?:string):RouteEvidenceSummary {
 const rows=Object.values(observations),observed=rows.filter(row=>row.samples>0),first=observed.flatMap(row=>'window'in row&&row.window?.firstObservedAt?[row.window.firstObservedAt]:[]).sort(),last=observed.flatMap(row=>'window'in row&&row.window?.lastObservedAt?[row.window.lastObservedAt]:[]).sort();
 return {version:1,source:'relay-run-observations',taskKind:kind,candidateCount:rows.length,candidatesWithSamples:observed.length,sampleCount:observed.reduce((n,row)=>n+row.samples,0),selectedSamples:selected?observations[selected]?.samples??0:0,independentOutcome:'unknown',window:'all-retained-current-account',firstObservedAt:first[0]??null,lastObservedAt:last.at(-1)??null};
}
