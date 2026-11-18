import 'reflect-metadata';
import { BasicConstraintsExtension, X509Certificate } from '@peculiar/x509';
import { controllerFetch, verifyTransportCatalog, ControllerTransportUnsupportedError } from './controller-transport';
import { base64url, normalizeFingerprint, parsePublicProfile, type PublicConnectionProfile } from './controller-storage';

export type LocalNetworkPermission = 'granted' | 'prompt' | 'denied' | 'unknown';
export type ControllerConnectionErrorKind = 'permission-denied' | 'trust-or-network' | 'identity-changed'
  | 'host-update-required' | 'invalid-profile' | 'aborted' | 'browser-unsupported';
export class ControllerConnectionError extends Error {
  constructor(public readonly kind: ControllerConnectionErrorKind, message: string) { super(message); this.name = 'ControllerConnectionError'; }
}
export async function getLocalNetworkPermission(): Promise<LocalNetworkPermission> {
  try {
    if (typeof navigator === 'undefined' || !navigator.permissions?.query) return 'unknown';
    // Chrome's legacy local-network-access descriptor is deliberately never queried.
    const result = await navigator.permissions.query({ name: 'local-network' as PermissionName });
    return ['granted', 'prompt', 'denied'].includes(result.state) ? result.state : 'unknown';
  } catch { return 'unknown'; }
}
const error = (kind: ControllerConnectionErrorKind, message: string): never => { throw new ControllerConnectionError(kind, message); };
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
function certificate(profile: PublicConnectionProfile): X509Certificate {
  if (profile.ca.length > 32_768 || !/^\s*-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----\s*$/.test(profile.ca)) return error('invalid-profile', 'Choose a profile with one public root certificate.');
  try {
    const root = new X509Certificate(profile.ca);
    if (!root.getExtension(BasicConstraintsExtension)?.ca || root.subject !== root.issuer
      || root.notBefore.getTime() > Date.now() || root.notAfter.getTime() <= Date.now()) throw new Error();
    return root;
  } catch { return error('invalid-profile', 'The public root certificate is invalid or expired. Get a fresh profile from the hosting computer.'); }
}
async function validatedRoot(profile: PublicConnectionProfile, root: X509Certificate): Promise<CryptoKey> {
  try {
    const fingerprint = hex(await crypto.subtle.digest('SHA-256', root.rawData));
    if (fingerprint !== normalizeFingerprint(profile.fingerprint)) return error('identity-changed', 'The certificate does not match the saved host fingerprint. Get a fresh profile from the hosting computer.');
    if (!await root.isSelfSigned(crypto)) throw new Error();
    const key = await root.publicKey.export({ name: 'ECDSA', namedCurve: 'P-256' }, ['verify'], crypto);
    if (key.algorithm.name !== 'ECDSA' || (key.algorithm as EcKeyAlgorithm).namedCurve !== 'P-256') throw new Error();
    return key;
  } catch (failure) {
    if (failure instanceof ControllerConnectionError) throw failure;
    return error('invalid-profile', 'This profile does not contain a valid Relay P-256 root certificate.');
  }
}

/**
 * Unauthenticated reachability and CA-key proof only; browsers do not expose the TLS certificate.
 * Call directly from the connect button to retain activation. For automatic checks, the UI must
 * first require getLocalNetworkPermission() === 'granted'; this function can trigger a prompt.
 */
export async function checkControllerHost(profile: PublicConnectionProfile, options: { signal?: AbortSignal } = {}): Promise<PublicConnectionProfile & { verified: true }> {
  let parsed: PublicConnectionProfile;
  try { parsed = parsePublicProfile(JSON.stringify(profile)); }
  catch { return error('invalid-profile', 'Choose a valid public connection profile from the hosting computer.'); }
  const root = certificate(parsed);
  if (options.signal?.aborted) return error('aborted', 'Connection check was cancelled.');
  const challenge = base64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
  // Start fetch before the first await: permission prompts can require the button's activation.
  const response = controllerFetch(parsed, '/api/network/info?challenge=' + challenge, {
    method: 'GET', signal: options.signal,
  }).then(value => ({ value }), failure => ({ failure }));
  const key = await validatedRoot(parsed, root);
  const result = await response;
  if ('failure' in result) {
    if (result.failure instanceof ControllerTransportUnsupportedError) return error('browser-unsupported', result.failure.message);
    if (options.signal?.aborted || result.failure?.name === 'AbortError') return error('aborted', 'Connection check was cancelled.');
    if (await getLocalNetworkPermission() === 'denied') return error('permission-denied', 'Allow local network access for Relay in this browser’s site settings, then try again.');
    return error('trust-or-network', parsed.transport ? 'The browser could not reach this host. Check that Relay is awake, both devices are on the same network, and Local Network access is allowed.' : 'The browser could not reach this legacy host. Check certificate trust, the host address, Wi-Fi, and local network permission.');
  }
  if (!result.value.ok) return error('trust-or-network', 'The hosting computer did not accept the connection check.');
  let info: Record<string, unknown>;
  try {
    const text = await result.value.text();
    if (text.length > 50_000) throw new Error();
    info = JSON.parse(text) as Record<string, unknown>;
    if (!info || typeof info !== 'object' || Array.isArray(info)) throw new Error();
  } catch { return error('host-update-required', 'Update Relay on the hosting computer, then get a fresh connection profile.'); }
  if (info.url !== parsed.url || typeof info.fingerprint !== 'string'
    || normalizeFingerprint(info.fingerprint) !== parsed.fingerprint || typeof info.publicCA !== 'string') return error('identity-changed', 'This address returned a different host identity. Check the profile on the hosting computer.');
  try {
    const returnedRoot = certificate({ ...parsed, ca: info.publicCA });
    if (hex(await crypto.subtle.digest('SHA-256', returnedRoot.rawData)) !== parsed.fingerprint) throw new Error();
  } catch { return error('identity-changed', 'This address returned a different root certificate. Check the profile on the hosting computer.'); }
  if (info.protocol !== 1 || !info.hostProof || typeof info.hostProof !== 'object') return error('host-update-required', 'Update Relay on the hosting computer to verify this saved host.');
  const proof = info.hostProof as Record<string, unknown>;
  if (proof.challenge !== challenge || typeof proof.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(proof.signature)) return error('identity-changed', 'The host identity proof did not match this connection check.');
  try {
    const bytes = Uint8Array.from(atob(proof.signature.replace(/-/g, '+').replace(/_/g, '/') + '=='), char => char.charCodeAt(0));
    if (bytes.length !== 64 || base64url(bytes.buffer) !== proof.signature) throw new Error();
    const message = JSON.stringify(['relay-host-proof-v1', parsed.url, challenge, parsed.fingerprint]);
    if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, bytes, new TextEncoder().encode(message))) throw new Error();
  } catch { return error('identity-changed', 'The host could not prove the saved certificate identity. Check the profile on the hosting computer.'); }
  if (options.signal?.aborted) return error('aborted', 'Connection check was cancelled.');
  if (parsed.transport) {
    if (!info.transportCatalog || typeof info.transportCatalog !== 'object') return error('host-update-required', 'The host did not return its signed connection trust. Update Relay and scan its QR again.');
    try {
      const envelope = info.transportCatalog as { payload: string; signature: string };
      await verifyTransportCatalog(parsed, envelope, parsed.transport.catalog);
      parsed = { ...parsed, transport: { ...parsed.transport, catalog: {payload:envelope.payload,signature:envelope.signature} } };
    } catch { return error('identity-changed', 'The host connection trust could not be verified. Scan a fresh QR from the hosting computer.'); }
  }
  if (options.signal?.aborted) return error('aborted', 'Connection check was cancelled.');
  return { ...parsed, verified: true };
}
