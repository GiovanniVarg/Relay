import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,rm,access,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {OpenCodeAdapter,openCodeProfile,openCodeReportingEnvironment} from '../server/providers/opencode.js';
import {markOutcomeReconciliation} from '../server/outcome-reconciliation.js';
import type {ProviderRequest} from '../shared/types.js';

const binary=process.env.RELAY_OPENCODE_PROBE_BINARY;
/** Official runtime plus synthetic loopback responses only; no external model or account. */
test('official OpenCode reporting retains a denied skill schema without exposing skills or executing tools',{skip:!binary,timeout:180000},async(t)=>{
 const root=await mkdtemp(join(tmpdir(),'relay-opencode-report-native-')),home=join(root,'opencode','home'),config=join(home,'.config','opencode'),project=join(root,'unrelated-project'),probe=join(root,'policy-probe'),marker=join(project,'forbidden.txt');
 await mkdir(config,{recursive:true});await mkdir(project);await mkdir(probe);
 let stage:'normal'|'shell'|'skill'='normal',requests=0,forcedCalls=0;const catalogs:string[][]=[],wire:string[]=[],toolResults:string[]=[],errors:string[]=[];
 const answer=JSON.stringify({state:'complete',summary:'Saved answer delivered',remaining:[],evidence:[]});
 const server=createServer((req,res)=>{void(async()=>{
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
  if(req.method==='GET'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({object:'list',data:[{id:'probe',object:'model'}]}));return;}
  requests++;const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));assert.equal(body.model,'probe');wire.push(JSON.stringify(body));catalogs.push((body.tools??[]).map((tool:any)=>tool.function?.name??tool.name));
  toolResults.push(...(body.messages??[]).filter((message:any)=>message.role==='tool').map((message:any)=>String(message.content)));
  const tool=stage!=='normal'&&forcedCalls++===0;let args:any={command:'echo UNSOLICITED > "'+marker+'"',description:'Forbidden synthetic marker'};
  if(stage==='skill'){const parameters=body.tools?.find((row:any)=>row.function?.name==='skill')?.function.parameters;assert.ok(parameters,'The residual denied skill schema is observed explicitly');args=Object.fromEntries((parameters.required??['name']).map((key:string)=>[key,parameters.properties?.[key]?.type==='array'?['report-private']: 'report-private']));}
  if(body.stream){res.writeHead(200,{'Content-Type':'text/event-stream'});for(const data of [{id:'fixture',object:'chat.completion.chunk',created:1,model:'probe',choices:[{index:0,delta:tool?{role:'assistant',tool_calls:[{index:0,id:'unsolicited',type:'function',function:{name:stage,arguments:JSON.stringify(args)}}]}:{role:'assistant',content:answer},finish_reason:null}]},{id:'fixture',object:'chat.completion.chunk',created:1,model:'probe',choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:5,completion_tokens:5,total_tokens:10}}])res.write('data: '+JSON.stringify(data)+'\n\n');res.end('data: [DONE]\n\n');}
  else{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id:'fixture',object:'chat.completion',created:1,model:'probe',choices:[{index:0,message:tool?{role:'assistant',content:null,tool_calls:[{id:'unsolicited',type:'function',function:{name:stage,arguments:JSON.stringify(args)}}]}:{role:'assistant',content:answer},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:5,completion_tokens:5,total_tokens:10}}));}
 })().catch(error=>{errors.push(String(error));res.destroy();});});
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const port=(server.address() as {port:number}).port;
 await writeFile(join(config,'opencode.json'),JSON.stringify({model:'relayfixture/probe',provider:{relayfixture:{npm:'@opencode/ai/providers/openai-compatible',options:{baseURL:'http://127.0.0.1:'+port+'/v1',apiKey:'synthetic-not-a-secret'},models:{probe:{name:'Fixture',tool_call:true,limit:{context:16000,output:1000}}}}}}));
 const profile=await openCodeProfile(root),connection={accountLabel:'OpenCode managed profile',plan:'',connectionScope:profile.scope};
 // Deliberate fixture profile injection lets native skill discovery see canaries that production profile validation rejects even earlier.
 const canaries=[{base:join(home,'.agents','skills'),id:'report-global',label:'GLOBAL'},{base:join(config,'skills'),id:'report-private',label:'PRIVATE'},{base:join(project,'.agents','skills'),id:'report-project',label:'PROJECT'}];
 for(const canary of canaries){const directory=join(canary.base,canary.id);await mkdir(directory,{recursive:true});await writeFile(join(directory,'SKILL.md'),'---\nname: PRIVATE_NAME_'+canary.label+'\ndescription: PRIVATE_DESCRIPTION_'+canary.label+'\n---\nPRIVATE_BODY_'+canary.label+'\n');}
 const command=async()=>({file:resolve(binary!),args:[]}),adapter=new OpenCodeAdapter(root,{command,profile:async()=>profile}),native=new OpenCodeAdapter(root,{command,profile:async()=>({...profile,env:openCodeReportingEnvironment(profile.env)})});
 const allowedEnvironment=openCodeReportingEnvironment(profile.env),allowPolicy=JSON.parse(allowedEnvironment.OPENCODE_CONFIG_CONTENT!);
 const allowSkill=[{action:'*',resource:'*',effect:'deny'},{action:'skill',resource:'report-private',effect:'allow'}];
 allowedEnvironment.OPENCODE_CONFIG_CONTENT=JSON.stringify({...allowPolicy,permissions:allowSkill,agents:{...allowPolicy.agents,build:{...allowPolicy.agents.build,permissions:allowSkill}},policies:[...allowPolicy.policies,{action:'tool.use',resource:'skill:report-private',effect:'allow'},{action:'skill.use',resource:'report-private',effect:'allow'}]});
 const positive=new OpenCodeAdapter(root,{command,profile:async()=>({...profile,env:allowedEnvironment})});
 const request=():ProviderRequest=>({runId:'report-native',conversationId:'fixture',model:'relayfixture/probe',usagePurpose:'outcome-reconciliation',mode:'chat',instructions:'Return only the saved outcome JSON. Never use tools.',history:[{role:'user',content:'Report the saved completed answer.'}],expectedAccount:{accountLabel:connection.accountLabel,plan:connection.plan},expectedConnectionScope:connection.connectionScope,maxSeconds:45});
 try{
  let interactions=0;
  // Positive control proves this exact synthetic skill is discoverable; only this skill may be loaded.
  stage='skill';forcedCalls=0;
  const control=await positive.stream({...request(),mode:'agent',workspace:probe,interact:async()=>{interactions++;return{decision:'deny'};}},()=>{},new AbortController().signal);
  assert.deepEqual(JSON.parse(control.text),JSON.parse(answer));assert.ok(wire.some(body=>body.includes('PRIVATE_BODY_PRIVATE')),'Positive control must load the exact synthetic skill into the local model');
  assert.equal(wire.some(body=>body.includes('PRIVATE_BODY_GLOBAL')||body.includes('PRIVATE_BODY_PROJECT')),false,'Positive control grants no other synthetic skill');
  requests=0;wire.length=0;catalogs.length=0;toolResults.length=0;stage='normal';
  assert.equal(requests,0);const result=await adapter.stream(markOutcomeReconciliation(request()),()=>{},new AbortController().signal);assert.deepEqual(JSON.parse(result.text),JSON.parse(answer));assert.equal(requests,1);assert.deepEqual(catalogs,[['skill']]);for(const canary of canaries)assert.equal(wire[0].includes(canary.id),false,'Initial skill IDs must be hidden too');
  // Let the runtime deliver its tool error back to the local model. An adapter-side abort cannot establish native denial before effects.
  for(const attack of ['shell','skill'] as const){stage=attack;forcedCalls=0;const before=toolResults.length;const result=await native.stream({...request(),mode:'agent',workspace:probe,interact:async()=>{interactions++;return{decision:'deny'};}},()=>{},new AbortController().signal);assert.deepEqual(JSON.parse(result.text),JSON.parse(answer));assert.ok(forcedCalls>=2,'Native denied tool result must return to the synthetic model');const returned=toolResults.slice(before).join('\n');t.diagnostic(JSON.stringify({attack,nativeToolResult:returned}));const failure=JSON.parse(returned);assert.equal(failure.error?.type,'tool.execution');assert.deepEqual(failure.content,[]);if(attack==='shell')assert.match(failure.error.message,/^No tool named.*shell.*is currently available/);else assert.equal(failure.error.message,'Unable to load skill report-private');assert.equal(await access(marker).then(()=>true,()=>false),false);}
  assert.equal(interactions,0,'Native deny policy prevents human permission interactions');assert.ok(catalogs.every(tools=>tools.length===1&&tools[0]==='skill'),'Only the denied residual skill schema is advertised');
  for(const canary of canaries)for(const secret of ['PRIVATE_NAME_','PRIVATE_DESCRIPTION_','PRIVATE_BODY_'])assert.equal(wire.some(body=>body.includes(secret+canary.label)),false,'Canary skill metadata and content never reach any model request');
  assert.deepEqual(errors,[]);assert.equal((await readdir(join(root,'opencode','operations'))).length,0);
 }finally{await adapter.close();await native.close();await positive.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
