import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OpenCodeAdapter,openCodeCatalog} from '../server/providers/opencode.js';
import type {ProviderRequest} from '../shared/types.js';
import type {Launcher} from '../server/providers/process.js';
const command={file:'fixture-opencode.exe',args:[]},scope='a'.repeat(64);
function fixture(o:{version?:string;legacy?:boolean;wrongModel?:boolean;permission?:boolean;foreignPermission?:boolean;earlyEof?:boolean;scopeChange?:boolean}={}){
 let active=false,prompts=0,selected='local/first',serial=0;const sent:any[]=[],envs:NodeJS.ProcessEnv[]=[];
 const config=()=>[{id:'model',category:'model',type:'select',currentValue:selected,options:[{group:'Local fixture',options:[{value:'local/first',name:'First'},{value:'local/second',name:'Second'}]}]}];
 const launcher:Launcher=(_command,args,cwd,env)=>{envs.push(env);assert.deepEqual(args,['acp']);const c=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),exitCode:null as number|null,signalCode:null,pid:undefined}) as unknown as ChildProcessWithoutNullStreams;
 const close=()=>{if(c.exitCode!==null)return;Object.assign(c,{exitCode:0});c.emit('close',0,null);};c.kill=(()=>{close();return true;}) as typeof c.kill;
 const reply=(v:any)=>(c.stdout as PassThrough).write(JSON.stringify(v)+'\n');
 let buffer='';c.stdin.on('data',chunk=>{buffer+=chunk;let at:number;while((at=buffer.indexOf('\n'))>=0){const v=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);sent.push(v);queueMicrotask(()=>{
  if(!v.method){assert.equal(v.result?.outcome?.optionId,'once');finish();return;}
  const result=(value:any)=>reply({jsonrpc:'2.0',id:v.id,result:value});
  if(v.method==='initialize')result({protocolVersion:1,agentInfo:{name:'opencode',version:o.version??'2.2.5'}});
  else if(v.method==='session/new')result({sessionId:'s',...(o.legacy?{models:{currentModelId:selected,availableModels:[{modelId:'local/first',name:'First'},{modelId:'local/second',name:'Second'}]}}:{configOptions:config()})});
  else if(v.method==='session/set_config_option'){selected=o.wrongModel?'paid/elsewhere':v.params.value;result({configOptions:config()});}
  else if(v.method==='session/set_model'){selected=o.wrongModel?'paid/elsewhere':v.params.modelId;result({});}
  else if(v.method==='session/prompt'){prompts++;active=true;if(o.earlyEof){close();return;}if(o.permission){reply({jsonrpc:'2.0',id:'permission',method:'session/request_permission',params:{sessionId:o.foreignPermission?'other':'s',toolCall:{toolCallId:'tool',title:'Write fixture',rawInput:{path:'result.txt'}},options:[{optionId:'always',kind:'allow_always'},{optionId:'once',kind:'allow_once'},{optionId:'reject',kind:'reject_once'}]}});}else finish();}
  else throw Error('Unexpected method '+v.method);
  function finish(){if(!active)return;active=false;reply({jsonrpc:'2.0',method:'session/update',params:{sessionId:'other',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'foreign'}}}});reply({jsonrpc:'2.0',method:'session/update',params:{sessionId:'s',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'fixture result'}}}});reply({jsonrpc:'2.0',id:v.method==='session/prompt'?v.id:[...sent].reverse().find((m:any)=>m.method==='session/prompt').id,result:{stopReason:'end_turn'}});}
 });}});c.stdin.on('finish',close);return c;};
 return {launcher,sent,envs,prompts:()=>prompts,profile:async()=>({scope:o.scopeChange&&++serial>1?'b'.repeat(64):scope,providers:{local:{local:true}},env:{PATH:'safe'}})};
}
async function setup(o:Parameters<typeof fixture>[0]={}){const dir=await mkdtemp(join(tmpdir(),'relay-opencode-fixture-')),workspace=join(dir,'project');await mkdir(workspace);const f=fixture(o),adapter=new OpenCodeAdapter(dir,{command:async()=>command,launcher:f.launcher,kill:async c=>{c.kill();},profile:f.profile});const request:ProviderRequest={runId:'r',conversationId:'c',model:'local/second',mode:'agent',workspace,instructions:'Private mission',history:[{role:'user',content:'hello'}],maxSeconds:2,expectedAccount:{accountLabel:'OpenCode managed profile',plan:''},expectedConnectionScope:scope,interact:async()=>({decision:'allow'})};return {f,adapter,request,async close(){await adapter.close();await rm(dir,{recursive:true,force:true});}};}
test('OpenCode config options retain complete qualified provider/model IDs and metadata without inferring entitlements',()=>{
 const rows=openCodeCatalog({configOptions:[{id:'model',category:'model',options:[{group:'A',options:[{value:'a/same',name:'Same'}]},{group:'B',options:[{value:'b/same',name:'Same'}]}]}]},{a:{local:true}});
 assert.deepEqual(rows.map(m=>m.id),['a/same','b/same']);assert.equal(rows[0].local,true);assert.equal(rows[1].local,false);assert.equal(rows[0].verified,false);
});
test('unverified OpenCode 2.x versions reject before any model prompt',async()=>{const s=await setup({version:'2.2.6'});try{await assert.rejects(s.adapter.stream(s.request,()=>{},new AbortController().signal),/2\.2\.5/);assert.equal(s.f.prompts(),0);}finally{await s.close();}});
test('OpenCode inspection creates no prompts; native Agent pins modern model and uses exact one-call host approval kinds',async()=>{
 const s=await setup({permission:true});try{const connection=await s.adapter.inspect();assert.equal(connection.nativeAgentOnly,true);assert.equal(connection.authMode,'managed');assert.equal(connection.connectionScope,scope);assert.equal(s.f.prompts(),0);assert.equal(connection.models.length,2);let approvals=0;s.request.interact=async()=>{approvals++;return{decision:'allow'};};
 const result=await s.adapter.stream(s.request,()=>{},new AbortController().signal);assert.equal(result.text,'fixture result');assert.equal(result.actualModel,undefined);assert.equal(approvals,1);assert.ok(s.f.sent.some(m=>m.method==='session/set_config_option'));assert.ok(!s.f.sent.some(m=>m.method==='authenticate'));}finally{await s.close();}
});
test('OpenCode legacy ACP model selection remains exact and rejects changed model/scope, unsupported modes and foreign approvals',async()=>{
 for(const options of [{legacy:true},{wrongModel:true},{scopeChange:true},{permission:true,foreignPermission:true},{earlyEof:true}]){
  const s=await setup(options);try{await assert.rejects(s.adapter.stream(s.request,()=>{},new AbortController().signal),/model|scope|configuration|session|closed/i);}finally{await s.close();}
 }
 const s=await setup();try{await assert.rejects(s.adapter.stream({...s.request,mode:'chat'},()=>{},new AbortController().signal),/Agent/);assert.equal(s.f.prompts(),0);}finally{await s.close();}
});
