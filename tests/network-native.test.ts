import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureNetworkNativeTransport, extractTransportNative, TRANSPORT_NATIVE_RELEASES } from '../server/network-native.js';

test('native transport rejects unknown or modified downloads before extraction', () => {
  const release = TRANSPORT_NATIVE_RELEASES['win32-x64']!;
  assert.throws(() => extractTransportNative(Buffer.alloc(0), release));
  assert.throws(() => extractTransportNative(Buffer.alloc(release.archiveBytes), release));
  assert.equal(Object.keys(TRANSPORT_NATIVE_RELEASES).length, 5);
});
test('the exact installed native release is verified before dynamic load', async () => {
  await ensureNetworkNativeTransport();
  const native = await import('@fails-components/webtransport-transport-http3-quiche');
  assert.equal(typeof native.Http3WebTransportServer, 'function');
});
