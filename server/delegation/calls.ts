import {selectedAccount} from '../../shared/accounts.js';
import type {CapabilityRequirementFields} from '../../shared/capabilities.js';
import type {RouteCapabilityContext} from '../router.js';
import { isActiveProviderId } from '../../shared/types.js';
import type { Agent, GroupRun, ProviderRequest, ProviderResult, ProviderState, RouteDecision, RunMode, Settings } from '../../shared/types.js';
import { enabledModels, permitted, validateManual } from '../router.js';
import { Runs } from '../runs.js';
import { Store } from '../store.js';
import {fileSources,selectReferenceMessages} from '../context-pack.js';
import {bindGroupImageAuthority,type GroupImageAuthority} from '../group-image-authority.js';
import type {ProviderImage} from '../../shared/types.js';

export interface CallContext {
  run: GroupRun;
  providers: ProviderState[];
  settings: Settings;
  signal: AbortSignal;
  update: () => void;
  routingTask?: string;
  imageAuthority?:GroupImageAuthority;
  inputRevision?:()=>number;
}
export function boundedInput(instructions: string, history: ProviderRequest['history']) {
  if (instructions.length + history.reduce((n, item) => n + item.content.length, 0) > 80000) throw new Error('Delegation context exceeds 80,000 characters. Reduce private memory or files.');
}
export function privateReference(store: Store, agent: Agent, current=''): ProviderRequest['history'] {
  const sources = [...fileSources(store.files(agent.id)),...(agent.memory?[{id:'memory:'+agent.id,name:'Own bot memory',kind:'memory' as const,content:agent.memory}]:[])];
  if (!sources.length) return [];
  return selectReferenceMessages({instructions:agent.instructions,current,sources}).history;
}

export class DelegationCalls {
  constructor(private runs: Runs) {}
  expected(context: CallContext, provider: ProviderState['id'], model: string, automatic: boolean, capability?:RouteCapabilityContext,accountId?:string) {
    if (context.signal.aborted) throw context.signal.reason ?? new Error('Delegation cancelled');
    const current = selectedAccount(this.runs.accountProviders(),provider,accountId);
    const snapshot = selectedAccount(context.providers,provider,accountId);
    if (!current || !snapshot || !snapshot.accountLabel.trim() || current.accountLabel !== snapshot.accountLabel || current.plan !== snapshot.plan || current.connectionScope !== snapshot.connectionScope) throw new Error('Subscription account changed during delegation; refresh and confirm the current account.');
    if (!permitted(current, automatic,capability?.mode==='agent'&&!!capability.workspace)) throw new Error('Subscription access or billing permission was revoked during delegation');
    if (!enabledModels(current).some(item => item.id === model)) throw new Error('The selected model was removed or disabled during delegation');
    validateManual([current],provider,model,capability?.mode==='agent'&&!!capability.workspace,capability,accountId);
    return { accountLabel: snapshot.accountLabel, plan: snapshot.plan };
  }
  connectionScope(context:CallContext,provider:ProviderState['id'],accountId?:string) {return selectedAccount(context.providers,provider,accountId)?.connectionScope;}
  async route(context: CallContext, agent: Agent, content: string, mode: RunMode, worker = false, requirements:CapabilityRequirementFields={}): Promise<RouteDecision> {
    await this.runs.refresh();
    const providers=context.providers.filter(item=>isActiveProviderId(item.id));
    const capability=this.runs.capabilityContext(mode,mode==='chat'?undefined:agent.workspace,agent.id,{...requirements,...(worker&&mode!=='chat'?{requiredCapabilities:{...requirements.requiredCapabilities,nativeTools:true}}:{})},worker?'herdr':'group',[]);
    validateManual(providers,agent.routeMode,agent.routeMode==='auto'?'':agent.model,mode==='agent'&&!!agent.workspace,capability,agent.accountId);
    const started = Date.now();
    return this.runs.chooseRoute({
      accountId:agent.accountId,capability,nativeAgent:mode==='agent'&&!!agent.workspace,content, mode: agent.routeMode, model: agent.routeMode === 'auto' ? '' : agent.model, states: providers, settings: context.settings,
      signal: context.signal, remainingSeconds: () => Math.max(0, Math.min(context.settings.maxRunSeconds - (Date.now() - started) / 1000, context.run.maxSeconds === null ? Infinity : context.run.maxSeconds - (Date.now() - Date.parse(context.run.startedAt)) / 1000)),
      call: async (provider, model, instructions, input,accountId) => {
        const expectedAccount = this.expected(context, provider, model, true,undefined,accountId); context.run.modelCalls++; context.update();
        const result = await this.runs.call(provider, { runId: context.run.id, conversationId: 'delegation-route-' + context.run.id, usagePurpose:'routing-classifier', accountId, model, mode: 'chat', instructions, history: [{ role: 'user', content: input }], maxSeconds: context.settings.maxRunSeconds, expectedAccount,expectedConnectionScope:this.connectionScope(context,provider,accountId) }, () => {}, context.signal, true);
        if (result.actualModel && result.actualModel !== model) throw new Error('Provider reported a different routing model');
        if (result.text.length > 16000) throw new Error('Routing output exceeds 16,000 characters');
        return result.text;
      },
    });
  }
  async local(context: CallContext, agent: Agent, purpose: 'plan' | 'synthesis', instructions: string, history: ProviderRequest['history'], delta?: (text: string) => void, images?:readonly ProviderImage[]): Promise<{ result: ProviderResult; route: RouteDecision }> {
    boundedInput(instructions, history);
    const inputRevision=context.inputRevision?.();
    const assertFresh=()=>{if(inputRevision!==context.inputRevision?.())throw new Error('Human guidance changed while the lead waited to dispatch. No stale lead input was sent; start a new task to include the saved guidance.');};
    const requirements:CapabilityRequirementFields=images?.length?{requiredInputModalities:['image']}:{};
    const route = await this.route(context, agent, context.settings.routingClassifier === 'typesafe' ? context.routingTask ?? '' : history.at(-1)?.content ?? '', 'chat',false,requirements);
    assertFresh();
    const expectedAccount = this.expected(context, route.provider, route.model, agent.routeMode === 'auto',this.runs.capabilityContext('chat',undefined,agent.id,requirements,'group',[]),route.accountId);
    context.run.moderatorRoute = route; context.run.modelCalls++; context.run.status = 'running'; context.update();
    let streamed = 0;
    const request:ProviderRequest={
      accountId:route.accountId,runId: context.run.id, conversationId: 'delegation-' + purpose + '-' + context.run.id, model: route.model, mode: 'chat',
      instructions, history,...requirements,...(images?.length?{imageTable:[...images],execution:{surface:'group' as const,mode:'chat' as const}}:{}), maxSeconds: context.settings.maxRunSeconds, expectedAccount,expectedConnectionScope:this.connectionScope(context,route.provider,route.accountId),
    };
    if(images?.length){if(!context.imageAuthority)throw new Error('Delegated lead image authority is unavailable');bindGroupImageAuthority(request,context.imageAuthority);}
    const result = await this.runs.call(route.provider,request, event => {
      if (context.signal.aborted || event.type !== 'delta' || !delta) return;
      streamed += event.text.length;
      if (streamed > 16000) throw new Error('The lead reply exceeds 16,000 characters');
      delta(event.text);
    }, context.signal, agent.routeMode === 'auto',undefined,undefined,assertFresh);
    if (context.signal.aborted) throw context.signal.reason ?? new Error('Delegation cancelled');
    if (result.actualModel && result.actualModel !== route.model) throw new Error('Provider reported a different lead model');
    if (!result.text || result.text.length > 16000) throw new Error('The lead returned an empty or oversized result');
    return { result, route };
  }
}
