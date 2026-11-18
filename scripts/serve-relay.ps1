param([Parameter(Mandatory=$true)][string]$Configuration)
$ErrorActionPreference='Stop'
$config=([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Configuration))|ConvertFrom-Json)
$appRoot=[IO.Path]::GetFullPath([string]$config.appRoot);$dataRoot=[IO.Path]::GetFullPath([string]$config.dataRoot);$port=[int]$config.port
if($port -lt 1 -or $port -gt 65535 -or -not [IO.Path]::IsPathRooted($config.appRoot) -or -not [IO.Path]::IsPathRooted($config.dataRoot)){throw 'Invalid supervisor configuration'}
function Read-ControlText([string]$path){$stream=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete));try{$reader=New-Object IO.StreamReader($stream,[Text.Encoding]::UTF8,$true);try{return $reader.ReadToEnd()}finally{$reader.Dispose()}}finally{$stream.Dispose()}}
function No-Links([string]$path){$current=[IO.Path]::GetFullPath($path);while($current){if(Test-Path -LiteralPath $current){if(((Get-Item -Force -LiteralPath $current).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Supervisor refuses linked control paths'}};$parent=[IO.Path]::GetDirectoryName($current);if($parent -eq $current){break};$current=$parent}}
No-Links $dataRoot;No-Links $appRoot;$listenerHelper=Join-Path $PSScriptRoot 'windows-tcp-listeners.ps1';No-Links $listenerHelper;if((Get-Item -LiteralPath $listenerHelper).LinkType -eq 'HardLink'){throw 'Linked native listener helper'};. $listenerHelper
New-Item -ItemType Directory -Force -Path $dataRoot|Out-Null
$log=Join-Path $dataRoot 'launcher.log';$control=Join-Path $dataRoot ('supervisor\'+$port);No-Links $control
New-Item -ItemType Directory -Force -Path $control|Out-Null
$statePath=Join-Path $control 'state.json';$stopPath=Join-Path $control 'stop.json';$latest=Join-Path $dataRoot 'self-update\latest';$serverPath=Join-Path $appRoot 'dist\server\index.js'
function Log([string]$message){Add-Content -LiteralPath $log -Encoding UTF8 -Value ((Get-Date -Format o)+' '+$message)}
function Atomic-Json([string]$path,$value){
 No-Links $path;$temp=$path+'.tmp-'+[Guid]::NewGuid().ToString('N');[IO.File]::WriteAllText($temp,($value|ConvertTo-Json -Depth 12 -Compress),(New-Object Text.UTF8Encoding($false)))
 if(Test-Path -LiteralPath $path){
  $backup=$path+'.previous-'+[Guid]::NewGuid().ToString('N');$retry=[Diagnostics.Stopwatch]::StartNew()
  while($true){try{[IO.File]::Replace($temp,$path,$backup);break}catch{$cause=$_.Exception;while($cause.InnerException){$cause=$cause.InnerException};if(($cause.HResult -band 65535) -notin @(32,33) -or $retry.ElapsedMilliseconds -ge 1000){throw};Start-Sleep -Milliseconds 20}}
  try{[IO.File]::Delete($backup)}catch [IO.IOException]{}
 }else{[IO.File]::Move($temp,$path)}
}
function Read-Json([string]$path){No-Links $path;$item=Get-Item -Force -LiteralPath $path;if($item.Length -gt 20000000){throw 'Supervisor JSON exceeds bounds'};return ((Read-ControlText $path)|ConvertFrom-Json)}
function Token-Pattern([string]$value){$escaped=[regex]::Escape($value);if($value -match '\s'){return ('"'+$escaped+'"')};return ('(?:"'+$escaped+'"|'+$escaped+')')}
$commandPattern='^\s*'+(Token-Pattern $config.nodePath)+'\s+--no-warnings\s+'+(Token-Pattern $serverPath)+'\s*$'
# Use the same Node path/case semantics as health, including Unicode and trailing separators.
$identityOutput=& $config.nodePath --no-warnings -e 'const p=require(''node:path''),c=require(''node:crypto''),app=p.resolve(process.argv[1]),data=p.resolve(process.argv[2]);console.log(JSON.stringify({app:Buffer.from(app).toString(''base64''),data:Buffer.from(data).toString(''base64''),id:c.createHash(''sha256'').update(data.toLowerCase()).digest(''hex'')}));' -- $appRoot $dataRoot
if($LASTEXITCODE -ne 0){throw 'Could not normalize Relay process identity'}
$identity=$identityOutput|ConvertFrom-Json
if($identity.id -notmatch '^[a-f0-9]{64}$'){throw 'Invalid Relay data identity'}
$appRoot=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($identity.app));$dataRoot=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($identity.data));$dataId=[string]$identity.id
$clock=[Diagnostics.Stopwatch]::StartNew();$windowMs=60000;$stableMs=60000;$backoff=@(1000,2000,4000);$pollMs=250;$updateWaitMs=180000;$readyWaitMs=30000
# Only explicit private fixture configuration can shorten timing; launchers never copy environment overrides.
if($config.timings){foreach($key in @('windowMs','stableMs','pollMs','updateWaitMs','readyWaitMs')){$prop=$config.timings.PSObject.Properties[$key];if($prop){$value=[int]$prop.Value;if($value -lt 20 -or $value -gt 600000){throw 'Invalid fixture timing'};Set-Variable -Name $key -Value $value}};if($config.timings.backoff){$backoff=@($config.timings.backoff|ForEach-Object{[int]$_});if($backoff.Count -ne 3 -or @($backoff|Where-Object{$_ -lt 20 -or $_ -gt 4000}).Count){throw 'Invalid backoff'}}}
$mutex=$null;$locked=$false;$child=$null;$childIdentity=$null;$pinned=$null;$restartTimes=New-Object 'Collections.Generic.List[long]';$readySince=$null;$publicationAuthorized=(-not [bool]$config.recovery);$recoveryProof=$null
$nativeHost=Get-CimInstance Win32_Process -Filter ('ProcessId='+$PID)
$state=@{version=1;sessionId=[Guid]::NewGuid().ToString();hostPid=$PID;hostStartedAt=$nativeHost.CreationDate.ToUniversalTime().ToString('o');hostExecutable=$nativeHost.ExecutablePath;hostCommandLine=$nativeHost.CommandLine;appRoot=$appRoot;dataRoot=$dataRoot;port=$port;phase='starting';restartCount=0;updatedAt=(Get-Date).ToUniversalTime().ToString('o')}
function Publish([string]$phase,[string]$reason=''){$state.phase=$phase;$state.updatedAt=(Get-Date).ToUniversalTime().ToString('o');$state.reason=$reason;if($childIdentity){$state.child=$childIdentity}else{$state.Remove('child')};Atomic-Json $statePath $state}
function Listeners{return ,@(Get-RelayTcpListeners -Port $port)}
function Owned-Process([int]$processId){
 $native=Get-CimInstance Win32_Process -Filter ('ProcessId='+$processId)
 if(-not $native){return $null}
 if($native.ExecutablePath -ine $config.nodePath -or -not [regex]::IsMatch([string]$native.CommandLine,$commandPattern,[Text.RegularExpressions.RegexOptions]::IgnoreCase)){throw 'Process executable/argv ownership mismatch; no process was stopped'}
 $process=Get-Process -Id $processId -ErrorAction Stop;$null=$process.Handle
 if($process.HasExited){return $null}
 return @{process=$process;startedAt=$native.CreationDate.ToUniversalTime().ToString('o');command=[string]$native.CommandLine}
}
function Verified-Health([int]$processId,[string]$startedAt,[string]$nonce=''){
 $before=Owned-Process $processId;if(-not $before -or $before.startedAt -ne $startedAt){throw 'Process generation changed'}
 $owners=Listeners;if($owners.Count -eq 0 -or @($owners|Where-Object{$_.OwningProcess -ne $processId -or $_.LocalAddress -notin @('127.0.0.1','::1')}).Count){throw 'Listener ownership mismatch; no process was stopped'}
 $health=Invoke-RestMethod -Uri ('http://127.0.0.1:'+$port+'/api/health') -TimeoutSec 2
 if($health.service -ne 'relay' -or $health.ok -ne $true -or $health.pid -ne $processId -or $health.dataDirectoryId -cne $dataId -or $health.updateHeld -ne $false -or [string]$health.instanceId -notmatch '^[a-fA-F0-9-]{36}$' -or ($nonce -and $health.updateNonce -cne $nonce)){throw 'Relay health identity/hold mismatch'}
 $after=Owned-Process $processId;$owners=Listeners
 if(-not $after -or $after.startedAt -ne $startedAt -or $after.command -cne $before.command -or $owners.Count -eq 0 -or @($owners|Where-Object{$_.OwningProcess -ne $processId -or $_.LocalAddress -notin @('127.0.0.1','::1')}).Count){throw 'Ownership changed during health check'}
 return $health
}
function Latest-Job{
 No-Links $latest;if(-not(Test-Path -LiteralPath $latest)){return $null}
 if((Get-Item -Force -LiteralPath $latest).Length -gt 100){throw 'Published update identity exceeds bounds'};$key=(Read-ControlText $latest);if($key -notmatch '^[a-fA-F0-9-]{36}$'){throw 'Invalid published update identity'}
 $directory=Join-Path $dataRoot ('self-update\jobs\'+$key);$jobPath=Join-Path $directory 'job.json';$job=Read-Json $jobPath
 if($job.version -ne 1 -or $job.id -cne $key -or $job.installDirectory -ine $appRoot -or $job.dataDirectory -ine $dataRoot -or $job.port -ne $port -or $job.nonce -notmatch '^[a-f0-9]{32,128}$' -or $job.oldPid -lt 1 -or $job.statusPath -ine (Join-Path $directory 'status.json') -or $job.holdPath -ine (Join-Path $directory 'startup.hold')){throw 'Published update does not match this installation'}
 return @{job=$job;directory=$directory;raw=(Read-ControlText $jobPath)}
}
function Released($intent,$receipt){
 $job=$intent.job;$hold=Join-Path $intent.directory 'startup.hold';$release=$hold+'.released';No-Links $hold;No-Links $release
 if(Test-Path -LiteralPath $hold){return $false};if(-not(Test-Path -LiteralPath $release)){return $false};if((Get-Item -Force -LiteralPath $release).Length -gt 128){throw 'Update release exceeds bounds'};if((Read-ControlText $release) -cne $job.nonce){throw 'Update release nonce mismatch'}
 return $true
}
function Read-Receipt($intent){
 No-Links (Join-Path $intent.directory 'job.json');$raw=(Read-ControlText (Join-Path $intent.directory 'job.json'));if($raw -cne $intent.raw){throw 'Pinned update job changed'}
 $receipt=Read-Json (Join-Path $intent.directory 'status.json')
 if($receipt.jobId -cne $intent.job.id -or $receipt.changeId -cne $intent.job.changeId -or $receipt.status -notin @('pending','queued','waiting_for_shutdown','backing_up','installing','checking','restoring','complete','rolled_back','failed') -or $receipt.recoveryRequired){throw 'Unknown or inconsistent updater state; inspect recovery'}
 return $receipt
}
function Recorded-Identity($intent,$receipt){
 $proof=$receipt.replacement
 if(-not $proof -or $proof.pid -ne $receipt.newPid -or $proof.executable -ine $config.nodePath -or $proof.serverPath -ine $serverPath -or -not [regex]::IsMatch([string]$proof.command,$commandPattern,[Text.RegularExpressions.RegexOptions]::IgnoreCase) -or $proof.dataDirectoryId -cne $dataId -or $proof.instanceId -notmatch '^[a-fA-F0-9-]{36}$' -or -not $proof.startedAt){return $false}
 try{$started=[DateTime]::Parse($proof.startedAt).ToUniversalTime();if($intent.job.createdAt -and $started -lt [DateTime]::Parse($intent.job.createdAt).ToUniversalTime()){return $false}}catch{return $false}
 return $true
}
function Terminal-Receipt($intent,$receipt){
 if(-not ($receipt.newPid -is [int] -or $receipt.newPid -is [long]) -or $receipt.newPid -lt 1 -or $receipt.newPid -gt [int]::MaxValue -or $receipt.recoveryRequired){return $false}
 if($receipt.status -in @('complete','rolled_back')){if($receipt.dataPreserved -ne $true){return $false}}
 elseif($receipt.status -eq 'failed'){if($receipt.restartedPrevious -ne $true -or $receipt.liveFilesChanged -ne $false){return $false}}
 else{return $false}
 if($receipt.replacement -and -not(Recorded-Identity $intent $receipt)){return $false}
 return $true
}
function Job-Fingerprint($intent){$hash=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($intent.raw)))).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}}
function Installation-Proof($intent,$receipt){
 $saved=$state.installationProof
 if(-not $saved -or $saved.version -ne 1 -or $saved.jobId -cne $intent.job.id -or $saved.jobHash -cne (Job-Fingerprint $intent) -or $saved.nonce -cne $intent.job.nonce -or $saved.status -cne $receipt.status -or $saved.receiptPid -ne $receipt.newPid){return $false}
 return (Recorded-Identity $intent @{newPid=$receipt.newPid;replacement=$saved.replacement})
}
function Remember-Installation($intent,$receipt,$native,$health){
 $state.installationProof=@{version=1;jobId=$intent.job.id;jobHash=(Job-Fingerprint $intent);nonce=$intent.job.nonce;status=$receipt.status;receiptPid=$receipt.newPid;replacement=@{pid=$receipt.newPid;startedAt=$native.startedAt;executable=$config.nodePath;command=$native.command;serverPath=$serverPath;dataDirectoryId=$dataId;instanceId=$health.instanceId}}
}
function Proven-Installation($intent,$receipt){
 if(-not(Terminal-Receipt $intent $receipt) -or -not(Released $intent $receipt)){return $false}
 # A living legacy replacement needs independent native health proof. An already proven
 # cached child permits normal process recovery; a dead unrecorded generation never does.
 if(Installation-Proof $intent $receipt){return $true}
 $recorded=Owned-Process ([int]$receipt.newPid)
 if(-not $recorded){return [bool](Recorded-Identity $intent $receipt)}
 if($receipt.replacement -and $recorded.startedAt -cne $receipt.replacement.startedAt){return $false}
 $nonce=[string]$intent.job.nonce;if($receipt.status -ne 'complete'){$nonce+='00'}
 $confirmed=Verified-Health ([int]$receipt.newPid) $recorded.startedAt $nonce
 if($receipt.replacement -and $confirmed.instanceId -cne $receipt.replacement.instanceId){return $false}
 Remember-Installation $intent $receipt $recorded $confirmed
 return $true
}
function Intent-ForChild{
 $intent=Latest-Job;if(-not $intent -or $intent.job.oldPid -ne $child.Id){return $null}
 if(-not $intent.job.supervisor -or $intent.job.supervisor.version -ne 1 -or $intent.job.supervisor.sessionId -cne $state.sessionId -or -not $childIdentity -or $intent.job.supervisor.oldInstanceId -cne $childIdentity.instanceId){throw 'Published update lacks this supervisor generation; do not restart'}
 if(-not $intent.job.createdAt -or [DateTime]::Parse($intent.job.createdAt).ToUniversalTime() -lt [DateTime]::Parse($childIdentity.startedAt).ToUniversalTime()){throw 'Published update predates its child generation'}
 return $intent
}
function Stop-Requested{
 No-Links $stopPath;if(-not(Test-Path -LiteralPath $stopPath)){return $false};$request=Read-Json $stopPath
 if($request.version -eq 1 -and $request.sessionId -ceq $state.sessionId -and $childIdentity -and $request.pid -eq $childIdentity.pid -and $request.startedAt -ceq $childIdentity.startedAt -and $request.instanceId -ceq $childIdentity.instanceId -and $request.reason -ceq 'user-stop'){return $true};return $false
}
function Wait-Update($intent){
 $state.updateJobId=$intent.job.id;Publish 'updating' 'Trusted updater owns the installation; spawning is suppressed';$until=$clock.ElapsedMilliseconds+$updateWaitMs
 while($clock.ElapsedMilliseconds -lt $until){
  $receipt=Read-Receipt $intent
  if($receipt.status -in @('complete','rolled_back','failed')){
   if(-not(Terminal-Receipt $intent $receipt)){throw 'Updater terminal state has no proven healthy replacement'}
   if(Released $intent $receipt){
    $replacement=Owned-Process ([int]$receipt.newPid)
    if(-not $replacement){
     $proof=$receipt.replacement
     if(-not(Recorded-Identity $intent $receipt)){throw 'Committed replacement is gone but its native generation is unproven; inspect recovery'}
     $now=$clock.ElapsedMilliseconds;while($restartTimes.Count -and $now-$restartTimes[0] -ge $windowMs){$restartTimes.RemoveAt(0)}
     if($restartTimes.Count -ge 3){throw 'Committed replacement crash budget exhausted'}
     Publish 'updating' 'Proven committed replacement exited before adoption; bounded process restart only'
     Start-Sleep -Milliseconds $backoff[$restartTimes.Count]
     $currentReceipt=Read-Receipt $intent
     if(($currentReceipt|ConvertTo-Json -Depth 12 -Compress) -cne ($receipt|ConvertTo-Json -Depth 12 -Compress) -or -not(Released $intent $currentReceipt) -or (Get-CimInstance Win32_Process -Filter ('ProcessId='+$receipt.newPid)) -or (Listeners).Count){throw 'Committed replacement absence/release/port proof changed; inspect recovery'}
     $restartTimes.Add($clock.ElapsedMilliseconds);$state.restartCount=[int]$state.restartCount+1
     return @{process=(Launch-Child);identity=$null}
    }
    if([DateTime]::Parse($replacement.startedAt).ToUniversalTime() -lt [DateTime]::Parse($intent.job.createdAt).ToUniversalTime()){throw 'Replacement predates published update'}
    $nonce=[string]$intent.job.nonce;if($receipt.status -ne 'complete'){$nonce+='00'}
    if($receipt.replacement -and $replacement.startedAt -cne $receipt.replacement.startedAt){throw 'Replacement native generation differs from its trusted receipt'}
    $health=Verified-Health ([int]$receipt.newPid) $replacement.startedAt $nonce
    if($receipt.replacement -and $health.instanceId -cne $receipt.replacement.instanceId){throw 'Replacement instance differs from its trusted receipt'}
    Remember-Installation $intent $receipt $replacement $health
    return @{process=$replacement.process;identity=@{pid=[int]$receipt.newPid;startedAt=$replacement.startedAt;instanceId=[string]$health.instanceId}}
   }
  }
  Start-Sleep -Milliseconds $pollMs
 }
 throw 'Updater observation expired or helper disappeared; inspect recovery. No activation was replayed'
}
function Launch-Child{
 if((Listeners).Count){throw 'Port is occupied; no process was stopped'}
 if(Latest-Job){$prior=Latest-Job;$receipt=Read-Receipt $prior;if(-not(Proven-Installation $prior $receipt)){throw 'Previous update remains uncertain; no process was started'}}
 foreach($name in @('server.log','server-error.log')){$path=Join-Path $dataRoot $name;if(Test-Path -LiteralPath $path){Move-Item -LiteralPath $path -Destination ($path+'.'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'.'+[Guid]::NewGuid().ToString('N')+'.previous')}}
 $process=Start-Process -FilePath $config.nodePath -ArgumentList @('--no-warnings',('"'+$serverPath+'"')) -WorkingDirectory $appRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $dataRoot 'server.log') -RedirectStandardError (Join-Path $dataRoot 'server-error.log')
 $null=$process.Handle;Set-Content -LiteralPath (Join-Path $dataRoot 'server.pid') -Value $process.Id -Encoding ASCII
 Log ('Relay process '+$process.Id+' started by independent Windows host '+$PID);return $process
}
try{
 $mutex=New-Object Threading.Mutex($false,('Local\Relay-Server-Port-'+$port));try{$locked=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$locked=$true}
 if(-not $locked){Log 'Another Relay launcher owns this port.';exit 0}
 if(-not(Test-Path -LiteralPath $serverPath -PathType Leaf)){throw 'Relay server build is missing'}
 foreach($name in @('USERPROFILE','HOME','APPDATA','LOCALAPPDATA','TEMP','TMP','HOMEDRIVE','HOMEPATH')){$property=$config.environment.PSObject.Properties[$name];if($null -ne $property){[Environment]::SetEnvironmentVariable($name,[string]$property.Value,'Process')}}
 $browserProperty=$config.environment.PSObject.Properties['PLAYWRIGHT_BROWSERS_PATH']
 if($null -ne $browserProperty){$browserRoot=[IO.Path]::GetFullPath([string]$browserProperty.Value);$profileRoot=[IO.Path]::GetFullPath([Environment]::GetFolderPath('UserProfile')).TrimEnd('\','/');if(-not [IO.Path]::IsPathRooted([string]$browserProperty.Value) -or -not $browserRoot.StartsWith($profileRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'The Relay browser cache must stay inside this Windows user profile.'};No-Links $browserRoot;$env:PLAYWRIGHT_BROWSERS_PATH=$browserRoot}
 $env:RELAY_DATA_DIR=$dataRoot;$env:PORT=[string]$port;$env:PATH=$config.path
 # Never inherit stale candidate controls into normal crash recovery.
 Remove-Item Env:RELAY_UPDATE_HOLD -ErrorAction SilentlyContinue;Remove-Item Env:RELAY_UPDATE_NONCE -ErrorAction SilentlyContinue
 $previous=$null;if(Test-Path -LiteralPath $statePath){$previous=Read-Json $statePath;if($previous.version -ne 1 -or $previous.appRoot -ine $appRoot -or $previous.dataRoot -ine $dataRoot -or $previous.port -ne $port){throw 'Previous supervisor descriptor belongs to a different installation'};if($previous.installationProof){$state.installationProof=$previous.installationProof};if($previous.phase -eq 'updating' -or ($previous.phase -eq 'recovery_required' -and -not $config.recovery)){throw 'Previous supervisor left uncertain activation state; inspect recovery'}}
 if($config.recovery){if(-not $config.adopt -or @($config.recovery.PSObject.Properties.Name|Where-Object{$_ -notin @('receiptPath','receiptSha256')}).Count){throw 'Invalid explicit recovery configuration'};$recoveryProof=Get-RelayListenerRecoveryProof -Receipt $config.recovery.receiptPath -ReceiptSha256 $config.recovery.receiptSha256 -AppRoot $appRoot -DataRoot $dataRoot -Port $port -NodePath $config.nodePath;if($recoveryProof.orphan.pid -ne $config.adopt.pid -or $recoveryProof.orphan.startedAt -cne $config.adopt.startedAt -or $recoveryProof.orphan.instanceId -cne $config.adopt.instanceId){throw 'Recovery adoption generation changed'}}
 $intent=Latest-Job;if($intent){$receipt=Read-Receipt $intent;if(-not(Proven-Installation $intent $receipt)){throw 'Published update requires recovery inspection'}}
 if($config.adopt){
  if($previous.child -and ($previous.child.pid -ne $config.adopt.pid -or $previous.child.startedAt -cne $config.adopt.startedAt -or $previous.child.instanceId -cne $config.adopt.instanceId)){throw 'Attachment generation differs from the previously monitored process; inspect recovery'}
  $owned=Owned-Process ([int]$config.adopt.pid);if(-not $owned -or $owned.startedAt -cne $config.adopt.startedAt){throw 'Attachment native generation changed'}
  $health=Verified-Health ([int]$config.adopt.pid) $owned.startedAt
  if($health.instanceId -cne $config.adopt.instanceId){throw 'Attachment instance changed'}
  $child=$owned.process;$childIdentity=@{pid=$child.Id;startedAt=$owned.startedAt;instanceId=$health.instanceId};$readySince=$clock.ElapsedMilliseconds;if($recoveryProof){Save-RelayListenerRecoveryAudit -Proof $recoveryProof -SessionId $state.sessionId -HostPid $PID;$state.recovery=@{version=1;receiptSha256=$recoveryProof.receiptSha256;priorStateSha256=$recoveryProof.priorStateSha256;originalJobId=$recoveryProof.jobId};$publicationAuthorized=$true};Publish 'monitoring' 'Attached to exact healthy Relay generation';Log ('Attached independent Windows host '+$PID+' to existing Relay '+$child.Id)
 }else{$child=Launch-Child;Publish 'starting'}
 $launchAt=$clock.ElapsedMilliseconds
 while($true){
  if((Stop-Requested) -and -not(Intent-ForChild)){Publish 'stopping' 'Intentional stop acknowledged for exact process generation';while(-not $child.WaitForExit($pollMs)){};Publish 'stopped' 'Intentional stop completed';exit 0}
  if($child.WaitForExit($pollMs)){
   Log ('Relay process '+$child.Id+' exited with code '+$child.ExitCode)
   $pinned=Intent-ForChild
   if($pinned){$adopted=Wait-Update $pinned;$child=$adopted.process;$childIdentity=$adopted.identity;$pinned=$null;$readySince=$clock.ElapsedMilliseconds;$launchAt=$clock.ElapsedMilliseconds;$state.Remove('updateJobId');if($childIdentity){Publish 'monitoring' 'Adopted exact trusted updater replacement'}else{Publish 'starting' 'Restarted proven committed replacement'};continue}
   $now=$clock.ElapsedMilliseconds;while($restartTimes.Count -and $now-$restartTimes[0] -ge $windowMs){$restartTimes.RemoveAt(0)}
   if($restartTimes.Count -ge 3){Publish 'exhausted' 'Three unexpected restarts within the rolling window; inspect server-error.log';exit 1}
   $delay=$backoff[$restartTimes.Count];Publish 'backoff' ('Unexpected child exit; retry after '+$delay+'ms');$until=$clock.ElapsedMilliseconds+$delay
   while($clock.ElapsedMilliseconds -lt $until){if(Stop-Requested){Publish 'stopped' 'Intentional stop acknowledged after child exit';exit 0};$pinned=Intent-ForChild;if($pinned){break};Start-Sleep -Milliseconds $pollMs}
   if($pinned){$adopted=Wait-Update $pinned;$child=$adopted.process;$childIdentity=$adopted.identity;$pinned=$null;$readySince=$clock.ElapsedMilliseconds;$launchAt=$clock.ElapsedMilliseconds;if($childIdentity){Publish 'monitoring' 'Adopted exact trusted updater replacement'}else{Publish 'starting' 'Restarted proven committed replacement'};continue}
   if(Stop-Requested){Publish 'stopped';exit 0};$null=Intent-ForChild
   $restartTimes.Add($clock.ElapsedMilliseconds);$state.restartCount=[int]$state.restartCount+1;$childIdentity=$null;$readySince=$null;$child=Launch-Child;$launchAt=$clock.ElapsedMilliseconds;Publish 'starting';continue
  }
  if(-not $childIdentity){
   $verified=$null
   try{$owned=Owned-Process $child.Id;$verified=Verified-Health $child.Id $owned.startedAt}catch{if($clock.ElapsedMilliseconds-$launchAt -ge $readyWaitMs){throw ('Relay readiness could not be proven: '+$_.Exception.Message)}}
   if($verified){$childIdentity=@{pid=$child.Id;startedAt=$owned.startedAt;instanceId=$verified.instanceId};$readySince=$clock.ElapsedMilliseconds;Publish 'monitoring'}
  }elseif($readySince -ne $null -and $clock.ElapsedMilliseconds-$readySince -ge $stableMs){
   try{$health=Verified-Health $child.Id $childIdentity.startedAt;if($health.instanceId -cne $childIdentity.instanceId){throw 'Stable health instance changed'};$restartTimes.Clear();$readySince=$null;Publish 'monitoring' 'Stable ready health reset the crash budget'}catch{$readySince=$clock.ElapsedMilliseconds}
  }
 }
}catch{Log ('ERROR '+$_.Exception.ToString());if($locked -and $publicationAuthorized){Publish 'recovery_required' $_.Exception.Message};exit 1}finally{if($locked){$mutex.ReleaseMutex()};if($mutex){$mutex.Dispose()}}
