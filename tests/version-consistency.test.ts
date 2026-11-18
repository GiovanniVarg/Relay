import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server/index.js';
import {PROVIDER_IDS} from '../server/store.js';
import {dataDirectoryId} from '../server/supervisor.js';
import {SyntheticVault} from './synthetic-vault.js';
import type {ProviderId,ProviderAdapter} from '../shared/types.js';

test('package and lock release version agree with actual temporary HTTP health and bootstrap',async()=>{
 const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
 const lock=JSON.parse(await readFile(new URL('../package-lock.json',import.meta.url),'utf8'));
 assert.equal(pkg.version,'0.10.1');assert.equal(lock.version,pkg.version);assert.equal(lock.packages[''].version,pkg.version);
 const root=await mkdtemp(join(tmpdir(),'relay-release-version-')),dataDir=join(root,'data'),vault=new SyntheticVault();let inspections=0;
 const adapters=Object.fromEntries(PROVIDER_IDS.map(id=>[id,{id,inspect:async()=>{inspections++;return{id,installed:false,authenticated:false,authMode:'unknown',accountLabel:'',plan:'',models:[]};},login:async()=>{throw Error('No account access');},stream:async()=>{throw Error('No inference');},close:async()=>{}}])) as unknown as Record<ProviderId,ProviderAdapter>;
 const app=createApp({dataDir,port:0,secretVault:vault,adapters,typesafeOptions:{fetch:async()=>{throw Error('No external service access');}}});
 try{
  const base='http://127.0.0.1:'+await app.listen(0);await app.runs.refresh();
  const response=await fetch(base+'/api/health');assert.equal(response.status,200);
  const health=await response.json();assert.equal(health.ok,true);assert.equal(health.version,pkg.version);assert.equal(health.pid,process.pid);assert.equal(health.dataDirectoryId,dataDirectoryId(dataDir));
  const bootstrap=await fetch(base+'/api/bootstrap');assert.equal(bootstrap.status,200);const boot=await bootstrap.json();assert.equal(boot.version,pkg.version);assert.ok(bootstrap.headers.get('set-cookie'));
  assert.deepEqual(boot.providers.map((provider:{id:string})=>provider.id),PROVIDER_IDS);
  assert.equal(vault.values.size,0);assert.equal(inspections,PROVIDER_IDS.length,'refresh must inspect only the synthetic adapters');
 }finally{await app.close();await rm(root,{recursive:true,force:true,maxRetries:5});}
});
