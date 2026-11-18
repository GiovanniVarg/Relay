import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, register } from 'node:module';
import { createElement, type ReactNode } from 'react';
import { allowedCatalog, ModelPicker, providerName, providerSetupUrl,persistModelChoices } from '../client/Models.js';
import type { ProviderState } from '../shared/types.js';
register(new URL('./fixtures/css-only-loader.mjs',import.meta.url),import.meta.url);
const {ProviderCard}=await import('../client/App.js');
const { renderToString } = createRequire(import.meta.url)('react-dom/server') as { renderToString: (element: ReactNode) => string };
const state = (id: ProviderState['id']): ProviderState => ({ id, installed: true, authenticated: true, authMode: 'subscription', accountLabel: 'Saved', plan: 'Saved', models: [{ id: 'saved-model', name: 'Saved model', verified: false }], billing: { mode: 'included', confirmed: true, automaticRouting: true, allowanceNote: 'Saved' }, modelPreferences: { defaultModel: 'saved-model', allowedModels: ['saved-model'] } });

test('connected subscription cards distinguish pending usage approval from account sign-in',()=>{
 for(const id of ['openai','claude','cursor'] as const){
  const provider=state(id);provider.billing={...provider.billing,confirmed:false,automaticRouting:false};const before=structuredClone(provider);
  const html=renderToString(createElement(ProviderCard,{provider,api:async()=>{throw Error('Rendering cannot change billing');},reload:async()=>{throw Error('Rendering cannot start sign-in');}}));
  assert.match(html,/Connected · approve usage/);assert.match(html,/Account connected/);assert.doesNotMatch(html,/Needs setup|Setup needed/);
  assert.match(html,/<input type="checkbox"\/><span>I verified this workspace’s billing and allowance/);assert.match(html,/Approve usage in Relay/);assert.match(html,/Account sign-in options/);assert.match(html,/does not buy a plan or link a payment method/);assert.match(html,/Subscriptions have limits/);assert.deepEqual(provider,before);
 }
});

test('account status identifies usage approval, enabled models, Auto and reported allowance separately',()=>{
 const render=(provider:ProviderState)=>renderToString(createElement(ProviderCard,{provider,api:async()=>{throw Error('Copy must not change settings');},reload:async()=>{throw Error('Copy must not refresh');}}));
 const provider=state('openai');provider.billing.automaticRouting=false;
 assert.match(render(provider),/Ready · manual only/);assert.match(render(provider),/Let Auto choose this account/);assert.match(render(provider),/Choose this account manually in chat/);assert.match(render(provider),/Remaining allowance unknown/);
 provider.billing.automaticRouting=true;assert.match(render(provider),/Ready for Auto/);
 provider.modelPreferences.allowedModels=[];assert.match(render(provider),/Connected · enable models/);
 provider.models=[];assert.match(render(provider),/Connected · refresh models/);
 provider.models=state('openai').models;provider.modelPreferences=state('openai').modelPreferences;
 provider.allowance={source:'codex-app-server',accountKey:'synthetic',observedAt:new Date().toISOString(),availability:'reported',ordinaryUsageAllowed:false,buckets:[]};
 const exhausted=render(provider);assert.match(exhausted,/Connected · allowance unavailable/);assert.match(exhausted,/Check your provider dashboard or choose another account/);assert.doesNotMatch(exhausted,/provider-state ready/);
 provider.allowance.availability='stale';assert.match(render(provider),/Ready for Auto/);assert.match(render(provider),/Remaining allowance unknown/);
});

test('historical retired names remain readable without exposing connection cards, models or sign-in resources', () => {
  assert.equal(providerName('gemini'), 'Google'); assert.equal(providerName('grok'), 'Grok');
  for (const id of ['gemini', 'grok'] as const) {
    const provider = state(id), before = structuredClone(provider);
    assert.deepEqual(allowedCatalog(provider), []);
    const card = renderToString(createElement(ProviderCard, { provider, api: async () => { throw new Error('No retired action'); }, reload: async () => { throw new Error('No retired refresh'); } })); assert.equal(card, '');
    const html = renderToString(createElement(ModelPicker, { provider, auto: false, value: 'saved-model', onChange: () => {} }));
    assert.match(html, /value="saved-model" disabled="" selected=""/); assert.deepEqual(provider, before);
  }
  for (const url of ['https://antigravity.google/docs/faq/', 'https://accounts.google.com/login', 'https://accounts.x.ai/login', 'https://grok.com/login']) for (const id of ['gemini', 'grok']) assert.equal(providerSetupUrl(id, url), null);
});

test('active login destinations stay allowlisted and Cursor Grok models remain available', () => {
  assert.equal(providerSetupUrl('opencode','https://opencode.ai/v2/docs/'),'https://opencode.ai/v2/docs/');for(const url of ['https://opencode.ai.evil.test/v2/docs/','https://user@opencode.ai/v2/docs/','http://opencode.ai/v2/docs/'])assert.equal(providerSetupUrl('opencode',url),null);
  assert.equal(providerSetupUrl('cursor', 'https://cursor.com/login'), 'https://cursor.com/login'); assert.equal(providerSetupUrl('openai', 'https://auth.openai.com/login'), 'https://auth.openai.com/login');
  for (const url of ['http://cursor.com/login', 'https://cursor.com.evil.test/login', 'https://user@cursor.com/login', 'javascript:alert(1)']) assert.equal(providerSetupUrl('cursor', url), null);
  const provider = state('cursor'); provider.models = [{ id: 'grok-covered-by-cursor', name: 'Grok', verified: false }]; provider.modelPreferences = { defaultModel: 'grok-covered-by-cursor', allowedModels: ['grok-covered-by-cursor'] };
  assert.equal(allowedCatalog(provider)[0]?.id, 'grok-covered-by-cursor');
  const html = renderToString(createElement(ModelPicker, { provider, auto: false, value: 'grok-covered-by-cursor', onChange: () => {} })); assert.match(html, /value="grok-covered-by-cursor" selected=""/); assert.doesNotMatch(html, /disabled=""/);
});

test('SSR CSS loader forwards missing JavaScript and TypeScript module errors',async()=>{
  for(const name of ['missing-provider-ssr-fixture.js','missing-provider-ssr-fixture.ts']){
    await assert.rejects(import(new URL('./fixtures/'+name,import.meta.url).href),error=>error instanceof Error&&'code' in error&&error.code==='ERR_MODULE_NOT_FOUND'&&error.message.includes(name));
  }
});
test('large qualified catalogs expose model search and bounded pages without dropping the saved selection',()=>{
 const p=state('opencode');p.authMode='managed';p.connectionScope='a'.repeat(64);p.nativeAgentOnly=true;p.billing={mode:'metered',confirmed:true,automaticRouting:false,allowanceNote:''};p.models=Array.from({length:305},(_,i)=>({id:'backend/model-'+i,name:'Model '+i,verified:false}));p.modelPreferences={defaultModel:'backend/model-304',allowedModels:p.models.map(m=>m.id)};
 const html=renderToString(createElement(ModelPicker,{provider:p,auto:false,value:'backend/model-304',onChange:()=>{}}));assert.match(html,/Search models/);assert.match(html,/backend\/model-304/);assert.ok((html.match(/<option/g)??[]).length<=52);
 const card=renderToString(createElement(ProviderCard,{provider:p,api:async()=>{throw Error();},reload:async()=>{throw Error();}}));assert.match(card,/OpenCode/);assert.match(card,/Local endpoint/);assert.doesNotMatch(card,/value="included"/);
});
test('saving over 200 exact selections adds the new default in the first bounded batch',async()=>{
 const p=state('opencode');p.authMode='managed';p.connectionScope='a'.repeat(64);p.modelPreferences={defaultModel:'',allowedModels:[]};const ids=Array.from({length:250},(_,i)=>'backend/model-'+i),enabled=new Set<string>();let patches=0;
 await persistModelChoices(p,{defaultModel:ids[249],allowedModels:ids},async<T>(_path:string,method?:string,body?:unknown):Promise<T>=>{
  if(!method)return{revision:'catalog-fixture'} as T;const input=body as any;assert.equal(input.expectedConnectionScope,p.connectionScope);assert.equal(input.expectedCatalogRevision,'catalog-fixture');assert.ok(input.addModels.length<=100);assert.ok(input.removeModels.length<=100);for(const id of input.removeModels)enabled.delete(id);for(const id of input.addModels)enabled.add(id);assert.ok(enabled.has(input.defaultModel),'Each intermediate default must be enabled');patches++;return{} as T;
 });assert.equal(patches,3);assert.deepEqual([...enabled].sort(),[...ids].sort());
});
test('non-tool OpenCode models remain indexed with an explicit native Agent explanation',()=>{
 const p=state('opencode');p.authMode='managed';p.connectionScope='a'.repeat(64);p.nativeAgentOnly=true;p.billing={mode:'metered',confirmed:true,automaticRouting:false,allowanceNote:''};p.models=[{id:'backend/text-only',name:'Text only',toolCalling:false,verified:false}];p.modelPreferences={defaultModel:'backend/text-only',allowedModels:['backend/text-only']};
 assert.deepEqual(allowedCatalog(p),[]);const card=renderToString(createElement(ProviderCard,{provider:p,api:async()=>{throw Error();},reload:async()=>{throw Error();}}));assert.match(card,/backend\/text-only/);assert.match(card,/Native Agent unavailable: this model does not support tools/);
});
