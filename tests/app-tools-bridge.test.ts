import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import {request as httpRequest} from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppToolSession, createAppToolsBridge } from '../server/app-tools-bridge.js';
import {createApp} from '../server/index.js';
import {id,now} from '../server/store.js';
import type {Agent,Run} from '../shared/types.js';

const definitions = [{ name: 'relay_create_bot', description: 'Create a Relay bot', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false } }];
test('app-tool session invokes genuine callback once, rejects unknown tools and changed replays', async () => {
  const calls: unknown[] = [];
  const session = createAppToolSession({ definitions, call: async (...args) => { calls.push(args); return { botId: 'created' }; } }, new AbortController().signal);
  assert.deepEqual(await session.call('one', 'relay_create_bot', { name: 'Ada' }), { botId: 'created' });
  assert.deepEqual(await session.call('one', 'relay_create_bot', { name: 'Ada' }), { botId: 'created' });
  assert.equal(calls.length, 1);
  await assert.rejects(session.call('one', 'relay_create_bot', { name: 'Other' }), /replay/i);
  await assert.rejects(session.call('two', 'shell', {}), /unavailable|unknown/i);
  session.close();
  await assert.rejects(session.call('three', 'relay_create_bot', {}), /closed|cancel/i);
});

test('app-tool cancellation rejects late output and prevents new callbacks', async () => {
  const controller = new AbortController(); let finish!: (value: unknown) => void; let calls = 0;
  const session = createAppToolSession({ definitions, call: async () => { calls++; return new Promise(done => { finish = done; }); } }, controller.signal);
  const pending = session.call('one', 'relay_create_bot', {});
  await new Promise(done => setImmediate(done)); controller.abort();
  await assert.rejects(pending, /closed|cancel/i); finish({ botId: 'late' });
  await assert.rejects(session.call('two', 'relay_create_bot', {}), /closed|cancel/i);
  assert.equal(calls, 1); session.close();
});

test('private stdio MCP facade advertises only supplied Relay tools and invokes parent callback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-app-mcp-')); let calls = 0;
  const bridge = await createAppToolsBridge({ definitions, call: async (_id, name, args) => { calls++; return { name, args, botId: 'actual' }; } }, new AbortController().signal, root);
  const config = bridge.mcpConfig.mcpServers.relay_app;
  const child = spawn(config.command, config.args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const closed = new Promise(done => child.once('close', done));
  let diagnostics = ''; child.stderr.on('data', value => { diagnostics += value; });
  let buffer = ''; const waiting = new Map<number, (value: any) => void>();
  child.stdout.on('data', chunk => { buffer += chunk; let end: number; while ((end = buffer.indexOf('\n')) >= 0) { const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); waiting.get(value.id)?.(value); waiting.delete(value.id); } });
  const rpc = (id: number, method: string, params?: unknown) => new Promise<any>((done, reject) => { const timer = setTimeout(() => reject(new Error('Facade did not answer: ' + diagnostics.slice(0, 1000))), 3000); waiting.set(id, value => { clearTimeout(timer); done(value); }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  try {
    assert.deepEqual(bridge.toolNames, ['mcp__relay_app__relay_create_bot']);
    assert.ok(!JSON.stringify(bridge.mcpConfig).includes('Bearer'));
    assert.equal((await rpc(1, 'initialize', { protocolVersion: '2025-03-26' })).result.serverInfo.name, 'relay_app');
    assert.deepEqual((await rpc(2, 'tools/list')).result.tools, definitions);
    const result = await rpc(3, 'tools/call', { name: 'relay_create_bot', arguments: { name: 'Ada' } });
    assert.equal(JSON.parse(result.result.content[0].text).botId, 'actual');
    await rpc(3, 'tools/call', { name: 'relay_create_bot', arguments: { name: 'Ada' } }); assert.equal(calls, 1);
    assert.ok((await rpc(4, 'tools/call', { name: 'Bash', arguments: {} })).error); assert.equal(calls, 1);
  } finally { child.stdin.end(); await closed; await bridge.close(); assert.deepEqual(await readdir(root), []); await rm(root, { recursive: true, force: true }); }
});


async function realToolkitFixture(){
 const directory=await mkdtemp(join(tmpdir(),'relay-real-tool-catalog-')),app=createApp({dataDir:directory});
 const agent=app.store.list<Agent>('agent')[0],conversationId=app.store.conversations(agent.id)[0].id,runId=id();
 app.store.put<Run>('run',{id:runId,agentId:agent.id,conversationId,messageId:id(),mode:'agent',status:'running',route:null,error:null,startedAt:now(),endedAt:null,usage:null});
 const scope={runId,agentId:agent.id,conversationId,signal:new AbortController().signal,isActive:()=>true,interact:async()=>({decision:'allow' as const})};
 return {app,agent,scope,bind:()=>app.toolkit.bind(scope),async close(){await app.close();await rm(directory,{recursive:true,force:true});}};
}

test('complete real AgentToolkit catalog plus a normal 100-tool MCP connection can be bridged',async()=>{
 const f=await realToolkitFixture();try{
  const base=f.bind();assert.ok(base.definitions.length>32,'Regression must use the complete real bound catalog');
  const connection=await f.app.mcp.add({agentId:f.agent.id,name:'Fixture connector',url:'https://example.test/mcp'});
  f.app.store.put('mcp-connection',{...connection,status:'ready',tools:Array.from({length:100},(_,i)=>({name:'fixture_'+i,description:'d'.repeat(1000),inputSchema:{type:'object',description:'s'.repeat(500),properties:{},additionalProperties:false}}))});
  const tools=f.bind();assert.equal(tools.definitions.length,base.definitions.length+100);
  assert.ok(Buffer.byteLength(JSON.stringify(tools.definitions))>128*1024,'Regression must cover a real catalog exceeding the old serialized cap');
  const session=createAppToolSession(tools,f.scope.signal);try{assert.equal(session.definitions.length,tools.definitions.length);assert.ok((await session.call('roster','relay_list_bots',{}) as {bots:unknown[]}).bots.length);}finally{session.close();}
 }finally{await f.close();}
});

test('hashed connected MCP names dispatch to their owning bot while arbitrary and foreign names are rejected',async()=>{
 const f=await realToolkitFixture();try{
  const connection=await f.app.mcp.add({agentId:f.agent.id,name:'Owner connector',url:'https://example.test/mcp'});
  f.app.store.put('mcp-connection',{...connection,token:'',status:'ready',tools:[{name:'inspect',inputSchema:{type:'object',properties:{}}}]});
  const tool=f.app.mcp.tools(f.agent.id)[0];assert.match(tool.name,/^mcp_[a-f0-9]{28}$/);
  let calls=0;f.app.mcp.call=async(agentId,name,args)=>{calls++;assert.equal(agentId,f.agent.id);assert.equal(name,tool.name);assert.deepEqual(args,{target:'fixture'});return {owner:agentId};};
  const bound=f.bind(),session=createAppToolSession({...bound,definitions:[tool]},f.scope.signal);
  try{
   const result=await session.call('connected',tool.name,{target:'fixture'});assert.equal((result as {result:{owner:string}}).result.owner,f.agent.id);assert.equal(calls,1);
   await assert.rejects(session.call('foreign','mcp_'+'f'.repeat(28),{}),/unknown|unavailable/i);
   await assert.rejects(session.call('arbitrary','shell',{}),/unknown|unavailable/i);
   assert.throws(()=>createAppToolSession({definitions:[{...tool,name:'mcp_arbitrary'}],call:bound.call},f.scope.signal),/Invalid/);
  }finally{session.close();}
 }finally{await f.close();}
});

test('real app-control library calls accept valid 190 KB text and still reject oversized bridge inputs',async()=>{
 const f=await realToolkitFixture();try{
  const tools=f.bind(),tool=tools.definitions.find(tool=>tool.name==='relay_app_control')!;
  const session=createAppToolSession({...tools,definitions:[tool]},f.scope.signal);
  try{
   const content='a'.repeat(190000),result=await session.call('large-library','relay_app_control',{action:'library.add',id:f.agent.id,input:{name:'large.txt',content}}) as {content:string};
   assert.equal(result.content,content);assert.equal(f.app.store.files(f.agent.id)[0].content.length,190000);
   await assert.rejects(session.call('oversized','relay_app_control',{content:'a'.repeat(1024*1024+1)}),/safety limit/);
  }finally{session.close();}
 }finally{await f.close();}
});


test('bridge limits remain bounded by encoded bytes and catalog count',async()=>{
 const signal=new AbortController().signal,call=async()=>({});
 assert.throws(()=>createAppToolSession({definitions:Array.from({length:513},(_,i)=>({...definitions[0],name:'relay_'+i})),call},signal),/Invalid/);
 assert.throws(()=>createAppToolSession({definitions:[{...definitions[0],description:'é'.repeat(600000)}],call},signal),/safety limit/);
 const session=createAppToolSession({definitions,call:async()=>({content:'é'.repeat(600000)})},signal);
 try{
  await assert.rejects(session.call('unicode-input','relay_create_bot',{content:'é'.repeat(600000)}),/safety limit/);
  await assert.rejects(session.call('unicode-output','relay_create_bot',{}),/safety limit/);
 }finally{session.close();}
});

test('private bridge preserves large UTF-8 arguments split within a multibyte character',async()=>{
 const root=await mkdtemp(join(tmpdir(),'relay-utf8-bridge-')),content='界'.repeat(190000);
 const bridge=await createAppToolsBridge({definitions,call:async(_id,_name,args)=>args},new AbortController().signal,root);
 try{
  const args=bridge.mcpConfig.mcpServers.relay_app.args,bootstrap=JSON.parse(await readFile(args[args.length-1],'utf8')) as {url:string;token:string};
  const bytes=Buffer.from(JSON.stringify({operation:'call',id:'utf8',name:'relay_create_bot',args:{content}})),split=bytes.indexOf(Buffer.from('界'))+1;
  const result=await new Promise<{value:{content:string}}>((done,reject)=>{
   const req=httpRequest(bootstrap.url,{method:'POST',headers:{authorization:'Bearer '+bootstrap.token,'content-type':'application/json'}},res=>{const chunks:Buffer[]=[];res.on('data',chunk=>chunks.push(Buffer.from(chunk)));res.on('error',reject);res.on('end',()=>{try{assert.equal(res.statusCode,200);done(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch(error){reject(error);}});});
   req.on('error',reject);req.write(bytes.subarray(0,split));setTimeout(()=>req.end(bytes.subarray(split)),20);
  });
  assert.equal(result.value.content,content);
 }finally{await bridge.close();await rm(root,{recursive:true,force:true});}
});
