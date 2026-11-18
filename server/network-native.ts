import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

/** Publisher release v1.6.12, N-API 6. Both archive and contained binary were verified.
 * https://github.com/fails-components/webtransport/releases/tag/v1.6.12
 * Do not execute dependency install scripts or fall back to an unverified local build.
 */
export const TRANSPORT_NATIVE_RELEASES: Readonly<Record<string, { archiveBytes: number; archiveHash: string; bytes: number; hash: string }>> = {
  'win32-x64': { archiveBytes: 2430768, archiveHash: 'e938b04f0ce8853c68922d7a61b30bdd66c8cd8b053ce2f6fb0ebd6020f44e1d', bytes: 5378048, hash: 'f4f25c0941a8daf648c8a757c460abd679cd12afe6d70fe28d87775053947a87' },
  'darwin-arm64': { archiveBytes: 2925537, archiveHash: '0e1de09c9d13921d3f67418e2748a2165738215f81cd067d525680734235ae17', bytes: 6922912, hash: '91b438d203dab312459ef38a804d858e86f0e249fd49f5eba28960998e88a1bf' },
  'darwin-x64': { archiveBytes: 3084656, archiveHash: '2e7ba1bcca0dcca6098ed98eaa1ad6f8f57c9ad8efd3b9e9c2f2aab67e0d858e', bytes: 7438832, hash: 'd001d6b699a487c81c49cbfd21d0a5ff442f285bee536d23308394ea9f2e22bd' },
  'linux-arm64': { archiveBytes: 4358250, archiveHash: 'db344c15cd4c0f8e9825580d83e65f22708c32eabda7a02786c6b0512489af28', bytes: 10675360, hash: '9d3726982c16d7ad69369d641ebeba4eca58dfee281bdbb2b08fd211fee2e0f4' },
  'linux-x64': { archiveBytes: 4651292, archiveHash: 'f4d3ba3872bb83e66309a0916f2aa143126e6035bf7deb192694f5c0b545e1a2', bytes: 11633880, hash: 'c046d742c8c4323f3a4fdf7935e117124c3b38d540f4e40f332f81049650a97a' },
};
const unavailable = () => new Error('The verified local-network transport component is unavailable. Check your connection and Relay installation.');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Extract only the single, fixed publisher entry; never extract arbitrary archive paths. */
export function extractTransportNative(archive: Buffer, release: typeof TRANSPORT_NATIVE_RELEASES[string]): Buffer {
  if (archive.length !== release.archiveBytes || sha256(archive) !== release.archiveHash) throw unavailable();
  const tar = gunzipSync(archive, { maxOutputLength: 16 * 1024 * 1024 });
  if (tar.length < 1024 || tar.subarray(0, 100).toString().replace(/\0.*$/s, '') !== 'build/Release/webtransport.node'
    || ![0, 48].includes(tar[156]!) || tar.subarray(157, 257).some(byte => byte !== 0)
    || tar.subarray(345, 500).some(byte => byte !== 0)) throw unavailable();
  const sizeText = tar.subarray(124, 136).toString().replace(/\0.*$/s, '').trim();
  if (!/^[0-7]+$/.test(sizeText) || parseInt(sizeText, 8) !== release.bytes) throw unavailable();
  const end = 512 + release.bytes, padded = 512 + Math.ceil(release.bytes / 512) * 512;
  if (padded + 1024 > tar.length || tar.subarray(padded).some(byte => byte !== 0)) throw unavailable();
  const binary = tar.subarray(512, end);
  if (sha256(binary) !== release.hash) throw unavailable();
  return binary;
}

async function safePath(path: string, missing = false): Promise<boolean> {
  const chain: string[] = []; let cursor = resolve(path);
  while (true) { chain.push(cursor); const parent = dirname(cursor); if (parent === cursor) break; cursor = parent; }
  for (const entry of chain.reverse()) {
    let stat;
    try { stat = await lstat(entry); }
    catch (error) { if (missing && (error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw unavailable(); }
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1)) throw unavailable();
  }
  return true;
}
async function verifiedFile(path: string, release: typeof TRANSPORT_NATIVE_RELEASES[string]): Promise<boolean> {
  if (!await safePath(path, true)) return false;
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== release.bytes) throw unavailable();
    const bytes = Buffer.alloc(release.bytes + 1), result = await handle.read(bytes, 0, bytes.length, 0);
    if (result.bytesRead !== release.bytes || sha256(bytes.subarray(0, result.bytesRead)) !== release.hash) throw unavailable();
    await safePath(path);
    return true;
  } finally { await handle.close(); }
}
let preparation: Promise<void> | undefined;
export function ensureNetworkNativeTransport(): Promise<void> {
  return preparation ??= prepare().catch(error => { preparation = undefined; throw error; });
}
async function prepare(): Promise<void> {
  const platform = `${process.platform}-${process.arch}`, release = TRANSPORT_NATIVE_RELEASES[platform];
  if (!release) throw new Error('QR connections are not available for this host architecture. Use a supported Windows x64, macOS, or Linux host.');
  const require = createRequire(import.meta.url);
  const packageRoot = resolve(dirname(require.resolve('@fails-components/webtransport-transport-http3-quiche')), '..');
  await safePath(packageRoot);
  const metadata = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as { name?: string; version?: string };
  if (metadata.name !== '@fails-components/webtransport-transport-http3-quiche' || metadata.version !== '1.6.12') throw unavailable();
  const ownBuild = join(packageRoot, `build_${process.platform}_${process.arch}`);
  if (await safePath(ownBuild, true)) {
    // The publisher wrapper prefers this directory over its default prebuild directory.
    if (process.env.NODE_ENV !== 'production' && await safePath(join(ownBuild, 'Debug', 'webtransport.node'), true)) throw unavailable();
    if (!await verifiedFile(join(ownBuild, 'Release', 'webtransport.node'), release)) throw unavailable();
    return;
  }
  const target = join(packageRoot, 'build', 'Release', 'webtransport.node');
  if (process.env.NODE_ENV !== 'production' && await safePath(join(packageRoot, 'build', 'Debug', 'webtransport.node'), true)) throw unavailable();
  if (await verifiedFile(target, release)) return;
  const url = `https://github.com/fails-components/webtransport/releases/download/v1.6.12/webtransport-transport-http3-quiche-v1.6.12-napi-v6-${platform}.tar.gz`;
  const response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body || new URL(response.url).protocol !== 'https:' || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(new URL(response.url).hostname)) throw unavailable();
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > release.archiveBytes) throw unavailable(); chunks.push(next.value); }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const binary = extractTransportNative(Buffer.concat(chunks), release), directory = dirname(target);
  for (const entry of [join(packageRoot, 'build'), directory]) {
    if (!await safePath(entry, true)) await mkdir(entry, { mode: 0o700 });
    await safePath(entry);
  }
  const temporary = join(directory, `.relay-native-${randomUUID()}.tmp`);
  let created = false;
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); created = true;
    try { await handle.writeFile(binary); await handle.sync(); } finally { await handle.close(); }
    if (!await verifiedFile(temporary, release)) throw unavailable();
    if (await safePath(target, true)) { if (!await verifiedFile(target, release)) throw unavailable(); return; }
    await safePath(directory);
    try { await link(temporary, target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!await verifiedFile(target, release)) throw unavailable();
      return;
    }
    await unlink(temporary); created = false;
    if (!await verifiedFile(target, release)) throw unavailable();
  } finally { if (created) await unlink(temporary).catch(() => {}); }
}
