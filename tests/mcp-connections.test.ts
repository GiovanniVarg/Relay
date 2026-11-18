import {testCredentials} from './synthetic-vault.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { McpConnections } from '../server/mcp-connections.js';
import { Store } from '../server/store.js';
import type { Agent } from '../shared/types.js';
async function fixture(mode:'json'|'sse'='json'){
 const root=await mkdtemp(join(tmpdir(),'relay-mcp-http-')),store=new Store(join(root,'data'));const [agent,peer]=store.list<Agent>('agent');const calls:{method:string;headers:Record<string,unknown>;params:any}[]=[];let toolCalls=0;let release!:(value?:unknown)=>void;const entered=new Promise(done=>release=done);
 const server=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const rpc=JSON.parse(Buffer.concat(chunks).toString());calls.push({method:rpc.method,headers:req.headers,params:rpc.params});
  if(rpc.method==='notifications/initialized'){res.writeHead(202);res.end();return;}
  let result:unknown;
  if(rpc.method==='initialize'){res.setHeader('Mcp-Session-Id','private-fixture-session');result={protocolVersion:'2025-11-25',capabilities:{tools:{}}};}
  else if(rpc.method==='tools/list'){result={tools:[{name:'relay_create_bot',description:'Fixture remote tool',inputSchema:{type:'object',properties:{text:{type:'string'},slow:{type:'boolean'}}}}]};}
  else{toolCalls++;if(rpc.params.arguments.slow){release();return;}result={content:[{type:'text',text:'Remote result '+rpc.params.arguments.text+' token:fixture-token-value'}]};}
  const data=JSON.stringify({jsonrpc:'2.0',id:rpc.id,result});res.setHeader('Content-Type',mode==='json'?'application/json':'text/event-stream');if(mode==='json')res.end(data);else{res.write('event: message\ndata: '+JSON.stringify({jsonrpc:'2.0',method:'notifications/message',params:{message:'status'}})+'\n\n');res.write('data: '+data.slice(0,15));res.end(data.slice(15)+'\n\n');}
 });await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const url='http://127.0.0.1:'+(server.address() as {port:number}).port+'/mcp';return{root,store,agent,peer,calls,server,url,entered,get toolCalls(){return toolCalls;},async close(){server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));store.close();await rm(root,{recursive:true,force:true,maxRetries:10});}};
}
for(const mode of ['json','sse'] as const)test(`remote MCP ${mode} negotiates session, discovers scoped tools and calls once with credential redaction`,async()=>{
 const f=await fixture(mode);let mcp=new McpConnections(f.store,{credentials:testCredentials(f.store)});
 try{const connection=await mcp.add({agentId:f.agent.id,name:'Fixture',url:f.url,token:'fixture-token-value'});assert.equal(connection.hasToken,true);assert.equal(JSON.stringify(connection).includes('fixture-token-value'),false);assert.deepEqual(mcp.tools(f.agent.id),[]);await mcp.refresh(connection.id);const [tool]=mcp.tools(f.agent.id);assert.match(tool.name,/^mcp_[a-f0-9]{28}$/);assert.notEqual(tool.name,'relay_create_bot');assert.equal(mcp.tools(f.peer.id).length,0);await assert.rejects(mcp.call(f.peer.id,tool.name,{}),/unavailable/);const output=await mcp.call(f.agent.id,tool.name,{text:'worked'});assert.match(JSON.stringify(output),/worked/);assert.equal(JSON.stringify(output).includes('fixture-token-value'),false);assert.equal(f.toolCalls,1);assert.deepEqual(f.calls.map(call=>call.method),['initialize','notifications/initialized','tools/list','tools/call']);assert.equal(f.calls[0].headers.authorization,'Bearer fixture-token-value');assert.equal(f.calls[1].headers['mcp-session-id'],'private-fixture-session');assert.equal(f.calls[2].headers['mcp-protocol-version'],'2025-11-25');await mcp.close();mcp=new McpConnections(f.store,{credentials:testCredentials(f.store)});assert.equal(mcp.tools(f.agent.id).length,1);await mcp.call(f.agent.id,tool.name,{text:'persisted'});assert.equal(f.calls.filter(call=>call.method==='initialize').length,1);await mcp.remove(connection.id);await assert.rejects(mcp.call(f.agent.id,tool.name,{}),/unavailable/);}finally{await mcp.close();await f.close();}
});
test('MCP human setup rejects credentials in URLs, insecure remote endpoints and the Relay origin',async()=>{
 const f=await fixture();let sent=0;const mcp=new McpConnections(f.store,{credentials:testCredentials(f.store),fetch:async()=>{sent++;throw Error('Should not send');},blockedOrigins:()=>[f.url]});
 try{for(const url of ['http://example.com/mcp','file:///private','https://user:pass@example.com/mcp','https://example.com/mcp?api_key=secret',f.url])await assert.rejects(mcp.add({agentId:f.agent.id,name:'Fixture',url}));assert.equal(sent,0);await assert.rejects(mcp.add({agentId:f.agent.id,name:'Fixture',url:'https://example.com/mcp',token:'x\r\ny'}));}finally{await mcp.close();await f.close();}
});
test('MCP cancellation and removal abort a tool request without replay or leaking its credential',async()=>{
 const f=await fixture();const mcp=new McpConnections(f.store,{credentials:testCredentials(f.store),timeoutMs:10000});
 try{const connection=await mcp.add({agentId:f.agent.id,name:'Fixture',url:f.url,token:'fixture-token-value'});await mcp.refresh(connection.id);const [tool]=mcp.tools(f.agent.id);const controller=new AbortController();const pending=mcp.call(f.agent.id,tool.name,{slow:true},controller.signal);await f.entered;controller.abort(new Error('Cancel fixture'));await assert.rejects(pending,error=>!/fixture-token-value/.test(String(error)));assert.equal(f.toolCalls,1);await mcp.remove(connection.id);await assert.rejects(mcp.call(f.agent.id,tool.name,{}));assert.equal(f.toolCalls,1);}finally{await mcp.close();await f.close();}
});
test('MCP redaction preserves JSON booleans/null/numbers when a token resembles a JSON literal',async()=>{
 const root=await mkdtemp(join(tmpdir(),'relay-mcp-scrub-')),store=new Store(join(root,'data'));const agent=store.list<Agent>('agent')[0];
 const mcp=new McpConnections(store,{credentials:testCredentials(store),fetch:async(_url,init)=>{const rpc=JSON.parse(String(init?.body));if(!rpc.id)return new Response(null,{status:202});const result=rpc.method==='initialize'?{protocolVersion:'2025-11-25',capabilities:{tools:{}}}:rpc.method==='tools/list'?{tools:[{name:'fixture',inputSchema:{type:'object',properties:{ok:{type:'boolean',default:true}},additionalProperties:false}}]}:{value:true,missing:null,count:42,text:'the token is true'};return new Response(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}),{headers:{'Content-Type':'application/json'}});}});
 try{const connection=await mcp.add({agentId:agent.id,name:'Fixture',url:'https://example.com/mcp',token:'true'});await mcp.refresh(connection.id);const tool=mcp.tools(agent.id)[0];assert.equal((tool.inputSchema.properties as any).ok.default,true);const result=await mcp.call(agent.id,tool.name,{});assert.deepEqual(result,{value:true,missing:null,count:42,text:'the token is [redacted]'});}finally{await mcp.close();store.close();await rm(root,{recursive:true,force:true,maxRetries:10});}
});
test('removing an MCP grant aborts an already pending external call without dispatching another',async()=>{
 const f=await fixture();const mcp=new McpConnections(f.store,{credentials:testCredentials(f.store)});
 try{const connection=await mcp.add({agentId:f.agent.id,name:'Fixture',url:f.url});await mcp.refresh(connection.id);const tool=mcp.tools(f.agent.id)[0];const pending=mcp.call(f.agent.id,tool.name,{slow:true});await f.entered;await mcp.remove(connection.id);await assert.rejects(pending,/cancelled|timed out/);assert.equal(f.toolCalls,1);assert.deepEqual(mcp.tools(f.agent.id),[]);}finally{await mcp.close();await f.close();}
});
test('MCP redirects cannot forward initialization or bearer credentials to another destination',async()=>{
 const f=await fixture();const redirect=createServer((_req,res)=>{res.writeHead(302,{Location:f.url});res.end();});await new Promise<void>(done=>redirect.listen(0,'127.0.0.1',done));const mcp=new McpConnections(f.store,{credentials:testCredentials(f.store)});
 try{const connection=await mcp.add({agentId:f.agent.id,name:'Redirect',url:'http://127.0.0.1:'+(redirect.address() as {port:number}).port+'/mcp',token:'fixture-token-value'});await assert.rejects(mcp.refresh(connection.id),/transport/);assert.equal(f.calls.length,0);assert.equal(mcp.list()[0].status,'error');assert.equal(JSON.stringify(mcp.list()).includes('fixture-token-value'),false);}finally{await mcp.close();redirect.closeAllConnections();await new Promise<void>(done=>redirect.close(()=>done()));await f.close();}
});
test('MCP catalog discovery cannot loop forever on empty pages with unique cursors',async()=>{
 const root=await mkdtemp(join(tmpdir(),'relay-mcp-pages-')),store=new Store(join(root,'data'));const agent=store.list<Agent>('agent')[0];let pages=0;
 const mcp=new McpConnections(store,{credentials:testCredentials(store),fetch:async(_url,init)=>{const rpc=JSON.parse(String(init?.body));if(!rpc.id)return new Response(null,{status:202});const result=rpc.method==='initialize'?{protocolVersion:'2025-11-25',capabilities:{tools:{}}}:{tools:[],nextCursor:'cursor-'+(++pages)};return new Response(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}),{headers:{'Content-Type':'application/json'}});}});
 try{const connection=await mcp.add({agentId:agent.id,name:'Fixture',url:'https://example.com/mcp'});await assert.rejects(mcp.refresh(connection.id),/100 pages/);assert.equal(pages,100);assert.equal(mcp.list()[0].status,'error');assert.deepEqual(mcp.tools(agent.id),[]);}finally{await mcp.close();store.close();await rm(root,{recursive:true,force:true,maxRetries:10});}
});
test('closing MCP connections drains an active call before the store is closed',async()=>{
 const f=await fixture();const mcp=new McpConnections(f.store,{credentials:testCredentials(f.store)});
 try{const connection=await mcp.add({agentId:f.agent.id,name:'Fixture',url:f.url});await mcp.refresh(connection.id);const tool=mcp.tools(f.agent.id)[0];const pending=mcp.call(f.agent.id,tool.name,{slow:true});const rejected=assert.rejects(pending,/cancelled|timed out/);await f.entered;await mcp.close();await rejected;assert.equal(f.toolCalls,1);await assert.rejects(mcp.call(f.agent.id,tool.name,{}),/stopping/);}finally{await mcp.close();await f.close();}
});
