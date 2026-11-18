import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import { SecretVault } from './secret-vault.js';
import type { SecretVaultLike } from './typesafe.js';
import { HttpError } from './security.js';

type Kind = 'telegram' | 'mcp-connection';
export interface ProtectedRecord { id: string; secretRef?: string; token?: string; hasToken?: boolean; }
const unavailable = () => new HttpError(503, 'Secure integration credential unavailable. Reconnect using secure entry; legacy credentials were preserved if migration failed.');
const reference = /^(telegram|mcp)-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const storageCleanup = 'integration-secret-storage-v1';

/** Retain revoked values for redaction of late responses until shutdown. Never serialized. */
export class KnownSecrets {
  private values = new Set<string>();
  add(value: string) {
    if (!value) return;
    this.values.add(value);
    this.values.add(JSON.stringify(value).slice(1, -1));
  }
  redact<T>(value: T): T {
    const walk = (item: unknown, depth: number): unknown => {
      if (depth > 50) return '[data omitted]';
      if (typeof item === 'string') {
        for (const secret of [...this.values].sort((a, b) => b.length - a.length)) item = (item as string).split(secret).join('[redacted]');
        return item;
      }
      if (Array.isArray(item)) return item.map(child => walk(child, depth + 1));
      if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) => [walk(key, depth + 1), walk(child, depth + 1)]));
      return item;
    };
    return walk(value, 0) as T;
  }
  /** Hold unfinished prefixes so split provider deltas cannot disclose a known credential. */
  stream() {
    let pending = '';
    return {
      push: (text: string) => {
        pending = this.redact(pending + text);
        let hold = 0;
        for (const secret of this.values) for (let n = 1; n < secret.length && n <= pending.length; n++) {
          if (pending.endsWith(secret.slice(0, n))) hold = Math.max(hold, n);
        }
        const safe = pending.slice(0, pending.length - hold);
        pending = pending.slice(pending.length - hold);
        return this.redact(safe);
      },
      flush: () => { const text = this.redact(pending); pending = ''; return text; }
    };
  }
  clear() { this.values.clear(); }
}

/** SQLite carries metadata; only verified vault values can enter the process-local cache. */
export class IntegrationCredentials {
  readonly secrets: KnownSecrets;
  private cache = new Map<string, string>();
  private failures = new Map<string, string>();
  private versions = new Map<string, number>();
  private initialized?: Promise<void>;
  private closed = false;
  constructor(private store: Store, private vault: SecretVaultLike = new SecretVault(store.dataDir), secrets = new KnownSecrets(), private allowInitialize: () => void = () => {}) { this.secrets = secrets; }
  private key(kind: Kind, id: string) { return kind + ':' + id; }
  private current(kind: Kind, record: ProtectedRecord) { return JSON.stringify(this.store.get<ProtectedRecord>(kind, record.id)) === JSON.stringify(record); }
  error(kind: Kind, id: string) { return this.failures.get(this.key(kind, id)); }
  token(record: ProtectedRecord): string | undefined {
    if (this.closed || record.token) throw unavailable();
    if (!record.secretRef) { if (record.hasToken) throw unavailable(); return undefined; }
    const token = this.cache.get(record.secretRef);
    if (!token) throw unavailable();
    return token;
  }
  async initialize() {
    this.checkInitialize();
    if(this.store.inTransaction)throw new Error('Credential initialization requires no active transaction');
    this.store.protectIntegrationCredentialStorage(()=>this.checkInitialize());
    return this.initialized ??= this.load().catch(error=>{this.initialized=undefined;throw error;});
  }
  private checkInitialize() { this.allowInitialize();if(this.closed)throw unavailable(); }
  private async load() {
    // Invalidate even an older successful marker before any await/row replacement.
    // A crash after migration but before compaction must leave cleanup pending.
    const legacy=()=>['telegram','mcp-connection'].some(kind=>this.store.list<ProtectedRecord>(kind).some(record=>!!record.token));
    if(legacy()){this.checkInitialize();this.store.remove('config',storageCleanup);}
    for (const kind of ['telegram', 'mcp-connection'] as const) for (const record of this.store.list<ProtectedRecord>(kind)) {
      const key = this.key(kind, record.id), version = this.versions.get(key) ?? 0;
      if (record.token) this.secrets.add(record.token);
      try {
        if (record.token) {
          const check = () => { this.allowInitialize();if (this.closed || (this.versions.get(key) ?? 0) !== version || !this.current(kind, record)) throw unavailable(); };
          const ref = await this.write(kind, record.token, check);
          check();
          const { token, ...metadata } = record;
          this.store.put(kind, { ...metadata, secretRef: ref, hasToken: true });
        } else if (record.secretRef) {
          if (!reference.test(record.secretRef) || !record.secretRef.startsWith(kind === 'telegram' ? 'telegram-' : 'mcp-')) throw unavailable();
          const token = await this.vault.get(record.secretRef);
          if (!token) throw unavailable();
          this.secrets.add(token);
          if (this.closed || (this.versions.get(key) ?? 0) !== version || !this.current(kind, record)) continue;
          this.cache.set(record.secretRef, token);
        } else if (kind === 'telegram' || record.hasToken) throw unavailable();
        else if (Object.hasOwn(record, 'token')) {
          const { token, ...metadata } = record;
          this.allowInitialize();if (this.current(kind, record)) this.store.put(kind, metadata);
        }
      } catch {
        this.failures.set(key, 'Secure credential migration/storage failed. Reconnect using secure entry.');
      }
    }
    this.checkInitialize();
    if(!this.store.get('config',storageCleanup)){
      this.store.scrubIntegrationCredentialResidue(()=>this.checkInitialize());
      // A failed vault migration deliberately leaves its live plaintext row recoverable.
      // It cannot certify completion; the next startup will retry migration and cleanup.
      if(!legacy()){this.checkInitialize();this.store.put('config',{id:storageCleanup,version:1});}
    }
  }
  /** Immutable new refs isolate replacement, cancelled writes and asynchronous deletion. */
  private async write(kind: Kind, token: string, check: () => void): Promise<string> {
    this.secrets.add(token);
    const ref = (kind === 'telegram' ? 'telegram-' : 'mcp-') + randomUUID();
    try {
      if (!(await this.vault.availability()).available) throw unavailable();
      check();
      await this.vault.set(ref, token, check);
      if (await this.vault.get(ref) !== token) throw unavailable();
      check();
      this.cache.set(ref, token);
      return ref;
    } catch {
      await this.discard(ref);
      throw unavailable();
    }
  }
  async replace<T extends ProtectedRecord>(kind: Kind, metadata: T, token: string, check: () => void = () => {}): Promise<T> {
    const key = this.key(kind, metadata.id), version = (this.versions.get(key) ?? 0) + 1;
    this.versions.set(key, version);
    await this.initialize();
    const old = this.store.get<ProtectedRecord>(kind, metadata.id);
    const guard = () => {
      check();
      if (this.closed || this.versions.get(key) !== version || JSON.stringify(this.store.get<ProtectedRecord>(kind, metadata.id)) !== JSON.stringify(old)) throw unavailable();
    };
    const ref = await this.write(kind, token, guard);
    try {
      guard();
      const { token: _, ...safe } = metadata;
      const record = { ...safe, secretRef: ref, hasToken: true } as T;
      this.store.put(kind, record);
      this.failures.delete(key);
      if (old?.secretRef) await this.discard(old.secretRef);
      return record;
    } catch (error) {
      await this.discard(ref);
      throw error;
    }
  }
  async remove(kind: Kind, id: string): Promise<void> {
    const key = this.key(kind, id), old = this.store.get<ProtectedRecord>(kind, id);
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
    this.store.remove(kind, id);
    this.failures.delete(key);
    if (old?.secretRef) {
      this.cache.delete(old.secretRef);
      try { await this.vault.remove(old.secretRef); }
      catch { throw new HttpError(503, 'Connection revoked, but its encrypted credential could not be removed.'); }
    }
  }
  private async discard(ref: string) { this.cache.delete(ref); await this.vault.remove(ref).catch(() => {}); }
  duplicate(kind: Kind, id: string, token: string) { return this.store.list<ProtectedRecord>(kind).some(record => record.id !== id && (record.token === token || !!record.secretRef && this.cache.get(record.secretRef) === token)); }
  close() { this.closed = true; this.cache.clear(); }
}
