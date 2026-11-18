import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
import {chromium, type Page, type Locator} from 'playwright';
import {png as attachmentPng} from './fixtures/attachment-inputs.js';

const date='2026-11-04T12:00:00Z';
const agent={id:'a',name:'Mira',role:'Assistant',initials:'M',color:'#657e70',instructions:'',memory:'',routeMode:'openai',model:'vision',mode:'chat',workspace:'',pinned:false,unread:false,lastMessage:'',createdAt:date,updatedAt:date};
const other={...agent,id:'b',name:'Sol'};
const conversation={id:'c',agentId:'a',title:'Chat polish',createdAt:date,updatedAt:date};
const room={id:'g',title:'Studio',agentIds:['a','b'],mode:'roundtable',moderatorAgentId:null,createdAt:date,updatedAt:date};
const provider={id:'openai',installed:true,authenticated:true,authMode:'subscription',models:[{id:'vision',name:'Vision',verified:true,inputModalities:['text','image'],inputModalitiesSource:'provider-catalog'}],billing:{confirmed:true,mode:'included',automaticRouting:true},modelPreferences:{defaultModel:'vision',allowedModels:null}};
const png=attachmentPng();
const run={id:'r',agentId:'a',conversationId:'c',messageId:'bot',status:'complete',route:null,error:null,startedAt:date,endedAt:date,mode:'chat',usageObservation:{availability:'reported',provider:'openai',accountKey:null,scope:'run',source:'provider-response',observedAt:date,tokens:{inputTokens:12,outputTokens:8,cachedInputTokens:null,cacheWriteTokens:null,totalTokens:20,reasoningTokens:null},rawCostCents:null,chargedCents:null}};

async function setup(page:Page, group=false){
  const direct:any[]=[{id:'own',conversationId:'c',role:'user',content:'My **brief** with https://example.com/brief',status:'complete',createdAt:date},{id:'internal',conversationId:'c',role:'user',origin:'task-continuation',content:'INTERNAL CONTROL PROMPT',status:'complete',createdAt:date},{id:'bot',conversationId:'c',role:'assistant',content:'## A clear answer\n\nA **useful** [reference](https://example.com/answer).\n\n- First\n- Second\n\n```ts\nconst ready = true;\n```',status:'complete',createdAt:date,runId:'r'}];
  const groupMessages:any[]=[{id:'g-own',roomId:'g',role:'user',authorName:'You',content:'Our **group brief** https://example.com/group',status:'complete',createdAt:date},{id:'g-bot',roomId:'g',agentId:'a',role:'assistant',authorName:'Mira',content:'A **shared** [reference](https://example.com/shared)',status:'complete',createdAt:date}];
  const posts:{path:string;body:any}[]=[],groupUploads:{path:string;body:any;attachment:any}[]=[],groupDrafts=new Map<string,any>();let uploads=0, failUpload=false;
  await page.addInitScript(({group})=>{localStorage.setItem('relay.agent','a');if(group)localStorage.setItem('relay.room','g');(window as any).EventSource=class{addEventListener(){}close(){}};(window as any).SpeechRecognition=class{start(){}stop(){}abort(){}};},{group});
  await page.route('**/api/**',async route=>{
    const req=route.request(),path=new URL(req.url()).pathname.slice(4);let value:any={},status=200;
    if(path==='/bootstrap')value={csrfToken:'test',agents:[agent,other],conversations:[conversation],rooms:[room],providers:[provider],settings:{maxRunSeconds:60,maxModelCalls:5}};
    else if(path==='/providers/refresh')value={providers:[provider]};
    else if(path==='/agents/a')value={agent,conversations:[conversation],files:[]};
    else if(path==='/conversations/c')value={conversation,messages:direct,runs:[run]};
    else if(path==='/groups/g')value={room,messages:groupMessages,runs:[]};
    else if(path==='/conversations/c/attachments'&&req.method()==='POST'){
      uploads++;if(failUpload){status=400;value={error:'Image exceeds pixel limit'};}else value={id:'image-'+uploads,name:req.postDataJSON().name,kind:'image',mimeType:'image/png',size:png.length,sha256:'test',width:2,height:2};
    }else if(path==='/groups/g/attachments'&&req.method()==='POST'){
      const body=req.postDataJSON();assert.deepEqual(Buffer.from(body.base64,'base64'),png);uploads++;status=201;value={id:randomUUID(),name:body.name,kind:'image',mimeType:'image/png',size:png.length,sha256:createHash('sha256').update(png).digest('hex'),width:2,height:2};groupDrafts.set(value.id,value);groupUploads.push({path,body,attachment:value});
    }else if(path==='/groups/g/attachments'&&req.method()==='GET')value=[...groupDrafts.values()];
    else if(path.includes('/attachments/')&&req.method()==='GET'){await route.fulfill({contentType:'image/png',body:png});return;}
    else if(path.endsWith('/attachments'))value=[];
    else if(path==='/conversations/c/messages'){
      const body=req.postDataJSON();posts.push({path,body});const n=posts.length;
      const inputMessage={id:'sent-'+n,conversationId:'c',role:'user',content:body.content,replyToId:body.replyToId,status:'complete',createdAt:date};
      const message={id:'answer-'+n,conversationId:'c',role:'assistant',content:'Received.',status:'complete',createdAt:date};direct.push(inputMessage,message);status=202;value={inputMessage,message,run:{...run,id:'run-'+n,messageId:message.id}};
    }else if(path==='/groups/g/runs'){
      const body=req.postDataJSON(),ids=body.attachmentIds??[];assert.equal(Array.isArray(ids),true);assert.equal(new Set(ids).size,ids.length);const attachments=ids.map((id:string)=>{const item=groupDrafts.get(id);assert.ok(item,'Only an owned group draft may be claimed');return item;});for(const id of ids)groupDrafts.delete(id);posts.push({path,body});const message={id:'g-sent-'+posts.length,roomId:'g',role:'user',authorName:'You',content:body.content,replyToId:body.replyToId,...(attachments.length?{attachments}:{}),status:'complete',createdAt:date};groupMessages.push(message);status=202;value={message,run:{id:'gr-'+posts.length,roomId:'g',status:'complete',mode:'roundtable',executionMode:'bounded',startedAt:date,endedAt:date,completedReplies:0,modelCalls:0}};
    }else if(path==='/tasks')value={tasks:[{id:'task',agentId:'a',conversationId:'c',runIds:['r'],status:'done',recoveryRequired:false,outcome:{summary:'VERBOSE COMPLETION SUMMARY',remaining:[]}}]};
    else if(path==='/health')value={service:'relay',ok:true,instanceId:'test'};
    else if(path.endsWith('/interactions'))value={interactions:[]};
    await route.fulfill({status,json:value});
  });
  return {posts,groupUploads,get groupDraftCount(){return groupDrafts.size;},get uploads(){return uploads;},failUploads(){failUpload=true;}};
}

async function pasteImage(composer:Locator){return composer.evaluate((element,bytes)=>{const data=new DataTransfer();data.items.add(new File([Uint8Array.from(bytes)],'clipboard.png',{type:'image/png'}));const event=new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true});element.dispatchEvent(event);return event.defaultPrevented;},Array.from(png));}
async function snapshot(page:Page,name:string){await mkdir('.data-ui-preview/chat-polish',{recursive:true});await page.screenshot({path:`.data-ui-preview/chat-polish/${name}.png`,fullPage:true});}

test('direct chat renders both speakers, persists reply anchors and accepts event images without intercepting text',{timeout:60000,skip:process.env.RELAY_BROWSER_LIVE!=='1'},async()=>{
  const vite=await createServer({server:{port:0,host:'127.0.0.1'},logLevel:'error'});let browser;
  try{
    await vite.listen();browser=await chromium.launch({headless:true,channel:process.env.RELAY_TEST_BROWSER_CHANNEL});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));const fixture=await setup(page);
    await page.goto(vite.resolvedUrls!.local[0]);const composer=page.getByRole('textbox',{name:'Message Mira',exact:true});await composer.waitFor();
    await page.getByRole('heading',{name:'A clear answer'}).waitFor();assert.equal(await page.locator('#message-c-own strong').getByText('brief',{exact:true}).count(),1);assert.equal(await page.locator('#message-c-own a[href="https://example.com/brief"]').count(),1);assert.equal(await page.locator('#message-c-bot a[href="https://example.com/answer"]').count(),1);
    assert.equal(await page.getByText('INTERNAL CONTROL PROMPT',{exact:true}).count(),0);assert.equal(await page.getByLabel('Reported provider usage').count(),0);assert.equal(await page.getByText(/VERBOSE COMPLETION SUMMARY/).count(),0);
    await page.getByRole('button',{name:'Reply to your message',exact:true}).click();assert.equal(await composer.evaluate(el=>el===document.activeElement),true);await page.getByText('Replying to You',{exact:true}).waitFor();await page.getByRole('button',{name:'Cancel reply'}).click();assert.equal(await page.getByText('Replying to You',{exact:true}).count(),0);
    await page.getByRole('button',{name:'Reply to Mira',exact:true}).click();assert.equal(await page.locator('.composer-reply .reply-quote-content > span').innerText(),'A clear answer A useful reference. First Second const ready = true;');await composer.fill('A reply to the bot');await composer.press('Enter');await page.locator('#message-c-sent-1').waitFor();assert.equal(fixture.posts[0].body.replyToId,'bot');
    await page.reload();await page.locator('#message-c-sent-1').getByRole('button',{name:'View original message from Mira'}).waitFor();const quote=page.locator('#message-c-sent-1').getByRole('button',{name:'View original message from Mira'});await quote.focus();await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>document.activeElement?.id),'message-c-bot');assert.equal(await page.locator('#message-c-bot').evaluate(el=>el.classList.contains('reply-source-highlight')),true);
    await page.locator('#message-c-own').getByRole('button',{name:'Reply to your message'}).click();await composer.fill('A reply to my brief');await composer.press('Enter');await page.locator('#message-c-sent-2').waitFor();assert.equal(fixture.posts[1].body.replyToId,'own');
    const textPrevented=await composer.evaluate(element=>{const data=new DataTransfer();data.setData('text/plain','ordinary text');const event=new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true});element.dispatchEvent(event);return event.defaultPrevented;});assert.equal(textPrevented,false);
    await composer.focus();assert.equal(await pasteImage(composer),true);await page.locator('.input-attachments img').waitFor();assert.equal(fixture.uploads,1);assert.equal(await page.locator('.input-attachments img').count(),1);const micBox=await page.getByRole('button',{name:'Start dictation',exact:true}).boundingBox(),sendBox=await page.getByRole('button',{name:'Send message',exact:true}).boundingBox();assert.ok(micBox&&sendBox);assert.ok(sendBox.x>=micBox.x+micBox.width&&sendBox.x-(micBox.x+micBox.width)<=16,'microphone sits directly beside Send');assert.ok(Math.abs(micBox.y+micBox.height/2-sendBox.y-sendBox.height/2)<=2,'microphone and Send share a row');
    fixture.failUploads();await pasteImage(composer);await page.getByText(/Could not attach file: Image exceeds pixel limit/).waitFor();await page.getByRole('button',{name:'Dismiss error',exact:true}).click();await snapshot(page,'direct-desktop');
    await page.evaluate(()=>{localStorage.setItem('relay.advanced','true');});await page.reload();await page.getByLabel('Reported provider usage').waitFor();await page.getByText(/VERBOSE COMPLETION SUMMARY/).waitFor();
    await page.setViewportSize({width:390,height:844});await page.evaluate(()=>localStorage.setItem('relay.advanced','false'));await page.reload();await composer.waitFor();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);await snapshot(page,'direct-narrow');assert.deepEqual(errors,[]);
  }finally{await browser?.close();await vite.close();}
});

test('group chat preserves rich text and reply anchors while claiming pasted image attachments',{timeout:45000,skip:process.env.RELAY_BROWSER_LIVE!=='1'},async()=>{
  const vite=await createServer({server:{port:0,host:'127.0.0.1'},logLevel:'error'});let browser;
  try{
    await vite.listen();browser=await chromium.launch({headless:true,channel:process.env.RELAY_TEST_BROWSER_CHANNEL});const page=await browser.newPage({viewport:{width:1200,height:900}});const fixture=await setup(page,true);await page.goto(vite.resolvedUrls!.local[0]);const composer=page.getByRole('textbox',{name:'Discussion topic or follow-up'});await composer.waitFor();await page.locator('#message-g-g-own').waitFor();
    assert.equal(await page.locator('#message-g-g-own strong').getByText('group brief',{exact:true}).count(),1);assert.equal(await page.locator('#message-g-g-bot a[href="https://example.com/shared"]').count(),1);
    await page.getByRole('button',{name:'Reply to Mira',exact:true}).click();assert.equal(await page.locator('.composer-reply .reply-quote-content > span').innerText(),'A shared reference');await composer.fill('Team reply');await composer.press('Enter');await page.locator('#message-g-g-sent-1').waitFor();assert.equal(fixture.posts[0].body.replyToId,'g-bot');
    await page.reload();await page.locator('#message-g-g-sent-1').getByRole('button',{name:'View original message from Mira'}).click();assert.equal(await page.evaluate(()=>document.activeElement?.id),'message-g-g-bot');
    await page.locator('#message-g-g-own').getByRole('button',{name:'Reply to your message'}).click();await composer.fill('Own group reply');await composer.press('Enter');await page.locator('#message-g-g-sent-2').waitFor();assert.equal(fixture.posts[1].body.replyToId,'g-own');
    await composer.fill('Keep this group draft');const textPrevented=await composer.evaluate(element=>{const data=new DataTransfer();data.setData('text/plain','ordinary group text');const event=new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true});element.dispatchEvent(event);return event.defaultPrevented;});assert.equal(textPrevented,false);assert.equal(await composer.inputValue(),'Keep this group draft');
    await composer.focus();assert.equal(await pasteImage(composer),true);const drafts=page.getByLabel('Group draft attachments', {exact:true});await drafts.getByRole('link',{name:'clipboard.png',exact:true}).waitFor();assert.equal(fixture.uploads,1);assert.equal(fixture.groupUploads.length,1);assert.equal(fixture.groupUploads[0].path,'/groups/g/attachments');assert.equal(fixture.groupDraftCount,1);assert.equal(await composer.inputValue(),'Keep this group draft');const image=fixture.groupUploads[0].attachment;
    await composer.press('Enter');const sent=page.locator('#message-g-g-sent-3');await sent.waitFor();assert.equal(fixture.posts.length,3);assert.equal(fixture.posts[2].path,'/groups/g/runs');assert.deepEqual(fixture.posts[2].body.attachmentIds,[image.id]);assert.equal(fixture.posts[2].body.content,'Keep this group draft');assert.equal(fixture.groupDraftCount,0);await drafts.getByRole('link',{name:'clipboard.png',exact:true}).waitFor({state:'detached'});const claimed=sent.getByRole('link',{name:'clipboard.png',exact:true});assert.equal(await claimed.getAttribute('href'),'/api/groups/g/attachments/'+image.id+'?messageId=g-sent-3');await claimed.locator('img').waitFor();
    await page.reload();await page.locator('#message-g-g-sent-3').getByRole('link',{name:'clipboard.png',exact:true}).waitFor();await page.waitForFunction(()=>{const image=document.querySelector<HTMLImageElement>('#message-g-g-sent-3 .attachment-chip img');return !!image?.complete&&image.naturalWidth===2;});assert.equal(await page.getByLabel('Group draft attachments',{exact:true}).getByRole('link',{name:'clipboard.png',exact:true}).count(),0);assert.equal(fixture.uploads,1);await snapshot(page,'group-desktop');await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);await snapshot(page,'group-narrow');
  }finally{await browser?.close();await vite.close();}
});

test('bot picker opens above direct and group composers, filters and selects without sending',{timeout:90000,skip:process.env.RELAY_BROWSER_LIVE!=='1'},async()=>{
 const vite=await createServer({server:{port:0,host:'127.0.0.1'},logLevel:'error'});let browser;
 try{
  await vite.listen();browser=await chromium.launch({headless:true,channel:process.env.RELAY_TEST_BROWSER_CHANNEL});
  for(const group of [false,true]){
   const page=await browser.newPage({viewport:{width:1200,height:900}}),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));const f=await setup(page,group);
   await page.goto(vite.resolvedUrls!.local[0]);const input=page.getByRole('textbox',{name:group?'Discussion topic or follow-up':'Message Mira',exact:true}),picker=page.getByRole('listbox',{name:'Choose a bot'});await input.waitFor();
   await input.fill('mail@example.com');assert.equal(await picker.count(),0);
   await input.fill('@');await picker.waitFor();assert.equal(await picker.getByRole('option').count(),2);const box=await picker.boundingBox(),anchor=await input.boundingBox();assert.ok(box&&anchor&&box.y+box.height<=anchor.y,'picker opens upwards');
   await input.press('ArrowDown');await input.press('Enter');assert.equal(await input.inputValue(),'@Sol: ');assert.equal(f.posts.length,0);assert.equal(await picker.count(),0);
   await input.fill('Please ask @mi');await picker.getByRole('option').waitFor();assert.equal(await picker.getByRole('option').count(),1);await input.press('Tab');assert.equal(await input.inputValue(),'Please ask @Mira: ');assert.equal(f.posts.length,0);
   await page.locator(group?'#message-g-g-bot':'#message-c-bot').getByRole('button',{name:'Reply to Mira',exact:true}).click();await input.fill('@');await picker.waitFor();await input.press('Escape');assert.equal(await picker.count(),0);assert.equal(await page.locator('.composer-reply').count(),1);await input.press('Escape');assert.equal(await page.locator('.composer-reply').count(),0);
   await input.fill('@zebra');await picker.waitFor();assert.equal(await picker.getByRole('option').count(),0);await input.press('Enter');assert.equal(f.posts.length,0);await input.fill('@mi');await picker.waitFor();
   await input.evaluate(el=>el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,isComposing:true})));assert.equal(f.posts.length,0);assert.equal(await input.inputValue(),'@mi');
   await picker.getByRole('option').click();assert.equal(await input.inputValue(),'@Mira: ');assert.equal(await input.evaluate(el=>document.activeElement===el),true);
   for(const theme of ['light','dark']){await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.setViewportSize({width:320,height:740});await input.fill('');await input.fill('@');await picker.waitFor();const b=await picker.boundingBox();assert.ok(b&&b.x>=0&&b.x+b.width<=320&&b.y>=0,'narrow picker remains reachable');await snapshot(page,'mentions-'+(group?'group':'direct')+'-'+theme);await input.press('Escape');}
   await input.fill('@Sol: help');await input.press('Enter');await page.waitForFunction(()=>!document.querySelector('textarea')?.value);assert.equal(f.posts.length,1);assert.equal(f.posts[0].body.content,'@Sol: help');assert.deepEqual(errors,[]);await page.close();
  }
 }finally{await browser?.close();await vite.close();}
});