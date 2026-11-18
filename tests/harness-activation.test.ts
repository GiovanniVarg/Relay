import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

const helper=await import(pathToFileURL(resolve('scripts/activate-relay.mjs')).href);
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function stopped(pid:number){for(let i=0;i<50;i++){try{process.kill(pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return;}await sleep(50);}throw Error('Fixture process did not stop');}
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'relay-activation-')),installDirectory=join(root,'install'),snapshotDirectory=join(root,'snapshot'),dataDirectory=join(root,'data'),id=randomUUID(),controls=join(dataDirectory,'self-update','jobs',id),backupDirectory=join(dataDirectory,'self-update','backups',id);
 await Promise.all([mkdir(join(installDirectory,'dist','server'),{recursive:true}),mkdir(join(snapshotDirectory,'dist','server'),{recursive:true}),mkdir(controls,{recursive:true})]);
 const db=new DatabaseSync(join(dataDirectory,'relay.sqlite'));db.exec('CREATE TABLE records(kind TEXT,id TEXT,data TEXT,PRIMARY KEY(kind,id))');db.prepare('INSERT INTO records VALUES(?,?,?)').run('conversation','keep','{"content":"private conversation"}');db.close();
 const server=(version:string,extra='')=>`import {createServer} from 'node:http';import{existsSync}from'node:fs';import{DatabaseSync}from'node:sqlite';import{join,resolve}from'node:path';import{createHash,randomUUID}from'node:crypto';const instanceId=randomUUID();${extra}\ncreateServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,service:'relay',pid:process.pid,instanceId,dataDirectoryId:createHash('sha256').update(process.platform==='win32'?resolve(process.env.RELAY_DATA_DIR).toLowerCase():resolve(process.env.RELAY_DATA_DIR)).digest('hex'),version:${JSON.stringify(version)},updateNonce:process.env.RELAY_UPDATE_NONCE,updateHeld:!!process.env.RELAY_UPDATE_HOLD&&existsSync(process.env.RELAY_UPDATE_HOLD)}))}).listen(Number(process.env.PORT),'127.0.0.1');`;
 for(const [folder,version] of [[installDirectory,'old'],[snapshotDirectory,'new']]){await mkdir(join(folder,'scripts'),{recursive:true});await copyFile(resolve('scripts/windows-tcp-listeners.ps1'),join(folder,'scripts/windows-tcp-listeners.ps1'));await writeFile(join(folder,'package.json'),JSON.stringify({type:'module',version}));await writeFile(join(folder,'dist','server','index.js'),server(version));}
 const listener=createServer();await new Promise<void>(resolve=>listener.listen(0,'127.0.0.1',resolve));const address=listener.address();if(!address||typeof address==='string')throw Error('No port');const port=address.port;await new Promise<void>(resolve=>listener.close(()=>resolve()));
 const old=spawn(process.execPath,['-e',''],{windowsHide:true,stdio:'ignore'});const oldPid=old.pid!;await new Promise(resolve=>old.once('exit',resolve));
 const job={version:1,id,changeId:randomUUID(),installDirectory,snapshotDirectory,dataDirectory,backupDirectory,statusPath:join(controls,'status.json'),holdPath:join(controls,'startup.hold'),port,oldPid,nonce:randomUUID().replaceAll('-',''),sourceFiles:await helper.scanTree(snapshotDirectory,[...helper.SOURCE_ROOTS,...helper.SOURCE_FILES]),baseFiles:await helper.scanTree(installDirectory,[...helper.SOURCE_ROOTS,...helper.SOURCE_FILES]),distFiles:await helper.scanTree(snapshotDirectory,['dist']),dependencyFiles:[]};
 async function refresh(){job.sourceFiles=await helper.scanTree(snapshotDirectory,[...helper.SOURCE_ROOTS,...helper.SOURCE_FILES]);job.distFiles=await helper.scanTree(snapshotDirectory,['dist']);}
 async function cleanup(){try{const status=JSON.parse(await readFile(job.statusPath,'utf8'));if(status.newPid){try{process.kill(status.newPid,'SIGTERM');await stopped(status.newPid);}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}}}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
 return {root,job,server,refresh,cleanup};
}
function data(path:string){const db=new DatabaseSync(path,{readOnly:true});try{return db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get('conversation','keep')?.data;}finally{db.close();}}

test('self activation backs up exact old source and database, then starts the reviewed build',async()=>{
 const f=await fixture();try{const result=await helper.activate(f.job,{waitMs:10000,pollMs:50});assert.equal(result.status,'complete');assert.equal(JSON.parse(await readFile(join(f.job.installDirectory,'package.json'),'utf8')).version,'new');assert.equal(JSON.parse(await readFile(join(f.job.backupDirectory,'app','package.json'),'utf8')).version,'old');assert.equal(data(join(f.job.dataDirectory,'relay.sqlite')),'{"content":"private conversation"}');assert.equal(data(join(f.job.backupDirectory,'relay.sqlite')),'{"content":"private conversation"}');const status=JSON.parse(await readFile(f.job.statusPath,'utf8'));assert.equal(status.dataPreserved,true);const health=await(await fetch(`http://127.0.0.1:${f.job.port}/api/health`)).json() as {version:string;updateHeld:boolean};assert.equal(health.version,'new');assert.equal(health.updateHeld,false);}finally{await f.cleanup();}
});
test('startup failure restores old app and saved data without touching account profiles',async()=>{
 const f=await fixture();try{await mkdir(join(f.job.dataDirectory,'profiles'),{recursive:true});await writeFile(join(f.job.dataDirectory,'profiles','untouched'),'private sign-in fixture');await writeFile(join(f.job.snapshotDirectory,'dist','server','index.js'),'process.exit(17)');await f.refresh();const result=await helper.activate(f.job,{waitMs:5000,pollMs:50});assert.equal(result.status,'rolled_back');assert.equal(JSON.parse(await readFile(join(f.job.installDirectory,'package.json'),'utf8')).version,'old');assert.equal(data(join(f.job.dataDirectory,'relay.sqlite')),'{"content":"private conversation"}');assert.equal(await readFile(join(f.job.dataDirectory,'profiles','untouched'),'utf8'),'private sign-in fixture');assert.equal(await readFile(join(f.job.backupDirectory,'failed-candidate','app','dist','server','index.js'),'utf8'),'process.exit(17)');}finally{await f.cleanup();}
});
test('a healthy candidate that rewrites saved history fails verification and preserves its failed database',async()=>{
 const f=await fixture();try{await writeFile(join(f.job.snapshotDirectory,'dist','server','index.js'),f.server('new',`const db=new DatabaseSync(join(process.env.RELAY_DATA_DIR,'relay.sqlite'));db.prepare('UPDATE records SET data=? WHERE id=?').run('changed','keep');db.close();`));await f.refresh();const result=await helper.activate(f.job,{waitMs:5000,pollMs:50});assert.equal(result.status,'rolled_back');assert.match(result.error,/saved Relay data/);assert.equal(data(join(f.job.dataDirectory,'relay.sqlite')),'{"content":"private conversation"}');assert.equal(data(join(f.job.backupDirectory,'failed-candidate','relay.sqlite')),'changed');}finally{await f.cleanup();}
});
test('stale live source is rejected and the unchanged server is restarted',async()=>{
 const f=await fixture();try{await writeFile(join(f.job.installDirectory,'package.json'),'{"type":"module","version":"changed outside Relay"}');await assert.rejects(helper.activate(f.job,{waitMs:5000,pollMs:50}),/reviewed manifest/);assert.equal(JSON.parse(await readFile(join(f.job.installDirectory,'package.json'),'utf8')).version,'changed outside Relay');const status=JSON.parse(await readFile(f.job.statusPath,'utf8'));assert.equal(status.liveFilesChanged,false);assert.equal(status.restartedPrevious,true);}finally{await f.cleanup();}
});
test('activation refuses traversal, duplicated entries, overlapping private roots and linked candidates',async()=>{
 const f=await fixture();try{
  await assert.rejects(helper.validateJob({...f.job,sourceFiles:[...f.job.sourceFiles,{path:'server/../../relay.sqlite',hash:'0'.repeat(64),size:1}]}),/Unsafe/);
  await assert.rejects(helper.validateJob({...f.job,sourceFiles:[...f.job.sourceFiles,...f.job.sourceFiles]}),/Duplicate/);
  await assert.rejects(helper.validateJob({...f.job,snapshotDirectory:join(f.job.dataDirectory,'draft')}),/overlap/);
  const external=join(f.root,'external');await mkdir(external);await symlink(external,join(f.job.snapshotDirectory,'server'),process.platform==='win32'?'junction':'dir');await assert.rejects(helper.activate(f.job,{waitMs:1000,pollMs:20}),/symlinks|reparse/);assert.equal(JSON.parse(await readFile(join(f.job.installDirectory,'package.json'),'utf8')).version,'old');
 }finally{await f.cleanup();}
});
test('preflight acknowledges the candidate before waiting for shutdown, without changing a running installation',async()=>{
 const f=await fixture(),old=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});f.job.oldPid=old.pid!;
 try{
  const pending=helper.activate(f.job,{waitMs:10000,pollMs:30});let waiting=false;
  for(let i=0;i<100;i++){try{const status=JSON.parse(await readFile(f.job.statusPath,'utf8'));if(status.status==='waiting_for_shutdown'){waiting=true;break;}}catch{}await sleep(30);}
  assert.equal(waiting,true);assert.equal(JSON.parse(await readFile(join(f.job.installDirectory,'package.json'),'utf8')).version,'old');assert.equal(old.exitCode,null);
  old.kill('SIGTERM');await stopped(f.job.oldPid);const result=await pending;assert.equal(result.status,'complete');
 }finally{if(old.exitCode===null)old.kill('SIGTERM');await f.cleanup();}
});
test('an invalid candidate never asks the existing server to stop',async()=>{
 const f=await fixture(),old=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});f.job.oldPid=old.pid!;
 try{await writeFile(join(f.job.snapshotDirectory,'package.json'),'{"changed":"after review"}');await assert.rejects(helper.activate(f.job,{waitMs:1000,pollMs:20}),/reviewed manifest/);assert.equal(old.exitCode,null);const status=JSON.parse(await readFile(f.job.statusPath,'utf8'));assert.equal(status.status,'failed');assert.equal(status.liveFilesChanged,false);assert.equal(JSON.parse(await readFile(join(f.job.installDirectory,'package.json'),'utf8')).version,'old');}
 finally{old.kill('SIGTERM');await stopped(f.job.oldPid);await f.cleanup();}
});
test('excluded nested files stay private, unedited and available in both the installation and backup',async()=>{
 const f=await fixture();try{await mkdir(join(f.job.installDirectory,'server','.cache'),{recursive:true});await writeFile(join(f.job.installDirectory,'server','.cache','reference'),'private cached source');await writeFile(join(f.job.installDirectory,'server','private.key'),'local secret fixture');f.job.baseFiles=await helper.scanTree(f.job.installDirectory,[...helper.SOURCE_ROOTS,...helper.SOURCE_FILES]);assert.equal(f.job.baseFiles.some((entry:{path:string})=>entry.path.includes('private.key')),false);const result=await helper.activate(f.job,{waitMs:5000,pollMs:30});assert.equal(result.status,'complete');for(const relative of ['server/.cache/reference','server/private.key'])assert.equal(await readFile(join(f.job.installDirectory,relative),'utf8'),await readFile(join(f.job.backupDirectory,'app',relative),'utf8'));}
 finally{await f.cleanup();}
});
test('the CLI updater exits while its verified replacement server keeps serving independently',async()=>{
 const f=await fixture();let updater:ReturnType<typeof spawn>|undefined;try{
  const controls=resolve(f.job.statusPath,'..'),script=join(controls,'activate-relay.mjs'),jobPath=join(controls,'job.json');await copyFile(resolve('scripts/activate-relay.mjs'),script);await writeFile(jobPath,JSON.stringify(f.job));
  updater=spawn(process.execPath,['--no-warnings',script,'--job',jobPath],{cwd:controls,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';updater.stdout!.on('data',chunk=>output+=String(chunk));updater.stderr!.on('data',chunk=>output+=String(chunk));
  const exit=await new Promise<number|null>((done,reject)=>{const timeout=setTimeout(()=>{updater!.kill();reject(Error('CLI updater did not exit'));},120000);updater!.once('error',error=>{clearTimeout(timeout);reject(error);});updater!.once('exit',code=>{clearTimeout(timeout);done(code);});});assert.equal(exit,0,output);
  const status=JSON.parse(await readFile(f.job.statusPath,'utf8'));assert.equal(status.status,'complete',output);
  // Exported activate() tests keep their Node parent alive. This proof crosses the process-exit boundary.
  for(let tick=0;tick<6;tick++){const response=await fetch(`http://127.0.0.1:${f.job.port}/api/health`,{signal:AbortSignal.timeout(2000)});const health=await response.json() as {version:string;updateNonce:string;updateHeld:boolean};assert.equal(health.version,'new');assert.equal(health.updateNonce,f.job.nonce);assert.equal(health.updateHeld,false);if(tick<5)await sleep(1000);}
 }finally{if(updater&&updater.exitCode===null)updater.kill();await f.cleanup();}
});

test('a candidate adding saved records during the hold fails exact row-set verification',async()=>{const f=await fixture();try{await writeFile(join(f.job.snapshotDirectory,'dist/server/index.js'),f.server('new',`const db=new DatabaseSync(join(process.env.RELAY_DATA_DIR,'relay.sqlite'));db.prepare('INSERT INTO records VALUES(?,?,?)').run('unexpected','new','{"changed":true}');db.close();`));await f.refresh();const result=await helper.activate(f.job,{waitMs:15000,pollMs:50});assert.equal(result.status,'rolled_back');assert.match(result.error,/saved Relay data/);const db=new DatabaseSync(join(f.job.dataDirectory,'relay.sqlite'),{readOnly:true});try{assert.equal(db.prepare('SELECT count(*) AS n FROM records').get()?.n,1);}finally{db.close();}}finally{await f.cleanup();}});
test('Windows helper rejects a matching HTTP response served by a different native listener without killing it',{skip:process.platform!=='win32',timeout:90000},async()=>{const f=await fixture();let fakePid=0;try{const fake=f.server('fake').replace('pid:process.pid','pid:Number(process.env.EXPECTED_PARENT)');await writeFile(join(f.job.snapshotDirectory,'dist/server/fake.js'),fake);await writeFile(join(f.job.snapshotDirectory,'dist/server/index.js'),`import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';import{join,dirname}from'node:path';import{fileURLToPath}from'node:url';const child=spawn(process.execPath,[join(dirname(fileURLToPath(import.meta.url)),'fake.js')],{detached:true,windowsHide:true,stdio:'ignore',env:{...process.env,EXPECTED_PARENT:String(process.pid)}});writeFileSync(join(process.env.RELAY_DATA_DIR,'synthetic-fake.pid'),String(child.pid));child.unref();setInterval(()=>{},1000);`);await f.refresh();await assert.rejects(helper.activate(f.job,{waitMs:5000,pollMs:50}),/native executable\/argv\/listener|startup verification/);fakePid=Number(await readFile(join(f.job.dataDirectory,'synthetic-fake.pid'),'utf8'));const receipt=JSON.parse(await readFile(f.job.statusPath,'utf8'));assert.equal(receipt.recoveryRequired,true);assert.doesNotThrow(()=>process.kill(fakePid,0),'foreign descendant listener was not killed/adopted');const health=await(await fetch(`http://127.0.0.1:${f.job.port}/api/health`)).json() as {version:string};assert.equal(health.version,'fake');}finally{if(!fakePid){try{fakePid=Number(await readFile(join(f.job.dataDirectory,'synthetic-fake.pid'),'utf8'));}catch{}}if(fakePid){process.kill(fakePid);await stopped(fakePid);}await f.cleanup();}});
