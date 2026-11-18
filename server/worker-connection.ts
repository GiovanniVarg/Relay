import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';
import { Agent, request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import { platform } from 'node:os';
import { bodyHash, signingPayload } from './network-auth.js';

export interface WorkerPublicProfile { url: string; ca: string; fingerprint: string }
export interface WorkerSecretVault { get(name: string): Promise<string | null | undefined>; set(name: string, value: string): Promise<void>; remove(name: string): Promise<void> }
export interface WorkerIdentity extends WorkerPublicProfile { version: 1; deviceId: string; privateKey: string }
export interface WorkerRequest { profile: WorkerPublicProfile; path: string; method: string; body: Buffer; headers: Record<string, string> }
export type WorkerRequester = (request: WorkerRequest) => Promise<{ status: number; body: unknown }>;
export class WorkerConnectionError extends Error { constructor(message: string, public status?: number) { super(message); } }
const SECRET = 'network-worker-identity', MAX_RESPONSE = 64 * 1024 * 1024, MAX_REQUEST = 8 * 1024 * 1024;
function bad(message = 'Invalid worker connection profile'): never { throw new WorkerConnectionError(message); }
function fingerprint(value: string) { return value.replace(/^sha256[:/-]?/i, '').replace(/:/g, '').toLowerCase(); }
function validProfile(profile: WorkerPublicProfile, allowLoopback: boolean): WorkerPublicProfile {
  if (!profile || typeof profile.url !== 'string' || typeof profile.ca !== 'string' || typeof profile.fingerprint !== 'string' || profile.ca.length > 8192) bad();
  let url: URL; try { url = new URL(profile.url); } catch { return bad(); }
  const ip = url.hostname, octets = ip.split('.').map(Number);
  const privateAddress = isIP(ip) === 4 && (octets[0] === 10 || octets[0] === 192 && octets[1] === 168 || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31);
  const loopback = allowLoopback && isIP(ip) === 4 && octets[0] === 127;
  if (url.protocol !== 'https:' || !(privateAddress || loopback) || url.username || url.password || url.search || url.hash || url.pathname !== '/') bad();
  const pin = fingerprint(profile.fingerprint);
  if (!/^[a-f0-9]{64}$/.test(pin) || (profile.ca.match(/-----BEGIN CERTIFICATE-----/g)?.length ?? 0) !== 1) bad();
  try { const certificate = new X509Certificate(profile.ca); if (createHash('sha256').update(certificate.raw).digest('hex') !== pin) bad(); } catch { return bad(); }
  return { url: url.origin, ca: profile.ca, fingerprint: pin };
}
function nodeRequester(input: WorkerRequest): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const agent = new Agent({ ca: input.profile.ca, rejectUnauthorized: true, checkServerIdentity });
    const req = httpsRequest(new URL(input.path, input.profile.url), { method: input.method, agent, headers: input.headers, timeout: 15000 }, response => {
      let size = 0; const parts: Buffer[] = [];
      response.on('data', (part: Buffer) => { size += part.length; if (size > MAX_RESPONSE) response.destroy(new Error('Response too large')); else parts.push(part); });
      response.on('error', () => { agent.destroy(); reject(new WorkerConnectionError('Controller connection failed')); });
      response.on('end', () => {
        agent.destroy(); let body: unknown;
        try { const text = Buffer.concat(parts).toString('utf8'); body = text ? JSON.parse(text) : {}; } catch { reject(new WorkerConnectionError('Controller returned an invalid response')); return; }
        resolve({ status: response.statusCode ?? 500, body });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.on('error', () => { agent.destroy(); reject(new WorkerConnectionError('Controller connection failed')); });
    req.end(input.body);
  });
}
export class WorkerConnection {
  private identity?: WorkerIdentity;
  private requester: WorkerRequester;
  constructor(private vault: WorkerSecretVault, private options: { request?: WorkerRequester; allowLoopbackForTests?: boolean; clock?: () => number } = {}) { this.requester = options.request ?? nodeRequester; }
  publicProfile(): WorkerPublicProfile | undefined { const i = this.identity; return i ? { url: i.url, ca: i.ca, fingerprint: i.fingerprint } : undefined; }
  deviceId() { return this.identity?.deviceId; }
  async load() {
    let raw: string | null | undefined;
    try { raw = await this.vault.get(SECRET); } catch { throw new WorkerConnectionError('Worker identity is unavailable'); }
    if (!raw) return false;
    try {
      if (Buffer.byteLength(raw) > 16384) bad();
      const value = JSON.parse(raw) as WorkerIdentity, profile = validProfile(value, !!this.options.allowLoopbackForTests);
      if (value.version !== 1 || typeof value.deviceId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(value.deviceId) || typeof value.privateKey !== 'string' || !value.privateKey.startsWith('-----BEGIN PRIVATE KEY-----')) bad();
      // Validate the private key without exporting it or logging an underlying crypto error.
      const key = createPrivateKey(value.privateKey);
      if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') bad();
      sign('sha256', Buffer.from('worker-identity-check'), { key, dsaEncoding: 'ieee-p1363' });
      this.identity = { version: 1, deviceId: value.deviceId, privateKey: value.privateKey, ...profile }; return true;
    } catch { throw new WorkerConnectionError('Stored worker identity is invalid; explicitly clear it before pairing again'); }
  }
  async clearIdentity() { try { await this.vault.remove(SECRET); this.identity = undefined; } catch { throw new WorkerConnectionError('Could not clear the worker identity'); } }
  async pair(profile: WorkerPublicProfile, code: string, name: string) {
    let existing: string | null | undefined;
    try { existing = await this.vault.get(SECRET); } catch { throw new WorkerConnectionError('Worker identity is unavailable'); }
    if (this.identity || existing) throw new WorkerConnectionError('Clear the existing identity before pairing again');
    const checked = validProfile(profile, !!this.options.allowLoopbackForTests);
    if (typeof code !== 'string' || code.length < 4 || code.length > 128 || typeof name !== 'string' || !name.trim() || name.length > 80) bad('Invalid pairing input');
    const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), jwk = keys.publicKey.export({ format: 'jwk' });
    const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const result = await this.send(checked, '/api/network/pair', 'POST', { code, name, platform: platform(), publicKey: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } }, { privateKey });
    const device = result as { id?: unknown; role?: unknown };
    if (!device || device.role !== 'worker' || typeof device.id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(device.id)) throw new WorkerConnectionError('Pairing did not grant a worker identity');
    const identity: WorkerIdentity = { version: 1, deviceId: device.id, ...checked, privateKey };
    const serialized = JSON.stringify(identity); if (Buffer.byteLength(serialized) > 16384) bad('Worker identity exceeds secure storage limits');
    try { await this.vault.set(SECRET, serialized); } catch { throw new WorkerConnectionError('Could not protect the worker identity'); }
    this.identity = identity; return { deviceId: identity.deviceId };
  }
  async request<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> {
    if (!this.identity) throw new WorkerConnectionError('Worker is not paired');
    return this.send(this.identity, path, method, body, this.identity) as Promise<T>;
  }
  private async send(profile: WorkerPublicProfile, path: string, method: string, body?: unknown, identity?: { privateKey: string; deviceId?: string }): Promise<unknown> {
    if (!path.startsWith('/api/network/') || path.startsWith('//') || path.includes('#') || !['GET', 'POST'].includes(method)) bad('Invalid worker request');
    let bytes: Buffer;
    try { bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)); } catch { return bad('Invalid worker request'); }
    if (bytes.length > MAX_REQUEST) bad('Worker request exceeds size limit');
    const headers: Record<string, string> = { 'content-type': 'application/json', 'content-length': String(bytes.length) };
    if (identity) {
      const timestamp = this.options.clock?.() ?? Date.now(), nonce = randomBytes(24).toString('base64url');
      if (identity.deviceId) headers['X-Relay-Device'] = identity.deviceId;
      headers['X-Relay-Timestamp'] = String(timestamp); headers['X-Relay-Nonce'] = nonce;
      headers['X-Relay-Signature'] = sign('sha256', Buffer.from(signingPayload(method, path, timestamp, nonce, bodyHash(bytes))), { key: identity.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    }
    let result: { status: number; body: unknown };
    try { result = await this.requester({ profile, path, method, body: bytes, headers }); } catch { throw new WorkerConnectionError('Controller connection failed'); }
    if (result.status < 200 || result.status >= 300) throw new WorkerConnectionError(result.status === 401 || result.status === 403 ? 'Worker authorization was rejected' : 'Controller rejected the worker request', result.status);
    return result.body;
  }
}
