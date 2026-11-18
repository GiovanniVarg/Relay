import {createHash} from 'node:crypto';
import type {ProviderConnection} from '../shared/types.js';
/** Only a live inspected subscription identity may own effective observations. */
export function accountUsageKey(state:ProviderConnection|undefined):string|null {
 if(!state?.installed||!state.authenticated||!state.accountLabel.trim())return null;
 if(state.id==='opencode')return ['managed','local'].includes(state.authMode)&&/^[a-f0-9]{64}$/.test(state.connectionScope??'')?createHash('sha256').update(JSON.stringify([state.id,state.connectionScope])).digest('hex'):null;
 if(state.authMode!=='subscription')return null;
 return createHash('sha256').update(JSON.stringify([state.id,state.accountLabel.trim(),state.plan,...(state.accountId&&!state.isDefault&&!state.accountId.startsWith('default-')?[state.accountId,state.profileGeneration??'',state.connectionScope??'']:[])])).digest('hex');
}
