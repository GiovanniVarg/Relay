import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {Store} from '../server/store.js';
import {NetworkCertificates} from '../server/network-certificates.js';
import {NetworkTransportCertificates} from '../server/network-transport-certificates.js';

test('clearing transport generation cancels both blocked and queued material loads without publishing keys',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-qr-cancel-')),store=new Store(dir),values=new Map<string,string>();
 let release!:()=>void,entered!:()=>void,hold=false;const wait=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
 const vault={async get(name:string){if(hold&&name==='network-transport-manifest'){entered();await wait;}return values.get(name)??null;},async set(name:string,value:string){values.set(name,value);},async remove(name:string){values.delete(name);}};
 try{
  const roots=new NetworkCertificates(store,vault);await roots.material('192.168.1.30');const manager=new NetworkTransportCertificates(vault,roots);
  hold=true;const first=manager.material('https://192.168.1.30:3443/relay');const second=manager.material('https://192.168.1.30:3443/relay');
  const settled=Promise.allSettled([first,second]);await started;manager.clear();release();const result=await settled;
  assert.deepEqual(result.map(item=>item.status),['rejected','rejected']);assert.equal(manager.current(),undefined);assert.equal(values.has('network-transport-manifest'),false);
  assert.equal([...values.keys()].some(name=>name.startsWith('network-transport-epoch-')),false);
  for(const endpoint of ['https://8.8.8.8:3443/relay','https://127.0.0.1:3443/relay','http://192.168.1.30:3443/relay','https://192.168.1.30:3443/relay?new=1'])await assert.rejects(manager.material(endpoint));
 }finally{release?.();store.close();rmSync(dir,{recursive:true,force:true});}
});
