// Synthetic, single-process instrumentation only. Never runs ordinary tests or changes target source.
import{mkdtempSync,readFileSync,writeFileSync,appendFileSync}from'node:fs';
import{tmpdir}from'node:os';import{join,resolve,isAbsolute}from'node:path';
import{pathToFileURL}from'node:url';import{syncBuiltinESMExports}from'node:module';import cp from'node:child_process';
if(!process.argv[2]||!process.argv[3]||!isAbsolute(process.argv[2])||!isAbsolute(process.argv[3]))throw Error('Pass absolute reviewed source and diagnostic output directories.');
const source=resolve(process.argv[2]),output=resolve(process.argv[3]);process.chdir(source);
const directory=mkdtempSync(join(tmpdir(),'relay-ci-guard-diagnostic-')),log=join(output,'native-guard.jsonl');writeFileSync(log,'',{flag:'wx'});
function record(value){const entry={at:new Date().toISOString(),...value};appendFileSync(log,JSON.stringify(entry)+'\n');console.log(JSON.stringify(entry));}
record({phase:'environment',directory,node:process.version,architecture:process.arch,platform:process.platform,cwd:source,systemRoot:process.env.SystemRoot??null,modulePath:process.env.PSModulePath??null});
let helper,stdoutBytes=0,stderrBytes=0;const original=cp.spawn;
function sample(phase,data){const limit=phase==='guard-stdout'?16384:32768,used=phase==='guard-stdout'?stdoutBytes:stderrBytes;if(used>=limit)return;const bytes=Buffer.from(data).subarray(0,limit-used);if(phase==='guard-stdout')stdoutBytes+=bytes.length;else stderrBytes+=bytes.length;record({phase,text:bytes.toString('utf8')});}
cp.spawn=function(file,args,options){
 if(args?.some(value=>String(value).endsWith('tree-guard.ps1'))){
  const path=args.find(value=>String(value).endsWith('tree-guard.ps1'));let script=readFileSync(path,'utf8');
  if(!script.includes("Add-Type -TypeDefinition @'")||!script.includes('} catch { [Console]::Out.WriteLine'))throw Error('Synthetic helper logging markers changed.');
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
