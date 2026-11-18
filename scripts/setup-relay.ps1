param([string]$SourceRoot = (Split-Path -Parent $PSScriptRoot), [string]$DestinationRoot = '', [switch]$Apply, [switch]$Autostart, [switch]$InstallHerdr, [switch]$SkipBrowser)
$ErrorActionPreference='Stop'
function File-Sha256([string]$path){$stream=[IO.File]::OpenRead($path);$hash=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}finally{$stream.Dispose();$hash.Dispose()}}
$homeRoot=[IO.Path]::GetFullPath($(if($env:USERPROFILE){$env:USERPROFILE}else{[Environment]::GetFolderPath('UserProfile')})).TrimEnd('\','/')
if(-not $DestinationRoot){$DestinationRoot=Join-Path $homeRoot 'Relay'}
$SourceRoot=(Resolve-Path -LiteralPath $SourceRoot).Path.TrimEnd('\','/')
$DestinationRoot=[IO.Path]::GetFullPath($DestinationRoot).TrimEnd('\','/')
function Assert-ChildOfHome([string]$path){if(-not $path.StartsWith($homeRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Installation paths must be inside the current user home.'}}
function Assert-NoReparse([string]$path){$cursor=$path;while($cursor -and $cursor.Length -gt $homeRoot.Length){if(Test-Path -LiteralPath $cursor){if((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Installation refuses reparse-point targets.'}};$cursor=Split-Path -Parent $cursor}}
Assert-ChildOfHome $DestinationRoot
Assert-NoReparse $DestinationRoot
$listenerHelper=Join-Path $PSScriptRoot 'windows-tcp-listeners.ps1';Assert-NoReparse $listenerHelper;if((Get-Item -LiteralPath $listenerHelper).LinkType -eq 'HardLink'){throw 'Linked native listener helper'};. $listenerHelper
if($DestinationRoot -ieq (Join-Path $homeRoot '.relay-data') -or $DestinationRoot.StartsWith((Join-Path $homeRoot '.relay-data')+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Install and data directories must be separate.'}
if($SourceRoot.StartsWith($DestinationRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Destination cannot contain the source checkout.'}
foreach($file in @('package.json','package-lock.json','Start-Relay.ps1','Start Relay.cmd','Setup Relay.cmd','tsconfig.json','tsconfig.server.json','vite.config.ts')){if(-not(Test-Path -LiteralPath (Join-Path $SourceRoot $file) -PathType Leaf)){throw ('Source is incomplete: '+$file)}}
$package=Get-Content -LiteralPath (Join-Path $SourceRoot 'package.json') -Raw|ConvertFrom-Json
if($package.name -ne 'relay-agent-harness'){throw 'Source is not a Relay checkout.'}
$startup=''
if($Autostart){$startupFolder=[Environment]::GetFolderPath('Startup');if(-not $startupFolder){throw 'Current user Startup folder is unavailable.'};$startup=Join-Path $startupFolder 'Relay.cmd'}
$report=[pscustomobject]@{mode=if($Apply){'apply'}else{'preview'};source=$SourceRoot;destination=$DestinationRoot;data=(Join-Path $homeRoot '.relay-data');version=$package.version;autostart=[bool]$Autostart;browser=(-not $SkipBrowser);herdr=[bool]$InstallHerdr;existingInstall=(Test-Path -LiteralPath $DestinationRoot);instructions='Use -Apply to install. Existing installations are backed up and must be stopped. Provider CLIs are installed separately; sign in inside Relay.'}
if(-not $Apply){$report|ConvertTo-Json -Depth 4;return}
$node=Get-Command node.exe -ErrorAction Stop
$version=[Version]((& $node.Source --version).Trim().TrimStart('v'))
if($version -lt [Version]'22.13.0'){throw 'Relay requires Node.js 22.13.0 or later.'}
$npm=(Get-Command npm.cmd -ErrorAction Stop).Source
function Assert-InstallStopped{
 if(Get-RelayTcpListeners -Port 3210){throw 'Stop Relay before installing or updating; localhost port3210 is in use. No installation files changed.'}
 $serverPath=Join-Path $DestinationRoot 'dist\server\index.js'
 if(@(Get-CimInstance Win32_Process|Where-Object{$_.CommandLine -and $_.CommandLine.Contains($serverPath)}).Count){throw 'A Relay server still owns this installation. Stop it first.'}
}
Assert-InstallStopped
if(Test-Path -LiteralPath $DestinationRoot){
 $manifest=Join-Path $DestinationRoot '.relay-install.json'
 if(-not(Test-Path -LiteralPath $manifest)){throw 'Existing destination has no Relay installation marker. Choose an empty destination; no files changed.'}
 $existing=Get-Content -LiteralPath $manifest -Raw -Encoding UTF8|ConvertFrom-Json
 if($existing.state -ne 'ready'){throw 'Existing destination is not a ready Relay installation.'}
 $serverPath=Join-Path $DestinationRoot 'dist\server\index.js'
 if(@(Get-CimInstance Win32_Process|Where-Object{$_.CommandLine -and $_.CommandLine.Contains($serverPath)}).Count){throw 'A Relay server still owns this installation. Stop it first.'}
}
if($Autostart){
 $startupParent=Split-Path -Parent $startup
 if(-not(Test-Path -LiteralPath $startupParent)){throw 'Current user Startup folder is unavailable.'}
 if(Test-Path -LiteralPath $startup){$startupText=Get-Content -LiteralPath $startup -Raw -Encoding UTF8;if(-not $startupText.Contains('Relay managed startup')){throw 'An unmanaged Relay.cmd already exists in Startup. Preserve or rename it before enabling autostart.'}}
}
$stageRoot=Join-Path (Join-Path $homeRoot '.relay-install-staging') ([Guid]::NewGuid().ToString('N'))
Assert-ChildOfHome $stageRoot
Assert-NoReparse $stageRoot
New-Item -ItemType Directory -Path $stageRoot -Force|Out-Null
$rootFiles=@('README.md','package.json','package-lock.json','Start-Relay.ps1','Start Relay.cmd','Setup Relay.cmd','tsconfig.json','tsconfig.server.json','vite.config.ts','.gitignore')
foreach($file in $rootFiles){$source=Join-Path $SourceRoot $file;if(Test-Path -LiteralPath $source -PathType Leaf){Copy-Item -LiteralPath $source -Destination (Join-Path $stageRoot $file)}}
foreach($directory in @('server','client','shared','docs','scripts','tests')){if(Test-Path -LiteralPath (Join-Path $SourceRoot $directory)){
 $sourceDirectory=Get-Item -LiteralPath (Join-Path $SourceRoot $directory) -Force
 if($sourceDirectory.Attributes -band [IO.FileAttributes]::ReparsePoint -or @(Get-ChildItem -LiteralPath $sourceDirectory.FullName -Recurse -Force|Where-Object{$_.Attributes -band [IO.FileAttributes]::ReparsePoint}).Count){throw 'Source directories must not contain reparse points.'}
 Copy-Item -LiteralPath (Join-Path $SourceRoot $directory) -Destination (Join-Path $stageRoot $directory) -Recurse}}
# Preserve an already-installed delegation capability using only its checksum-pinned public archive.
$oldRuntime=Join-Path $DestinationRoot '.data-herdr-tools/0.9.5'
$oldBinary=Join-Path $oldRuntime 'herdr.exe'
if(Test-Path -LiteralPath $oldBinary -PathType Leaf){
 Assert-NoReparse $oldBinary
 if((File-Sha256 $oldBinary) -ne 'cd877c8744296f4a38a2703bf13cf11728973649ec54959959c4587ffe5368b2'){throw 'Existing Herdr runtime does not match the pinned release. Existing installation remains unchanged.'}
 $InstallHerdr=$true
 $cachedArchive=Join-Path $oldRuntime 'herdr-windows-x86_64.zip'
 if(Test-Path -LiteralPath $cachedArchive -PathType Leaf){
  Assert-NoReparse $cachedArchive
  if((File-Sha256 $cachedArchive) -ne 'd2c6c9c971c43a0bfdde8c692a9a1a7a45c3e4807cd01ae45662b4734fac1cbf'){throw 'Existing Herdr archive checksum mismatch. Existing installation remains unchanged.'}
  $newRuntime=Join-Path $stageRoot '.data-herdr-tools/0.9.5';New-Item -ItemType Directory -Path $newRuntime -Force|Out-Null
  Copy-Item -LiteralPath $cachedArchive -Destination (Join-Path $newRuntime 'herdr-windows-x86_64.zip')
 }
}
# Dependencies/build run in a fresh stage; credentials, private profiles, .env, .git and user .data* are never copied.
Push-Location $stageRoot
try{
 & $npm ci
 if($LASTEXITCODE -ne 0){throw 'Dependency installation failed. Existing installation is unchanged.'}
 & $npm run build
 if($LASTEXITCODE -ne 0){throw 'Build failed. Existing installation is unchanged.'}
 if(-not $SkipBrowser){& $npm exec -- playwright install chromium;if($LASTEXITCODE -ne 0){throw 'Browser installation failed. Existing installation is unchanged.'}}
 if($InstallHerdr){& (Join-Path $stageRoot 'scripts/install-herdr.ps1');if(-not(Test-Path -LiteralPath (Join-Path $stageRoot '.data-herdr-tools/0.9.5/herdr.exe'))){throw 'Herdr installation did not complete.'}}
}finally{Pop-Location}
# A user could start the old application while the fresh stage was building.
Assert-InstallStopped
Assert-NoReparse $DestinationRoot
$backupRoot=$null
if(Test-Path -LiteralPath $DestinationRoot){
 $backupRoot=$DestinationRoot+'.backup-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+([Guid]::NewGuid().ToString('N').Substring(0,6))
 Assert-ChildOfHome $backupRoot
 Assert-NoReparse $backupRoot
 Move-Item -LiteralPath $DestinationRoot -Destination $backupRoot
}
try{
 Move-Item -LiteralPath $stageRoot -Destination $DestinationRoot
 [IO.File]::WriteAllText((Join-Path $DestinationRoot '.relay-install.json'),([pscustomobject]@{state='ready';version=$package.version;installedAt=[DateTime]::UtcNow.ToString('o');source=$SourceRoot;backup=$backupRoot}|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
 if($Autostart){
  $startupParent=Split-Path -Parent $startup
  if(-not(Test-Path -LiteralPath $startupParent)){throw 'Current user Startup folder is unavailable.'}
  # This file is only created when the human explicitly selects -Autostart.
  [IO.File]::WriteAllText($startup,(@('@echo off','chcp 65001 >nul',':: Relay managed startup',('powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -File "'+(Join-Path $DestinationRoot 'Start-Relay.ps1')+'" -NoBrowser')) -join [Environment]::NewLine),[Text.UTF8Encoding]::new($false))
 }
 [pscustomobject]@{installed=$true;path=$DestinationRoot;backup=$backupRoot;dataUnchanged=$true;autostart=[bool]$Autostart;launch=(Join-Path $DestinationRoot 'Start Relay.cmd')}|ConvertTo-Json
}catch{
 if($backupRoot){
  if(Test-Path -LiteralPath $DestinationRoot){$failedRoot=$DestinationRoot+'.failed-'+[Guid]::NewGuid().ToString('N');Assert-ChildOfHome $failedRoot;Assert-NoReparse $DestinationRoot;Move-Item -LiteralPath $DestinationRoot -Destination $failedRoot}
  Move-Item -LiteralPath $backupRoot -Destination $DestinationRoot
 }
 throw ('Installation activation failed. Preserve the new and backup directories for recovery. '+$_.Exception.Message)
}
