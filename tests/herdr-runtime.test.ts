import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { HerdrHost, processGone, type WorkerJob } from '../server/herdr/host.js';
import { HERDR_VERSION } from '../server/herdr/runtime.js';
import { childEnvironment } from '../server/providers/process.js';
const exec = promisify(execFile);
test('private pinned Herdr hosts the real typed bridge in Windows ConPTY without model inference', {
  skip: process.platform !== 'win32' || process.env.RELAY_HERDR_RUNTIME_TEST !== '1', timeout: 60_000,
}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-herdr-real-'));
  const session = 'relay-fixture-' + crypto.randomUUID().slice(0,8);
  const entry = new URL('../server/herdr/worker.ts', import.meta.url).href;
  const processModule = new URL('../server/providers/process.ts', import.meta.url).href;
  const wrapper = join(dir, 'fixture-worker.mjs');
  await writeFile(wrapper, "import{runWorker}from" + JSON.stringify(entry) + ";import{killOwned}from" + JSON.stringify(processModule) + ";" +
    "await runWorker(process.argv[2],{createAdapter(provider,dataDir,launcher){let child;return{id:provider,inspect:async()=>{throw Error('No account access in fixture')},login:async()=>{throw Error('No login in fixture')},async stream(request,emit,signal){" +
    "const code=\"const fs=require('node:fs');fs.copyFileSync('input.txt','output.txt');process.stdout.write(JSON.stringify({method:'item/completed',params:{item:{type:'commandExecution',status:'completed',exitCode:0}}})+'\\\\n');\";" +
    "child=launcher({file:process.execPath,args:[]},['-e',code],request.workspace,process.env);await new Promise(done=>child.once('close',done));emit({type:'tool',name:'shell',summary:'Private fixture copy'});return{text:'fixture completed',actualModel:request.model}},async close(){if(child)await killOwned(child)}}}});");
  const host = new HerdrHost(dir, { session, workerCommand: [process.execPath, '--import', import.meta.resolve('tsx'), wrapper] });
  const runtimeRoot = join(dir, 'herdr', 'runtime');
  const env = { ...childEnvironment(), HERDR_CONFIG_PATH: join(runtimeRoot, 'config.toml'), APPDATA: join(runtimeRoot, 'appdata'), LOCALAPPDATA: join(runtimeRoot, 'localappdata'), XDG_CONFIG_HOME: join(runtimeRoot, 'config') };
  let serverPid = 0, success = false; t.diagnostic('Private fixture: ' + dir);
  try {
    const status = await host.inspect(); assert.equal(status.available, true, status.error); assert.equal(status.version, HERDR_VERSION);
    const input = Buffer.from('private-herdr-' + crypto.randomUUID() + '\r\n'); await writeFile(join(dir, 'input.txt'), input);
    const job: WorkerJob = { delegationId: crypto.randomUUID(), parentRunId: 'private-runtime-proof', agentId: 'fixture', provider: 'openai',
      request: { runId: 'private-runtime-proof', conversationId: 'private-runtime-proof', model: 'fixture-no-inference', mode: 'work', workspace: dir,
        instructions: 'Private fixture only', history: [{ role: 'user', content: 'Copy the private fixture' }], maxSeconds: 15, expectedAccount: { accountLabel: 'fixture@example.test', plan: 'fixture' } } };
    const outcome = await host.execute(job, () => {}, async () => { throw Error('Fixture must not request permission'); }, new AbortController().signal);
    assert.equal(outcome.result.text, 'fixture completed'); assert.equal(outcome.executionVerified, false);
    assert.deepEqual(await readFile(join(dir, 'output.txt')), input);
    assert.equal((await host.reconcile(job.delegationId)).stopped, true);
    t.diagnostic('Pinned Herdr ' + status.version + ': real ConPTY, authenticated bridge, owned provider process exit, exact fixture bytes');
    const marker = await readFile(join(env.XDG_CONFIG_HOME, 'herdr', 'sessions', session, 'herdr.sock'), 'utf8');
    success = true; serverPid = Number(marker.split(':')[0]); assert.ok(serverPid > 0);
  } finally {
    await host.close().catch(() => {});
    // This session name and private profile were created by this test; never target a shared/default server.
    await exec(resolve('.data-herdr-tools', HERDR_VERSION, 'herdr.exe'), ['--session', session, 'session', 'stop', session, '--json'], { env, windowsHide: true, timeout: 5000 }).catch(() => {});
    if (serverPid) for (let i = 0; i < 100 && !processGone(serverPid); i++) await new Promise(r => setTimeout(r, 50));
    if (success && (!serverPid || processGone(serverPid))) await rm(dir, { recursive: true, force: true });
  }
});
