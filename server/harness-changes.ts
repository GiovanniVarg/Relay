import {runHarnessCommand,type CheckCommandLifecycle} from './harness-command.js';
import {CheckOutputLog} from './check-output-log.js';
import {renameAtomicState} from './atomic-state-file.js';
import {createHash,randomUUID} from 'node:crypto';
import {spawn,type ChildProcess} from 'node:child_process';
import {createServer,type Server} from 'node:http';
import {lstat,mkdir,readFile,readdir,realpath,rename,rm,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename,dirname,extname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import type {HarnessChange,HarnessDiff,HarnessFile,PreparedHarnessChange} from '../shared/harness-changes.js';
import {HttpError,stringValue} from './security.js';
import {noEffectFailure} from './tool-failures.js';

const SOURCE_DIRS=new Set(['server','shared','client','scripts','tests','docs']);
const SOURCE_ROOTS=new Set(['package.json','package-lock.json','README.md','Start-Relay.ps1','Start Relay.cmd','Setup Relay.cmd','tsconfig.json','tsconfig.server.json','vite.config.ts','.gitignore']);
const MAX_FILE=200000,MAX_SOURCE=20000000,MAX_FILES=5000;
const stamp=()=>new Date().toISOString();
const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
const revision=(files:HarnessFile[])=>hash(JSON.stringify(files));
const samePath=(a:string,b:string)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const inside=(parent:string,child:string)=>{const r=relative(parent,child);return r!==''&&!r.startsWith('..'+sep)&&r!=='..'&&!isAbsolute(r);};
const validId=(id:string)=>{if(!/^[a-f0-9-]{36}$/.test(id))throw new HttpError(404,'Change not found');return id;};
function sourcePath(value:unknown):string {
 const path=stringValue(value,'Source path',500,1);
 const parts=path.split('/');
 if(path.includes('\\')||isAbsolute(path)||parts.some(p=>!p||p==='.'||p==='..'||/[\x00-\x1f<>:"|?*]/.test(p)||/[. ]$/.test(p)||/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p)))throw new HttpError(400,'Use a relative source file path');
 if(parts.length===1? !SOURCE_ROOTS.has(path): !SOURCE_DIRS.has(parts[0]))throw new HttpError(403,'This is not an editable Relay source path');
 if(parts.slice(1).some(p=>p.startsWith('.')||/^(?:node_modules|dist)$/i.test(p))||/\.(?:sqlite|db|pem|key|pfx|p12|crt|cer|log|zip|exe|dll)$/i.test(path))throw new HttpError(403,'Private data and generated files are excluded from source changes');
 return path;
}
function textBytes(bytes:Buffer,path:string):string {
 if(bytes.length>MAX_FILE)throw new HttpError(413,`${path} exceeds the 200 KB source-file limit`);
 let content:string;try{content=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new HttpError(400,`${path} is not UTF-8 text`);}
 if(content.includes('\0'))throw new HttpError(400,`${path} is not a text source file`);
 return content;
}
/** Reject links at every existing ancestor. Drafts are separate files, never links into the installation. */
async function safeTarget(root:string,path:string,missing=false):Promise<string>{
 const target=resolve(root,...path.split('/'));if(!inside(root,target))throw new HttpError(403,'Path escapes the source workspace');
 const rootInfo=await lstat(root);if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink())throw new HttpError(409,'Workspace root is not an ordinary directory');const canonicalRoot=await realpath(root);
 let current=root;for(const piece of path.split('/')){current=join(current,piece);try{const info=await lstat(current);if(info.isSymbolicLink()||info.isFile()&&info.nlink>1)throw new HttpError(409,'Linked files and directories cannot be used in a Relay change');const actual=await realpath(current);if(!samePath(actual,canonicalRoot)&&!inside(canonicalRoot,actual))throw new HttpError(409,'Source path resolves outside its workspace');}catch(e){if(missing&&(e as NodeJS.ErrnoException).code==='ENOENT')break;throw e;}}
 return target;
}
/** Bound disk pressure and drain every started operation before reporting a batch failure. */
export async function settledFileWork<T>(items:readonly T[],work:(item:T)=>Promise<void>,concurrency=10):Promise<void>{
 let next=0,failed=false,failure:unknown;
 await Promise.all(Array.from({length:Math.min(concurrency,items.length)},async()=>{
  while(!failed){const index=next++;if(index>=items.length)return;try{await work(items[index]);}catch(error){if(!failed){failed=true;failure=error;}}}
 }));
 if(failed)throw failure;
}
async function scan(root:string,kind:'source'|'built'|'dependencies'='source'):Promise<HarnessFile[]>{
 const files:HarnessFile[]=[],pending:string[]=[],directories=[''];let total=0;
 for(let index=0;index<directories.length;index++){
  const prefix=directories[index],dir=prefix?await safeTarget(root,prefix):root;
  for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
   const path=prefix?prefix+'/'+entry.name:entry.name;
   if(kind==='source'){
    if(!prefix&&!SOURCE_ROOTS.has(entry.name)&&!SOURCE_DIRS.has(entry.name))continue;
    if(prefix){try{sourcePath(path);}catch{continue;}}
   }
   if(entry.isDirectory())directories.push(path);
   else{pending.push(path);if(pending.length>(kind==='source'?MAX_FILES:100000))throw new HttpError(413,'Too many files in change');}
  }
 }
 await settledFileWork(pending,async path=>{
  const target=await safeTarget(root,path),info=await lstat(target);
  if(!info.isFile())throw new HttpError(409,'Only ordinary files and directories can be copied');
  if(kind==='source'&&info.size>MAX_FILE)throw new HttpError(413,`${path} exceeds the 200 KB source-file limit`);
  const bytes=await readFile(target);if(kind==='source')textBytes(bytes,path);total+=bytes.length;
  if(total>(kind==='source'?MAX_SOURCE:3000000000))throw new HttpError(413,'Change directory is too large');
  files.push({path,hash:hash(bytes),size:bytes.length});
 });return files.sort((a,b)=>a.path.localeCompare(b.path));
}
async function copyFiles(from:string,to:string,files:HarnessFile[],signal?:AbortSignal){
 await mkdir(to,{recursive:true});
 await settledFileWork(files,async file=>{if(signal?.aborted)throw new Error('Checks cancelled');const source=await safeTarget(from,file.path),target=await safeTarget(to,file.path,true),bytes=await readFile(source);if(hash(bytes)!==file.hash)throw new HttpError(409,'Source changed while copying; try again');await mkdir(dirname(target),{recursive:true});await safeTarget(to,file.path,true);await writeFile(target,bytes,{flag:'wx'});});
}
interface RecordState { change:HarnessChange;baseFiles:HarnessFile[];checkedDirectory?:string;checkedBuilt?:HarnessFile[];checkedDependencies?:HarnessFile[]; }
/** Internal projection metadata. Ordinary REST/editor diffs retain their existing shape. */
export interface HarnessSourceDiff extends HarnessDiff {beforeFile:HarnessFile|null;afterFile:HarnessFile|null;}
export interface HarnessCommand {executable:string;args:string[];cwd:string;env:NodeJS.ProcessEnv;signal?:AbortSignal;}
export interface HarnessChangesOptions {
 installDirectory:string;dataDirectory:string;workspacesDirectory?:string;
 /** Test seam only; rejection on abort must follow cleanup, or carry HARNESS_CHECK_OUTCOME_UNKNOWN. HTTP/agent calls cannot replace this runner. */
 commandRunner?:(command:HarnessCommand,output:(text:string)=>void)=>Promise<void>;
}
export interface HarnessChangePage {changes:HarnessChange[];offset:number;limit:number;total:number;nextOffset:number|null;}
/** Source isolation and review, not an OS sandbox. Approved builds/tests execute local code as the current user. */
export class HarnessChanges {
 readonly installDirectory:string;readonly dataDirectory:string;readonly workspacesDirectory:string;
 private records=new Map<string,RecordState>();private busy=new Set<string>();private previews=new Map<string,{server:Server;revision:string;url:string}>();private children=new Set<ChildProcess>();private checks=new Map<string,{controller:AbortController;finished:Promise<void>}>();private initialized=false;private closed=false;
 constructor(private options:HarnessChangesOptions){this.installDirectory=resolve(options.installDirectory);this.dataDirectory=resolve(options.dataDirectory);this.workspacesDirectory=resolve(options.workspacesDirectory??join(homedir(),'Relay-workspaces'));}
 busyCount(){return this.busy.size;}
 private get control(){return join(this.dataDirectory,'harness-changes');}
 private draft(id:string){return join(this.workspacesDirectory,validId(id),'draft');}
 private base(id:string){return join(this.workspacesDirectory,validId(id),'base');}
 async initialize(){if(this.initialized)return;await mkdir(this.control,{recursive:true});await mkdir(this.workspacesDirectory,{recursive:true});for(const dir of[this.control,this.workspacesDirectory]){const info=await lstat(dir);if(info.isSymbolicLink()||!info.isDirectory())throw new Error('Change storage must be an ordinary directory');}
  for(const entry of await readdir(this.control)){if(!/^[a-f0-9-]{36}\.json$/.test(entry))continue;try{const record=JSON.parse(await readFile(await safeTarget(this.control,entry),'utf8')) as RecordState;validId(record.change.id);record.change.workspaceDirectory=this.draft(record.change.id);record.change.previewUrl=null;if(record.change.status==='checking'){record.change.status='failed';record.change.error='Relay restarted during checks. Run them again before applying.';record.change.checkedRevision=null;}this.records.set(record.change.id,record);}catch{/* A damaged record never becomes executable authority. */}}
  this.initialized=true;
 }
 private async state(id:string){await this.initialize();const state=this.records.get(validId(id));if(!state)throw new HttpError(404,'Change not found');return state;}
 private async save(state:RecordState){state.change.updatedAt=stamp();const path=await safeTarget(this.control,state.change.id+'.json',true),temp=path+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(state),{flag:'wx'});await renameAtomicState(temp,path);}
 private async refresh(state:RecordState){const files=await scan(state.change.workspaceDirectory),next=revision(files);if(next!==state.change.revision){state.change.revision=next;state.change.checkedRevision=null;state.change.status='draft';state.change.error=null;await this.stopPreview(state.change.id);await this.save(state);}return files;}
 async get(id:string):Promise<HarnessChange>{const state=await this.state(id);if(!this.busy.has(id))await this.refresh(state);return structuredClone(state.change);}
 async list():Promise<HarnessChange[]>{await this.initialize();const result:HarnessChange[]=[];for(const id of this.records.keys())result.push(await this.get(id));return result.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));}
 /** Select from saved metadata first; only selected drafts earn a fresh source scan. */
 async listPage(options:{offset?:unknown;limit?:unknown}={}):Promise<HarnessChangePage>{
  if(!options||typeof options!=='object'||Array.isArray(options))throw new HttpError(400,'Status page options must be an object');
  const integer=(value:unknown,name:string,fallback:number,min:number,max=Number.MAX_SAFE_INTEGER)=>{if(value===undefined)return fallback;if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max)throw new HttpError(400,name+' must be an integer from '+min+' to '+max);return value;};
  const offset=integer(options.offset,'offset',0,0),limit=integer(options.limit,'limit',10,1,20);
  await this.initialize();
  const ordered=[...this.records.values()].sort((a,b)=>b.change.updatedAt.localeCompare(a.change.updatedAt)||a.change.id.localeCompare(b.change.id)),selected=ordered.slice(offset,offset+limit),changes:HarnessChange[]=[];
  for(const state of selected)changes.push(await this.get(state.change.id));
  const total=ordered.length;return{changes,offset,limit,total,nextOffset:offset+changes.length<total?offset+changes.length:null};
 }
 async status(id:string){return this.get(id);}
 async inspect(){return {installDirectory:this.installDirectory,workspacesDirectory:this.workspacesDirectory,editableDirectories:[...SOURCE_DIRS],editableRootFiles:[...SOURCE_ROOTS],executionBoundary:'Source drafts are separate copies. Approved builds and tests run as your Windows user, not in an OS sandbox. Saved accounts and conversations are not copied.'};}
 async create(input:{title:string;agentId?:string}):Promise<HarnessChange>{return this.createFrom(this.installDirectory,input);}
 /** Internal recovery entry: source only, with current installation as the review baseline. */
 async restoreDraft(sourceDirectory:string,title:string):Promise<HarnessChange>{return this.createFrom(resolve(sourceDirectory),{title});}
 private async createFrom(sourceDirectory:string,input:{title:string;agentId?:string}){
  await this.initialize();const title=stringValue(input.title,'Change title',160,1).trim();if(!title)throw new HttpError(400,'Change title is required');if(input.agentId!==undefined)stringValue(input.agentId,'Bot ID',100,1);
  const baseFiles=await scan(this.installDirectory),sourceFiles=samePath(sourceDirectory,this.installDirectory)?baseFiles:await scan(sourceDirectory),id=randomUUID(),createdAt=stamp();
  await copyFiles(this.installDirectory,this.base(id),baseFiles);await copyFiles(sourceDirectory,this.draft(id),sourceFiles);
  const change:HarnessChange={id,title,agentId:input.agentId??null,createdAt,updatedAt:createdAt,status:'draft',revision:revision(sourceFiles),checkedRevision:null,checkLog:'',error:null,workspaceDirectory:this.draft(id),previewUrl:null};const record={change,baseFiles};this.records.set(id,record);await this.save(record);return structuredClone(change);
 }
 async files(id:string):Promise<HarnessFile[]>{const state=await this.state(id);return this.refresh(state);}
 async read(id:string,path:string):Promise<{path:string;content:string;hash:string}>{const state=await this.state(id);path=sourcePath(path);const bytes=await readFile(await safeTarget(state.change.workspaceDirectory,path));return {path,content:textBytes(bytes,path),hash:hash(bytes)};}
 private assertFree(id:string){if(this.busy.has(id))throw new HttpError(409,'Checks or preparation are running for this change');}
 async write(id:string,input:{path:string;content:string;expectedHash:string|null}){
  const state=await this.state(id);this.assertFree(id);this.busy.add(id);try{const path=sourcePath(input.path),bytes=Buffer.from(stringValue(input.content,'Source content',MAX_FILE)),target=await safeTarget(state.change.workspaceDirectory,path,true);textBytes(bytes,path);const files=await this.refresh(state),old=files.find(f=>samePath(f.path,path));if(input.expectedHash!==(old?.hash??null))throw noEffectFailure(new HttpError(409,'This file changed. Reload it before saving.'),'source_prewrite');if(files.reduce((n,f)=>n+f.size,0)-(old?.size??0)+bytes.length>MAX_SOURCE||!old&&files.length>=MAX_FILES)throw noEffectFailure(new HttpError(413,'Source workspace limit exceeded'),'source_prewrite');await mkdir(dirname(target),{recursive:true});await safeTarget(state.change.workspaceDirectory,path,true);const temp=target+'.'+randomUUID()+'.tmp';await writeFile(temp,bytes,{flag:'wx'});await rename(temp,target);await this.refresh(state);return {path,content:input.content,hash:hash(bytes)};}finally{this.busy.delete(id);}
 }
 async remove(id:string,input:{path:string;expectedHash:string|null}){const state=await this.state(id);this.assertFree(id);this.busy.add(id);try{const path=sourcePath(input.path),file=await this.read(id,path);if(file.hash!==input.expectedHash)throw noEffectFailure(new HttpError(409,'This file changed. Reload it before deleting.'),'source_prewrite');await rm(await safeTarget(state.change.workspaceDirectory,path));await this.refresh(state);return {removed:true,path};}finally{this.busy.delete(id);}}
 async diff(id:string,options:{sourceMetadata:true}):Promise<HarnessSourceDiff[]>;
 async diff(id:string):Promise<HarnessDiff[]>;
 async diff(id:string,options?:{sourceMetadata:true}):Promise<HarnessDiff[]>{const state=await this.state(id),current=await this.refresh(state),paths=[...new Set([...state.baseFiles.map(f=>f.path),...current.map(f=>f.path)])].sort(),diff:HarnessDiff[]=[];for(const path of paths){const before=state.baseFiles.find(f=>f.path===path),after=current.find(f=>f.path===path);if(before?.hash===after?.hash)continue;const row={path,before:before?textBytes(await readFile(await safeTarget(this.base(id),path)),path):null,after:after?(await this.read(id,path)).content:null};const projected=options?.sourceMetadata?{...row,beforeFile:before??null,afterFile:after??null}:row;diff.push(projected);}return diff;}
 private cleanEnv(cwd:string):NodeJS.ProcessEnv{const env:NodeJS.ProcessEnv={NODE_ENV:'test',CI:'true',RELAY_DATA_DIR:join(cwd,'.check-data'),HOME:cwd,USERPROFILE:cwd,APPDATA:join(cwd,'.check-home','AppData','Roaming'),LOCALAPPDATA:join(cwd,'.check-home','AppData','Local'),TEMP:join(cwd,'.check-temp'),TMP:join(cwd,'.check-temp'),npm_config_userconfig:join(cwd,'.check-home','empty-npmrc'),npm_config_cache:join(cwd,'.check-cache'),npm_config_registry:'https://registry.npmjs.org/',npm_config_ignore_scripts:'true',npm_config_audit:'false',npm_config_fund:'false'};for(const key of ['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','ComSpec','COMSPEC','PATHEXT','PROCESSOR_ARCHITECTURE'])if(process.env[key])env[key]=process.env[key];return env;}
 private async run(command:HarnessCommand,output:(text:string)=>void,lifecycle?:CheckCommandLifecycle){
  if(command.signal?.aborted)throw new Error('Checks cancelled');
  if(this.options.commandRunner){lifecycle?.('running');try{await this.options.commandRunner(command,output);lifecycle?.('drained');}catch(error){lifecycle?.(error&&typeof error==='object'&&'code'in error&&error.code==='HARNESS_CHECK_OUTCOME_UNKNOWN'?'unknown':'drained');throw error;}return;}
  return runHarnessCommand(command,output,this.children,{lifecycle});
 }
 async check(id:string,options:{signal?:AbortSignal;expectedRevision?:string;commandLifecycle?:CheckCommandLifecycle}={}):Promise<HarnessChange>{
  const state=await this.state(id);if(this.closed)throw new HttpError(409,'Relay is shutting down');this.assertFree(id);this.busy.add(id);const controller=new AbortController(),signal=options.signal?AbortSignal.any([controller.signal,options.signal]):controller.signal;let finished!:()=>void;this.checks.set(id,{controller,finished:new Promise<void>(done=>finished=done)});let retainedLog:CheckOutputLog|undefined;try{
   const files=await this.refresh(state),startRevision=revision(files);if(options.expectedRevision!==undefined&&options.expectedRevision!==startRevision)throw new HttpError(409,'Source changed since approval. Review and approve the current revision.');const checked=join(this.workspacesDirectory,'checked-'+randomUUID());await copyFiles(state.change.workspaceDirectory,checked,files,signal);
   state.change.status='checking';state.change.checkedRevision=null;state.change.error=null;state.change.checkLog='Build and tests execute local code as your user. This is a separate source copy, not an OS sandbox.\n';await this.save(state);await this.stopPreview(id);
   const log=new CheckOutputLog(state.change.checkLog);retainedLog=log;const output=(value:string)=>{log.append(value);state.change.checkLog=log.text();};
   const env=this.cleanEnv(checked);for(const folder of['.check-data','.check-home','.check-temp','.check-cache',join('.check-home','AppData','Roaming'),join('.check-home','AppData','Local')])await mkdir(join(checked,folder),{recursive:true});await writeFile(join(checked,'.check-home','empty-npmrc'),'');
   let sameDependencies=false;try{sameDependencies=(await readFile(join(checked,'package.json'))).equals(await readFile(join(this.installDirectory,'package.json')))&&(await readFile(join(checked,'package-lock.json'))).equals(await readFile(join(this.installDirectory,'package-lock.json')));}catch{}
   if(sameDependencies&&existsSync(join(this.installDirectory,'node_modules'))){output('Copying installed dependencies into the check workspace.\n');const dependencies=await scan(join(this.installDirectory,'node_modules'),'dependencies');await copyFiles(join(this.installDirectory,'node_modules'),join(checked,'node_modules'),dependencies,signal);}
   else{const npm=join(dirname(process.execPath),'node_modules','npm','bin','npm-cli.js');if(!existsSync(npm))throw new Error('npm is unavailable. Re-run Setup Relay.cmd to install the local build tools.');output('Installing locked dependencies with npm ci --ignore-scripts.\n');await this.run({executable:process.execPath,args:[npm,'ci','--ignore-scripts','--no-audit','--no-fund'],cwd:checked,env,signal},output,options.commandLifecycle);await scan(join(checked,'node_modules'),'dependencies');}
   const nodeModules=join(checked,'node_modules'),commands=[{name:'Type check',args:[join(nodeModules,'typescript','bin','tsc'),'--noEmit','-p','tsconfig.json']},{name:'Server build',args:[join(nodeModules,'typescript','bin','tsc'),'-p','tsconfig.server.json']},{name:'Interface build',args:[join(nodeModules,'vite','bin','vite.js'),'build']}];
   const testFiles=(await readdir(join(checked,'tests'))).filter(f=>f.endsWith('.test.ts')).sort();if(!testFiles.length)throw new Error('At least one test file is required before applying Relay changes');
   // Keep every test serial while bounding each command independently by the existing deadline.
   const testBatchSize=20;
   for(let start=0;start<testFiles.length;start+=testBatchSize)commands.push({name:`Tests ${start+1}-${Math.min(start+testBatchSize,testFiles.length)} of ${testFiles.length}`,args:[join(nodeModules,'tsx','dist','cli.mjs'),'--test','--test-concurrency=1',...testFiles.slice(start,start+testBatchSize).map(f=>join('tests',f))]});
   const totals=[0,0,0,0,0,0];let summariesComplete=true;
   for(const command of commands){
    output('\n'+command.name+'\n');await this.save(state);const isTest=command.args.includes('--test');let summaryTail='';
    await this.run({executable:process.execPath,args:command.args,cwd:checked,env:command.name==='Interface build'?{...env,NODE_ENV:'production'}:env,signal},value=>{if(isTest)summaryTail=(summaryTail+value).slice(-8192);output(value);},options.commandLifecycle);
    if(isTest){
     // Only the complete, unindented final TAP footer counts; nested subtests do not.
     const match=summaryTail.match(/(?:^|\n)# tests (\d+)\r?\n# suites \d+\r?\n# pass (\d+)\r?\n# fail (\d+)\r?\n# cancelled (\d+)\r?\n# skipped (\d+)\r?\n# todo (\d+)\r?\n# duration_ms [\d.]+\s*$/);
     const counts=match?.slice(1).map(Number);
     if(!counts||counts.some(value=>!Number.isSafeInteger(value))||counts[0]!==counts.slice(1).reduce((sum,value)=>sum+value,0)||counts[2]||counts[3]||counts[5])summariesComplete=false;
     else for(let index=0;index<totals.length;index++){totals[index]+=counts[index];if(!Number.isSafeInteger(totals[index]))summariesComplete=false;}
    }
    log.flush();state.change.checkLog=log.text();
   }
   output(summariesComplete?'\nAll test batches passed; aggregate TAP summary\n'+['tests','pass','fail','cancelled','skipped','todo'].map((name,index)=>`# ${name} ${totals[index]}\n`).join(''):'\nAll test batch commands exited successfully; aggregate TAP summary unavailable.\n');
   if(revision(await scan(checked))!==startRevision||revision(await scan(state.change.workspaceDirectory))!==startRevision)throw new Error('Source changed during checks. Run checks again for the current source.');
   const built=await scan(join(checked,'dist'),'built');if(!built.some(f=>f.path==='server/index.js')||!built.some(f=>f.path==='client/index.html'))throw new Error('The build did not produce a complete Relay server and interface');
   state.checkedDirectory=checked;state.checkedBuilt=built.map(f=>({...f,path:'dist/'+f.path}));state.checkedDependencies=(await scan(join(checked,'node_modules'),'dependencies')).map(f=>({...f,path:'node_modules/'+f.path}));state.change.checkedRevision=startRevision;state.change.revision=startRevision;state.change.status='ready';output('\nChecks passed for source revision '+startRevision+'.\n');await this.save(state);return structuredClone(state.change);
  }catch(e){state.change.status='failed';state.change.checkedRevision=null;state.change.error=(e as Error).message;if(retainedLog){retainedLog.append('\n'+state.change.error+'\n');retainedLog.flush();state.change.checkLog=retainedLog.text();}else state.change.checkLog=(state.change.checkLog+'\n'+state.change.error+'\n').slice(-120000);await this.save(state);throw e;}finally{this.busy.delete(id);this.checks.delete(id);finished();}
 }
 private async verified(state:RecordState){await this.refresh(state);if(state.change.status!=='ready'||state.change.checkedRevision!==state.change.revision||!state.checkedDirectory||!state.checkedBuilt||!state.checkedDependencies)throw new HttpError(409,'Run checks for the current source before previewing or applying');if(!inside(this.workspacesDirectory,state.checkedDirectory)||!basename(state.checkedDirectory).startsWith('checked-'))throw new HttpError(409,'Invalid check workspace');if(revision(await scan(state.checkedDirectory))!==state.change.revision||revision((await scan(join(state.checkedDirectory,'dist'),'built')).map(f=>({...f,path:'dist/'+f.path})))!==revision(state.checkedBuilt)||revision((await scan(join(state.checkedDirectory,'node_modules'),'dependencies')).map(f=>({...f,path:'node_modules/'+f.path})))!==revision(state.checkedDependencies))throw new HttpError(409,'Checked files changed. Run checks again.');return state.checkedDirectory;}
 async prepareApply(id:string):Promise<PreparedHarnessChange>{const state=await this.state(id);this.assertFree(id);this.busy.add(id);try{const checked=await this.verified(state),sourceFiles=await scan(checked);if(revision(await scan(this.installDirectory))!==revision(state.baseFiles))throw new HttpError(409,'Relay changed since this draft was created. Create a new draft and bring your edits forward.');const snapshotDirectory=join(this.workspacesDirectory,'frozen-'+randomUUID());await copyFiles(checked,snapshotDirectory,[...sourceFiles,...state.checkedBuilt!,...state.checkedDependencies!]);return {changeId:id,title:state.change.title,revision:state.change.revision,snapshotDirectory,sourceFiles,baseFiles:structuredClone(state.baseFiles),distFiles:structuredClone(state.checkedBuilt!),dependencyFiles:structuredClone(state.checkedDependencies!),dependenciesIncluded:true,createdAt:stamp()};}finally{this.busy.delete(id);}}
 async preview(id:string):Promise<{url:string;revision:string;mode:'interface-only'}>{const state=await this.state(id);this.assertFree(id);this.busy.add(id);try{const checked=await this.verified(state),existing=this.previews.get(id);if(existing?.revision===state.change.revision)return {url:existing.url,revision:existing.revision,mode:'interface-only'};await this.stopPreview(id);const root=join(checked,'dist','client'),agent={id:'preview-atlas',name:'Atlas',role:'Coordinator',initials:'AT',color:'#9a83dc',instructions:'',memory:'',routeMode:'auto',model:'',mode:'agent',workspace:'Preview workspace',pinned:true,unread:false,lastMessage:'Preview only · no connected accounts',createdAt:stamp(),updatedAt:stamp()};const providers=['openai','claude','cursor'].map(id=>({id,installed:false,authenticated:false,authMode:'unknown',accountLabel:'Preview only',plan:'',models:[],inferenceAvailable:false,billing:{mode:'unknown',confirmed:false,automaticRouting:false,allowanceNote:''},modelPreferences:{defaultModel:'',allowedModels:null}}));
  const server=createServer((req,res)=>{void(async()=>{const address=server.address();if(!address||typeof address==='string'||req.headers.host!==`127.0.0.1:${address.port}`){res.writeHead(403);res.end();return;}res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'");res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cache-Control','no-store');const url=new URL(req.url??'/',`http://${req.headers.host}`),json=(value:unknown,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};if(req.method!=='GET')return json({error:'Interface preview only. Actions, accounts and backend changes are disabled.'},403);if(url.pathname==='/api/bootstrap')return json({agents:[agent],conversations:[],rooms:[],providers,settings:{maxRunSeconds:180,maxModelCalls:3,openaiDefaultModel:'',maxWorkSeconds:900},homeDirectory:'Preview workspace',csrfToken:'preview-disabled',version:'preview'});if(url.pathname==='/api/agents/preview-atlas')return json({agent,conversations:[],files:[]});if(url.pathname==='/api/workspace')return json({tasks:[],capabilities:[],routing:{availability:[],recent:[]},artifacts:[],knowledge:[],browserProfiles:[],operation:{node:process.versions.node,installDirectory:'Interface preview',dataDirectory:'No live data'}});if(url.pathname==='/api/tasks')return json({tasks:[]});if(url.pathname.startsWith('/api/'))return json({error:'This is an inert interface preview. No provider or live backend is connected.'},403);let path:string;try{path=decodeURIComponent(url.pathname);}catch{return json({error:'Invalid path'},400);}if(path==='/'||!extname(path))path='/index.html';const target=resolve(root,'.'+path);if(!inside(root,target))return json({error:'Not found'},404);const bytes=await readFile(await safeTarget(root,relative(root,target).split(sep).join('/')));const mime=({'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'}as Record<string,string>)[extname(target)]??'application/octet-stream';res.writeHead(200,{'Content-Type':mime});res.end(bytes);})().catch(()=>{if(!res.headersSent)res.writeHead(404);res.end('Preview file unavailable');});});await new Promise<void>((done,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',done);});const address=server.address();if(!address||typeof address==='string')throw new Error('Preview did not start');const url=`http://127.0.0.1:${address.port}/`;this.previews.set(id,{server,url,revision:state.change.revision});state.change.previewUrl=url;await this.save(state);return {url,revision:state.change.revision,mode:'interface-only'};}finally{this.busy.delete(id);}
 }
 private async stopPreview(id:string){const preview=this.previews.get(id);if(preview){await new Promise<void>(done=>{preview.server.close(()=>done());preview.server.closeAllConnections();});this.previews.delete(id);}const state=this.records.get(id);if(state)state.change.previewUrl=null;}
 async close(){this.closed=true;const checks=[...this.checks.values()];for(const check of checks)check.controller.abort();await Promise.allSettled(checks.map(check=>check.finished));for(const child of this.children)child.kill();for(const id of [...this.previews.keys()])await this.stopPreview(id);}
}
