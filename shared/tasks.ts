import type { CapabilityRequirementFields } from './capabilities.js';
import type { RunStatus } from './types.js';
export type TaskStatus = 'scheduled' | 'queued' | 'working' | 'needs_input' | 'done' | 'failed' | 'cancelled';
export interface TaskEvidenceRef {kind:'tool_receipt'|'artifact';id:string;}
export interface TaskEvidence extends TaskEvidenceRef {assertion:'execution'|'checks_passed'|'checks_failed'|'artifact_integrity'|'pending_activation'|'untrusted';changeId?:string;revision?:string;current?:boolean;}
export interface TaskOutcome {state:'complete'|'continuing'|'blocked'|'deferred';summary:string;remaining:string[];evidence:TaskEvidence[];runId:string;recordedAt:string;verification:'unverified'|'checks_passed'|'activation_applied';}
export interface TaskExternal {requestId:string;changeId:string;revision:string;runId:string;jobId?:string;status:string;}
export interface TaskBudget {calls:number;maxCalls:number;deadline:string;}
export interface TaskReportingBudget {attempt:number;calls:number;remainingMilliseconds:number;lease?:{id:string;runId:string;attempt:number;allocatedMilliseconds:number};}
export interface TaskPendingCheck {requestId:string;changeId:string;revision:string;runId:string;taskId:string;attempt:number;receiptId:string;acceptedAt:string;hostInstanceId:string;state:'accepted'|'running'|'ready'|'failed'|'cancelled'|'unknown';waitLease?:TaskBudget&{startedAt:string;remainingMilliseconds:number;settledAt?:string};}
export interface TaskCheckStatus extends TaskPendingCheck {endedAt?:string;endedMonotonic?:number;current?:boolean;error?:string|null;}
export function taskStatusLabel(task:Task):string {if(task.status==='cancelled'&&task.recoveryRequired)return 'Stop unconfirmed · needs attention';if(task.external&&['queued','pending','waiting_for_shutdown'].includes(task.external.status))return 'Waiting for update';if(task.waitingForChildren)return 'Waiting for team';if(task.phase==='checking'&&task.status==='working')return 'Checking';if(task.status==='done')return task.outcome?.verification==='checks_passed'?'Complete · checks passed':task.outcome?.verification==='activation_applied'?'Update applied':'Complete · unverified';return {scheduled:'Scheduled',queued:'Queued',working:'Working',needs_input:'Needs attention',failed:'Needs attention',cancelled:'Stopped'}[task.status];}
export interface Task extends CapabilityRequirementFields {
  /** Immutable original input IDs within this task's own bot/conversation. Never inherited cross-bot. */
  inputMessageIds?: string[];
  id: string; agentId: string; creatorAgentId?: string; title: string; prompt: string; status: TaskStatus;
  dueAt: string | null; repeatMinutes: number | null; parentTaskId: string | null; parentAttempt: number | null; childTaskIds: string[]; waitingForChildren: boolean;
  runId: string | null; conversationId: string | null; runIds: string[]; attempt: number;
  checkpoint: string; result: string; error: string | null; recoveryRequired: boolean;
  createdAt: string; updatedAt: string; completedAt: string | null;
  outcome?:TaskOutcome;outcomeHistory?:TaskOutcome[];continuations?:number;budget?:TaskBudget;reportingBudgets?:Record<string,TaskReportingBudget>;budgetRenewalRuns?:string[];external?:TaskExternal;externalHistory?:TaskExternal[];pendingCheck?:TaskPendingCheck;phase?:'working'|'checking'|'waiting';
}
export interface TaskInput extends CapabilityRequirementFields { agentId: string; title: string; prompt: string; dueAt?: string | null; repeatMinutes?: number | null; parentTaskId?: string | null; }
export interface TaskRunSnapshot { status: RunStatus; text?: string; error?: string | null; pendingInteractions?: number; observedToolEvents?: number; endedAt?:string|null; }
export interface TaskHooks {
  admit?(agent: import('./types.js').Agent, input: TaskInput): void;
  start(task: Task): Promise<{ runId: string; conversationId: string }>;
  snapshot(runId: string): TaskRunSnapshot | undefined;
  cancel(runId: string): Promise<void>;
  availableCapacity?(task?:Task): boolean;
  /** A saved remote lease may be observed after restart; this never starts or replays work. */
  recoverRun?(task:Task): boolean;
  verifyEvidence?(task:Task,refs:TaskEvidenceRef[]):Promise<TaskEvidence[]>;
  externalStatus?(external:TaskExternal):Promise<TaskExternal>;
  cancelExternal?(requestId:string):boolean;
  recordEvidence?(runId:string,evidence:TaskEvidence[]):void;
  checkStatus?(check:TaskPendingCheck):Promise<TaskCheckStatus>;
}
