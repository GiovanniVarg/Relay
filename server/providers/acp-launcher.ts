import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { killOwned, providerOutcomeUnknown, type Launcher } from './process.js';

/** Native ACP runs in its own wrapper. Relay itself is never assigned to the job. */
export function createAcpLauncher(directory: string, provider?: 'gemini' | 'grok'|'opencode') {
  const states = new WeakMap<ChildProcessWithoutNullStreams, { receipt: boolean; closed: Promise<void>; isClosed: boolean }>();
  const launcher: Launcher = (command, args, cwd, env) => {
    if (process.platform !== 'win32') throw new Error('Native ACP tree ownership is currently verified only on Windows');
    const development = import.meta.url.endsWith('.ts'), worker = fileURLToPath(new URL(`./acp-guard-worker.${development ? 'ts' : 'js'}`, import.meta.url));
    const child = spawn(process.execPath, development ? ['--import', import.meta.resolve('tsx'), worker] : [worker], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] }) as ChildProcessWithoutNullStreams;
    const state = { receipt: false, isClosed: false, closed: Promise.resolve() };
    state.closed = new Promise<void>(done => child.once('close', () => { state.isClosed = true; done(); }));
    child.on('message', value => { if ((value as any)?.type === 'acp-cleanup' && (value as any).stopped === true) state.receipt = true; });
    states.set(child, state);
    child.send({ type: 'acp-start', command, args, cwd, env, directory, provider }, error => { if (error) child.kill('SIGKILL'); });
    return child;
  };
  const prove = async (child: ChildProcessWithoutNullStreams) => {
    const state = states.get(child);
    if (!state?.isClosed || !state.receipt) throw providerOutcomeUnknown('Native ACP wrapper exited without an independent Windows job cleanup receipt');
  };
  const kill = async (child: ChildProcessWithoutNullStreams) => {
    const state = states.get(child); if (!state) throw providerOutcomeUnknown('Native ACP ownership state is unavailable');
    if (!state.isClosed) {
      if (child.connected) { try { child.send({ type: 'acp-stop' }, () => {}); } catch {} }
      let timer: NodeJS.Timeout | undefined;
      const stopped = await Promise.race([state.closed.then(() => true), new Promise<boolean>(done => { timer = setTimeout(() => done(false), 20_000); })]);
      clearTimeout(timer);
      if (!stopped) { try { await killOwned(child); } catch {} throw providerOutcomeUnknown('Native ACP wrapper did not acknowledge job cleanup'); }
    }
    await prove(child);
  };
  return { launcher, kill, prove };
}
