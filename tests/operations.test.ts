import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:net';
const run=promisify(execFile),root=resolve('.');
const ps=process.env.RELAY_TEST_PWSH||(process.platform==='win32'?join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'):'pwsh');
async function script(file:string,args:string[]=[]){return run(ps,['-NoProfile','-File',join(root,'scripts',file),...args],{windowsHide:true,timeout:30000,maxBuffer:1024*1024});}

test('operations scripts parse, setup defaults to a no-write per-user preview and doctor never authenticates',{skip:process.platform!=='win32'},async()=>{
 for(const name of ['setup-relay','doctor-relay','backup-relay']){const {stdout}=await run(ps,['-NoProfile','-Command','$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile($env:RELAY_TEST_PS_PATH,[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){throw $errors[0].Message}'],{windowsHide:true,timeout:30000,env:{...process.env,RELAY_TEST_PS_PATH:join(root,'scripts',name+'.ps1')}});assert.equal(stdout,'');}
 const preview=JSON.parse((await script('setup-relay.ps1')).stdout);assert.equal(preview.mode,'preview');assert.equal(preview.destination.toLowerCase(),join(homedir(),'Relay').toLowerCase());assert.equal(preview.autostart,false);
 const doctor=JSON.parse((await script('doctor-relay.ps1',['-Json'])).stdout);assert.equal(doctor.homeDirectory,homedir());assert.ok(doctor.checks.some((check:{name:string})=>check.name==='Shared browser'));assert.match(doctor.notes.join(' '),/does not authenticate/);
 await assert.rejects(script('setup-relay.ps1',['-DestinationRoot',homedir()]),/inside the current user home/);
});
test('backup captures a consistent SQLite snapshot and hashed artifacts; restore preview detects tampering',{skip:process.platform!=='win32'},async()=>{
 const dir=await mkdtemp(join(root,'.data-operations-'));const data=join(dir,'data'),backup=join(dir,'snapshot');await mkdir(join(data,'artifacts'),{recursive:true});let sourceDb:DatabaseSync|undefined;
 try{
  const db=sourceDb=new DatabaseSync(join(data,'relay.sqlite'));db.exec('PRAGMA journal_mode=WAL;CREATE TABLE records(kind TEXT,id TEXT,data TEXT,PRIMARY KEY(kind,id));');db.prepare('INSERT INTO records VALUES(?,?,?)').run('message','message','{"content":"private fixture"}');
  await writeFile(join(data,'artifacts','result.txt'),'verified fixture');
  const created=JSON.parse((await script('backup-relay.ps1',['-DataRoot',data,'-BackupPath',backup])).stdout);assert.equal(created.created,true);assert.equal(created.files,2);
  db.prepare('UPDATE records SET data=?').run('{"content":"later"}');db.close();
  const snapshot=new DatabaseSync(join(backup,'relay.sqlite'),{readOnly:true});assert.match(String(snapshot.prepare('SELECT data FROM records').get()!.data),/private fixture/);snapshot.close();
  const preview=JSON.parse((await script('backup-relay.ps1',['-Action','PreviewRestore','-DataRoot',data,'-BackupPath',backup])).stdout);assert.equal(preview.requiresStoppedServer,true);assert.equal(preview.preservesCurrentDataInRecoveryCopy,true);
  await writeFile(join(backup,'artifacts','result.txt'),'tampered');await assert.rejects(script('backup-relay.ps1',['-Action','PreviewRestore','-DataRoot',data,'-BackupPath',backup]),/missing or changed/);
  const current=new DatabaseSync(join(data,'relay.sqlite'),{readOnly:true});assert.match(String(current.prepare('SELECT data FROM records').get()!.data),/later/);current.close();
 }finally{try{sourceDb?.close();}catch{}await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

test('actual restore preserves the previous database and artifacts in a recovery copy',{skip:process.platform!=='win32'},async()=>{
 const dir=await mkdtemp(join(root,'.data-restore-proof-'));const data=join(dir,'data'),backup=join(dir,'snapshot');await mkdir(join(data,'artifacts'),{recursive:true});let recovery='';
 const socket=createServer();await new Promise<void>(done=>socket.listen(0,'127.0.0.1',done));const port=(socket.address() as {port:number}).port;await new Promise<void>(done=>socket.close(()=>done()));
 try{
  let db=new DatabaseSync(join(data,'relay.sqlite'));db.exec('CREATE TABLE records(kind TEXT,id TEXT,data TEXT,PRIMARY KEY(kind,id));');db.prepare('INSERT INTO records VALUES(?,?,?)').run('message','m','before');db.close();
  await writeFile(join(data,'artifacts','résumé report.txt'),'before artifact');await script('backup-relay.ps1',['-DataRoot',data,'-BackupPath',backup]);
  db=new DatabaseSync(join(data,'relay.sqlite'));db.prepare('UPDATE records SET data=?').run('later');db.close();await writeFile(join(data,'artifacts','résumé report.txt'),'later artifact');
  const restored=JSON.parse((await script('backup-relay.ps1',['-Action','Restore','-DataRoot',data,'-BackupPath',backup,'-ServerPort',String(port)])).stdout);assert.equal(restored.restored,true);recovery=restored.recovery;
  assert.ok(resolve(recovery).startsWith(join(homedir(),'.relay-backups','before-restore-')));
  db=new DatabaseSync(join(data,'relay.sqlite'),{readOnly:true});assert.equal(db.prepare('SELECT data FROM records').get()!.data,'before');db.close();assert.equal(await readFile(join(data,'artifacts','résumé report.txt'),'utf8'),'before artifact');
  db=new DatabaseSync(join(recovery,'relay.sqlite'),{readOnly:true});assert.equal(db.prepare('SELECT data FROM records').get()!.data,'later');db.close();assert.equal(await readFile(join(recovery,'artifacts','résumé report.txt'),'utf8'),'later artifact');
 }finally{await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});if(recovery&&resolve(recovery).startsWith(join(homedir(),'.relay-backups','before-restore-')))await rm(recovery,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});