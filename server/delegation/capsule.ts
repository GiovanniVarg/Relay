import {createHash} from 'node:crypto';
import type {DelegationRecord} from '../../shared/delegation.js';
import type {ProviderRequest} from '../../shared/types.js';
import {contextWireCharacters} from '../context-wire.js';
/** Attributed extractive handoff. Full output stays saved; excerpts never certify worker claims. */
export function resultCapsule(record:DelegationRecord,limit=3200,detailScale=1){
 const scale=Math.max(0,Math.min(detailScale,1)),taskLimit=Math.floor(1200*scale),expectedLimit=Math.floor(800*scale),errorLimit=Math.floor(1000*scale),evidenceLimit=Math.floor(350*scale);
 const result=record.result??'',size=Math.max(0,Math.min(limit,6000)),truncated=result.length>size,head=Math.ceil(size*.6),tail=size-head;
 const ranges=truncated?[{start:0,end:head},{start:result.length-tail,end:result.length}]:[{start:0,end:result.length}];
 const excerpt=truncated?result.slice(0,head)+'\n[Saved middle result omitted; see omittedRanges]\n'+result.slice(result.length-tail):result;
 return {delegationId:record.id,parentRunId:record.parentRunId,workerId:record.workerId,worker:record.workerName,status:record.status,task:record.task.slice(0,taskLimit),taskTruncated:record.task.length>taskLimit,expectedResult:record.expectedResult.slice(0,expectedLimit),expectedResultTruncated:record.expectedResult.length>expectedLimit,result:excerpt,resultRanges:ranges,omittedRanges:truncated?[{start:head,end:result.length-tail}]:[],resultCharacters:result.length,resultSha256:createHash('sha256').update(result).digest('hex'),resultTruncated:truncated,...(truncated?{omission:'Full worker output is saved in the attributed delegation record. Omitted text has not been reviewed; report material gaps rather than infer its contents.'}:{}),error:record.error?.slice(0,errorLimit),errorTruncated:(record.error?.length??0)>errorLimit,executionVerified:record.executionVerified,evidence:record.evidence.slice(0,8).map(item=>item.slice(0,evidenceLimit)),evidenceTruncated:record.evidence.length>8||record.evidence.some(item=>item.length>evidenceLimit),trust:'untrusted-worker-output'};
}
export type ResultCapsule=ReturnType<typeof resultCapsule>;
export const incompleteCapsule=(capsule:ResultCapsule)=>capsule.resultTruncated||capsule.evidenceTruncated||capsule.taskTruncated||capsule.expectedResultTruncated||capsule.errorTruncated;
/** Fit the actual nested provider envelopes; fixed human inputs and private references never shrink. */
export function fitResultCapsules(records:DelegationRecord[],input:{instructions:string;history:(capsules:ResultCapsule[])=>ProviderRequest['history'];resultLimit?:number;budget?:number}){
 const budget=Math.min(input.budget??76000,80000),limit=input.resultLimit??3200;
 const candidate=(units:number)=>{const results=records.map(record=>resultCapsule(record,Math.floor(limit*units/1000),units/1000)),history=input.history(results);return{results,history,characters:contextWireCharacters(input.instructions,history)};};
 const full=candidate(1000);if(full.characters<=budget)return full;
 let best=candidate(0);if(best.characters>budget)throw Error('Required human goal, private references and capsule identities exceed the delegation wire budget');
 let low=0,high=999;
 while(low<high){const middle=Math.ceil((low+high)/2),next=candidate(middle);if(next.characters<=budget){low=middle;best=next;}else high=middle-1;}
 if(best.characters>budget)throw Error('Delegation result envelopes exceed the wire budget');
 return best;
}
