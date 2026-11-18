import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openCodeProfile,openCodeEnvironment,openCodeCatalog} from '../server/providers/opencode.js';
import {GuardedProviderAdapter} from '../server/providers/lifecycle.js';
import type {ProviderAdapter,ProviderRequest,ProviderConnection} from '../shared/types.js';
async function fixture(){const dir=await mkdtemp(join(tmpdir(),'relay-opencode-profile-')),home=join(dir,'opencode','home'),config=join(home,'.config','opencode'),data=join(home,'.local','share','opencode');await mkdir(config,{recursive:true});await mkdir(data,{recursive:true});return{dir,home,config,data,close:()=>rm(dir,{recursive:true,force:true})};}
test('private environment normalizes Windows keys and excludes credential/config injection',()=>{
 const home=join(tmpdir(),'private-profile-fixture'),env=openCodeEnvironment(home,{PROGRAMDATA:'global',ProgramData:'other',userprofile:'personal',PATH:'safe',OPENAI_API_KEY:'secret',OPENCODE_CONFIG_CONTENT:'bad',NODE_OPTIONS:'bad'});
 assert.equal(env.PROGRAMDATA,join(home,'ProgramData'));assert.equal(Object.keys(env).filter(key=>key.toLowerCase()==='programdata').length,1);assert.equal(Object.keys(env).filter(key=>key.toLowerCase()==='userprofile').length,1);assert.equal(env.OPENAI_API_KEY,undefined);assert.equal(env.NODE_OPTIONS,undefined);assert.equal(env.OPENCODE_FLAGS,'-schedules');
});
test('native credential scope ignores session writes but binds credential and legacy migration bytes without exposing them',async()=>{
 const f=await fixture();const db=new DatabaseSync(join(f.data,'opencode.db'));try{db.exec('CREATE TABLE credential(id TEXT,integration_id TEXT,label TEXT,value TEXT,active INTEGER);CREATE TABLE session(id TEXT);CREATE TABLE kv(key TEXT,value TEXT)');db.prepare('INSERT INTO credential VALUES(?,?,?,?,?)').run('credential-1','openai','Test account',JSON.stringify({type:'key',key:'synthetic-private-key'}),1);
 const before=await openCodeProfile(f.dir);db.prepare('INSERT INTO session VALUES(?)').run('s1');assert.equal((await openCodeProfile(f.dir)).scope,before.scope);db.prepare('UPDATE credential SET value=?').run(JSON.stringify({type:'key',key:'synthetic-private-key-2'}));const after=await openCodeProfile(f.dir);assert.notEqual(after.scope,before.scope);assert.equal(JSON.stringify(after).includes('synthetic-private-key'),false);
 await writeFile(join(f.data,'auth.json'),JSON.stringify({opencode:{type:'api',key:'synthetic-console'}}));await assert.rejects(openCodeProfile(f.dir),/legacy credentials|unsupported/);
 }finally{db.close();await f.close();}
});
test('scope capture rejects alternate layers, executable packages, wildcard providers and remote config authority',async()=>{
 for(const config of [{policies:[]},{provider:{'*':{}}},{provider:{x:{npm:'file:///unsafe.js'}}},{providers:{x:{package:'@ai-sdk/openai-compatible'}}},{provider:{x:{options:{apiKey:'{env:PRIVATE_KEY}'}}}}]){
  const f=await fixture();try{await writeFile(join(f.config,'opencode.json'),JSON.stringify(config));await assert.rejects(openCodeProfile(f.dir),/host-owned|wildcard|concrete|package|unsupported/);}finally{await f.close();}
 }
 const f=await fixture();try{await writeFile(join(f.config,'opencode.jsonc'),'{}');await assert.rejects(openCodeProfile(f.dir),/JSONC/);}finally{await f.close();}
 const g=await fixture();const db=new DatabaseSync(join(g.data,'opencode.db'));try{db.exec('CREATE TABLE kv(key TEXT,value TEXT)');db.prepare('INSERT INTO kv VALUES(?,?)').run('wellknown:sources','["https://synthetic.invalid"]');await assert.rejects(openCodeProfile(g.dir),/remote configuration/);}finally{db.close();await g.close();}
 const h=await fixture();try{await writeFile(join(h.config,'AGENTS.md'),'Synthetic unbound native instructions');await assert.rejects(openCodeProfile(h.dir),/supplementary instruction/);}finally{await h.close();}
 const i=await fixture();const empty=new DatabaseSync(join(i.data,'opencode.db'));try{await writeFile(join(i.data,'auth.json'),JSON.stringify({'opencode/':{type:'api',key:'synthetic-console-alias'}}));await assert.rejects(openCodeProfile(i.dir),/legacy credentials/);}finally{empty.close();await i.close();}
});
test('local billing respects model endpoints and exact IDs before variant aliases regardless of insertion order',async()=>{
 const f=await fixture();
 try{
  const models={'foo/bar':{settings:{baseURL:'https://synthetic.invalid/v1'}},foo:{variants:[{id:'bar',settings:{baseURL:'http://127.0.0.1:1/v1'}}]}};
  await writeFile(join(f.config,'opencode.json'),JSON.stringify({providers:{local:{settings:{baseURL:'http://127.0.0.1:1/v1'},models}}}));
  const p=await openCodeProfile(f.dir),rows=openCodeCatalog({configOptions:[{id:'model',options:['local/foo/bar','local/foo#bar','local/foo#unknown'].map(value=>({value,name:value}))}]},p.providers);
  assert.equal(rows[0].local,false);assert.equal(rows[1].local,true);assert.equal(rows[2].local,false);
 }finally{await f.close();}
});
test('guard verification caches require response identity and the exact OpenCode connection scope',async()=>{
 let scope='a'.repeat(64);const connection=():ProviderConnection=>({id:'opencode',installed:true,authenticated:true,authMode:'managed',accountLabel:'OpenCode managed profile',plan:'',connectionScope:scope,models:[{id:'local/probe',name:'Probe',verified:false}]});
 const direct:ProviderAdapter={id:'opencode',inspect:async()=>connection(),login:async()=>({message:'fixture'}),stream:async()=>({text:'fixture'}),close:async()=>{}},guard=new GuardedProviderAdapter('unused-fixture-directory',direct);
 const request:ProviderRequest={runId:'r',conversationId:'c',model:'local/probe',instructions:'fixture',history:[{role:'user',content:'fixture'}],maxSeconds:1,expectedAccount:{accountLabel:'OpenCode managed profile',plan:''},expectedConnectionScope:scope};
 (guard as any).run=async()=>({text:'fixture'});await guard.stream(request,()=>{},new AbortController().signal);assert.equal((await guard.inspect()).models[0].verified,false);
 (guard as any).run=async()=>({text:'fixture',actualModel:request.model});await guard.stream(request,()=>{},new AbortController().signal);assert.equal((await guard.inspect()).models[0].verified,true);scope='b'.repeat(64);assert.equal((await guard.inspect()).models[0].verified,false);await guard.close();
});
