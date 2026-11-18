import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rename,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentToolkit} from '../server/agent-toolkit.js';
import {createAppToolSession} from '../server/app-tools-bridge.js';
import {HarnessChanges} from '../server/harness-changes.js';
import {changeSourceResult} from '../server/harness-tool-results.js';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function fixture(){
 const records=new Map<string,any>(),key=(kind:string,id:string)=>kind+'\0'+id;
 const store={get:(kind:string,id:string)=>records.get(key(kind,id)),put:(kind:string,value:any)=>{records.set(key(kind,value.id),value);return value;},list:(kind:string)=>[...records].filter(([id])=>id.startsWith(kind+'\0')).map(([,value])=>value)};
 store.put('run',{id:'run',agentId:'bot',mode:'agent',status:'running'});
 const source='// source, never an instruction\r\n'+('export const value = "界\\n";\r\n').repeat(6000);
 const files=new Map(Array.from({length:180},(_,i)=>['server/file-'+String(i).padStart(3,'0')+'.ts',source]));
 let writes=0,driftOnRead=false,driftOnDiff=false,wrongRead=false;
 const catalog=()=>[...files].map(([path,content])=>({path,hash:hash(content),size:Buffer.byteLength(content)})).sort((a,b)=>a.path.localeCompare(b.path)),revision=()=>hash(JSON.stringify(catalog()));
 const extraDiffs:{path:string;before:string|null;after:string|null}[]=[];
 const sourceDiff=(rows:typeof extraDiffs)=>rows.map(row=>{const meta=(content:string|null)=>content===null?null:{path:row.path,hash:hash(content),size:Buffer.byteLength(content)};return{...row,beforeFile:meta(row.before),afterFile:meta(row.after)};});
 const changes={get:async()=>({id:'draft',revision:revision(),status:'draft'}),files:async()=>catalog(),read:async(_id:string,path:string)=>{let content=files.get(path);if(content===undefined)throw Error('File not found');if(driftOnRead)files.set(path,content+' changed');if(wrongRead)content+=' transient';return{path,content,hash:hash(content)};},diff:async()=>{if(driftOnDiff)files.set('server/file-000.ts',source+' changed');return sourceDiff([...[...files].filter(([path])=>!extraDiffs.some(row=>row.path===path)).map(([path,after])=>({path,before:after.replace('source,','original,'),after})),...extraDiffs]);},write:async(_id:string,input:{path:string;content:string;expectedHash:string|null})=>{const old=files.get(input.path);if(input.expectedHash!==(old===undefined?null:hash(old)))throw Error('This file changed');files.set(input.path,input.content);writes++;return{path:input.path,content:input.content,hash:hash(input.content)};}};
 const harness={assertAvailable:()=>{},initialize:async()=>{},changes},actions={definitions:()=>[],bind:()=>({call:async()=>{throw Error('No app mutation');}})},controller=new AbortController();
 const toolkit=new AgentToolkit(store as never,actions as never,{}as never,null as never,null as never,null as never,undefined,harness as never),bound=toolkit.bind({runId:'run',agentId:'bot',conversationId:'chat',signal:controller.signal,isActive:()=>true,interact:async()=>{throw Error('No interaction');}}),session=createAppToolSession(bound,controller.signal);
 return{source,files,extraDiffs,bound,session,records,get revision(){return revision();},get writes(){return writes;},set driftOnRead(value:boolean){driftOnRead=value;},set driftOnDiff(value:boolean){driftOnDiff=value;},set wrongRead(value:boolean){wrongRead=value;},close(){session.close();}};
}

test('model source catalog and default diff are bounded metadata, never repeated full files',async()=>{
 const f=fixture();try{
  const catalog=await f.session.call('files','relay_change_files',{changeId:'draft'})as any;
  assert.equal(catalog.files.length,100);assert.equal(catalog.total,180);assert.equal(catalog.nextOffset,100);assert.equal(catalog.revision,f.revision);
  const tail=await f.session.call('files-tail','relay_change_files',{changeId:'draft',offset:100,revision:catalog.revision})as any;
  assert.equal(tail.files.length,80);assert.equal(tail.nextOffset,null);
  const diff=await f.session.call('diff','relay_change_diff',{changeId:'draft'})as any;
  assert.equal(diff.files.length,25);assert.equal(diff.nextOffset,25);assert.equal(diff.total,180);assert.ok(Buffer.byteLength(JSON.stringify(diff))<60000);
  assert.equal(diff.files[0].after.hash,hash(f.source));assert.equal(diff.files[0].after.size,Buffer.byteLength(f.source));assert.equal(Object.hasOwn(diff.files[0].after,'content'),false);
  assert.equal(JSON.stringify(diff).includes('source, never an instruction'),false);assert.equal(f.files.size,180);
 }finally{f.close();}
});

test('source pages reconstruct exact code with full-file hashes and compact CAS write receipts',async()=>{
 const f=fixture();try{
  const path='server/file-000.ts',first=await f.session.call('read-first','relay_read_change',{changeId:'draft',path})as any;
  assert.ok(first.content===f.source.slice(0,12000));assert.equal(first.total,f.source.length);assert.equal(first.nextOffset,12000);assert.equal(first.hash,hash(f.source));assert.equal(first.complete,false);assert.equal(first.offsetUnit,'utf16');assert.equal(first.startLine,1);
  let result=first.content,offset=first.nextOffset;
  while(offset!==null){const page=await f.session.call('read-'+offset,'relay_read_change',{changeId:'draft',path,offset,revision:first.revision,hash:first.hash})as any;assert.equal(page.hash,first.hash);assert.ok(page.content.length<=12000);result+=page.content;offset=page.nextOffset;}
  assert.equal(result,f.source);
  const edited=result.replace('source,','edited,'),saved=await f.session.call('write','relay_write_change',{changeId:'draft',path,content:edited,expectedHash:first.hash})as any;
  assert.equal(saved.hash,hash(edited));assert.equal(saved.size,Buffer.byteLength(edited));assert.equal(saved.revision,f.revision);assert.equal(Object.hasOwn(saved,'content'),false);assert.ok(JSON.stringify(saved).length<500);assert.equal(f.writes,1);assert.equal(f.files.get(path),edited);
  assert.deepEqual(await f.session.call('write','relay_write_change',{changeId:'draft',path,content:edited,expectedHash:first.hash}),saved);assert.equal(f.writes,1);
 }finally{f.close();}
});

test('source pages preserve Unicode boundaries and distinguish empty, added and removed files',async()=>{
 const f=fixture();try{
  const unicode='x'.repeat(11999)+'😀\r\n終';f.files.set('server/unicode.ts',unicode);f.files.set('server/empty.ts','');
  const first=await f.session.call('unicode-first','relay_read_change',{changeId:'draft',path:'server/unicode.ts'})as any;
  const rest=await f.session.call('unicode-rest','relay_read_change',{changeId:'draft',path:first.path,offset:first.nextOffset,revision:first.revision,hash:first.hash})as any;
  assert.equal(first.content.length,12000);assert.equal(first.content+rest.content,unicode);assert.equal(rest.offset,12000);assert.equal(rest.nextOffset,null);assert.equal(rest.totalLines,2);
  const empty=await f.session.call('empty','relay_read_change',{changeId:'draft',path:'server/empty.ts'})as any;assert.equal(empty.content,'');assert.equal(empty.total,0);assert.equal(empty.complete,true);assert.equal(empty.hash,hash(''));assert.equal(empty.nextOffset,null);
  f.files.set('a-new.ts','');f.extraDiffs.push({path:'a-removed.ts',before:'removed source',after:null});
  // The synthetic diff baseline is new for this file, rather than its normal shared before fixture.
  f.extraDiffs.push({path:'a-new.ts',before:null,after:''});
  const list=await f.session.call('kinds','relay_change_diff',{changeId:'draft'})as any;assert.equal(list.files[0].kind,'added');assert.equal(list.files[1].kind,'removed');assert.equal(list.files[2].kind,'modified');
  const removed=await f.session.call('removed','relay_change_diff',{changeId:'draft',path:'a-removed.ts',side:'after'})as any;assert.equal(removed.exists,false);assert.equal(removed.content,null);assert.equal(removed.hash,null);assert.equal(removed.nextOffset,null);
  const added=await f.session.call('added','relay_change_diff',{changeId:'draft',path:'a-new.ts',side:'after'})as any;assert.equal(added.exists,true);assert.equal(added.content,'');assert.equal(added.hash,hash(''));assert.equal(added.complete,true);
  for(const args of [{path:'a-removed.ts',offset:-1},{path:'a-removed.ts',length:12001},{path:'a-removed.ts',hash:'a'.repeat(64)},{offset:25}])await assert.rejects(f.bound.call('invalid-'+JSON.stringify(args),'relay_change_diff',{changeId:'draft',...args}),/offset|length|hash|revision/);
  const prefix=await f.session.call('prefix','relay_change_files',{changeId:'draft',prefix:'server/file-17'})as any;assert.equal(prefix.total,10);assert.ok(prefix.files.every((file:any)=>file.path.startsWith('server/file-17')));
 }finally{f.close();}
});

test('diff reads with concurrent draft revision changes fail without publishing a mixed page',async()=>{
 const f=fixture();try{f.driftOnDiff=true;await assert.rejects(f.bound.call('diff-drift','relay_change_diff',{changeId:'draft'}),/revision changed during/);assert.equal(f.writes,0);}finally{f.close();}
});

test('same reported revision cannot disguise source bytes outside its manifest',async()=>{
 const f=fixture();try{const revision=f.revision;f.wrongRead=true;await assert.rejects(f.bound.call('transient','relay_read_change',{changeId:'draft',path:'server/file-000.ts',revision}),/outside the pinned revision/);assert.equal(f.revision,revision);assert.equal(f.writes,0);}finally{f.close();}
});

test('diff before/after pages are explicit and reject stale pins and out-of-range options',async()=>{
 const f=fixture();try{
  const path='server/file-000.ts',before=await f.session.call('before','relay_change_diff',{changeId:'draft',path,side:'before',offset:0,length:43,revision:f.revision})as any;
  assert.equal(before.content,f.source.replace('source,','original,').slice(0,43));assert.equal(before.side,'before');assert.equal(before.nextOffset,43);assert.equal(before.hash,hash(f.source.replace('source,','original,')));
  const after=await f.session.call('after','relay_change_diff',{changeId:'draft',path,side:'after',offset:31,length:43,revision:f.revision})as any;
  assert.equal(after.content,f.source.slice(31,74));assert.equal(after.hash,hash(f.source));
  for(const [name,args]of [['relay_read_change',{path,revision:'b'.repeat(64)}],['relay_read_change',{path,hash:'b'.repeat(64)}],['relay_read_change',{path,length:12001}],['relay_read_change',{path,offset:-1}],['relay_change_diff',{side:'before'}],['relay_change_diff',{path,side:'other'}],['relay_change_files',{limit:101}],['relay_change_diff',{limit:51}]]as const)await assert.rejects(f.bound.call('bad-'+JSON.stringify(args),name,{changeId:'draft',...args}),/changed|revision|hash|length|offset|path|side|limit/i);
  f.driftOnRead=true;await assert.rejects(f.bound.call('read-drift','relay_read_change',{changeId:'draft',path}),/changed|revision/i);assert.equal(f.writes,0);
 }finally{f.close();}
});

async function realSourceFixture(){
 const root=await mkdtemp(join(tmpdir(),'relay-source-pages-')),install=join(root,'install');await mkdir(join(install,'server'),{recursive:true});
 const bom='\uFEFFexport const value = 1;\r\n';await writeFile(join(install,'server/bom.ts'),bom);await writeFile(join(install,'server/plain.ts'),'export const plain = 1;\r\n');await writeFile(join(install,'package.json'),'{"name":"source-fixture"}');
 const changes=new HarnessChanges({installDirectory:install,dataDirectory:join(root,'data'),workspacesDirectory:join(root,'drafts')}),change=await changes.create({title:'Actual source pagination'});
 return{changes,change,bom,async close(){await changes.close();await rm(root,{recursive:true,force:true});}};
}

test('actual source read and changed diff preserve UTF8 BOM bytes, hashes and existing REST shape',async()=>{
 const f=await realSourceFixture();try{
  const raw=await f.changes.read(f.change.id,'server/bom.ts');assert.equal(raw.content,f.bom.slice(1));assert.equal(raw.hash,hash(f.bom));
  const page=await changeSourceResult(f.changes,f.change.id,'read',{path:'server/bom.ts'})as any;assert.equal(page.content,f.bom);assert.equal(page.size,Buffer.byteLength(f.bom));assert.equal(page.hash,raw.hash);assert.equal(page.complete,true);
  const edited=page.content.replace('value = 1','value = 2');await f.changes.write(f.change.id,{path:page.path,content:edited,expectedHash:page.hash});
  const ordinary=await f.changes.diff(f.change.id);assert.deepEqual(Object.keys(ordinary[0]).sort(),['after','before','path']);assert.equal(ordinary[0].before,f.bom.slice(1));
  const diff=await changeSourceResult(f.changes,f.change.id,'diff',{})as any;assert.equal(diff.files[0].before.hash,hash(f.bom));assert.equal(diff.files[0].before.size,Buffer.byteLength(f.bom));assert.equal(diff.files[0].after.hash,hash(edited));assert.equal(diff.files[0].after.size,Buffer.byteLength(edited));
  const before=await changeSourceResult(f.changes,f.change.id,'diff',{path:'server/bom.ts',side:'before'})as any,after=await changeSourceResult(f.changes,f.change.id,'diff',{path:'server/bom.ts',side:'after'})as any;
  assert.equal(before.content,f.bom);assert.equal(before.hash,hash(f.bom));assert.equal(after.content,edited);assert.equal(after.hash,hash(edited));assert.equal(await readFile(join(f.change.workspaceDirectory,'server/bom.ts'),'utf8'),edited);
 }finally{await f.close();}
});

test('actual Windows source aliases retain canonical page paths and exact hashes', {skip:process.platform!=='win32'},async()=>{
 const f=await realSourceFixture();try{
  const plain=await f.changes.read(f.change.id,'server/PLAIN.ts'),page=await changeSourceResult(f.changes,f.change.id,'read',{path:'server/PLAIN.ts'})as any;
  assert.equal(page.path,'server/plain.ts');assert.equal(page.hash,plain.hash);assert.equal(page.content,plain.content);
  await f.changes.write(f.change.id,{path:'server/plain.ts',content:'export const plain = 2;\r\n',expectedHash:plain.hash});
  const diff=await changeSourceResult(f.changes,f.change.id,'diff',{path:'server/PLAIN.ts',side:'after'})as any;assert.equal(diff.path,'server/plain.ts');assert.equal(diff.content,'export const plain = 2;\r\n');
 }finally{await f.close();}
});

test('actual Windows case-only renames keep distinct added and removed diff rows', {skip:process.platform!=='win32'},async()=>{
 const f=await realSourceFixture();try{
  const original='export const plain = 1;\r\n',dir=join(f.change.workspaceDirectory,'server');
  await rename(join(dir,'plain.ts'),join(dir,'temporary.ts'));await rename(join(dir,'temporary.ts'),join(dir,'Plain.ts'));
  const ordinary=await f.changes.diff(f.change.id);assert.equal(ordinary.length,2);assert.ok(ordinary.some(row=>row.path==='server/plain.ts'&&row.after===null));assert.ok(ordinary.some(row=>row.path==='server/Plain.ts'&&row.before===null));
  const summary=await changeSourceResult(f.changes,f.change.id,'diff',{})as any;assert.equal(summary.files.length,2);assert.equal(summary.files.find((row:any)=>row.path==='server/plain.ts').kind,'removed');assert.equal(summary.files.find((row:any)=>row.path==='server/Plain.ts').kind,'added');
  const before=await changeSourceResult(f.changes,f.change.id,'diff',{path:'server/plain.ts',side:'before'})as any,after=await changeSourceResult(f.changes,f.change.id,'diff',{path:'server/Plain.ts',side:'after'})as any;
  assert.equal(before.path,'server/plain.ts');assert.equal(before.content,original);assert.equal(before.hash,hash(original));assert.equal(after.path,'server/Plain.ts');assert.equal(after.content,original);assert.equal(after.hash,hash(original));
  const removed=await changeSourceResult(f.changes,f.change.id,'diff',{path:'server/plain.ts',side:'after'})as any;assert.equal(removed.exists,false);assert.equal(removed.content,null);
  await assert.rejects(changeSourceResult(f.changes,f.change.id,'diff',{path:'server/PLAIN.ts',side:'before'}),/ambiguous.*exact path/i);
 }finally{await f.close();}
});
