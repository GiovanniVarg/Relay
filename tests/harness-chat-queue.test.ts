import test from 'node:test';
import assert from 'node:assert/strict';
import {HarnessUpdates,type ActivationStatus} from '../server/harness-updates.js';

function fixture(){
 let revision='one',active=1,state={agentId:'bot',mode:'agent',status:'running'};
 const calls:string[]=[];
 class Updates extends HarnessUpdates{override async apply(changeId:string,value:string):Promise<ActivationStatus>{calls.push(value);assert.equal(active,0);assert.equal(state.status,'complete');if(value!==revision)throw Error('draft changed');return {changeId,status:'pending'};}}
 const updates=new Updates({get:async()=>({revision,status:'ready',checkedRevision:revision})}as never,{installDirectory:'unused',dataDirectory:'unused',port:()=>3210,activeCount:()=>active,restart:async()=>{},runState:()=>state});
 return {updates,calls,finish(){state.status='complete';active=0;},fail(status='cancelled'){state.status=status;active=0;},edit(){revision='two';},otherWork(){active=1;},idle(){active=0;}};
}
const request={runId:'run',agentId:'bot',requestKey:'run:call'};
const settle=()=>new Promise(done=>setTimeout(done,320));
test('chat self apply returns a receipt, waits for own reply and all other work, deduplicates',async()=>{const f=fixture();try{const first=await f.updates.requestApply('draft','one',request);assert.equal(first.status,'queued');assert.deepEqual(await f.updates.requestApply('draft','one',request),first);await settle();assert.equal(f.calls.length,0);f.finish();f.otherWork();await settle();assert.equal(f.calls.length,0);f.idle();await settle();assert.deepEqual(f.calls,['one']);assert.equal((await f.updates.status())?.status,'pending');}finally{f.updates.close();}});
test('cancelled owner cannot activate a queued chat change',async()=>{const f=fixture();try{await f.updates.requestApply('draft','one',request);f.fail();await settle();assert.equal(f.calls.length,0);assert.equal((await f.updates.status())?.status,'cancelled');}finally{f.updates.close();}});
test('stale revision and changed duplicate requests are rejected',async()=>{const f=fixture();try{await f.updates.requestApply('draft','one',request);await assert.rejects(f.updates.requestApply('other','one',request),/reused/);f.edit();f.finish();await settle();assert.equal(f.calls.length,0);assert.equal((await f.updates.status())?.status,'failed');}finally{f.updates.close();}});
test('only a live Agent run can queue an activation',async()=>{const f=fixture();try{await assert.rejects(f.updates.requestApply('draft','one',{...request,agentId:'other'}),/authority/);f.finish();await assert.rejects(f.updates.requestApply('draft','one',request),/authority/);}finally{f.updates.close();}});
test('failed and interrupted owner runs invalidate queued activation',async()=>{for(const status of ['failed','interrupted']){const f=fixture();try{await f.updates.requestApply('draft','one',request);f.fail(status);await settle();assert.equal(f.calls.length,0);assert.equal((await f.updates.status())?.status,'cancelled');}finally{f.updates.close();}}});
test('simultaneous duplicate calls share one queued receipt; close discards the queue',async()=>{const f=fixture();try{const [a,b]=await Promise.all([f.updates.requestApply('draft','one',request),f.updates.requestApply('draft','one',request)]);assert.deepEqual(a,b);f.updates.close();f.finish();await settle();assert.equal(f.calls.length,0);}finally{f.updates.close();}});
