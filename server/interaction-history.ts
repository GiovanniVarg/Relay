import type { GroupMessage, GroupRun, Message, Run, RunInteraction } from '../shared/types.js';
import type { Store } from './store.js';
import { redactSecrets } from './security.js';

export const questionMessageId = (interactionId: string) => 'question-' + interactionId;
/** Keep interactive turns strictly ordered even when an answer and final response share a millisecond. */
export function nextHistoryStamp(messages: { createdAt: string }[]): string {
  let latest = Date.now() - 1;
  for (const message of messages) { const stamp = Date.parse(message.createdAt); if (Number.isFinite(stamp)) latest = Math.max(latest, stamp); }
  return new Date(Math.max(Date.now(), latest + 1)).toISOString();
}
function questionContent(interaction: RunInteraction): string {
  if (interaction.humanRequired && interaction.kind === 'approval') return redactSecrets([interaction.title, interaction.description, interaction.details, 'Type approve or no. Type stop to end the task.'].filter(Boolean).join('\n'));
  const questions = interaction.questions ?? [];
  const lines = questions.map(question => `${questions.length > 1 ? question.id + ': ' : ''}${question.question}${question.options?.length ? '\nOptions: ' + question.options.join(' / ') : ''}`);
  return redactSecrets([interaction.title, ...lines.filter(line => line !== interaction.title)].filter(Boolean).join('\n'));
}
/** Save only the question shown to the human, excluding provider details and tool payloads. */
export function saveRunQuestion(store: Store, run: Run, interaction: RunInteraction): Message {
  return store.put<Message>('message', { id: questionMessageId(interaction.id), conversationId: run.conversationId, role: 'assistant', content: questionContent(interaction), runId: null, status: 'complete', createdAt: nextHistoryStamp(store.messages(run.conversationId)) });
}
export function saveGroupQuestion(store: Store, run: GroupRun, interaction: RunInteraction): GroupMessage {
  return store.put<GroupMessage>('group-message', { id: questionMessageId(interaction.id), roomId: run.roomId, runId: null, role: 'assistant', agentId: interaction.workerId ?? null, authorName: interaction.workerName ?? 'Assistant', content: questionContent(interaction), status: 'complete', createdAt: nextHistoryStamp(store.groupMessages(run.roomId)), route: null });
}
