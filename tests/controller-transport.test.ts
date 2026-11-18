import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto, createHash } from 'node:crypto';
import { BasicConstraintsExtension, X509CertificateGenerator } from '@peculiar/x509';
import { checkControllerHost, ControllerConnectionError } from '../client/controller-host.js';
import { parsePublicProfile, type PublicConnectionProfile, type TransportCatalogEnvelope } from '../client/controller-storage.js';
import { closeControllerTransport, controllerFetch, verifyTransportCatalog, ControllerTransportUnsupportedError, type TransportCatalog } from '../client/controller-transport.js';

const origin = 'https://192.168.1.20:3443', pin = 'ab'.repeat(32), encoder = new TextEncoder();
async function identity() {
  const keys = await webcrypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);
  const root = await X509CertificateGenerator.createSelfSigned({name:'CN=Relay transport client fixture',keys:keys as unknown as CryptoKeyPair,
    signingAlgorithm:{name:'ECDSA',hash:'SHA-256'},notBefore:new Date(Date.now()-86_400_000),notAfter:new Date(Date.now()+1000*86_400_000),
    extensions:[new BasicConstraintsExtension(true,0,true)]},webcrypto as unknown as Crypto);
  const profile: PublicConnectionProfile = {url:origin,ca:root.toString('pem'),fingerprint:createHash('sha256').update(Buffer.from(root.rawData)).digest('hex'),transport:{kind:'webtransport-v1',endpoint:origin+'/relay',pin}};
  const now = Date.now();
  const catalog: TransportCatalog = {version:1,hostFingerprint:profile.fingerprint,sequence:1,issuedAt:now,expiresAt:now+742*86_400_000,endpoint:origin+'/relay',
    leaves:[{sha256:pin,notBefore:now-300_000,notAfter:now+12*86_400_000-300_000}]};
  const sign = async (value: unknown): Promise<TransportCatalogEnvelope> => {
    const payload = JSON.stringify(value), bytes = encoder.encode(JSON.stringify(['relay-transport-catalog-v1',payload]));
    const signature = Buffer.from(await webcrypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},keys.privateKey,bytes)).toString('base64url');
    return {payload,signature};
  };
  return {profile,catalog,sign};
}
test('QR transport profile binds its endpoint to the exact private LAN authority and rejects extra fields', async () => {
  const {profile} = await identity(); assert.equal(parsePublicProfile(JSON.stringify(profile)).transport?.pin,pin);
  for (const transport of [{...profile.transport,endpoint:'https://evil.example/relay'},{...profile.transport,endpoint:origin.replace('3443','3444')+'/relay'},
    {...profile.transport,endpoint:origin+'/relay?target=http://localhost'}, {...profile.transport,pin:'x'.repeat(64)},{...profile.transport,cookie:'bad'}]) {
    assert.throws(()=>parsePublicProfile(JSON.stringify({...profile,transport})));
  }
});
test('catalog signature binds exact bytes, stable identity, validity, endpoint, sequence and bounded future leaves', async () => {
  const {profile,catalog,sign}=await identity(), valid=await sign(catalog);
  assert.equal((await verifyTransportCatalog(profile,valid)).sequence,1);
  await assert.rejects(verifyTransportCatalog(profile,{...valid,payload:valid.payload+' '}));
  const changed = [{...catalog,hostFingerprint:'0'.repeat(64)},{...catalog,endpoint:origin.replace('3443','3444')+'/relay'},
    {...catalog,leaves:[{...catalog.leaves[0],notAfter:catalog.leaves[0]!.notBefore+15*86_400_000}]},
    {...catalog,expiresAt:Date.now()-1}, {...catalog,expiresAt:catalog.issuedAt+751*86_400_000},
    {...catalog,leaves:[catalog.leaves[0],catalog.leaves[0]]}, {...catalog,sequence:0}, {...catalog,extra:true}];
  for (const value of changed) await assert.rejects(verifyTransportCatalog(profile,await sign(value)));
  const newer=await sign({...catalog,sequence:2});
  assert.equal((await verifyTransportCatalog(profile,newer,valid)).sequence,2);
  await assert.rejects(verifyTransportCatalog(profile,valid,newer));
  await assert.rejects(verifyTransportCatalog(profile,await sign({...catalog,issuedAt:catalog.issuedAt-1}),valid));
});

interface MockState { constructors: number; options: unknown[]; requests: Array<{metadata: Record<string,unknown>; body: Uint8Array}>; cancelled: number; mode: string }
function installNativeMock() {
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'WebTransport');
  const state: MockState={constructors:0,options:[],requests:[],cancelled:0,mode:'normal'};
  class MockTransport {
    ready=Promise.resolve(); closed: Promise<void>; closeResolve!:()=>void;
    constructor(_url:string,options:unknown) {state.constructors++;state.options.push(options);this.closed=new Promise(done=>{this.closeResolve=done;});}
    close(){this.closeResolve();}
    async createBidirectionalStream() {
      let output!:ReadableStreamDefaultController<Uint8Array>;const chunks:Uint8Array[]=[];
      const readable=new ReadableStream<Uint8Array>({start(controller){output=controller;},cancel(){state.cancelled++;}});
      const writable=new WritableStream<Uint8Array>({write(chunk){chunks.push(chunk.slice());},close(){
        const length=chunks.reduce((sum,chunk)=>sum+chunk.length,0),bytes=new Uint8Array(length);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
        const size=new DataView(bytes.buffer).getUint32(0),metadata=JSON.parse(new TextDecoder().decode(bytes.subarray(4,4+size)));
        state.requests.push({metadata,body:bytes.slice(4+size)});
        if(state.mode==='slow')return;
        const headers=state.mode==='bad-header'?{'set-cookie':'stolen=1'}:{'content-type':'application/octet-stream'};
        const response=encoder.encode(JSON.stringify({version:1,status:state.mode==='bodyless'?204:200,headers})),prefix=new Uint8Array(4);new DataView(prefix.buffer).setUint32(0,response.length);
        // Split the prefix and metadata across unrelated transport read boundaries.
        output.enqueue(prefix.slice(0,1));output.enqueue(prefix.slice(1));output.enqueue(response.slice(0,7));output.enqueue(response.slice(7));
        if(state.mode!=='bodyless'){output.enqueue(Uint8Array.from([0,1,255]));output.enqueue(Uint8Array.from([4,5]));}output.close();
      }});
      return {readable,writable};
    }
  }
  Object.defineProperty(globalThis,'WebTransport',{configurable:true,value:MockTransport});
  return {state,restore(){closeControllerTransport();if(descriptor)Object.defineProperty(globalThis,'WebTransport',descriptor);else Reflect.deleteProperty(globalThis,'WebTransport');}};
}
test('first QR starts native pinned handshake during activation; framing preserves signed path, headers and binary bytes', async()=>{
  const {profile}=await identity(), mock=installNativeMock();
  try {
    const waiting=controllerFetch(profile,'/api/example?name=a%20b',{method:'POST',headers:{'content-type':'application/octet-stream','x-relay-signature':'fixture-signature'},body:Uint8Array.from([9,0,255,8])});
    assert.equal(mock.state.constructors,1,'native constructor starts before yielding the user gesture');
    const response=await waiting;assert.deepEqual([...new Uint8Array(await response.arrayBuffer())],[0,1,255,4,5]);
    const request=mock.state.requests[0]!;assert.equal(request.metadata.path,'/api/example?name=a%20b');assert.equal(request.metadata.bodyLength,4);
    assert.deepEqual([...request.body],[9,0,255,8]);assert.equal((request.metadata.headers as Record<string,string>)['x-relay-signature'],'fixture-signature');
    const options=mock.state.options[0] as {allowPooling:boolean;serverCertificateHashes:Array<{algorithm:string;value:Uint8Array}>};
    assert.equal(options.allowPooling,false);assert.equal(options.serverCertificateHashes[0]!.algorithm,'sha-256');assert.equal(Buffer.from(options.serverCertificateHashes[0]!.value).toString('hex'),pin);
  } finally {mock.restore();}
});
test('unsupported browser, wrong paths/headers and tampered catalog never downgrade to ordinary fetch', async()=>{
  const {profile,catalog,sign}=await identity(), originalFetch=globalThis.fetch, descriptor=Object.getOwnPropertyDescriptor(globalThis,'WebTransport');let fetches=0;
  globalThis.fetch=(async()=>{fetches++;throw new Error('Must not fetch');}) as typeof fetch;
  try {
    Reflect.deleteProperty(globalThis,'WebTransport');await assert.rejects(controllerFetch(profile,'/api/bootstrap'),(error:unknown)=>error instanceof ControllerTransportUnsupportedError);
    await assert.rejects(checkControllerHost(profile),(error:unknown)=>error instanceof ControllerConnectionError && error.kind==='browser-unsupported' && /Update your browser or operating system/.test(error.message) && !/Wi-Fi/.test(error.message));
    for(const path of ['https://evil.example/api','//evil.example/api','/api/../bootstrap','/api/network/local-trust','/api/network/worker/jobs','/api/x#fragment'])await assert.rejects(controllerFetch(profile,path));
    for(const headers of [{cookie:'x'},{host:'localhost'},{origin:'https://evil.example'},{authorization:'Bearer x'}] as Array<Record<string,string>>)await assert.rejects(controllerFetch(profile,'/api/bootstrap',{headers}));
    const mock=installNativeMock();try {const envelope=await sign(catalog);await assert.rejects(controllerFetch({...profile,transport:{...profile.transport!,catalog:{...envelope,payload:envelope.payload+' '}}},'/api/bootstrap'));assert.equal(mock.state.constructors,0);}finally{mock.restore();}
    assert.equal(fetches,0);
  }finally{globalThis.fetch=originalFetch;if(descriptor)Object.defineProperty(globalThis,'WebTransport',descriptor);else Reflect.deleteProperty(globalThis,'WebTransport');}
});
test('encrypted responses reject cookie headers and preserve bodyless responses; cancellation aborts pending reads',async()=>{
  const {profile}=await identity(),mock=installNativeMock();
  try{
    mock.state.mode='bad-header';await assert.rejects(controllerFetch(profile,'/api/bootstrap'),/response header/);
    mock.state.mode='bodyless';const response=await controllerFetch(profile,'/api/example');assert.equal(response.status,204);assert.equal(response.body,null);
    mock.state.mode='slow';const abort=new AbortController(),request=controllerFetch(profile,'/api/example',{signal:abort.signal});
    await new Promise(done=>setTimeout(done,10));abort.abort();await assert.rejects(request,(error:unknown)=>error instanceof DOMException&&error.name==='AbortError');assert.ok(mock.state.cancelled>0);
  }finally{mock.restore();}
});
