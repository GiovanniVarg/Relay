import assert from 'node:assert/strict';
import {request as httpsRequest,type Server as HttpsServer} from 'node:https';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {NetworkAccess} from '../server/network-access.js';
import {Security} from '../server/security.js';
import {Store} from '../server/store.js';

test('listener error shutdown is serialized with enable and stale listener errors cannot close the new host',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-qr-stop-')),store=new Store(dir),values=new Map<string,string>();let writableCalls=0;
 let release!:()=>void,entered!:()=>void;const blocked=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
 const vault={async has(name:string){return values.has(name);},async get(name:string){return values.get(name)??null;},async set(name:string,value:string){values.set(name,value);},async remove(name:string){values.delete(name);},close(){},availability(){return{available:true,protection:'test'};}};
 const access=new NetworkAccess(store,new Security(3210),vault,{assertWritable(){writableCalls++;},async onRevoke(){},async workerRequest(_device,_req,res){res.end();},async handle(_req,res){res.writeHead(404);res.end();}},
  {allowLoopbackTest:true,transport:false,interfaces:()=>[{name:'test-loopback',address:'127.0.0.1',netmask:'255.0.0.0'}]});
 let enabling:Promise<ReturnType<NetworkAccess['status']>>|undefined;
 try{
  await access.enable({address:'127.0.0.1',port:0});
  const internal=access as unknown as{server:HttpsServer;transport:unknown},oldServer=internal.server;
  internal.transport={async close(){entered();await blocked;}};
  oldServer.emit('error',new Error('simulated owned listener failure'));await started;
  let completed=false;enabling=access.enable({address:'127.0.0.1',port:0});void enabling.then(()=>{completed=true;},()=>{completed=true;});
  // A complete event-loop turn drains the enable queue. Before the fix its writable hook
  // runs even though old shutdown is blocked; after the fix it cannot enter that operation.
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(writableCalls,1,'Enable entered while prior listener shutdown was still running');assert.equal(completed,false);
  release();const current=await enabling;assert.equal(current.listening,true);assert.notEqual(internal.server,oldServer);
  const read=()=>new Promise<{status:number;body:string}>((resolve,reject)=>{
   const req=httpsRequest({hostname:'127.0.0.1',port:current.port,path:'/api/network/info',ca:access.certificates.publicCA()!.certificate,agent:false},res=>{
    const parts:Buffer[]=[];res.on('data',part=>parts.push(Buffer.from(part)));res.once('error',reject);res.once('end',()=>resolve({status:res.statusCode!,body:Buffer.concat(parts).toString()}));
   });req.once('error',reject);req.end();
  });
  const first=await read();assert.equal(first.status,200);assert.equal(JSON.parse(first.body).url,current.url);
  oldServer.emit('error',new Error('late error from retired listener'));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(access.status().listening,true);assert.equal((await read()).status,200);
 }finally{release?.();await enabling?.catch(()=>{});await access.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
