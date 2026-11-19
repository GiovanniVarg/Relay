// Synthetic, single-process instrumentation only. Never runs ordinary tests or changes target source.
import{mkdtempSync,readFileSync,writeFileSync,appendFileSync}from'node:fs';
import{tmpdir}from'node:os';import{join,resolve,isAbsolute}from'node:path';
import{pathToFileURL,fileURLToPath}from'node:url';import{syncBuiltinESMExports}from'node:module';import cp from'node:child_process';
if(process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_OS!=='Windows'||process.env.GITHUB_REPOSITORY!=='GiovanniVarg/Relay')throw Error('Native diagnostics run only in official Windows CI.');
if(!process.argv[2]||!process.argv[3]||!isAbsolute(process.argv[2])||!isAbsolute(process.argv[3]))throw Error('Pass absolute reviewed source and diagnostic output directories.');
const source=resolve(process.argv[2]),output=resolve(process.argv[3]);process.chdir(source);
const scenario=process.argv[4],caseNames=['baseline','explicit-utility'];
if(!scenario){
 const log=join(output,'native-guard.jsonl');writeFileSync(log,'',{flag:'wx'});
 const results=[];let unsafe=false;
 const record=row=>{appendFileSync(log,JSON.stringify(row)+'\n');console.log(JSON.stringify(row));};
 async function probe(name){
  if(unsafe)return null;
  const env=process.env; // CI authorization belongs to this driver; the measured PowerShell environment is filtered below.
  let stdout='',stderr='',timedOut=false;
  const result=await new Promise(done=>{const child=cp.spawn(process.execPath,[...process.execArgv,fileURLToPath(import.meta.url),source,output,name],{cwd:source,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let fallback,settled=false;const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(fallback);done(value);};const timer=setTimeout(()=>{timedOut=true;fallback=setTimeout(()=>finish({code:null,signal:null,cleanupUnknown:true}),5000);try{child.kill('SIGKILL');}catch{}},55000);
   child.stdout.on('data',bytes=>{stdout=(stdout+String(bytes)).slice(0,131072);});child.stderr.on('data',bytes=>{stderr=(stderr+String(bytes)).slice(0,16384);});child.once('error',error=>{stderr=(stderr+String(error)).slice(0,16384);});child.once('close',(code,signal)=>finish({code,signal,cleanupUnknown:timedOut}));
  });
  const phases=[];for(const line of stdout.split(/\r?\n/).filter(Boolean)){try{phases.push(JSON.parse(line));}catch{phases.push({phase:'unparsed-child-output',text:line.slice(0,1000)});}}
  const verified=result.code===0&&!timedOut&&!result.cleanupUnknown&&phases.some(row=>row.phase==='complete');
  const receipt={at:new Date().toISOString(),phase:'scenario-result',scenario:name,environmentWidened:false,verified,timedOut,...result,stderr,phases};results.push(receipt);record(receipt);unsafe=result.cleanupUnknown;return receipt;
 }
 const baseline=await probe('baseline'),candidate=await probe('explicit-utility');
 record({at:new Date().toISOString(),phase:'comparison-summary',testedCases:results.length,environmentWidened:false,originalGuardDeadlineMs:12000,baselinePassed:baseline?.verified??false,explicitUtilityPassed:candidate?.verified??false,utilityImportHealed:!baseline?.verified&&!!candidate?.verified&&!unsafe,cleanupUnknown:unsafe});
 if(unsafe||results.length!==caseNames.length||results.some(row=>!row.verified))process.exitCode=1;
}else{
if(!caseNames.includes(scenario))throw Error('Unknown native diagnostic scenario.');
const directory=mkdtempSync(join(tmpdir(),'relay-ci-guard-diagnostic-')),log=join(output,'native-guard-'+scenario+'.jsonl');writeFileSync(log,'',{flag:'wx'});
function record(value){const entry={at:new Date().toISOString(),scenario,...value};appendFileSync(log,JSON.stringify(entry)+'\n');console.log(JSON.stringify(entry));}
record({phase:'environment',node:process.version,architecture:process.arch,platform:process.platform,environmentWidened:false});
const{childEnvironment}=await import(pathToFileURL(join(source,'server/providers/process.ts')).href);
const measuredPowerShellEnvironment=childEnvironment(process.env);
let helper,stdoutBytes=0,stderrBytes=0;const original=cp.spawn;
function sample(phase,data){const limit=phase==='guard-stdout'?16384:32768,used=phase==='guard-stdout'?stdoutBytes:stderrBytes;if(used>=limit)return;const bytes=Buffer.from(data).subarray(0,limit-used);if(phase==='guard-stdout')stdoutBytes+=bytes.length;else stderrBytes+=bytes.length;record({phase,text:bytes.toString('utf8')});}
cp.spawn=function(file,args,options){
 if(args?.some(value=>String(value).endsWith('tree-guard.ps1'))){
  const path=args.find(value=>String(value).endsWith('tree-guard.ps1'));let script=readFileSync(path,'utf8');
  if(!script.includes("Add-Type -TypeDefinition @'")||!script.includes('} catch { [Console]::Out.WriteLine'))throw Error('Synthetic helper logging markers changed.');
  const early=String.raw`[Console]::Error.WriteLine('DIAG|body-entry '+[DateTime]::UtcNow.ToString('o'))
$ErrorActionPreference = 'Stop'`;
  script=script.replace("$ErrorActionPreference = 'Stop'",early);
  if(scenario==='explicit-utility'){
   const trustedImport="[Console]::Error.WriteLine('DIAG|before-utility-import '+[DateTime]::UtcNow.ToString('o'))\nImport-Module -Name ([IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Utility','Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop\n[Console]::Error.WriteLine('DIAG|after-utility-import '+[DateTime]::UtcNow.ToString('o'))\n";
   script=script.replace("Add-Type -TypeDefinition @'",trustedImport+"Add-Type -TypeDefinition @'");
   script=script.replaceAll('| ConvertTo-Json','| Microsoft.PowerShell.Utility\\ConvertTo-Json');
  }
  script=script.replace("Add-Type -TypeDefinition @'","[Console]::Error.WriteLine('DIAG|before-AddType '+[DateTime]::UtcNow.ToString('o'))\nAdd-Type -TypeDefinition @'");
  script=script.replace("'@\r\ntry {","'@\r\n[Console]::Error.WriteLine('DIAG|after-AddType '+[DateTime]::UtcNow.ToString('o'))\r\ntry {").replace("'@\ntry {","'@\n[Console]::Error.WriteLine('DIAG|after-AddType '+[DateTime]::UtcNow.ToString('o'))\ntry {");
  script=script.replace('} catch { [Console]::Out.WriteLine',"} catch { [Console]::Error.WriteLine('DIAG|native-failure '+$_.Exception.ToString()); [Console]::Out.WriteLine");
  writeFileSync(path,script);const child=original.call(this,file,args,{...options,env:measuredPowerShellEnvironment});helper=child;
  child.stdout.on('data',data=>sample('guard-stdout',data));
  child.stderr.on('data',data=>sample('guard-stderr',data));child.on('close',(code,signal)=>record({phase:'guard-close',code,signal}));return child;
 }
 return original.call(this,file,args,options);
};syncBuiltinESMExports();
let guard;const watchdog=setTimeout(()=>{record({phase:'watchdog-timeout'});helper?.kill('SIGKILL');},45000);
try{const{WindowsTreeGuard}=await import(pathToFileURL(join(source,'server/herdr/tree-guard.ts')).href);const started=Date.now();guard=await WindowsTreeGuard.create(directory,()=>{});record({phase:'ready',ms:Date.now()-started});const pids=await guard.drain();await guard.release();record({phase:'complete',ms:Date.now()-started,drained:pids});}
catch(error){record({phase:'failure',message:String(error.stack??error).slice(0,6000)});if(helper?.exitCode===null)helper.kill('SIGKILL');process.exitCode=1;}
finally{clearTimeout(watchdog);cp.spawn=original;syncBuiltinESMExports();}
record({phase:'receipt',file:'native-guard-'+scenario+'.jsonl'});
}
