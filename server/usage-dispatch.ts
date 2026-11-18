import type {ActiveProviderId,ProviderRequest,ProviderResult} from '../shared/types.js';
import {normalizeUsage,reportedUsageCounters,validTurnUsage,type UsageDispatch,type UsageObservation} from '../shared/provider-usage.js';
import {Store,id,now} from './store.js';

/** Trusted dispatch attribution is supplied by the host, never by provider output. */
export function recordUsageDispatch(store:Store,input:{id?:string;provider:ActiveProviderId;accountKey:string|null;request:Pick<ProviderRequest,'runId'|'conversationId'|'model'|'usagePurpose'>;result?:ProviderResult;parentRunId?:string;agentId?:string}) {
 const {request,result,provider,accountKey}=input;
 const existing=input.id?store.get<UsageDispatch>('provider-usage',input.id):undefined;
 if(existing)return {usageObservation:existing.usage,sessionUsage:existing.sessionUsage,usage:validTurnUsage(result?.usage),usageCounters:reportedUsageCounters(result?.usageCounters??result?.usage)};
 const usage=validTurnUsage(result?.usage),usageCounters=reportedUsageCounters(result?.usageCounters??result?.usage);
 const usageObservation=normalizeUsage(usageCounters??{},{provider,accountKey,source:'provider-response',scope:'run',observedAt:now(),...(result?.sessionId?{sessionId:result.sessionId}:{})},usageCounters?'reported':'unavailable');
 let sessionUsage:UsageObservation|undefined;const session=result?.sessionUsage;
 if(session?.provider===provider&&accountKey&&session.accountKey===accountKey&&session.scope==='agent'&&session.sessionId&&session.sessionId===result?.sessionId&&Number.isFinite(Date.parse(session.observedAt)))
  sessionUsage=normalizeUsage({...session.tokens,rawCostCents:session.rawCostCents,chargedCents:session.chargedCents},{provider:session.provider,accountKey,source:'cursor-sdk',scope:'agent',observedAt:session.observedAt,sessionId:session.sessionId},session.availability==='reported'?'reported':'unavailable');
 store.put<UsageDispatch&{parentRunId?:string;agentId?:string;actualModel?:string}>('provider-usage',{id:input.id??id(),runId:request.runId,conversationId:request.conversationId,provider,model:request.model,purpose:request.usagePurpose??'inference',usage:usageObservation,...(sessionUsage?{sessionUsage}:{}),...(input.parentRunId?{parentRunId:input.parentRunId}:{}),...(input.agentId?{agentId:input.agentId}:{}),...(result?.actualModel?{actualModel:result.actualModel}:{})});
 return {usage,usageCounters,usageObservation,sessionUsage};
}
