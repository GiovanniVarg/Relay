import type { SecretVaultLike } from '../server/typesafe.js';
/** Synthetic in-memory key vault. Never reads the user's DPAPI directory. */
export function fakeBrowserVault(): SecretVaultLike & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return { values, availability: () => ({ available: true }), has: async name => values.has(name), get: async name => values.get(name) ?? null, set: async (name, value, check) => { check?.(); values.set(name, value); }, remove: async name => { values.delete(name); }, close() {} };
}
