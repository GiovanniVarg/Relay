import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {createServer} from 'vite';
import {chromium,type Browser,type Page} from 'playwright';
import {dispatcherFixtureSource} from './fixtures/dispatcher-ui.js';
import type {DispatcherReceipt} from '../shared/dispatcher.js';

const sentinel='SYNTHETIC_GOD_PRIVATE_734819',secret='SYNTHETIC_GOD_CREDENTIAL_813743';
const receipt=(n=1):DispatcherReceipt=>({submissionId:'submission-'+n,taskId:'task-'+n,agentId:'lead',status:'working',runId:'run-'+n,conversationId:'chat-'+n,selectionSource:'local',recoveryRequired:false,activeWork:true,interactionTargets:[]});
async function fixture(){
 const calls:{path:string;method:string;body:any;sensitive:boolean}[]=[],jobs=new Map<string,DispatcherReceipt>(),questions=new Map<string,any[]>();
 let mode:'accept'|'lost'|'late'|'recipient'|'reject'='accept',late:(()=>Promise<void>)|undefined,hideLookup=false;
 const drafts=new Map<string,any[]>();let fileSequence=0;
 const vite=await createServer({cacheDir:resolve('.data-browser-watch/dispatcher-vite-cache'),server:{port:0,host:'127.0.0.1'},logLevel:'error',plugins:[{name:'synthetic-dispatcher',resolveId(id){if(id==='/synthetic-dispatcher.tsx')return id;},load(id){if(id==='/synthetic-dispatcher.tsx')return dispatcherFixtureSource;}}]});let browser:Browser|undefined;
 try{
  await vite.listen();browser=await chromium.launch({headless:true,channel:process.env.RELAY_TEST_BROWSER_CHANNEL});const page=await browser.newPage(),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/synthetic-dispatcher',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><button id="focus-anchor">Focus anchor</button><div id="root"></div><script type="module" src="/synthetic-dispatcher.tsx"></script>'}));
  await page.route('**/api/**',async route=>{
   const req=route.request(),path=new URL(req.url()).pathname.slice(4)+new URL(req.url()).search,method=req.method(),body=req.postDataJSON();calls.push({path,method,body,sensitive:req.headers()['x-synthetic-sensitive']==='yes'});
   const send=(data:any,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
   const attachment=path.match(/^\/dispatcher\/drafts\/([^/]+)\/attachments(?:\/([^/?]+))?$/);
   if(attachment){const scope=attachment[1],items=drafts.get(scope)||[];if(method==='GET')return attachment[2]?route.fulfill({contentType:'text/plain',body:'synthetic file'}):send(items);if(method==='DELETE'){drafts.set(scope,items.filter(item=>item.id!==attachment[2]));return send({ok:true});}const item={id:'file-'+(++fileSequence),name:body.name,mimeType:body.mimeType,size:Buffer.from(body.base64,'base64').length,kind:body.mimeType.startsWith('image/')?'image':'document',sha256:'synthetic'};drafts.set(scope,[...items,item]);return send(item);}
   if(path==='/dispatcher/submissions'&&method==='POST'){
    if(mode==='reject')return send({error:'Synthetic unsupported admission'},409);
    if(mode==='recipient'&&!body.agentId)return send({state:'needs-recipient',reason:'ambiguous',candidates:[{agentId:'worker',name:'Worker',role:'Reviewer'}]});
    drafts.set(body.draftId,[]);
    const r={...receipt(jobs.size+1),submissionId:body.submissionId,agentId:body.agentId||'lead'};jobs.set(r.taskId,r);
    if(mode==='lost')return route.abort();if(mode==='late'){late=()=>send({state:'accepted',receipt:r});return;}return send({state:'accepted',receipt:r});
   }
   if(path.startsWith('/dispatcher/submissions/')){if(hideLookup)return send({state:'pending'});const id=decodeURIComponent(path.split('/').at(-1)!);const r=[...jobs.values()].find(r=>r.submissionId===id);return send(r?{state:'accepted',receipt:r}:{state:'unconfirmed'});}
   if(path.startsWith('/dispatcher/jobs?')){const ids=new URL('http://local'+path).searchParams.get('ids')!.split(',');assert.ok(ids.length<=100);return send({receipts:ids.flatMap(id=>jobs.has(id)?[jobs.get(id)]:[])});}
   if(path.endsWith('/cancel')){const id=path.split('/')[3],r=jobs.get(id)!;const updated={...r,status:'cancelled',activeWork:false,interactionTargets:[]};jobs.set(id,updated as DispatcherReceipt);return send(updated);}
   const interaction=path.match(/^\/runs\/([^/]+)\/interactions(?:\/([^/]+))?$/);
   if(interaction){const run=decodeURIComponent(interaction[1]),entries=questions.get(run)||[];if(method==='GET')return send({interactions:entries});const current=entries.find(q=>q.id===decodeURIComponent(interaction[2]));if(!current)return send({error:'changed'},409);questions.set(run,entries.filter(q=>q!==current));return send({interaction:{...current,status:'answered'}});}
   if(path==='/integrations/credentials/request')return send({receiver:{kind:'mcp',agentId:'worker',agentName:'Worker',name:'Synthetic tools',url:'https://example.test/mcp'},nonce:'nonce-'+body.runId,expiresAt:new Date(Date.now()+60000).toISOString()});
   if(path==='/integrations/credentials/connect'){for(const [run,entries] of questions)if(body.nonce==='nonce-'+run)questions.set(run,[]);return send({configured:true});}
   return send({error:'Unknown synthetic endpoint'},404);
  });
  await page.goto(vite.resolvedUrls!.local[0]+'synthetic-dispatcher');await page.getByRole('textbox',{name:'Message Boss Chat'}).waitFor();
  return {page,calls,jobs,questions,errors,setMode:(value:typeof mode)=>mode=value,setLookupHidden:(value:boolean)=>hideLookup=value,release:()=>late?.(),async close(){await browser?.close();await vite.close();}};
 }catch(error){await browser?.close();await vite.close();throw error;}
}
async function send(page:Page,text:string){await page.getByRole('textbox',{name:'Message Boss Chat'}).fill(text);await page.getByRole('button',{name:'Send to Boss Chat',exact:true}).click();}
async function privateStorage(page:Page){return page.evaluate(()=>JSON.stringify({...sessionStorage,...localStorage}));}
const browserOnly={timeout:45000,skip:process.env.RELAY_BROWSER_LIVE!=='1'};
test('mounted submit, status refresh, open and ambiguous conversational stops preserve only IDs',browserOnly,async()=>{
 const f=await fixture();try{
  await send(f.page,sentinel);await f.page.getByText('Job1',{exact:true}).waitFor();assert.equal(await f.page.getByRole('textbox',{name:'Message Boss Chat'}).inputValue(),'');
  await send(f.page,'new: another request');await f.page.getByText('Job2',{exact:true}).waitFor();await send(f.page,'stop');await f.page.getByText(/Which job/).waitFor();assert.equal(f.calls.filter(c=>c.path.endsWith('/cancel')).length,0);
  await send(f.page,'cancel task-1');await f.page.getByText('Stopped',{exact:true}).waitFor();await send(f.page,'open task-2');assert.deepEqual(await f.page.evaluate(()=>(window as any).opened),[['lead','chat-2']]);
  f.jobs.set('task-2',{...f.jobs.get('task-2')!,status:'done',activeWork:false});await f.page.getByText('Finished',{exact:true}).waitFor();
  const storage=await privateStorage(f.page);assert.doesNotMatch(storage,new RegExp(sentinel+'|another request|chat-2|Lead'));assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
test('mounted lost responses and reload recover by opaque ID without POST replay',browserOnly,async()=>{
 const f=await fixture();try{f.setMode('lost');await send(f.page,sentinel);await f.page.getByText('Job1',{exact:true}).waitFor();assert.equal(f.calls.filter(c=>c.method==='POST'&&c.path==='/dispatcher/submissions').length,1);await f.page.reload();await f.page.getByText('Job1',{exact:true}).waitFor();assert.equal(f.calls.filter(c=>c.method==='POST'&&c.path==='/dispatcher/submissions').length,1);assert.equal(await f.page.getByRole('textbox',{name:'Message Boss Chat'}).inputValue(),'');assert.doesNotMatch(await privateStorage(f.page),new RegExp(sentinel));}finally{await f.close();}
});
test('reset and unmount fence late replies and never replay accepted submissions',browserOnly,async()=>{
 const f=await fixture();try{f.setMode('late');await send(f.page,sentinel);await f.page.waitForFunction(()=>sessionStorage.getItem('relay.dispatcher.ids')?.includes('submissionId'));await f.page.getByRole('button',{name:'Reset Boss Chat view'}).click();await f.release();await f.page.waitForTimeout(100);assert.equal(await f.page.getByText('Job1',{exact:true}).count(),0);assert.equal(await f.page.getByRole('textbox',{name:'Message Boss Chat'}).inputValue(),'');assert.equal(await f.page.evaluate(()=>sessionStorage.getItem('relay.dispatcher.ids')),'[]');await f.page.evaluate(()=>(window as any).unmount());await f.page.evaluate(()=>(window as any).mount());await f.page.getByRole('textbox',{name:'Message Boss Chat'}).waitFor();assert.equal(await f.page.getByText('Job1',{exact:true}).count(),0);await send(f.page,'second private request');await f.page.waitForFunction(()=>sessionStorage.getItem('relay.dispatcher.ids')?.includes('submissionId'));await f.page.evaluate(()=>(window as any).unmount());await f.release();await f.page.evaluate(()=>(window as any).mount());await f.page.getByText('Job1',{exact:true}).waitFor();assert.ok((await privateStorage(f.page)).includes('task-2'));assert.equal(f.calls.filter(c=>c.path==='/dispatcher/submissions').length,2);assert.doesNotMatch(await privateStorage(f.page),new RegExp(sentinel+'|second private request'));}finally{await f.close();}
});
test('recipient selection retains attachments and scope while a fresh explicit submission claims once',browserOnly,async()=>{
 const f=await fixture();try{
  f.setMode('recipient');await f.page.locator('#boss-chat-attachments').setInputFiles({name:'private-source.txt',mimeType:'text/plain',buffer:Buffer.from(sentinel)});await f.page.getByRole('button',{name:'Remove attachment private-source.txt'}).waitFor();
  await send(f.page,sentinel);await f.page.getByRole('button',{name:'Assign to Worker'}).waitFor();assert.equal(await f.page.getByRole('button',{name:'Remove attachment private-source.txt'}).count(),1);
  await f.page.getByRole('button',{name:'Assign to Worker'}).click();await f.page.getByText('Job1',{exact:true}).waitFor();const posts=f.calls.filter(c=>c.path==='/dispatcher/submissions');assert.equal(posts.length,2);assert.notEqual(posts[0].body.submissionId,posts[1].body.submissionId);assert.equal(posts[0].body.draftId,posts[1].body.draftId);assert.deepEqual(posts[1].body.attachmentIds,posts[0].body.attachmentIds);assert.equal(posts[1].body.prompt,sentinel);assert.equal(posts[1].body.agentId,'worker');assert.equal(await f.page.getByRole('button',{name:'Remove attachment private-source.txt'}).count(),0);assert.doesNotMatch(await privateStorage(f.page),new RegExp(sentinel+'|private-source'));
 }finally{await f.close();}
});

test('Boss picker, clipboard, removal, rejected submission and reload preserve recoverable drafts without replay',browserOnly,async()=>{
 const f=await fixture();try{
  await f.page.locator('#boss-chat-attachments').setInputFiles({name:'remove-me.txt',mimeType:'text/plain',buffer:Buffer.from('remove')});await f.page.getByRole('button',{name:'Remove attachment remove-me.txt'}).click();await f.page.getByRole('button',{name:'Remove attachment remove-me.txt'}).waitFor({state:'detached'});
  await f.page.getByRole('textbox',{name:'Message Boss Chat'}).evaluate(el=>{const data=new DataTransfer();data.items.add(new File(['synthetic'],'pasted-source.txt',{type:'text/plain'}));el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));});await f.page.getByRole('button',{name:'Remove attachment pasted-source.txt'}).waitFor();
  f.setMode('reject');await send(f.page,'Keep my draft');await f.page.getByText(/Assignment is unconfirmed/).waitFor();assert.equal(await f.page.getByRole('textbox',{name:'Message Boss Chat'}).inputValue(),'Keep my draft');assert.equal(await f.page.getByRole('button',{name:'Remove attachment pasted-source.txt'}).count(),1);
  const submissionCount=f.calls.filter(c=>c.path==='/dispatcher/submissions').length;await f.page.reload();await f.page.getByRole('button',{name:'Remove attachment pasted-source.txt'}).waitFor();assert.equal(f.calls.filter(c=>c.path==='/dispatcher/submissions').length,submissionCount);assert.equal(await f.page.getByRole('textbox',{name:'Message Boss Chat'}).inputValue(),'');
  f.setMode('accept');await f.page.getByRole('button',{name:'Send to Boss Chat',exact:true}).click();await f.page.getByText('Job1',{exact:true}).waitFor();const body=f.calls.filter(c=>c.path==='/dispatcher/submissions').at(-1)!.body;assert.equal(body.prompt,'');assert.equal(body.attachmentIds.length,1);assert.doesNotMatch(await privateStorage(f.page),/pasted-source|Keep my draft|synthetic/);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('Boss global drop excludes a live masked secure field while composer drop still attaches to the current draft',browserOnly,async()=>{
 const f=await fixture();try{
  await send(f.page,'Start secure worker');await f.page.getByText('Job1',{exact:true}).waitFor();
  f.questions.set('worker-run',[{id:'secure-drop',runId:'worker-run',provider:'openai',kind:'question',title:'Synthetic secure entry',description:'Synthetic only',status:'pending',questions:[{id:'relay-integration-credential:opaque',question:'Secure entry'}]}]);
  f.jobs.set('task-1',{...f.jobs.get('task-1')!,activeWork:true,interactionTargets:[{taskId:'child',agentId:'worker',runId:'worker-run'}]});
  const secure=f.page.getByLabel('Integration token',{exact:true});await secure.waitFor();await secure.fill(secret);assert.equal(await f.page.getByRole('button',{name:'Attach image or document to Boss Chat'}).isEnabled(),true);
  const uploads=()=>f.calls.filter(c=>c.method==='POST'&&/^\/dispatcher\/drafts\/[^/]+\/attachments$/.test(c.path));
  await secure.evaluate(el=>{const data=new DataTransfer();data.items.add(new File(['sensitive source'],'secure-target.txt',{type:'text/plain'}));el.dispatchEvent(new DragEvent('drop',{dataTransfer:data,bubbles:true,cancelable:true}));});await f.page.waitForTimeout(200);
  assert.equal(uploads().length,0);assert.equal(await secure.inputValue(),secret);
  await f.page.getByRole('textbox',{name:'Message Boss Chat'}).evaluate(el=>{const data=new DataTransfer();data.items.add(new File(['ordinary source'],'composer-drop.txt',{type:'text/plain'}));el.dispatchEvent(new DragEvent('drop',{dataTransfer:data,bubbles:true,cancelable:true}));});await f.page.getByRole('button',{name:'Remove attachment composer-drop.txt'}).waitFor();assert.equal(uploads().length,1);assert.equal(await secure.inputValue(),secret);assert.doesNotMatch(JSON.stringify(uploads()),new RegExp(secret));assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('Boss delayed acceptance recovery removes only submitted files and preserves files staged after the lost response',browserOnly,async()=>{
 const f=await fixture();try{
  await f.page.locator('#boss-chat-attachments').setInputFiles({name:'submitted.txt',mimeType:'text/plain',buffer:Buffer.from('first')});await f.page.getByRole('button',{name:'Remove attachment submitted.txt'}).waitFor();
  f.setMode('lost');f.setLookupHidden(true);await send(f.page,'First original request');await f.page.getByText(/Assignment is still being checked/).waitFor();
  await f.page.locator('#boss-chat-attachments').setInputFiles({name:'later.txt',mimeType:'text/plain',buffer:Buffer.from('newer unsent')});await f.page.getByRole('button',{name:'Remove attachment later.txt'}).waitFor();
  f.setLookupHidden(false);await f.page.getByText('Job1',{exact:true}).waitFor();await f.page.getByRole('button',{name:'Remove attachment submitted.txt'}).waitFor({state:'detached'});assert.equal(await f.page.getByRole('button',{name:'Remove attachment later.txt'}).count(),1);
  f.setMode('accept');await send(f.page,'new: Second request');await f.page.getByText('Job2',{exact:true}).waitFor();const posts=f.calls.filter(c=>c.path==='/dispatcher/submissions');assert.equal(posts.length,2);assert.equal(posts[0].body.draftId,posts[1].body.draftId);assert.deepEqual(posts[0].body.attachmentIds,['file-1']);assert.deepEqual(posts[1].body.attachmentIds,['file-2']);assert.equal(await f.page.getByRole('button',{name:'Remove attachment later.txt'}).count(),0);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
test('terminal lead keeps live descendant secure forms attributed, unfocused and current-run isolated',browserOnly,async()=>{
 const f=await fixture();try{
  await send(f.page,'start secure task');await f.page.getByText('Job1',{exact:true}).waitFor();await f.page.getByRole('textbox',{name:'Message Boss Chat'}).focus();
  const question=(runId:string,id:string)=>({id,runId,provider:'openai',kind:'question',title:'Synthetic secure entry',description:'Synthetic only',status:'pending',questions:[{id:'relay-integration-credential:opaque',question:'Secure entry'}]});
  f.questions.set('worker-run',[question('worker-run','secure-1')]);f.jobs.set('task-1',{...f.jobs.get('task-1')!,status:'failed',activeWork:true,interactionTargets:[{taskId:'child',agentId:'worker',runId:'worker-run'}]});
  await f.page.getByLabel('Integration token',{exact:true}).waitFor();assert.equal(await f.page.getByRole('textbox',{name:'Message Boss Chat'}).evaluate(el=>document.activeElement===el),true);assert.equal(await f.page.getByText(/Worker · delegated worker/).count(),1);
  const input=f.page.getByLabel('Integration token',{exact:true});await input.fill(secret);f.questions.set('worker-next',[question('worker-next','secure-2')]);f.jobs.set('task-1',{...f.jobs.get('task-1')!,interactionTargets:[{taskId:'child',agentId:'worker',runId:'worker-next'}]});await f.page.waitForFunction(()=>document.querySelector('input[type=password]')?.getAttribute('disabled')===null);await f.page.waitForTimeout(2300);assert.equal(await input.inputValue(),'');await input.fill(secret);await f.page.getByRole('button',{name:'Connect securely',exact:true}).click();await input.waitFor({state:'detached'});
  const connect=f.calls.find(c=>c.path==='/integrations/credentials/connect')!;assert.equal(connect.body.nonce,'nonce-worker-next');assert.equal(connect.body.token,secret);assert.equal(connect.sensitive,true);assert.ok(!f.calls.filter(c=>c.path.startsWith('/dispatcher')).some(c=>JSON.stringify(c.body).includes(secret)));assert.doesNotMatch(await privateStorage(f.page),new RegExp(secret));await send(f.page,'stop');await f.page.getByText('Stopped',{exact:true}).waitFor();assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
test('conversational answers use a unique live interaction and do not turn guidance into work',browserOnly,async()=>{
 const f=await fixture();try{
  await send(f.page,'first job');await f.page.getByText('Job1',{exact:true}).waitFor();const q={id:'q-1',runId:'run-1',provider:'openai',kind:'question',title:'Choose color',description:'Synthetic question',status:'pending',questions:[{id:'color',question:'Color?'}]};f.questions.set('run-1',[q]);f.jobs.set('task-1',{...f.jobs.get('task-1')!,interactionTargets:[{taskId:'task-1',agentId:'lead',runId:'run-1'}]});await f.page.getByText('Choose color',{exact:true}).waitFor();await send(f.page,'blue');await f.page.waitForTimeout(100);const answer=f.calls.find(c=>c.path==='/runs/run-1/interactions/q-1'&&c.method==='POST');assert.deepEqual(answer?.body,{decision:'allow',answers:{color:['blue']}});await send(f.page,'please use green instead');await f.page.getByText(/Open the assigned chat/).waitFor();assert.equal(f.calls.filter(c=>c.path==='/dispatcher/submissions').length,1);
 }finally{await f.close();}
});
test('friendly job and request references, chat recipient selection and view commands bind exact work',browserOnly,async()=>{
 const f=await fixture();try{
  f.setMode('recipient');await send(f.page,'private choice request');await f.page.getByText('Choose a bot',{exact:true}).waitFor();await send(f.page,'assign @Worker');await f.page.getByText('Job1',{exact:true}).waitFor();assert.equal(f.calls.filter(c=>c.path==='/dispatcher/submissions').length,2);await send(f.page,'open job1');assert.deepEqual(await f.page.evaluate(()=>(window as any).opened),[['worker','chat-1']]);
  const q=(runId:string,id:string)=>({id,runId,provider:'openai',kind:'approval',title:'Synthetic permission '+id,description:'Synthetic only',status:'pending'});
  f.questions.set('run-1',[q('run-1','permission-a')]);f.questions.set('worker-run',[q('worker-run','permission-b')]);f.jobs.set('task-1',{...f.jobs.get('task-1')!,interactionTargets:[{taskId:'task-1',agentId:'worker',runId:'run-1'},{taskId:'child',agentId:'worker',runId:'worker-run'}]});
  await f.page.getByText('Request2',{exact:true}).waitFor();await send(f.page,'approve');await f.page.getByText(/Which job and request/).waitFor();assert.equal(f.calls.filter(c=>c.path.includes('/interactions/')&&c.method==='POST').length,0);await send(f.page,'Request2: approve');await f.page.waitForTimeout(100);assert.equal(f.calls.find(c=>c.path==='/runs/worker-run/interactions/permission-b'&&c.method==='POST')?.body.decision,'allow');
  await send(f.page,'cancel job1');await f.page.getByText('Stopped',{exact:true}).waitFor();assert.equal(await f.page.evaluate(()=>sessionStorage.getItem('relay.dispatcher.ids')),'[]');await send(f.page,'reset');await f.page.getByText(/View cleared/).waitFor();assert.equal(await f.page.getByText('Job1',{exact:true}).count(),0);await send(f.page,'recover');await f.page.waitForTimeout(100);assert.equal(await f.page.getByText('Job1',{exact:true}).count(),0);assert.equal(f.calls.filter(c=>c.path==='/dispatcher/submissions').length,2);
  f.setMode('recipient');await send(f.page,'another choice');await f.page.getByText('Choose a bot',{exact:true}).waitFor();await send(f.page,'discard');await f.page.getByText('Pending request discarded.').waitFor();assert.equal(f.calls.filter(c=>c.path==='/dispatcher/submissions').length,3);
 }finally{await f.close();}
});
test('late accepted response preserves text typed while assignment is in flight',browserOnly,async()=>{
 const f=await fixture();try{f.setMode('late');await send(f.page,'old request');await f.page.waitForFunction(()=>sessionStorage.getItem('relay.dispatcher.ids')?.includes('submissionId'));await f.page.getByRole('textbox',{name:'Message Boss Chat'}).fill('new unsent RAM draft');await f.release();await f.page.getByText('Job1',{exact:true}).waitFor();assert.equal(await f.page.getByRole('textbox',{name:'Message Boss Chat'}).inputValue(),'new unsent RAM draft');assert.doesNotMatch(await privateStorage(f.page),/new unsent RAM draft|old request/);}finally{await f.close();}
});
test('button recipient assignment preserves the unrelated unsent composer draft',browserOnly,async()=>{
 const f=await fixture();try{f.setMode('recipient');await send(f.page,'recipient request');await f.page.getByText('Choose a bot',{exact:true}).waitFor();await f.page.getByRole('textbox',{name:'Message Boss Chat'}).fill('unrelated unsent draft');await f.page.getByRole('button',{name:'Assign to Worker',exact:true}).click();await f.page.getByText('Job1',{exact:true}).waitFor();assert.equal(await f.page.getByRole('textbox',{name:'Message Boss Chat'}).inputValue(),'unrelated unsent draft');assert.equal(f.calls.filter(c=>c.path==='/dispatcher/submissions').at(-1)?.body.prompt,'recipient request');}finally{await f.close();}
});
test('actual browser HTTP delegates exact request, enters secure nonce and finishes explicit task outcome',{timeout:60000,skip:process.env.RELAY_BROWSER_LIVE!=='1'||process.env.RELAY_DISPATCHER_HOST_UI!=='1'},async()=>{const {dispatcherHostUi}=await import('./fixtures/dispatcher-host-ui.js');await dispatcherHostUi();});
test('secure focus policy uses the current view while ordinary chat keeps its default autofocus',browserOnly,async()=>{
 for(const kind of ['integration','typesafe'])for(const background of [true,false]){
  const f=await fixture();let release:(()=>Promise<void>)|undefined;try{
   await f.page.route('**/api/integrations/**',async route=>{const path=new URL(route.request().url()).pathname;if(path.endsWith('/typesafe'))return route.fulfill({contentType:'application/json',body:JSON.stringify({configured:false,enabled:false,models:[],storage:{available:true}})});release=()=>route.fulfill({contentType:'application/json',body:JSON.stringify({receiver:{kind:'mcp',agentId:'worker',agentName:'Worker',name:'Synthetic tools',url:'https://example.test/mcp'},nonce:'focus-nonce',expiresAt:new Date(Date.now()+60000).toISOString()})});});
   await f.page.evaluate(kind=>(window as any).mountSecure(undefined,kind),kind);const input=f.page.getByLabel(kind==='typesafe'?'TypeSafe API key':'Integration token',{exact:true});await input.waitFor();for(let n=0;n<50&&!release;n++)await f.page.waitForTimeout(20);assert.ok(release);
   await f.page.getByRole('button',{name:'Focus anchor'}).focus();if(background)await f.page.evaluate(kind=>(window as any).mountSecure(false,kind),kind);await f.page.waitForTimeout(50);await release!();await input.waitFor({state:'visible'});await f.page.waitForFunction(()=>!(document.querySelector('input[type=password]') as HTMLInputElement)?.disabled);await f.page.waitForTimeout(50);assert.equal(await input.evaluate(el=>document.activeElement===el),!background,kind+' current focus policy');
  }finally{await f.close();}
 }
});
test('stale and unknown explicit request references never fall back across jobs or changed runs',browserOnly,async()=>{
 const f=await fixture();const question=(runId:string,id:string)=>({id,runId,provider:'openai',kind:'question',title:id,description:'Synthetic question',status:'pending',questions:[{id:'color',question:'Color?'}]});
 try{
  await send(f.page,'first request');await f.page.getByText('Job1',{exact:true}).waitFor();f.questions.set('run-1',[question('run-1','old-question')]);f.jobs.set('task-1',{...f.jobs.get('task-1')!,interactionTargets:[{taskId:'task-1',agentId:'lead',runId:'run-1'}]});await f.page.getByText('Request1',{exact:true}).waitFor();await send(f.page,'blue');await f.page.getByText('Answer accepted by the assigned bot.').waitFor();
  await send(f.page,'new: second request');await f.page.getByText('Job2',{exact:true}).waitFor();f.jobs.set('task-1',{...f.jobs.get('task-1')!,status:'done',activeWork:false,interactionTargets:[]});f.questions.set('run-2',[question('run-2','second-question')]);f.jobs.set('task-2',{...f.jobs.get('task-2')!,interactionTargets:[{taskId:'task-2',agentId:'lead',runId:'run-2'}]});await f.page.getByText('Request2',{exact:true}).waitFor();
  const posts=()=>f.calls.filter(c=>c.method==='POST'&&c.path.includes('/interactions/'));
  for(const text of ['Request1: stale cross-job answer','Request999: unknown answer','Job999: unknown job','@Unknown: unknown bot']){await send(f.page,text);await f.page.waitForTimeout(100);assert.equal(posts().length,1,text);await f.page.getByText(/That request reference is not current/).waitFor();}
  f.questions.set('run-2-next',[question('run-2-next','current-question')]);f.jobs.set('task-2',{...f.jobs.get('task-2')!,runId:'run-2-next',interactionTargets:[{taskId:'task-2',agentId:'lead',runId:'run-2-next'}]});await f.page.getByText('Request3',{exact:true}).waitFor();await send(f.page,'Request2: stale changed-run answer');await f.page.getByText(/That request reference is not current/).waitFor();assert.equal(posts().length,1);assert.equal(f.calls.filter(c=>c.method==='POST'&&c.path==='/dispatcher/submissions').length,2);
  await send(f.page,'Request3: green');await f.page.getByText('Answer accepted by the assigned bot.').waitFor();assert.deepEqual(posts().at(-1)?.body,{decision:'allow',answers:{color:['green']}});assert.equal(posts().at(-1)?.path,'/runs/run-2-next/interactions/current-question');
  f.jobs.set('task-2',{...f.jobs.get('task-2')!,status:'done',activeWork:false,interactionTargets:[]});await f.page.getByText('Finished',{exact:true}).last().waitFor();await send(f.page,'Request999: no remaining question');await f.page.getByText(/That request reference is not current/).waitFor();assert.equal(f.calls.filter(c=>c.method==='POST'&&c.path==='/dispatcher/submissions').length,2);
 }finally{await f.close();}
});
test('reserved question IDs survive as own JSON answer keys at the original endpoint',browserOnly,async()=>{
 const f=await fixture();try{await send(f.page,'reserved ID request');await f.page.getByText('Job1',{exact:true}).waitFor();f.questions.set('run-1',[{id:'reserved-question',runId:'run-1',provider:'openai',kind:'question',title:'Reserved question',description:'Synthetic question',status:'pending',questions:[{id:'__proto__',question:'Reserved answer?'}]}]);f.jobs.set('task-1',{...f.jobs.get('task-1')!,interactionTargets:[{taskId:'task-1',agentId:'lead',runId:'run-1'}]});await f.page.getByText('Reserved question',{exact:true}).waitFor();await send(f.page,'own answer');await f.page.getByText('Answer accepted by the assigned bot.').waitFor();const answer=f.calls.find(c=>c.method==='POST'&&c.path==='/runs/run-1/interactions/reserved-question');assert.ok(answer);assert.equal(Object.hasOwn(answer.body.answers,'__proto__'),true);assert.deepEqual(answer.body.answers.__proto__,['own answer']);assert.equal(f.calls.filter(c=>c.path==='/dispatcher/submissions').length,1);}finally{await f.close();}
});
test('unprefixed URLs, Windows paths and multi-question colon formats remain literal answers',browserOnly,async()=>{
 const f=await fixture();try{
  await send(f.page,'colon answer request');await f.page.getByText('Job1',{exact:true}).waitFor();f.jobs.set('task-1',{...f.jobs.get('task-1')!,interactionTargets:[{taskId:'task-1',agentId:'lead',runId:'run-1'}]});
  for(const [id,text,questions,answers] of [
   ['url-question','https://example.test/a:b',[{id:'location',question:'Location?'}],{location:['https://example.test/a:b']}],
   ['path-question','C:\\synthetic\\folder:detail',[{id:'location',question:'Location?'}],{location:['C:\\synthetic\\folder:detail']}],
   ['multi-question','color: blue\nlocation: https://example.test/a:b',[{id:'color',question:'Color?'},{id:'location',question:'Location?'}],{color:['blue'],location:['https://example.test/a:b']}],
  ] as const){f.questions.set('run-1',[{id,runId:'run-1',provider:'openai',kind:'question',title:id,description:'Synthetic question',status:'pending',questions}]);await f.page.getByText(id,{exact:true}).waitFor();await send(f.page,text);await f.page.getByText(id,{exact:true}).waitFor({state:'detached'});const answer=f.calls.find(c=>c.path==='/runs/run-1/interactions/'+id&&c.method==='POST');assert.deepEqual(answer?.body,{decision:'allow',answers});}
  assert.equal(f.calls.filter(c=>c.path==='/dispatcher/submissions').length,1);
 }finally{await f.close();}
});
test('first-job bot mentions validate recipients while stale no-pending request references never submit',browserOnly,async()=>{
 const f=await fixture();try{
  await send(f.page,'Request999: stale answer');await f.page.getByText(/That request reference is not current/).waitFor();assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
  await send(f.page,'@Unknown: build something');await f.page.getByText(/That bot mention is ambiguous or unavailable/).waitFor();assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
  await send(f.page,'@Worker: build something');await f.page.getByText('Job1',{exact:true}).waitFor();const posts=f.calls.filter(c=>c.method==='POST'&&c.path==='/dispatcher/submissions');assert.equal(posts.length,1);assert.equal(posts[0].body.agentId,'worker');assert.equal(posts[0].body.prompt,'build something');
 }finally{await f.close();}
});

test('Boss picker assigns the selected bot and keeps pending recipient selection working',browserOnly,async()=>{
 const f=await fixture();try{
  const input=f.page.getByRole('textbox',{name:'Message Boss Chat'}),picker=f.page.getByRole('listbox',{name:'Choose a bot'});await input.fill('@work');await picker.getByRole('option').waitFor();await input.press('Enter');assert.equal(await input.inputValue(),'@Worker: ');assert.equal(f.calls.filter(c=>c.path==='/dispatcher/submissions').length,0);await input.press('End');await input.press('a');await f.page.getByRole('button',{name:'Send to Boss Chat',exact:true}).click();await f.page.getByText('Job1',{exact:true}).waitFor();let posts=f.calls.filter(c=>c.path==='/dispatcher/submissions');assert.equal(posts.length,1);assert.equal(posts[0].body.agentId,'worker');assert.equal(posts[0].body.prompt,'a');
  await f.page.getByRole('button',{name:'Reset Boss Chat view'}).click();f.setMode('recipient');await send(f.page,'Choose someone for this task');await f.page.getByRole('button',{name:'Assign to Worker'}).waitFor();await input.fill('@work');await picker.getByRole('option').waitFor();await input.press('Enter');await picker.waitFor({state:'detached'});await input.press('Enter');await f.page.getByText('Job1',{exact:true}).waitFor();posts=f.calls.filter(c=>c.path==='/dispatcher/submissions');assert.equal(posts.length,3);assert.equal(posts[2].body.agentId,'worker');assert.equal(posts[2].body.prompt,'Choose someone for this task');assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});