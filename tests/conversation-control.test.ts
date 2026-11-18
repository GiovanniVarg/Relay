import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, PROVIDER_IDS } from '../server/store.js';
import { Runs } from '../server/runs.js';
import { replyToRun, answerFromText } from '../server/conversation-control.js';
import type { Agent, ProviderAdapter, ProviderId, ProviderRequest, InteractionPrompt } from '../shared/types.js';
const approval: InteractionPrompt = {kind:'approval',title:'Write code',description:'Edit requested file'};
const question: InteractionPrompt = {kind:'question',title:'Which color?',description:'',questions:[{id:'color',question:'Which color?'}]};
async function fixture(handle: (request:ProviderRequest)=>Promise<{text:string}>) {
 const root=await mkdtemp(join(tmpdir(),'relay-conversation-'));await mkdir(join(root,'project'));
 const store=new Store(join(root,'data'));
 const adapters=Object.fromEntries(PROVIDER_IDS.map(provider=>[provider,{id:provider,inspect:async()=>({id:provider,installed:true,authenticated:true,authMode:'subscription',accountLabel:'Fixture',plan:'Fixture',models:[{id:'m',name:'Model',verified:false}]}),login:async()=>({message:'fixture'}),close:async()=>{},stream:handle}])) as unknown as Record<ProviderId,ProviderAdapter>;
 for(const provider of PROVIDER_IDS){store.saveBilling(provider,{mode:'included',confirmed:true,automaticRouting:true,allowanceNote:''});store.saveModelPreferences(provider,{defaultModel:'m',allowedModels:['m']});}
 const runs=new Runs(store,adapters);await runs.refresh();const original=store.list<Agent>('agent')[0];const agent=store.put<Agent>('agent',{...original,mode:'agent',workspace:join(root,'project')});const conversation=store.conversations(agent.id)[0];
 return {store,runs,agent,conversation,async close(){await runs.close();store.close();await rm(root,{recursive:true,force:true});}};
}
async function waiting(runs:Runs,runId:string){for(let i=0;i<200;i++){const value=runs.pendingInteractions(runId)[0];if(value)return value;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('No question');}
test('Agent grants requested tool approval with audit event and no pending interaction',async()=>{let granted=false;const f=await fixture(async r=>{granted=(await r.interact!(approval)).decision==='allow';return {text:'Done'};});try{const {run}=f.runs.accept(f.agent,f.conversation.id,'Fix code','claude','m');const active=f.runs.active.get(run.id)!;await active.promise;assert.equal(granted,true);assert.equal(f.runs.pendingInteractions(run.id).length,0);assert.ok(active.events.some(e=>e.type==='tool'&&e.name==='agent_authority'));}finally{await f.close();}});
test('Agent question waits for typed answer and stores human text without another model call',async()=>{let calls=0;const f=await fixture(async r=>{calls++;assert.deepEqual(await r.interact!(question),{decision:'allow',answers:{color:['Blue']}});return {text:'Done'};});try{const {run}=f.runs.accept(f.agent,f.conversation.id,'Do work','claude','m');const active=f.runs.active.get(run.id)!;const prompt=await waiting(f.runs,run.id);assert.equal(calls,1);const response=await replyToRun({runs:f.runs,store:f.store},run.id,'Blue',prompt.id);assert.equal(response.action,'answered');await active.promise;assert.equal(calls,1);assert.ok(f.store.messages(f.conversation.id).some(m=>m.role==='user'&&m.content==='Blue'));await assert.rejects(replyToRun({runs:f.runs,store:f.store},run.id,'Blue',prompt.id),{status:409});}finally{await f.close();}});
test('typed approval is explicit, multi-question answers require complete labels',()=>{assert.deepEqual(answerFromText(approval,'yes'),{decision:'allow'});assert.deepEqual(answerFromText(approval,'no'),{decision:'deny'});assert.throws(()=>answerFromText(approval,'maybe'),{status:409});const prompt={...question,questions:[{id:'color',question:'Color?'},{id:'size',question:'Size?'}]};assert.throws(()=>answerFromText(prompt,'Blue'),{status:409});assert.deepEqual(answerFromText(prompt,'color: Blue\nsize: Large'),{decision:'allow',answers:{color:['Blue'],size:['Large']}});});
test('typed stop cancels a pending question and persists message',async()=>{const f=await fixture(async r=>{await r.interact!(question);return {text:'never'};});try{const {run}=f.runs.accept(f.agent,f.conversation.id,'Do work','claude','m');await waiting(f.runs,run.id);assert.equal((await replyToRun({runs:f.runs,store:f.store},run.id,'stop')).action,'cancelled');assert.equal(f.store.get<{status:string}>('run',run.id)?.status,'cancelled');assert.ok(f.store.messages(f.conversation.id).some(m=>m.content==='stop'));}finally{await f.close();}});

test('two pending questions reject an ambiguous reply and accept an exact request prefix', async () => {
 const f=await fixture(async request=>{await Promise.all([request.interact!(question),request.interact!({...question,title:'Which size?',questions:[{id:'size',question:'Which size?'}]})]);return {text:'Done'};});
 try {const {run}=f.runs.accept(f.agent,f.conversation.id,'Do work','claude','m');const active=f.runs.active.get(run.id)!;await waiting(f.runs,run.id);const pending=f.runs.pendingInteractions(run.id);assert.equal(pending.length,2);await assert.rejects(replyToRun({runs:f.runs,store:f.store},run.id,'Blue'),{status:409});assert.equal(f.runs.pendingInteractions(run.id).length,2);assert.equal(f.store.messages(f.conversation.id).filter(message=>message.role==='user').length,1);await replyToRun({runs:f.runs,store:f.store},run.id,pending[0].id+': Blue');await replyToRun({runs:f.runs,store:f.store},run.id,'Large');await active.promise;assert.equal(f.runs.pendingInteractions(run.id).length,0);}finally{await f.close();}
});
test('Agent never authorizes an already-cancelled provider approval callback', async () => {const f=await fixture(async request=>{const cancelled=new AbortController();cancelled.abort();await assert.rejects(request.interact!(approval,cancelled.signal),/expired/);return {text:'Done'};});try{const {run}=f.runs.accept(f.agent,f.conversation.id,'Do work','claude','m');const active=f.runs.active.get(run.id)!;await active.promise;assert.equal(active.events.some(event=>event.type==='tool'&&event.name==='agent_authority'),false);}finally{await f.close();}});
test('typed question answers preserve opaque prototype and Unicode IDs',()=>{const prompt={...question,questions:[{id:'__proto__',question:'Prototype?'},{id:'constructor',question:'Constructor?'},{id:'选择 one',question:'Unicode?'}]};assert.deepEqual(answerFromText(prompt,'__proto__: safe\nconstructor: safe\n选择 one: 选项 A'),{decision:'allow',answers:{['__proto__']:['safe'],constructor:['safe'],['选择 one']:['选项 A']}});});

test('single multi-select questions accept pipe-separated chat selections',()=>{assert.deepEqual(answerFromText({...question,questions:[{id:'color',question:'Colors?',multiple:true}]},'Blue | Red'),{decision:'allow',answers:{color:['Blue','Red']}});});

test('question, typed human answer and final reply survive rehydration in conversational order', async()=>{
 const f=await fixture(async request=>{await request.interact!({...question,details:'PRIVATE INTERNAL DETAILS'});return {text:'I will use teal.'};});
 try {
  const {run}=f.runs.accept(f.agent,f.conversation.id,'Choose a theme','claude','m');const active=f.runs.active.get(run.id)!;
  const prompt=await waiting(f.runs,run.id);
  assert.ok(f.store.messages(f.conversation.id).some(message=>message.role==='assistant'&&message.runId===null&&message.content.includes('Which color?')),'Question is saved while waiting');
  const response=await replyToRun({runs:f.runs,store:f.store},run.id,'teal',prompt.id);await active.promise;
  assert.ok(response.questionMessage?.content.includes('Which color?'));
  const reopened=new Store(f.store.dataDir);
  try {const messages=reopened.messages(f.conversation.id);assert.deepEqual(messages.map(message=>message.role),['user','assistant','user','assistant']);assert.equal(messages[1].runId,null);assert.equal(messages[2].content,'teal');assert.equal(messages[3].content,'I will use teal.');assert.ok(messages[1].createdAt<messages[2].createdAt&&messages[2].createdAt<messages[3].createdAt);assert.equal(JSON.stringify(messages).includes('PRIVATE INTERNAL DETAILS'),false);}finally{reopened.close();}
 }finally{await f.close();}
});
