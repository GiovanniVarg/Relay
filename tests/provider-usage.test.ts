import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ClaudeStream} from '../server/providers/claude.js';
import {CodexTurn} from '../server/providers/codex.js';
import {CursorAdapter} from '../server/providers/cursor.js';
import { normalizeUsage, usageSummary } from '../shared/provider-usage.js';
import { accountUsageKey } from '../server/provider-usage.js';
import { cursorUsageSnapshot } from '../server/providers/cursor-worker.js';
const meta={provider:'cursor' as const,accountKey:'opaque',source:'cursor-sdk' as const,scope:'agent' as const,sessionId:'session',observedAt:'2026-10-26T12:00:00Z'};
test('reported usage retains zero, missing and invalid counters/cents distinctly, and strips upstream fields',()=>{
 const zero=normalizeUsage({inputTokens:0,outputTokens:0,chargedCents:0,rawCostCents:1.25,apiKey:'secret'},meta);
 assert.equal(zero.tokens.inputTokens,0);assert.equal(zero.chargedCents,0);assert.equal(zero.rawCostCents,1.25);assert.ok(!JSON.stringify(zero).includes('secret'));
 const absent=normalizeUsage({},meta);assert.equal(absent.tokens.inputTokens,null);assert.equal(absent.chargedCents,null);
 const bad=normalizeUsage({inputTokens:-1,outputTokens:Infinity,chargedCents:NaN,rawCostCents:-5},meta);assert.equal(bad.tokens.inputTokens,null);assert.equal(bad.tokens.outputTokens,null);assert.equal(bad.chargedCents,null);assert.equal(bad.rawCostCents,null);
 assert.match(usageSummary(zero),/0.*in.*0.*out/i);assert.match(usageSummary(absent),/unknown/i);
});
test('Claude preserves partial/cache-only counters and never fabricates missing or invalid values as zero',()=>{
 for(const [usage,expected] of [[{input_tokens:0},{inputTokens:0}],[{cache_read_input_tokens:4},{cachedInputTokens:4}],[{input_tokens:-1,output_tokens:NaN},undefined]] as const){const parser=new ClaudeStream(()=>{});parser.accept({type:'result',subtype:'success',result:'Done',usage});const result=parser.finish(0);assert.equal(result.usage,undefined);assert.deepEqual(result.usageCounters,expected);}
});
test('canonical Codex cache-write and reasoning plus Claude cache-creation counters retain partial values and zero',()=>{
 for(const counters of [{cacheWriteInputTokens:3,reasoningOutputTokens:5},{cacheWriteInputTokens:0,reasoningOutputTokens:0},{cacheWriteInputTokens:7}]){
  const turn=new CodexTurn('thread','m',()=>{});turn.start('turn');turn.accept({method:'thread/tokenUsage/updated',params:{threadId:'thread',turnId:'turn',tokenUsage:{total:counters}}});
  assert.equal(turn.usageCounters?.cacheWriteTokens,counters.cacheWriteInputTokens);assert.equal(turn.usageCounters?.reasoningTokens,counters.reasoningOutputTokens);assert.equal(turn.usage,undefined);
 }
 for(const count of [4,0]){const parser=new ClaudeStream(()=>{});parser.accept({type:'result',subtype:'success',result:'Done',usage:{cache_creation_input_tokens:count}});assert.deepEqual(parser.finish(0).usageCounters,{cacheWriteTokens:count});assert.equal(parser.finish(0).usage,undefined);}
});
test('actual Cursor adapter starts required asynchronous disposal without waiting for optional usage and withholds terminal success until cleanup',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'relay-usage-cleanup-'));
 try{for(const mode of ['adapter-cleanup','cleanup-error']){let stdout='';
  const adapter=new CursorAdapter(dir,{command:{file:process.execPath,args:['--import',new URL('../node_modules/tsx/dist/loader.mjs',import.meta.url).href,fileURLToPath(new URL('./fixtures/cursor-usage-worker.ts',import.meta.url)),mode]},launcher:(command,args,cwd,env)=>{
   const child=spawn(command.file,[...command.args,...args],{cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe','ipc']});child.stdout!.on('data',chunk=>stdout+=chunk);return child as unknown as ChildProcessWithoutNullStreams;
  }});
  try{const pending=adapter.stream({runId:'fixture',conversationId:'fixture',model:'m',instructions:'',history:[{role:'user',content:'Fixture'}],maxSeconds:10,expectedAccount:{accountLabel:'fixture',plan:''}},()=>{},new AbortController().signal);
   if(mode==='cleanup-error'){await assert.rejects(pending,/before a successful result/);assert.ok(!stdout.includes('"type":"result"'));}
   else{const result=await pending;assert.equal(result.text,'Done');assert.equal(result.sessionUsage!.availability,'reported','usage settles only after cleanup starts; a serial pre-cleanup await loses it');const rows=stdout.trim().split('\n').map(line=>JSON.parse(line));const order=rows.map(row=>row.type);assert.equal(order.filter(type=>type==='cleanup-started').length,1);assert.ok(order.indexOf('usage-started')<order.indexOf('cleanup-started'));assert.ok(order.indexOf('cleanup-finished')<order.indexOf('result'));assert.equal(result.sessionUsage!.tokens.inputTokens,0);}
  }finally{await adapter.close();}
 }}finally{await rm(dir,{recursive:true,force:true});}
});
test('one-shot Cursor worker flushes a successful result and completes cleanup despite a nonsettling usage handle',async()=>{
 const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('./fixtures/cursor-usage-worker.ts',import.meta.url))],{windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);let timer:ReturnType<typeof setTimeout>|undefined;
 try{const code=await Promise.race([new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{child.kill();reject(Error('Worker failed to finish bounded optional usage lookup'));},6000);})]);assert.equal(code,0,stderr);const rows=stdout.trim().split('\n').map(line=>JSON.parse(line));assert.ok(rows.some(row=>row.type==='result'&&row.text==='Done'&&row.sessionUsage.availability==='unavailable'));assert.equal(rows.at(-1).type,'cleanup-complete');assert.ok(!stdout.includes('synthetic'));}finally{clearTimeout(timer);if(child.exitCode===null)child.kill();}
});
test('account binding requires a currently authenticated installed subscription identity',()=>{
 const state={id:'cursor' as const,installed:true,authenticated:true,authMode:'subscription' as const,accountLabel:'A',plan:'',models:[]};
 assert.match(accountUsageKey(state)!,/^[a-f0-9]{64}$/);assert.notEqual(accountUsageKey(state),accountUsageKey({...state,accountLabel:'B'}));
 for(const change of [{authenticated:false},{installed:false},{authMode:'unknown' as const},{accountLabel:''}])assert.equal(accountUsageKey({...state,...change}),null);
});
test('Cursor usage is a bounded sanitized agent snapshot and never passes a client run label',async()=>{
 let exhaustedCalls=0;const skipped=await cursorUsageSnapshot({getUsage:async()=>{exhaustedCalls++;return {};}},meta,0);assert.equal(exhaustedCalls,0);assert.equal(skipped.availability,'unavailable');
 let args:unknown[]=[];const snapshot=await cursorUsageSnapshot({getUsage:async(...value:unknown[])=>{args=value;return {usage:{inputTokens:0,outputTokens:4,cacheReadTokens:2,totalTokens:6},cost:{chargedCents:0,rawCostCents:1.25},runs:[],credential:'secret'};}},meta,10);
 assert.deepEqual(args,[]);assert.equal(snapshot.scope,'agent');assert.equal(snapshot.chargedCents,0);assert.equal(snapshot.tokens.inputTokens,0);assert.ok(!JSON.stringify(snapshot).includes('secret'));
 for(const getUsage of [async()=>{throw Error('Account gated secret');},async()=>new Promise(()=>{})]){const result=await cursorUsageSnapshot({getUsage},meta,10);assert.equal(result.availability,'unavailable');assert.equal(result.chargedCents,null);assert.ok(!JSON.stringify(result).includes('secret'));}
 const invalid=await cursorUsageSnapshot({getUsage:async()=>({usage:{inputTokens:-1,outputTokens:Infinity},cost:{chargedCents:-2}})},meta,10);assert.equal(invalid.tokens.inputTokens,null);assert.equal(invalid.chargedCents,null);
});
