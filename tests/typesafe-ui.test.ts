import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {TypeSafeConnection} from '../client/TypeSafeConnection.js';
import {RunInteractions,isTypeSafeCredentialInteraction,useRunInteractions} from '../client/Interactions.js';
import type {RunInteraction} from '../shared/types.js';
const api=async<T>():Promise<T>=>{throw Error('No network in static UI proof');};
const request:RunInteraction={id:'interaction',runId:'run',provider:'openai',kind:'question',title:'Connect TypeSafe',description:'Enter your key securely.',status:'pending',questions:[{id:'relay-typesafe-credential:opaque',question:'Secure credential entry'}]};
test('TypeSafe uses a separate masked credential form, rather than an ordinary interaction answer',()=>{
 assert.equal(isTypeSafeCredentialInteraction(request),true);
 assert.equal(isTypeSafeCredentialInteraction({...request,questions:[{id:'ordinary',question:'What next?'}]}),false);
 assert.equal(isTypeSafeCredentialInteraction({...request,kind:'approval'}),false);
 const state={entries:{entry:request},answers:{},errors:{},submitting:{},secureApi:api,resolve:()=>{},cancelSecure:async()=>{}} as unknown as ReturnType<typeof useRunInteractions>;
 const html=renderToStaticMarkup(createElement(RunInteractions,{runId:'run',state,returnFocus:()=>{}}));
 assert.match(html,/type="password"/);assert.match(html,/autocomplete="new-password"/i);
 assert.doesNotMatch(html,/Answer with a form|Submit answer|<textarea|Reply in the chat below/);
 assert.match(html,/API credits/);assert.match(html,/Windows account/);
});
test('optional TypeSafe settings expose secure entry without changing subscription route options',async()=>{
 const html=renderToStaticMarkup(createElement(TypeSafeConnection,{api}));assert.match(html,/TypeSafe/);assert.match(html,/type="password"/);
 const app=await readFile(new URL('../client/App.tsx',import.meta.url),'utf8');
 assert.match(app,/<TypeSafeConnection api=\{api\}/);assert.match(app,/aria-label="Automatic model selector"/);assert.match(app,/<option value="typesafe">Jev/);const models=await readFile(new URL('../client/Models.tsx',import.meta.url),'utf8');assert.doesNotMatch(models,/<option value="typesafe"/);
 assert.match(app,/disabled=\{!agent \|\| secureCredentialPending\}/);
});
test('credential input is isolated from browser draft persistence and ordinary messages',async()=>{
 const source=await readFile(new URL('../client/TypeSafeConnection.tsx',import.meta.url),'utf8');
 assert.doesNotMatch(source,/localStorage|sessionStorage|setDraft|\/messages|\/interactions\/|console\./);
 assert.match(source,/\/integrations\/typesafe\/credential-request/);assert.match(source,/\/integrations\/typesafe\/connect/);
 assert.match(source,/apiKey: candidate/);assert.match(source,/setApiKey\(''\)/);assert.match(source,/AbortController/);
 assert.match(source,/expiresAt/);assert.match(source,/onSubmit=/);
});
