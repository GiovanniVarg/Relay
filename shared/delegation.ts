import type {CapabilityRequirementFields} from './capabilities.js';
import type { RouteDecision, RunMode } from './types.js';
import type {UsageObservation} from './provider-usage.js';

export interface DelegationRecord extends CapabilityRequirementFields {
  id: string; parentRunId: string; workerId: string; workerName: string;
  task: string; expectedResult: string; dependsOn: string[];
  status: 'queued' | 'running' | 'attention' | 'complete' | 'failed' | 'cancelled' | 'interrupted' | 'unrun';
  mode: RunMode; workspace: string; route: RouteDecision | null;
  result?: string; error?: string; evidence: string[]; executionVerified: boolean;
  terminationUnconfirmed?: boolean; startedAt?: string; endedAt?: string;
  usageObservation?:UsageObservation; sessionUsage?:UsageObservation;
}
