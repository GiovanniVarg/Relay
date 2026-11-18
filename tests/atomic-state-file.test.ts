import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import { renameAtomicState } from '../server/atomic-state-file.js';

const denied = (code: string) => Object.assign(new Error('Simulated filesystem denial'), { code });
async function fixture() {
  const parent = resolve(tmpdir()), directory = await mkdtemp(join(parent, 'relay-atomic-state-'));
  if (!resolve(directory).startsWith(parent + sep)) throw Error('Unexpected fixture path');
  const destination = join(directory, 'state.json'), temporary = join(directory, 'state.json.owned.tmp');
  const previous = '{"revision":"previous","status":"draft"}', next = '{"revision":"next","status":"ready"}';
  await writeFile(destination, previous, { flag: 'wx' }); await writeFile(temporary, next, { flag: 'wx' });
  return { destination, temporary, previous, next, async cleanup() {
    if (!resolve(directory).startsWith(parent + sep)) throw Error('Unsafe fixture cleanup');
    await rm(directory, { recursive: true, force: true });
  } };
}

test('Windows sharing locks retry the same atomic publication while preserving prior state until success', async () => {
  const f = await fixture(), waits: number[] = [], paths: string[][] = []; let attempts = 0;
  try {
    await renameAtomicState(f.temporary, f.destination, { platform: 'win32',
      renameFile: async (temporary, destination) => {
        paths.push([temporary, destination]); attempts++;
        assert.equal(await readFile(destination, 'utf8'), f.previous);
        assert.equal(await readFile(temporary, 'utf8'), f.next);
        if (attempts < 3) throw denied(attempts === 1 ? 'EPERM' : 'EBUSY');
        await rename(temporary, destination);
      }, wait: async milliseconds => { waits.push(milliseconds); },
    });
    assert.equal(attempts, 3); assert.deepEqual(waits, [25, 50]);
    assert.ok(paths.every(([temporary, destination]) => temporary === f.temporary && destination === f.destination));
    assert.equal(await readFile(f.destination, 'utf8'), f.next);
    await assert.rejects(readFile(f.temporary), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT');
  } finally { await f.cleanup(); }
});

test('persistent Windows denial stops after bounded retries without deleting or replacing prior state', async () => {
  const f = await fixture(), waits: number[] = [], failure = denied('EACCES'); let attempts = 0;
  try {
    await assert.rejects(renameAtomicState(f.temporary, f.destination, { platform: 'win32',
      renameFile: async (temporary, destination) => { attempts++; assert.equal(temporary, f.temporary); assert.equal(destination, f.destination); throw failure; },
      wait: async milliseconds => { waits.push(milliseconds); },
    }), error => error === failure);
    assert.equal(attempts, 10); assert.equal(waits.length, 9); assert.equal(waits.reduce((sum, value) => sum + value, 0), 4575);
    assert.equal(await readFile(f.destination, 'utf8'), f.previous); assert.equal(await readFile(f.temporary, 'utf8'), f.next);
  } finally { await f.cleanup(); }
});

test('other errors, missing source, and non-Windows permission failures are returned immediately', async () => {
  const f = await fixture();
  try {
    for (const [platform, code] of [['win32', 'ENOENT'], ['win32', 'EXDEV'], ['linux', 'EPERM'], ['darwin', 'EBUSY']] as const) {
      const failure = denied(code); let attempts = 0, waits = 0;
      await assert.rejects(renameAtomicState(f.temporary, f.destination, { platform,
        renameFile: async () => { attempts++; throw failure; }, wait: async () => { waits++; },
      }), error => error === failure);
      assert.equal(attempts, 1); assert.equal(waits, 0);
      assert.equal(await readFile(f.destination, 'utf8'), f.previous); assert.equal(await readFile(f.temporary, 'utf8'), f.next);
    }
  } finally { await f.cleanup(); }
});
