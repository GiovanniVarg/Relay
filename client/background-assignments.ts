import {scopedSessionStorage as sessionStorage} from './controller-scope';
import type { Agent } from '../shared/types';
import type { Assignment, AssignmentSource, AssignmentSubmit } from '../shared/chat-assignments';
import { parseAssignmentMentions } from '../shared/assignment-mentions';
import type { AssignmentApi } from './AssignmentActivity';

export type RegisteredComputer = { id: string; name: string; platform?: string; online?: boolean; ready?: boolean; modelCount?: number };
type Pending = { requestId: string; hash: string; source: AssignmentSource };
type SubmitInput = Omit<AssignmentSubmit, 'requestId'>;
export type BackgroundReceipt<M = unknown> = { message?: M; assignments: Assignment[]; recoveryWarning?: string };
const pendingKey = 'relay.assignments.pending', bossKey = 'relay.assignments.boss-sources';
const emptyComputers: RegisteredComputer[] = [];
let pending: Pending[] | undefined, storageAvailable = true, bossSources: string[] | undefined;
const opaque = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const validSource = (value: unknown): value is AssignmentSource => !!value && typeof value === 'object' && ['conversation', 'group', 'boss'].includes((value as AssignmentSource).kind) && opaque((value as AssignmentSource).id);
const sameSource = (a: AssignmentSource, b: AssignmentSource) => a.kind === b.kind && a.id === b.id;
function readPending() {
  if (pending) return pending;
  try {
    const data: unknown = JSON.parse(sessionStorage.getItem(pendingKey) || '[]');
    pending = Array.isArray(data) ? data.filter((entry): entry is Pending => !!entry && opaque(entry.requestId) && /^[a-f0-9]{64}$/.test(entry.hash) && validSource(entry.source)).slice(0, 100).map(entry => ({ requestId: entry.requestId, hash: entry.hash, source: { kind: entry.source.kind, id: entry.source.id } })) : [];
  } catch { pending = []; storageAvailable = false; }
  return pending;
}
function savePending(values: Pending[]) {
  pending = values;
  try { sessionStorage.setItem(pendingKey, JSON.stringify(values)); }
  catch { storageAvailable = false; }
}
export function registeredComputers(bootstrap: unknown): RegisteredComputer[] {
  const computers = (bootstrap as { computers?: RegisteredComputer[] } | null)?.computers;
  return Array.isArray(computers) ? computers : emptyComputers;
}
export function buildAssignmentRoster(agents: Pick<Agent, 'id' | 'name' | 'role'>[], computers: RegisteredComputer[] = []) {
  return [...agents.map(agent => ({ kind: 'bot' as const, id: agent.id, name: agent.name, role: agent.role })),
    ...computers.map(computer => ({ kind: 'computer' as const, id: computer.id, name: computer.name, role: 'Computer' }))];
}
export const parseBackgroundAssignment = (content: string, agents: Pick<Agent, 'id' | 'name' | 'role'>[], computers: RegisteredComputer[] = []) => parseAssignmentMentions(content, buildAssignmentRoster(agents, computers));
/** Invalid explicit tokens keep Send enabled so admission can explain the error without routing. */
export function hasBackgroundAssignment(content: string, agents: Pick<Agent, 'id' | 'name' | 'role'>[], computers: RegisteredComputer[] = []) {
  try { return parseBackgroundAssignment(content, agents, computers).tokens.length > 0; } catch { return true; }
}
function accepted<M>(value: unknown, requestId: string, source: AssignmentSource): BackgroundReceipt<M> | undefined {
  const object = value as { receipt?: unknown; assignments?: unknown } | undefined;
  const receipt = (object?.receipt ?? object) as BackgroundReceipt<M> | undefined;
  return receipt && Array.isArray(receipt.assignments) && receipt.assignments.length > 0 && receipt.assignments.every(item => item.requestId === requestId && sameSource(item.source, source)) ? receipt : undefined;
}
/** A deliberate retry retains its UUID. Unknown outcomes get one read-only lookup, never automatic replay. */
export async function submitBackgroundAssignment<M>(api: AssignmentApi, input: SubmitInput): Promise<BackgroundReceipt<M>> {
  if (!input.content.trim() || input.content.length > 16000) throw new Error('Assignments need an instruction of at most 16,000 characters. Your draft is kept.');
  const canonical = JSON.stringify({ source: { kind: input.source.kind, id: input.source.id }, content: input.content, replyToId: input.replyToId ?? null, attachmentIds: input.attachmentIds ?? [] });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const entries = readPending();
  let record = entries.find(entry => entry.hash === hash && sameSource(entry.source, input.source));
  if (!record) {
    if (entries.length >= 100) throw new Error('There are 100 unconfirmed assignments. Review background activity before creating another. No request was sent.');
    record = { requestId: crypto.randomUUID(), hash, source: { ...input.source } };
    savePending([...entries, record]);
  }
  const requestId = record.requestId;
  let receipt: BackgroundReceipt<M> | undefined;
  try {
    const response = await api<unknown>('/assignments', 'POST', { ...input, requestId });
    receipt = accepted<M>(response, requestId, input.source);
    if (!receipt) throw new Error('Relay returned an unconfirmed assignment receipt.');
  } catch (failure) {
    const status = (failure as { status?: number })?.status;
    if (status && status >= 400 && status < 500) throw failure;
    try { receipt = accepted<M>(await api<unknown>(`/assignments/lookup/${encodeURIComponent(requestId)}`), requestId, input.source); }
    catch { /* Keep the same request ID for a later deliberate retry. */ }
    if (!receipt) throw new Error('Assignment acceptance could not be confirmed. Your draft and files are kept. Check background activity, then send this exact draft again to reuse its request ID. Nothing was automatically replayed.' + (!storageAvailable ? ' Browser recovery storage is unavailable; keep this page open.' : ''));
  }
  savePending(readPending().filter(entry => entry.requestId !== requestId));
  window.dispatchEvent(new CustomEvent('relay:assignments-changed', { detail: { source: input.source } }));
  return { ...receipt, ...(!storageAvailable ? { recoveryWarning: 'Assignment accepted. Browser recovery storage is unavailable; keep this page open while checking its progress.' } : {}) };
}
export function readBossAssignmentSources() {
  if (!bossSources) {
    try { const data: unknown = JSON.parse(sessionStorage.getItem(bossKey) || '[]'); bossSources = Array.isArray(data) ? [...new Set(data.filter(opaque))].slice(-100) : []; }
    catch { bossSources = []; }
  }
  return [...new Set([...bossSources, ...readPending().filter(entry => entry.source.kind === 'boss').map(entry => entry.source.id)])].slice(-100);
}
export function rememberBossAssignmentSource(id: string) {
  const next = [...readBossAssignmentSources().filter(value => value !== id), id].slice(-100);
  bossSources = next; try { sessionStorage.setItem(bossKey, JSON.stringify(next)); } catch { storageAvailable = false; }
  return next;
}
export function clearBossAssignmentSources() { bossSources = []; try { sessionStorage.removeItem(bossKey); } catch {} }
