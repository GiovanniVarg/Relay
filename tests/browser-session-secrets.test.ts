import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, rm, link, symlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BrowserSessionSecrets } from '../server/browser-session-secrets.js';
import { fakeBrowserVault } from './browser-vault-fixture.js';
import fs from 'node:fs';
import filesystem from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const cookie = { name: 'fixture', value: 'synthetic-cookie-only-never-real-credential', domain: 'fixture.test', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' as const };
const check = () => {};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'relay-cookie-secrets-')), vault = fakeBrowserVault(), secrets = new BrowserSessionSecrets(root, vault);
  const profile = await secrets.profile('agent-a'), target = join(profile, 'session-cookies.encrypted.json'), legacy = join(profile, 'session-cookies.json');
  return { root, vault, secrets, profile, target, legacy, async close() { secrets.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }); } };
}
test('cookie persistence stores only authenticated ciphertext and reloads with an independently sealed per-agent key', async () => {
  const f = await fixture(); try {
    assert.deepEqual(await f.secrets.load('agent-a', check), []); await f.secrets.save('agent-a', [cookie], check);
    for (const name of await readdir(f.profile)) assert.equal((await readFile(join(f.profile, name), 'utf8')).includes(cookie.value), false);
    assert.equal(f.vault.values.get('browser-cookie-key-agent-a')?.length, 44); const reload = new BrowserSessionSecrets(f.root, f.vault);
    assert.deepEqual(await reload.load('agent-a', check), [cookie]); reload.close();
    await f.secrets.profile('agent-b'); await writeFile(join(f.root, 'browser', 'agent-b', 'session-cookies.encrypted.json'), await readFile(f.target));
    await assert.rejects(f.secrets.load('agent-b', check), /verified or decrypted/);
  } finally { await f.close(); }
});
test('legacy migration writes, verifies and then removes only the exact plaintext source', async () => {
  const f = await fixture(); try { await writeFile(f.legacy, JSON.stringify([cookie])); assert.deepEqual(await f.secrets.load('agent-a', check), [cookie]); await assert.rejects(readFile(f.legacy), { code: 'ENOENT' }); assert.equal((await readFile(f.target, 'utf8')).includes(cookie.value), false); } finally { await f.close(); }
});
test('failed key protection or ACL verification preserves the legacy source and profile', async () => {
  for (const operation of ['get', 'set'] as const) { const f = await fixture(); try {
    await writeFile(f.legacy, JSON.stringify([cookie])); f.vault[operation] = async () => { throw Error('synthetic protected-store failure with secret detail'); };
    await assert.rejects(f.secrets.load('agent-a', check), error => error instanceof Error && /verified or decrypted/.test(error.message) && !error.message.includes('secret detail'));
    assert.deepEqual(JSON.parse(await readFile(f.legacy, 'utf8')), [cookie]); await assert.rejects(readFile(f.target), { code: 'ENOENT' });
  } finally { await f.close(); } }
});
for (const alteration of ['ciphertext', 'tag', 'iv', 'agent', 'version', 'missing-key', 'wrong-key', 'missing-file'] as const) test(`encrypted session fails closed on ${alteration}`, async () => {
  const f = await fixture(); try {
    await f.secrets.save('agent-a', [cookie], check); const envelope = JSON.parse(await readFile(f.target, 'utf8'));
    if (alteration === 'missing-key') f.vault.values.clear(); else if (alteration === 'wrong-key') f.vault.values.set('browser-cookie-key-agent-a', Buffer.alloc(32).toString('base64'));
    else if (alteration === 'missing-file') await rm(f.target);
    else { envelope[alteration] = alteration === 'version' ? 2 : alteration === 'agent' ? 'agent-b' : Buffer.alloc(alteration === 'tag' ? 16 : alteration === 'iv' ? 12 : 8).toString('base64'); await writeFile(f.target, JSON.stringify(envelope)); }
    const reload = new BrowserSessionSecrets(f.root, f.vault); await assert.rejects(reload.load('agent-a', check), /verified or decrypted/); reload.close();
  } finally { await f.close(); }
});
test('conflicting encrypted and legacy values preserve both files and fail closed', async () => {
  const f = await fixture(); try { await f.secrets.save('agent-a', [cookie], check); await writeFile(f.legacy, JSON.stringify([{ ...cookie, value: 'different-session' }])); await assert.rejects(f.secrets.load('agent-a', check), /verified or decrypted/); assert.equal((await readFile(f.legacy, 'utf8')).includes('different-session'), true); } finally { await f.close(); }
});
test('an active session cannot silently overwrite a corrupt encrypted cookie payload', async () => {
  const f = await fixture(); try { await f.secrets.save('agent-a', [cookie], check); const damaged = JSON.stringify({ version: 2, ciphertext: 'invalid' }); await writeFile(f.target, damaged); await assert.rejects(f.secrets.save('agent-a', [cookie], check), /verified or decrypted/); assert.equal(await readFile(f.target, 'utf8'), damaged); } finally { await f.close(); }
});
test('cancelled key creation cannot commit or remove a legacy session', async () => {
  const f = await fixture(); try {
    await writeFile(f.legacy, JSON.stringify([cookie])); let valid = true; const original = f.vault.set; f.vault.set = async (...args) => { valid = false; await original(...args); };
    await assert.rejects(f.secrets.load('agent-a', () => { if (!valid) throw Error('revoked fixture'); }), /revoked fixture/);
    assert.equal((await readFile(f.legacy, 'utf8')).includes(cookie.value), true); await assert.rejects(readFile(f.target), { code: 'ENOENT' });
  } finally { await f.close(); }
});
for (const legacy of [false, true]) test(`cancellation after first key commit rolls back only the uncommitted key (${legacy ? 'legacy' : 'fresh'} profile)`, async () => {
  const f = await fixture(); try {
    if (legacy) await writeFile(f.legacy, JSON.stringify([cookie])); let valid = true; const original = f.vault.get;
    f.vault.get = async name => { const value = await original(name); if (value != null) valid = false; return value; };
    await assert.rejects(legacy ? f.secrets.load('agent-a', () => { if (!valid) throw Error('revoked fixture'); }) : f.secrets.save('agent-a', [cookie], () => { if (!valid) throw Error('revoked fixture'); }), /revoked fixture/);
    f.vault.get = original; assert.equal(f.vault.values.size, 0); await assert.rejects(readFile(f.target), { code: 'ENOENT' });
    assert.deepEqual(await f.secrets.load('agent-a', check), legacy ? [cookie] : []);
  } finally { await f.close(); }
});
test('oversized, malformed and non-session legacy cookies are preserved and rejected', async () => {
  for (const value of ['{invalid', JSON.stringify([{ ...cookie, expires: 123 }]), JSON.stringify([{ ...cookie, value: 'x'.repeat(65537) }]), ' '.repeat(4 * 1024 * 1024 + 1)]) { const f = await fixture(); try { await writeFile(f.legacy, value); await assert.rejects(f.secrets.load('agent-a', check), /verified or decrypted/); assert.equal(await readFile(f.legacy, 'utf8'), value); } finally { await f.close(); } }
});
test('hardlinked session files and junction profiles are rejected without changing their targets', async () => {
  const f = await fixture(); try {
    const source = join(f.root, 'source.json'); await writeFile(source, JSON.stringify([cookie])); await link(source, f.legacy); await assert.rejects(f.secrets.load('agent-a', check), /verified or decrypted/); assert.equal((await readFile(source, 'utf8')).includes(cookie.value), true);
    const outside = join(f.root, 'other-profile'); await mkdir(outside); await symlink(outside, join(f.root, 'browser', 'agent-b'), process.platform === 'win32' ? 'junction' : 'dir'); await assert.rejects(f.secrets.load('agent-b', check), /verified or decrypted/);
    await assert.rejects(f.secrets.load('../escape', check), /verified or decrypted/);
  } finally { await f.close(); }
});
test('concurrent first saves reuse one key and cached saves do not re-enter the DPAPI vault', async () => {
  const f = await fixture(); try {
    let writes = 0; const original = f.vault.set; f.vault.set = async (...args) => { writes++; await original(...args); };
    await Promise.all([f.secrets.save('agent-a', [cookie], check), f.secrets.save('agent-a', [cookie], check)]); assert.equal(writes, 1);
    f.vault.get = async () => { throw Error('must use cached verified key'); }; f.vault.set = async () => { throw Error('must use cached verified key'); };
    await f.secrets.save('agent-a', [cookie], check); assert.deepEqual(await f.secrets.load('agent-a', check), [cookie]);
  } finally { await f.close(); }
});
test('unavailable protection permits fresh in-memory browsing, reports persistence unavailable, and never writes plaintext', async () => {
  const f = await fixture(); try {
    f.vault.availability = () => ({ available: false }); f.vault.get = async () => { throw Error('unavailable vault must not be used'); };
    assert.deepEqual(await f.secrets.load('agent-a', check), []); assert.equal(f.secrets.unavailable(), true); await f.secrets.save('agent-a', [cookie], check); assert.deepEqual(await readdir(f.profile), []);
    await writeFile(f.legacy, JSON.stringify([cookie])); await assert.rejects(f.secrets.load('agent-a', check), /verified or decrypted/); await assert.rejects(f.secrets.save('agent-a', [cookie], check), /verified or decrypted/); assert.equal((await readFile(f.legacy, 'utf8')).includes(cookie.value), true);
  } finally { await f.close(); }
});
test('the final encrypted commit cannot yield between its authority check and rename', async () => {
  const f = await fixture(), nativeAsync = filesystem.rename, nativeSync = fs.renameSync;
  try {
    await f.secrets.save('agent-a', [cookie], check); let valid = true, asynchronousCommits = 0, synchronousCommits = 0;
    filesystem.rename = async (from, to) => { asynchronousCommits++; valid = false; await nativeAsync(from, to); };
    fs.renameSync = (from, to) => { assert.equal(valid, true, 'authority must still be valid at the non-yielding commit'); synchronousCommits++; nativeSync(from, to); };
    syncBuiltinESMExports();
    await f.secrets.save('agent-a', [{ ...cookie, value: 'authorized-next-synthetic-cookie' }], () => { if (!valid) throw Error('synthetic revoked before commit'); });
    assert.equal(asynchronousCommits, 0); assert.equal(synchronousCommits, 1);
    assert.equal((await f.secrets.load('agent-a', check))[0].value, 'authorized-next-synthetic-cookie');
  } finally { filesystem.rename = nativeAsync; fs.renameSync = nativeSync; syncBuiltinESMExports(); await f.close(); }
});
test('verified legacy removal cannot yield between its authority check and unlink', async () => {
  const f = await fixture(), nativeAsync = filesystem.unlink, nativeSync = fs.unlinkSync;
  try {
    await writeFile(f.legacy, JSON.stringify([cookie])); let valid = true, asynchronousRemovals = 0, synchronousRemovals = 0;
    filesystem.unlink = async path => { if (String(path) === f.legacy) { asynchronousRemovals++; valid = false; } await nativeAsync(path); };
    fs.unlinkSync = path => { if (String(path) === f.legacy) { assert.equal(valid, true, 'authority must still be valid at the non-yielding removal'); synchronousRemovals++; } nativeSync(path); };
    syncBuiltinESMExports();
    assert.deepEqual(await f.secrets.load('agent-a', () => { if (!valid) throw Error('synthetic revoked before legacy removal'); }), [cookie]);
    assert.equal(asynchronousRemovals, 0); assert.equal(synchronousRemovals, 1); await assert.rejects(readFile(f.legacy), { code: 'ENOENT' });
  } finally { filesystem.unlink = nativeAsync; fs.unlinkSync = nativeSync; syncBuiltinESMExports(); await f.close(); }
});
test('revocation during the last async validation preserves the previous encrypted bytes', async () => {
  const f = await fixture(), nativeStat = filesystem.lstat; let release: () => void = () => {};
  try {
    await f.secrets.save('agent-a', [cookie], check); const before = await readFile(f.target); let valid = true, entered!: () => void, held = false;
    const started = new Promise<void>(done => entered = done), gate = new Promise<void>(done => release = done);
    filesystem.lstat = (async (...args: Parameters<typeof filesystem.lstat>) => {
      if (!held && String(args[0]) === f.target && fs.readdirSync(f.profile).some(name => name.endsWith('.tmp'))) { held = true; entered(); await gate; }
      return nativeStat(...args);
    }) as typeof filesystem.lstat; syncBuiltinESMExports();
    const pending = f.secrets.save('agent-a', [{ ...cookie, value: 'revoked-synthetic-cookie' }], () => { if (!valid) throw Error('synthetic revoked before commit'); }), result = Promise.allSettled([pending]);
    await started; valid = false; release(); const [outcome] = await result; assert.equal(outcome.status, 'rejected');
    assert.deepEqual(await readFile(f.target), before); assert.equal((await f.secrets.load('agent-a', check))[0].value, cookie.value);
    assert.equal((await readdir(f.profile)).some(name => name.endsWith('.tmp')), false);
  } finally { release(); filesystem.lstat = nativeStat; syncBuiltinESMExports(); await f.close(); }
});
test('revocation during the final legacy validation preserves its verified source', async () => {
  const f = await fixture(), nativeStat = filesystem.lstat; let release: () => void = () => {};
  try {
    await writeFile(f.legacy, JSON.stringify([cookie])); let valid = true, entered!: () => void, held = false;
    const started = new Promise<void>(done => entered = done), gate = new Promise<void>(done => release = done);
    filesystem.lstat = (async (...args: Parameters<typeof filesystem.lstat>) => {
      if (!held && String(args[0]) === f.legacy && fs.existsSync(f.target)) { held = true; entered(); await gate; }
      return nativeStat(...args);
    }) as typeof filesystem.lstat; syncBuiltinESMExports();
    const pending = f.secrets.load('agent-a', () => { if (!valid) throw Error('synthetic revoked before legacy removal'); }), result = Promise.allSettled([pending]);
    await started; valid = false; release(); const [outcome] = await result; assert.equal(outcome.status, 'rejected');
    assert.deepEqual(JSON.parse(await readFile(f.legacy, 'utf8')), [cookie]);
    assert.deepEqual(await f.secrets.load('agent-a', check), [cookie]); await assert.rejects(readFile(f.legacy), { code: 'ENOENT' });
  } finally { release(); filesystem.lstat = nativeStat; syncBuiltinESMExports(); await f.close(); }
});
