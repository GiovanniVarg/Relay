import { createSocket, type Socket, type RemoteInfo } from 'node:dgram';

export interface TransportNic { address: string; netmask: string }
const ip = (value: string): number => value.split('.').reduce((result, part) => (result * 256 + Number(part)) >>> 0, 0);
const ipv4 = (value: string): boolean => /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value) && value.split('.').every(part => Number(part) <= 255);
export function transportPeerAllowed(peer: string, nic: TransportNic, allowLoopback = false): boolean {
  if (!ipv4(peer) || !ipv4(nic.address) || !ipv4(nic.netmask)) return false;
  const mask = ip(nic.netmask), inverse = (~mask) >>> 0;
  if (!mask || (inverse & (inverse + 1)) !== 0) return false;
  const permitted = (value: string) => { const [a,b] = value.split('.').map(Number); return a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || (allowLoopback && a === 127); };
  if (!permitted(peer) || !permitted(nic.address) || (ip(peer) & mask) !== (ip(nic.address) & mask)) return false;
  // Reject the subnet's directed broadcast and network address for conventional subnets.
  const host = ip(peer) & inverse; return inverse <= 1 || (host !== 0 && host !== inverse);
}
interface Route { socket: Socket; peer: RemoteInfo; touched: number; ready: boolean; pending: Buffer[]; bytes: number }

/** Native QUIC listens on loopback. The LAN-facing UDP gateway checks the actual OS source
 * on every packet, so QUIC migration cannot bypass subnet admission. No dependency patching. */
export class NetworkTransportGateway {
  private readonly front = createSocket('udp4');
  private readonly routes = new Map<string, Route>();
  private stopped = false;
  private closing: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private rate = { since: Date.now(), count: 0, opens: 0 };
  constructor(private readonly nic: TransportNic, private readonly port: number, private readonly nativePort: number,
    private readonly currentNic: () => boolean, private readonly onFailure: () => void, private readonly allowLoopback = false) {}
  async start(): Promise<void> {
    if (!transportPeerAllowed(this.nic.address, this.nic, this.allowLoopback) || !this.currentNic()) throw new Error('QR network interface unavailable');
    this.front.on('message', (bytes, peer) => this.ingress(bytes, peer));
    this.front.on('error', () => this.fail());
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { this.front.off('listening', ready); reject(error); };
      const ready = () => { this.front.off('error', failed); resolve(); };
      this.front.once('error', failed); this.front.once('listening', ready); this.front.bind(this.port, this.nic.address);
    });
    if (this.stopped) throw new Error('QR gateway startup cancelled');
    this.timer = setInterval(() => {
      if (!this.currentNic()) { this.fail(); return; }
      const now = Date.now(); for (const [key, route] of this.routes) if (now - route.touched > 120_000) this.drop(key, route);
    }, 5000); this.timer.unref();
  }
  private admitted(peer: string): boolean { return !this.stopped && this.currentNic() && transportPeerAllowed(peer, this.nic, this.allowLoopback); }
  private ingress(bytes: Buffer, peer: RemoteInfo): void {
    if (!this.admitted(peer.address) || peer.family !== 'IPv4' || bytes.length === 0 || bytes.length > 65_507 || peer.port < 1) return;
    const now = Date.now(); if (now - this.rate.since >= 1000 || now < this.rate.since) this.rate = { since: now, count: 0, opens: 0 };
    if (++this.rate.count > 16_000) return;
    const key = peer.address + ':' + peer.port; let route = this.routes.get(key);
    if (!route) {
      if (this.routes.size >= 128 || ++this.rate.opens > 32) return;
      route = { socket: createSocket('udp4'), peer: { ...peer }, touched: now, ready: false, pending: [], bytes: 0 };
      const owned = route; this.routes.set(key, owned);
      owned.socket.on('error', () => this.drop(key, owned));
      owned.socket.on('message', data => {
        if (!this.admitted(owned.peer.address) || this.routes.get(key) !== owned || data.length > 65_507 || this.front.getSendQueueSize() > 262_144) return;
        owned.touched = Date.now(); this.front.send(data, owned.peer.port, owned.peer.address, error => { if (error) this.drop(key, owned); });
      });
      owned.socket.bind(0, '127.0.0.1', () => {
        if (this.stopped || this.routes.get(key) !== owned) { this.drop(key, owned); return; }
        owned.socket.connect(this.nativePort, '127.0.0.1', () => {
          if (this.stopped || this.routes.get(key) !== owned) { this.drop(key, owned); return; }
          owned.ready = true; const pending = owned.pending; owned.pending = []; owned.bytes = 0;
          for (const packet of pending) this.forward(key, owned, packet);
        });
      });
    }
    route.touched = now;
    if (route.ready) this.forward(key, route, bytes);
    else if (route.pending.length < 8 && route.bytes + bytes.length <= 65_536) { route.pending.push(Buffer.from(bytes)); route.bytes += bytes.length; }
  }
  private forward(key: string, route: Route, bytes: Buffer): void {
    if (!this.admitted(route.peer.address) || this.routes.get(key) !== route || route.socket.getSendQueueSize() > 262_144) return;
    route.socket.send(bytes, error => { if (error) this.drop(key, route); });
  }
  private drop(key: string, route: Route): void {
    if (this.routes.get(key) !== route) return; this.routes.delete(key); route.pending.length = 0; route.bytes = 0;
    try { route.socket.close(); } catch {}
  }
  private fail(): void { if (this.stopped) return; this.close(); this.onFailure(); }
  close(): Promise<void> {
    if(this.closing)return this.closing;this.stopped=true;if(this.timer)clearInterval(this.timer);
    for(const[key,route]of this.routes)this.drop(key,route);
    this.closing=new Promise<void>(resolve=>{
      const done=()=>{this.front.off('close',done);resolve();};this.front.once('close',done);
      try{this.front.close();}catch{done();}
    });return this.closing;
  }
}
