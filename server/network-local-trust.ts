import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { join, win32 } from 'node:path';
import type { NetworkCertificates } from './network-certificates.js';

export interface LocalTrustStatus {
  platform: string;
  supported: boolean;
  trusted: boolean;
  fingerprint: string | null;
  certificateName: string;
  scope: 'current-user';
  pending?: boolean;
  reason?: 'timeout' | 'unconfirmed';
}
/** The injected operation is an OS boundary; tests must never modify a real root store. */
export type LocalTrustOperation = (operation: 'read' | 'install', derBase64: string, fingerprint: string) => Promise<boolean>;
export interface LocalTrustOptions { platform?: string; operation?: LocalTrustOperation }

export class LocalTrustOperationError extends Error {
  constructor(public readonly reason: 'timeout' | 'unconfirmed',
    public readonly stages: ReadonlyArray<'before-add' | 'after-add'> = []) {
    super('Local certificate trust unavailable');
    this.name = 'LocalTrustOperationError';
  }
}

const unavailable = (): never => { throw new Error('Local certificate trust unavailable'); };

const windowsOperation: LocalTrustOperation = async (operation, derBase64, fingerprint) => {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(derBase64) || !/^[a-f0-9]{64}$/.test(fingerprint)) return unavailable();
  const root = process.env.SystemRoot;
  if (!root || !/^[a-z]:\\[^\r\n]*$/i.test(root) || !win32.isAbsolute(root)) return unavailable();
  const executable = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Only validated public DER and hex enter this fixed command. No writable script or shell lookup.
  const script = `$ErrorActionPreference='Stop'
Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Utility','Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop
$der=[Convert]::FromBase64String('${derBase64}')
$expected='${fingerprint}'
$sha=[Security.Cryptography.SHA256]::Create()
$certificate=New-Object Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList (,$der)
function Hash($c) { return ([BitConverter]::ToString($sha.ComputeHash($c.RawData))).Replace('-','').ToLowerInvariant() }
if ((Hash $certificate) -cne $expected) { throw 'Invalid certificate' }
$store=New-Object Security.Cryptography.X509Certificates.X509Store -ArgumentList 'Root','CurrentUser'
try {
  $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::${operation === 'read' ? 'ReadOnly' : 'ReadWrite'})
  ${operation === 'install' ? "[Console]::Error.WriteLine('relay-trust:before-add'); $store.Add($certificate); [Console]::Error.WriteLine('relay-trust:after-add')" : ''}
  $found=$false
  foreach ($entry in $store.Certificates) { if ((Hash $entry) -ceq $expected) { $found=$true; break } }
  if ($found) { [Console]::Out.Write('trusted') } else { [Console]::Out.Write('untrusted') }
} finally { $store.Close(); $certificate.Dispose(); $sha.Dispose() }
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const timeout = operation === 'install' ? 120_000 : 20_000;
  const started = performance.now();
  return new Promise<boolean>((resolve, reject) => {
    execFile(executable, ['-NoLogo', '-NoProfile', '-EncodedCommand', encoded],
      // Installation is an explicitly approved interactive action. Preserve Windows consent UI.
      { windowsHide: operation === 'read', timeout, killSignal: 'SIGKILL', maxBuffer: 32_768, encoding: 'utf8' },
      (error, stdout, stderr) => {
        // Retain only fixed stage markers. Never expose raw PowerShell output or errors.
        const stages: Array<'before-add' | 'after-add'> = [];
        for (const line of stderr.split(/\r?\n/)) {
          if (line === 'relay-trust:before-add') stages.push('before-add');
          else if (line === 'relay-trust:after-add') stages.push('after-add');
        }
        if (error || !['trusted', 'untrusted'].includes(stdout.trim())) {
          const timedOut = error?.killed === true && performance.now() - started >= timeout - 1000;
          reject(new LocalTrustOperationError(timedOut ? 'timeout' : 'unconfirmed', stages)); return;
        }
        resolve(stdout.trim() === 'trusted');
      });
  });
};

export class LocalNetworkTrust {
  private readonly platform: string;
  private readonly operation: LocalTrustOperation;
  private installing: Promise<LocalTrustStatus> | undefined;
  constructor(private readonly certificates: Pick<NetworkCertificates, 'publicCA'>, options: LocalTrustOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.operation = options.operation ?? windowsOperation;
  }
  private material() {
    const ca = this.certificates.publicCA();
    if (!ca) return null;
    const certificate = new X509Certificate(ca.certificate);
    const fingerprint = certificate.fingerprint256.replaceAll(':', '').toLowerCase();
    if (fingerprint !== ca.fingerprint || !certificate.ca) return unavailable();
    return { fingerprint, derBase64: certificate.raw.toString('base64') };
  }
  async status(): Promise<LocalTrustStatus> {
    const material = this.material();
    const status: LocalTrustStatus = { platform: this.platform, supported: this.platform === 'win32', trusted: false,
      fingerprint: material?.fingerprint ?? null, certificateName: 'Relay Local Network', scope: 'current-user' };
    if (!status.supported || !material) return status;
    try { status.trusted = await this.operation('read', material.derBase64, material.fingerprint); }
    catch (error) { status.reason = error instanceof LocalTrustOperationError ? error.reason : 'unconfirmed'; }
    return status;
  }
  install(fingerprint: string, confirm: true): Promise<LocalTrustStatus> {
    const material = this.material();
    if (confirm !== true || !material || fingerprint !== material.fingerprint) return Promise.reject(new Error('Local certificate confirmation does not match'));
    if (this.platform !== 'win32') return this.status();
    if (this.installing) return this.installing;
    const task = (async () => {
      // Re-read after installation. The subprocess result alone is not a trust assertion.
      let reason: 'timeout' | 'unconfirmed' | undefined;
      try { await this.operation('install', material.derBase64, material.fingerprint); }
      catch (error) { reason = error instanceof LocalTrustOperationError ? error.reason : 'unconfirmed'; }
      const result = await this.status();
      if (result.fingerprint !== material.fingerprint) return unavailable();
      return result.trusted ? { ...result, pending: false }
        : { ...result, pending: true, reason: reason ?? result.reason ?? 'unconfirmed' };
    })();
    this.installing = task;
    void task.finally(() => { if (this.installing === task) this.installing = undefined; }).catch(() => {});
    return task;
  }
}
