// Synthetic, single-process instrumentation only. Never runs ordinary tests or changes target source.
import{mkdtempSync,readFileSync,writeFileSync,appendFileSync,existsSync}from'node:fs';
import{tmpdir}from'node:os';import{join,resolve,isAbsolute}from'node:path';
import{pathToFileURL,fileURLToPath}from'node:url';import{syncBuiltinESMExports}from'node:module';import cp from'node:child_process';
if(!process.argv[2]||!process.argv[3]||!isAbsolute(process.argv[2])||!isAbsolute(process.argv[3]))throw Error('Pass absolute reviewed source and diagnostic output directories.');
const source=resolve(process.argv[2]),output=resolve(process.argv[3]);process.chdir(source);
const scenarios=['raw','provider','provider-pinned'],scenario=process.argv[4];
if(!scenario){
 const log=join(output,'native-guard.jsonl');writeFileSync(log,'',{flag:'wx'});
 const{childEnvironment}=await import(pathToFileURL(join(source,'server/providers/process.ts')).href);
 const filtered=childEnvironment(),modulePath=resolve(process.env.SystemRoot??'C:/Windows','System32','WindowsPowerShell','v1.0','Modules');
 if(!existsSync(modulePath))throw Error('Trusted Windows PowerShell module directory is unavailable.');
 let failed=false;
 for(const name of scenarios){
  const env=name==='raw'?process.env:name==='provider'?filtered:{...filtered,PSModulePath:modulePath};
  let stdout='',stderr='',timedOut=false;
  const result=await new Promise(done=>{const child=cp.spawn(process.execPath,[...process.execArgv,fileURLToPath(import.meta.url),source,output,name],{cwd:source,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let fallback;const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');fallback=setTimeout(()=>done({code:null,signal:null,cleanupUnknown:true}),5000);},55000);
   child.stdout.on('data',bytes=>{stdout=(stdout+String(bytes)).slice(0,131072);});child.stderr.on('data',bytes=>{stderr=(stderr+String(bytes)).slice(0,16384);});child.once('error',error=>{stderr=(stderr+String(error)).slice(0,16384);});child.once('close',(code,signal)=>{clearTimeout(timer);clearTimeout(fallback);done({code,signal,cleanupUnknown:false});});
  });
  const phases=[];for(const line of stdout.split(/\r?\n/).filter(Boolean)){try{phases.push(JSON.parse(line));}catch{phases.push({phase:'unparsed-child-output',text:line.slice(0,1000)});}}
  const verified=result.code===0&&!timedOut&&!result.cleanupUnknown&&phases.some(row=>row.phase==='complete');if(!verified)failed=true;
  const receipt={at:new Date().toISOString(),phase:'scenario-result',scenario:name,verified,timedOut,...result,stderr,phases};appendFileSync(log,JSON.stringify(receipt)+'\n');console.log(JSON.stringify(receipt));if(result.cleanupUnknown)break;
 }
 if(failed)process.exitCode=1;
}else{
if(!scenarios.includes(scenario))throw Error('Unknown native diagnostic scenario.');
const directory=mkdtempSync(join(tmpdir(),'relay-ci-guard-diagnostic-')),log=join(output,'native-guard-'+scenario+'.jsonl');writeFileSync(log,'',{flag:'wx'});
function record(value){const entry={at:new Date().toISOString(),scenario,...value};appendFileSync(log,JSON.stringify(entry)+'\n');console.log(JSON.stringify(entry));}
record({phase:'environment',directory,node:process.version,architecture:process.arch,platform:process.platform,cwd:source,systemRoot:process.env.SystemRoot??null,modulePath:process.env.PSModulePath??null});
let helper,stdoutBytes=0,stderrBytes=0;const original=cp.spawn;
function sample(phase,data){const limit=phase==='guard-stdout'?16384:32768,used=phase==='guard-stdout'?stdoutBytes:stderrBytes;if(used>=limit)return;const bytes=Buffer.from(data).subarray(0,limit-used);if(phase==='guard-stdout')stdoutBytes+=bytes.length;else stderrBytes+=bytes.length;record({phase,text:bytes.toString('utf8')});}
cp.spawn=function(file,args,options){
 if(args?.some(value=>String(value).endsWith('tree-guard.ps1'))){
  const path=args.find(value=>String(value).endsWith('tree-guard.ps1'));let script=readFileSync(path,'utf8');
  if(!script.includes("Add-Type -TypeDefinition @'")||!script.includes('} catch { [Console]::Out.WriteLine'))throw Error('Synthetic helper logging markers changed.');
  const early=String.raw`[Console]::Error.WriteLine('DIAG|body-entry '+[DateTime]::UtcNow.ToString('o'))
$ErrorActionPreference = 'Stop'
try {
 function Read-Policy($hive,[string]$path,[string]$name){$key=$hive.OpenSubKey($path);if($null -eq $key){return ''};try{return [string]$key.GetValue($name,'')}finally{$key.Dispose()}}
 [Console]::Error.WriteLine('DIAG|policy process='+[Environment]::GetEnvironmentVariable('PSExecutionPolicyPreference')+';machine='+(Read-Policy ([Microsoft.Win32.Registry]::LocalMachine) 'SOFTWARE\Microsoft\PowerShell\1\ShellIds\Microsoft.PowerShell' 'ExecutionPolicy')+';user='+(Read-Policy ([Microsoft.Win32.Registry]::CurrentUser) 'SOFTWARE\Microsoft\PowerShell\1\ShellIds\Microsoft.PowerShell' 'ExecutionPolicy')+';machinePolicy='+(Read-Policy ([Microsoft.Win32.Registry]::LocalMachine) 'SOFTWARE\Policies\Microsoft\Windows\PowerShell' 'ExecutionPolicy')+';userPolicy='+(Read-Policy ([Microsoft.Win32.Registry]::CurrentUser) 'SOFTWARE\Policies\Microsoft\Windows\PowerShell' 'ExecutionPolicy'))
} catch {[Console]::Error.WriteLine('DIAG|policy-read-unavailable')}`;
  script=script.replace("$ErrorActionPreference = 'Stop'",early);
  script=script.replace("Add-Type -TypeDefinition @'","[Console]::Error.WriteLine('DIAG|before-AddType '+[DateTime]::UtcNow.ToString('o'))\nAdd-Type -TypeDefinition @'");
  script=script.replace("'@\r\ntry {","'@\r\n[Console]::Error.WriteLine('DIAG|after-AddType '+[DateTime]::UtcNow.ToString('o'))\r\ntry {").replace("'@\ntry {","'@\n[Console]::Error.WriteLine('DIAG|after-AddType '+[DateTime]::UtcNow.ToString('o'))\ntry {");
  script=script.replace('} catch { [Console]::Out.WriteLine',"} catch { [Console]::Error.WriteLine('DIAG|native-failure '+$_.Exception.ToString()); [Console]::Out.WriteLine");
  writeFileSync(path,script);const child=original.call(this,file,args,options);helper=child;
  child.stdout.on('data',data=>sample('guard-stdout',data));
  child.stderr.on('data',data=>sample('guard-stderr',data));child.on('close',(code,signal)=>record({phase:'guard-close',code,signal}));return child;
 }
 return original.call(this,file,args,options);
};syncBuiltinESMExports();
let guard;const watchdog=setTimeout(()=>{record({phase:'watchdog-timeout'});helper?.kill('SIGKILL');},45000);
try{const{WindowsTreeGuard}=await import(pathToFileURL(join(source,'server/herdr/tree-guard.ts')).href);const started=Date.now();guard=await WindowsTreeGuard.create(directory,()=>{});record({phase:'ready',ms:Date.now()-started});const pids=await guard.drain();await guard.release();record({phase:'complete',ms:Date.now()-started,drained:pids});}
catch(error){record({phase:'failure',message:String(error.stack??error).slice(0,6000)});if(helper?.exitCode===null)helper.kill('SIGKILL');process.exitCode=1;}
finally{clearTimeout(watchdog);cp.spawn=original;syncBuiltinESMExports();}
record({phase:'receipt',log});
}
