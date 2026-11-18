export type RemoteProviderId = 'openai' | 'claude' | 'cursor' | 'opencode';
export interface RemoteInventory {
  protocolVersion: 1;
  name: string;
  platform: string;
  providers: { id: RemoteProviderId; models: { id: string; name: string; available: boolean; automatic?:boolean; modalities: string[] }[] }[];
  workspaces: string[];
  defaultAgent?: { id: string; provider: RemoteProviderId; model: string; ready: boolean; reason?: string };
}
export interface RemoteJobPayload { [key: string]: unknown }
export interface RemoteQuestion {
  id: string; revision: number; title: string; description: string; localOnly?: boolean;
  questions: { id: string; question: string; options?: { id: string; label: string; description?: string }[] }[];
}
export interface RemoteJobEvent {
  sequence: number; type: 'status' | 'tool' | 'progress' | 'delta' | 'question';
  text?: string; question?: RemoteQuestion;
}
export interface RemoteInteractionAnswer { questionId: string; revision: number; answers: Record<string, string> }
export type RemoteJobState = 'queued' | 'offered' | 'accepted' | 'running' | 'complete' | 'failed' | 'cancelled' | 'unknown' | 'blocked';
export interface RemoteJob {
  id: string; runId: string; taskId: string; attempt: number; agentId: string; computerId: string;
  prompt: string; capsuleId: string; profile?: string; state: RemoteJobState; createdAt: number; updatedAt: number;
  leaseId?: string; leaseExpiresAt?: number; workerInstanceId?: string;
  cancelRequested?: boolean; sequence: number; events: RemoteJobEvent[];
  pendingInteraction?: RemoteQuestion; interactionAnswers: RemoteInteractionAnswer[];
  text?: string; error?: string; summary?: string; endedAt?: number; receiptDigest?: string;
  inspectedAt?: number; inspectionNote?: string;
}
export interface RemoteFinish {
  sequence: number; state: 'complete' | 'failed' | 'cancelled' | 'unknown';
  text: string; summary: string; terminationConfirmed?: boolean;
}
export interface RemotePoll {
  job?: Pick<RemoteJob, 'id' | 'runId' | 'taskId' | 'attempt' | 'agentId' | 'computerId'>;
  leaseId?: string; payload?: RemoteJobPayload; cancelRequested?: boolean;
  interactionAnswers?: RemoteInteractionAnswer[];
}
