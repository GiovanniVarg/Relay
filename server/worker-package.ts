import { constants } from 'node:fs';
import { createHash, X509Certificate } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { WORKER_PACKAGE_FILES } from './worker-package-manifest.js';
import { HttpError } from './security.js';
import type { WorkerPublicProfile } from './worker-connection.js';

const MAX_FILE = 8 * 1024 * 1024, MAX_RAW = 48 * 1024 * 1024, MAX_ZIP = 32 * 1024 * 1024, MAX_FILES = 1200;
const SHIPPED = new Set(WORKER_PACKAGE_FILES);
const CORE = ['package.json', 'package-lock.json', 'server/worker-cli.ts', 'client/index.html'];
interface Entry { name: string; bytes: Buffer; executable?: boolean }
const fail = (): never => { throw new HttpError(409, 'A complete, bounded Relay build is required for the worker package'); };
function validName(name: string): boolean {
  return !!name && !isAbsolute(name) && !/[\\:\u0000-\u001f\u007f]/.test(name)
    && name.split('/').every(part => !!part && part !== '.' && part !== '..');
}
async function readShipped(root: string, name: string, limit = MAX_FILE): Promise<Buffer> {
  if (!validName(name)) return fail();
  const path = resolve(root, name), rel = relative(root, path);
  if (!rel || rel.startsWith('..' + sep) || isAbsolute(rel)) return fail();
  let cursor = root;
  for (const part of name.split('/')) {
    cursor = resolve(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink()) return fail();
  }
  if (await realpath(path) !== path) return fail();
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > limit) return fail();
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) { const read = await file.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) return fail(); offset += read.bytesRead; }
    const after = await file.stat(), named = await lstat(path);
    if (!named.isFile() || named.isSymbolicLink() || named.ino !== before.ino || named.dev !== before.dev
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino || after.nlink !== 1) return fail();
    return bytes;
  } finally { await file.close(); }
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Buffer): number {
  let value = 0xffffffff; for (const byte of bytes) value = crcTable[(value ^ byte) & 255]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function zip(entries: Entry[]): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0, centralSize = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), data = deflateRawSync(entry.bytes, { level: 6 }), crc = crc32(entry.bytes);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8); header.writeUInt16LE(0x2821, 12);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(entry.bytes.length, 22); header.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(0x0314, 4);
    directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(8, 10); directory.writeUInt16LE(0x2821, 14);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(entry.bytes.length, 24); directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(((entry.executable ? 0o100755 : 0o100644) << 16) >>> 0, 38); directory.writeUInt32LE(offset, 42);
    local.push(header, name, data); central.push(directory, name); offset += header.length + name.length + data.length; centralSize += directory.length + name.length;
    if (offset + centralSize + 22 > MAX_ZIP) return fail();
  }
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

const WINDOWS_SETUP = `@echo off\r
setlocal\r
cd /d "%~dp0"\r
title Relay Worker Setup\r
echo Relay Worker - local setup\r
echo Requires Node.js 22.13 or newer and npm already installed.\r
echo OpenAI needs the official Codex CLI. Claude needs the official Claude Code CLI.\r
echo Cursor uses its official SDK browser sign-in in Relay local setup.\r
echo This script does not install Node, provider CLIs, or browsers and never signs you in silently.\r
where node >nul 2>nul\r
if errorlevel 1 goto missing\r
where npm >nul 2>nul\r
if errorlevel 1 goto missing\r
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"\r
if errorlevel 1 goto missing\r
if exist "node_modules\\.package-lock.json" goto run\r
echo.\r
echo Relay needs its pinned npm runtime dependencies. This downloads only this package's dependencies.\r
choice /C YN /M "Install Relay runtime dependencies now"\r
if errorlevel 2 goto done\r
set PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1\r
call npm ci --omit=dev --no-audit --no-fund\r
if errorlevel 1 goto failed\r
:run\r
echo.\r
echo Compare the public CA fingerprint with the host. Enter the one-time code only when prompted.\r
node --no-warnings dist\\server\\worker-cli.js --profile relay-connection.json\r
if errorlevel 1 goto failed\r
goto done\r
:missing\r
echo Install Node.js 22.13 or newer with npm yourself, then run this setup again.\r
goto done\r
:failed\r
echo Worker setup could not finish. Check the displayed local instructions and your host connection.\r
:done\r
pause\r
endlocal\r
`;
const MAC_SETUP = `#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
finish() { result=$?; if [ "$result" -ne 0 ]; then printf '\\nWorker setup could not finish. Check local prerequisites and the host connection.\\n'; fi; read -r -p 'Press Return to close this window. ' _ || true; }
trap finish EXIT
printf '%s\\n' 'Relay Worker - local setup' 'Requires Node.js 22.13 or newer and npm already installed.' 'OpenAI needs the official Codex CLI. Claude needs the official Claude Code CLI.' 'Cursor uses its official SDK browser sign-in in Relay local setup.' 'This script does not install Node, provider CLIs, or browsers and never signs you in silently.'
command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 || { printf '%s\\n' 'Install Node.js with npm yourself, then run setup again.'; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'
if [ ! -f node_modules/.package-lock.json ]; then
  printf '%s\\n' 'Relay needs its pinned npm runtime dependencies. This downloads only this package’s dependencies.'
  read -r -p 'Install Relay runtime dependencies now? [y/N] ' answer
  case "$answer" in y|Y|yes|YES) PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev --no-audit --no-fund ;; *) exit 0 ;; esac
fi
printf '%s\\n' 'Compare the public CA fingerprint with the host. Enter the one-time code only when prompted.'
node --no-warnings dist/server/worker-cli.js --profile relay-connection.json
`;
const README = `Relay Worker

Extract this ZIP before running setup. Keep relay-connection.json beside the setup files.
Windows: run Setup Relay Worker.cmd. Mac: run Setup Relay Worker.command.
If macOS blocks opening the command, use Finder's Open action or run it from your own Terminal with bash.

Prerequisites: Node.js 22.13 or newer with npm. Install official Codex / Claude Code CLIs yourself for the providers you intend to use. Cursor uses the official SDK browser flow.
Setup asks before installing Relay's pinned npm runtime dependencies. No Node, CLI, or browser installer is run.

Keep this computer and the host on the same LAN. Compare the CA fingerprint with the host UI before trusting the profile. Enter the fresh worker code in the prompt; it is never placed in a command line or this package.
Use the displayed loopback setup address to sign in on this computer and explicitly approve provider usage and models. Existing host accounts, tokens, cookies, and credentials are not copied.
Keep the setup window running for assigned work. Stop it with Ctrl+C. A disconnected offline computer may continue accepted work; inspect its last result.

The included connection file is public: host URL, public CA certificate, and SHA-256 fingerprint only. Private identity is created on this computer and protected by its Windows DPAPI / macOS Keychain. There is no plaintext credential fallback.
`;

export async function buildWorkerPackage(installation: string, profile: WorkerPublicProfile,
  options: { sourceFiles?: readonly string[]; maximumBytes?: number } = {}): Promise<Buffer> {
  try {
    const ca = new X509Certificate(profile.ca.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0]??'');
    if (!ca.ca || !ca.verify(ca.publicKey) || ca.subject !== ca.issuer
      || createHash('sha256').update(ca.raw).digest('hex') !== profile.fingerprint || profile.ca.length > 8192) return fail();
    const host = new URL(profile.url);
    if (host.protocol !== 'https:' || host.username || host.password || host.search || host.hash || host.pathname !== '/') return fail();
    if ((await lstat(installation)).isSymbolicLink()) return fail();
    const root = await realpath(installation), sourceFiles = options.sourceFiles ?? WORKER_PACKAGE_FILES;
    if (sourceFiles.length > MAX_FILES || CORE.some(name => !sourceFiles.includes(name))
      || sourceFiles.some(name => !SHIPPED.has(name) || !validName(name))) return fail();
    const entries: Entry[] = []; const included = new Set<string>(); let total = 0;
    const add = (entry: Entry) => {
      if (!validName(entry.name) || included.has(entry.name) || entries.length >= MAX_FILES) return fail();
      total += entry.bytes.length;
      if (total > Math.min(options.maximumBytes ?? MAX_RAW, MAX_RAW)) return fail();
      included.add(entry.name); entries.push(entry);
    };
    for (const name of sourceFiles) {
      const bytes = await readShipped(root, name);
      if (name === 'package-lock.json') {
        const lock = JSON.parse(bytes.toString('utf8')) as { packages?: Record<string, { resolved?: unknown }> };
        for (const item of Object.values(lock.packages ?? {})) if (typeof item.resolved === 'string' && /^https?:/i.test(item.resolved)) {
          const resolved = new URL(item.resolved);
          if (resolved.username || resolved.password || [...resolved.searchParams.keys()].some(key => /token|auth|key|sig/i.test(key))) return fail();
        }
      }
      add({ name, bytes });
      if (/^(?:server|shared)\/.*\.ts$/.test(name) && !name.endsWith('.d.ts')) {
        const compiled = 'dist/' + name.replace(/\.ts$/, '.js'); add({ name: compiled, bytes: await readShipped(root, compiled) });
      }
    }
    for (const entry of entries.filter(entry => /^dist\/(?:server|shared)\/.*\.js$/.test(entry.name))) {
      const references = [...entry.bytes.toString('utf8').matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|new\s+URL\s*\(\s*)["'](\.[^"']+\.js)["']/g)];
      for (const [, reference] of references) {
        const target = relative(root, resolve(root, dirname(entry.name), reference!)).split(sep).join('/');
        if (!included.has(target)) return fail();
      }
    }
    const index = await readShipped(root, 'dist/client/index.html'); add({ name: 'dist/client/index.html', bytes: index });
    for (const name of sourceFiles.filter(name => name.startsWith('client/public/'))) {
      const compiled = name.replace('client/public/', 'dist/client/'); add({ name: compiled, bytes: await readShipped(root, compiled) });
    }
    const pending = [{ name: 'dist/client/index.html', bytes: index }], visited = new Set<string>();
    while (pending.length) {
      const current = pending.pop()!; if (visited.has(current.name)) continue; visited.add(current.name);
      const text = current.bytes.toString('utf8');
      const references = [...text.matchAll(/["'`(]\s*((?:\/?assets\/|\.{1,2}\/)?[A-Za-z0-9_./-]+-[A-Za-z0-9_-]{8,}\.(?:m?js|css|svg|png|webp|jpe?g|woff2?|ttf|wasm))(?=["'`)\s?#])/g)];
      for (const [, reference] of references) {
        const path = reference!.startsWith('/') ? 'dist/client/'+reference!.slice(1) : reference!.startsWith('assets/') ? 'dist/client/'+reference!
          : relative(root, resolve(root, dirname(current.name), reference!)).split(sep).join('/');
        if(included.has(path))continue;
        if (!/^dist\/client\/assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(?:m?js|css|svg|png|webp|jpe?g|woff2?|ttf|wasm)$/.test(path)) return fail();
        if (included.has(path)) continue;
        const bytes = await readShipped(root, path); add({ name: path, bytes });
        if (/\.(?:m?js|css)$/.test(path)) pending.push({ name: path, bytes });
      }
    }
    add({ name: 'relay-connection.json', bytes: Buffer.from(JSON.stringify({ url: host.origin, ca: ca.toString(), fingerprint: profile.fingerprint }, null, 2) + '\n') });
    add({ name: 'Setup Relay Worker.cmd', bytes: Buffer.from(WINDOWS_SETUP) });
    add({ name: 'Setup Relay Worker.command', bytes: Buffer.from(MAC_SETUP), executable: true });
    add({ name: 'READ ME FIRST.txt', bytes: Buffer.from(README) });
    return zip(entries.sort((a, b) => a.name.localeCompare(b.name)));
  } catch { return fail(); }
}
