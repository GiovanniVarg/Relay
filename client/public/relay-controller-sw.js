/* Per-window public controller bridge. Private CryptoKeys remain structured clones in IndexedDB. */
const VERSION = 3, MAX_BINDINGS = 64;
const CACHE = 'relay-controller-shell-v3';
const SHELL = ['/', '/manifest.webmanifest', '/relay-icon.svg'];
const activeRequests = new Map();
let messageQueue = Promise.resolve();
function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('relay-controller', 2);
    request.onupgradeneeded = () => {
      const db = request.result, tx = request.transaction;
      if (!db.objectStoreNames.contains('connection')) db.createObjectStore('connection', { keyPath: 'id' });
      const profiles = db.createObjectStore('profiles', { keyPath: 'id' });
      const settings = db.createObjectStore('settings', { keyPath: 'id' });
      db.createObjectStore('bindings', { keyPath: 'clientId' });
      const legacy = tx.objectStore('connection').get('connection');
      legacy.onsuccess = () => { if (legacy.result) {
        const id = crypto.randomUUID();
        profiles.put({ ...legacy.result, id, name:'My Relay', autoConnect:true, legacyStorage:true });
        settings.put({ id:'selection',profileId:id }); settings.put({ id:'legacy-migration',profileId:id,version:1 });
      } };
    };
    request.onsuccess = () => { const db=request.result; db.onversionchange=()=>db.close(); resolve(db); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Controller storage is blocked.'));
  });
}
async function stored(stores, mode, operation) {
  const db = await database();
  return new Promise((resolve,reject) => {
    const tx=db.transaction(stores,mode);let result;
    tx.oncomplete=()=>{db.close();resolve(result);};
    tx.onerror=tx.onabort=()=>{db.close();reject(tx.error || new Error('Controller storage failed.'));};
    try { operation(tx,value=>{result=value;}); } catch(error) {tx.abort();db.close();reject(error);}
  });
}
const sameBinding=(a,b)=>Boolean(a && b && a.clientId===b.clientId && a.profileId===b.profileId && a.deviceId===b.deviceId && a.pairedAt===b.pairedAt && a.token===b.token);
const sameGeneration=(profile,binding)=>Boolean(profile && binding && profile.id===binding.profileId && profile.deviceId===binding.deviceId && profile.pairedAt===binding.pairedAt);
function snapshot(clientId) {
  return stored(['bindings','profiles'],'readonly',(tx,done)=>{
    const request=tx.objectStore('bindings').get(clientId);
    request.onsuccess=()=>{
      const binding=request.result;if(!binding){done(undefined);return;}
      const profile=tx.objectStore('profiles').get(binding.profileId);
      profile.onsuccess=()=>done(sameGeneration(profile.result,binding)?{binding,profile:profile.result}:undefined);
    };
  });
}
function abortRequests(clientId) {for(const controller of activeRequests.get(clientId)||[])controller.abort();}
function json(status,message,code) {return new Response(JSON.stringify({error:message,...(code?{code}:{})}),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});}
const required=()=>json(409,'Choose a saved Relay host and reconnect this window.','CONNECTION_REQUIRED');
async function notify(clientId,type,binding) {
  const client=await self.clients.get(clientId);
  if(client)client.postMessage({type,profileId:binding.profileId,deviceId:binding.deviceId,pairedAt:binding.pairedAt});
}
async function authenticatedClient(source) {
  if(!source || typeof source.id!=='string')throw new Error('A controlled window is required.');
  const client=await self.clients.get(source.id);
  if(!(await self.clients.matchAll({type:'window'})).some(item=>item.id===source.id) || !client || client.type!=='window' || new URL(client.url).origin!==self.location.origin || new URL(source.url).origin!==self.location.origin)throw new Error('A same-origin controlled window is required.');
  return client;
}
async function handleMessage(event) {
  const port=event.ports?.[0];if(!port)return;
  const message=event.data, type=typeof message?.type==='string'?message.type:'UNKNOWN';
  const reply=(ok,error)=>port.postMessage({type:type+'_ACK',version:VERSION,ok,...(error?{error}:{})});
  try {
    const client=await authenticatedClient(event.source);
    if(message.version!==VERSION)throw new Error('Controller protocol v3 is required. Reload Relay.');
    if(type==='HELLO'){reply(true);return;}
    if(type!=='BIND_PROFILE' && type!=='UNBIND_PROFILE')throw new Error('Unknown controller message.');
    const live=new Set((await self.clients.matchAll({type:'window'})).map(item=>item.id));
    await stored(['bindings','profiles'],'readwrite',(tx,done)=>{
      const store=tx.objectStore('bindings'), rows=store.getAll();
      rows.onsuccess=()=>{
        const retained=rows.result.filter(row=>live.has(row.clientId));
        for(const row of rows.result)if(!live.has(row.clientId))store.delete(row.clientId);
        if(type==='UNBIND_PROFILE'){store.delete(client.id);done(undefined);return;}
        if(typeof message.profileId!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(message.profileId)) {tx.abort();return;}
        if(!retained.some(row=>row.clientId===client.id) && retained.length>=MAX_BINDINGS){tx.abort();return;}
        const profile=tx.objectStore('profiles').get(message.profileId);
        profile.onsuccess=()=>{
          if(!sameGeneration(profile.result,{profileId:message.profileId,deviceId:message.deviceId,pairedAt:message.pairedAt})){tx.abort();return;}
          store.put({clientId:client.id,profileId:message.profileId,deviceId:message.deviceId,pairedAt:message.pairedAt,token:crypto.randomUUID()});done(undefined);
        };
      };
    });
    abortRequests(client.id);reply(true);
  } catch {reply(false,'Controller binding could not be changed. Choose a saved host and reload Relay.');}
}
self.addEventListener('message',event=>{
  // Serialize binding changes, including the bounded-capacity check.
  const work=messageQueue.then(()=>handleMessage(event));messageQueue=work.catch(()=>{});event.waitUntil(work);
});
function privateOrigin(value) {
  if(typeof value!=='string' || !/^https:\/\/(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?$/.test(value))throw new Error('Invalid controller address.');
  const url=new URL(value),parts=url.hostname.split('.').map(Number);
  if(parts.some((part,index)=>part>255 || String(part)!==value.match(/https:\/\/([^:]+)/)[1].split('.')[index]) || !(parts[0]===10 || (parts[0]===172 && parts[1]>=16 && parts[1]<=31) || (parts[0]===192 && parts[1]===168)))throw new Error('Invalid private address.');
  return url.origin;
}
async function bindingStillCurrent(binding) {const saved=await snapshot(binding.clientId);return sameBinding(saved?.binding,binding);}
async function clearMatchingBinding(binding) {
  return stored(['bindings'],'readwrite',(tx,done)=>{
    const store=tx.objectStore('bindings'),request=store.get(binding.clientId);
    request.onsuccess=()=>{const matches=sameBinding(request.result,binding);if(matches)store.delete(binding.clientId);done(matches);};
  });
}
async function boundedRequestBody(request) {
  const reader=request.clone().body?.getReader();if(!reader)return new ArrayBuffer(0);
  const chunks=[];let length=0;
  try {for(;;){const next=await reader.read();if(next.done)break;length+=next.value.length;if(length>8*1024*1024)throw new Error('Controller upload exceeds limit.');chunks.push(next.value);}}
  catch(error){await reader.cancel().catch(()=>{});throw error;}
  const body=new Uint8Array(length);let at=0;for(const chunk of chunks){body.set(chunk,at);at+=chunk.length;}return body.buffer;
}
async function transportFetch(saved,request,signal) {
  const client=await self.clients.get(saved.binding.clientId);
  if(!client || client.type!=='window' || new URL(client.url).origin!==self.location.origin || !await bindingStillCurrent(saved.binding))throw new Error('Controller owner unavailable.');
  const channel=new MessageChannel();let ended=false,closed=false,headersSeen=false,pendingPull,pendingReject,timer,resolveHeaders,rejectHeaders;
  const headersReady=new Promise((resolve,reject)=>{resolveHeaders=resolve;rejectHeaders=reject;});
  function reset(ms){clearTimeout(timer);timer=setTimeout(()=>failure(new Error('Controller owner did not respond.')),ms);}
  function cleanup(){if(closed)return;closed=true;clearTimeout(timer);signal.removeEventListener('abort',abort);channel.port1.close();}
  function failure(error){if(closed)return;channel.port1.postMessage({type:'ABORT'});rejectHeaders(error);pendingReject?.(error);cleanup();}
  const abort=()=>failure(new Error('Controller request cancelled.'));
  channel.port1.onmessage=event=>{
    const message=event.data;
    if(!message || typeof message!=='object'){failure(new Error('Invalid controller frame.'));return;}
    if(message.type==='ERROR'){failure(new Error('Encrypted request ended with an unknown outcome.'));return;}
    if(message.type==='HEADERS'){
      if(headersSeen || !Number.isInteger(message.status) || message.status<200 || message.status>599 || !message.headers || typeof message.headers!=='object' || Array.isArray(message.headers)){failure(new Error('Invalid controller headers.'));return;}
      const entries=Object.entries(message.headers),allow=new Set(['cache-control','x-content-type-options','content-security-policy','referrer-policy','content-type','content-disposition','content-range','accept-ranges','etag','last-modified','retry-after']);
      if(entries.some(([name,value])=>!allow.has(name) || typeof value!=='string' || value.length>8192 || /[\r\n\u0000]/.test(value)) || new TextEncoder().encode(JSON.stringify(message.headers)).length>16384){failure(new Error('Invalid controller headers.'));return;}
      headersSeen=true;clearTimeout(timer);resolveHeaders({status:message.status,headers:new Headers(message.headers)});return;
    }
    if(message.type==='END'){
      if(!headersSeen){failure(new Error('Response ended before headers.'));return;}
      ended=true;pendingPull?.({done:true});pendingPull=pendingReject=undefined;cleanup();return;
    }
    if(message.type==='CHUNK'){
      if(!headersSeen || !pendingPull || !(message.body instanceof ArrayBuffer) || message.body.byteLength>65536 || !message.body.byteLength){failure(new Error('Invalid controller body frame.'));return;}
      clearTimeout(timer);const resolve=pendingPull;pendingPull=pendingReject=undefined;resolve({done:false,value:new Uint8Array(message.body)});return;
    }
    failure(new Error('Unknown controller frame.'));
  };
  channel.port1.start();signal.addEventListener('abort',abort,{once:true});reset(30000);
  if(signal.aborted){abort();return headersReady;}
  client.postMessage({type:'WT_REQUEST',version:VERSION,binding:saved.binding,request},[channel.port2,request.body]);
  const metadata=await headersReady;
  if(request.method==='HEAD' || [204,205,304].includes(metadata.status)){channel.port1.postMessage({type:'ABORT'});cleanup();return new Response(null,metadata);}
  const body=new ReadableStream({
    async pull(output){
      try {
        if(ended){output.close();return;}if(closed)throw new Error('Controller response ended.');
        if(!await bindingStillCurrent(saved.binding))throw new Error('Controller binding changed.');
        const next=await new Promise((resolve,reject)=>{pendingPull=resolve;pendingReject=reject;reset(120000);channel.port1.postMessage({type:'PULL'});});
        if(!await bindingStillCurrent(saved.binding))throw new Error('Controller binding changed.');
        next.done?output.close():output.enqueue(next.value);
      } catch(error){failure(error);output.error(error);}
    },
    cancel(){channel.port1.postMessage({type:'ABORT'});cleanup();},
  },{highWaterMark:0});
  return new Response(body,metadata);
}
async function signedFetch(request,clientId) {
  let saved,controller,abortListener,requests;
  try {
    if(!clientId)return required();
    saved=await snapshot(clientId);if(!saved)return required();
    controller=new AbortController();requests=activeRequests.get(clientId)||new Set();activeRequests.set(clientId,requests);requests.add(controller);
    abortListener=()=>controller.abort();request.signal.addEventListener('abort',abortListener,{once:true});if(request.signal.aborted)controller.abort();
    const original=new URL(request.url),path=original.pathname+original.search,target=new URL(path,privateOrigin(saved.profile.url));
    const body=['GET','HEAD'].includes(request.method)?new ArrayBuffer(0):await boundedRequestBody(request);
    const digest=await crypto.subtle.digest('SHA-256',body),bodyHash=[...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
    const timestamp=String(Date.now()),nonce=crypto.randomUUID();
    const payload=JSON.stringify(['relay-device-v1',request.method.toUpperCase(),path,timestamp,nonce,bodyHash]);
    const signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},saved.profile.privateKey,new TextEncoder().encode(payload));
    if(signature.byteLength!==64)throw new Error('Unsupported signature format.');
    const encoded=btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    const headers=new Headers();
    for(const name of ['Content-Type','Accept','X-CSRF-Token','Last-Event-ID']){const value=request.headers.get(name);if(value!==null)headers.set(name,value);}
    headers.set('X-Relay-Device',saved.profile.deviceId);headers.set('X-Relay-Timestamp',timestamp);headers.set('X-Relay-Nonce',nonce);headers.set('X-Relay-Signature',encoded);
    if(controller.signal.aborted || !await bindingStillCurrent(saved.binding)){cleanup();return required();}
    const response=saved.profile.transport
      ? await transportFetch(saved,{method:request.method,path,headers:Object.fromEntries(headers),body},controller.signal)
      : await fetch(target,{method:request.method,headers,...(body.byteLength || !['GET','HEAD'].includes(request.method)?{body}:{}),credentials:'omit',redirect:'error',mode:'cors',cache:'no-store',signal:controller.signal});
    if(controller.signal.aborted || !await bindingStillCurrent(saved.binding)){controller.abort();cleanup();return required();}
    if(response.status===401){
      const auth=messageQueue.then(async()=>{if(await clearMatchingBinding(saved.binding))await notify(clientId,'AUTH_REQUIRED',saved.binding);});
      messageQueue=auth.catch(()=>{});await auth;
    }
    const returned=new Headers({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    for(const name of ['Content-Security-Policy','Referrer-Policy','Content-Type','Content-Disposition','Content-Range','Accept-Ranges','ETag','Last-Modified','Retry-After']){const value=response.headers.get(name);if(value!==null)returned.set(name,value);}
    // Retain the abort controller until an SSE/image/stream body finishes, not merely until headers arrive.
    const reader=response.body?.getReader();
    if(!reader){cleanup();return new Response(null,{status:response.status,statusText:response.statusText,headers:returned});}
    const stream=new ReadableStream({async pull(output){try{if(controller.signal.aborted || !await bindingStillCurrent(saved.binding))throw new Error('Controller binding changed.');const chunk=await reader.read();if(controller.signal.aborted || !await bindingStillCurrent(saved.binding))throw new Error('Controller binding changed.');if(chunk.done){cleanup();output.close();}else output.enqueue(chunk.value);}catch(error){cleanup();output.error(error);}},async cancel(reason){controller.abort();cleanup();await reader.cancel(reason);}});
    return new Response(stream,{status:response.status,statusText:response.statusText,headers:returned});
  } catch {
    cleanup();
    if(controller?.signal.aborted)return required();
    if(saved){const notice=messageQueue.then(async()=>{if(await bindingStillCurrent(saved.binding).catch(()=>false))await notify(clientId,'NETWORK_UNREACHABLE',saved.binding);});messageQueue=notice.catch(()=>{});await notice.catch(()=>{});}
    return json(503,'Could not reach your Relay host securely. Check the same local network, computer power and Local Network permission. The last request may have reached the host; inspect its result before retrying. Requests are not replayed automatically.');
  }
  function cleanup(){if(controller)requests?.delete(controller);if(requests?.size===0)activeRequests.delete(clientId);if(abortListener)request.signal.removeEventListener('abort',abortListener);}
}
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map(async path => { try { const response = await fetch(path, { cache: 'reload', credentials: 'omit', redirect: 'error' }); if (response.ok && !/private|no-store/i.test(response.headers.get('Cache-Control') || '')) await cache.put(path, response); } catch {} }));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => { for (const key of await caches.keys()) if (key.startsWith('relay-controller-shell-') && key !== CACHE) await caches.delete(key); await self.clients.claim(); })());
});
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Initial LAN-hosted pairing must reach the two public HTTPS endpoints before a key exists.
  if((url.pathname==='/api/network/info'&&request.method==='GET')||(url.pathname==='/api/network/pair'&&request.method==='POST')) {
    // Explicit legacy LAN hosting only. Public-shell API calls must never fall through to cloud.
    try { if(privateOrigin(self.location.origin)===self.location.origin)return; } catch {}
    event.respondWith(Promise.resolve(json(409,'Connect directly using the Relay QR profile.','CONNECTION_REQUIRED'))); return;
  }
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) { event.respondWith(signedFetch(request, event.clientId)); return; }
  const safe = request.method === 'GET' && !url.search && !request.headers.has('Authorization')
    && (SHELL.includes(url.pathname) || /^\/assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(?:js|css|woff2|svg|png|webp)$/.test(url.pathname));
  if (!safe && !(request.mode === 'navigate' && request.method === 'GET')) return;
  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (safe && response.ok && response.type === 'basic' && !/private|no-store/i.test(response.headers.get('Cache-Control') || '')) { const cache = await caches.open(CACHE); await cache.put(request, response.clone()); }
      return response;
    } catch {
      const cached = await caches.match(safe ? request : '/');
      return cached || new Response('Relay is offline. Reconnect to load the controller.', { status: 503, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
    }
  })());
});
