import type {AccountDescriptor} from '../../shared/accounts.js';
import type { ProviderEvent, ProviderId, ProviderRequest, ProviderResult } from '../../shared/types.js';
export interface HerdrStatus { available: boolean; version?: string; error?: string }
export interface WorkerJob { account?:AccountDescriptor; delegationId: string; parentRunId: string; agentId: string; provider: ProviderId; request: Omit<ProviderRequest, 'interact' | 'imageTable'> }
export interface WorkerOutcome { result: ProviderResult; executionVerified: boolean; evidence: string[] }
export type WorkerInference = {phase:'started'} | {phase:'completed';result:ProviderResult};
export interface PaneHandle { workspaceId: string; paneId: string }
export interface HerdrRuntimeContract {
  inspect(): Promise<HerdrStatus>;
  start(command: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<PaneHandle>;
  closePane(pane: PaneHandle): Promise<void>;
  socketPath?: string;
  binary?: string;
}
export interface Binding { delegationId: string; parentRunId: string; epoch: string; token: string; expiresAt: number }
export interface Bootstrap extends Binding {
  endpoint: { host: '127.0.0.1'; port: number }; dataDir: string; job: WorkerJob;
  imageManifest?: import('./images.js').ImageMetadata[];
  herdr?: { socketPath: string; binary: string };
}
export type FrameType = 'ready' | 'imageInit' | 'imageChunk' | 'imagesReady' | 'start' | 'child' | 'event' | 'inference' | 'resultChunk' | 'interaction' | 'interactionExpired' | 'answer' | 'result' | 'failed' | 'cancel' | 'stopped';
export interface Frame { v: 1; delegationId: string; parentRunId: string; epoch: string; token: string; seq: number; type: FrameType; payload: any }
export type EventSink = (event: ProviderEvent) => void;
