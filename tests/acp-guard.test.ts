import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAcpLauncher } from '../server/providers/acp-launcher.js';
import { childEnvironment } from '../server/providers/process.js';
const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };
async function waitFile(path: string) { for (let i = 0; i < 250; i++) { try { return await readFile(path, 'utf8'); } catch {} await new Promise(done => setTimeout(done, 40)); } throw Error('No native fixture ready'); }
for (const exitsFirst of [true, false]) test(`ACP wrapper proves detached descendants stop when native root ${exitsFirst ? 'exits first' : 'waits for stop'}`, { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-acp-guard-'));
  try {
    const source = join(dir, 'native.mjs'), pids = join(dir, 'pids.json');
    await writeFile(source, `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const daemon=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true,windowsHide:true});daemon.unref();writeFileSync(${JSON.stringify(pids)},JSON.stringify([process.pid,daemon.pid]));${exitsFirst ? 'setTimeout(()=>process.exit(0),80)' : 'setInterval(()=>{},1000)'};`);
    const guard = createAcpLauncher(dir), child = guard.launcher({ file: process.execPath, args: [source] }, [], dir, childEnvironment());
    const closed = new Promise<void>(done => child.once('close', () => done()));
    const nativePids: number[] = JSON.parse(await waitFile(pids));
    if (!exitsFirst) await guard.kill(child);
    await closed; await guard.prove(child);
    assert.equal(nativePids.every(gone), true);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
test('ACP wrapper death kills its native job but missing IPC cleanup proof remains unknown', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-acp-guard-death-'));
  try {
    const source = join(dir, 'native.mjs'), pids = join(dir, 'pids.json');
    await writeFile(source, `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const daemon=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true,windowsHide:true});daemon.unref();writeFileSync(${JSON.stringify(pids)},JSON.stringify([process.pid,daemon.pid]));setInterval(()=>{},1000);`);
    const guard = createAcpLauncher(dir), child = guard.launcher({ file: process.execPath, args: [source] }, [], dir, childEnvironment());
    const closed = new Promise<void>(done => child.once('close', () => done())); const nativePids: number[] = JSON.parse(await waitFile(pids));
    child.kill('SIGKILL'); await closed;
    await assert.rejects(guard.prove(child), error => (error as any).code === 'PROVIDER_OUTCOME_UNKNOWN');
    for (let i = 0; i < 125 && !nativePids.every(gone); i++) await new Promise(done => setTimeout(done, 40));
    assert.equal(nativePids.every(gone), true);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
