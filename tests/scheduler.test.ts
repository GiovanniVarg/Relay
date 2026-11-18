import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InferenceScheduler } from '../server/scheduler.js';

const deferred = <T = void>() => { let resolve!: (v: T | PromiseLike<T>) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

test('shared inference capacity is two; queued work starts in admission order', async () => {
  const scheduler = new InferenceScheduler(); const one = deferred(); const two = deferred(); const seen: number[] = [];
  const run = (n: number, wait?: Promise<void>) => scheduler.run(undefined, new AbortController().signal, async () => { seen.push(n); await wait; return n; });
  const a = run(1, one.promise), b = run(2, two.promise), c = run(3), d = run(4);
  await tick(); assert.deepEqual(seen, [1, 2]); assert.equal(scheduler.activeCount, 2);
  one.resolve(); await a; await c; await d; assert.deepEqual(seen, [1, 2, 3, 4]); two.resolve(); await b;
  assert.equal(scheduler.activeCount, 0);
});

test('canonical overlapping workspaces serialize through the full provider promise; unrelated chat proceeds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-schedule-')); await mkdir(join(root, 'child'));
  const scheduler = new InferenceScheduler(); const waiting = deferred(); const seen: string[] = [];
  try {
    const a = scheduler.run(root, new AbortController().signal, async () => { seen.push('parent'); await waiting.promise; });
    const b = scheduler.run(join(root, 'child'), new AbortController().signal, async () => { seen.push('child'); });
    const c = scheduler.run(undefined, new AbortController().signal, async () => { seen.push('chat'); });
    await c; assert.deepEqual(seen, ['parent', 'chat']); waiting.resolve(); await Promise.all([a, b]);
    assert.deepEqual(seen, ['parent', 'chat', 'child']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('aborting a queued slot never invokes its provider', async () => {
  const scheduler = new InferenceScheduler(); const gate = deferred(); const abort = new AbortController(); let invoked = false;
  const a = scheduler.run(undefined, new AbortController().signal, () => gate.promise);
  const b = scheduler.run(undefined, new AbortController().signal, () => gate.promise);
  const c = scheduler.run(undefined, abort.signal, async () => { invoked = true; });
  abort.abort(new Error('cancel queued'));
  await assert.rejects(c, /cancel queued/); gate.resolve(); await Promise.all([a, b]); assert.equal(invoked, false);
});

test('unknown worker termination keeps its inference lease and overlapping workspace excluded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-schedule-')); const scheduler = new InferenceScheduler(); const abort = new AbortController();
  try {
    await assert.rejects(scheduler.run(root, new AbortController().signal, async () => { throw Object.assign(new Error('unconfirmed stop'), { code: 'HERDR_OUTCOME_UNKNOWN' }); }), /unconfirmed stop/);
    assert.equal(scheduler.activeCount, 1);
    let invoked = false;
    const waiting = scheduler.run(root, abort.signal, async () => { invoked = true; }); await tick();
    assert.equal(invoked, false); abort.abort(); await assert.rejects(waiting);
  } finally { await rm(root, { recursive: true, force: true }); }
});
