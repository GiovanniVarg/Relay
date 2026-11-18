import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const run = promisify(execFile), root = resolve('.');
const ps = process.env.RELAY_TEST_PWSH || join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const doctor = join(root, 'scripts', 'doctor-relay.ps1');
type Check = { name: string; ready: boolean; detail: string };
type Report = { ready: boolean; appRoot: string; dataRoot: string; homeDirectory: string; checks: Check[]; notes: string[] };
const windows = { skip: process.platform !== 'win32' };
async function fixture(body: (appRoot: string, dataRoot: string) => Promise<void>) {
  const dir = await mkdtemp(join(root, '.data-doctor-'));
  const appRoot = join(dir, 'application'), dataRoot = join(dir, 'synthetic-data');
  await mkdir(join(appRoot, 'dist', 'server'), { recursive: true });
  await mkdir(dataRoot);
  await writeFile(join(appRoot, 'dist', 'server', 'index.js'), '// synthetic build marker');
  try { await body(appRoot, dataRoot); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
async function inspect(appRoot: string, dataRoot: string, prelude = '', environment: NodeJS.ProcessEnv = {}) {
  const { stdout, stderr } = await run(ps, ['-NoProfile', '-NonInteractive', '-Command', prelude + '; & $env:RELAY_TEST_DOCTOR -AppRoot $env:RELAY_TEST_APP -DataRoot $env:RELAY_TEST_DATA -Json'], {
    windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024,
    env: { ...process.env, ...environment, RELAY_TEST_DOCTOR: doctor, RELAY_TEST_APP: appRoot, RELAY_TEST_DATA: dataRoot },
  });
  assert.equal(stderr, '');
  return { report: JSON.parse(stdout) as Report, stdout };
}
function check(report: Report, name: string) { const result = report.checks.find(item => item.name === name); assert.ok(result, 'missing ' + name); return result; }

for (const osValue of [undefined, 'Unix']) test(`native Windows readiness ignores ${osValue === undefined ? 'absent' : 'misleading'} OS environment`, windows, async () => {
  await fixture(async (appRoot, dataRoot) => {
    const packageRoot = join(appRoot, 'node_modules', '@cursor', 'sdk');
    await mkdir(packageRoot, { recursive: true });
    const publicPackage = join(packageRoot, 'package.json');
    await writeFile(publicPackage, JSON.stringify({ name: '@cursor/sdk', version: '1.0.40' }));
    const fakeProfile = join(dataRoot, 'fixture-user-home');
    const appData = join(fakeProfile, 'AppData', 'Roaming'), localAppData = join(fakeProfile, 'AppData', 'Local');
    await mkdir(appData, { recursive: true });
    await mkdir(localAppData, { recursive: true });
    const environment = { USERPROFILE: fakeProfile, HOME: fakeProfile, APPDATA: appData, LOCALAPPDATA: localAppData, OS: osValue,
      RELAY_TEST_PUBLIC_PACKAGE: publicPackage, RELAY_TEST_READ_MARKER: join(dataRoot, 'unexpected-private-read') };
    // Warm PowerShell's own startup/module cache before checking doctor-specific writes.
    await run(ps, ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.Security;Get-Command node.exe|Out-Null;Get-Content -LiteralPath $env:RELAY_TEST_PUBLIC_PACKAGE -Raw -Encoding UTF8|ConvertFrom-Json|ConvertTo-Json|Out-Null'], {
      windowsHide: true, timeout: 30000, env: { ...process.env, ...environment },
    });
    const privatePath = join(dataRoot, 'credentials.json');
    await writeFile(privatePath, 'SYNTHETIC_PRIVATE_SENTINEL invalid-json');
    const before = (await readdir(dataRoot, { recursive: true })).sort();
    const prelude = (osValue === undefined ? 'Remove-Item Env:OS -ErrorAction SilentlyContinue' : "$env:OS='Unix'")
      + "; function Get-Content { param([string]$LiteralPath,[switch]$Raw,[string]$Encoding) if($LiteralPath -ne $env:RELAY_TEST_PUBLIC_PACKAGE){[IO.File]::WriteAllText($env:RELAY_TEST_READ_MARKER,'unexpected read');throw 'Unexpected private read'}; Microsoft.PowerShell.Management\\Get-Content @PSBoundParameters }";
    const { report, stdout } = await inspect(appRoot, dataRoot, prelude, environment);
    const protection = check(report, 'Managed secrets (DPAPI)'), cursor = check(report, 'Cursor');
    assert.equal(protection.ready, true, 'actual Windows CurrentUser Protect/Unprotect must run independently of env:OS');
    assert.match(protection.detail, /CurrentUser.*memory-only.*Protect\/Unprotect.*roundtrip succeeded/i);
    assert.equal(cursor.ready, true);
    assert.match(cursor.detail, /native Work\/Agent.*unavailable.*Windows/i);
    assert.match(cursor.detail, /authentication.*entitlement.*not verified/i);
    assert.equal(report.appRoot, appRoot);
    assert.equal(report.homeDirectory, fakeProfile);
    assert.equal(report.dataRoot, dataRoot);
    assert.deepEqual((await readdir(dataRoot, { recursive: true })).sort(), before);
    assert.equal(await readFile(privatePath, 'utf8'), 'SYNTHETIC_PRIVATE_SENTINEL invalid-json');
    assert.doesNotMatch(stdout, /SYNTHETIC_PRIVATE_SENTINEL|unexpected read/);
  });
});

test('doctor parses in Windows PowerShell and reports synthetic DPAPI capability without reading data', windows, async () => {
  await run(ps, ['-NoProfile', '-NonInteractive', '-Command', '$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile($env:RELAY_TEST_DOCTOR,[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){throw $errors[0].Message}'], { windowsHide: true, timeout: 30000, env: { ...process.env, RELAY_TEST_DOCTOR: doctor } });
  await fixture(async (appRoot, dataRoot) => {
    // Any data inspection would encounter this invalid private fixture; doctor only reports the path.
    await writeFile(join(dataRoot, 'credentials.json'), 'SYNTHETIC_PRIVATE_SENTINEL invalid-json');
    const before = await readdir(dataRoot);
    const { report, stdout } = await inspect(appRoot, dataRoot);
    assert.equal(check(report, 'Managed secrets (DPAPI)').ready, true);
    assert.match(check(report, 'Managed secrets (DPAPI)').detail, /CurrentUser.*memory-only.*roundtrip/i);
    assert.equal(report.dataRoot, dataRoot);
    assert.equal(report.homeDirectory, process.env.USERPROFILE);
    assert.deepEqual(await readdir(dataRoot), before);
    assert.equal(await readFile(join(dataRoot, 'credentials.json'), 'utf8'), 'SYNTHETIC_PRIVATE_SENTINEL invalid-json');
    assert.doesNotMatch(stdout, /SYNTHETIC_PRIVATE_SENTINEL|api[_ -]?key|access[_ -]?token|ciphertext|authenticated\s*[:=]\s*true|entitlement\s*[:=]\s*true/i);
    assert.match(report.notes.join(' '), /does not authenticate/);
  });
});

test('Cursor package presence reports actual local version and limited transport without authentication claims', windows, async () => {
  await fixture(async (appRoot, dataRoot) => {
    assert.equal(check((await inspect(appRoot, dataRoot)).report, 'Cursor').ready, false);
    const packageRoot = join(appRoot, 'node_modules', '@cursor', 'sdk');
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@cursor/sdk', version: '1.0.40' }));
    const { report } = await inspect(appRoot, dataRoot);
    const cursor = check(report, 'Cursor');
    assert.equal(cursor.ready, true);
    assert.match(cursor.detail, /1\.0\.40/);
    assert.match(cursor.detail, /app-only.*Relay.*Agent.*Chat/i);
    assert.match(cursor.detail, /native Work\/Agent.*unavailable.*Windows/i);
    assert.match(cursor.detail, /authentication.*entitlement.*not verified/i);
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@cursor/sdk', version: 'SECRET_SENTINEL' }));
    const malformed = await inspect(appRoot, dataRoot);
    assert.equal(check(malformed.report, 'Cursor').ready, false);
    assert.doesNotMatch(malformed.stdout, /SECRET_SENTINEL/);
  });
});

test('base readiness requires runtime and build while optional capabilities remain independent', windows, async () => {
  await fixture(async (appRoot, dataRoot) => {
    const { report } = await inspect(appRoot, dataRoot, "function Get-Command { param($Name,$ErrorAction) if($Name -in @('codex','claude')){return $null}; Microsoft.PowerShell.Core\\Get-Command -Name $Name -ErrorAction SilentlyContinue }");
    assert.equal(check(report, 'Node.js').ready, true, 'fixture host requires Node >=22.13');
    assert.equal(check(report, 'npm').ready, true);
    assert.equal(check(report, 'Application build').ready, true);
    for (const name of ['OpenAI', 'Claude', 'Cursor', 'Herdr delegation', 'Shared browser']) assert.equal(check(report, name).ready, false);
    assert.equal(report.ready, true);
    await rm(join(appRoot, 'dist', 'server', 'index.js'));
    const missing = (await inspect(appRoot, dataRoot)).report;
    assert.equal(check(missing, 'Application build').ready, false);
    assert.equal(missing.ready, false);
    assert.match(check(missing, 'Application build').detail, /Setup Relay\.cmd/);
    assert.match(check(missing, 'Application build').detail, /scripts\\setup-relay\.ps1 -Apply/);
    assert.match(check(missing, 'Shared browser').detail, /npm exec -- playwright install chromium/);
  });
});

test('DPAPI failure is explicit and bounded without turning optional providers into base prerequisites', windows, async () => {
  await fixture(async (appRoot, dataRoot) => {
    const { report, stdout } = await inspect(appRoot, dataRoot, "function Add-Type { throw 'SYNTHETIC_PRIVATE_EXCEPTION' }");
    const protection = check(report, 'Managed secrets (DPAPI)');
    assert.equal(protection.ready, false);
    assert.match(protection.detail, /managed secrets.*unavailable/i);
    assert.equal(report.ready, true);
    assert.doesNotMatch(stdout, /SYNTHETIC_PRIVATE_EXCEPTION/);
    assert.match(report.notes.join(' '), /base application.*Node.*npm.*build/i);
  });
});

test('Node minimum and npm remain mandatory checks', windows, async () => {
  await fixture(async (appRoot, dataRoot) => {
    const stub = join(appRoot, 'node-version.cmd');
    await writeFile(stub, '@echo off\r\necho v22.12.0\r\n');
    const oldNode = (await inspect(appRoot, dataRoot, "function Get-Command { param($Name,$ErrorAction) if($Name -eq 'node.exe'){return [pscustomobject]@{Source=$env:RELAY_TEST_NODE_STUB}}; Microsoft.PowerShell.Core\\Get-Command -Name $Name -ErrorAction SilentlyContinue }", { RELAY_TEST_NODE_STUB: stub })).report;
    assert.equal(check(oldNode, 'Node.js').ready, false);
    assert.equal(oldNode.ready, false);
    const noNpm = (await inspect(appRoot, dataRoot, "function Get-Command { param($Name,$ErrorAction) if($Name -eq 'npm.cmd'){return $null}; Microsoft.PowerShell.Core\\Get-Command -Name $Name -ErrorAction SilentlyContinue }")).report;
    assert.equal(check(noNpm, 'npm').ready, false);
    assert.equal(noNpm.ready, false);
  });
});

test('default paths follow the detected user profile without opening or creating its data directory', windows, async () => {
  await fixture(async (appRoot, dataRoot) => {
    const fakeProfile = join(dataRoot, 'fixture-user-home');
    const { stdout } = await run(ps, ['-NoProfile', '-NonInteractive', '-File', doctor, '-AppRoot', appRoot, '-Json'], {
      windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024, env: { ...process.env, USERPROFILE: fakeProfile },
    });
    const report = JSON.parse(stdout) as Report;
    assert.equal(report.homeDirectory, fakeProfile);
    assert.equal(report.dataRoot, join(fakeProfile, '.relay-data'));
    // Windows PowerShell startup creates its own fake-home folders even with -NoProfile.
    await assert.rejects(readdir(join(fakeProfile, '.relay-data')), { code: 'ENOENT' });
  });
});
