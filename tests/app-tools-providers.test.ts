import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexAdapter, CODEX_CONFIG, CODEX_DISABLED_FEATURES, assertSafeCodexConfig } from '../server/providers/codex.js';
import { ClaudeAdapter } from '../server/providers/claude.js';
import { CursorAdapter } from '../server/providers/cursor.js';
import { runCursorOperation, CURSOR_CONNECTOR_KEY_NAME, type CursorSdk } from '../server/providers/cursor-worker.js';
import { JsonLines, type Launcher } from '../server/providers/process.js';
import type { ProviderRequest } from '../shared/types.js';
import { HttpError } from '../server/security.js';

const definitions = [{ name: 'relay_create_bot', description: 'Create a Relay bot', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }];
const request: ProviderRequest = { runId: 'apps', conversationId: 'c', model: 'fixture-model', mode: 'chat', instructions: 'Manage Relay when asked.',
  history: [{ role: 'user', content: 'Create a bot.' }], maxSeconds: 5, expectedAccount: { accountLabel: 'a@example.test', plan: 'team' } };
const command = { file: 'fixture', args: [] };
function processFixture() {
  let closed = false;
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 999999,
    exitCode: null as number | null, signalCode: null, kill: () => { end(); return true; } });
  const end = () => { if (!closed) { closed = true; child.exitCode = 0; child.emit('close', 0, null); } };
  return { child: child as unknown as ChildProcessWithoutNullStreams, end, send: (value: unknown) => child.stdout.write(JSON.stringify(value) + '\n') };
}

test('Codex app-only run registers dynamic tools and executes the scoped callback with real result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-app-codex-')); let calls = 0; const replies: any[] = [];
  const launcher: Launcher = (_command, args) => {
    assert.ok(args.includes('features.code_mode_host=true'));
    for (const feature of CODEX_DISABLED_FEATURES.filter(feature => feature !== 'code_mode_host')) assert.ok(args.includes(`features.${feature}=false`), feature);
    const f = processFixture();
    const parser = new JsonLines(message => {
      if (!message.method) { replies.push(message); f.send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed', items: [{ type: 'dynamicToolCall', id: 'tool', namespace: 'relay_app', tool: 'relay_create_bot' }, { type: 'agentMessage', id: 'a', text: 'Created actual.' }] } } }); return; }
      let result: any = {};
      if (message.method === 'initialize') assert.equal(message.params.capabilities.experimentalApi, true);
      if (message.method === 'config/read') result = { config: { ...CODEX_CONFIG, features: Object.fromEntries(CODEX_DISABLED_FEATURES.map(k => [k, k === 'code_mode_host'])), mcp_servers: {} } };
      if (message.method === 'account/read') result = { account: { type: 'chatgpt', email: 'a@example.test', planType: 'team' } };
      if (message.method === 'thread/start') { assert.deepEqual(message.params.dynamicTools, [{ type: 'namespace', name: 'relay_app', description: 'Relay app actions', tools: definitions.map(tool => ({ type: 'function', ...tool })) }]); result = { thread: { id: 'thread' }, model: 'fixture-model', modelProvider: 'openai', sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never' }; }
      if (message.method === 'turn/start') result = { turn: { id: 'turn' } };
      queueMicrotask(() => { if (message.id != null) f.send({ id: message.id, result }); if (message.method === 'turn/start') f.send({ id: 'call', method: 'item/tool/call', params: { threadId: 'thread', turnId: 'turn', callId: 'actual', namespace: 'relay_app', tool: 'relay_create_bot', arguments: {} } }); });
    });
    f.child.stdin.on('data', chunk => parser.push(chunk)); f.child.stdin.on('finish', f.end); return f.child;
  };
  const adapter = new CodexAdapter(root, { command: async () => command, launcher, kill: async child => { child.kill(); } });
  try { const result = await adapter.stream({ ...request, appTools: { definitions, call: async (id, name) => { calls++; assert.equal(id, 'actual'); assert.equal(name, 'relay_create_bot'); return { botId: 'actual' }; } } }, () => {}, new AbortController().signal);
    assert.equal(result.text, 'Created actual.'); assert.equal(calls, 1); assert.deepEqual(replies[0].result, { success: true, contentItems: [{ type: 'inputText', text: '{"botId":"actual"}' }] });
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

test('Codex rejects stale, terminal or foreign dynamic tool calls before any app mutation', async () => {
  for (const bad of [{ turnId: 'old-turn' }, { threadId: 'other-thread' }, { namespace: 'foreign' }, { tool: 'shell' }, { terminal: true }, { terminalError: true }, { terminalMalformed: true }]) {
    const root = await mkdtemp(join(tmpdir(), 'relay-app-codex-scope-')); let calls = 0;
    const launcher: Launcher = () => {
      const f = processFixture(); const parser = new JsonLines(message => {
        if (!message.method) return;
        let result: any = {};
        if (message.method === 'config/read') result = { config: { ...CODEX_CONFIG, features: Object.fromEntries(CODEX_DISABLED_FEATURES.map(k => [k, k === 'code_mode_host'])), mcp_servers: {} } };
        if (message.method === 'account/read') result = { account: { type: 'chatgpt', email: 'a@example.test', planType: 'team' } };
        if (message.method === 'thread/start') result = { thread: { id: 'thread' }, model: 'fixture-model', modelProvider: 'openai', sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never' };
        if (message.method === 'turn/start') result = { turn: { id: 'turn' } };
        queueMicrotask(() => { if (message.id != null) f.send({ id: message.id, result }); if (message.method === 'turn/start') {
          const frames: unknown[] = [];
          if ('terminal' in bad) frames.push({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed', items: [{ id: 'a', type: 'agentMessage', text: 'Done.' }] } } });
          if ('terminalError' in bad) frames.push({ method: 'error', params: { threadId: 'thread', turnId: 'turn', willRetry: false, error: { message: 'Terminal provider failure' } } });
          if ('terminalMalformed' in bad) frames.push({ method: 'item/started', params: { threadId: 'thread', turnId: 'turn', item: { id: 'forbidden', type: 'commandExecution', command: 'forbidden' } } });
          frames.push({ id: 'call', method: 'item/tool/call', params: { threadId: 'thread', turnId: 'turn', callId: 'actual', namespace: 'relay_app', tool: 'relay_create_bot', arguments: {}, ...bad } });
          if ('namespace' in bad) frames.push({ id: 'later', method: 'item/tool/call', params: { threadId: 'thread', turnId: 'turn', callId: 'later-valid', namespace: 'relay_app', tool: 'relay_create_bot', arguments: {} } });
          (f.child.stdout as PassThrough).write(frames.map(frame => JSON.stringify(frame)).join('\n') + '\n');
        } });
      }); f.child.stdin.on('data', value => parser.push(value)); f.child.stdin.on('finish', f.end); return f.child;
    };
    const adapter = new CodexAdapter(root, { command: async () => command, launcher, kill: async child => { child.kill(); } });
    try { const pending = adapter.stream({ ...request, appTools: { definitions, call: async () => { calls++; return {}; } } }, () => {}, new AbortController().signal);
      if (Object.keys(bad).some(key => key.startsWith('terminal'))) await pending.catch(() => {}); else await assert.rejects(pending, /outside|unavailable/); assert.equal(calls, 0); }
    finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
  }
});

function codexToolSequence(sequence: { callId: string; tool: string; arguments: unknown }[], replies: any[], native = false): Launcher {
  return () => {
    const f = processFixture(); let next = 0;
    const sendNext = () => {
      const call = sequence[next++];
      if (call) f.send({ id: 'request-' + next, method: 'item/tool/call', params: { threadId: 'thread', turnId: 'turn', namespace: 'relay_app', ...call } });
      else f.send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed', items: [{ type: 'agentMessage', id: 'final', text: 'Repaired and checked.' }] } } });
    };
    const parser = new JsonLines(message => {
      if (!message.method) { replies.push(message); queueMicrotask(sendNext); return; }
      let result: any = {};
      if (message.method === 'config/read') result = { config: native ? { forced_login_method: 'chatgpt', approval_policy: 'on-request', sandbox_mode: 'workspace-write', sandbox_workspace_write: { network_access: false }, model_provider: 'openai', windows: { sandbox: 'mxc' } } : { ...CODEX_CONFIG, features: Object.fromEntries(CODEX_DISABLED_FEATURES.map(k => [k, k === 'code_mode_host'])), mcp_servers: {} } };
      if (message.method === 'account/read') result = { account: { type: 'chatgpt', email: 'a@example.test', planType: 'team' } };
      if (message.method === 'thread/start') result = { thread: { id: 'thread' }, model: 'fixture-model', modelProvider: 'openai', sandbox: { type: native ? 'workspaceWrite' : 'readOnly', networkAccess: false }, approvalPolicy: native ? 'on-request' : 'never' };
      if (message.method === 'turn/start') result = { turn: { id: 'turn' } };
      queueMicrotask(() => { if (message.id != null) f.send({ id: message.id, result }); if (message.method === 'turn/start') sendNext(); });
    });
    f.child.stdin.on('data', chunk => parser.push(chunk)); f.child.stdin.on('finish', f.end); return f.child;
  };
}

const changeToolDefinitions = ['relay_check_change', 'relay_write_change'].map(name => ({ name, description: name, inputSchema: { type: 'object', properties: {} } }));
test('Codex returns failed checks to the agent so it can repair and recheck in the same turn', async () => {
  for (const native of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), 'relay-app-codex-recover-')), replies: any[] = [], calls: string[] = [];
    const sequence = [
      { callId: 'check-failed', tool: 'relay_check_change', arguments: { changeId: 'draft' } },
      { callId: 'repair', tool: 'relay_write_change', arguments: { changeId: 'draft', content: 'fixed' } },
      { callId: 'check-fixed', tool: 'relay_check_change', arguments: { changeId: 'draft' } },
    ];
    const adapter = new CodexAdapter(root, { command: async () => command, launcher: codexToolSequence(sequence, replies, native), kill: async child => { child.kill(); } });
    try {
      const result = await adapter.stream({ ...request, ...(native ? { mode: 'agent' as const, workspace: root, interact: async () => ({ decision: 'allow' as const }) } : {}), appTools: { definitions: changeToolDefinitions, call: async id => {
        calls.push(id);
        if (id === 'check-failed') throw new Error('Check command exited 2; api_key=fixture-secret; authorization: Bearer fixture-bearer; password=fixture-password; client_secret=fixture-client; ' + 'x'.repeat(1000));
        return { status: id === 'repair' ? 'draft' : 'ready' };
      } } }, () => {}, new AbortController().signal);
      assert.equal(result.text, 'Repaired and checked.'); assert.deepEqual(calls, sequence.map(call => call.callId));
      assert.equal(replies[0].result.success, false); assert.equal(replies[1].result.success, true); assert.equal(replies[2].result.success, true);
      const diagnostic = replies[0].result.contentItems[0].text;
      assert.match(diagnostic, /Check command exited 2/); assert.doesNotMatch(diagnostic, /fixture-(?:secret|bearer|password|client)/); assert.ok(diagnostic.length <= 1000);
      assert.match(diagnostic, /inspect|outcome/i);
    } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
  }
});

test('Codex still rejects changed tool call identities after a recoverable failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-app-codex-replay-')), replies: any[] = [], calls: string[] = [];
  const adapter = new CodexAdapter(root, { command: async () => command, launcher: codexToolSequence([
    { callId: 'same', tool: 'relay_check_change', arguments: { changeId: 'first' } },
    { callId: 'same', tool: 'relay_check_change', arguments: { changeId: 'other' } },
  ], replies), kill: async child => { child.kill(); } });
  try {
    await assert.rejects(adapter.stream({ ...request, appTools: { definitions: changeToolDefinitions, call: async id => { calls.push(id); throw new Error('Check command exited 2'); } } }, () => {}, new AbortController().signal), /replay/i);
    assert.deepEqual(calls, ['same']); assert.equal(replies[0].result.success, false);
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

test('Codex cancellation during an app call remains terminal and suppresses late tool output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-app-codex-cancel-')), controller = new AbortController(), replies: any[] = [];
  let started!: () => void, finish!: (value: unknown) => void;
  const callbackStarted = new Promise<void>(done => { started = done; });
  const adapter = new CodexAdapter(root, { command: async () => command, launcher: codexToolSequence([{ callId: 'check', tool: 'relay_check_change', arguments: {} }], replies), kill: async child => { child.kill(); } });
  try {
    const pending = adapter.stream({ ...request, appTools: { definitions: changeToolDefinitions, call: async () => { started(); return new Promise(done => { finish = done; }); } } }, () => {}, controller.signal);
    await callbackStarted; controller.abort(); await assert.rejects(pending, /cancel/i); finish({ status: 'ready' });
    await new Promise(done => setImmediate(done)); assert.deepEqual(replies, []);
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

test('Codex does not execute an identical failed tool call again or resume expired app authority', async () => {
  for (const expired of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), 'relay-app-codex-failed-identity-')), replies: any[] = []; let calls = 0;
    const call = { callId: 'same', tool: 'relay_check_change', arguments: { changeId: 'draft' } };
    const adapter = new CodexAdapter(root, { command: async () => command, launcher: codexToolSequence([call, call], replies), kill: async child => { child.kill(); } });
    try {
      const pending = adapter.stream({ ...request, appTools: { definitions: changeToolDefinitions, call: async () => { calls++; throw expired ? new HttpError(409, 'Agent tool authority expired') : new Error('Check command exited 2'); } } }, () => {}, new AbortController().signal);
      if (expired) { await assert.rejects(pending, /authority expired/); assert.ok(!replies[0]?.result); }
      else { assert.equal((await pending).text, 'Repaired and checked.'); assert.equal(replies.length, 2); assert.deepEqual(replies[0].result, replies[1].result); }
      assert.equal(calls, 1);
    } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
  }
});

test('Codex callback identity, scope, size and depth guards remain terminal', async () => {
  for (const [status, message] of [
    [409, 'This Agent run is no longer active; app action scope expired'],
    [409, 'Tool call ID reused with different tool or arguments'],
    [409, 'Tool call identity was reused with different arguments or tool'],
    [400, 'Tool input too large'],
    [400, 'Tool input nested too deeply'],
    [400, 'Tool arguments are too deeply nested'],
  ] as const) {
    const root = await mkdtemp(join(tmpdir(), 'relay-app-codex-guard-')), replies: any[] = []; let calls = 0;
    const call = { callId: 'guard', tool: 'relay_check_change', arguments: {} };
    const adapter = new CodexAdapter(root, { command: async () => command, launcher: codexToolSequence([call, call], replies), kill: async child => { child.kill(); } });
    try {
      await assert.rejects(adapter.stream({ ...request, appTools: { definitions: changeToolDefinitions, call: async () => { calls++; throw new HttpError(status, message); } } }, () => {}, new AbortController().signal), error => error instanceof Error && error.message === message);
      assert.equal(calls, 1); assert.ok(!replies[0]?.result);
    } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
  }
});

test('Codex app-only host config permits only typed app runner and rejects native execution feature leaks', () => {
  const config = { ...CODEX_CONFIG, features: Object.fromEntries(CODEX_DISABLED_FEATURES.map(k => [k, k === 'code_mode_host'])), mcp_servers: {} };
  assert.doesNotThrow(() => assertSafeCodexConfig(config, 'chat', true));
  assert.throws(() => assertSafeCodexConfig({ ...config, features: { ...config.features, code_mode_host: false } }, 'chat', true), /app.*host|runner/i);
  for (const feature of CODEX_DISABLED_FEATURES.filter(feature => feature !== 'code_mode_host')) assert.throws(() => assertSafeCodexConfig({ ...config, features: { ...config.features, [feature]: true } }, 'chat', true), /cannot disable/);
  assert.throws(() => assertSafeCodexConfig(config, 'chat'), /code_mode_host/);
});

test('Claude app-only launch exposes only Relay MCP and actual facade executes callback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-app-claude-')); let calls = 0;
  const launcher: Launcher = (_command, args) => {
    const f = processFixture();
    f.child.stdin.on('finish', () => { void (async () => {
      if (args.includes('auth')) { (f.child.stdout as PassThrough).write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'a@example.test', subscriptionType: 'team' })); f.end(); return; }
      assert.equal(args[args.indexOf('--tools') + 1], ''); assert.ok(args.includes('--strict-mcp-config'));
      assert.equal(args.includes('--safe-mode'), false);
      for (const flag of ['--restricted', '--disable-slash-commands', '--no-chrome']) assert.ok(args.includes(flag), flag);
      assert.equal(args[args.indexOf('--setting-sources') + 1], ''); assert.deepEqual(JSON.parse(args[args.indexOf('--settings') + 1]), { disableAllHooks: true });
      assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk'); assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none');
      assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__relay_app__relay_create_bot');
      const config = JSON.parse(args[args.indexOf('--mcp-config') + 1]); assert.deepEqual(Object.keys(config.mcpServers), ['relay_app']);
      const entry = config.mcpServers.relay_app; const mcp = spawn(entry.command, entry.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      const result = await new Promise<any>(done => { const parser = new JsonLines(done); mcp.stdout.on('data', chunk => parser.push(chunk)); mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'relay_create_bot', arguments: {} } }) + '\n'); });
      assert.equal(JSON.parse(result.result.content[0].text).botId, 'actual'); mcp.stdin.end(); await new Promise(done => mcp.once('close', done));
      f.send({ type: 'assistant', message: { model: 'claude-sonnet-fixture', content: [{ type: 'tool_use', name: 'mcp__relay_app__relay_create_bot', input: {} }] } });
      f.send({ type: 'result', subtype: 'success', result: 'Created actual.' }); f.end();
    })().catch(error => { f.child.emit('error', error); f.end(); }); });
    return f.child;
  };
  const adapter = new ClaudeAdapter(root, { command: async () => command, launcher, kill: async child => { child.kill(); } });
  try { const result = await adapter.stream({ ...request, model: 'sonnet', appTools: { definitions, call: async () => { calls++; return { botId: 'actual' }; } } }, () => {}, new AbortController().signal);
    assert.equal(result.text, 'Created actual.'); assert.equal(calls, 1);
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

function cursorFixture(foreign = false, cancelMutation?: 'disabled' | 'failed') {
  let options: any; let observed: unknown;
  const sdk = {
    FileCredentialStore: class { async load() { return { apiKey: 'private', backendUrl: 'https://api2.cursor.sh' }; } }, JsonlLocalAgentStore: class {},
    Cursor: { async me() { return { userId: 1, userEmail: 'a@example.test', apiKeyName: CURSOR_CONNECTOR_KEY_NAME }; }, models: { async list() { return [{ id: 'fixture-model', displayName: 'Fixture' }]; } } },
    Agent: { async create(value: any) { options = value; return { agentId: 'agent', async send() { return { status: cancelMutation ? 'running' : 'finished', async *stream() {
      assert.deepEqual(options.tools, ['mcp']); assert.deepEqual(options.mcpServers, {}); assert.deepEqual(options.local.settingSources, []); assert.deepEqual(Object.keys(options.local.customTools), ['relay_create_bot']);
      if (cancelMutation === 'disabled') { yield { type: 'tool_call', call_id: 'disabled', name: 'shell', args: {} }; return; }
      if (!cancelMutation) observed = await options.local.customTools.relay_create_bot.execute({}, { toolCallId: 'sdk-id' });
      yield { type: 'tool_call', call_id: 'sdk-id', name: 'mcp', args: { providerIdentifier: foreign ? 'foreign' : 'custom-user-tools', toolName: 'relay_create_bot', args: {} } };
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Created actual.' }] } };
    }, async wait() { return { status: cancelMutation === 'failed' ? 'error' : 'finished', result: 'Created actual.', model: { id: 'fixture-model' } }; }, async cancel() { if (cancelMutation) await options.local.customTools.relay_create_bot.execute({}, { toolCallId: 'during-cancel' }).catch(() => {}); } }; }, async [Symbol.asyncDispose]() {} }; } },
  } as unknown as CursorSdk;
  return { sdk, observed: () => observed };
}
test('Cursor app-only custom SDK callback executes Relay and rejects foreign MCP events', async () => {
  let calls = 0; const f = cursorFixture();
  const input = { ...request, expectedAccount: { ...request.expectedAccount, plan: '' }, appTools: { definitions, call: async () => { calls++; return { botId: 'actual' }; } } };
  await runCursorOperation({ operation: 'stream', request: input }, f.sdk, () => {}, new AbortController().signal);
  assert.equal(calls, 1); assert.deepEqual(f.observed(), { botId: 'actual' });
  await assert.rejects(runCursorOperation({ operation: 'stream', request: input }, cursorFixture(true).sdk, () => {}, new AbortController().signal), /disallowed|non-Relay/);
});

test('Cursor SDK cancellation cannot invoke app callbacks after disabled tools or terminal failure', async () => {
  for (const failure of ['disabled', 'failed'] as const) {
    let calls = 0;
    await assert.rejects(runCursorOperation({ operation: 'stream', request: { ...request, expectedAccount: { ...request.expectedAccount, plan: '' },
      appTools: { definitions, call: async () => { calls++; return {}; } } } }, cursorFixture(false, failure).sdk, () => {}, new AbortController().signal));
    assert.equal(calls, 0, failure);
  }
});

test('Cursor parent IPC keeps callback private and deduplicates repeated SDK calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-app-cursor-ipc-')); let calls = 0; const replies: any[] = [];
  const launcher: Launcher = () => {
    const f = processFixture(); let input = ''; let completed = false;
    Object.assign(f.child, { connected: true, send: (message: any, done: () => void) => {
      replies.push(message); done?.();
      if (!completed && message.type === 'app-tool-result') { completed = true; assert.equal(message.value.botId, 'actual'); f.send({ type: 'result', text: 'Created actual.' }); f.end(); }
    } });
    f.child.stdin.on('data', value => { input += value; });
    f.child.stdin.on('finish', () => {
      const operation = JSON.parse(input); assert.deepEqual(operation.request.appTools, { definitions });
      assert.equal(operation.request.appTools.call, undefined);
      f.send({ type: 'app-tool-call', callId: 'same', name: 'relay_create_bot', args: {} });
      f.send({ type: 'app-tool-call', callId: 'same', name: 'relay_create_bot', args: {} });
    }); return f.child;
  };
  const adapter = new CursorAdapter(root, { command, launcher, kill: async child => { child.kill(); } });
  try {
    const result = await adapter.stream({ ...request, appTools: { definitions, call: async () => { calls++; return { botId: 'actual' }; } } }, () => {}, new AbortController().signal);
    assert.equal(result.text, 'Created actual.'); assert.equal(calls, 1); assert.ok(replies.length >= 1);
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

test('Cursor cancellation revokes parent app-tool reply before a delayed callback returns', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-app-cursor-cancel-')); const controller = new AbortController();
  let finish!: (value: unknown) => void; let started!: () => void; const callbackStarted = new Promise<void>(done => { started = done; }); const replies: any[] = [];
  const launcher: Launcher = () => {
    const f = processFixture(); Object.assign(f.child, { connected: true, send: (message: any, done: () => void) => { replies.push(message); done?.(); } });
    f.child.stdin.on('finish', () => f.send({ type: 'app-tool-call', callId: 'pending', name: 'relay_create_bot', args: {} })); return f.child;
  };
  const adapter = new CursorAdapter(root, { command, launcher, kill: async child => { child.kill(); } });
  try {
    const pending = adapter.stream({ ...request, appTools: { definitions, call: async () => { started(); return new Promise(done => { finish = done; }); } } }, () => {}, controller.signal);
    await callbackStarted; controller.abort(); await assert.rejects(pending, /cancel/i); finish({ botId: 'late' });
    await new Promise(done => setImmediate(done)); assert.deepEqual(replies, []);
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

test('Cursor terminal result revokes app mutations in the same stdout batch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-app-cursor-terminal-')); let calls = 0;
  const launcher: Launcher = () => {
    const f = processFixture(); Object.assign(f.child, { connected: true, send: (_value: unknown, done: () => void) => done?.() });
    f.child.stdin.on('finish', () => { f.send({ type: 'result', text: 'Done.' }); f.send({ type: 'app-tool-call', callId: 'late', name: 'relay_create_bot', args: {} }); f.end(); }); return f.child;
  };
  const adapter = new CursorAdapter(root, { command, launcher, kill: async child => { child.kill(); } });
  try { await adapter.stream({ ...request, appTools: { definitions, call: async () => { calls++; return {}; } } }, () => {}, new AbortController().signal).catch(() => {}); assert.equal(calls, 0); }
  finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

test('Cursor queued app callback is revoked by a following fatal frame in the same stdout batch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-app-cursor-fatal-')); let calls = 0;
  const launcher: Launcher = () => {
    const f = processFixture(); Object.assign(f.child, { connected: true, send: (_value: unknown, done: () => void) => done?.() });
    f.child.stdin.on('finish', () => {
      (f.child.stdout as PassThrough).write([{ type: 'app-tool-call', callId: 'queued', name: 'relay_create_bot', args: {} }, { type: 'error', error: 'fatal result' }].map(value => JSON.stringify(value)).join('\n') + '\n'); f.end();
    }); return f.child;
  };
  const adapter = new CursorAdapter(root, { command, launcher, kill: async child => { child.kill(); } });
  try { await assert.rejects(adapter.stream({ ...request, appTools: { definitions, call: async () => { calls++; return {}; } } }, () => {}, new AbortController().signal), /fatal result/); assert.equal(calls, 0); }
  finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

test('Claude terminal output revokes its private MCP callback before process teardown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-app-claude-terminal-')); let calls = 0;
  const launcher: Launcher = (_command, args) => {
    const f = processFixture(); f.child.stdin.on('finish', () => { void (async () => {
      if (args.includes('auth')) { (f.child.stdout as PassThrough).write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'a@example.test', subscriptionType: 'team' })); f.end(); return; }
      const entry = JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers.relay_app;
      f.send({ type: 'assistant', message: { model: 'claude-sonnet-fixture', content: [] } }); f.send({ type: 'result', subtype: 'success', result: 'Done.' });
      const mcp = spawn(entry.command, entry.args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); const closed = new Promise(done => mcp.once('close', done));
      await new Promise<void>(done => { mcp.stdout.once('data', () => done()); mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'relay_create_bot', arguments: {} } }) + '\n'); });
      mcp.stdin.end(); await closed; f.end();
    })().catch(error => { f.child.emit('error', error); f.end(); }); }); return f.child;
  };
  const adapter = new ClaudeAdapter(root, { command: async () => command, launcher, kill: async child => { child.kill(); } });
  try { await adapter.stream({ ...request, model: 'sonnet', appTools: { definitions, call: async () => { calls++; return {}; } } }, () => {}, new AbortController().signal); assert.equal(calls, 0); }
  finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

test('serialized worker app-tool requests fail clearly without a process-local callback', async () => {
  const wire = JSON.parse(JSON.stringify({ ...request, appTools: { definitions, call: async () => ({}) } }));
  wire.expectedAccount.plan = '';
  await assert.rejects(runCursorOperation({ operation: 'stream', request: wire }, cursorFixture().sdk, () => {}, new AbortController().signal), /process-local host callback/);
});
