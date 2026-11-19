// Synthetic vault comparison only. Product checks, 20-second timeouts and return values stay intact.
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,isAbsolute} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
if(process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_OS!=='Windows'||process.env.GITHUB_REPOSITORY!=='GiovanniVarg/Relay')throw Error('Vault diagnostics run only in official Windows CI.');
if(!process.argv[2]||!process.argv[3]||!isAbsolute(process.argv[2])||!isAbsolute(process.argv[3]))throw Error('Pass absolute reviewed source and diagnostic output directories.');
const source=resolve(process.argv[2]),output=resolve(process.argv[3]);
const scenario=process.argv[4]==='--scenario'?process.argv[5]:undefined;
const caseNames=['baseline','explicit-utility','explicit-required-builtins'];
if(process.argv[4]&&!scenario||scenario&&!caseNames.includes(scenario))throw Error('Unknown synthetic DPAPI scenario.');
const redact=value=>String(value).replace(/S-1-[0-9-]+/g,'[sid]');

if(!scenario){
 const scenarios=[];
 let utilitySufficed=false;
 for(const name of caseNames){
  if(name==='explicit-required-builtins'&&utilitySufficed)break;
  const started=Date.now(),child=childProcess.spawn(process.execPath,[...process.execArgv,fileURLToPath(import.meta.url),source,output,'--scenario',name],{cwd:source,windowsHide:true,stdio:['ignore','pipe','pipe'],env:process.env});
  let stdout='',stderr='',timedOut=false;
  const exit=await new Promise(done=>{let fallback,settled=false;const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(fallback);done(value);};const timer=setTimeout(()=>{timedOut=true;fallback=setTimeout(()=>finish({code:child.exitCode,signal:child.signalCode,cleanupUnknown:true}),3000);try{child.kill();}catch(error){stderr=(stderr+'\n'+redact(error)).slice(0,8192);}},100000);child.stdout.on('data',data=>{stdout=(stdout+String(data)).slice(0,32768);});child.stderr.on('data',data=>{stderr=(stderr+String(data)).slice(0,8192);});child.once('error',error=>finish({code:null,signal:null,launchError:redact(error),cleanupUnknown:!!child.pid}));child.once('close',(code,signal)=>finish({code,signal,cleanupUnknown:timedOut}));});
  let result;try{const bytes=await readFile(join(output,'dpapi-'+name+'.json'));if(bytes.length>192*1024)throw Error('Scenario receipt exceeded its bound');result=JSON.parse(bytes.toString('utf8'));if(result.scenario!==name)throw Error('Scenario receipt mismatch');}catch(error){result={verified:false,scenario:name,receiptUnavailable:true,error:redact(error)};}
  scenarios.push({scenario:name,exit,durationMs:Date.now()-started,timedOut,stdout:redact(stdout),stderr:redact(stderr),result});
  if(name==='explicit-utility')utilitySufficed=exit.code===0&&result.verified===true;
  if(exit.cleanupUnknown||result.cleanupUnknown)break;
 }
 const cleanupUnknown=scenarios.some(item=>item.exit.cleanupUnknown||item.result.cleanupUnknown);
 const expectedCount=utilitySufficed?2:3;
 const verified=scenarios.length===expectedCount&&!cleanupUnknown&&scenarios.every(item=>item.exit.code===0&&item.result.verified);
 const requiredBuiltins=scenarios.find(item=>item.scenario==='explicit-required-builtins');
 const aggregate={scope:'Synthetic actual-vault trusted import contrast; no environment widening or release certification',version:process.versions.node,separateNodeProcesses:true,environmentWidened:false,verified,cleanupUnknown,remainingScenariosStopped:scenarios.length!==expectedCount,utilityOnlyRoundtripVerified:utilitySufficed,requiredBuiltinsRoundtripVerified:requiredBuiltins?.result.verified??null,requiredBuiltinsOmittedBecauseUtilitySufficed:utilitySufficed,scenarios};
 await writeFile(join(output,'dpapi.json'),JSON.stringify(aggregate,null,2),{flag:'wx'});
 console.log(JSON.stringify({scope:aggregate.scope,separateNodeProcesses:true,environmentWidened:false,verified,cleanupUnknown,utilityOnlyRoundtripVerified:aggregate.utilityOnlyRoundtripVerified,requiredBuiltinsRoundtripVerified:aggregate.requiredBuiltinsRoundtripVerified,requiredBuiltinsOmittedBecauseUtilitySufficed:aggregate.requiredBuiltinsOmittedBecauseUtilitySufficed,remainingScenariosStopped:aggregate.remainingScenariosStopped,scenarios:scenarios.map(item=>({scenario:item.scenario,exit:item.exit,timedOut:item.timedOut,verified:item.result.verified,operations:item.result.operations?.map(({operation,durationMs,exitCode,closeObserved,phases,stderrBytes})=>({operation,durationMs,exitCode,closeObserved,phases,stderrBytes}))}))}));
 if(!verified)process.exitCode=1;
}else{
 const original=childProcess.spawn,operations=[],owned=[];const deadline=Date.now()+75000;
 const systemRoot=process.env.SystemRoot||'C:\\Windows';
 childProcess.spawn=function(command,args,options){
  let operation;
  if(Array.isArray(args)&&args.includes('-EncodedCommand')){
   const index=args.indexOf('-EncodedCommand')+1;let script=Buffer.from(args[index],'base64').toString('utf16le');
   if(script.includes("$request=[Console]::In.ReadToEnd()|ConvertFrom-Json")&&script.includes('ProtectedData')){
    if(Date.now()>deadline||operations.length>=16)throw Error('Synthetic scenario operation budget exceeded.');
    if(resolve(command)!==resolve(join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe')))throw Error('Unexpected vault bridge executable.');
    operation={operation:'unknown',diagnostics:'',exitCode:null,closeObserved:false,stderrBytes:0,environmentWidened:false};operations.push(operation);
    const request="$request=[Console]::In.ReadToEnd()|ConvertFrom-Json";
    const before='} catch {exit 1}',after="} catch { $category=[string]$_.Exception.Message;if($category -notin @('unsafe','owner','inheritance','principal','rights','missing','operation')){$category='other'};[Console]::Error.WriteLine(('D|fail|'+$_.Exception.GetType().Name+'|'+$category));exit 1}";
    if(script.split(before).length!==2||script.split(request).length!==2)throw Error('Synthetic bridge logging seams changed.');
    const modules=scenario==='baseline'?[]:scenario==='explicit-utility'?['Microsoft.PowerShell.Utility']:['Microsoft.PowerShell.Utility','Microsoft.PowerShell.Management','Microsoft.PowerShell.Security'];
    const imports=modules.map(name=>"[Console]::Error.WriteLine('D|before-import|"+name+"|'+[DateTime]::UtcNow.ToString('o'));Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules','"+name+"','"+name+".psd1')) -ErrorAction Stop;[Console]::Error.WriteLine('D|after-import|"+name+"|'+[DateTime]::UtcNow.ToString('o'));\n").join('');
    const converter=scenario==='baseline'?'ConvertFrom-Json':'Microsoft.PowerShell.Utility\\ConvertFrom-Json';
    script="[Console]::Error.WriteLine('D|entry')\n"+script.replace(request,imports+"$diagnosticJson=[Console]::In.ReadToEnd();[Console]::Error.WriteLine('D|stdin');$request=$diagnosticJson|"+converter+";[Console]::Error.WriteLine(('D|json|'+$request.op))").replace(before,after);
    for(const[command,phase]of[["$item=Get-Item -LiteralPath $request.directory -Force",'getitem'],["$item=Get-Item -LiteralPath $path -Force",'getitem'],["Set-Acl -LiteralPath $request.directory -AclObject $acl",'setacl'],["$acl=Get-Acl -LiteralPath $path",'getacl']]){
     script=script.replace(command,"[Console]::Error.WriteLine('D|before-"+phase+"');"+command+";[Console]::Error.WriteLine('D|after-"+phase+"')");
    }
    args=[...args];args[index]=Buffer.from(script,'utf16le').toString('base64');
    // Every actual PowerShell bridge retains its original scrubbed environment unchanged.
   }
  }
  const child=original.call(this,command,args,options);
  if(operation){
   const started=Date.now(),end=child.stdin.end,write=child.stdin.write;
   child.stdin.write=function(chunk,...rest){try{operation.operation=JSON.parse(String(chunk)).op;}catch{}return write.call(this,chunk,...rest);};
   child.stdin.end=function(chunk,...rest){try{operation.operation=JSON.parse(String(chunk)).op;}catch{}return end.call(this,chunk,...rest);};
   child.once('spawn',()=>{operation.spawnObserved=true;});
   child.stderr.on('data',chunk=>{operation.stderrBytes+=chunk.length;operation.diagnostics=(operation.diagnostics+String(chunk)).slice(0,8192);});
   const closed=new Promise(done=>child.once('close',(code,signal)=>{operation.exitCode=code;operation.signal=signal;operation.closeObserved=true;operation.durationMs=Date.now()-started;done();}));
   owned.push({child,closed,operation});
  }
  return child;
 };syncBuiltinESMExports();
 const directory=await mkdtemp(join(tmpdir(),'relay-ci-dpapi-'+scenario+'-'));let vault,result;
 console.log(JSON.stringify({phase:'scenario-start',scenario,fixtureDirectory:directory}));
 try{
  const{SecretVault}=await import(pathToFileURL(join(source,'server/secret-vault.ts')).href);
  vault=new SecretVault(directory);await vault.set('typesafe-api-key','synthetic-CI-diagnostic-only');vault.close();vault=new SecretVault(directory);
  if(await vault.get('typesafe-api-key')!=='synthetic-CI-diagnostic-only')throw Error('Synthetic roundtrip mismatch');
  result={verified:true,scenario,source,execPath:process.execPath,version:process.versions.node,tempRoot:tmpdir(),environment:'actual scrubbed bridge environment unchanged',operations};
 }catch(error){result={verified:false,scenario,source,execPath:process.execPath,version:process.versions.node,tempRoot:tmpdir(),error:redact(error),operations};process.exitCode=1;}
 finally{
  vault?.close();
  for(const item of owned)if(item.child.exitCode===null&&item.child.signalCode===null)try{item.child.kill();}catch{result.cleanupKillFailed=true;}
  await Promise.race([Promise.all(owned.map(item=>item.closed)),new Promise(done=>setTimeout(done,3000))]);
  childProcess.spawn=original;syncBuiltinESMExports();
  result.cleanupUnknown=owned.some(item=>!item.operation.closeObserved);
  if(result.cleanupUnknown){result.verified=false;result.fixtureRetained=true;result.fixtureDirectory=directory;process.exitCode=1;}
  else try{await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});}catch(error){result.cleanupError=redact(error);process.exitCode=1;}
 }
 for(const operation of operations){
  operation.phases=[...operation.diagnostics.matchAll(/D\|(entry|stdin|json\|[a-z]+|(?:before|after)-(?:getitem|setacl|getacl)|(?:before|after)-import\|[A-Za-z.]+\|[0-9:T.Z+-]+|fail\|[^\r\n]+)/g)].map(match=>redact(match[1]));
  operation.ownerChecks=[...operation.diagnostics.matchAll(/OWNER\|(S-[0-9-]+)\|USER\|(S-[0-9-]+)/g)].map(([,owner,user])=>({ownerMatchesUser:owner===user,ownerIsAdministrators:owner==='S-1-5-32-544'}));
  operation.diagnostics=redact(operation.diagnostics);
 }
 await writeFile(join(output,'dpapi-'+scenario+'.json'),JSON.stringify(result,null,2),{flag:'wx'});
 console.log(JSON.stringify({verified:result.verified,scenario,operations:operations.length,phaseSummaries:operations.map(item=>({operation:item.operation,phases:item.phases,closeObserved:item.closeObserved,stderrBytes:item.stderrBytes}))}));
}
