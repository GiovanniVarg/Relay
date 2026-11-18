import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir,homedir} from 'node:os';
import {request as httpsRequest} from 'node:https';
import {generateKeyPairSync,randomBytes,randomUUID,sign,type KeyObject} from 'node:crypto';
import {createApp} from '../server/index.js';
import {bodyHash,signingPayload,type DeviceRecord,type DeviceRole} from '../server/network-auth.js';
import type {SecretVaultLike} from '../server/typesafe.js';
import type {Agent,Message,ProviderAdapter,ProviderId,ProviderRequest} from '../shared/types.js';
import type {RemoteInventory} from '../shared/remote-jobs.js';
import {requestImages} from '../server/attachment-context.js';
import {png} from './fixtures/attachment-inputs.js';

function proof(key:KeyObject,method:string,path:string,body:Buffer,id?:string){
 const timestamp=Date.now(),nonce=randomBytes(18).toString('base64url'),signature=sign('sha256',Buffer.from(signingPayload(method,path,timestamp,nonce,bodyHash(body))),{key,dsaEncoding:'ieee-p1363'}).toString('base64url');
 return {'x-relay-timestamp':String(timestamp),'x-relay-nonce':nonce,'x-relay-signature':signature,...(id?{'x-relay-device':id}:{})};
}
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'relay-assignment-http-')),seen:ProviderRequest[]=[],secrets=new Map<string,string>();
 const vault={has:async(key:string)=>secrets.has(key),get:async(key:string)=>secrets.get(key)??null,set:async(key:string,value:string)=>{secrets.set(key,value);},remove:async(key:string)=>{secrets.delete(key);},close(){},availability(){return {available:true,protection:'test'};}} as unknown as SecretVaultLike;
 const adapters=Object.fromEntries(['openai','claude','cursor','opencode'].map(id=>[id,{id,inspect:async()=>({id,installed:true,authenticated:true,authMode:'subscription',accountLabel:'Synthetic own account',plan:'Synthetic',models:[{id:'vision',name:'Synthetic vision',verified:true,inputModalities:['text','image'],inputModalitiesSource:'provider-catalog'}]}),stream:async(request:ProviderRequest)=>{
  if(request.usagePurpose==='outcome-reconciliation')return{text:JSON.stringify({state:'complete',summary:'Synthetic assigned work completed',remaining:[],evidence:[]})};
  seen.push(request);if(request.appTools)await request.appTools.call('fixture-outcome','relay_report_task_outcome',{state:'complete',summary:'Synthetic assigned work completed',remaining:[],evidence:[]});return{text:'Synthetic assigned work completed with the selected source.'};
 },login:async()=>({message:''}),close:async()=>{}}])) as unknown as Record<ProviderId,ProviderAdapter>;
 const options={dataDir:dir,port:0,adapters,secretVault:vault,taskPollMs:60000,networkOptions:{allowLoopbackTest:true,interfaces:()=>[{name:'test-loopback',address:'127.0.0.1',netmask:'255.0.0.0'}]}};
 let app=createApp(options),port=0,cookie='',csrf='';
 const origin=app.store.list<Agent>('agent')[0],worker=app.store.createAgent({name:'HTTP Worker',mode:'agent',workspace:homedir()}),reviewer=app.store.createAgent({name:'HTTP Reviewer',mode:'agent',workspace:homedir()});
 for(const agent of [worker,reviewer])app.store.put('agent',{...agent,routeMode:'openai',model:'vision'});
 const conversation=app.store.conversations(origin.id)[0];
 async function open(){app.store.saveBilling('openai',{mode:'included',confirmed:true,automaticRouting:true,allowanceNote:'Synthetic integration test'});await app.runs.refresh();port=await app.listen(0);const response=await fetch('http://127.0.0.1:'+port+'/api/bootstrap');cookie=response.headers.get('set-cookie')!.split(';')[0];csrf=(await response.json()).csrfToken;}
 await open();
 async function call(path:string,method='GET',body?:unknown){return fetch('http://127.0.0.1:'+port+'/api'+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':csrf},...(body===undefined?{}:{body:JSON.stringify(body)})});}
 async function wire(method:string,path:string,body=Buffer.alloc(0),headers:Record<string,string>={},trust=true){
  const status=app.network!.status();return new Promise<{status:number;body:Buffer;json:any;headers:Record<string,unknown>}>((resolve,reject)=>{
   const request=httpsRequest({hostname:'127.0.0.1',port:status.port,method,path,...(trust?{ca:status.publicCA!}:{}),headers:{'content-type':'application/json','content-length':String(body.length),...headers}},response=>{const chunks:Buffer[]=[];response.on('data',chunk=>chunks.push(Buffer.from(chunk)));response.once('error',reject);response.once('end',()=>{const data=Buffer.concat(chunks);let json:unknown;try{json=JSON.parse(data.toString());}catch{}resolve({status:response.statusCode!,body:data,json,headers:response.headers});});});request.once('error',reject);request.end(body);
  });
 }
 async function pair(role:DeviceRole){
  const invite=await call('/network/invites','POST',{role});assert.equal(invite.status,201,await invite.clone().text());const {code}=await invite.json(),keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=keys.publicKey.export({format:'jwk'}),publicKey={kty:'EC',crv:'P-256',x:jwk.x!,y:jwk.y!},input={code,name:role+' fixture',platform:'test',publicKey},body=Buffer.from(JSON.stringify(input)),path='/api/network/pair';
  const response=await wire('POST',path,body,proof(keys.privateKey,'POST',path,body));assert.equal(response.status,201,response.body.toString());return {key:keys.privateKey,device:response.json as DeviceRecord,csrf:''};
 }
 async function signed(device:Awaited<ReturnType<typeof pair>>,path:string,method='GET',input?:unknown){const body=input===undefined?Buffer.alloc(0):Buffer.from(JSON.stringify(input));return wire(method,path,body,{...proof(device.key,method,path,body,device.device.id),...(device.csrf?{'x-csrf-token':device.csrf}:{})});}
 async function finishLocal(){for(let round=0;round<8&&app.tasks.list().some(task=>['queued','scheduled','working','needs_input'].includes(task.status));round++){await app.tasks.tick();await Promise.all([...app.runs.active.values()].map(run=>run.promise));}}
 return {dir,origin,worker,reviewer,conversation,seen,call,wire,pair,signed,finishLocal,get app(){return app;},async tls(){return app.network!.enable({address:'127.0.0.1',port:0,controllerOrigins:['https://controller.example']});},async restart(){await app.close();app=createApp(options);await open();},async close(){await app.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});}};
}

test('real HTTP direct/group/Boss assignment submissions preserve source bubbles, owned attachments, and idempotency',{timeout:120000},async()=>{
 const f=await fixture();try{
  const image=await(await f.call('/conversations/'+f.conversation.id+'/attachments','POST',{name:'selected.png',mimeType:'image/png',base64:png().toString('base64')})).json(),source={kind:'conversation',id:f.conversation.id},request={requestId:randomUUID(),source,content:'@HTTP Worker: inspect only the selected image',attachmentIds:[image.id]};
  const rejected=await f.call('/assignments','POST',{...request,requestId:randomUUID(),content:'@Unknown bot: inspect'});assert.equal(rejected.status,400);assert.equal(f.app.store.messages(source.id).length,0);assert.equal(f.app.tasks.list().length,0);
  const response=await f.call('/assignments','POST',request);assert.equal(response.status,202,await response.clone().text());const receipt=await response.json();assert.equal(receipt.message.content,request.content);assert.equal(receipt.assignments.length,1);assert.equal((await f.call('/assignments/lookup/'+request.requestId)).status,200);assert.equal((await f.call('/assignments/lookup/'+randomUUID())).status,404);
  const replay=await f.call('/assignments','POST',request);assert.equal(replay.status,202);assert.deepEqual(await replay.json(),receipt);
  const group={id:randomUUID(),title:'HTTP source group',agentIds:[f.origin.id,f.worker.id],mode:'roundtable',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};f.app.store.put('group-room',group);
  const grouped=await f.call('/assignments','POST',{requestId:randomUUID(),source:{kind:'group',id:group.id},content:'@HTTP Reviewer: inspect the group source'});assert.equal(grouped.status,202,await grouped.clone().text());assert.equal(f.app.store.groupMessages(group.id).length,1);assert.equal(f.app.store.list('group-run').length,0);
  const boss=await f.call('/assignments','POST',{requestId:randomUUID(),source:{kind:'boss',id:randomUUID()},content:'@HTTP Worker: inspect this separate Boss request'});assert.equal(boss.status,202,await boss.clone().text());assert.equal((await boss.json()).message,undefined);
  await f.finishLocal();assert.equal(f.app.tasks.list().length,3);assert.ok(f.app.tasks.list().every(task=>task.status==='done'));assert.equal(f.app.store.messages(source.id).filter(message=>message.role==='user').length,1);assert.equal(f.seen.some(request=>request.conversationId===source.id),false);
  const imageRequest=f.seen.find(request=>requestImages(request).length>0)!;assert.ok(imageRequest);assert.deepEqual(Buffer.from(requestImages(imageRequest)[0].data,'base64'),png());assert.notEqual(requestImages(imageRequest)[0].attachmentId,image.id);
  const listing=await(await f.call('/assignments?kind=conversation&id='+source.id)).json();assert.equal(listing.assignments.length,1);assert.equal(JSON.stringify(listing).includes(request.content),false);
  const detail=await(await f.call('/assignments/'+receipt.assignments[0].id+'?offset=0&limit=12000')).json();assert.equal(detail.assignment.state,'done');assert.match(detail.result.text,/Synthetic assigned work completed/);assert.ok(Array.isArray(detail.events));assert.equal(f.app.store.messages(source.id).filter(message=>message.role==='assistant').length,0);
 }finally{await f.close();}
});

test('actual verified TLS worker roles, selected-machine payload, questions, and completion reach the source assignment',{timeout:120000},async()=>{
 const f=await fixture();try{
  await f.tls();await assert.rejects(f.wire('GET','/api/network/info',Buffer.alloc(0),{},false));const controller=await f.pair('controller'),a=await f.pair('worker'),b=await f.pair('worker');
  const bootstrap=await f.signed(controller,'/api/bootstrap');assert.equal(bootstrap.status,200);controller.csrf=bootstrap.json.csrfToken;
  assert.equal((await f.signed(a,'/api/assignments?kind=conversation&id='+f.conversation.id)).status,401);assert.equal((await f.signed(controller,'/api/network/worker/poll?instance=controller-is-not-worker')).status,401);
  const inventory:RemoteInventory={protocolVersion:1,name:'TLS worker A',platform:'test',providers:[{id:'openai',models:[{id:'vision',name:'Vision',available:true,modalities:['text','image']}]}],workspaces:['home'],defaultAgent:{id:'own-agent',provider:'openai',model:'vision',ready:true}};
  assert.equal((await f.signed(a,'/api/network/worker/heartbeat','POST',inventory)).status,200);assert.equal((await f.signed(b,'/api/network/worker/heartbeat','POST',{...inventory,name:'TLS worker B'})).status,200);
  const image=await(await f.call('/conversations/'+f.conversation.id+'/attachments','POST',{name:'selected.png',mimeType:'image/png',base64:png().toString('base64')})).json(),request={requestId:randomUUID(),source:{kind:'conversation',id:f.conversation.id},content:'@HTTP Worker: @computer/'+a.device.id+': render this selected image',attachmentIds:[image.id]};
  const submitted=await f.signed(controller,'/api/assignments','POST',request);assert.equal(submitted.status,202,submitted.body.toString());const assignment=submitted.json.assignments[0];await f.app.tasks.tick();assert.equal(f.seen.length,0);
  assert.deepEqual((await f.signed(b,'/api/network/worker/poll?instance=worker-b')).json,{});const offered=await f.signed(a,'/api/network/worker/poll?instance=worker-a');assert.equal(offered.status,200);assert.equal(offered.json.job.computerId,a.device.id);assert.equal(offered.json.payload.instruction,'render this selected image');assert.deepEqual(Buffer.from(offered.json.payload.attachments[0].base64,'base64'),png());assert.equal(offered.json.payload.attachments.length,1);
  const job=offered.json.job,identity={leaseId:offered.json.leaseId,instanceId:'worker-a'},base='/api/network/worker/jobs/'+job.id;
  assert.equal((await f.signed(b,base+'/ack','POST',identity)).status,409);assert.equal((await f.signed(a,base+'/ack','POST',identity)).status,200);assert.equal((await f.signed(a,base+'/started','POST',identity)).status,200);
  assert.equal((await f.signed(a,base+'/events','POST',{...identity,event:{sequence:1,type:'question',question:{id:'local-sign-in',revision:1,localOnly:true,title:'PRIVATE_TITLE',description:'PRIVATE_DESCRIPTION',questions:[{id:'secret',question:'PRIVATE_SECRET_FIELD'}]}}})).status,200);
  const localOnly=await f.signed(controller,'/api/assignments/'+assignment.id);assert.equal(localOnly.json.remoteQuestion.localOnly,true);for(const value of ['PRIVATE_TITLE','PRIVATE_DESCRIPTION','PRIVATE_SECRET_FIELD'])assert.equal(localOnly.body.toString().includes(value),false);
  assert.equal((await f.signed(controller,'/api/assignments/'+assignment.id+'/remote-answer','POST',{questionId:'local-sign-in',revision:1,answers:{secret:'must-not-forward'}})).status,409);
  assert.equal((await f.signed(a,base+'/events','POST',{...identity,event:{sequence:2,type:'question',question:{id:'approval',revision:1,title:'Worker approval',description:'Approve the selected action',questions:[{id:'decision',question:'Allow?',options:[{id:'allow',label:'Allow'},{id:'deny',label:'Deny'}]}]}}})).status,200);
  const answerPath='/api/assignments/'+assignment.id+'/remote-answer';assert.equal((await f.signed(controller,answerPath,'POST',{questionId:'approval',revision:2,answers:{decision:'deny'}})).status,409);assert.equal((await f.signed(controller,answerPath,'POST',{questionId:'approval',revision:1,answers:{decision:'allow'}})).status,200);
  const answered=await f.signed(a,'/api/network/worker/poll?instance=worker-a');assert.deepEqual(answered.json.interactionAnswers[0].answers,{decision:'allow'});assert.deepEqual((await f.signed(b,'/api/network/worker/poll?instance=worker-b')).json,{});
  assert.equal((await f.signed(a,base+'/finish','POST',{...identity,receipt:{sequence:3,state:'complete',text:'Selected TLS worker completed the source assignment.',summary:'Selected work complete'}})).status,200);await f.app.tasks.tick();
  const detail=await f.signed(controller,'/api/assignments/'+assignment.id);assert.equal(detail.json.assignment.state,'done');assert.equal(detail.json.result.text,'Selected TLS worker completed the source assignment.');assert.equal(f.seen.length,0);assert.equal(f.app.store.messages(f.conversation.id).length,1);
 }finally{await f.close();}
});

test('accepted remote execution survives actual host restart with its lease and no payload replay',{timeout:120000},async()=>{
 const f=await fixture();try{
  await f.tls();const worker=await f.pair('worker'),inventory:RemoteInventory={protocolVersion:1,name:'Restart worker',platform:'test',providers:[{id:'openai',models:[{id:'vision',name:'Vision',available:true,modalities:['text']}]}],workspaces:['home'],defaultAgent:{id:'own-worker',provider:'openai',model:'vision',ready:true}};
  assert.equal((await f.signed(worker,'/api/network/worker/heartbeat','POST',inventory)).status,200);
  const input={requestId:randomUUID(),source:{kind:'conversation',id:f.conversation.id},content:'@HTTP Worker: @computer/'+worker.device.id+': preserve the accepted execution'},response=await f.call('/assignments','POST',input);assert.equal(response.status,202);const receipt=await response.json();await f.app.tasks.tick();
  const offer=await f.signed(worker,'/api/network/worker/poll?instance=persistent-worker'),job=offer.json.job,identity={leaseId:offer.json.leaseId,instanceId:'persistent-worker'};assert.equal((await f.signed(worker,'/api/network/worker/jobs/'+job.id+'/ack','POST',identity)).status,200);
  const before=f.app.tasks.get(receipt.assignments[0].taskId),fingerprint=f.app.network!.status().fingerprint;await f.restart();const after=f.app.tasks.get(before.id);assert.equal(after.runId,before.runId);assert.equal(after.attempt,before.attempt);assert.equal(after.recoveryRequired,false);assert.equal(f.app.remoteJobs.forTask(before.id).length,1);assert.equal(f.app.network!.status().fingerprint,fingerprint);
  const recovered=await f.signed(worker,'/api/network/worker/poll?instance=persistent-worker');assert.equal(recovered.status,200);assert.equal(recovered.json.job.id,job.id);assert.equal(recovered.json.leaseId,identity.leaseId);assert.equal(recovered.json.payload,undefined);assert.equal(f.seen.length,0);
  const lookup=await f.call('/assignments/lookup/'+input.requestId);assert.equal(lookup.status,200);assert.deepEqual(await lookup.json(),receipt);assert.equal(f.app.store.messages(f.conversation.id).filter((message:Message)=>message.content===input.content).length,1);
 }finally{await f.close();}
});
