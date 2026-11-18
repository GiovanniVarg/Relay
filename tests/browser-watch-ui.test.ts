import test from 'node:test';
import assert from 'node:assert/strict';
import {parseBrowserWatchEvent,browserWatchFeed,type BrowserFeedState} from '../client/browser-watch-feed.js';
const time='2026-11-03T12:00:00.000Z';
const status=(sid:string|null='s')=>({type:'status',agentId:'a',sequence:1,observedAt:time,sessionId:sid,status:{granted:true,available:true,running:!!sid,humanControl:false,url:'https://example.test',sessionId:sid}});
const frame=(sequence=2,sessionId='s')=>({type:'frame',agentId:'a',sequence,observedAt:time,sessionId,url:'https://example.test',jpeg:'/9j/2Q==',capturedAt:time});
test('parser bounds JPEG, timestamps, scoped IDs and sanitizes activity',()=>{
 assert.ok(parseBrowserWatchEvent(JSON.stringify(frame()),'a'));
 for(const invalid of [{...frame(),agentId:'b'},{...frame(),sequence:0},{...frame(),capturedAt:'yesterday'},{...frame(),jpeg:'data:image/svg+xml,test'},{...frame(),jpeg:'AAAA'.repeat(180000)},{...status(),status:{...status().status,humanControl:'yes'}},{...frame(),sessionId:''}])assert.equal(parseBrowserWatchEvent(JSON.stringify(invalid),'a'),null);
 assert.equal(parseBrowserWatchEvent('x'.repeat(800000),'a'),null);
 assert.equal(parseBrowserWatchEvent(JSON.stringify({...frame(),type:'activity',action:'unknown',phase:'complete'}),'a'),null);
 assert.equal(parseBrowserWatchEvent(JSON.stringify({...status(),sessionId:'different'}),'a'),null);
 const activity=parseBrowserWatchEvent(JSON.stringify({...frame(),type:'activity',action:'fill',phase:'complete',value:'secret',selector:'secret'}),'a');
 assert.ok(activity);assert.equal('value' in activity,false);assert.equal('selector' in activity,false);
});
test('feed requires status, clears pixels and rejects old connection/session callbacks',()=>{
 const sources:any[]=[],timers:(()=>void)[]=[];let state!:BrowserFeedState;
 const feed=browserWatchFeed('a',value=>{state=value;},()=>{const source={onopen:null,onmessage:null,onerror:null,closed:false,close(){this.closed=true;}};sources.push(source);return source;},tick=>{timers.push(tick);return()=>{};});
 const emit=(index:number,value:unknown)=>sources[index].onmessage({data:JSON.stringify(value)});
 emit(0,frame());assert.equal(state.frame,null);emit(0,status());emit(0,frame());assert.ok(state.frame);
 emit(0,{...frame(3),sessionId:'old'});assert.equal((state as BrowserFeedState).frame?.sessionId,'s');
 emit(0,{...status('new'),sequence:4});assert.equal(state.frame,null);emit(0,frame(5));assert.equal(state.frame,null);
 emit(0,{...frame(6,'new')});assert.ok(state.frame);sources[0].onerror();assert.equal(state.frame,null);assert.equal(state.connection,'reconnecting');timers.shift()!();
 emit(0,{...frame(100,'new')});assert.equal(state.frame,null);emit(1,frame(2,'new'));assert.equal(state.frame,null);emit(1,status('new'));emit(1,frame(2,'new'));assert.ok(state.frame);
 emit(1,{type:'clear',agentId:'a',sessionId:'new',sequence:3,observedAt:time,reason:'navigation'});assert.equal(state.frame,null);
 for(let i=4;i<55;i++)emit(1,{type:'activity',agentId:'a',sessionId:'new',sequence:i,observedAt:time,action:'fill',phase:'complete'});
 assert.equal(state.activities.length,40);feed.close();const before=state;emit(1,status());sources[1].onerror();assert.equal(state,before);assert.ok(sources.every(s=>s.closed));
});
test('URL changes, null sessions and revocation cannot retain or revive old pixels',()=>{
 let source:any,state!:BrowserFeedState;
 const feed=browserWatchFeed('a',next=>{state=next;},()=>source={onopen:null,onmessage:null,onerror:null,close(){}});
 const emit=(event:unknown)=>source.onmessage({data:JSON.stringify(event)});
 emit(status());emit(frame());assert.ok(state.frame);
 emit({...status(),sequence:3,status:{...status().status,url:'https://example.test/next'}});assert.equal(state.frame,null);
 emit(frame(4));assert.ok(state.frame);
 emit({type:'clear',agentId:'a',sessionId:'s',sequence:5,observedAt:time,reason:'revoked'});emit(frame(6));assert.equal(state.frame,null);
 emit({...status(null),sequence:7});emit(frame(8));assert.equal(state.frame,null);feed.close();
});
