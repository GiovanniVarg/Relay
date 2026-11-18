import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { WindowsTreeGuard } from '../herdr/tree-guard.js';
import type { Command } from './process.js';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

type Start = { type: 'acp-start'; command: Command; args: string[]; cwd: string; env: NodeJS.ProcessEnv; directory: string; provider?: 'gemini' | 'grok'|'opencode' };
let started = false, stopping = false, starting: Promise<void> | undefined, completion: Promise<void> | undefined;
let guard: WindowsTreeGuard | undefined, native: ChildProcessWithoutNullStreams | undefined;
function finish(code = 0): Promise<void> {
  stopping = true;
  return completion ??= (async () => {
    await starting;
    if (!guard) throw new Error('Native ACP job was not established');
    process.stdin.unpipe(); native?.stdin.end();
    const pids = await guard.drain(); await guard.release();
    if (process.connected) await new Promise<void>((done, reject) => process.send!({ type: 'acp-cleanup', stopped: true, pids }, error => error ? reject(error) : done()));
    if (process.connected) process.disconnect();
    process.exit(code);
  })().catch(() => { process.stderr.write('Native ACP cleanup could not be proved\n'); process.exit(1); });
}
process.on('message', (message: Start | { type: 'acp-stop' }) => {
  if (message?.type === 'acp-stop') { void finish(); return; }
  if (message?.type !== 'acp-start' || started) { void finish(1); return; }
  started = true;
  starting = (async () => {
    guard = await WindowsTreeGuard.create(message.directory, () => {});
    if (stopping) return;
    if (message.provider === 'gemini') {
      const entry = message.command.args[0];
      if (!entry?.endsWith('gemini.js')) throw new Error('Unverified Gemini executable');
      // Pinned 0.62.0 loader; fail closed if this package layout or effective native policy changes.
      const settingsModule = await import(pathToFileURL(join(dirname(entry), 'chunk-KCP45VUB.js')).href);
      const loaded = settingsModule.loadSettings(message.cwd), config = loaded.merged;
      if (loaded.errors.length || !Array.isArray(config.tools?.core) || config.tools.core.length || config.tools.discoveryCommand || config.tools.callCommand || config.hooksConfig?.enabled !== false
        || config.security?.auth?.selectedType !== 'oauth-personal' || config.security.auth.useExternal !== true
        || config.experimental?.enableAgents !== false || config.experimental?.dynamicModelConfiguration !== false || Object.keys(config.mcpServers ?? {}).length)
        throw new Error('Gemini native configuration could not be verified');
    }
    native = spawn(message.command.file, [...message.command.args, ...message.args], { cwd: message.cwd, env: message.env, windowsHide: true, shell: false, stdio: 'pipe' });
    native.stdout.pipe(process.stdout); native.stderr.resume(); native.stdin.on('error', () => {});
    native.once('error', () => { void finish(1); }); native.once('close', code => { void finish(code === 0 ? 0 : 1); });
    process.stdin.pipe(native.stdin);
  })();
  void starting.catch(() => { void finish(1); });
});
process.stdin.once('end', () => { void finish(); });
process.once('disconnect', () => { void finish(); });
process.once('SIGTERM', () => { void finish(); });
process.once('SIGINT', () => { void finish(); });
process.stdin.pause();
