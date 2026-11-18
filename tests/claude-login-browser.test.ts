import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {mkdtemp,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {ClaudeAdapter} from '../server/providers/claude.js';
import {childEnvironment} from '../server/providers/process.js';

function child() {return Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),stdin:new PassThrough(),pid:765432,exitCode:null as number|null,signalCode:null,kill:()=>true}) as unknown as ChildProcessWithoutNullStreams;}
for(const isolatedProfile of [false,true])test(`Claude ${isolatedProfile?'isolated':'default'} sign-in opens official browser authentication without a terminal command`,async()=>{
 const directory=await mkdtemp(join(tmpdir(),'relay-claude-sign-in-')),events:{args:string[];cwd:string;env:NodeJS.ProcessEnv}[]=[],children:ChildProcessWithoutNullStreams[]=[];let stopped=0;
 const adapter=new ClaudeAdapter(directory,{isolatedProfile,command:async()=>({file:'synthetic-claude',args:[]}),launcher:(_command,args,cwd,env)=>{events.push({args,cwd,env});const process=child();children.push(process);return process;},kill:async process=>{stopped++;process.emit('close',0,null);}});
 try{
  const result=await adapter.login();assert.equal('command'in result,false);assert.match(result.message,/browser sign-in/);assert.doesNotMatch(result.message,/Run .* terminal/);assert.deepEqual(events[0].args,['auth','login']);
  const env=events[0].env;assert.equal(env.ANTHROPIC_API_KEY,undefined);assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN,undefined);
  if(isolatedProfile){assert.equal(env.CLAUDE_CONFIG_DIR,resolve(directory,'claude','home','.claude'));await access(env.CLAUDE_CONFIG_DIR!);assert.equal(env.HOME,resolve(directory,'claude','home'));}
  else{const normal=childEnvironment();assert.equal(env.HOME,normal.HOME);assert.equal(env.USERPROFILE,normal.USERPROFILE);assert.equal(env.APPDATA,normal.APPDATA);assert.equal(env.CLAUDE_CONFIG_DIR,undefined);await assert.rejects(access(resolve(directory,'claude','home','.claude')));}
  await assert.rejects(adapter.login(),/active operations/);assert.equal(events.length,1,'a pending login cannot start another authentication process');
  (children[0].stdout as PassThrough).write(Buffer.alloc(256*1024+1,120));await new Promise(done=>setImmediate(done));assert.equal(stopped,1,'oversized authentication output terminates only the owned process');assert.equal(result.message.includes('xxxx'),false);
 }finally{await adapter.close();await rm(directory,{recursive:true,force:true,maxRetries:5});}
});

test('Claude sign-in rejects an unavailable CLI without changing account identity or reading credentials',async()=>{const directory=await mkdtemp(join(tmpdir(),'relay-claude-missing-'));let launches=0;const adapter=new ClaudeAdapter(directory,{command:async()=>null,launcher:()=>{launches++;return child();}});try{await assert.rejects(adapter.login(),/official Claude Code CLI/);assert.equal(launches,0);await assert.rejects(access(join(directory,'claude')));}finally{await adapter.close();await rm(directory,{recursive:true,force:true});}});
