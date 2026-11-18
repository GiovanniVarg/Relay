import 'reflect-metadata';
import { BasicConstraintsExtension, X509Certificate } from '@peculiar/x509';
import { CONTROLLER_PROTOCOL_VERSION, base64url, controllerBindingCurrent, parsePublicProfile,
  type ControllerProfile, type ControllerWindowBinding, type PublicConnectionProfile, type TransportCatalogEnvelope } from './controller-storage';

const MAX_METADATA = 16_384, MAX_BODY = 8 * 1024 * 1024, CHUNK = 65_536, MAX_STREAMS = 32;
const REQUEST_HEADERS = new Set(['accept','content-type','x-csrf-token','last-event-id',
  'x-relay-device','x-relay-timestamp','x-relay-nonce','x-relay-signature']);
const RESPONSE_HEADERS = new Set(['cache-control','x-content-type-options','content-security-policy','referrer-policy',
  'content-type','content-disposition','content-range','accept-ranges','etag','last-modified','retry-after']);
const encoder = new TextEncoder();
export interface TransportCatalog {
  version: 1; hostFingerprint: string; sequence: number; issuedAt: number; expiresAt: number; endpoint: string;
  leaves: Array<{ sha256: string; notBefore: number; notAfter: number }>;
}
type FetchOptions = { method?: string; headers?: HeadersInit; body?: BodyInit | null; signal?: AbortSignal;
  /** Internal owning-window guard. Rechecked at the final boundary before any request byte is sent. */
  beforeSend?: () => Promise<boolean> | boolean;
};
export class ControllerTransportUnsupportedError extends Error {
  constructor() { super('This browser cannot make QR-encrypted connections. Update your browser or operating system, then reopen Relay.'); this.name = 'ControllerTransportUnsupportedError'; }
}
interface TransportStream { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }
interface NativeTransport {
  ready: Promise<void>; closed: Promise<unknown>; close(): void;
  createBidirectionalStream(): Promise<TransportStream>;
}
interface CachedTransport { transport: NativeTransport; streams: number; lastUsed: number; closed: boolean }
const connections = new Map<string, CachedTransport>();
const cacheKey = (profile: PublicConnectionProfile) => `${profile.fingerprint}|${profile.transport!.endpoint}|${profile.transport!.pin}`;
const aborted = () => new DOMException('Connection request cancelled.', 'AbortError');
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function exact(value: Record<string, unknown>, keys: string[]): boolean { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
const hex = (value: ArrayBuffer) => [...new Uint8Array(value)].map(x => x.toString(16).padStart(2, '0')).join('');
function unbase(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]{86}$/.test(value)) throw new Error('Invalid host signature.');
  const bytes = Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/') + '=='), x => x.charCodeAt(0));
  if (bytes.length !== 64 || base64url(bytes.buffer) !== value) throw new Error('Invalid host signature.');
  return bytes;
}
async function identityKey(profile: PublicConnectionProfile): Promise<CryptoKey> {
  const root = new X509Certificate(profile.ca);
  if (!root.getExtension(BasicConstraintsExtension)?.ca || root.subject !== root.issuer || root.notBefore.getTime() > Date.now()
    || root.notAfter.getTime() <= Date.now() || hex(await crypto.subtle.digest('SHA-256', root.rawData)) !== profile.fingerprint
    || !await root.isSelfSigned(crypto)) throw new Error('The saved host identity is invalid.');
  return root.publicKey.export({ name:'ECDSA',namedCurve:'P-256' }, ['verify'], crypto);
}
/** Verify signed bytes before using future hashes; the catalog cannot change its own identity. */
export async function verifyTransportCatalog(profile: PublicConnectionProfile, envelope: TransportCatalogEnvelope,
  previous?: TransportCatalogEnvelope, now = Date.now()): Promise<TransportCatalog> {
  if (!profile.transport || !object(envelope) || !exact(envelope, ['payload','signature']) || typeof envelope.payload !== 'string'
    || encoder.encode(envelope.payload).length > 32_768 || typeof envelope.signature !== 'string') throw new Error('Invalid connection trust catalog.');
  const signature = unbase(envelope.signature);
  const key = await identityKey(profile);
  if (!await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'}, key, signature,
    encoder.encode(JSON.stringify(['relay-transport-catalog-v1', envelope.payload])))) throw new Error('Host trust catalog signature was rejected.');
  const data: unknown = JSON.parse(envelope.payload);
  if (!object(data) || !exact(data,['version','hostFingerprint','sequence','issuedAt','expiresAt','endpoint','leaves'])
    || data.version !== 1 || data.hostFingerprint !== profile.fingerprint || data.endpoint !== profile.transport.endpoint
    || !Number.isSafeInteger(data.sequence) || (data.sequence as number) < 1 || !Number.isSafeInteger(data.issuedAt)
    || !Number.isSafeInteger(data.expiresAt) || (data.issuedAt as number) > now + 300_000
    || (data.expiresAt as number) <= now || (data.expiresAt as number) <= (data.issuedAt as number)
    || (data.expiresAt as number) - (data.issuedAt as number) > 750 * 86_400_000
    || !Array.isArray(data.leaves) || !data.leaves.length || data.leaves.length > 80) throw new Error('Invalid or expired host trust catalog.');
  const pins = new Set<string>();
  for (const leaf of data.leaves) {
    if (!object(leaf) || !exact(leaf,['sha256','notBefore','notAfter']) || typeof leaf.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(leaf.sha256)
      || pins.has(leaf.sha256) || !Number.isSafeInteger(leaf.notBefore) || !Number.isSafeInteger(leaf.notAfter)
      || (leaf.notAfter as number) <= (leaf.notBefore as number) || (leaf.notAfter as number) - (leaf.notBefore as number) > 14 * 86_400_000
      || (leaf.notBefore as number) < (data.issuedAt as number) - 14 * 86_400_000 || (leaf.notAfter as number) > (data.expiresAt as number)) throw new Error('Invalid host certificate schedule.');
    pins.add(leaf.sha256);
  }
  if (previous) {
    const old = await verifyTransportCatalog(profile, previous, undefined, Math.min(now, JSON.parse(previous.payload).expiresAt - 1));
    if ((data.sequence as number) < old.sequence || (data.sequence === old.sequence && envelope.payload !== previous.payload)) throw new Error('Host trust catalog rollback was rejected.');
  }
  return data as unknown as TransportCatalog;
}
function requestPath(path: string): void {
  if (typeof path !== 'string' || path.length > 8192 || /[\u0000-\u0020\u007f#\\]/.test(path) || !path.startsWith('/') || path.startsWith('//')
    || /%(?:2f|5c|00)/i.test(path.split('?')[0]!) || (path !== '/bootstrap' && path !== '/api' && !path.startsWith('/api/'))
    || path.split('?')[0] === '/api/network/local-trust' || path.split('?')[0]!.startsWith('/api/network/worker/')) throw new Error('Unsupported controller request path.');
  // URL must not normalize dot segments into another signed action.
  if (new URL(path, 'https://relay.invalid').pathname !== path.split('?')[0]) throw new Error('Noncanonical controller request path.');
}
function requestHeaders(input?: HeadersInit): Record<string,string> {
  const headers = new Headers(input), out: Record<string,string> = {};
  for (const [name,value] of headers) {
    if (!REQUEST_HEADERS.has(name) || value.length > 8192 || /[\r\n\u0000]/.test(value)) throw new Error('Unsupported controller request header.');
    out[name] = value;
  }
  return out;
}
async function boundedBody(input: BodyInit | null | undefined, limit: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  if (input == null) return new Uint8Array(0);
  const reader = new Response(input).body!.getReader(), parts: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw aborted();
      const next = await reader.read(); if (next.done) break;
      size += next.value.length; if (size > limit) throw new Error('The controller request is too large.'); parts.push(next.value);
    }
    const body = new Uint8Array(size); let offset = 0;
    for (const part of parts) { body.set(part, offset); offset += part.length; }
    return body;
  } catch (error) { await reader.cancel().catch(()=>{}); throw error; }
}
async function within<T>(promise: Promise<T>, signal: AbortSignal, ms = 30_000): Promise<T> {
  if (signal.aborted) throw aborted();
  let timer: ReturnType<typeof setTimeout> | undefined, abort: () => void = () => {};
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      abort = () => reject(aborted()); signal.addEventListener('abort', abort, {once:true});
      timer = setTimeout(() => reject(new Error('The encrypted connection did not respond in time.')), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); signal.removeEventListener('abort', abort); }
}
async function open(profile: PublicConnectionProfile): Promise<CachedTransport> {
  const key = cacheKey(profile), existing = connections.get(key);
  if (existing && !existing.closed && !profile.transport!.catalog) { existing.lastUsed = Date.now(); return existing; }
  let pins = [profile.transport!.pin];
  if (profile.transport!.catalog) {
    const catalog = await verifyTransportCatalog(profile, profile.transport!.catalog);
    const now = Date.now(); pins = catalog.leaves.filter(leaf => leaf.notBefore <= now && now < leaf.notAfter).map(leaf => leaf.sha256);
    if (!pins.length) throw new Error('Saved connection trust has expired. Scan a fresh Relay QR code.');
  }
  const raced = connections.get(key);
  if (raced && !raced.closed) { raced.lastUsed = Date.now(); return raced; }
  if (connections.size >= 8) {
    for (const [oldKey, old] of connections) if (old.streams === 0) { old.transport.close(); old.closed = true; connections.delete(oldKey); break; }
    if (connections.size >= 8) throw new Error('Too many open Relay hosts. Close another controller window first.');
  }
  const Constructor = (globalThis as unknown as {WebTransport?: new (url: string, options: unknown) => NativeTransport}).WebTransport;
  if (!Constructor) throw new ControllerTransportUnsupportedError();
  // On first QR connect there is no await above this constructor: retain user activation for LNA.
  const transport = new Constructor(profile.transport!.endpoint, {allowPooling:false,serverCertificateHashes:pins.map(pin => ({algorithm:'sha-256',value:Uint8Array.from(pin.match(/../g)!, pair => parseInt(pair,16))}))});
  const entry: CachedTransport = {transport,streams:0,lastUsed:Date.now(),closed:false};
  connections.set(key, entry);
  void transport.closed.catch(()=>{}).finally(() => { entry.closed = true; if (connections.get(key) === entry) connections.delete(key); });
  if (connections.size > 8) for (const [oldKey, old] of connections) {
    if (oldKey !== key && old.streams === 0) { old.transport.close(); old.closed = true; connections.delete(oldKey); if (connections.size <= 8) break; }
  }
  return entry;
}
export function closeControllerTransport(profile?: PublicConnectionProfile): void {
  for (const [key, entry] of connections) if (!profile || key === cacheKey(profile)) {
    entry.closed = true; entry.transport.close(); connections.delete(key);
  }
}

/** Direct pinned transport; legacy HTTPS is chosen only when the profile explicitly has no WT. */
export async function controllerFetch(input: PublicConnectionProfile, path: string, options: FetchOptions = {}): Promise<Response> {
  const profile = parsePublicProfile(JSON.stringify(input)); requestPath(path);
  const method = options.method ?? 'GET';
  if (!['GET','POST','PUT','PATCH','DELETE','HEAD'].includes(method)) throw new Error('Unsupported controller method.');
  const headers = requestHeaders(options.headers);
  if (!profile.transport) {
    if (options.beforeSend && !await options.beforeSend()) throw new Error('Controller binding changed before dispatch.');
    if (options.signal?.aborted) throw aborted();
    const {beforeSend:_guard,...legacyOptions} = options;
    return fetch(profile.url + path, {...legacyOptions,method,headers,credentials:'omit',redirect:'error',mode:'cors',cache:'no-store'});
  }
  if (options.signal?.aborted) throw aborted();
  const opened = open(profile); // Starts the first native handshake synchronously.
  const control = new AbortController(), abort = () => control.abort();
  options.signal?.addEventListener('abort', abort, {once:true});
  let entry: CachedTransport | undefined, stream: TransportStream | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  let cleaned = false, counted = false;
  function cleanup() { if (cleaned) return; cleaned = true; options.signal?.removeEventListener('abort', abort); if (entry && counted) entry.streams--; }
  const cancelled = () => { void reader?.cancel().catch(()=>{}); void writer?.abort().catch(()=>{}); };
  control.signal.addEventListener('abort', cancelled, {once:true});
  try {
    entry = await within(opened, control.signal);
    if (entry.streams >= MAX_STREAMS) throw new Error('Too many active controller requests.');
    entry.streams++; counted = true; await within(entry.transport.ready, control.signal);
    stream = await within(entry.transport.createBidirectionalStream(), control.signal); reader = stream.readable.getReader(); writer = stream.writable.getWriter();
    const body = await within(boundedBody(options.body, path.split('?')[0] === '/api/network/pair' ? 16_384 : MAX_BODY, control.signal), control.signal);
    if ((method === 'GET' || method === 'HEAD') && body.length) throw new Error('This request cannot include a body.');
    const metadata = encoder.encode(JSON.stringify({version:1,method,path,headers,bodyLength:body.length}));
    if (metadata.length > MAX_METADATA) throw new Error('Controller request headers are too large.');
    const prefix = new Uint8Array(4); new DataView(prefix.buffer).setUint32(0,metadata.length);
    // No request bytes leave the owner until its current binding has survived all asynchronous setup.
    if (options.beforeSend && !await options.beforeSend()) throw new Error('Controller binding changed before dispatch.');
    if (control.signal.aborted) throw aborted();
    await within(writer.write(prefix), control.signal); await within(writer.write(metadata), control.signal);
    for (let at = 0; at < body.length; at += CHUNK) await within(writer.write(body.subarray(at, at + CHUNK)), control.signal);
    await within(writer.close(), control.signal);
    let pending: Uint8Array = new Uint8Array(0);
    const take = async (count: number): Promise<Uint8Array<ArrayBuffer>> => {
      const out = new Uint8Array(count); let copied = 0;
      while (copied < count) {
        if (!pending.length) { const next = await within(reader!.read(), control.signal); if (control.signal.aborted) throw aborted(); if (next.done) throw new Error('The response ended before its headers.'); if (next.value.length > 1024 * 1024) throw new Error('Invalid encrypted response frame.'); pending = next.value; }
        const size = Math.min(count - copied, pending.length); out.set(pending.subarray(0,size),copied); copied += size; pending = pending.subarray(size);
      }
      return out;
    };
    const frame = await take(4), size = new DataView(frame.buffer).getUint32(0);
    if (!size || size > MAX_METADATA) throw new Error('Invalid encrypted response headers.');
    const data: unknown = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await take(size)));
    if (!object(data) || !exact(data,['version','status','headers']) || data.version !== 1 || !Number.isInteger(data.status)
      || (data.status as number) < 200 || (data.status as number) > 599 || !object(data.headers)) throw new Error('Invalid encrypted response status.');
    const responseHeaders = new Headers({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    for (const [name,value] of Object.entries(data.headers)) {
      if (!RESPONSE_HEADERS.has(name) || typeof value !== 'string' || value.length > 8192 || /[\r\n\u0000]/.test(value)) throw new Error('Invalid encrypted response header.');
      responseHeaders.set(name,value);
    }
    if (method === 'HEAD' || [204,205,304].includes(data.status as number)) { await reader.cancel(); cleanup(); return new Response(null,{status:data.status as number,headers:responseHeaders}); }
    const responseBody = new ReadableStream<Uint8Array>({
      async pull(output) {
        try {
          if (control.signal.aborted) throw aborted();
          if (pending.length) { const piece = pending.slice(0,CHUNK); pending = pending.subarray(piece.length); output.enqueue(piece); return; }
          const next = await reader!.read(); if (control.signal.aborted) throw aborted();
          if (next.done) { cleanup(); output.close(); }
          else if (next.value.length > 1024 * 1024) throw new Error('Encrypted response chunk exceeds limit.');
          else { pending = next.value; const piece = pending.slice(0,CHUNK); pending = pending.subarray(piece.length); output.enqueue(piece); }
        } catch (error) { control.abort(); cleanup(); output.error(error); }
      },
      async cancel() { control.abort(); cleanup(); await reader?.cancel().catch(()=>{}); },
    },{highWaterMark:0});
    return new Response(responseBody,{status:data.status as number,headers:responseHeaders});
  } catch (error) { control.abort(); cleanup(); throw error; }
}

/** Attach before SW binding. Only this owning document may carry its signed requests. */
export function bindControllerTransport(profile: ControllerProfile): () => void {
  if (!profile.transport) return () => {};
  if (!profile.publicCA || !profile.fingerprint) throw new Error('The saved host identity is missing. Scan a fresh QR code.');
  const publicProfile: PublicConnectionProfile = {url:profile.url,ca:profile.publicCA,fingerprint:profile.fingerprint,transport:profile.transport};
  const live = new Set<AbortController>(); let disposed = false;
  const listener = (event: MessageEvent) => {
    if (event.source !== navigator.serviceWorker.controller || event.data?.type !== 'WT_REQUEST') return;
    const port = event.ports[0]; if (!port) return;
    const message = event.data, binding = message.binding as ControllerWindowBinding;
    const control = new AbortController(); live.add(control); let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let finished = false, pulling = false, timer: ReturnType<typeof setTimeout>;
    const timeout = () => { clearTimeout(timer); timer = setTimeout(() => finish(true),120_000); };
    const finish = (notify = false) => {
      if (finished) return; finished = true; clearTimeout(timer); control.abort(); live.delete(control);
      void reader?.cancel().catch(()=>{}); if (notify) port.postMessage({type:'ERROR',error:'Encrypted controller request ended. Its effects may be unknown; it was not retried.'}); port.close();
    };
    control.signal.addEventListener('abort', () => finish(true),{once:true});
    port.onmessage = async (reply: MessageEvent) => {
      if (reply.data?.type === 'ABORT') { finish(); return; }
      if (reply.data?.type !== 'PULL' || !reader || pulling || finished) { finish(true); return; }
      pulling = true; timeout();
      try {
        if (disposed || !await controllerBindingCurrent(binding)) throw new Error('Connection binding changed.');
        const next = await reader.read();
        if (disposed || !await controllerBindingCurrent(binding)) throw new Error('Connection binding changed.');
        if (next.done) { port.postMessage({type:'END'}); finish(); }
        else { const bytes = next.value.slice(); if (bytes.length > CHUNK) throw new Error('Invalid bridge chunk.'); port.postMessage({type:'CHUNK',body:bytes.buffer},[bytes.buffer]); }
      } catch { finish(true); } finally { pulling = false; }
    };
    port.start(); timeout();
    void (async () => {
      try {
        if (disposed || live.size > MAX_STREAMS || message.version !== CONTROLLER_PROTOCOL_VERSION || !object(binding)
          || binding.profileId !== profile.id || binding.deviceId !== profile.deviceId || binding.pairedAt !== profile.pairedAt
          || typeof binding.clientId !== 'string' || typeof binding.token !== 'string' || !await controllerBindingCurrent(binding)
          || !object(message.request) || !(message.request.body instanceof ArrayBuffer) || message.request.body.byteLength > MAX_BODY) throw new Error('Invalid controller owner.');
        const request = message.request;
        if (typeof request.path !== 'string' || typeof request.method !== 'string' || !object(request.headers)) throw new Error('Invalid request frame.');
        const response = await controllerFetch(publicProfile,request.path,{method:request.method,headers:request.headers as Record<string,string>,
          ...(request.body.byteLength ? {body:request.body} : {}),signal:control.signal,
          beforeSend:async () => !disposed && !control.signal.aborted && await controllerBindingCurrent(binding)});
        if (disposed || !await controllerBindingCurrent(binding)) throw new Error('Connection binding changed.');
        reader = response.body?.getReader();
        port.postMessage({type:'HEADERS',status:response.status,headers:Object.fromEntries(response.headers)}); timeout();
        if (!reader) { port.postMessage({type:'END'}); finish(); }
      } catch { finish(true); }
    })();
  };
  navigator.serviceWorker.addEventListener('message',listener);
  return () => { disposed = true; navigator.serviceWorker.removeEventListener('message',listener); for (const control of live) control.abort(); closeControllerTransport(publicProfile); };
}
