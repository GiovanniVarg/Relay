import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import {createServer,createConnection,type Socket} from 'node:net';
import {resolve} from 'node:path';
const exec=promisify(execFile),windows=process.platform==='win32';
const ps=resolve(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
const helper=resolve('scripts/windows-tcp-listeners.ps1'),quote=(s:string)=>"'"+s.replaceAll("'","''")+"'";
test('managed user startup remains hidden and does not reopen a browser',async()=>{
 const source=await readFile('scripts/setup-relay.ps1','utf8');
 assert.match(source,/powershell\.exe -NoProfile -NonInteractive -WindowStyle Hidden -File/);
 assert.match(source,/Start-Relay\.ps1'\)\+'" -NoBrowser'/);
});
async function powershell(code:string){const result=await exec(ps,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from("$ErrorActionPreference='Stop';. "+quote(helper)+";"+code,'utf16le').toString('base64')],{windowsHide:true,timeout:30000,maxBuffer:1024*1024});return result.stdout.trim();}
test('native listener decoder uses verified DWORD layouts and refuses malformed/connected/bound snapshots',{skip:!windows},async()=>{
 const code=`
function Require($value,$message){if(-not $value){throw $message}}
Require ([RelayNativeTcpListeners]::IPv4RowSize -eq 24) 'IPv4 row size'
Require ([RelayNativeTcpListeners]::IPv6RowSize -eq 56) 'IPv6 row size'
Require ([RelayNativeTcpListeners]::IPv4TableOffset -eq 4) 'IPv4 offset'
Require ([RelayNativeTcpListeners]::IPv6TableOffset -eq 4) 'IPv6 offset'
function Snapshot([int]$state,[int]$owner=1234,[int]$remote=0){$b=New-Object byte[] 28;[BitConverter]::GetBytes([uint32]1).CopyTo($b,0);[BitConverter]::GetBytes([uint32]$state).CopyTo($b,4);[BitConverter]::GetBytes([uint32]16777343).CopyTo($b,8);[BitConverter]::GetBytes([uint32]35340).CopyTo($b,12);[BitConverter]::GetBytes([uint32]$remote).CopyTo($b,20);[BitConverter]::GetBytes([uint32]$owner).CopyTo($b,24);return ,$b}
$rows=[RelayNativeTcpListeners]::Decode((Snapshot 0),28,2,3210)
Require ($rows.Count -eq 1 -and $rows[0].LocalPort -eq 3210 -and $rows[0].LocalAddress -eq '127.0.0.1' -and $rows[0].OwningProcess -eq 1234 -and $rows[0].RawState -eq 0 -and $rows[0].TableClass -eq 3) 'Category metadata'
Require (([RelayNativeTcpListeners]::Decode((Snapshot 2),28,2,3210)).Count -eq 1) 'Normal listen state'
Require (([RelayNativeTcpListeners]::Decode((Snapshot 0 1234 99),28,2,3210)).Count -eq 1) 'Listener remote fields are undefined, not a classification source'
foreach($b in @((New-Object byte[] 3),(Snapshot 5),(Snapshot 100),(Snapshot 0 0))){$failed=$false;try{[RelayNativeTcpListeners]::Decode($b,$b.Length,2,3210)|Out-Null}catch{$failed=$true};Require $failed 'Malformed native snapshot accepted'}
$b=Snapshot 0;[BitConverter]::GetBytes([uint32]4294967295).CopyTo($b,0);$failed=$false;try{[RelayNativeTcpListeners]::Decode($b,28,2,3210)|Out-Null}catch{$failed=$true};Require $failed 'Count overflow accepted'
'PASS'
`;
 assert.equal(await powershell(code),'PASS');
});
test('listener-only native query includes real IPv4/IPv6 listener and excludes connected-only endpoints',{skip:!windows,timeout:60000},async()=>{
 for(const host of ['127.0.0.1','::1']){
  const sockets:Socket[]=[];const server=createServer(socket=>sockets.push(socket));await new Promise<void>((done,reject)=>{server.once('error',reject);server.listen(0,host,()=>done());});let client:Socket|undefined;
  try{const port=(server.address() as {port:number}).port;const rows=JSON.parse(await powershell('ConvertTo-Json -Depth 4 -Compress -InputObject @(Get-RelayTcpListeners -Port '+port+')')) as {OwningProcess:number;LocalAddress:string;LocalPort:number;TableClass:number}[];
   assert.equal(rows.length,1);assert.equal(rows[0].OwningProcess,process.pid);assert.equal(rows[0].LocalAddress,host);assert.equal(rows[0].LocalPort,port);assert.equal(rows[0].TableClass,3);
   client=createConnection({host,port});await new Promise<void>((done,reject)=>{client!.once('connect',done);client!.once('error',reject);});
   const clientPort=client.localPort!;const connected=JSON.parse(await powershell('ConvertTo-Json -Compress -InputObject @(Get-RelayTcpListeners -Port '+clientPort+')'));assert.deepEqual(connected,[],'Connected-only client endpoint must not enter listener category');
  }finally{client?.destroy();sockets.forEach(s=>s.destroy());await new Promise<void>(done=>server.close(()=>done()));}
 }
});
test('bound but unlistening native socket is excluded from listener category',{skip:!windows},async()=>{
 assert.equal(await powershell("$s=New-Object Net.Sockets.Socket([Net.Sockets.AddressFamily]::InterNetwork,[Net.Sockets.SocketType]::Stream,[Net.Sockets.ProtocolType]::Tcp);try{$s.Bind((New-Object Net.IPEndPoint([Net.IPAddress]::Loopback,0)));$p=$s.LocalEndPoint.Port;if(@(Get-RelayTcpListeners -Port $p).Count){throw 'Bound socket classified as listener'};'PASS'}finally{$s.Dispose()}"),'PASS');
});
test('shared native query fixes both families/class and never treats all-table unknown state as listener',async()=>{
 const source=await readFile(helper,'utf8');assert.match(source,/GetExtendedTcpTable/);assert.match(source,/ListenerTableClass\s*=\s*3/);assert.match(source,/ReadFamily\(2/);assert.match(source,/ReadFamily\(23/);assert.doesNotMatch(source,/Get-NetTCPConnection|State\s*-eq\s*0/);
});
