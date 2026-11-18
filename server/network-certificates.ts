import 'reflect-metadata';
import { BasicConstraintsExtension, ExtendedKeyUsageExtension, KeyUsageFlags,
  KeyUsagesExtension, SubjectAlternativeNameExtension, X509CertificateGenerator } from '@peculiar/x509';
import { createPrivateKey, createPublicKey, sign, webcrypto, X509Certificate, type KeyObject } from 'node:crypto';
import type { SecretVaultLike } from './typesafe.js';
import type { Store } from './store.js';

type Vault = Pick<SecretVaultLike, 'get' | 'set' | 'remove'>;
interface CertificateRecord {
  id: 'network-certificates';
  version: 1;
  ca: string;
  cert: string;
  address: string;
  hostname: string | null;
}
export interface NetworkTlsMaterial {
  key: string;
  cert: string;
  ca: string;
  fingerprint: string;
  rootFingerprint: string;
  expiresAt: string;
}
const RECORD = 'network-certificates';
const CA_KEY = 'network-ca-key';
const LEAF_KEY = 'network-leaf-key';
const DAY = 86_400_000;
const certificateQueues = new WeakMap<Store, Promise<void>>();
const cryptoProvider = webcrypto as unknown as Crypto;
const algorithm = { name: 'ECDSA', hash: 'SHA-256' };
const unavailable = (): never => { throw new Error('Network certificate material unavailable'); };

function addressValid(address: unknown, allowLoopback: boolean): address is string {
  if (typeof address !== 'string' || !/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(address)) return false;
  const parts = address.split('.').map(Number);
  if (parts.some(part => part > 255)) return false;
  return parts[0] === 10 || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31)
    || (parts[0] === 192 && parts[1] === 168) || (allowLoopback && parts[0] === 127);
}

function hostnameValid(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 253 && value.length > 0
    && !/^\d+(?:\.\d+){3}$/.test(value)
    && value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

function pem(label: string, der: ArrayBuffer): string {
  return `-----BEGIN ${label}-----\n${Buffer.from(der).toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END ${label}-----\n`;
}

function privateKey(value: unknown) {
  if (typeof value !== 'string' || value.length > 16_384 || !value.startsWith('-----BEGIN PRIVATE KEY-----')) return unavailable();
  const key = createPrivateKey(value);
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return unavailable();
  return key;
}

function keyMatches(value: string, certificate: X509Certificate): boolean {
  const actual = createPublicKey(privateKey(value)).export({ format: 'der', type: 'spki' });
  const expected = certificate.publicKey.export({ format: 'der', type: 'spki' });
  return actual.equals(expected);
}

function rootCertificate(value: unknown, now: number): X509Certificate {
  if (typeof value !== 'string' || value.length > 32_768) return unavailable();
  const root = new X509Certificate(value);
  if (!root.ca || root.subject !== root.issuer || !root.verify(root.publicKey)
    || Date.parse(root.validFrom) > now || Date.parse(root.validTo) <= now) return unavailable();
  return root;
}

function readRecord(value: unknown): CertificateRecord {
  if (!value || typeof value !== 'object') return unavailable();
  const record = value as CertificateRecord;
  if (record.id !== RECORD || record.version !== 1 || typeof record.ca !== 'string'
    || typeof record.cert !== 'string' || record.cert.length > 32_768
    || typeof record.address !== 'string' || (record.hostname !== null && !hostnameValid(record.hostname))) return unavailable();
  return record;
}

const certFingerprint = (certificate: X509Certificate): string => certificate.fingerprint256.replaceAll(':', '').toLowerCase();

export class NetworkCertificates {
  private proofKey: { fingerprint: string; key: KeyObject } | undefined;
  private proofEpoch = 0;
  private readonly clock: () => number;
  private readonly allowLoopback: boolean;
  constructor(private readonly store: Store, private readonly vault: Vault,
    options: { clock?: () => number; allowLoopback?: boolean } = {}) {
    this.clock = options.clock ?? Date.now;
    this.allowLoopback = options.allowLoopback === true;
  }

  publicCA(): { certificate: string; fingerprint: string } | null {
    try {
      const value = this.store.get<CertificateRecord>('config', RECORD);
      if (!value) return null;
      const record = readRecord(value);
      const root = rootCertificate(record.ca, this.now());
      return { certificate: record.ca, fingerprint: certFingerprint(root) };
    } catch { return unavailable(); }
  }

  /** Forget private signing material on shutdown; in-flight loads cannot repopulate it. */
  clearHostProof(): void { this.proofEpoch++; this.proofKey = undefined; }

  async hostProof(origin: string, challenge: string): Promise<{ challenge: string; signature: string }> {
    try {
      if (!/^[A-Za-z0-9_-]{32,96}$/.test(challenge)) return unavailable();
      const parsed = new URL(origin);
      if (parsed.origin !== origin || parsed.protocol !== 'https:' || !addressValid(parsed.hostname, this.allowLoopback)) return unavailable();
      const epoch = this.proofEpoch;
      const ca = this.publicCA();
      if (!ca) return unavailable();
      let cached = this.proofKey;
      if (!cached || cached.fingerprint !== ca.fingerprint) {
        const value = await this.vault.get(CA_KEY);
        const root = rootCertificate(ca.certificate, this.now());
        if (!value || !keyMatches(value, root)) return unavailable();
        cached = { fingerprint: ca.fingerprint, key: privateKey(value) };
      }
      // A concurrent close or certificate replacement must fail closed.
      if (epoch !== this.proofEpoch || this.publicCA()?.fingerprint !== ca.fingerprint) return unavailable();
      this.proofKey = cached;
      const message = JSON.stringify(['relay-host-proof-v1', origin, challenge, ca.fingerprint]);
      const signature = sign('sha256', Buffer.from(message), { key: cached.key, dsaEncoding: 'ieee-p1363' });
      if (signature.length !== 64) return unavailable();
      return { challenge, signature: signature.toString('base64url') };
    } catch { return unavailable(); }
  }

  /** Fixed domain: only typed transport catalogs use this stable host identity. */
  async signTransportCatalog(payload: string): Promise<string> {
    try {
      if (typeof payload !== 'string' || Buffer.byteLength(payload) > 32768) return unavailable();
      const epoch = this.proofEpoch, ca = this.publicCA(); if (!ca) return unavailable();
      let cached = this.proofKey;
      if (!cached || cached.fingerprint !== ca.fingerprint) {
        const value = await this.vault.get(CA_KEY), root = rootCertificate(ca.certificate, this.now());
        if (!value || !keyMatches(value, root)) return unavailable();
        cached = { fingerprint: ca.fingerprint, key: privateKey(value) };
      }
      if (epoch !== this.proofEpoch || this.publicCA()?.fingerprint !== ca.fingerprint) return unavailable();
      this.proofKey = cached;
      const message = JSON.stringify(['relay-transport-catalog-v1', payload]);
      const signature = sign('sha256', Buffer.from(message), { key: cached.key, dsaEncoding: 'ieee-p1363' });
      if (signature.length !== 64) return unavailable(); return signature.toString('base64url');
    } catch { return unavailable(); }
  }

  material(address: string, hostname?: string): Promise<NetworkTlsMaterial> {
    const task = (certificateQueues.get(this.store) ?? Promise.resolve()).then(async () => {
      try { return await this.loadMaterial(address, hostname); } catch { return unavailable(); }
    });
    certificateQueues.set(this.store, task.then(() => undefined, () => undefined));
    return task;
  }

  private now(): number {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0) return unavailable();
    return now;
  }

  private async loadMaterial(address: string, hostname?: string): Promise<NetworkTlsMaterial> {
    if (!addressValid(address, this.allowLoopback) || (hostname !== undefined && !hostnameValid(hostname))) return unavailable();
    const requestedHost = hostname?.toLowerCase() ?? null;
    const now = this.now();
    const value = this.store.get<CertificateRecord>('config', RECORD);
    const caKey = await this.vault.get(CA_KEY);
    const leafKey = await this.vault.get(LEAF_KEY);
    if (!value) {
      if (caKey != null || leafKey != null) return unavailable();
      return this.initialize(address, requestedHost, now);
    }
    if (!caKey || !leafKey) return unavailable();
    const record = readRecord(value);
    if (!addressValid(record.address, this.allowLoopback)) return unavailable();
    const root = rootCertificate(record.ca, now);
    const leaf = new X509Certificate(record.cert);
    if (!keyMatches(caKey, root) || !keyMatches(leafKey, leaf) || leaf.ca
      || !leaf.checkIssued(root) || !leaf.verify(root.publicKey)
      || Date.parse(leaf.validFrom) > now || !leaf.checkIP(record.address)
      || (record.hostname !== null && !leaf.checkHost(record.hostname, { subject: 'never' }))) return unavailable();
    if (record.address !== address || record.hostname !== requestedHost || Date.parse(leaf.validTo) - now <= 14 * DAY) {
      const caPrivate = await this.importPrivate(caKey);
      const leafPrivate = privateKey(leafKey);
      const leafPublic = await webcrypto.subtle.importKey('spki',
        createPublicKey(leafPrivate).export({ type: 'spki', format: 'der' }),
        { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
      const cert = await this.issueLeaf(address, requestedHost, root.subject, caPrivate, leafPublic, now,
        Math.min(now + 90 * DAY, Date.parse(root.validTo)));
      const updated: CertificateRecord = { ...record, cert, address, hostname: requestedHost };
      this.store.transaction(() => this.store.put('config', updated));
      return this.result(updated, leafKey);
    }
    return this.result(record, leafKey);
  }

  private async initialize(address: string, hostname: string | null, now: number): Promise<NetworkTlsMaterial> {
    const caKeys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const leafKeys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const root = await X509CertificateGenerator.createSelfSigned({
      name: 'CN=Relay Local Network', keys: caKeys as unknown as CryptoKeyPair, signingAlgorithm: algorithm,
      notBefore: new Date(now - 5 * 60_000), notAfter: new Date(now + 3650 * DAY),
      extensions: [new BasicConstraintsExtension(true, 0, true),
        new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true)],
    }, cryptoProvider);
    const ca = root.toString('pem');
    const cert = await this.issueLeaf(address, hostname, root.subject,
      caKeys.privateKey, leafKeys.publicKey, now, now + 90 * DAY);
    const caPem = pem('PRIVATE KEY', await webcrypto.subtle.exportKey('pkcs8', caKeys.privateKey));
    const leafPem = pem('PRIVATE KEY', await webcrypto.subtle.exportKey('pkcs8', leafKeys.privateKey));
    const record: CertificateRecord = { id: RECORD, version: 1, ca, cert, address, hostname };
    const written: string[] = [];
    try {
      // Only keys created by this initialization may be removed on failure.
      if (await this.vault.get(CA_KEY) != null || await this.vault.get(LEAF_KEY) != null) return unavailable();
      written.push(CA_KEY);
      await this.vault.set(CA_KEY, caPem);
      written.push(LEAF_KEY);
      await this.vault.set(LEAF_KEY, leafPem);
      if (!keyMatches((await this.vault.get(CA_KEY)) ?? '', new X509Certificate(ca))
        || !keyMatches((await this.vault.get(LEAF_KEY)) ?? '', new X509Certificate(cert))) return unavailable();
      this.store.transaction(() => this.store.put('config', record));
      return this.result(record, leafPem);
    } catch {
      for (const name of written) { try { await this.vault.remove(name); } catch { /* Remains partial and fails closed. */ } }
      return unavailable();
    }
  }

  private async importPrivate(value: string) {
    const der = privateKey(value).export({ type: 'pkcs8', format: 'der' });
    return webcrypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  }

  private async issueLeaf(address: string, hostname: string | null, issuer: string,
    signingKey: webcrypto.CryptoKey, publicKey: webcrypto.CryptoKey, now: number, until: number): Promise<string> {
    if (until <= now) return unavailable();
    const names: Array<{ type: 'ip' | 'dns'; value: string }> = [{ type: 'ip', value: address }];
    if (hostname) names.push({ type: 'dns', value: hostname });
    const certificate = await X509CertificateGenerator.create({
      subject: 'CN=Relay', issuer, signingKey: signingKey as unknown as CryptoKey,
      publicKey: publicKey as unknown as CryptoKey, signingAlgorithm: algorithm,
      notBefore: new Date(now - 5 * 60_000), notAfter: new Date(until),
      extensions: [new BasicConstraintsExtension(false, undefined, true),
        new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
        new ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1']), new SubjectAlternativeNameExtension(names)],
    }, cryptoProvider);
    return certificate.toString('pem');
  }

  private result(record: CertificateRecord, key: string): NetworkTlsMaterial {
    const root = new X509Certificate(record.ca);
    const leaf = new X509Certificate(record.cert);
    return { key, cert: record.cert, ca: record.ca, fingerprint: certFingerprint(leaf),
      rootFingerprint: certFingerprint(root), expiresAt: new Date(leaf.validTo).toISOString() };
  }
}
