export type KnowledgeScope = 'private' | 'shared';
export type KnowledgeKind = 'note' | 'routine';
export interface KnowledgeEntry {
  id: string; agentId: string; title: string; content: string; scope: KnowledgeScope; kind: KnowledgeKind;
  status: 'pending' | 'approved' | 'rejected'; sourceRunId: string | null; createdAt: string; updatedAt: string;
}
export interface KnowledgeInput { agentId: string; title: string; content: string; scope?: KnowledgeScope; kind?: KnowledgeKind; sourceRunId?: string | null; }
