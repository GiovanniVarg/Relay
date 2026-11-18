import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import ts from 'typescript';

// Real browser IndexedDB and real nonextractable CryptoKeys; only LAN transport and window inventory are mocked.
test('profile migration, immutable UI scope, and per-window signed routing survive worker restart', { skip: process.env.RELAY_BROWSER_LIVE !== '1', timeout: 90000 }, async () => {
  const storage = ts.transpileModule(await readFile(resolve('client/controller-storage.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const scope = ts.transpileModule(await readFile(resolve('client/controller-scope.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replaceAll('./controller-storage', '/storage.js');
  const worker = await readFile(resolve('client/public/relay-controller-sw.js'), 'utf8');
  const server = createServer((request, response) => { response.setHeader('Content-Type', request.url?.startsWith('/storage') || request.url?.startsWith('/scope') ? 'text/javascript' : 'text/html'); response.end(request.url?.startsWith('/storage') ? storage : request.url?.startsWith('/scope') ? scope : '<!doctype html><title>Controller profile fixture</title>'); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const browser = await chromium.launch(process.env.RELAY_BROWSER_EXECUTABLE ? { executablePath: process.env.RELAY_BROWSER_EXECUTABLE, headless: true } : { headless: true });
  try {
    const page = await browser.newPage(); await page.addInitScript(() => { (window as any).__name = (value: unknown) => value; }); await page.goto('http://127.0.0.1:' + address.port);
    const result = await page.evaluate(async workerSource => {
      const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
      const key = await crypto.subtle.generateKey({ name:'ECDSA',namedCurve:'P-256' },false,['sign','verify']);
      const publicKey = await crypto.subtle.exportKey('jwk',key.publicKey);
      const legacy = { id:'connection',url:'https://192.168.1.10:3211',deviceId:'device-a',pairedAt:'2026-01-01T00:00:00Z',privateKey:key.privateKey,publicKey };
      await new Promise<void>((done,fail) => { const request=indexedDB.open('relay-controller',1);request.onupgradeneeded=()=>request.result.createObjectStore('connection',{keyPath:'id'});request.onerror=()=>fail(request.error);request.onsuccess=()=>{const db=request.result,tx=db.transaction('connection','readwrite');tx.objectStore('connection').put(legacy);tx.oncomplete=()=>{db.close();done();};}; });
      const storageModule='/storage.js';const store = await import(storageModule);
      let profiles=await store.listProfiles();check(profiles.length===1,'legacy copied once');const a=profiles[0];check(a.legacyStorage && !a.privateKey.extractable,'migration preserves nonextractable key');
      const message=new TextEncoder().encode('migration proof'),signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},a.privateKey,message);
      check(await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key.publicKey,signature,message),'migrated key signs correctly');
      await store.listProfiles();check((await store.listProfiles()).length===1,'migration idempotent');
      const legacyStillExists=await new Promise<boolean>(done=>{const request=indexedDB.open('relay-controller',2);request.onsuccess=()=>{const db=request.result,read=db.transaction('connection').objectStore('connection').get('connection');read.onsuccess=()=>{db.close();done(Boolean(read.result?.privateKey));};};});check(legacyStillExists,'legacy store and record retained');
      const oldVersion=await new Promise<string>(done=>{const request=indexedDB.open('relay-controller',1);request.onerror=()=>done(request.error!.name);request.onsuccess=()=>{request.result.close();done('opened');};});check(oldVersion==='VersionError','v1 client fails closed');
      await store.saveProfile({...a,name:'Home'});check((await store.loadProfile(a.id)).legacyStorage,'renaming migrated profile retains migration grant');
      const b={...a,id:crypto.randomUUID(),name:'Office',url:'https://192.168.1.20:3211',deviceId:'device-b',pairedAt:'2026-01-02T00:00:00Z'};await store.saveProfile(b);check(!(await store.loadProfile(b.id)).legacyStorage,'new host cannot claim legacy UI state');
      await store.selectProfile(b.id);check((await store.loadSelectedProfile()).id===b.id,'selection points to B');await store.selectProfile(a.id);check((await store.listProfiles()).length===2,'selection never drops other host');
      localStorage.setItem('relay.draft','legacy draft');
      const scopeBModule='/scope.js?b';const scopeB=await import(scopeBModule);scopeB.setControllerScope(b.id);check(scopeB.scopedLocalStorage.getItem('relay.draft')===null,'B cannot adopt A legacy draft');scopeB.scopedLocalStorage.setItem('relay.draft','office draft');
      let refused=false;try{scopeB.setControllerScope(a.id);}catch{refused=true;}check(refused,'scope cannot change after mount');
      const scopeAModule='/scope.js?a';const scopeA=await import(scopeAModule);scopeA.setControllerScope(a.id,{claimLegacy:true});check(scopeA.scopedLocalStorage.getItem('relay.draft')==='legacy draft','only migrated A adopts legacy state');check(scopeB.scopedLocalStorage.getItem('relay.draft')==='office draft','host draft isolation');
      scopeA.scopedLocalStorage.removeItem('relay.draft');check(scopeA.scopedLocalStorage.getItem('relay.draft')===null,'cleared migrated draft never resurrects');check(localStorage.getItem('relay.draft')==='legacy draft','original local legacy draft preserved');
      const reloadedScopeModule='/scope.js?reloaded';const reloadedScope=await import(reloadedScopeModule);reloadedScope.setControllerScope(a.id,{claimLegacy:true});check(reloadedScope.scopedLocalStorage.getItem('relay.draft')===null,'migration tombstone survives helper reload');
      localStorage.setItem('relay.unread-draft','unread legacy draft');reloadedScope.scopedLocalStorage.setItem('relay.unread-draft','new scoped draft');reloadedScope.scopedLocalStorage.removeItem('relay.unread-draft');check(reloadedScope.scopedLocalStorage.getItem('relay.unread-draft')===null,'set then clear consumes unread legacy migration');check(localStorage.getItem('relay.unread-draft')==='unread legacy draft','set and clear preserve original legacy value');
      localStorage.setItem('relay.removed-draft','never imported');reloadedScope.scopedLocalStorage.removeItem('relay.removed-draft');check(reloadedScope.scopedLocalStorage.getItem('relay.removed-draft')===null,'removing an unread key prevents legacy adoption');
      sessionStorage.setItem('relay.session-draft','legacy session draft');check(reloadedScope.scopedSessionStorage.getItem('relay.session-draft')==='legacy session draft','session legacy draft imported once');reloadedScope.scopedSessionStorage.removeItem('relay.session-draft');check(reloadedScope.scopedSessionStorage.getItem('relay.session-draft')===null && sessionStorage.getItem('relay.session-draft')==='legacy session draft','session removal does not resurrect or delete local original');
      localStorage.setItem('relay.quota-draft','untouched legacy draft');
      const nativeSet=Storage.prototype.setItem, failingKey=scopeA.controllerStorageKey('relay.quota-draft');let quotaFailed=false;
      Storage.prototype.setItem=function(name:string,value:string){if(this===localStorage&&name===failingKey)throw new DOMException('quota fixture','QuotaExceededError');return nativeSet.call(this,name,value);};
      try{scopeA.scopedLocalStorage.setItem('relay.quota-draft','new draft');}catch(error){quotaFailed=error instanceof DOMException&&error.name==='QuotaExceededError';}finally{Storage.prototype.setItem=nativeSet;}
      check(quotaFailed,'failed scoped write surfaces quota error');check(scopeA.scopedLocalStorage.getItem('relay.quota-draft')==='untouched legacy draft','failed write cannot consume or hide untouched legacy draft');
      const clients=new Map(['a','b'].map(id=>[id,{id,type:'window',url:location.origin+'/'+id,messages:[] as unknown[],postMessage(message:unknown){this.messages.push(message);}}]));
      const calls:{origin:string;device:string|null;method:string;body:string;credentials:RequestCredentials|undefined}[]=[];
      let status=200,failNetwork=false,blocked:((response:Response)=>void)|undefined;
      const transport=async(url:URL,options:RequestInit)=>{calls.push({origin:url.origin,device:new Headers(options.headers).get('X-Relay-Device'),method:options.method!,body:options.body?new TextDecoder().decode(options.body as ArrayBuffer):'',credentials:options.credentials});if(failNetwork)throw new Error('network fixture');if(url.pathname==='/api/slow')return new Promise<Response>(done=>{blocked=done;});return new Response('reply',{status});};
      const makeWorker=()=>new Function('self','fetch',workerSource+';return {signedFetch,handleMessage};')({location:{origin:location.origin},clients:{get:async(id:string)=>clients.get(id),matchAll:async()=>[...clients.values()]},addEventListener(){}},transport);
      let bridge=makeWorker();
      const command=async(clientId:string,message:Record<string,unknown>)=>{let ack:any;await bridge.handleMessage({source:clients.get(clientId),data:{version:3,...message},ports:[{postMessage(value:unknown){ack=value;}}]});return ack;};
      const bind=(clientId:string,profile:any)=>command(clientId,{type:'BIND_PROFILE',profileId:profile.id,deviceId:profile.deviceId,pairedAt:profile.pairedAt});
      check((await command('a',{type:'HELLO'})).version===3,'v3 handshake');check(!(await command('a',{type:'HELLO',version:1})).ok,'v1 handshake rejected');check(!(await command('a',{type:'HELLO',version:2})).ok,'v2 handshake rejected');
      check((await bind('a',a)).ok && (await bind('b',b)).ok,'windows bind independent profiles');
      const send=(id:string,path='/api/probe',method='POST')=>bridge.signedFetch(new Request(location.origin+path,{method,...(method==='POST'?{body:'exact body'}:{}),headers:{Cookie:'must-not-forward','Content-Type':'text/plain'}}),id);
      await store.selectProfile(b.id);check((await send('a')).status===200 && (await send('b')).status===200,'both windows sign');check(calls[0].origin===a.url && calls[0].device===a.deviceId && calls[1].origin===b.url,'global selection cannot reroute either window');check(calls.every(call=>call.credentials==='omit') && calls[0].body==='exact body','cookie omission and exact write body');
      bridge=makeWorker();check((await send('a')).status===200 && calls.at(-1)!.origin===a.url,'worker restart restores persistent binding');
      const beforeMissing=calls.length;check((await send('missing')).status===409 && calls.length===beforeMissing,'unbound API fails without network');
      check(!(await bind('a',{...a,pairedAt:'wrong-generation'})).ok,'stale generation cannot bind');
      const slow=send('a','/api/slow');while(!blocked)await new Promise(done=>setTimeout(done,0));await bind('a',b);blocked(new Response('old-host receipt',{status:401}));check((await slow).status===409,'late old-generation response cannot cross binding');check((await send('a')).status===200 && calls.at(-1)!.origin===b.url,'late 401 leaves replacement binding intact');
      await bind('a',a);status=401;check((await send('a')).status===401,'host auth failure forwarded');check((await store.loadProfile(a.id)).privateKey && (await store.loadProfile(b.id)).privateKey,'auth failure preserves both saved keys');check((await send('a')).status===409,'auth failure unbinds only requesting window');status=200;check((await send('b')).status===200,'B stays connected');check(clients.get('a')!.messages.some((value:any)=>value.type==='AUTH_REQUIRED'&&value.profileId===a.id),'auth notification targets exact profile');
      status=403;check((await send('b')).status===403,'policy denial forwarded');status=200;check((await send('b')).status===200,'403 preserves binding');
      failNetwork=true;const beforeFailure=calls.length;check((await send('b')).status===503,'network failure returned');check(calls.length===beforeFailure+1,'one write attempt, no replay');check((await store.loadProfile(b.id)).privateKey,'network failure preserves key');failNetwork=false;check(calls.length===beforeFailure+1,'reconnection never replays writes');
      await bind('a',a);await store.saveProfile({...a,pairedAt:'2026-02-01T00:00:00Z'},{replaceGeneration:{deviceId:a.deviceId,pairedAt:a.pairedAt}});const beforeStale=calls.length;check((await send('a')).status===409 && calls.length===beforeStale,'repairing profile invalidates previous generation');
      await store.removeProfile(a.id);check((await send('b')).status===200,'removing A leaves B binding intact');await store.removeProfile(b.id);const afterRemoval=calls.length;check((await send('b')).status===409 && calls.length===afterRemoval,'removing bound profile invalidates route');
      for(let index=0;index<16;index++)await store.saveProfile({...b,id:crypto.randomUUID(),name:'Host '+index});let capacityRefused=false;try{await store.saveProfile({...b,id:crypto.randomUUID(),name:'Overflow'});}catch{capacityRefused=true;}check(capacityRefused && (await store.listProfiles()).length===16,'profile capacity fails without evicting a saved host');
      return {profilesMigrated:1,oldVersion,privateKeyExtractable:a.privateKey.extractable,requests:calls.length};
    },worker);
    assert.equal(result.profilesMigrated,1);assert.equal(result.oldVersion,'VersionError');assert.equal(result.privateKeyExtractable,false);assert.ok(result.requests>=8);
  } finally { await browser.close();await new Promise<void>((done,fail)=>server.close(error=>error?fail(error):done())); }
});
