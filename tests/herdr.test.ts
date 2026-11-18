import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ChildRegistry } from '../server/herdr/registry.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { HerdrHost, processGone, type WorkerJob } from '../server/herdr/host.js';
import { FrameReader, FRAME_LIMIT, frame, validateFrame, validateJob } from '../server/herdr/protocol.js';
import { killOwned } from '../server/providers/process.js';
import type { HerdrRuntimeContract, PaneHandle, Binding } from '../server/herdr/types.js';
const binding: Binding = { token: 'a'.repeat(64), epoch: 'one', delegationId: 'd', parentRunId: 'p', expiresAt: Date.now() + 60_000 };
test('bridge rejects foreign, expired, duplicate, unauthorized and malformed frames', () => {
  const good = frame(binding, 1, 'ready', { pid: 123, conpty: true });
  assert.equal(validateFrame(good, binding, 0, ['ready']).seq, 1);
  for (const patch of [{ token: 'b'.repeat(64) }, { token: 'é'.repeat(64) }, { parentRunId: 'foreign' }, { delegationId: 'foreign' }, { epoch: 'foreign' }, { seq: 2 }, { v: 2 }, { type: 'answer' }, { payload: { pid: -1, conpty: true } }, { injected: true }])
    assert.throws(() => validateFrame({ ...good, ...patch }, binding, 0, ['ready']), /Invalid/);
  assert.throws(() => validateFrame(good, binding, 1, ['ready']), /duplicate/);
  assert.throws(() => validateFrame(good, binding, 0, ['ready'], binding.expiresAt + 1), /expired/);
});
test('native question IDs remain opaque and usage cannot smuggle invalid values', () => {
  const value = frame(binding, 1, 'interaction', { id: 'request', prompt: { kind: 'question', title: 'Q', description: 'Pick', questions: ['constructor','__proto__','选择 one'].map(id => ({ id, question: 'Choose?', multiple: false, options: ['A'] })) } });
  assert.doesNotThrow(() => validateFrame(value, binding, 0, ['interaction']));
  assert.throws(() => validateFrame({ ...value, payload: { ...value.payload, prompt: { ...value.payload.prompt, questions: [{ id: 'x', question: 'Q', multiple: 'yes' }] } } }, binding, 0, ['interaction']));
  for (const usage of [{ inputTokens: 'secret', outputTokens: 1 }, { inputTokens: -1, outputTokens: 1 }, { inputTokens: 1, outputTokens: Infinity }, { inputTokens: 1, outputTokens: 1, cachedInputTokens: NaN }])
    assert.throws(() => validateFrame(frame(binding, 1, 'result', { result: { text: 'ok', usage }, executionVerified: true, evidence: [] }), binding, 0, ['result']));
});
test('reader bounds split UTF8 frames and rejects malformed and oversized input', () => {
  const seen: unknown[] = [], reader = new FrameReader(v => seen.push(v));
  const bytes = Buffer.from(JSON.stringify({ text: '😀' }) + '\n');
  for (const byte of bytes) reader.push(Buffer.from([byte]));
  assert.deepEqual(seen, [{ text: '😀' }]);
  assert.throws(() => new FrameReader(() => {}).push(Buffer.from('{bad}\n')), /Malformed/);
  assert.throws(() => new FrameReader(() => {}).push(Buffer.alloc(FRAME_LIMIT + 1, 65)), /size/);
});
function job(id: string, workspace?: string, instructions = 'fixture'): WorkerJob { return { delegationId: id, parentRunId: 'parent', agentId: 'worker', provider: 'openai', request: { runId: 'run-' + id, conversationId: 'conversation', model: 'fixture-model', instructions, history: [{ role: 'user', content: 'Only my assignment' }], maxSeconds: 15, expectedAccount: { accountLabel: 'fixture@example.test', plan: 'test' }, ...(workspace ? { workspace } : {}) } }; }
test('jobs retain strict identities, account and mode while Cursor Agent is rejected', () => {
  assert.doesNotThrow(() => validateJob(job('valid')));
  assert.throws(() => validateJob({ ...job('valid'), provider: 'cursor', request: { ...job('valid').request, mode: 'agent', workspace: process.cwd() } }), /Cursor Agent/);
  assert.throws(() => validateJob({ ...job('valid'), otherBotPrivateContext: 'secret' }), /identity/);
  assert.throws(() => validateJob({ ...job('valid'), request: { ...job('valid').request, interact: 'approve' } }), /request/);
});
async function fixture(options: { delayStart?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'relay-herdr-test-'));
  const script = join(dir, 'worker.mjs');
  const entry = new URL('../server/herdr/worker.ts', import.meta.url).href;
  const processModule = new URL('../server/providers/process.ts', import.meta.url).href;
  await writeFile(script, "import{runWorker}from" + JSON.stringify(entry) + ";import{killOwned}from" + JSON.stringify(processModule) + ";import{readFileSync,writeFileSync}from'node:fs';" +
    "await runWorker(process.argv[2],{createAdapter(provider,dataDir,launcher){writeFileSync(dataDir+'/adapter-invoked','started');let child;return{id:provider,inspect:async()=>{throw Error('not needed')},login:async()=>{throw Error('never login')},async stream(request,emit,signal){" +
    "if(request.instructions==='images'){const{createHash}=await import('node:crypto');const images=request.imageTable||[];return{text:JSON.stringify(images.map(i=>({id:i.attachmentId,message:i.messageId,digest:createHash('sha256').update(Buffer.from(i.data,'base64')).digest('hex'),size:Buffer.from(i.data,'base64').length}))),actualModel:request.model};}const waiting=request.instructions==='wait';const code=request.instructions==='orphan'?\"const{spawn}=require('node:child_process');const{writeFileSync}=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true,detached:true});writeFileSync(process.argv[1],String(c.pid));c.unref();\":waiting?\"const{spawn}=require('node:child_process');const{writeFileSync}=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});writeFileSync(process.argv[1],String(c.pid));setInterval(()=>{},1000);\":\"setTimeout(()=>{},20)\";" +
    "child=launcher({file:process.execPath,args:[]},['-e',code,request.workspace+'/grandchild.pid'],request.workspace||dataDir,process.env);" +
    "let text=request.instructions==='unicode'?'中'.repeat(200000):request.instructions.startsWith('escaped')?String.fromCharCode(0).repeat(100000):'fixture-result';if(request.instructions==='approval'){const answer=await request.interact({kind:'approval',title:'Fixture permission',description:'Allow this one action?'},signal);text=answer.decision;}" +
    "if(request.instructions==='questions'){const answer=await request.interact({kind:'question',title:'Fixture question',description:'Pick',questions:[{id:'选择 one',question:'Choose?',options:['A'],multiple:false},{id:'__proto__',question:'Other?',options:['B']}]},signal);text=JSON.stringify(answer.answers);}" +
    "if(waiting)await new Promise((done,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));else await new Promise(done=>child.once('close',done));" +
    "if(text.length<10000||request.instructions==='escaped-delta')emit({type:'delta',text});return{text,actualModel:request.instructions==='drift'?'other-model':request.model}},async close(){if(child)await killOwned(child)}}}});" );
  let launches = 0;
  const owned = new Map<string, ChildProcessWithoutNullStreams>();
  const runtime: HerdrRuntimeContract = { inspect: async () => ({ available: true, version: 'fixture' }),
    start: async (command, cwd, env) => { launches++; const child = spawn(command[0], command.slice(1), { cwd, env, windowsHide: true, stdio: 'pipe' }); child.stderr.on('data', () => {}); const paneId = 'fixture-' + launches; owned.set(paneId, child); if (options.delayStart) await new Promise(r => setTimeout(r, options.delayStart)); return { workspaceId: 'fixture', paneId }; },
    closePane: async (pane: PaneHandle) => { const child = owned.get(pane.paneId); if (child) await killOwned(child); } };
  const host = new HerdrHost(dir, { runtime, workerCommand: [process.execPath, '--import', import.meta.resolve('tsx'), script], startupTimeoutMs: options.delayStart ? 50 : 10000, stopTimeoutMs: 3000 });
  return { dir, host, runtime, launches: () => launches, crashBridge: () => [...owned.values()].at(-1)?.kill('SIGKILL'), close: async () => { await host.close().catch(() => {}); for (const child of owned.values()) await killOwned(child); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } };
}
test('host runs the real bridge once, preserves context and does not certify a model claim', async () => {
  const f = await fixture(); try {
    const input = job('one', f.dir), events: unknown[] = [],inferences:any[]=[];
    const a = f.host.execute(input, e => events.push(e), async () => ({ decision: 'deny' }), new AbortController().signal,undefined,value=>inferences.push(value));
    const b = f.host.execute(input, () => {}, async () => ({ decision: 'deny' }), new AbortController().signal);
    assert.strictEqual(a, b);
    const outcome = await a;
    assert.equal(outcome.result.text, 'fixture-result'); assert.equal(outcome.executionVerified, false);
    assert.deepEqual(inferences.map(value=>value.phase),['started','completed']);assert.equal(inferences[1].result.text,'');
    assert.ok(events.length); assert.equal(f.launches(), 1);
    assert.deepEqual(await f.host.execute(input, () => {}, async () => ({ decision: 'deny' }), new AbortController().signal,undefined,value=>inferences.push(value)), outcome);
    assert.equal(inferences.length,2,'Saved outcome reads never report another actual inference');
    assert.equal(f.launches(), 1);
    await assert.rejects(f.host.execute({ ...input, request: { ...input.request, model: 'changed' } }, () => {}, async () => ({ decision: 'deny' }), new AbortController().signal), /identity/);
    assert.equal((await f.host.reconcile('one')).stopped, true);
  } finally { await f.close(); }
});
test('native approvals forward allow and deny once and opaque question answers survive', async () => {
  const f = await fixture(); try {
    for (const decision of ['allow','deny'] as const) {
      let interactions = 0; const input = job('approval-' + decision, f.dir, 'approval'); input.request.mode = 'agent';
      const result = await f.host.execute(input, () => {}, async prompt => { interactions++; assert.equal(prompt.kind, 'approval'); return { decision }; }, new AbortController().signal);
      assert.equal(result.result.text, decision); assert.equal(interactions, 1);
    }
    const input = job('questions', f.dir, 'questions'); input.request.mode = 'agent';
    const result = await f.host.execute(input, () => {}, async prompt => ({ decision: 'allow', answers: Object.fromEntries(prompt.questions!.map((q, i) => [q.id, [i ? 'B' : 'A']])) }), new AbortController().signal);
    assert.deepEqual(JSON.parse(result.result.text), JSON.parse('{"选择 one":["A"],"__proto__":["B"]}'));
  } finally { await f.close(); }
});
// Synthetic provider readiness includes cold TSX import and the real Windows C# job guard.
// Keep this bounded separately from cancellation/cleanup assertions and the explicit timeout test.
async function fixturePid(path: string): Promise<number> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { const pid = Number(await readFile(path, 'utf8')); if (Number.isSafeInteger(pid) && pid > 0) return pid; }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(done => setTimeout(done, 40));
  }
  throw Error('Synthetic native worker did not become ready within 30 seconds: ' + path);
}

test('Stop terminates the owned provider child and its actual descendant before cancellation resolves', async () => {
  const f = await fixture(); try {
    const controller = new AbortController(), input = job('stop', f.dir, 'wait');
    const running = f.host.execute(input, () => {}, async () => ({ decision: 'deny' }), controller.signal);
    void running.catch(() => {});
    const grandchild = await fixturePid(join(f.dir, 'grandchild.pid'));
    assert.ok(grandchild > 0); assert.equal(processGone(grandchild), false);
    controller.abort(); await assert.rejects(running, /cancelled/);
    assert.equal(processGone(grandchild), true); assert.equal((await f.host.reconcile('stop')).stopped, true);
  } finally { await f.close(); }
});
test('missing runtime and Cursor Agent never launch; native model drift fails without replay', async () => {
  const f = await fixture(); try {
    const missing = new HerdrHost(f.dir, { runtime: { ...f.runtime, inspect: async () => ({ available: false, error: 'Herdr unavailable' }) } });
    await assert.rejects(missing.execute(job('missing'), () => {}, async () => ({ decision: 'deny' }), new AbortController().signal), /unavailable/);
    assert.equal(f.launches(), 0); await missing.close();
    await assert.rejects(f.host.execute(job('drift', f.dir, 'drift'), () => {}, async () => ({ decision: 'deny' }), new AbortController().signal), /unexpected model/);
    assert.equal(f.launches(), 1);
  } finally { await f.close(); }
});

test('a host timeout permanently revokes start even when the pane launch acknowledges late', async () => {
  const f = await fixture({ delayStart: 1800 }); try {
    const input = job('late-start', f.dir); input.request.maxSeconds = 1;
    await assert.rejects(f.host.execute(input, () => {}, async () => ({ decision: 'deny' }), new AbortController().signal), /timed out|unknown/);
    await assert.rejects(readFile(join(f.dir, 'adapter-invoked')), /ENOENT/);
    assert.equal(f.launches(), 1);
  } finally { await f.close(); }
});
test('reconciliation unions the durable child journal after a lost child frame and refuses incomplete proof', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-herdr-registry-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
  const oldBridge = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
  const bridgePid = oldBridge.pid!; await new Promise(done => oldBridge.once('close', done));
  const identity = { delegationId: 'lost-child-frame', parentRunId: 'parent', epoch: 'epoch' }, key = 'b'.repeat(64);
  const jobDir = join(dir, 'herdr', 'jobs', createHash('sha256').update(identity.delegationId).digest('hex'));
  await mkdir(jobDir, { recursive: true });
  await writeFile(join(jobDir, 'receipt.json'), JSON.stringify({ ...identity, registryKey: key, pids: [bridgePid], status: 'unknown' }));
  const registry = new ChildRegistry(join(jobDir, 'children.jsonl'), identity, key);
  registry.append('worker', { pid: bridgePid }); registry.append('intent', { launchId: 'provider' }); registry.append('spawn', { launchId: 'provider', pid: child.pid! });
  const host = new HerdrHost(dir);
  try {
    assert.equal((await host.reconcile(identity.delegationId)).stopped, false);
    child.kill(); await new Promise(done => child.once('close', done));
    assert.equal((await host.reconcile(identity.delegationId)).stopped, false, 'Missing durable cleanup cannot become proof just because the bridge exited');
    registry.append('exit', { launchId: 'provider', pid: child.pid! }); registry.append('complete', { cleanup: true, treeScope: 'windows-job' });
    assert.equal((await host.reconcile(identity.delegationId)).stopped, true);
    const source = await readFile(join(jobDir, 'children.jsonl'), 'utf8'); await writeFile(join(jobDir, 'children.jsonl'), source.replace('provider', 'foreign'));
    assert.equal((await host.reconcile(identity.delegationId)).stopped, false, 'Foreign or tampered registration must not clear quarantine');
  } finally { child.kill(); await host.close(); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
test('kernel containment kills a detached descendant after its provider root has already exited', async () => {
  const f = await fixture(); try {
    const outcome = await f.host.execute(job('orphan-root', f.dir, 'orphan'), () => {}, async () => ({ decision: 'deny' }), new AbortController().signal);
    const orphanPid = Number(await readFile(join(f.dir, 'grandchild.pid'), 'utf8'));
    assert.equal(outcome.result.text, 'fixture-result'); assert.ok(orphanPid > 0); assert.equal(processGone(orphanPid), true);
    assert.equal((await f.host.reconcile('orphan-root')).stopped, true);
  } finally { await f.close(); }
});
test('abrupt bridge death closes the guard job but never fabricates a completed cleanup proof', async () => {
  const f = await fixture(); try {
    const running = f.host.execute(job('crash', f.dir, 'wait'), () => {}, async () => ({ decision: 'deny' }), new AbortController().signal);
    void running.catch(() => {});
    const descendant = await fixturePid(join(f.dir, 'grandchild.pid'));
    assert.ok(descendant > 0); assert.equal(processGone(descendant), false);
    f.crashBridge(); await assert.rejects(running, error => (error as any).code === 'HERDR_OUTCOME_UNKNOWN');
    for (let i = 0; i < 100 && !processGone(descendant); i++) await new Promise(r => setTimeout(r, 40));
    assert.equal(processGone(descendant), true);
    assert.equal((await f.host.reconcile('crash')).stopped, false, 'Kernel assignment is not a final drain proof');
  } finally { await f.close(); }
});
test('parent rechecks admission after asynchronous runtime boot before granting provider start',async()=>{for(const revoked of [false,true]){const f=await fixture();let entered!:()=>void,release!:()=>void;const booted=new Promise<void>(done=>entered=done),hold=new Promise<void>(done=>release=done),start=f.runtime.start;let allowed=true,guards=0;f.runtime.start=async(...args)=>{const pane=await start(...args);entered();await hold;return pane;};try{const pending=f.host.execute(job('final-admission-'+revoked,f.dir),()=>{},async()=>({decision:'deny'}),new AbortController().signal,()=>{guards++;if(!allowed)throw Error('Automatic model policy revoked at final start');});await booted;allowed=!revoked;release();if(revoked){await assert.rejects(pending,/revoked|unknown/i);await assert.rejects(readFile(join(f.dir,'adapter-invoked')),/ENOENT/);}else{assert.equal((await pending).result.text,'fixture-result');assert.equal(await readFile(join(f.dir,'adapter-invoked'),'utf8'),'started');}assert.equal(guards,1);}finally{release();await f.close();}}});

test('long Unicode and escaped final results cross bounded frames exactly with proven cleanup',async()=>{
 const f=await fixture();try{for(const kind of ['unicode','escaped','escaped-delta']){
  const deltas:string[]=[];const outcome=await f.host.execute(job('large-'+kind,f.dir,kind),event=>{if(event.type==='delta')deltas.push(event.text);},async()=>({decision:'deny'}),new AbortController().signal);
  assert.equal(outcome.result.text,kind==='unicode'?'中'.repeat(200000):String.fromCharCode(0).repeat(100000));assert.equal((await f.host.reconcile('large-'+kind)).stopped,true);
  if(kind==='escaped-delta')assert.equal(deltas.join(''),outcome.result.text);
 }}finally{await f.close();}
});

test('original images cross real bridge in chunks without durable bytes and immutable identity',async()=>{
 const f=await fixture();try{for(const count of [1,4]){
  const input=job('images-'+count,f.dir,'images');const images=Array.from({length:count},(_,i)=>{const bytes=Buffer.alloc(count===1?300000:4*1024*1024,73+i);return {attachmentId:'image-'+i,messageId:'original-'+i,sha256:createHash('sha256').update(bytes).digest('hex'),mimeType:'image/png' as const,width:1,height:1,data:bytes.toString('base64')};});
  input.request.history=images.map(i=>({role:'user',content:'inspect original',messageId:i.messageId,imageRefs:[i.attachmentId]}));
  let bootstrap='';const previous=f.runtime.start;f.runtime.start=async(...args)=>{bootstrap=await readFile(args[0].at(-1)!,'utf8');return previous(...args);};
  const events:unknown[]=[];let finalChecks=0;
  const outcome=await f.host.execute(input,e=>events.push(e),async()=>({decision:'deny'}),new AbortController().signal,()=>{finalChecks++;},undefined,images);
  assert.equal(finalChecks,1);assert.deepEqual(JSON.parse(outcome.result.text),images.map(i=>({id:i.attachmentId,message:i.messageId,digest:i.sha256,size:Buffer.from(i.data,'base64').length})));
  assert.ok(Buffer.byteLength(bootstrap)<128*1024);assert.equal(bootstrap.includes('imageTable'),false);
  const receipt=await readFile(join(f.dir,'herdr','jobs',createHash('sha256').update(input.delegationId).digest('hex'),'receipt.json'),'utf8');
  for(const i of images){assert.equal(bootstrap.includes(i.data.slice(0,1000)),false);assert.equal(receipt.includes(i.data.slice(0,1000)),false);assert.equal(JSON.stringify(events).includes(i.data.slice(0,1000)),false);}
  assert.deepEqual(await f.host.execute(input,()=>{},async()=>({decision:'deny'}),new AbortController().signal,undefined,undefined,images),outcome);
  await assert.rejects(f.host.execute(input,()=>{},async()=>({decision:'deny'}),new AbortController().signal,undefined,undefined,images.map((i,n)=>n?i:{...i,width:2})),/identity/);
  f.runtime.start=previous;
 }}finally{await f.close();}
});
