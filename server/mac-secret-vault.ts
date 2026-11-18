import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { SecretVault } from './secret-vault.js';
import type { SecretVaultLike } from './typesafe.js';

export interface KeychainEntry {
  getPassword(): Promise<string | null>;
  setPassword(value: string): Promise<void>;
  deletePassword(): Promise<boolean>;
}
export type KeychainEntryFactory = (service: string, username: string) => KeychainEntry | Promise<KeychainEntry>;
export interface MacSecretVaultOptions {
  entryFactory?: KeychainEntryFactory;
  /** Test injection only. Normal operation uses the actual OS. */
  platform?: NodeJS.Platform;
}
const unavailable = (): never => { throw new Error('macOS Keychain operation unavailable'); };

export class MacSecretVault implements SecretVaultLike {
  private readonly macService: string;
  private readonly macPlatform: NodeJS.Platform;
  private readonly macFactory: KeychainEntryFactory | undefined;
  private macClosed = false;
  private macQueue: Promise<void> = Promise.resolve();

  constructor(dataDirectory: string, options: MacSecretVaultOptions = {}) {
    this.macService = `Relay-${createHash('sha256').update(resolve(dataDirectory)).digest('hex')}`;
    this.macPlatform = options.platform ?? process.platform;
    this.macFactory = options.entryFactory;
  }

  availability(): { available: boolean; protection: 'macos-keychain' | 'unavailable' } {
    const available = this.macPlatform === 'darwin' && !this.macClosed;
    return { available, protection: available ? 'macos-keychain' : 'unavailable' };
  }

  close(): void { this.macClosed = true; }

  async has(name: string): Promise<boolean> { return (await this.get(name)) !== null; }

  get(name: string): Promise<string | null> {
    return this.macEnqueue(async () => {
      const entry = await this.macEntry(name);
      this.macCheck();
      const value = await entry.getPassword();
      this.macCheck();
      if (value !== null) this.macValue(value);
      return value;
    });
  }

  set(name: string, value: string, check?: () => void): Promise<void> {
    return this.macEnqueue(async () => {
      this.macValue(value);
      check?.();
      const entry = await this.macEntry(name);
      const previous = await entry.getPassword();
      if (previous !== null) this.macValue(previous);
      this.macCheck();
      check?.();
      let attempted = false;
      try {
        attempted = true;
        await entry.setPassword(value);
        this.macCheck();
        check?.();
        if (await entry.getPassword() !== value) return unavailable();
        this.macCheck();
        check?.();
      } catch {
        // Roll back only the exact value this operation attempted to write.
        // Keychain denial never falls through to a file or subprocess fallback.
        if (attempted) {
          try {
            if (await entry.getPassword() === value) {
              if (previous === null) await entry.deletePassword();
              else await entry.setPassword(previous);
            }
          } catch { /* A locked keychain remains unavailable; never report success. */ }
        }
        return unavailable();
      }
    });
  }

  remove(name: string): Promise<void> {
    return this.macEnqueue(async () => {
      const entry = await this.macEntry(name);
      this.macCheck();
      await entry.deletePassword();
      if (await entry.getPassword() !== null) return unavailable();
      this.macCheck();
    });
  }

  private macCheck(): void {
    if (this.macClosed || this.macPlatform !== 'darwin') return unavailable();
  }

  private macValue(value: unknown): asserts value is string {
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 16_384) return unavailable();
  }

  private async macEntry(name: string): Promise<KeychainEntry> {
    this.macCheck();
    if (typeof name !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(name)) return unavailable();
    if (this.macFactory) return this.macFactory(this.macService, name);
    // Do not load a native keyring binding on Windows or unsupported systems.
    const { AsyncEntry } = await import('@napi-rs/keyring');
    this.macCheck();
    return new AsyncEntry(this.macService, name);
  }

  private macEnqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.macQueue.then(async () => {
      try { this.macCheck(); return await operation(); } catch { return unavailable(); }
    });
    this.macQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function createPlatformSecretVault(dataDirectory: string): SecretVaultLike {
  return process.platform === 'darwin' ? new MacSecretVault(dataDirectory) : new SecretVault(dataDirectory);
}
