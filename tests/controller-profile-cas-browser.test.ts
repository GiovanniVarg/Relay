import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium,type Browser} from 'playwright';
import ts from 'typescript';

test('atomic profile metadata and repair CAS preserve cross-tab updates and never revive removed profiles',{skip:process.env.RELAY_BROWSER_LIVE!=='1',timeout:90000},async()=>{
  const source=ts.transpileModule(await readFile(resolve('client/controller-storage.ts'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  const server=createServer((request,response)=>{response.setHeader('Content-Type',request.url==='/storage.js'?'text/javascript':'text/html');response.end(request.url==='/storage.js'?source:'<!doctype html><title>Profile CAS fixture</title>');});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();assert.ok(address&&typeof address==='object');let browser:Browser|undefined;
  try{
    browser=await chromium.launch(process.env.RELAY_BROWSER_EXECUTABLE?{executablePath:process.env.RELAY_BROWSER_EXECUTABLE,headless:true}:{headless:true});
    const context=await browser.newContext();await context.addInitScript(()=>{(window as any).__name=(value:unknown)=>value;});
    const first=await context.newPage(),second=await context.newPage(),origin='http://127.0.0.1:'+address.port;
    await Promise.all([first.goto(origin),second.goto(origin)]);
    const identity=await first.evaluate(async()=>{
      const module='/storage.js',store=await import(module),keys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);
      const profile={id:crypto.randomUUID(),name:'Home',autoConnect:true,url:'https://192.168.1.10:3211',deviceId:'device-before',pairedAt:'2026-01-01T00:00:00Z',privateKey:keys.privateKey,publicKey:await crypto.subtle.exportKey('jwk',keys.publicKey)};
      await store.saveProfile(profile);(window as any).oldProfile=await store.loadProfile(profile.id);return {id:profile.id,deviceId:profile.deviceId,pairedAt:profile.pairedAt};
    });
    await second.evaluate(async id=>{const module='/storage.js',store=await import(module);(window as any).oldProfile=await store.loadProfile(id);},identity.id);
    await Promise.all([
      first.evaluate(async expected=>{const module='/storage.js',store=await import(module);await store.updateProfileMetadata(expected.id,expected,{name:'Office'});},identity),
      second.evaluate(async expected=>{const module='/storage.js',store=await import(module);await store.updateProfileMetadata(expected.id,expected,{autoConnect:false});},identity),
    ]);
    const metadata=await second.evaluate(async expected=>{const module='/storage.js',store=await import(module);return store.updateProfileMetadata(expected.id,expected,{lastConnectedAt:'2026-11-18T12:00:00Z'});},identity);
    assert.equal(metadata.name,'Office');assert.equal(metadata.autoConnect,false);assert.equal(metadata.lastConnectedAt,'2026-11-18T12:00:00Z');
    const repaired=await first.evaluate(async expected=>{
      const module='/storage.js',store=await import(module),keys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);
      const current=await store.loadProfile(expected.id),next={...current,deviceId:'device-after',pairedAt:'2026-02-01T00:00:00Z',privateKey:keys.privateKey,publicKey:await crypto.subtle.exportKey('jwk',keys.publicKey)};
      let implicitRejected=false;try{await store.saveProfile(next);}catch{implicitRejected=true;}
      await store.saveProfile(next,{replaceGeneration:expected});const saved=await store.loadProfile(expected.id),message=new TextEncoder().encode('CAS repaired identity'),signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},saved.privateKey,message);
      (window as any).repairedProfile=saved;return {implicitRejected,extractable:saved.privateKey.extractable,verifies:await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},keys.publicKey,signature,message),deviceId:saved.deviceId,pairedAt:saved.pairedAt,name:saved.name,autoConnect:saved.autoConnect};
    },identity);
    assert.equal(repaired.implicitRejected,true);assert.equal(repaired.extractable,false);assert.equal(repaired.verifies,true);assert.equal(repaired.name,'Office');assert.equal(repaired.autoConnect,false);
    const stale=await second.evaluate(async expected=>{
      const module='/storage.js',store=await import(module),old=(window as any).oldProfile;
      const touched=await store.updateProfileMetadata(expected.id,expected,{name:'Stale tab',autoConnect:true,lastConnectedAt:'2026-01-01T01:00:00Z'});
      let staleSaveRejected=false,staleRepairRejected=false;try{await store.saveProfile(old);}catch{staleSaveRejected=true;}try{await store.saveProfile({...old,deviceId:'third-device'},{replaceGeneration:expected});}catch{staleRepairRejected=true;}
      const current=await store.loadProfile(expected.id);return {ignored:touched===undefined,staleSaveRejected,staleRepairRejected,name:current.name,autoConnect:current.autoConnect,deviceId:current.deviceId};
    },identity);
    assert.equal(stale.ignored,true);assert.equal(stale.staleSaveRejected,true);assert.equal(stale.staleRepairRejected,true);assert.equal(stale.name,'Office');assert.equal(stale.autoConnect,false);assert.equal(stale.deviceId,'device-after');
    await second.evaluate(async id=>{const module='/storage.js',store=await import(module);(window as any).pendingRepair=await store.loadProfile(id);},identity.id);
    await first.evaluate(async id=>{const module='/storage.js',store=await import(module);await store.removeProfile(id);},identity.id);
    const removed=await second.evaluate(async id=>{
      const module='/storage.js',store=await import(module),pending=(window as any).pendingRepair;
      const touched=await store.updateProfileMetadata(id,pending,{lastConnectedAt:'2026-11-18T13:00:00Z'});let rejected=false;try{await store.saveProfile({...pending,deviceId:'late-repair'},{replaceGeneration:pending});}catch{rejected=true;}
      return {ignored:touched===undefined,rejected,absent:await store.loadProfile(id)===undefined,count:(await store.listProfiles()).length};
    },identity.id);
    assert.deepEqual(removed,{ignored:true,rejected:true,absent:true,count:0});
  }finally{await browser?.close();await new Promise<void>((done,fail)=>server.close(error=>error?fail(error):done()));}
});
