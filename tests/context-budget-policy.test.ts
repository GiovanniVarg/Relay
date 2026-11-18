import test from 'node:test';
import assert from 'node:assert/strict';
import {buildContextPack,contextHash,rankSources} from '../server/context-pack.js';
import {canonicalConversation} from '../server/context-wire.js';
import {NativeSessions} from '../server/native-sessions.js';
import {AgentToolkit} from '../server/agent-toolkit.js';

const prefix=(a:string,b:string)=>{let n=0;while(n<a.length&&a[n]===b[n])n++;return n;};
const source=(id:string,name:string,content:string)=>({id,name,content,kind:'file' as const});

test('exact requested names outrank extension-only matches and support short document names',()=>{
 const sources=[...Array.from({length:5},(_,i)=>source('a-'+i,'Other'+i+'.md','unrelated body '+i+' '+ 'noise '.repeat(6000))),source('z-task','Task.md','Exact requested task document')];
 const pack=buildContextPack({instructions:'Mission',current:'Read Task.md',history:[],sources});
 assert.ok(pack.history.some(row=>row.contextReference?.id==='z-task'&&row.content.includes('Exact requested task document')));
 assert.equal(rankSources(sources,'Read Task.md')[0].source.id,'z-task');
 const short=[source('short','X','Exact short document')];
 assert.ok(buildContextPack({instructions:'Mission',current:'Read X',history:[],sources:short}).history.some(row=>row.contextReference?.id==='short'));
 assert.equal(buildContextPack({instructions:'Mission',current:'Explain extra details',history:[],sources:short}).diagnostics.sources.length,0,'an embedded character is not an explicit document name');
 assert.equal(buildContextPack({instructions:'Mission',current:'Say a greeting',history:[],sources:[source('article','A','Private document')]}).diagnostics.sources.length,0,'an article is not a requested short document name');
 assert.equal(rankSources([source('literal','Task[1].md','Literal file')],'Read Task[1].md')[0].score>=1000000,true);
});

test('sparse greeting avoids zero-relevance library replay and bounds unrelated private memory',(t)=>{
 const base={instructions:'Fixed bot mission',current:'Say hello',history:[],sources:[]};
 const empty=buildContextPack(base),loaded=buildContextPack({...base,sources:Array.from({length:8},(_,i)=>source('source-'+i,'Irrelevant file '+i,('unrelated material '+i+' ').repeat(1000)))});
 assert.ok(loaded.diagnostics.characters<empty.diagnostics.characters+1000);
 assert.equal(loaded.diagnostics.sources.length,0);assert.equal(loaded.diagnostics.omittedSources,8);
 const memory=buildContextPack({...base,sources:[{id:'memory:own',name:'Bot memory',kind:'memory',content:'Private persistent preference. '.repeat(5000)}]});
 assert.ok(memory.diagnostics.characters<5000);assert.equal(memory.diagnostics.omittedSources,1);
 assert.ok(memory.history.some(row=>row.content.includes('Private persistent preference')));
 t.diagnostic(JSON.stringify({sourceFreeWireCharacters:empty.diagnostics.characters,loadedLibraryWireCharacters:loaded.diagnostics.characters,previousLoadedLibraryWireCharacters:79534,unrelatedMemoryWireCharacters:memory.diagnostics.characters,measurement:'transport characters; provider tokens/cache reuse unmeasured'}));
});

test('stable long history precedes query-dependent excerpts while rare named evidence remains exact',(t)=>{
 const body='prefix '.repeat(800)+'alpha-needle '+ 'middle '.repeat(800)+'beta-needle '+'tail '.repeat(800);
 const input={instructions:'Mission',current:'alpha-needle in target.txt',history:[{id:'human',role:'user' as const,content:'Exact human authority '+ 'history '.repeat(2000)}],sources:[source('target','target.txt',body)]};
 const alpha=buildContextPack(input),beta=buildContextPack({...input,current:'beta-needle in target.txt'});
 assert.ok(prefix(canonicalConversation(alpha.history),canonicalConversation(beta.history))>10000);
 for(const [pack,needle] of [[alpha,'alpha-needle'],[beta,'beta-needle']] as const){assert.ok(pack.history.some(row=>row.content.includes(needle)&&row.content.startsWith('Untrusted reference')));assert.equal(pack.history.at(-1)!.role,'user');assert.ok(pack.diagnostics.characters<=80000);}
 assert.equal(alpha.referenceFingerprint,beta.referenceFingerprint);
 t.diagnostic(JSON.stringify({commonConversationPrefixCharacters:prefix(canonicalConversation(alpha.history),canonicalConversation(beta.history)),historyCharacters:input.history[0].content.length,measurement:'local byte ordering, not provider cache telemetry'}));
});

function fakeStore(){const records=new Map<string,any>();return {get:(kind:string,id:string)=>records.get(kind+':'+id),put:(kind:string,row:any)=>{records.set(kind+':'+row.id,row);return row;},messages:()=>[],list:(kind:string)=>[...records].filter(([key])=>key.startsWith(kind+':')).map(([,row])=>row)};}

test('native reference reuse requires a committed exact excerpt and survives dirty/fallback boundaries safely',()=>{
 const store=fakeStore(),sessions=new NativeSessions(store as never),pack=buildContextPack({instructions:'Mission',current:'Read target.txt needle',history:[],sources:[source('target','target.txt','needle '+ 'exact evidence '.repeat(100))]});
 const request:any={runId:'first',conversationId:'conversation',model:'model',instructions:'Mission',history:pack.history,maxSeconds:10,expectedAccount:{accountLabel:'fixture',plan:''}};
 request.continuity=sessions.begin(request,'bot',pack.referenceFingerprint,undefined,pack.delta);
 const ref=pack.delta.find(row=>row.content.startsWith('Untrusted reference'))!;assert.ok(ref);
 sessions.commit(request,'session','account','cursor');
 const next:any={...request,runId:'second'};next.continuity=sessions.begin(next,'bot',pack.referenceFingerprint,'cursor',pack.delta);
 assert.equal(next.continuity.sessionId,'session');assert.ok(!next.continuity.delta.some((row:any)=>row.content===ref.content));
 assert.ok(next.history.some((row:any)=>row.content===ref.content),'full fallback history must retain the source');
 assert.equal(next.continuity.localReuse.referenceMessages,1);
 const dirty=sessions.begin({...request,runId:'dirty'},'bot',pack.referenceFingerprint,'cursor',pack.delta);assert.equal(dirty.sessionId,undefined);assert.ok(dirty.delta.some(row=>row.content===ref.content));
 const fresh:any={...request,runId:'third'};fresh.continuity=sessions.begin(fresh,'bot',pack.referenceFingerprint,undefined,pack.delta);sessions.commit(fresh,'session','account','cursor');
 const changed={...ref,content:ref.content.replace('exact evidence','changed evidence')};const changedDelta=pack.delta.map(row=>row===ref?changed:row);
 const changedRequest:any={...request,runId:'changed',history:pack.history.map(row=>row===ref?changed:row)};changedRequest.continuity=sessions.begin(changedRequest,'bot',pack.referenceFingerprint,'cursor',changedDelta);
 assert.ok(changedRequest.continuity.delta.some((row:any)=>row.content===changed.content));
});

test('reference-looking human text and changed excerpt bounds are never elided by native reuse',()=>{
 const store=fakeStore(),sessions=new NativeSessions(store as never),sources=[source('target','target.txt','prefix '.repeat(800)+'alpha-needle '+'middle '.repeat(800)+'beta-needle '+'tail '.repeat(800))];
 const a=buildContextPack({instructions:'Mission',current:'alpha-needle in target.txt',history:[],sources}),b=buildContextPack({instructions:'Mission',current:'beta-needle in target.txt',history:[],sources});
 const request:any={runId:'one',conversationId:'same',model:'m',instructions:'Mission',history:a.history,maxSeconds:10,expectedAccount:{accountLabel:'own',plan:''}};
 request.continuity=sessions.begin(request,'bot',a.referenceFingerprint,undefined,a.delta);sessions.commit(request,'session','own','cursor');
 const firstRef=a.delta.find(row=>row.contextReference)!;
 const human={...firstRef,messageId:'real-human'};
 const delta=[human,...b.delta];const changed:any={...request,runId:'two',history:[human,...b.history]};changed.continuity=sessions.begin(changed,'bot',b.referenceFingerprint,'cursor',delta);
 assert.ok(changed.continuity.delta.some((row:any)=>row.messageId==='real-human'));
 assert.ok(changed.continuity.delta.some((row:any)=>row.contextReference?.start===b.delta.find(row=>row.contextReference)!.contextReference!.start&&!row.messageId));
 assert.equal(changed.continuity.localReuse.referenceMessages,0);
 const foreign=sessions.begin({...request,runId:'foreign'},'different-bot',a.referenceFingerprint,'cursor',a.delta);assert.equal(foreign.sessionId,undefined);assert.ok(foreign.delta.some(row=>row.contextReference));
});

test('task tool list and detail cross the real toolkit with bounded exact pages and revision/visibility pins',async()=>{
 const store=fakeStore();store.put('run',{id:'run',agentId:'bot',status:'running',mode:'agent'});
 const rows=Array.from({length:25},(_,i)=>({id:'task-'+i,agentId:'bot',creatorAgentId:'boss',title:'Task '+i,prompt:'Original instruction '.repeat(800),result:'Exact result 私密 '.repeat(50000),checkpoint:'checkpoint '.repeat(3000),status:'done',updatedAt:'2026-11-06',runIds:['worker-run'],childTaskIds:[],recoveryRequired:false,waitingForChildren:false}));
 const tasks={list:()=>rows,get:(id:string)=>rows.find(row=>row.id===id)};
 const actions={definitions:()=>[],bind:()=>({call:async()=>{throw Error('No mutation expected');}})};
 const toolkit=new AgentToolkit(store as never,actions as never,tasks as never,null as never,null as never,null as never);
 const bound=toolkit.bind({runId:'run',agentId:'bot',conversationId:'chat',signal:new AbortController().signal,isActive:()=>true,interact:async()=>{throw Error('No interaction expected');}});
 const listed:any=await bound.call('list','relay_list_tasks',{});assert.ok(JSON.stringify(listed).length<12000);assert.equal(listed.tasks.length,10);assert.equal(listed.nextOffset,10);assert.ok(!Object.hasOwn(listed.tasks[0],'result'));
 const listNext:any=await bound.call('list-next','relay_list_tasks',{offset:10,revision:listed.revision});assert.equal(listNext.tasks[0].id,'task-10');await assert.rejects(bound.call('list-no-pin','relay_list_tasks',{offset:10}),/revision|pin/i);
 const first:any=await bound.call('first','relay_task_result',{taskId:'task-0'});assert.equal(first.content,rows[0].result.slice(0,12000));assert.equal(first.total,rows[0].result.length);assert.equal(first.nextOffset,12000);assert.equal(first.complete,false);assert.equal(first.hash,contextHash(rows[0].result));assert.ok(JSON.stringify(first).length<16000);
 const next:any=await bound.call('next','relay_task_result',{taskId:'task-0',offset:12000,length:23,revision:first.revision,hash:first.hash});assert.equal(next.content,rows[0].result.slice(12000,12023));
 for(const field of ['prompt','checkpoint'] as const){let offset=0,exact='',revision:string|undefined,hash:string|undefined;do{const page:any=await bound.call(field+'-'+offset,'relay_task_result',{taskId:'task-0',field,offset,...(revision?{revision,hash}:{})});exact+=page.content;revision=page.revision;hash=page.hash;offset=page.nextOffset;}while(offset!==null);assert.equal(exact,rows[0][field]);}
 await assert.rejects(bound.call('unpinned','relay_task_result',{taskId:'task-0',offset:12000}),/revision|hash|pin/i);
 rows[0].checkpoint+=' changed';await assert.rejects(bound.call('changed','relay_task_result',{taskId:'task-0',offset:12000,revision:first.revision,hash:first.hash}),/revision|changed/i);
 rows[0].agentId='other';rows[0].creatorAgentId='other';await assert.rejects(bound.call('foreign','relay_task_result',{taskId:'task-0'}),/not found/i);
 assert.equal(rows[0].result.length,'Exact result 私密 '.repeat(50000).length);
});

test('bounded task metadata retains exact scheduled time, repeat cadence and current phase',async()=>{
 const store=fakeStore();store.put('run',{id:'run',agentId:'bot',status:'running',mode:'agent'});
 const scheduled={id:'scheduled',agentId:'bot',title:'Follow up',prompt:'Follow up tomorrow',result:'',checkpoint:'',status:'scheduled',updatedAt:'2026-11-06',dueAt:'2026-11-07T16:30:00.000Z',repeatMinutes:1440,phase:'waiting',runIds:[],childTaskIds:[],recoveryRequired:false,waitingForChildren:false};
 const actions={definitions:()=>[],bind:()=>({call:async()=>{throw Error('No mutation expected');}})};
 const toolkit=new AgentToolkit(store as never,actions as never,{list:()=>[scheduled],get:()=>scheduled} as never,null as never,null as never,null as never);
 const bound=toolkit.bind({runId:'run',agentId:'bot',conversationId:'chat',signal:new AbortController().signal,isActive:()=>true,interact:async()=>{throw Error('No interaction expected');}});
 const list:any=await bound.call('schedule-list','relay_list_tasks',{}),detail:any=await bound.call('schedule-detail','relay_task_result',{taskId:scheduled.id});
 for(const row of [list.tasks[0],detail.task]){assert.equal(row.dueAt,scheduled.dueAt);assert.equal(row.repeatMinutes,1440);assert.equal(row.phase,'waiting');}
 assert.ok(JSON.stringify(list).length<3000);assert.ok(!Object.hasOwn(list.tasks[0],'prompt'));
});
