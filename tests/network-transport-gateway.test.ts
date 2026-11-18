import assert from 'node:assert/strict';
import {createSocket,type Socket} from 'node:dgram';
import test from 'node:test';
import {NetworkTransportGateway} from '../server/network-transport-gateway.js';

async function bound(address='127.0.0.1'){const socket=createSocket('udp4');await new Promise<void>((resolve,reject)=>{socket.once('error',reject);socket.bind(0,address,resolve);});return socket;}
function close(socket:Socket){try{socket.close();}catch{}}
function receive(socket:Socket,ms=1500){return new Promise<Buffer>((resolve,reject)=>{const timer=setTimeout(()=>{socket.off('message',received);reject(Error('UDP response timeout'));},ms);const received=(bytes:Buffer)=>{clearTimeout(timer);resolve(bytes);};socket.once('message',received);});}

test('LAN UDP gateway isolates rebinding peers and checks every ingress and egress packet',async()=>{
 const backend=await bound(),first=await bound(),second=await bound(),outside=await bound('127.0.0.2');
 let valid=true,failed=0;const seen:Buffer[]=[];
 const gateway=new NetworkTransportGateway({address:'127.0.0.1',netmask:'255.255.255.255'},0,backend.address().port,()=>valid,()=>failed++,true);
 try{
  backend.on('message',(bytes,peer)=>{seen.push(Buffer.from(bytes));if(bytes.toString()!=='held')backend.send(bytes,peer.port,peer.address);});
  await gateway.start();
  const port=(gateway as unknown as{front:Socket}).front.address().port;
  const one=receive(first),two=receive(second);first.send(Buffer.from('first-peer'),port,'127.0.0.1');second.send(Buffer.from('rebound-peer'),port,'127.0.0.1');
  assert.equal((await one).toString(),'first-peer');assert.equal((await two).toString(),'rebound-peer');assert.equal(seen.length,2);
  const denied=receive(outside,150);outside.send(Buffer.from('not-on-selected-subnet'),port,'127.0.0.1');await assert.rejects(denied,/timeout/);assert.equal(seen.length,2);
  const received=new Promise<{port:number;address:string}>(resolve=>{backend.once('message',(_bytes,peer)=>resolve(peer));});
  first.send(Buffer.from('held'),port,'127.0.0.1');const peer=await received;
  valid=false;const afterChange=receive(first,150);backend.send(Buffer.from('blocked-egress'),peer.port,peer.address);await assert.rejects(afterChange,/timeout/);
  first.send(Buffer.from('blocked-ingress'),port,'127.0.0.1');await new Promise(resolve=>setTimeout(resolve,50));assert.equal(seen.length,3);
  await new Promise(resolve=>setTimeout(resolve,5100));assert.equal(failed,1);
 }finally{gateway.close();for(const socket of[backend,first,second,outside])close(socket);}
});
