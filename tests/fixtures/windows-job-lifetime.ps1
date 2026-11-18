$ErrorActionPreference='Stop'
$root=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$fixture=Join-Path $env:TEMP ('relay-launcher-job-'+[Guid]::NewGuid().ToString('N'))
$appRoot=Join-Path $fixture 'install résumé İ';$fixedData=Join-Path $fixture 'fixed'
New-Item -ItemType Directory -Path $fixture,(Join-Path $appRoot 'dist\server'),(Join-Path $appRoot 'scripts'),(Join-Path $fixture 'baseline'),$fixedData -Force|Out-Null
'{"type":"commonjs"}'|Set-Content -LiteralPath (Join-Path $appRoot 'package.json') -Encoding ASCII
foreach($file in @('Start-Relay.ps1','scripts\serve-relay.ps1','scripts\activate-relay.mjs','scripts\windows-tcp-listeners.ps1')){Copy-Item -LiteralPath (Join-Path $root $file) -Destination (Join-Path $appRoot $file)}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'windows-job-server.cjs') -Destination (Join-Path $appRoot 'dist\server\index.js')
$node=(Get-Command node.exe).Source;$ps=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class JobProof {
[StructLayout(LayoutKind.Sequential)] public struct SI {public int cb; public string reserved,desktop,title; public int x,y,xs,ys,xc,yc,fill,flags;public short show,res2;public IntPtr reserved2,input,output,error;}
[StructLayout(LayoutKind.Sequential)] public struct PI {public IntPtr process,thread; public int pid,tid;}
[StructLayout(LayoutKind.Sequential)] public struct Basic {public long procTime,jobTime; public uint flags;public UIntPtr min,max;public uint active;public UIntPtr affinity;public uint priority,scheduling;}
[StructLayout(LayoutKind.Sequential)] public struct IO {public ulong r,w,o,rb,wb,ob;}
[StructLayout(LayoutKind.Sequential)] public struct Extended {public Basic basic;public IO io;public UIntPtr processMemory,jobMemory,peakProcess,peakJob;}
[DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a,string b);
[DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j,int c,ref Extended i,uint n);
[DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string a,string cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref SI si,out PI pi);
[DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);
[DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr t);
[DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
[DllImport("kernel32.dll")] public static extern bool IsProcessInJob(IntPtr p,IntPtr j,out bool result);
public static IntPtr Launch(string app,string cmd,string cwd,out int pid) {var j=CreateJobObject(IntPtr.Zero,null);var info=new Extended(); info.basic.flags=0x2000;if(!SetInformationJobObject(j,9,ref info,(uint)Marshal.SizeOf(info)))throw new Exception("Set job "+Marshal.GetLastWin32Error()); var si=new SI();si.cb=Marshal.SizeOf(si);PI pi; if(!CreateProcess(app,cmd,IntPtr.Zero,IntPtr.Zero,false,0x08000004,IntPtr.Zero,cwd,ref si,out pi))throw new Exception("Create "+Marshal.GetLastWin32Error());if(!AssignProcessToJobObject(j,pi.process))throw new Exception("Assign "+Marshal.GetLastWin32Error());ResumeThread(pi.thread);CloseHandle(pi.thread);CloseHandle(pi.process);pid=pi.pid;return j;}
}
"@

& $node --no-warnings (Join-Path $PSScriptRoot 'windows-job-seed.mjs') $fixedData
if($LASTEXITCODE -ne 0){throw 'Fixture database seed failed'}
function Wait-Health([int]$port){for($i=0;$i -lt 200;$i++){try{return Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 1}catch{Start-Sleep -Milliseconds 200}};throw "No fixture health on $port"}
function Free-Port {$listener=New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,0);$listener.Start();$value=$listener.LocalEndpoint.Port;$listener.Stop();return $value}
function Process-Info([int]$processId){$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$processId);if(-not $p){return $null};$sid=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid;return @{pid=$processId;sessionId=$p.SessionId;sid=$sid.Sid;parentId=$p.ParentProcessId}}
function State-Value {$stream=[IO.File]::Open((Join-Path $fixedData ('supervisor\'+$port+'\state.json')),[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete));try{$reader=New-Object IO.StreamReader($stream,[Text.Encoding]::UTF8,$true);try{return ($reader.ReadToEnd()|ConvertFrom-Json)}finally{$reader.Dispose()}}finally{$stream.Dispose()}}
function Mutex-Owned {$m=New-Object Threading.Mutex($false,('Local\Relay-Server-Port-'+$port));$got=$false;try{try{$got=$m.WaitOne(0)}catch [Threading.AbandonedMutexException]{$got=$true};return (-not $got)}finally{if($got){$m.ReleaseMutex()};$m.Dispose()}}
$oldData=$env:RELAY_DATA_DIR;$oldPort=$env:PORT;$jobs=@();$owned=@();$report=@{fixture=$fixture;interactive=Process-Info $PID}
try{
 $port=Free-Port;$env:PORT=[string]$port;$env:RELAY_DATA_DIR=Join-Path $fixture 'baseline';$controllerPid=0
 $job=[JobProof]::Launch($node,('"'+$node+'" "'+(Join-Path $appRoot 'dist\server\index.js')+'" --controller'),$appRoot,[ref]$controllerPid);$jobs+=$job
 $before=Wait-Health $port;$baselinePid=[int]$before.pid;$owned+=$baselinePid
 $report.baseline=@{pid=$baselinePid;healthyBefore=$true;controller=Process-Info $controllerPid;node=Process-Info $baselinePid}
 [JobProof]::CloseHandle($job)|Out-Null;$jobs=@();Start-Sleep -Milliseconds 700
 $report.baseline.healthyAfter=$false;try{$null=Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 1;$report.baseline.healthyAfter=$true}catch{}
 if($report.baseline.healthyAfter){throw 'Baseline survived caller job closure unexpectedly'}
 $port=Free-Port;$env:PORT=[string]$port;$env:RELAY_DATA_DIR=$fixedData;$launcherPid=0
 $command='"'+$ps+'" -NoProfile -NonInteractive -WindowStyle Hidden -File "'+(Join-Path $appRoot 'Start-Relay.ps1')+'" -NoBrowser -LocalInstall -Port '+$port
 $job=[JobProof]::Launch($ps,$command,$appRoot,[ref]$launcherPid);$jobs+=$job
 $before=Wait-Health $port;$fixedPid=[int]$before.pid;$owned+=$fixedPid;$nodeInfo=Process-Info $fixedPid;$hostPid=[int]$nodeInfo.parentId;$owned+=$hostPid
 $report.fixed=@{pid=$fixedPid;healthyBefore=$true;node=$nodeInfo;host=Process-Info $hostPid}
 [JobProof]::CloseHandle($job)|Out-Null;$jobs=@();Start-Sleep -Seconds 2
 $after=Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 2
 $report.fixed.samePidAfter=([int]$after.pid -eq $fixedPid);$report.fixed.healthyAfter=$true;$report.fixed.sameUser=($nodeInfo.sid -eq $report.interactive.sid);$report.fixed.sameSession=($nodeInfo.sessionId -eq $report.interactive.sessionId)
 if(-not $report.fixed.samePidAfter -or -not $report.fixed.sameUser -or -not $report.fixed.sameSession){throw 'Independent host identity/session/lifetime assertion failed'}
 for($wait=0;$wait -lt 150;$wait++){try{$state=State-Value;if($state.phase -eq 'monitoring' -and $state.child.pid -eq $fixedPid){break}}catch{};Start-Sleep -Milliseconds 200}
 $initialSession=$state.sessionId;$handoff=Invoke-RestMethod -Uri "http://127.0.0.1:$port/handoff" -TimeoutSec 60
 $replacement=$null
 for($wait=0;$wait -lt 300;$wait++){try{$state=State-Value;$candidate=Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 1;if($state.phase -eq 'monitoring' -and $state.child.pid -eq $candidate.pid -and $candidate.pid -ne $fixedPid -and $candidate.updateHeld -eq $false){$replacement=$candidate;break};if($state.phase -eq 'recovery_required'){throw $state.reason}}catch{};Start-Sleep -Milliseconds 200}
 if(-not $replacement){throw 'Trusted replacement did not become adopted by the original host'}
 $owned+=[int]$replacement.pid;$replacementInfo=Process-Info ([int]$replacement.pid)
 $report.handoff=@{pid=[int]$replacement.pid;jobId=$handoff.jobId;healthy=$true;differentPid=([int]$replacement.pid -ne $fixedPid);originalNodeExited=(-not(Get-Process -Id $fixedPid -ErrorAction SilentlyContinue));originalHostExited=(-not(Get-Process -Id $hostPid -ErrorAction SilentlyContinue));sameHost=($state.hostPid -eq $hostPid -and $state.sessionId -eq $initialSession);mutexOwned=(Mutex-Owned);adopted=($state.child.pid -eq $replacement.pid);sameUser=($replacementInfo.sid -eq $report.interactive.sid);sameSession=($replacementInfo.sessionId -eq $report.interactive.sessionId)}
 if(-not $report.handoff.differentPid -or -not $report.handoff.originalNodeExited -or $report.handoff.originalHostExited -or -not $report.handoff.sameHost -or -not $report.handoff.mutexOwned -or -not $report.handoff.adopted -or -not $report.handoff.sameUser -or -not $report.handoff.sameSession){throw 'Persistent original-host trusted handoff assertion failed'}
 & (Join-Path $appRoot 'Start-Relay.ps1') -NoBrowser -LocalInstall -Port $port -Stop
 if($LASTEXITCODE -ne 0){throw 'Owned intentional stop failed'}
 Start-Sleep -Milliseconds 1500;$state=State-Value;$report.intentionalStop=@{phase=$state.phase;mutexReleased=(-not(Mutex-Owned));nodeExited=(-not(Get-Process -Id ([int]$replacement.pid) -ErrorAction SilentlyContinue))}
 if($state.phase -ne 'stopped' -or -not $report.intentionalStop.mutexReleased -or -not $report.intentionalStop.nodeExited){throw 'Intentional stop did not finish the owned generation'}
 $report.passed=$true
}finally{
 foreach($j in $jobs){[JobProof]::CloseHandle($j)|Out-Null}
 foreach($file in @('fixture-node.pid','fixture-helper.pid')){try{$owned+=[int][IO.File]::ReadAllText((Join-Path $fixedData $file))}catch{}}
 foreach($processId in ($owned|Select-Object -Unique)){$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$processId);if($p -and $p.CommandLine.Contains((Split-Path $fixture -Leaf))){$ownedProcess=Get-Process -Id $processId -ErrorAction SilentlyContinue;Stop-Process -Id $processId -ErrorAction SilentlyContinue;if($ownedProcess){$ownedProcess.WaitForExit(5000)|Out-Null}}}
 $env:RELAY_DATA_DIR=$oldData;$env:PORT=$oldPort;$report.cleanup=@{ownedPids=@($owned);remaining=@($owned|Where-Object{Get-Process -Id $_ -ErrorAction SilentlyContinue})}
 $report|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $fixture 'report.json') -Encoding UTF8
 if($report.cleanup.remaining.Count){throw 'Fixture process cleanup failed'};Write-Output ('REPORT '+(Join-Path $fixture 'report.json'));$report|ConvertTo-Json -Depth 8
}
