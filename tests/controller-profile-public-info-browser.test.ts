import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {webcrypto,createHash} from 'node:crypto';
import {BasicConstraintsExtension,X509CertificateGenerator} from '@peculiar/x509';
import {chromium,type Browser} from 'playwright';
import ts from 'typescript';

async function publicRoot(){
  const keys=await webcrypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);
  const certificate=await X509CertificateGenerator.createSelfSigned({name:'CN=Relay public-info fixture',keys:keys as unknown as CryptoKeyPair,signingAlgorithm:{name:'ECDSA',hash:'SHA-256'},notBefore:new Date('2026-01-01'),notAfter:new Date('2030-01-01'),extensions:[new BasicConstraintsExtension(true,0,true)]},webcrypto as unknown as Crypto);
  return {ca:certificate.toString('pem'),fingerprint:createHash('sha256').update(Buffer.from(certificate.rawData)).digest('hex')};
}

test('pinned legacy profiles atomically persist verified public info without changing credentials or preferences',{skip:process.env.RELAY_BROWSER_LIVE!=='1',timeout:90000},async()=>{
  const roots=await Promise.all([publicRoot(),publicRoot()]);
  const source=ts.transpileModule(await readFile(resolve('client/controller-storage.ts'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  const server=createServer((request,response)=>{response.setHeader('Content-Type',request.url==='/storage.js'?'text/javascript':'text/html');response.end(request.url==='/storage.js'?source:'<!doctype html><title>Public-info fixture</title>');});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();assert.ok(address&&typeof address==='object');let browser:Browser|undefined;
  try{
    browser=await chromium.launch(process.env.RELAY_BROWSER_EXECUTABLE?{executablePath:process.env.RELAY_BROWSER_EXECUTABLE,headless:true}:{headless:true});const context=await browser.newContext();await context.addInitScript(()=>{(window as any).__name=(value:unknown)=>value;});const page=await context.newPage();await page.goto('http://127.0.0.1:'+address.port);
    const identity=await page.evaluate(async root=>{
      const keys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);
      const connection={id:'connection',url:'https://192.168.1.10:3211',deviceId:'legacy-device',pairedAt:'2026-01-01T00:00:00Z',privateKey:keys.privateKey,publicKey:await crypto.subtle.exportKey('jwk',keys.publicKey),fingerprint:root.fingerprint};
      await new Promise<void>((done,fail)=>{const request=indexedDB.open('relay-controller',1);request.onupgradeneeded=()=>request.result.createObjectStore('connection',{keyPath:'id'});request.onerror=()=>fail(request.error);request.onsuccess=()=>{const db=request.result,tx=db.transaction('connection','readwrite');tx.objectStore('connection').put(connection);tx.oncomplete=()=>{db.close();done();};};});
      const module='/storage.js',store=await import(module),profile=(await store.listProfiles())[0];if(profile.publicCA!==undefined)throw new Error('Expected optional publicCA to be absent');
      await store.updateProfileMetadata(profile.id,profile,{name:'Home',autoConnect:false});
      const saved=await store.updateProfilePublicInfo(profile.id,profile,{...root,url:'https://192.168.1.20:3211'});
      if(!saved || saved.name!=='Home' || saved.autoConnect!==false || saved.publicCA!==root.ca || saved.deviceId!==profile.deviceId || saved.pairedAt!==profile.pairedAt || saved.privateKey.extractable)throw new Error('Enrichment changed profile identity or preferences');
      const payload=new TextEncoder().encode('legacy enrichment key proof'),signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},saved.privateKey,payload);if(!await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},keys.publicKey,signature,payload))throw new Error('Enrichment replaced the private key');
      return {id:profile.id,deviceId:profile.deviceId,pairedAt:profile.pairedAt};
    },roots[0]);
    await page.reload();
    const reloaded=await page.evaluate(async id=>{const module='/storage.js',store=await import(module),profile=await store.loadProfile(id);const publicKey=await crypto.subtle.importKey('jwk',profile.publicKey,{name:'ECDSA',namedCurve:'P-256'},false,['verify']),payload=new TextEncoder().encode('reload proof'),signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},profile.privateKey,payload);return {ca:profile.publicCA,url:profile.url,name:profile.name,autoConnect:profile.autoConnect,extractable:profile.privateKey.extractable,verifies:await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},publicKey,signature,payload)};},identity.id);
    assert.equal(reloaded.ca,roots[0].ca);assert.equal(reloaded.url,'https://192.168.1.20:3211');assert.equal(reloaded.name,'Home');assert.equal(reloaded.autoConnect,false);assert.equal(reloaded.extractable,false);assert.equal(reloaded.verifies,true);
    const results=await page.evaluate(async({identity,roots})=>{
      const module='/storage.js',store=await import(module),info={...roots[0],url:'https://192.168.1.30:3211'};
      const wrongPin=await store.updateProfilePublicInfo(identity.id,identity,{...roots[1],url:info.url});let badDigestRejected=false;try{await store.updateProfilePublicInfo(identity.id,identity,{...info,fingerprint:'0'.repeat(64)});}catch{badDigestRejected=true;}
      const afterWrongPin=await store.loadProfile(identity.id),old=afterWrongPin;await store.saveProfile({...old,deviceId:'repaired-device',pairedAt:'2026-02-01T00:00:00Z'},{replaceGeneration:identity});
      const stale=await store.updateProfilePublicInfo(identity.id,identity,info),current=await store.loadProfile(identity.id);
      const unpinned={...current,id:crypto.randomUUID(),name:'Unpinned'};delete unpinned.fingerprint;delete unpinned.publicCA;await store.saveProfile(unpinned);const tofu=await store.updateProfilePublicInfo(unpinned.id,unpinned,info),unpinnedAfter=await store.loadProfile(unpinned.id);
      await store.removeProfile(identity.id);const missing=await store.updateProfilePublicInfo(identity.id,current,info);
      return {wrongPinIgnored:wrongPin===undefined,badDigestRejected,oldUrl:afterWrongPin.url,oldCA:afterWrongPin.publicCA,staleIgnored:stale===undefined,currentUrl:current.url,tofuIgnored:tofu===undefined,stillUnpinned:unpinnedAfter.fingerprint===undefined&&unpinnedAfter.publicCA===undefined,missingIgnored:missing===undefined,stillMissing:await store.loadProfile(identity.id)===undefined};
    },{identity,roots});
    assert.deepEqual(results,{wrongPinIgnored:true,badDigestRejected:true,oldUrl:'https://192.168.1.20:3211',oldCA:roots[0].ca,staleIgnored:true,currentUrl:'https://192.168.1.20:3211',tofuIgnored:true,stillUnpinned:true,missingIgnored:true,stillMissing:true});
  }finally{await browser?.close();await new Promise<void>((done,fail)=>server.close(error=>error?fail(error):done()));}
});
