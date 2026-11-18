param([switch]$NoBrowser,[int]$Port=3210,[switch]$LocalInstall,[switch]$Stop,[switch]$Recover,[string]$RecoveryReceipt='',[string]$RecoveryReceiptSha256='')
$ErrorActionPreference='Stop'
if($Recover){if($Stop -or -not $RecoveryReceipt -or $RecoveryReceiptSha256 -notmatch '^[a-f0-9]{64}$'){throw 'Recovery requires its exact reviewed receipt path and external SHA256, and cannot stop a process'}}elseif($RecoveryReceipt -or $RecoveryReceiptSha256){throw 'Recovery receipt requires explicit -Recover'}
$appRoot=$PSScriptRoot
$preferredRoot=Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Relay'
$preferredLauncher=Join-Path $preferredRoot 'Start-Relay.ps1';$preferredManifest=Join-Path $preferredRoot '.relay-install.json'
if(-not $LocalInstall -and $appRoot -ine $preferredRoot -and (Test-Path -LiteralPath $preferredLauncher) -and (Test-Path -LiteralPath $preferredManifest)){
 try{$preferredState=Get-Content -LiteralPath $preferredManifest -Raw|ConvertFrom-Json}catch{$preferredState=$null}
 if($preferredState.state -eq 'ready'){& $preferredLauncher -NoBrowser:$NoBrowser -Port $Port -Stop:$Stop -Recover:$Recover -RecoveryReceipt $RecoveryReceipt -RecoveryReceiptSha256 $RecoveryReceiptSha256;exit}
}
if($Port -lt 1 -or $Port -gt 65535){throw 'Port must be between 1 and 65535.'}
$dataRoot=[IO.Path]::GetFullPath($(if($env:RELAY_DATA_DIR){$env:RELAY_DATA_DIR}else{Join-Path ([Environment]::GetFolderPath('UserProfile')) '.relay-data'}))
$baseUrl="http://127.0.0.1:$Port"
$serverPath=Join-Path $appRoot 'dist\server\index.js';$servePath=Join-Path $appRoot 'scripts\serve-relay.ps1'
if(-not(Test-Path -LiteralPath $serverPath) -or -not(Test-Path -LiteralPath $servePath)){throw 'Build Relay first: run Setup Relay.cmd.'}
function Read-ControlText([string]$path){$stream=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete));try{$reader=New-Object IO.StreamReader($stream,[Text.Encoding]::UTF8,$true);try{return $reader.ReadToEnd()}finally{$reader.Dispose()}}finally{$stream.Dispose()}}
function No-Links([string]$path){$current=[IO.Path]::GetFullPath($path);while($current){if(Test-Path -LiteralPath $current){if(((Get-Item -Force -LiteralPath $current).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Launcher refuses linked control paths'}};$parent=[IO.Path]::GetDirectoryName($current);if($parent -eq $current){break};$current=$parent}}
No-Links $appRoot;No-Links $dataRoot;$listenerHelper=Join-Path $appRoot 'scripts\windows-tcp-listeners.ps1';No-Links $listenerHelper;if((Get-Item -LiteralPath $listenerHelper).LinkType -eq 'HardLink'){throw 'Linked native listener helper'};. $listenerHelper;New-Item -ItemType Directory -Force -Path $dataRoot|Out-Null
$runtimeHelper=Join-Path $appRoot 'scripts\private-runtime.ps1';$privateRuntime=$null
if(Test-Path -LiteralPath $runtimeHelper){No-Links $runtimeHelper;if((Get-Item -LiteralPath $runtimeHelper).LinkType -eq 'HardLink'){throw 'Linked private runtime helper'};. $runtimeHelper;$privateRuntime=Get-RelayPrivateRuntime -AppRoot $appRoot}
elseif(Test-Path -LiteralPath (Join-Path $appRoot '.runtime')){throw 'Relay private runtime verification is unavailable. Repair Relay using its official installer.'}
if($privateRuntime){$nodePath=$privateRuntime.NodePath;$env:PATH=$privateRuntime.Path}else{$nodePath=(Get-Command node.exe -ErrorAction Stop).Source}
function Command-TokenPattern([string]$value){
 $escaped=[regex]::Escape($value)
 if($value -match '\s'){return ('"'+$escaped+'"')}
 return ('(?:"'+$escaped+'"|'+$escaped+')')
}
$ownedCommandPattern='^\s*'+(Command-TokenPattern $nodePath)+'\s+--no-warnings\s+'+(Command-TokenPattern $serverPath)+'\s*$'
function Host-OwnsPortMutex{
 $probe=New-Object Threading.Mutex($false,('Local\Relay-Server-Port-'+$Port));$acquired=$false
 try{try{$acquired=$probe.WaitOne(0)}catch [Threading.AbandonedMutexException]{$acquired=$true};return (-not $acquired)}finally{if($acquired){$probe.ReleaseMutex()};$probe.Dispose()}
}
# Use the same Node path/case semantics as health, including Unicode and trailing separators.
$identityOutput=& $nodePath --no-warnings -e 'const p=require(''node:path''),c=require(''node:crypto''),app=p.resolve(process.argv[1]),data=p.resolve(process.argv[2]);console.log(JSON.stringify({app:Buffer.from(app).toString(''base64''),data:Buffer.from(data).toString(''base64''),id:c.createHash(''sha256'').update(data.toLowerCase()).digest(''hex'')}));' -- $appRoot $dataRoot
if($LASTEXITCODE -ne 0){throw 'Could not normalize Relay process identity'}
$identity=$identityOutput|ConvertFrom-Json
if($identity.id -notmatch '^[a-f0-9]{64}$'){throw 'Invalid Relay data identity'}
$appRoot=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($identity.app));$dataRoot=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($identity.data));$dataId=[string]$identity.id
$control=Join-Path $dataRoot ('supervisor\'+$Port);$statePath=Join-Path $control 'state.json';$stopPath=Join-Path $control 'stop.json'
function Atomic-Json([string]$path,$value){
 No-Links $path;$temp=$path+'.tmp-'+[Guid]::NewGuid().ToString('N');[IO.File]::WriteAllText($temp,($value|ConvertTo-Json -Depth 12 -Compress),(New-Object Text.UTF8Encoding($false)))
 if(Test-Path -LiteralPath $path){
  $backup=$path+'.previous-'+[Guid]::NewGuid().ToString('N');$retry=[Diagnostics.Stopwatch]::StartNew()
  while($true){try{[IO.File]::Replace($temp,$path,$backup);break}catch{$cause=$_.Exception;while($cause.InnerException){$cause=$cause.InnerException};if(($cause.HResult -band 65535) -notin @(32,33) -or $retry.ElapsedMilliseconds -ge 1000){throw};Start-Sleep -Milliseconds 20}}
  try{[IO.File]::Delete($backup)}catch [IO.IOException]{}
 }else{[IO.File]::Move($temp,$path)}
}
function Get-OwnedHealth{
 try{$health=Invoke-RestMethod -Uri "$baseUrl/api/health" -TimeoutSec 2}catch{return $null}
 $listeners=@(Get-RelayTcpListeners -Port $Port)
 if($health.service -ne 'relay' -or $listeners.Count -eq 0 -or @($listeners|Where-Object{$_.LocalAddress -notin @('127.0.0.1','::1')}).Count){throw "Port $Port is occupied by a different service."}
 $nativeBefore=$null
 foreach($listener in $listeners){
  $owner=Get-CimInstance Win32_Process -Filter ('ProcessId='+$listener.OwningProcess)
  if(-not $owner -or $owner.ExecutablePath -ine $nodePath -or -not [regex]::IsMatch($owner.CommandLine,$ownedCommandPattern,[Text.RegularExpressions.RegexOptions]::IgnoreCase)){throw "Port $Port belongs to another installation. No process was stopped."}
  if($health.pid -ne $owner.ProcessId){throw 'Health PID does not own the listener'};$nativeBefore=$owner
 }
 if($health.ok -ne $true -or $health.updateHeld -ne $false -or $health.dataDirectoryId -cne $dataId -or [string]$health.instanceId -notmatch '^[a-fA-F0-9-]{36}$'){throw 'Relay health has no matching released data/instance identity. Inspect activation before starting or stopping.'}
 $again=Invoke-RestMethod -Uri "$baseUrl/api/health" -TimeoutSec 2;$nativeAfter=Get-CimInstance Win32_Process -Filter ('ProcessId='+$health.pid);$listeners=@(Get-RelayTcpListeners -Port $Port)
 if(-not $nativeAfter -or $nativeAfter.CreationDate -ne $nativeBefore.CreationDate -or $nativeAfter.CommandLine -cne $nativeBefore.CommandLine -or $again.instanceId -cne $health.instanceId -or $again.pid -ne $health.pid -or $again.dataDirectoryId -cne $dataId -or $again.updateHeld -ne $false -or $listeners.Count -eq 0 -or @($listeners|Where-Object{$_.OwningProcess -ne $health.pid}).Count){throw 'Relay process ownership changed during verification'}
 return @{health=$health;startedAt=$nativeAfter.CreationDate.ToUniversalTime().ToString('o')}
}
function Read-State{
 No-Links $statePath;if(-not [IO.File]::Exists($statePath)){return $null}
 try{$text=Read-ControlText $statePath}catch [IO.FileNotFoundException]{return $null}
 if($text.Length -gt 65536){throw 'Supervisor descriptor exceeds bounds'}
 $state=$text|ConvertFrom-Json
 if($state.version -ne 1 -or $state.appRoot -ine $appRoot -or $state.dataRoot -ine $dataRoot -or $state.port -ne $Port -or $state.sessionId -notmatch '^[a-fA-F0-9-]{36}$'){throw 'Supervisor descriptor does not match this installation'}
 return $state
}
function Native-Host($state){$native=Get-CimInstance Win32_Process -Filter ('ProcessId='+$state.hostPid);return ($native -and $native.ExecutablePath -ine '' -and $native.ExecutablePath -ieq $state.hostExecutable -and $native.CommandLine -ceq $state.hostCommandLine -and $native.CreationDate.ToUniversalTime().ToString('o') -ceq $state.hostStartedAt)}
$owned=Get-OwnedHealth
if($Stop){
 $state=Read-State
 if(-not $state -or -not(Host-OwnsPortMutex) -or -not(Native-Host $state) -or $state.phase -notin @('monitoring','backoff')){throw 'No exact supervised generation is available to stop. Inspect supervisor state; no process was stopped.'}
 if($owned -and ($state.child.pid -ne $owned.health.pid -or $state.child.startedAt -cne $owned.startedAt -or $state.child.instanceId -cne $owned.health.instanceId)){throw 'Supervisor child generation changed; retry stop'}
 Atomic-Json $stopPath @{version=1;sessionId=$state.sessionId;pid=$state.child.pid;startedAt=$state.child.startedAt;instanceId=$state.child.instanceId;reason='user-stop'}
 $ack=$false;for($attempt=0;$attempt -lt 80;$attempt++){Start-Sleep -Milliseconds 100;$current=Read-State;if($current.sessionId -cne $state.sessionId){throw 'Supervisor session changed before stop acknowledgment'};if($current.phase -in @('stopping','stopped')){$ack=$true;break};if($current.phase -in @('updating','recovery_required')){throw 'Supervisor rejected stop during update/uncertainty. No process was stopped.'}}
 if(-not $ack){throw 'Supervisor did not acknowledge intentional stop. No process was stopped.'}
 if($current.phase -ne 'stopped'){
  $native=Get-CimInstance Win32_Process -Filter ('ProcessId='+$state.child.pid)
  if($native){if($native.CreationDate.ToUniversalTime().ToString('o') -cne $state.child.startedAt -or $native.ExecutablePath -ine $nodePath -or -not [regex]::IsMatch($native.CommandLine,$ownedCommandPattern,[Text.RegularExpressions.RegexOptions]::IgnoreCase)){throw 'Stop native identity changed. No process was stopped.'};Stop-Process -Id ([int]$state.child.pid) -ErrorAction Stop}
 }
 for($attempt=0;$attempt -lt 80;$attempt++){Start-Sleep -Milliseconds 100;$current=Read-State;if($current.sessionId -ceq $state.sessionId -and $current.phase -eq 'stopped'){Write-Host 'Relay stopped intentionally.';exit 0}}
 throw 'Relay stop was acknowledged but final supervisor exit is unconfirmed. Inspect state.'
}
$hasHost=Host-OwnsPortMutex
$expectedSession=$null
if($Recover){if(-not $owned -or $hasHost){throw 'Explicit listener recovery requires the existing healthy orphan and an absent supervisor'};$recovery=Get-RelayListenerRecoveryProof -Receipt $RecoveryReceipt -ReceiptSha256 $RecoveryReceiptSha256 -AppRoot $appRoot -DataRoot $dataRoot -Port $Port -NodePath $nodePath;if($recovery.orphan.pid -ne $owned.health.pid -or $recovery.orphan.startedAt -cne $owned.startedAt -or $recovery.orphan.instanceId -cne $owned.health.instanceId){throw 'Recovery generation differs from launcher ownership proof'}}
if($hasHost){$existingState=Read-State;if($existingState -and ((Native-Host $existingState) -or -not(Host-OwnsPortMutex))){$expectedSession=$existingState.sessionId}}
if($owned -and $hasHost){$state=Read-State;if($state -and (Native-Host $state) -and $state.phase -eq 'monitoring' -and $state.child.pid -eq $owned.health.pid -and $state.child.instanceId -ceq $owned.health.instanceId -and $state.child.startedAt -ceq $owned.startedAt){if(-not $NoBrowser){Start-Process $baseUrl};Write-Host "Relay is running at $baseUrl";exit 0}}
if(-not $owned -and @(Get-RelayTcpListeners -Port $Port).Count){throw "Port $Port is in use. No process was stopped."}
if(-not $hasHost){
 $environment=@{};foreach($name in @('USERPROFILE','HOME','APPDATA','LOCALAPPDATA','TEMP','TMP','HOMEDRIVE','HOMEPATH')){$value=[Environment]::GetEnvironmentVariable($name,'Process');if($null -ne $value){$environment[$name]=$value}}
 if($env:PLAYWRIGHT_BROWSERS_PATH){
  $profileRoot=[IO.Path]::GetFullPath([Environment]::GetFolderPath('UserProfile')).TrimEnd('\','/');$browserRoot=[IO.Path]::GetFullPath($env:PLAYWRIGHT_BROWSERS_PATH)
  if(-not [IO.Path]::IsPathRooted($env:PLAYWRIGHT_BROWSERS_PATH) -or -not $browserRoot.StartsWith($profileRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'The Relay browser cache must be an absolute folder inside this Windows user profile.'}
  No-Links $browserRoot;$environment['PLAYWRIGHT_BROWSERS_PATH']=$browserRoot
 }
 $configurationValue=@{appRoot=$appRoot;dataRoot=$dataRoot;nodePath=$nodePath;port=$Port;path=$env:PATH;environment=$environment}
 if($Recover){$configurationValue.recovery=@{receiptPath=$RecoveryReceipt;receiptSha256=$RecoveryReceiptSha256}}
 if($owned){$configurationValue.adopt=@{pid=$owned.health.pid;startedAt=$owned.startedAt;instanceId=$owned.health.instanceId}}
 $encodedConfig=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($configurationValue|ConvertTo-Json -Depth 6 -Compress)))
 $powershell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe';$startup=New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0}
 $result=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=('"'+$powershell+'" -NoProfile -NonInteractive -WindowStyle Hidden -File "'+$servePath+'" -Configuration '+$encodedConfig);CurrentDirectory=$appRoot;ProcessStartupInformation=$startup}
 if($result.ReturnValue -ne 0){throw "Windows could not start Relay independently (WMI result $($result.ReturnValue)). See $dataRoot\launcher.log."}
}
$ready=$false
for($attempt=0;$attempt -lt 90;$attempt++){
 Start-Sleep -Milliseconds 500;$state=Read-State
 if($state -and (($result -and $state.hostPid -eq $result.ProcessId) -or ((Host-OwnsPortMutex) -and (Native-Host $state)))){$expectedSession=$state.sessionId}
 $freshState=$state -and $expectedSession -and $state.sessionId -ceq $expectedSession
 if($freshState -and $state.phase -in @('recovery_required','exhausted')){throw "Relay stopped during startup: $($state.reason). See $dataRoot\launcher.log and server-error.log."}
 $owned=Get-OwnedHealth
 if($owned -and $state -and $state.phase -eq 'monitoring' -and (Host-OwnsPortMutex) -and (Native-Host $state) -and $state.child.pid -eq $owned.health.pid -and $state.child.instanceId -ceq $owned.health.instanceId -and $state.child.startedAt -ceq $owned.startedAt){$ready=$true;break}
 if($result -and -not(Get-Process -Id $result.ProcessId -ErrorAction SilentlyContinue) -and -not(Host-OwnsPortMutex)){throw "Relay stopped during startup. See $dataRoot\launcher.log and server-error.log."}
}
if(-not $ready){throw "Relay has not become supervised and ready. See $dataRoot\launcher.log and server-error.log. No process was stopped."}
if(-not $NoBrowser){Start-Process $baseUrl};Write-Host "Relay is running at $baseUrl"
