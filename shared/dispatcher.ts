import type { Task } from './tasks.js';

export interface DispatcherInput {
  submissionId: string;
  prompt: string;
  agentId?: string;
  /** Opaque attachment staging owner, stable while choosing a recipient. */
  draftId?: string;
  /** Ordered protected draft IDs. Never file bytes or extracted contents. */
  attachmentIds?: string[];
}

export interface DispatcherReceipt {
  submissionId: string;
  taskId: string;
  agentId: string;
  status: Task['status'];
  runId: string | null;
  conversationId: string | null;
  selectionSource: 'jev' | 'local' | 'explicit';
  /** Recovery or run-specific exclusion attention anywhere in the validated current task tree. */
  recoveryRequired: boolean;
  /** Current live runs in this accepted task tree; an empty array suppresses stale root-run fallback. */
  interactionTargets?: { taskId: string; agentId: string; runId: string }[];
  /** Work or recovery attention remains anywhere in the currently validated task tree. */
  activeWork?: boolean;
}
export type DispatcherSubmitResult =
  | { state: 'accepted'; receipt: DispatcherReceipt }
  | { state: 'needs-recipient'; reason: string; candidates: { agentId: string; name: string; role: string }[] };
export interface DispatcherLookup {
  state: 'accepted' | 'pending' | 'unconfirmed' | 'not-found';
  receipt?: DispatcherReceipt;
}
