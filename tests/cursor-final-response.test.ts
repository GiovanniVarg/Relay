import test from 'node:test';
import assert from 'node:assert/strict';
import type {SDKMessage,AgentOptions,RunResult} from '@cursor/sdk';
import {runCursorOperation,CURSOR_CONNECTOR_KEY_NAME,type CursorSdk,type CursorWorkerEvent} from '../server/providers/cursor-worker.js';
import type {ProviderRequest} from '../shared/types.js';

const request:ProviderRequest={runId:'synthetic',conversationId:'synthetic',model:'exact-model',instructions:'Synthetic',history:[{role:'user',content:'Synthetic'}],mode:'chat',maxSeconds:5,expectedAccount:{accountLabel:'fixture@example.test',plan:''}};
const assistant=(text:string):SDKMessage=>({type:'assistant',agent_id:'agent',run_id:'run',message:{role:'assistant',content:[{type:'text',text}]}});
const tool:SDKMessage={type:'tool_call',agent_id:'agent',run_id:'run',call_id:'call-1',name:'mcp__custom-user-tools__relay_echo',status:'completed',args:{}};
function fixture(events:SDKMessage[],result:Partial<RunResult>={}){
 let sends=0,disposed=0,actions=0;const emitted:CursorWorkerEvent[]=[];
 const sdk={JsonlLocalAgentStore:class{},FileCredentialStore:class{async load(){return{apiKey:'synthetic-never-used',backendUrl:'https://api2.cursor.sh'};}},Cursor:{async me(){return{userId:1,userEmail:'fixture@example.test',apiKeyName:CURSOR_CONNECTOR_KEY_NAME};},models:{async list(){return[{id:'exact-model',displayName:'Synthetic'}];}}},Agent:{async create(options:AgentOptions){return{agentId:'synthetic-agent',async send(){sends++;return{status:'finished',async*stream(){for(const event of events){if(event.type==='tool_call'&&event.status==='completed')await options.local!.customTools!.relay_echo.execute({}, {toolCallId:event.call_id});yield event;}},async wait(){return{id:'synthetic',status:'finished',model:{id:'exact-model'},usage:{inputTokens:2,outputTokens:1},...result};},async cancel(){}};},async getUsage(){return{};},async[Symbol.asyncDispose](){disposed++;}};}}} as unknown as CursorSdk;
 const run=()=>runCursorOperation({operation:'stream',request:{...request,appTools:{definitions:[{name:'relay_echo',description:'Synthetic echo',inputSchema:{type:'object'}}],async call(){actions++;return{ok:true};}}}},sdk,event=>emitted.push(event),new AbortController().signal,'synthetic-cwd');
 return{run,emitted,counts:()=>({sends,disposed,actions}),text:()=>emitted.filter((e):e is Extract<CursorWorkerEvent,{type:'delta'}>=>e.type==='delta').map(e=>e.text).join(''),result:()=>emitted.find((e):e is Extract<CursorWorkerEvent,{type:'result'}>=>e.type==='result')};
}

test('Cursor validates the SDK final assistant step after a completed app tool while preserving all streamed text and one tool action',async()=>{
 const f=fixture([assistant('Checking status.\n'),tool,assistant('It is '),assistant('ready.')],{result:'It is ready.'});await f.run();assert.equal(f.text(),'Checking status.\nIt is ready.');assert.equal(f.result()!.text,f.text());assert.deepEqual(f.result()!.usage,{inputTokens:2,outputTokens:1});assert.deepEqual(f.counts(),{sends:1,disposed:1,actions:1});
});
test('Cursor appends only the missing suffix of the final step after a tool',async()=>{
 const f=fixture([assistant('Checking.\n'),tool,assistant('Ready')],{result:'Ready now.'});await f.run();assert.equal(f.text(),'Checking.\nReady now.');assert.equal(f.result()!.text,f.text());assert.deepEqual(f.counts(),{sends:1,disposed:1,actions:1});
});
test('Cursor accepts a nonempty authoritative result-only final step after a tool without replay',async()=>{
 const f=fixture([assistant('Checking.\n'),tool],{result:'Ready now.'});await f.run();assert.equal(f.text(),'Checking.\nReady now.');assert.equal(f.result()!.text,f.text());assert.deepEqual(f.counts(),{sends:1,disposed:1,actions:1});
 const initial=fixture([],{result:'Only terminal text'});await initial.run();assert.equal(initial.text(),'Only terminal text');assert.equal(initial.result()!.text,initial.text());
});
test('Cursor thinking and user events delimit assistant steps; status and usage events do not',async()=>{
 for(const boundary of [{type:'thinking',agent_id:'agent',run_id:'run',text:'Synthetic thought'},{type:'user',agent_id:'agent',run_id:'run',message:{role:'user',content:[{type:'text',text:'Synthetic followup'}]}}] satisfies SDKMessage[]){const f=fixture([assistant('Earlier.\n'),boundary,assistant('Final'),{type:'status',agent_id:'agent',run_id:'run',status:'RUNNING'},assistant(' answer')],{result:'Final answer'});await f.run();assert.equal(f.text(),'Earlier.\nFinal answer');assert.equal(f.result()!.text,f.text());}
});
test('Cursor empty thinking completion annotates an existing step without splitting assistant deltas',async()=>{
 const f=fixture([assistant('Hello'),{type:'thinking',agent_id:'agent',run_id:'run',text:'',thinking_duration_ms:25},assistant(' world')],{result:'Hello world'});await f.run();assert.equal(f.text(),'Hello world');assert.equal(f.result()!.text,f.text());assert.deepEqual(f.counts(),{sends:1,disposed:1,actions:0});
});
test('Cursor assistant events remain SDK deltas, never guessed cumulative snapshots',async()=>{
 const f=fixture([assistant('a'),assistant('ab')],{result:'aab'});await f.run();assert.equal(f.text(),'aab');
 const invalid=fixture([assistant('a'),assistant('ab')],{result:'ab'});await assert.rejects(invalid.run(),/did not match/);assert.equal(invalid.result(),undefined);assert.equal(invalid.counts().sends,1);
});
test('Cursor still rejects genuine final mismatch and missing final assistant text after a tool',async()=>{
 for(const result of ['Different answer','Earlier.\nFinal']){const f=fixture([assistant('Earlier.\n'),tool,assistant('Final answer')],{result});await assert.rejects(f.run(),/did not match/);assert.equal(f.result(),undefined);assert.deepEqual(f.counts(),{sends:1,disposed:1,actions:1});}
 for(const result of ['',undefined]){const f=fixture([assistant('Earlier commentary.\n'),tool],{result});await assert.rejects(f.run(),/empty|did not match/);assert.equal(f.result(),undefined);assert.deepEqual(f.counts(),{sends:1,disposed:1,actions:1});}
});
test('Cursor failed, cancelled and unexpected-model results remain terminal failures without replay',async()=>{
 for(const result of [{status:'error',error:{message:'Synthetic failure'}},{status:'cancelled'},{model:{id:'unexpected-model'}}] satisfies Partial<RunResult>[]){const f=fixture([assistant('Visible partial answer')],{result:'Visible partial answer',...result});await assert.rejects(f.run(),/Synthetic failure|cancelled|unexpected model/);assert.equal(f.result(),undefined);assert.deepEqual(f.counts(),{sends:1,disposed:1,actions:0});}
});
