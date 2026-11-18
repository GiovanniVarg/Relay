import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { join, parse } from 'node:path';
import { createApp } from '../server/index.js';
import { Store, PROVIDER_IDS } from '../server/store.js';
import { Runs } from '../server/runs.js';
import { resolveMode, validateWorkspace } from '../server/mode.js';
import { redactSecrets } from '../server/security.js';
import type { Agent, Bootstrap, ProviderAdapter, ProviderEvent, ProviderId, ProviderRequest, Run, RunEvent } from '../shared/types.js';

const included = { mode: 'included' as const, confirmed: true, automaticRouting: true, allowanceNote: 'x' };
const conn = (id: ProviderId) => ({ id, installed: true, authenticated: true, authMode: 'subscription' as const, accountLabel: 'Test', plan: 'Test', models: [{ id: 'm1', name: 'm1', verified: false }] });
function adapters(seen: ProviderRequest[], tools = false): Record<ProviderId, ProviderAdapter> {
  return Object.fromEntries(PROVIDER_IDS.map(id => [id, { id, inspect: async () => conn(id), login: async () => ({ message: 'x' }), close: async () => {}, stream: async (r: ProviderRequest, emit: (e: ProviderEvent) => void) => { seen.push(r); if (tools && r.mode === 'work') emit({ type: 'tool', name: 'Edit', summary: 'a.ts' }); emit({ type: 'delta', text: 'ok' }); return { text: 'ok', actualModel: r.model }; } }])) as unknown as Record<ProviderId, ProviderAdapter>;
}
async function setup(tools = false) {
  const dir = await mkdtemp(join(tmpdir(), 'relay-modes-')); const data = join(dir, '.data'); const ws = join(dir, 'proj'); await mkdir(ws);
  const seen: ProviderRequest[] = []; let store = new Store(data); const runs = new Runs(store, adapters(seen, tools)); await runs.refresh(); store.saveBilling('claude', included);
  const agent = store.list<Agent>('agent')[0]; const conversation = store.conversations(agent.id)[0];
  return { dir, data, ws, seen, store, runs, agent, conversation, async close() { await runs.close(); store.close(); await rm(dir, { recursive: true, force: true }); } };
}
const done = async (runs: Runs, id: string) => { await runs.active.get(id)?.promise; return runs.store.get<Run>('run', id)!; };

test('resolveMode: chat never works, explicit work needs a workspace, auto classifies and needs a workspace', () => {
  const w = { workspace: '/x' }; const none = { workspace: '' };
  assert.equal(resolveMode('chat', w, 'fix the bug in src/a.ts'), 'chat');
  assert.throws(() => resolveMode('work', none, 'hi'), { status: 400 });
  assert.equal(resolveMode('work', w, 'hello'), 'work');
  assert.equal(resolveMode('auto', none, 'fix the bug in src/a.ts'), 'chat');
  for (const text of ['fix the failing test', 'please refactor this', 'run npm test', 'edit src/app/main.ts', 'update README.md', 'look at the codebase', 'create a new file for it']) assert.equal(resolveMode('auto', w, text), 'work', text);
  for (const text of ['what is the capital of France?', 'explain how DNS works', 'write me a poem about autumn']) assert.equal(resolveMode('auto', w, text), 'chat', text);
});

test('validateWorkspace rejects relative, missing, file, root, home, and Relay data folder paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-ws-')); const data = join(dir, '.data'); await mkdir(data); const proj = join(dir, 'proj'); await mkdir(proj); await writeFile(join(dir, 'file.txt'), 'x');
  try {
    const bad = (p: unknown) => assert.throws(() => validateWorkspace(p, data), { status: 400 }, String(p));
    bad(''); bad(42); bad('proj'); bad('..'); bad('../..'); bad(join(dir, 'missing')); bad(join(dir, 'file.txt')); bad(`${proj}\u0000`);
    bad(parse(dir).root); bad(homedir()); bad(data); bad(join(data, 'sub')); bad(dir);
    bad(join(proj, '..', '.data'));
    assert.equal(validateWorkspace(join(proj, '..', 'proj'), data), validateWorkspace(proj, data));
    let linked = true; try { await symlink(data, join(proj, 'link'), 'junction'); } catch { linked = false; }
    if (linked) bad(join(proj, 'link'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('work runs pass mode+workspace to the adapter, record Run.mode, forward tool events; chat runs stay text-only', async () => {
  const f = await setup(true);
  try {
    f.store.put('agent', { ...f.agent, workspace: f.ws, mode: 'work' });
    const events: RunEvent[] = [];
    const { run } = f.runs.accept(f.store.get<Agent>('agent', f.agent.id)!, f.conversation.id, 'hello', 'claude', 'm1'); f.runs.subscribe(run.id, e => events.push(e));
    assert.equal(run.mode, 'work'); const finished = await done(f.runs, run.id);
    assert.equal(finished.status, 'complete'); assert.equal(finished.mode, 'work');
    const work = f.seen.filter(r => r.mode === 'work'); assert.equal(work.length, 1); assert.equal(work[0].workspace, validateWorkspace(f.ws, f.data));
    assert.ok(events.some(e => e.type === 'tool' && e.name === 'Edit' && e.summary === 'a.ts'));
    f.seen.length = 0;
    const second = f.runs.accept(f.store.get<Agent>('agent', f.agent.id)!, f.conversation.id, 'hello', 'claude', 'm1', 'chat'); assert.equal(second.run.mode, 'chat'); await done(f.runs, second.run.id);
    assert.ok(f.seen.every(r => r.mode === undefined && r.workspace === undefined));
  } finally { await f.close(); }
});

test('explicit work without a workspace is rejected and a vanished workspace fails closed; auto falls back to chat', async () => {
  const f = await setup();
  try {
    f.store.put('agent', { ...f.agent, workspace: '' });
    assert.throws(() => f.runs.accept(f.agent, f.conversation.id, 'hi', 'claude', 'm1', 'work'), { status: 400 });
    const auto = f.runs.accept(f.agent, f.conversation.id, 'fix src/a.ts', 'claude', 'm1', 'auto'); assert.equal(auto.run.mode, 'chat'); await done(f.runs, auto.run.id);
    f.store.put('agent', { ...f.agent, workspace: join(f.dir, 'gone'), mode: 'work' });
    assert.throws(() => f.runs.accept(f.store.get<Agent>('agent', f.agent.id)!, f.conversation.id, 'hi', 'claude', 'm1'), { status: 400 });
  } finally { await f.close(); }
});

test('work runs use maxWorkSeconds, not maxRunSeconds', async () => {
  const f = await setup();
  try {
    f.store.put('agent', { ...f.agent, workspace: f.ws, mode: 'work' }); f.store.saveSettings({ ...f.store.settings(), maxRunSeconds: 5, maxWorkSeconds: 77 });
    const { run } = f.runs.accept(f.store.get<Agent>('agent', f.agent.id)!, f.conversation.id, 'hi', 'claude', 'm1'); await done(f.runs, run.id);
    const main = f.seen.at(-1)!; assert.ok(main.maxSeconds > 60 && main.maxSeconds <= 77);
  } finally { await f.close(); }
});

test('store migrates legacy agents and defaults maxWorkSeconds', async () => {
  const f = await setup();
  try {
    const { mode: _m, workspace: _w, ...legacy } = f.agent; f.store.put('agent', legacy as Agent);
    const reopened = new Store(f.data); const migrated = reopened.get<Agent>('agent', f.agent.id)!; assert.equal(migrated.mode, 'agent'); assert.equal(migrated.workspace, homedir());
    assert.equal(reopened.settings().maxWorkSeconds, 900); reopened.close();
  } finally { await f.close(); }
});

test('HTTP: agent mode/workspace and message mode validation, maxWorkSeconds range', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-http-')); const client = join(dir, 'client'); await mkdir(client); await writeFile(join(client, 'index.html'), 'x'); const ws = join(dir, 'proj'); await mkdir(ws);
  const seen: ProviderRequest[] = []; const app = createApp({ dataDir: join(dir, '.data'), adapters: adapters(seen), clientDir: client, port: 0 }); const port = await app.listen(0); const base = `http://127.0.0.1:${port}`;
  try {
    const initial = await fetch(`${base}/api/bootstrap`); const cookie = initial.headers.get('set-cookie')!.split(';')[0]; const boot = await initial.json() as Bootstrap;
    const call = (path: string, method: string, body?: unknown) => fetch(base + path, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': boot.csrfToken }, body: body === undefined ? undefined : JSON.stringify(body) });
    const a = boot.agents[0]; assert.equal(a.mode, 'agent'); assert.equal(a.workspace, homedir());
    assert.equal((await call(`/api/agents/${a.id}`, 'PATCH', { mode: 'work' })).status, 400);
    assert.equal((await call(`/api/agents/${a.id}`, 'PATCH', { mode: 'bogus' })).status, 400);
    for (const bad of ['relative/path', join(dir, 'nope'), parse(dir).root, join(dir, '.data')]) assert.equal((await call(`/api/agents/${a.id}`, 'PATCH', { workspace: bad })).status, 400, bad);
    const ok = await call(`/api/agents/${a.id}`, 'PATCH', { workspace: ws, mode: 'auto' }); assert.equal(ok.status, 200); const updated = await ok.json() as Agent; assert.equal(updated.mode, 'auto'); assert.ok(updated.workspace);
    assert.equal((await call(`/api/agents/${a.id}`, 'PATCH', { workspace: '', mode: 'chat' })).status, 200);
    const conv = boot.conversations.find(c => c.agentId === a.id)!;
    assert.equal((await call(`/api/conversations/${conv.id}/messages`, 'POST', { content: 'hi', mode: 'work' })).status, 400);
    assert.equal((await call(`/api/conversations/${conv.id}/messages`, 'POST', { content: 'hi', mode: 'nope' })).status, 400);
    for (const v of [0, 3601, 1.5, '9']) assert.equal((await call('/api/settings', 'PATCH', { maxWorkSeconds: v })).status, 400);
    const s = await call('/api/settings', 'PATCH', { maxWorkSeconds: 3600 }); assert.equal(((await s.json()) as { maxWorkSeconds: number }).maxWorkSeconds, 3600);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('redactSecrets strips bot tokens and bot URLs', () => {
  const token = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw_x'; assert.equal(redactSecrets(`failed https://api.telegram.org/bot${token}/getMe with ${token}`), 'failed https://api.telegram.org/[redacted]/getMe with [redacted]');
});

test('work mode: a multi-turn run (streamed text across tool turns, shorter final text) completes and the final text replaces the streamed text', async () => {
  const f = await setup();
  try {
    f.store.put('agent', { ...f.agent, workspace: f.ws, mode: 'work' });
    const multi = (final: string) => ({ ...f.runs.adapters, claude: { ...f.runs.adapters.claude, stream: async (r: ProviderRequest, emit: (e: ProviderEvent) => void) => {
      emit({ type: 'delta', text: 'Looking at it. ' }); emit({ type: 'tool', name: 'Edit', summary: 'a.ts' }); emit({ type: 'delta', text: 'Edited. ' }); return { text: final, actualModel: r.model };
    } } });
    f.runs.adapters = multi('All done.') as never;
    const a = f.runs.accept(f.store.get<Agent>('agent', f.agent.id)!, f.conversation.id, 'x', 'claude', 'm1');
    assert.equal((await done(f.runs, a.run.id)).status, 'complete'); assert.equal(f.store.get<{ content: string }>('message', a.run.messageId)!.content, 'All done.');
    f.runs.adapters = multi('  ') as never; // empty final in work mode keeps the streamed content
    const b = f.runs.accept(f.store.get<Agent>('agent', f.agent.id)!, f.conversation.id, 'y', 'claude', 'm1');
    assert.equal((await done(f.runs, b.run.id)).status, 'complete'); assert.equal(f.store.get<{ content: string }>('message', b.run.messageId)!.content, 'Looking at it. Edited. ');
    f.runs.adapters = { ...f.runs.adapters, claude: { ...f.runs.adapters.claude, stream: async (r: ProviderRequest, emit: (e: ProviderEvent) => void) => { emit({ type: 'delta', text: 'abc' }); return { text: 'xyz', actualModel: r.model }; } } } as never;
    const c = f.runs.accept(f.store.get<Agent>('agent', f.agent.id)!, f.conversation.id, 'z', 'claude', 'm1', 'chat'); // chat mode keeps its strict check
    assert.equal((await done(f.runs, c.run.id)).status, 'failed');
  } finally { await f.close(); }
});

test('auto-route fallback never re-runs a work-mode turn', async () => {
  const f = await setup();
  try {
    f.store.put('agent', { ...f.agent, workspace: f.ws, mode: 'work', routeMode: 'auto' });
    let calls = 0; const failing = Object.fromEntries(PROVIDER_IDS.map(id => [id, { ...f.runs.adapters[id], stream: async () => { calls++; throw new Error('boom'); } }]));
    f.runs.adapters = failing as never;
    const a = f.runs.accept(f.store.get<Agent>('agent', f.agent.id)!, f.conversation.id, 'x', 'auto', '', 'work');
    assert.equal((await done(f.runs, a.run.id)).status, 'failed'); assert.equal(calls, 1);
  } finally { await f.close(); }
});

test('validateWorkspace: 8.3 short names resolve and a child dir named ..x is inside, not outside', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-ws-')); const data = join(dir, '.data'); await mkdir(data);
  try {
    const weird = join(dir, '..x'); await mkdir(weird);
    assert.equal(validateWorkspace(weird, data), validateWorkspace(weird, data)); // '..x' sibling of .data is allowed
    const inside = join(data, '..x'); await mkdir(inside); assert.throws(() => validateWorkspace(inside, data), { status: 400 }); // '..x' under data is still inside data
    if (process.platform === 'win32') {
      const short = execFileSync('cmd', ['/c', 'for %I in ("' + data + '") do @echo %~sI'], { encoding: 'utf8' }).trim();
      if (short && short.toLowerCase() !== data.toLowerCase()) assert.throws(() => validateWorkspace(join(short, 'x'.repeat(0)), data), { status: 400 });
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('auto classifier: common words alone stay chat; strong signals work', () => {
  const w = { workspace: '/x' };
  for (const text of ['how do I run a project meeting', 'what is a good test strategy for a team', 'build a habit of reading', 'any project ideas?']) assert.equal(resolveMode('auto', w, text), 'chat', text);
  for (const text of ['fix the failing test', 'git status', 'here is code ```x```', 'open src/a.ts', 'run the build script']) assert.equal(resolveMode('auto', w, text), 'work', text);
});

test('redactSecrets strips short-numeric-id bot tokens too', () => assert.equal(redactSecrets('a 1234:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw_x b'), 'a [redacted] b'));

test('Work badge retains chat routing failure and never starts the work adapter', async () => {
  const f = await setup();
  try {
    f.store.saveBilling('openai', included);
    f.store.put('agent', { ...f.agent, workspace: f.ws, mode: 'work', routeMode: 'auto' });
    f.runs.adapters.openai.stream = async request => {
      f.seen.push(request);
      throw new Error('Codex did not enforce the required sandbox (stage=chat thread/start; sandbox=readOnly; network=true; approval=never; backend=missing). No turn started.');
    };
    const { run } = f.runs.accept(f.store.get<Agent>('agent', f.agent.id)!, f.conversation.id, 'Audit the project security', 'auto', '', 'work');
    const finished = await done(f.runs, run.id);
    assert.equal(finished.mode, 'work');
    assert.equal(finished.status, 'failed');
    assert.equal(finished.route, null);
    assert.match(finished.error!, /Chat routing classifier failed:.*stage=chat thread\/start.*network=true/);
    assert.equal(f.seen.length, 1);
    assert.equal(f.seen[0].mode, undefined);
    assert.equal(f.seen[0].workspace, undefined);
    assert.equal(f.seen[0].conversationId, `route-${run.id}`);
  } finally { await f.close(); }
});
