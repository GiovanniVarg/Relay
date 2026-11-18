import { normalizeProfileId } from './controller-storage';
let scope: string | undefined;
let legacy = false;
let initialized = false;
/** Set once, before mounting the app. Switch hosts by reloading the document. */
export function setControllerScope(profileId: string | undefined, options: { claimLegacy?: boolean } = {}): void {
  const next = profileId === undefined ? undefined : normalizeProfileId(profileId);
  if (initialized && next !== scope) throw new Error('Reload Relay to change controller profile.');
  if (initialized && Boolean(options.claimLegacy) !== legacy) throw new Error('Controller storage migration grant cannot change.');
  initialized = true; scope = next; legacy = Boolean(next && options.claimLegacy);
}
export function controllerStorageKey(key: string): string { return scope ? 'relay.profile.' + scope + '.' + key : key; }
export type ScopedStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
function scoped(storage: () => Storage, id = scope, claim = legacy): ScopedStorage {
  const keyFor = (key: string) => id ? 'relay.profile.' + id + '.' + key : key;
  // Separate from the value namespace, so no user key can collide with a migration marker.
  const claimFor = (key: string) => 'relay.profile-legacy-claim.' + id + '.' + JSON.stringify(key);
  const consume = (target: Storage, key: string) => { if (id && claim) target.setItem(claimFor(key), '1'); };
  return {
    getItem(key) {
      const target = storage(), value = target.getItem(keyFor(key));
      if (!id || !claim || target.getItem(claimFor(key)) === '1') return value;
      // Each migrated profile may adopt each legacy key once. A cleared value stays cleared.
      const previous = value === null ? target.getItem(key) : value;
      if (value === null && previous !== null) target.setItem(keyFor(key), previous);
      consume(target, key);
      return previous;
    },
    setItem(key, value) { const target = storage(); target.setItem(keyFor(key), value); consume(target, key); },
    removeItem(key) { const target = storage(); consume(target, key); target.removeItem(keyFor(key)); },
  };
}
/** Capture at hook initialization when a callback may finish after unmount. */
export function captureControllerStorage(): { local: ScopedStorage; session: ScopedStorage } {
  return { local: scoped(() => localStorage), session: scoped(() => sessionStorage) };
}
// Methods choose the scope at call time; the scope is immutable after initialization.
export const scopedLocalStorage: ScopedStorage = {
  getItem: key => scoped(() => localStorage).getItem(key),
  setItem: (key, value) => scoped(() => localStorage).setItem(key, value),
  removeItem: key => scoped(() => localStorage).removeItem(key),
};
export const scopedSessionStorage: ScopedStorage = {
  getItem: key => scoped(() => sessionStorage).getItem(key),
  setItem: (key, value) => scoped(() => sessionStorage).setItem(key, value),
  removeItem: key => scoped(() => sessionStorage).removeItem(key),
};
