import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { AppActions, APP_TOOL_DEFINITIONS } from '../server/app-actions.js';
import { Store, PROVIDER_IDS, id, now } from '../server/store.js';
import { Groups } from '../server/groups.js';
import { Runs } from '../server/runs.js';
import { createApp } from '../server/index.js';
import { isOutcomeReconciliation } from '../server/outcome-reconciliation.js';
import { resolveMode, validateWorkspace } from '../server/mode.js';
import type { Agent, GroupRun, ProviderAdapter, ProviderId, ProviderRequest, Run } from '../shared/types.js';
const billing = { mode: 'included' as const, confirmed: true, automaticRouting: true, allowanceNote: 'fixture' };

test('chat tools expose Smart moderation and start a checked tool-free discussion with a visible outcome', async () => {
  const f = await fixture();
  try {
    assert.ok(JSON.stringify(APP_TOOL_DEFINITIONS.find(tool => tool.name === 'relay_start_group')!.inputSchema).includes('smart'));
    const members = f.store.list<Agent>('agent').slice(0, 2).map(agent => f.store.put<Agent>('agent', {...agent, routeMode: 'openai', model: 'm'}));
    f.runs.adapters.openai.stream = async request => {assert.equal(request.appTools, undefined); return {text: request.runId.startsWith('group-moderator-') ? '{"speakerId":null,"reason":"A direct answer suffices.","focus":""}' : 'Use the simplest working option.'};};
    const room = f.groups.create(members.map(member => member.id));
    const tools = f.actions.bind(f.context), input = {roomId: room.id, content: 'Recommend a practical next step.', executionMode: 'smart'};
    const ticket = await tools.call('smart-group', 'relay_start_group', input) as {runId: string};
    await f.groups.active.get(ticket.runId)?.promise;
    assert.equal(f.store.get<GroupRun>('group-run', ticket.runId)!.executionMode, 'smart'); assert.equal(f.store.get<GroupRun>('group-run', ticket.runId)!.status, 'complete');
    assert.equal(f.store.groupMessages(room.id).at(-1)!.content, 'Use the simplest working option.');
    assert.deepEqual(await tools.call('smart-group', 'relay_start_group', input), ticket); assert.equal(f.store.groupRuns(room.id).length, 1);
  } finally {await f.close();}
});
function adapters(handler: (request: ProviderRequest) => Promise<string> = async () => 'ok'): Record<ProviderId, ProviderAdapter> {
  return Object.fromEntries(PROVIDER_IDS.map(provider => [provider, {
    id: provider, inspect: async () => ({ id: provider, installed: true, authenticated: true, authMode: 'subscription' as const, accountLabel: 'fixture', plan: '', models: [{ id: 'm', name: 'm', verified: false }] }),
    login: async () => ({ message: 'fixture' }), close: async () => {},
    stream: async (request: ProviderRequest, emit: Parameters<ProviderAdapter['stream']>[1]) => { const text = await handler(request); emit({ type: 'delta', text }); return { text }; },
  }])) as unknown as Record<ProviderId, ProviderAdapter>;
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'relay-app-actions-')), store = new Store(dir), runs = new Runs(store, adapters()), groups = new Groups(store, runs);
  await runs.refresh(); for (const provider of PROVIDER_IDS) { store.saveBilling(provider, billing); store.saveModelPreferences(provider, { defaultModel: 'm', allowedModels: ['m'] }); }
  const actor = store.list<Agent>('agent')[0], stamp = now(), runId = id();
  store.put<Run>('run', { id: runId, agentId: actor.id, conversationId: store.conversations(actor.id)[0].id, messageId: id(), mode: 'agent', status: 'running', route: null, error: null, startedAt: stamp, endedAt: null, usage: null });
  let active = true; const controller = new AbortController();
  const actions = new AppActions(store, groups, () => runs.refresh());
  const context = { runId, agentId: actor.id, signal: controller.signal, isActive: () => active };
  return { dir, store, runs, groups, actor, runId, controller, actions, context, expire: () => { active = false; },
    async close() { await groups.close(); await runs.close(); store.close(); await rm(dir, { recursive: true, force: true }); } };
}
test('Agent defaults migrate once, retain workspaces, and preserve future explicit Chat choices', async () => {
  const f = await fixture(); try {
    assert.ok(f.store.list<Agent>('agent').every(agent => agent.mode === 'agent'));
    const created = f.store.createAgent({ name: 'New' }); assert.equal(created.mode, 'agent'); assert.equal(created.workspace, homedir());
    f.store.remove('config', 'agent-defaults-v1');
    f.store.put('agent', { ...f.actor, mode: 'work', workspace: 'saved-project', instructions: 'private mission' });
    const migrated = new Store(f.dir); assert.equal(migrated.get<Agent>('agent', f.actor.id)!.mode, 'agent');
    assert.equal(migrated.get<Agent>('agent', f.actor.id)!.workspace, 'saved-project');
    migrated.put('agent', { ...migrated.get<Agent>('agent', f.actor.id)!, mode: 'chat' }); migrated.close();
    const reopened = new Store(f.dir); assert.equal(reopened.get<Agent>('agent', f.actor.id)!.mode, 'chat'); reopened.close();
    assert.equal(resolveMode('agent', { workspace: '' }, 'Create a bot'), 'agent');
    assert.throws(() => resolveMode('work', { workspace: '' }, 'Write a file'), /workspace/);
  } finally { await f.close(); }
});
test('AppActions exposes only public roster and validates exact schemas without app administration', async () => {
  const f = await fixture(); try {
    f.store.put('agent', { ...f.actor, instructions: 'PRIVATE_MISSION', memory: 'PRIVATE_MEMORY', workspace: 'PRIVATE_PATH' });
    const tools = f.actions.bind(f.context), roster = await tools.call('list', 'relay_list_bots', {});
    assert.equal(JSON.stringify(roster).includes('PRIVATE_'), false);
    assert.deepEqual(tools.definitions.map(tool => tool.name), ['relay_list_bots', 'relay_create_bot', 'relay_create_group', 'relay_start_group']);
    for (const [name, args] of [['relay_create_bot', { name: 'X', billing: true }], ['relay_create_bot', { name: ' ' }], ['relay_create_bot', { name: 'X', color: '#oops' }], ['relay_create_group', { agentIds: [f.actor.id] }], ['relay_list_bots', { private: true }], ['delete_bot', {}]] as const)
      await assert.rejects(tools.call(id(), name, args), /Unknown|Name|required|color|agents|tool/i);
    assert.equal(f.store.list('agent').length, 5);
  } finally { await f.close(); }
});
test('AppActions receipts deduplicate stable call IDs and reject argument or tool mismatches', async () => {
  const f = await fixture(); try {
    const tools = f.actions.bind(f.context), input = { name: 'Helper', role: 'Reviewer', instructions: 'Private bot mission' };
    const first = await tools.call('opaque 选择 __proto__', 'relay_create_bot', input);
    const repeat = await tools.call('opaque 选择 __proto__', 'relay_create_bot', { instructions: input.instructions, role: input.role, name: input.name });
    assert.deepEqual(repeat, first); assert.equal(f.store.list('agent').length, 6); assert.equal(f.store.list('conversation').length, 6);
    await assert.rejects(tools.call('opaque 选择 __proto__', 'relay_create_bot', { name: 'Different' }), /reused|identity|arguments/);
    await assert.rejects(tools.call('opaque 选择 __proto__', 'relay_list_bots', {}), /reused|identity|arguments/);
    const other = new AppActions(f.store, f.groups); assert.deepEqual(await other.bind(f.context).call('opaque 选择 __proto__', 'relay_create_bot', input), first);
  } finally { await f.close(); }
});
test('creation and its receipt roll back together on persistence failure', async () => {
  const f = await fixture(); try {
    const put = f.store.put.bind(f.store);
    f.store.put = ((kind: string, value: any) => { if (kind === 'app-action') throw Error('receipt unavailable'); return put(kind, value); }) as typeof f.store.put;
    await assert.rejects(f.actions.bind(f.context).call('atomic', 'relay_create_bot', { name: 'Not persisted' }), /receipt unavailable/);
    assert.equal(f.store.list('agent').length, 5); assert.equal(f.store.list('conversation').length, 5);
    f.store.put = put;
  } finally { await f.close(); }
});
test('run scope rejects cancelled, foreign, completed and expired tool calls', async () => {
  const f = await fixture(); try {
    await assert.rejects(f.actions.bind({ ...f.context, agentId: 'foreign' }).call('foreign', 'relay_create_bot', { name: 'No' }), /active|scope|run/);
    f.expire(); await assert.rejects(f.actions.bind(f.context).call('expired', 'relay_create_bot', { name: 'No' }), /active|expired/);
    assert.equal(f.store.list('agent').length, 5);
  } finally { await f.close(); }
  const cancelled = await fixture(); try {
    cancelled.controller.abort(); await assert.rejects(cancelled.actions.bind(cancelled.context).call('abort', 'relay_create_bot', { name: 'No' }), /cancel|expired|active/);
    cancelled.store.put('run', { ...cancelled.store.get<Run>('run', cancelled.runId)!, status: 'complete' });
    await assert.rejects(cancelled.actions.bind({ ...cancelled.context, signal: new AbortController().signal }).call('complete', 'relay_list_bots', {}), /active|scope|run/);
  } finally { await cancelled.close(); }
});
test('start_group returns an accepted ticket once and does not await group inference', async () => {
  const f = await fixture(); try {
    let starts = 0;
    const actionGroups = { create: f.groups.create.bind(f.groups), accept: (...args: Parameters<Groups['accept']>) => { starts++; return { run: { id: 'accepted-run', status: 'routing', roomId: args[0] } as GroupRun, message: null }; } };
    const actions = new AppActions(f.store, actionGroups), tools = actions.bind(f.context);
    const created = await tools.call('room', 'relay_create_group', { title: 'Review', agentIds: f.store.list<Agent>('agent').slice(0, 2).map(a => a.id), mode: 'moderated' }) as { room: { id: string } };
    const args = { roomId: created.room.id, content: 'Discuss this', executionMode: 'continuous' };
    const ticket = await tools.call('start', 'relay_start_group', args);
    assert.deepEqual(ticket, { roomId: created.room.id, runId: 'accepted-run', status: 'routing' });
    assert.deepEqual(await tools.call('start', 'relay_start_group', args), ticket); assert.equal(starts, 1);
  } finally { await f.close(); }
});
test('cancellation during start preflight never starts a group; pending receipts never replay', async () => {
  const f = await fixture(); try {
    let release!: () => void, starts = 0;
    const wait = new Promise<void>(done => { release = done; });
    const actions = new AppActions(f.store, { create: f.groups.create.bind(f.groups), accept: () => { starts++; throw Error('must not start'); } }, () => wait);
    const room = f.groups.create(f.store.list<Agent>('agent').slice(0, 2).map(a => a.id));
    const input = { roomId: room.id, content: 'Topic' }, tools = actions.bind(f.context);
    const running = tools.call('start', 'relay_start_group', input); void running.catch(() => {});
    f.controller.abort(); release(); await assert.rejects(running, /cancel|expired|active/); assert.equal(starts, 0);
    const receipt = f.store.list<any>('app-action')[0]; f.store.put('app-action', { ...receipt, status: 'pending' });
    await assert.rejects(new AppActions(f.store, f.groups).bind({ ...f.context, signal: new AbortController().signal }).call('start', 'relay_start_group', input), /unknown|interrupted|replay/);
  } finally { await f.close(); }
});
test('parallel start calls share one invocation and a lost completion receipt cannot replay', async () => {
  const f = await fixture(); try {
    let release!: () => void, starts = 0;
    const wait = new Promise<void>(done => { release = done; });
    const room = f.groups.create(f.store.list<Agent>('agent').slice(0, 2).map(a => a.id));
    const actions = new AppActions(f.store, { create: f.groups.create.bind(f.groups), accept: () => { starts++; return { run: { id: 'ticket', status: 'routing' } as GroupRun, message: null }; } }, () => wait);
    const tools = actions.bind(f.context), args = { roomId: room.id, content: 'Topic' };
    const first = tools.call('parallel', 'relay_start_group', args), second = tools.call('parallel', 'relay_start_group', args);
    assert.strictEqual(first, second); release(); assert.deepEqual(await first, await second); assert.equal(starts, 1);
    const put = f.store.put.bind(f.store);
    f.store.put = ((kind: string, value: any) => { if (kind === 'app-action' && value.status === 'complete') throw Error('completion persistence unavailable'); return put(kind, value); }) as typeof f.store.put;
    await assert.rejects(tools.call('lost-result', 'relay_start_group', args), /unknown|receipt|persistence/);
    f.store.put = put; assert.equal(starts, 2);
    const pending = f.store.list<any>('app-action').find(receipt => receipt.callId === 'lost-result'); assert.equal(pending.status, 'pending');
    await assert.rejects(new AppActions(f.store, f.groups).bind(f.context).call('lost-result', 'relay_start_group', args), /unknown|interrupted|replay/);
    assert.equal(starts, 2);
  } finally { await f.close(); }
});
test('direct Agent calls get real app tools with honest execution mode; manual Chat remains tool-free', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-app-tool-run-')), ws = join(dir, 'project'); await mkdir(ws);
  const seen: ProviderRequest[] = []; let reports = 0;
  const app = createApp({ dataDir: join(dir, 'data'), adapters: adapters(async request => {
    if (isOutcomeReconciliation(request)) { reports++; assert.equal(request.mode, 'chat'); assert.equal(request.appTools, undefined); assert.equal(request.workspace, undefined); assert.equal(request.interact, undefined); return JSON.stringify({ state: 'complete', summary: 'Requested app work delivered.', remaining: [], evidence: [] }); }
    seen.push(request); if (request.appTools) await request.appTools.call('create-once', 'relay_create_bot', { name: 'Created in app' });
    return 'done';
  }) });
  try {
    await app.runs.refresh(); for (const provider of PROVIDER_IDS) { app.store.saveBilling(provider, billing); app.store.saveModelPreferences(provider, { defaultModel: 'm', allowedModels: ['m'] }); }
    const actor = app.store.list<Agent>('agent')[0], conversation = app.store.conversations(actor.id)[0];
    const accepted = app.runs.accept(actor, conversation.id, 'Create a bot', 'cursor', 'm');
    await app.runs.active.get(accepted.run.id)!.promise;
    assert.equal(app.store.get<Run>('run', accepted.run.id)!.status, 'complete');
    assert.equal(reports, 1); assert.equal(seen.length, 1);
    assert.equal(seen[0].mode, 'chat'); assert.equal(seen[0].workspace, undefined); assert.ok(seen[0].appTools);
    await assert.rejects(seen[0].appTools!.call('late', 'relay_create_bot', { name: 'No' }), /active|expired/);
    app.store.put('agent', { ...actor, mode: 'agent', workspace: ws });
    for (const provider of ['cursor', 'claude'] as const) {
      const accepted = app.runs.accept(actor, conversation.id, 'Use configured capabilities', provider, 'm'); await app.runs.active.get(accepted.run.id)!.promise;
      assert.equal(app.store.get<Run>('run', accepted.run.id)!.status, 'complete');
      assert.equal(seen.at(-1)!.mode, provider === 'cursor' ? 'chat' : 'agent');
      assert.equal(seen.at(-1)!.workspace, provider === 'cursor' ? undefined : validateWorkspace(ws, app.store.dataDir));
    }
    const chat = app.runs.accept(actor, conversation.id, 'Talk only', 'cursor', 'm', 'chat'); await app.runs.active.get(chat.run.id)!.promise;
    assert.equal(app.store.get<Run>('run', chat.run.id)!.status, 'complete');
    assert.equal(seen.at(-1)!.appTools, undefined); assert.equal(seen.length, 4);
    assert.equal(app.store.messages(conversation.id).filter(message => message.role === 'assistant').length, 4);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('direct Agent tools create a group and start its real discussion while group calls remain tool-free', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-app-group-flow-'));
  let direct = 0, discussion = 0, reports = 0;
  const app = createApp({ dataDir: dir, adapters: adapters(async request => {
    if (isOutcomeReconciliation(request)) { reports++; assert.equal(request.appTools, undefined); assert.equal(request.workspace, undefined); assert.equal(request.interact, undefined); return JSON.stringify({ state: 'complete', summary: 'Created the group and started its discussion.', remaining: [], evidence: [] }); }
    if (!request.appTools) { discussion++; return 'A group contribution'; }
    direct++;
    const bot = await request.appTools.call('new-bot', 'relay_create_bot', { name: 'New participant', role: 'Reviewer' }) as { bot: { id: string } };
    const roster = await request.appTools.call('roster', 'relay_list_bots', {}) as { bots: { id: string }[] };
    const room = await request.appTools.call('new-room', 'relay_create_group', { title: 'Created by a bot', agentIds: [roster.bots[0].id, bot.bot.id], mode: 'roundtable' }) as { room: { id: string } };
    const ticket = await request.appTools.call('start-room', 'relay_start_group', { roomId: room.room.id, content: 'Discuss options', rounds: 1 }) as { runId: string };
    assert.ok(ticket.runId); return 'Created the bot and started the group.';
  }) });
  try {
    await app.runs.refresh(); for (const provider of PROVIDER_IDS) { app.store.saveBilling(provider, billing); app.store.saveModelPreferences(provider, { defaultModel: 'm', allowedModels: ['m'] }); }
    const actor = app.store.list<Agent>('agent')[0], conversation = app.store.conversations(actor.id)[0];
    const accepted = app.runs.accept(actor, conversation.id, 'Create a bot and start a group', 'openai', 'm');
    await app.runs.active.get(accepted.run.id)!.promise;
    await Promise.all([...app.groups.active.values()].map(active => active.promise));
    assert.equal(app.store.get<Run>('run', accepted.run.id)!.status, 'complete');
    assert.equal(app.store.list('group-room').length, 1); assert.equal(app.store.list<GroupRun>('group-run')[0].status, 'complete');
    assert.equal(direct, 1); assert.equal(discussion, 2); assert.equal(reports, 1);
    assert.equal(app.store.messages(conversation.id).filter(message => message.role === 'assistant').length, 1); assert.equal(app.store.list('app-action').length, 4);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});
test('an Agent app mutation is never automatically replayed on another provider after a temporary error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-app-no-replay-')); let calls = 0;
  const app = createApp({ dataDir: dir, adapters: adapters(async request => {
    calls++; await request.appTools!.call('created', 'relay_create_bot', { name: 'Exactly one new bot' });
    throw Error('Temporary overload');
  }) });
  try {
    await app.runs.refresh(); for (const provider of PROVIDER_IDS) { app.store.saveBilling(provider, billing); app.store.saveModelPreferences(provider, { defaultModel: 'm', allowedModels: ['m'] }); }
    const actor = app.store.list<Agent>('agent')[0], conversation = app.store.conversations(actor.id)[0];
    const accepted = app.runs.accept(actor, conversation.id, 'Create one bot', 'auto', '');
    await app.runs.active.get(accepted.run.id)!.promise;
    assert.equal(app.store.get<Run>('run', accepted.run.id)!.status, 'failed'); assert.equal(calls, 1);
    assert.equal(app.store.list('agent').length, 6); assert.equal(app.store.list('app-action').length, 1);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});
