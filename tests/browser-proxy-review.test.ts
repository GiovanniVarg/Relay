import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,connect} from 'node:net';
import {BrowserProxy} from '../server/browser-proxy.js';

test('review: proxy shutdown between destination validation and CONNECT dispatch opens no late upstream socket',async()=>{
 let connections=0,checks=0,closing:Promise<void>|undefined;
 const target=createServer(socket=>{connections++;socket.destroy();});await new Promise<void>(done=>target.listen(0,'127.0.0.1',done));const targetPort=(target.address() as{port:number}).port;
 const proxy=new BrowserProxy(()=>{if(++checks===3)queueMicrotask(()=>{closing=proxy.close();});});const url=new URL(await proxy.start());const client=connect(Number(url.port),url.hostname);client.on('error',()=>{});
 try{
  const stopped=new Promise<void>(done=>client.once('close',()=>done()));await new Promise<void>(done=>client.once('connect',()=>done()));client.write('CONNECT 127.0.0.1:'+targetPort+' HTTP/1.1\r\nHost: 127.0.0.1:'+targetPort+'\r\n\r\n');await stopped;await closing;await new Promise(done=>setTimeout(done,30));assert.equal(connections,0,'Shutdown must not acquire an untracked outbound connection');
 }finally{client.destroy();await proxy.close();await new Promise<void>(done=>target.close(()=>done()));}
});
