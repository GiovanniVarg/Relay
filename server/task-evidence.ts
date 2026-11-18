import type {Task,TaskEvidence,TaskEvidenceRef} from '../shared/tasks.js';
import type {HarnessChange} from '../shared/harness-changes.js';
import type {Store} from './store.js';
import {HttpError} from './security.js';
interface ToolReceipt {id:string;runId:string;agentId:string;name:string;status:string;result?:unknown;createdAt?:string;}
/** Execution receipts are facts about a call. Only a host check of the current revision supports check success. */
export async function taskEvidence(store:Store,task:Task,refs:TaskEvidenceRef[],currentChange?:(id:string)=>Promise<HarnessChange>,verifyArtifact?:(id:string)=>Promise<unknown>):Promise<TaskEvidence[]> {
 const evidence:TaskEvidence[]=[];
 for(const ref of refs){
  if(ref.kind==='artifact'){
   const artifact=store.get<{id:string;agentId:string;taskId?:string;runId:string;verifiedAt?:string}>('artifact',ref.id);
   if(!artifact||artifact.agentId!==task.agentId||artifact.taskId!==task.id||!task.runIds.includes(artifact.runId))throw new HttpError(404,'Owned artifact evidence not found');
   if(verifyArtifact)await verifyArtifact(artifact.id);evidence.push({...ref,assertion:verifyArtifact?'artifact_integrity':'execution'});continue;
  }
  const receipt=store.get<ToolReceipt>('workspace-tool',ref.id)??store.get<ToolReceipt>('app-action',ref.id);
  if(!receipt||receipt.agentId!==task.agentId||!task.runIds.includes(receipt.runId)||receipt.status!=='complete')throw new HttpError(404,'Completed receipt in this task scope not found');
  let result=receipt.result as (Partial<HarnessChange>&{requestId?:string;changeId?:string;taskId?:string;runId?:string;attempt?:number;receiptId?:string;hostInstanceId?:string})|undefined;
  if(receipt.name==='relay_check_change'&&result?.requestId){
   const job=store.get<{id:string;requestId:string;taskId:string;agentId:string;runId:string;attempt:number;receiptId:string;changeId:string;revision:string;hostInstanceId:string;state:string}>('source-check-job',result.requestId);
   if(!job||job.requestId!==result.requestId||job.taskId!==task.id||job.taskId!==result.taskId||job.agentId!==task.agentId||job.runId!==receipt.runId||job.runId!==result.runId||job.attempt!==result.attempt||job.receiptId!==receipt.id||job.receiptId!==result.receiptId||job.changeId!==result.changeId||job.revision!==result.revision||job.hostInstanceId!==result.hostInstanceId)throw new HttpError(404,'Owned exact source check evidence not found');
   result={id:job.changeId,revision:job.revision,status:job.state==='ready'?'ready':job.state==='failed'?'failed':'checking',checkedRevision:job.state==='ready'?job.revision:null};
  }
  if(receipt.name==='relay_check_change'&&result&&typeof result.id==='string'&&typeof result.revision==='string'){
   const current=currentChange?await currentChange(result.id):undefined;
   const matches=!!current&&current.revision===result.revision&&current.checkedRevision===result.revision&&current.status==='ready';
   evidence.push({...ref,assertion:result.status==='ready'&&result.checkedRevision===result.revision&&matches?'checks_passed':result.status==='failed'?'checks_failed':'execution',changeId:result.id,revision:result.revision,current:matches});
  }else evidence.push({...ref,assertion:receipt.name==='relay_apply_change'?'pending_activation':receipt.name==='relay_mcp_call'||!receipt.name.startsWith('relay_')?'untrusted':'execution'});
 }
 return evidence;
}
