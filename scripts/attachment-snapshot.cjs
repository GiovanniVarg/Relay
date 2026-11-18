'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
const [mode,dbPath,root]=process.argv.slice(2),db=new DatabaseSync(dbPath,{readOnly:true});
function fail(){throw Error('Snapshot attachment references are incomplete, redirected or changed');}
const digest=b=>createHash('sha256').update(b).digest('hex'),uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,sha=/^[0-9a-f]{64}$/;
try{const get=(kind,id)=>{if(typeof id!=='string')return null;const row=db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind,id);return row?JSON.parse(row.data):null;};
 const equal=require('node:util').isDeepStrictEqual;const manifest=a=>{const{id,name,mimeType,size,sha256,kind,width,height,extraction}=a;return{id,name,mimeType,size,sha256,kind,...(width===undefined?{}:{width}),...(height===undefined?{}:{height}),...(extraction===undefined?{}:{extraction})};};
 const surface=a=>a.surface??'conversation';
 const validOwner=a=>surface(a)==='conversation'?typeof a.agentId==='string'&&typeof a.conversationId==='string'&&a.roomId===undefined&&a.draftId===undefined&&get('conversation',a.conversationId)?.agentId===a.agentId&&!!get('agent',a.agentId):surface(a)==='group'?typeof a.roomId==='string'&&a.agentId===undefined&&a.conversationId===undefined&&a.draftId===undefined&&!!get('group-room',a.roomId):surface(a)==='dispatcher'?typeof a.draftId==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(a.draftId)&&a.agentId===undefined&&a.conversationId===undefined&&a.roomId===undefined&&a.messageId===null:false;
 const owns=(a,m,kind)=>kind==='message'?surface(a)==='conversation'&&a.conversationId===m.conversationId:kind==='group-message'&&surface(a)==='group'&&a.roomId===m.roomId;
 const files=[];
 for(const row of db.prepare("SELECT data FROM records WHERE kind='attachment'").all()){const a=JSON.parse(row.data);
  if(!uuid.test(a.id)||!sha.test(a.sha256)||!Number.isSafeInteger(a.size)||a.size<1||a.size>4194304||!validOwner(a))fail();
  if(a.messageId!==null){const kind=surface(a)==='group'?'group-message':'message',m=get(kind,a.messageId);if(m?.role!=='user'||!owns(a,m,kind)||!m.attachments?.some(ref=>equal(ref,manifest(a))))fail();}
  files.push({path:'attachments/'+a.id+'.bin',sha256:a.sha256,bytes:a.size});
  if(a.extraction){const e=a.extraction;if(!sha.test(e.sha256)||e.sourceSha256!==a.sha256||!Number.isSafeInteger(e.characters)||e.characters<0||e.characters>80000||typeof e.parser!=='string'||typeof e.version!=='string')fail();files.push({path:'attachments/'+a.id+'.txt',sha256:e.sha256,characters:e.characters});}
 }
 for(const row of db.prepare("SELECT kind,data FROM records WHERE kind IN ('message','group-message')").all()){let m;try{m=JSON.parse(row.data);}catch{continue;}if(m.attachments!==undefined){if(m.role!=='user'||!Array.isArray(m.attachments)||m.attachments.length>8||new Set(m.attachments.map(a=>a.id)).size!==m.attachments.length)fail();for(const ref of m.attachments){const a=get('attachment',ref.id);if(!a||a.messageId!==m.id||!owns(a,m,row.kind)||!equal(ref,manifest(a)))fail();}}}
 if(mode==='validate'){const manifest=JSON.parse(fs.readFileSync(path.join(root,'backup.json'),'utf8'));const listed=new Map(manifest.files.map(f=>[f.path.replaceAll('\\','/'),f]));if(listed.size!==manifest.files.length)fail();for(const entry of files){if(listed.get(entry.path)?.sha256!==entry.sha256)fail();}}
 if(mode.startsWith('validate'))for(const entry of files){const target=path.resolve(root,entry.path),base=path.resolve(root);if(!target.startsWith(base+path.sep))fail();for(const name of [base,path.dirname(target),target]){const info=fs.lstatSync(name);if(info.isSymbolicLink()||path.resolve(fs.realpathSync(name)).toLowerCase()!==name.toLowerCase())fail();}
 const stat=fs.lstatSync(target);if(!stat.isFile()||stat.size>(entry.bytes??320000))fail();const bytes=fs.readFileSync(target);if(digest(bytes)!==entry.sha256||entry.bytes!==undefined&&bytes.length!==entry.bytes)fail();if(entry.characters!==undefined&&new TextDecoder('utf8',{fatal:true}).decode(bytes).length!==entry.characters)fail();}
 process.stdout.write(JSON.stringify(files));
}finally{db.close();}
