import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,copyFile,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
const run=promisify(execFile),root=resolve('.');
const ps=join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
const enabled=process.platform==='win32'&&process.env.RELAY_TEST_WINDOWS_LAUNCH==='1';
async function freePort(){const socket=createServer();await new Promise<void>(done=>socket.listen(0,'127.0.0.1',done));const port=(socket.address() as {port:number}).port;await new Promise<void>(done=>socket.close(()=>done()));return port;}
async function health(port:number){return await (await fetch(`http://127.0.0.1:${port}/api/health`)).json() as {service:string,pid:number,data:string,cwd:string,profile:string,fixture:string};}

test('Windows-owned launcher survives caller exit, preserves paths/profile, reuses one instance and records failure',{skip:!enabled,timeout:180000},async()=>{
 const parent=await mkdtemp(join(root,'.data-launcher-'));const fixture=join(parent,'résumé space'),data=join(fixture,'data'),port=await freePort();let ownedPid:number|undefined;
 await mkdir(join(fixture,'dist/server'),{recursive:true});await mkdir(join(fixture,'scripts'));await mkdir(data);
 await copyFile(join(root,'Start-Relay.ps1'),join(fixture,'Start-Relay.ps1'));await copyFile(join(root,'scripts/serve-relay.ps1'),join(fixture,'scripts/serve-relay.ps1'));await copyFile(join(root,'scripts/windows-tcp-listeners.ps1'),join(fixture,'scripts/windows-tcp-listeners.ps1'));
 const fixtureId='launcher-'+Date.now();
 await writeFile(join(fixture,'dist/server/index.js'),`import http from 'node:http';import {createHash,randomUUID} from 'node:crypto';import {resolve} from 'node:path';const instanceId=randomUUID();http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({service:'relay',ok:true,instanceId,dataDirectoryId:createHash('sha256').update(resolve(process.env.RELAY_DATA_DIR).toLowerCase()).digest('hex'),updateHeld:false,fixture:${JSON.stringify(fixtureId)},pid:process.pid,data:process.env.RELAY_DATA_DIR,cwd:process.cwd(),profile:process.env.HOME}))}).listen(Number(process.env.PORT),'127.0.0.1');`);
 const launch=(targetPort=port,stop=false)=>run(ps,['-NoProfile','-File',join(fixture,'Start-Relay.ps1'),'-NoBrowser','-LocalInstall','-Port',String(targetPort),...(stop?['-Stop']:[])],{windowsHide:true,timeout:90000,env:{...process.env,RELAY_DATA_DIR:data,HOME:'profile Unicode résumé'}});
 try{
  await launch();const first=await health(port);ownedPid=first.pid;assert.equal(first.fixture,fixtureId);assert.equal(first.cwd,fixture);assert.equal(first.data,data);assert.equal(first.profile,'profile Unicode résumé');
  // The caller PowerShell process has exited; Node is hosted by WMI instead of the caller job.
  await new Promise(done=>setTimeout(done,500));assert.equal((await health(port)).pid,first.pid);
  await launch();assert.equal((await health(port)).pid,first.pid);assert.match(await readFile(join(data,'launcher.log'),'utf8'),/independent Windows host/);
  const foreignPort=await freePort();const foreign=createServer(socket=>socket.destroy());await new Promise<void>(done=>foreign.listen(foreignPort,'127.0.0.1',done));
  try{await assert.rejects(launch(foreignPort),/Port .* is in use/);assert.equal(foreign.listening,true);}finally{await new Promise<void>(done=>foreign.close(()=>done()));}
  // Startup errors are logged and returned; another service is never terminated.
  process.kill(first.pid);ownedPid=undefined;await new Promise(done=>setTimeout(done,800));
  await writeFile(join(fixture,'dist/server/index.js'),'throw new Error("fixture startup error");');
  await assert.rejects(launch(),/Relay stopped during startup/);assert.match(await readFile(join(data,'server-error.log'),'utf8'),/fixture startup error/);assert.match(await readFile(join(data,'launcher.log'),'utf8'),/exited with code 1/);
 }finally{
  if(ownedPid){try{await launch(port,true);}catch{}try{const current=await health(port);if(current.fixture===fixtureId&&current.pid===ownedPid)process.kill(ownedPid);}catch{}}
  await new Promise(done=>setTimeout(done,500));await rm(parent,{recursive:true,force:true,maxRetries:5,retryDelay:200});
 }
});

test('Windows launcher ownership accepts exact native argv and rejects argument lookalikes',{skip:process.platform!=='win32'},async()=>{
 const source=await readFile(join(root,'Start-Relay.ps1'),'utf8');const fn=source.slice(source.indexOf('function Command-TokenPattern'),source.indexOf('$ownedCommandPattern='));
 const code=fn+String.raw`
$node='C:\node\node.exe';$server='C:\Users\example\Relay\dist\server\index.js'
$pattern='^\s*'+(Command-TokenPattern $node)+'\s+--no-warnings\s+'+(Command-TokenPattern $server)+'\s*$'
foreach($line in @(($node+' --no-warnings '+$server),('"'+$node+'" --no-warnings "'+$server+'"'))){if(-not [regex]::IsMatch($line,$pattern,[Text.RegularExpressions.RegexOptions]::IgnoreCase)){throw 'Rejected exact argv'}}
foreach($line in @(($node+' --no-warnings '+$server+' --extra'),($node+' -e "console.log(1)" '+$server),($node+' --no-warnings '+$server+'.other'),('other '+$node+' --no-warnings '+$server))){if([regex]::IsMatch($line,$pattern,[Text.RegularExpressions.RegexOptions]::IgnoreCase)){throw 'Accepted different argv'}}
$space='C:\résumé space\index.js';$token=Command-TokenPattern $space
if([regex]::IsMatch($space,('^'+$token+'$'))){throw 'Accepted unquoted whitespace'}
if(-not [regex]::IsMatch(('"'+$space+'"'),('^'+$token+'$'))){throw 'Rejected paired quoted Unicode'}
`;
 await run(ps,['-NoProfile','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{windowsHide:true,timeout:20000});
});

test('launcher reuses a native updater-style unquoted server path',{skip:!enabled,timeout:150000},async()=>{
 const dir=await mkdtemp(join(root,'.data-native-launcher-'));const port=await freePort();const fixtureId='native-'+Date.now();let child:ReturnType<typeof import('node:child_process').spawn>|undefined;
 try{
  await mkdir(join(dir,'dist/server'),{recursive:true});await mkdir(join(dir,'scripts'));await copyFile(join(root,'Start-Relay.ps1'),join(dir,'Start-Relay.ps1'));await copyFile(join(root,'scripts/serve-relay.ps1'),join(dir,'scripts/serve-relay.ps1'));await copyFile(join(root,'scripts/windows-tcp-listeners.ps1'),join(dir,'scripts/windows-tcp-listeners.ps1'));
  await writeFile(join(dir,'dist/server/index.js'),`import http from 'node:http';import {createHash,randomUUID} from 'node:crypto';import {resolve} from 'node:path';const instanceId=randomUUID();http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({service:'relay',ok:true,instanceId,dataDirectoryId:createHash('sha256').update(resolve(process.env.RELAY_DATA_DIR).toLowerCase()).digest('hex'),updateHeld:false,fixture:${JSON.stringify(fixtureId)},pid:process.pid}))}).listen(${port},'127.0.0.1');`);
  const {spawn}=await import('node:child_process');child=spawn(process.execPath,['--no-warnings',join(dir,'dist/server/index.js')],{cwd:dir,windowsHide:true,stdio:'ignore',env:{...process.env,RELAY_DATA_DIR:join(dir,'data')}});
  let ready=false;for(let i=0;i<40;i++){try{assert.equal((await health(port)).pid,child.pid);ready=true;break;}catch{await new Promise(done=>setTimeout(done,100));}}assert.equal(ready,true);
  const details=JSON.parse((await run(ps,['-NoProfile','-Command',`Get-CimInstance Win32_Process -Filter 'ProcessId=${child.pid}'|Select-Object CommandLine|ConvertTo-Json -Compress`],{windowsHide:true})).stdout);assert.ok(details.CommandLine.includes(' --no-warnings '+join(dir,'dist/server/index.js')));
  await run(ps,['-NoProfile','-File',join(dir,'Start-Relay.ps1'),'-LocalInstall','-NoBrowser','-Port',String(port)],{windowsHide:true,timeout:90000,env:{...process.env,RELAY_DATA_DIR:join(dir,'data')}});
  const after=await health(port);assert.equal(after.pid,child.pid);assert.equal(after.fixture,fixtureId);
 }finally{try{await run(ps,['-NoProfile','-File',join(dir,'Start-Relay.ps1'),'-LocalInstall','-NoBrowser','-Port',String(port),'-Stop'],{windowsHide:true,timeout:90000,env:{...process.env,RELAY_DATA_DIR:join(dir,'data')}});}catch{}if(child){child.kill();await new Promise(done=>setTimeout(done,300));}await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
});

test('Windows kill-on-close caller job preserves independent host and replacement process',{skip:!enabled,timeout:185000},async()=>{
 const result=await run(ps,['-NoProfile','-File',join(root,'tests/fixtures/windows-job-lifetime.ps1')],{windowsHide:true,timeout:180000,maxBuffer:1024*1024});
 const reportPath=/^REPORT (.+)$/m.exec(result.stdout)?.[1].trim();assert.ok(reportPath,'Job proof must emit its saved report path');
 const report=JSON.parse((await readFile(reportPath,'utf8')).replace(/^\uFEFF/,''));
 assert.equal(report.passed,true);assert.equal(report.fixed.samePidAfter,true);assert.equal(report.fixed.sameUser,true);assert.equal(report.fixed.sameSession,true);assert.equal(report.handoff.originalHostExited,false);assert.equal(report.handoff.sameHost,true);assert.equal(report.handoff.mutexOwned,true);assert.equal(report.handoff.adopted,true);assert.equal(report.intentionalStop.phase,'stopped');assert.equal(report.intentionalStop.mutexReleased,true);assert.equal(report.handoff.differentPid,true);assert.equal(report.cleanup.remaining.length,0);
});
