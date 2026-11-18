import type { InteractionAnswer, InteractionPrompt, Message, GroupMessage, GroupRun, Run, RunInteraction } from '../shared/types.js';
import type { Runs } from './runs.js';
import { interactionAnswer } from './runs.js';
import type { Delegations } from './delegation/index.js';
import { Store, id } from './store.js';
import { HttpError, stringValue } from './security.js';
import { nextHistoryStamp, questionMessageId } from './interaction-history.js';
import {replyTarget} from './message-replies.js';

type InteractionEngine = Pick<Runs, 'pendingInteractions' | 'answerInteraction' | 'cancel'>;
type Services = { runs: Runs; store: Store; delegations?: Pick<Delegations, 'active' | 'owns' | 'pendingInteractions' | 'answerInteraction' | 'cancel'>; groups?: { active?: { has(runId: string): boolean }; cancel(runId: string): Promise<void>; guide?(runId: string, content: unknown, replyToId?: unknown, attachmentIds?:unknown): GroupMessage } };
const stopText = /^(?:stop|cancel|stop (?:this|the) (?:run|task|response|discussion|workers)|cancel (?:this|the) (?:run|task))[.!]?$/i;
/** No model interprets permission replies. Ambiguous text leaves the request pending. */
export function answerFromText(prompt: InteractionPrompt, content: string): InteractionAnswer {
  if (prompt.kind === 'approval') {
    const text = content.trim();
    if (/^(?:yes|y|allow|approve|approved|go ahead|proceed|yes please|do it)[.!]?$/i.test(text)) return { decision: 'allow' };
    if (/^(?:no|n|deny|decline|reject|do not|don't)[.!]?$/i.test(text)) return { decision: 'deny' };
    throw new HttpError(409, 'Reply yes to allow this request, or no to deny it.');
  }
  const questions = prompt.questions ?? [];
  if (questions.length === 1) return interactionAnswer({ decision: 'allow', answers: { [questions[0].id]: questions[0].multiple ? content.split('|').map(item => item.trim()) : [content.trim()] } }, prompt);
  const answers: Record<string, string[]> = Object.create(null);
  for (const line of content.trim().split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator < 1) throw new HttpError(409, 'Answer each question on its own line as question ID: answer.');
    const label = line.slice(0, separator).trim();
    const matches = questions.filter(question => question.id === label || question.question.toLowerCase() === label.toLowerCase());
    if (matches.length !== 1 || Object.hasOwn(answers, matches[0].id)) throw new HttpError(409, 'Use each exact question ID once to identify your answers.');
    const question = matches[0];
    const value = line.slice(separator + 1).trim();
    answers[question.id] = question.multiple ? value.split('|').map(item => item.trim()) : [value];
  }
  if (questions.some(question => !Object.hasOwn(answers, question.id))) throw new HttpError(409, 'Include an answer for every question, using question ID: answer.');
  return interactionAnswer({ decision: 'allow', answers }, prompt);
}
/** Called only after the HTTP session and CSRF checks, never exposed as an agent tool. */
export async function replyToRun(services: Services, runId: string, value: unknown, interactionId?: string,replyToId?:unknown,attachmentIds?:unknown): Promise<{ action: 'answered' | 'cancelled' | 'guided'; interaction?: RunInteraction; message: Message | GroupMessage; questionMessage?: Message | GroupMessage; questionMessages?: (Message | GroupMessage)[] }> {
  const ids=attachmentIds??[];if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string')||ids.length>8||new Set(ids).size!==ids.length)throw new HttpError(400,'Use up to eight distinct attachment IDs');
  const entered = stringValue(value, 'Message', 16000, ids.length?0:1).trim();
  const content = services.runs.redactText?.(entered) ?? entered;
  if (!content&&!ids.length) throw new HttpError(400, 'A message is required');
  services.runs.guardInteractionText?.(runId,content);
  const ordinary = services.store.get<Run>('run', runId);
  const group = ordinary ? undefined : services.store.get<GroupRun>('group-run', runId);
  const run = ordinary ?? group;
  if (!run) throw new HttpError(404, 'Run not found');
  const referenced=ordinary?replyTarget(services.store,'message',ordinary.conversationId,replyToId):replyTarget(services.store,'group-message',group!.roomId,replyToId);
  if (run.status !== 'running' && run.status !== 'routing') throw new HttpError(409, 'This run has ended. Send a new message to continue.');
  const delegated = !ordinary && services.delegations?.owns(runId);
  const engine: InteractionEngine | undefined = ordinary ? services.runs : delegated ? services.delegations : undefined;
  if (ordinary && !services.runs.active.has(runId) || delegated && !services.delegations!.active.has(runId) || group && !delegated && services.groups?.active && !services.groups.active.has(runId)) throw new HttpError(409, 'This run is no longer active.');
  const stop = stopText.test(content);
  if(ids.length&&(ordinary||stop||engine?.pendingInteractions(runId).some(entry=>entry.status==='pending')))throw new HttpError(409,'Attachments cannot answer a pending interaction or stop a run. Remove attachments or send group guidance when no question is pending.');
  if (group && !stop && services.groups?.guide && (!engine || !engine.pendingInteractions(runId).some(entry=>entry.status==='pending'))) {
    if (interactionId) throw new HttpError(409, 'This discussion has no pending question with that request ID.');
    return {action: 'guided', message: services.groups.guide(runId, content, referenced?.id,ids)};
  }
  if (!engine && (!stop || !services.groups)) throw new HttpError(409, 'This discussion has no question waiting. Type stop to end it.');
  let interaction: RunInteraction | undefined;
  let answer: InteractionAnswer | undefined;
  let answerText = content;
  if (!stop) {
    const pending = engine!.pendingInteractions(runId).filter(entry => entry.status === 'pending');
    if (interactionId) {
      interaction = pending.find(entry => entry.id === interactionId);
      if (!interaction) throw new HttpError(409, 'That question has expired or was already answered.');
    } else {
      const separator = content.indexOf(':');
      const label = separator > 0 ? content.slice(0, separator).trim() : '';
      const selected = pending.filter(entry => entry.id === label || entry.workerName?.toLowerCase() === label.toLowerCase());
      if (selected.length === 1) { interaction = selected[0]; answerText = content.slice(separator + 1).trim(); }
      else if (pending.length === 1) interaction = pending[0];
      else if (pending.length > 1) throw new HttpError(409, 'More than one bot has a question. Begin your reply with the request ID or bot name followed by a colon.');
    }
    if (!interaction) throw new HttpError(409, 'The bot is still working. Type stop to cancel, or wait for its next question.');
    if(referenced&&referenced.id!==questionMessageId(interaction.id))throw new HttpError(409,'This run is waiting for its current question. Wait for it to finish before replying to an earlier message.');
    answer = answerFromText(interaction, answerText);
  }
  const questionMessages = (stop ? engine?.pendingInteractions(runId) ?? [] : interaction ? [interaction] : []).filter(item => item.kind === 'question' || item.humanRequired).map(item => services.store.get<Message | GroupMessage>(ordinary ? 'message' : 'group-message', questionMessageId(item.id))).filter((item): item is Message | GroupMessage => !!item);
  const stamp = nextHistoryStamp(ordinary ? services.store.messages(ordinary.conversationId) : services.store.groupMessages(group!.roomId));
  const message: Message | GroupMessage = ordinary
    ? { id: id(), ...(referenced?{replyToId:referenced.id}:{}), conversationId: ordinary.conversationId, role: 'user', origin:'human', content, runId, status: 'complete', createdAt: stamp }
    : { id: id(), ...(referenced?{replyToId:referenced.id}:{}), roomId: group!.roomId, runId, role: 'user', agentId: null, authorName: 'You', content, createdAt: stamp, status: 'complete', route: null };
  if (interaction) interaction = engine!.answerInteraction(runId, interaction.id, answer);
  services.store.put(ordinary ? 'message' : 'group-message', message);
  if (stop) {
    await (engine ?? services.groups)!.cancel(runId);
    return { action: 'cancelled', message, questionMessages };
  }
  return { action: 'answered', interaction, message, ...(questionMessages[0] ? { questionMessage: questionMessages[0] } : {}) };
}
