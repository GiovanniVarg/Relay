import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {Store} from '../server/store.js';
import {RoutingInsights,type RoutingObservation} from '../server/routing-insights.js';
import {AppControls,type AppControlServices} from '../server/app-controls.js';
import {workspaceApi} from '../server/workspace-api.js';
import {accountUsageKey} from '../server/provider-usage.js';
import type {ProviderConnection,Run} from '../shared/types.js';
test('host channels assign feedback provenance, reject forged sources and retain operator votes across agent updates',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'relay-feedback-provenance-')),store=new Store(dir);
 const state:ProviderConnection={id:'openai',installed:true,authenticated:true,authMode:'subscription',accountLabel:'fixture',plan:'fixture',models:[]};
 const insights=new RoutingInsights(store,()=>[state]),services={routing:insights} as AppControlServices,controls=new AppControls(store,services),scope={runId:'actor',agentId:'bot',signal:new AbortController().signal,isActive:()=>true};
 const run:Run={id:'observed',agentId:'bot',conversationId:'chat',messageId:'m',status:'complete',route:{provider:'openai',model:'m',strategy:'manual',reason:''},accountKey:accountUsageKey(state)!,startedAt:'2026-10-26T12:00:00Z',endedAt:'2026-10-26T12:00:01Z',usage:null,error:null};
 const agent=(value:string,extra={})=>controls.call(scope,'relay_app_control',{action:'routing.feedback',id:run.id,input:{value,...extra}},()=>{});
 // Exercise the real trusted HTTP handler; session/CSRF validation occurs upstream.
 const endpoint=async(value:string,extra={})=>{const req=Readable.from([JSON.stringify({value,...extra})]) as IncomingMessage;req.method='POST';let result:any;const res={writeHead:()=>{},end:(body:string)=>{result=JSON.parse(body);}} as unknown as ServerResponse;assert.equal(await workspaceApi(req,res,new URL('http://fixture/api/routing/observed/feedback'),{routing:insights} as Parameters<typeof workspaceApi>[3]),true);return result;};
 try{
  insights.recordRun(run,'coding');await agent('helpful');let model=insights.snapshot().models[0];assert.equal(model.helpful,0);assert.equal(model.unhelpful,0);assert.equal((model as any).agentHelpful,1);
  await assert.rejects(agent('helpful',{source:'direct-operator'}),/Unknown|read-only/);await assert.rejects(endpoint('helpful',{source:'direct-operator'}),/Unknown|read-only/);
  const direct=await endpoint('unhelpful');assert.equal(direct.feedbackSource,'direct-operator');await agent('helpful');await agent('helpful');model=insights.snapshot().models[0];assert.equal(model.unhelpful,1);assert.equal(model.helpful,0);assert.equal((model as any).agentHelpful,1);assert.equal(insights.snapshot().recent[0].feedback,'unhelpful');
  await endpoint('helpful');await endpoint('helpful');model=insights.snapshot().models[0];assert.equal(model.helpful,1);assert.equal(model.unhelpful,0);
  const legacy=store.get<RoutingObservation>('routing-observation',run.id)!;store.put('routing-observation',{...legacy,id:'legacy',feedback:'helpful',feedbackSource:undefined,operatorFeedback:undefined,agentFeedback:undefined});
  model=insights.snapshot().models[0];assert.equal(model.samples,2);assert.equal(model.helpful,1);assert.equal((model as any).unverifiedFeedbackSamples,1);
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
