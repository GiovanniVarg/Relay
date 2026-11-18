export interface HarnessFile { path: string; hash: string; size: number; }
export interface HarnessDiff { path: string; before: string | null; after: string | null; }
export interface HarnessChange {
  id: string; title: string; agentId: string | null; createdAt: string; updatedAt: string;
  status: 'draft' | 'checking' | 'ready' | 'failed'; revision: string; checkedRevision: string | null;
  checkLog: string; error: string | null; workspaceDirectory: string; previewUrl: string | null;
}
export interface PreparedHarnessChange {
  changeId: string; title: string; revision: string; snapshotDirectory: string; createdAt: string;
  sourceFiles: HarnessFile[]; baseFiles: HarnessFile[]; distFiles: HarnessFile[]; dependencyFiles: HarnessFile[];
  dependenciesIncluded: true;
}
