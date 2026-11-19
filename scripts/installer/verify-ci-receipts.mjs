import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_CASE_CHECKS = Object.freeze({
  'installer-pe-identity': ['productIdentity', 'versionIdentity', 'associatedIcon'],
  'process-output-bounds': ['stdoutBounded', 'stderrBounded', 'bothDrained'],
  'independent-lifetime': ['explicitResultCaptured', 'childSurvivedLauncher', 'naturalExpiryConfirmed'],
  'owned-timeout-cleanup': ['ownedTimeoutConfirmed', 'childExitConfirmed', 'beforeNaturalExpiry'],
  'installer-clean-lifecycle': ['cleanInstall', 'privateRuntime', 'healthIdentity', 'noSystemNode', 'reopenReusedInstance', 'supportedUninstall', 'dataRetained', 'shutdownConfirmed'],
});
const purpose = 'Relay installer CI integration';
export function validateInstallerCiReceipts(receipts, identity) {
  const ids = Object.keys(REQUIRED_CASE_CHECKS), seen = new Set();
  if (!/^\d+\.\d+\.\d+$/.test(identity.version) || !/^[a-f0-9]{64}$/.test(identity.artifactSha256)
    || !/^[a-f0-9-]{36}$/.test(identity.runId) || !Array.isArray(receipts) || receipts.length !== ids.length) {
    throw Error('Installer integration receipts or identity are incomplete.');
  }
  for (const receipt of receipts) {
    if (!receipt || receipt.schema !== 1 || receipt.purpose !== purpose || receipt.status !== 'passed'
      || typeof receipt.caseId !== 'string' || !Object.hasOwn(REQUIRED_CASE_CHECKS, receipt.caseId) || seen.has(receipt.caseId)
      || receipt.version !== identity.version || receipt.artifactSha256 !== identity.artifactSha256
      || receipt.runId !== identity.runId || receipt.cleanup?.confirmed !== true || receipt.cleanup?.rootRemoved !== true
      || !Number.isFinite(Date.parse(receipt.startedAt)) || !Number.isFinite(Date.parse(receipt.finishedAt))
      || Date.parse(receipt.finishedAt) < Date.parse(receipt.startedAt)
      || REQUIRED_CASE_CHECKS[receipt.caseId].some(check => receipt.checks?.[check] !== true)) {
      throw Error('Installer integration did not prove every required case and its cleanup.');
    }
    seen.add(receipt.caseId);
  }
  return ids;
}
async function noLinks(path) {
  let current = resolve(path);
  for (;;) {
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1) throw Error('Linked CI receipt or artifact path refused.');
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
}
async function json(path) {
  await noLinks(path); const stat = await lstat(path);
  if (!stat.isFile() || stat.size > 128 * 1024) throw Error('CI receipt is not a bounded regular file.');
  return JSON.parse(await readFile(path, 'utf8'));
}
export async function verifyInstallerCiReceiptDirectory(directory, artifact, version) {
  if (!isAbsolute(directory) || !isAbsolute(artifact)) throw Error('Absolute CI paths are required.');
  await noLinks(directory); await noLinks(artifact);
  const root = await realpath(directory), executable = await realpath(artifact);
  const contained = relative(root, executable);
  if (!contained.startsWith('..' + sep) && contained !== '..' && !isAbsolute(contained)) throw Error('Artifact must stay outside disposable receipt storage.');
  if (basename(executable) !== `Relay-Setup-${version}-beta-windows-x64.exe`) throw Error('Installer name does not match the release.');
  const stat = await lstat(executable); if (!stat.isFile() || stat.size > 128 * 1024 * 1024) throw Error('Unexpected installer artifact.');
  const artifactSha256 = createHash('sha256').update(await readFile(executable)).digest('hex');
  const owner = await json(resolve(root, 'owner.json'));
  if (owner.schema !== 1 || owner.purpose !== purpose || owner.version !== version || owner.artifactSha256 !== artifactSha256) {
    throw Error('CI receipt ownership marker does not match the checked release.');
  }
  const expected = ['owner.json', ...Object.keys(REQUIRED_CASE_CHECKS).map(id => id + '.json')].sort();
  const names = (await readdir(root)).sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw Error('Missing or unexpected integration receipt files.');
  const receipts = await Promise.all(Object.keys(REQUIRED_CASE_CHECKS).map(id => json(resolve(root, id + '.json'))));
  return validateInstallerCiReceipts(receipts, { version, artifactSha256, runId: owner.runId });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, artifact, version, ...extra] = process.argv.slice(2);
  if (!directory || !artifact || !version || extra.length) throw Error('Use verify-ci-receipts.mjs <receipts> <installer> <version>.');
  const cases = await verifyInstallerCiReceiptDirectory(directory, artifact, version);
  console.log(JSON.stringify({ verified: true, cases, count: cases.length }));
}
