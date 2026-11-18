import {isActiveProviderId} from '../shared/types.js';
import { createHash } from 'node:crypto';
import type { Agent, AppToolDefinition, ProviderRequest, Run } from '../shared/types.js';
import { Store, now } from './store.js';
import type { Groups } from './groups.js';
import type { AppControls } from './app-controls.js';
import { HttpError, only, stringValue } from './security.js';
import {noEffectBoundary} from './tool-failures.js';

type AppTools = NonNullable<ProviderRequest['appTools']>;
export interface AppActionScope { runId: string; agentId: string; signal: AbortSignal; isActive: () => boolean; interact?:NonNullable<ProviderRequest['interact']>; }
interface Receipt { id: string; runId: string; agentId: string; callId: string; name: string; argumentHash: string; status: 'pending' | 'complete' | 'failed'; result?: unknown; error?: string; failure?:{kind:'known_no_effect';boundary:'read_only'|'source_prewrite';status:number}; createdAt: string; }
export function rejectCredentialArguments(name:string,args:unknown) {
 if(name!=='relay_app_control'||!args||typeof args!=='object')return;const body=args as Record<string,unknown>,input=body.input;if(['mcp.add','telegram.connect'].includes(String(body.action))&&input&&typeof input==='object'&&['token','secret','apiKey','password'].some(key=>Object.hasOwn(input,key)))throw new HttpError(400,'Credentials must use the masked secure field, never model tool arguments');
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new HttpError(400, 'Tool arguments must be an object');
  return value as Record<string, unknown>;
};
function canonical(value: unknown, depth = 0): string {
  if (depth > 8) throw new HttpError(400, 'Tool arguments are too deeply nested');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) { if (value.length > 100) throw new HttpError(400, 'Tool arguments are too large'); return '[' + value.map(v => canonical(v, depth + 1)).join(',') + ']'; }
  const record = object(value);
  return '{' + Object.keys(record).sort().map(key => JSON.stringify(key) + ':' + canonical(record[key], depth + 1)).join(',') + '}';
}
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const text = (maxLength: number, minLength = 0) => ({ type: 'string', minLength, maxLength });
export const APP_TOOL_DEFINITIONS: AppToolDefinition[] = [
  { name: 'relay_list_bots', description: 'List public bot IDs, names and roles so you can choose participants. Private bot instructions, memory, files and credentials are never returned.', inputSchema: schema({}) },
  { name: 'relay_create_bot', description: 'Create a bot when the human asks. Supply its name, role and mission; it uses Relay defaults. Optionally select an existing accountId/provider/model for the new bot; this grants no billing permission and changes no existing bot.', inputSchema: schema({ name: text(80, 1), role: text(120), instructions: text(16000), color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },accountId:{anyOf:[text(100,1),{type:'null'}]},routeMode:{type:'string',enum:['auto','openai','claude','cursor','opencode']},model:text(512) }, ['name']) },
  { name: 'relay_create_group', description: 'Create an in-app group with 2 to 5 selected bot IDs. This creates the room without starting inference. Choose roundtable, moderated, or delegated; the lead must be a participant.', inputSchema: schema({ title: text(160, 1), agentIds: { type: 'array', minItems: 2, maxItems: 5, uniqueItems: true, items: text(100, 1) }, mode: { type: 'string', enum: ['roundtable', 'moderated', 'delegated'] }, moderatorAgentId: { type: 'string', maxLength: 100 } }, ['agentIds']) },
  { name: 'relay_start_group', description: 'Start or continue an existing group when the human asks. Returns an accepted run ticket promptly; completion is observed in the group. Prefer smart for moderated rooms: focused contributions followed by a visible moderator outcome, with maxReplies including that outcome. Use continuous only when the human wants discussion until stopped; bounded preserves fixed sessions. Existing subscription and run limits still apply. Smart is only available for moderated rooms.', inputSchema: schema({ roomId: text(100, 1), content: text(16000, 1), rounds: { type: 'integer', minimum: 1, maximum: 3 }, maxReplies: { type: 'integer', minimum: 1, maximum: 15 }, executionMode: { type: 'string', enum: ['smart', 'bounded', 'continuous'] } }, ['roomId']) },
];
const publicBot = (agent: Agent) => ({ accountId:agent.accountId??null,routeMode:agent.routeMode,model:agent.model,id: agent.id, name: agent.name, role: agent.role, mode: agent.mode });

/** Application authority lives in Relay, not in browser sessions or provider prompts. */
export class AppActions {
  redact:<T>(value:T)=>T=value=>value;
  private pending = new Map<string, { hash: string; name: string; promise: Promise<unknown> }>();
  constructor(private store: Store, private groups: Pick<Groups, 'create' | 'accept'>, private refresh: () => Promise<unknown> = async () => {}, private controls?: AppControls) {}
  /** Shared with the authenticated browser create route. */
  createBot(value: unknown): Agent {
    const body = object(value); only(body, ['name', 'role', 'instructions', 'color','routeMode','model','accountId']);
    const name = stringValue(body.name, 'Name', 80, 1).trim(); if (!name) throw new HttpError(400, 'Name is required');
    const input: Partial<Agent> & Pick<Agent, 'name'> = { name };
    if (body.role !== undefined) input.role = stringValue(body.role, 'role', 120);
    if (body.instructions !== undefined) input.instructions = stringValue(body.instructions, 'instructions', 16000);
    if (body.color !== undefined) { const color = stringValue(body.color, 'color', 7, 7); if (!/^#[0-9a-f]{6}$/i.test(color)) throw new HttpError(400, 'color must be a six-digit hex value'); input.color = color; }
    if(body.routeMode!==undefined){if(body.routeMode!=='auto'&&!isActiveProviderId(body.routeMode))throw new HttpError(400,'Invalid routing mode');input.routeMode=body.routeMode;}
    if(body.model!==undefined)input.model=stringValue(body.model,'model',512);
    if(body.accountId!==undefined&&body.accountId!==null&&body.accountId!==''&&!this.controls)throw new HttpError(503,'Account controls are unavailable');
    if(Object.hasOwn(body,'accountId'))input.accountId=this.controls?.accountSelection(body.accountId,input.routeMode??'auto');
    return this.store.transaction(()=>{const created=this.store.createAgent(input);return input.routeMode!==undefined||input.model!==undefined||input.accountId!==undefined?this.store.put('agent',{...created,routeMode:input.routeMode??created.routeMode,model:input.model??created.model,accountId:input.accountId}):created;});
  }
  definitions() { return structuredClone([...APP_TOOL_DEFINITIONS,...(this.controls?.definitions??[])]); }
  bind(scope: AppActionScope): AppTools {
    return { definitions: this.definitions(), call: (callId, name, args) => this.call(scope, callId, name, args) };
  }
  private check(scope: AppActionScope) {
    const run = this.store.get<Run>('run', scope.runId);
    if (scope.signal.aborted || !scope.isActive() || !run || run.agentId !== scope.agentId || run.mode !== 'agent' || run.status !== 'running') throw new HttpError(409, 'This Agent run is no longer active; app action scope expired');
  }
  private call(scope: AppActionScope, callId: string, name: string, args: unknown): Promise<unknown> {
    try {
      this.check(scope);
      stringValue(callId, 'Tool call ID', 300, 1); if (!callId.trim()) throw new HttpError(400, 'Tool call ID is required');
      if (![...APP_TOOL_DEFINITIONS,...(this.controls?.definitions??[])].some(tool => tool.name === name)) throw new HttpError(400, 'Unknown Relay app tool');
      rejectCredentialArguments(name,args);
      const body = object(args), encoded = canonical(body); if (Buffer.byteLength(encoded) > (name==='relay_app_control'?220000:24000)) throw new HttpError(400, 'Tool arguments are too large');
      const hash = createHash('sha256').update(encoded).digest('hex'), key = createHash('sha256').update(JSON.stringify([scope.runId, callId])).digest('hex');
      const prior = this.store.get<Receipt>('app-action', key);
      if (prior && (prior.agentId !== scope.agentId || prior.runId !== scope.runId || prior.callId !== callId || prior.name !== name || prior.argumentHash !== hash)) throw new HttpError(409, 'Tool call identity was reused with different arguments or tool');
      const active = this.pending.get(key);
      if (active) { if (active.hash !== hash || active.name !== name) throw new HttpError(409, 'Tool call identity was reused'); return active.promise; }
      if (prior) {
        if (prior.status === 'complete') return Promise.resolve(structuredClone(this.redact(prior.result)));
        if (prior.status === 'failed') throw new HttpError(prior.failure?.status??409, prior.error ?? 'This app action failed; it was not replayed');
        throw new HttpError(409, 'This app action has interrupted or unknown execution; it was not replayed. Inspect the group before an explicit new request.');
      }
      const receipt: Receipt = { id: key, runId: scope.runId, agentId: scope.agentId, callId, name, argumentHash: hash, status: 'pending', createdAt: now() };
      const promise = this.perform(scope, body, receipt).finally(() => this.pending.delete(key));
      this.pending.set(key, { hash, name, promise }); return promise;
    } catch (error) { return Promise.reject(error); }
  }
  private async perform(scope: AppActionScope, body: Record<string, unknown>, receipt: Receipt): Promise<unknown> {
    const complete = (result: unknown) => { result=this.redact(result); this.store.put<Receipt>('app-action', { ...receipt, status: 'complete', result }); return structuredClone(result); };
    if(this.controls?.definitions.some(tool=>tool.name===receipt.name)){
      this.check(scope);this.store.put('app-action',receipt);
      // A pending receipt survives an uncertain external outcome; never replay it automatically.
      try{return complete(await this.controls.call(scope,receipt.name,body,()=>this.check(scope)));}
      catch(error){const boundary=noEffectBoundary(error);if(boundary)this.store.put<Receipt>('app-action',{...receipt,status:'failed',error:this.redact(error instanceof Error?error.message:String(error)),failure:{kind:'known_no_effect',boundary,status:error instanceof HttpError?error.status:409}});throw error;}
    }
    if (receipt.name === 'relay_start_group') {
      only(body, ['roomId', 'content', 'rounds', 'maxReplies', 'executionMode']);
      const roomId = stringValue(body.roomId, 'Room ID', 100, 1);
      if (!this.store.get('group-room', roomId)) throw new HttpError(404, 'Group room not found');
      const content = body.content === undefined ? undefined : stringValue(body.content, 'content', 16000, 1);
      if (content !== undefined && !content.trim()) throw new HttpError(400, 'Topic is required');
      for (const [key, max] of [['rounds', 3], ['maxReplies', 15]] as const) if (body[key] !== undefined && (!Number.isInteger(body[key]) || Number(body[key]) < 1 || Number(body[key]) > max)) throw new HttpError(400, key + ' is outside the allowed range');
      if (body.executionMode !== undefined && !['smart', 'bounded', 'continuous'].includes(String(body.executionMode))) throw new HttpError(400, 'Invalid executionMode');
      this.check(scope); this.store.put('app-action', receipt);
      let started = false;
      try {
        await this.refresh(); this.check(scope);
        const accepted = this.groups.accept(roomId, content, body.rounds, body.maxReplies, body.executionMode);
        started = true;
        return complete({ roomId, runId: accepted.run.id, status: accepted.run.status });
      } catch (error) {
        if (started) throw new HttpError(409, 'Group start outcome is unknown because its completion receipt could not be saved; inspect the group before a new request');
        this.store.put<Receipt>('app-action', { ...receipt, status: 'failed', error: this.redact(error instanceof HttpError ? error.message : 'App action failed; no automatic replay is allowed') });
        throw error;
      }
    }
    return this.store.transaction(() => {
      this.check(scope);
      if (receipt.name === 'relay_list_bots') { only(body, []); return complete({ bots: this.store.list<Agent>('agent').map(publicBot) }); }
      if (receipt.name === 'relay_create_bot') return complete({ bot: publicBot(this.createBot(body)) });
      only(body, ['title', 'agentIds', 'mode', 'moderatorAgentId']);
      if (body.moderatorAgentId !== undefined) stringValue(body.moderatorAgentId, 'Moderator ID', 100, 1);
      return complete({ room: this.groups.create(body.agentIds, body.title, body.mode, body.moderatorAgentId) });
    });
  }
}

