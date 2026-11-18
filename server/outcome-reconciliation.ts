import type {ProviderRequest} from '../shared/types.js';
import type {TaskEvidence} from '../shared/tasks.js';
const marked=new WeakSet<ProviderRequest>();
/** Only trusted host code creates this identity; serialized request fields confer no authority. */
export function markOutcomeReconciliation(request:ProviderRequest):ProviderRequest {marked.add(request);return request;}
export function isOutcomeReconciliation(request:ProviderRequest):boolean {return marked.has(request);}
export interface OutcomeReportLease {id:string;taskId:string;runId:string;attempt:number;remainingMilliseconds:number;}
export interface OutcomeReporting {
 context(runId:string,acceptedAnswer:string):Promise<{taskId:string;attempt:number;originalRequest:string;checkpoint:{text:string;characters:number;sha256:string;truncated:boolean};receiptCount:number;receiptIndexSha256:string;receipts:{kind:string;id:string;name:string;status:string;result?:unknown}[];evidence:TaskEvidence[]}|undefined>;
 begin(runId:string):OutcomeReportLease;
 reserve(runId:string,lease:OutcomeReportLease):void;
 assert(runId:string,lease:OutcomeReportLease):void;
 report(runId:string,lease:OutcomeReportLease,value:unknown):Promise<void>;
 settle(runId:string,lease:OutcomeReportLease,remainingMilliseconds:number):void;
}
