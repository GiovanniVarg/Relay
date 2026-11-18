import test from 'node:test';
import assert from 'node:assert/strict';
import {ClaudeAdapter, ClaudeStream} from '../server/providers/claude.js';
import {resolveCapabilities} from '../shared/capabilities.js';
import {searchModelCatalog} from '../server/model-catalog.js';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import type {ProviderRequest} from '../shared/types.js';
import {CLAUDE_AGENT_SETTINGS} from '../server/providers/claude.js';
import {JsonLines,type Launcher} from '../server/providers/process.js';
import {png} from './fixtures/attachment-inputs.js';

test('actual Claude catalog admits images only with its exact reviewed transport binding', async () => {
  const adapter = new ClaudeAdapter('unused', {command: async () => null});
  const catalog = (await adapter.inspect()).models;
  for (const model of catalog) {
    const resolve = (value: typeof model) => resolveCapabilities({provider:'claude', model:value, mode:'chat', host:{nativeToolsAvailable:false, callableTools:[], transportInputModalities:['text','image']}, requiredInputModalities:['image']});
    assert.equal(resolve(model).eligible, true, model.id);
    assert.equal((model as any).imageModelBinding.model, `claude-${model.id}-5-5`);
    assert.equal(resolve({...model, imageModelBinding:undefined} as typeof model).eligible, false);
    assert.equal(resolve({...model, imageModelBinding:{model:'claude-sonnet-other',contract:'claude-image-pin/v1'}} as typeof model).eligible, false);
    assert.equal(resolve({...model, id:'unknown'}).eligible, false);
    assert.equal(resolve({...model, inputModalitiesSource:undefined}).eligible, false);
  }
  const bounded=searchModelCatalog([{id:'claude',models:catalog}] as any,{},10_000);
  assert.equal(bounded.items.length,3);
  for(const model of bounded.items) assert.deepEqual(model.imageModelBinding, catalog.find(m=>m.id===model.id)?.imageModelBinding);
});

const pinned = 'claude-sonnet-5-5';
const success = (models?: string[]) => ({type:'result',subtype:'success',result:'Done',...(models ? {modelUsage:Object.fromEntries(models.map(id=>[id,{}]))} : {})});
function stream(native = false) { return new ClaudeStream(()=>{},'sonnet',native ? 'native' : false,new Set(),pinned); }
test('image model evidence rejects wrong or missing primary model before accepting results', () => {
  for (const model of ['sonnet','claude-sonnet-4-6','claude-sonnet-5-5-extra','claude-opus-5-5']) {
    assert.throws(()=>stream().accept({type:'assistant',message:{model,content:[{type:'text',text:'Wrong'}]}}),/image model/);
    assert.throws(()=>stream().accept({type:'system',subtype:'init',model}),/image model/);
  }
  for (const models of [undefined,[],['claude-sonnet-4-6'],[pinned,'claude-haiku-5-5']]) assert.throws(()=>stream().accept(success(models)),/image model/);
  const valid = stream(); valid.accept(success([pinned])); assert.equal(valid.finish(0).actualModel,'sonnet');
});
test('exact primary evidence permits auxiliary model usage and ignores nested native subagents', () => {
  {
    const parser=stream(true);
    parser.accept({type:'assistant',message:{model:pinned,content:[]}});
    parser.accept({type:'assistant',parent_tool_use_id:'worker',message:{model:'claude-haiku-5-5',content:[]}});
    parser.accept(success([pinned,'claude-haiku-5-5'])); assert.equal(parser.finish(0).text,'Done');
    assert.throws(()=>parser.accept({type:'assistant',message:{model:'claude-sonnet-4-6',content:[]}}),/image model/);
  }
});

test('init selection alone cannot override missing, wrong or mixed response evidence', () => {
  for(const models of [undefined,[],['claude-opus-5-5'],[pinned,'claude-opus-5-5']]) {
    const parser=stream(true);
    parser.accept({type:'system',subtype:'init',model:pinned});
    assert.throws(()=>parser.accept(success(models)),/image model/);
  }
  const valid=stream(true);
  valid.accept({type:'system',subtype:'init',model:pinned});
  valid.accept(success([pinned]));
  assert.equal(valid.finish(0).text,'Done');
});

test('native continuation requires fresh response evidence before each terminal result', () => {
  for(const continuation of ['result-only','model-less-assistant','delta'] as const) for(const models of [undefined,[],['claude-opus-5-5'],[pinned,'claude-opus-5-5']]) {
    const parser=stream(true);
    parser.accept({type:'assistant',message:{model:pinned,content:[]}});
    parser.accept(success([pinned]));
    if(continuation==='model-less-assistant') parser.accept({type:'assistant',message:{content:[]}});
    if(continuation==='delta') parser.accept({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'Done'}}});
    assert.throws(()=>parser.accept(success(models)),/image model/);
  }
  const valid=stream(true);
  valid.accept({type:'assistant',message:{model:pinned,content:[]}});valid.accept(success([pinned]));
  valid.accept({type:'assistant',message:{model:pinned,content:[]}});valid.accept(success([pinned,'claude-haiku-5-5']));
  assert.equal(valid.finish(0).text,'Done');
});

test('primary streaming message_start model is validated before any delta and nested native streams stay excluded', () => {
  const start=(model:string)=>({type:'stream_event',event:{type:'message_start',message:{type:'message',role:'assistant',model,content:[]}}});
  for(const model of ['claude-opus-5-5','sonnet',`${pinned}-extra`]) assert.throws(()=>stream().accept(start(model)),/image model/);
  const valid=stream(true);
  valid.accept({...start('claude-opus-5-5'),parent_tool_use_id:'worker'});
  valid.accept(start(pinned));valid.accept(success([pinned,'claude-haiku-5-5']));
  assert.equal(valid.finish(0).text,'Done');
});

test('documented primary fallback blocks and fallback usage fail closed', () => {
  const fallback={type:'fallback',from:{model:pinned},to:{model:'claude-opus-5-5'},trigger:{type:'refusal',category:null}};
  for(const report of [
    {type:'stream_event',event:{type:'content_block_start',index:0,content_block:fallback}},
    {type:'stream_event',event:{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{iterations:[{type:'fallback_message',model:'claude-opus-5-5'}]}}},
    {type:'assistant',message:{model:pinned,content:[fallback]}},
    {type:'assistant',message:{model:pinned,content:[],usage:{iterations:[{type:'fallback_message',model:'claude-opus-5-5'}]}}},
    {...success([pinned]),usage:{iterations:[{type:'fallback_message',model:'claude-opus-5-5'}]}}
  ]) {
    const parser=stream(true);parser.accept({type:'assistant',message:{model:pinned,content:[]}});
    assert.throws(()=>parser.accept(report),/image model/);
  }
});

test('actual adapter pins each approved alias in every mode and fails closed on ambiguous image results', async () => {
  const dir=await mkdtemp(join(tmpdir(),'relay-claude-binding-'));
  const bytes=png();
  const expectedAccount={accountLabel:'fixture@example.test',plan:'team'};
  try {
    for(const mode of ['chat','work','agent'] as const) for(const alias of ['sonnet','opus','haiku']) {
      const exact=`claude-${alias}-5-5`;
      for(const report of ['exact','wrong','missing','mixed','contradiction','primary-auxiliary'] as const) {
        const events:{type:string}[]=[];
        const launcher:Launcher=(_command,args)=>{
          let closed=false;
          const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),pid:876543,exitCode:null as number|null,signalCode:null,kill(){end();return true;}});
          const end=()=>{if(!closed){closed=true;child.exitCode=0;child.emit('close',0,null);}};
          const send=(value:unknown)=>child.stdout.write(JSON.stringify(value)+'\n');
          child.stdin.once('finish',end);
          if(args.includes('status')) {
            child.stdin.prependOnceListener('finish',()=>child.stdout.write(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',email:expectedAccount.accountLabel,subscriptionType:expectedAccount.plan})));
          } else {
            assert.equal(args[args.indexOf('--model')+1],exact);
            const parser=new JsonLines(message=>queueMicrotask(()=>{
              if(message.type==='control_request') send({type:'control_response',response:{subtype:'success',request_id:message.request_id,response:message.request.subtype==='initialize'?{model:exact,current_permission_mode:'default',account:{email:expectedAccount.accountLabel,subscriptionType:'Claude Team',apiProvider:'firstParty'}}:{effective:CLAUDE_AGENT_SETTINGS}}});
              if(message.type==='user') {
                send({type:'system',subtype:'init',model:exact});
                assert.deepEqual(Buffer.from(message.message.content.find((p:any)=>p.type==='image').source.data,'base64'),bytes);
                if(report==='primary-auxiliary'||report==='contradiction') send({type:'assistant',message:{model:exact,content:[]}});
                if(report==='contradiction') send({type:'system',subtype:'init',model:'claude-sonnet-4-6'});
                send(success(report==='missing'?undefined:report==='wrong'?['claude-sonnet-4-6']:report==='mixed'||report==='primary-auxiliary'?[exact,'claude-haiku-4-5']:[exact]));
                if(mode==='agent') send({type:'system',subtype:'session_state_changed',state:'idle'}); else end();
              }
            }));
            child.stdin.on('data',chunk=>parser.push(chunk));
          }
          return child as unknown as ChildProcessWithoutNullStreams;
        };
        const adapter=new ClaudeAdapter(dir,{command:async()=>({file:'synthetic',args:[]}),launcher,kill:async child=>{child.kill();}});
        const request:ProviderRequest={runId:'r',conversationId:'c',model:alias,mode,instructions:'Inspect image',history:[{role:'user',content:'Inspect',messageId:'source',imageRefs:['image']}],imageTable:[{attachmentId:'image',messageId:'source',sha256:createHash('sha256').update(bytes).digest('hex'),mimeType:'image/png',data:bytes.toString('base64'),width:2,height:2}],expectedAccount,maxSeconds:10,...(mode!=='chat'?{workspace:dir}:{}),...(mode==='agent'?{interact:async()=>({decision:'deny' as const})}:{})};
        try {
          const result=adapter.stream(request,event=>events.push(event),new AbortController().signal);
          if(report==='exact'||report==='primary-auxiliary') assert.equal((await result).actualModel,alias);
          else {await assert.rejects(result,/image model/);assert.deepEqual(events.filter(event=>event.type==='delta'),[]);}
        } finally {await adapter.close();}
      }
    }
  } finally {await rm(dir,{recursive:true,force:true});}
});
