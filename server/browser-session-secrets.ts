import { constants, renameSync, unlinkSync, type Stats } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { Cookie } from 'playwright';
import { SecretVault } from './secret-vault.js';
import type { SecretVaultLike } from './typesafe.js';
import { HttpError } from './security.js';

const MAX_PLAIN = 4 * 1024 * 1024, MAX_ENVELOPE = Math.ceil(MAX_PLAIN / 3) * 4 + 1024;
const failure = () => new HttpError(409, 'The private browser session state could not be verified or decrypted. Review the browser profile before continuing.');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;

/** Cookie payloads stay outside the small credential vault; only independent data keys enter DPAPI. */
export class BrowserSessionSecrets {
  private readonly vault: SecretVaultLike;
  private readonly keys = new Map<string, Buffer>();
  private readonly pendingKeys = new Map<string, Promise<Buffer>>();
  private readonly operations = new Map<string, Promise<unknown>>();
  private readonly createdKeys = new Map<string, string>();
  private persistenceAvailable: boolean | undefined;
  private closed = false;
  private readonly ownsVault: boolean;
  constructor(private readonly dataDirectory: string, vault?: SecretVaultLike) {
    this.vault = vault ?? new SecretVault(dataDirectory); this.ownsVault = !vault;
  }
  close() { this.closed = true; for (const key of this.keys.values()) key.fill(0); this.keys.clear(); this.createdKeys.clear(); if (this.ownsVault) void this.vault.close(); }
  unavailable() { return this.persistenceAvailable === false; }
  private async available() { return this.persistenceAvailable ??= (await this.vault.availability()).available; }
  private name(agent: string) { if (this.closed || !/^[a-z0-9-]{1,44}$/.test(agent)) throw failure(); return 'browser-cookie-key-' + agent; }
  private async safe(path: string, file = false, absent = false): Promise<Stats | null> {
    const ancestors: string[] = []; let cursor = resolve(path);
    while (true) { ancestors.push(cursor); const parent = dirname(cursor); if (parent === cursor) break; cursor = parent; }
    let result: Stats | null = null;
    for (const target of ancestors.reverse()) {
      let stat: Stats; try { stat = await lstat(target); } catch (error) { if (absent && target === resolve(path) && missing(error)) return null; throw failure(); }
      const leaf = target === resolve(path);
      if (stat.isSymbolicLink() || (leaf && file ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())) throw failure();
      result = stat;
    }
    return result;
  }
  async profile(agent: string): Promise<string> {
    this.name(agent);
    try { await this.safe(resolve(this.dataDirectory)); const base = await realpath(this.dataDirectory), directory = join(base, 'browser'), profile = join(directory, agent); for (const target of [directory, profile]) { if (!await this.safe(target, false, true)) { try { await mkdir(target, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } } await this.safe(target); } return profile; } catch { throw failure(); }
  }
  private async read(path: string, limit: number): Promise<{ bytes: Buffer; stat: Stats } | null> {
    const before = await this.safe(path, true, true); if (!before) return null;
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat(); if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit || !same(before, stat)) throw failure();
      const bytes = Buffer.alloc(stat.size + 1); const read = await handle.read(bytes, 0, bytes.length, 0);
      if (read.bytesRead !== stat.size || !same(stat, await handle.stat()) || !same(stat, (await this.safe(path, true))!)) throw failure();
      return { bytes: bytes.subarray(0, read.bytesRead), stat };
    } finally { await handle.close(); }
  }
  private cookies(bytes: Buffer): Cookie[] {
    if (bytes.length > MAX_PLAIN) throw failure(); const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!Array.isArray(value) || value.length > 10000) throw failure();
    for (const cookie of value) {
      if (!cookie || typeof cookie !== 'object' || Array.isArray(cookie) || Object.keys(cookie).some(key => !['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite', 'partitionKey'].includes(key))) throw failure();
      for (const field of ['name', 'value', 'domain', 'path']) if (typeof cookie[field] !== 'string' || cookie[field].length > (field === 'value' ? 65536 : 4096)) throw failure();
      if (!cookie.name || !cookie.domain || !cookie.path.startsWith('/') || cookie.expires !== -1 || typeof cookie.httpOnly !== 'boolean' || typeof cookie.secure !== 'boolean' || !['Strict', 'Lax', 'None'].includes(cookie.sameSite) || (cookie.partitionKey !== undefined && (typeof cookie.partitionKey !== 'string' || cookie.partitionKey.length > 4096))) throw failure();
    }
    return value as Cookie[];
  }
  private async key(agent: string, create: boolean, check: () => void): Promise<Buffer> {
    this.name(agent);
    const cached = this.keys.get(agent); if (cached) return cached;
    const pending = this.pendingKeys.get(agent); if (pending) { const key = await pending; check(); return key; }
    const operation = this.createKey(agent, create, check); this.pendingKeys.set(agent, operation);
    try { return await operation; } finally { if (this.pendingKeys.get(agent) === operation) this.pendingKeys.delete(agent); }
  }
  private async createKey(agent: string, create: boolean, check: () => void): Promise<Buffer> {
    const name = this.name(agent); let value = await this.vault.get(name); check();
    if (value == null) {
      if (!create) throw failure(); const generated = randomBytes(32);
      try { this.createdKeys.set(agent, generated.toString('base64')); await this.vault.set(name, generated.toString('base64'), check); value = await this.vault.get(name); check(); if (value !== generated.toString('base64')) throw failure(); } finally { generated.fill(0); }
    }
    if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw failure();
    const key = Buffer.from(value, 'base64'); if (key.length !== 32 || key.toString('base64') !== value) { key.fill(0); throw failure(); }
    if (this.closed) { key.fill(0); throw failure(); } this.keys.set(agent, key); return key;
  }
  private aad(agent: string) { return Buffer.from('Relay/browser-session/v1/' + agent); }
  private serialize<T>(agent: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.operations.get(agent) ?? Promise.resolve()).catch(() => {}).then(operation); this.operations.set(agent, result);
    void result.finally(() => { if (this.operations.get(agent) === result) this.operations.delete(agent); }).catch(() => {}); return result;
  }
  private decrypt(bytes: Buffer, agent: string, key: Buffer): Cookie[] {
    const envelope = JSON.parse(bytes.toString('utf8'));
    if (!envelope || envelope.version !== 1 || envelope.agent !== agent || envelope.protection !== 'aes-256-gcm' || Object.keys(envelope).sort().join(',') !== 'agent,ciphertext,iv,protection,tag,version') throw failure();
    const decode = (value: unknown, length?: number) => { if (typeof value !== 'string' || !value.length || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw failure(); const decoded = Buffer.from(value, 'base64'); if (decoded.toString('base64') !== value || (length !== undefined && decoded.length !== length)) throw failure(); return decoded; };
    const cipher = decode(envelope.ciphertext); if (cipher.length > MAX_PLAIN) throw failure();
    const decipher = createDecipheriv('aes-256-gcm', key, decode(envelope.iv, 12)); decipher.setAAD(this.aad(agent)); decipher.setAuthTag(decode(envelope.tag, 16));
    const plain = Buffer.concat([decipher.update(cipher), decipher.final()]); try { return this.cookies(plain); } finally { plain.fill(0); }
  }
  load(agent: string, check: () => void): Promise<Cookie[]> { return this.serialize(agent, () => this.loadInternal(agent, check)); }
  private async loadInternal(agent: string, check: () => void): Promise<Cookie[]> {
    try {
      check(); const profile = await this.profile(agent); check();
      const target = join(profile, 'session-cookies.encrypted.json'), legacyPath = join(profile, 'session-cookies.json');
      const encrypted = await this.read(target, MAX_ENVELOPE), legacy = await this.read(legacyPath, MAX_PLAIN); check();
      if (!await this.available()) { if (encrypted || legacy) throw failure(); check(); return []; }
      if (!encrypted && !legacy) { if (this.keys.has(agent) || await this.vault.get(this.name(agent)) != null) throw failure(); check(); return []; }
      let cookies: Cookie[];
      if (encrypted) { cookies = this.decrypt(encrypted.bytes, agent, await this.key(agent, false, check)); if (legacy && JSON.stringify(this.cookies(legacy.bytes)) !== JSON.stringify(cookies)) throw failure(); }
      else { cookies = this.cookies(legacy!.bytes); await this.saveInternal(agent, cookies, check); }
      check();
      if (legacy) { this.cookies(legacy.bytes); if (!same(legacy.stat, (await this.safe(legacyPath, true))!)) throw failure(); check(); unlinkSync(legacyPath); legacy.bytes.fill(0); }
      return cookies;
    } catch (error) { check(); throw failure(); }
  }
  save(agent: string, cookies: Cookie[], check: () => void): Promise<void> { return this.serialize(agent, () => this.saveInternal(agent, cookies, check)); }
  private async saveInternal(agent: string, cookies: Cookie[], check: () => void): Promise<void> {
    let temporary: string | undefined, plain: Buffer | undefined, target: string | undefined, originalExists = true;
    try {
      check(); plain = Buffer.from(JSON.stringify(cookies)); this.cookies(plain);
      const profile = await this.profile(agent); target = join(profile, 'session-cookies.encrypted.json'); originalExists = !!await this.safe(target, true, true);
      if (!await this.available()) { if (originalExists || await this.safe(join(profile, 'session-cookies.json'), true, true)) throw failure(); check(); return; }
      const key = await this.key(agent, true, check); check();
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(this.aad(agent));
      const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
      const envelope = Buffer.from(JSON.stringify({ version: 1, agent, protection: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: encrypted.toString('base64') }));
      if (envelope.length > MAX_ENVELOPE) throw failure();
      await this.safe(profile); const existing = await this.read(target, MAX_ENVELOPE); if (existing) this.decrypt(existing.bytes, agent, key); check(); temporary = join(profile, '.' + randomUUID() + '.tmp');
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { await this.safe(temporary, true); await handle.writeFile(envelope); await handle.sync(); } finally { await handle.close(); }
      await this.safe(profile); await this.safe(temporary, true); await this.safe(target, true, true);
      // Authority cannot be revoked by an in-process callback between this final
      // check and commit. All potentially long preparation stays asynchronous.
      check(); renameSync(temporary, target); temporary = undefined;
      const verified = await this.read(target, MAX_ENVELOPE); if (!verified || !verified.bytes.equals(envelope)) throw failure(); this.decrypt(verified.bytes, agent, key); this.createdKeys.delete(agent); check();
    } catch (error) { check(); throw failure(); } finally {
      plain?.fill(0); if (temporary) await unlink(temporary).catch(() => {});
      // A cancelled first save must not leave a key that makes an otherwise fresh
      // profile look like a deleted committed session. Never roll back a key once
      // any encrypted payload exists, or if another writer has changed the key.
      const created = this.createdKeys.get(agent);
      if (created && !originalExists && target) {
        try { if (!await this.safe(target, true, true) && await this.vault.get(this.name(agent)) === created) { await this.vault.remove(this.name(agent)); this.keys.get(agent)?.fill(0); this.keys.delete(agent); this.createdKeys.delete(agent); } } catch { /* Preserve the failure and key when safe rollback cannot be proven. */ }
      }
    }
  }
}
