import {normalizeCodexAllowance,type AllowanceObservation} from '../shared/provider-allowance.js';
import type {ProviderConnection} from '../shared/types.js';
import {accountUsageKey} from './provider-usage.js';
/** Read-only optional RPCs, on the inspected connection; unknown features cannot fail inspection. */
export async function readCodexAllowance(rpc:{request(method:string,params:unknown):Promise<any>},state:ProviderConnection,timeoutMs=750):Promise<AllowanceObservation|undefined>{
 const key=accountUsageKey(state);if(!key)return;
 let timer:ReturnType<typeof setTimeout>|undefined;
 const unknown=()=>normalizeCodexAllowance(undefined,key);
 try{return await Promise.race([Promise.resolve().then(async()=>{
  const value=await rpc.request('account/rateLimits/read',{});
  const after=await rpc.request('account/read',{refreshToken:false});
  const account=after?.account;
  if(account?.type!=='chatgpt'||String(account.email??'').slice(0,180)!==state.accountLabel||String(account.planType??'').slice(0,80)!==state.plan)return unknown();
  return normalizeCodexAllowance(value,key);
 }),new Promise<AllowanceObservation>(resolve=>{timer=setTimeout(()=>resolve(unknown()),timeoutMs);})]);}
 catch{return unknown();}finally{clearTimeout(timer);}
}
