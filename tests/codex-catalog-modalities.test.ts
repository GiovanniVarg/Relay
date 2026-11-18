import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CodexAdapter,CODEX_DISABLED_FEATURES} from '../server/providers/codex.js';
import {JsonLines,type Launcher} from '../server/providers/process.js';

test('Codex discovery retains valid advertised modalities, discards malformed evidence, and never runs inference',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'relay-catalog-modalities-')),methods:string[]=[];
 const launcher:Launcher=()=>{
  const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),pid:987654,exitCode:null as number|null,signalCode:null as NodeJS.Signals|null,kill:()=>{end();return true;}});
  let ended=false;function end(){if(ended)return;ended=true;child.exitCode=0;child.emit('close',0,null);}
  const send=(id:unknown,result:unknown)=>child.stdout.write(JSON.stringify({id,result})+'\n');
  const parser=new JsonLines(message=>{if(message.id===undefined)return;methods.push(message.method);queueMicrotask(()=>{
   if(message.method==='initialize')send(message.id,{});
   else if(message.method==='config/read')send(message.id,{config:{forced_login_method:'chatgpt',approval_policy:'never',sandbox_mode:'read-only',web_search:'disabled',features:Object.fromEntries(CODEX_DISABLED_FEATURES.map(name=>[name,false])),mcp_servers:{}}});
   else if(message.method==='account/read')send(message.id,{account:{type:'chatgpt',email:'fixture@example.test',planType:'fixture'}});
   else if(message.method==='model/list')send(message.id,{data:[{model:'vision',inputModalities:['text','image']},{model:'text',inputModalities:['text']},{model:'missing'},{model:'malformed',inputModalities:['image','video']},{model:'hidden',hidden:true,inputModalities:['image']}]});
   else if(message.method==='account/rateLimits/read')send(message.id,{});
   else assert.fail('Unexpected inference or method: '+message.method);
  });});
  child.stdin.on('data',chunk=>parser.push(chunk));child.stdin.on('finish',end);return child as unknown as ChildProcessWithoutNullStreams;
 };
 const adapter=new CodexAdapter(dir,{command:async()=>({file:'fixture.exe',args:[]}),launcher,kill:async child=>{child.kill();}});
 try{const state=await adapter.inspect();assert.equal(state.authenticated,true);assert.equal(state.models.length,4);assert.deepEqual(state.models[0].inputModalities,['text','image']);assert.equal(state.models[0].inputModalitiesSource,'provider-catalog');assert.equal(state.models[0].verified,false);assert.deepEqual(state.models[1].inputModalities,['text']);for(const model of state.models.slice(2)){assert.equal(model.inputModalities,undefined);assert.equal(model.inputModalitiesSource,undefined);}assert.ok(methods.every(method=>['initialize','config/read','account/read','model/list','account/rateLimits/read'].includes(method)));}
 finally{await adapter.close();await rm(dir,{recursive:true,force:true});}
});
