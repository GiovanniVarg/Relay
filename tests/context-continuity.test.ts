import {claudeTextEnvelope,claudeNativeEnvelope,contextWireCharacters} from '../server/context-wire.js';
import {Runs} from '../server/runs.js';
import {boundedPrompt} from '../server/providers/process.js';
import {cursorPrompt} from '../server/providers/cursor-worker.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {JsonlLocalAgentStore} from '@cursor/sdk';
import {buildContextPack} from '../server/context-pack.js';
import {NativeSessions} from '../server/native-sessions.js';
import {readOwnSource,searchOwnSources} from '../server/source-retrieval.js';
import {Store,now} from '../server/store.js';
import {cursorLocalStore,runCursorOperation,CURSOR_CONNECTOR_KEY_NAME,type CursorSdk,type CursorWorkerEvent} from '../server/providers/cursor-worker.js';
import type {Agent,ProviderRequest} from '../shared/types.js';

test('bounded context preserves exact mandatory input, retrieves a named library source and discloses losses deterministically',()=>{
 const input={instructions:'Mission "exact" 私密',current:'Please inspect target-file.txt for needle',history:[{id:'old',role:'assistant' as const,content:'old'.repeat(90000)},{id:'recent',role:'user' as const,content:'newest relevant reminder'}],sources:Array.from({length:100},(_,i)=>({id:'file-'+i,name:i===77?'target-file.txt':'other-'+i,content:i===77?'needle '.repeat(3000):'irrelevant '.repeat(5000),kind:'file' as const}))};
 const saved=JSON.stringify(input),pack=buildContextPack(input);
 assert.equal(pack.instructions,input.instructions);assert.equal(pack.history.at(-1)?.content,input.current);assert.ok(pack.diagnostics.characters<=80000);assert.ok(pack.diagnostics.omittedHistory>0);assert.ok(pack.diagnostics.omittedSources>0);assert.ok(pack.history.some(m=>m.content.includes('newest relevant reminder')));assert.ok(pack.diagnostics.sources.some(s=>s.id==='file-77'));assert.match(pack.history.at(-2)!.content,/omitted|excerpted/);assert.equal(JSON.stringify(input),saved);assert.deepEqual(buildContextPack(input),pack);assert.throws(()=>buildContextPack({...input,instructions:'x'.repeat(80000)}),/Required agent instructions/);
});

test('source reads/search are bounded and isolated to own bot and current conversation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'relay-sources-')),store=new Store(dir);try{
 const [a,b]=store.list<Agent>('agent'),c=store.conversations(a.id)[0];store.put('file',{id:'owned',agentId:a.id,name:'Named.txt',content:'needle '.repeat(8000),size:56000,createdAt:now()});store.put('file',{id:'foreign',agentId:b.id,name:'private.txt',content:'private sentinel',size:16,createdAt:now()});const foreign=store.conversations(b.id)[0];store.put('message',{id:'archive',conversationId:c.id,role:'assistant',content:'historic needle',status:'complete',createdAt:now(),runId:null});store.put('message',{id:'private-message',conversationId:foreign.id,role:'user',content:'private sentinel',status:'complete',createdAt:now(),runId:null});
 assert.equal(searchOwnSources(store,a.id,c.id,{query:'Named.txt'}).results[0].id,'owned');assert.equal(readOwnSource(store,a.id,c.id,{sourceId:'owned',start:100,length:12000}).content.length,12000);assert.equal(readOwnSource(store,a.id,c.id,{sourceId:'archive'}).content,'historic needle');assert.throws(()=>readOwnSource(store,a.id,c.id,{sourceId:'foreign'}),/not found/);assert.throws(()=>readOwnSource(store,a.id,c.id,{sourceId:'private-message'}),/not found/);assert.throws(()=>searchOwnSources(store,a.id,foreign.id,{query:''}),/not found/);assert.throws(()=>readOwnSource(store,a.id,c.id,{sourceId:'owned',length:12001}),/12000/);assert.ok(!JSON.stringify(searchOwnSources(store,a.id,c.id,{query:''})).includes('private sentinel'));
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
const base:ProviderRequest={runId:'run-1',conversationId:'conversation',model:'model',instructions:'Mission',history:[{role:'user',content:'old context'},{role:'assistant',content:'old result'},{role:'user',content:'new exact request'}],maxSeconds:10,mode:'chat',expectedAccount:{accountLabel:'fixture@example.test',plan:''}};
test('registry commits exact successful cursor; every binding change, dirty attempt and intervening turn invalidate reuse',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'relay-sessions-')),store=new Store(dir);try{
 for(const mutate of [(r:ProviderRequest)=>({...r,model:'other'}),(r:ProviderRequest)=>({...r,mode:'work' as const}),(r:ProviderRequest)=>({...r,workspace:'different'}),(r:ProviderRequest)=>({...r,instructions:'changed'}),(r:ProviderRequest)=>({...r,expectedAccount:{...r.expectedAccount,accountLabel:'changed'}}),(r:ProviderRequest)=>({...r,appTools:{definitions:[{name:'tool',description:'new',inputSchema:{}}],call:async()=>({})}})]){
 const sessions=new NativeSessions(store),req={...structuredClone(base),runId:Math.random().toString()};req.continuity=sessions.begin(req,'bot','references','before');sessions.commit(req,'session','account','cursor');const next={...base,runId:'next'};assert.equal(sessions.begin(mutate(next),'bot','references','cursor').sessionId,undefined);
 }
 const sessions=new NativeSessions(store),req={...base,runId:'commit'};req.continuity=sessions.begin(req,'bot','references');sessions.commit(req,'session','account','cursor');assert.equal(sessions.begin({...base,runId:'second'},'bot','references','cursor').sessionId,'session');assert.equal(sessions.begin({...base,runId:'third'},'bot','references','cursor').sessionId,undefined,'dirty run cannot reuse');
 for(const [bot,ref,cursor] of [['other','references','cursor'],['bot','changed','cursor'],['bot','references','intervening-turn']]){req.continuity=sessions.begin(req,'bot','references');sessions.commit(req,'session','account','cursor');assert.equal(sessions.begin(base,bot,ref,cursor).sessionId,undefined);}
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});

async function sdkFixture(options:{empty?:boolean;sendError?:boolean}={}){
 const dir=await mkdtemp(join(tmpdir(),'relay-cursor-resume-')),roots:string[]=[],callbacks:any[]=[],prompts:string[]=[],received:number[]=[];let creates=0,resumes=0;
 const accountKey=createHash('sha256').update('42').digest('hex');
 const agent=(opts:any,nativeId='native-session')=>{callbacks.push(opts.local.customTools.relay_echo);assert.deepEqual(opts.local.settingSources,[]);assert.equal(opts.local.enableAgentRetries,false);assert.deepEqual(opts.mcpServers,{});return {agentId:nativeId,async send(prompt:string){prompts.push(prompt);if(options.sendError)throw Error('uncertain send');return{status:'finished',async *stream(){const result=await opts.local.customTools.relay_echo.execute({},{toolCallId:'call-'+prompts.length});received.push(result);yield {type:'assistant',message:{content:[{type:'text',text:'Done'}]}};},async wait(){return{status:'finished',result:'Done',model:{id:'model'}}},async cancel(){}}},async [Symbol.asyncDispose](){}};};
 const sdk={JsonlLocalAgentStore:class extends JsonlLocalAgentStore{constructor(root:string){const target=join(dir,root.split(/[\\/]/).at(-1)!);super(target);roots.push(target);}},FileCredentialStore:class{async load(){return{apiKey:'synthetic',backendUrl:'https://api2.cursor.sh'}}},Cursor:{me:async()=>({userId:42,userEmail:'fixture@example.test',apiKeyName:CURSOR_CONNECTOR_KEY_NAME}),models:{list:async()=>[{id:'model',displayName:'Model'}]}},Agent:{async create(opts:any){creates++;const nativeId=creates===1?'native-session':'native-session-'+creates;const stamp=Date.now();await opts.local.store.agents.create({agent:{agentId:nativeId,cwd:opts.local.cwd,status:'idle',latestCheckpoint:{schemaVersion:1,rootBlobId:'checkpoint'},createdAt:stamp,updatedAt:stamp}});if(!options.empty)await opts.local.store.checkpoints.create({agentId:nativeId,blobId:'checkpoint',data:Buffer.from('checkpoint')});return agent(opts,nativeId)},async resume(id:string,opts:any){assert.equal(id,'native-session');resumes++;return agent(opts)}}} as unknown as CursorSdk;
 return{sdk,accountKey,roots,callbacks,prompts,received,counts:()=>({creates,resumes}),failSend:()=>{options.sendError=true},close:()=>rm(dir,{recursive:true,force:true})};
}
test('official durable store resumes with fresh callback authority and sends only current delta, never old history',async()=>{
 const f=await sdkFixture();try{const first={...base,runId:'first',appTools:{definitions:[{name:'relay_echo',description:'Echo',inputSchema:{type:'object'}}],call:async()=>1},continuity:{agentId:'bot',binding:'fixed',delta:[base.history.at(-1)!]}};let result:any;await runCursorOperation({operation:'stream',request:first},f.sdk,e=>{if(e.type==='result')result=e},new AbortController().signal,'private-cwd');await assert.rejects(f.callbacks[0].execute({},{toolCallId:'old'}),/closed|expired/);
 const second={...first,runId:'second',appTools:{...first.appTools,call:async()=>2},continuity:{...first.continuity,sessionId:result.sessionId,accountKey:result.continuity.accountKey}};await runCursorOperation({operation:'stream',request:second},f.sdk,e=>{if(e.type==='result')result=e},new AbortController().signal,'private-cwd');assert.deepEqual(f.counts(),{creates:1,resumes:1});assert.equal(f.roots[0],f.roots[1]);assert.deepEqual(f.received,[1,2]);assert.ok(!f.prompts[1].includes('old context'));assert.ok(f.prompts[1].includes('new exact request'));assert.equal(result.continuity.mode,'native-resumed');assert.ok(!f.prompts.join('').includes('synthetic'));
 }finally{await f.close();}
});
test('missing/empty checkpoint safely reconstructs before dispatch; failed resumed send is never sent fresh',async()=>{
 for(const empty of [true,false]){const f=await sdkFixture({empty});try{const request={...base,appTools:{definitions:[{name:'relay_echo',description:'Echo',inputSchema:{type:'object'}}],call:async()=>1},continuity:{agentId:'bot',binding:'fixed',delta:[base.history.at(-1)!]}};await runCursorOperation({operation:'stream',request},f.sdk,()=>{},new AbortController().signal,'cwd');request.continuity={...request.continuity,sessionId:'native-session',accountKey:f.accountKey} as typeof request.continuity;await runCursorOperation({operation:'stream',request},f.sdk,()=>{},new AbortController().signal,'cwd');assert.deepEqual(f.counts(),{creates:empty?2:1,resumes:empty?0:1});}finally{await f.close();}}
 const f=await sdkFixture();try{const request={...base,appTools:{definitions:[{name:'relay_echo',description:'Echo',inputSchema:{type:'object'}}],call:async()=>1},continuity:{agentId:'bot',binding:'fixed',sessionId:'missing',accountKey:f.accountKey,delta:[base.history.at(-1)!]}};await runCursorOperation({operation:'stream',request},f.sdk,()=>{},new AbortController().signal,'cwd');assert.equal(f.counts().creates,1);request.continuity.sessionId='native-session';f.failSend();await assert.rejects(runCursorOperation({operation:'stream',request},f.sdk,()=>{},new AbortController().signal,'cwd'),/uncertain send/);assert.deepEqual(f.counts(),{creates:1,resumes:1});}finally{await f.close();}
});

test('escaped file/history transport remains under budget and excerpt anchors on rare deep request term',()=>{
 const pack=buildContextPack({instructions:'Mission "preserved"',current:'the relevant-deep-needle target.txt',history:[{id:'huge',role:'assistant',content:'"\\\n'.repeat(50000)}],sources:[{id:'target',name:'target.txt',kind:'file',content:'the common prefix '.repeat(5000)+'relevant-deep-needle '+'"\\\n'.repeat(50000)},...Array.from({length:8},(_,i)=>({id:'common-'+i,name:'common',kind:'file' as const,content:'the common data'}))]});
 const request={...base,instructions:pack.instructions,history:pack.history};assert.ok(boundedPrompt(request).length+request.instructions.length<=80000);assert.ok(cursorPrompt(request).length<=80000);assert.ok(claudeTextEnvelope(request.instructions,boundedPrompt(request)).length<=80000);assert.ok(JSON.stringify(claudeNativeEnvelope(boundedPrompt(request))).length+request.instructions.length<=80000);assert.equal(pack.diagnostics.characters,contextWireCharacters(request.instructions,request.history));assert.ok(pack.history.some(m=>m.content.includes('relevant-deep-needle')&&m.content.includes('"id":"target"')));assert.equal(pack.history.at(-1)?.content,'the relevant-deep-needle target.txt');
});

test('host persists truthful delta provenance and never reuses across provider switches or cancellation before commit',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'relay-context-host-')),store=new Store(dir);let runs:Runs|undefined;try{
 const requests:ProviderRequest[]=[];let cancel=false;
 const adapters=Object.fromEntries(['openai','claude','cursor','gemini','grok'].map(id=>[id,{id,inspect:async()=>({id,installed:true,authenticated:true,authMode:'subscription',accountLabel:'fixture@example.test',plan:'',models:[{id:'model',name:'Model',verified:false}]}),login:async()=>({message:''}),close:async()=>{},stream:async(request:ProviderRequest)=>{requests.push(request);if(cancel)runs!.active.get(request.runId)!.controller.abort(new Error('Cancelled by user'));return{text:'Synthetic result',sessionId:'session',...(id==='cursor'?{continuity:{mode:request.continuity?.sessionId?'native-resumed':'reconstructed',accountKey:'account',inputHash:'sent-hash',inputCharacters:1234}}:{})};}}])) as never;
 runs=new Runs(store,adapters);runs.redactText=text=>text.replaceAll('secret-sentinel','[REDACTED]');await runs.refresh();for(const provider of ['openai','cursor']){store.saveBilling(provider,{mode:'included',confirmed:true,automaticRouting:true,allowanceNote:'fixture'});store.saveModelPreferences(provider,{defaultModel:'model',allowedModels:['model']});}
 const original=store.list<Agent>('agent')[0],bot=store.put('agent',{...original,workspace:'',mode:'chat' as const,instructions:'Trusted instructions'}),conversation=store.conversations(bot.id)[0];store.put('file',{id:'file',agentId:bot.id,name:'target.txt',content:'first-topic '.repeat(5000)+'second-topic second-topic content',size:60000,createdAt:now()});
 const start=async(provider:'cursor'|'openai',content:string)=>{const result=runs!.start(bot,conversation.id,content,provider,'model','chat');await runs!.active.get(result.run.id)!.promise;return store.get<any>('run',result.run.id)!;};
 await start('cursor','Read first-topic from target.txt');const next=await start('cursor','Read second-topic from target.txt secret-sentinel');assert.equal(requests[1].continuity?.sessionId,'session');assert.ok(!JSON.stringify(requests[1].continuity?.delta).includes('secret-sentinel'));assert.ok(requests[1].continuity!.delta.some(m=>m.content.includes('second-topic')));assert.ok(!requests[1].continuity!.delta.some(m=>m.content==='Synthetic result'));assert.equal(next.context.mode,'native-resumed');assert.equal(next.context.provenance,'native-delta');assert.equal(next.context.historyIncluded,0);assert.ok(next.context.sources.every((source:any)=>source.kind!=='history'));assert.equal(next.context.hash,'sent-hash');
 await start('openai','Intervening provider response');await start('cursor','Return safely');assert.equal(requests.at(-1)?.continuity?.sessionId,undefined);
 cancel=true;const stopped=await start('cursor','Cancel before host commit');assert.equal(stopped.status,'cancelled');cancel=false;await start('cursor','After cancellation');assert.equal(requests.at(-1)?.continuity?.sessionId,undefined);
 }finally{await runs?.close();store.close();await rm(dir,{recursive:true,force:true});}
});
import {testCredentials} from './synthetic-vault.js';
import {InferenceScheduler,scheduleAdapters} from '../server/scheduler.js';
import {AgentToolkit} from '../server/agent-toolkit.js';
import {AppActions} from '../server/app-actions.js';
import {Tasks} from '../server/tasks.js';
import {Knowledge} from '../server/knowledge.js';
import {McpConnections} from '../server/mcp-connections.js';

test('queued Cursor follow-up rechecks the live MCP schema and disconnection before resume or send',async()=>{
 for(const change of ['schema','disconnect'] as const){
  const dir=await mkdtemp(join(tmpdir(),'relay-context-queued-tools-')),store=new Store(dir),scheduler=new InferenceScheduler(2,store),requests:ProviderRequest[]=[];
  const [original]=store.list<Agent>('agent'),bot=store.put('agent',{...original,workspace:'',mode:'agent' as const}),conversation=store.conversations(bot.id)[0];
  const mcp=new McpConnections(store,{credentials:testCredentials(store),fetch:async()=>{throw Error('No network in fixture')}}),knowledge=new Knowledge(store),tasks=new Tasks(store,{start:async()=>{throw Error('No task inference')},snapshot:()=>({status:'running'}),cancel:async()=>{}}),actions=new AppActions(store,{} as never),toolkit=new AgentToolkit(store,actions,tasks,knowledge,{} as never,{} as never,mcp);
  const connection=store.put('mcp-connection',{id:'fixture-mcp',agentId:bot.id,name:'Fixture MCP',url:'https://fixture.invalid/mcp',hasToken:false,toolCount:1,status:'ready',updatedAt:now(),tools:[{name:'echo',description:'First schema',inputSchema:{type:'object',properties:{old:{type:'string'}}}}]});
  const adapters=Object.fromEntries(['openai','claude','cursor','gemini','grok'].map(id=>[id,{id,inspect:async()=>({id,installed:true,authenticated:true,authMode:'subscription',accountLabel:'fixture@example.test',plan:'',models:[{id:'model',name:'Model',verified:false}]}),login:async()=>({message:''}),close:async()=>{},stream:async(request:ProviderRequest)=>{requests.push(request);return{text:'Fixture success',sessionId:'session',continuity:{mode:request.continuity?.sessionId?'native-resumed':'reconstructed',accountKey:'account'}};}}])) as never;
  const runs=new Runs(store,scheduleAdapters(adapters,scheduler));runs.toolkit=toolkit;runs.knowledge=knowledge;let release=()=>{};let held:Promise<unknown>[]=[];
  try{
   await runs.refresh();store.saveBilling('cursor',{mode:'included',confirmed:true,automaticRouting:true,allowanceNote:'fixture'});store.saveModelPreferences('cursor',{defaultModel:'model',allowedModels:['model']});
   const first=runs.start(bot,conversation.id,'First turn','cursor','model','agent');await runs.active.get(first.run.id)!.promise;assert.equal(store.get<any>('run',first.run.id).status,'complete');
   const gate=new Promise<void>(done=>{release=done});held=[scheduler.run(undefined,new AbortController().signal,()=>gate),scheduler.run(undefined,new AbortController().signal,()=>gate)];
   const second=runs.start(bot,conversation.id,'Matching follow-up','cursor','model','agent'),active=runs.active.get(second.run.id)!;for(let i=0;i<30&&!scheduler.queuedCount;i++)await new Promise(done=>setImmediate(done));assert.equal(scheduler.queuedCount,1);
   if(change==='schema')store.put('mcp-connection',{...connection,tools:[{name:'echo',description:'Changed schema',inputSchema:{type:'object',properties:{fresh:{type:'number'}}}}]});else await mcp.remove(connection.id);
   release();await Promise.all(held);await active.promise;const failed=store.get<any>('run',second.run.id);assert.equal(failed.status,'failed');assert.match(failed.error,/Tool catalog or permission policy changed before dispatch/);assert.equal(requests.length,1,'queued request never reaches an adapter or resumes a stale native session');assert.equal(store.list<any>('native-session')[0].state,'dirty');
   const fresh=runs.start(bot,conversation.id,'Fresh safe admission','cursor','model','agent');await runs.active.get(fresh.run.id)!.promise;assert.equal(requests.length,2);assert.equal(requests[1].continuity?.sessionId,undefined);const external=requests[1].appTools!.definitions.filter(tool=>tool.name.startsWith('mcp_'));if(change==='schema'){assert.equal(external.length,1);assert.ok(JSON.stringify(external[0].inputSchema).includes('fresh'));}else assert.deepEqual(external,[]);
  }finally{release();await Promise.allSettled(held);await runs.close();await tasks.close();await mcp.close();store.close();await rm(dir,{recursive:true,force:true});}
 }
});
