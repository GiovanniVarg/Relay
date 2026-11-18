/** Fixed, public activity labels: never include workspace, account or exclusion identities. */
export const INFERENCE_STATUS = {
  capacity: 'Waiting for inference capacity…',
  workspace: 'Waiting for another job in this workspace…',
  'safety-hold': 'Waiting for an unresolved safety hold…',
  admitted: 'Working…',
} as const;
export type InferenceQueueStatus = keyof typeof INFERENCE_STATUS;
export const inferenceWaitingMessage = (message?: string) =>
  Object.entries(INFERENCE_STATUS).find(([status, label]) => status !== 'admitted' && label === message)?.[1];
