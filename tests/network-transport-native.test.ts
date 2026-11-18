import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes,sign,type KeyObject} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {chromium,type Browser} from 'playwright';
import {NetworkAccess} from '../server/network-access.js';
import {bodyHash,signingPayload} from '../server/network-auth.js';
import {Security,jsonBody} from '../server/security.js';
import {Store} from '../server/store.js';

function keypair(){const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),key=pair.publicKey.export({format:'jwk'});return{privateKey:pair.privateKey,publicKey:{kty:'EC',crv:'P-256',x:key.x!,y:key.y!}};}
function proof(key:KeyObject,method:string,path:string,body:Buffer,id?:string){const timestamp=Date.now(),nonce=randomBytes(18).toString('base64url');return{'x-relay-timestamp':String(timestamp),'x-relay-nonce':nonce,'x-relay-signature':sign('sha256',Buffer.from(signingPayload(method,path,timestamp,nonce,bodyHash(body))),{key,dsaEncoding:'ieee-p1363'}).toString('base64url'),...(id?{'x-relay-device':id}:{})};}

test('real Chrome QR transport preserves LAN pairing, signed auth, replay/role checks, binary/SSE and revocation',{timeout:90000,skip:process.env.RELAY_BROWSER_LIVE!=='1'},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-qr-native-')),store=new Store(dir),values=new Map<string,string>();let browser:Browser|undefined,mutation=0;
 const vault={async has(name:string){return values.has(name);},async get(name:string){return values.get(name)??null;},async set(name:string,value:string){values.set(name,value);},async remove(name:string){values.delete(name);},close(){},availability(){return{available:true,protection:'test'};}};
 let access!:NetworkAccess;
 access=new NetworkAccess(store,new Security(3210),vault,{
  assertWritable(){},async onRevoke(){},async workerRequest(_device,_req,res){res.end('{}');},
  async handle(req,res,security){security.validate(req);const url=new URL(req.url!,'http://fixture');
   if(url.pathname==='/bootstrap'){const session=security.bootstrap(req,res);res.setHeader('content-type','application/json');res.end(JSON.stringify({csrf:session.csrf}));return;}
   security.session(req);if(!['GET','HEAD'].includes(req.method!))security.mutation(req);if(await access.manage(req,res,url))return;
   if(url.pathname==='/api/events'){res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: connected\n\n');return;}
   if(url.pathname==='/api/binary'){res.setHeader('content-type','application/octet-stream');res.end(Buffer.from([0,255,42]));return;}
   if(url.pathname==='/api/mutate'){await jsonBody(req);mutation++;}res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true}));
  },
 },{allowLoopbackTest:true,transport:true,interfaces:()=>[{name:'test-loopback',address:'127.0.0.1',netmask:'255.0.0.0'}]});
 try{
  const status=await access.enable({address:'127.0.0.1',port:0});const until=Date.now()+45000;
  while(!access.status().transport){if(Date.now()>until)throw Error('QR startup: '+access.status().transportError);await new Promise(resolve=>setTimeout(resolve,50));}
  const profile=access.status().transport!;browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage();
  await page.addInitScript(()=>{(window as any).__name=(value:unknown)=>value;});await page.route(status.url!+'/fixture',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Relay native transport fixture</title>'}));await page.goto(status.url!+'/fixture');
  await page.evaluate(async p=>{
   const context=window as any,wt=new(window as any).WebTransport(p.endpoint,{allowPooling:false,serverCertificateHashes:[{algorithm:'sha-256',value:Uint8Array.from(p.pin.match(/../g)!,x=>parseInt(x,16))}]});wt.closed.catch(()=>{});await wt.ready;context.testTransport=wt;
   context.wire=async(input:any,events=false)=>{const stream=await wt.createBidirectionalStream(),writer=stream.writable.getWriter();writer.closed.catch(()=>{});const body=Uint8Array.from(atob(input.body),x=>x.charCodeAt(0));const metadata=new TextEncoder().encode(JSON.stringify({version:1,method:input.method,path:input.path,headers:input.headers,bodyLength:body.length}));const prefix=new Uint8Array(4);new DataView(prefix.buffer).setUint32(0,metadata.length);await writer.write(prefix);await writer.write(metadata);if(body.length)await writer.write(body);await writer.close();
    const reader=stream.readable.getReader();let pending=new Uint8Array(0);const exact=async(size:number)=>{const out=new Uint8Array(size);let at=0;while(at<size){if(!pending.length){const next=await reader.read();if(next.done)throw Error('truncated response');pending=next.value;}const take=Math.min(size-at,pending.length);out.set(pending.subarray(0,take),at);at+=take;pending=pending.subarray(take);}return out;};
    const head=new DataView((await exact(4)).buffer).getUint32(0);if(head>16384)throw Error('oversized response');const response=JSON.parse(new TextDecoder().decode(await exact(head)));
    if(events){let text=new TextDecoder().decode(pending);if(!text)text=new TextDecoder().decode((await reader.read()).value);context.eventReader=reader;return{status:response.status,text};}
    const chunks:Uint8Array[]=[];if(pending.length)chunks.push(pending);for(;;){const next=await reader.read();if(next.done)break;chunks.push(next.value);if(chunks.reduce((sum,value)=>sum+value.length,0)>1048576)throw Error('unexpected response size');}
    const bytes=new Uint8Array(chunks.reduce((sum,value)=>sum+value.length,0));let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}return{status:response.status,body:btoa(String.fromCharCode(...bytes)),text:new TextDecoder().decode(bytes),headers:response.headers};
   };
  },profile);
  const call=async(method:string,path:string,body:Buffer=Buffer.alloc(0),headers:Record<string,string>={},events=false)=>page.evaluate(async({input,events})=>(window as any).wire(input,events),{input:{method,path,body:body.toString('base64'),headers},events}) as Promise<{status:number;text:string;body:string;headers:Record<string,string>}>;
  const info=await call('GET','/api/network/info?challenge='+randomBytes(32).toString('base64url'));assert.equal(info.status,200);assert.ok(JSON.parse(info.text).transportCatalog);
  assert.equal((await call('GET','/bootstrap')).status,401);
  const pair=async(role:'controller'|'worker')=>{const key=keypair(),invite=access.devices.createInvite(role),body=Buffer.from(JSON.stringify({code:invite.code,name:'QR test',platform:'Chrome',publicKey:key.publicKey}));const response=await call('POST','/api/network/pair',body,{'content-type':'application/json',...proof(key.privateKey,'POST','/api/network/pair',body)});assert.equal(response.status,201,response.text);return{key,id:JSON.parse(response.text).id as string};};
  const controller=await pair('controller'),worker=await pair('worker'),empty=Buffer.alloc(0);
  const bootstrap=await call('GET','/bootstrap',empty,proof(controller.key.privateKey,'GET','/bootstrap',empty,controller.id));assert.equal(bootstrap.status,200);const csrf=JSON.parse(bootstrap.text).csrf;
  const replay=proof(controller.key.privateKey,'GET','/api/health',empty,controller.id);assert.equal((await call('GET','/api/health',empty,replay)).status,200);assert.equal((await call('GET','/api/health',empty,replay)).status,401);
  assert.equal((await call('GET','/api/health',empty,proof(worker.key.privateKey,'GET','/api/health',empty,worker.id))).status,401);
  const body=Buffer.from('{"edit":"yes"}'),changed=Buffer.from('{"edit":"bad"}'),path='/api/mutate';
  assert.equal((await call('POST',path,changed,{'content-type':'application/json','x-csrf-token':csrf,...proof(controller.key.privateKey,'POST',path,body,controller.id)})).status,401);assert.equal(mutation,0);
  assert.equal((await call('POST',path,body,{'content-type':'application/json','x-csrf-token':csrf,...proof(controller.key.privateKey,'POST',path,body,controller.id)})).status,200);assert.equal(mutation,1);
  const binary=await call('GET','/api/binary',empty,proof(controller.key.privateKey,'GET','/api/binary',empty,controller.id));assert.deepEqual(Buffer.from(binary.body,'base64'),Buffer.from([0,255,42]));assert.equal(binary.headers['set-cookie'],undefined);
  const event=await call('GET','/api/events',empty,proof(controller.key.privateKey,'GET','/api/events',empty,controller.id),true);assert.equal(event.status,200);assert.match(event.text,/connected/);
  const revoke='/api/network/devices/'+controller.id;assert.equal((await call('DELETE',revoke,empty,{'x-csrf-token':csrf,...proof(controller.key.privateKey,'DELETE',revoke,empty,controller.id)})).status,200);
  const stopped=await page.evaluate(async()=>{try{const result=await(window as any).eventReader.read();return result.done?'closed':'data';}catch{return'aborted';}});assert.ok(['closed','aborted'].includes(stopped));
  assert.equal((await call('GET','/api/health',empty,proof(controller.key.privateKey,'GET','/api/health',empty,controller.id))).status,401);
  await page.evaluate(()=>{(window as any).testTransport.close();});
 }finally{await browser?.close();await access.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
