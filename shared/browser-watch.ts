import type { BrowserStatus } from './capabilities.js';

export type BrowserWatchAction = 'open' | 'read' | 'click' | 'fill' | 'screenshot' | 'takeover' | 'return' | 'stop' | 'revoke';
export type BrowserWatchPhase = 'started' | 'complete' | 'failed';
export type BrowserWatchClearReason = 'session_closed' | 'session_replaced' | 'revoked' | 'shutdown' | 'unavailable' | 'navigation';
interface BrowserWatchBase { agentId: string; sequence: number; observedAt: string; sessionId: string | null; }
/** Connection-local sequence begins at 1 with status. Frames are ephemeral operator-only page pixels. */
export type BrowserWatchEvent = BrowserWatchBase & (
 | { type: 'status'; status: BrowserStatus }
 | { type: 'frame'; sessionId: string; url: string; jpeg: string; capturedAt: string }
 | { type: 'activity'; action: BrowserWatchAction; phase: BrowserWatchPhase }
 | { type: 'clear'; reason: BrowserWatchClearReason }
);
export type BrowserWatchPayload = BrowserWatchEvent extends infer E ? E extends BrowserWatchEvent ? Omit<E, 'agentId' | 'sequence' | 'observedAt'> : never : never;
export type BrowserStopResult = { status: 'stop_requested'; browser: BrowserStatus } | { status: 'stop_unconfirmed'; browser: BrowserStatus; reasons: string[]; error: string };
