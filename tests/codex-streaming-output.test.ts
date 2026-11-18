import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {CodexAdapter,CodexRpc,CodexTurn} from '../server/providers/codex.js';
import {JsonLines,type Launcher} from '../server/providers/process.js';
import type {ProviderRequest} from '../shared/types.js';

function fixture() {
  let closed=false;
  const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),pid:987654,
    exitCode:null as number|null,signalCode:null as NodeJS.Signals|null,kill:()=>{end();return true;}});
  function end(){if(!closed){closed=true;child.exitCode=0;child.emit('close',0,null);}}
  return {child:child as unknown as ChildProcessWithoutNullStreams,end,send:(value:unknown)=>child.stdout.write(JSON.stringify(value)+'\n')};
}
const base:ProviderRequest={runId:'stream',conversationId:'conversation',model:'fixture',mode:'agent',instructions:'Complete the task.',
  history:[{role:'user',content:'Work through the source, then use the app action.'}],maxSeconds:5,expectedAccount:{accountLabel:'stream@example.test',plan:'team'}};

test('actual Codex adapter consumes more than 4MiB of transient output and still executes the next scoped tool once',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'relay-streaming-codex-'));let calls=0,wireBytes=0,replies=0;
  const definition={name:'relay_fixture',description:'Complete the requested app action.',inputSchema:{type:'object',properties:{},additionalProperties:false}};
  const launcher:Launcher=()=>{
    const f=fixture(),command={type:'commandExecution',id:'shell',command:'read source'},app={type:'dynamicToolCall',id:'app',namespace:'relay_app',tool:'relay_fixture'};
    const send=(value:unknown)=>{wireBytes+=Buffer.byteLength(JSON.stringify(value))+1;f.send(value);};
    const parser=new JsonLines(message=>{
      if(!message.method){replies++;assert.equal(message.result.success,true);send({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:app}});
        send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed',items:[command,app,{type:'agentMessage',id:'answer',text:'The work is complete.'}]}}});return;}
      let result:any={};
      if(message.method==='config/read')result={config:{forced_login_method:'chatgpt',model_provider:'openai',approval_policy:'on-request',sandbox_mode:'workspace-write',sandbox_workspace_write:{network_access:false},windows:{sandbox:'mxc'}}};
      if(message.method==='account/read')result={account:{type:'chatgpt',email:base.expectedAccount.accountLabel,planType:'team'}};
      if(message.method==='thread/start')result={thread:{id:'thread'},model:'fixture',modelProvider:'openai',approvalPolicy:'on-request',sandbox:{type:'workspaceWrite',networkAccess:false}};
      if(message.method==='turn/start')result={turn:{id:'turn'}};
      queueMicrotask(()=>{if(message.id!==undefined)send({id:message.id,result});if(message.method==='turn/start')setImmediate(()=>{
        send({method:'item/started',params:{threadId:'thread',turnId:'turn',item:command}});
        for(let index=0;index<12;index++)send({method:'item/commandExecution/outputDelta',params:{threadId:'thread',turnId:'turn',itemId:'shell',delta:'x'.repeat(450000)}});
        send({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:command}});
        send({method:'item/started',params:{threadId:'thread',turnId:'turn',item:app}});
        send({id:'host-call',method:'item/tool/call',params:{threadId:'thread',turnId:'turn',namespace:'relay_app',callId:'exactly-once',tool:'relay_fixture',arguments:{}}});
      });});
    });
    f.child.stdin.on('data',chunk=>parser.push(chunk));f.child.stdin.on('finish',f.end);return f.child;
  };
  const adapter=new CodexAdapter(directory,{command:async()=>({file:'fixture',args:[]}),launcher,kill:async child=>{child.kill();}});
  try{const events:any[]=[];const result=await adapter.stream({...base,workspace:directory,interact:async()=>({decision:'deny'}),appTools:{definitions:[definition],call:async()=>{calls++;return {completed:true};}}},event=>events.push(event),new AbortController().signal);
    assert.equal(result.text,'The work is complete.');assert.equal(calls,1);assert.equal(replies,1);assert.ok(wireBytes>4*1024*1024);assert.equal(JSON.stringify(events).includes('x'.repeat(200)),false);
  }finally{await adapter.close();await rm(directory,{recursive:true,force:true});}
});

test('streaming JSON lines bound individual frames and preserve fragmented UTF8, malformed and object checks',()=>{
  const values:any[]=[];const parser=new JsonLines(value=>values.push(value),1024,128,'streaming');
  const frame=Buffer.from(JSON.stringify({text:'界🙂é'})+'\n');for(const byte of frame)parser.push(Buffer.from([byte]));
  parser.push((JSON.stringify({text:'ok'})+'\n').repeat(200));parser.end();assert.equal(values[0].text,'界🙂é');assert.equal(values.length,201);
  assert.throws(()=>new JsonLines(()=>{},1024,128,'streaming').push(JSON.stringify({text:'x'.repeat(130)})+'\n'),/JSON line exceeded/);
  assert.throws(()=>new JsonLines(()=>{},1024,128,'streaming').push('x'.repeat(129)),/JSON line exceeded/);
  assert.throws(()=>new JsonLines(()=>{},1024,128,'streaming').push('{broken}\n'),/malformed/);
  assert.throws(()=>new JsonLines(()=>{},1024,128,'streaming').push('[]\n'),/invalid protocol/);
  assert.throws(()=>new JsonLines(()=>{},10,128).push(JSON.stringify({text:'a'.repeat(20)})+'\n'),/output exceeded/);
});

test('retained UTF8 response state is bounded before an overflowing delta is emitted',()=>{
  const events:any[]=[];const turn=new CodexTurn('thread','model',event=>events.push(event));turn.start('turn');
  const delta='é'.repeat(600000);turn.accept({method:'item/agentMessage/delta',params:{threadId:'thread',turnId:'turn',itemId:'answer',delta}});
  assert.throws(()=>turn.accept({method:'item/agentMessage/delta',params:{threadId:'thread',turnId:'turn',itemId:'answer',delta}}),/retained.*safety limit/);
  assert.equal(events.length,1);assert.equal(turn.text,delta);
});

test('early notifications are bounded by retained bytes as well as their count',()=>{
  const turn=new CodexTurn('thread','model',()=>{});
  assert.throws(()=>{for(let i=0;i<10;i++)turn.accept({method:'item/commandExecution/outputDelta',params:{threadId:'thread',turnId:'turn',itemId:'shell',delta:'x'.repeat(500000)}});},/retained.*safety limit/);
});

test('file-change replacement releases old retained details while distinct accumulated details stay bounded',()=>{
  const turn=new CodexTurn('thread','model',()=>{},'native');turn.start('turn');
  const change=(id:string,diff:string)=>({method:'item/started',params:{threadId:'thread',turnId:'turn',item:{type:'fileChange',id,changes:[{path:'file.ts',kind:{type:'update'},diff}]}}});
  for(let i=0;i<20;i++){turn.accept(change('same','x'.repeat(500000)));turn.accept(change('same',''));}
  assert.throws(()=>{for(let i=0;i<10;i++)turn.accept(change('file-'+i,'x'.repeat(500000)));},/retained.*safety limit/);
});

test('RPC refuses unbounded unresolved host requests and closes their authority on failure',async()=>{
  const f=fixture();const rpc=new CodexRpc({file:'fixture',args:[]},[],process.cwd(),{},5,undefined,()=>f.child,async child=>{child.kill();});
  let calls=0;rpc.handleRequests((_message,signal)=>new Promise((_done,reject)=>{calls++;signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});}));
  try{for(let i=0;i<100;i++)f.send({id:'request-'+i,method:'item/tool/call',params:{threadId:'thread'}});
    let timer:NodeJS.Timeout|undefined;
    try{await assert.rejects(Promise.race([rpc.failed,new Promise((_done,reject)=>{timer=setTimeout(()=>reject(new Error('Host request flood was not bounded')),100);})]),/request.*safety limit/);assert.ok(calls<=32);}
    finally{clearTimeout(timer);}
  }finally{await rpc.close();}
});

test('streaming line accounting joins string chunks split inside a surrogate pair exactly',()=>{
  const line=JSON.stringify({text:'🙂'}),values:any[]=[];const parser=new JsonLines(value=>values.push(value),100,Buffer.byteLength(line),'streaming');
  const split=line.indexOf('🙂')+1;parser.push(line.slice(0,split));parser.push(line.slice(split)+'\n');assert.equal(values[0].text,'🙂');
});

test('response accounting joins split surrogate deltas and deduplicates completion without leaking reservations',async()=>{
  const turn=new CodexTurn('thread','model',()=>{});turn.start('turn');
  for(const delta of ['\uD83D','\uDE42'])turn.accept({method:'item/agentMessage/delta',params:{threadId:'thread',turnId:'turn',itemId:'answer',delta}});
  const item={id:'answer',type:'agentMessage',text:'🙂'};
  turn.accept({method:'item/completed',params:{threadId:'thread',turnId:'turn',item}});
  turn.accept({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed',items:[item]}}});assert.equal((await turn.result).text,'🙂');
});

test('processing early transient frames releases their reservations before later response text',()=>{
  const turn=new CodexTurn('thread','model',()=>{},'native');
  for(let i=0;i<4;i++)turn.accept({method:'item/commandExecution/outputDelta',params:{threadId:'thread',turnId:'turn',itemId:'shell',delta:'x'.repeat(900000)}});
  turn.start('turn');turn.accept({method:'item/agentMessage/delta',params:{threadId:'thread',turnId:'turn',itemId:'answer',delta:'a'.repeat(1000000)}});
  assert.equal(turn.text.length,1000000);
});

test('invalid replacement file details release the previous payload instead of retaining stale approval data',()=>{
  const turn=new CodexTurn('thread','model',()=>{},'native');turn.start('turn');
  for(let i=0;i<7;i++)turn.accept({method:'item/started',params:{threadId:'thread',turnId:'turn',item:{type:'fileChange',id:'file-'+i,changes:[{path:'file.ts',kind:{type:'update'},diff:'x'.repeat(500000)}]}}});
  for(let i=0;i<7;i++){turn.accept({method:'item/started',params:{threadId:'thread',turnId:'turn',item:{type:'fileChange',id:'file-'+i,changes:[{path:'file.ts',kind:{type:'unknown'},diff:''}]}}});assert.equal(turn.fileChangeDetails('file-'+i),undefined);}
  turn.accept({method:'item/agentMessage/delta',params:{threadId:'thread',turnId:'turn',itemId:'answer',delta:'a'.repeat(1000000)}});assert.equal(turn.text.length,1000000);
});

test('RPC identity retention is byte bounded even when host callbacks finish promptly',async()=>{
  const f=fixture();const rpc=new CodexRpc({file:'fixture',args:[]},[],process.cwd(),{},5,undefined,()=>f.child,async child=>{child.kill();});
  let calls=0;rpc.handleRequests(async()=>{calls++;return {};});
  try{for(let i=0;i<20;i++){f.send({id:'request-'+i+'x'.repeat(300000),method:'item/tool/call',params:{threadId:'thread'}});await new Promise(done=>setImmediate(done));}
    await assert.rejects(rpc.failed,/retained.*safety limit/);assert.ok(calls<20);
  }finally{await rpc.close();}
});

test('server cancellation does not free capacity while a host callback still retains its request',async()=>{
  const f=fixture();const rpc=new CodexRpc({file:'fixture',args:[]},[],process.cwd(),{},5,undefined,()=>f.child,async child=>{child.kill();});
  let calls=0;rpc.handleRequests(()=>{calls++;return new Promise(()=>{});});
  try{for(let i=0;i<32;i++){f.send({id:'request-'+i,method:'item/tool/call',params:{threadId:'thread'}});f.send({method:'serverRequest/resolved',params:{threadId:'thread',requestId:'request-'+i}});}
    f.send({id:'overflow',method:'item/tool/call',params:{threadId:'thread'}});await assert.rejects(rpc.failed,/request.*safety limit/);assert.equal(calls,32);
  }finally{await rpc.close();}
});

test('RPC pending requests remain bounded and closing rejects the existing waiters',async()=>{
  const f=fixture();const rpc=new CodexRpc({file:'fixture',args:[]},[],process.cwd(),{},5,undefined,()=>f.child,async child=>{child.kill();});
  const pending=Array.from({length:64},()=>rpc.request('config/read').catch(error=>error));
  try{await assert.rejects(rpc.request('config/read'),/pending request.*safety limit/);}finally{await rpc.close();}
  assert.ok((await Promise.all(pending)).every(value=>value instanceof Error));
});

test('completed file-change payloads do not accumulate across a long coding turn',()=>{
  const turn=new CodexTurn('thread','model',()=>{},'native');turn.start('turn');
  for(let i=0;i<20;i++){
    const item={type:'fileChange',id:'file-'+i,changes:[{path:'file.ts',kind:{type:'update'},diff:'x'.repeat(900000)}]};
    turn.accept({method:'item/started',params:{threadId:'thread',turnId:'turn',item}});
    turn.accept({method:'item/completed',params:{threadId:'thread',turnId:'turn',item}});
    assert.equal(Boolean(turn.fileChangeDetails(item.id)),true);
    if(i)assert.equal(Boolean(turn.fileChangeDetails('file-'+(i-1))),false);
  }
});

test('an approval pins its exact file snapshot through terminal events and releases it when settled',()=>{
  const turn=new CodexTurn('thread','model',()=>{},'native');turn.start('turn');const pins:{details:unknown;release():void}[]=[];
  const item=(id:string)=>({type:'fileChange',id,changes:[{path:'file.ts',kind:{type:'update'},diff:'x'.repeat(900000)}]});
  for(let i=0;i<4;i++){const change=item('file-'+i);turn.accept({method:'item/started',params:{threadId:'thread',turnId:'turn',item:change}});pins.push(turn.pinFileChangeDetails(change.id));turn.accept({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:change}});}
  assert.throws(()=>turn.accept({method:'item/started',params:{threadId:'thread',turnId:'turn',item:item('overflow')}}),/retained.*safety limit/);
  assert.equal((pins[0].details as any[])[0].diff.length,900000);for(const pin of pins){pin.release();pin.release();}
  turn.accept({method:'item/started',params:{threadId:'thread',turnId:'turn',item:item('after-release')}});
});

test('RPC bounds legal permission replies when the provider stops consuming stdin',async()=>{
  const f=fixture();const rpc=new CodexRpc({file:'fixture',args:[]},[],process.cwd(),{},5,undefined,()=>f.child,async child=>{child.kill();});
  let calls=0;rpc.handleRequests(async message=>{calls++;return {permissions:message.params.permissions,scope:'turn'};});
  const permissions={fileSystem:{read:['a'.repeat(9000)],write:null}};
  try{for(let i=0;i<500;i++){f.send({id:'permission-'+i,method:'item/permissions/requestApproval',params:{threadId:'thread',turnId:'turn',permissions}});await new Promise(done=>setImmediate(done));}
    let timer:NodeJS.Timeout|undefined;
    try{await assert.rejects(Promise.race([rpc.failed,new Promise((_done,reject)=>{timer=setTimeout(()=>reject(new Error('Provider input queue was not bounded')),100);})]),/input queue.*safety limit/);}
    finally{clearTimeout(timer);}
    assert.ok(calls<500);assert.ok(f.child.stdin.writableLength<=4*1024*1024);
  }finally{await rpc.close();}
});

test('RPC allows more than 4MiB of cumulative outgoing replies when stdin keeps draining',async()=>{
  const f=fixture();let bytes=0;f.child.stdin.on('data',chunk=>{bytes+=chunk.length;});
  const rpc=new CodexRpc({file:'fixture',args:[]},[],process.cwd(),{},5,undefined,()=>f.child,async child=>{child.kill();});
  let calls=0;rpc.handleRequests(async message=>{calls++;return {permissions:message.params.permissions,scope:'turn'};});
  const permissions={fileSystem:{read:['a'.repeat(9000)],write:null}};
  try{for(let i=0;i<600;i++){f.send({id:'permission-'+i,method:'item/permissions/requestApproval',params:{threadId:'thread',turnId:'turn',permissions}});await new Promise(done=>setImmediate(done));}
    assert.equal(calls,600);assert.ok(bytes>4*1024*1024);assert.equal(f.child.stdin.writableLength,0);assert.equal(f.child.stdin.destroyed,false);
  }finally{await rpc.close();}
});

test('RPC releases queued-input capacity after the provider resumes reading',async()=>{
  const f=fixture();const rpc=new CodexRpc({file:'fixture',args:[]},[],process.cwd(),{},5,undefined,()=>f.child,async child=>{child.kill();});
  let calls=0,bytes=0;rpc.handleRequests(async()=>{calls++;return {text:'x'.repeat(300000)};});
  const send=async(index:number)=>{f.send({id:'request-'+index,method:'item/tool/call',params:{threadId:'thread'}});await new Promise(done=>setImmediate(done));};
  try{for(let i=0;i<12;i++)await send(i);assert.ok(f.child.stdin.writableLength>1024*1024);
    f.child.stdin.on('data',chunk=>{bytes+=chunk.length;});await new Promise(done=>setImmediate(done));
    for(let i=12;i<24;i++)await send(i);assert.equal(calls,24);assert.ok(bytes>4*1024*1024);assert.equal(f.child.stdin.writableLength,0);
  }finally{await rpc.close();}
});

test('RPC cancellation discards queued host replies and suppresses subsequent output',async()=>{
  const f=fixture(),controller=new AbortController();const rpc=new CodexRpc({file:'fixture',args:[]},[],process.cwd(),{},5,controller.signal,()=>f.child,async child=>{child.kill();});
  let calls=0;rpc.handleRequests(async()=>{calls++;return {text:'x'.repeat(900000)};});
  try{for(let i=0;i<3;i++){f.send({id:'request-'+i,method:'item/tool/call',params:{threadId:'thread'}});await new Promise(done=>setImmediate(done));}
    assert.ok(f.child.stdin.writableLength>1024*1024);controller.abort();await assert.rejects(rpc.failed,/cancelled/);
    f.send({id:'late',method:'item/tool/call',params:{threadId:'thread'}});await new Promise(done=>setImmediate(done));
    assert.equal(f.child.stdin.destroyed,true);assert.equal(calls,3);
  }finally{await rpc.close();}
});

test('unserializable host results fail through the owned process instead of an unhandled reply promise',async()=>{
  const f=fixture();const rpc=new CodexRpc({file:'fixture',args:[]},[],process.cwd(),{},5,undefined,()=>f.child,async child=>{child.kill();});
  rpc.handleRequests(async()=>({unsupported:1n}));
  try{f.send({id:'bad-result',method:'item/tool/call',params:{threadId:'thread'}});await assert.rejects(rpc.failed,/input.*serializ/);}
  finally{await rpc.close();}
});
