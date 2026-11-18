import {resolveCapabilities,type CapabilityInput} from '../shared/capabilities.js';
import {parseCapabilityRequirements,parseRequiredInputModalities,type CapabilityRequirementFields} from '../shared/capabilities.js';
import type { BrowserGrant, ProviderCapabilities } from '../shared/capabilities.js';
import { isActiveProviderId, type Agent, type ProviderState } from '../shared/types.js';
import { Store, now } from './store.js';
import { HttpError } from './security.js';

export class Capabilities {
  constructor(readonly store: Store) {}
  browserGrant(agentId: string): BrowserGrant {
    if (!this.store.get<Agent>('agent', agentId)) throw new HttpError(404, 'Bot not found');
    return this.store.get<BrowserGrant>('browser-grant', agentId) ?? { id: agentId, agentId, enabled: false, updatedAt: '' };
  }
  /** Used by authenticated settings and live Agent actions for the requested task. */
  setBrowserGrant(agentId: string, enabled: boolean): BrowserGrant {
    this.browserGrant(agentId);
    if (typeof enabled !== 'boolean') throw new HttpError(400, 'Browser access must be true or false');
    return this.store.put<BrowserGrant>('browser-grant', { id: agentId, agentId, enabled, updatedAt: now() });
  }
  matrix(providers: ProviderState[], context:Omit<CapabilityInput,'provider'|'model'>={mode:'chat',surface:'run',host:{nativeToolsAvailable:true,callableTools:[],transportInputModalities:['text']}}): ProviderCapabilities[] {
    return providers.filter(provider=>isActiveProviderId(provider.id)).map(provider=>{
      const model=provider.models.find(item=>item.id===provider.modelPreferences.defaultModel)??provider.models[0]??{id:'unknown',name:'Unknown',verified:false};
      const details=resolveCapabilities({...context,provider:provider.id,model});
      return {provider:provider.id,appTools:details.capabilities.appTools.support==='supported',browser:details.capabilities.browser.support==='supported',nativeTools:details.capabilities.nativeTools.support==='supported',nativeWorkers:details.capabilities.nativeWorkers.support==='supported',details,models:provider.models.map(model=>({model:model.id,modalities:resolveCapabilities({...context,provider:provider.id,model}).modalities})),notes:'Support is separate from this execution\'s current readiness and exact callable tools. Native workers describes this provider\'s own execution, not task orchestration. Browser grant, engine availability and human takeover remain separate. Groups are tool-free Chat; worker outputs and digest verification do not prove task correctness.'};
    });
  }
}

/** Invalid client/tool constraints are input errors, never relaxed requirements. */
export function taskRequirements(value: CapabilityRequirementFields | Record<string,unknown>): CapabilityRequirementFields {
  try { const requiredCapabilities=parseCapabilityRequirements(value.requiredCapabilities),requiredInputModalities=parseRequiredInputModalities(value.requiredInputModalities);return {...(requiredCapabilities?{requiredCapabilities}:{}),...(requiredInputModalities?{requiredInputModalities}:{})}; }
  catch(error){throw new HttpError(400,error instanceof Error?error.message:'Invalid task requirements');}
}
export function mergeTaskRequirements(...values: (CapabilityRequirementFields | undefined)[]): CapabilityRequirementFields {
  const parsed=values.filter((value):value is CapabilityRequirementFields=>!!value).map(taskRequirements),caps=Object.assign({},...parsed.map(value=>value.requiredCapabilities??{})),modalities=[...new Set(parsed.flatMap(value=>value.requiredInputModalities??[]))];
  return taskRequirements({...((Object.keys(caps).length)?{requiredCapabilities:caps}:{}),...(modalities.length?{requiredInputModalities:modalities}:{})});
}
