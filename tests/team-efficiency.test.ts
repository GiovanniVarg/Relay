import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePlan} from '../server/delegation/plan.js';

test('lead may dispatch only the smallest useful selected subset',()=>{
 const assignment={workerId:'a',task:'Research',expectedResult:'Cited facts',dependsOn:[]};
 assert.deepEqual(parsePlan(JSON.stringify({assignments:[assignment]}),['a','b']),{assignments:[assignment]});
 assert.throws(()=>parsePlan(JSON.stringify({assignments:[{...assignment,dependsOn:['b']}]}),['a','b']),/depend/i);
 assert.throws(()=>parsePlan(JSON.stringify({assignments:[]}),['a','b']));
});

import {resultCapsule} from '../server/delegation/capsule.js';
import {recordUsageDispatch} from '../server/usage-dispatch.js';
import {normalizeUsage} from '../shared/provider-usage.js';

test('long result capsules remain attributed, bounded and explicit about omitted evidence',()=>{
 const result='x'.repeat(200000);const capsule=resultCapsule({id:'r',parentRunId:'p',workerId:'w',workerName:'Worker',task:'Task',expectedResult:'Result',dependsOn:[],status:'complete',mode:'chat',workspace:'',route:null,result,evidence:[],executionVerified:false});
 assert.ok(JSON.stringify(capsule).length<5000);assert.equal(capsule.resultCharacters,result.length);assert.equal(capsule.resultTruncated,true);assert.equal(capsule.executionVerified,false);assert.match(capsule.resultSha256,/^[a-f0-9]{64}$/);assert.equal(capsule.delegationId,'r');
});
test('worker dispatch usage is once, account attributed, missing counters unknown and snapshots separate',()=>{
 const rows=new Map<string,unknown>();const store={get:(_kind:string,id:string)=>rows.get(id),put:(_kind:string,row:any)=>{rows.set(row.id,row);return row;}} as any;
 const request={runId:'worker',conversationId:'session',model:'model'};
 const sessionUsage=normalizeUsage({inputTokens:999},{provider:'openai',accountKey:'other-account',source:'cursor-sdk',scope:'agent',observedAt:new Date().toISOString(),sessionId:'native'});
 const first=recordUsageDispatch(store,{id:'dispatch',provider:'openai',accountKey:'account',request,result:{text:'ok',sessionId:'native',usageCounters:{outputTokens:7},sessionUsage},parentRunId:'parent',agentId:'employee'});
 assert.equal(first.usageObservation.tokens.inputTokens,null);assert.equal(first.usageObservation.tokens.outputTokens,7);assert.equal(first.usageObservation.accountKey,'account');assert.equal(first.sessionUsage,undefined);
 recordUsageDispatch(store,{id:'dispatch',provider:'openai',accountKey:'account',request,result:{text:'reconnect',usage:{inputTokens:99,outputTokens:99}}});assert.equal(rows.size,1);
 const missing=recordUsageDispatch(store,{id:'failure',provider:'openai',accountKey:null,request});assert.equal(missing.usageObservation.availability,'unavailable');assert.equal(missing.usageObservation.tokens.inputTokens,null);assert.equal(missing.usageObservation.tokens.outputTokens,null);assert.equal(missing.usageObservation.accountKey,null);
});

test('native inference metadata rejects malformed counters and never sends full result text',()=>{
 const binding={token:'a'.repeat(64),epoch:'epoch',delegationId:'d',parentRunId:'p',expiresAt:Date.now()+10000};
 const good={phase:'completed',result:{text:'',usageCounters:{outputTokens:4}}};
 assert.doesNotThrow(()=>validateFrame(frame(binding,1,'inference',good),binding,0,['inference']));
 for(const patch of [{usageCounters:{outputTokens:-1}},{usageCounters:{outputTokens:'secret'}},{sessionId:{}},{actualModel:{}},{text:'full transcript'}])assert.throws(()=>validateFrame(frame(binding,1,'inference',{phase:'completed',result:{...good.result,...patch}}),binding,0,['inference']));
});
import {frame,validateFrame} from '../server/herdr/protocol.js';

import {resultFrames,FRAME_LIMIT,FrameReader} from '../server/herdr/protocol.js';
test('large encoded results use authenticated bounded exact chunks and pinned aggregate manifests',()=>{
 const binding={token:'a'.repeat(64),epoch:'epoch',delegationId:'d',parentRunId:'p',expiresAt:Date.now()+10000};
 for(const text of ['中'.repeat(200000),String.fromCharCode(0).repeat(100000),'😀'.repeat(100000)]){
  const frames=resultFrames(binding,0,{result:{text},executionVerified:false,evidence:[]});let seq=0;const decoded:any[]=[];const reader=new FrameReader(value=>{const valid=validateFrame(value,binding,seq,['resultChunk','result']);seq=valid.seq;decoded.push(valid);});
  for(const value of frames){const bytes=Buffer.from(JSON.stringify(value)+'\n');assert.ok(bytes.length-1<=FRAME_LIMIT);reader.push(bytes);}
  const final=decoded.at(-1)!.payload;
  if(Buffer.byteLength(JSON.stringify({result:{text}}))>FRAME_LIMIT){assert.ok(frames.length>1);assert.equal(decoded.slice(0,-1).map(frame=>frame.payload.text).join(''),text);assert.equal(final.textManifest.characters,text.length);assert.equal(final.textManifest.chunks,decoded.length-1);}
  else{assert.equal(frames.length,1);assert.equal(final.result.text,text);}
  assert.throws(()=>validateFrame(decoded[0],{...binding,delegationId:'foreign'},0,['resultChunk']));assert.throws(()=>validateFrame(decoded[0],binding,1,['resultChunk']));
  assert.throws(()=>validateFrame(frame(binding,1,'resultChunk',{index:4,text:'extra'}),binding,0,['resultChunk']));
 }
});
