import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Explicit dependencies support deterministic tests; production always uses CurrentUser DPAPI. */
export interface SecretProtector {
  protect(value: Buffer, purpose: string): Promise<Buffer>;
  unprotect(value: Buffer, purpose: string): Promise<Buffer>;
}
export interface SecretAcl {
  secureDirectory(directory: string): Promise<void>;
  verify(paths: string[]): Promise<void>;
}
export interface SecretVaultOptions { protector?: SecretProtector; acl?: SecretAcl; platform?: NodeJS.Platform }

// Constant code only: sensitive values travel over anonymous stdin/stdout pipes, never argv/env/files.
const bridgeScript = String.raw`
$ErrorActionPreference='Stop'
try {
  $request=[Console]::In.ReadToEnd()|ConvertFrom-Json
  $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $system=New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
  if($request.op -eq 'secure') {
    $item=Get-Item -LiteralPath $request.directory -Force
    if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'unsafe'}
    $acl=New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true,$false);$acl.SetOwner($sid)
    foreach($principal in @($sid,$system)) {
      $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($principal,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
      $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $request.directory -AclObject $acl
    $item.Attributes=$item.Attributes -bor [IO.FileAttributes]::Hidden
    [Console]::Out.Write('{"ok":true}')
  } elseif($request.op -eq 'verify') {
    foreach($path in $request.paths) {
      $item=Get-Item -LiteralPath $path -Force
      if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'unsafe'}
      $acl=Get-Acl -LiteralPath $path
      if($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'owner'}
      if($item.PSIsContainer -and -not $acl.AreAccessRulesProtected){throw 'inheritance'}
      $seen=@{}
      foreach($rule in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) {
        $id=$rule.IdentityReference.Value
        if(($id -ne $sid.Value -and $id -ne $system.Value) -or $rule.AccessControlType -ne 'Allow'){throw 'principal'}
        if(($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl){throw 'rights'}
        $seen[$id]=$true
      }
      if(-not $seen[$sid.Value] -or -not $seen[$system.Value]){throw 'missing'}
    }
    [Console]::Out.Write('{"ok":true}')
  } elseif($request.op -eq 'protect' -or $request.op -eq 'unprotect') {
    Add-Type -AssemblyName System.Security
    $bytes=[Convert]::FromBase64String($request.data)
    $entropy=[Text.Encoding]::UTF8.GetBytes($request.purpose)
    try {
      if($request.op -eq 'protect'){$result=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)}
      else{$result=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$entropy,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)}
      [Console]::Out.Write(('{"data":"'+[Convert]::ToBase64String($result)+'"}'))
    } finally {
      if($bytes){[Array]::Clear($bytes,0,$bytes.Length)}
      if($result){[Array]::Clear($result,0,$result.Length)}
      if($entropy){[Array]::Clear($entropy,0,$entropy.Length)}
      $request=$null
    }
  } else {throw 'operation'}
} catch {exit 1}
`;
const encodedScript = Buffer.from(bridgeScript,'utf16le').toString('base64');
const MAX_SECRET=16*1024, MAX_FILE=64*1024;
const failure=()=>new Error('Secure credential storage could not be verified or decrypted.');

async function bridge(request: Record<string,unknown>): Promise<{ok?:boolean;data?:string}> {
  return new Promise((accept,reject)=>{
    const root=process.env.SystemRoot||'C:\\Windows';
    const env:NodeJS.ProcessEnv={SystemRoot:root,WINDIR:root};
    for(const name of ['USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP']) if(process.env[name]) env[name]=process.env[name];
    const child=spawn(join(root,'System32','WindowsPowerShell','v1.0','powershell.exe'),
      ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',encodedScript],
      {windowsHide:true,shell:false,stdio:'pipe',env});
    let size=0,stderrSize=0,finished=false;const chunks:Buffer[]=[];
    const finish=(error?:Error)=>{
      if(finished)return;finished=true;clearTimeout(timer);
      try {
        if(error){child.kill();reject(error);return;}
        const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if(!result||typeof result!=='object')throw failure();accept(result);
      }catch{reject(failure());}finally{for(const chunk of chunks)chunk.fill(0);}
    };
    const timer=setTimeout(()=>{child.kill();finish(failure());},20000);timer.unref();
    child.stdout.on('data',(chunk:Buffer)=>{if(finished){chunk.fill(0);return;}size+=chunk.length;if(size>MAX_FILE){child.kill();finish(failure());}else chunks.push(Buffer.from(chunk));chunk.fill(0);});
    child.stderr.on('data',(chunk:Buffer)=>{stderrSize+=chunk.length;chunk.fill(0);if(stderrSize>2048){child.kill();finish(failure());}});
    child.on('error',()=>finish(failure()));child.on('close',code=>finish(code===0?undefined:failure()));
    child.stdin.on('error',()=>finish(failure()));
    child.stdin.end(JSON.stringify(request));
  });
}

function nativeDependencies():{protector:SecretProtector;acl:SecretAcl} {
  async function crypt(op:string,value:Buffer,purpose:string) {
    const result=await bridge({op,data:value.toString('base64'),purpose});
    if(typeof result.data!=='string'||!result.data.length||result.data.length>MAX_FILE||!(/^[A-Za-z0-9+/]+={0,2}$/).test(result.data))throw failure();
    return Buffer.from(result.data,'base64');
  }
  return {
    protector:{protect:(value,purpose)=>crypt('protect',value,purpose),unprotect:(value,purpose)=>crypt('unprotect',value,purpose)},
    acl:{
      async secureDirectory(directory){if(!(await bridge({op:'secure',directory})).ok)throw failure();},
      async verify(paths){if(!(await bridge({op:'verify',paths})).ok)throw failure();}
    }
  };
}

/** At-rest protection, not a sandbox against code running as this Windows account. */
export class SecretVault {
  private readonly directory:string;
  private readonly protector:SecretProtector;
  private readonly acl:SecretAcl;
  private readonly available:boolean;
  private closed=false;
  private queue:Promise<unknown>=Promise.resolve();
  constructor(dataDirectory:string,options:SecretVaultOptions={}) {
    this.directory=join(resolve(dataDirectory),'secure-credentials');
    this.available=Boolean(options.protector&&options.acl)||(options.platform??process.platform)==='win32';
    const native=nativeDependencies();this.protector=options.protector??native.protector;this.acl=options.acl??native.acl;
    if(Boolean(options.protector)!==Boolean(options.acl))throw new Error('Explicit vault dependencies must include protector and ACL.');
  }
  availability():{available:boolean;protection:'windows-dpapi'|'unavailable'} {
    return {available:this.available&&!this.closed,protection:this.available&&!this.closed?'windows-dpapi':'unavailable'};
  }
  close(){this.closed=true;}
  private assertOpen(){if(this.closed)throw Error('Secure credential vault is closed.');if(!this.available)throw Error('Secure credential storage is unavailable on this platform.');}
  private file(name:string){if(!/^[a-z][a-z0-9-]{0,63}$/.test(name))throw Error('Invalid credential name.');return join(this.directory,name+'.dpapi');}
  private serialize<T>(operation:()=>Promise<T>):Promise<T>{const pending=this.queue.then(operation);this.queue=pending.catch(()=>{});return pending;}
  private async links(path:string,missing=false):Promise<boolean>{
    const ancestors:string[]=[];let cursor=resolve(path);
    while(true){ancestors.push(cursor);const parent=dirname(cursor);if(parent===cursor)break;cursor=parent;}
    for(const target of ancestors.reverse()){
      let info;try{info=await lstat(target);}catch(error){if(missing&&target===path&&(error as NodeJS.ErrnoException).code==='ENOENT')return false;throw failure();}
      if(info.isSymbolicLink()||(!info.isDirectory()&&!info.isFile())||(info.isFile()&&info.nlink!==1))throw failure();
    }
    return true;
  }
  private async directoryReady(create:boolean):Promise<boolean>{
    this.assertOpen();
    try{
      const exists=await this.links(this.directory,true);
      if(!exists){if(!create)return false;await mkdir(this.directory,{mode:0o700});await this.acl.secureDirectory(this.directory);}
      await this.links(this.directory);await this.acl.verify([this.directory]);this.assertOpen();return true;
    }catch{this.assertOpen();throw failure();}
  }
  async has(name:string):Promise<boolean>{return (await this.get(name))!==null;}
  async get(name:string):Promise<string|null>{
    const file=this.file(name);
    return this.serialize(async()=>{
      this.assertOpen();if(!await this.directoryReady(false)||!await this.links(file,true))return null;
      let plain:Buffer|undefined;
      try{
        await this.acl.verify([this.directory,file]);
        const handle=await open(file,constants.O_RDONLY| (constants.O_NOFOLLOW??0));
        let bytes:Buffer;
        try{
          const stat=await handle.stat();if(!stat.isFile()||stat.nlink!==1||stat.size>MAX_FILE)throw failure();
          const bounded=Buffer.alloc(MAX_FILE+1),read=await handle.read(bounded,0,bounded.length,0);
          if(read.bytesRead>MAX_FILE)throw failure();bytes=bounded.subarray(0,read.bytesRead);
        }finally{await handle.close();}
        const envelope=JSON.parse(bytes.toString('utf8'));
        if(envelope.version!==1||envelope.name!==name||envelope.protection!=='windows-dpapi'||typeof envelope.ciphertext!=='string'||!envelope.ciphertext.length||!(/^[A-Za-z0-9+/]+={0,2}$/).test(envelope.ciphertext))throw failure();
        plain=await this.protector.unprotect(Buffer.from(envelope.ciphertext,'base64'),'Relay/credential/v1/'+name);
        if(!plain.length||plain.length>MAX_SECRET)throw failure();
        await this.links(file);await this.acl.verify([this.directory,file]);this.assertOpen();
        return plain.toString('utf8');
      }catch{this.assertOpen();throw failure();}finally{plain?.fill(0);}
    });
  }
  async set(name:string,value:string,check?:()=>void):Promise<void>{
    const file=this.file(name);
    if(typeof value!=='string'||!value.length||Buffer.byteLength(value,'utf8')>MAX_SECRET)throw Error('Invalid credential value.');
    return this.serialize(async()=>{
      this.assertOpen();await this.directoryReady(true);const plain=Buffer.from(value,'utf8');let cipher:Buffer;
      try{cipher=await this.protector.protect(plain,'Relay/credential/v1/'+name);}catch{throw failure();}finally{plain.fill(0);}
      this.assertOpen();check?.();
      const envelope=Buffer.from(JSON.stringify({version:1,name,protection:'windows-dpapi',ciphertext:cipher.toString('base64')}));cipher.fill(0);
      if(envelope.length>MAX_FILE)throw failure();
      const temporary=join(this.directory,'.'+randomUUID()+'.tmp');let created=false;
      try{
        await this.links(this.directory);await this.acl.verify([this.directory]);
        if(await this.links(file,true))await this.acl.verify([file]);
        const handle=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);created=true;
        try{await this.links(temporary);await this.acl.verify([this.directory,temporary]);await handle.writeFile(envelope);await handle.sync();}finally{await handle.close();}
        await this.links(this.directory);await this.links(temporary);await this.acl.verify([this.directory,temporary]);
        if(await this.links(file,true))await this.acl.verify([file]);
        this.assertOpen();check?.();await rename(temporary,file);created=false;
      }finally{envelope.fill(0);if(created)await unlink(temporary).catch(()=>{});}
    });
  }
  async remove(name:string):Promise<void>{
    const file=this.file(name);
    return this.serialize(async()=>{this.assertOpen();if(!await this.directoryReady(false)||!await this.links(file,true))return;await this.acl.verify([this.directory,file]);this.assertOpen();await unlink(file);});
  }
}
