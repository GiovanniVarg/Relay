import test from 'node:test';
import assert from 'node:assert/strict';
import {buildContextPack, type ContextSource} from '../server/context-pack.js';
import {canonicalConversation} from '../server/context-wire.js';

const source = (id:string,name:string,content:string,provenance?:unknown):ContextSource => ({id,name,content,kind:'file',...(provenance?{provenance}:{})});
const commonPrefix = (a:string,b:string) => {let length=0;while(length<a.length&&a[length]===b[length])length++;return length;};

test('empty ordinary history does not discard older nonempty context',()=>{
 const pack=buildContextPack({instructions:'Mission',current:'Continue',history:[{id:'older',role:'user',content:'Preserve this earlier instruction'},{id:'empty',role:'assistant',content:''}],sources:[]});
 assert.ok(pack.history.some(message=>message.messageId==='older'));
 assert.equal(pack.diagnostics.historyIncluded,1);
 assert.equal(pack.diagnostics.omittedHistory,1);
});

test('image-only history keeps its exact manifest and empty content when it fits',()=>{
 const attachment={id:'image',name:'image.png',mimeType:'image/png' as const,size:100,sha256:'a'.repeat(64),kind:'image' as const,width:1,height:1};
 const input={instructions:'Mission',current:'Continue',history:[{id:'older',role:'user' as const,content:'Earlier context'},{id:'image-only',role:'user' as const,content:'',attachments:[attachment]}],sources:[]};
 const pack=buildContextPack(input),image=pack.history.find(message=>message.messageId==='image-only');
 assert.ok(image);assert.equal(image.content,'');assert.deepEqual(image.attachments,[attachment]);
 assert.ok(pack.history.some(message=>message.messageId==='older'));assert.equal(pack.diagnostics.historyIncluded,2);assert.equal(pack.diagnostics.omittedHistory,0);
 assert.ok(pack.diagnostics.characters<=80000);
 const small=buildContextPack({...input,historyBudget:1});
 assert.equal(small.history.some(message=>message.messageId==='image-only'),false);
});

test('identical reference bodies appear once with every alias and provenance while original counts and fingerprints remain truthful',()=>{
 const sources=[source('b','Second.txt','same body '.repeat(800),{revision:'second'}),source('a','First.txt','same body '.repeat(800),{revision:'first'})];
 const input={instructions:'Mission',current:'Read Second.txt',history:[],sources};
 const pack=buildContextPack(input);
 const refs=pack.history.filter(message=>message.content.startsWith('Untrusted reference'));
 assert.equal(refs.length,1);
 const aliases=[{id:'a',name:'First.txt',kind:'file',provenance:{revision:'first'}},{id:'b',name:'Second.txt',kind:'file',provenance:{revision:'second'}}];
 assert.deepEqual(JSON.parse(refs[0].content.slice(refs[0].content.indexOf('\n')+1)).aliases,aliases);
 assert.deepEqual(pack.diagnostics.sources[0].aliases,aliases);
 assert.equal(pack.diagnostics.sourceTotal,2);assert.equal(pack.diagnostics.omittedSources,0);
 assert.ok(pack.diagnostics.characters<12000);
 assert.notEqual(buildContextPack({...input,sources:sources.slice(1)}).referenceFingerprint,pack.referenceFingerprint);
 const partial=buildContextPack({...input,budget:4000});
 assert.equal(partial.diagnostics.omittedSources,2);assert.equal(partial.diagnostics.sourceTotal,2);
 assert.ok(partial.diagnostics.characters<=4000);
 assert.equal(JSON.stringify(input.sources),JSON.stringify(sources));
});

test('oversized duplicate attribution falls back to the requested identity without dropping its affordable body',()=>{
 const sources=Array.from({length:100},(_,i)=>source(String(i).padStart(36,'0'),String(i).padStart(3,'0')+'a'.repeat(197),'important shared content '.repeat(400),{revision:'revision-'+i}));
 const input={instructions:'I'.repeat(10000),current:'Read '+sources[99].name,history:[{id:'history',role:'assistant' as const,content:'H'.repeat(100000)}],sources};
 const pack=buildContextPack(input),refs=pack.history.filter(message=>message.content.startsWith('Untrusted reference')).map(message=>JSON.parse(message.content.slice(message.content.indexOf('\n')+1)));
 const requested=refs.find(ref=>ref.id===sources[99].id||ref.aliases?.some((alias:{id:string})=>alias.id===sources[99].id));
 assert.ok(requested,'the explicitly requested identity must be attributed');
 assert.equal(requested.content,sources[99].content);
 assert.equal(requested.name,sources[99].name);assert.deepEqual(requested.provenance,sources[99].provenance);
 const represented=pack.diagnostics.sources.filter(item=>item.kind!=='history');
 const fullyIncluded=represented.filter(item=>item.start===0&&item.end===item.total).reduce((count,item)=>count+(item.aliases?.length??1),0);
 assert.equal(pack.diagnostics.sourceTotal,100);assert.equal(pack.diagnostics.omittedSources,100-fullyIncluded);
 assert.ok(pack.diagnostics.omittedSources>0,'unattributed identities must remain omitted');
 assert.ok(pack.diagnostics.characters<=80000);
 assert.notEqual(pack.referenceFingerprint,buildContextPack({...input,sources:sources.map((item,i)=>i===0?{...item,name:'changed unattributed source'}:item)}).referenceFingerprint);
});

test('bounded relevant reference selection emits stable ID order when query term order changes',()=>{
 const sources=[source('a','alpha','alpha '+'a'.repeat(12000)),source('b','beta','beta '+'b'.repeat(12000))];
 const input={instructions:'Fixed mission',current:'alpha beta',history:[],sources};
 const alpha=buildContextPack(input),beta=buildContextPack({...input,current:'beta alpha'});
 const references=(pack:typeof alpha)=>pack.history.filter(message=>message.content.startsWith('Untrusted reference'));
 assert.deepEqual(references(alpha),references(beta));
 assert.equal(JSON.parse(references(beta)[0].content.split('\n').slice(1).join('\n')).id,'a');
 assert.ok(commonPrefix(canonicalConversation(alpha.history),canonicalConversation(beta.history))>14000);
 const tight=buildContextPack({...input,current:'beta',budget:4000});
 assert.equal(tight.diagnostics.sources[0].id,'b','relevance still determines which source gets scarce budget');
 assert.equal(alpha.history.at(-1)?.content,'alpha beta');
 assert.match(alpha.history.at(-2)!.content,/Earlier conversation messages/);
});

test('mandatory original history retains its exact role/text prefix when optional windows and omissions change',()=>{
 const sources=[source('stable','Reference','stable reference '.repeat(300))];
 const input={instructions:'Mission',current:'Continue',sources,mandatoryMessageIds:['original'],history:[{id:'original',role:'user' as const,content:'EXACT original task'},{id:'old',role:'assistant' as const,content:'x'.repeat(100000)}]};
 const a=buildContextPack(input),b=buildContextPack({...input,history:[...input.history,{id:'new',role:'assistant',content:'y'.repeat(100000)}]});
 assert.deepEqual(a.history[0],b.history[0]);assert.equal(a.history[0].messageId,'original');
 assert.ok(commonPrefix(canonicalConversation(a.history),canonicalConversation(b.history))>200);
 assert.ok(a.history.some(message=>message.messageId==='original'&&message.role==='user'&&message.content==='EXACT original task'));
 assert.equal(a.history.at(-1)?.content,'Continue');assert.ok(a.diagnostics.characters<=80000);assert.ok(b.diagnostics.characters<=80000);
});
