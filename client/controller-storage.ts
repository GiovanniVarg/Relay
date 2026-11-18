export type TransportCatalogEnvelope = { payload: string; signature: string };
export type ControllerTransportProfile = { kind: 'webtransport-v1'; endpoint: string; pin: string; catalog?: TransportCatalogEnvelope };
export type PublicConnectionProfile = { url: string; ca: string; fingerprint: string; transport?: ControllerTransportProfile };
export type ControllerConnection = {
  id: 'connection'; url: string; deviceId: string; privateKey: CryptoKey;
  publicKey: JsonWebKey; pairedAt: string; publicCA?: string; fingerprint?: string; transport?: ControllerTransportProfile;
};
export type ControllerProfile = Omit<ControllerConnection, 'id'> & {
  id: string; name: string; autoConnect: boolean; lastConnectedAt?: string;
  /** Only the v1 migration grants access to unscoped legacy UI preferences. */
  legacyStorage?: true;
};
export const CONTROLLER_PROTOCOL_VERSION = 3;
export const MAX_CONTROLLER_PROFILES = 16;
const DATABASE = 'relay-controller';
export function normalizeProfileId(value: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error('Invalid controller profile ID.');
  return value.toLowerCase();
}
async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 2);
    request.onupgradeneeded = () => {
      const db = request.result, tx = request.transaction!;
      if (!db.objectStoreNames.contains('connection')) db.createObjectStore('connection', { keyPath: 'id' });
      const profiles = db.createObjectStore('profiles', { keyPath: 'id' });
      const settings = db.createObjectStore('settings', { keyPath: 'id' });
      db.createObjectStore('bindings', { keyPath: 'clientId' });
      // This is a structured clone inside the upgrade transaction. Never serialize or export keys.
      const legacy = tx.objectStore('connection').get('connection');
      legacy.onsuccess = () => {
        if (!legacy.result) return;
        const id = crypto.randomUUID();
        profiles.put({ ...legacy.result, id, name: 'My Relay', autoConnect: true, legacyStorage: true });
        settings.put({ id: 'selection', profileId: id });
        settings.put({ id: 'legacy-migration', profileId: id, version: 1 });
      };
    };
    request.onsuccess = () => { const db = request.result; db.onversionchange = () => db.close(); resolve(db); };
    request.onerror = () => reject(request.error ?? new Error('Controller storage is unavailable.'));
    request.onblocked = () => reject(new Error('Close other Relay tabs and try again.'));
  });
}
async function transaction<T>(stores: string[], mode: IDBTransactionMode, operation: (tx: IDBTransaction, result: (value: T) => void) => void): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode); let result: T;
    tx.oncomplete = () => { db.close(); resolve(result); };
    tx.onerror = tx.onabort = () => { db.close(); reject(tx.error ?? new Error('Controller storage failed.')); };
    try { operation(tx, value => { result = value; }); } catch (error) { tx.abort(); db.close(); reject(error); }
  });
}
function validateProfile(profile: ControllerProfile): ControllerProfile {
  const allowed = new Set(['id','url','deviceId','privateKey','publicKey','pairedAt','publicCA','fingerprint','name','autoConnect','lastConnectedAt','legacyStorage','transport']);
  if (Object.keys(profile).some(key => !allowed.has(key)) || typeof profile.name !== 'string' || !profile.name.trim() || profile.name.length > 80
    || typeof profile.autoConnect !== 'boolean' || typeof profile.deviceId !== 'string' || !profile.deviceId || profile.deviceId.length > 200
    || typeof profile.pairedAt !== 'string' || !profile.pairedAt || profile.pairedAt.length > 100
    || !profile.privateKey || profile.privateKey.type !== 'private' || profile.privateKey.extractable || profile.privateKey.algorithm.name !== 'ECDSA'
    || (profile.privateKey.algorithm as EcKeyAlgorithm).namedCurve !== 'P-256' || !profile.privateKey.usages.includes('sign')
    || !profile.publicKey || profile.publicKey.kty !== 'EC' || profile.publicKey.crv !== 'P-256'
    || typeof profile.publicKey.x !== 'string' || typeof profile.publicKey.y !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(profile.publicKey.x) || !/^[A-Za-z0-9_-]{43}$/.test(profile.publicKey.y)
    || Object.keys(profile.publicKey).some(key => !['kty','crv','x','y','key_ops','ext','alg'].includes(key))
    || (profile.lastConnectedAt !== undefined && (typeof profile.lastConnectedAt !== 'string' || !Number.isFinite(Date.parse(profile.lastConnectedAt))))
    || (profile.legacyStorage !== undefined && profile.legacyStorage !== true)
    || (profile.fingerprint !== undefined && !/^[a-f0-9]{64}$/.test(normalizeFingerprint(profile.fingerprint)))
    || (profile.publicCA !== undefined && (typeof profile.publicCA !== 'string' || profile.publicCA.length > 200000))) throw new Error('Invalid saved controller profile.');
  if (profile.transport !== undefined) validateTransportProfile(profile.transport, privateHttpsOrigin(profile.url));
  return { ...profile, id: normalizeProfileId(profile.id), url: privateHttpsOrigin(profile.url), name: profile.name.trim(), ...(profile.fingerprint ? { fingerprint: normalizeFingerprint(profile.fingerprint) } : {}) };
}
export const listProfiles = () => transaction<ControllerProfile[]>(['profiles'], 'readonly', (tx, result) => { const request = tx.objectStore('profiles').getAll(); request.onsuccess = () => result(request.result); });
export const loadProfile = (id: string) => transaction<ControllerProfile | undefined>(['profiles'], 'readonly', (tx, result) => { const request = tx.objectStore('profiles').get(normalizeProfileId(id)); request.onsuccess = () => result(request.result); });
export type ControllerProfileGeneration = { deviceId: string; pairedAt: string };
export type ControllerProfileMetadataPatch = Partial<Pick<ControllerProfile, 'name' | 'autoConnect' | 'lastConnectedAt'>>;
export type SaveControllerProfileOptions = { replaceGeneration?: ControllerProfileGeneration };
const matchesGeneration = (profile: ControllerProfile | undefined, expected: ControllerProfileGeneration): boolean => Boolean(profile && profile.deviceId === expected.deviceId && profile.pairedAt === expected.pairedAt);
/** Patch only current metadata. Never recreate a deleted profile or replace its credentials. */
export async function updateProfileMetadata(id: string, expected: ControllerProfileGeneration, patch: ControllerProfileMetadataPatch): Promise<ControllerProfile | undefined> {
  id = normalizeProfileId(id);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !['name', 'autoConnect', 'lastConnectedAt'].includes(key))) throw new Error('Only controller profile metadata can be updated.');
  // Snapshot caller-owned input before the transaction starts.
  const changes = { ...patch }, generation = { ...expected };
  return transaction<ControllerProfile | undefined>(['profiles'], 'readwrite', (tx, done) => {
    const store = tx.objectStore('profiles'), request = store.get(id);
    request.onsuccess = () => {
      const previous = request.result as ControllerProfile | undefined;
      if (!matchesGeneration(previous, generation)) { done(undefined); return; }
      try {
        const saved = validateProfile({ ...previous!, ...changes });
        store.put(saved); done(saved);
      } catch { tx.abort(); }
    };
  });
}
/** Persist public information only after the UI has verified this host's fresh nonce proof.
 * Certificate-byte verification here proves the existing pin, not online host identity.
 */
export async function updateProfilePublicInfo(id: string, expected: ControllerProfileGeneration, info: PublicConnectionProfile): Promise<ControllerProfile | undefined> {
  id = normalizeProfileId(id);
  const generation = { ...expected };
  // Verify outside the IDB transaction; awaiting crypto inside a transaction can make it inactive.
  const verified = await verifyPinnedProfile(info);
  if (verified.transport?.catalog) await (await import('./controller-transport')).verifyTransportCatalog(verified, verified.transport.catalog);
  return transaction<ControllerProfile | undefined>(['profiles', 'bindings'], 'readwrite', (tx, done) => {
    const store = tx.objectStore('profiles'), request = store.get(id);
    request.onsuccess = () => {
      const previous = request.result as ControllerProfile | undefined;
      if (!matchesGeneration(previous, generation) || !previous?.fingerprint || normalizeFingerprint(previous.fingerprint) !== verified.fingerprint) { done(undefined); return; }
      // Preserve current credentials and preferences, including concurrent metadata changes.
      let transport = previous.transport;
      try { transport = mergeTransport(previous.transport, verified.transport, verified.url); } catch { tx.abort(); return; }
      const saved = { ...previous, publicCA: verified.ca, url: verified.url, ...(transport ? { transport } : {}) };
      store.put(saved);
      if (previous.url !== saved.url) {
        const cursor = tx.objectStore('bindings').openCursor(); cursor.onsuccess = () => { const row = cursor.result; if (row) { if (row.value.profileId === id) row.delete(); row.continue(); } };
      }
      done(saved);
    };
  });
}
/** Pair a new host, or replace an existing pairing using an explicit generation compare-and-swap. */
export async function saveProfile(profile: ControllerProfile, options: SaveControllerProfileOptions = {}): Promise<void> {
  const value = validateProfile(profile), expected = options.replaceGeneration ? { ...options.replaceGeneration } : undefined;
  if (value.transport?.catalog) {
    if (!value.publicCA || !value.fingerprint) throw new Error('Pinned host identity is required.');
    await (await import('./controller-transport')).verifyTransportCatalog({url:value.url,ca:value.publicCA,fingerprint:value.fingerprint,transport:value.transport}, value.transport.catalog);
  }
  await transaction<void>(['profiles','settings','bindings'], 'readwrite', (tx, done) => {
    const store = tx.objectStore('profiles'), all = store.getAll();
    all.onsuccess = () => {
      const previous = (all.result as ControllerProfile[]).find(item => item.id === value.id);
      // An explicit repair may update only the exact profile generation it started from.
      if (expected && !matchesGeneration(previous, expected)) { tx.abort(); return; }
      const generationChanged = previous && (!matchesGeneration(previous, value) || previous.publicKey.x !== value.publicKey.x || previous.publicKey.y !== value.publicKey.y);
      if (generationChanged && !expected) { tx.abort(); return; }
      if (previous?.fingerprint && normalizeFingerprint(previous.fingerprint) !== value.fingerprint) { tx.abort(); return; }
      if (!previous && all.result.length >= MAX_CONTROLLER_PROFILES) { tx.abort(); return; }
      // The migration grant is immutable and cannot be claimed by a newly saved profile.
      const saved = { ...value }; delete saved.legacyStorage;
      try { const transport = mergeTransport(previous?.transport, value.transport, value.url); if (transport) saved.transport = transport; } catch { tx.abort(); return; }
      if (previous?.legacyStorage) saved.legacyStorage = true;
      // Metadata saves cannot replace a structured-cloned key for the same identity.
      if (previous && !generationChanged) { saved.privateKey = previous.privateKey; saved.publicKey = previous.publicKey; }
      store.put(saved);
      if (previous && (generationChanged || previous.url !== saved.url)) {
        const cursor = tx.objectStore('bindings').openCursor(); cursor.onsuccess = () => { const row = cursor.result; if (row) { if (row.value.profileId === value.id) row.delete(); row.continue(); } };
      }
      done(undefined);
    };
  });
}
export async function removeProfile(id: string): Promise<void> {
  id = normalizeProfileId(id);
  await transaction<void>(['profiles','settings','bindings'], 'readwrite', (tx, done) => {
    tx.objectStore('profiles').delete(id);
    const settings = tx.objectStore('settings'), selection = settings.get('selection');
    selection.onsuccess = () => { if (selection.result?.profileId === id) settings.delete('selection'); };
    const cursor = tx.objectStore('bindings').openCursor(); cursor.onsuccess = () => { const row = cursor.result; if (row) { if (row.value.profileId === id) row.delete(); row.continue(); } };
    done(undefined);
  });
}
export async function selectProfile(id: string | undefined): Promise<void> {
  if (id !== undefined) id = normalizeProfileId(id);
  await transaction<void>(['profiles','settings'], 'readwrite', (tx, done) => {
    if (id === undefined) { tx.objectStore('settings').delete('selection'); done(undefined); return; }
    const request = tx.objectStore('profiles').get(id);
    request.onsuccess = () => { if (!request.result) { tx.abort(); return; } tx.objectStore('settings').put({ id:'selection',profileId:id }); done(undefined); };
  });
}
export async function loadSelectedProfile(): Promise<ControllerProfile | undefined> {
  return transaction<ControllerProfile | undefined>(['profiles','settings'], 'readonly', (tx, done) => {
    const request = tx.objectStore('settings').get('selection'); request.onsuccess = () => {
      if (!request.result?.profileId) { done(undefined); return; }
      const profile = tx.objectStore('profiles').get(request.result.profileId); profile.onsuccess = () => done(profile.result);
    };
  });
}
// Compatibility only. The service worker never uses the selected-profile preference for routing.
export async function loadConnection(): Promise<ControllerConnection | undefined> {
  const profile = await loadSelectedProfile(); if (!profile) return undefined;
  const { name, autoConnect, lastConnectedAt, legacyStorage, ...connection } = profile;
  return { ...connection, id: 'connection' };
}
export async function saveConnection(connection: ControllerConnection): Promise<void> {
  const existing = (await listProfiles()).find(item => item.deviceId === connection.deviceId && item.pairedAt === connection.pairedAt && item.url === connection.url);
  const id = existing?.id ?? crypto.randomUUID();
  await saveProfile({ ...connection, id, name: existing?.name ?? 'My Relay', autoConnect: existing?.autoConnect ?? true });
  await selectProfile(id);
}
export async function clearConnection(): Promise<void> { const profile = await loadSelectedProfile(); if (profile) await removeProfile(profile.id); }
export async function verifyPinnedProfile(profile: PublicConnectionProfile): Promise<PublicConnectionProfile> {
  const normalized = parsePublicProfile(JSON.stringify(profile));
  const certificate = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(normalized.ca)?.[1].replace(/\s/g, '');
  if (!certificate) throw new Error('Public certificate is invalid.');
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(atob(certificate), char => char.charCodeAt(0)));
  const actual = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== normalized.fingerprint) throw new Error('The certificate does not match its pinned fingerprint.');
  return normalized;
}
export async function controllerWorkerRequest(worker: ServiceWorker, message: Record<string, unknown>, timeoutMs = 5000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel(), timer = setTimeout(() => finish(new Error('Controller worker did not acknowledge protocol v3. Reload Relay.')), timeoutMs);
    function finish(error?: Error) { clearTimeout(timer); channel.port1.close(); error ? reject(error) : resolve(); }
    channel.port1.onmessage = event => {
      const ack = event.data;
      if (ack?.version !== CONTROLLER_PROTOCOL_VERSION || ack?.type !== message.type + '_ACK' || ack?.ok !== true) finish(new Error(ack?.error ?? 'Controller worker protocol mismatch. Reload Relay.'));
      else finish();
    };
    worker.postMessage({ ...message, version: CONTROLLER_PROTOCOL_VERSION }, [channel.port2]);
  });
}
export async function handshakeController(worker: ServiceWorker, profile?: ControllerProfile): Promise<void> {
  await controllerWorkerRequest(worker, { type: 'HELLO' });
  await controllerWorkerRequest(worker, profile ? { type:'BIND_PROFILE',profileId:profile.id,deviceId:profile.deviceId,pairedAt:profile.pairedAt } : { type:'UNBIND_PROFILE' });
}
export function privateHttpsOrigin(input: string): string {
  const match = /^https:\/\/((?:\d{1,3}\.){3}\d{1,3})(?::\d{1,5})?\/?$/i.exec(input.trim());
  if (!match) throw new Error('Use the hosting computer’s HTTPS address with a private IPv4 address, such as https://192.168.1.20:3211.');
  const parts = match[1].split('.').map(Number);
  if (parts.some((value, index) => value > 255 || String(value) !== match[1].split('.')[index])
    || !(parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168))) throw new Error('The address must use a private LAN IPv4 address.');
  return new URL(input.trim()).origin;
}
export const normalizeFingerprint = (value: string) => value.replace(/[:\s-]/g, '').toLowerCase();
export function parsePublicProfile(text: string): PublicConnectionProfile {
  if (text.length > 200000) throw new Error('Connection profile is too large.');
  const profile = JSON.parse(text) as Record<string, unknown>;
  if (!profile || typeof profile !== 'object' || Object.keys(profile).some(key => !['url', 'ca', 'fingerprint', 'transport'].includes(key))
    || typeof profile.url !== 'string' || typeof profile.ca !== 'string' || typeof profile.fingerprint !== 'string') throw new Error('Choose a public connection profile containing only url, ca, and fingerprint.');
  const fingerprint = normalizeFingerprint(profile.fingerprint);
  if (!/^[a-f0-9]{64}$/.test(fingerprint) || !/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(profile.ca)) throw new Error('The profile needs its public root certificate and SHA-256 fingerprint.');
  const url = privateHttpsOrigin(profile.url);
  const transport = profile.transport === undefined ? undefined : validateTransportProfile(profile.transport, url);
  return { url, ca: profile.ca, fingerprint, ...(transport ? { transport } : {}) };
}
export function profileFromFragment(fragment: string): PublicConnectionProfile | undefined {
  if (!fragment.startsWith('#connect=')) return undefined;
  const encoded = fragment.slice(9);
  const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(encoded.length / 4) * 4, '='));
  return parsePublicProfile(new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0))));
}
export const base64url = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const signaturePayload = (method: string, path: string, timestamp: string, nonce: string, bodyHash: string) => JSON.stringify(['relay-device-v1', method.toUpperCase(), path, timestamp, nonce, bodyHash]);
export async function requestSignature(privateKey: CryptoKey, method: string, path: string, body: BufferSource, timestamp = String(Date.now()), nonce: string = crypto.randomUUID()) {
  const digest = await crypto.subtle.digest('SHA-256', body);
  const bodyHash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, new TextEncoder().encode(signaturePayload(method, path, timestamp, nonce, bodyHash)));
  if (signature.byteLength !== 64) throw new Error('This browser does not support Relay’s P-256 signature format.');
  return { 'X-Relay-Timestamp': timestamp, 'X-Relay-Nonce': nonce, 'X-Relay-Signature': base64url(signature) };
}
const xml = (value: string) => value.replace(/[<>&"']/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]!);
export function certificateProfile(profile: PublicConnectionProfile): string {
  const certificate = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(profile.ca)?.[1].replace(/\s/g, '');
  if (!certificate || !/^[A-Za-z0-9+/]+=*$/.test(certificate)) throw new Error('Public certificate is invalid.');
  const rootId = crypto.randomUUID(), profileId = crypto.randomUUID();
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>PayloadType</key><string>Configuration</string><key>PayloadVersion</key><integer>1</integer><key>PayloadIdentifier</key><string>local.relay.controller.${profileId}</string><key>PayloadUUID</key><string>${profileId}</string><key>PayloadDisplayName</key><string>Relay Local Certificate</string><key>PayloadDescription</key><string>${xml(`Public root certificate for ${profile.url}. Compare SHA-256 fingerprint: ${profile.fingerprint}`)}</string><key>PayloadContent</key><array><dict>
<key>PayloadType</key><string>com.apple.security.root</string><key>PayloadVersion</key><integer>1</integer><key>PayloadIdentifier</key><string>local.relay.root.${rootId}</string><key>PayloadUUID</key><string>${rootId}</string><key>PayloadDisplayName</key><string>Relay Local CA</string><key>PayloadCertificateFileName</key><string>RelayLocalCA.cer</string><key>PayloadContent</key><data>${certificate}</data>
</dict></array></dict></plist>`;
}
export async function downloadCertificateProfile(profile: PublicConnectionProfile) {
  const certificate = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(profile.ca)?.[1].replace(/\s/g, '');
  if (!certificate) throw new Error('Public certificate is invalid.');
  const der = Uint8Array.from(atob(certificate), char => char.charCodeAt(0));
  const digest = await crypto.subtle.digest('SHA-256', der);
  const actual = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== normalizeFingerprint(profile.fingerprint)) throw new Error('The certificate bytes do not match the public fingerprint. Obtain a fresh profile from your hosting computer.');
  const url = URL.createObjectURL(new Blob([certificateProfile(profile)], { type: 'application/x-apple-aspen-config' }));
  const link = document.createElement('a'); link.href = url; link.download = 'RelayLocalCA.mobileconfig'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** Structural validation only. Catalog signatures are checked before any catalog pin is used. */
export function validateTransportProfile(value: unknown, origin: string): ControllerTransportProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid pinned connection.');
  const profile = value as Record<string, unknown>;
  if (Object.keys(profile).some(key => !['kind','endpoint','pin','catalog'].includes(key)) || profile.kind !== 'webtransport-v1'
    || profile.endpoint !== privateHttpsOrigin(origin) + '/relay' || typeof profile.pin !== 'string' || !/^[a-f0-9]{64}$/.test(profile.pin)) throw new Error('Invalid pinned connection.');
  let catalog: TransportCatalogEnvelope | undefined;
  if (profile.catalog !== undefined) {
    const envelope = profile.catalog as Record<string, unknown>;
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || Object.keys(envelope).some(key => !['payload','signature'].includes(key))
      || typeof envelope.payload !== 'string' || new TextEncoder().encode(envelope.payload).byteLength > 32768
      || typeof envelope.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(envelope.signature)) throw new Error('Invalid saved connection trust.');
    catalog = { payload: envelope.payload, signature: envelope.signature };
  }
  return { kind:'webtransport-v1',endpoint:profile.endpoint as string,pin:profile.pin,...(catalog ? { catalog } : {}) };
}
function mergeTransport(previous: ControllerTransportProfile | undefined, incoming: ControllerTransportProfile | undefined, origin: string): ControllerTransportProfile | undefined {
  if (!incoming) return previous;
  const next = validateTransportProfile(incoming, origin);
  if (previous?.catalog) {
    if (!next.catalog) return { ...next, catalog: previous.catalog };
    const oldSequence = JSON.parse(previous.catalog.payload).sequence, newSequence = JSON.parse(next.catalog.payload).sequence;
    if (!Number.isSafeInteger(oldSequence) || !Number.isSafeInteger(newSequence) || newSequence < oldSequence
      || (newSequence === oldSequence && next.catalog.payload !== previous.catalog.payload)) throw new Error('Saved connection trust cannot move backwards.');
  }
  return next;
}
export interface ControllerWindowBinding { clientId: string; profileId: string; deviceId: string; pairedAt: string; token: string }
export async function controllerBindingCurrent(binding: ControllerWindowBinding): Promise<boolean> {
  return transaction<boolean>(['bindings','profiles'], 'readonly', (tx, done) => {
    const request = tx.objectStore('bindings').get(binding.clientId);
    request.onsuccess = () => {
      const saved = request.result as ControllerWindowBinding | undefined;
      if (!saved || !['clientId','profileId','deviceId','pairedAt','token'].every(key => saved[key as keyof ControllerWindowBinding] === binding[key as keyof ControllerWindowBinding])) { done(false); return; }
      const profile = tx.objectStore('profiles').get(binding.profileId);
      profile.onsuccess = () => done(matchesGeneration(profile.result, binding));
    };
  });
}
