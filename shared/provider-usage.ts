import type { ActiveProviderId, Usage } from './types.js';
export interface UsageObservation {
 provider:ActiveProviderId; accountKey:string|null; source:'cursor-sdk'|'provider-response'; scope:'run'|'agent'; observedAt:string; sessionId?:string;
 availability:'reported'|'unavailable'; reason?:'unsupported-or-unavailable';
 tokens:{inputTokens:number|null;outputTokens:number|null;cachedInputTokens:number|null;cacheWriteTokens:number|null;totalTokens:number|null;reasoningTokens:number|null};
 rawCostCents:number|null; chargedCents:number|null;
}
export type UsageMetadata=Pick<UsageObservation,'provider'|'accountKey'|'source'|'scope'|'observedAt'|'sessionId'>;
export type ReportedUsageCounters=Partial<Record<keyof UsageObservation['tokens'],number>>;
export function reportedUsageCounters(value:unknown):ReportedUsageCounters|undefined {
 const row=value&&typeof value==='object'?value as Record<string,unknown>:{},result:ReportedUsageCounters={};
 for(const name of ['inputTokens','outputTokens','cachedInputTokens','cacheWriteTokens','totalTokens','reasoningTokens'] as const){const count=usageNumber(row[name]);if(count!==null)result[name]=count;}
 return Object.keys(result).length?result:undefined;
}
export interface UsageDispatch {id:string;runId:string;conversationId:string;provider:ActiveProviderId;model:string;purpose:'inference'|'routing-classifier'|'outcome-reconciliation';usage:UsageObservation;sessionUsage?:UsageObservation;}
export const usageNumber=(value:unknown):number|null=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
/** Whitelist provider fields; absence/invalid values stay unknown rather than becoming zero. */
export function normalizeUsage(value:unknown,meta:UsageMetadata,availability:UsageObservation['availability']='reported'):UsageObservation {
 const row=value&&typeof value==='object'?value as Record<string,unknown>:{};
 return {...meta,availability,...(availability==='unavailable'?{reason:'unsupported-or-unavailable' as const}:{}),tokens:{inputTokens:usageNumber(row.inputTokens),outputTokens:usageNumber(row.outputTokens),cachedInputTokens:usageNumber(row.cachedInputTokens),cacheWriteTokens:usageNumber(row.cacheWriteTokens),totalTokens:usageNumber(row.totalTokens),reasoningTokens:usageNumber(row.reasoningTokens)},rawCostCents:usageNumber(row.rawCostCents),chargedCents:usageNumber(row.chargedCents)};
}
export function validTurnUsage(value:unknown):Usage|undefined {
 if(!value||typeof value!=='object')return;
 const row=value as Record<string,unknown>,inputTokens=usageNumber(row.inputTokens),outputTokens=usageNumber(row.outputTokens),cachedInputTokens=usageNumber(row.cachedInputTokens);
 if(inputTokens===null||outputTokens===null)return;
 return {inputTokens,outputTokens,...(cachedInputTokens!==null?{cachedInputTokens}:{})};
}
export function usageSummary(value:UsageObservation):string {
 const tokens=value.tokens,counts=tokens.inputTokens!==null||tokens.outputTokens!==null?`${tokens.inputTokens??'unknown'} in · ${tokens.outputTokens??'unknown'} out`:'Tokens unknown';
 return `${value.scope==='agent'?'Session snapshot':'Reported usage'} · ${counts}${tokens.cachedInputTokens!==null?` · ${tokens.cachedInputTokens} cached in`:''}${value.chargedCents!==null?` · billed historical ${value.chargedCents}¢`:''}`;
}
