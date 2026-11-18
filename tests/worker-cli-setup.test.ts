import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { parseWorkerArguments, promptWorkerProfilePath, readWorkerPublicProfile } from '../server/worker-cli.js';

test('first setup accepts an interactive profile path or the extracted public-profile default', async () => {
  const fallback = resolve('fixture-worker', 'relay-connection.json');
  assert.equal(await promptWorkerProfilePath({ question: async () => '' }, fallback), fallback);
  assert.equal(await promptWorkerProfilePath({ question: async () => '"profile with spaces.json"' }), resolve('profile with spaces.json'));
  assert.equal(parseWorkerArguments([]).profile, undefined);
  assert.throws(() => parseWorkerArguments(['--code', 'NEVER-A-COMMAND-ARGUMENT']));
});

test('profile reader refuses credential-shaped or oversized JSON without echoing its content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-worker-cli-'));
  try {
    const path = join(directory, 'profile.json');
    await writeFile(path, JSON.stringify({ url: 'https://192.168.1.2:3443', ca: 'not a certificate', fingerprint: 'x', privateKey: 'private-sentinel' }));
    assert.throws(() => readWorkerPublicProfile(path), { message: 'Choose a valid public Relay connection profile' });
    await writeFile(path, 'x'.repeat(16385));
    assert.throws(() => readWorkerPublicProfile(path), { message: 'Choose a valid public Relay connection profile' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
