import test from 'node:test';
import assert from 'node:assert/strict';

// Pure receipt validation only: no executable files, compiler, native driver or child processes.
const verifierUrl = new URL('../scripts/installer/verify-ci-receipts.mjs', import.meta.url).href;
const { validateInstallerCiReceipts, REQUIRED_CASE_CHECKS } = await import(verifierUrl);
const identity = { version: '0.11.1', artifactSha256: 'a'.repeat(64), runId: '12345678-1234-4234-8234-123456789abc' };
function receipts() {
  return Object.entries(REQUIRED_CASE_CHECKS).map(([caseId, checks]) => ({
    schema: 1, purpose: 'Relay installer CI integration', ...identity, caseId, status: 'passed',
    startedAt: '2026-11-19T00:00:00.000Z', finishedAt: '2026-11-19T00:00:01.000Z',
    checks: Object.fromEntries((checks as string[]).map(check => [check, true])),
    cleanup: { confirmed: true, rootRemoved: true },
  }));
}
test('installer CI gate accepts every required case only with matching artifact identity and confirmed cleanup', () => {
  assert.equal(Object.keys(REQUIRED_CASE_CHECKS).length, 5);
  assert.ok(Object.hasOwn(REQUIRED_CASE_CHECKS, 'installer-clean-lifecycle'));
  assert.deepEqual(validateInstallerCiReceipts(receipts(), identity), Object.keys(REQUIRED_CASE_CHECKS));
});
test('installer CI gate refuses missing, duplicate, foreign, skipped and failed cases', () => {
  const all = receipts();
  for (const invalid of [all.slice(1), [...all, all[0]], [...all, { ...all[0], caseId: 'foreign' }],
    all.map(receipt => ({ ...receipt, caseId: [receipt.caseId] })),
    all.map((r, i) => i ? r : { ...r, status: 'skipped' }), all.map((r, i) => i ? r : { ...r, status: 'failed' })]) {
    assert.throws(() => validateInstallerCiReceipts(invalid, identity));
  }
});
test('installer CI gate independently requires every clean lifecycle and data preservation assertion', () => {
  for (const check of REQUIRED_CASE_CHECKS['installer-clean-lifecycle']) {
    const all = receipts(), lifecycle = all.find(receipt => receipt.caseId === 'installer-clean-lifecycle')!;
    lifecycle.checks[check] = false;
    assert.throws(() => validateInstallerCiReceipts(all, identity));
  }
  const all = receipts();
  assert.throws(() => validateInstallerCiReceipts(all.filter(receipt => receipt.caseId !== 'installer-clean-lifecycle'), identity));
});
test('installer CI gate refuses altered version, executable digest, run owner or case evidence', () => {
  for (const change of [{ version: '0.11.0' }, { artifactSha256: 'b'.repeat(64) }, { runId: 'foreign' },
    { cleanup: { confirmed: false, rootRemoved: true } }, { cleanup: { confirmed: true, rootRemoved: false } },
    { checks: {} }, { checks: { ...receipts()[0].checks, productIdentity: false } }]) {
    const all = receipts(); all[0] = { ...all[0], ...change } as typeof all[0];
    assert.throws(() => validateInstallerCiReceipts(all, identity));
  }
});
