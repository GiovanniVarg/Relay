import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, unlink, link, rename, symlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fromBuffer, type Entry as ZipEntry } from 'yauzl';
import { buildWorkerPackage } from '../server/worker-package.js';
import { NetworkCertificates } from '../server/network-certificates.js';
import { Store } from '../server/store.js';

const FILES = ['package.json', 'package-lock.json', 'server/worker-cli.ts', 'shared/types.ts', 'client/index.html','client/public/relay-controller-sw.js'];
async function entries(bytes: Buffer): Promise<Map<string, { bytes: Buffer; mode: number }>> {
  return new Promise((resolve, reject) => fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true }, (error, archive) => {
    if (error || !archive) { reject(error); return; }
    const result = new Map<string, { bytes: Buffer; mode: number }>();
    archive.once('error', reject); archive.once('end', () => resolve(result));
    archive.on('entry', (entry: ZipEntry) => archive.openReadStream(entry, (error, stream) => {
      if (error || !stream) { archive.close(); reject(error); return; }
      const chunks: Buffer[] = []; stream.on('data', chunk => chunks.push(Buffer.from(chunk))); stream.once('error', reject);
      stream.once('end', () => { result.set(entry.fileName, { bytes: Buffer.concat(chunks), mode: entry.externalFileAttributes >>> 16 }); archive.readEntry(); });
    }));
    archive.readEntry();
  }));
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'relay-worker-package-'));
  const put = async (path: string, value: string | Buffer) => { const file = join(directory, path); await mkdir(dirname(file), { recursive: true }); await writeFile(file, value); };
  for (const file of FILES) await put(file, file.endsWith('.json') ? '{}' : 'export {};');
  await put('dist/server/worker-cli.js', 'export {};'); await put('dist/shared/types.js', 'export {};');
  await put('dist/client/index.html', '<script type="module" src="/assets/index-12345678.js"></script><link rel="stylesheet" href="/assets/index-87654321.css">');
  await put('dist/client/relay-controller-sw.js','export {};');
  await put('dist/client/assets/index-12345678.js', 'import "./chunk-abcdefgh.js"; const publicWorker="/relay-controller-sw.js";');
  await put('dist/client/assets/chunk-abcdefgh.js', 'export {};');
  await put('dist/client/assets/index-87654321.css', 'body{background:url("/assets/font-01234567.woff2")}');
  await put('dist/client/assets/font-01234567.woff2', Buffer.from('fixture-font'));
  const store = new Store(join(directory, 'data'));
  const secrets = new Map<string, string>();
  const vault = { async get(name: string) { return secrets.get(name) ?? null; }, async set(name: string, value: string) { secrets.set(name, value); }, async remove(name: string) { secrets.delete(name); } };
  const material = await new NetworkCertificates(store, vault).material('192.168.1.15');
  const profile = { url: 'https://192.168.1.15:3443', ca: material.ca, fingerprint: material.rootFingerprint };
  return { directory, put, profile, secrets, async cleanup() { store.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('ZIP contains exact source/build and referenced client assets, public profile, and runnable setup entry points', async () => {
  const f = await fixture();
  try {
    const bytes = await buildWorkerPackage(f.directory, f.profile, { sourceFiles: FILES });
    const zip = await entries(bytes);
    for (const file of [...FILES, 'dist/server/worker-cli.js', 'dist/shared/types.js', 'dist/client/index.html',
      'dist/client/assets/index-12345678.js', 'dist/client/assets/chunk-abcdefgh.js', 'dist/client/assets/font-01234567.woff2',
      'Setup Relay Worker.cmd', 'Setup Relay Worker.command', 'relay-connection.json']) assert.equal(zip.has(file), true, file);
    const profile = JSON.parse(zip.get('relay-connection.json')!.bytes.toString());
    assert.deepEqual(Object.keys(profile).sort(), ['ca', 'fingerprint', 'url']);
    assert.equal(profile.fingerprint, f.profile.fingerprint);
    assert.equal(zip.get('Setup Relay Worker.command')!.mode & 0o111, 0o111);
    const windows = zip.get('Setup Relay Worker.cmd')!.bytes.toString(), mac = zip.get('Setup Relay Worker.command')!.bytes.toString();
    assert.match(windows, /choice \/C YN/); assert.match(mac, /read -r -p 'Install Relay runtime/);
    for (const script of [windows, mac]) {
      assert.match(script, /npm ci --omit=dev/); assert.match(script, /PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1/);
      assert.match(script, /worker-cli\.js/); assert.doesNotMatch(script, /--code|npx|curl|brew install|winget|choco|npm install -g/);
      assert.match(script, /--profile relay-connection\.json/);
    }
  } finally { await f.cleanup(); }
});

test('excludes runtime data, env, credentials, node_modules, evidence, unlisted source, and unreferenced hashed assets', async () => {
  const f = await fixture();
  try {
    const secret = 'fixture-private-sentinel-not-shipped';
    for (const name of ['.env', '.npmrc', '.git/config', 'data/account.json', 'profiles/auth.json',
      'evidence/transcript.json', 'node_modules/private.json', 'server/unlisted-secret.ts', 'dist/server/unlisted-secret.js',
      'dist/client/assets/private-deadbeef.js']) await f.put(name, secret);
    const zip = await entries(await buildWorkerPackage(f.directory, f.profile, { sourceFiles: FILES }));
    assert.equal([...zip.keys()].some(name => /(?:^|\/)(?:data|profiles|evidence|node_modules|\.git)(?:\/|$)|\.env|\.npmrc|unlisted-secret|private-deadbeef/.test(name)), false);
    assert.equal([...zip.values()].some(entry => entry.bytes.includes(secret)), false);
    for (const privateKey of f.secrets.values()) assert.equal([...zip.values()].some(entry => entry.bytes.includes(privateKey)), false);
    await assert.rejects(buildWorkerPackage(f.directory, f.profile, { sourceFiles: [...FILES, 'server/unlisted-secret.ts'] }));
  } finally { await f.cleanup(); }
});

test('requires a complete build, rejects missing runtime imports and bounds total bytes', async () => {
  const f = await fixture();
  try {
    await assert.rejects(buildWorkerPackage(f.directory, f.profile, { sourceFiles: FILES, maximumBytes: 256 }));
    await f.put('dist/server/worker-cli.js', 'import "./not-shipped.js";');
    await assert.rejects(buildWorkerPackage(f.directory, f.profile, { sourceFiles: FILES }));
    await unlink(join(f.directory, 'dist/server/worker-cli.js'));
    await assert.rejects(buildWorkerPackage(f.directory, f.profile, { sourceFiles: FILES }));
  } finally { await f.cleanup(); }
});

test('refuses credential-bearing package-lock URLs rather than copying registry credentials', async () => {
  const f = await fixture();
  try {
    await f.put('package-lock.json', JSON.stringify({ packages: { dependency: { resolved: 'https://user:private-token@registry.example/package.tgz' } } }));
    await assert.rejects(buildWorkerPackage(f.directory, f.profile, { sourceFiles: FILES }));
  } finally { await f.cleanup(); }
});

test('rejects hardlinked files and symbolic-link/junction ancestors instead of following them', async () => {
  const f = await fixture();
  try {
    const source = join(f.directory, 'server/worker-cli.ts'), copy = await readFile(source);
    await unlink(source); await f.put('private-file', 'not for the archive'); await link(join(f.directory, 'private-file'), source);
    await assert.rejects(buildWorkerPackage(f.directory, f.profile, { sourceFiles: FILES }));
    await unlink(source); await writeFile(source, copy);
    await rename(join(f.directory, 'server'), join(f.directory, 'server-original'));
    await symlink(join(f.directory, 'server-original'), join(f.directory, 'server'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(buildWorkerPackage(f.directory, f.profile, { sourceFiles: FILES }));
  } finally { await f.cleanup(); }
});

test('canonicalizes the public certificate and never copies extra profile fields or appended private PEM', async () => {
  const f = await fixture();
  try {
    const privateKey = f.secrets.get('network-ca-key')!;
    const profile = { ...f.profile, ca: f.profile.ca + privateKey, code: 'NEVER-IN-ARCHIVE', privateKey };
    const zip = await entries(await buildWorkerPackage(f.directory, profile, { sourceFiles: FILES }));
    const publicFile = zip.get('relay-connection.json')!.bytes.toString();
    assert.equal(publicFile.includes('PRIVATE KEY'), false); assert.equal(publicFile.includes('NEVER-IN-ARCHIVE'), false);
    assert.deepEqual(Object.keys(JSON.parse(publicFile)).sort(), ['ca', 'fingerprint', 'url']);
  } finally { await f.cleanup(); }
});


test('declaration sources ship without requiring fabricated runtime modules', async () => {
  const f = await fixture();
  try {
    const declaration = 'server/network-transport-native.d.ts';
    const source = 'declare module "@fails-components/webtransport" { export class Http3Server {} }\n';
    await f.put(declaration, source);
    const sourceFiles = [...FILES, declaration];
    const zip = await entries(await buildWorkerPackage(f.directory, f.profile, { sourceFiles }));
    assert.equal(zip.get(declaration)?.bytes.toString(), source);
    assert.equal(zip.has('dist/server/network-transport-native.d.js'), false);
    assert.equal(zip.has('dist/server/worker-cli.js'), true);
    // A declaration is not a runtime import target: completeness checks still reject a real JS
    // dependency that has no emitted or shipped module, even when its declaration source exists.
    await f.put('dist/server/worker-cli.js', 'import "./network-transport-native.d.js";');
    await assert.rejects(buildWorkerPackage(f.directory, f.profile, { sourceFiles }));
  } finally { await f.cleanup(); }
});
