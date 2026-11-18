import test from 'node:test';
import assert from 'node:assert/strict';
import { lowModel } from '../server/router.js';
import type { ProviderState } from '../shared/types.js';
const state=(models:string[],defaultModel=''):ProviderState=>({id:'gemini',installed:true,authenticated:true,authMode:'subscription',accountLabel:'Fixture',plan:'',models:models.map(id=>({id,name:id,verified:false})),billing:{mode:'included',confirmed:true,automaticRouting:true,allowanceNote:''},modelPreferences:{defaultModel,allowedModels:null}});
test('lightweight routing does not confuse Gemini provider name with a mini model tier',()=>{
 assert.equal(lowModel(state(['gemini-pro','gemini-flash'])),'gemini-flash');
 assert.equal(lowModel(state(['gemini-pro','gpt-mini'])),'gpt-mini');
 assert.equal(lowModel(state(['gemini-pro','gemini-flash'],'gemini-pro')),'gemini-pro');
 assert.equal(lowModel(state(['gemini-pro','gemini-flash'],'disabled-model')),undefined);
});
