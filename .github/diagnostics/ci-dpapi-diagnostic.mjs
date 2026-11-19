// Synthetic vault only. Instrumentation logs failures; all production checks and return values stay intact.
import childProcess from'node:child_process';import{syncBuiltinESMExports}from'node:module';
import{mkdtemp,rm,writeFile}from'node:fs/promises';import{tmpdir}from'node:os';
import{join,resolve,isAbsolute}from'node:path';import{pathToFileURL}from'node:url';
if(!process.argv[2]||!process.argv[3]||!isAbsolute(process.argv[2])||!isAbsolute(process.argv[3]))throw Error('Pass absolute reviewed source and diagnostic output directories.');
const source=resolve(process.argv[2]),output=resolve(process.argv[3]),original=childProcess.spawn,operations=[];
childProcess.spawn=function(command,args,options){
 let operation;
 if(Array.isArray(args)&&args.includes('-EncodedCommand')){
  const index=args.indexOf('-EncodedCommand')+1;let script=Buffer.from(args[index],'base64').toString('utf16le');
  if(script.includes("$request=[Console]::In.ReadToEnd()|ConvertFrom-Json")&&script.includes('ProtectedData')){
   operation={operation:'unknown',diagnostics:'',exitCode:null};operations.push(operation);
   const before='} catch {exit 1}',after="} catch { [Console]::Error.WriteLine(('{\"reason\":\"'+$_.Exception.GetType().Name+'\",\"guard\":\"'+$_.Exception.Message+'\"}')); if($request.op -eq 'verify'){ foreach($p in $request.paths){try{$a=Get-Acl -LiteralPath $p;[Console]::Error.WriteLine(('OWNER|'+$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value+'|USER|'+[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value))}catch{}} };exit 1}";
   if(script.split(before).length!==2)throw Error('Synthetic bridge catch changed.');args=[...args];args[index]=Buffer.from(script.replace(before,after),'utf16le').toString('base64');
  }
 }
 const child=original.call(this,command,args,options);
 if(operation){const start=Date.now(),write=child.stdin.write,end=child.stdin.end;child.stdin.write=function(chunk,...rest){try{operation.operation=JSON.parse(String(chunk)).op;}catch{}return write.call(this,chunk,...rest);};child.stdin.end=function(chunk,...rest){try{operation.operation=JSON.parse(String(chunk)).op;}catch{}return end.call(this,chunk,...rest);};child.stderr.on('data',chunk=>{operation.diagnostics=(operation.diagnostics+String(chunk)).slice(0,8192);});child.on('close',code=>{operation.exitCode=code;operation.durationMs=Date.now()-start;operation.stderrBytes=Buffer.byteLength(operation.diagnostics);});}
 return child;
};syncBuiltinESMExports();
const directory=await mkdtemp(join(tmpdir(),'relay-ci-dpapi-diagnostic-'));let vault,result;
try{const{SecretVault}=await import(pathToFileURL(join(source,'server/secret-vault.ts')).href);vault=new SecretVault(directory);await vault.set('typesafe-api-key','synthetic-CI-diagnostic-only');vault.close();vault=new SecretVault(directory);if(await vault.get('typesafe-api-key')!=='synthetic-CI-diagnostic-only')throw Error('Synthetic roundtrip mismatch');result={verified:true,source,execPath:process.execPath,version:process.versions.node,tempRoot:tmpdir(),operations};}
catch(error){result={verified:false,source,execPath:process.execPath,version:process.versions.node,tempRoot:tmpdir(),error:String(error),operations};process.exitCode=1;}
finally{vault?.close();childProcess.spawn=original;syncBuiltinESMExports();await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
for(const operation of operations){operation.ownerChecks=[...operation.diagnostics.matchAll(/OWNER\|(S-[0-9-]+)\|USER\|(S-[0-9-]+)/g)].map(([,owner,user])=>({ownerMatchesUser:owner===user,ownerIsAdministrators:owner==='S-1-5-32-544'}));operation.diagnostics=operation.diagnostics.replace(/S-1-[0-9-]+/g,'[sid]');}
await writeFile(join(output,'dpapi.json'),JSON.stringify(result,null,2),{flag:'wx'});console.log(JSON.stringify(result,null,2));
