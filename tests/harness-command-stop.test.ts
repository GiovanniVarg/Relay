import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import type {ChildProcess} from 'node:child_process';
import {runHarnessCommand} from '../server/harness-command.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {connect} from 'node:net';

const flush=async()=>{for(let n=0;n<30;n++)await Promise.resolve();};
const gate=()=>{let resolve!:()=>void,reject!:(error:Error)=>void;const promise=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
function fixture(){
 const child=Object.assign(new EventEmitter(),{pid:4321,stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>true})as unknown as ChildProcess;
 const controller=new AbortController(),tree=gate(),children=new Set<ChildProcess>();let launches=0,stops=0;
 const launch=()=>{launches++;return child;},stopTree=async(pid:number)=>{assert.equal(pid,4321);stops++;return tree.promise;};
 const start=()=>runHarnessCommand({executable:'synthetic',args:[],cwd:'synthetic',env:{},signal:controller.signal},()=>{},children,{launch,stopTree,groupGone:async()=>{}});
 return{child,controller,tree,children,start,get launches(){return launches;},get stops(){return stops;}};
}
test('parent close before failed tree stop never becomes confirmed cancellation',async()=>{
 const f=fixture(),job=f.start();f.controller.abort();f.child.emit('close',0,null);f.tree.reject(Error('Synthetic tree refusal'));await assert.rejects(job,error=>!!error&&typeof error==='object'&&'code'in error&&error.code==='HARNESS_CHECK_OUTCOME_UNKNOWN');assert.equal(f.stops,1);
});
test('tree stop success waits for owned close and duplicate abort stops one tree',async()=>{
 const f=fixture(),job=f.start();let ended=false;void job.catch(()=>{ended=true;});f.controller.abort();f.controller.abort();f.tree.resolve();await flush();assert.equal(ended,false);assert.equal(f.stops,1);f.child.emit('close',null,'SIGTERM');await assert.rejects(job,/Checks cancelled/);assert.equal(f.children.size,0);
});
test('tree stop without close is unknown within its fixed stop bound',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture(),job=f.start();f.controller.abort();f.tree.resolve();await flush();t.mock.timers.tick(5000);await assert.rejects(job,error=>!!error&&typeof error==='object'&&'code'in error&&error.code==='HARNESS_CHECK_OUTCOME_UNKNOWN');f.child.emit('close',null,'SIGTERM');assert.equal(f.children.size,0);t.mock.timers.reset();
});
test('fixed command timeout cannot pass even with a racing zero exit',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture(),job=f.start();t.mock.timers.tick(15*60*1000);f.tree.resolve();f.child.emit('close',0,null);await assert.rejects(job,/15 minute limit/);assert.equal(f.stops,1);t.mock.timers.reset();
});
test('pre-spawn abort launches and stops no process',async()=>{
 const f=fixture();f.controller.abort();await assert.rejects(f.start(),/Checks cancelled/);assert.equal(f.launches,0);assert.equal(f.stops,0);assert.equal(f.children.size,0);
});
test('trusted lifecycle journals before spawn and marks uncertainty before rejection',async()=>{
 const f=fixture(),events:string[]=[];
 const job=runHarnessCommand({executable:'synthetic',args:[],cwd:'synthetic',env:{},signal:f.controller.signal},()=>{},f.children,{lifecycle:state=>events.push(state),launch:()=>{events.push('spawn');return f.child;},stopTree:async()=>{throw Error('Synthetic refusal');},groupGone:async()=>{}});
 assert.deepEqual(events,['running','spawn']);f.controller.abort();f.child.emit('close',0,null);await assert.rejects(job,/termination is unknown/);assert.deepEqual(events,['running','spawn','unknown']);
});

test('Windows default runner stops its exact disposable descendant tree and closes its listener',{skip:process.platform!=='win32',timeout:15000},async()=>{
 const cwd=await mkdtemp(join(tmpdir(),'relay-native-check-stop-')),controller=new AbortController(),children=new Set<ChildProcess>();
 const descendant="const net=require('node:net');const server=net.createServer();server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({pid:process.pid,port:server.address().port})));";
 const parent="const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',"+JSON.stringify(descendant)+"],{windowsHide:true,stdio:['ignore','pipe','inherit']});child.stdout.pipe(process.stdout);setInterval(()=>{},1000);";
 let ready!:(value:{pid:number;port:number})=>void,rejectReady!:(error:Error)=>void,buffer='';const observed=new Promise<{pid:number;port:number}>((yes,no)=>{ready=yes;rejectReady=no;});
 const job=runHarnessCommand({executable:process.execPath,args:['-e',parent],cwd,env:process.env,signal:controller.signal},text=>{buffer+=text;const newline=buffer.indexOf('\n');if(newline>=0){try{ready(JSON.parse(buffer.slice(0,newline)));}catch{rejectReady(Error('Invalid owned fixture handshake'));}}},children);void job.catch(rejectReady);
 const timer=setTimeout(()=>rejectReady(Error('Owned fixture did not become ready')),5000);
 try{
  const fixture=await observed;assert.ok(Number.isInteger(fixture.pid)&&fixture.pid>0);assert.ok(Number.isInteger(fixture.port)&&fixture.port>0);clearTimeout(timer);controller.abort();await assert.rejects(job,/Checks cancelled/);assert.equal(children.size,0);
  assert.throws(()=>process.kill(fixture.pid,0),error=>!!error&&typeof error==='object'&&'code'in error&&error.code==='ESRCH','the exact fixture descendant must be absent');
  await new Promise<void>((done,fail)=>{const socket=connect({host:'127.0.0.1',port:fixture.port});socket.once('connect',()=>{socket.destroy();fail(Error('Owned descendant listener survived cancellation'));});socket.once('error',error=>(error as NodeJS.ErrnoException).code==='ECONNREFUSED'?done():fail(error));});
 }finally{clearTimeout(timer);controller.abort();await job.catch(()=>{});await rm(cwd,{recursive:true,force:true});}
});
