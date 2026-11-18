/** Merge HTTP replies and SSE messages by identity, then order conversational turns independently of delivery order. */
export function mergeConversationMessages<T extends { id: string; createdAt: string; status: string }>(existing: T[], incoming: T[]): T[] {
  const entries = new Map(existing.map(message => [message.id, message]));
  for (const message of incoming) {
    const previous = entries.get(message.id);
    // A stale HTTP snapshot cannot turn an already finished assistant reply back into a stream.
    if (message.status === 'streaming' && previous && previous.status !== 'streaming') continue;
    entries.set(message.id, message);
  }
  return [...entries.values()].map((message, index) => ({ message, index })).sort((left, right) => {
    const streaming = Number(left.message.status === 'streaming') - Number(right.message.status === 'streaming');
    return streaming || left.message.createdAt.localeCompare(right.message.createdAt) || left.index - right.index;
  }).map(entry => entry.message);
}
