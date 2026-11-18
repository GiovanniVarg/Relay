import { createServer, request as requestHttp, type IncomingMessage, type ServerResponse } from 'node:http';
import { lookup } from 'node:dns/promises';
import { connect, isIP, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

/** Per-profile network fence: every redirect hop passes here before any destination socket opens. */
export class BrowserProxy {
  private sockets = new Set<Socket | Duplex>();
  private stopping = false;
  private server = createServer((request, response) => { void this.forward(request, response); });
  constructor(private validate: (url: string) => void) {
    this.server.on('connection', socket => { this.sockets.add(socket); socket.on('close', () => this.sockets.delete(socket)); });
    this.server.on('connect', (request, socket, head) => { void this.tunnel(request, socket, head); });
    this.server.on('upgrade', (request, socket, head) => { void this.upgrade(request, socket, head); });
  }
  async start(): Promise<string> { await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', () => { this.server.removeListener('error', reject); resolve(); }); }); return 'http://127.0.0.1:' + (this.server.address() as { port: number }).port; }
  private async destination(value: string) {
    if (this.stopping) throw Error('Browser proxy stopped'); this.validate(value); const url = new URL(value); const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
    if (!addresses.length) throw Error('Browser destination unavailable');
    for (const address of addresses) { const resolved = new URL(url.href); resolved.hostname = address.family === 6 ? '[' + address.address + ']' : address.address; this.validate(resolved.href); }
    if (this.stopping) throw Error('Browser proxy stopped'); this.validate(value);
    return { url, address: addresses[0].address, port: Number(url.port || (url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80)) };
  }
  private async forward(request: IncomingMessage, response: ServerResponse) {
    try {
      const target = await this.destination(request.url ?? ''); if (this.stopping || request.aborted || response.destroyed) throw Error('Browser proxy stopped before dispatch'); this.validate(target.url.href); if (target.url.protocol !== 'http:') throw Error('Only HTTP proxy requests use this path');
      const headers: Record<string, string | string[] | undefined> = { ...request.headers, host: target.url.host }; delete headers['proxy-authorization']; delete headers['proxy-connection'];
      const upstream = requestHttp({ hostname: target.address, port: target.port, method: request.method, agent: false, path: target.url.pathname + target.url.search, headers }, remote => { response.writeHead(remote.statusCode ?? 502, remote.headers); remote.pipe(response); });
      upstream.on('socket', socket => { if (this.stopping) { socket.destroy(); return; } this.sockets.add(socket); socket.on('close', () => this.sockets.delete(socket)); });
      upstream.setTimeout(20000, () => upstream.destroy()); upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); }); request.on('aborted', () => upstream.destroy()); response.on('close', () => upstream.destroy()); request.pipe(upstream);
    } catch { response.writeHead(403, { 'Content-Type': 'text/plain', 'Connection': 'close' }); response.end('Browser destination blocked by Relay network permissions'); }
  }
  private async upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    try {
      const target = await this.destination(request.url ?? ''); if (this.stopping || socket.destroyed) throw Error('Browser proxy stopped before upgrade'); this.validate(target.url.href); if (!['http:', 'ws:'].includes(target.url.protocol)) throw Error('Unsupported upgrade');
      const headers: Record<string, string | string[] | undefined> = { ...request.headers, host: target.url.host }; delete headers['proxy-authorization']; delete headers['proxy-connection'];
      const upstream = requestHttp({ hostname: target.address, port: target.port, method: 'GET', agent: false, path: target.url.pathname + target.url.search, headers });
      upstream.on('socket', remote => { if (this.stopping) { remote.destroy(); return; } this.sockets.add(remote); remote.on('close', () => this.sockets.delete(remote)); }); socket.on('close', () => upstream.destroy());
      upstream.setTimeout(15000, () => upstream.destroy());
      upstream.once('upgrade', (response, remote, remoteHead) => { if (this.stopping || socket.destroyed) { remote.destroy(); return; } this.sockets.add(remote); remote.on('close', () => this.sockets.delete(remote)); let greeting = 'HTTP/1.1 ' + response.statusCode + ' ' + response.statusMessage + '\r\n'; for (let i = 0; i < response.rawHeaders.length; i += 2) greeting += response.rawHeaders[i] + ': ' + response.rawHeaders[i + 1] + '\r\n'; socket.write(greeting + '\r\n'); if (head.length) remote.write(head); if (remoteHead.length) socket.write(remoteHead); socket.pipe(remote); remote.pipe(socket); socket.on('close', () => remote.destroy()); remote.on('error', () => socket.destroy()); });
      upstream.once('response', response => { response.resume(); socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); }); upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy()); upstream.end();
    } catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
  }
  private async tunnel(request: IncomingMessage, socket: Duplex, head: Buffer) {
    try {
      const target = await this.destination('https://' + request.url + '/');
      if (this.stopping || socket.destroyed) throw Error('Browser proxy stopped before CONNECT dispatch'); this.validate(target.url.href);
      const upstream = connect(target.port, target.address); this.sockets.add(upstream); upstream.on('close', () => this.sockets.delete(upstream));
      upstream.setTimeout(20000, () => upstream.destroy()); upstream.once('connect', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); upstream.pipe(socket); socket.pipe(upstream); });
      upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy()); socket.on('close', () => upstream.destroy());
    } catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
  }
  async close(): Promise<void> { if (this.stopping) return; this.stopping = true; for (const socket of this.sockets) socket.destroy(); await new Promise<void>(resolve => { if (!this.server.listening) return resolve(); this.server.close(() => resolve()); }); }
}
