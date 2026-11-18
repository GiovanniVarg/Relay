import test from 'node:test';
import assert from 'node:assert/strict';
import {register} from 'node:module';
import {createElement} from 'react';
import {renderToString} from 'react-dom/server';
register(new URL('./fixtures/css-only-loader.mjs',import.meta.url),import.meta.url);
const{Dispatcher}=await import('../client/Dispatcher.js');
test('dispatcher preserves Boss Chat naming and describes recovery retention accurately',()=>{
 const html=renderToString(createElement(Dispatcher,{api:async()=>({})as never,agents:[],onOpenWork:()=>{}}));
 assert.match(html,/aria-label="Boss Chat"/);assert.match(html,/<strong>Boss Chat<\/strong>/);
 assert.match(html,/Message Boss Chat/);assert.match(html,/Send to Boss Chat/);assert.match(html,/Reset Boss Chat view/);assert.match(html,/Full requests and attachments move to the assigned bot chat\./);assert.match(html,/Only assignment and attachment draft IDs are kept here for recovery\./);assert.doesNotMatch(html,/Boss Chat messages and drafts are not saved/);
 assert.doesNotMatch(html,/\bGod\b/);
});
