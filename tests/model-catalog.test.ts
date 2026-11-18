import test from 'node:test';
import assert from 'node:assert/strict';
import { isActiveProviderId } from '../shared/types.js';
import { permitted, enabledModels } from '../server/router.js';
import { accountUsageKey } from '../server/provider-usage.js';
import type { ProviderState } from '../shared/types.js';
import {searchModelCatalog} from '../server/model-catalog.js';

const state = (): ProviderState => ({ id:'opencode' as any,installed:true,authenticated:true,authMode:'managed' as any,accountLabel:'OpenCode managed profile',plan:'',connectionScope:'a'.repeat(64),nativeAgentOnly:true,models:[{id:'local/mini',name:'Mini',verified:false,local:true},{id:'paid/mini',name:'Mini',verified:false,local:false}],billing:{mode:'local' as any,confirmed:true,automaticRouting:false,allowanceNote:''},modelPreferences:{defaultModel:'',allowedModels:['local/mini','paid/mini']} } as ProviderState);
test('OpenCode is a distinct active managed connection; local approval never enables paid models',()=>{
 assert.equal(isActiveProviderId('opencode'),true);const s=state();assert.equal(permitted(s,false,true),true);assert.equal(permitted(s,true,true),false);assert.equal(permitted(s,false,false),false);assert.deepEqual(enabledModels(s).map(m=>m.id),['local/mini']);
 assert.ok(accountUsageKey(s));assert.notEqual(accountUsageKey(s),accountUsageKey({...s,connectionScope:'b'.repeat(64)}));
 assert.equal(permitted({...s,connectionScope:undefined},false,true),false);assert.equal(permitted({...s,billing:{...s.billing,mode:'included'}},false,true),false);
 const old={...s,id:'openai' as const,authMode:'api-key' as const,billing:{...s.billing,mode:'metered' as const}};assert.equal(permitted(old,false,true),false);
});
test('full model index searches qualified IDs and names with revision-bound stable pagination',()=>{
 const s=state();s.models=Array.from({length:403},(_,i)=>({id:(i%2?'paid/':'local/')+String(i).padStart(4,'0'),name:'Shared name',verified:false,backendProviderId:i%2?'paid':'local',contextWindow:32000+i}));
 const first=searchModelCatalog([s],{query:'shared',limit:100});assert.equal(first.total,403);assert.equal(first.items.length,100);assert.ok(first.nextCursor);
 const all=[...first.items];let page=first;while(page.nextCursor){page=searchModelCatalog([s],{query:'shared',limit:100,cursor:page.nextCursor});all.push(...page.items);}
 assert.equal(all.length,403);assert.equal(new Set(all.map(m=>m.id)).size,403);assert.equal(searchModelCatalog([s],{query:'paid/0001'}).items[0]?.id,'paid/0001');
 assert.throws(()=>searchModelCatalog([{...s,connectionScope:'c'.repeat(64)}],{query:'shared',limit:100,cursor:first.nextCursor!}),/changed/i);
 assert.throws(()=>searchModelCatalog([s],{query:'different',cursor:first.nextCursor!}),/cursor/i);assert.throws(()=>searchModelCatalog([s],{limit:101}),/limit/i);
});
test('agent model pages fit the serialized budget and still reach every long-metadata model',()=>{
 const s=state();s.models=Array.from({length:203},(_,i)=>({id:'local/'+String(i).padStart(4,'0')+'x'.repeat(480),name:'N'.repeat(512),description:'D'.repeat(1000),verified:false}));
 let cursor:string|undefined,seen:string[]=[];do{const page=searchModelCatalog([s],{limit:100,...(cursor?{cursor}:{})},12000);assert.ok(JSON.stringify(page).length<=12000);assert.ok(page.items.length>0);seen.push(...page.items.map(m=>m.id));cursor=page.nextCursor??undefined;}while(cursor);
 assert.equal(seen.length,203);assert.equal(new Set(seen).size,203);
});
