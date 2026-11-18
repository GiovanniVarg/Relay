import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {NetworkAccess} from '../server/network-access.js';
import {Security} from '../server/security.js';
import {Store} from '../server/store.js';

test('native QR certificate rotation replaces the backend and preserves saved pins across restart',{timeout:90000,skip:process.env.RELAY_BROWSER_LIVE!=='1'},async()=>{
const directory=await mkdtemp(join(tmpdir(),'relay-native-rotation-proof-'));
const store=new Store(directory),secrets=new Map<string,string>();
const actualNow=Date.now(),clock={now:actualNow-10*86_400_000};
const vault={async has(name:string){return secrets.has(name);},async get(name:string){return secrets.get(name)??null;},async set(name:string,value:string){assert.ok(Buffer.byteLength(value)<=16384);secrets.set(name,value);},async remove(name:string){secrets.delete(name);},close(){},availability(){return{available:true,protection:'isolated-memory-test'};}};
const origin='https://rotation-fixture.example';
const create=()=>new NetworkAccess(store,new Security(3210),vault,{assertWritable(){},async onRevoke(){},async workerRequest(_device,_req,res){res.writeHead(403);res.end();},async handle(_req,res){res.writeHead(404);res.end();}},{clock:()=>clock.now,allowLoopbackTest:true,transport:true,interfaces:()=>[{name:'rotation-test-loopback',address:'127.0.0.1',netmask:'255.0.0.0'}]});
let access:NetworkAccess|undefined=create(),browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
const watchdog=setTimeout(()=>{void browser?.close().catch(()=>{});void access?.close().catch(()=>{});},85_000);watchdog.unref();
const report:Record<string,unknown>={status:'running',test:'actual-native-updateCert-and-host-restart',initialClockBackdatedDays:10,sourceChanges:false,osTrustChanges:false};
async function ready(){const until=Date.now()+35_000;while(!access!.status().transport){if(Date.now()>until)throw Error('Native transport did not become ready: '+access!.status().transportError);await new Promise(resolve=>setTimeout(resolve,40));}return access!.status();}
try{
 await access!.enable({address:'127.0.0.1',port:0,controllerOrigins:[origin]});
 const first=await ready(),profileA=first.transport!;report.hostFingerprint=first.fingerprint;report.pinA=profileA.pin;
 browser=await chromium.launch({channel:'chrome',headless:true});
 const context=await browser.newContext(),cdp=await browser.newBrowserCDPSession();
 const contexts=await cdp.send('Target.getBrowserContexts');const permissions:string[]=[];
 for(const name of ['local-network','loopback-network']){try{await cdp.send('Browser.setPermission',{permission:{name},setting:'granted',origin,browserContextId:contexts.browserContextIds[0]});permissions.push(name);}catch(error){report[name+'PermissionUnsupported']=String(error);}}
 report.permissions=permissions;
 const page=await context.newPage();await page.addInitScript(()=>{(window as any).__name=(value:unknown)=>value;});
 await page.route(origin+'/proof',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Relay native certificate rotation proof</title>'}));await page.goto(origin+'/proof');
 await page.evaluate(()=>{
  const deadline=<T>(promise:Promise<T>,ms=12_000)=>new Promise<T>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('test timeout')),ms);promise.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});
  (window as any).rotationConnect=async(endpoint:string,pins:string[])=>{
   const wt=new(window as any).WebTransport(endpoint,{allowPooling:false,serverCertificateHashes:pins.map(pin=>({algorithm:'sha-256',value:Uint8Array.from(pin.match(/../g)!,part=>parseInt(part,16))}))});wt.closed.catch(()=>{});
   try{
    await deadline(wt.ready);const stream=await wt.createBidirectionalStream(),writer=stream.writable.getWriter();writer.closed.catch(()=>{});
    const nonce=crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
    const metadata=new TextEncoder().encode(JSON.stringify({version:1,method:'GET',path:'/api/network/info?challenge='+nonce,headers:{},bodyLength:0})),prefix=new Uint8Array(4);new DataView(prefix.buffer).setUint32(0,metadata.length);
    await deadline(writer.write(prefix));await deadline(writer.write(metadata));await deadline(writer.close());
    const reader:ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>=stream.readable.getReader();let pending=new Uint8Array(0);
    const exact=async(size:number)=>{const bytes=new Uint8Array(size);let offset=0;while(offset<size){if(!pending.length){const next=await deadline(reader.read());if(next.done)throw Error('truncated response');pending=next.value;}const take=Math.min(size-offset,pending.length);bytes.set(pending.subarray(0,take),offset);offset+=take;pending=pending.subarray(take);}return bytes;};
    const length=new DataView((await exact(4)).buffer).getUint32(0);if(length>16384)throw Error('oversized response metadata');const header=JSON.parse(new TextDecoder().decode(await exact(length)));if(header.status!==200)throw Error('HTTP '+header.status);
    const chunks:Uint8Array[]=[];let total=0;if(pending.length){chunks.push(pending);total+=pending.length;}
    for(;;){const next=await deadline(reader.read());if(next.done)break;total+=next.value.length;if(total>100000)throw Error('oversized public info');chunks.push(next.value);}
    const data=new Uint8Array(total);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length;}
    const info=JSON.parse(new TextDecoder().decode(data));if(info.hostProof?.challenge!==nonce)throw Error('wrong nonce proof');
    return{ok:true,info};
   }catch(error){return{ok:false,error:String(error),timeout:String(error).includes('test timeout')};}finally{try{wt.close();}catch{}}
  };
 });
 const connect=async(pins:string[])=>page.evaluate(async({endpoint,pins})=>(window as any).rotationConnect(endpoint,pins),{endpoint:profileA.endpoint,pins});
 const before=await connect([profileA.pin]);assert.equal(before.ok,true,JSON.stringify(before));
 const saved=before.info.transportCatalog,manifest=JSON.parse(saved.payload);assert.equal(manifest.hostFingerprint,first.fingerprint);
 report.initialPinAccepted=true;report.initialSequence=manifest.sequence;
 const validSavedPins=manifest.leaves.filter((leaf:any)=>leaf.notBefore<=actualNow&&actualNow<leaf.notAfter).map((leaf:any)=>leaf.sha256);
 assert.ok(validSavedPins.includes(profileA.pin));assert.ok(validSavedPins.length>=2);report.applicableSavedPins=validSavedPins.length;
 const retiredPath='/api/network/info?challenge='+randomBytes(24).toString('base64url');let retiredForwarded=0;
 (access as any).server.on('request',(req:{url?:string})=>{if(req.url===retiredPath)retiredForwarded++;});
 await page.evaluate(async({endpoint,pin,path})=>{
  const wt=new(window as any).WebTransport(endpoint,{allowPooling:false,serverCertificateHashes:[{algorithm:'sha-256',value:Uint8Array.from(pin.match(/../g)!,part=>parseInt(part,16))}]});wt.closed.catch(()=>{});await wt.ready;(window as any).retiredTransport=wt;
  const stream=await wt.createBidirectionalStream(),writer=stream.writable.getWriter();writer.closed.catch(()=>{});
  const metadata=new TextEncoder().encode(JSON.stringify({version:1,method:'GET',path,headers:{},bodyLength:0})),prefix=new Uint8Array(4);new DataView(prefix.buffer).setUint32(0,metadata.length);
  await writer.write(prefix);await writer.write(metadata);(window as any).retiredWriter=writer;
 },{endpoint:profileA.endpoint,pin:profileA.pin,path:retiredPath});
 await new Promise(resolve=>setTimeout(resolve,50));
 clock.now=actualNow;
 const runtime=(access as unknown as{transport:{refresh():Promise<void>;server:unknown;count:number}}).transport,oldBackend=runtime.server;
 await runtime.refresh();assert.notEqual(runtime.server,oldBackend,'Rotation must create a fresh native proof source');
 await page.evaluate(()=>{try{void(window as any).retiredWriter.close().catch(()=>{});}catch{}try{(window as any).retiredTransport.close();}catch{}});
 await new Promise(resolve=>setTimeout(resolve,100));assert.equal(retiredForwarded,0,'A retired pending stream must never enter HTTPS forwarding');assert.ok(runtime.count>=0);
 const second=access!.status(),profileB=second.transport!;assert.ok(profileB);assert.notEqual(profileB.pin,profileA.pin);report.pinB=profileB.pin;
 const strictB=await connect([profileB.pin]);assert.equal(strictB.ok,true,JSON.stringify(strictB));report.newPinAcceptedAfterNativeUpdate=true;
 const savedAccepted=await connect(validSavedPins);assert.equal(savedAccepted.ok,true,JSON.stringify(savedAccepted));report.savedCatalogReconnectsAfterUpdate=true;
 const staleA=await connect([profileA.pin]);assert.equal(staleA.ok,false,'Old pin alone unexpectedly accepted after native certificate update');assert.equal(staleA.timeout,false,'A timeout is not wrong-pin rejection');report.oldPinAloneRejected=true;report.oldPinError=staleA.error;
 const updated=JSON.parse(strictB.info.transportCatalog.payload);assert.equal(updated.sequence,manifest.sequence);assert.equal(strictB.info.transportCatalog.payload,saved.payload);report.catalogUnchangedDuringRotation=true;
 await access!.close();access=undefined;
 access=create();await access.restore();const restored=await ready();assert.equal(restored.fingerprint,first.fingerprint);assert.equal(restored.transport!.pin,profileB.pin);assert.equal(restored.transport!.endpoint,profileB.endpoint);
 const afterRestart=await connect([profileB.pin]);assert.equal(afterRestart.ok,true,JSON.stringify(afterRestart));const restartedCatalog=JSON.parse(afterRestart.info.transportCatalog.payload);assert.equal(restartedCatalog.sequence,manifest.sequence);assert.equal(afterRestart.info.transportCatalog.payload,saved.payload);
 report.samePinAfterHostRestart=true;report.sameHostIdentityAfterRestart=true;report.sameCatalogSequenceAfterRestart=true;report.status='pass';
}finally{
 clearTimeout(watchdog);await browser?.close();await access?.close();store.close();secrets.clear();await rm(directory,{recursive:true,force:true});
}
});
