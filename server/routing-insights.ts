import {accountMatches,defaultAccountId} from '../shared/accounts.js';
import { ACTIVE_PROVIDER_IDS, isActiveProviderId } from '../shared/types.js';
import type { ActiveProviderId, Run, ProviderConnection } from '../shared/types.js';
import {accountUsageKey} from './provider-usage.js';
import {validInsight} from './routing-evidence.js';
import {currentAllowance,type AllowanceObservation} from '../shared/provider-allowance.js';
import {usageNumber,type UsageObservation,type UsageDispatch} from '../shared/provider-usage.js';
import { HttpError, only, stringValue } from './security.js';
import type { Store } from './store.js';
import type {Task,TaskEvidence} from '../shared/tasks.js';
interface HostChecks {source:'host-relay-check-receipts';scope:'recorded-exact-revision-checks';passed:boolean;failed:boolean;recordedAt:string;}
function hostChecks(evidence:TaskEvidence[]):HostChecks {return {source:'host-relay-check-receipts',scope:'recorded-exact-revision-checks',passed:evidence.some(e=>e.assertion==='checks_passed'&&e.current===true),failed:evidence.some(e=>e.assertion==='checks_failed'&&!evidence.some(ok=>ok.assertion==='checks_passed'&&ok.current===true&&ok.changeId===e.changeId)),recordedAt:new Date().toISOString()};}

export type TaskKind = 'general' | 'coding' | 'research' | 'analysis';
export type Feedback = 'helpful' | 'unhelpful';
export interface RoutingObservation { accountId?:string; hostChecks?:HostChecks;id: string; provider: ActiveProviderId; model: string; taskKind: TaskKind; status: 'complete' | 'failed'; latencyMs: number; inputTokens: number | null; outputTokens: number | null; feedback: Feedback | null; feedbackSource?:'direct-operator'|'agent-recorded'|'unknown';operatorFeedback?:Feedback;operatorFeedbackAt?:string;agentFeedback?:Feedback;agentFeedbackAt?:string; recordedAt: string; accountKey?:string; usage?:UsageObservation; sessionUsage?:UsageObservation; }
export interface ModelInsight { accountId?:string; checksPassedSamples?:number;checksFailedSamples?:number;checksUnknownSamples?:number;provider: ActiveProviderId; model: string; taskKind: TaskKind; accountKey?:string; firstObservedAt?:string; lastObservedAt?:string; samples: number; completed: number; failed: number; completionRate: number; helpful: number; unhelpful: number; agentHelpful?:number;agentUnhelpful?:number;unverifiedFeedbackSamples?:number; meanLatencyMs: number; inputTokens: number; outputTokens: number; usageReportedSamples: number; inputReportedSamples:number;outputReportedSamples:number; }
export interface DeclaredAvailability { accountId?:string; provider: ActiveProviderId; state: 'unknown' | 'available' | 'exhausted'; resetsAt: string | null; note: string; source: 'user' | 'unknown'; updatedAt: string | null; accountKey?:string; }
export interface RoutingSnapshot { models: ModelInsight[]; availability: DeclaredAvailability[]; reportedAllowance:AllowanceObservation[]; recent: RoutingObservation[]; usage: {runs:UsageObservation[];sessions:UsageObservation[];dispatches:UsageDispatch[];remainingAllowance:null;resetAt:null;costNote:string}; allowanceSource: 'user-declared-or-unknown'; price: null; }
const KINDS: TaskKind[] = ['general', 'coding', 'research', 'analysis'];
const count = usageNumber;
/** Buckets describe observations; they are not a claim of universal model strengths. */
export function classifyTask(content: string): TaskKind {
  if (/\b(code|coding|typescript|javascript|python|debug|bug|test failure|repository|refactor|implement)\b/i.test(content)) return 'coding';
  if (/\b(research|sources|competitor|browse|websites|investigate)\b/i.test(content)) return 'research';
  if (/\b(analy[sz]e|analysis|spreadsheet|dataset|statistics|calculate)\b/i.test(content)) return 'analysis';
  return 'general';
}
export class RoutingInsights {
  constructor(private store: Pick<Store, 'get' | 'put' | 'list'>,private providers:()=>ProviderConnection[]=()=>[]) {}
  bindAccounts(providers:()=>ProviderConnection[]) { this.providers=providers; }
  private account(provider:ActiveProviderId,accountId?:string) {return accountUsageKey(this.providers().find(state=>accountMatches(state,provider,accountId)));}
  recordRun(run: Run, taskKind: TaskKind = 'general'): RoutingObservation | undefined {
    if (!run.route || !isActiveProviderId(run.route.provider) || !['complete', 'failed'].includes(run.status)) return;
    if (!KINDS.includes(taskKind)) throw new HttpError(400, 'Invalid task category');
    const existing = this.store.get<RoutingObservation>('routing-observation', run.id); if (existing) return existing;
    const task=this.store.list<Task>('task').find(task=>task.outcome?.runId===run.id),checks=task?.outcome?hostChecks(task.outcome.evidence):undefined;
    const start = Date.parse(run.startedAt), end = run.endedAt ? Date.parse(run.endedAt) : NaN;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new HttpError(400, 'Observation needs a completed time interval');
    return this.store.put<RoutingObservation>('routing-observation', { id: run.id,...(run.route.accountId?{accountId:run.route.accountId}:{}), provider: run.route.provider, model: run.route.model, taskKind, status: run.status as 'complete' | 'failed', latencyMs: end - start,
      inputTokens: count(run.usageObservation?run.usageObservation.tokens.inputTokens:run.usage?.inputTokens), outputTokens: count(run.usageObservation?run.usageObservation.tokens.outputTokens:run.usage?.outputTokens), feedback: null, recordedAt: new Date().toISOString(),...(checks?{hostChecks:checks}:{}),...(run.accountKey?{accountKey:run.accountKey}:{}),...(run.usageObservation?{usage:run.usageObservation}:{}),...(run.sessionUsage?{sessionUsage:run.sessionUsage}:{}) });
  }
  recordChecks(runId:string,evidence:TaskEvidence[]){const observation=this.store.get<RoutingObservation>('routing-observation',runId);if(observation)this.store.put<RoutingObservation>('routing-observation',{...observation,hostChecks:hostChecks(evidence)});}
  /** Source is assigned by host entry points, never accepted in the model/HTTP payload. */
  feedback(runId: string, value: unknown, source:'direct-operator'|'agent-recorded'|'unknown'='unknown'): RoutingObservation {
    if (value !== 'helpful' && value !== 'unhelpful') throw new HttpError(400, 'Feedback must be helpful or unhelpful');
    const observation = this.store.get<RoutingObservation>('routing-observation', runId); if (!observation) throw new HttpError(404, 'Run observation not found');
    const fields:Partial<RoutingObservation>=source==='direct-operator'?{operatorFeedback:value,operatorFeedbackAt:new Date().toISOString()}:source==='agent-recorded'?{agentFeedback:value,agentFeedbackAt:new Date().toISOString()}:{};
    // A later model-tool vote cannot erase the last direct operator vote.
    const direct=source!=='direct-operator'&&observation.operatorFeedback;
    return this.store.put('routing-observation', { ...observation,...fields, feedback:direct||value,feedbackSource:direct?'direct-operator':source });
  }
  setAvailability(provider: string, input: unknown): DeclaredAvailability {
    if (!isActiveProviderId(provider)) throw new HttpError(400, 'Invalid active provider');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Availability must be an object');
    const body = input as Record<string, unknown>; only(body, ['state', 'resetsAt', 'note', 'accountId']);
    if(body.accountId!==undefined&&(typeof body.accountId!=='string'||!this.providers().some(state=>accountMatches(state,provider,body.accountId as string))))throw new HttpError(400,'Choose a connected account for this provider');const accountId=body.accountId as string|undefined;
    if (!['unknown', 'available', 'exhausted'].includes(String(body.state))) throw new HttpError(400, 'Invalid availability state');
    let resetsAt: string | null = null;
    if (body.resetsAt !== undefined && body.resetsAt !== null && body.resetsAt !== '') {
      if (typeof body.resetsAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(body.resetsAt) || !Number.isFinite(Date.parse(body.resetsAt))) throw new HttpError(400, 'Reset time must be an ISO timestamp');
      resetsAt = new Date(body.resetsAt).toISOString();
    }
    const accountKey=this.account(provider,accountId);
    if(!accountKey)throw new HttpError(400,'Refresh a connected subscription account before declaring availability');
    const value: DeclaredAvailability = { provider,...(accountId?{accountId}:{}), state: body.state as DeclaredAvailability['state'], resetsAt, note: body.note === undefined ? '' : stringValue(body.note, 'Allowance note', 500), source: 'user', updatedAt: new Date().toISOString(),...(accountKey?{accountKey}:{}) };
    this.store.put('routing-availability', { id: accountId&&accountId!==defaultAccountId(provider)?accountId:provider, ...value }); return value;
  }
  snapshot(at = Date.now()): RoutingSnapshot {
    const current=this.providers(),accounts=new Set(current.map(state=>accountUsageKey(state)).filter((key):key is string=>!!key));
    const historical = this.store.list<RoutingObservation>('routing-observation').filter(row => isActiveProviderId(row.provider));
    const observations=historical.filter(row=>!!row.accountKey&&accounts.has(row.accountKey)&&KINDS.includes(row.taskKind)&&['complete','failed'].includes(row.status)&&Number.isFinite(row.latencyMs)&&row.latencyMs>=0&&Number.isFinite(Date.parse(row.recordedAt)));
    const groups = new Map<string, RoutingObservation[]>();
    for (const row of observations) { const key = JSON.stringify([row.provider, row.accountKey, row.model, row.taskKind]); const rows = groups.get(key) ?? []; rows.push(row); groups.set(key, rows); }
    const models = [...groups.values()].map(rows => ({ ...(rows[0].accountId?{accountId:rows[0].accountId}:{}), provider: rows[0].provider, model: rows[0].model, taskKind: rows[0].taskKind, accountKey:rows[0].accountKey, firstObservedAt:new Date(rows.reduce((min,row)=>Math.min(min,Date.parse(row.recordedAt)),Infinity)).toISOString(), lastObservedAt:new Date(rows.reduce((max,row)=>Math.max(max,Date.parse(row.recordedAt)),-Infinity)).toISOString(), samples: rows.length, completed: rows.filter(r => r.status === 'complete').length,
      failed: rows.filter(r => r.status === 'failed').length, completionRate: rows.filter(r => r.status === 'complete').length / rows.length,
      helpful: rows.filter(r => r.operatorFeedback === 'helpful').length, unhelpful: rows.filter(r => r.operatorFeedback === 'unhelpful').length,
      checksPassedSamples:rows.filter(r=>r.hostChecks?.source==='host-relay-check-receipts'&&r.hostChecks.passed===true).length,checksFailedSamples:rows.filter(r=>r.hostChecks?.source==='host-relay-check-receipts'&&r.hostChecks.failed===true).length,checksUnknownSamples:rows.filter(r=>!r.hostChecks||r.hostChecks.source!=='host-relay-check-receipts'||!r.hostChecks.passed&&!r.hostChecks.failed).length,
      agentHelpful:rows.filter(r=>r.agentFeedback==='helpful').length,agentUnhelpful:rows.filter(r=>r.agentFeedback==='unhelpful').length,unverifiedFeedbackSamples:rows.filter(r=>(r.feedback==='helpful'||r.feedback==='unhelpful')&&!r.operatorFeedback&&!r.agentFeedback).length,
      meanLatencyMs: Math.round(rows.reduce((n, r) => n + r.latencyMs/rows.length, 0)), inputTokens: rows.reduce((n, r) => n + (count(r.inputTokens) ?? 0), 0), outputTokens: rows.reduce((n, r) => n + (count(r.outputTokens) ?? 0), 0), usageReportedSamples: rows.filter(r => count(r.inputTokens) !== null && count(r.outputTokens) !== null).length,inputReportedSamples:rows.filter(r=>count(r.inputTokens)!==null).length,outputReportedSamples:rows.filter(r=>count(r.outputTokens)!==null).length }));
    const availability = [...ACTIVE_PROVIDER_IDS.map(provider=>({provider,accountId:defaultAccountId(provider)})),...current.filter(state=>state.accountId&&state.accountId!==defaultAccountId(state.id)).map(state=>({provider:state.id as ActiveProviderId,accountId:state.accountId!}))].map(({provider,accountId}) => {
      const saved = this.store.get<DeclaredAvailability>('routing-availability', accountId===defaultAccountId(provider)?provider:accountId);
      if (!saved?.accountKey || saved.accountKey!==this.account(provider,accountId)) return { provider,...(accountId!==defaultAccountId(provider)?{accountId}:{}), state: 'unknown' as const, resetsAt: null, note: '', source: 'unknown' as const, updatedAt: null };
      // A passed reset does not prove renewed access or allowance; uncertainty is explicit.
      return { ...saved, ...(saved.state === 'exhausted' && saved.resetsAt && Date.parse(saved.resetsAt) <= at ? { state: 'unknown' as const } : {}) };
    });
    const sessions=new Map<string,UsageObservation>();
    const dispatches=this.store.list<UsageDispatch>('provider-usage').filter(row=>isActiveProviderId(row.provider)&&!!row.usage.accountKey&&accounts.has(row.usage.accountKey));
    const usageRows=[...observations.map(row=>({accountKey:row.accountKey,sessionUsage:row.sessionUsage})),...dispatches.map(row=>({accountKey:row.usage.accountKey,sessionUsage:row.sessionUsage}))];
    for(const row of usageRows){const usage=row.sessionUsage;if(usage?.scope==='agent'&&usage.sessionId&&usage.accountKey===row.accountKey){const key=JSON.stringify([usage.provider,usage.accountKey,usage.sessionId]),old=sessions.get(key);if(!old||Date.parse(usage.observedAt)>=Date.parse(old.observedAt))sessions.set(key,usage);}}
    const dispatchRuns=new Set(dispatches.map(row=>row.runId));
    const runUsage=[...observations.filter(row=>!dispatchRuns.has(row.id)&&row.usage?.scope==='run'&&row.usage.accountKey===row.accountKey).map(row=>row.usage!),...dispatches.filter(row=>row.purpose==='inference'||row.purpose==='outcome-reconciliation').map(row=>row.usage)];
    const reportedAllowance=current.map(state=>currentAllowance(state.allowance,accountUsageKey(state),at)).filter((value):value is AllowanceObservation=>!!value);
    return { models, availability, reportedAllowance, recent: historical.slice(-50).reverse(),usage:{runs:runUsage.slice(-50).reverse(),sessions:[...sessions.values()].slice(-50),dispatches:dispatches.slice(-50).reverse(),remainingAllowance:null,resetAt:null,costNote:'Provider-reported historical costs may lag. Session totals are snapshots; do not sum repeated snapshots or treat them as turn charges. Classifier and outcome-reconciliation calls are separately labeled in dispatches.'}, allowanceSource: 'user-declared-or-unknown', price: null };
  }
}
/** Separate human preference from turn reliability. Thresholds are conservative policy, not calibrated quality. */
export function measuredPreference(candidates: { provider: ActiveProviderId; accountId?:string; model: string; accountKey?:string|null }[], snapshot: RoutingSnapshot, kind: TaskKind): { provider: ActiveProviderId; accountId?:string; model: string; reason: string } | undefined {
  const scored = candidates.map(candidate => ({ ...candidate, observation: snapshot.models.find(row => row.provider === candidate.provider && row.model === candidate.model && row.taskKind === kind && !!candidate.accountKey && row.accountKey === candidate.accountKey && row.samples >= 3&&validInsight(row)) }));
  if (scored.length < 2 || scored.some(row => !row.observation)) return;
  const reviewed=scored.every(row=>row.observation!.helpful+row.observation!.unhelpful>=3);
  const metric=(row:typeof scored[number])=>{const m=row.observation!;return reviewed?m.helpful/(m.helpful+m.unhelpful):m.completed/m.samples;};
  scored.sort((a,b) => metric(b)-metric(a) || a.observation!.meanLatencyMs-b.observation!.meanLatencyMs);
  const best = scored[0], next = scored[1];
  if (metric(best)-metric(next)<.08) return;
  return { ...(best.accountId?{accountId:best.accountId}:{}), provider: best.provider, model: best.model, reason: `Observed ${kind} ${reviewed?'human preference from direct operator feedback':'provider-turn reliability'}: ${best.observation!.completed}/${best.observation!.samples} turns completed; ${best.observation!.helpful} helpful and ${best.observation!.unhelpful} unhelpful direct operator reviews. Independent task correctness unknown; no price or remaining-allowance estimate.` };
}
