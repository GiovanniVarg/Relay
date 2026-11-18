import assert from 'node:assert/strict';
import test from 'node:test';
import {TransportReader,transportFrame} from '../server/network-transport.js';

test('header-only large declarations reserve no body memory; only received bytes consume the bounded budget',async()=>{
 let source!:ReadableStreamDefaultController<Uint8Array>;
 const readable=new ReadableStream<Uint8Array>({start(controller){source=controller;}}),reader=new TransportReader(readable);
 source.enqueue(transportFrame({version:1,method:'POST',path:'/api/attachments',headers:{},bodyLength:8*1024*1024}));
 let reserved=0;const request=reader.request(received=>{if(reserved+received>8)throw Error('aggregate request budget exceeded');reserved+=received;});
 const settled=assert.rejects(request,/budget exceeded/);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(reserved,0);
 source.enqueue(new Uint8Array([1,2,3]));await new Promise(resolve=>setImmediate(resolve));assert.equal(reserved,3);
 source.enqueue(new Uint8Array([4,5,6,7,8,9]));await settled;assert.equal(reserved,3);reader.cancel();
});
