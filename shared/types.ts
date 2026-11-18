import type {MessageAttachment} from './attachments.js';
import type { CapabilityRequirementFields } from './capabilities.js';
import type { InferenceQueueStatus } from './inference-status.js';
import type { DelegationRecord } from './delegation.js';
import type {UsageObservation,ReportedUsageCounters} from './provider-usage.js';
import type {AllowanceObservation} from './provider-allowance.js';
/** Legacy provider IDs remain readable in saved routes; only ACTIVE_PROVIDER_IDS may execute. */
export type ProviderId = 'openai' | 'claude' | 'cursor' | 'opencode' | 'gemini' | 'grok';
export const ACTIVE_PROVIDER_IDS = Object.freeze(['openai', 'claude', 'cursor', 'opencode'] as const);
export type ActiveProviderId = typeof ACTIVE_PROVIDER_IDS[number];
export const isActiveProviderId = (value: unknown): value is ActiveProviderId => ACTIVE_PROVIDER_IDS.some(id => id === value);
export type RouteMode = 'auto' | ProviderId;
export type BillingMode = 'unknown' | 'included' | 'metered' | 'local';
export type ChatMode = 'chat' | 'work' | 'auto' | 'agent';
export type RunMode = 'chat' | 'work' | 'agent';
export type RunStatus = 'routing' | 'running' | 'complete' | 'failed' | 'cancelled' | 'interrupted';
export interface Agent {
  id: string; name: string; role: string; initials: string; color: string; accountId?: string;
  instructions: string; memory: string; routeMode: RouteMode; model: string;
  mode: ChatMode; workspace: string;
  /** Optional bounded PNG/JPEG/WebP data URL shown as the bot thumbnail; null or missing means initials. */
  avatar?: string | null;
  pinned: boolean; unread: boolean; lastMessage: string; createdAt: string; updatedAt: string;
}
export interface Conversation { id: string; agentId: string; title: string; createdAt: string; updatedAt: string; }
export interface GroupRoom {
  id: string; title: string; agentIds: string[]; createdAt: string; updatedAt: string;
  mode?: 'roundtable' | 'moderated' | 'delegated'; moderatorAgentId?: string | null;
}
export interface GroupMessage {
  attachments?: MessageAttachment[];
  replyToId?: string;
  id: string; roomId: string; runId: string | null; role: 'user' | 'assistant'; agentId: string | null;
  authorName: string; content: string; createdAt: string; status: Message['status']; route: RouteDecision | null;
}
export interface GroupRun {
  id: string; roomId: string; status: RunStatus; rounds: number; completedReplies: number; totalReplies: number | null;
  modelCalls: number; maxModelCalls: number | null; maxSeconds: number | null; currentAgentId: string | null;
  error: string | null; startedAt: string; endedAt: string | null;
  mode?: 'roundtable' | 'moderated' | 'delegated'; moderatorAgentId?: string | null; moderatorCalls?: number;
  nextSpeakerReason?: string | null; moderatorRoute?: RouteDecision | null; phase?: 'moderating' | 'reply' | 'planning' | 'working' | 'synthesizing' | null;
  executionMode?: 'bounded' | 'continuous' | 'smart'; contextWindowed?: boolean; pendingGuidance?: boolean; delegations?: DelegationRecord[];
}
export type GroupEvent =
  | { type: 'snapshot'; run: GroupRun; messages: GroupMessage[]; interactions?: RunInteraction[] }
  | { type: 'run'; run: GroupRun }
  | { type: 'message'; message: GroupMessage }
  | { type: 'delta'; runId: string; messageId: string; text: string }
  | { type: 'status'; runId: string; message: string }
  | { type: 'delegation'; runId: string; delegation: DelegationRecord }
  | { type: 'interaction'; interaction: RunInteraction }
  | { type: 'interactionResolved'; runId: string; interactionId: string; status: 'answered' | 'expired' }
  | { type: 'done'; run: GroupRun };
export interface Message {
  replyToId?: string;
  attachments?: MessageAttachment[];
  id: string; conversationId: string; role: 'user' | 'assistant'; content: string;
  origin?:'human'|'task-continuation';
  createdAt: string; runId: string | null; status: 'complete' | 'streaming' | 'error' | 'cancelled';
}
export interface LibraryFile { id: string; agentId: string; name: string; content: string; size: number; createdAt: string; }
export interface Usage { inputTokens: number; outputTokens: number; cachedInputTokens?: number; }
export interface RouteEvidenceSummary {
 version:1; source:'relay-run-observations'; taskKind:'general'|'coding'|'research'|'analysis';
 candidateCount:number; candidatesWithSamples:number; sampleCount:number; selectedSamples:number;
 independentOutcome:'unknown'; window:'all-retained-current-account'; firstObservedAt:string|null; lastObservedAt:string|null;
}
export interface RouteDecision { accountId?:string; provider: ProviderId; model: string; reason: string; strategy: 'manual' | 'direct' | 'classifier'; evidence?:RouteEvidenceSummary; classifier?: { provider: 'typesafe' | 'openai'; model: string; usage?: { inputTokens: number; outputTokens: number } }; }
export interface ContextDiagnostics {
  localReuse?:{kind:'extractive-pack'|'committed-native-references';referenceCharacters:number;referencesIncluded:number;referencesOmitted:number;reusedReferenceMessages?:number;avoidedReferenceCharacters?:number};
  version:1; mode:'reconstructed'|'windowed'|'native-resumed'; characters:number; budget:number;
  provenance?:'reconstructed-pack'|'native-delta'; packHash?:string;
  attachments?:{included:string[];omitted:string[]};
  historyTotal:number; historyIncluded:number; sourceTotal:number; omittedHistory:number; omittedSources:number; hash:string;
  sources:{id:string;kind:'history'|'file'|'memory'|'knowledge'|'attachment';start:number;end:number;total:number;aliases?:{id:string;name:string;kind:'history'|'file'|'memory'|'knowledge'|'attachment';provenance?:unknown}[]}[];
}
export interface Run extends CapabilityRequirementFields {
  accountId?:string;
  /** Host-observed tool activity. Missing on legacy records means unknown, never zero. */
  observedToolEvents?: number;
  /** Host facts from the actual inference dispatch, never mutable bot configuration. */
  capabilityBinding?: import('./capabilities.js').CapabilityResolution;
  /** Host-owned canonical original input anchors, never client-selected read authority. */
  inputMessageIds?: string[];
  id: string; agentId: string; conversationId: string; messageId: string; status: RunStatus;
  route: RouteDecision | null; error: string | null; startedAt: string; endedAt: string | null; usage: Usage | null;
  mode?: RunMode; executionSeconds?:number;context?: ContextDiagnostics; accountKey?:string; usageObservation?:UsageObservation; sessionUsage?:UsageObservation;
}
export interface ModelInfo {
 id:string;name:string;verified:boolean;description?:string;
 backendProviderId?:string;backendProviderName?:string;nativeModelId?:string;
 contextWindow?:number;outputLimit?:number;toolCalling?:boolean;reasoning?:boolean;
 /** Controlled loopback endpoint, not a promise of zero cost. */
 local?:boolean;
 provenance?:{source:string;observedAt:string;revision?:string};
 inputModalities?:import('./capabilities.js').InputModality[];inputModalitiesSource?:'provider-catalog'|'official-model-docs';
 /** Image-bearing Claude requests pin this reviewed concrete model; text keeps the logical alias. */
 imageModelBinding?:{model:string;contract:string};
}
export interface ModelCatalogQuery {query?:string;backendProviderId?:string;cursor?:string;limit?:number;enabledOnly?:boolean;}
export interface ModelCatalogPage {accountId?:string;provider:ProviderId;revision:string;observedAt:string|null;total:number;items:ModelInfo[];nextCursor:string|null;connectionScope?:string;metadataSummary?:true;}
export interface BillingConfig { mode: BillingMode; confirmed: boolean; automaticRouting: boolean; allowanceNote: string; }
export interface ProviderConnection {
  allowance?:AllowanceObservation;
  id: ProviderId; accountId?:string; accountName?:string; profileGeneration?:string; isDefault?:boolean; installed: boolean; authenticated: boolean;
  authMode: 'subscription' | 'api-key' | 'managed' | 'local' | 'unknown'; accountLabel: string; plan: string;
  /** Opaque private native configuration and credential fingerprint; no key values. */
  connectionScope?:string;
  models: ModelInfo[]; error?: string; quota?: string;
  /** Account/model discovery may be available before this integration can safely send prompts. */
  inferenceAvailable?: boolean;
  /** Sending requires a direct native Agent run, a project workspace and native permission callbacks. */
  nativeAgentOnly?: boolean;
}
export interface ModelPreferences { defaultModel: string; allowedModels: string[] | null; }
export interface ProviderState extends ProviderConnection { billing: BillingConfig; modelPreferences: ModelPreferences; }
export type Appearance = 'light' | 'dark' | 'system';
export type ResolvedAppearance = 'light' | 'dark';
export interface Settings { appearance?: Appearance; maxRunSeconds: number; maxModelCalls: number; openaiDefaultModel: string; maxWorkSeconds?: number; routingClassifier?: 'typesafe' | 'openai' | 'rules'; }
export interface TelegramStatus { configured: boolean; enabled: boolean; botUsername: string; allowedUserId: number | null; running: boolean; error: string | null; }
export interface Bootstrap {
  agents: Agent[]; conversations: Conversation[]; rooms: GroupRoom[]; providers: ProviderState[]; settings: Settings;
  homeDirectory?: string;
  accounts?:import('./accounts.js').AccountState[];
  computers?:{id:string;name:string;platform:string;online:boolean;ready:boolean;modelCount:number}[];
  csrfToken: string; version: string;
}
export interface InteractionPrompt {
  kind: 'approval' | 'question'; title: string; description: string; details?: string;
  questions?: { id: string; question: string; options?: string[]; multiple?: boolean }[];
}
export interface InteractionAnswer { decision: 'allow' | 'deny'; answers?: Record<string, string[]>; }
export interface RunInteraction extends InteractionPrompt {
  id: string; runId: string; provider: ProviderId; status: 'pending' | 'answered' | 'expired'; humanRequired?: true; workerId?: string; workerName?: string;
}
export type RunEvent =
  | { type: 'route'; run: Run }
  | { type: 'delta'; runId: string; text: string }
  | { type: 'status'; runId: string; message: string }
  | { type: 'tool'; runId: string; name: string; summary: string }
  | { type: 'interaction'; interaction: RunInteraction }
  | { type: 'interactionResolved'; runId: string; interactionId: string; status: 'answered' | 'expired' }
  | { type: 'done'; run: Run; message: Message };
export interface AppToolDefinition { name: string; description: string; inputSchema: Record<string, unknown>; }
export interface ProviderHistory {role:'user'|'assistant';content:string;messageId?:string;attachments?:MessageAttachment[];imageRefs?:string[];contextReference?:{id:string;revision:string;start:number;end:number;hash:string};}
export interface ProviderImage {attachmentId:string;messageId:string;sha256:string;mimeType:'image/png'|'image/jpeg'|'image/webp';data:string;width:number;height:number;}
export interface ProviderRequest extends CapabilityRequirementFields {
  accountId?:string; accountProfileGeneration?:string;
  /** Ephemeral operation-private bytes; never persist or emit. */
  imageTable?:ProviderImage[];
  /** Host-owned actual logical execution, including Cursor app-only Agent over Chat transport. */
  execution?: {mode:RunMode;surface?:import('./capabilities.js').CapabilitySurface;workspace?:string};
  /** Host metadata only; attachment resolution rechecks owner and conversation. */
  inputMessageIds?: string[];
  usagePurpose?:'inference'|'routing-classifier'|'outcome-reconciliation';
  runId: string; conversationId: string; model: string; instructions: string;
  history: ProviderHistory[];
  maxSeconds: number;
  /** Host-only continuation metadata. Never include this in model instructions. */
  continuity?: {agentId:string;binding:string;references?:string;sessionId?:string;accountKey?:string;delta:ProviderRequest['history'];localReuse?:{referenceMessages:number;avoidedCharacters:number}};
  /** Defaults to 'chat' (text-only, tools off). 'work' and native 'agent' require `workspace`. */
  mode?: RunMode; workspace?: string;
  interact?: (prompt: InteractionPrompt, signal?: AbortSignal) => Promise<InteractionAnswer>;
  /** Process-local Relay app authority. Never serialize this callback into provider prompts or worker jobs. */
  appTools?: { definitions: AppToolDefinition[]; call: (callId: string, name: string, args: unknown) => Promise<unknown> };
  expectedAccount: { accountLabel: string; plan: string };
  expectedConnectionScope?:string;
}
export type ProviderEvent = { type: 'delta'; text: string } | { type: 'status'; message: string } | { type: 'tool'; name: string; summary: string };
export interface ProviderResult { text: string; sessionId?: string; usage?: Usage; usageCounters?:ReportedUsageCounters; usageObservation?:UsageObservation; sessionUsage?:UsageObservation; actualModel?: string; continuity?: {mode:'native-resumed'|'reconstructed';accountKey:string;inputHash?:string;inputCharacters?:number}; }
export interface LoginResult { url?: string; message: string; command?: string; }
export interface ProviderAdapter {
  id: ProviderId;
  inspect(): Promise<ProviderConnection>;
  login(): Promise<LoginResult>;
  /** Process-local dispatch check, evaluated after a shared inference slot is granted. Never serialize this callback. */
  /** queueWait is scheduler-only: begin returns an exactly-once settlement, with true only on admission. Never forward it to a raw provider. */
  stream(request: ProviderRequest, emit: (event: ProviderEvent) => void, signal: AbortSignal, beforeDispatch?: () => void,
    queueWait?: () => (admitted: boolean) => void, queueStatus?: (status:InferenceQueueStatus)=>void): Promise<ProviderResult>;
  close(): Promise<void>;
}
