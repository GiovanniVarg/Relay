import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {Terminals,nativePty,terminalEnvironment,terminalCwd,type ShellDefinition} from '../server/terminal.js';
import type {TerminalEvent} from '../shared/terminal.js';
const live=process.env.RELAY_TERMINAL_LIVE==='1'&&process.platform==='win32';
const wait=async(predicate:()=>boolean,label:string,diagnostic:()=>string=()=>'')=>{const end=Date.now()+15000;while(!predicate()){if(Date.now()>end)throw Error('Native terminal timeout: '+label+' '+JSON.stringify(diagnostic().slice(-2048)));await new Promise(done=>setTimeout(done,25));}};
test('isolated Windows cmd and PowerShell real PTY input/cwd/resize/interrupt/owned exit',{skip:!live,timeout:90000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'relay-terminal-native-')),home=join(root,'home'),appData=join(home,'appdata'),localAppData=join(home,'localappdata'),history=join(home,'fixture-history.txt');await mkdir(appData,{recursive:true});await mkdir(localAppData,{recursive:true});
 try{
  const system=process.env.SystemRoot??'C:\\Windows',canonicalHome=await terminalCwd(home);
  const startup="Import-Module PSReadLine -ErrorAction Stop; Set-PSReadLineOption -HistorySavePath '"+history.replaceAll("'","''")+"' -HistorySaveStyle SaveNothing; Write-Output ('RELAY_HISTORY_STYLE_'+(Get-PSReadLineOption).HistorySaveStyle); Write-Output ('RELAY_HISTORY_PATH_'+(Get-PSReadLineOption).HistorySavePath)";
  const shells:ShellDefinition[]=[{id:'cmd',label:'Fixture Command Prompt',file:join(system,'System32','cmd.exe'),args:['/d']},{id:'powershell',label:'Fixture PowerShell',file:join(system,'System32','WindowsPowerShell','v1.0','powershell.exe'),args:['-NoLogo','-NoProfile','-NoExit','-Command',startup]}];
  for(const shell of shells){const owner={},events:TerminalEvent[]=[],manager=new Terminals({ownerAlive:o=>o===owner,assertAvailable:()=>{},resolveCwd:async()=>({cwd:canonicalHome,context:'isolated native fixture'}),shells:async()=>[shell],preparePty:()=>{const factory=nativePty();return {ready:factory.ready,dispose:()=>factory.dispose(),spawn:(file,args,options)=>factory.spawn(file,args,{...options,env:{...terminalEnvironment(),HOME:canonicalHome,USERPROFILE:canonicalHome,APPDATA:appData,LOCALAPPDATA:localAppData,XDG_DATA_HOME:appData,XDG_CONFIG_HOME:appData,XDG_STATE_HOME:localAppData,XDG_CACHE_HOME:localAppData,TEMP:root,TMP:root}})};}});
   try{const session=await manager.start(owner,{shellId:shell.id,cols:200,rows:24});manager.subscribe(owner,session.id,0,event=>events.push(event),()=>{});const status=events[0];assert.equal(status.type,'status');if(status.type!=='status'||!status.leaseId)throw Error('No controller');let sequence=status.nextInputSequence;const input=(data:string)=>manager.input(owner,session.id,{leaseId:status.leaseId!,sequence:sequence++,data}),output=()=>events.filter(e=>e.type==='output').map(e=>e.data).join(''),plain=()=>output().replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\x1b\][^\x07]*?(?:\x07|\x1b\\)/g,'').replace(/[\r\n]/g,'');
    if(shell.id==='powershell')await wait(()=>plain().includes('RELAY_HISTORY_STYLE_SaveNothing')&&plain().includes('RELAY_HISTORY_PATH_'+history),'disposable PSReadLine startup policy',output);
    // Computed marker cannot be satisfied by the console echo of our command.
    await input(shell.id==='cmd'?'set "RELAY_FIXTURE_SUFFIX=OK"\recho RELAY_NATIVE_%RELAY_FIXTURE_SUFFIX%\recho CWD_%CD%\r':"Write-Output ('RELAY_NATIVE_'+'OK'); Write-Output ('CWD_'+(Get-Location).Path)\r");
    await wait(()=>plain().includes('RELAY_NATIVE_OK')&&plain().includes('CWD_'+canonicalHome),shell.id+' computed marker and cwd',output);const size=await manager.resize(owner,session.id,{leaseId:status.leaseId,cols:100,rows:30});assert.equal(size.cols,100);assert.equal(size.rows,30);
    const sleepCursor=plain().length;await input(shell.id==='cmd'?'ping -n 30 127.0.0.1\r':"for ($i=0; $i -lt 150; $i++) { Write-Output ('RELAY_TICK_'+$i); Start-Sleep -Milliseconds 200 }\r");await wait(()=>plain().slice(sleepCursor).includes(shell.id==='cmd'?'Reply from 127.0.0.1':'RELAY_TICK_2'),shell.id+' long command actually running',output);const interruptCursor=plain().length;await input('\x03');await wait(()=>plain().slice(interruptCursor).includes(canonicalHome+'>'),shell.id+' prompt after interrupt',output);await input(shell.id==='cmd'?'echo RELAY_INTERRUPTED_%RELAY_FIXTURE_SUFFIX%\r':"Write-Output ('RELAY_INTERRUPTED_'+'OK')\r");await wait(()=>plain().includes('RELAY_INTERRUPTED_OK'),shell.id+' interrupt regained shell',output);
    await manager.stop(owner,session.id);assert.equal(manager.current(owner)?.state,'exited');assert.equal(manager.activeCount(),0);assert.ok(events.some(e=>e.type==='exit'));
   }finally{await manager.close();}
  }
 }finally{const target=resolve(root);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&target.includes('relay-terminal-native-'));await rm(target,{recursive:true,force:true,maxRetries:5});}
});
