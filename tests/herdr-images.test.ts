import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {prepareImages,ImageAssembler,IMAGE_CHUNK_BYTES,manifestSha256} from '../server/herdr/images.js';
import {frame,validateFrame} from '../server/herdr/protocol.js';
import type {ProviderImage} from '../shared/types.js';
const binding={token:'a'.repeat(64),epoch:'e',delegationId:'d',parentRunId:'p',expiresAt:Date.now()+60000};
function image(size=300000,id='img'):ProviderImage {const bytes=Buffer.alloc(size,73);return {attachmentId:id,messageId:'original',sha256:createHash('sha256').update(bytes).digest('hex'),mimeType:'image/png',width:1,height:1,data:bytes.toString('base64')};}
const history=[{role:'user' as const,content:'image',messageId:'original',imageRefs:['img']}];
test('bounded image transport reconstructs original bytes, metadata only and canonical ACK',()=>{
 const input=image(),prepared=prepareImages({history},[input]);assert.ok(prepared.manifest);assert.equal(JSON.stringify(prepared.manifest).includes(input.data),false);
 const assembler=new ImageAssembler({history},prepared.manifest!);assembler.init({images:prepared.manifest!});
 const bytes=Buffer.from(input.data,'base64');for(let start=0,index=0;start<bytes.length;start+=IMAGE_CHUNK_BYTES,index++)assembler.chunk({imageIndex:0,chunkIndex:index,data:bytes.subarray(start,start+IMAGE_CHUNK_BYTES).toString('base64')});
 assert.deepEqual(assembler.finish(),[input]);
 assert.doesNotThrow(()=>validateFrame(frame(binding,1,'imagesReady',{manifestSha256:manifestSha256(prepared.manifest!)}),binding,0,['imagesReady']));
 assert.throws(()=>validateFrame(frame(binding,1,'imagesReady',{}),binding,0,['imagesReady']));
});
test('strict exact references, private table shapes and image budgets fail closed',()=>{
 for(const table of [[image(10,'extra')],[{...image(10),url:'https://example.test'}],[{...image(10),data:'A==='}],[image(4*1024*1024+1)]])assert.throws(()=>prepareImages({history},table as ProviderImage[]));
 assert.throws(()=>prepareImages({history},[]));assert.throws(()=>prepareImages({history:[]},[image(10)]));
 assert.throws(()=>prepareImages({history:[{...history[0],imageRefs:['img','img']}]},[image(10)]));
});
test('assembler rejects missing, duplicate, foreign, corrupt and noncanonical chunks',()=>{
 const prepared=prepareImages({history},[image()]);
 const fresh=()=>{const a=new ImageAssembler({history},prepared.manifest!);a.init({images:prepared.manifest!});return a;};
 assert.throws(()=>fresh().finish());for(const chunk of [{imageIndex:1,chunkIndex:0,data:'SQ=='},{imageIndex:0,chunkIndex:1,data:'SQ=='},{imageIndex:0,chunkIndex:0,data:'SQ=='},{imageIndex:0,chunkIndex:0,data:'S Q=='}])assert.throws(()=>fresh().chunk(chunk));
 const a=fresh();assert.throws(()=>a.init({images:prepared.manifest!}));a.clear();assert.throws(()=>a.finish());
});
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Server} from 'node:net';
import {HerdrHost,type WorkerJob} from '../server/herdr/host.js';
function textJob(id:string):WorkerJob{return {delegationId:id,parentRunId:'parent',agentId:'worker',provider:'openai',request:{runId:'run',conversationId:'conversation',model:'m',instructions:'fixture',history:[{role:'user',content:'hi'}],maxSeconds:1,expectedAccount:{accountLabel:'fixture',plan:'test'}}};}
test('legacy text receipt fingerprints still return saved outcomes without runtime launch',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'herdr-image-legacy-'));let launches=0;const host=new HerdrHost(dir,{runtime:{inspect:async()=>({available:true}),start:async()=>{launches++;throw Error('must not launch');},closePane:async()=>{}}});
 try{const job=textJob('legacy'),folder=join(dir,'herdr','jobs',createHash('sha256').update(job.delegationId).digest('hex')),outcome={result:{text:'saved'},executionVerified:false,evidence:[]};await mkdir(folder,{recursive:true});await writeFile(join(folder,'receipt.json'),JSON.stringify({delegationId:job.delegationId,parentRunId:job.parentRunId,fingerprint:createHash('sha256').update(JSON.stringify(job)).digest('hex'),status:'complete',outcome}));assert.deepEqual(await host.execute(job,()=>{},async()=>({decision:'deny'}),new AbortController().signal),outcome);assert.equal(launches,0);}finally{await host.close();await rm(dir,{recursive:true,force:true});}
});
test('UTF8 bootstrap rejection closes newly allocated listener and never launches',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'herdr-image-bootstrap-'));let launches=0;const before=new Set((process as any)._getActiveHandles());const host=new HerdrHost(dir,{runtime:{inspect:async()=>({available:true}),start:async()=>{launches++;throw Error('must not launch');},closePane:async()=>{}}});
 try{const input=textJob('oversized');input.request.instructions='中'.repeat(70000);await assert.rejects(host.execute(input,()=>{},async()=>({decision:'deny'}),new AbortController().signal),/bootstrap|unknown/i);await new Promise(done=>setImmediate(done));assert.equal(launches,0);const listeners=(process as any)._getActiveHandles().filter((h:any)=>h instanceof Server&&!before.has(h)&&h.listening);assert.equal(listeners.length,0,'rejected bootstrap must not leak listeners');}finally{await host.close();for(const h of (process as any)._getActiveHandles())if(h instanceof Server&&!before.has(h)&&h.listening)await new Promise<void>(done=>h.close(()=>done()));await rm(dir,{recursive:true,force:true});}
});

test('image references cannot be attributed to an assistant message',()=>{assert.throws(()=>prepareImages({history:[{...history[0],role:'assistant'}]},[image(10)]));});
import {createServer,type Socket} from 'node:net';
import {randomUUID} from 'node:crypto';
import {runWorker} from '../server/herdr/worker.js';
import {FrameReader,encode} from '../server/herdr/protocol.js';
import type {FrameType} from '../server/herdr/types.js';
for(const scenario of ['early-start','foreign-init','duplicate-init','bad-digest','out-of-order','cancel-late-start','unexpected-init','valid-ack-cancel'] as const)test('real worker rejects or cancels image handshake before adapter: '+scenario,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'herdr-image-reject-')),input=textJob('reject-'+scenario),original=image(300000),prepared=prepareImages({history},[original]);input.request.history=history;
 const expected=scenario!=='unexpected-init';let adapters=0,ack=0,peer:Socket|undefined,seq=0;
 const bootstrap:any={token:'b'.repeat(64),epoch:randomUUID(),delegationId:input.delegationId,parentRunId:input.parentRunId,expiresAt:Date.now()+60000,dataDir:dir,job:input,...(expected?{imageManifest:prepared.manifest}:{})};
 const send=(type:FrameType,payload:any)=>peer!.write(encode(frame(bootstrap,++seq,type,payload)));
 const server=createServer(socket=>{peer=socket;const reader=new FrameReader((m:any)=>{if(m.type==='ready'){
   if(scenario==='early-start'){send('start',{});return;}
   if(scenario==='foreign-init'){send('imageInit',{images:prepared.manifest!.map(m=>({...m,messageId:'foreign'}))});return;}
   send('imageInit',{images:prepared.manifest});
   if(scenario==='unexpected-init')return;
   if(scenario==='duplicate-init'){send('imageInit',{images:prepared.manifest});return;}
   if(scenario==='cancel-late-start'){send('cancel',{});send('start',{});return;}
   const bytes=Buffer.from(original.data,'base64');if(scenario==='bad-digest')bytes[0]^=1;
   for(let offset=0,index=0;offset<bytes.length;offset+=IMAGE_CHUNK_BYTES,index++)send('imageChunk',{imageIndex:0,chunkIndex:scenario==='out-of-order'?index+1:index,data:bytes.subarray(offset,offset+IMAGE_CHUNK_BYTES).toString('base64')});
  }else if(m.type==='imagesReady'){ack++;assert.equal(m.payload.manifestSha256,manifestSha256(prepared.manifest!));send('cancel',{});send('start',{});}
 });socket.on('data',chunk=>reader.push(chunk));socket.on('error',()=>{});});
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));bootstrap.endpoint={host:'127.0.0.1',port:(server.address() as any).port};const path=join(dir,'bootstrap.json');await writeFile(path,JSON.stringify(bootstrap));
 try{await runWorker(path,{createAdapter:()=>{adapters++;throw Error('Adapter must not run');}});assert.equal(adapters,0);assert.equal(ack,scenario==='valid-ack-cancel'?1:0);}finally{peer?.destroy();await new Promise<void>(done=>server.close(()=>done()));await rm(dir,{recursive:true,force:true});}
});
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {killOwned} from '../server/providers/process.js';
for(const scenario of ['wrong-ack','cancel-drain','late-ack'] as const)test('host revokes image start across '+scenario,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'herdr-host-image-')),script=join(dir,'peer.mjs');const moduleUrl=(path:string)=>new URL(path,import.meta.url).href;
 const source=`import{readFileSync,writeFileSync}from'node:fs';import{createConnection}from'node:net';import{dirname,join}from'node:path';import{ChildRegistry,registryKey}from${JSON.stringify(moduleUrl('../server/herdr/registry.ts'))};import{FrameReader,frame,encode}from${JSON.stringify(moduleUrl('../server/herdr/protocol.ts'))};import{manifestSha256}from${JSON.stringify(moduleUrl('../server/herdr/images.ts'))};const b=JSON.parse(readFileSync(process.argv[2],'utf8')),registry=new ChildRegistry(join(dirname(process.argv[2]),'children.jsonl'),b,registryKey(b.token));registry.append('worker',{pid:process.pid});const socket=createConnection(b.endpoint);let seq=0,chunks=0;const send=(type,payload)=>socket.write(encode(frame(b,++seq,type,payload)));const finish=()=>{registry.append('complete',{cleanup:true,treeScope:'not-started'});send('stopped',{cleanup:true});socket.end();};socket.once('connect',()=>send('ready',{pid:process.pid,conpty:false}));socket.on('data',data=>reader.push(data));socket.on('error',()=>{});const reader=new FrameReader(m=>{if(m.type==='start')writeFileSync(b.dataDir+'/started','bad');if(m.type==='cancel'){if(${JSON.stringify(scenario)}==='late-ack')send('imagesReady',{manifestSha256:manifestSha256(b.imageManifest)});finish();}if(m.type==='imageInit'&&${JSON.stringify(scenario)}==='cancel-drain'){writeFileSync(b.dataDir+'/phase','ready');socket.pause();setTimeout(()=>{socket.resume();finish();},250);}if(m.type==='imageChunk'&&++chunks===b.imageManifest.reduce((n,i)=>n+i.chunks,0)){if(${JSON.stringify(scenario)}==='wrong-ack')send('imagesReady',{manifestSha256:'0'.repeat(64)});else writeFileSync(b.dataDir+'/phase','ready');}});`;
 await writeFile(script,source);let child:ChildProcessWithoutNullStreams|undefined,checks=0;const controller=new AbortController();
 const host=new HerdrHost(dir,{stopTimeoutMs:1500,runtime:{inspect:async()=>({available:true}),start:async(command,cwd,env)=>{child=spawn(command[0],command.slice(1),{cwd,env,windowsHide:true,stdio:'pipe'});child.stderr.on('data',()=>{});return {workspaceId:'fixture',paneId:'fixture'};},closePane:async()=>{if(child)await killOwned(child);}},workerCommand:[process.execPath,'--import',import.meta.resolve('tsx'),script]});
 try{const original=image(4*1024*1024),input=textJob('host-'+scenario);input.request.history=history;input.request.maxSeconds=5;const running=host.execute(input,()=>{},async()=>({decision:'deny'}),controller.signal,()=>{checks++;},undefined,[original]);void running.catch(()=>{});
 if(scenario!=='wrong-ack'){const deadline=Date.now()+5000;for(;;){try{await readFile(join(dir,'phase'));break;}catch(error:any){if(error.code!=='ENOENT'||Date.now()>deadline)throw error;await new Promise(done=>setTimeout(done,10));}}controller.abort();}
 await assert.rejects(running,/acknowledgment|cancelled|unknown/i);assert.equal(checks,0);await assert.rejects(readFile(join(dir,'started')),/ENOENT/);
 }finally{await host.close().catch(()=>{});if(child)await killOwned(child);await rm(dir,{recursive:true,force:true});}
});
