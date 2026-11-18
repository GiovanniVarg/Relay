import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeCodexAllowance,currentAllowance,allowanceSummary} from '../shared/provider-allowance.js';
import {readCodexAllowance} from '../server/provider-allowance.js';
import {accountUsageKey} from '../server/provider-usage.js';
import type {ProviderConnection} from '../shared/types.js';
const state:ProviderConnection={id:'openai',installed:true,authenticated:true,authMode:'subscription',accountLabel:'fixture',plan:'team',models:[]},key=accountUsageKey(state)!;
const raw={ordinaryUsageAllowed:false,accountId:'private-account',rateLimitsByLimitId:{codex:{primary:{usedPercent:0,windowDurationMins:300,resetsAt:2000000000},secondary:{usedPercent:100,windowDurationMins:10080,resetsAt:2000000010},credits:{balance:'secret'},individualLimit:{raw:'secret'}}},rateLimitResetCredits:{secret:true},rateLimitUpsell:{secret:'never-forward'}};
test('Codex allowances whitelist reported zero and multiple windows; unsupported and invalid remain unknown',()=>{
 const result=normalizeCodexAllowance(raw,key,'2026-10-26T12:00:00Z');assert.equal(result.availability,'reported');assert.equal(result.ordinaryUsageAllowed,false);assert.equal(result.buckets[0].windows[0].usedPercent,0);assert.equal(result.buckets[0].windows[1].usedPercent,100);assert.equal(result.buckets[0].windows[0].resetsAt,2000000000);assert.ok(!JSON.stringify(result).includes('secret'));assert.ok(!JSON.stringify(result).includes('private-account'));assert.match(allowanceSummary(result),/0% used/);
 for(const value of [null,{}, {rateLimits:{primary:{usedPercent:-1}}},{rateLimits:{primary:{usedPercent:Infinity}}},{rateLimits:{primary:{usedPercent:101}}}]){const missing=normalizeCodexAllowance(value,key);assert.equal(missing.availability,'unavailable');assert.equal(missing.ordinaryUsageAllowed,null);assert.equal(missing.buckets.length,0);}
 const legacy=normalizeCodexAllowance({rateLimits:{primary:{usedPercent:34,windowDurationMins:null,resetsAt:null}}},key);assert.equal(legacy.buckets[0].windows[0].usedPercent,34);assert.equal(legacy.buckets[0].windows[0].resetsAt,null);
});
test('stale or elapsed resets never imply renewed included access; changed identity excludes measurements',()=>{
 const at=Date.parse('2026-10-26T12:00:00Z'),result=normalizeCodexAllowance(raw,key,new Date(at).toISOString());assert.equal(currentAllowance(result,key,at)!.ordinaryUsageAllowed,false);
 assert.equal(currentAllowance(result,'other',at),undefined);const stale=currentAllowance(result,key,at+300001)!;assert.equal(stale.availability,'stale');assert.equal(stale.ordinaryUsageAllowed,null);assert.equal(stale.buckets.length,0);
 const expired=normalizeCodexAllowance({...raw,rateLimitsByLimitId:{codex:{primary:{usedPercent:100,resetsAt:Math.floor(at/1000)}}}},key,new Date(at).toISOString());assert.equal(currentAllowance(expired,key,at)!.availability,'stale');assert.equal(currentAllowance(expired,key,at)!.ordinaryUsageAllowed,null);
 assert.equal(currentAllowance(result,key,at-60000)!.availability,'stale');
});
test('bounded read-only Codex RPC inspection revalidates account, handles unsupported/late reads without inference',async()=>{
 const methods:{method:string;params:unknown}[]=[];const rpc={request:async(method:string,params:unknown)=>{methods.push({method,params});return method==='account/read'?{account:{type:'chatgpt',email:'fixture',planType:'team'}}:raw;}};
 const result=await readCodexAllowance(rpc,state,10);assert.equal(result!.availability,'reported');assert.deepEqual(methods,[{method:'account/rateLimits/read',params:{}},{method:'account/read',params:{refreshToken:false}}]);
 for(const request of [async()=>{throw Error('Unsupported secret');},async()=>new Promise(()=>{}),async(method:string)=>method==='account/read'?{account:{type:'chatgpt',email:'changed',planType:'team'}}:raw]){const missing=await readCodexAllowance({request},state,10);assert.equal(missing!.availability,'unavailable');assert.equal(missing!.ordinaryUsageAllowed,null);assert.ok(!JSON.stringify(missing).includes('secret'));}
});
