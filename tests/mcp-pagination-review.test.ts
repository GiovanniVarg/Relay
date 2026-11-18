import {testCredentials} from './synthetic-vault.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {McpConnections} from '../server/mcp-connections.js';
import type {Agent} from '../shared/types.js';

test('review: empty MCP pages with unique cursors terminate within the bounded discovery budget',async()=>{
 const root=await mkdtemp(join(tmpdir(),'relay-mcp-page-review-')),store=new Store(root),agent=store.list<Agent>('agent')[0];let requests=0,pages=0;
 const mcp=new McpConnections(store,{credentials:testCredentials(store),fetch:async(_url,options)=>{
  requests++;if(requests>130)throw new Error('Review fixture stopped unbounded discovery');
  const input=JSON.parse(String(options?.body));if(!input.id)return new Response(null,{status:202});
  const result=input.method==='initialize'?{protocolVersion:'2025-11-25',capabilities:{tools:{}}}:{tools:[],nextCursor:'unique-page-'+(++pages)};
  return new Response(JSON.stringify({jsonrpc:'2.0',id:input.id,result}),{headers:{'Content-Type':'application/json'}});
 }});
 try{const connection=await mcp.add({agentId:agent.id,name:'Hostile pagination fixture',url:'https://example.com/mcp'});await assert.rejects(mcp.refresh(connection.id),/pagination|catalog.*limit|catalog.*pages|discovery.*limit/i);assert.ok(requests<=105,'Discovery must stop even when no tools accumulate');assert.equal(mcp.list()[0].status,'error');assert.equal(mcp.tools(agent.id).length,0);}finally{await mcp.close();store.close();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
