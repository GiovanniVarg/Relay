import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeAppearance,resolveAppearance} from '../client/appearance.js';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

test('appearance accepts only exact preferences and falls back safely',()=>{
 for(const value of [undefined,null,'DARK','obsolete',0,{},['dark']])assert.equal(normalizeAppearance(value),'system');
 for(const value of ['light','dark','system'] as const)assert.equal(normalizeAppearance(value),value);
});
test('system resolves reactively while explicit preferences ignore the OS',()=>{
 assert.equal(resolveAppearance('system',true),'dark');assert.equal(resolveAppearance('system',false),'light');
 for(const value of ['light','dark'] as const)for(const systemDark of [true,false])assert.equal(resolveAppearance(value,systemDark),value);
});
test('external first paint validates cache, survives denied storage, and synchronizes native chrome',()=>{
 const script=readFileSync(new URL('../client/public/appearance-init.js',import.meta.url),'utf8');
 for(const value of ['light','dark','system',null,'DARK','garbage'])for(const systemDark of [false,true])for(const denied of [false,true]){
  const root={dataset:{} as Record<string,string>,style:{} as Record<string,string>};let chrome='';
  runInNewContext(script,{localStorage:{getItem(){if(denied)throw Error('blocked');return value;}},window:{matchMedia:()=>({matches:systemDark})},document:{documentElement:root,querySelector:()=>({setAttribute:(_key:string,value:string)=>{chrome=value;}})}});
  const expected=resolveAppearance(denied?'system':normalizeAppearance(value),systemDark);
  assert.equal(root.dataset.theme,expected);assert.equal(root.style.colorScheme,expected);assert.equal(chrome,expected==='dark'?'#1c201e':'#f7f5ef');
 }
 const html=readFileSync(new URL('../client/index.html',import.meta.url),'utf8');
 assert.ok(html.indexOf('src="/appearance-init.js"')<html.indexOf('src="/main.tsx"'));
 assert.match(html,/<script src="\/appearance-init\.js"><\/script>/);
});
