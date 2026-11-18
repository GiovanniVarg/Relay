import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {HarnessChanges} from '../server/harness-changes.js';
async function fixture(mode:'fail'|'cancel'|'unknown'='fail'){
 const root=await mkdtemp(join(tmpdir(),'relay-check-diagnostics-')),install=join(root,'install'),data=join(root,'data'),workspaces=join(root,'work');
 for(const path of ['server','client','tests','node_modules/typescript/bin'])await mkdir(join(install,path),{recursive:true});await mkdir(data);
 for(const [path,content]of Object.entries({'package.json':'{}','package-lock.json':'{}','server/index.ts':'// fixture','tests/example.test.ts':'// fixture','node_modules/typescript/bin/tsc':'// fixture'}))await writeFile(join(install,path),content);
 let entered!:()=>void;const started=new Promise<void>(done=>entered=done);let release!:()=>void;const gate=new Promise<void>(done=>release=done),lifecycle:string[]=[];
 const options={installDirectory:install,dataDirectory:data,workspacesDirectory:workspaces,commandRunner:async(command:any,output:(text:string)=>void)=>{
  if(!command.args.includes('--test'))return;
  output('not ');output('ok 1 - early private source assertion\n  ---\n  failureType: testCodeFailure\n  error: expected source.md to remain untrusted\n  code: ERR_ASSERTION\n  ...\n');
  for(let i=0;i<2500;i++)output('ok '+(i+2)+' - a later passing test with repeated progress data '.repeat(3)+'\n');
  output('# tests 2501\n# pass 2500\n# fail 1\n');entered();
  if(mode==='cancel')await new Promise<void>((_,reject)=>{if(command.signal.aborted)reject(Error('Checks cancelled'));else command.signal.addEventListener('abort',()=>reject(Error('Checks cancelled')),{once:true});});
  else{await gate;throw Object.assign(Error(mode==='unknown'?'Check termination is unproven':'Check command exited 1'),mode==='unknown'?{code:'HARNESS_CHECK_OUTCOME_UNKNOWN'}:{});}
 }};
 const service=new HarnessChanges(options);
 return{root,service,options,started,release:()=>release(),lifecycle,async close(){release();await service.close();await rm(root,{recursive:true,force:true});}};
}
test('early TAP failure survives a long passing tail in checking, failed and reloaded status',async()=>{
 const f=await fixture();try{
  const change=await f.service.create({title:'Retained failure'}),pending=f.service.check(change.id,{commandLifecycle:s=>f.lifecycle.push(s)}),rejected=assert.rejects(pending,/Check command exited 1/);
  await f.started;const during=await f.service.get(change.id);assert.equal(during.status,'checking');assert.match(during.checkLog,/early private source assertion/);assert.match(during.checkLog,/expected source.md to remain untrusted/);assert.ok(during.checkLog.length<=120000);assert.match(during.checkLog,/# fail 1/);
  f.release();await rejected;const failed=await f.service.get(change.id);assert.equal(failed.status,'failed');assert.equal(failed.checkedRevision,null);assert.match(failed.checkLog,/not ok 1 - early private source assertion/);assert.match(failed.checkLog,/ERR_ASSERTION/);assert.match(failed.checkLog,/Check command exited 1/);assert.ok(failed.checkLog.length<=120000);
  const restored=new HarnessChanges(f.options);try{await restored.initialize();assert.equal((await restored.get(change.id)).checkLog,failed.checkLog);}finally{await restored.close();}
 }finally{await f.close();}
});
test('failure retention preserves cancellation and unknown termination lifecycle semantics',async()=>{
 for(const mode of ['cancel','unknown'] as const){const f=await fixture(mode);try{
  const change=await f.service.create({title:mode}),controller=new AbortController(),pending=f.service.check(change.id,{signal:controller.signal,commandLifecycle:s=>f.lifecycle.push(s)}),rejected=assert.rejects(pending,mode==='cancel'?/Checks cancelled/:/termination is unproven/);
  await f.started;if(mode==='cancel')controller.abort();else f.release();await rejected;const failed=await f.service.get(change.id);assert.equal(failed.status,'failed');assert.equal(failed.checkedRevision,null);assert.equal(f.service.busyCount(),0);assert.match(failed.checkLog,/early private source assertion/);assert.equal(f.lifecycle.at(-1),mode==='unknown'?'unknown':'drained');
 }finally{await f.close();}}
});
