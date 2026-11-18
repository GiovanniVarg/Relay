import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,copyFile,cp} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {tmpdir,homedir} from 'node:os';
import {createServer} from 'node:net';
const run=promisify(execFile),powershell=join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
const marker={version:1,nodeVersion:'22.23.5',nodeSha256:'247e9693d316da9857e44990e5e11709f596f18112251b8026ec6eed80bdf38a'};
async function inspect(root:string){const code="$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);. $env:RELAY_FIXTURE_HELPER;$result=Get-RelayPrivateRuntime -AppRoot $env:RELAY_FIXTURE_APP;if($null -eq $result){'null'}else{$result|ConvertTo-Json -Compress}";return run(powershell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{windowsHide:true,timeout:20000,env:{...process.env,RELAY_FIXTURE_HELPER:resolve('scripts/private-runtime.ps1'),RELAY_FIXTURE_APP:root}});}
test('missing private runtime preserves the legacy launcher choice without reading global Node',{skip:process.platform!=='win32'},async()=>{const root=await mkdtemp(join(tmpdir(),'relay-private-absent-'));try{assert.equal((await inspect(root)).stdout.trim(),'null');}finally{await rm(root,{recursive:true,force:true});}});
test('partial, redirected and tampered private runtime fail closed instead of falling back',{skip:process.platform!=='win32'},async()=>{const root=await mkdtemp(join(tmpdir(),'relay-private-invalid-')),runtime=join(root,'.runtime');try{await mkdir(runtime);await assert.rejects(inspect(root),/install-runtime/);await writeFile(join(runtime,'install-runtime.json'),JSON.stringify({...marker,executable:'C:/other.exe'}));await assert.rejects(inspect(root),/supported verified runtime/);await writeFile(join(runtime,'install-runtime.json'),JSON.stringify(marker));await mkdir(join(runtime,'node'));await writeFile(join(runtime,'node','node.exe'),'not the verified Node binary');await assert.rejects(inspect(root),/Node verification failed/);}finally{await rm(root,{recursive:true,force:true,maxRetries:5});}});
test('private runtime refuses a linked Node directory before using an executable',{skip:process.platform!=='win32'},async()=>{const root=await mkdtemp(join(tmpdir(),'relay-private-link-')),runtime=join(root,'.runtime'),target=join(root,'external');try{await mkdir(runtime);await mkdir(target);await writeFile(join(runtime,'install-runtime.json'),JSON.stringify(marker));await symlink(target,join(runtime,'node'),'junction');await assert.rejects(inspect(root),/linked/);}finally{await rm(root,{recursive:true,force:true,maxRetries:5});}});

test('runtime helper and launcher remain public text sources with no caller-selected executable path',async()=>{const source=await readFile(resolve('scripts/private-runtime.ps1'),'utf8'),launcher=await readFile(resolve('Start-Relay.ps1'),'utf8');assert.ok(source.includes("Join-Path $nodeDirectory 'node.exe'"));assert.ok(!source.includes('$saved.executable'));assert.ok(launcher.includes('$env:PATH=$privateRuntime.Path'));assert.ok(!launcher.includes("SetEnvironmentVariable('PATH'"));});

test('private Node launches independently with no system Node and preserves private PATH, npm and browser cache',{skip:process.platform!=='win32'||!process.env.RELAY_TEST_PRIVATE_NODE,timeout:180000},async()=>{
 const root=await mkdtemp(join(homedir(),'.relay-private-runtime-test-')),app=join(root,'install résumé space'),data=join(root,'data'),browserCache=join(root,'browser-cache'),nodeDirectory=join(app,'.runtime','node');
 await mkdir(join(app,'dist/server'),{recursive:true});await mkdir(join(app,'scripts'),{recursive:true});await mkdir(nodeDirectory,{recursive:true});
 const socket=createServer();await new Promise<void>(done=>socket.listen(0,'127.0.0.1',done));const port=(socket.address() as {port:number}).port;await new Promise<void>(done=>socket.close(()=>done()));
 let launched=false;
 const launch=(stop=false)=>run(powershell,['-NoProfile','-NonInteractive','-File',join(app,'Start-Relay.ps1'),'-LocalInstall','-NoBrowser','-Port',String(port),...(stop?['-Stop']:[])],{windowsHide:true,timeout:90000,env:{...process.env,PATH:join(process.env.SystemRoot??'C:\\Windows','System32'),RELAY_DATA_DIR:data,PLAYWRIGHT_BROWSERS_PATH:browserCache}});
 try{
  const supplied=resolve(process.env.RELAY_TEST_PRIVATE_NODE!);await copyFile(supplied,join(nodeDirectory,'node.exe'));await cp(join(dirname(supplied),'node_modules','npm'),join(nodeDirectory,'node_modules','npm'),{recursive:true});
  await writeFile(join(app,'.runtime','install-runtime.json'),JSON.stringify(marker));
  const providerRoots=['providers/node_modules/@anthropic-ai/claude-code-win32-x64','providers/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin','providers/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/codex-path'];for(const relative of providerRoots)await mkdir(join(app,'.runtime',relative),{recursive:true});
  for(const file of ['Start-Relay.ps1','scripts/private-runtime.ps1','scripts/serve-relay.ps1','scripts/windows-tcp-listeners.ps1'])await copyFile(resolve(file),join(app,file));
  await writeFile(join(app,'package.json'),'{"type":"module"}');
  await writeFile(join(app,'dist/server/index.js'),"import http from'node:http';import{createHash,randomUUID}from'node:crypto';import{resolve}from'node:path';const instanceId=randomUUID();http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({service:'relay',ok:true,pid:process.pid,instanceId,dataDirectoryId:createHash('sha256').update(resolve(process.env.RELAY_DATA_DIR).toLowerCase()).digest('hex'),updateHeld:false,node:process.execPath,path:process.env.PATH,browserCache:process.env.PLAYWRIGHT_BROWSERS_PATH}))}).listen(Number(process.env.PORT),'127.0.0.1');");
  await launch();launched=true;const response=await fetch('http://127.0.0.1:'+port+'/api/health'),health=await response.json() as {node:string;path:string;browserCache:string};assert.equal(health.node.toLowerCase(),join(nodeDirectory,'node.exe').toLowerCase());assert.equal(health.browserCache,browserCache);const prefix=[nodeDirectory,...providerRoots.map(relative=>join(app,'.runtime',relative))];assert.deepEqual(health.path.split(';').slice(0,prefix.length),prefix);
  const npm=await run(join(nodeDirectory,'node.exe'),[join(nodeDirectory,'node_modules/npm/bin/npm-cli.js'),'--version'],{windowsHide:true,timeout:20000,env:{...process.env,PATH:health.path}});assert.equal(npm.stdout.trim(),'10.9.9');
  const reused=await launch();assert.match(reused.stdout,/Relay is running/);
 }finally{if(launched)await launch(true);await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
});
