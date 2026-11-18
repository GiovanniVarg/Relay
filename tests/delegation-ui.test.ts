import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createElement, type ReactNode } from 'react';
import { DelegationList, WorkerInteractions, HerdrStatusView, groupEventBelongsToRun } from '../client/Delegations.js';
import { CreateDiscussion, GroupWorkspace } from '../client/Groups.js';
import type { DelegationRecord } from '../shared/delegation.js';
import type { Agent, Bootstrap, GroupRoom, GroupEvent, GroupRun, RunInteraction } from '../shared/types.js';
import type { useRunInteractions } from '../client/Interactions.js';

const { renderToString } = createRequire(import.meta.url)('react-dom/server') as { renderToString: (element: ReactNode) => string };
const render = (element: ReactNode) => renderToString(element).replace(/<!-- -->/g, '');
const worker = (patch: Partial<DelegationRecord> = {}): DelegationRecord => ({
  id: 'task-a', parentRunId: 'parent', workerId: 'bot-a', workerName: 'Builder', task: 'Copy the project fixture',
  expectedResult: 'Matching bytes', dependsOn: [], status: 'complete', mode: 'agent', workspace: 'C:\\project',
  route: { provider: 'openai', model: 'gpt-6-luna', reason: 'Saved route', strategy: 'manual' }, result: 'Copied.',
  evidence: ['File bytes matched'], executionVerified: false, ...patch,
});
function interactionState(entries: RunInteraction[]): ReturnType<typeof useRunInteractions> {
  return { entries: Object.fromEntries(entries.map(entry => [`${entry.runId}:${entry.id}`, entry])), answers: {}, errors: {}, submitting: {},
    receive() {}, resolve() {}, finish() {}, async reconcile() {}, updateAnswers() {}, async respond() {} };
}
const agent = (id: string): Agent => ({ id, name: id === 'lead' ? 'Atlas' : 'Builder', role: id === 'lead' ? 'Lead' : 'Implementation', initials: 'AB', color: '#657e70',
  instructions: '', memory: '', routeMode: 'auto', model: '', mode: 'chat', workspace: '', pinned: false, unread: false, lastMessage: '', createdAt: '', updatedAt: '' });
const room = (mode: GroupRoom['mode']): GroupRoom => ({ id: 'room', title: 'My group', mode, moderatorAgentId: 'lead', agentIds: ['lead', 'bot-a'], createdAt: '', updatedAt: '' });
const bootstrap = (mode: GroupRoom['mode'] = 'moderated'): Bootstrap => ({ agents: [agent('lead'), agent('bot-a')], conversations: [], rooms: [room(mode)], providers: [],
  settings: { maxRunSeconds: 180, maxModelCalls: 3, openaiDefaultModel: '' }, csrfToken: '', version: 'test' });
const api = async <T,>(): Promise<T> => { throw new Error('No API call should happen during server rendering'); };

test('worker activity and per-worker details stay collapsed by default', () => {
  const html = render(createElement(DelegationList, { records: [worker()], runId: 'parent' }));
  assert.match(html, /Worker activity/);
  assert.ok((html.match(/<details/g) || []).length >= 2);
  assert.doesNotMatch(html, /<details[^>]*\bopen(?:=|\s|>)/);
  assert.match(html, /Builder/);
  assert.match(html, /Matching bytes/);
});

test('a finished worker is never labeled verified without independent execution evidence', () => {
  const unverified = render(createElement(DelegationList, { records: [worker()], runId: 'parent' }));
  assert.match(unverified, /Finished · unverified/);
  assert.doesNotMatch(unverified, /Verified complete/);
  const verified = render(createElement(DelegationList, { records: [worker({ executionVerified: true })], runId: 'parent' }));
  assert.match(verified, /Verified complete/);
});

test('foreign run records are excluded and unknown termination offers reconciliation, never retry', () => {
  const records = [worker({ id: 'foreign', parentRunId: 'elsewhere', workerName: 'Foreign worker' }), worker({ status: 'interrupted', terminationUnconfirmed: true })];
  const html = render(createElement(DelegationList, { records, runId: 'parent', reconcile: async () => ({ stopped: false, error: 'Still stopping' }) }));
  assert.doesNotMatch(html, /Foreign worker/);
  assert.match(html, /Recheck stopped worker/);
  assert.doesNotMatch(html, /Retry task/);
  assert.match(html, /Outcome unknown/);
});

test('worker permission cards show their worker and hide foreign or expired requests', () => {
  const pending: RunInteraction = { id: 'approval', runId: 'parent', workerId: 'bot-a', workerName: 'Builder', provider: 'openai', status: 'pending', kind: 'approval', title: 'Write file', description: 'Review the requested write.' };
  const entries = [pending, { ...pending, id: 'expired', status: 'expired' as const, title: 'Expired request' }, { ...pending, id: 'foreign', runId: 'other', title: 'Foreign request' }];
  const html = render(createElement(WorkerInteractions, { runId: 'parent', state: interactionState(entries), returnFocus() {} }));
  assert.match(html, /Builder needs your attention/);
  assert.match(html, /Allow once/);
  assert.doesNotMatch(html, /Expired request|Foreign request/);
});

test('group creation offers Lead & workers without requiring Advanced mode', () => {
  const html = render(createElement(CreateDiscussion, { bootstrap: bootstrap(), api, reload: async () => bootstrap(), close() {}, created() {}, advanced: false }));
  assert.match(html, /Lead &amp; workers/);
  assert.match(html, /value="delegated"/);
});

test('ordinary Simple group view keeps delegation controls out of its chat and composer', () => {
  const html = render(createElement(GroupWorkspace, { bootstrap: bootstrap(), roomId: 'room', api, reload: async () => bootstrap(), openRoster() {}, openSettings() {}, profileOpen: false, toggleProfile() {}, editAgent() {}, advanced: false, openOptions() {} }));
  assert.match(html, /Message the group/);
  assert.doesNotMatch(html, /Worker activity|Herdr|Discussion session mode|Recheck stopped worker/);
});

test('delegated composer asks for a task and omits continuous discussion controls', () => {
  const html = render(createElement(GroupWorkspace, { bootstrap: bootstrap('delegated'), roomId: 'room', api, reload: async () => bootstrap('delegated'), openRoster() {}, openSettings() {}, profileOpen: false, toggleProfile() {}, editAgent() {}, advanced: true, openOptions() {} }));
  assert.match(html, /Task for the lead bot/);
  assert.match(html, /Images and documents are shared with the lead and selected workers/);
  assert.doesNotMatch(html, /Images require an ordinary group/);
  assert.doesNotMatch(html, /Discussion session mode|Discussion reply limit|Discussion rounds|Chat only · tools off/);
});

test('missing Herdr status gives actionable setup guidance without exposing runtime paths', () => {
  const html = render(createElement(HerdrStatusView, { status: { available: false, error: 'Private runtime unavailable' }, checking: false, refresh() {} }));
  assert.match(html, /Herdr is not ready/);
  assert.match(html, /Check again/);
  assert.doesNotMatch(html, /<input|socket|token|\.exe/);
});

test('room streams reject foreign snapshots, worker records, and interaction cards before state changes', () => {
  const run = { id: 'parent', roomId: 'room' };
  const otherRun = { ...run, id: 'other' } as GroupRun;
  const ownRun = { ...run } as GroupRun;
  const pending: RunInteraction = { id: 'approval', runId: 'parent', provider: 'openai', status: 'pending', kind: 'approval', title: 'Approve', description: 'Review' };
  assert.equal(groupEventBelongsToRun({ type: 'interaction', interaction: pending }, run), true);
  assert.equal(groupEventBelongsToRun({ type: 'interaction', interaction: { ...pending, runId: 'other' } }, run), false);
  assert.equal(groupEventBelongsToRun({ type: 'snapshot', run: otherRun, messages: [] }, run), false);
  assert.equal(groupEventBelongsToRun({ type: 'snapshot', run: ownRun, messages: [] }, run), true);
  assert.equal(groupEventBelongsToRun({ type: 'run', run: { ...ownRun, roomId: 'foreign-room' } }, run), false);
  assert.equal(groupEventBelongsToRun({ type: 'delegation', runId: 'parent', delegation: worker({ parentRunId: 'other' }) }, run), false);
  assert.equal(groupEventBelongsToRun({ type: 'interactionResolved', runId: 'other', interactionId: 'approval', status: 'expired' }, run), false);
  assert.equal(groupEventBelongsToRun(null as unknown as GroupEvent, run), false);
});
