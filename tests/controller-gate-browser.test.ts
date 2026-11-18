import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir,networkInterfaces} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash,generateKeyPairSync,randomBytes,sign,X509Certificate} from 'node:crypto';
import {request as httpsRequest} from 'node:https';
import {createServer} from 'vite';
import {chromium,type Browser} from 'playwright';
import {Store} from '../server/store.js';
import {Security,jsonBody} from '../server/security.js';
import {NetworkAccess} from '../server/network-access.js';
import {bodyHash,signingPayload} from '../server/network-auth.js';
import type {SecretVaultLike} from '../server/typesafe.js';
import {png} from './fixtures/attachment-inputs.js';

const liveBrowser=process.env.RELAY_BROWSER_LIVE==='1';
const privateAddress=()=>Object.values(networkInterfaces()).flatMap(values=>values??[]).find(value=>value.family==='IPv4'&&!value.internal&&/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(value.address));
const fixtureModule=`
import {createElement,useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ControllerGate} from '/ControllerGate.tsx';
import '/controller.css';
window.controllerMounts=0;
function Connected(){
 const[csrf,setCsrf]=useState(''),[status,setStatus]=useState('Opening'),[events,setEvents]=useState('');
 useEffect(()=>{window.controllerMounts++;fetch('/api/bootstrap').then(r=>r.json()).then(value=>{setCsrf(value.csrfToken);setStatus('Connected');});},[]);
 async function request(path,method='GET',body){const response=await fetch(path,{method,headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},...(body===undefined?{}:{body:JSON.stringify(body)})});setStatus(String(response.status));}
 return createElement('section',{'aria-label':'Connected controller'},createElement('p',{role:'status'},status),createElement('img',{src:'/api/image',alt:'Signed controller image'}),
  createElement('button',{onClick:()=>request('/api/probe','POST',{instruction:'Synthetic exact body'})},'Send signed probe'),
  createElement('button',{onClick:()=>request('/api/probe')},'Check connection'),
  createElement('button',{onClick:()=>request('/api/policy-deny','POST',{})},'Check policy denial'),
  createElement('button',{onClick:()=>{const source=new EventSource('/api/events');let received=[];source.onmessage=event=>{received.push(event.data);setEvents(received.join(', '));if(received.length===2)source.close();};}},'Open live events'),
  createElement('p',{'data-testid':'stream-events'},events));
}
createRoot(document.getElementById('root')).render(createElement(ControllerGate,null,createElement(Connected)));
`;

test('ordinary loopback mounts the local app without registering the controller worker',{skip:!liveBrowser,timeout:60000},async()=>{
 const source="import{createElement}from'react';import{createRoot}from'react-dom/client';import{ControllerGate}from'/ControllerGate.tsx';createRoot(document.getElementById('root')).render(createElement(ControllerGate,null,createElement('p',null,'Local Relay app')));";
 const vite=await createServer({configFile:false,root:resolve('client'),define:{__RELAY_HOSTED__:'false'},esbuild:{jsx:'automatic'},logLevel:'error',server:{host:'127.0.0.1',port:0},plugins:[{name:'controller-loopback-fixture',resolveId(id){if(id==='/controller-loopback.tsx')return '\0controller-loopback';},load(id){if(id==='\0controller-loopback')return source;}}]});let browser:Browser|undefined;
 try{await vite.listen();browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage();await page.route('**/loopback-fixture',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><div id="root"></div><script type="module" src="/controller-loopback.tsx"></script>'}));await page.goto(vite.resolvedUrls!.local[0]+'loopback-fixture');await page.getByText('Local Relay app',{exact:true}).waitFor();assert.equal(await page.getByRole('heading',{name:'Connect to your Relay'}).count(),0);assert.equal(await page.evaluate(async()=>(await navigator.serviceWorker.getRegistrations()).length),0);}
 finally{await browser?.close();await vite.close();}
});

for(const mode of ['separate-origin','same-origin'] as const)test(`actual ${mode} Gate/SW pairing, signed bodies, policy denial, streaming SSE, and revocation`,{skip:!liveBrowser,timeout:120000},async t=>{
 const nic=privateAddress();if(!nic){t.skip('A private IPv4 interface is required for the production LAN-origin validator.');return;}
 const dir=await mkdtemp(join(tmpdir(),'relay-controller-browser-')),store=new Store(dir,{deferRecovery:true}),base=new Security(3210),secrets=new Map<string,string>();
 const vault={has:async(key:string)=>secrets.has(key),get:async(key:string)=>secrets.get(key)??null,set:async(key:string,value:string)=>{secrets.set(key,value);},remove:async(key:string)=>{secrets.delete(key);},close(){},availability(){return {available:true,protection:'test'};}} as unknown as SecretVaultLike;
 const protectedCalls:{path:string;cookie?:string;body?:unknown}[]=[];
 let browser:Browser|undefined;let vite:Awaited<ReturnType<typeof createServer>>|undefined;
 const access=new NetworkAccess(store,base,vault,{assertWritable(){},async handle(req,res,security){
  security.validate(req);const url=new URL(req.url!,'https://fixture');
  if(!url.pathname.startsWith('/api/')){if(!vite)throw Error('Fixture shell is unavailable');vite.middlewares(req,res,()=>{res.statusCode=404;res.end('Not found');});return;}
  const session=security.bootstrap(req,res);if(!['GET','HEAD'].includes(req.method!))security.mutation(req);
  const body=req.method==='POST'?await jsonBody(req):undefined;protectedCalls.push({path:url.pathname,cookie:req.headers.cookie,body});
  if(url.pathname==='/api/image'){res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'no-store'});res.end(png());return;}
  if(url.pathname==='/api/events'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store'});res.write('data: first\n\n');const timer=setTimeout(()=>res.write('data: second\n\n'),50);res.once('close',()=>clearTimeout(timer));return;}
  const status=url.pathname==='/api/policy-deny'?403:200;res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(url.pathname==='/api/bootstrap'?{csrfToken:session.csrf}:{accepted:status===200,body}));
 },async workerRequest(_device,_req,res){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({worker:true}));},async onRevoke(){}},{allowLoopbackTest:true,interfaces:()=>[{name:'fixture-lan',address:nic.address,netmask:nic.netmask}]});
 try{
  const material=await access.certificates.material(nic.address),ca=access.certificates.publicCA()!,fixtureSpki=[material.cert,ca.certificate].map(pem=>createHash('sha256').update(new X509Certificate(pem).publicKey.export({format:'der',type:'spki'})).digest('base64')).join(',');
  vite=await createServer({configFile:false,root:resolve('client'),publicDir:resolve('client/public'),define:{__RELAY_HOSTED__:'true'},esbuild:{jsx:'automatic'},logLevel:'error',server:{host:nic.address,port:0,https:{key:material.key,cert:material.cert}},plugins:[{name:'controller-gate-fixture',resolveId(id){if(id==='/controller-gate-fixture.tsx')return '\0controller-gate-fixture';},load(id){if(id==='\0controller-gate-fixture')return fixtureModule;},configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=='/'){next();return;}void server.transformIndexHtml('/','<!doctype html><html><head><link rel="manifest" href="/manifest.webmanifest"></head><body><div id="root"></div><script type="module" src="/controller-gate-fixture.tsx"></script></body></html>').then(html=>{res.setHeader('Content-Type','text/html');res.end(html);}).catch(next);});}}]});await vite.listen();const address=vite.httpServer!.address();assert.ok(address&&typeof address==='object');const publicOrigin='https://'+nic.address+':'+address.port;
  const status=await access.enable({address:nic.address,port:0,controllerOrigins:[publicOrigin]});
  // Trust only these ephemeral test certificate SPKIs in an isolated Chrome profile. TLS stays enabled;
  // this is test provisioning, not a product mechanism for bypassing OS certificate trust.
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--ignore-certificate-errors-spki-list='+fixtureSpki]});
  const controllerOrigin=mode==='same-origin'?status.url!:publicOrigin;
  const context=await browser.newContext({viewport:{width:320,height:740},userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'});await context.addCookies([{name:'must_not_forward',value:'synthetic-public-cookie',url:controllerOrigin}]);
  await context.addInitScript(()=>{const original=navigator.permissions.query.bind(navigator.permissions);(window as any).fixturePermission='unknown';navigator.permissions.query=(descriptor:PermissionDescriptor)=>descriptor.name===('local-network' as PermissionName)?((window as any).fixturePermission==='unknown'?Promise.reject(new Error('Granular permission unsupported')):Promise.resolve({state:(window as any).fixturePermission} as PermissionStatus)):original(descriptor);});
  const page=await context.newPage(),profile={url:status.url!,ca:ca.certificate,fingerprint:ca.fingerprint},fragment=Buffer.from(JSON.stringify(profile)).toString('base64url');
  const probeTrace:string[]=[];page.on('request',request=>{if(request.url().includes('/api/network/info?'))probeTrace.push('request '+request.url());});page.on('requestfailed',request=>{if(request.url().includes('/api/network/info?'))probeTrace.push('failed '+request.url()+' '+request.failure()?.errorText);});
  page.on('pageerror',error=>probeTrace.push('pageerror '+error.message));
  await page.goto(controllerOrigin+'/#connect='+fragment);await page.getByRole('heading',{name:'My Relay',exact:true}).waitFor();assert.equal(new URL(page.url()).hash,'');assert.equal(await page.evaluate(()=>(window as any).controllerMounts),0);assert.equal(protectedCalls.length,0);
  // Public profile bytes are pinned before an OS certificate profile may be offered.
  // A single simulated transport failure exposes the one-time guidance without weakening TLS.
  await page.route('**/api/network/info?*',async route=>{await route.abort('failed');});
  await page.evaluate(()=>(window as any).fixturePermission='denied');
  await page.getByRole('button',{name:'Check connection',exact:true}).click();await page.getByText('Allow local network access',{exact:true}).waitFor();assert.equal(await page.getByLabel('Sync code',{exact:true}).count(),0);
  await page.evaluate(()=>(window as any).fixturePermission='unknown');
  await page.getByRole('button',{name:'Recheck connection',exact:true}).click();
  await page.getByText('Advanced: legacy certificate setup',{exact:true}).click();
  await page.getByRole('heading',{name:'Legacy HTTPS connection'}).waitFor();
  await page.unroute('**/api/network/info?*');
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'Download iPhone certificate profile'}).click();const profileDownload=await download;assert.equal(profileDownload.suggestedFilename(),'RelayLocalCA.mobileconfig');const stream=await profileDownload.createReadStream();assert.ok(stream);const chunks:Buffer[]=[];for await(const chunk of stream)chunks.push(Buffer.from(chunk));const xml=Buffer.concat(chunks).toString();assert.match(xml,/com\.apple\.security\.root/);assert.equal(xml.includes('PRIVATE KEY'),false);
  await page.getByRole('button',{name:'Recheck connection',exact:true}).click();
  await page.getByLabel('Sync code',{exact:true}).waitFor();
  assert.equal(await page.getByRole('heading',{name:'Legacy HTTPS connection'}).count(),0);
  await page.getByText('Connection details',{exact:true}).click();
  const invite=access.devices.createInvite('controller');await page.getByLabel('This device’s name',{exact:true}).fill('Browser controller fixture');await page.getByLabel('Sync code',{exact:true}).fill(invite.code);await page.getByRole('button',{name:'Connect securely',exact:true}).click();await page.getByRole('region',{name:'Connected controller'}).waitFor().catch(async()=>{await page.getByLabel('Connected controller').waitFor();});await page.waitForFunction(()=>document.querySelector('[aria-label="Connected controller"] [role="status"]')?.textContent==='Connected');
  const connection=await page.evaluate(async modulePath=>{const storage=await import(modulePath);const saved=await storage.loadSelectedProfile();return {deviceId:saved.deviceId,id:saved.id,extractable:saved.privateKey.extractable,keys:Object.keys(saved)};},'/controller-storage.ts');
  assert.equal(connection.extractable,false);assert.equal(connection.keys.includes('code'),false);assert.equal(await page.evaluate(()=>navigator.serviceWorker.controller?.scriptURL.endsWith('/relay-controller-sw.js')),true);assert.equal(await page.evaluate(()=>(window as any).controllerMounts),1);
  await page.waitForFunction(()=>{const image=document.querySelector('img[alt="Signed controller image"]') as HTMLImageElement|null;return image?.complete&&image.naturalWidth>0;});assert.ok(protectedCalls.some(call=>call.path==='/api/image'));
  await page.getByRole('button',{name:'Send signed probe'}).click();await page.waitForFunction(()=>document.querySelector('[aria-label="Connected controller"] [role="status"]')?.textContent==='200');assert.deepEqual(protectedCalls.find(call=>call.path==='/api/probe'&&call.body)?.body,{instruction:'Synthetic exact body'});assert.ok(protectedCalls.every(call=>!call.cookie));
  await page.getByRole('button',{name:'Check policy denial'}).click();await page.waitForFunction(()=>document.querySelector('[aria-label="Connected controller"] [role="status"]')?.textContent==='403');assert.equal(await page.getByRole('heading',{name:'Connect to your Relay'}).count(),0);
  await page.getByRole('button',{name:'Open live events'}).click();await page.waitForFunction(()=>document.querySelector('[data-testid="stream-events"]')?.textContent==='first, second');
  assert.equal(await page.evaluate(async()=>{for(const name of await caches.keys())if(await(await caches.open(name)).match('/api/probe'))return true;return false;}),false);
  // The worker role cannot reach controller APIs even with a valid signature and trusted TLS.
  const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=keys.publicKey.export({format:'jwk'}),workerInvite=access.devices.createInvite('worker');
  async function tls(method:string,path:string,input?:unknown,id?:string){const body=input===undefined?Buffer.alloc(0):Buffer.from(JSON.stringify(input)),timestamp=Date.now(),nonce=randomBytes(18).toString('base64url'),signature=sign('sha256',Buffer.from(signingPayload(method,path,timestamp,nonce,bodyHash(body))),{key:keys.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');return new Promise<{status:number;body:string}>((resolve,reject)=>{const request=httpsRequest({hostname:nic!.address,port:status.port,method,path,ca:ca.certificate,headers:{'Content-Type':'application/json','Content-Length':String(body.length),'X-Relay-Timestamp':String(timestamp),'X-Relay-Nonce':nonce,'X-Relay-Signature':signature,...(id?{'X-Relay-Device':id}:{})}},response=>{const chunks:Buffer[]=[];response.on('data',chunk=>chunks.push(Buffer.from(chunk)));response.once('end',()=>resolve({status:response.statusCode!,body:Buffer.concat(chunks).toString()}));response.once('error',reject);});request.once('error',reject);request.end(body);});}
  const paired=await tls('POST','/api/network/pair',{code:workerInvite.code,name:'Worker fixture',platform:'test',publicKey:{kty:'EC',crv:'P-256',x:jwk.x,y:jwk.y}});assert.equal(paired.status,201);assert.equal((await tls('GET','/api/probe',undefined,JSON.parse(paired.body).id)).status,401);
  // Simulate a second known endpoint with a real CA-key nonce proof. This checks selection and
  // the draft reload veto; it does not provision or claim trust for a second physical computer.
  const failoverOrigin='https://192.168.254.250:3443';
  const failoverId=await page.evaluate(async ({modulePath,url})=>{const storage=await import(modulePath),saved=await storage.loadSelectedProfile();const alternate={...saved,id:crypto.randomUUID(),name:'Office failover fixture',url,autoConnect:true};await storage.saveProfile(alternate);return alternate.id;},{modulePath:'/controller-storage.ts',url:failoverOrigin});
  await page.evaluate(()=>{(window as any).fixturePermission='granted';(window as any).runtimeReloadVeto=()=>{(window as any).failoverVetoed=true;};(window as any).runtimeReloadListener=(event:Event)=>{(window as any).runtimeReloadVeto();event.preventDefault();};window.addEventListener('relay:before-runtime-reload',(window as any).runtimeReloadListener);window.dispatchEvent(new Event('online'));});
  await page.waitForTimeout(150);
  await page.route(failoverOrigin+'/api/network/info?*',async route=>{const challenge=new URL(route.request().url()).searchParams.get('challenge')!;const hostProof=await access.certificates.hostProof(failoverOrigin,challenge);await route.fulfill({contentType:'application/json',headers:{'Access-Control-Allow-Origin':controllerOrigin},body:JSON.stringify({protocol:1,url:failoverOrigin,publicCA:ca.certificate,fingerprint:ca.fingerprint,hostProof})});});
  await page.route(status.url!+'/api/network/info?*',route=>route.abort('failed'));
  await page.evaluate(()=>window.dispatchEvent(new Event('offline')));await page.getByText('You’re offline. Your saved access and drafts are kept.',{exact:true}).waitFor();await page.evaluate(()=>window.dispatchEvent(new Event('online')));
  await page.waitForFunction(()=>(window as any).failoverVetoed===true,undefined,{timeout:20000}).catch(async error=>{
    const state=await page.evaluate(async()=>({permission:(window as any).fixturePermission,visibility:document.visibilityState,online:navigator.onLine,body:document.body.innerText.slice(0,12000)}));
    console.error('GATE_FAILOVER_DIAGNOSTIC',JSON.stringify({mode,probeTrace,state}));throw error;
  });
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('relay.controller.profile')),connection.id,'Draft veto precedes tab selection changes');assert.equal((await page.evaluate(async modulePath=>(await import(modulePath)).loadSelectedProfile(),'/controller-storage.ts')).id,connection.id);assert.equal(await page.evaluate(()=>(window as any).controllerMounts),1);
  await page.unroute(failoverOrigin+'/api/network/info?*');await page.unroute(status.url!+'/api/network/info?*');await page.evaluate(async ({modulePath,id})=>{await (await import(modulePath)).removeProfile(id);window.removeEventListener('relay:before-runtime-reload',(window as any).runtimeReloadListener);},{modulePath:'/controller-storage.ts',id:failoverId});
  // A reconnect finishing after Hosts opens must not steal the user's setup context.
  let pendingProbe:(()=>void)|undefined,probeCount=0;
  await page.route('**/api/network/info?*',async route=>{probeCount++;await new Promise<void>(resolve=>{pendingProbe=resolve;});await route.continue().catch(()=>{});});
  await page.evaluate(()=>{(window as any).fixturePermission='granted';window.dispatchEvent(new Event('offline'));});
  await page.getByText('You’re offline. Your saved access and drafts are kept.',{exact:true}).waitFor();
  await page.evaluate(()=>window.dispatchEvent(new Event('online')));
  await assert.doesNotReject(async()=>{for(let attempt=0;attempt<40&&!pendingProbe;attempt++)await page.waitForTimeout(25);assert.ok(pendingProbe,'A readonly reconnect probe starts in the workspace');});
  await page.getByRole('button',{name:'Hosts',exact:true}).click();await page.getByRole('heading',{name:'Your hosts'}).waitFor();
  pendingProbe!();await page.waitForTimeout(100);await page.getByRole('heading',{name:'Your hosts'}).waitFor();
  const probesBefore=probeCount;await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.waitForTimeout(150);assert.equal(probeCount,probesBefore,'Hosts and Add flows suspend background resume');
  await page.getByRole('button',{name:'Add a host',exact:true}).click();await page.getByRole('heading',{name:'Connect to your Relay'}).waitFor();await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.waitForTimeout(150);assert.equal(probeCount,probesBefore,'Adding a host cannot be replaced by reconnecting the active host');
  // File reads are asynchronous: a stale imported file must not replace a newer Hosts choice.
  await page.getByText('Advanced connection options',{exact:true}).click();
  const lateProfile=JSON.stringify({...profile,url:'https://192.168.254.251:3443'});
  await page.evaluate(text=>{const original=File.prototype.text;File.prototype.text=function(){return new Promise<string>(resolve=>{(window as any).releaseProfileFile=()=>{File.prototype.text=original;resolve(text);};});};},lateProfile);
  await page.getByLabel('Import public profile',{exact:true}).setInputFiles({name:'late-host.json',mimeType:'application/json',buffer:Buffer.from(lateProfile)});
  await page.waitForFunction(()=>typeof (window as any).releaseProfileFile==='function');
  await page.getByRole('button',{name:'Your hosts',exact:true}).click();await page.getByRole('heading',{name:'Your hosts'}).waitFor();
  await page.evaluate(()=>(window as any).releaseProfileFile());await page.waitForTimeout(100);await page.getByRole('heading',{name:'Your hosts'}).waitFor();
  await page.getByText('Manage My Relay',{exact:true}).click();await page.getByLabel('Reconnect automatically',{exact:true}).uncheck();
  await page.waitForFunction(async()=>{const modulePath='/controller-storage.ts';return (await (await import(modulePath)).loadSelectedProfile())?.autoConnect===false;});
  await page.getByRole('button',{name:'Back to My Relay',exact:true}).click();
  await page.evaluate(()=>{window.dispatchEvent(new Event('online'));document.dispatchEvent(new Event('visibilitychange'));});await page.waitForTimeout(150);
  assert.equal(probeCount,probesBefore,'Opting out prevents reconnect probes after online and visibility wake');
  assert.equal((await page.evaluate(async modulePath=>(await import(modulePath)).loadSelectedProfile(),'/controller-storage.ts')).autoConnect,false,'Reconnect cannot restore stale true consent');
  await page.unroute('**/api/network/info?*');await page.evaluate(()=>(window as any).fixturePermission='unknown');
  const callsBefore=protectedCalls.length;await access.disable();await page.getByRole('button',{name:'Check connection'}).click();await page.waitForFunction(()=>document.querySelector('[aria-label="Connected controller"] [role="status"]')?.textContent==='503');assert.equal(protectedCalls.length,callsBefore);await page.getByText(/Connection lost/).waitFor();
  assert.equal(await page.evaluate(()=>(window as any).controllerMounts),1);
  assert.equal((await page.evaluate(async modulePath=>(await import(modulePath)).loadSelectedProfile(),'/controller-storage.ts')).deviceId,connection.deviceId);
  const writesBefore=protectedCalls.filter(call=>call.body!==undefined).length;await page.getByRole('button',{name:'Send signed probe'}).click();await page.waitForTimeout(100);assert.equal(protectedCalls.filter(call=>call.body!==undefined).length,writesBefore);
  await access.enable({address:nic.address,port:status.port,controllerOrigins:[publicOrigin]});
  await page.getByRole('button',{name:'Reconnect',exact:true}).click();await page.waitForTimeout(100);assert.equal(protectedCalls.filter(call=>call.body!==undefined).length,writesBefore,'Failed writes are never replayed');
  access.devices.revoke(connection.deviceId);await page.getByRole('button',{name:'Check connection',exact:true}).click();await page.getByText(/Access needs attention/).first().waitFor();
  const retained=await page.evaluate(async modulePath=>(await import(modulePath)).loadSelectedProfile(),'/controller-storage.ts');assert.equal(retained.deviceId,connection.deviceId,'Auth failures retain this host key for explicit repair');
  // A second saved host and another tab's global preference cannot rewrite this tab's QR intent.
  const otherId=await page.evaluate(async modulePath=>{const storage=await import(modulePath),saved=await storage.loadSelectedProfile();const other={...saved,id:crypto.randomUUID(),name:'Office',url:'https://192.168.254.253:3443',autoConnect:false};await storage.saveProfile(other);await storage.selectProfile(other.id);return other.id;},'/controller-storage.ts');
  await page.getByRole('button',{name:'Hosts',exact:true}).click();await page.getByRole('heading',{name:'Your hosts'}).waitFor();await page.getByRole('button',{name:'Select Office',exact:true}).waitFor();
  // Reopen a new scanned host B while A is selected: no private App or code form may mount.
  const scanned={...profile,url:'https://192.168.254.252:3443'},scannedFragment=Buffer.from(JSON.stringify(scanned)).toString('base64url');
  await page.goto(controllerOrigin+'/#connect='+scannedFragment);await page.getByRole('heading',{name:'My Relay',exact:true}).waitFor();await page.getByText(scanned.url,{exact:true}).waitFor();
  assert.equal(await page.getByLabel('Sync code',{exact:true}).count(),0);assert.equal(await page.evaluate(()=>(window as any).controllerMounts),0);
  assert.equal(await page.evaluate(async modulePath=>(await import(modulePath)).listProfiles().then((items:any[])=>items.length),'/controller-storage.ts'),2);
  assert.equal((await page.evaluate(async modulePath=>(await import(modulePath)).loadSelectedProfile(),'/controller-storage.ts')).id,otherId);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 }finally{await browser?.close();await vite?.close();await access.close();store.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
});


test('pinned QR Gate pairs without installing a root certificate and carries signed chat, images and SSE through WebTransport',{skip:!liveBrowser,timeout:120000},async t=>{
 const nic=privateAddress();if(!nic){t.skip('A private IPv4 interface is required.');return;}
 const dir=await mkdtemp(join(tmpdir(),'relay-pinned-gate-')),store=new Store(dir,{deferRecovery:true}),base=new Security(3210),secrets=new Map<string,string>();
 const vault={has:async(key:string)=>secrets.has(key),get:async(key:string)=>secrets.get(key)??null,set:async(key:string,value:string)=>{secrets.set(key,value);},remove:async(key:string)=>{secrets.delete(key);},close(){},availability(){return {available:true,protection:'test'};}} as unknown as SecretVaultLike;
 const calls:{path:string;body?:unknown;cookie?:string}[]=[];let browser:Browser|undefined,vite:Awaited<ReturnType<typeof createServer>>|undefined;
 const access=new NetworkAccess(store,base,vault,{assertWritable(){},async handle(req,res,security){
  security.validate(req);const url=new URL(req.url!,'https://fixture'),session=security.bootstrap(req,res);
  if(!['GET','HEAD'].includes(req.method!))security.mutation(req);
  const body=req.method==='POST'?await jsonBody(req):undefined;calls.push({path:url.pathname,body,cookie:req.headers.cookie});
  if(url.pathname==='/api/image'){res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'no-store'});res.end(png());return;}
  if(url.pathname==='/api/events'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store'});res.write('data: first\n\n');const timer=setTimeout(()=>res.write('data: second\n\n'),50);res.once('close',()=>clearTimeout(timer));return;}
  const status=url.pathname==='/api/policy-deny'?403:200;res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(url.pathname==='/api/bootstrap'?{csrfToken:session.csrf}:{accepted:status===200,body}));
 },async workerRequest(){throw Error('Controller cannot enter worker transport');},async onRevoke(){}},{allowLoopbackTest:true,transport:true,interfaces:()=>[{name:'fixture-lan',address:nic.address,netmask:nic.netmask}]});
 try{
  const material=await access.certificates.material(nic.address),ca=access.certificates.publicCA()!;
  vite=await createServer({configFile:false,root:resolve('client'),publicDir:resolve('client/public'),define:{__RELAY_HOSTED__:'true'},esbuild:{jsx:'automatic'},logLevel:'error',server:{host:'127.0.0.1',port:0,https:{key:material.key,cert:material.cert}},plugins:[{name:'pinned-gate-fixture',resolveId(id){if(id==='/controller-gate-fixture.tsx')return '\0pinned-gate-fixture';},load(id){if(id==='\0pinned-gate-fixture')return fixtureModule;},configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=='/'){next();return;}void server.transformIndexHtml('/','<!doctype html><html><body><div id="root"></div><script type="module" src="/controller-gate-fixture.tsx"></script></body></html>').then(html=>{res.setHeader('Content-Type','text/html');res.end(html);}).catch(next);});}}]});
  await vite.listen();const address=vite.httpServer!.address();assert.ok(address&&typeof address==='object');const controllerOrigin='https://127.0.0.1:'+address.port;
  await access.enable({address:nic.address,port:0,controllerOrigins:[controllerOrigin]});
  let status=access.status();const start=Date.now();
  while(!status.transport&&Date.now()-start<10000){await new Promise(done=>setTimeout(done,25));status=access.status();}
  assert.ok(status.transport,'The pinned listener must be available; a legacy fallback cannot satisfy this test. '+String(status.transportError));
  // Only the static fixture shell receives a scoped SPKI trust override. WT has independent epoch
  // keys, and succeeds solely using its explicit leaf hash; no OS root is imported.
  const shellSpki=createHash('sha256').update(new X509Certificate(material.cert).publicKey.export({format:'der',type:'spki'})).digest('base64');
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--ignore-certificate-errors-spki-list='+shellSpki]});
  const context=await browser.newContext(),cdp=await browser.newBrowserCDPSession(),contexts=await cdp.send('Target.getBrowserContexts');
  await cdp.send('Browser.setPermission',{permission:{name:'local-network'},setting:'granted',origin:controllerOrigin,browserContextId:contexts.browserContextIds[0]});
  await context.addInitScript(()=>{(window as any).__name=(v:unknown)=>v;});const page=await context.newPage();let cloudApi=0;const errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route(controllerOrigin+'/api/**',async route=>{cloudApi++;await route.fulfill({status:599,contentType:'application/json',body:'{"error":"Private requests reached the shell server"}'});});
  const profile={url:status.url!,ca:ca.certificate,fingerprint:ca.fingerprint,transport:status.transport},fragment=Buffer.from(JSON.stringify(profile)).toString('base64url');
  await page.goto(controllerOrigin+'/#connect='+fragment);await page.getByRole('button',{name:'Check connection',exact:true}).click();await page.getByLabel('Sync code',{exact:true}).waitFor();
  assert.equal(await page.getByText('Advanced: legacy certificate setup',{exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:/Download.*certificate/}).count(),0);
  const invite=access.devices.createInvite('controller');await page.getByLabel('Sync code',{exact:true}).fill(invite.code);await page.getByRole('button',{name:'Connect securely',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[aria-label="Connected controller"] [role="status"]')?.textContent==='Connected');
  await page.getByRole('button',{name:'Send signed probe'}).click();await page.waitForFunction(()=>document.querySelector('[aria-label="Connected controller"] [role="status"]')?.textContent==='200');
  assert.deepEqual(calls.find(value=>value.body)?.body,{instruction:'Synthetic exact body'});assert.ok(calls.every(value=>!value.cookie));
  await page.getByRole('img',{name:'Signed controller image'}).evaluate((img:HTMLImageElement)=>{if(!img.complete||!img.naturalWidth)throw Error('Pinned image did not load');});
  await page.getByRole('button',{name:'Open live events'}).click();await page.waitForFunction(()=>document.querySelector('[data-testid="stream-events"]')?.textContent==='first, second');
  await page.getByRole('button',{name:'Check policy denial'}).click();await page.waitForFunction(()=>document.querySelector('[aria-label="Connected controller"] [role="status"]')?.textContent==='403');
  await page.reload();await page.waitForFunction(()=>document.querySelector('[aria-label="Connected controller"] [role="status"]')?.textContent==='Connected');
  assert.equal(cloudApi,0,'Pairing and private requests must stay in pinned LAN transport');assert.deepEqual(errors,[]);
 }finally{await browser?.close();await access.close();await vite?.close();store.close();await rm(dir,{recursive:true,force:true});}
});
