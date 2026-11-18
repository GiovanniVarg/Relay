import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, win32 } from 'node:path';
import { assertSafeCodexConfig, CODEX_AGENT_ARGS, CODEX_WORK_ARGS, CodexAdapter, CodexRpc } from '../server/providers/codex.js';
import { childEnvironment, findCommand, JsonLines, launch, safeError } from '../server/providers/process.js';
import type { ProviderEvent } from '../shared/types.js';

// A separate opt-in exercises the real sandbox without starting a thread or model turn.
// Point this at the Relay data directory, and optionally choose an existing working directory.
const shellDataDir = process.env.RELAY_CODEX_SHELL_DATA_DIR;
test('live Codex Windows MXC executes PowerShell without model inference', {
  skip: process.platform !== 'win32' || !shellDataDir, timeout: 70_000,
}, async t => {
  const command = await findCommand('codex');
  assert.ok(command, 'Install the official Codex CLI (0.162.0+) before running the sandbox smoke test');
  const cwd = resolve(process.env.RELAY_CODEX_SHELL_CWD ?? tmpdir());
  const env = childEnvironment();
  env.CODEX_HOME = resolve(shellDataDir!, 'openai');
  for (const [mode, args] of [['work', CODEX_WORK_ARGS], ['agent', CODEX_AGENT_ARGS]] as const) {
    const rpc: CodexRpc = new CodexRpc(command, args, cwd, env, 25);
    try {
      await rpc.request('initialize', { clientInfo: { name: 'relay_shell_smoke', version: '0.1.0' }, capabilities: {} });
      rpc.notify('initialized');
      const effective = await rpc.request('config/read', { cwd, includeLayers: false });
      assertSafeCodexConfig(effective?.config, mode);
      assert.equal(effective.config.windows?.sandbox, 'mxc');
      const started = Date.now();
      const result = await rpc.request('command/exec', {
        command: [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
          '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '(Get-Location).Path'],
        cwd, sandboxPolicy: { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false }, timeoutMs: 15_000,
      });
      t.diagnostic(JSON.stringify({ mode, backend: 'mxc', elapsedMs: Date.now() - started, exitCode: result.exitCode }));
      assert.equal(result.exitCode, 0, `${mode} sandbox shell failed: ${safeError(result.stderr ?? '')}`);
      assert.equal(win32.normalize(String(result.stdout).trim()).toLowerCase(), win32.normalize(cwd).toLowerCase());
    } finally { await rpc.close(); }
  }
});

// Explicitly opt in: uses the installed CLI and the supplied subscription profile.
// Config-only fixtures cannot prove a model's tools actually execute.
const dataDir = process.env.RELAY_CODEX_LIVE_DATA_DIR;
const workspaceParent = process.env.RELAY_CODEX_LIVE_WORKSPACE_PARENT
  ?? (process.platform === 'win32' ? join(homedir(), 'Documents') : tmpdir());
for (const mode of ['work', 'agent'] as const) test(`live Codex ${mode === 'work' ? 'Work' : 'Agent'} mode executes shell and copies an owned project fixture`, {
  skip: !dataDir, timeout: 330_000,
}, async t => {
  // MXC may deny writes beneath the host Temp directory; choose an allowed project parent.
  const workspace = await mkdtemp(join(resolve(workspaceParent), `relay-codex-live-${mode}-`));
  const commandResults: { status: unknown; exitCode: unknown }[] = [];
  const adapter = new CodexAdapter(dataDir!, { launcher: (command, args, cwd, env) => {
    const child = launch(command, args, cwd, env);
    const parser = new JsonLines(message => {
      const item = message.params?.item;
      if (message.method === 'item/completed' && item?.type === 'commandExecution') {
        commandResults.push({ status: item.status, exitCode: item.exitCode });
        t.diagnostic(JSON.stringify({ mode, status: item.status, exitCode: item.exitCode,
          output: safeError(item.aggregatedOutput ?? '') }));
      }
    });
    child.stdout.on('data', chunk => { try { parser.push(chunk); } catch { /* Adapter handles protocol errors. */ } });
    return child;
  } });
  const events: ProviderEvent[] = [];
  try {
    const input = Buffer.from('relay-live-shell-' + crypto.randomUUID() + '\r\n');
    await writeFile(join(workspace, 'input.txt'), input);
    const connection = await adapter.inspect();
    assert.equal(connection.authenticated, true, connection.error);
    const result = await adapter.stream({
      runId: `live-smoke-${mode}`, conversationId: `live-smoke-${mode}`, model: 'gpt-6-luna',
      mode, workspace, maxSeconds: 300,
      expectedAccount: { accountLabel: connection.accountLabel, plan: connection.plan },
      ...(mode === 'agent' ? { interact: async () => ({ decision: 'deny' as const }) } : {}),
      instructions: 'Complete this minimal local tool smoke test.',
      history: [{ role: 'user', content: 'Use the shell to execute this command in the current directory:\n'
        + (process.platform === 'win32'
          ? '```powershell\nGet-Location; Copy-Item -LiteralPath input.txt -Destination output.txt; Get-Content -LiteralPath output.txt -Raw\n```\n'
          : '```sh\npwd; cp -- input.txt output.txt; cat -- output.txt\n```\n')
        + 'Do not access other directories or the network. Execute the tool; do not just describe commands. Give a short result.' }],
    }, event => events.push(event), new AbortController().signal);
    assert.equal(result.actualModel, 'gpt-6-luna');
    assert.ok(events.some(event => event.type === 'tool' && event.name === 'shell'), 'No shell execution event was observed');
    assert.ok(commandResults.length > 0, 'No completed shell execution was observed in the CLI trace');
    for (const execution of commandResults) {
      assert.equal(execution.status, 'completed', 'A traced shell execution did not complete successfully');
      assert.equal(execution.exitCode, 0, 'A traced shell execution failed');
    }
    assert.deepEqual(await readFile(join(workspace, 'output.txt')), input);
  } finally {
    await adapter.close();
    // This exact path was created by mkdtemp above, never supplied by the model/user.
    await rm(workspace, { recursive: true, force: true });
  }
});
