import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatAssignments } from '../server/chat-assignments.js';
import type { AssignmentMessage, AssignmentStore, AssignmentSubmit, ChatAssignmentHooks, ContextCapsule } from '../shared/chat-assignments.js';

class FakeStore implements AssignmentStore {
  data = new Map<string, unknown>();
  get<T>(collection: string, id: string) { return this.data.get(`${collection}/${id}`) as T | undefined; }
  list<T>(collection: string) { return [...this.data].filter(([key]) => key.startsWith(`${collection}/`)).map(([, value]) => value as T); }
  put<T extends { id: string }>(collection: string, value: T) { this.data.set(`${collection}/${value.id}`, value); return value; }
  remove(collection: string, id: string) { this.data.delete(`${collection}/${id}`); }
  transaction<T>(work: () => T) { const before = structuredClone(this.data); try { return work(); } catch (error) { this.data = before; throw error; } }
  messages(id: string) { return this.list<AssignmentMessage>('messages').filter(message => message.conversationId === id); }
  groupMessages(id: string) { return this.list<AssignmentMessage>('groupMessages').filter(message => message.groupId === id); }
  createConversation() { return undefined; }
}
function setup() {
  const store = new FakeStore();
  store.put('conversations', { id: 'chat', agentId: 'builder' });
  store.put('groups', { id: 'room', agentIds: ['builder', 'reviewer'] });
  let preflights = 0, cancelled: string | undefined;
  const hooks: ChatAssignmentHooks = {
    roster: () => [{ kind: 'bot', id: 'builder', name: 'Builder', role: 'builder' }, { kind: 'bot', id: 'reviewer', name: 'Reviewer', role: 'reviewer' }, { kind: 'computer', id: 'desktop', name: 'Desktop', role: 'computer' }],
    defaultAgent: () => 'builder', preflight: async () => { preflights++; }, assertWritable() {},
    validateAttachments: (_source, ids) => ids.map(id => ({ id, hash: `hash-${id}` })),
    commitAttachments: (_source, _message, ids) => ids.map(id => ({ id: `owned-${id}`, hash: `hash-${id}` })),
    createTask: input => { const taskId = `task-${input.assignmentId}`; store.put('tasks', { id: taskId, ...input }); return { taskId }; },
    snapshot: () => ({ state: 'running', progress: 'a'.repeat(13000) }),
    cancel: async assignment => { cancelled = assignment.taskId; }, redact: text => text.replaceAll('SECRET', '[redacted]'),
  };
  const service = new ChatAssignments(store, hooks);
  const input: AssignmentSubmit = { requestId: '00000000-0000-4000-8000-000000000001', source: { kind: 'conversation', id: 'chat' }, content: '@Builder: implement routing' };
  return { store, hooks, service, input, preflights: () => preflights, cancelled: () => cancelled };
}
test('one source human bubble, shared capsule, distinct jobs, and idempotent replay', async () => {
  const { service, store, input, preflights } = setup();
  input.content = '@Builder: @Reviewer: implement routing';
  input.attachmentIds = ['draft'];
  const result = await service.submit(input);
  assert.equal(result.assignments.length, 2);
  assert.equal(result.message?.content, input.content);
  assert.equal(store.messages('chat').length, 1);
  assert.equal(new Set(result.assignments.map(item => item.capsuleId)).size, 1);
  assert.equal(store.list('tasks').length, 2);
  assert.deepEqual(await service.submit(input), result);
  assert.equal(preflights(), 1);
  await assert.rejects(service.submit({ ...input, content: '@Builder: different' }), /already used/);
  const capsule = service.contextForTask(result.assignments[0].taskId)!;
  assert.deepEqual(capsule.attachments, [{ id: 'owned-draft', hash: 'hash-draft' }]);
});
test('simultaneous duplicate requests produce one accepted submission', async () => {
  const { service, store, input } = setup();
  const [a, b] = await Promise.all([service.submit(input), service.submit(input)]);
  assert.deepEqual(a, b);
  assert.equal(store.list('tasks').length, 1);
});
test('preflight failure and transactional task failure leave no messages or receipts', async () => {
  const { service, store, input, hooks } = setup();
  hooks.preflight = async () => { throw new Error('offline'); };
  await assert.rejects(service.submit(input), /offline/);
  assert.equal(store.messages('chat').length, 0);
  hooks.preflight = async () => {};
  hooks.createTask = () => { throw new Error('task failed'); };
  await assert.rejects(service.submit(input), /task failed/);
  assert.equal(store.messages('chat').length, 0);
  assert.equal(store.list('assignmentCapsules').length, 0);
  assert.equal(service.lookup(input.requestId), undefined);
});
test('capsule is reply-first, bounded, redacted, source-local, and excludes control origins', async () => {
  const { service, store, input } = setup();
  for (let i = 0; i < 14; i++) store.put('messages', { id: `${i}`, role: 'assistant', content: 'routing SECRET ' + 'x'.repeat(3000), createdAt: `${i}`, conversationId: 'chat', status: 'completed' });
  store.put('messages', { id: 'control', role: 'assistant', content: 'internal memory', origin: 'internal-continuation', createdAt: '', conversationId: 'chat' });
  store.put('messages', { id: 'foreign', role: 'user', content: 'foreign secret', createdAt: '', conversationId: 'other' });
  input.replyToId = '0';
  const result = await service.submit(input);
  const capsule = store.get<ContextCapsule>('assignmentCapsules', result.assignments[0].capsuleId)!;
  assert.equal(capsule.references[0].id, '0');
  assert.ok(capsule.references.length <= 8);
  assert.ok(capsule.references.reduce((n, ref) => n + ref.content.length, 0) <= 12000);
  assert.ok(capsule.provenance.truncated);
  assert.equal(JSON.stringify(capsule).includes('SECRET'), false);
  assert.equal(capsule.references.some(ref => ['foreign', 'control'].includes(ref.id)), false);
  assert.match(capsule.markdown, /UNTRUSTED/);
  assert.match(capsule.contentHash, /^[a-f0-9]{64}$/);
});
test('invalid replies and mention-free requests fail before mutation', async () => {
  const { service, store, input } = setup();
  await assert.rejects(service.submit({ ...input, replyToId: 'foreign' }), /Reply must reference/);
  await assert.rejects(service.submit({ ...input, content: 'ordinary chat' }), /explicit assignment mention/);
  assert.equal(store.messages('chat').length, 0);
});
test('computer-only uses the source default; boss retains no global human history', async () => {
  const { service, store, input } = setup();
  const result = await service.submit({ ...input, source: { kind: 'boss', id: 'boss' }, content: '@computer/desktop: render this' });
  assert.equal(result.message, undefined);
  assert.equal(result.assignments[0].agentId, 'builder');
  assert.equal(result.assignments[0].computerId, 'desktop');
  assert.equal(store.list('messages').length, 0);
  assert.deepEqual(service.contextForTask(result.assignments[0].taskId)?.references, []);
});
test('source changes during preflight abort; task detail stays bounded and cancellation targets its assignment', async () => {
  const { service, store, hooks, input, cancelled } = setup();
  hooks.preflight = async () => { store.put('conversations', { id: 'chat', agentId: 'reviewer' }); };
  await assert.rejects(service.submit(input), /source changed/);
  assert.equal(store.list('tasks').length, 0);
  hooks.preflight = async () => {};
  const result = await service.submit(input);
  const assignment = result.assignments[0];
  assert.equal(service.detail(assignment.id)?.snapshot.progress?.length, 12000);
  await service.cancel(assignment.id);
  assert.equal(cancelled(), assignment.taskId);
  await assert.rejects(service.cancel('missing'), /not found/);
});
test('deleting a replied-to message during preflight rejects without creating work', async () => {
  const { service, store, hooks, input } = setup();
  store.put('messages', { id: 'reply', role: 'user', content: 'source instruction', createdAt: '', conversationId: 'chat' });
  hooks.preflight = async () => { store.remove('messages', 'reply'); };
  await assert.rejects(service.submit({ ...input, replyToId: 'reply' }), /Replied-to message changed/);
  assert.equal(store.list('tasks').length, 0);
});
