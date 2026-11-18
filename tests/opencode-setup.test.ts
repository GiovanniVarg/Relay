import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,rm,realpath,copyFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,join,resolve,sep} from 'node:path';
import {OpenCodeAdapter,openCodeSetupCommand} from '../server/providers/opencode.js';

const exec=promisify(execFile);
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),"relay-opencode-setup ' & ^ % ! (local)-"));
 const marker=join(root,'synthetic-marker.json');
 const allowed=/^(path|pathext|systemroot|windir|comspec|os|processor_architecture|systemdrive|programfiles|programfiles\(x86\)|programdata|userdomain|username)$/i;
 const env:NodeJS.ProcessEnv={...Object.fromEntries(Object.entries(process.env).filter(([key])=>allowed.test(key)).map(([key,value])=>[key.toUpperCase(),value])),HOME:root,USERPROFILE:root,TEMP:root,TMP:root};
 env.SYSTEMROOT??='C:/Windows';env.WINDIR??='C:/Windows';
 return{root,marker,env,async script(path:string){await writeFile(path,"import{writeFileSync}from'node:fs';writeFileSync("+JSON.stringify(marker)+",JSON.stringify({execPath:process.execPath,script:process.argv[1],args:process.argv.slice(2)}));\n");},async verify(node:string,script:string){const result=JSON.parse(await readFile(marker,'utf8'));assert.equal(await realpath(result.execPath),await realpath(node));assert.equal(await realpath(result.script),await realpath(script));assert.deepEqual(result.args,[]);await rm(marker);},async close(){const absolute=resolve(root);assert.ok(absolute.startsWith(resolve(tmpdir())+sep)&&basename(absolute).startsWith('relay-opencode-setup '));await rm(absolute,{recursive:true,force:true,maxRetries:10,retryDelay:100});}};
}
async function windowsShells(command:string,f:Awaited<ReturnType<typeof fixture>>,node:string,script:string){
 const systemRoot=f.env.SYSTEMROOT!;
 for(const [shell,args]of [[join(systemRoot,'System32','cmd.exe'),['/d','/s','/c',command]],[join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-Command',command]]] as const){
  const operation=exec(shell,[...args],{cwd:tmpdir(),env:f.env,windowsHide:true,timeout:20000,maxBuffer:65536});operation.child.stdin?.end();const result=await operation;
  try{await f.verify(node,script);}catch(error){throw new Error(basename(shell)+' fixture marker verification failed; stdout='+result.stdout+'; stderr='+result.stderr,{cause:error});}
 }
}
test('native setup login command works unchanged from CMD and PowerShell without executing authentication',{skip:process.platform!=='win32',timeout:60000},async()=>{
 const f=await fixture(),adapter=new OpenCodeAdapter(f.root,{command:async()=>({file:'unreachable-synthetic-provider.exe',args:[]})});
 try{const login=await adapter.login();assert.ok(login.command);const script=join(f.root,'opencode','home','relay-native-login.mjs');await f.script(script);await windowsShells(login.command!,f,process.execPath,script);}finally{await adapter.close();await f.close();}
});
test('Windows setup wrapper preserves executable and script paths with spaces, apostrophes and shell metacharacters',{skip:process.platform!=='win32',timeout:60000},async()=>{
 const f=await fixture();try{
  const node=join(f.root,"fake node's & ^ % ! (local).exe"),script=join(f.root,"script's $() `tick` & ; (local).mjs");
  await copyFile(process.execPath,node);await f.script(script);const command=openCodeSetupCommand(node,script,'win32');
  assert.match(command,/^powershell\.exe -NoProfile -EncodedCommand [A-Za-z0-9+/]+=*$/);assert.doesNotMatch(command,/-NonInteractive/i);
  await windowsShells(command,f,node,script);
 }finally{await f.close();}
});
const posixShell=process.platform==='win32'?['C:/Program Files/Git/bin/bash.exe','C:/Program Files/Git/usr/bin/bash.exe'].find(existsSync):'/bin/sh';
test('POSIX setup quoting preserves argument bytes through an actual shell',{skip:!posixShell,timeout:60000},async()=>{
 const f=await fixture();try{
  for(const name of ['plain.mjs','file with spaces.mjs',"it's 'quoted'.mjs",'dollar$() and `ticks` & ;.mjs']){
   const script=join(f.root,name);await f.script(script);const command=openCodeSetupCommand(process.execPath.replaceAll('\\','/'),script.replaceAll('\\','/'),'linux');
   await exec(posixShell!,process.platform==='win32'?['--noprofile','--norc','-c',command]:['-c',command],{cwd:f.root,env:f.env,windowsHide:true,timeout:20000,maxBuffer:65536});await f.verify(process.execPath,script);
  }
 }finally{await f.close();}
});
