// Synthetic, single-process instrumentation only. Never runs ordinary tests or changes target source.
import{mkdtempSync,readFileSync,writeFileSync,appendFileSync}from'node:fs';
import{tmpdir}from'node:os';import{join,resolve,isAbsolute}from'node:path';
import{pathToFileURL,fileURLToPath}from'node:url';import{syncBuiltinESMExports}from'node:module';import cp from'node:child_process';
import{safeWindowsOsAdditions,selectWindowsOsAdditions,minimizePassingOsKeys}from'./windows-os-environment.mjs';
if(!process.argv[2]||!process.argv[3]||!isAbsolute(process.argv[2])||!isAbsolute(process.argv[3]))throw Error('Pass absolute reviewed source and diagnostic output directories.');
const source=resolve(process.argv[2]),output=resolve(process.argv[3]);process.chdir(source);
const scenario=process.argv[4],selectedKeys=process.argv[5]?JSON.parse(process.argv[5]):[];
if(!scenario){
 const log=join(output,'native-guard.jsonl');writeFileSync(log,'',{flag:'wx'});
 const{childEnvironment}=await import(pathToFileURL(join(source,'server/providers/process.ts')).href);
 const filtered=childEnvironment(),additions=safeWindowsOsAdditions(process.env,filtered),keys=Object.keys(additions).sort(),deadline=performance.now()+220000,maxCases=16;
 const results=[];let unsafe=false,caseNumber=0;
 const record=row=>{appendFileSync(log,JSON.stringify(row)+'\n');console.log(JSON.stringify(row));};
 async function probe(name,names,raw=false){
  if(unsafe||results.length>=maxCases||deadline-performance.now()<60000)return null;
  const env=raw?process.env:{...filtered,...selectWindowsOsAdditions(additions,names)};
  let stdout='',stderr='',timedOut=false;
  const result=await new Promise(done=>{const child=cp.spawn(process.execPath,[...process.execArgv,fileURLToPath(import.meta.url),source,output,name,JSON.stringify(names)],{cwd:source,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let fallback,settled=false;const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(fallback);done(value);};const timer=setTimeout(()=>{timedOut=true;fallback=setTimeout(()=>finish({code:null,signal:null,cleanupUnknown:true}),5000);try{child.kill('SIGKILL');}catch{}},55000);
   child.stdout.on('data',bytes=>{stdout=(stdout+String(bytes)).slice(0,131072);});child.stderr.on('data',bytes=>{stderr=(stderr+String(bytes)).slice(0,16384);});child.once('error',error=>{stderr=(stderr+String(error)).slice(0,16384);});child.once('close',(code,signal)=>finish({code,signal,cleanupUnknown:timedOut}));
  });
  const phases=[];for(const line of stdout.split(/\r?\n/).filter(Boolean)){try{phases.push(JSON.parse(line));}catch{phases.push({phase:'unparsed-child-output',text:line.slice(0,1000)});}}
  const verified=result.code===0&&!timedOut&&!result.cleanupUnknown&&phases.some(row=>row.phase==='complete');
  const receipt={at:new Date().toISOString(),phase:'scenario-result',scenario:name,addedOsKeyNames:names,verified,timedOut,...result,stderr,phases};results.push(receipt);record(receipt);unsafe=result.cleanupUnknown;return receipt;
 }
 const raw=await probe('raw',[],true),baseline=await probe('baseline',[]),complete=await probe('os-complete',keys);
 const healed=!!raw?.verified&&!baseline?.verified&&!!complete?.verified&&keys.length>0&&!unsafe;
 let passing=keys,oneMinimal=false,confirmed=false,budgetLimited=false;
 if(healed){
  const minimized=await minimizePassingOsKeys(keys,names=>probe('reduce-'+(++caseNumber),names));passing=minimized.keys;oneMinimal=minimized.oneMinimal;budgetLimited=minimized.budgetLimited;
  const confirmation=await probe('confirm-'+(++caseNumber),passing);confirmed=!!confirmation?.verified;
 }
 record({at:new Date().toISOString(),phase:'comparison-summary',candidateOsKeyNames:keys,testedCases:results.length,maxCases,wallBudgetMs:220000,rawPassed:raw?.verified??false,baselinePassed:baseline?.verified??false,osCompletePassed:complete?.verified??false,osAdditionsHealed:healed,passingOsKeyNames:healed?passing:[],oneMinimalVerified:healed&&oneMinimal&&confirmed&&!unsafe,passingSetConfirmed:confirmed,minimizationBudgetLimited:budgetLimited,cleanupUnknown:unsafe,conclusion:!healed?'Safe OS additions did not prove a heal; no production change is justified.':oneMinimal&&confirmed?'A confirmed one-minimal passing OS addition set was found.':'A passing OS addition set was observed, but minimization or confirmation is incomplete.'});
 if(unsafe||!raw?.verified||!complete?.verified||healed&&!confirmed)process.exitCode=1;
}else{
if(!/^(?:raw|baseline|os-complete|reduce-[1-9][0-9]*|confirm-[1-9][0-9]*)$/.test(scenario)||!Array.isArray(selectedKeys)||selectedKeys.some(key=>typeof key!=='string'))throw Error('Unknown native diagnostic scenario.');
const directory=mkdtempSync(join(tmpdir(),'relay-ci-guard-diagnostic-')),log=join(output,'native-guard-'+scenario+'.jsonl');writeFileSync(log,'',{flag:'wx'});
function record(value){const entry={at:new Date().toISOString(),scenario,...value};appendFileSync(log,JSON.stringify(entry)+'\n');console.log(JSON.stringify(entry));}
record({phase:'environment',node:process.version,architecture:process.arch,platform:process.platform,addedOsKeyNames:selectedKeys});
let helper,stdoutBytes=0,stderrBytes=0;const original=cp.spawn;
function sample(phase,data){const limit=phase==='guard-stdout'?16384:32768,used=phase==='guard-stdout'?stdoutBytes:stderrBytes;if(used>=limit)return;const bytes=Buffer.from(data).subarray(0,limit-used);if(phase==='guard-stdout')stdoutBytes+=bytes.length;else stderrBytes+=bytes.length;record({phase,text:bytes.toString('utf8')});}
cp.spawn=function(file,args,options){
 if(args?.some(value=>String(value).endsWith('tree-guard.ps1'))){
  const path=args.find(value=>String(value).endsWith('tree-guard.ps1'));let script=readFileSync(path,'utf8');
  if(!script.includes("Add-Type -TypeDefinition @'")||!script.includes('} catch { [Console]::Out.WriteLine'))throw Error('Synthetic helper logging markers changed.');
  const early=String.raw`[Console]::Error.WriteLine('DIAG|body-entry '+[DateTime]::UtcNow.ToString('o'))
$ErrorActionPreference = 'Stop'`;
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
record({phase:'receipt',file:'native-guard-'+scenario+'.jsonl'});
}
