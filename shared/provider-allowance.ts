export interface AllowanceWindow {kind:'primary'|'secondary';usedPercent:number;windowDurationMins:number|null;resetsAt:number|null;}
export interface AllowanceObservation {source:'codex-app-server';accountKey:string;observedAt:string;availability:'reported'|'unavailable'|'stale';ordinaryUsageAllowed:boolean|null;buckets:{limitId:string|null;windows:AllowanceWindow[]}[];}
const nonnegative=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
export function normalizeCodexAllowance(value:unknown,accountKey:string,observedAt=new Date().toISOString()):AllowanceObservation {
 const empty:AllowanceObservation={source:'codex-app-server',accountKey,observedAt,availability:'unavailable',ordinaryUsageAllowed:null,buckets:[]};
 if(!value||typeof value!=='object')return empty;
 const row=value as Record<string,unknown>,multi=row.rateLimitsByLimitId;
 const candidates:[string,unknown][]=multi&&typeof multi==='object'&&!Array.isArray(multi)?Object.entries(multi).slice(0,20):[['legacy',row.rateLimits]];
 const buckets:AllowanceObservation['buckets']=[];
 for(const [id,value] of candidates){if(!value||typeof value!=='object')continue;const bucket=value as Record<string,unknown>,windows:AllowanceWindow[]=[];
  for(const kind of ['primary','secondary'] as const){const raw=bucket[kind];if(!raw||typeof raw!=='object')continue;const item=raw as Record<string,unknown>,usedPercent=nonnegative(item.usedPercent);if(usedPercent===null||usedPercent>100)continue;
   const duration=nonnegative(item.windowDurationMins),reset=nonnegative(item.resetsAt);
   windows.push({kind,usedPercent,windowDurationMins:duration!==null&&duration>0?duration:null,resetsAt:reset!==null&&Number.isSafeInteger(reset)&&reset<=8640000000000?reset:null});
  }
  if(windows.length)buckets.push({limitId:id!=='legacy'&&/^[a-zA-Z0-9_.:-]{1,80}$/.test(id)?id:null,windows});
 }
 const ordinaryUsageAllowed=typeof row.ordinaryUsageAllowed==='boolean'?row.ordinaryUsageAllowed:null;
 return {...empty,availability:buckets.length||ordinaryUsageAllowed!==null?'reported':'unavailable',ordinaryUsageAllowed,buckets};
}
/** Expiry removes current evidence; it never implies a refill or renewed permission. */
export function currentAllowance(value:AllowanceObservation|undefined,accountKey:string|null,at=Date.now()):AllowanceObservation|undefined {
 if(!value||!accountKey||value.accountKey!==accountKey)return;
 const observed=Date.parse(value.observedAt),expired=value.buckets.some(bucket=>bucket.windows.some(window=>window.resetsAt!==null&&window.resetsAt*1000<=at));
 if(!Number.isFinite(observed)||observed>at+30000||at-observed>300000||expired)return {...value,availability:'stale',ordinaryUsageAllowed:null,buckets:[]};
 return value;
}
export function allowanceSummary(value:AllowanceObservation|undefined):string {
 if(!value||value.availability!=='reported')return 'Remaining allowance unknown';
 return value.buckets.flatMap(bucket=>bucket.windows.map(window=>`${bucket.limitId??'Reported limit'} ${window.kind}: ${window.usedPercent}% used${window.resetsAt!==null?` · resets ${new Date(window.resetsAt*1000).toLocaleString()}`:''}`)).join(' · ')||(value.ordinaryUsageAllowed===false?'Provider reports ordinary included usage unavailable':'Provider reports ordinary included usage allowed');
}
