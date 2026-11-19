import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { createConnection, createServer } from 'node:net';

/**
 * Disposable GitHub release-CI integration, intentionally outside tests/*.test.ts.
 * Never run by Relay, its source-change checks, or an ordinary developer test run.
 * Tests the actual built installer; does not compile or drop another executable.
 * Synthetic children have finite lifetimes. The lifecycle case uses supported
 * uninstall, confirms shutdown, and fails closed if cleanup is not established.
 */
const PURPOSE = 'Relay installer CI integration';
const WORKER_TTL_MS = 12_000;
const PARENT_TTL_MS = 15_000;
const runFile = promisify(execFile);
const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
let haltNativeCases = false;

function inside(root: string, path: string) {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}
async function noLinks(path: string) {
  let current = resolve(path);
  for (;;) {
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1) throw Error('Linked CI fixture paths are refused.');
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
}
async function boundedJson(path: string): Promise<any> {
  await noLinks(path); const stat = await lstat(path);
  if (!stat.isFile() || stat.size > 128 * 1024) throw Error('Invalid fixture receipt file.');
  return JSON.parse(await readFile(path, 'utf8'));
}
async function context() {
  assert.equal(process.platform, 'win32', 'Installer integration requires an isolated Windows GitHub runner.');
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Installer native fixtures are CI-only.');
  assert.equal(process.env.CI, 'true');
  assert.equal(process.env.RELAY_RUN_INSTALLER_CI_INTEGRATION, '1', 'Explicit release-CI integration authorization is required.');
  assert.equal(process.env.GITHUB_REPOSITORY, 'GiovanniVarg/Relay');
  const runnerInput = process.env.RUNNER_TEMP, artifactInput = process.env.RELAY_TEST_INSTALLER_PATH;
  const receiptsInput = process.env.RELAY_INSTALLER_CI_RECEIPTS;
  assert.ok(runnerInput && artifactInput && receiptsInput, 'Release artifact and temporary receipt paths are required.');
  assert.ok([runnerInput, artifactInput, receiptsInput].every(isAbsolute));
  await noLinks(runnerInput); await noLinks(artifactInput);
  const runner = await realpath(runnerInput), artifact = await realpath(artifactInput), receipts = resolve(receiptsInput);
  assert.ok(inside(runner, artifact) && inside(runner, receipts), 'All integration paths must stay in RUNNER_TEMP.');
  assert.ok(!inside(receipts, artifact) && artifact !== receipts, 'Receipts cannot own the release artifact.');
  const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.name, 'relay-agent-harness');
  const version: string = packageJson.version;
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(basename(artifact), `Relay-Setup-${version}-beta-windows-x64.exe`);
  const stat = await lstat(artifact); assert.ok(stat.isFile() && stat.size <= 128 * 1024 * 1024);
  const artifactSha256 = createHash('sha256').update(await readFile(artifact)).digest('hex');
  await noLinks(dirname(receipts)); await mkdir(receipts); // Refuse an existing or foreign receipt directory.
  const runId = randomUUID();
  await writeFile(join(receipts, 'owner.json'), JSON.stringify({ schema: 1, purpose: PURPOSE, runId, version, artifactSha256 }), { flag: 'wx' });
  return { runner, artifact, receipts, version, artifactSha256, runId };
}
type Context = Awaited<ReturnType<typeof context>>;
let ctxPromise: Promise<Context> | undefined;
const getContext = () => ctxPromise ??= context();
type Ready = { schema: number; nonce: string; role: string; pid: number; readyAt: number; expiresAt: number };

class Scope {
  readonly nonce = randomUUID();
  readonly startedAt = Date.now();
  readonly readyPath: string;
  readonly observations: unknown[] = [];
  expectsWorker = false;
  unknown = false;
  cleanup?: () => Promise<void>;
  private sequence = 0;
  constructor(readonly ctx: Context, readonly root: string) { this.readyPath = join(root, 'finite-worker-ready.json'); }
  async powershell(body: string, timeout = 30_000): Promise<any> {
    assert.ok(Number.isSafeInteger(timeout) && timeout >= 30_000 && timeout <= 650_000);
    const script = join(this.root, `developer-test-${++this.sequence}.ps1`);
    await writeFile(script, `# ${PURPOSE}; developer test only; not installed by Relay.\n` +
      "$ErrorActionPreference='Stop'\n" +
      "Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Utility','Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop\n" +
      "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n" + body, { flag: 'wx' });
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'PROCESSOR_ARCHITECTURE']) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    env.PSModulePath = join(systemRoot, 'System32/WindowsPowerShell/v1.0/Modules');
    try {
      const result = await runFile(join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script], {
          cwd: this.root, env, windowsHide: true, timeout, maxBuffer: 256 * 1024,
        });
      assert.equal(result.stderr, '', 'The CI driver reported unexpected diagnostics.');
      return JSON.parse(result.stdout);
    } catch (error) {
      this.unknown = true; haltNativeCases = true;
      throw error; // Host refusal/unknown cleanup is evidence, never permission to retry or evade.
    }
  }
  async runner(source: string, seconds: number, independent = false) {
    const script = join(this.root, `finite-parent-${++this.sequence}.cjs`);
    await writeFile(script, `// ${PURPOSE}; finite disposable fixture.\n` + source, { flag: 'wx' });
    const result = await this.powershell(`
[Reflection.Assembly]::LoadFrom(${quote(this.ctx.artifact)})|Out-Null
$info=New-Object Diagnostics.ProcessStartInfo
$info.FileName=${quote(process.execPath)}
$info.Arguments='"'+${quote(script)}+'"'
$info.WorkingDirectory=${quote(this.root)}
$info.UseShellExecute=$false;$info.CreateNoWindow=$true
$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
try {
  $result=[RelayProcessRunner]::RunStreaming($info,${seconds},$null,$null,$${independent},$false)
  [pscustomobject]@{kind='result';code=$result.ExitCode;output=$result.Output;outLength=$result.Output.Length;errorLength=$result.Error.Length}|ConvertTo-Json -Compress
} catch {
  $message=$_.Exception.ToString()
  if($message.Contains('A setup component timed out and its process group was stopped.')) {
    [pscustomobject]@{kind='owned-timeout-confirmed'}|ConvertTo-Json -Compress
  } else { throw }
}
`);
    return result;
  }
  async finiteWorker(mode: 'independent' | 'owned-timeout') {
    this.expectsWorker = true;
    const worker = join(this.root, 'finite-worker.cjs');
    await writeFile(worker, `// ${PURPOSE}. No infinite timers or account access.\n` +
      `const fs=require('node:fs');const expiresAt=Date.now()+${WORKER_TTL_MS};` +
      `setTimeout(()=>process.exit(0),${WORKER_TTL_MS});` +
      `fs.writeFileSync(${JSON.stringify(this.readyPath + '.pending')},JSON.stringify({schema:1,nonce:${JSON.stringify(this.nonce)},role:'finite-ci-worker',pid:process.pid,readyAt:Date.now(),expiresAt}),{flag:'wx'});` +
      `fs.renameSync(${JSON.stringify(this.readyPath + '.pending')},${JSON.stringify(this.readyPath)});`, { flag: 'wx' });
    // The timeout test must prove job death well before this independent finite deadline.
    const parent = `const fs=require('node:fs');const{spawn}=require('node:child_process');` +
      `setTimeout(()=>process.exit(0),${PARENT_TTL_MS});` +
      `const child=spawn(process.execPath,[${JSON.stringify(worker)}],{cwd:${JSON.stringify(this.root)},stdio:'ignore',windowsHide:true,detached:${mode === 'independent'}});` +
      (mode === 'independent' ? `child.unref();process.stdout.write('OPENED|fixture\\n',()=>process.exit(0));` : '');
    return this.runner(parent, mode === 'independent' ? 10 : 3, mode === 'independent');
  }
  async ready(): Promise<Ready> {
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      try {
        const record: Ready = await boundedJson(this.readyPath);
        assert.equal(record.schema, 1); assert.equal(record.nonce, this.nonce); assert.equal(record.role, 'finite-ci-worker');
        assert.ok(Number.isSafeInteger(record.pid) && record.pid > 0);
        assert.ok(record.readyAt >= this.startedAt && record.expiresAt > record.readyAt && record.expiresAt - record.readyAt <= WORKER_TTL_MS + 100);
        return record;
      } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      await new Promise(done => setTimeout(done, 40));
    }
    throw Error('Finite CI child did not produce its owned readiness receipt.');
  }
  /** Read-only retained Process handle. Never terminates a process using a saved PID. */
  async observe(record: Ready, requireAlive: boolean, wait: boolean) {
    const result = await this.powershell(`
$pidToObserve=${record.pid};$expectedNode=${quote(process.execPath)}
try { $observed=[Diagnostics.Process]::GetProcessById($pidToObserve) }
catch [ArgumentException] { if($${requireAlive}){throw 'Expected finite child already exited'};[pscustomobject]@{state='exited'}|ConvertTo-Json -Compress;exit 0 }
try {
  $null=$observed.Handle
  if($observed.HasExited){if($${requireAlive}){throw 'Expected finite child already exited'};[pscustomobject]@{state='exited'}|ConvertTo-Json -Compress;exit 0}
  $created=([DateTimeOffset]$observed.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()
  if($created -lt ${this.startedAt - 2_000} -or $created -gt ${record.readyAt + 2_000} -or $observed.MainModule.FileName -ine $expectedNode){throw 'Observed process generation does not match this fixture; no action taken'}
  if($${wait}) {
    if(-not $observed.WaitForExit(${WORKER_TTL_MS + 3_000})){throw 'Finite child exit remains unconfirmed; no PID termination attempted'}
    [pscustomobject]@{state='exited';createdAt=$created}|ConvertTo-Json -Compress
  } else {[pscustomobject]@{state='alive';createdAt=$created}|ConvertTo-Json -Compress}
} finally {$observed.Dispose()}
`);
    this.observations.push(result); return result;
  }
}
async function assertOwnedTree(root: string) {
  await noLinks(root);
  for (const name of await readdir(root)) {
    const file = join(root, name), stat = await lstat(file);
    if (stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1) throw Error('Linked disposable CI fixture refused.');
    if (stat.isDirectory()) await assertOwnedTree(file);
  }
}
async function integrationCase(caseId: string, work: (scope: Scope) => Promise<Record<string, boolean>>, homeFixture = false) {
  const ctx = await getContext(), startedAt = new Date().toISOString();
  let fixtureParent = ctx.runner;
  if (homeFixture) {
    assert.ok(process.env.USERPROFILE && isAbsolute(process.env.USERPROFILE));
    await noLinks(process.env.USERPROFILE);
    fixtureParent = await realpath(process.env.USERPROFILE);
    assert.equal(fixtureParent.toLowerCase(), (await realpath(homedir())).toLowerCase());
  }
  const root = await mkdtemp(join(fixtureParent, `relay-installer-ci-${caseId}-`)), scope = new Scope(ctx, root);
  const marker = { schema: 1, purpose: PURPOSE, runId: ctx.runId, nonce: scope.nonce, version: ctx.version, artifactSha256: ctx.artifactSha256, caseId };
  await writeFile(join(root, 'owner.json'), JSON.stringify(marker), { flag: 'wx' });
  let primary: unknown, cleanupError: unknown, checks: Record<string, boolean> = {}, confirmed = false, rootRemoved = false;
  try { if (haltNativeCases) throw Error('Previous native cleanup is unknown; later native cases are refused.'); checks = await work(scope); }
  catch (error) { primary = error; }
  finally {
    try {
      if (scope.cleanup) await scope.cleanup();
      if (scope.expectsWorker) {
        const ready = await scope.ready();
        const exit = await scope.observe(ready, false, true);
        assert.equal(exit.state, 'exited');
      }
      confirmed = !scope.unknown;
      if (!confirmed) throw Error('CI native cleanup remains unknown; evidence retained.');
      // Preserve failed-case evidence; never delete quarantined/blocked artifacts or retry cleanup.
      if (!primary) {
        assert.ok(inside(fixtureParent, root)); await assertOwnedTree(root);
        assert.deepEqual(await boundedJson(join(root, 'owner.json')), marker);
        await rm(root, { recursive: true }); rootRemoved = true;
      }
    } catch (error) { cleanupError = error; haltNativeCases = true; }
    const error = primary ?? cleanupError;
    await writeFile(join(ctx.receipts, caseId + '.json'), JSON.stringify({
      schema: 1, purpose: PURPOSE, runId: ctx.runId, version: ctx.version, artifactSha256: ctx.artifactSha256,
      caseId, status: error ? 'failed' : 'passed', startedAt, finishedAt: new Date().toISOString(), checks,
      cleanup: { confirmed, rootRemoved }, observations: scope.observations,
      ...(error ? { error: String(error).slice(0, 1_000), cleanupError: cleanupError ? String(cleanupError).slice(0, 1_000) : undefined, retainedFixture: root } : {}),
    }, null, 2), { flag: 'wx' });
  }
  if (primary && cleanupError) throw new AggregateError([primary, cleanupError], 'Integration failed; cleanup evidence retained.');
  if (primary) throw primary; if (cleanupError) throw cleanupError;
}

test('required installer-pe-identity', { timeout: 60_000 }, () => integrationCase('installer-pe-identity', async scope => {
  const value = await scope.powershell(`
Add-Type -AssemblyName System.Drawing
$file=${quote(scope.ctx.artifact)};$version=[Diagnostics.FileVersionInfo]::GetVersionInfo($file)
$icon=[Drawing.Icon]::ExtractAssociatedIcon($file)
try {[pscustomobject]@{product=$version.ProductName;company=$version.CompanyName;fileVersion=$version.FileVersion;release=$version.ProductVersion;icon=$icon.Width -gt 0}|ConvertTo-Json -Compress}finally{$icon.Dispose()}
`);
  assert.equal(value.product, 'Relay'); assert.equal(value.company, 'Relay contributors');
  assert.equal(value.fileVersion, scope.ctx.version + '.0'); assert.equal(value.release, scope.ctx.version + '-beta'); assert.equal(value.icon, true);
  return { productIdentity: true, versionIdentity: true, associatedIcon: true };
}));
test('required process-output-bounds', { timeout: 60_000 }, () => integrationCase('process-output-bounds', async scope => {
  const result = await scope.runner("process.stdout.write('x'.repeat(200000));process.stderr.write('y'.repeat(200000));", 10);
  assert.equal(result.kind, 'result'); assert.equal(result.code, 0); assert.equal(result.outLength, 16384); assert.equal(result.errorLength, 16384);
  return { stdoutBounded: true, stderrBounded: true, bothDrained: true };
}));
test('required independent-lifetime', { timeout: 60_000 }, () => integrationCase('independent-lifetime', async scope => {
  const result = await scope.finiteWorker('independent');
  assert.equal(result.kind, 'result'); assert.equal(result.code, 0); assert.equal(result.output, 'OPENED|fixture\n');
  const ready = await scope.ready(); assert.equal((await scope.observe(ready, true, false)).state, 'alive');
  assert.equal((await scope.observe(ready, false, true)).state, 'exited');
  return { explicitResultCaptured: true, childSurvivedLauncher: true, naturalExpiryConfirmed: true };
}));
test('required owned-timeout-cleanup', { timeout: 60_000 }, () => integrationCase('owned-timeout-cleanup', async scope => {
  const result = await scope.finiteWorker('owned-timeout');
  assert.equal(result.kind, 'owned-timeout-confirmed');
  const ready = await scope.ready(); assert.equal((await scope.observe(ready, false, false)).state, 'exited');
  assert.ok(Date.now() < ready.expiresAt, 'Containment must stop the worker before its natural finite deadline.');
  return { ownedTimeoutConfirmed: true, childExitConfirmed: true, beforeNaturalExpiry: true };
}));

async function availablePort() {
  const server = createServer();
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address(); assert.ok(address && typeof address !== 'string' && address.port >= 1024);
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  return address.port;
}
async function portClosed(port: number, host: string) {
  return new Promise<boolean>(done => {
    const socket = createConnection({ port, host });
    let settled = false;
    const finish = (closed: boolean) => { if (!settled) { settled = true; socket.destroy(); done(closed); } };
    socket.once('connect', () => finish(false));
    socket.once('error', (error: NodeJS.ErrnoException) => finish(error.code === 'ECONNREFUSED' || error.code === 'EADDRNOTAVAIL'));
    socket.setTimeout(1_000, () => finish(false)); // A timeout does not prove that a listener stopped.
  });
}
async function actualInstaller(scope: Scope, file: string, args: string[], seconds: number, independent = false) {
  assert.ok(seconds === 600 || seconds === 120);
  assert.ok(args.every(arg => !/["\x00\r\n]/.test(arg)), 'Unexpected installer argument.');
  await noLinks(file);
  const operationStartedAt = Date.now();
  const result = await scope.powershell(`
[Reflection.Assembly]::LoadFrom(${quote(scope.ctx.artifact)})|Out-Null
$info=New-Object Diagnostics.ProcessStartInfo
$info.FileName=${quote(file)};$info.Arguments=${quote(args.map(arg => '"' + arg + '"').join(' '))}
$info.WorkingDirectory=${quote(scope.root)};$info.UseShellExecute=$false;$info.CreateNoWindow=$true
$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
$info.EnvironmentVariables.Clear()
foreach($name in @('SystemRoot','WINDIR','ComSpec','PATHEXT','USERPROFILE','HOME','APPDATA','LOCALAPPDATA','TEMP','TMP')) {
  $value=[Environment]::GetEnvironmentVariable($name);if($null -ne $value){$info.EnvironmentVariables[$name]=$value}
}
$info.EnvironmentVariables['PATH']=$env:SystemRoot+';'+[IO.Path]::Combine($env:SystemRoot,'System32')+';'+[IO.Path]::Combine($env:SystemRoot,'System32','Wbem')
$result=[RelayProcessRunner]::RunStreaming($info,${seconds},$null,$null,$${independent},$false)
[pscustomobject]@{code=$result.ExitCode;output=$result.Output;error=$result.Error}|ConvertTo-Json -Compress
`, seconds * 1_000 + 30_000);
  scope.observations.push({ operation: args[0], exitCode: result.code, stdoutBytes: Buffer.byteLength(result.output), stderrBytes: Buffer.byteLength(result.error) });
  if (result.code !== 0) {
    scope.observations.push({ operation: args[0], failureDiagnostic: await setupFailureDiagnostic(operationStartedAt, Date.now()) });
  }
  assert.equal(result.code, 0, 'The actual installer operation failed; inspect this owned fixture without replaying it.');
}

/** Diagnostic only, never an ownership receipt or permission to retry/clean up. */
async function setupFailureDiagnostic(startedAt: number, endedAt: number) {
  try {
    const local = process.env.LOCALAPPDATA; if (!local || !isAbsolute(local)) return { status: 'unavailable' };
    const file = join(local, 'Temp/RelaySetup-last-error.txt');
    await noLinks(file); const before = await lstat(file);
    if (!before.isFile() || before.nlink !== 1 || before.size > 16 * 1024
      || before.mtimeMs < startedAt - 2_000 || before.mtimeMs > endedAt + 2_000) return { status: 'unavailable' };
    const handle = await open(file, 'r');
    try {
      const opened = await handle.stat();
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size
        || opened.mtimeMs !== before.mtimeMs || !opened.isFile() || opened.nlink !== 1) return { status: 'unavailable' };
      const buffer = Buffer.alloc(16 * 1024 + 1), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const after = await handle.stat(); await noLinks(file); const named = await lstat(file);
      if (bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
        || after.nlink !== 1 || named.dev !== before.dev || named.ino !== before.ino || named.nlink !== 1
        || named.size !== before.size || named.mtimeMs !== before.mtimeMs) return { status: 'unavailable' };
      const message = buffer.subarray(0, bytesRead).toString('utf8')
        .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]')
        .replace(/\b((?:authorization|api[-_ ]?key|token|secret|password|credential|cookie)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
        .replace(/\b(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{8,}/g, '[redacted]')
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').slice(0, 1_500);
      return { status: 'captured', message };
    } finally { await handle.close(); }
  } catch { return { status: 'unavailable' }; } // Preserve the original installer failure.
}

test('required installer-clean-lifecycle', { timeout: 20 * 60_000 }, () => integrationCase('installer-clean-lifecycle', async scope => {
  const app = join(scope.root, 'app'), data = join(scope.root, 'data'), browser = join(scope.root, 'browser');
  const port = await availablePort(), sentinel = `Synthetic Relay CI data: ${scope.nonce}`;
  const sentinelPath = join(data, 'user-data-sentinel.txt');
  await mkdir(data); await writeFile(sentinelPath, sentinel, { flag: 'wx' });
  const node = join(app, '.runtime/node/node.exe'), server = join(app, 'dist/server/index.js');
  const launcher = join(app, '.runtime/Relay.exe'), markerPath = join(app, '.relay-install.json');
  const checks: Record<string, boolean> = {};
  let readyInstallId: string | undefined, uninstallAttempted = false;
  let generation: { pid: number; instanceId: string; startedAt: string; hostPid: number; hostStartedAt: string } | undefined;
  const absent = async (path: string) => { try { await lstat(path); return false; } catch (error: any) { if (error.code === 'ENOENT') return true; throw error; } };
  const ready = async () => {
    const marker = await boundedJson(markerPath), owner = await boundedJson(join(app, '.runtime/install-owner.json'));
    assert.equal(marker.state, 'ready'); assert.equal(marker.version, scope.ctx.version);
    assert.equal(marker.installedBy, 'relay-windows-installer-v1'); assert.match(marker.installId, /^[a-f0-9]{32}$/);
    assert.equal(resolve(marker.installDirectory).toLowerCase(), resolve(app).toLowerCase());
    assert.equal(resolve(marker.dataDirectory).toLowerCase(), resolve(data).toLowerCase()); assert.equal(marker.port, port);
    assert.equal(owner.version, 1); assert.equal(owner.installId, marker.installId);
    if (readyInstallId) assert.equal(marker.installId, readyInstallId, 'Installation identity changed; cleanup refused.');
    readyInstallId = marker.installId; return marker;
  };
  const health = async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2_000) });
    assert.equal(response.status, 200); const value = await response.json() as any;
    assert.equal(value.service, 'relay'); assert.equal(value.ok, true); assert.equal(value.version, scope.ctx.version);
    assert.equal(value.updateHeld, false); assert.ok(Number.isSafeInteger(value.pid) && value.pid > 0);
    assert.match(value.instanceId, /^[a-f0-9-]{36}$/i);
    assert.equal(value.dataDirectoryId, createHash('sha256').update(resolve(data).toLowerCase()).digest('hex'));
    return value;
  };
  // This is the only cleanup action: the supported uninstaller, at most once,
  // after exact ready/owner records agree. Never kill a saved PID or replay a tool.
  scope.cleanup = async () => {
    if (scope.unknown) throw Error('Actual installer ownership/cleanup is unknown; fixture retained without another operation.');
    if (await absent(app)) {
      if (readyInstallId || generation) throw Error('Installation disappeared before supported cleanup; inspect retained evidence.');
      return; // A failed pre-publication install has no launched application to uninstall.
    }
    try {
      await ready(); assert.equal(uninstallAttempted, false); uninstallAttempted = true;
      await actualInstaller(scope, scope.ctx.artifact, ['--uninstall-worker', '--silent', '--no-integrations', '--no-browser', '--destination', app, '--data', data, '--port', String(port)], 120);
      assert.equal(await absent(app), true, 'Uninstaller left application files.');
      await noLinks(sentinelPath); assert.equal((await lstat(sentinelPath)).size, Buffer.byteLength(sentinel));
      assert.equal(await readFile(sentinelPath, 'utf8'), sentinel, 'User data changed during uninstall.');
      assert.equal(await portClosed(port, '127.0.0.1'), true); assert.equal(await portClosed(port, '::1'), true);
      if (generation) {
        const stopped = await scope.powershell(`
Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules','CimCmdlets','CimCmdlets.psd1')) -ErrorAction Stop
$clock=[Diagnostics.Stopwatch]::StartNew()
do {
  $server=Get-CimInstance Win32_Process -Filter 'ProcessId=${generation.pid}'
  $hostProcess=Get-CimInstance Win32_Process -Filter 'ProcessId=${generation.hostPid}'
  $serverStopped=($null -eq $server -or $server.CreationDate.ToUniversalTime().ToString('o') -cne ${quote(generation.startedAt)})
  $hostStopped=($null -eq $hostProcess -or $hostProcess.CreationDate.ToUniversalTime().ToString('o') -cne ${quote(generation.hostStartedAt)})
  if($serverStopped -and $hostStopped){break};[Threading.Thread]::Sleep(100)
} while($clock.ElapsedMilliseconds -lt 5000)
[pscustomobject]@{serverStopped=$serverStopped;hostStopped=$hostStopped}|ConvertTo-Json -Compress
`);
        assert.equal(stopped.serverStopped, true); assert.equal(stopped.hostStopped, true);
      }
      checks.supportedUninstall = true; checks.dataRetained = true; checks.shutdownConfirmed = true;
    } catch (error) { scope.unknown = true; throw error; }
  };
  await writeFile(join(scope.root, 'lifecycle-intent.json'), JSON.stringify({ schema: 1, runId: scope.ctx.runId, nonce: scope.nonce, artifactSha256: scope.ctx.artifactSha256, version: scope.ctx.version, app, data, browser, port }), { flag: 'wx' });
  await actualInstaller(scope, scope.ctx.artifact, ['--silent', '--no-integrations', '--no-browser', '--destination', app, '--data', data, '--port', String(port), '--browser-cache', browser], 600);
  await ready(); checks.cleanInstall = true;
  const runtime = await boundedJson(join(app, '.runtime/install-runtime.json'));
  assert.deepEqual(runtime, { version: 1, nodeVersion: '22.23.5', nodeSha256: '247e9693d316da9857e44990e5e11709f596f18112251b8026ec6eed80bdf38a' });
  await noLinks(node); assert.equal(createHash('sha256').update(await readFile(node)).digest('hex'), runtime.nodeSha256);
  await noLinks(launcher); assert.equal(createHash('sha256').update(await readFile(launcher)).digest('hex'), scope.ctx.artifactSha256);
  await actualInstaller(scope, launcher, ['--launch', '--silent', '--no-browser'], 120, true);
  let current: any; const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) { try { current = await health(); break; } catch { await new Promise(done => setTimeout(done, 250)); } }
  assert.ok(current, 'Installed Relay did not reach matching healthy identity.');
  const state = await boundedJson(join(data, 'supervisor', String(port), 'state.json'));
  assert.equal(resolve(state.appRoot).toLowerCase(), resolve(app).toLowerCase());
  assert.equal(resolve(state.dataRoot).toLowerCase(), resolve(data).toLowerCase()); assert.equal(state.port, port);
  assert.ok(Number.isSafeInteger(state.hostPid) && state.hostPid > 0); assert.ok(Number.isFinite(Date.parse(state.hostStartedAt)));
  assert.equal(state.phase, 'monitoring'); assert.equal(state.child.pid, current.pid); assert.equal(state.child.instanceId, current.instanceId);
  const token = (value: string) => `(?:"${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"|${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`;
  const trustedPowerShell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const hostPattern = '^\\s*' + token(trustedPowerShell) + '\\s+-NoProfile\\s+-NonInteractive\\s+-WindowStyle\\s+Hidden\\s+-File\\s+' + token(join(app, 'scripts/serve-relay.ps1')) + '\\s+-Configuration\\s+([A-Za-z0-9+/]+=*)\\s*$';
  assert.equal(typeof state.hostCommandLine, 'string'); const hostCommand = state.hostCommandLine.match(new RegExp(hostPattern, 'i'));
  assert.ok(hostCommand, 'Supervisor command does not match the installed script.');
  const configuration = JSON.parse(Buffer.from(hostCommand[1], 'base64').toString('utf8'));
  for (const [key, expected] of Object.entries({ appRoot: app, dataRoot: data, nodePath: node })) {
    assert.equal(resolve(configuration[key]).toLowerCase(), resolve(expected).toLowerCase());
  }
  assert.equal(configuration.port, port);
  const command = '^\\s*' + token(node) + '\\s+--no-warnings\\s+' + token(server) + '\\s*$';
  const native = await scope.powershell(`
Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules','CimCmdlets','CimCmdlets.psd1')) -ErrorAction Stop
. ${quote(join(app, 'scripts/windows-tcp-listeners.ps1'))}
$owned=Get-CimInstance Win32_Process -Filter 'ProcessId=${current.pid}'
$supervisor=Get-CimInstance Win32_Process -Filter 'ProcessId=${state.hostPid}'
$listeners=@(Get-RelayTcpListeners -Port ${port})
if(-not $owned -or $owned.ExecutablePath -ine ${quote(node)} -or -not [regex]::IsMatch($owned.CommandLine,${quote(command)},[Text.RegularExpressions.RegexOptions]::IgnoreCase)){throw 'Installed native server identity mismatch'}
if(-not $supervisor -or $supervisor.ExecutablePath -ine [IO.Path]::Combine($env:SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe') -or $supervisor.CommandLine -cne ${quote(state.hostCommandLine)} -or $supervisor.CreationDate.ToUniversalTime().ToString('o') -cne ${quote(state.hostStartedAt)}){throw 'Installed supervisor identity mismatch'}
if($listeners.Count -eq 0 -or @($listeners|Where-Object{$_.OwningProcess -ne ${current.pid} -or $_.LocalAddress -notin @('127.0.0.1','::1')}).Count){throw 'Installed listener identity mismatch'}
[pscustomobject]@{startedAt=$owned.CreationDate.ToUniversalTime().ToString('o');hostStartedAt=$supervisor.CreationDate.ToUniversalTime().ToString('o');privateNode=$true;loopbackOnly=$true}|ConvertTo-Json -Compress
`);
  assert.equal(native.privateNode, true); assert.equal(native.loopbackOnly, true);
  generation = { pid: current.pid, instanceId: current.instanceId, startedAt: native.startedAt, hostPid: state.hostPid, hostStartedAt: native.hostStartedAt };
  checks.privateRuntime = true; checks.healthIdentity = true; checks.noSystemNode = true;
  await actualInstaller(scope, launcher, ['--launch', '--silent', '--no-browser'], 120, true);
  const reopened = await health(); assert.equal(reopened.pid, generation.pid); assert.equal(reopened.instanceId, generation.instanceId);
  checks.reopenReusedInstance = true;
  return checks; // integrationCase runs the single supported uninstall before accepting this receipt.
}, true));
