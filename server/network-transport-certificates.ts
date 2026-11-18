import 'reflect-metadata';
import { BasicConstraintsExtension, X509CertificateGenerator } from '@peculiar/x509';
import { createPrivateKey, createPublicKey, randomBytes, randomUUID, webcrypto, X509Certificate } from 'node:crypto';
import type { SecretVaultLike } from './typesafe.js';
import type { NetworkCertificates } from './network-certificates.js';

export interface TransportCatalog { payload: string; signature: string }
export interface TransportProfile { kind: 'webtransport-v1'; endpoint: string; pin: string }
export interface TransportLeaf { sha256: string; notBefore: number; notAfter: number }
interface SavedLeaf { cert: string; key: string }
interface Descriptor extends TransportLeaf { chunk: number; index: number }
interface Manifest { version: 1; sequence: number; endpoint: string; hostFingerprint: string; issuedAt: number; refs: string[]; leaves: Descriptor[] }
export interface TransportMaterial { profile: TransportProfile; catalog: TransportCatalog; cert: string; key: string }
const MANIFEST = 'network-transport-manifest';
const REF = /^network-transport-epoch-[a-f0-9]{32}$/;
const DAY = 86_400_000, MAX_SECRET = 16_384;
const queues = new WeakMap<object, Promise<void>>();
const failed = (): never => { throw new Error('Secure QR certificate material unavailable'); };
const fingerprint = (cert: X509Certificate): string => cert.fingerprint256.replaceAll(':', '').toLowerCase();
const pem = (der: ArrayBuffer): string => '-----BEGIN PRIVATE KEY-----\n' + Buffer.from(der).toString('base64').match(/.{1,64}/g)!.join('\n') + '\n-----END PRIVATE KEY-----\n';

/** Independent epoch keys/DER live in immutable encrypted chunks. One bounded encrypted
 * manifest atomically publishes their descriptors. Restart decrypts only the current chunk. */
export class NetworkTransportCertificates {
  private cached: { manifest: Manifest; chunks: Map<string, SavedLeaf[]>; material?: TransportMaterial } | undefined;
  private epoch = 0;
  constructor(private readonly vault: Pick<SecretVaultLike, 'get' | 'set' | 'remove'>,
    private readonly roots: NetworkCertificates, private readonly clock: () => number = Date.now, private readonly allowLoopback = false) {}
  clear(): void { this.epoch++; this.cached = undefined; }
  current(): TransportMaterial | undefined { return this.cached?.material; }
  material(endpoint: string): Promise<TransportMaterial> {
    const started = this.epoch;
    const task = (queues.get(this.vault) ?? Promise.resolve()).then(() => this.load(endpoint, started));
    queues.set(this.vault, task.then(() => undefined, () => undefined)); return task;
  }
  private now(): number { const value = this.clock(); if (!Number.isSafeInteger(value) || value < 0) return failed(); return value; }
  private leaf(saved: SavedLeaf): TransportLeaf {
    if (!saved || typeof saved.cert !== 'string' || saved.cert.length > 8192 || typeof saved.key !== 'string' || saved.key.length > 4096) return failed();
    const cert = new X509Certificate(saved.cert), key = createPrivateKey(saved.key);
    if (cert.ca || key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
      || !cert.verify(cert.publicKey) || cert.publicKey.asymmetricKeyType !== 'ec'
      || cert.publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
      || !createPublicKey(key).export({ type: 'spki', format: 'der' }).equals(cert.publicKey.export({ type: 'spki', format: 'der' }))) return failed();
    const notBefore = Date.parse(cert.validFrom), notAfter = Date.parse(cert.validTo);
    if (!Number.isSafeInteger(notBefore) || !Number.isSafeInteger(notAfter) || notAfter <= notBefore || notAfter - notBefore > 14 * DAY) return failed();
    return { sha256: fingerprint(cert), notBefore, notAfter };
  }
  private async generate(start: number): Promise<SavedLeaf> {
    const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const cert = await X509CertificateGenerator.createSelfSigned({ name: 'CN=Relay QR Transport', serialNumber: randomBytes(16).toString('hex'),
      keys: keys as unknown as CryptoKeyPair, signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
      notBefore: new Date(start), notAfter: new Date(start + 12 * DAY),
      extensions: [new BasicConstraintsExtension(false, undefined, true)] }, webcrypto as unknown as Crypto);
    return { cert: cert.toString('pem'), key: pem(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)) };
  }
  private validateManifest(value: unknown, hostFingerprint: string): Manifest {
    const data = value as Manifest;
    if (!data || data.version !== 1 || !Number.isSafeInteger(data.sequence) || data.sequence < 1
      || !Number.isSafeInteger(data.issuedAt) || data.issuedAt < 0 || data.issuedAt > this.now() + 300_000 || data.hostFingerprint !== hostFingerprint
      || typeof data.endpoint !== 'string' || !Array.isArray(data.refs) || data.refs.length < 1 || data.refs.length > 10
      || data.refs.some(ref => typeof ref !== 'string' || !REF.test(ref)) || new Set(data.refs).size !== data.refs.length
      || !Array.isArray(data.leaves) || !data.leaves.length || data.leaves.length > 80) return failed();
    const hashes = new Set<string>(), slots = new Set<string>();
    for (const [index, leaf] of data.leaves.entries()) {
      if (!leaf || !/^[a-f0-9]{64}$/.test(leaf.sha256) || hashes.has(leaf.sha256)
        || !Number.isSafeInteger(leaf.notBefore) || !Number.isSafeInteger(leaf.notAfter) || leaf.notAfter <= leaf.notBefore
        || leaf.notAfter - leaf.notBefore > 14 * DAY || leaf.notAfter > data.issuedAt + 750 * DAY
        || !Number.isSafeInteger(leaf.chunk) || leaf.chunk < 0 || leaf.chunk >= data.refs.length
        || !Number.isSafeInteger(leaf.index) || leaf.index < 0 || leaf.index >= 8
        || slots.has(leaf.chunk + ':' + leaf.index) || (index > 0 && (leaf.notBefore <= data.leaves[index - 1]!.notBefore || leaf.notBefore > data.leaves[index - 1]!.notAfter))) return failed();
      hashes.add(leaf.sha256); slots.add(leaf.chunk + ':' + leaf.index);
    }
    return data;
  }
  private async saved(manifest: Manifest, descriptor: Descriptor, chunks: Map<string, SavedLeaf[]>): Promise<SavedLeaf> {
    const ref = manifest.refs[descriptor.chunk]!; let chunk = chunks.get(ref);
    if (!chunk) {
      const text = await this.vault.get(ref); if (!text || Buffer.byteLength(text) > MAX_SECRET) return failed();
      const parsed = JSON.parse(text) as { version: number; leaves: SavedLeaf[] };
      if (parsed.version !== 1 || !Array.isArray(parsed.leaves) || !parsed.leaves.length || parsed.leaves.length > 8) return failed();
      chunk = parsed.leaves; chunks.set(ref, chunk);
    }
    const saved = chunk[descriptor.index]; if (!saved) return failed(); const meta = this.leaf(saved);
    if (meta.sha256 !== descriptor.sha256 || meta.notBefore !== descriptor.notBefore || meta.notAfter !== descriptor.notAfter) return failed();
    return saved;
  }
  private async publish(previous: Manifest | undefined, endpoint: string, hostFingerprint: string, now: number,
    leaves: SavedLeaf[], started: number): Promise<{manifest: Manifest; chunks: Map<string, SavedLeaf[]>}> {
    const refs: string[] = [], descriptors: Descriptor[] = [], owned: string[] = [], chunks = new Map<string, SavedLeaf[]>();
    if (previous && previous.sequence >= Number.MAX_SAFE_INTEGER) return failed();
    try {
      for (let index = 0; index < leaves.length; index += 8) {
        if (started !== this.epoch) return failed();
        const ref = 'network-transport-epoch-' + randomUUID().replaceAll('-', ''), batch = leaves.slice(index, index + 8);
        const text = JSON.stringify({ version: 1, leaves: batch }); if (Buffer.byteLength(text) > MAX_SECRET) return failed();
        owned.push(ref); await this.vault.set(ref, text); if (await this.vault.get(ref) !== text) return failed();
        for (const [slot, saved] of batch.entries()) descriptors.push({ ...this.leaf(saved), chunk: refs.length, index: slot });
        refs.push(ref); chunks.set(ref, batch);
      }
      const next: Manifest = { version: 1, sequence: (previous?.sequence ?? 0) + 1, endpoint, hostFingerprint, issuedAt: now, refs, leaves: descriptors };
      this.validateManifest(next, hostFingerprint); const text = JSON.stringify(next);
      if (Buffer.byteLength(text) > MAX_SECRET || started !== this.epoch) return failed(); await this.vault.set(MANIFEST, text);
      if (await this.vault.get(MANIFEST) !== text) return failed();
      owned.length = 0; // Publication committed; keys must survive subsequent shutdown/failure.
      for (const ref of previous?.refs ?? []) { try { await this.vault.remove(ref); } catch {} }
      return { manifest: next, chunks };
    } catch {
      // A read-back error leaves publication uncertain; preserve anything it might reference.
      let published: string[] = [];
      try { const text = await this.vault.get(MANIFEST); if (text) published = this.validateManifest(JSON.parse(text), hostFingerprint).refs; } catch { return failed(); }
      for (const ref of owned) if (!published.includes(ref)) { try { await this.vault.remove(ref); } catch {} }
      return failed();
    }
  }
  private async load(endpoint: string, started: number): Promise<TransportMaterial> {
    if (started !== this.epoch) return failed();
    const now = this.now(), root = this.roots.publicCA(); if (!root) return failed();
    const url = new URL(endpoint);
    const parts = url.hostname.split('.').map(Number);
    if (url.protocol !== 'https:' || url.pathname !== '/relay' || url.search || url.hash || url.username || url.password || url.href !== endpoint
      || !/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(url.hostname) || parts.some(value => value > 255)
      || !(parts[0] === 10 || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) || (parts[0] === 192 && parts[1] === 168) || (this.allowLoopback && parts[0] === 127))) return failed();
    let manifest = this.cached?.manifest, chunks = this.cached?.chunks ?? new Map<string, SavedLeaf[]>();
    if (!manifest) { const text = await this.vault.get(MANIFEST); if (text != null) { if (Buffer.byteLength(text) > MAX_SECRET) return failed(); manifest = this.validateManifest(JSON.parse(text), root.fingerprint); } }
    if (started !== this.epoch) return failed();
    if (manifest) this.validateManifest(manifest, root.fingerprint);
    const renew = !manifest || manifest.endpoint !== endpoint || manifest.leaves.at(-1)!.notAfter < now + 700 * DAY;
    if (renew) {
      const saved: SavedLeaf[] = [];
      for (const descriptor of manifest?.leaves ?? []) if (descriptor.notAfter > now) saved.push(await this.saved(manifest!, descriptor, chunks));
      let start = saved.length ? this.leaf(saved.at(-1)!).notBefore + 10 * DAY : Math.floor((now - 300_000) / 1000) * 1000;
      while (!saved.length || this.leaf(saved.at(-1)!).notAfter < now + 740 * DAY) {
        if (started !== this.epoch) return failed();
        if (saved.length >= 80) return failed(); saved.push(await this.generate(start)); start += 10 * DAY;
      }
      ({manifest, chunks} = await this.publish(manifest, endpoint, root.fingerprint, now, saved, started));
    }
    if (!manifest || started !== this.epoch || this.roots.publicCA()?.fingerprint !== root.fingerprint) return failed();
    const current = manifest.leaves.filter(value => value.notBefore <= now && value.notAfter > now + 60_000).at(-1); if (!current) return failed();
    const saved = await this.saved(manifest, current, chunks);
    const payload = JSON.stringify({ version: 1, hostFingerprint: root.fingerprint, sequence: manifest.sequence,
      issuedAt: manifest.issuedAt, expiresAt: manifest.leaves.at(-1)!.notAfter, endpoint,
      leaves: manifest.leaves.map(({sha256,notBefore,notAfter}) => ({sha256,notBefore,notAfter})) });
    if (Buffer.byteLength(payload) > 32768) return failed();
    const old = this.cached?.material?.catalog;
    const catalog = old?.payload === payload ? old : { payload, signature: await this.roots.signTransportCatalog(payload) };
    if (started !== this.epoch) return failed();
    const material: TransportMaterial = { profile: { kind: 'webtransport-v1', endpoint, pin: current.sha256 }, catalog, cert: saved.cert, key: saved.key };
    this.cached = { manifest, chunks, material }; return material;
  }
}
