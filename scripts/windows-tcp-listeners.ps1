# Native listener CATEGORY, not a State=0 fallback. This script has no process-control operations.
# GetExtendedTcpTable's fixed OWNER_PID_LISTENER query supplies the listening classification.
if (-not ('RelayNativeTcpListeners' -as [type])) {
 Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Net;
using System.Runtime.InteropServices;

public static class RelayNativeTcpListeners {
 public const int ListenerTableClass = 3;
 const int MaximumBytes = 4 * 1024 * 1024;
 const int MaximumRows = 65536;
 [StructLayout(LayoutKind.Sequential, Pack=4)]
 struct Row4 { public uint State, LocalAddress, LocalPort, RemoteAddress, RemotePort, Pid; }
 [StructLayout(LayoutKind.Sequential, Pack=4)]
 struct Row6 {
  [MarshalAs(UnmanagedType.ByValArray, SizeConst=16)] public byte[] LocalAddress;
  public uint LocalScope, LocalPort;
  [MarshalAs(UnmanagedType.ByValArray, SizeConst=16)] public byte[] RemoteAddress;
  public uint RemoteScope, RemotePort, State, Pid;
 }
 [StructLayout(LayoutKind.Sequential, Pack=4)] struct Table4 { public uint Count; public Row4 First; }
 [StructLayout(LayoutKind.Sequential, Pack=4)] struct Table6 { public uint Count; public Row6 First; }
 public static readonly int IPv4RowSize = Marshal.SizeOf(typeof(Row4));
 public static readonly int IPv6RowSize = Marshal.SizeOf(typeof(Row6));
 public static readonly int IPv4TableOffset = Marshal.OffsetOf(typeof(Table4), "First").ToInt32();
 public static readonly int IPv6TableOffset = Marshal.OffsetOf(typeof(Table6), "First").ToInt32();
 [DllImport("iphlpapi.dll", SetLastError=true)]
 static extern uint GetExtendedTcpTable(IntPtr table, ref uint size, bool order, int family, int tableClass, uint reserved);
 public sealed class Listener {
  public int Family, TableClass, LocalPort;
  public string LocalAddress;
  public uint ScopeId, RawState, OwningProcess;
 }
 static void Layout() {
  if (IPv4RowSize!=24 || IPv6RowSize!=56 || IPv4TableOffset!=4 || IPv6TableOffset!=4 ||
      Marshal.OffsetOf(typeof(Row4),"Pid").ToInt32()!=20 || Marshal.OffsetOf(typeof(Row6),"State").ToInt32()!=48 ||
      Marshal.OffsetOf(typeof(Row6),"Pid").ToInt32()!=52) throw new InvalidOperationException("Unexpected native TCP layout");
 }
 static int Port(uint value) { return (int)(((value & 255) << 8) | ((value >> 8) & 255)); }
 static bool Zero(byte[] value) { foreach(byte b in value) if(b!=0) return false; return true; }
 public static Listener[] Decode(byte[] bytes, int length, int family, int port) {
  Layout();
  if (port<1 || port>65535 || (family!=2 && family!=23) || bytes==null || length<4 ||
      length>bytes.Length || length>MaximumBytes) throw new InvalidOperationException("Invalid native TCP snapshot");
  uint count=BitConverter.ToUInt32(bytes,0);
  int stride=family==2?IPv4RowSize:IPv6RowSize, offset=family==2?IPv4TableOffset:IPv6TableOffset;
  if(count>MaximumRows || (long)offset+(long)count*stride>length) throw new InvalidOperationException("Truncated native TCP table");
  List<Listener> result=new List<Listener>(); HashSet<string> seen=new HashSet<string>();
  IntPtr memory=Marshal.AllocHGlobal(length);
  try {
   Marshal.Copy(bytes,0,memory,length);
   for(uint i=0;i<count;i++){
    IntPtr row=IntPtr.Add(memory,checked(offset+(int)i*stride));
    uint localPort,remotePort,pid,state,scope=0; string address; bool remoteZero;
    if(family==2){
     Row4 r=(Row4)Marshal.PtrToStructure(row,typeof(Row4));
     localPort=r.LocalPort;remotePort=r.RemotePort;pid=r.Pid;state=r.State;
     address=new IPAddress(BitConverter.GetBytes(r.LocalAddress)).ToString();remoteZero=r.RemoteAddress==0;
    }else{
     Row6 r=(Row6)Marshal.PtrToStructure(row,typeof(Row6));
     localPort=r.LocalPort;remotePort=r.RemotePort;pid=r.Pid;state=r.State;scope=r.LocalScope;
     address=new IPAddress(r.LocalAddress,(long)scope).ToString();remoteZero=Zero(r.RemoteAddress)&&r.RemoteScope==0;
    }
    if(Port(localPort)!=port)continue;
    // Known connected/bound states contradict the listener-only category; remote fields are undefined.
    // Unknown raw state zero is retained as data; it cannot classify an ALL-table row.
    if((localPort & 0xffff0000U)!=0 || pid==0 || pid>Int32.MaxValue ||
       (state!=0 && state!=2)) throw new InvalidOperationException("Contradictory listener-only native row");
    string key=family+"|"+address+"|"+scope+"|"+port;
    if(!seen.Add(key))throw new InvalidOperationException("Duplicate native listener endpoint");
    result.Add(new Listener{Family=family,TableClass=ListenerTableClass,LocalPort=port,LocalAddress=address,
      ScopeId=scope,RawState=state,OwningProcess=pid});
   }
  }finally{Marshal.FreeHGlobal(memory);}
  return result.ToArray();
 }
 static Listener[] ReadFamily(int family,int port) {
  Layout();uint required=0;
  uint status=GetExtendedTcpTable(IntPtr.Zero,ref required,false,family,ListenerTableClass,0);
  if(status!=122)throw new InvalidOperationException("Native TCP size query failed: "+status);
  for(int attempt=0;attempt<3;attempt++){
   if(required<4 || required>MaximumBytes)throw new InvalidOperationException("Native TCP table size exceeds bounds");
   uint allocated=required;IntPtr memory=Marshal.AllocHGlobal((int)allocated);
   try {
    status=GetExtendedTcpTable(memory,ref required,false,family,ListenerTableClass,0);
    if(status==122)continue;
    if(status!=0 || required<4 || required>allocated)throw new InvalidOperationException("Native TCP table query failed: "+status);
    byte[] bytes=new byte[required];Marshal.Copy(memory,bytes,0,(int)required);
    return Decode(bytes,(int)required,family,port);
   }finally{Marshal.FreeHGlobal(memory);}
  }
  throw new InvalidOperationException("Native TCP table kept changing");
 }
 public static Listener[] Read(int port) {
  if(port<1 || port>65535)throw new ArgumentOutOfRangeException("port");
  List<Listener> rows=new List<Listener>();
  rows.AddRange(ReadFamily(2,port));rows.AddRange(ReadFamily(23,port));return rows.ToArray();
 }
}
'@
}
function Get-RelayTcpListeners {
 param([Parameter(Mandatory=$true)][ValidateRange(1,65535)][int]$Port)
 [RelayNativeTcpListeners]::Read($Port)
}
# RELAY_RECOVERY_FUNCTIONS
# Recovery is a separately authorized operator operation. No descriptor is cleared.
function Get-RelayListenerRecoveryProof {
 param([string]$Receipt,[string]$ReceiptSha256,[string]$AppRoot,[string]$DataRoot,[int]$Port,[string]$NodePath)
 $validator=@'
const fs=require('node:fs'),p=require('node:path'),c=require('node:crypto');
const [receiptPath,pin,app,data,portText,node]=process.argv.slice(1),port=Number(portText),sha=b=>c.createHash('sha256').update(b).digest('hex'),same=(a,b)=>typeof a==='string'&&typeof b==='string'&&p.resolve(a).toLowerCase()===p.resolve(b).toLowerCase(),need=(ok,m)=>{if(!ok)throw Error(m);},hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
function ordinary(file,directory=false){for(let q=p.resolve(file);;q=p.dirname(q)){const s=fs.lstatSync(q);need(!s.isSymbolicLink()&&(!s.isFile()||s.nlink===1),'Linked recovery path');if(q===p.dirname(q))break;}const s=fs.lstatSync(file);need(directory?s.isDirectory():s.isFile(),'Unexpected recovery path type');return s;}
function read(file,max=20000000){const s=ordinary(file);need(s.size<=max,'Recovery input too large');return fs.readFileSync(file);}
function keys(value,allowed){need(value&&typeof value==='object'&&!Array.isArray(value),'Invalid recovery object');need(Object.keys(value).every(k=>allowed.includes(k)),'Unknown recovery field');}
need(hex(pin)&&Number.isInteger(port)&&port>0&&port<65536,'Invalid recovery invocation');
const receiptBytes=read(receiptPath,524288);need(sha(receiptBytes)===pin,'Recovery receipt SHA mismatch');const r=JSON.parse(receiptBytes);
keys(r,['version','kind','id','createdAt','appRoot','dataRoot','port','originalJobId','originalJobSha256','originalStatusSha256','beforeCatalogSha256','afterCatalogSha256','afterCatalog','priorStateSha256','orphan','files']);
need(r.version===1&&r.kind==='relay-listener-recovery'&&/^[a-f0-9-]{36}$/.test(r.id)&&Number.isFinite(Date.parse(r.createdAt))&&same(r.appRoot,app)&&same(r.dataRoot,data)&&r.port===port,'Recovery invocation mismatch');
const directory=p.join(data,'recovery',r.id);need(same(receiptPath,p.join(directory,'bootstrap.json')),'Recovery receipt escaped its fixed directory');ordinary(directory,true);
const statePath=p.join(data,'supervisor',String(port),'state.json'),priorBytes=read(statePath,65536);need(hex(r.priorStateSha256)&&sha(priorBytes)===r.priorStateSha256,'Prior supervisor changed');const prior=JSON.parse(priorBytes);
need(prior.version===1&&prior.phase==='recovery_required'&&!prior.child&&prior.reason==='Relay readiness could not be proven: Listener ownership mismatch; no process was stopped'&&same(prior.appRoot,app)&&same(prior.dataRoot,data)&&prior.port===port&&/^[a-f0-9-]{36}$/.test(prior.sessionId),'Not a known owned listener-readiness failure');
need(Number.isSafeInteger(prior.hostPid)&&prior.hostPid>0&&Number.isFinite(Date.parse(prior.hostStartedAt))&&Number.isFinite(Date.parse(prior.updatedAt))&&Date.parse(prior.updatedAt)>=Date.parse(prior.hostStartedAt),'Invalid prior host generation');
need(/^[a-f0-9-]{36}$/.test(r.originalJobId)&&hex(r.originalJobSha256)&&hex(r.originalStatusSha256),'Invalid original job binding');
const jobDirectory=p.join(data,'self-update','jobs',r.originalJobId),jobBytes=read(p.join(jobDirectory,'job.json')),statusBytes=read(p.join(jobDirectory,'status.json'));
need(sha(jobBytes)===r.originalJobSha256&&sha(statusBytes)===r.originalStatusSha256,'Original completed job changed');const job=JSON.parse(jobBytes),status=JSON.parse(statusBytes),saved=prior.installationProof;
need(job.id===r.originalJobId&&same(job.installDirectory,app)&&same(job.dataDirectory,data)&&job.port===port&&status.jobId===job.id&&status.changeId===job.changeId&&status.status==='complete'&&status.dataPreserved===true&&!status.recoveryRequired&&!status.error,'Installation is not a completed trusted job');
need(read(p.join(data,'self-update','latest'),128).toString()===job.id&&same(job.holdPath,p.join(jobDirectory,'startup.hold'))&&same(job.statusPath,p.join(jobDirectory,'status.json'))&&!fs.existsSync(job.holdPath)&&read(job.holdPath+'.released',128).toString()===job.nonce,'Update is held or a different job is published');
need(saved&&saved.version===1&&saved.jobId===job.id&&saved.jobHash===r.originalJobSha256&&saved.nonce===job.nonce&&saved.status==='complete'&&saved.receiptPid===status.newPid,'Prior installation proof does not bind the complete job');
const replacementKeys=['pid','startedAt','executable','command','serverPath','dataDirectoryId','instanceId'];
need(saved.replacement&&status.replacement&&replacementKeys.every(k=>saved.replacement[k]===status.replacement[k]),'Original replacement proof changed');
need(hex(r.beforeCatalogSha256)&&r.beforeCatalogSha256===job.revision&&Array.isArray(job.sourceFiles)&&sha(JSON.stringify(job.sourceFiles))===r.beforeCatalogSha256,'Original source catalog mismatch');
const roots=['client','docs','scripts','server','shared','tests'],rootFiles=['.gitignore','package.json','package-lock.json','README.md','Setup Relay.cmd','Start Relay.cmd','Start-Relay.ps1','tsconfig.json','tsconfig.server.json','vite.config.ts'],allowed=['Start-Relay.ps1','scripts/serve-relay.ps1','scripts/activate-relay.mjs','scripts/windows-tcp-listeners.ps1'];
function validPath(value){need(typeof value==='string'&&value.length<=500&&!value.includes('\\')&&!value.includes(':')&&!value.split('/').some(k=>!k||k==='..'||k==='.'||k.startsWith('.')&&value!=='.gitignore'||['node_modules','dist'].includes(k))&&(value.includes('/')?roots.includes(value.split('/')[0]):rootFiles.includes(value)),'Invalid recovery source path');return value;}
function catalog(rows){need(Array.isArray(rows)&&rows.length>0&&rows.length<=5000,'Invalid recovery catalog');const seen=new Set();let total=0;for(const f of rows){keys(f,['path','hash','size']);validPath(f.path);need(!seen.has(f.path.toLowerCase())&&hex(f.hash)&&Number.isSafeInteger(f.size)&&f.size>=0&&f.size<=200000,'Invalid or duplicate catalog row');seen.add(f.path.toLowerCase());total+=f.size;}need(total<=20000000,'Recovery catalog exceeds bounds');return rows;}
catalog(job.sourceFiles);catalog(r.afterCatalog);need(r.files?.length===4&&new Set(r.files.map(f=>f.path)).size===4&&r.files.every(f=>allowed.includes(f.path)),'Bootstrap changes are not the exact four allowed scripts');
const expected=new Map(job.sourceFiles.map(f=>[f.path,{...f}]));
for(const f of r.files){keys(f,['path','before','after']);const before=expected.get(f.path);keys(f.after,['hash','size']);need(hex(f.after.hash)&&Number.isSafeInteger(f.after.size)&&f.after.size>0&&f.after.size<=200000,'Invalid bootstrap after row');if(before){keys(f.before,['hash','size']);need(f.before.hash===before.hash&&f.before.size===before.size&&f.before.hash!==f.after.hash,'Bootstrap before hash mismatch');}else need(f.before===null&&f.path==='scripts/windows-tcp-listeners.ps1','Unexpected added bootstrap file');expected.set(f.path,{path:f.path,hash:f.after.hash,size:f.after.size});}
const rebuilt=[...expected.values()].sort((a,b)=>a.path.localeCompare(b.path));need(JSON.stringify(rebuilt)===JSON.stringify(r.afterCatalog)&&hex(r.afterCatalogSha256)&&sha(JSON.stringify(rebuilt))===r.afterCatalogSha256,'Bootstrap catalog is not derived from original source plus four deltas');
const actual=[];function walk(dir,prefix){ordinary(dir,true);for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(e.name.startsWith('.')||['node_modules','dist'].includes(e.name)||/\.(sqlite|db|pem|key|pfx|p12|crt|cer|log|zip|exe|dll)$/i.test(e.name))continue;const rel=prefix+'/'+e.name,file=p.join(dir,e.name);if(e.isDirectory())walk(file,rel);else{const b=read(file,200000);actual.push({path:validPath(rel),hash:sha(b),size:b.length});}}}
for(const d of roots)if(fs.existsSync(p.join(app,d)))walk(p.join(app,d),d);for(const q of rootFiles)if(fs.existsSync(p.join(app,q))){const b=read(p.join(app,q),200000);actual.push({path:q,hash:sha(b),size:b.length});}actual.sort((a,b)=>a.path.localeCompare(b.path));need(JSON.stringify(actual)===JSON.stringify(rebuilt),'Installed source differs from reviewed bootstrap');
keys(r.orphan,['pid','startedAt','parentPid','executable','command','instanceId','dataDirectoryId']);const o=r.orphan,dataId=sha(Buffer.from(p.resolve(data).toLowerCase()));
need(Number.isSafeInteger(o.pid)&&o.pid>0&&o.pid!==status.newPid&&o.parentPid===prior.hostPid&&same(o.executable,node)&&o.dataDirectoryId===dataId&&/^[a-f0-9-]{36}$/.test(o.instanceId)&&Number.isFinite(Date.parse(o.startedAt))&&Date.parse(o.startedAt)>Date.parse(prior.hostStartedAt)&&Date.parse(o.startedAt)<=Date.parse(prior.updatedAt),'Orphan does not belong to failed host generation');
console.log(Buffer.from(JSON.stringify({id:r.id,receiptPath:p.resolve(receiptPath),receiptSha256:pin,directory,priorStatePath:statePath,priorStateSha256:r.priorStateSha256,priorState:prior,orphan:o,oldReceiptPid:status.newPid,jobId:job.id,jobHash:r.originalJobSha256,afterCatalogSha256:r.afterCatalogSha256}),'utf8').toString('base64'));
'@
 $readProof={ $json=& $NodePath --no-warnings -e $validator -- $Receipt $ReceiptSha256 $AppRoot $DataRoot ([string]$Port) $NodePath; if($LASTEXITCODE -ne 0){throw 'Recovery receipt/source validation failed; prior state preserved'};return ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(($json -join '').Trim()))|ConvertFrom-Json) }
 $proof=& $readProof
 $state=$proof.priorState;$orphan=$proof.orphan
 $hostExecutable=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
 if($state.hostExecutable -ine $hostExecutable -or (Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$state.hostPid)) -or (Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$proof.oldReceiptPid))){throw 'Prior host or original replacement is not proven absent'}
 $escape={param($s) $escaped=[regex]::Escape($s);if($s -match '\s'){return ('"'+$escaped+'"')};return ('(?:"'+$escaped+'"|'+$escaped+')')}
 $serverPath=Join-Path $AppRoot 'dist\server\index.js'
 $expected='^\s*'+(& $escape $NodePath)+'\s+--no-warnings\s+'+(& $escape $serverPath)+'\s*$'
 $hostPattern='^\s*'+(& $escape $hostExecutable)+'\s+-NoProfile\s+-NonInteractive\s+-WindowStyle\s+Hidden\s+-File\s+'+(& $escape (Join-Path $AppRoot 'scripts\serve-relay.ps1'))+'\s+-Configuration\s+([A-Za-z0-9+/=]+)\s*$'
 if(-not [regex]::IsMatch($state.hostCommandLine,$hostPattern,[Text.RegularExpressions.RegexOptions]::IgnoreCase)){throw 'Prior failed host launcher grammar is foreign'}
 $hostMatch=[regex]::Match($state.hostCommandLine,$hostPattern,[Text.RegularExpressions.RegexOptions]::IgnoreCase)
 $oldConfig=([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($hostMatch.Groups[1].Value))|ConvertFrom-Json)
 if($oldConfig.appRoot -ine $AppRoot -or $oldConfig.dataRoot -ine $DataRoot -or $oldConfig.port -ne $Port -or $oldConfig.nodePath -ine $NodePath){throw 'Prior failed host configuration is foreign'}
 $samples=@()
 foreach($sample in 1..2){
  $native=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$orphan.pid)
  if(-not $native -or $native.ExecutablePath -ine $NodePath -or $native.CommandLine -cne $orphan.command -or -not [regex]::IsMatch($native.CommandLine,$expected,[Text.RegularExpressions.RegexOptions]::IgnoreCase) -or $native.CreationDate.ToUniversalTime().ToString('o') -cne $orphan.startedAt -or $native.ParentProcessId -ne $state.hostPid){throw 'Orphan native generation is not the exact failed host child'}
  $listeners=@(Get-RelayTcpListeners -Port $Port)
  if(-not $listeners.Count -or @($listeners|Where-Object{$_.OwningProcess -ne $orphan.pid -or $_.LocalAddress -notin @('127.0.0.1','::1')}).Count){throw 'Orphan listener category ownership is not exclusive loopback'}
  $health=Invoke-RestMethod -Uri ('http://127.0.0.1:'+$Port+'/api/health') -TimeoutSec 2
  if($health.ok -ne $true -or $health.service -ne 'relay' -or $health.pid -ne $orphan.pid -or $health.instanceId -cne $orphan.instanceId -or $health.dataDirectoryId -cne $orphan.dataDirectoryId -or $health.updateHeld -ne $false -or $null -ne $health.updateNonce){throw 'Orphan health does not match released normal process generation'}
  $samples+=(@{pid=$native.ProcessId;startedAt=$native.CreationDate.ToUniversalTime().ToString('o');command=$native.CommandLine;instanceId=$health.instanceId;dataId=$health.dataDirectoryId}|ConvertTo-Json -Compress)
 }
 if($samples[0] -cne $samples[1] -or ((& $readProof)|ConvertTo-Json -Depth 20 -Compress) -cne ($proof|ConvertTo-Json -Depth 20 -Compress)){throw 'Recovery proof changed between scans'}
 return $proof
}
function Save-RelayListenerRecoveryAudit {
 param($Proof,[string]$SessionId,[int]$HostPid)
 # Create-only durable evidence must precede any replacement supervisor descriptor.
 $bytes=[IO.File]::ReadAllBytes($Proof.priorStatePath);$hash=[Security.Cryptography.SHA256]::Create()
 try{$actual=([BitConverter]::ToString($hash.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}
 if($actual -cne $Proof.priorStateSha256){throw 'Prior state changed before recovery audit'}
 foreach($name in @('recovery-prior-state.json','recovery-adoption.json')){if(Test-Path -LiteralPath (Join-Path $Proof.directory $name)){throw 'Recovery evidence already exists; inspect without replay'}}
 $prior=[IO.File]::Open((Join-Path $Proof.directory 'recovery-prior-state.json'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$prior.Write($bytes,0,$bytes.Length);$prior.Flush($true)}finally{$prior.Dispose()}
 $audit=@{version=1;at=[DateTime]::UtcNow.ToString('o');receiptSha256=$Proof.receiptSha256;priorStateSha256=$Proof.priorStateSha256;originalJobId=$Proof.jobId;originalJobHash=$Proof.jobHash;installedCatalogSha256=$Proof.afterCatalogSha256;newSessionId=$SessionId;newHostPid=$HostPid;adoptedPid=$Proof.orphan.pid;adoptedStartedAt=$Proof.orphan.startedAt;adoptedInstanceId=$Proof.orphan.instanceId;activationReplayed=$false}
 $text=[Text.Encoding]::UTF8.GetBytes(($audit|ConvertTo-Json -Depth 6 -Compress))
 $stream=[IO.File]::Open((Join-Path $Proof.directory 'recovery-adoption.json'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$stream.Write($text,0,$text.Length);$stream.Flush($true)}finally{$stream.Dispose()}
}
