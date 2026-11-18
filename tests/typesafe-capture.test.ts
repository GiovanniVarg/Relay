import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { TypeSafeIntegration, type SecretVaultLike } from '../server/typesafe.js';
import type { InteractionAnswer, RunInteraction } from '../shared/types.js';
import type { TypeSafeScope } from '../shared/typesafe.js';
const key = 'capture-test-key-1234567890';
const models = { models: [{ name: 'jev-latest', description: 'Model', release_date: '2026-09-15' }] };
async function fixture(fetcher: typeof fetch = async () => Response.json(models)) {
    const dir = await mkdtemp(join(tmpdir(), 'relay-typesafe-capture-')), store = new Store(dir), values = new Map<string, string>();
    let clock = Date.now(), live = true, pending: RunInteraction[] = [], resolveQuestion: (answer: InteractionAnswer) => void = () => { }, beforeCommit: undefined | (() => Promise<void>);
    const vault: SecretVaultLike = { has: async (name) => values.has(name), get: async (name) => values.get(name) ?? null, set: async (name, value, check) => { await beforeCommit?.(); check?.(); values.set(name, value); }, remove: async (name) => { values.delete(name); }, close() { }, availability: () => ({ available: true, protection: 'test encrypted backend' }) };
    let service: TypeSafeIntegration;
    const controller = new AbortController();
    const scope: TypeSafeScope = { runId: 'run', agentId: 'agent', signal: controller.signal, isActive: () => live, interact: async (prompt) => { pending = [{ ...prompt, id: 'interaction', runId: 'run', provider: 'openai', status: 'pending' }]; return new Promise<InteractionAnswer>(resolve => resolveQuestion = resolve); } };
    service = new TypeSafeIntegration(store, vault, { fetch: fetcher, now: () => clock, interactions: () => pending, liveScope: () => live ? scope : undefined, answer: (run, id, answer) => { service.guardAnswer(run, id, answer); assert.equal(id, pending[0]?.id); pending = []; resolveQuestion(answer); } });
    await service.initialize();
    return { service, store, vault, values, scope, controller, pending: () => pending, setLive: (value: boolean) => { live = value; }, expire: () => { clock += 300001; }, beforeCommit: (fn: () => Promise<void>) => beforeCommit = fn, async close() { controller.abort(); await service.close(); store.close(); await rm(dir, { recursive: true, force: true }); } };
}
test('secure capture rejects text/raw answers and resumes only sanitized trusted completion', async () => { const f = await fixture(); try {
    const task = f.service.connectTool(f.scope);
    void task.catch(() => { });
    const interaction = f.pending()[0];
    assert.ok(interaction.questions![0].id.startsWith('relay-typesafe-credential:'));
    assert.throws(() => f.service.guardText('run', key), { status: 409 });
    assert.doesNotThrow(() => f.service.guardText('run', 'stop'));
    assert.throws(() => f.service.guardAnswer('run', interaction.id, { decision: 'allow', answers: { [interaction.questions![0].id]: [key] } }), { status: 409 });
    const c = f.service.credentialRequest('session-a', { runId: 'run', interactionId: interaction.id });
    await assert.rejects(f.service.connectCredential('session-b', { nonce: c.nonce, apiKey: key }), { status: 403 });
    const status = await f.service.connectCredential('session-a', { nonce: c.nonce, apiKey: key });
    assert.equal(status.configured, true);
    assert.equal((await task).configured, true);
    assert.equal(f.pending().length, 0);
    assert.equal(JSON.stringify(f.store.list('message')).includes(key), false);
    assert.equal(JSON.stringify(status).includes(key), false);
}
finally {
    await f.close();
} });
test('expired or cancelled capture after catalog response cannot store the key', async () => { for (const mode of ['expire', 'cancel', 'revoke'] as const) {
    let finish!: (response: Response) => void;
    const f = await fixture((async () => new Promise<Response>(resolve => finish = resolve)) as typeof fetch);
    try {
        const task = f.service.connectTool(f.scope);
        void task.catch(() => { });
        const c = f.service.credentialRequest('s', { runId: 'run', interactionId: 'interaction' });
        const connecting = f.service.connectCredential('s', { nonce: c.nonce, apiKey: key });
        void connecting.catch(() => { });
        if (mode === 'expire')
            f.expire();
        else if (mode === 'cancel')
            f.controller.abort();
        else
            f.setLive(false);
        finish(Response.json(models));
        await assert.rejects(connecting);
        assert.equal(f.values.size, 0);
        f.controller.abort();
        await assert.rejects(task);
    }
    finally {
        await f.close();
    }
} });
test('scope cancellation during encryption is rechecked by the vault commit guard', async () => { const f = await fixture(); let release!: () => void, entered!: () => void; const entering = new Promise<void>(resolve => entered = resolve); f.beforeCommit(async () => { entered(); await new Promise<void>(resolve => release = resolve); }); try {
    const task = f.service.connectTool(f.scope);
    void task.catch(() => { });
    const c = f.service.credentialRequest('s', { runId: 'run', interactionId: 'interaction' }), connecting = f.service.connectCredential('s', { nonce: c.nonce, apiKey: key });
    void connecting.catch(() => { });
    await entering;
    f.controller.abort();
    release();
    await assert.rejects(connecting);
    await assert.rejects(task);
    assert.equal(f.values.size, 0);
}
finally {
    release?.();
    await f.close();
} });
test('a forged credential-looking provider question cannot mint a secure nonce', async () => { const f = await fixture(); try {
    assert.throws(() => f.service.credentialRequest('s', { runId: 'run', interactionId: 'not-registered' }), { status: 409 });
}
finally {
    await f.close();
} });
test('disconnect revokes an in-flight settings credential validation before encrypted save', async () => { let finish!: (value: Response) => void; const f = await fixture((async () => new Promise<Response>(resolve => finish = resolve)) as typeof fetch); try {
    const c = f.service.credentialRequest('s', {}), connecting = f.service.connectCredential('s', { nonce: c.nonce, apiKey: key });
    void connecting.catch(() => { });
    await f.service.disconnect();
    finish(Response.json(models));
    await assert.rejects(connecting);
    assert.equal(f.values.size, 0);
    assert.equal(f.service.status().configured, false);
}
finally {
    await f.close();
} });
test('cancelled credential HTTP request prevents a settings key from being saved', async () => { let finish!: (value: Response) => void; const f = await fixture((async () => new Promise<Response>(resolve => finish = resolve)) as typeof fetch); try {
    const c = f.service.credentialRequest('s', {}), controller = new AbortController(), connecting = f.service.connectCredential('s', { nonce: c.nonce, apiKey: key }, controller.signal);
    void connecting.catch(() => { });
    controller.abort();
    finish(Response.json(models));
    await assert.rejects(connecting);
    assert.equal(f.values.size, 0);
}
finally {
    await f.close();
} });

test('post-vault-guard cancellation or disconnect cannot publish an active key, including rotation restart', async()=>{
 for(const mode of ['disconnect','scope-abort','rotation-cleanup-fails'] as const){
  let calls=0;const f=await fixture((async()=>{calls++;return Response.json(models)}) as typeof fetch);let release!:()=>void,entered!:()=>void;const entering=new Promise<void>(resolve=>entered=resolve);let task:Promise<unknown>|undefined;
  try{
   if(mode==='rotation-cleanup-fails'){const initial=f.service.credentialRequest('s',{});await f.service.connectCredential('s',{nonce:initial.nonce,apiKey:'old-capture-key-123456789'});assert.equal(f.service.status().enabled,true);}
   f.vault.set=async(name,value,check)=>{check?.();entered();await new Promise<void>(resolve=>release=resolve);f.values.set(name,value)};
   if(mode==='rotation-cleanup-fails')f.vault.remove=async()=>{throw Error('synthetic removal failure')};
   if(mode==='scope-abort'){task=f.service.connectTool(f.scope);void task.catch(()=>{});}
   const challenge=f.service.credentialRequest('s',mode==='scope-abort'?{runId:'run',interactionId:'interaction'}:{}),http=new AbortController();
   const connecting=f.service.connectCredential('s',{nonce:challenge.nonce,apiKey:key},http.signal);void connecting.catch(()=>{});await entering;
   if(mode==='disconnect')await f.service.disconnect();else if(mode==='scope-abort')f.controller.abort();else http.abort();
   release();await assert.rejects(connecting);if(task)await assert.rejects(task);
   assert.equal(f.service.status().configured,false);assert.equal(f.service.status().enabled,false);
   const dispatched=calls;await assert.rejects(f.service.decide(f.scope,{state:'Ticket',questions:{ok:{type:'noul',instructions:'Okay?'}}}));assert.equal(calls,dispatched);
   const reopened=new Store(f.store.dataDir),restarted=new TypeSafeIntegration(reopened,f.vault,{fetch:async()=>{throw Error('No dispatch allowed')}});await restarted.initialize();
   try{assert.equal(restarted.status().enabled,false);await assert.rejects(restarted.decide({...f.scope,signal:new AbortController().signal,isActive:()=>true},{state:'Ticket',questions:{ok:{type:'noul',instructions:'Okay?'}}}));}finally{await restarted.close();reopened.close();}
  }finally{release?.();await f.close();}
 }
});
