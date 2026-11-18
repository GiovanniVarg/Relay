import { randomBytes } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import type { IncomingMessage, ClientRequest } from 'node:http';
import { NetworkTransportCertificates, type TransportMaterial, type TransportCatalog, type TransportProfile } from './network-transport-certificates.js';
import { NetworkTransportGateway, type TransportNic } from './network-transport-gateway.js';
import { ensureNetworkNativeTransport } from './network-native.js';

type NativeServer = import('@fails-components/webtransport').Http3Server;
interface TransportStream { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }
interface TransportSession { ready: Promise<unknown>; closed: Promise<unknown>; header?: unknown; incomingBidirectionalStreams: ReadableStream<TransportStream>;
  incomingUnidirectionalStreams: ReadableStream<ReadableStream<Uint8Array>>; datagrams?: { readable: ReadableStream<Uint8Array> }; close(): void }
export interface NetworkTransportOptions {
  origin: string; nic: TransportNic; allowedOrigins: string[]; ca: string; certificates: NetworkTransportCertificates;
  currentNic(): boolean; onFailure(): void; allowLoopbackTest?: boolean;
}
const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
const requestHeaders = new Set(['accept','content-type','x-csrf-token','last-event-id','x-relay-device','x-relay-timestamp','x-relay-nonce','x-relay-signature']);
const responseHeaders = new Set(['content-type','content-security-policy','referrer-policy','content-disposition','content-range','accept-ranges','etag','last-modified','retry-after']);
const HEADER_LIMIT = 16_384, BODY_LIMIT = 8 * 1024 * 1024;
const fail = (): never => { throw new Error('Secure QR request denied'); };
export interface TransportRequest { version: 1; method: string; path: string; headers: Record<string,string>; bodyLength: number }
export function validateTransportRequest(value: unknown): TransportRequest {
  const data = value as TransportRequest;
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['version','method','path','headers','bodyLength'].includes(key))
    || data.version !== 1 || typeof data.method !== 'string' || !methods.has(data.method) || typeof data.path !== 'string' || data.path.length > 8192
    || !data.path.startsWith('/') || data.path.startsWith('//') || /[\\#\u0000-\u0020\u007f-\u009f]/.test(data.path)
    || !Number.isSafeInteger(data.bodyLength) || data.bodyLength < 0 || data.bodyLength > BODY_LIMIT
    || (['GET','HEAD'].includes(data.method) && data.bodyLength !== 0)) return fail();
  const pathname = data.path.split('?')[0]!;
  if (/%(?:2f|5c|00)/i.test(pathname) || pathname.split('/').some(part => { try { return ['.','..'].includes(decodeURIComponent(part)); } catch { return true; } })
    || !(pathname === '/bootstrap' || pathname === '/api' || pathname.startsWith('/api/'))
    || pathname === '/api/network/local-trust' || pathname === '/api/network/worker' || pathname.startsWith('/api/network/worker/')) return fail();
  if (pathname === '/api/network/pair' && (data.method !== 'POST' || data.bodyLength > 16_384)) return fail();
  if (!data.headers || typeof data.headers !== 'object' || Array.isArray(data.headers) || Object.keys(data.headers).length > requestHeaders.size) return fail();
  for (const [key, value] of Object.entries(data.headers)) if (!requestHeaders.has(key) || typeof value !== 'string' || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) return fail();
  return data;
}
export function transportFrame(value: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(value)); if (!json.length || json.length > HEADER_LIMIT) return fail();
  const frame = Buffer.allocUnsafe(json.length + 4); frame.writeUInt32BE(json.length); json.copy(frame, 4); return frame;
}
export class TransportReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private static readonly MAX_CHUNK = 262_144;
  private remainder: Buffer = Buffer.alloc(0);
  constructor(readable: ReadableStream<Uint8Array>) { this.reader = readable.getReader(); }
  async exactly(length: number): Promise<Buffer> {
    if (!Number.isSafeInteger(length) || length < 0 || length > HEADER_LIMIT) return fail();
    const out = Buffer.alloc(length); let offset = 0;
    while (offset < length) {
      if (!this.remainder.length) {
        const chunk = await this.reader.read(); if (chunk.done || !(chunk.value instanceof Uint8Array) || chunk.value.length > TransportReader.MAX_CHUNK) return fail();
        this.remainder = Buffer.from(chunk.value.buffer, chunk.value.byteOffset, chunk.value.byteLength);
      }
      const take = Math.min(length - offset, this.remainder.length); this.remainder.copy(out, offset, 0, take); this.remainder = this.remainder.subarray(take); offset += take;
    }
    return out;
  }
  private async body(length: number, reserve?: (received: number) => void): Promise<Buffer> {
    const parts: Buffer[] = []; let received = 0;
    while (received < length) {
      if (!this.remainder.length) {
        const chunk = await this.reader.read();
        if (chunk.done || !(chunk.value instanceof Uint8Array) || chunk.value.length > TransportReader.MAX_CHUNK) return fail();
        this.remainder = Buffer.from(chunk.value.buffer, chunk.value.byteOffset, chunk.value.byteLength);
      }
      const take = Math.min(length - received, this.remainder.length);
      // Reserve only bytes which arrived. Header-only hostile requests allocate no declared body.
      reserve?.(take); parts.push(Buffer.from(this.remainder.subarray(0, take)));
      this.remainder = this.remainder.subarray(take); received += take;
    }
    return Buffer.concat(parts, received);
  }
  async request(reserveBodyBytes?: (received: number) => void): Promise<{ meta: TransportRequest; body: Buffer }> {
    const length = (await this.exactly(4)).readUInt32BE(); if (!length || length > HEADER_LIMIT) return fail();
    const meta = validateTransportRequest(JSON.parse((await this.exactly(length)).toString('utf8')));
    const body = await this.body(meta.bodyLength, reserveBodyBytes);
    if (this.remainder.length) return fail(); const tail = await this.reader.read(); if (!tail.done) return fail();
    return { meta, body };
  }
  cancel(): void { void this.reader.cancel().catch(() => {}); }
}

/** HTTP/3 is only a transport: every request still passes the existing LAN HTTPS signed
 * authority. The bridge target, CA, Origin and Host are never supplied by a client frame. */
export class NetworkTransport {
  private server: NativeServer | undefined;
  private gateway: NetworkTransportGateway | undefined;
  private active: TransportMaterial | undefined;
  private readonly sessions = new Set<TransportSession>();
  private readonly aborts = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private refreshing = false;
  private count = 0;
  private bufferedBodies = 0;
  private epoch = 0;
  private retiring: Promise<void> = Promise.resolve();
  constructor(private readonly options: NetworkTransportOptions) {}
  get profile(): TransportProfile | null { return this.closed ? null : this.active?.profile ?? null; }
  get catalog(): TransportCatalog | undefined { return this.closed ? undefined : this.active?.catalog; }
  async start(): Promise<void> {
    const epoch = this.epoch, material = await this.options.certificates.material(this.options.origin + '/relay');
    if(this.closed || epoch!==this.epoch)return fail();await this.listen(material,epoch);
  }
  private sameRuntime(epoch: number, server: NativeServer): boolean {
    return !this.closed && epoch===this.epoch && this.server===server;
  }
  private alive(epoch: number, server: NativeServer): boolean {
    return this.sameRuntime(epoch,server) && this.options.currentNic();
  }
  private async listen(material: TransportMaterial, epoch: number): Promise<void> {
    if(this.closed || epoch!==this.epoch || !this.options.currentNic())return fail();
    await ensureNetworkNativeTransport();if(this.closed || epoch!==this.epoch)return fail();
    const {Http3Server} = await import('@fails-components/webtransport');
    if(this.closed || epoch!==this.epoch)return fail();
    const server = new Http3Server({host:'127.0.0.1',port:0,secret:randomBytes(32).toString('hex'),cert:material.cert,privKey:material.key,
      maxConnections:64,defaultDatagramsReadableMode:'bytes',initialStreamFlowControlWindow:65_536,streamShouldAutoTuneReceiveWindow:false,
      streamFlowControlWindowSizeLimit:65_536,initialSessionFlowControlWindow:262_144,sessionShouldAutoTuneReceiveWindow:false,sessionFlowControlWindowSizeLimit:262_144});
    this.server = server;
    void server.closed.then(()=>{if(this.sameRuntime(epoch,server))this.failed();},()=>{if(this.sameRuntime(epoch,server))this.failed();});
    server.ready.catch(()=>{});
    // Native startup is asynchronous. A retired listener can become ready late, but it only
    // binds loopback and is closed without being allowed to affect its replacement runtime.
    void server.ready.then(()=>{if(!this.alive(epoch,server)){try{server.stopServer();}catch{}}},()=>{});
    const authority = new URL(this.options.origin).host;
    server.setRequestCallback(async(args:{header:Record<string,unknown>})=>{
      const header=args.header,allowed=this.alive(epoch,server)&&this.sessions.size<64&&header[':authority']===authority
        &&header[':path']==='/relay'&&header[':method']==='CONNECT'&&header[':protocol']==='webtransport'
        &&typeof header.origin==='string'&&[this.options.origin,...this.options.allowedOrigins].includes(header.origin);
      return{path:'/relay',status:allowed?200:403};
    });
    const incoming=server.sessionStream('/relay') as unknown as ReadableStream<TransportSession>;
    void this.accept(incoming,epoch,server).catch(()=>{if(this.sameRuntime(epoch,server))this.failed();});
    server.startServer();await this.deadline(server.ready,15_000);if(!this.alive(epoch,server))return fail();
    const native=server.address();if(!native||native.host!=='127.0.0.1'||native.port<1)return fail();
    const gateway=new NetworkTransportGateway(this.options.nic,Number(new URL(this.options.origin).port||443),native.port,
      ()=>this.alive(epoch,server),()=>{if(this.gateway===gateway&&this.sameRuntime(epoch,server))this.failed();},this.options.allowLoopbackTest);
    this.gateway=gateway;await gateway.start();if(!this.alive(epoch,server)||this.gateway!==gateway)return fail();
    // Publish the new pin only after a fresh native listener and its admitted LAN gateway exist.
    this.active=material;
    if(!this.timer){this.timer=setInterval(()=>{void this.refresh();},60_000);this.timer.unref();}
  }
  private deadline<T>(work:Promise<T>,ms:number):Promise<T>{
    return new Promise<T>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Secure QR request timed out')),ms);
      work.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});
  }
  private async refresh():Promise<void>{
    if(this.closed||this.refreshing)return;this.refreshing=true;
    try{
      if(!this.options.currentNic())return this.failed();
      const material=await this.options.certificates.material(this.options.origin+'/relay');if(this.closed)return;
      if(material.profile.pin!==this.active?.profile.pin){
        // The quiche 1.6.12 native binding has no updateCert implementation. Its public JS
        // wrapper silently does nothing. Retire the old backend, then bind a fresh one.
        await this.stopRuntime();if(this.closed)return;await this.listen(material,this.epoch);
      }else this.active=material;
    }catch{this.failed();}finally{this.refreshing=false;}
  }
  private async accept(incoming:ReadableStream<TransportSession>,epoch:number,server:NativeServer):Promise<void>{
    for await(const session of incoming as unknown as AsyncIterable<TransportSession>){
      if(!this.alive(epoch,server)||this.sessions.size>=64){session.close();continue;}
      this.sessions.add(session);void this.session(session,epoch,server);
    }
  }
  private async session(session:TransportSession,epoch:number,server:NativeServer):Promise<void>{
    const localAborts=new Set<()=>void>();let streams=0;
    session.closed.then(()=>{for(const abort of localAborts)abort();},()=>{for(const abort of localAborts)abort();});
    try{
      await this.deadline(session.ready,10_000);if(!this.alive(epoch,server))return fail();
      const header=session.header as Record<string,unknown>|undefined,origin=header?.origin;
      if(typeof origin!=='string'||![this.options.origin,...this.options.allowedOrigins].includes(origin))return fail();
      void(async()=>{for await(const stream of session.incomingUnidirectionalStreams as unknown as AsyncIterable<ReadableStream<Uint8Array>>){void stream.cancel().catch(()=>{});session.close();break;}})().catch(()=>{});
      if(session.datagrams)void(async()=>{for await(const _ of session.datagrams!.readable as unknown as AsyncIterable<Uint8Array>){session.close();break;}})().catch(()=>{});
      for await(const stream of session.incomingBidirectionalStreams as unknown as AsyncIterable<TransportStream>){
        if(!this.alive(epoch,server)||streams>=16||this.count>=128){void stream.readable.cancel().catch(()=>{});void stream.writable.abort().catch(()=>{});continue;}
        streams++;this.count++;
        void this.bridge(stream,origin,localAborts,epoch,server).catch(()=>{}).finally(()=>{streams--;this.count--;});
      }
    }catch{try{session.close();}catch{}}finally{this.sessions.delete(session);for(const abort of localAborts)abort();}
  }
  private async bridge(stream:TransportStream,origin:string,localAborts:Set<()=>void>,epoch:number,server:NativeServer):Promise<void>{
    const input=new TransportReader(stream.readable),writer=stream.writable.getWriter();let request:ClientRequest|undefined,response:IncomingMessage|undefined;
    let done=false,cancelled=false,reserved=0,headerTimer:ReturnType<typeof setTimeout>|undefined;
    const abort=()=>{cancelled=true;if(done)return;request?.destroy();response?.destroy();input.cancel();void writer.abort().catch(()=>{});};
    this.aborts.add(abort);localAborts.add(abort);writer.closed.catch(abort);
    try{
      const{meta,body}=await this.deadline(input.request(received=>{
        if(cancelled||!this.alive(epoch,server)||this.bufferedBodies+received>32*1024*1024)return fail();
        this.bufferedBodies+=received;reserved+=received;
      }),20_000);
      // A complete old request may already be queued as a microtask when rotation retires it.
      // Check its immutable runtime epoch immediately before any privileged HTTPS forwarding.
      if(cancelled||!this.alive(epoch,server))return fail();
      const target=new URL(this.options.origin),headers={...meta.headers,origin,host:target.host,'content-length':String(body.length)};
      response=await new Promise<IncomingMessage>((resolve,reject)=>{
        request=httpsRequest({hostname:target.hostname,port:Number(target.port||443),path:meta.path,method:meta.method,headers,
          ca:this.options.ca,rejectUnauthorized:true,minVersion:'TLSv1.3',agent:false},res=>{if(headerTimer)clearTimeout(headerTimer);resolve(res);});
        request.once('error',reject);headerTimer=setTimeout(()=>{request?.destroy();reject(new Error('Secure QR host response timed out'));},30_000);request.end(body);
      });
      if(cancelled||!this.alive(epoch,server))return fail();
      const status=response.statusCode??502;if(status<200||status>599)return fail();
      const returned:Record<string,string>={'cache-control':'no-store','x-content-type-options':'nosniff'};
      for(const[key,value]of Object.entries(response.headers))if(responseHeaders.has(key)&&typeof value==='string'&&value.length<=8192&&!/[\u0000-\u001f\u007f]/.test(value))returned[key]=value;
      await this.deadline(writer.write(transportFrame({version:1,status,headers:returned})),30_000);
      if(meta.method!=='HEAD'&&![204,205,304].includes(status))for await(const chunk of response){
        if(cancelled||!this.alive(epoch,server))return fail();const bytes=Buffer.from(chunk);
        for(let at=0;at<bytes.length;at+=65_536)await this.deadline(writer.write(bytes.subarray(at,at+65_536)),30_000);
      }else response.resume();
      await this.deadline(writer.close(),30_000);done=true;
    }catch{abort();}finally{done=true;if(headerTimer)clearTimeout(headerTimer);this.aborts.delete(abort);localAborts.delete(abort);this.bufferedBodies-=reserved;input.cancel();}
  }
  private async stopRuntime():Promise<void>{
    this.epoch++;this.active=undefined;
    const gateway=this.gateway,server=this.server,previous=this.retiring;this.gateway=undefined;this.server=undefined;
    for(const abort of this.aborts)abort();this.aborts.clear();for(const session of this.sessions){try{session.close();}catch{}}this.sessions.clear();
    const gatewayClosed=gateway?.close()??Promise.resolve();
    if(server){try{server.stopServer();}catch{}}
    const serverClosed=server?this.deadline(server.closed,5000).then(()=>{},()=>{}):Promise.resolve();
    // Never reset stream/body counters here: each retired bridge owns its finally decrement.
    this.retiring=Promise.all([previous,gatewayClosed,serverClosed]).then(()=>{});await this.retiring;
  }
  private failed():void{if(this.closed)return;void this.close();this.options.onFailure();}
  close():Promise<void>{
    if(this.closed)return this.retiring;this.closed=true;if(this.timer){clearInterval(this.timer);this.timer=undefined;}
    return this.stopRuntime();
  }
}
