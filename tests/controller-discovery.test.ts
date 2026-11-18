import test from 'node:test';
import assert from 'node:assert/strict';
import { checkKnownHosts, chooseKnownHost } from '../client/controller-discovery.js';
import type { ControllerProfile } from '../client/controller-storage.js';

const profiles = (count: number) => Array.from({ length: count }, (_, index) => ({ id: String(index), name: `Host ${index}`, autoConnect: true } as ControllerProfile));
test('known host selection prefers this tab, and ambiguous results require a choice', () => {
  const saved = profiles(3), reachable = new Set(['0', '1']);
  assert.equal(chooseKnownHost(saved, reachable, '1')?.id, '1');
  assert.equal(chooseKnownHost(saved, reachable, '2'), undefined);
  assert.equal(chooseKnownHost(saved, new Set(['1']))?.id, '1');
  saved[1].autoConnect = false;
  assert.equal(chooseKnownHost(saved, new Set(['1'])), undefined);
});
test('background checks visit at most sixteen saved opt-in hosts with two requests at a time', async () => {
  const saved = profiles(20); saved[0].autoConnect = false;
  const visited: string[] = []; let running = 0, maximum = 0;
  const found = await checkKnownHosts(saved, async profile => {
    visited.push(profile.id); running++; maximum = Math.max(maximum, running);
    await new Promise(resolve => setTimeout(resolve, 2)); running--;
    if (profile.id === '3') throw new Error('Host unavailable');
  }, new AbortController().signal);
  assert.equal(visited.length, 16); assert.equal(maximum, 2);
  assert.equal(visited.includes('0'), false); assert.equal(visited.includes('17'), false);
  assert.equal(found.has('3'), false); assert.equal(found.size, 15);
});
test('cancelling a discovery generation cannot promote its late replies', async () => {
  const controller = new AbortController(); let started = 0;
  const found = await checkKnownHosts(profiles(8), async () => { started++; controller.abort(); }, controller.signal);
  assert.equal(found.size, 0); assert.equal(started, 1);
});
