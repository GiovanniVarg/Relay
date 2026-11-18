import { createHash, createPublicKey, randomBytes, randomUUID, verify as verifySignature } from 'node:crypto';
import { Store } from './store.js';
import { HttpError } from './security.js';

export type DeviceRole = 'controller' | 'worker';
export type PublicDeviceKey = { kty: 'EC'; crv: 'P-256'; x: string; y: string };
export interface DeviceRecord {
  id: string;
  role: DeviceRole;
  name: string;
  platform: string;
  publicKey: PublicDeviceKey;
  fingerprint: string;
  createdAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
}
interface StoredDevice extends DeviceRecord {
  highWater: number;
  nonces: Record<string, number>;
}
interface Invite { id: string; role: DeviceRole; createdAt: number; expiresAt: number }
export interface RequestProof {
  method: string;
  path: string;
  timestamp: number;
  nonce: string;
  body: Buffer;
  signature: string;
}

const DEVICES = 'network-devices';
const INVITES = 'network-invites';
const WINDOW = 90_000;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const fail = (status = 401): never => { throw new HttpError(status, 'Network authentication failed'); };
const roleValid = (role: unknown): role is DeviceRole => role === 'controller' || role === 'worker';
const timeValid = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export const bodyHash = (body: Buffer): string => createHash('sha256').update(body).digest('hex');

export function signingPayload(method: string, path: string, timestamp: number, nonce: string, hash: string): string {
  return JSON.stringify(['relay-device-v1', method, path, String(timestamp), nonce, hash]);
}

function decode(value: unknown, length: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return fail();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== length || bytes.toString('base64url') !== value) return fail();
  return bytes;
}

function publicKey(value: unknown): PublicDeviceKey {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const key = value as Record<string, unknown>;
  if (Object.keys(key).sort().join(',') !== 'crv,kty,x,y' || key.kty !== 'EC' || key.crv !== 'P-256') return fail();
  decode(key.x, 32);
  decode(key.y, 32);
  const result: PublicDeviceKey = { kty: 'EC', crv: 'P-256', x: key.x as string, y: key.y as string };
  try { createPublicKey({ key: result, format: 'jwk' }); } catch { return fail(); }
  return result;
}

function fingerprint(key: PublicDeviceKey): string {
  return createHash('sha256').update(JSON.stringify(key)).digest('hex');
}

function metadata(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[\u0000-\u001f\u007f]/.test(value)) return fail(400);
  return value.trim();
}

function readDevice(value: unknown): StoredDevice {
  if (!value || typeof value !== 'object') return fail();
  const d = value as StoredDevice;
  if (typeof d.id !== 'string' || !/^[a-f0-9-]{36}$/.test(d.id) || !roleValid(d.role)
    || !timeValid(d.createdAt) || !timeValid(d.lastSeenAt) || !timeValid(d.highWater)
    || (d.revokedAt !== null && !timeValid(d.revokedAt)) || d.highWater < d.createdAt
    || !d.nonces || typeof d.nonces !== 'object' || Array.isArray(d.nonces)) return fail();
  metadata(d.name);
  metadata(d.platform);
  const key = publicKey(d.publicKey);
  if (d.fingerprint !== fingerprint(key)) return fail();
  const entries = Object.entries(d.nonces);
  if (entries.length > 4096 || entries.some(([nonce, timestamp]) => !/^[A-Za-z0-9_-]{16,100}$/.test(nonce)
    || !timeValid(timestamp) || timestamp > d.highWater || timestamp < d.highWater - WINDOW)) return fail();
  return d;
}

function exposed(d: StoredDevice): DeviceRecord {
  return { id: d.id, role: d.role, name: d.name, platform: d.platform,
    publicKey: { ...d.publicKey }, fingerprint: d.fingerprint, createdAt: d.createdAt,
    lastSeenAt: d.lastSeenAt, revokedAt: d.revokedAt };
}

function checkProof(key: PublicDeviceKey, proof: RequestProof, now: number): void {
  if (!proof || !/^[A-Z]{1,16}$/.test(proof.method) || typeof proof.path !== 'string'
    || !proof.path.startsWith('/') || proof.path.length > 4096 || /[\r\n\u0000]/.test(proof.path)
    || !timeValid(proof.timestamp) || Math.abs(now - proof.timestamp) > WINDOW
    || typeof proof.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(proof.nonce)
    || !Buffer.isBuffer(proof.body)) return fail();
  const signature = decode(proof.signature, 64);
  try {
    if (!verifySignature('sha256', Buffer.from(signingPayload(proof.method, proof.path,
      proof.timestamp, proof.nonce, bodyHash(proof.body))),
    { key: createPublicKey({ key, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, signature)) return fail();
  } catch { return fail(); }
}

function inviteId(code: unknown): string {
  if (typeof code !== 'string' || code.length > 32) return fail();
  const normalized = code.trim().toUpperCase();
  if (!/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(normalized)) return fail();
  return createHash('sha256').update(normalized).digest('hex');
}

export class NetworkDevices {
  private readonly clock: () => number;
  constructor(private readonly store: Store, options: { clock?: () => number } = {}) {
    this.clock = options.clock ?? Date.now;
  }

  private now(): number {
    const now = this.clock();
    if (!timeValid(now)) return fail(503);
    return now;
  }

  createInvite(role: DeviceRole): { code: string; expiresAt: number } {
    if (!roleValid(role)) return fail(400);
    const now = this.now();
    let code = '';
    let bits = BigInt('0x' + randomBytes(8).toString('hex'));
    for (let i = 0; i < 12; i++) { code += ALPHABET[Number(bits & 31n)]; bits >>= 5n; }
    code = `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
    const expiresAt = now + 300_000;
    this.store.transaction(() => {
      const invites = this.store.list<Invite>(INVITES);
      for (const invite of invites) {
        if (!timeValid(invite.expiresAt) || !roleValid(invite.role)) return fail(503);
        if (invite.expiresAt <= now) this.store.remove(INVITES, invite.id);
      }
      if (invites.filter(invite => invite.expiresAt > now).length >= 10) return fail(429);
      this.store.put(INVITES, { id: inviteId(code), role, createdAt: now, expiresAt });
    });
    return { code, expiresAt };
  }

  pair(input: { code: string; name: string; platform: string; publicKey: unknown }, proof: RequestProof): DeviceRecord {
    const now = this.now();
    const key = publicKey(input.publicKey);
    const name = metadata(input.name);
    const platform = metadata(input.platform);
    if (proof.method !== 'POST' || proof.path !== '/api/network/pair') return fail();
    checkProof(key, proof, now);
    const id = inviteId(input.code);
    let result!: DeviceRecord;
    this.store.transaction(() => {
      const invite = this.store.get<Invite>(INVITES, id);
      if (!invite || invite.id !== id || !roleValid(invite.role) || !timeValid(invite.createdAt)
        || !timeValid(invite.expiresAt) || invite.expiresAt <= now || invite.createdAt > now) return fail();
      const devices = this.store.list<StoredDevice>(DEVICES).map(readDevice);
      const active = devices.filter(d => d.revokedAt === null);
      const fp = fingerprint(key);
      // Keep identities distinct even after revocation: the signed protocol does
      // not include deviceId, so reusing a key could replay an earlier identity's proof.
      if (active.length >= 100 || devices.some(d => d.fingerprint === fp)) return fail(409);
      const device: StoredDevice = { id: randomUUID(), role: invite.role, name, platform,
        publicKey: key, fingerprint: fp, createdAt: now, lastSeenAt: now, revokedAt: null,
        highWater: Math.max(now, proof.timestamp), nonces: { [proof.nonce]: proof.timestamp } };
      this.store.put(DEVICES, device);
      this.store.remove(INVITES, id);
      result = exposed(device);
    });
    return result;
  }

  verify(input: RequestProof & { deviceId: string }, requiredRole?: DeviceRole): DeviceRecord {
    const now = this.now();
    const initial = readDevice(this.store.get<StoredDevice>(DEVICES, input.deviceId));
    if (initial.revokedAt !== null || (requiredRole !== undefined && initial.role !== requiredRole)) return fail(403);
    checkProof(initial.publicKey, input, now);
    let result!: DeviceRecord;
    this.store.transaction(() => {
      const device = readDevice(this.store.get<StoredDevice>(DEVICES, input.deviceId));
      if (device.revokedAt !== null || device.fingerprint !== initial.fingerprint
        || device.role !== initial.role || (requiredRole !== undefined && device.role !== requiredRole)) return fail(403);
      if (input.timestamp < device.highWater - WINDOW || Object.hasOwn(device.nonces, input.nonce)) return fail();
      const highWater = Math.max(device.highWater, input.timestamp);
      const nonces = Object.fromEntries(Object.entries(device.nonces).filter(([, t]) => t >= highWater - WINDOW));
      if (Object.keys(nonces).length >= 4096) return fail(429);
      nonces[input.nonce] = input.timestamp;
      const updated = { ...device, highWater, nonces, lastSeenAt: Math.max(now, device.lastSeenAt) };
      this.store.put(DEVICES, updated);
      result = exposed(updated);
    });
    return result;
  }

  get(id: string): DeviceRecord | undefined {
    const device = this.store.get<StoredDevice>(DEVICES, id);
    return device ? exposed(readDevice(device)) : undefined;
  }

  list(): DeviceRecord[] { return this.store.list<StoredDevice>(DEVICES).map(d => exposed(readDevice(d))); }

  revoke(id: string): void {
    const now = this.now();
    this.store.transaction(() => {
      const existing = this.store.get<StoredDevice>(DEVICES, id);
      if (!existing) return;
      const device = readDevice(existing);
      if (device.revokedAt === null) this.store.put(DEVICES, { ...device, revokedAt: now });
    });
  }
}
