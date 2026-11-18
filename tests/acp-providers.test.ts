import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ProviderRequest } from '../shared/types.js';
import { AcpClient, acpEnvironment } from '../server/providers/acp.js';
import { GeminiAdapter, geminiIdentity } from '../server/providers/gemini.js';
import { GrokAdapter, grokIdentity } from '../server/providers/grok.js';
import type { Launcher } from '../server/providers/process.js';

const command = { file: 'fixture-native', args: [] };
const request: ProviderRequest = { runId: 'r', conversationId: 'c', model: 'gemini-fixture', mode: 'chat',
  instructions: 'Only this private mission 私密', history: [{ role: 'user', content: 'hello' }], maxSeconds: 2,
  expectedAccount: { accountLabel: 'fixture@example.test', plan: '' } };
async function profile(dir: string) {
  const base = join(dir, 'gemini', 'home', '.gemini'); await mkdir(base, { recursive: true });
  await writeFile(join(base, 'google_accounts.json'), JSON.stringify({ active: 'fixture@example.test', old: [] }));
  await writeFile(join(base, 'oauth_creds.json'), JSON.stringify({ refresh_token: 'fixture-private-refresh' }));
}
async function requestFor(dir: string): Promise<ProviderRequest> { return { ...request, expectedAccount: (await geminiIdentity(join(dir, 'gemini', 'home')))! }; }
function fixture(options: { wrongModel?: boolean; failAuth?: boolean; tool?: boolean; earlyEof?: boolean; grok?: boolean; grokApi?: boolean; grokGated?: boolean; flashLite?: boolean; nativeApproval?: boolean; wrongApprovalSession?: boolean;
  stayOpen?: boolean; phase?: (phase: string, env: NodeJS.ProcessEnv) => Promise<void> } = {}) {
  const methods: string[] = [], sent: any[] = [], environments: NodeJS.ProcessEnv[] = [], launches: { cwd: string; args: string[] }[] = [];
  const launcher: Launcher = (_command, args, cwd, env) => {
    environments.push(env); launches.push({ cwd, args });
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
    const close = () => { if (child.exitCode !== null) return; Object.assign(child, { exitCode: 0 }); (child.stdout as PassThrough).end(); (child.stderr as PassThrough).end(); child.emit('close', 0, null); };
    child.kill = (() => { close(); return true; }) as typeof child.kill;
    const reply = (value: unknown) => (child.stdout as PassThrough).write(JSON.stringify(value) + '\n');
    let buffer = '', nativeAnswer: ((value: any) => void) | undefined;
    child.stdin.on('data', chunk => {
      buffer += chunk; let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const value = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); sent.push(value);
        if (!value.method) { nativeAnswer?.(value); nativeAnswer = undefined; continue; }
        methods.push(value.method);
        queueMicrotask(async () => {
          if (value.method === 'initialize') { reply({ jsonrpc: '2.0', id: value.id, result: { protocolVersion: 1,
            ...(options.grok ? { _meta: { grokShell: true, agentVersion: '1.0.67', defaultAuthMethodId: 'cached_token' }, authMethods: [{ id: 'cached_token' }, { id: 'grok.com' }] }
              : { agentInfo: { name: 'gemini-cli', version: '0.62.0' }, authMethods: [{ id: 'oauth-personal' }] }) } }); }
          else if (value.method === '_x.ai/auth/info') reply({ jsonrpc: '2.0', id: value.id, result: { methodId: options.grokApi ? 'xai.api_key' : 'cached_token', email: 'grokfixture@example.test', userBlockedReason: null, teamBlockedReasons: [] } });
          else if (value.method === '_x.ai/auth/check_subscription') reply({ jsonrpc: '2.0', id: value.id, result: { authenticated: true, meta: { auth_mode: 'Oidc', subscription_tier: 'Free', gate: options.grokGated ? { message: 'Requires access' } : null } } });
          else if (value.method === 'authenticate') reply({ jsonrpc: '2.0', id: value.id,
            ...(options.failAuth ? { error: { code: -32000, message: 'native auth failed' } } : { result: {} }) });
          else if (value.method === 'session/new') { env.RELAY_TEST_MCP_BOOTSTRAP = value.params.mcpServers[0]?.args.at(-1); await options.phase?.('before-prompt', env); reply({ jsonrpc: '2.0', id: value.id, result: { sessionId: 's', _meta: { currentWorkingDirectory: value.params.cwd },
            models: { currentModelId: options.wrongModel ? 'different' : 'gemini-fixture', availableModels: [{ modelId: 'auto', name: 'Auto' }, { modelId: 'gemini-fixture', name: 'Native fixture' }, ...(options.flashLite ? [{ modelId: 'gemini-3.1-flash-lite', name: 'Flash Lite' }] : [])] } } }); }
          else if (value.method === 'session/prompt') {
            await options.phase?.('admitted', env);
            if (options.nativeApproval) await new Promise<void>(done => { nativeAnswer = () => done(); reply({ jsonrpc: '2.0', id: 'native-permission', method: 'session/request_permission', params: {
              sessionId: options.wrongApprovalSession ? 'foreign' : 's', toolCall: { toolCallId: 'tool-1', title: 'Write project file', rawInput: { file_path: 'result.txt', content: 'fixture' } },
              options: [{ optionId: 'enable-always-approve', kind: 'allow_once', name: 'Approve everything' }, { optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' }, { optionId: 'reject-once', kind: 'reject_once', name: 'Reject once' }] } }); });
            if (options.earlyEof) { close(); return; }
            if (options.tool) { reply({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'tool_call', title: 'read_file', toolCallId: 'x', status: 'in_progress' } } }); return; }
            reply({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'foreign', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'foreign' } } } });
            reply({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fixture response' } } } });
            reply({ jsonrpc: '2.0', id: value.id, result: { stopReason: 'end_turn' } });
            await options.phase?.('terminal', env);
          }
        });
      }
    });
    child.stdin.on('finish', () => { if (!options.stayOpen) close(); }); return child;
  };
  return { launcher, methods, sent, environments, launches };
}

test('ACP environment pins isolated homes and excludes API, Vertex, custom routes and injected runtimes', () => {
  const env = acpEnvironment('private-home', 'gemini', { PATH: 'safe', HOME: 'personal', GOOGLE_API_KEY: 'bad', GEMINI_API_KEY: 'bad',
    GOOGLE_APPLICATION_CREDENTIALS: 'bad', GOOGLE_GENAI_USE_VERTEXAI: 'true', XAI_API_KEY: 'bad', GROK_MODELS_BASE_URL: 'bad', NODE_OPTIONS: 'bad' });
  assert.equal(env.HOME, 'private-home'); assert.equal(env.USERPROFILE, 'private-home'); assert.equal(env.GEMINI_CLI_HOME, 'private-home');
  for (const key of ['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_GENAI_USE_VERTEXAI', 'XAI_API_KEY', 'GROK_MODELS_BASE_URL', 'NODE_OPTIONS']) assert.equal(env[key], undefined);
  assert.equal(env.GEMINI_FORCE_FILE_STORAGE, 'true'); assert.equal(env.NO_BROWSER, 'true');
});
test('ACP requests are correlated and every native permission or file/terminal request is denied', async () => {
  const sent: any[] = []; const client = new AcpClient(value => sent.push(value));
  const pending = client.call('initialize', { protocolVersion: 1 });
  client.accept({ jsonrpc: '2.0', id: sent[0].id, result: { protocolVersion: 1 } });
  assert.deepEqual(await pending, { protocolVersion: 1 });
  client.accept({ jsonrpc: '2.0', id: 'native-1', method: 'session/request_permission', params: { toolCall: { title: 'mcp__relay_app__relay_create_bot' }, options: [{ optionId: 'always', kind: 'allow_always' }] } });
  assert.deepEqual(sent.at(-1).result, { outcome: { outcome: 'cancelled' } });
  client.accept({ jsonrpc: '2.0', id: 'native-2', method: 'fs/read_text_file', params: { path: 'secret' } });
  assert.equal(sent.at(-1).error.code, -32601);
  assert.throws(() => client.accept({ jsonrpc: '2.0', id: 'native-1', method: 'session/request_permission', params: {} }), /duplicate/);
  client.close();
});
test('Gemini inspection proves isolated cached OAuth and discovers only native concrete models without inference', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-acp-gemini-'));
  try {
    const f = fixture(); const adapter = new GeminiAdapter(dir, { command: async () => command, launcher: f.launcher, kill: async child => { child.kill(); } });
    assert.equal((await adapter.inspect()).authenticated, false); assert.equal(f.methods.length, 0);
    await profile(dir); const state = await adapter.inspect();
    assert.equal(state.authenticated, true); assert.equal(state.authMode, 'subscription'); assert.match(state.accountLabel, /^Gemini subscription · [a-f0-9]{24}$/);
    assert.equal(state.plan, ''); assert.deepEqual(state.models.map(m => m.id), ['gemini-fixture']); assert.equal(state.models[0].verified, false);
    assert.ok(!f.methods.includes('session/prompt'));
    const settings = JSON.parse(await readFile(join(f.environments[0].HOME!, '.gemini', 'settings.json'), 'utf8'));
    assert.deepEqual(settings.tools.core, []); assert.equal(settings.security.auth.useExternal, true); assert.equal(settings.hooksConfig.enabled, false);
    await adapter.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('Gemini sends one bounded private mission, filters foreign sessions, and claims no resolved model', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-acp-gemini-'));
  try {
    await profile(dir); const f = fixture(), events: any[] = []; let dispatched = 0;
    const adapter = new GeminiAdapter(dir, { command: async () => command, launcher: f.launcher, kill: async child => { child.kill(); } });
    const result = await adapter.stream(await requestFor(dir), event => events.push(event), new AbortController().signal, () => { dispatched++; });
    assert.equal(result.text, 'fixture response'); assert.equal(result.actualModel, undefined); assert.equal(dispatched, 1);
    assert.equal(f.methods.filter(m => m === 'session/prompt').length, 1);
    const input = f.sent.find(m => m.method === 'session/prompt').params.prompt[0].text;
    assert.ok(input.includes(request.instructions)); assert.ok(!input.includes('fixture-private-refresh'));
    assert.equal(f.sent.find(m => m.method === 'initialize').params.clientCapabilities.terminal, false);
    assert.equal(events.filter(e => e.type === 'delta').map(e => e.text).join(''), 'fixture response');
    await adapter.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Gemini uses fresh run config and stops ambient system, project and dotenv discovery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-acp-gemini-config-'));
  try {
    await profile(dir); const checked: string[] = [];
    const f = fixture({ phase: async (phase, env) => {
      if (phase !== 'before-prompt') return;
      const cwd = f.launches.at(-1)!.cwd;
      assert.match(cwd, /[\\/]\.relay-runs[\\/]run-[^\\/]+[\\/]workspace$/);
      assert.equal(await readFile(join(cwd, '.env'), 'utf8'), '');
      assert.equal(await readFile(join(cwd, '.gemini', '.env'), 'utf8'), '');
      for (const key of ['GEMINI_CLI_SYSTEM_SETTINGS_PATH', 'GEMINI_CLI_SYSTEM_DEFAULTS_PATH']) {
        assert.equal(typeof env[key], 'string'); assert.ok(env[key]!.startsWith(cwd.slice(0, -'workspace'.length)));
        await assert.rejects(readFile(env[key]!, 'utf8'), { code: 'ENOENT' });
      }
      const config = JSON.parse(await readFile(join(env.HOME!, '.gemini', 'settings.json'), 'utf8'));
      assert.equal(config.tools.discoveryCommand, ''); assert.equal(config.tools.callCommand, '');
      checked.push(cwd);
    } });
    const adapter = new GeminiAdapter(dir, { command: async () => command, launcher: f.launcher, kill: async child => { child.kill(); } });
    assert.equal((await adapter.inspect()).authenticated, true); assert.equal((await adapter.inspect()).authenticated, true);
    assert.equal(checked.length, 2); assert.notEqual(checked[0], checked[1]); await adapter.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('Gemini account, model, policy or native auth failures reject before prompt with no fallback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-acp-gemini-'));
  try {
    await profile(dir);
    for (const issue of ['account', 'model', 'auth', 'mode', 'revoke']) {
      const f = fixture({ wrongModel: issue === 'model', failAuth: issue === 'auth' });
      const adapter = new GeminiAdapter(dir, { command: async () => command, launcher: f.launcher, kill: async child => { child.kill(); } });
      await assert.rejects(adapter.stream({ ...await requestFor(dir), ...(issue === 'account' ? { expectedAccount: { accountLabel: 'changed', plan: '' } } : {}), ...(issue === 'mode' ? { mode: 'work' as const } : {}) }, () => {}, new AbortController().signal,
        () => { if (issue === 'revoke') throw Error('revoked'); }));
      assert.ok(!f.methods.includes('session/prompt')); await adapter.close();
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('ACP native tool attempts and early EOF never become successful responses or replay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-acp-gemini-'));
  try {
    await profile(dir);
    for (const options of [{ tool: true }, { earlyEof: true }]) {
      const f = fixture(options); const adapter = new GeminiAdapter(dir, { command: async () => command, launcher: f.launcher, kill: async child => { child.kill(); } });
      await assert.rejects(adapter.stream(await requestFor(dir), () => {}, new AbortController().signal), /tool|closed|ended|completion/);
      assert.equal(f.methods.filter(m => m === 'session/prompt').length, 1); await adapter.close();
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('Gemini never treats the native cached display email as proof of the OAuth principal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-gemini-binding-'));
  try {
    await profile(dir); const home = join(dir, 'gemini', 'home'), first = await geminiIdentity(home);
    await writeFile(join(home, '.gemini', 'google_accounts.json'), JSON.stringify({ active: 'unrelated@example.test' }));
    assert.equal((await geminiIdentity(home))?.accountLabel, first?.accountLabel);
    assert.ok(!first?.accountLabel.includes('fixture@example.test')); assert.ok(!first?.accountLabel.includes('fixture-private-refresh'));
    await writeFile(join(home, '.gemini', 'oauth_creds.json'), JSON.stringify({ refresh_token: 'fixture-private-refresh', access_token: 'routine-refresh', expiry_date: 123456 }));
    assert.equal((await geminiIdentity(home))?.accountLabel, first?.accountLabel);
    await writeFile(join(home, '.gemini', 'oauth_creds.json'), JSON.stringify({ refresh_token: 'different-native-credential' }));
    assert.notEqual((await geminiIdentity(home))?.accountLabel, first?.accountLabel);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Gemini excludes native Flash Lite silent-fallback chains and rejects dispatch before launch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-acp-gemini-model-'));
  try {
    await profile(dir); const f = fixture({ flashLite: true });
    const adapter = new GeminiAdapter(dir, { command: async () => command, launcher: f.launcher, kill: async child => { child.kill(); } });
    const state = await adapter.inspect(); assert.equal(state.authenticated, true);
    assert.ok(!state.models.some(model => model.id.includes('flash-lite'))); assert.match(state.error!, /Flash Lite.*fallback/i);
    const launches = f.launches.length;
    await assert.rejects(adapter.stream({ ...await requestFor(dir), model: 'gemini-3.1-flash-lite' }, () => {}, new AbortController().signal), /Flash Lite.*fallback/i);
    assert.equal(f.launches.length, launches); assert.ok(!f.methods.includes('session/prompt')); await adapter.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('ACP app facade admits calls only during the prompt and revokes before terminal cleanup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-acp-app-lifecycle-'));
  try {
    await profile(dir); const observed: { phase: string; accepted: boolean }[] = []; const calls: string[] = [];
    let bootstrap: { url: string; token: string } | undefined;
    const probe = async (phase: string, env: NodeJS.ProcessEnv) => {
      if (!bootstrap) bootstrap = JSON.parse(await readFile(env.RELAY_TEST_MCP_BOOTSTRAP!, 'utf8'));
      let accepted = false; try { const response = await fetch(bootstrap!.url, { method: 'POST', headers: { authorization: 'Bearer ' + bootstrap!.token }, body: JSON.stringify({ operation: 'call', id: phase, name: 'relay_create_bot', args: { name: phase } }) }); accepted = response.ok; } catch {}
      observed.push({ phase, accepted });
    };
    const f = fixture({ stayOpen: true, phase: probe });
    const adapter = new GeminiAdapter(dir, { command: async () => command, launcher: f.launcher,
      kill: async child => { await probe('cleanup', f.environments[0]); child.kill(); } });
    const input = { ...await requestFor(dir), mode: 'agent' as const, appTools: { definitions: [{ name: 'relay_create_bot', description: 'create bot', inputSchema: { type: 'object' } }],
      call: async (id: string) => { calls.push(id); return { id }; } } };
    assert.equal((await adapter.stream(input, () => {}, new AbortController().signal)).text, 'fixture response');
    assert.deepEqual(calls, ['admitted']);
    assert.equal(observed.find(p => p.phase === 'before-prompt')?.accepted, false);
    assert.equal(observed.find(p => p.phase === 'terminal')?.accepted, false);
    assert.equal(observed.find(p => p.phase === 'cleanup')?.accepted, false);
    await adapter.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('Grok credential binding is opaque, private-profile specific and changes when native auth bytes change', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-acp-grok-'));
  try {
    const home = join(dir, 'grok', 'home'); await mkdir(join(home, '.grok'), { recursive: true });
    assert.equal(await grokIdentity(home), null);
    await writeFile(join(home, '.grok', 'auth.json'), JSON.stringify({ native: 'fixture-secret' }));
    const first = await grokIdentity(home), second = await grokIdentity(home);
    assert.ok(first); assert.equal(first?.accountLabel, second?.accountLabel); assert.ok(!first?.accountLabel.includes('fixture-secret'));
    await writeFile(join(home, '.grok', 'auth.json'), JSON.stringify({ native: 'changed-secret' }));
    assert.notEqual((await grokIdentity(home))?.accountLabel, first?.accountLabel);
    const adapter = new GrokAdapter(dir, { command: async () => null }); assert.equal((await adapter.inspect()).installed, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('Grok verifies native cached OAuth, account and entitlement without invoking interactive authenticate', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-acp-grok-'));
  try {
    const home = join(dir, 'grok', 'home'); await mkdir(join(home, '.grok'), { recursive: true });
    await writeFile(join(home, '.grok', 'auth.json'), JSON.stringify({ fixture: 'private-cache' }));
    const f = fixture({ grok: true }); const adapter = new GrokAdapter(dir, { command: async () => command, launcher: f.launcher, kill: async child => { child.kill(); } });
    const state = await adapter.inspect(); assert.equal(state.authenticated, true); assert.equal(state.accountLabel, 'grokfixture@example.test'); assert.equal(state.plan, 'Free');
    assert.ok(!f.methods.includes('authenticate')); assert.ok(f.methods.includes('_x.ai/auth/check_subscription')); assert.ok(!f.methods.includes('session/prompt'));
    assert.equal(state.nativeAgentOnly, true);
    await assert.rejects(adapter.stream(request, () => {}, new AbortController().signal), /native Agent.*project/i);
    assert.ok(!f.methods.includes('session/prompt'));
    assert.match(await readFile(join(home, '.grok', 'config.toml'), 'utf8'), /preferred_method = "oidc"/);
    await adapter.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Grok native Agent uses the workspace and only exact one-call host approval options', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-acp-grok-native-'));
  try {
    const home = join(dir, 'grok', 'home'), workspace = join(dir, 'project'); await mkdir(join(home, '.grok'), { recursive: true }); await mkdir(workspace);
    await writeFile(join(home, '.grok', 'auth.json'), JSON.stringify({ fixture: 'private-cache' }));
    for (const decision of ['allow', 'deny'] as const) {
      const f = fixture({ grok: true, nativeApproval: true }); let approvals = 0; const events: any[] = [];
      const adapter = new GrokAdapter(dir, { command: async () => command, launcher: f.launcher, kill: async child => { child.kill(); } });
      const result = await adapter.stream({ ...request, mode: 'agent', workspace, expectedAccount: { accountLabel: 'grokfixture@example.test', plan: 'Free' },
        interact: async prompt => { approvals++; assert.equal(prompt.kind, 'approval'); assert.match(prompt.details!, /result.txt/); return { decision }; } }, event => events.push(event), new AbortController().signal);
      assert.equal(result.text, 'fixture response'); assert.equal(result.actualModel, undefined); assert.equal(approvals, 1);
      assert.equal(f.launches[0].cwd, workspace);
      const session = f.sent.find(value => value.method === 'session/new'); assert.equal(session.params.cwd, workspace);
      assert.deepEqual(session.params._meta, { yoloMode: false, autoMode: false });
      assert.deepEqual(f.sent.find(value => value.id === 'native-permission').result, { outcome: { outcome: 'selected', optionId: decision === 'allow' ? 'allow-once' : 'reject-once' } });
      assert.equal(f.environments[0].GROK_REMEMBER_TOOL_APPROVALS, '0'); assert.equal(f.environments[0].GROK_WRITE_FILE, '1');
      const config = await readFile(join(home, '.grok', 'config.toml'), 'utf8'); assert.match(config, /ask = \["\*"\]/); assert.match(config, /deny = \["WebSearch", "WebFetch"\]/);
      assert.ok(events.some(event => event.type === 'status' && /Windows.*sandbox/.test(event.message))); await adapter.close();
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Grok refuses Chat, Work, app-only Agent and missing native approval transport before any RPC', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-acp-grok-mode-'));
  try {
    const f = fixture({ grok: true }); const adapter = new GrokAdapter(dir, { command: async () => command, launcher: f.launcher, kill: async child => { child.kill(); } });
    for (const partial of [{ mode: 'chat' as const }, { mode: 'work' as const }, { mode: 'agent' as const }, { mode: 'agent' as const, workspace: dir }, { mode: 'agent' as const, workspace: join(dir, 'missing'), interact: async () => ({ decision: 'allow' as const }) }])
      await assert.rejects(adapter.stream({ ...request, ...partial }, () => {}, new AbortController().signal));
    assert.equal(f.methods.length, 0); await adapter.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Grok native approval is cancelled on Stop and foreign-session requests never reach the human', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-acp-grok-cancel-'));
  try {
    const home = join(dir, 'grok', 'home'); await mkdir(join(home, '.grok'), { recursive: true }); await writeFile(join(home, '.grok', 'auth.json'), JSON.stringify({ fixture: 'private-cache' }));
    for (const foreign of [false, true]) {
      const f = fixture({ grok: true, nativeApproval: true, wrongApprovalSession: foreign }); const controller = new AbortController(); let approvals = 0, approvalSignal: AbortSignal | undefined;
      const adapter = new GrokAdapter(dir, { command: async () => command, launcher: f.launcher, kill: async child => { child.kill(); } });
      const run = adapter.stream({ ...request, mode: 'agent', workspace: dir, expectedAccount: { accountLabel: 'grokfixture@example.test', plan: 'Free' }, interact: async (_prompt, signal) => {
        approvals++; approvalSignal = signal; controller.abort(); return { decision: 'allow' };
      } }, () => {}, controller.signal);
      await assert.rejects(run, /cancel|session/i); assert.equal(approvals, foreign ? 0 : 1);
      if (!foreign) assert.equal(approvalSignal?.aborted, true);
      assert.ok(!f.sent.some(value => value.id === 'native-permission' && value.result?.outcome?.optionId === 'allow-once')); await adapter.close();
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('Grok API auth and gated entitlement fail before any prompt or browser-auth request', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-acp-grok-'));
  try {
    const home = join(dir, 'grok', 'home'); await mkdir(join(home, '.grok'), { recursive: true });
    await writeFile(join(home, '.grok', 'auth.json'), JSON.stringify({ fixture: 'private-cache' }));
    for (const options of [{ grok: true, grokApi: true }, { grok: true, grokGated: true }]) {
      const f = fixture(options); const adapter = new GrokAdapter(dir, { command: async () => command, launcher: f.launcher, kill: async child => { child.kill(); } });
      assert.equal((await adapter.inspect()).authenticated, false);
      assert.ok(!f.methods.includes('session/prompt')); assert.ok(!f.methods.includes('authenticate')); await adapter.close();
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
