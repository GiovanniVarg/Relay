import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CodexAdapter, CODEX_AGENT_ARGS } from '../server/providers/codex.js';
import { JsonLines, OwnedProcess, providerOutcomeUnknown, type Launcher } from '../server/providers/process.js';
import type { ProviderEvent, ProviderRequest } from '../shared/types.js';

const command = { file: 'fake-startup-provider.exe', args: [] };
const sqliteError = 'Error: failed to initialize sqlite state runtime under C:\\private-user\\secret-profile: failed to initialize state runtime at C:\\private-user\\secret-profile\n';
const request: ProviderRequest = { runId: 'startup', conversationId: 'c', model: 'gpt-test', mode: 'agent', instructions: 'private instructions',
  history: [{ role: 'user', content: 'private prompt' }], maxSeconds: 3,
  expectedAccount: { accountLabel: 'approved@example.test', plan: 'team' }, interact: async () => ({ decision: 'deny' }) };
type Failure = { at: string; code?: number | null; signal?: NodeJS.Signals | null; stderr?: string; malformed?: boolean; chunked?: boolean;
  activity?: 'notification' | 'foreign-response' | 'userMessage-started' | 'userMessage-completed'; beforeExit?: () => void };

function fixture(failures: Failure[]) {
  const launches: { args: string[]; cwd: string; env: NodeJS.ProcessEnv; closed: boolean; methods: string[] }[] = [];
  let turns = 0;
  const launcher: Launcher = (_command, args, cwd, env) => {
    // A replacement must wait until its predecessor has actually closed.
    assert.ok(launches.every(launch => launch.closed));
    const launch = { args: [...args], cwd, env: { ...env }, closed: false, methods: [] as string[] };
    const failure = failures[launches.length]; launches.push(launch);
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
      pid: 987654, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, kill: () => { end(); return true; } });
    function end(code: number | null = 0, signal: NodeJS.Signals | null = null) {
      if (launch.closed) return;
      launch.closed = true; child.exitCode = code; child.signalCode = signal; child.emit('close', code, signal);
    }
    const send = (value: unknown) => child.stdout.write(JSON.stringify(value) + '\n');
    function fail() {
      if (failure.activity === 'notification') send({ method: 'private/notification', params: { secret: 'protocol-secret' } });
      if (failure.activity === 'foreign-response') send({ id: 999, result: { secret: 'protocol-secret' } });
      if (failure.activity?.startsWith('userMessage-')) send({ method: failure.activity === 'userMessage-started' ? 'item/started' : 'item/completed',
        params: { threadId: 'thread', turnId: 'turn', item: { type: 'userMessage', id: 'user', content: [{ type: 'text', text: 'hidden-user-message' }] } } });
      const text = failure.stderr ?? sqliteError;
      if (failure.chunked) { for (const byte of Buffer.from(text)) child.stderr.write(Buffer.from([byte])); }
      else child.stderr.write(text);
      if (failure.malformed) child.stdout.write('{bad protocol}\n');
      end(failure.code === undefined ? 1 : failure.code, failure.signal ?? null);
      failure.beforeExit?.();
    }
    const parser = new JsonLines(message => {
      launch.methods.push(message.method ?? 'host-response');
      if (!message.id) return;
      queueMicrotask(() => {
        if (launch.closed) return;
        if (message.method === 'turn/start') turns++;
        if (failure?.at === message.method) { fail(); return; }
        let result: any = {};
        if (message.method === 'config/read') result = { config: { forced_login_method: 'chatgpt', model_provider: 'openai', approval_policy: 'on-request',
          sandbox_mode: 'workspace-write', sandbox_workspace_write: { network_access: false }, windows: { sandbox: 'mxc' } } };
        if (message.method === 'account/read') result = { account: { type: 'chatgpt', email: 'approved@example.test', planType: 'team' } };
        if (message.method === 'thread/start') {
          assert.equal(message.params.model, 'gpt-test'); assert.equal(message.params.modelProvider, 'openai');
          result = { thread: { id: 'thread' }, model: 'gpt-test', modelProvider: 'openai', approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite', networkAccess: false } };
        }
        if (message.method === 'turn/start') result = { turn: { id: 'turn' } };
        send({ id: message.id, result });
        if (message.method === 'turn/start') {
          if (failure?.at === 'partial') { send({ method: 'item/agentMessage/delta', params: { threadId: 'thread', turnId: 'turn', itemId: 'answer', delta: 'partial' } }); fail(); }
          else if (failure?.at === 'tool') { send({ method: 'item/started', params: { threadId: 'thread', turnId: 'turn', item: { type: 'mcpToolCall', id: 'tool', server: 'fixture', tool: 'lookup' } } }); fail(); }
          else send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', text: 'Finished.' }] } } });
        }
      });
    });
    child.stdin.on('data', value => parser.push(value)); child.stdin.on('finish', () => end());
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  return { launcher, launches, turns: () => turns };
}

async function harness(failures: Failure[], body: (adapter: CodexAdapter, f: ReturnType<typeof fixture>, dir: string, events: ProviderEvent[]) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'relay-codex-startup-'));
  const f = fixture(failures), events: ProviderEvent[] = [];
  const adapter = new CodexAdapter(dir, { command: async () => command, launcher: f.launcher, kill: async child => { child.kill(); } });
  try { await body(adapter, f, dir, events); }
  finally { await adapter.close(); await rm(dir, { recursive: true, force: true }); }
}

for (const failures of [1, 2]) test(`Codex recovers from ${failures} SQLite initialize exits before one model turn`, async () => {
  await harness(Array.from({ length: failures }, () => ({ at: 'initialize', chunked: true })), async (adapter, f, dir, events) => {
    const result = await adapter.stream({ ...request, workspace: dir }, event => events.push(event), new AbortController().signal);
    assert.equal(result.text, 'Finished.'); assert.equal(f.launches.length, failures + 1); assert.equal(f.turns(), 1);
    for (const launch of f.launches) {
      assert.deepEqual(launch.args, CODEX_AGENT_ARGS); assert.equal(launch.cwd, dir); assert.equal(launch.env.CODEX_HOME, join(dir, 'openai'));
      assert.deepEqual(launch.env, f.launches[0].env);
    }
    for (const launch of f.launches.slice(0, -1)) assert.deepEqual(launch.methods, ['initialize']);
    assert.deepEqual(events.filter(e => e.type === 'delta').map(e => e.text), ['Finished.']);
  });
});

test('Codex stops after three SQLite initialize exits with safe actionable exit diagnostics', async () => {
  await harness(Array.from({ length: 4 }, () => ({ at: 'initialize', stderr: sqliteError + 'access_token=super-secret sk-secret-value 😀\n', chunked: true })), async (adapter, f, dir) => {
    await assert.rejects(adapter.stream({ ...request, workspace: dir }, () => {}, new AbortController().signal), error => {
      assert.match(String(error), /phase=initialize.*exitCode=1.*signal=none.*category=sqlite-state-initialization/);
      assert.doesNotMatch(String(error), /private-user|secret-profile|super-secret|sk-secret|access_token|😀/); return true;
    });
    assert.equal(f.launches.length, 3); assert.equal(f.turns(), 0);
    assert.ok(f.launches.every(launch => launch.closed && launch.methods.join() === 'initialize'));
  });
});

for (const activity of ['userMessage-started', 'userMessage-completed'] as const) test(`Codex image request does not retry after filtered ${activity} before initialize acknowledgment`, async () => {
  await harness([{ at: 'initialize', activity }], async (adapter, f, dir, events) => {
    const bytes = Buffer.from('private-image-input');
    const imageRequest: ProviderRequest = { ...request, workspace: dir,
      history: [{ role: 'user', content: 'Inspect image', messageId: 'source', imageRefs: ['image'] }],
      imageTable: [{ attachmentId: 'image', messageId: 'source', sha256: createHash('sha256').update(bytes).digest('hex'),
        mimeType: 'image/png', data: bytes.toString('base64'), width: 1, height: 1 }] };
    await assert.rejects(adapter.stream(imageRequest, event => events.push(event), new AbortController().signal), /phase=initialize.*exitCode=1/);
    assert.equal(f.launches.length, 1); assert.equal(f.turns(), 0);
    assert.deepEqual(events, []); assert.doesNotMatch(JSON.stringify(events), /hidden-user-message|private-image-input/);
  });
});

for (const at of ['config/read', 'account/read', 'thread/start', 'turn/start', 'partial', 'tool']) test(`Codex never replays after initialize succeeds then exits at ${at}`, async () => {
  await harness([{ at }], async (adapter, f, dir, events) => {
    await assert.rejects(adapter.stream({ ...request, workspace: dir }, event => events.push(event), new AbortController().signal), error => {
      assert.match(String(error), /exitCode=1.*signal=none/);
      assert.match(String(error), new RegExp('phase=' + (['partial', 'tool'].includes(at) ? 'turn/running' : at))); return true;
    });
    assert.equal(f.launches.length, 1); assert.equal(f.turns(), ['turn/start', 'partial', 'tool'].includes(at) ? 1 : 0);
    if (at === 'partial') assert.ok(events.some(event => event.type === 'delta' && event.text === 'partial'));
    if (at === 'tool') assert.ok(events.some(event => event.type === 'tool'));
  });
});

for (const failure of [
  { at: 'initialize', stderr: 'unrecognized failure with private-path and secret-token' },
  { at: 'initialize', code: 0 }, { at: 'initialize', code: 2 },
  { at: 'initialize', code: null, signal: 'SIGTERM' as const }, { at: 'initialize', malformed: true },
  { at: 'initialize', activity: 'notification' as const }, { at: 'initialize', activity: 'foreign-response' as const },
]) test(`Codex does not retry unrecognized or unsafe startup failure ${JSON.stringify({ ...failure, stderr: failure.stderr ? 'unrecognized' : undefined })}`, async () => {
  await harness([failure], async (adapter, f, dir) => {
    await assert.rejects(adapter.stream({ ...request, workspace: dir }, () => {}, new AbortController().signal), error => {
      assert.doesNotMatch(String(error), /private-path|secret-token|protocol-secret|private\/notification/);
      assert.match(String(error), failure.malformed ? /malformed/ : /phase=initialize.*exitCode=/); return true;
    });
    assert.equal(f.launches.length, 1); assert.equal(f.turns(), 0);
  });
});

test('Codex abort during startup backoff never launches another worker', async () => {
  const controller = new AbortController();
  await harness([{ at: 'initialize', beforeExit: () => { setTimeout(() => controller.abort(), 10); } }], async (adapter, f, dir) => {
    await assert.rejects(adapter.stream({ ...request, workspace: dir }, () => {}, controller.signal), /cancelled/);
    assert.equal(f.launches.length, 1); assert.equal(f.turns(), 0);
  });
});

test('Codex close during startup backoff prevents replacement without a request abort', async () => {
  let adapterToClose: CodexAdapter;
  await harness([{ at: 'initialize', beforeExit: () => { setTimeout(() => { void adapterToClose.close(); }, 10); } }], async (adapter, f, dir) => {
    adapterToClose = adapter;
    await assert.rejects(adapter.stream({ ...request, workspace: dir }, () => {}, new AbortController().signal), /cancelled/);
    assert.equal(f.launches.length, 1); assert.equal(f.turns(), 0);
  });
});

test('Codex close during command lookup prevents that launch and permits a later fresh connection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-codex-lookup-'));
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const lookupEntered = new Promise<void>(resolve => { entered = resolve; });
  const f = fixture([]);
  const adapter = new CodexAdapter(dir, { command: async () => { entered(); await gate; return command; }, launcher: f.launcher, kill: async child => { child.kill(); } });
  try {
    const running = adapter.stream({ ...request, workspace: dir }, () => {}, new AbortController().signal);
    await lookupEntered; await adapter.close(); release();
    await assert.rejects(running, /cancelled/);
    assert.equal(f.launches.length, 0); assert.equal(f.turns(), 0);
    assert.equal((await adapter.stream({ ...request, workspace: dir }, () => {}, new AbortController().signal)).text, 'Finished.');
    assert.equal(f.launches.length, 1); assert.equal(f.turns(), 1);
  } finally { release(); await adapter.close(); await rm(dir, { recursive: true, force: true }); }
});

test('Codex never launches a replacement when owned worker cleanup is uncertain', async t => {
  const stop = OwnedProcess.prototype.stop;
  let stops = 0;
  t.mock.method(OwnedProcess.prototype, 'stop', async function(this: OwnedProcess) {
    if (++stops === 1) throw providerOutcomeUnknown('test owned cleanup uncertainty');
    await stop.call(this);
  });
  await harness([{ at: 'initialize' }], async (adapter, f, dir) => {
    await assert.rejects(adapter.stream({ ...request, workspace: dir }, () => {}, new AbortController().signal), /termination is unknown/);
    assert.equal(f.launches.length, 1); assert.equal(f.turns(), 0);
  });
});
