param([ValidateSet('Create','PreviewRestore','Restore')][string]$Action='Create', [string]$DataRoot='', [string]$BackupPath='', [ValidateRange(1,65535)][int]$ServerPort=3210)
$ErrorActionPreference='Stop'
function File-Sha256([string]$path){$stream=[IO.File]::OpenRead($path);$hash=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}finally{$stream.Dispose();$hash.Dispose()}}
$homeRoot=[IO.Path]::GetFullPath($(if($env:USERPROFILE){$env:USERPROFILE}else{[Environment]::GetFolderPath('UserProfile')})).TrimEnd('\','/')
if(-not $DataRoot){$DataRoot=Join-Path $homeRoot '.relay-data'}
$DataRoot=[IO.Path]::GetFullPath($DataRoot).TrimEnd('\','/')
function Assert-InHome([string]$path){if(-not $path.StartsWith($homeRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Backup and restore paths must be inside the current user home.'}}
Assert-InHome $DataRoot
if(-not $BackupPath){if($Action -ne 'Create'){throw 'BackupPath is required for restore.'};$BackupPath=Join-Path (Join-Path $homeRoot '.relay-backups') ((Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+[Guid]::NewGuid().ToString('N').Substring(0,8))}
$BackupPath=[IO.Path]::GetFullPath($BackupPath).TrimEnd('\','/')
Assert-InHome $BackupPath
if($BackupPath -ieq $DataRoot -or $BackupPath.StartsWith($DataRoot+'\',[StringComparison]::OrdinalIgnoreCase) -or $DataRoot.StartsWith($BackupPath+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Backup and live data directories must not overlap.'}
function Assert-NoReparse([string]$path){
 $cursor=$path
 while($cursor -and $cursor.Length -gt $homeRoot.Length){if(Test-Path -LiteralPath $cursor){if((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Backup/restore refuses reparse-point paths.'}};$cursor=Split-Path -Parent $cursor}
}
Assert-NoReparse $DataRoot;Assert-NoReparse $BackupPath
$listenerHelper=Join-Path $PSScriptRoot 'windows-tcp-listeners.ps1';Assert-NoReparse $listenerHelper;if((Get-Item -LiteralPath $listenerHelper).LinkType -eq 'HardLink'){throw 'Linked native listener helper'};. $listenerHelper
$node=(Get-Command node.exe -ErrorAction Stop).Source
function Assert-Stopped{
 if(Get-RelayTcpListeners -Port $ServerPort){throw ('Restore requires Relay stopped; port'+$ServerPort+' is in use. No live data changed.')}
 $pidPath=Join-Path $DataRoot 'server.pid'
 if(Test-Path -LiteralPath $pidPath){$value=Get-Content -LiteralPath $pidPath -Raw;$savedId=0;if([int]::TryParse($value.Trim(),[ref]$savedId) -and (Get-CimInstance Win32_Process -Filter ('ProcessId='+$savedId))){throw 'Restore requires the recorded server process stopped. No live data changed.'}}
}
function Validate-Backup{
 $manifestPath=Join-Path $BackupPath 'backup.json'
 if(-not(Test-Path -LiteralPath $manifestPath -PathType Leaf)){throw 'Relay backup manifest is missing.'}
 $manifest=Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8|ConvertFrom-Json
 if($manifest.format -ne 1 -or $manifest.application -ne 'relay-agent-harness'){throw 'Unsupported Relay backup format.'}
 if(-not @($manifest.files|Where-Object{$_.path -eq 'relay.sqlite'}).Count){throw 'Backup has no database.'}
 foreach($entry in $manifest.files){
  if(-not($entry.path -eq 'relay.sqlite' -or $entry.path -match '^artifacts[/\\].+$' -or $entry.path -match '^attachments[/\\][0-9a-fA-F-]{36}\.(bin|txt)$') -or $entry.path.Contains(':') -or $entry.path -match '(^|[/\\])\.\.([/\\]|$)'){throw 'Unsafe backup entry path.'}
  $file=[IO.Path]::GetFullPath((Join-Path $BackupPath $entry.path))
  if(-not $file.StartsWith($BackupPath+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Backup entry escaped its root.'}
  Assert-NoReparse $file
  if(-not(Test-Path -LiteralPath $file -PathType Leaf) -or (File-Sha256 $file) -ne $entry.sha256){throw ('Backup file is missing or changed: '+$entry.path)}
 }
 $nodeScript = 'const{DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.argv[2],{readOnly:true});try{if(db.prepare("PRAGMA quick_check").get().quick_check!=="ok")throw Error("Backup database integrity failed");if(!db.prepare("SELECT name FROM sqlite_master WHERE type=? AND name=?").get("table","records"))throw Error("Not a Relay database")}finally{db.close()}'
 $nodeScript | & $node --no-warnings --input-type=commonjs - (Join-Path $BackupPath 'relay.sqlite')
 if($LASTEXITCODE -ne 0){throw 'Backup database validation failed.'}
 & $node --no-warnings (Join-Path $PSScriptRoot 'attachment-snapshot.cjs') validate (Join-Path $BackupPath 'relay.sqlite') $BackupPath | Out-Null
 if($LASTEXITCODE -ne 0){throw 'Backup attachment completeness validation failed.'}
 return $manifest
}
if($Action -eq 'Create'){
 if(Test-Path -LiteralPath $BackupPath){throw 'Backup destination already exists; refusing to overwrite.'}
 $db=Join-Path $DataRoot 'relay.sqlite'
 if(-not(Test-Path -LiteralPath $db -PathType Leaf)){throw 'Relay database not found.'}
 New-Item -ItemType Directory -Path $BackupPath -Force|Out-Null
 $nodeScript = 'const{DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.argv[2],{readOnly:true});try{db.exec("PRAGMA busy_timeout=5000");db.prepare("VACUUM INTO ?").run(process.argv[3])}finally{db.close()}'
 $nodeScript | & $node --no-warnings --input-type=commonjs - $db (Join-Path $BackupPath 'relay.sqlite')
 if($LASTEXITCODE -ne 0){throw 'Database snapshot failed; incomplete backup retained for inspection.'}
 $requiredJson=& $node --no-warnings (Join-Path $PSScriptRoot 'attachment-snapshot.cjs') plan (Join-Path $BackupPath 'relay.sqlite') $BackupPath
 if($LASTEXITCODE -ne 0){throw 'Snapshot attachment manifest is invalid.'}
 $required=$requiredJson|ConvertFrom-Json
 foreach($entry in $required){$source=[IO.Path]::GetFullPath((Join-Path $DataRoot $entry.path));$target=[IO.Path]::GetFullPath((Join-Path $BackupPath $entry.path));if(-not $source.StartsWith($DataRoot+'\',[StringComparison]::OrdinalIgnoreCase) -or -not $target.StartsWith($BackupPath+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Attachment copy escaped its intended root.'};Assert-NoReparse $source;if(-not(Test-Path -LiteralPath $source -PathType Leaf)){throw 'Snapshot attachment is missing; backup is incomplete.'};New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force|Out-Null;Copy-Item -LiteralPath $source -Destination $target}
 $artifacts=Join-Path $DataRoot 'artifacts'
 if(Test-Path -LiteralPath $artifacts){
  Assert-NoReparse $artifacts
  foreach($file in Get-ChildItem -LiteralPath $artifacts -Recurse -File){Assert-NoReparse $file.FullName;$relative=$file.FullName.Substring($DataRoot.Length+1);$target=Join-Path $BackupPath $relative;New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force|Out-Null;Copy-Item -LiteralPath $file.FullName -Destination $target}
 }
 $files=@(Get-ChildItem -LiteralPath $BackupPath -Recurse -File|ForEach-Object{[pscustomobject]@{path=$_.FullName.Substring($BackupPath.Length+1);sha256=(File-Sha256 $_.FullName);bytes=$_.Length}})
 [IO.File]::WriteAllText((Join-Path $BackupPath 'backup.json'),([pscustomobject]@{application='relay-agent-harness';format=1;createdAt=[DateTime]::UtcNow.ToString('o');files=$files;excludes=@('Provider and browser sign-in profiles','Encrypted integration credential vault (Telegram, MCP, TypeSafe); reconnect required when restoring to a new data root','Application binaries and dependencies','Logs');privateData=$true}|ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
 $validated=Validate-Backup
 [pscustomobject]@{created=$true;backup=$BackupPath;files=@($validated.files).Count;note='Contains private Relay data. Keep this directory private. Provider/browser sign-ins and the integration vault are not included. Reconnect Telegram/MCP/TypeSafe after restore into a new data root. Legacy database pages/backups may retain old plaintext credentials.'}|ConvertTo-Json
 return
}
$manifest=Validate-Backup
$preview=[pscustomobject]@{mode=$Action;backup=$BackupPath;destination=$DataRoot;files=@($manifest.files).Count;requiresStoppedServer=$true;preservesCurrentDataInRecoveryCopy=$true;note='Restore replaces the database, artifact and attachment directories only. Provider/browser profiles remain unchanged. The integration vault is excluded: reconnect Telegram/MCP/TypeSafe when restoring into a new data root. Legacy database pages/backups may retain old plaintext credentials.'}
if($Action -eq 'PreviewRestore'){$preview|ConvertTo-Json;return}
Assert-Stopped
$recovery=Join-Path (Join-Path $homeRoot '.relay-backups') ('before-restore-'+[Guid]::NewGuid().ToString('N'))
Assert-InHome $recovery;Assert-NoReparse $recovery
New-Item -ItemType Directory -Path $recovery -Force|Out-Null
New-Item -ItemType Directory -Path $DataRoot -Force|Out-Null
# Recheck immediately before the first mutation; this command never terminates a server.
Assert-Stopped
$moved=@()
try{
 foreach($name in @('relay.sqlite','relay.sqlite-wal','relay.sqlite-shm','artifacts','attachments')){
  $source=[IO.Path]::GetFullPath((Join-Path $DataRoot $name));$target=[IO.Path]::GetFullPath((Join-Path $recovery $name))
  if(-not $source.StartsWith($DataRoot+'\',[StringComparison]::OrdinalIgnoreCase) -or -not $target.StartsWith($recovery+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Restore mutation escaped intended directories.'}
  Assert-NoReparse $source
  if(Test-Path -LiteralPath $source){Move-Item -LiteralPath $source -Destination $target;$moved+=$name}
 }
 foreach($entry in $manifest.files){$target=Join-Path $DataRoot $entry.path;New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force|Out-Null;Copy-Item -LiteralPath (Join-Path $BackupPath $entry.path) -Destination $target}
 & $node --no-warnings (Join-Path $PSScriptRoot 'attachment-snapshot.cjs') validate-files (Join-Path $DataRoot 'relay.sqlite') $DataRoot | Out-Null
 if($LASTEXITCODE -ne 0){throw 'Restored attachment completeness validation failed.'}
 [pscustomobject]@{restored=$true;destination=$DataRoot;recovery=$recovery;files=@($manifest.files).Count}|ConvertTo-Json
}catch{
 $failure=$_.Exception.Message
 # Preserve partial new data without deletion, then restore the original snapshot.
 $failed=Join-Path $recovery 'failed-restore';New-Item -ItemType Directory -Path $failed -Force|Out-Null
 foreach($name in @('relay.sqlite','relay.sqlite-wal','relay.sqlite-shm','artifacts','attachments')){$path=Join-Path $DataRoot $name;if(Test-Path -LiteralPath $path){Move-Item -LiteralPath $path -Destination (Join-Path $failed $name)}}
 foreach($name in $moved){Move-Item -LiteralPath (Join-Path $recovery $name) -Destination (Join-Path $DataRoot $name)}
 throw ('Restore failed; original data restored. '+$failure)
}