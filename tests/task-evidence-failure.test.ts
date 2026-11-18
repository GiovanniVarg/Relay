import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {Artifacts} from '../server/artifacts.js';
import {Tasks} from '../server/tasks.js';
import {taskEvidence} from '../server/task-evidence.js';
import type {Agent} from '../shared/types.js';
import type {HarnessChange} from '../shared/harness-changes.js';
import type {Task,TaskEvidence,TaskRunSnapshot} from '../shared/tasks.js';

const complete={state:'complete',summary:'Saved and checked output',remaining:[],evidence:[]} as const;
async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'relay-terminal-evidence-')),store=new Store(dir),artifacts=new Artifacts(store);
  const [a,b]=store.list<Agent>('agent'),snapshots=new Map<string,TaskRunSnapshot>(),starts:Task[]=[],recorded=new Map<string,TaskEvidence[]>();
  let beforeVerify:()=>Promise<void>=async()=>{},currentChange:()=>Promise<HarnessChange>=async()=>({id:'change',revision:'one',checkedRevision:'one',status:'ready'}) as HarnessChange;
  const tasks=new Tasks(store,{
    start:async task=>{
      starts.push(task);const runId='run-'+starts.length,conversationId=store.conversations(task.agentId)[0].id;
      store.put('run',{id:runId,agentId:task.agentId,conversationId,status:'running'});snapshots.set(runId,{status:'running'});
      return{runId,conversationId};
    },
    snapshot:runId=>snapshots.get(runId),cancel:async runId=>{snapshots.set(runId,{status:'cancelled'});},
    verifyEvidence:async(task,refs)=>{await beforeVerify();return taskEvidence(store,task,refs,currentChange,id=>artifacts.verify(id));},
    recordEvidence:(runId,evidence)=>{recorded.set(runId,evidence);},
  });
  async function reported(){
    const task=tasks.create({agentId:a.id,title:'First',prompt:'Save and verify output'});await tasks.tick();const live=tasks.get(task.id);
    const artifact=await artifacts.text({agentId:a.id,runId:live.runId!,taskId:task.id,name:'answer.txt',content:'original'});
    const receiptId=live.runId+':check';store.put('workspace-tool',{id:receiptId,agentId:a.id,runId:live.runId,name:'relay_check_change',status:'complete',result:{id:'change',revision:'one',checkedRevision:'one',status:'ready'}});
    await tasks.reportOutcome(task.id,live.runId!,{...complete,evidence:[{kind:'artifact',id:artifact.id},{kind:'tool_receipt',id:receiptId}]});
    assert.equal(tasks.get(task.id).outcome?.verification,'checks_passed');
    return{task:tasks.get(task.id),artifact,receiptId};
  }
  return{store,artifacts,a,b,tasks,snapshots,starts,recorded,reported,setBeforeVerify(value:typeof beforeVerify){beforeVerify=value;},setCurrentChange(value:typeof currentChange){currentChange=value;},async close(){await tasks.close();store.close();await rm(dir,{recursive:true,force:true});}};
}

for(const failure of ['digest','missing-file','missing-receipt','unavailable-check'] as const){
  test('terminal '+failure+' evidence failure pauses only its task; queued work and later runs continue',async()=>{
    const f=await fixture();try{
      const {task,artifact,receiptId}=await f.reported(),prior=structuredClone(task.outcomeHistory);
      const second=f.tasks.create({agentId:f.b.id,title:'Second',prompt:'Independent work'});
      if(failure==='digest')await writeFile(join(f.artifacts.root,artifact.id),'modified');
      if(failure==='missing-file')await rm(join(f.artifacts.root,artifact.id));
      if(failure==='missing-receipt')f.store.db.prepare("DELETE FROM records WHERE kind='workspace-tool' AND id=?").run(receiptId);
      if(failure==='unavailable-check')f.setCurrentChange(async()=>{throw Error('Current check could not be read');});
      f.snapshots.set(task.runId!,{status:'complete',text:'Finished provider output'});
      await f.tasks.tick();await f.tasks.tick();
      const saved=f.tasks.get(task.id);
      assert.equal(saved.status,'needs_input');assert.equal(saved.recoveryRequired,true);assert.equal(saved.phase,'waiting');
      assert.equal(saved.outcome?.state,'blocked');assert.equal(saved.outcome?.verification,'unverified');assert.deepEqual(saved.outcome?.evidence,[]);
      assert.match(saved.error??'',/evidence.*revalidat/i);assert.match(saved.checkpoint,/inspect|review/i);assert.match(saved.checkpoint,/not.*replay/i);
      assert.equal(saved.result,'Finished provider output');assert.equal(saved.runId,task.runId);assert.equal(saved.attempt,1);
      assert.deepEqual(saved.outcomeHistory?.slice(0,prior?.length),prior);assert.equal(saved.outcomeHistory?.length,(prior?.length??0)+1);
      assert.deepEqual(f.recorded.get(task.runId!),[]);assert.equal(f.tasks.get(second.id).status,'working');assert.equal(f.starts.length,2);
      await f.tasks.reportOutcome(second.id,f.tasks.get(second.id).runId!,complete);
      f.snapshots.set(f.tasks.get(second.id).runId!,{status:'complete'});await f.tasks.tick();assert.equal(f.tasks.get(second.id).status,'done');
      const later=f.tasks.create({agentId:f.a.id,title:'Later',prompt:'A separate run on the original bot'});await f.tasks.tick();
      assert.equal(f.tasks.get(later.id).status,'working');assert.equal(f.starts.length,3);assert.equal(f.tasks.get(task.id).status,'needs_input');
      assert.equal(f.tasks.get(task.id).outcomeHistory?.length,saved.outcomeHistory?.length);
    }finally{await f.close();}
  });
}

test('intact actual artifact and exact ready check retain normal verified completion',async()=>{
  const f=await fixture();try{const {task}=await f.reported();f.snapshots.set(task.runId!,{status:'complete'});await f.tasks.tick();assert.equal(f.tasks.get(task.id).status,'done');assert.equal(f.tasks.get(task.id).outcome?.verification,'checks_passed');assert.ok(f.recorded.get(task.runId!)?.some(e=>e.assertion==='artifact_integrity'));assert.equal(f.starts.length,1);}finally{await f.close();}
});

test('submitted invalid references still reject without entering terminal recovery',async()=>{
  const f=await fixture();try{const {task}=await f.reported();await assert.rejects(f.tasks.reportOutcome(task.id,task.runId!,{...complete,evidence:[{kind:'artifact',id:'not-owned'}]}),/Owned artifact/);assert.equal(f.tasks.get(task.id).status,'working');assert.equal(f.tasks.get(task.id).recoveryRequired,false);assert.equal(f.tasks.get(task.id).outcome?.verification,'checks_passed');}finally{await f.close();}
});

test('terminal verifier diagnostics are bounded and redacted before task and journal persistence',async()=>{
  const f=await fixture();try{
    const {task}=await f.reported(),secret='fixture-managed-secret',token='123456:'+'A'.repeat(35);
    f.tasks.redact=<T>(value:T)=>JSON.parse(JSON.stringify(value).replaceAll(secret,'[managed-redacted]')) as T;
    f.setCurrentChange(async()=>{throw Error(secret+' '+token+' '+ 'x'.repeat(10000));});
    f.snapshots.set(task.runId!,{status:'complete'});await f.tasks.tick();const saved=f.tasks.get(task.id);
    assert.ok((saved.error?.length??0)<1400);assert.ok(saved.checkpoint.length<=24000);assert.match(saved.error??'',/managed-redacted/);assert.match(saved.error??'',/\[redacted\]/);
    const persisted=JSON.stringify([saved,f.store.list('task-journal')]);assert.equal(persisted.includes(secret),false);assert.equal(persisted.includes(token),false);
  }finally{await f.close();}
});

for(const settlement of ['resolve','reject'] as const){
  test('cancellation during pending terminal verification wins over a late '+settlement,async()=>{
    const f=await fixture();try{
      const {task}=await f.reported();let entered!:()=>void,release!:()=>void;
      const pending=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
      f.setBeforeVerify(async()=>{entered();await pending;if(settlement==='reject')throw Error('Late verifier failure');});
      f.snapshots.set(task.runId!,{status:'complete'});const tick=f.tasks.tick();await started;await f.tasks.cancel(task.id);
      const cancelled=structuredClone(f.tasks.get(task.id));release();await tick;await f.tasks.tick();
      assert.deepEqual(f.tasks.get(task.id),cancelled);assert.equal(f.tasks.get(task.id).status,'cancelled');assert.equal(f.starts.length,1);assert.equal(f.recorded.has(task.runId!),false);
    }finally{await f.close();}
  });
  test('explicit resume during pending terminal verification survives a late '+settlement,async()=>{
    const f=await fixture();try{
      const {task}=await f.reported();f.snapshots.set(task.runId!,{status:'running',pendingInteractions:1});await f.tasks.tick();
      assert.equal(f.tasks.get(task.id).status,'needs_input');let entered!:()=>void,release!:()=>void;
      const pending=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
      f.setBeforeVerify(async()=>{entered();await pending;if(settlement==='reject')throw Error('Old-attempt verifier failure');});
      f.snapshots.set(task.runId!,{status:'complete'});const tick=f.tasks.tick();await started;f.tasks.resume(task.id,true);release();await tick;
      const resumed=f.tasks.get(task.id);assert.equal(resumed.status,'working');assert.equal(resumed.attempt,2);assert.notEqual(resumed.runId,task.runId);
      assert.equal(resumed.recoveryRequired,false);assert.equal(resumed.error,null);assert.equal(f.starts.length,2);assert.deepEqual(resumed.outcomeHistory,task.outcomeHistory);
      assert.equal(f.recorded.has(task.runId!),false);
    }finally{await f.close();}
  });
}
