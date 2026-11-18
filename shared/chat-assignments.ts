export type AssignmentSource = { kind: 'conversation' | 'group' | 'boss'; id: string };
export type AssignmentTarget = { kind: 'bot' | 'computer'; id: string; name: string; role: string };
export type MessageAttachment = { id: string; hash: string; [key: string]: unknown };
export type AssignmentMessage = {
  id: string; role: string; content: string; createdAt: string; status?: string;
  origin?: string; replyToId?: string; attachments?: MessageAttachment[];
  conversationId?: string; groupId?: string;
};
/** Store adapters normalize source records to this shape; identity covers ownership/revisions. */
export type AssignmentSourceRecord = { id: string; agentId?: string; agentIds?: string[]; identity?: string };
export type ContextCapsule = {
  id: string; source: AssignmentSource; createdAt: string;
  references: { id: string; role: string; content: string }[];
  attachments: { id: string; hash: string }[];
  markdown: string; contentHash: string;
  provenance: { selectedIds: string[]; omittedMessages: number; truncated: boolean; maxMessages: number; maxCharacters: number };
};
export type Assignment = {
  id: string; requestId: string; source: AssignmentSource; messageId?: string;
  agentId: string; computerId?: string; taskId: string; capsuleId: string; createdAt: string;
};
export type AssignmentSnapshot = { state: string; updatedAt?: string; progress?: string; question?: string; result?: string; [key: string]: unknown };
export type AssignmentSubmit = { requestId: string; source: AssignmentSource; content: string; replyToId?: string; attachmentIds?: string[] };
export type AssignmentReceipt = { message?: AssignmentMessage; assignments: Assignment[] };
export type AssignmentRequestRecord = { id: string; hash: string; source: AssignmentSource; messageId?: string; assignmentIds: string[] };
export interface AssignmentStore {
  get<T>(collection: string, id: string): T | undefined;
  list<T>(collection: string): T[];
  put<T extends { id: string }>(collection: string, value: T): T;
  remove(collection: string, id: string): void;
  transaction<T>(work: () => T): T;
  messages(conversationId: string): AssignmentMessage[];
  groupMessages(groupId: string): AssignmentMessage[];
  createConversation(agentId: string, title: string): unknown;
}
export interface ChatAssignmentHooks {
  roster(): AssignmentTarget[];
  defaultAgent(source: AssignmentSource): string;
  preflight(targets: { agentId: string; computerId?: string }[], prompt: string, scope: AssignmentSource, attachments?: MessageAttachment[]): Promise<void>;
  assertWritable(): void;
  validateAttachments(source: AssignmentSource, ids: string[]): MessageAttachment[];
  commitAttachments(source: AssignmentSource, messageId: string, ids: string[]): MessageAttachment[];
  /** Synchronous, in the current Store transaction; reuse Tasks with requestKey and withinTransaction. */
  createTask(input: { assignmentId: string; agentId: string; computerId?: string; prompt: string; source: AssignmentSource; messageId?: string; capsuleId: string; requestKey: string; withinTransaction: true }): { taskId: string };
  snapshot(assignment: Assignment): AssignmentSnapshot;
  cancel(assignment: Assignment): Promise<void>;
  redact(text: string): string;
}
