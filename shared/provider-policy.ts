import {isActiveProviderId,type ProviderState,type ModelInfo} from './types.js';
/** Shared eligibility facts. Model discovery is never entitlement or permission. */
export function connectionAuthenticated(state:Pick<ProviderState,'id'|'installed'|'authenticated'|'authMode'|'connectionScope'>):boolean {
 return state.installed&&state.authenticated&&(state.id==='opencode'?['managed','local'].includes(state.authMode)&&/^[a-f0-9]{64}$/.test(state.connectionScope??''):state.authMode==='subscription');
}
export function connectionBillingReady(state:ProviderState):boolean {
 return state.billing.confirmed&&(state.id==='opencode'?['metered','local'].includes(state.billing.mode):['included','metered'].includes(state.billing.mode));
}
export function connectionReady(state:ProviderState,nativeAgent=false,automatic=false):boolean {
 return isActiveProviderId(state.id)&&state.inferenceAvailable!==false&&(!state.nativeAgentOnly||nativeAgent)&&connectionAuthenticated(state)&&connectionBillingReady(state)&&(!automatic||state.billing.automaticRouting);
}
export function modelBillingAllowed(state:ProviderState,model:ModelInfo):boolean {
 return state.id!=='opencode'||state.modelPreferences.allowedModels!==null&&model.toolCalling!==false&&(state.billing.mode!=='local'||model.local===true);
}
