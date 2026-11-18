import test from 'node:test';
import assert from 'node:assert/strict';
import {AgentToolkit} from '../server/agent-toolkit.js';
import {createAppToolSession} from '../server/app-tools-bridge.js';
import type {HarnessChange} from '../shared/harness-changes.js';

function fixture(){
 const records=new Map<string,any>(),key=(kind:string,id:string)=>kind+'\0'+id;
 const store={get:(kind:string,id:string)=>records.get(key(kind,id)),put:(kind:string,value:any)=>{records.set(key(kind,value.id),value);return value;},list:(kind:string)=>[...records].filter(([id])=>id.startsWith(kind+'\0')).map(([,value])=>value)};
 store.put('run',{id:'run',agentId:'bot',mode:'agent',status:'running'});
 const changes=Array.from({length:35},(_,n):HarnessChange=>({id:'draft-'+n,title:'Synthetic '+n,agentId:null,createdAt:'2026-11-05T12:00:00Z',updatedAt:'2026-11-05T12:00:00Z',status:'failed',revision:'a'.repeat(64),checkedRevision:null,checkLog:('historical check '+n+'\n').repeat(10000),error:'Synthetic failure',workspaceDirectory:'C:/synthetic/draft-'+n,previewUrl:null}));
 let mutations=0;
 const harness={assertAvailable:()=>{},initialize:async()=>{},changes:{inspect:async()=>({installDirectory:'C:/synthetic-install',workspacesDirectory:'C:/synthetic-drafts',editableDirectories:['client','server'],editableRootFiles:['package.json'],executionBoundary:'Synthetic'}),list:async()=>changes,listPage:async(args:any={})=>{const offset=args.offset??0,limit=args.limit??10;return{changes:changes.slice(offset,offset+limit),offset,limit,total:changes.length,nextOffset:offset+limit<changes.length?offset+limit:null};},get:async(id:string)=>{const result=changes.find(row=>row.id===id);if(!result)throw Error('Not found');return structuredClone(result);},check:async()=>{mutations++;throw Error('Check must not run');}},updates:{status:async()=>({status:'complete',changeId:'draft-0',revision:'a'.repeat(64),message:'Applied fixture',replacement:{private:'do not return'},nonce:'private-nonce',registryKey:'private-registry-key'})}};
 const actions={definitions:()=>[],bind:()=>({call:async()=>{throw Error('No app mutation');}})},controller=new AbortController();
 const toolkit=new AgentToolkit(store as never,actions as never,{}as never,null as never,null as never,null as never,undefined,harness as never);
 const bound=toolkit.bind({runId:'run',agentId:'bot',conversationId:'chat',signal:controller.signal,isActive:()=>true,interact:async()=>{throw Error('No interaction');}}),session=createAppToolSession(bound,controller.signal);
 return{store,changes,bound,session,get mutations(){return mutations;},close(){session.close();}};
}

test('actual harness status crosses the tool bridge as paged bounded metadata, preserving full logs',async()=>{
 const f=fixture();try{
  const lengths=f.changes.map(row=>row.checkLog.length),first=await f.session.call('first','relay_harness_status',{})as any;
  assert.equal(first.changes.length,10);assert.equal(first.total,35);assert.equal(first.offset,0);assert.equal(first.nextOffset,10);
  assert.ok(Buffer.byteLength(JSON.stringify(first))<65536);assert.ok(first.changes.every((row:any)=>!Object.hasOwn(row,'checkLog')));
  assert.deepEqual(first.activation,{status:'complete',changeId:'draft-0',revision:'a'.repeat(64),message:'Applied fixture'});
  const second=await f.session.call('second','relay_harness_status',{offset:10,limit:20})as any;assert.equal(second.changes.length,20);assert.equal(second.nextOffset,30);
  const last=await f.session.call('last','relay_harness_status',{offset:30,limit:20})as any;assert.equal(last.changes.length,5);assert.equal(last.nextOffset,null);
  assert.deepEqual(f.changes.map(row=>row.checkLog.length),lengths);assert.equal(f.store.get('workspace-tool','run:first').status,'complete');
  for(const args of [{offset:-1},{offset:0.5},{limit:21},{limit:0}])await assert.rejects(f.bound.call('bad-'+JSON.stringify(args),'relay_harness_status',args),/integer|limit|offset/i);
 }finally{f.close();}
});

test('check-log pages are read-only, bounded, revision-aware and retry safe after invalid input',async()=>{
 const f=fixture();try{
  const a=await f.session.call('log-a','relay_read_change_check_log',{changeId:'draft-0'})as any;
  assert.equal(a.content.length,12000);assert.equal(a.offset,0);assert.equal(a.total,f.changes[0].checkLog.length);assert.equal(a.nextOffset,12000);assert.equal(a.revision,'a'.repeat(64));assert.equal(a.status,'failed');
  const b=await f.session.call('log-b','relay_read_change_check_log',{changeId:'draft-0',offset:a.nextOffset,length:17,revision:a.revision})as any;
  assert.equal(b.content,f.changes[0].checkLog.slice(12000,12017));assert.equal(b.nextOffset,12017);assert.equal(f.mutations,0);
  await assert.rejects(f.bound.call('stale','relay_read_change_check_log',{changeId:'draft-0',revision:'b'.repeat(64)}),/revision|changed/i);
  await assert.rejects(f.bound.call('bad-length','relay_read_change_check_log',{changeId:'draft-0',length:12001}),/length|12000/i);
  assert.equal(f.store.get('workspace-tool','run:bad-length').failure.boundary,'read_only');
  const corrected=await f.bound.call('corrected','relay_read_change_check_log',{changeId:'draft-0',length:10})as any;assert.equal(corrected.content.length,10);assert.equal(f.mutations,0);
 }finally{f.close();}
});

test('status paging remains below 64 KiB for adversarial metadata and keeps the global bridge cap',async()=>{
 const f=fixture();try{
  for(const row of f.changes){row.title='界'.repeat(160);row.workspaceDirectory='界'.repeat(2000);row.error='界'.repeat(4000);row.previewUrl='界'.repeat(2000);}
  const result=await f.session.call('unicode','relay_harness_status',{limit:20})as any;assert.ok(Buffer.byteLength(JSON.stringify(result))<65536);assert.ok(result.changes.length>0);assert.ok(result.changes.length<=20);assert.equal(result.nextOffset,result.changes.length);
  const oversized=createAppToolSession({definitions:[{name:'relay_fixture',description:'Synthetic bounded transport',inputSchema:{type:'object'}}],call:async()=>({content:'x'.repeat(1048576)})},new AbortController().signal);
  try{await assert.rejects(oversized.call('oversized','relay_fixture',{}),/safety limit/);}finally{oversized.close();}
 }finally{f.close();}
});
