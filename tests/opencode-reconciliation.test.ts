import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OpenCodeAdapter} from '../server/providers/opencode.js';
import {markOutcomeReconciliation} from '../server/outcome-reconciliation.js';
import type {ProviderRequest} from '../shared/types.js';
import type {Launcher} from '../server/providers/process.js';

const scope='a'.repeat(64);
async function fixture(attack?:'tool_call'|'tool_call_update'|'permission'){
 const root=await mkdtemp(join(tmpdir(),'relay-opencode-report-')),sent:any[]=[],launches:{cwd:string;env:NodeJS.ProcessEnv}[]=[];
 const launcher:Launcher=(_command,args,cwd,env)=>{
  assert.deepEqual(args,['acp']);launches.push({cwd,env});
  const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),exitCode:null as number|null,signalCode:null,pid:undefined}) as unknown as ChildProcessWithoutNullStreams;
  const close=()=>{if(child.exitCode!==null)return;Object.assign(child,{exitCode:0});child.emit('close',0,null);};child.kill=(()=>{close();return true;}) as typeof child.kill;
  const write=(value:any)=>(child.stdout as PassThrough).write(JSON.stringify(value)+'\n');let buffer='';
  child.stdin.on('data',chunk=>{buffer+=chunk;let at:number;while((at=buffer.indexOf('\n'))>=0){const value=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);sent.push(value);queueMicrotask(()=>{
   const result=(result:any)=>write({jsonrpc:'2.0',id:value.id,result});
   const options=[{id:'model',category:'model',currentValue:'local/probe',options:[{value:'local/probe',name:'Probe'}]}];
   if(value.method==='initialize')result({protocolVersion:1,agentInfo:{name:'opencode',version:'2.2.5'}});
   else if(value.method==='session/new')result({sessionId:'session',configOptions:options});
   else if(value.method==='session/set_config_option')result({configOptions:options});
   else if(value.method==='session/prompt'){
    if(attack==='permission'){write({jsonrpc:'2.0',id:'native-permission',method:'session/request_permission',params:{sessionId:'session',toolCall:{toolCallId:'shell',title:'Shell',rawInput:{command:'forbidden'}},options:[{optionId:'allow',kind:'allow_once'},{optionId:'deny',kind:'reject_once'}]}});return;}
    if(attack){write({jsonrpc:'2.0',method:'session/update',params:{sessionId:'session',update:{sessionUpdate:attack,title:'Shell',kind:'execute',status:'pending'}}});return;}
    write({jsonrpc:'2.0',method:'session/update',params:{sessionId:'session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'{"state":"complete","summary":"Answered","remaining":[],"evidence":[]}'}}}});result({stopReason:'end_turn'});
   }else if(value.method==='session/cancel'){}else throw Error('Unexpected fixture method');
  });}});child.stdin.on('finish',close);return child;
 };
 const adapter=new OpenCodeAdapter(root,{command:async()=>({file:'fixture.exe',args:[]}),launcher,kill:async child=>{child.kill();},profile:async()=>({scope,providers:{local:{local:true}},env:{PATH:'safe'}})});
 const request:ProviderRequest={runId:'report',conversationId:'conversation',model:'local/probe',usagePurpose:'outcome-reconciliation',mode:'chat',instructions:'Report only',history:[{role:'user',content:'Assess saved work'}],maxSeconds:2,expectedAccount:{accountLabel:'OpenCode managed profile',plan:''},expectedConnectionScope:scope};
 return {root,adapter,request,launches,sent,async close(){await adapter.close();await rm(root,{recursive:true,force:true});}};
}

test('host-marked OpenCode reporting uses a private restricted session with the same model and profile',async()=>{
 const f=await fixture();try{
  const result=await f.adapter.stream(markOutcomeReconciliation(f.request),()=>{},new AbortController().signal);
  assert.equal(JSON.parse(result.text).state,'complete');assert.equal(f.launches.length,1);
  const launch=f.launches[0];assert.ok(launch.cwd.startsWith(join(f.root,'opencode','operations')+'\\')||launch.cwd.startsWith(join(f.root,'opencode','operations')+'/'));assert.equal(launch.cwd,f.sent.find(row=>row.method==='session/new').params.cwd);
  assert.deepEqual(f.sent.find(row=>row.method==='session/new').params.mcpServers,[]);
  assert.equal(f.sent.find(row=>row.method==='session/set_config_option').params.value,'local/probe');
  const policy=JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT!);
  assert.deepEqual(policy.permissions,[{action:'*',resource:'*',effect:'deny'},{action:'skill',resource:'*',effect:'deny'}]);assert.deepEqual(policy.agents.build.permissions,[{action:'*',resource:'*',effect:'deny'},{action:'skill',resource:'*',effect:'deny'}]);
  assert.ok(policy.policies.some((rule:any)=>rule.action==='tool.use'&&rule.resource==='*'&&rule.effect==='deny'));assert.ok(policy.policies.some((rule:any)=>rule.action==='skill.use'&&rule.resource==='*'&&rule.effect==='deny'));assert.equal(policy.mcp,undefined);
 }finally{await f.close();}
});

test('a serialized reconciliation-looking request cannot grant OpenCode reporting authority',async()=>{
 const f=await fixture();try{await assert.rejects(f.adapter.stream({...f.request,usagePurpose:'outcome-reconciliation',outcomeReconciliation:true} as ProviderRequest,()=>{},new AbortController().signal),/Agent/);assert.equal(f.launches.length,0);}finally{await f.close();}
});

for(const attack of ['tool_call','tool_call_update','permission'] as const)test('OpenCode reporting rejects native '+attack+' without a human callback',async()=>{
 const f=await fixture(attack);try{await assert.rejects(f.adapter.stream(markOutcomeReconciliation(f.request),()=>{},new AbortController().signal),/report|reconcil|disabled|tool/i);}finally{await f.close();}
});

for(const unsafe of ['workspace','appTools','interact','continuity'] as const)test('OpenCode reporting rejects inherited '+unsafe+' authority before launch',async()=>{
 const f=await fixture();try{const request={...f.request,[unsafe]:unsafe==='workspace'?f.root:unsafe==='appTools'?{definitions:[],call:async()=>({})}:unsafe==='interact'?async()=>({decision:'allow'}):{agentId:'a',binding:'b',delta:[]}} as ProviderRequest;await assert.rejects(f.adapter.stream(markOutcomeReconciliation(request),()=>{},new AbortController().signal),/report|reconcil|authority|tool|workspace/i);assert.equal(f.launches.length,0);}finally{await f.close();}
});
