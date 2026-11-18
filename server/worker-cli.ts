import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir, hostname } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { WorkerConnection, type WorkerPublicProfile } from './worker-connection.js';
import { createNativeWorkerExecutor, WorkerRuntime, type NativeWorkerApp, type WorkerJournal } from './worker-runtime.js';
import { createPlatformSecretVault } from './mac-secret-vault.js';

export interface WorkerCliOptions { profile?: string; dataDirectory: string; name: string; subscriptionOnly: boolean; clearIdentity: boolean }
export function parseWorkerArguments(args: string[]): WorkerCliOptions {
  const result: WorkerCliOptions = { dataDirectory: join(homedir(), '.relay', 'worker'), name: hostname(), subscriptionOnly: false, clearIdentity: false };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--subscription-only') result.subscriptionOnly = true;
    else if (key === '--clear-identity') result.clearIdentity = true;
    else if (['--profile', '--data-dir', '--name'].includes(key)) {
      const value = args[++i]; if (!value || value.startsWith('--')) throw new Error('A worker option is missing its value');
      if (key === '--profile') result.profile = resolve(value); else if (key === '--data-dir') result.dataDirectory = resolve(value); else result.name = value;
    } else throw new Error('Unknown worker option. Pairing codes must be entered at the prompt.');
  }
  if (!result.name.trim() || result.name.length > 80) throw new Error('Invalid worker name');
  return result;
}
function packageDirectory() {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(directory, 'package.json'))) { const parent = dirname(directory); if (directory === parent) throw new Error('Worker installation is incomplete'); directory = parent; }
  return directory;
}
export async function promptWorkerProfilePath(prompt: { question(query: string): Promise<string> }, fallback = resolve('relay-connection.json')): Promise<string> {
  let value = (await prompt.question('Public connection profile path [relay-connection.json]: ')).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  return value ? resolve(value) : resolve(fallback);
}
export function readWorkerPublicProfile(path: string): WorkerPublicProfile {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16384) throw new Error('Invalid public profile');
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'ca,fingerprint,url'
      || typeof value.url !== 'string' || typeof value.ca !== 'string' || typeof value.fingerprint !== 'string') throw new Error('Invalid public profile');
    const ca = new X509Certificate(value.ca), fingerprint = value.fingerprint.replace(/^sha256[:/-]?/i, '').replace(/:/g, '').toLowerCase();
    if (!ca.ca || !ca.verify(ca.publicKey) || ca.subject !== ca.issuer || Date.parse(ca.validTo) <= Date.now()
      || createHash('sha256').update(ca.raw).digest('hex') !== fingerprint) throw new Error('Invalid public profile');
    const url = new URL(value.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || url.pathname !== '/') throw new Error('Invalid public profile');
    return { url: url.origin, ca: ca.toString(), fingerprint };
  } catch { throw new Error('Choose a valid public Relay connection profile'); }
}
export async function workerMain(args = process.argv.slice(2)) {
  const options = parseWorkerArguments(args); await mkdir(options.dataDirectory, { recursive: true });
  const vault = createPlatformSecretVault(options.dataDirectory), connection = new WorkerConnection(vault);
  let app: Awaited<ReturnType<typeof import('./index.js')['createApp']>> | undefined;
  let runtime: WorkerRuntime | undefined;
  try {
    const protection = await vault.availability(); if (!protection.available) throw new Error('Secure local credential storage is unavailable');
    if (options.clearIdentity) await connection.clearIdentity();
    const loaded = await connection.load();
    if (!loaded) {
      const prompt = createInterface({ input: stdin, output: stdout });
      let code: string, info: WorkerPublicProfile;
      try {
        const profilePath = options.profile ?? await promptWorkerProfilePath(prompt);
        info = readWorkerPublicProfile(profilePath);
        stdout.write('Compare this public CA fingerprint with the host UI before pairing:\n' + info.fingerprint + '\n');
        if ((await prompt.question('Does the fingerprint match the host? Type yes to continue: ')).trim().toLowerCase() !== 'yes') throw new Error('Host trust was not confirmed');
        code = (await prompt.question('Enter the worker pairing code: ')).trim();
      } finally { prompt.close(); }
      await connection.pair(info, code, options.name); stdout.write('Worker paired.\n');
    } else if (options.profile) {
      const info = readWorkerPublicProfile(options.profile), saved = connection.publicProfile();
      if (info.url.replace(/\/$/, '') !== saved?.url || info.fingerprint.replace(/:/g, '').toLowerCase() !== saved.fingerprint) throw new Error('The profile differs from the paired controller; clear the identity explicitly before re-pairing');
    }
    const installDirectory = packageDirectory(), { createApp } = await import('./index.js');
    app = await createApp({ dataDir: options.dataDirectory, installDirectory, clientDir: join(installDirectory, 'dist', 'client'), secretVault: vault, port: 0 });
    const port = await app.listen(0); stdout.write('Worker local setup: http://127.0.0.1:' + port + '\n');
    if (!options.subscriptionOnly) stdout.write('Use local setup to authenticate this computer and approve its provider billing policy.\n');
    const executor = await createNativeWorkerExecutor(app as unknown as NativeWorkerApp, { name: options.name, subscriptionOnly: options.subscriptionOnly });
    const store = app.store;
    runtime = new WorkerRuntime(connection, executor, { get: id => store.get<WorkerJournal>('worker-journal', id), put: record => store.put('worker-journal', record) });
    const abort = new AbortController(), stop = () => abort.abort(); process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try { stdout.write('Worker connected. Waiting for assigned jobs.\n'); await runtime.run(abort.signal); if (runtime.lastError) stdout.write(runtime.lastError + '\n'); }
    finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  } finally { if (runtime) await runtime.stop(); if (app) await app.close(); else await vault.close(); }
}
const invokedFile = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedFile) workerMain().catch(() => { process.stderr.write('Worker could not continue. Check local setup, the public connection profile, and controller authorization.\n'); process.exitCode = 1; });

