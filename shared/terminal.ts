/** Human-only terminal protocol. Never add these endpoints to model tools. */
export const TERMINAL_LIMITS = {sessions:4,inputBytes:16*1024,bodyBytes:128*1024,pendingInputBytes:64*1024,outputChunkBytes:16*1024,replayBytes:512*1024,streamBacklogBytes:1024*1024,blockedMs:5000,expirySweepMs:15000,pendingRenderBytes:128*1024,scrollback:2000,minCols:20,maxCols:500,minRows:5,maxRows:200} as const;
export interface TerminalShell {id:string;label:string}
export interface TerminalCatalog {platform:string;shells:TerminalShell[];engine:'unchecked'|'ready'|'unavailable';error?:string}
export type TerminalState = 'starting'|'live'|'stopping'|'uncertain'|'exited';
export interface TerminalSession {id:string;shellId:string;shellLabel:string;cwd:string;context:string|null;state:TerminalState;cols:number;rows:number;sequence:number;warning?:string;exitCode?:number;signal?:number}
export interface TerminalStart {shellId:string;agentId?:string;cols:number;rows:number}
export interface TerminalInput {leaseId:string;sequence:number;data:string}
export interface TerminalResize {leaseId:string;cols:number;rows:number}
export type TerminalEvent =
 | {type:'status';session:TerminalSession;leaseId:string|null;nextInputSequence:number}
 | {type:'output';sessionId:string;sequence:number;data:string}
 /** Reset renderer and set fully rendered cursor to sequence; only future output follows. */
 | {type:'gap';sessionId:string;sequence:number;reason:string}
 | {type:'exit';session:TerminalSession};
export interface TerminalCurrent {session:TerminalSession|null}
export interface TerminalStarted {session:TerminalSession}
export interface TerminalStopped {session:TerminalSession}
