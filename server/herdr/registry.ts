import { createHmac, timingSafeEqual } from 'node:crypto';
import { openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { readFile, lstat } from 'node:fs/promises';
export interface RegistryIdentity { delegationId: string; parentRunId: string; epoch: string }
export function registryKey(token: string): string { return createHmac('sha256', token).update('relay-child-registry-v1').digest('hex'); }
export class ChildRegistry {
  private seq = 0;
  constructor(private path: string, private identity: RegistryIdentity, private key: string) {}
  append(kind: 'worker' | 'intent' | 'spawn' | 'exit' | 'guard' | 'complete', payload: { launchId?: string; pid?: number | null; cleanup?: boolean; treeScope?: 'windows-job' | 'not-started' }): void {
    const data = { delegationId: this.identity.delegationId, parentRunId: this.identity.parentRunId, epoch: this.identity.epoch, seq: ++this.seq, kind, ...payload };
    const signature = createHmac('sha256', this.key).update(JSON.stringify(data)).digest('hex');
    const fd = openSync(this.path, 'a', 0o600);
    try { writeSync(fd, JSON.stringify({ data, signature }) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  }
}
export async function registrationProof(path: string, identity: RegistryIdentity, key: string): Promise<{ valid: boolean; complete: boolean; cleanup: boolean; kernelBound: boolean; pids: number[] }> {
  const invalid = { valid: false, complete: false, cleanup: false, kernelBound: false, pids: [] };
  try {
    const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) return invalid;
    const source = await readFile(path, 'utf8'); if (!source.endsWith('\n')) return invalid;
    const lines = source.trimEnd().split('\n'); if (!lines.length || lines.length > 2000) return invalid;
    const pids = new Set<number>(), intents = new Map<string, { spawned: boolean; exited: boolean }>(); let seq = 0, complete = false, cleanup = false, worker = false, kernelBound = false;
    for (const line of lines) {
      const { data, signature } = JSON.parse(line);
      if (!data || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature) || complete
        || data.delegationId !== identity.delegationId || data.parentRunId !== identity.parentRunId || data.epoch !== identity.epoch || data.seq !== ++seq) return invalid;
      const expected = createHmac('sha256', key).update(JSON.stringify(data)).digest('hex');
      if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return invalid;
      if (data.pid != null) { if (!Number.isSafeInteger(data.pid) || data.pid <= 0) return invalid; pids.add(data.pid); }
      if (data.kind === 'worker') { if (worker || seq !== 1 || !data.pid) return invalid; worker = true; }
      else if (data.kind === 'intent') { if (!worker || typeof data.launchId !== 'string' || intents.has(data.launchId)) return invalid; intents.set(data.launchId, { spawned: false, exited: false }); }
      else if (data.kind === 'spawn' || data.kind === 'exit') {
        const intent = intents.get(data.launchId); if (!intent) return invalid;
        if (data.kind === 'spawn') { if (intent.spawned) return invalid; intent.spawned = true; }
        else { if (!intent.spawned || intent.exited) return invalid; intent.exited = true; }
      } else if (data.kind === 'guard') {
        if (!worker || kernelBound || !data.pid || ![...intents.values()].some(v => v.spawned)) return invalid; kernelBound = true;
      } else if (data.kind === 'complete') {
        if (!worker || typeof data.cleanup !== 'boolean' || !['windows-job','not-started'].includes(data.treeScope)) return invalid;
        complete = true; cleanup = data.cleanup && [...intents.values()].every(v => v.spawned && v.exited);
      } else return invalid;
    }
    return { valid: worker, complete, cleanup, kernelBound, pids: [...pids] };
  } catch { return invalid; }
}
