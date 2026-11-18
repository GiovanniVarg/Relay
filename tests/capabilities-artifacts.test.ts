import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.js';
import { Capabilities } from '../server/capabilities.js';
import { Artifacts } from '../server/artifacts.js';
import { Browser } from '../server/browser.js';
import type { Agent } from '../shared/types.js';

async function fixture() { const root = await mkdtemp(join(tmpdir(), 'relay-capabilities-')); const store = new Store(join(root, 'data')); const [agent, peer] = store.list<Agent>('agent'); return { root, store, agent, peer }; }
test('browser grants are explicit per bot and native capabilities do not imply browser authority', async () => {
  const f = await fixture(); try { const caps = new Capabilities(f.store); assert.equal(caps.browserGrant(f.agent.id).enabled, false); caps.setBrowserGrant(f.agent.id, true); assert.equal(caps.browserGrant(f.agent.id).enabled, true); assert.equal(caps.browserGrant(f.peer.id).enabled, false); caps.setBrowserGrant(f.agent.id, false); const browser = new Browser(f.store, caps); await assert.rejects(browser.open(f.agent.id, 'https://example.com'), /grant|access/i); await browser.close(); } finally { f.store.close(); await rm(f.root, { recursive: true, force: true, maxRetries: 10 }); }
});
test('artifacts are copied with provenance and integrity does not claim correctness', async () => {
 const f = await fixture(); try { const artifacts = new Artifacts(f.store); const workspace = join(f.root, 'project'); await mkdir(workspace); const source = join(workspace, 'result.txt'); await writeFile(source, 'finished bytes'); const saved = await artifacts.capture({ agentId: f.agent.id, workspace, path: 'result.txt', name: 'Result.txt' }); await writeFile(source, 'later modified'); assert.equal((await artifacts.read(saved.id)).bytes.toString(), 'finished bytes'); assert.equal(saved.verification, 'captured'); assert.equal((await artifacts.verify(saved.id)).correctness, 'not_assessed'); assert.equal(artifacts.list(f.peer.id).length, 0); await writeFile(join(f.store.dataDir, 'artifacts', saved.id), 'tampered'); await assert.rejects(artifacts.read(saved.id), /integrity/i); } finally { f.store.close(); await rm(f.root, { recursive: true, force: true, maxRetries: 10 }); }
});
test('artifact capture rejects traversal, private Relay data, symlink escape and foreign attribution', async () => {
 const f = await fixture(); try { const artifacts = new Artifacts(f.store); const workspace = join(f.root, 'project'); await mkdir(workspace); await writeFile(join(f.root, 'outside.txt'), 'private'); await writeFile(join(workspace, 'inside.txt'), 'public'); await assert.rejects(artifacts.capture({agentId:f.agent.id,workspace,path:'../outside.txt',name:'x'}), /workspace/i); await assert.rejects(artifacts.capture({agentId:f.agent.id,workspace:f.root,path:'data/relay.sqlite',name:'x'}), /private/i); await symlink(f.root, join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir'); await assert.rejects(artifacts.capture({agentId:f.agent.id,workspace,path:'escape/outside.txt',name:'x'}), /workspace/i); f.store.put('run', {id:'foreign-run',agentId:f.peer.id}); await assert.rejects(artifacts.text({agentId:f.agent.id,runId:'foreign-run',name:'x',content:'x'}), /another bot/i); await assert.rejects(artifacts.text({agentId:f.agent.id,name:'../escape.html',content:'<script>x</script>'}), /filename/i); } finally { f.store.close(); await rm(f.root, { recursive: true, force: true, maxRetries: 10 }); }
});
test('browser launch revocation closes the owned context before any action can continue', async () => {
 const f = await fixture(); const caps = new Capabilities(f.store);caps.setBrowserGrant(f.agent.id,true);let release!:()=>void;let entered!:()=>void;let closed=0;
 const started=new Promise<void>(resolve=>entered=resolve),hold=new Promise<void>(resolve=>release=resolve);
 const fakeContext={close:async()=>{closed++;}};
 const browser=new Browser(f.store,caps,{launch:async()=>{entered();await hold;return fakeContext as never;}});
 try {const pending=browser.open(f.agent.id,'https://example.com');await started;caps.setBrowserGrant(f.agent.id,false);release();await assert.rejects(pending,/Grant/);assert.equal(closed,1);assert.equal((await browser.status(f.agent.id)).running,false);}finally{await browser.close();f.store.close();await rm(f.root,{recursive:true,force:true,maxRetries:10});}
});
test('cancellation while the initial browser launch is pending closes the acquired context',async()=>{
 const f=await fixture();const caps=new Capabilities(f.store);caps.setBrowserGrant(f.agent.id,true);let entered!:()=>void,release!:()=>void,closed=0;const started=new Promise<void>(done=>entered=done),hold=new Promise<void>(done=>release=done);const browser=new Browser(f.store,caps,{launch:async()=>{entered();await hold;return {close:async()=>{closed++;}} as never;}});const controller=new AbortController();
 try{const pending=browser.open(f.agent.id,'https://example.com',controller.signal);await started;controller.abort(new Error('Cancelled initial launch'));release();await assert.rejects(pending,/Cancelled initial launch/);assert.equal(closed,1);assert.equal((await browser.status(f.agent.id)).running,false);}finally{await browser.close();f.store.close();await rm(f.root,{recursive:true,force:true,maxRetries:10});}
});
