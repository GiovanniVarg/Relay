import {SyntheticVault,testCredentials} from './synthetic-vault.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.js';
import { Store, PROVIDER_IDS } from '../server/store.js';
import { Runs } from '../server/runs.js';
import { Telegram, TelegramBot, chunk, type TelegramRecord } from '../server/telegram.js';
import type { Agent, Bootstrap, ProviderAdapter, ProviderEvent, ProviderId, ProviderRequest, RunInteraction, TelegramStatus } from '../shared/types.js';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw_x'; const OWNER = 4242;
const conn = (id: ProviderId) => ({ id, installed: true, authenticated: true, authMode: 'subscription' as const, accountLabel: 'Test', plan: 'Test', models: [{ id: 'm1', name: 'm1', verified: false }] });
function adapters(reply: () => string, gate?: Promise<void>): Record<ProviderId, ProviderAdapter> {
  return Object.fromEntries(PROVIDER_IDS.map(id => [id, { id, inspect: async () => conn(id), login: async () => ({ message: 'x' }), close: async () => {}, stream: async (r: ProviderRequest, emit: (e: ProviderEvent) => void, signal: AbortSignal) => {
    if (r.mode === 'work') { emit({ type: 'tool', name: 'Edit', summary: 'one.ts' }); emit({ type: 'tool', name: 'Bash', summary: 'npm test' }); }
    if (gate) await new Promise<void>((resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason)); void gate.then(resolve); });
    const text = reply(); emit({ type: 'delta', text }); return { text, actualModel: r.model };
  } }])) as Record<ProviderId, ProviderAdapter>;
}
type Call = { method: string; body: Record<string, unknown>; url: string };
function fakeTelegram() {
  const calls: Call[] = []; const queue: unknown[][] = []; let nextId = 100; let badToken = false;
  const json = (value: unknown) => new Response(JSON.stringify(value));
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const method = url.split('/').pop()!; const body = JSON.parse(String(init.body)) as Record<string, unknown>; calls.push({ method, body, url });
    if (badToken) return json({ ok: false, description: 'Unauthorized' });
    if (method === 'getUpdates') {
      const batch = queue.shift(); if (batch) return json({ ok: true, result: batch });
      await new Promise<void>(resolve => { const t = setTimeout(resolve, 20); init.signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }); });
      if (init.signal?.aborted) throw new Error('aborted'); return json({ ok: true, result: [] });
    }
    if (method === 'getMe') return json({ ok: true, result: { username: 'relay_test_bot' } });
    if (method === 'sendMessage') return json({ ok: true, result: { message_id: nextId++ } });
    return json({ ok: true, result: true });
  }) as unknown as typeof fetch;
  return { calls, queue, fetchImpl, setBadToken(v: boolean) { badToken = v; }, texts: () => calls.filter(c => c.method === 'sendMessage').map(c => String(c.body.text)) };
}
const msg = (text: string, from = OWNER, type = 'private', id = 1) => ({ update_id: id, message: { message_id: id, text, from: { id: from }, chat: { id: from, type } } });
async function setup(reply = () => 'Hello from Relay', gate?: Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'relay-tg-')); const ws = join(dir, 'proj'); await mkdir(ws);
  const store = new Store(join(dir, '.data')); const runs = new Runs(store, adapters(reply, gate)); await runs.refresh();
  store.saveBilling('claude', { mode: 'included', confirmed: true, automaticRouting: true, allowanceNote: 'x' });
  const agent = store.list<Agent>('agent')[0]; store.put('agent', { ...agent, routeMode: 'claude', model: 'm1' });
  store.put<TelegramRecord>('telegram', { id: agent.id, token: TOKEN, allowedUserId: OWNER, enabled: true, offset: 0, botUsername: 'relay_test_bot' });
  const credentials=testCredentials(store);await credentials.initialize();
  const tg = fakeTelegram(); const bot = new TelegramBot(store, runs, agent.id, { credentials, fetch: tg.fetchImpl, pollSeconds: 0, progressMs: 0 });
  return { dir, ws, store, runs, agent, tg, bot, credentials, agentNow: () => store.get<Agent>('agent', agent.id)!, async close() { await bot.stop(); await runs.close(); store.close(); await rm(dir, { recursive: true, force: true }); } };
}

test('chunk splits at 4096 on newline boundaries and loses nothing', () => {
  assert.deepEqual(chunk('short'), ['short']);
  const text = ('a'.repeat(99) + '\n').repeat(100); const parts = chunk(text); assert.ok(parts.length > 2 && parts.every(p => p.length <= 4096)); assert.equal(parts.join('\n'), text);
  const long = 'x'.repeat(9000); const hard = chunk(long); assert.equal(hard.join(''), long); assert.ok(hard.every(p => p.length <= 4096));
});

test('only the allowlisted user in a private chat is answered; everyone else is silently ignored', async () => {
  const f = await setup();
  try {
    await f.bot.handle(msg('hello', 999)); await f.bot.handle(msg('hello', OWNER, 'group')); await f.bot.handle(msg('/work', 999)); await f.bot.idle();
    assert.equal(f.tg.calls.length, 0); assert.equal(f.store.conversations(f.agent.id).flatMap(c => f.store.messages(c.id)).length, 0); assert.equal(f.agentNow().mode, 'agent');
    await f.bot.handle(msg('hello')); await f.bot.idle(); assert.ok(f.tg.texts().includes('Hello from Relay'));
  } finally { await f.close(); }
});

test('text goes through runs.accept on the latest conversation (shared with the web UI) and replies in chunks', async () => {
  const big = 'line of text\n'.repeat(1000); const f = await setup(() => big);
  try {
    await f.bot.handle(msg('hi there')); await f.bot.idle();
    const conversation = f.store.conversations(f.agent.id).at(-1)!; const messages = f.store.messages(conversation.id); assert.equal(messages[0].content, 'hi there'); assert.equal(messages[1].status, 'complete');
    const replies = f.tg.texts(); assert.ok(replies.length >= 4); assert.ok(replies.every(t => t.length <= 4096)); assert.equal(replies.join('\n'), big);
    assert.ok(f.tg.calls.some(c => c.method === 'sendChatAction' && c.body.action === 'typing'));
    assert.ok(f.tg.calls.every(c => c.body.parse_mode === undefined));
  } finally { await f.close(); }
});

test('commands: /work needs a workspace, /mode /chat /auto /new /help, workspace and token are not settable', async () => {
  const f = await setup(); f.store.put('agent', { ...f.agentNow(), workspace: '' });
  try {
    await f.bot.handle(msg('/work')); assert.match(f.tg.texts().at(-1)!, /No workspace/); assert.equal(f.agentNow().mode, 'agent');
    await f.bot.handle(msg('/auto')); assert.equal(f.agentNow().mode, 'auto');
    f.store.put('agent', { ...f.agentNow(), workspace: f.ws }); await f.bot.handle(msg('/work@relay_test_bot')); assert.equal(f.agentNow().mode, 'work');
    await f.bot.handle(msg('/mode')); assert.match(f.tg.texts().at(-1)!, /Mode: work\nWorkspace: set/);
    await f.bot.handle(msg('/chat')); assert.equal(f.agentNow().mode, 'chat');
    const before = f.store.conversations(f.agent.id).length; await f.bot.handle(msg('/new')); assert.equal(f.store.conversations(f.agent.id).length, before + 1);
    await f.bot.handle(msg('/workspace C:\\Windows')); await f.bot.handle(msg('/token 1:x')); assert.match(f.tg.texts().at(-1)!, /\/chat/); assert.equal(f.agentNow().workspace, f.ws);
    assert.equal(f.store.get<TelegramRecord>('telegram', f.agent.id)!.token, undefined);
  } finally { await f.close(); }
});

test('work mode sends one progress message from tool events then edits it; /stop cancels the active run', async () => {
  const f = await setup();
  try {
    f.store.put('agent', { ...f.agentNow(), workspace: f.ws, mode: 'work' }); await f.bot.handle(msg('please fix it')); await f.bot.idle();
    const progress = f.tg.calls.filter(c => c.method === 'sendMessage' && String(c.body.text).startsWith('Working...')); assert.equal(progress.length, 1);
    assert.ok(f.tg.calls.some(c => c.method === 'editMessageText' && String(c.body.text).includes('Bash: npm test')));
  } finally { await f.close(); }
  let release!: () => void; const gate = new Promise<void>(r => { release = r; }); const g = await setup(() => 'late', gate);
  try {
    await g.bot.handle(msg('long task')); assert.equal(g.runs.active.size, 1);
    await g.bot.handle(msg('/status')); assert.match(g.tg.texts().at(-1)!, /Running/);
    await g.bot.handle(msg('second message')); assert.match(g.tg.texts().at(-1)!, /still working/);
    await g.bot.handle(msg('/stop')); await g.bot.idle(); assert.equal(g.runs.active.size, 0); assert.ok(g.tg.texts().includes('Stopped.'));
  } finally { release(); await g.close(); }
});

test('Agent approvals run automatically and native questions are answered by the private chat owner', async () => {
  const f = await setup(); let continued = false; let answer: unknown;
  f.runs.adapters.claude.stream = async request => {
    assert.equal(request.mode, 'agent');
    assert.deepEqual(await request.interact!({ kind: 'approval', title: 'Run requested edit', description: '', details: 'PRIVATE COMMAND DETAILS' }), { decision: 'allow' });
    continued = true;
    answer = await request.interact!({ kind: 'question', title: 'Choose a color', description: '', details: 'PRIVATE INTERNAL DETAILS', questions: [{ id: 'q', question: 'Which color?', options: ['Blue', 'Red'] }] });
    return { text: 'Finished through Telegram' };
  };
  try {
    f.store.put('agent', { ...f.agentNow(), mode: 'agent', workspace: f.ws });
    await f.bot.handle(msg('start native', 999)); await f.bot.handle(msg('start native', OWNER, 'group')); assert.equal(f.runs.active.size, 0); assert.equal(f.tg.calls.length, 0);
    await f.bot.handle(msg('start native')); const active = [...f.runs.active.values()][0];
    for (let i = 0; i < 100 && !f.runs.pendingInteractions(active.run.id).length; i++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(continued, true); const question = f.runs.pendingInteractions(active.run.id)[0]; assert.ok(question);
    await f.bot.handle(msg('/status')); assert.match(f.tg.texts().at(-1)!, /Awaiting your answer/);
    f.runs.emit(active, { type: 'interaction', interaction: question });
    await f.bot.handle(msg('Red', 999)); await f.bot.handle(msg('Red', OWNER, 'group')); assert.equal(f.runs.pendingInteractions(active.run.id).length, 1);
    await f.bot.handle(msg('Blue')); await f.bot.idle();
    assert.deepEqual(answer, { decision: 'allow', answers: { q: ['Blue'] } });
    const notices = f.tg.texts().filter(text => text.startsWith('Choose a color')); assert.equal(notices.length, 1);
    assert.match(notices[0], /Which color\?/); assert.match(notices[0], /Reply here/);
    assert.ok(f.tg.texts().every(text => !text.includes('PRIVATE'))); assert.ok(f.tg.calls.every(call => call.body.chat_id === OWNER));
    assert.ok(f.tg.texts().includes('Finished through Telegram'));
    assert.ok(f.store.messages(active.run.conversationId).some(message => message.content === 'Blue' && message.role === 'user'));
  } finally { await f.close(); }
});

test('Telegram /stop cancels a native request without answering it', async () => {
  const f = await setup(); let answered = false;
  f.runs.adapters.claude.stream = async request => { await request.interact!({ kind: 'question', title: 'Choose', description: '', questions: [{ id: 'q', question: 'Which option?' }] }); answered = true; return { text: 'unsafe' }; };
  try {
    f.store.put('agent', { ...f.agentNow(), mode: 'agent', workspace: f.ws }); await f.bot.handle(msg('start native'));
    const active = [...f.runs.active.values()][0];
    for (let i = 0; i < 100 && !f.runs.pendingInteractions(active.run.id).length; i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(f.runs.pendingInteractions(active.run.id).length, 1);
    await f.bot.handle(msg('/stop')); await f.bot.idle(); assert.equal(answered, false); assert.equal(f.runs.active.size, 0); assert.deepEqual(f.runs.pendingInteractions(active.run.id), []);
    assert.ok(f.tg.texts().includes('Stopped.'));
  } finally { await f.close(); }
});

test('polling persists the offset before handling so a restart never replays updates; errors back off and never leak the token', async () => {
  const f = await setup();
  try {
    f.tg.queue.push([msg('hello', OWNER, 'private', 7)]); f.bot.start();
    for (let i = 0; i < 100 && f.tg.texts().length < 1; i++) await new Promise(r => setTimeout(r, 20));
    await f.bot.stop(); assert.equal(f.store.get<TelegramRecord>('telegram', f.agent.id)!.offset, 8);
    assert.equal(f.tg.calls.find(c => c.method === 'getUpdates')!.body.offset, 0);
    const second = new TelegramBot(f.store, f.runs, f.agent.id, { credentials:f.credentials, fetch: f.tg.fetchImpl, pollSeconds: 0 }); second.start(); await new Promise(r => setTimeout(r, 60)); await second.stop();
    assert.ok(f.tg.calls.filter(c => c.method === 'getUpdates').some(c => c.body.offset === 8));
    const failing = new TelegramBot(f.store, f.runs, f.agent.id, { credentials:f.credentials, fetch: (async (url: string) => { throw new Error(`connect failed ${url}`); }) as unknown as typeof fetch }); failing.start();
    for (let i = 0; i < 50 && !failing.error; i++) await new Promise(r => setTimeout(r, 10));
    assert.ok(failing.error && !failing.error.includes(TOKEN)); await failing.stop();
  } finally { await f.close(); }
});

test('HTTP: PUT/GET/DELETE /api/agents/:id/telegram never expose the token and validate input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-tgh-')); const client = join(dir, 'client'); await mkdir(client); await writeFile(join(client, 'index.html'), 'x');
  const tg = fakeTelegram(); const app = createApp({ secretVault:new SyntheticVault(), dataDir: join(dir, '.data'), adapters: adapters(() => 'x'), clientDir: client, port: 0, telegramFetch: tg.fetchImpl, telegramPollSeconds: 0 }); const port = await app.listen(0); const base = `http://127.0.0.1:${port}`;
  try {
    const initial = await fetch(`${base}/api/bootstrap`); const cookie = initial.headers.get('set-cookie')!.split(';')[0]; const boot = await initial.json() as Bootstrap;
    const call = (path: string, method: string, body?: unknown) => fetch(base + path, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': boot.csrfToken }, body: body === undefined ? undefined : JSON.stringify(body) });
    const [a, b] = boot.agents; const url = `/api/agents/${a.id}/telegram`;
    const empty = await (await call(url, 'GET')).json() as TelegramStatus; assert.equal(empty.configured, false);
    assert.equal((await call(url, 'PUT', { allowedUserId: OWNER, enabled: true })).status, 400);
    assert.equal((await call(url, 'PUT', { token: 'nope', allowedUserId: OWNER, enabled: true })).status, 400);
    assert.equal((await call(url, 'PUT', { token: TOKEN, allowedUserId: 'x', enabled: true })).status, 400);
    assert.equal((await call(url, 'PUT', { token: TOKEN, allowedUserId: OWNER, enabled: true, extra: 1 })).status, 400);
    tg.setBadToken(true); const rejected = await call(url, 'PUT', { token: TOKEN, allowedUserId: OWNER, enabled: true }); assert.equal(rejected.status, 400); assert.ok(!(await rejected.text()).includes(TOKEN)); tg.setBadToken(false);
    const ok = await call(url, 'PUT', { token: TOKEN, allowedUserId: OWNER, enabled: true }); const body = await ok.text(); assert.equal(ok.status, 200); assert.ok(!body.includes(TOKEN));
    const status = JSON.parse(body) as TelegramStatus; assert.deepEqual([status.configured, status.enabled, status.botUsername, status.allowedUserId], [true, true, 'relay_test_bot', OWNER]);
    assert.equal((await call(`/api/agents/${b.id}/telegram`, 'PUT', { token: TOKEN, allowedUserId: OWNER, enabled: true })).status, 400);
    const update = await call(url, 'PUT', { allowedUserId: 77, enabled: false }); assert.equal(update.status, 200); assert.equal(((await update.json()) as TelegramStatus).allowedUserId, 77);
    for (const path of ['/api/bootstrap', `/api/agents/${a.id}`, url]) assert.ok(!(await (await call(path, 'GET')).text()).includes(TOKEN), path);
    assert.equal(app.store.get<TelegramRecord>('telegram', a.id)!.token, undefined);
    const removed = await (await call(url, 'DELETE')).json() as TelegramStatus; assert.equal(removed.configured, false); assert.equal(app.store.get('telegram', a.id), undefined);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('Telegram manager starts a bot per enabled agent and stops cleanly', async () => {
  const f = await setup();
  try {
    const manager = new Telegram(f.store, f.runs, { credentials:f.credentials, fetch: f.tg.fetchImpl, pollSeconds: 0 }); manager.startAll(); assert.equal(manager.status(f.agent.id).running, true); assert.equal(manager.status(f.agent.id).error, null);
    await manager.stop(); assert.equal(manager.status(f.agent.id).running, false); assert.ok(JSON.stringify(manager.status(f.agent.id)).indexOf(TOKEN) < 0);
  } finally { await f.close(); }
});

test('a deleted record is never re-created by an in-flight poll batch, and remaining updates are dropped', async () => {
  const f = await setup();
  try {
    let removed = false;
    const wrapped = (async (url: string, init: RequestInit) => { const res = await f.tg.fetchImpl(url, init); if (url.endsWith('sendMessage') && !removed) { removed = true; f.store.remove('telegram', f.agent.id); } return res; }) as unknown as typeof fetch;
    const bot = new TelegramBot(f.store, f.runs, f.agent.id, { credentials:f.credentials, fetch: wrapped, pollSeconds: 0 });
    f.tg.queue.push([msg('/help', OWNER, 'private', 1), msg('/help', OWNER, 'private', 2), msg('/help', OWNER, 'private', 3)]); bot.start();
    for (let i = 0; i < 100 && !removed; i++) await new Promise(r => setTimeout(r, 20));
    await new Promise(r => setTimeout(r, 100)); await bot.stop();
    assert.equal(f.store.get('telegram', f.agent.id), undefined); assert.equal(f.tg.texts().length, 1);
  } finally { await f.close(); }
});

test('stop() does not wait for pending run jobs, so shutdown cannot hang', async () => {
  const f = await setup(() => 'x', new Promise<void>(() => {}));
  try {
    f.tg.queue.push([msg('hello', OWNER, 'private', 1)]); f.bot.start();
    for (let i = 0; i < 100 && !f.bot.pending.size; i++) await new Promise(r => setTimeout(r, 20));
    assert.ok(f.bot.pending.size > 0);
    await Promise.race([f.bot.stop(), new Promise((_, reject) => setTimeout(() => reject(new Error('stop() hung')), 2000))]);
    await f.runs.close(); await f.bot.idle();
  } finally { await f.close(); }
});

test('PUT with a new token keeps offsets handled while getMe was in flight', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-tgo-')); const client = join(dir, 'client'); await mkdir(client); await writeFile(join(client, 'index.html'), 'x');
  const tg = fakeTelegram(); let app: ReturnType<typeof createApp>; let bump = false; let agentId = '';
  const fetchImpl = (async (url: string, init: RequestInit) => { if (bump && url.endsWith('getMe')) app.store.put('telegram', { ...app.store.get<TelegramRecord>('telegram', agentId)!, offset: 55 }); return tg.fetchImpl(url, init); }) as unknown as typeof fetch;
  app = createApp({ secretVault:new SyntheticVault(), dataDir: join(dir, '.data'), adapters: adapters(() => 'x'), clientDir: client, port: 0, telegramFetch: fetchImpl, telegramPollSeconds: 0 }); const port = await app.listen(0); const base = `http://127.0.0.1:${port}`;
  try {
    const initial = await fetch(`${base}/api/bootstrap`); const cookie = initial.headers.get('set-cookie')!.split(';')[0]; const boot = await initial.json() as Bootstrap;
    const call = (path: string, method: string, body?: unknown) => fetch(base + path, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': boot.csrfToken }, body: body === undefined ? undefined : JSON.stringify(body) });
    agentId = boot.agents[0].id; const url = `/api/agents/${agentId}/telegram`;
    assert.equal((await call(url, 'PUT', { token: TOKEN, allowedUserId: OWNER, enabled: false })).status, 200);
    bump = true; assert.equal((await call(url, 'PUT', { token: TOKEN, allowedUserId: OWNER, enabled: false })).status, 200);
    assert.equal(app.store.get<TelegramRecord>('telegram', agentId)!.offset, 55);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('Telegram Work and Auto reject the detected home before changing mode or starting inference', async () => {
  const f = await setup();
  try {
    f.store.put('agent', { ...f.agentNow(), mode: 'agent', workspace: homedir() });
    let inspections = 0; const inspect = f.runs.refresh.bind(f.runs); f.runs.refresh = () => { inspections++; return inspect(); };
    for (const command of ['/work', '/auto']) {
      const before = f.agentNow(); await f.bot.handle(msg(command));
      assert.deepEqual(f.agentNow(), before); assert.match(f.tg.texts().at(-1)!, /whole home.*Work mode|project folder/);
      assert.equal(f.runs.active.size, 0); assert.equal(inspections, 0);
    }
    await f.bot.handle(msg('/chat')); assert.equal(f.agentNow().mode, 'chat'); assert.equal(f.agentNow().workspace, homedir());
    f.store.put('agent', { ...f.agentNow(), workspace: f.ws });
    await f.bot.handle(msg('/auto')); assert.equal(f.agentNow().mode, 'auto');
    await f.bot.handle(msg('/work')); assert.equal(f.agentNow().mode, 'work');
  } finally { await f.close(); }
});