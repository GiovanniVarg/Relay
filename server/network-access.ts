import { randomBytes, X509Certificate } from 'node:crypto';
import { createServer, type Server as HttpsServer } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import type { Duplex } from 'node:stream';
import { Security, HttpError, jsonBody, only, cacheVerifiedRequestBody } from './security.js';
import { NetworkDevices, type DeviceRecord, type RequestProof } from './network-auth.js';
import { NetworkCertificates } from './network-certificates.js';
import { LocalNetworkTrust, type LocalTrustOptions } from './network-local-trust.js';
import { NetworkTransportCertificates } from './network-transport-certificates.js';
import { NetworkTransport } from './network-transport.js';
import type { Store } from './store.js';
import type { SecretVaultLike } from './typesafe.js';

interface Nic { name: string; address: string; netmask: string }
interface Config { id: string; enabled: boolean; address: string; port: number; controllerOrigins: string[] }
interface Hooks {
  handle(req: IncomingMessage, res: ServerResponse, security: Security): Promise<void>;
  assertWritable(): void;
  workerRequest(device: DeviceRecord, req: IncomingMessage, res: ServerResponse, url: URL, rawBody: Buffer): Promise<void>;
  onRevoke(deviceId: string, session?: object): Promise<void>;
}
interface Options { allowLoopbackTest?: boolean; interfaces?: () => Nic[]; clock?: () => number; localTrust?: LocalTrustOptions; transport?: boolean }
const ID = 'network-access';
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];
const HEADERS = ['accept', 'content-type', 'x-csrf-token', 'last-event-id', 'x-relay-device',
  'x-relay-timestamp', 'x-relay-nonce', 'x-relay-signature'];
const AUTH_HEADERS = new Set(['x-relay-device', 'x-relay-timestamp', 'x-relay-nonce', 'x-relay-signature']);
const fail = (status = 403): never => { throw new HttpError(status, 'Network request denied'); };
const ipNumber = (address: string): number => address.split('.').reduce((n, value) => (n * 256 + Number(value)) >>> 0, 0);
function ipv4(address: string): boolean {
  return /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(address)
    && address.split('.').every(part => Number(part) <= 255);
}
function privateIp(address: string, test: boolean): boolean {
  if (!ipv4(address)) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || (test && a === 127);
}
function maskValid(mask: string): boolean {
  if (!ipv4(mask)) return false;
  const n = ipNumber(mask), inverse = (~n) >>> 0;
  return n !== 0 && (inverse & (inverse + 1)) === 0;
}
function send(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
function one(req: IncomingMessage, name: string): string | undefined {
  if (req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === name).length > 1) return fail(400);
  const value = req.headers[name];
  if (value !== undefined && typeof value !== 'string') return fail(400);
  return value;
}
async function raw(req: IncomingMessage, limit: number): Promise<Buffer> {
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') return fail(415);
  if (req.method === 'GET' || req.method === 'HEAD') {
    if ((req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0') || req.headers['transfer-encoding']) return fail(400);
    return Buffer.alloc(0);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) return fail(413);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

class LanSecurity extends Security {
  constructor(private readonly access: NetworkAccess, port: number) { super(port); }
  override validate(req: IncomingMessage): void { this.access.boundary(req); }
  override session(req: IncomingMessage): { csrf: string; touched: number } { return this.access.controllerSession(req); }
  override bootstrap(req: IncomingMessage, _res: ServerResponse): { csrf: string; touched: number } { return this.session(req); }
}

export class NetworkAccess {
  readonly devices: NetworkDevices;
  readonly certificates: NetworkCertificates;
  private readonly lanSecurity: Security;
  private readonly localTrust: LocalNetworkTrust;
  private readonly transportCertificates: NetworkTransportCertificates;
  private transport: NetworkTransport | undefined;
  private transportError: string | null = null;
  private readonly verified = new WeakMap<IncomingMessage, DeviceRecord>();
  private readonly sessions = new Map<string, { token: string; session: { csrf: string; touched: number } }>();
  private readonly responses = new Map<string, Set<ServerResponse>>();
  private readonly sockets = new Set<Duplex>();
  private readonly attempts = new Map<string, { start: number; count: number }>();
  private globalAttempts = { start: 0, count: 0 };
  private config: Config = { id: ID, enabled: false, address: '', port: 3443, controllerOrigins: [] };
  private nic: Nic | undefined;
  private server: HttpsServer | undefined;
  private transition: Promise<void> = Promise.resolve();
  private closed = false;
  private error: string | null = null;
  constructor(private readonly store: Store, private readonly baseSecurity: Security,
    vault: SecretVaultLike, private readonly hooks: Hooks, private readonly options: Options = {}) {
    this.devices = new NetworkDevices(store, { clock: options.clock });
    this.certificates = new NetworkCertificates(store, vault, { clock: options.clock, allowLoopback: options.allowLoopbackTest });
    this.lanSecurity = new LanSecurity(this, baseSecurity.port);
    this.localTrust = new LocalNetworkTrust(this.certificates, options.localTrust);
    this.transportCertificates = new NetworkTransportCertificates(vault, this.certificates, options.clock, options.allowLoopbackTest);
  }

  private now(): number { return this.options.clock?.() ?? Date.now(); }
  private interfaces(): Nic[] {
    const all = this.options.interfaces?.() ?? Object.entries(networkInterfaces()).flatMap(([name, entries]) =>
      (entries ?? []).filter(entry => entry.family === 'IPv4').map(entry => ({ name, address: entry.address, netmask: entry.netmask })));
    return all.filter(nic => privateIp(nic.address, !!this.options.allowLoopbackTest) && maskValid(nic.netmask));
  }
  private origin(): string { return `https://${this.config.address}:${this.config.port}`; }
  status() {
    let ca: { certificate: string; fingerprint: string } | null = null;
    try { ca = this.certificates.publicCA(); } catch { /* Status remains available during certificate failure. */ }
    return { enabled: this.config.enabled, listening: !!this.server?.listening,
      url: this.config.address ? this.origin() : null, address: this.config.address, port: this.config.port,
      controllerOrigins: [...this.config.controllerOrigins], error: this.error, interfaces: this.interfaces(),
      publicCA: ca?.certificate ?? null, fingerprint: ca?.fingerprint ?? null,
      transport: this.transport?.profile ?? null, transportError: this.transportError,
      devices: this.devices.list().map(({ publicKey: _publicKey, ...metadata }) => metadata) };
  }
  async restore(): Promise<void> {
    try {
      const saved = this.store.get<Config>('config', ID);
      if (!saved) return;
      if (saved.id !== ID || typeof saved.enabled !== 'boolean') return fail(503);
      this.config = { ...this.settings(saved), enabled: saved.enabled, id: ID };
      if (saved.enabled) await this.enable(this.config);
    } catch { this.error = 'Network access unavailable'; }
  }
  enable(input: { address: string; port?: number; controllerOrigins?: string[] }): Promise<ReturnType<NetworkAccess['status']>> {
    return this.enqueue(async () => {
      this.hooks.assertWritable();
      const config = this.settings(input);
      if (this.closed) return fail(503);
      const nic = this.interfaces().find(entry => entry.address === config.address);
      if (!nic) return fail(400);
      const material = await this.certificates.material(config.address);
      await this.stop();
      this.config = { ...config, id: ID, enabled: true };
      this.nic = nic;
      const server = createServer({ key: material.key, cert: material.cert, minVersion: 'TLSv1.3',
        handshakeTimeout: 10_000, maxHeaderSize: 16_384 },
        (req, res) => { void this.request(req, res); });
      server.maxConnections = 128;
      server.requestTimeout = 30_000;
      server.headersTimeout = 15_000;
      server.on('connection', socket => { this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket)); });
      this.server = server;
      try {
        await new Promise<void>((resolve, reject) => {
          const failed = (error: Error) => { server.off('listening', ready); reject(error); };
          const ready = () => { server.off('error', failed); resolve(); };
          server.once('error', failed); server.once('listening', ready);
          server.listen(config.port, config.address);
        });
        const bound = server.address();
        if (!bound || typeof bound === 'string') return fail(503);
        this.config.port = bound.port;
        server.on('error', () => {
          // Listener errors share the same transition queue as enable/disable. A retired
          // listener must not resume an asynchronous stop against its replacement.
          void this.enqueue(async () => {
            if (this.server !== server) return;
            this.error = 'Network access unavailable'; await this.stop();
          }).catch(() => {});
        });
        this.store.put('config', this.config);
        this.error = null;
        this.startTransport(material.ca);
      } catch { await this.stop(); this.error = 'Network access unavailable'; return fail(503); }
      return this.status();
    });
  }
  disable(): Promise<void> {
    return this.enqueue(async () => {
      this.hooks.assertWritable();
      this.config.enabled = false;
      if (this.config.address) this.store.put('config', this.config);
      else this.store.remove('config', ID);
      await this.stop();
    });
  }
  close(): Promise<void> { return this.enqueue(async () => { this.closed = true; this.certificates.clearHostProof(); await this.stop(); }); }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.transition.then(operation);
    this.transition = result.then(() => undefined, () => undefined);
    return result;
  }
  private startTransport(ca: string): void {
    if (this.options.transport === false || (this.options.allowLoopbackTest && this.options.transport !== true)) return;
    const nic = this.nic; if (!nic) return;
    const candidate = new NetworkTransport({ origin: this.origin(), nic, ca, allowedOrigins: [...this.config.controllerOrigins],
      certificates: this.transportCertificates, allowLoopbackTest: this.options.allowLoopbackTest,
      currentNic: () => !this.closed && this.config.enabled && this.nic === nic && this.interfaces().some(item => item.address === nic.address && item.netmask === nic.netmask),
      onFailure: () => { if (this.transport === candidate) this.transportError = 'Secure QR connection unavailable. Check the local network connection and try enabling connections again.'; },
    });
    this.transport = candidate; this.transportError = 'Secure QR connection is starting';
    const timer = setTimeout(() => { if (this.transport === candidate && !candidate.profile) { candidate.close(); this.transportCertificates.clear(); this.transportError = 'Secure QR connection took too long to start. Try enabling connections again.'; } }, 120_000); timer.unref();
    void candidate.start().then(() => { clearTimeout(timer); if (this.transport === candidate && candidate.profile) this.transportError = null; }, () => { clearTimeout(timer); candidate.close(); if (this.transport === candidate) this.transportError = 'Secure QR connection unavailable. Check the local network connection and try enabling connections again.'; });
  }
  private async stop(): Promise<void> {
    const transport = this.transport; this.transport = undefined; this.transportCertificates.clear(); this.transportError = null;
    await transport?.close();
    const server = this.server;
    this.server = undefined;
    const stopped = server ? new Promise<void>(resolve => server.close(() => resolve())) : Promise.resolve();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    for (const entry of this.sessions.values()) this.baseSecurity.sessions.delete(entry.token);
    this.sessions.clear();
    this.responses.clear();
    this.attempts.clear();
    await stopped;
  }
  private settings(input: unknown): Omit<Config, 'enabled' | 'id'> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return fail(400);
    const data = input as Record<string, unknown>;
    only(data, ['id', 'enabled', 'address', 'port', 'controllerOrigins']);
    const port = data.port ?? 3443;
    if (typeof data.address !== 'string' || !privateIp(data.address, !!this.options.allowLoopbackTest)
      || typeof port !== 'number' || !Number.isInteger(port) || port > 65535
      || (port !== 0 && port < 1024) || (port === 0 && !this.options.allowLoopbackTest)) return fail(400);
    const origins = data.controllerOrigins ?? [];
    if (!Array.isArray(origins) || origins.length > 10 || origins.some(value => {
      if (typeof value !== 'string' || value.length > 2048) return true;
      try { const parsed = new URL(value); return parsed.protocol !== 'https:' || parsed.origin !== value || !!parsed.username || !!parsed.password || parsed.hostname.includes('*'); }
      catch { return true; }
    })) return fail(400);
    return { address: data.address, port, controllerOrigins: [...new Set(origins as string[])] };
  }

  boundary(req: IncomingMessage): void {
    if (!this.server?.listening || !this.nic || one(req, 'host') !== `${this.config.address}:${this.config.port}`) return fail();
    const remote = req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? '';
    if (!ipv4(remote) || ((ipNumber(remote) & ipNumber(this.nic.netmask)) !== (ipNumber(this.nic.address) & ipNumber(this.nic.netmask)))) return fail();
    for (const name of Object.keys(req.headers)) {
      if (name === 'forwarded' || name.startsWith('x-forwarded-') || (name.startsWith('x-relay-') && !AUTH_HEADERS.has(name))) return fail();
    }
    const origin = one(req, 'origin');
    if (origin !== undefined && origin !== this.origin() && !this.config.controllerOrigins.includes(origin)) return fail();
    const site = one(req, 'sec-fetch-site');
    if (site && !['same-origin', 'same-site', 'none', 'cross-site'].includes(site)) return fail();
    if (site === 'cross-site' && !origin) return fail();
    delete req.headers.cookie;
    if (req.headers.authorization) return fail();
  }
  controllerSession(req: IncomingMessage): { csrf: string; touched: number } {
    const authenticated = this.verified.get(req);
    const live = authenticated && this.devices.get(authenticated.id);
    if (!live || live.revokedAt !== null || live.role !== 'controller') return fail(401);
    let entry = this.sessions.get(live.id);
    if (!entry) {
      entry = { token: randomBytes(32).toString('hex'), session: { csrf: randomBytes(32).toString('hex'), touched: this.now() } };
      this.sessions.set(live.id, entry);
    }
    entry.session.touched = this.now();
    this.baseSecurity.sessions.set(entry.token, entry.session);
    return entry.session;
  }
  private proof(req: IncomingMessage, body: Buffer): RequestProof {
    const timestamp = one(req, 'x-relay-timestamp');
    if (!timestamp || !/^(0|[1-9]\d{0,15})$/.test(timestamp)) return fail(401);
    return { method: req.method ?? '', path: req.url ?? '', timestamp: Number(timestamp),
      nonce: one(req, 'x-relay-nonce') ?? '', signature: one(req, 'x-relay-signature') ?? '', body };
  }
  private pairLimit(peer: string): void {
    const now = this.now();
    if (now - this.globalAttempts.start >= 60_000 || now < this.globalAttempts.start) this.globalAttempts = { start: now, count: 0 };
    if (++this.globalAttempts.count > 60) return fail(429);
    for (const [key, value] of this.attempts) if (now - value.start >= 60_000 || now < value.start) this.attempts.delete(key);
    let bucket = this.attempts.get(peer);
    if (!bucket) {
      if (this.attempts.size >= 256) return fail(429);
      bucket = { start: now, count: 0 }; this.attempts.set(peer, bucket);
    }
    if (++bucket.count > 10) return fail(429);
  }
  private async request(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      this.boundary(req);
      const origin = one(req, 'origin');
      if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); res.setHeader('Access-Control-Expose-Headers','Content-Disposition, Content-Security-Policy, X-Content-Type-Options, ETag, Content-Range, Accept-Ranges'); }
      if (req.method === 'OPTIONS') {
        if (!origin || !METHODS.includes(one(req, 'access-control-request-method') ?? '')) return fail();
        const requested = (one(req, 'access-control-request-headers') ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
        if (requested.some(value => !HEADERS.includes(value))) return fail();
        res.writeHead(204, { 'Access-Control-Allow-Methods': METHODS.join(', '), 'Access-Control-Allow-Headers': requested.join(', '),
          'Access-Control-Allow-Private-Network': 'true', 'Access-Control-Max-Age': '600' }); res.end(); return;
      }
      if (!req.url?.startsWith('/') || req.url.startsWith('//') || req.url.split('?')[0]!.includes('\\') || /%(?:2f|5c|00)/i.test(req.url.split('?')[0]!)) return fail(400);
      const url = new URL(req.url, this.origin());
      if (url.pathname === '/api/network/info' && req.method === 'GET') {
        await raw(req, 0); const ca = this.certificates.publicCA();
        const challenges = url.searchParams.getAll('challenge');
        if (challenges.length > 1 || [...url.searchParams.keys()].some(key => key !== 'challenge')
          || (challenges.length === 1 && !/^[A-Za-z0-9_-]{32,96}$/.test(challenges[0]!))) return fail(400);
        const info = { protocol: 1, url: this.origin(), publicCA: ca?.certificate ?? null, fingerprint: ca?.fingerprint ?? null };
        const transportCatalog = this.transport?.catalog;
        const details = transportCatalog ? { ...info, transportCatalog } : info;
        send(res, 200, challenges.length ? { ...details, hostProof: await this.certificates.hostProof(this.origin(), challenges[0]!) } : details); return;
      }
      if (url.pathname === '/api/network/pair' && req.method === 'POST') {
        this.pairLimit(req.socket.remoteAddress ?? '');
        if (!/^application\/json(?:\s*;|$)/i.test(one(req, 'content-type') ?? '')) return fail(415);
        const body = await raw(req, 16_384);
        cacheVerifiedRequestBody(req, body);
        const input = await jsonBody(req, 16_384);
        only(input, ['code', 'name', 'platform', 'publicKey']);
        const device = this.devices.pair(input as unknown as Parameters<NetworkDevices['pair']>[0], this.proof(req, body));
        send(res, 201, device); return;
      }
      if (url.pathname === '/bootstrap' || url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        const role = url.pathname.startsWith('/api/network/worker/') ? 'worker' : 'controller';
        const id = one(req, 'x-relay-device');
        if (!id || id.length > 100) return fail(401);
        const candidate = this.devices.get(id);
        if (!candidate || candidate.revokedAt !== null || candidate.role !== role) return fail(401);
        const body = await raw(req, 8 * 1024 * 1024);
        const device = this.devices.verify({ deviceId: id, ...this.proof(req, body) }, role);
        this.verified.set(req, device); cacheVerifiedRequestBody(req, body);
        const active = this.responses.get(id) ?? new Set<ServerResponse>();
        this.responses.set(id, active); active.add(res);
        res.once('close', () => { active.delete(res); if (!active.size && this.responses.get(id) === active) this.responses.delete(id); });
        if (role === 'worker') { await this.hooks.workerRequest(device, req, res, url, body); return; }
      } else if (req.method !== 'GET' && req.method !== 'HEAD') return fail(401);
      await this.hooks.handle(req, res, this.lanSecurity);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const code = error instanceof HttpError ? error.status : 500;
      send(res, Number.isInteger(code) && code >= 400 && code <= 599 ? code : 500, { error: 'Network request denied' });
    }
  }

  async manage(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname;
    if (!path.startsWith('/api/network')) return false;
    if (path.startsWith('/api/network/worker/')) return fail();
    if (path === '/api/network/local-trust') {
      const remote = req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? '';
      if (this.verified.has(req) || !(remote === '::1' || (ipv4(remote) && remote.split('.')[0] === '127'))) return fail();
      // Retain the normal local Host/Origin/session/CSRF checks even if called directly.
      this.baseSecurity.validate(req);
      this.baseSecurity.session(req);
      if (req.method === 'GET') { send(res, 200, await this.localTrust.status()); return true; }
      if (req.method !== 'POST') return fail(405);
      this.baseSecurity.mutation(req);
      this.hooks.assertWritable();
      const input = await jsonBody(req, 1024); only(input, ['fingerprint', 'confirm']);
      const ca = this.certificates.publicCA();
      if (input.confirm !== true || typeof input.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.fingerprint)
        || !ca || input.fingerprint !== ca.fingerprint) return fail(400);
      send(res, 200, await this.localTrust.install(input.fingerprint, true)); return true;
    }
    if (path === '/api/network' && req.method === 'GET') { send(res, 200, this.status()); return true; }
    if (path === '/api/network/certificate' && req.method === 'GET') {
      const ca = this.certificates.publicCA(); if (!ca) return fail(404);
      res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="relay-local-ca.cer"', 'Cache-Control': 'no-store' });
      res.end(new X509Certificate(ca.certificate).raw); return true;
    }
    if (path === '/api/network/enable' && req.method === 'POST') {
      const input = await jsonBody(req); only(input, ['address', 'port', 'controllerOrigins']);
      if (this.verified.has(req)) {
        this.settings(input); this.hooks.assertWritable();
        res.once('finish', () => { void this.enable(input as unknown as Parameters<NetworkAccess['enable']>[0]).catch(() => { this.error = 'Network access unavailable'; }); });
        send(res, 202, { pending: true });
      } else send(res, 200, await this.enable(input as unknown as Parameters<NetworkAccess['enable']>[0]));
      return true;
    }
    if (path === '/api/network/disable' && req.method === 'POST') {
      only(await jsonBody(req), []); this.hooks.assertWritable();
      if (this.verified.has(req)) {
        res.once('finish', () => { void this.disable().catch(() => { this.error = 'Network access unavailable'; }); });
        send(res, 202, { pending: true });
      } else { await this.disable(); send(res, 200, this.status()); }
      return true;
    }
    if (path === '/api/network/invites' && req.method === 'POST') {
      const body = await jsonBody(req); only(body, ['role']); this.hooks.assertWritable();
      if (body.role !== 'controller' && body.role !== 'worker') return fail(400);
      send(res, 201, this.devices.createInvite(body.role)); return true;
    }
    const match = /^\/api\/network\/devices\/([a-f0-9-]{36})$/.exec(path);
    if (match && req.method === 'DELETE') {
      if (req.headers['transfer-encoding'] || (req.headers['content-length'] && req.headers['content-length'] !== '0')) only(await jsonBody(req), []);
      this.hooks.assertWritable(); this.devices.revoke(match[1]!);
      const entry = this.sessions.get(match[1]!);
      if (entry) this.baseSecurity.sessions.delete(entry.token);
      this.sessions.delete(match[1]!);
      const active = this.responses.get(match[1]!);
      for (const response of active ?? []) if (response !== res) response.destroy();
      this.responses.delete(match[1]!);
      await this.hooks.onRevoke(match[1]!, entry?.session);
      send(res, 200, { revoked: true }); return true;
    }
    return false;
  }
}
