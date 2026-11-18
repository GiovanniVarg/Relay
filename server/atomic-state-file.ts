import { rename } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

interface AtomicStateRenameOptions {
  /** Internal test dependencies; these are never populated from HTTP or agent input. */
  platform?: NodeJS.Platform;
  renameFile?: (temporary: string, destination: string) => Promise<void>;
  wait?: (milliseconds: number) => Promise<void>;
}
const WINDOWS_LOCK_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);
// Ten attempts; at most 4.575 seconds of added delay, then preserve the original failure.
const RETRY_DELAYS = [25, 50, 100, 200, 400, 800, 1000, 1000, 1000] as const;

/** Publish an already-written, caller-owned state file atomically. Windows scanners can
 * briefly deny rename/delete sharing. Retry that same rename only: never unlink the
 * destination, rewrite the temporary file, or replay the operation that produced it.
 * The caller retains responsibility for validating its paths and exclusive temp ownership.
 */
export async function renameAtomicState(temporary: string, destination: string,
  options: AtomicStateRenameOptions = {}): Promise<void> {
  const platform = options.platform ?? process.platform;
  const renameFile = options.renameFile ?? rename;
  const wait = options.wait ?? (async milliseconds => { await delay(milliseconds); });
  for (let attempt = 0; ; attempt++) {
    try { await renameFile(temporary, destination); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (platform !== 'win32' || !code || !WINDOWS_LOCK_ERRORS.has(code) || attempt >= RETRY_DELAYS.length) throw error;
      await wait(RETRY_DELAYS[attempt]!);
    }
  }
}
