// CI-only, fixed synthetic JSON. No Add-Type, native guard, DPAPI, product mutation or OS-policy changes.
import{spawn}from'node:child_process';
import{access,lstat,stat,realpath,writeFile}from'node:fs/promises';import{constants}from'node:fs';
import{join,resolve,isAbsolute}from'node:path';import{pathToFileURL}from'node:url';import{createHash}from'node:crypto';
if(process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_OS!=='Windows'||process.env.GITHUB_REPOSITORY!=='GiovanniVarg/Relay')throw Error('This synthetic probe runs only in the official Windows CI workflow.');
if(!process.argv[2]||!process.argv[3]||!isAbsolute(process.argv[2])||!isAbsolute(process.argv[3]))throw Error('Pass absolute reviewed source and diagnostic output directories.');
const source=resolve(process.argv[2]),output=resolve(process.argv[3]),raw=process.env;
const{childEnvironment}=await import(pathToFileURL(join(source,'server/providers/process.ts')).href),filtered=childEnvironment(raw);
const systemRoot=raw.SystemRoot||'C:/Windows',executable=resolve(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),modulePath=resolve(systemRoot,'System32','WindowsPowerShell','v1.0','Modules','Microsoft.PowerShell.Utility','Microsoft.PowerShell.Utility.psd1');
const quoted=value=>"'"+value.replaceAll("'","''")+"'";
const script=String.raw`
[Console]::Error.WriteLine('U|entry')
$ErrorActionPreference='Stop'
$mode=[Console]::In.ReadToEnd()
[Console]::Error.WriteLine('U|stdin')
try {
 if($mode -ceq 'explicit') {
  [Console]::Error.WriteLine('U|before-import')
  Import-Module -Name ${quoted(modulePath)} -ErrorAction Stop
  [Console]::Error.WriteLine('U|after-import')
  [Console]::Error.WriteLine('U|before-convert')
  $value=Microsoft.PowerShell.Utility\ConvertFrom-Json -InputObject '{"probe":"utility","count":1}' -ErrorAction Stop
 } elseif($mode -ceq 'baseline') {
  [Console]::Error.WriteLine('U|before-convert')
  $value=ConvertFrom-Json -InputObject '{"probe":"utility","count":1}' -ErrorAction Stop
 } else {throw 'Invalid synthetic mode'}
 if($value.probe -cne 'utility' -or $value.count -ne 1){throw 'Unexpected synthetic result'}
 [Console]::Error.WriteLine('U|after-convert')
 [Console]::Out.Write('UTILITY_OK')
 exit 0
} catch {
 [Console]::Error.WriteLine(('U|failure|'+$_.Exception.GetType().Name))
 exit 1
}`;
const args=['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')];
function entry(env,name){const found=Object.entries(env).filter(([key])=>key.toUpperCase()===name.toUpperCase());return{keys:found.map(([key])=>key),value:found[0]?.[1]};}
async function shape(value){
 if(typeof value!=='string'||!value)return{present:false};
 const result={present:true,length:value.length,absolute:isAbsolute(value),exists:false,kind:null,readAccess:false,writeAccess:false};
 try{const info=await lstat(value),target=await stat(value);result.exists=true;result.link=info.isSymbolicLink();result.kind=target.isDirectory()?'directory':target.isFile()?'file':'other';}catch(error){result.errorCode=error.code??'unknown';return result;}
 try{await access(value,constants.R_OK);result.readAccess=true;}catch{}try{await access(value,constants.W_OK);result.writeAccess=true;}catch{}return result;
}
async function compareShape(name,rawValue,filteredValue){let canonicalEqual=null;try{canonicalEqual=(await realpath(rawValue)).toLowerCase()===(await realpath(filteredValue)).toLowerCase();}catch{}return{name,valuesEqual:rawValue===filteredValue,canonicalEqual,raw:await shape(rawValue),filtered:await shape(filteredValue)};}
const directories=[];
for(const name of['TEMP','TMP','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','PSModuleAnalysisCachePath']){const a=entry(raw,name),b=entry(filtered,name);directories.push({...await compareShape(name,a.value,b.value),rawKeyNames:a.keys,filteredKeyNames:b.keys,rawCaseDuplicate:a.keys.length>1,filteredCaseDuplicate:b.keys.length>1});}
for(const[subpath,label]of[['Microsoft/Windows/PowerShell/ModuleAnalysisCache','windows-profile-cache-candidate'],['Microsoft/PowerShell/ModuleAnalysisCache','powershell-profile-cache-candidate']]){const a=entry(raw,'LOCALAPPDATA').value,b=entry(filtered,'LOCALAPPDATA').value;directories.push(await compareShape(label,a?join(a,subpath):undefined,b?join(b,subpath):undefined));}
const keyContext=['PSModulePath','PSModuleAnalysisCachePath','PSExecutionPolicyPreference','PSModuleAutoLoadingPreference','POWERSHELL_DISTRIBUTION_CHANNEL','DOTNET_ROOT','DOTNET_ROOT(x86)','DOTNET_MULTILEVEL_LOOKUP','DOTNET_SYSTEM_GLOBALIZATION_INVARIANT','COMPLUS_ReadyToRun','SYSTEMDRIVE'].map(name=>{const a=entry(raw,name),b=entry(filtered,name);return{name,rawPresent:a.value!==undefined,filteredPresent:b.value!==undefined,valuesEqual:a.value===b.value,rawCaseDuplicate:a.keys.length>1,filteredCaseDuplicate:b.keys.length>1};});
const cases=[];
for(const[name,env,input]of[['raw-control',raw,'baseline'],['filtered-baseline',filtered,'baseline'],['filtered-explicit-utility',filtered,'explicit']]){
 const started=performance.now();let stdout='',stderr='',stdoutBytes=0,stderrBytes=0,timedOut=false,outputExceeded=false,killRequested=false;
 const phases=[];const phaseSeen=new Set();
 const outcome=await new Promise(done=>{
  let settled=false,fallback;const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(fallback);done(value);};
  const child=spawn(executable,args,{cwd:source,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  const stop=()=>{if(killRequested)return;killRequested=true;fallback=setTimeout(()=>finish({code:child.exitCode,signal:child.signalCode,closeObserved:false,cleanupUnknown:true}),3000);try{child.kill();}catch{}};
  const timer=setTimeout(()=>{timedOut=true;stop();},20000);
  child.stdout.on('data',bytes=>{stdoutBytes+=bytes.length;stdout=(stdout+String(bytes)).slice(0,4096);if(stdoutBytes>4096){outputExceeded=true;stop();}});
  child.stderr.on('data',bytes=>{stderrBytes+=bytes.length;stderr=(stderr+String(bytes)).slice(0,16384);for(const match of stderr.matchAll(/U\|(entry|stdin|before-import|after-import|before-convert|after-convert|failure\|[A-Za-z0-9_.]+)/g)){if(!phaseSeen.has(match[1])){phaseSeen.add(match[1]);phases.push({phase:match[1],receivedMs:Math.round(performance.now()-started)});}}if(stderrBytes>16384){outputExceeded=true;stop();}});
  child.once('error',error=>{if(!child.pid)finish({code:null,signal:null,closeObserved:true,cleanupUnknown:false,launchErrorCode:error.code??'unknown'});else stop();});
  child.once('close',(code,signal)=>finish({code,signal,closeObserved:true,cleanupUnknown:false}));
  child.stdin.on('error',()=>stop());child.stdin.end(input);
 });
 const verified=outcome.code===0&&outcome.closeObserved&&!outcome.cleanupUnknown&&!timedOut&&!outputExceeded&&stdout==='UTILITY_OK'&&phaseSeen.has('after-convert');
 const result={name,verified,...outcome,timedOut,outputExceeded,killRequested,durationMs:Math.round(performance.now()-started),stdoutBytes,stderrBytes,stdoutMatchesSynthetic:stdout==='UTILITY_OK',phases};cases.push(result);console.log(JSON.stringify({phase:'utility-case',...result}));if(outcome.cleanupUnknown)break;
}
const rawCase=cases.find(row=>row.name==='raw-control'),baseline=cases.find(row=>row.name==='filtered-baseline'),explicit=cases.find(row=>row.name==='filtered-explicit-utility');
const receipt={scope:'Fixed synthetic Utility first-cmdlet contrast; no Add-Type, guard, DPAPI or production change',nodeVersion:process.versions.node,identicalExecutableArgumentsCwd:true,scriptSha256:createHash('sha256').update(script).digest('hex'),environmentValuesLogged:false,moduleManifestShape:await shape(modulePath),directoryShapes:directories,keyContext,cases,autoloadContrastObserved:!!rawCase?.verified&&!baseline?.verified&&!!explicit?.verified,cleanupUnknown:cases.some(row=>row.cleanupUnknown)};
await writeFile(join(output,'powershell-utility.json'),JSON.stringify(receipt,null,2),{flag:'wx'});console.log(JSON.stringify({phase:'utility-summary',autoloadContrastObserved:receipt.autoloadContrastObserved,cleanupUnknown:receipt.cleanupUnknown,cases:cases.map(({name,verified,durationMs})=>({name,verified,durationMs}))}));
if(cases.length!==3||receipt.cleanupUnknown||cases.some(row=>!row.verified))process.exitCode=1;
