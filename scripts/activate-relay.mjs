/** Trusted out-of-process activation. Copy this installed file into the private job before shutting Relay down. */
import {createHash,randomUUID} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:net';
import {constants as fsConstants} from 'node:fs';
import {copyFile,lstat,mkdir,open,readFile,readdir,rename,writeFile,unlink} from 'node:fs/promises';
import {dirname,isAbsolute,join,parse,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

export const SOURCE_ROOTS=['server','client','shared','docs','scripts','tests'];
export const SOURCE_FILES=['README.md','package.json','package-lock.json','Start-Relay.ps1','Start Relay.cmd','Setup Relay.cmd','tsconfig.json','tsconfig.server.json','vite.config.ts','.gitignore'];
const MANAGED=[...SOURCE_ROOTS,...SOURCE_FILES,'dist','node_modules'];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const within=(root,target)=>{const r=relative(root,target);return r!==''&&!r.startsWith('..'+sep)&&r!=='..'&&!isAbsolute(r);};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const exists=async path=>{try{await lstat(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
/** Drain every started operation before reporting failure; no writes outlive rollback. */
async function bounded(items,perform,concurrency=10){
 let cursor=0,failure;const workers=Array.from({length:Math.min(concurrency,items.length)},async()=>{while(!failure){const index=cursor++;if(index>=items.length)return;try{await perform(items[index],index);}catch(error){failure??=error;}}});
 await Promise.allSettled(workers);if(failure)throw failure;
}

export async function noLinks(path){
 let current=resolve(path);
 while(true){try{const info=await lstat(current);if(info.isSymbolicLink())throw Error('Update refuses symlinks and reparse paths: '+current);}catch(error){if(error.code!=='ENOENT')throw error;}const parent=dirname(current);if(parent===current)break;current=parent;}
}
function safeRelative(path){
 if(typeof path!=='string'||!path||path.length>2000||path.includes('\\')||path.includes(':')||path.split('/').some(p=>!p||p==='.'||p==='..'||/[\x00-\x1f<>:"|?*]/.test(p)||/[. ]$/.test(p)||/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(p)))throw Error('Unsafe update file path');
 return path;
}
function sourcePath(path){const parts=path.split('/'),first=parts[0];return (SOURCE_FILES.includes(path)||SOURCE_ROOTS.includes(first)&&parts.slice(1).every(p=>!p.startsWith('.')&&!/^node_modules$|^dist$/i.test(p)))&&!/\.(sqlite|db|pem|key|pfx|p12|crt|cer|log|zip|exe|dll)$/i.test(path);}
function entries(value,label){
 if(!Array.isArray(value)||value.length>100000)throw Error('Invalid '+label+' manifest');const seen=new Set();
 return value.map(entry=>{const path=safeRelative(entry.path);if(!/^[a-f0-9]{64}$/.test(entry.hash)||!Number.isSafeInteger(entry.size)||entry.size<0||entry.size>250000000)throw Error('Invalid update manifest entry');const key=path.toLowerCase();if(seen.has(key))throw Error('Duplicate update manifest entry');seen.add(key);if(label==='source'&&!sourcePath(path)||label==='built'&&!path.startsWith('dist/')||label==='dependencies'&&!path.startsWith('node_modules/'))throw Error('Manifest escaped its component');return {path,hash:entry.hash,size:entry.size};});
}
export async function validateJob(value){
 if(!value||value.version!==1||typeof value.id!=='string'||!/^[-a-zA-Z0-9]{8,100}$/.test(value.id)||typeof value.changeId!=='string'||!/^[-a-zA-Z0-9]{1,100}$/.test(value.changeId))throw Error('Invalid update job');
 const job={...value};
 for(const key of ['installDirectory','dataDirectory','snapshotDirectory','backupDirectory','statusPath','holdPath']){if(typeof job[key]!=='string'||!isAbsolute(job[key]))throw Error('Update paths must be absolute');job[key]=resolve(job[key]);await noLinks(job[key]);}
 for(const [a,b] of [['installDirectory','dataDirectory'],['installDirectory','snapshotDirectory'],['dataDirectory','snapshotDirectory']])if(same(job[a],job[b])||within(job[a],job[b])||within(job[b],job[a]))throw Error('Install, draft and private data paths must not overlap');
 if(!within(job.dataDirectory,job.backupDirectory)||!within(job.dataDirectory,job.statusPath)||!within(job.dataDirectory,job.holdPath)||!same(dirname(job.holdPath),dirname(job.statusPath))||same(job.holdPath,job.statusPath)||within(job.backupDirectory,job.statusPath))throw Error('Update controls must stay in the private data directory');
 const controls=join(job.dataDirectory,'self-update','jobs',job.id);
 if(!same(job.statusPath,join(controls,'status.json'))||!same(job.holdPath,join(controls,'startup.hold'))||!same(job.backupDirectory,join(job.dataDirectory,'self-update','backups',job.id)))throw Error('Update control paths do not match the job identity');
 if(!same(parse(job.installDirectory).root,parse(job.backupDirectory).root))throw Error('Update backup and install must share a filesystem volume');
 if(!Number.isSafeInteger(job.port)||job.port<1||job.port>65535||!Number.isSafeInteger(job.oldPid)||job.oldPid<1||job.oldPid===process.pid||typeof job.nonce!=='string'||!/^[a-f0-9]{32,128}$/.test(job.nonce))throw Error('Invalid activation process identity');
 job.sourceFiles=entries(job.sourceFiles,'source');job.baseFiles=entries(job.baseFiles,'source');job.distFiles=entries(job.distFiles,'built');job.dependencyFiles=entries(job.dependencyFiles,'dependencies');
 if(!job.sourceFiles.some(f=>f.path==='package.json')||!job.distFiles.some(f=>f.path==='dist/server/index.js'))throw Error('Update is incomplete');
 return job;
}
export async function scanTree(root,names){
 const result=[],files=[];let bytes=0,pending=[...names];const sourceOnly=names.every(name=>SOURCE_ROOTS.includes(name)||SOURCE_FILES.includes(name));
 // Discover a level at a time so a lone root directory still fans out across the bounded workers.
 while(pending.length){const next=[];await bounded(pending,async path=>{if(sourceOnly&&!sourcePath(path))return;const absolute=join(root,path);await noLinks(absolute);let info;try{info=await lstat(absolute);}catch(error){if(error.code==='ENOENT')return;throw error;}
  if(info.isDirectory()){for(const entry of(await readdir(absolute)).sort())next.push(path+'/'+entry);}
  else if(info.isFile()){if(info.nlink>1)throw Error('Update refuses hard linked files');bytes+=info.size;if(files.length>=100000||bytes>2000000000)throw Error('Update tree exceeds bounds');files.push({path,absolute,size:info.size});}
  else throw Error('Unsupported update filesystem entry');
 });pending=next;}
 await bounded(files,async file=>{await noLinks(file.absolute);const contents=await readFile(file.absolute);if(contents.length!==file.size)throw Error('Update file changed while scanning');result.push({path:file.path.replaceAll('\\','/'),hash:hash(contents),size:contents.length});});
 return result.sort((a,b)=>a.path.localeCompare(b.path));
}
function identical(expected,actual){const a=new Map(expected.map(x=>[x.path,x]));return expected.length===actual.length&&actual.every(x=>a.get(x.path)?.hash===x.hash&&a.get(x.path)?.size===x.size);}
async function verifyTree(root,files,names){if(!identical(files,await scanTree(root,names)))throw Error('Update files changed or do not match the reviewed manifest: '+root);}
async function atomicJson(path,value){await noLinks(path);await mkdir(dirname(path),{recursive:true});await noLinks(path);const temporary=path+'.tmp-'+process.pid+'-'+randomUUID();try{await writeFile(temporary,JSON.stringify(value,null,2),{flag:'wx'});for(let attempt=0;;attempt++){try{await rename(temporary,path);break;}catch(error){if(process.platform!=='win32'||!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=49)throw error;await sleep(20);}}}finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}}

async function freePort(port){const until=Date.now()+2000;for(;;){try{await new Promise((resolve,reject)=>{const server=createServer();server.once('error',error=>reject(Object.assign(Error('Relay port is still occupied; no process was stopped'),{code:error.code})));server.listen(port,'127.0.0.1',()=>server.close(error=>error?reject(error):resolve()));});return;}catch(error){if(!['EADDRINUSE','EACCES'].includes(error.code)||Date.now()>=until)throw error;await sleep(50);}}}

async function waitOldProcess(pid,waitMs,pollMs){const end=Date.now()+waitMs;while(true){let running=true;try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH')running=false;else throw error;}if(!running)return;if(Date.now()>=end)throw Error('Existing Relay has not exited. No live files changed.');await sleep(pollMs);}}
function records(path){const db=new DatabaseSync(path,{readOnly:true});try{if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('Database integrity check failed');return db.prepare('SELECT kind,id,data FROM records ORDER BY kind,id').all();}finally{db.close();}}
async function databaseSnapshot(source,destination){const db=new DatabaseSync(source,{readOnly:true});try{db.exec('PRAGMA busy_timeout=5000');db.prepare('VACUUM INTO ?').run(destination);}finally{db.close();}return records(destination);}
function verifyRecords(before,after){const current=new Map(after.map(r=>[r.kind+'\0'+r.id,r.data]));if(before.length!==after.length||before.some(r=>current.get(r.kind+'\0'+r.id)!==r.data))throw Error('Candidate changed existing saved Relay data during startup');}
async function copyEntries(source,target,files){await bounded(files,async entry=>{const from=resolve(source,entry.path),to=resolve(target,entry.path);if(!within(source,from)||!within(target,to))throw Error('Copy path escaped root');await noLinks(from);await noLinks(to);await mkdir(dirname(to),{recursive:true});await noLinks(to);await copyFile(from,to,fsConstants.COPYFILE_EXCL);if(hash(await readFile(to))!==entry.hash)throw Error('Copied update file hash changed');});}
async function move(source,target){await noLinks(source);await noLinks(target);if(await exists(target))throw Error('Recovery target already exists: '+target);await mkdir(dirname(target),{recursive:true});await rename(source,target);}
async function stopOwned(child){if(child.exitCode!==null||child.signalCode!==null)return;const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await Promise.race([exited,sleep(5000)]);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await Promise.race([exited,sleep(5000)]);}if(child.exitCode===null&&child.signalCode===null)throw Error('New Relay process could not be stopped; recovery preserved');}
function childEnvironment(job,nonce){
 const env={};for(const key of ['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','USERPROFILE','HOME','APPDATA','LOCALAPPDATA','TEMP','TMP'])if(process.env[key]!==undefined)env[key]=process.env[key];
 return {...env,PORT:String(job.port),RELAY_DATA_DIR:job.dataDirectory,RELAY_UPDATE_HOLD:job.holdPath,RELAY_UPDATE_NONCE:nonce};
}
async function launch(job,nonce,logName){
 const out=await open(join(dirname(job.statusPath),logName+'.log'),'a');const err=await open(join(dirname(job.statusPath),logName+'-error.log'),'a');
 // Windows must also create an independent process group. An unref alone lets the
 // updater exit but does not keep a non-detached replacement alive after that exit.
 try{const child=spawn(process.execPath,['--no-warnings',join(job.installDirectory,'dist/server/index.js')],{cwd:job.installDirectory,env:childEnvironment(job,nonce),windowsHide:true,detached:true,stdio:['ignore',out.fd,err.fd]});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});return child;}finally{await out.close();await err.close();}
}
function dataIdentity(job){const path=resolve(job.dataDirectory);return hash(Buffer.from(process.platform==='win32'?path.toLowerCase():path));}
export async function captureNativeTcpSource(job){
 if(process.platform!=='win32')return '';
 const relative='scripts/windows-tcp-listeners.ps1',entry=job.baseFiles.find(f=>f.path===relative);
 if(!entry||entry.size<1||entry.size>200000)throw Error('Trusted installed native listener helper is absent from the base manifest');
 const file=join(job.installDirectory,relative);await noLinks(file);const info=await lstat(file);
 if(!info.isFile()||info.nlink!==1||info.size!==entry.size)throw Error('Trusted native listener helper identity changed');
 const bytes=await readFile(file);if(bytes.length!==entry.size||hash(bytes)!==entry.hash)throw Error('Trusted native listener helper hash changed');
 const source=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(source.includes('\0'))throw Error('Trusted native listener helper is not text');const prefix=source.split('# RELAY_RECOVERY_FUNCTIONS')[0];if(prefix.length>10000)throw Error('Trusted native listener command exceeds the safe Windows transport bound');return prefix;
}

/** Native ownership checks bracket HTTP, which is readiness evidence, never PID authority. */
async function nativeIdentity(job,child,nativeTcpSource){
 if(child.exitCode!==null||child.signalCode!==null)throw Error('New Relay exited before identity verification');
 if(process.platform!=='win32')return {pid:child.pid,executable:process.execPath,serverPath:join(job.installDirectory,'dist/server/index.js')};
 const ps=join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 const code=`$ErrorActionPreference='Stop';${nativeTcpSource}
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false);$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${child.pid}';$owners=@((Get-RelayTcpListeners -Port ${job.port})|ForEach-Object{if($_.LocalAddress -notin @('127.0.0.1','::1')){throw 'Candidate listener is not exclusive loopback'};$_.OwningProcess});if(-not $p){throw 'Candidate native process is gone'};@{pid=$p.ProcessId;executable=$p.ExecutablePath;command=$p.CommandLine;startedAt=$p.CreationDate.ToUniversalTime().ToString('o');owners=$owners}|ConvertTo-Json -Compress`;
 const result=await execute(ps,['-NoProfile','-NonInteractive','-Command',code],{windowsHide:true,timeout:10000,maxBuffer:65536});const native=JSON.parse(result.stdout);
 const token=value=>value.match(/\s/)?'"'+value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'"':'(?:"'+value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'"|'+value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+')';
 const serverPath=join(job.installDirectory,'dist/server/index.js');const pattern=new RegExp('^\\s*'+token(process.execPath)+'\\s+--no-warnings\\s+'+token(serverPath)+'\\s*$','i');
 if(native.pid!==child.pid||!same(native.executable,process.execPath)||!pattern.test(native.command)||!Array.isArray(native.owners)||!native.owners.length||native.owners.some(pid=>pid!==child.pid)||!Number.isFinite(Date.parse(native.startedAt)))throw Error('Candidate native executable/argv/listener ownership mismatch');
 return {...native,serverPath};
}
async function health(job,child,nonce,waitMs,pollMs,nativeTcpSource){const end=Date.now()+waitMs;let last='No matching health response';while(Date.now()<end){if(child.exitCode!==null||child.signalCode!==null)throw Error('New Relay exited before becoming ready');try{const response=await fetch(`http://127.0.0.1:${job.port}/api/health`,{signal:AbortSignal.timeout(1500)});const body=await response.json();if(response.ok&&body.service==='relay'&&body.ok===true&&body.updateNonce===nonce&&body.updateHeld===true){
   if(body.pid!==child.pid||body.dataDirectoryId!==dataIdentity(job)||typeof body.instanceId!=='string'||!/^[-a-f0-9]{36}$/i.test(body.instanceId))throw Error('Candidate HTTP process/data identity mismatch');
   const before=await nativeIdentity(job,child,nativeTcpSource);const secondResponse=await fetch(`http://127.0.0.1:${job.port}/api/health`,{signal:AbortSignal.timeout(1500)});const second=await secondResponse.json();const after=await nativeIdentity(job,child,nativeTcpSource);
   if(!secondResponse.ok||JSON.stringify(before)!==JSON.stringify(after)||second.pid!==child.pid||second.instanceId!==body.instanceId||second.dataDirectoryId!==dataIdentity(job)||second.updateNonce!==nonce||second.updateHeld!==true||child.exitCode!==null||child.signalCode!==null)throw Error('Candidate identity changed during health verification');
   return {...after,instanceId:body.instanceId,dataDirectoryId:body.dataDirectoryId};
 }last='New Relay did not confirm its startup hold and identity';}catch(error){last=error.message;}await sleep(pollMs);}throw Error('Relay startup verification failed: '+last);}


/** activate never terminates oldPid; the caller must first gracefully drain and close that exact server. */
export async function activate(value,{waitMs=30000,shutdownWaitMs=120000,pollMs=150,beforeRelease}={}){
 const job=await validateJob(value);const nativeTcpSource=await captureNativeTcpSource(job);let child=null,mutated=false,installStarted=false,oldStopped=false,shutdownAuthorized=false;const moved=[];let originalRows=[];
 const status=async(phase,extra={})=>atomicJson(job.statusPath,{version:1,jobId:job.id,changeId:job.changeId,status:phase,updatedAt:new Date().toISOString(),backupDirectory:job.backupDirectory,...extra});
 if(await exists(job.backupDirectory))throw Error('Backup already exists. Inspect previous status before retrying; updates are never replayed automatically.');
 if(await exists(job.statusPath)){const old=JSON.parse(await readFile(job.statusPath,'utf8'));if(!['pending','queued'].includes(old.status))throw Error('Activation job already ran. Inspect its receipt before creating a new job.');}
 try{
  await status('pending');await verifyTree(job.snapshotDirectory,job.sourceFiles,[...SOURCE_ROOTS,...SOURCE_FILES]);await verifyTree(job.snapshotDirectory,job.distFiles,['dist']);await verifyTree(job.snapshotDirectory,job.dependencyFiles,['node_modules']);
  await status('waiting_for_shutdown');shutdownAuthorized=true;
  await waitOldProcess(job.oldPid,shutdownWaitMs,pollMs);await freePort(job.port);oldStopped=true;await verifyTree(job.installDirectory,job.baseFiles,[...SOURCE_ROOTS,...SOURCE_FILES]);
  await mkdir(dirname(job.backupDirectory),{recursive:true});await noLinks(job.backupDirectory);await mkdir(job.backupDirectory,{recursive:false});await writeFile(job.holdPath,job.nonce,{flag:'wx'});await status('backing_up');
  originalRows=await databaseSnapshot(join(job.dataDirectory,'relay.sqlite'),join(job.backupDirectory,'relay.sqlite'));
  await atomicJson(join(job.backupDirectory,'records.json'),originalRows);
  const before=await scanTree(job.installDirectory,MANAGED);await atomicJson(join(job.backupDirectory,'manifest.json'),{version:1,jobId:job.id,files:before,createdAt:new Date().toISOString()});
  // Reject stale or tampered drafts again at the last boundary before live mutations.
  await verifyTree(job.snapshotDirectory,job.sourceFiles,[...SOURCE_ROOTS,...SOURCE_FILES]);await verifyTree(job.snapshotDirectory,job.distFiles,['dist']);await verifyTree(job.snapshotDirectory,job.dependencyFiles,['node_modules']);await freePort(job.port);
  await status('installing');
  for(const name of MANAGED){const source=join(job.installDirectory,name);if(await exists(source)){await move(source,join(job.backupDirectory,'app',name));moved.push(name);mutated=true;await atomicJson(join(job.backupDirectory,'journal.json'),{moved});}}
  installStarted=true;await copyEntries(job.snapshotDirectory,job.installDirectory,[...job.sourceFiles,...job.distFiles,...job.dependencyFiles]);
  // Source drafts deliberately exclude private and generated files nested under source.
  // Retain those existing files in place instead of silently deleting them during an update.
  const preserved=before.filter(entry=>SOURCE_ROOTS.includes(entry.path.split('/')[0])&&!sourcePath(entry.path));
  await copyEntries(join(job.backupDirectory,'app'),job.installDirectory,preserved);
  await status('checking');child=await launch(job,job.nonce,'candidate');const replacement=await health(job,child,job.nonce,waitMs,pollMs,nativeTcpSource);verifyRecords(originalRows,records(join(job.dataDirectory,'relay.sqlite')));
  await writeFile(join(job.dataDirectory,'server.pid'),String(child.pid));
  // Commit the receipt before releasing work. A crash cannot release an unrecorded activation.
  await status('complete',{newPid:child.pid,replacement,sourceFiles:job.sourceFiles.length,dataPreserved:true});
  if(beforeRelease)await beforeRelease({job,child});
  await rename(job.holdPath,job.holdPath+'.released');child.unref();return {status:'complete',newPid:child.pid,backupDirectory:job.backupDirectory};
 }catch(error){
  const failure=String(error.message??error);
  try{
   if(child)await stopOwned(child);
   // The coordinator may already have closed while an early manifest check failed.
   // Restart only after the recorded process is gone and the port is actually free.
   if(shutdownAuthorized&&!oldStopped){try{await waitOldProcess(job.oldPid,shutdownWaitMs,pollMs);await freePort(job.port);oldStopped=true;}catch{}}
   if(mutated){
    await status('restoring',{error:failure});const failed=join(job.backupDirectory,'failed-candidate');await mkdir(failed,{recursive:true});
    for(const name of MANAGED){const source=join(job.installDirectory,name);if((installStarted||moved.includes(name))&&await exists(source))await move(source,join(failed,'app',name));}
    for(const name of moved)await move(join(job.backupDirectory,'app',name),join(job.installDirectory,name));
    // The first candidate may have written a WAL. Preserve all of it, then restore the consistent snapshot.
    for(const name of ['relay.sqlite','relay.sqlite-wal','relay.sqlite-shm']){const source=join(job.dataDirectory,name);if(await exists(source))await move(source,join(failed,name));}
    await copyFile(join(job.backupDirectory,'relay.sqlite'),join(job.dataDirectory,'relay.sqlite'),fsConstants.COPYFILE_EXCL);
    await freePort(job.port);const restoredNonce=job.nonce+'00';child=await launch(job,restoredNonce,'restored');const replacement=await health(job,child,restoredNonce,waitMs,pollMs,nativeTcpSource);verifyRecords(originalRows,records(join(job.dataDirectory,'relay.sqlite')));await writeFile(join(job.dataDirectory,'server.pid'),String(child.pid));
    await status('rolled_back',{error:failure,newPid:child.pid,replacement,dataPreserved:true});if(await exists(job.holdPath))await rename(job.holdPath,job.holdPath+'.released');child.unref();return {status:'rolled_back',newPid:child.pid,backupDirectory:job.backupDirectory,error:failure};
   }
   if(oldStopped){
    await mkdir(dirname(job.holdPath),{recursive:true});if(!await exists(job.holdPath))await writeFile(job.holdPath,job.nonce,{flag:'wx'});await freePort(job.port);
    const restoredNonce=job.nonce+'00';child=await launch(job,restoredNonce,'unchanged');const replacement=await health(job,child,restoredNonce,waitMs,pollMs,nativeTcpSource);await writeFile(join(job.dataDirectory,'server.pid'),String(child.pid));await status('failed',{error:failure,liveFilesChanged:false,newPid:child.pid,replacement,restartedPrevious:true});await rename(job.holdPath,job.holdPath+'.released');child.unref();
   }else await status('failed',{error:failure,liveFilesChanged:false});
  }catch(recoveryError){if(child)await stopOwned(child).catch(()=>{});await status('failed',{error:failure,recoveryError:String(recoveryError.message??recoveryError),recoveryRequired:true});}
  throw Error(failure);
 }
}

if(process.argv[1]&&same(resolve(process.argv[1]),fileURLToPath(import.meta.url))){
 try{if(process.argv.length!==4||process.argv[2]!=='--job')throw Error('Usage: node activate-relay.mjs --job <absolute job.json>');const jobPath=resolve(process.argv[3]);await noLinks(jobPath);const raw=await readFile(jobPath,'utf8');if(raw.length>20000000)throw Error('Update job exceeds bounds');const result=await activate(JSON.parse(raw));process.stdout.write(JSON.stringify(result)+'\n');}catch(error){process.stderr.write(String(error.message??error)+'\n');process.exitCode=1;}
}
