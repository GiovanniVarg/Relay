// Supplied synthetic bytes only. This probe does not change or bypass the ordinary parser tests.
import{fork}from'node:child_process';import{pathToFileURL}from'node:url';import{writeFile}from'node:fs/promises';import{join,resolve,isAbsolute}from'node:path';
if(!process.argv[2]||!process.argv[3]||!isAbsolute(process.argv[2])||!isAbsolute(process.argv[3]))throw Error('Pass absolute reviewed source and diagnostic output directories.');
const source=resolve(process.argv[2]),output=resolve(process.argv[3]),fixtures=await import(pathToFileURL(join(source,'tests/fixtures/attachment-inputs.ts')).href),results=[];
for(const[name,bytes,mimeType]of[['txt',Buffer.from('synthetic diagnostic'),'text/plain'],['docx',fixtures.docx(),fixtures.DOCX_MIME],['pdf',fixtures.pdf(),'application/pdf'],['clipped-docx',fixtures.docx('x'.repeat(100000)),fixtures.DOCX_MIME]]){
 const result={name,heap:128,execPath:process.execPath,stderr:'',stdout:'',messages:[]};
 try{await new Promise((done,reject)=>{const child=fork(join(source,'server/attachment-worker.ts'),[],{execArgv:['--max-old-space-size=128','--import','tsx'],serialization:'advanced',stdio:['ignore','pipe','pipe','ipc'],windowsHide:true,cwd:source,env:{SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP}});let fallback;const timer=setTimeout(()=>{result.timedOut=true;child.kill();fallback=setTimeout(()=>reject(Error('Synthetic parser exit was not confirmed after timeout.')),5000);},30000);
 child.stdout.on('data',data=>{result.stdout=(result.stdout+String(data)).slice(0,8192);});child.stderr.on('data',data=>{result.stderr=(result.stderr+String(data)).slice(0,8192);});
 child.on('message',message=>{if(message?.result?.text){message.result.textCharacters=message.result.text.length;delete message.result.text;}result.messages.push(message);child.kill();});child.on('error',reject);child.on('exit',(code,signal)=>{clearTimeout(timer);clearTimeout(fallback);result.code=code;result.signal=signal;done();});child.send({bytes,mimeType});});}
 catch(error){result.error=String(error);process.exitCode=1;}
 if(!result.messages.some(message=>message?.ok===true)){process.exitCode=1;}results.push(result);console.log(JSON.stringify(result));
}
await writeFile(join(output,'parser.json'),JSON.stringify(results,null,2),{flag:'wx'});
