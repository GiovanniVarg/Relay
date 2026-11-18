import {createHash} from 'node:crypto';
import type {HarnessChange,HarnessFile} from '../shared/harness-changes.js';
import type {HarnessChanges,HarnessChangePage} from './harness-changes.js';
import {HttpError,stringValue} from './security.js';

const text=(value:string,max:number)=>value.replace(/[\u0000-\u001f\u007f-\u009f]/g,' ').slice(0,max);
function strings(value:unknown,limits:Record<string,number>){
 const source=value&&typeof value==='object'?value as Record<string,unknown>:{};const result:Record<string,string|null>={};
 for(const[field,max]of Object.entries(limits)){if(typeof source[field]==='string')result[field]=text(source[field],max);else if(source[field]===null)result[field]=null;}
 return result;
}
function integer(value:unknown,name:string,fallback:number,min:number,max=Number.MAX_SAFE_INTEGER){
 if(value===undefined)return fallback;if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max)throw new HttpError(400,`${name} must be an integer from ${min} to ${max}`);return value;
}
/** Model-facing projection only. Full check logs and activation control material stay at rest. */
export function harnessStatusPage(inspection:unknown,changes:HarnessChange[]|HarnessChangePage,activation:unknown,args:Record<string,unknown>){
 const all=Array.isArray(changes)?changes:undefined,page=all?undefined:changes as HarnessChangePage;
 if(page&&(!Array.isArray(page.changes)||typeof page!=='object'))throw new HttpError(400,'Invalid harness status page');
 const offset=integer(page?page.offset:args.offset,'offset',0,0),limit=integer(page?page.limit:args.limit,'limit',10,1,20),total=page?integer(page.total,'total',0,0):all!.length,selected=page?page.changes:all!.slice(offset,offset+limit),source=inspection&&typeof inspection==='object'?inspection as Record<string,unknown>:{};
 if(page&&(selected.length>limit||selected.length>Math.max(0,total-offset)||args.offset!==undefined&&integer(args.offset,'offset',0,0)!==offset||args.limit!==undefined&&integer(args.limit,'limit',10,1,20)!==limit))throw new HttpError(400,'Harness status page bounds differ from the requested page');
 const inspect:Record<string,unknown>=strings(source,{installDirectory:1000,workspacesDirectory:1000,executionBoundary:1000});
 for(const field of ['editableDirectories','editableRootFiles'])if(Array.isArray(source[field]))inspect[field]=(source[field]as unknown[]).filter((item):item is string=>typeof item==='string').slice(0,20).map(item=>text(item,100));
 const active=activation&&typeof activation==='object'?strings(activation,{status:40,changeId:100,revision:100,runId:100,requestId:100,jobId:100,message:1000,error:1000}):null;
 const pid=activation&&typeof activation==='object'?(activation as Record<string,unknown>).newPid:undefined;
 if(active&&typeof pid==='number'&&Number.isSafeInteger(pid)&&pid>0)(active as Record<string,unknown>).newPid=pid;
 const rows:Record<string,unknown>[]=[];
 const result=()=>({...inspect,changes:rows,offset,limit,total,nextOffset:offset+rows.length<total?offset+rows.length:null,activation:active,apply:'Use relay_check_change then relay_apply_change with the exact checked revision. Activation waits for the requesting turn and all other active work to finish.'});
 for(const change of selected){
  rows.push({...strings(change,{id:100,title:160,agentId:100,createdAt:40,updatedAt:40,status:40,revision:100,checkedRevision:100,error:500,workspaceDirectory:500,previewUrl:500}),checkLogCharacters:typeof change.checkLog==='string'?change.checkLog.length:0});
  if(Buffer.byteLength(JSON.stringify(result()))>60000){rows.pop();break;}
 }
 // Whitelisted inspection/activation fields and a single bounded row fit comfortably.
 if(offset<total&&!rows.length)throw new HttpError(413,'Harness status metadata exceeds its bounded page size');
 return result();
}
export function changeCheckLogPage(change:HarnessChange,args:Record<string,unknown>){
 const offset=integer(args.offset,'offset',0,0),length=integer(args.length,'length',12000,1,12000);
 if(args.revision!==undefined&&stringValue(args.revision,'revision',100,1)!==change.revision)throw new HttpError(409,'The change revision changed; inspect its current metadata before reading another log page');
 const log=typeof change.checkLog==='string'?change.checkLog:'',content=log.slice(offset,offset+length);
 return{changeId:change.id,revision:change.revision,checkedRevision:change.checkedRevision,status:change.status,offset,total:log.length,nextOffset:offset+content.length<log.length?offset+content.length:null,content};
}

const sourceHash=(content:string)=>createHash('sha256').update(content).digest('hex');
const sourceKey=(path:string)=>process.platform==='win32'?path.toLowerCase():path;
function exactSource(file:HarnessFile|null,content:string|null):{path:string;content:string;hash:string}|null{
 if(!file){if(content===null)return null;throw new HttpError(409,'Source content has no pinned file metadata');}
 if(content!==null){
  // TextDecoder strips one leading UTF-8 BOM. Restore only the exact prefix
  // proven by the raw source hash AND size; never accept arbitrary normalization.
  for(const candidate of [content,'\uFEFF'+content])if(Buffer.byteLength(candidate)===file.size&&sourceHash(candidate)===file.hash)return{path:file.path,content:candidate,hash:file.hash};
 }
 throw new HttpError(409,'The source file changed outside the pinned revision; inspect the current metadata and retry');
}
function sourceRevision(change:HarnessChange,args:Record<string,unknown>){
 if(args.revision!==undefined&&stringValue(args.revision,'revision',100,1)!==change.revision)throw new HttpError(409,'The change revision changed; inspect its current metadata before reading another source page');
 if(typeof args.offset==='number'&&args.offset>0&&args.revision===undefined)throw new HttpError(400,'Use the returned revision when requesting another source page');
}
function sourcePage(change:HarnessChange,file:{path:string;content:string;hash:string},args:Record<string,unknown>){
 const offset=integer(args.offset,'offset',0,0),length=integer(args.length,'length',12000,1,12000);
 if(args.hash!==undefined&&stringValue(args.hash,'hash',100,1)!==file.hash)throw new HttpError(409,'The full source file hash changed; read its current metadata before continuing');
 const content=file.content.slice(offset,offset+length),end=offset+content.length;
 const lineAt=(position:number)=>1+(file.content.slice(0,position).match(/\n/g)?.length??0);
 return{changeId:change.id,revision:change.revision,path:file.path,hash:file.hash,size:Buffer.byteLength(file.content),offset,offsetUnit:'utf16',total:file.content.length,nextOffset:end<file.content.length?end:null,complete:offset===0&&end===file.content.length,startLine:lineAt(Math.min(offset,file.content.length)),endLine:lineAt(Math.min(end,file.content.length)),totalLines:lineAt(file.content.length),content};
}
function sourceList<T>(change:HarnessChange,rows:T[],args:Record<string,unknown>,defaultLimit:number,maxLimit:number){
 const offset=integer(args.offset,'offset',0,0),limit=integer(args.limit,'limit',defaultLimit,1,maxLimit),files:T[]=[];
 const result=()=>({changeId:change.id,revision:change.revision,files,offset,limit,total:rows.length,nextOffset:offset+files.length<rows.length?offset+files.length:null});
 for(const row of rows.slice(offset,offset+limit)){files.push(row);if(Buffer.byteLength(JSON.stringify(result()))>60000){files.pop();break;}}
 if(offset<rows.length&&!files.length)throw new HttpError(413,'Source metadata exceeds the bounded page size');
 return result();
}
/** Only model-facing replies are paged. The editor, full source and CAS writes stay exact. */
export async function changeSourceResult(changes:Pick<HarnessChanges,'get'|'files'|'read'|'diff'>,changeId:string,operation:'files'|'read'|'diff',args:Record<string,unknown>){
 // Read failures keep their original exact error. Successful reads must match a
 // real source manifest, not merely two get() calls (get may skip refresh while busy).
 const file=operation==='read'?await changes.read(changeId,stringValue(args.path,'path',500,1)):undefined;
 const catalog=(await changes.files(changeId)).map(file=>({path:file.path,hash:file.hash,size:file.size})).sort((a,b)=>a.path.localeCompare(b.path));
 const catalogRevision=sourceHash(JSON.stringify(catalog)),before=await changes.get(changeId);sourceRevision(before,args);
 if(catalogRevision!==before.revision)throw new HttpError(409,'The change revision changed while reading its source catalog; inspect the current metadata and retry');
 const manifest=new Map(catalog.map(file=>[file.path,file]));
 let result:unknown;
 if(operation==='read'){
  const saved=manifest.get(file!.path)??(process.platform==='win32'?catalog.find(saved=>sourceKey(saved.path)===sourceKey(file!.path)):undefined);
  if(!saved||saved.hash!==file!.hash)throw new HttpError(409,'The source file changed outside the pinned revision; inspect the current metadata and retry');
  result=sourcePage(before,exactSource(saved,file!.content)!,args);
 }
 else if(operation==='files'){
  const prefix=args.prefix===undefined?'':stringValue(args.prefix,'prefix',500,0);
  const files=catalog.filter(file=>sourceKey(file.path).startsWith(sourceKey(prefix)));
  result={...sourceList<HarnessFile>(before,files,args,100,100),prefix};
 }else{
  const diff=(await changes.diff(changeId,{sourceMetadata:true})).sort((a,b)=>a.path.localeCompare(b.path)).map(file=>{
   // Backend diff rows carry canonical paths. Case-only Windows renames are
   // separate deletion/addition rows, even though native reads accept aliases.
   const saved=manifest.get(file.path);
   if(file.afterFile?!saved||saved.hash!==file.afterFile.hash||saved.size!==file.afterFile.size:!!saved)throw new HttpError(409,'The change revision changed during this diff read; inspect the current metadata and retry');
   return{path:file.path,before:exactSource(file.beforeFile,file.before),after:exactSource(file.afterFile,file.after)};
  });
  if(args.path!==undefined){
   if(args.limit!==undefined)throw new HttpError(400,'limit applies to the diff file list; use length for a path page');
   integer(args.offset,'offset',0,0);integer(args.length,'length',12000,1,12000);
   const path=stringValue(args.path,'path',500,1);let file=diff.find(file=>file.path===path);
   if(!file&&process.platform==='win32'){
    const aliases=diff.filter(file=>sourceKey(file.path)===sourceKey(path));
    if(aliases.length>1)throw new HttpError(409,'Ambiguous path casing; choose the exact path returned by the diff file list');
    file=aliases[0];
   }
   if(!file)throw new HttpError(404,'The path has no changes in this draft');
   const side=args.side===undefined?'after':args.side;if(side!=='before'&&side!=='after')throw new HttpError(400,'side must be before or after');
   const source=file[side];if(source===null&&args.hash!==undefined)throw new HttpError(409,'There is no source file hash on this side of the change');
   result=source===null?{changeId:before.id,revision:before.revision,path:file.path,side,exists:false,hash:null,size:0,total:0,nextOffset:null,complete:true,content:null}:{...sourcePage(before,source,args),side,exists:true};
  }else{
   if(args.side!==undefined||args.length!==undefined||args.hash!==undefined)throw new HttpError(400,'Choose a path to read a before or after source page');
   const metadata=(value:{content:string;hash:string}|null)=>value===null?null:{hash:value.hash,size:Buffer.byteLength(value.content),characters:value.content.length};
   result=sourceList(before,diff.map(file=>({path:file.path,kind:file.before===null?'added':file.after===null?'removed':'modified',before:metadata(file.before),after:metadata(file.after)})),args,25,50);
  }
 }
 // A file read can race another edit, including an external filesystem edit. Never
 // label a mixed-revision page with the old pin, even when no caller pin was supplied.
 const after=(await changes.files(changeId)).map(file=>({path:file.path,hash:file.hash,size:file.size})).sort((a,b)=>a.path.localeCompare(b.path));
 if(sourceHash(JSON.stringify(after))!==before.revision||(await changes.get(changeId)).revision!==before.revision)throw new HttpError(409,'The change revision changed during this source read; inspect the current metadata and retry');
 return result;
}
export function changeWriteReceipt(file:{path:string;content:string;hash:string},revision:string){
 return{path:file.path,hash:file.hash,size:Buffer.byteLength(file.content),characters:file.content.length,revision,saved:true};
}
