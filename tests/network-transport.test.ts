import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, verify, X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Store } from '../server/store.js';
import { NetworkCertificates } from '../server/network-certificates.js';
import { NetworkTransportCertificates } from '../server/network-transport-certificates.js';
import { transportPeerAllowed } from '../server/network-transport-gateway.js';
import { TransportReader, transportFrame, validateTransportRequest } from '../server/network-transport.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'relay-qr-catalog-')), store = new Store(dir), values = new Map<string,string>(), gets: string[] = [], writes: string[] = [];
  const time = {now:Date.now()};
  const vault = {async get(name:string){gets.push(name);return values.get(name)??null;},async set(name:string,value:string){assert.ok(Buffer.byteLength(value)<=16_384);writes.push(name);values.set(name,value);},async remove(name:string){values.delete(name);}};
  const roots = new NetworkCertificates(store,vault,{clock:()=>time.now});
  return {store,values,gets,writes,time,vault,roots,manager:()=>new NetworkTransportCertificates(vault,roots,()=>time.now),cleanup(){store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('transport catalog persists exact independent epochs, verifies stable identity, and restarts with only the current encrypted chunk',async()=>{
  const f=fixture();try{
    await f.roots.material('192.168.1.20');const manager=f.manager(),first=await manager.material('https://192.168.1.20:3443/relay');
    const catalog=JSON.parse(first.catalog.payload),root=new X509Certificate(f.roots.publicCA()!.certificate);
    assert.equal(catalog.version,1);assert.equal(catalog.hostFingerprint,f.roots.publicCA()!.fingerprint);assert.equal(catalog.sequence,1);
    assert.equal(catalog.leaves.length,74);assert.ok(catalog.expiresAt<=f.time.now+750*86_400_000);
    assert.equal(verify('sha256',Buffer.from(JSON.stringify(['relay-transport-catalog-v1',first.catalog.payload])),{key:root.publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(first.catalog.signature,'base64url')),true);
    assert.equal(verify('sha256',Buffer.from(JSON.stringify(['relay-transport-catalog-v1',first.catalog.payload+' '])),{key:root.publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(first.catalog.signature,'base64url')),false);
    assert.equal(new X509Certificate(first.cert).fingerprint256.replaceAll(':','').toLowerCase(),first.profile.pin);
    const manifest=JSON.parse(f.values.get('network-transport-manifest')!);assert.equal(manifest.refs.length,10);
    const chunk=JSON.parse(f.values.get(manifest.refs[0])!);
    assert.notDeepEqual(createPublicKey(createPrivateKey(chunk.leaves[0].key)).export({type:'spki',format:'der'}),createPublicKey(createPrivateKey(chunk.leaves[1].key)).export({type:'spki',format:'der'}));
    f.gets.length=0;const restarted=await f.manager().material(first.profile.endpoint);
    assert.equal(restarted.cert,first.cert);assert.equal(restarted.key,first.key);assert.equal(restarted.catalog.payload,first.catalog.payload);
    assert.equal(f.gets.filter(name=>name.startsWith('network-transport-epoch-')).length,1);
    assert.equal(JSON.stringify(f.store.list('config')).includes('PRIVATE KEY'),false);
    const before=f.writes.length;f.time.now+=10*86_400_000+1000;const rotated=await manager.material(first.profile.endpoint);
    assert.notEqual(rotated.profile.pin,first.profile.pin);assert.equal(rotated.catalog.payload,first.catalog.payload);assert.equal(f.writes.length,before);
    manager.clear();assert.equal(manager.current(),undefined);
  }finally{f.cleanup();}
});

test('missing or corrupt current encrypted epoch fails closed without replacing stable identity or catalog',async()=>{
  const f=fixture();try{
    await f.roots.material('10.1.2.3');const initial=await f.manager().material('https://10.1.2.3:3443/relay');const manifest=f.values.get('network-transport-manifest')!,ref=JSON.parse(manifest).refs[0],chunk=f.values.get(ref)!;
    const before=f.writes.length,root=f.roots.publicCA()!.fingerprint;f.values.delete(ref);
    await assert.rejects(f.manager().material(initial.profile.endpoint));assert.equal(f.writes.length,before);assert.equal(f.values.get('network-transport-manifest'),manifest);
    const corrupted=JSON.parse(chunk);corrupted.leaves[0].key=corrupted.leaves[1].key;f.values.set(ref,JSON.stringify(corrupted));
    await assert.rejects(f.manager().material(initial.profile.endpoint));assert.equal(f.writes.length,before);assert.equal(f.roots.publicCA()!.fingerprint,root);
  }finally{f.cleanup();}
});

test('atomic encrypted manifest publication retains referenced chunks after ambiguous write failure',async()=>{
  const f=fixture();try{
    await f.roots.material('192.168.1.21');let failOnce=true;
    const vault={...f.vault,async set(name:string,value:string){await f.vault.set(name,value);if(name==='network-transport-manifest'&&failOnce){failOnce=false;throw Error('read-back unavailable');}}};
    await assert.rejects(new NetworkTransportCertificates(vault,f.roots,()=>f.time.now).material('https://192.168.1.21:3443/relay'));
    const manifest=JSON.parse(f.values.get('network-transport-manifest')!);for(const ref of manifest.refs)assert.ok(f.values.has(ref));
    const restored=await new NetworkTransportCertificates(vault,f.roots,()=>f.time.now).material('https://192.168.1.21:3443/relay');assert.ok(restored.profile.pin);
  }finally{f.cleanup();}
});

test('LAN admission rejects public, alternate private subnet, mapped IPv6, loopback, noncanonical and broadcast peers',()=>{
  const nic={address:'192.168.1.106',netmask:'255.255.255.0'};
  assert.equal(transportPeerAllowed('192.168.1.42',nic),true);
  for(const peer of ['8.8.8.8','10.0.0.1','192.168.2.42','::ffff:192.168.1.42','127.0.0.1','192.168.01.42','192.168.1.0','192.168.1.255','169.254.1.1'])assert.equal(transportPeerAllowed(peer,nic),false,peer);
  assert.equal(transportPeerAllowed('127.0.0.1',{address:'127.0.0.1',netmask:'255.0.0.0'},true),true);
  assert.equal(transportPeerAllowed('192.168.1.42',{...nic,netmask:'255.0.255.0'}),false);
});

const valid=()=>({version:1,method:'POST',path:'/api/chat?x=1',headers:{'content-type':'application/octet-stream','x-relay-device':'device'},bodyLength:3});
test('frame request boundary rejects authority, role, header and path confusion without normalizing signed bytes',()=>{
  assert.equal(validateTransportRequest(valid()).path,'/api/chat?x=1');
  for(const path of ['https://example.com/api','//example.com/api','/api/../bootstrap','/api/%2e%2e/bootstrap','/api/a%2Fb','/api/a\\b','/api/network/local-trust','/api/network/worker/poll','/api/chat#fragment','/api/a\n'])assert.throws(()=>validateTransportRequest({...valid(),path}),path);
  for(const name of ['host','origin','cookie','authorization','x-forwarded-for','x-relay-owner','X-Relay-Device','content-length'])assert.throws(()=>validateTransportRequest({...valid(),headers:{[name]:'spoof'}}),name);
  assert.throws(()=>validateTransportRequest({...valid(),method:'GET'}));
  assert.throws(()=>validateTransportRequest({...valid(),bodyLength:8*1024*1024+1}));
  assert.throws(()=>validateTransportRequest({...valid(),path:'/api/network/pair',bodyLength:16_385}));
  assert.throws(()=>validateTransportRequest({...valid(),headers:{accept:'a\r\nb'}}));
});

function readable(chunks:Uint8Array[]){return new ReadableStream<Uint8Array>({start(out){for(const chunk of chunks)out.enqueue(chunk);out.close();}});}
test('framing reads fragmented metadata and exact binary body, rejects oversized lengths, trailing and truncated bytes',async()=>{
  const body=Buffer.from([0,255,42]),wire=Buffer.concat([transportFrame(valid()),body]);
  const fragmented=Array.from(wire,byte=>new Uint8Array([byte]));const parsed=await new TransportReader(readable(fragmented)).request();assert.deepEqual(parsed.body,body);assert.equal(parsed.meta.path,valid().path);
  const oversized=Buffer.alloc(4);oversized.writeUInt32BE(16_385);await assert.rejects(new TransportReader(readable([oversized])).request());
  await assert.rejects(new TransportReader(readable([wire.subarray(0,-1)])).request());
  await assert.rejects(new TransportReader(readable([Buffer.concat([wire,Buffer.from([9])])])).request());
  assert.throws(()=>transportFrame({tooLarge:'x'.repeat(16_384)}));
});
