import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAdapter, CODEX_AGENT_CONFIG, CODEX_AGENT_ARGS } from '../server/providers/codex.js';
import { ClaudeAdapter, CLAUDE_AGENT_ARGS, CLAUDE_AGENT_SETTINGS } from '../server/providers/claude.js';
import { JsonLines, type Launcher } from '../server/providers/process.js';
import type { InteractionAnswer, InteractionPrompt, ProviderRequest } from '../shared/types.js';

const command = { file: 'fake-native-provider.exe', args: [] };
const baseRequest: ProviderRequest = { runId: 'native', conversationId: 'c', model: 'gpt-test', mode: 'agent', instructions: 'Bot instructions.',
  history: [{ role: 'user', content: 'Complete this request.' }], maxSeconds: 3,
  expectedAccount: { accountLabel: 'approved@example.test', plan: 'team' } };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fakeProcess() {
  let ended = false;
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
    pid: 765432, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, kill: () => { end(); return true; } });
  function end() { if (!ended) { ended = true; child.exitCode = 0; child.emit('close', 0, null); } }
  return { child: child as unknown as ChildProcessWithoutNullStreams, end, send: (value: unknown) => child.stdout.write(`${JSON.stringify(value)}\n`) };
}
type NativeRequest = { method: string; params?: Record<string, unknown>; cancel?: boolean;
  items?: { threadId?: string; turnId?: string; method?: string; item: Record<string, unknown> }[] };
function codexNativeFixture(requests: NativeRequest[], overrides: { config?: Record<string, unknown>; auth?: string; modelProvider?: string } = {}) {
  const writes: any[] = []; const replies: any[] = [];
  let turns = 0; let index = 0; let active: ReturnType<typeof fakeProcess>;
  const launcher: Launcher = (_command, args, cwd, env) => {
    assert.deepEqual(args, CODEX_AGENT_ARGS);
    assert.ok(env.CODEX_HOME?.endsWith('openai')); assert.equal(env.OPENAI_API_KEY, undefined);
    active = fakeProcess();
    function next() {
      const request = requests[index++];
      if (request) {
        const id = `host-${index}`;
        for (const item of request.items ?? []) active.send({ method: item.method ?? 'item/started', params: { threadId: item.threadId ?? 'thread', turnId: item.turnId ?? 'turn', item: item.item } });
        active.send({ id, method: request.method, params: { threadId: 'thread', turnId: 'turn', itemId: 'item', ...request.params } });
        if (request.cancel) setImmediate(() => { active.send({ method: 'serverRequest/resolved', params: { threadId: 'thread', requestId: id } }); next(); });
      }
      else {
        active.send({ method: 'item/started', params: { threadId: 'thread', turnId: 'turn', item: { type: 'mcpToolCall', id: 'mcp', server: 'configured', tool: 'lookup' } } });
        active.send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', text: 'Finished.' }] } } });
      }
    }
    const parser = new JsonLines(message => {
      writes.push(message);
      if (!message.method && message.id != null) { replies.push(message); if (!message.error) queueMicrotask(next); return; }
      queueMicrotask(() => {
        let result: any = {};
        if (message.method === 'config/read') result = { config: { forced_login_method: 'chatgpt', model_provider: 'openai', chatgpt_base_url: 'https://chatgpt.com/backend-api/', approval_policy: 'on-request', sandbox_mode: 'workspace-write',
          sandbox_workspace_write: { network_access: false }, windows: { sandbox: 'mxc' }, features: { shell_tool: true }, mcp_servers: { configured: {} }, ...overrides.config } };
        if (message.method === 'account/read') result = { account: { type: overrides.auth ?? 'chatgpt', email: baseRequest.expectedAccount.accountLabel, planType: baseRequest.expectedAccount.plan } };
        if (message.method === 'thread/start') {
          assert.equal(message.params.baseInstructions, undefined); assert.equal(message.params.developerInstructions, 'Bot instructions.');
          assert.equal(message.params.approvalPolicy, 'on-request');
          result = { thread: { id: 'thread' }, model: 'gpt-test', modelProvider: overrides.modelProvider ?? 'openai', sandbox: { type: 'workspaceWrite', networkAccess: false }, approvalPolicy: 'on-request' };
        }
        if (message.method === 'turn/start') {
          turns++; assert.deepEqual(message.params.sandboxPolicy, { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false });
          assert.equal(message.params.approvalPolicy, 'on-request'); result = { turn: { id: 'turn' } };
        }
        if (message.id != null) active.send({ id: message.id, result });
        if (message.method === 'turn/start') next();
      });
    });
    active.child.stdin.on('data', value => parser.push(value)); active.child.stdin.on('finish', active.end);
    return active.child;
  };
  return { launcher, writes, replies, turns: () => turns };
}
async function runCodex(requests: NativeRequest[], interact: NonNullable<ProviderRequest['interact']>,
  overrides?: Parameters<typeof codexNativeFixture>[1], signal = new AbortController().signal) {
  const dir = await mkdtemp(join(tmpdir(), 'relay-native-codex-'));
  const fixture = codexNativeFixture(requests, overrides);
  const adapter = new CodexAdapter(dir, { command: async () => command, launcher: fixture.launcher, kill: async child => { child.kill(); } });
  const events: any[] = [];
  try { return { result: await adapter.stream({ ...baseRequest, workspace: dir, interact }, event => events.push(event), signal), fixture, events }; }
  finally { await adapter.close(); await rm(dir, { recursive: true, force: true }); }
}

test('native Codex restores native defaults and scopes command/file approvals to one action', async () => {
  assert.equal(CODEX_AGENT_CONFIG.approval_policy, 'on-request'); assert.ok(!Object.keys(CODEX_AGENT_CONFIG).some(k => k.startsWith('features.')));
  assert.equal(CODEX_AGENT_CONFIG.project_doc_max_bytes, undefined); assert.equal(CODEX_AGENT_CONFIG.mcp_servers, undefined);
  if (process.platform === 'win32') {
    assert.equal(CODEX_AGENT_CONFIG['windows.sandbox'], 'mxc');
    assert.ok(CODEX_AGENT_ARGS.includes('windows.sandbox="mxc"'));
    assert.ok(!CODEX_AGENT_ARGS.some(value => /elevated|danger-full-access|dangerFullAccess/.test(value)));
  } else assert.equal(CODEX_AGENT_CONFIG['windows.sandbox'], undefined);
  for (const decision of ['allow', 'deny'] as const) {
    const prompts: InteractionPrompt[] = [];
    const { result, fixture, events } = await runCodex([
      { method: 'item/commandExecution/requestApproval', params: { command: 'echo native', reason: 'Run the command', proposedExecpolicyAmendment: ['echo'] } },
      { method: 'item/fileChange/requestApproval', params: { grantRoot: 'requested-root' } },
    ], async prompt => { prompts.push(prompt); return { decision }; });
    assert.equal(result.text, 'Finished.'); assert.equal(prompts.length, 2);
    assert.deepEqual(fixture.replies.map(r => r.result), [{ decision: decision === 'allow' ? 'accept' : 'decline' }, { decision: decision === 'allow' ? 'accept' : 'decline' }]);
    assert.ok(events.some(e => e.type === 'tool' && e.name === 'configured/lookup'));
  }
});

test('native Codex requires MXC on Windows and never falls back to another backend', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-native-codex-backend-'));
  try {
    for (const windows of [undefined, {}, { sandbox: 'elevated' }, { sandbox: 'unelevated' }, { sandbox: 'disabled' }, { sandbox: 'dangerFullAccess' }]) {
      const fixture = codexNativeFixture([], { config: { windows } });
      let launches = 0;
      const adapter = new CodexAdapter(dir, { command: async () => command,
        launcher: (...args) => { launches++; return fixture.launcher(...args); }, kill: async child => { child.kill(); } });
      try {
        await assert.rejects(adapter.stream({ ...baseRequest, workspace: dir, interact: async () => { throw new Error('No approval should be requested'); } }, () => {}, new AbortController().signal),
          /Windows MXC sandbox backend.*0\.162\.0\+.*no turn started/);
        assert.equal(fixture.turns(), 0);
        assert.equal(fixture.writes.some(message => message.method === 'thread/start'), false);
        assert.equal(launches, 1);
      } finally { await adapter.close(); }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('native Codex grants only the displayed requested permissions for the active turn', async () => {
  const permissions = { network: { enabled: true }, fileSystem: { read: ['read-root'], write: ['write-root'] } };
  for (const decision of ['allow', 'deny'] as const) {
    const { fixture } = await runCodex([{ method: 'item/permissions/requestApproval', params: { permissions } }], async prompt => {
      assert.deepEqual(JSON.parse(prompt.details!).permissions, permissions);
      return { decision, answers: { injected: ['extra-permissions'] } };
    });
    assert.deepEqual(fixture.replies[0].result, { permissions: decision === 'allow' ? permissions : {}, scope: 'turn' });
  }
  const unsupported = await runCodex([{ method: 'item/permissions/requestApproval', params: { permissions: { all: true } } }], async () => { throw new Error('Must not ask about an unrecognized grant'); });
  assert.deepEqual(unsupported.fixture.replies[0].result, { permissions: {}, scope: 'turn' });
  assert.ok(unsupported.events.some(e => e.type === 'status' && /unsupported/.test(e.message)));
});

test('native Codex file approvals display scoped paths, change kinds and patches with bounded explicit fallback', async () => {
  const change = { path: 'src/feature.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-old\n+new\n' };
  const foreign = { path: 'foreign/private.ts', kind: { type: 'delete' }, diff: 'must never enter this approval' };
  for (const method of ['item/started', 'item/completed']) {
    await runCodex([{ method: 'item/fileChange/requestApproval', params: { grantRoot: 'approved-root', reason: 'Apply this patch' }, items: [
      { method, item: { id: 'item', type: 'fileChange', changes: [change] } },
      { threadId: 'foreign-thread', item: { id: 'item', type: 'fileChange', changes: [foreign] } },
      { turnId: 'foreign-turn', item: { id: 'item', type: 'fileChange', changes: [foreign] } },
    ] }], async prompt => {
      const details = JSON.parse(prompt.details!);
      assert.deepEqual(details, { itemId: 'item', grantRoot: 'approved-root', reason: 'Apply this patch', fileChanges: [change] });
      assert.doesNotMatch(prompt.details!, /foreign|must never/); return { decision: 'deny' };
    });
  }
  await runCodex([{ method: 'item/fileChange/requestApproval', items: [{ threadId: 'foreign', item: { id: 'item', type: 'fileChange', changes: [foreign] } }] }], async prompt => {
    assert.match(prompt.details!, /Patch details unavailable from runtime/); assert.doesNotMatch(prompt.details!, /foreign/); return { decision: 'deny' };
  });
  await runCodex([{ method: 'item/fileChange/requestApproval', items: [{ item: { id: 'item', type: 'fileChange', changes: [{ ...change, diff: 'x'.repeat(20_000) }] } }] }], async prompt => {
    assert.ok(prompt.details!.length < 16_000); assert.match(prompt.details!, /Patch details truncated/); assert.match(prompt.details!, /src\/feature\.ts/); return { decision: 'deny' };
  });
});

test('native Codex returns exact question ids and accepts supported MCP forms', async () => {
  const { fixture } = await runCodex([
    { method: 'item/tool/requestUserInput', params: { questions: [{ id: 'choice', question: 'Which option?', options: [{ label: 'A' }, { label: 'B' }] }] } },
    { method: 'mcpServer/elicitation/request', params: { mode: 'form', serverName: 'configured', message: 'Supply values', requestedSchema: { type: 'object', properties: { label: { type: 'string' }, okay: { type: 'boolean' } }, required: ['label'] } } },
  ], async prompt => {
    const answers: Record<string, string[]> = prompt.questions?.[0].id === 'choice' ? { choice: ['A'] } : { label: ['answer'], okay: ['true'] };
    return { decision: 'allow', answers };
  });
  assert.deepEqual(fixture.replies.map(r => r.result), [{ answers: { choice: { answers: ['A'] } } }, { action: 'accept', content: { label: 'answer', okay: true } }]);
});

test('native Codex declines unsupported MCP interactions visibly and never opens their URL', async () => {
  const { fixture, events } = await runCodex([{ method: 'mcpServer/elicitation/request', params: { mode: 'url', url: 'https://untrusted.test', serverName: 'configured' } }], async () => { throw new Error('Unsupported requests must be declined'); });
  assert.deepEqual(fixture.replies[0].result, { action: 'decline', content: null }); assert.ok(events.some(e => e.type === 'status'));
});

test('native Codex fails closed on foreign scope, dynamic host tools, malformed answers and custom billing routes', async () => {
  for (const request of [
    { method: 'item/commandExecution/requestApproval', params: { threadId: 'foreign' } },
    { method: 'item/commandExecution/requestApproval', params: { turnId: 'foreign' } },
    { method: 'mcpServer/elicitation/request', params: { turnId: null } },
    { method: 'item/tool/call' }, { method: 'new/unknown' },
  ]) await assert.rejects(runCodex([request], async () => { throw new Error('Must not approve'); }), /outside the active|unsupported host/);
  await assert.rejects(runCodex([{ method: 'item/commandExecution/requestApproval' }], async () => ({ decision: 'yes' } as unknown as InteractionAnswer)), /invalid approval/);
  await assert.rejects(runCodex([{ method: 'item/tool/requestUserInput', params: { questions: [{ id: 'real', question: 'Question?' }] } }], async () => ({ decision: 'allow', answers: { wrong: ['value'] } })), /invalid question/);
  for (const config of [{ model_provider: 'other' }, { model_providers: { openai: { base_url: 'https://metered.test' } } }, { chatgpt_base_url: 'https://other.test' }, { approval_policy: 'never' }])
    await assert.rejects(runCodex([], async () => ({ decision: 'allow' }), { config }), /subscription|built-in OpenAI/);
  await assert.rejects(runCodex([], async () => ({ decision: 'allow' }), { auth: 'apiKey' }), /subscription authentication/);
});

test('native Codex cancellation never writes a delayed approval response after process closure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-native-cancel-'));
  const fixture = codexNativeFixture([{ method: 'item/commandExecution/requestApproval' }]);
  const adapter = new CodexAdapter(dir, { command: async () => command, launcher: fixture.launcher, kill: async child => { child.kill(); } });
  const controller = new AbortController(); let answer!: (value: InteractionAnswer) => void; let prompted!: () => void;
  const pending = new Promise<void>(resolve => { prompted = resolve; });
  try {
    const running = adapter.stream({ ...baseRequest, workspace: dir, interact: async () => { prompted(); return new Promise(resolve => { answer = resolve; }); } }, () => {}, controller.signal);
    await pending; controller.abort(); await assert.rejects(running, /cancelled/);
    const before = fixture.writes.length; answer({ decision: 'allow' }); await tick();
    assert.equal(fixture.writes.length, before); assert.equal(fixture.replies.length, 0);
  } finally { await adapter.close(); await rm(dir, { recursive: true, force: true }); }
});

test('native Codex expires a resolved request without aborting the provider turn or replying late', async () => {
  let aborted = false;
  const { result, fixture } = await runCodex([{ method: 'item/commandExecution/requestApproval', cancel: true }], async (_prompt, signal) => {
    assert.ok(signal); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('Request resolved')); }, { once: true }));
  });
  assert.equal(aborted, true); assert.equal(result.text, 'Finished.'); assert.equal(fixture.replies.length, 0);
});

function claudeNativeFixture(requests: any[] = [], overrides: { auth?: Record<string, unknown>; account?: Record<string, unknown>; mode?: string; settings?: Record<string, unknown>; delegated?: boolean } = {}) {
  const writes: any[] = []; const replies: any[] = []; let prompts = 0; let launches = 0; let index = 0;
  const launcher: Launcher = (_command, args, _cwd, env) => {
    launches++; const fake = fakeProcess();
    assert.deepEqual(args.slice(0, CLAUDE_AGENT_ARGS.length), CLAUDE_AGENT_ARGS);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    if (args.includes('status')) {
      fake.child.stdin.on('finish', () => {
        (fake.child.stdout as PassThrough).write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty',
          email: baseRequest.expectedAccount.accountLabel, subscriptionType: baseRequest.expectedAccount.plan, ...overrides.auth }, null, 2)); fake.end();
      });
      return fake.child;
    }
    assert.equal(env.CLAUDE_CODE_SDK_READS_SESSION_STATE, '1');
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'manual');
    assert.equal(args[args.indexOf('--permission-prompts') + 1], 'host');
    assert.equal(args[args.indexOf('--append-system-prompt') + 1], baseRequest.instructions);
    assert.equal(args.includes('--system-prompt'), false); assert.equal(args.includes('--allowedTools'), false);
    assert.equal(args.includes('--safe-mode'), false); assert.equal(args.includes('--disable-slash-commands'), false);
    const complete = (text: string) => fake.send({ type: 'result', subtype: 'success', result: text, modelUsage: { 'claude-sonnet-4-6': {} } });
    const next = () => {
      const request = requests[index++];
      if (request) {
        const request_id = `permission-${index}`;
        fake.send({ type: 'control_request', request_id, request });
        if (request.relayCancel) setImmediate(() => { fake.send({ type: 'control_cancel_request', request_id }); next(); });
      }
      else if (overrides.delegated) {
        fake.send({ type: 'system', subtype: 'task_started', task_id: 'agent', task_type: 'local_agent' });
        fake.send({ type: 'system', subtype: 'session_state_changed', state: 'running' });
        complete('First turn.');
        fake.send({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
        setImmediate(() => {
          assert.equal(fake.child.stdin.writableEnded, false);
          fake.send({ type: 'system', subtype: 'task_notification', task_id: 'agent' });
          fake.send({ type: 'system', subtype: 'session_state_changed', state: 'running' });
          fake.send({ type: 'assistant', message: { model: 'claude-sonnet-4-6', content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'native-skill' } }] } });
          complete('Delegated work finished.'); fake.send({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
        });
      } else { complete('Native Claude finished.'); fake.send({ type: 'system', subtype: 'session_state_changed', state: 'idle' }); }
    };
    const parser = new JsonLines(message => {
      writes.push(message);
      if (message.type === 'control_request') {
        const subtype = message.request?.subtype;
        queueMicrotask(() => fake.send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id,
          response: subtype === 'initialize' ? { current_permission_mode: overrides.mode ?? 'default', account: { email: baseRequest.expectedAccount.accountLabel, subscriptionType: 'Claude Team', apiProvider: 'firstParty', ...overrides.account } }
            : subtype === 'get_settings' ? { effective: { ...CLAUDE_AGENT_SETTINGS, ...overrides.settings } } : {} } }));
      } else if (message.type === 'user') {
        prompts++; assert.ok(message.message.content.some((part:any)=>part.type==='text'&&part.text.includes('Complete this request.'))); queueMicrotask(next);
      } else if (message.type === 'control_response') {
        replies.push(message); if (message.response.subtype === 'success') queueMicrotask(next);
      }
    });
    fake.child.stdin.on('data', value => parser.push(value)); fake.child.stdin.on('finish', fake.end);
    return fake.child;
  };
  return { launcher, writes, replies, prompts: () => prompts, launches: () => launches };
}
async function runClaude(requests: any[], interact: NonNullable<ProviderRequest['interact']>, overrides?: Parameters<typeof claudeNativeFixture>[1]) {
  const dir = await mkdtemp(join(tmpdir(), 'relay-native-claude-')); const fixture = claudeNativeFixture(requests, overrides);
  const adapter = new ClaudeAdapter(dir, { command: async () => command, launcher: fixture.launcher, kill: async child => { child.kill(); } });
  const events: any[] = [];
  try { return { result: await adapter.stream({ ...baseRequest, model: 'sonnet', workspace: dir, interact }, event => events.push(event), new AbortController().signal), fixture, events }; }
  finally { await adapter.close(); await rm(dir, { recursive: true, force: true }); }
}

test('native Claude launches the official CLI with native prompt/tools and bridges allow/deny without permission amendments', async () => {
  for (const decision of ['allow', 'deny'] as const) {
    const input = { command: 'echo native', description: 'A native command' };
    const { result, fixture } = await runClaude([{ subtype: 'can_use_tool', tool_name: 'Bash', input, permission_suggestions: [{ type: 'setMode', mode: 'bypassPermissions' }] }], async prompt => {
      assert.equal(prompt.kind, 'approval'); assert.deepEqual(JSON.parse(prompt.details!), input); return { decision };
    });
    assert.equal(result.text, 'Native Claude finished.'); assert.equal(fixture.prompts(), 1); assert.equal(fixture.launches(), 2);
    assert.deepEqual(fixture.replies[0].response.response, decision === 'allow' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'The user declined this request.' });
  }
});

test('native Claude AskUserQuestion returns answers under exact question text and preserves multiple selections', async () => {
  const questions = [{ question: 'Which features?', header: 'Features', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] },
    { question: 'Which style?', header: 'Style', multiSelect: false, options: [{ label: 'Compact' }, { label: 'Large' }] }];
  const { fixture } = await runClaude([{ subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions } }], async prompt => {
    assert.equal(prompt.kind, 'question'); assert.deepEqual(prompt.questions?.map(q => q.id), ['claude-q-0', 'claude-q-1']);
    return { decision: 'allow', answers: { 'claude-q-0': ['A', 'B'], 'claude-q-1': ['Compact'] } };
  });
  assert.deepEqual(fixture.replies[0].response.response, { behavior: 'allow', updatedInput: { questions, answers: { 'Which features?': ['A', 'B'], 'Which style?': 'Compact' } } });
});

test('native Claude uses short host ids for long or reserved question text and restores original CLI answer keys', async () => {
  const text = 'Detailed question '.repeat(20) + '?';
  const questions = [text, 'constructor'].map(question => ({ question, header: 'Question', options: [{ label: 'A' }, { label: 'B' }] }));
  const { fixture } = await runClaude([{ subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions } }], async prompt => {
    assert.ok(prompt.questions!.every(q => q.id.length < 100));
    return { decision: 'allow', answers: Object.fromEntries(prompt.questions!.map(q => [q.id, ['A']])) };
  });
  assert.deepEqual(fixture.replies[0].response.response.updatedInput.answers, Object.fromEntries([[text, 'A'], ['constructor', 'A']]));
});

test('native Claude expires cancelled tool requests, keeps the run alive and never answers the cancelled request', async () => {
  let aborted = false;
  const { result, fixture } = await runClaude([{ subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo pending' }, relayCancel: true }], async (_prompt, signal) => {
    assert.ok(signal); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('CLI cancelled')); }, { once: true }));
  });
  assert.equal(aborted, true); assert.equal(result.text, 'Native Claude finished.'); assert.equal(fixture.replies.length, 0);
});

test('native Claude waits for delegated tasks and native idle before closing its input', async () => {
  const { result, events } = await runClaude([], async () => ({ decision: 'deny' }), { delegated: true });
  assert.equal(result.text, 'Delegated work finished.'); assert.ok(events.some(e => e.type === 'tool' && e.name === 'Skill'));
});

test('native Claude rejects effective credential/provider overrides and changed native account before sending a prompt', async () => {
  const cases: Parameters<typeof claudeNativeFixture>[1][] = [
    { auth: { authMethod: 'api_key' } }, { auth: { email: 'changed@example.test' } }, { mode: 'bypassPermissions' },
    { account: { apiProvider: 'bedrock' } }, { account: { email: 'changed@example.test' } }, { account: { subscriptionType: 'Claude Pro' } },
    { settings: { apiKeyHelper: 'bill-me' } }, { settings: { env: { ...CLAUDE_AGENT_SETTINGS.env, ANTHROPIC_API_KEY: 'key' } } },
    { settings: { env: { ...CLAUDE_AGENT_SETTINGS.env, ANTHROPIC_BEDROCK_BASE_URL: 'https://other.test' } } },
  ];
  for (const value of cases) {
    const dir = await mkdtemp(join(tmpdir(), 'relay-claude-guard-')); const fixture = claudeNativeFixture([], value);
    const adapter = new ClaudeAdapter(dir, { command: async () => command, launcher: fixture.launcher, kill: async child => { child.kill(); } });
    try {
      await assert.rejects(adapter.stream({ ...baseRequest, model: 'sonnet', workspace: dir, interact: async () => ({ decision: 'deny' }) }, () => {}, new AbortController().signal), /subscription|account or plan|configuration|manual permissions|credential/);
      assert.equal(fixture.prompts(), 0);
    } finally { await adapter.close(); await rm(dir, { recursive: true, force: true }); }
  }
});

test('native Claude fails closed on unsupported host actions and malformed approval/question replies', async () => {
  await assert.rejects(runClaude([{ subtype: 'hook_callback', input: {} }], async () => { throw new Error('Must not ask'); }), /unsupported host action/);
  await assert.rejects(runClaude([{ subtype: 'can_use_tool', tool_name: 'Bash', input: {} }], async () => ({ decision: 'yes' } as unknown as InteractionAnswer)), /invalid Claude approval/);
  await assert.rejects(runClaude([{ subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Real?', options: [] }] } }], async () => ({ decision: 'allow', answers: { Wrong: ['value'] } })), /invalid Claude question/);
});
