import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, webcrypto } from 'node:crypto';
import { resolve } from 'node:path';
import { BasicConstraintsExtension, X509CertificateGenerator } from '@peculiar/x509';
import { chromium, type Browser } from 'playwright';
import { createServer } from 'vite';

test('owning window does not send a queued mutation after its real SW binding is deleted or repaired', {
  skip: process.env.RELAY_BROWSER_LIVE !== '1', timeout: 120_000,
}, async () => {
  const keys = await webcrypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);
  const certificate = await X509CertificateGenerator.createSelfSigned({name:'CN=Relay dispatch binding fixture',keys:keys as unknown as CryptoKeyPair,
    signingAlgorithm:{name:'ECDSA',hash:'SHA-256'},notBefore:new Date(Date.now()-86_400_000),notAfter:new Date(Date.now()+1000*86_400_000),
    extensions:[new BasicConstraintsExtension(true,0,true)]},webcrypto as unknown as Crypto);
  const root = {ca:certificate.toString('pem'),fingerprint:createHash('sha256').update(Buffer.from(certificate.rawData)).digest('hex')};
  const vite = await createServer({configFile:false,root:resolve('client'),server:{host:'127.0.0.1',port:0},appType:'spa'});
  let browser: Browser | undefined;
  try {
    await vite.listen(); browser = await chromium.launch({channel:'chrome',headless:true});
    for (const action of ['delete','repair'] as const) {
      const context = await browser.newContext();
      await context.addInitScript(() => { (window as any).__name = (value:unknown) => value; });
      const page = await context.newPage(); let directPrivateRequests = 0;
      page.on('request', request => { if (request.url().startsWith('https://192.168.1.20:3443')) directPrivateRequests++; });
      await page.route('**/binding-fixture',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Controller binding race</title>'}));
      await page.goto(vite.resolvedUrls!.local[0]!+'binding-fixture');
      await page.evaluate(async root => {
        const storageModule = '/controller-storage.ts', transportModule = '/controller-transport.ts';
        const store = await import(storageModule), transport = await import(transportModule);
        const device = await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);
        const profile = {id:crypto.randomUUID(),name:'Home',autoConnect:true,url:'https://192.168.1.20:3443',deviceId:'original-device',
          pairedAt:new Date().toISOString(),privateKey:device.privateKey,publicKey:await crypto.subtle.exportKey('jwk',device.publicKey),publicCA:root.ca,fingerprint:root.fingerprint,
          transport:{kind:'webtransport-v1',endpoint:'https://192.168.1.20:3443/relay',pin:'ab'.repeat(32)}};
        await store.saveProfile(profile);
        const counters = {wireWrites:0,streams:0,constructors:0};
        class DelayedTransport {
          ready:Promise<void>; closed:Promise<void>; closeResolve!:()=>void;
          constructor() {
            counters.constructors++; this.ready = new Promise(done => { (window as any).__releaseTransport = done; });
            this.closed = new Promise(done => { this.closeResolve = done; });
          }
          close() { this.closeResolve(); }
          async createBidirectionalStream() {
            counters.streams++;
            return {readable:new ReadableStream<Uint8Array>(),writable:new WritableStream<Uint8Array>({write(){counters.wireWrites++;}})};
          }
        }
        Object.defineProperty(window,'WebTransport',{configurable:true,value:DelayedTransport});
        const registration = await navigator.serviceWorker.register('/relay-controller-sw.js',{scope:'/'});
        await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller) await new Promise<void>(done => navigator.serviceWorker.addEventListener('controllerchange',()=>done(),{once:true}));
        const dispose = transport.bindControllerTransport(profile);
        await store.handshakeController(navigator.serviceWorker.controller ?? registration.active,profile);
        Object.assign(window,{__bindingTest:{store,profile,dispose,counters}});
        (window as any).__pendingMutation = fetch('/api/example-mutation',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({job:'must-not-run'})})
          .then(async response=>({status:response.status,body:await response.text()}));
      }, root);
      await page.waitForFunction(() => typeof (window as any).__releaseTransport === 'function');
      const result = await page.evaluate(async action => {
        const test = (window as any).__bindingTest;
        if (action === 'delete') await test.store.removeProfile(test.profile.id);
        else {
          const replacement = await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);
          await test.store.saveProfile({...test.profile,deviceId:'replacement-device',pairedAt:new Date(Date.now()+1).toISOString(),privateKey:replacement.privateKey,
            publicKey:await crypto.subtle.exportKey('jwk',replacement.publicKey)},{replaceGeneration:test.profile});
        }
        (window as any).__releaseTransport();
        const response = await (window as any).__pendingMutation;
        test.dispose();
        return {...test.counters,status:response.status};
      }, action);
      assert.equal(result.constructors,1,action); assert.equal(result.streams,1,action);
      assert.equal(result.wireWrites,0,`${action}: no metadata or mutation bytes may be sent after binding changed`);
      assert.ok(result.status >= 400,`${action}: request must fail locally`); assert.equal(directPrivateRequests,0,`${action}: no HTTPS downgrade`);
      await context.close();
    }
  } finally { await browser?.close(); await vite.close(); }
});
