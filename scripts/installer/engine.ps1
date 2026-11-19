param([ValidateSet('install','launch','uninstall')][string]$Mode='install',[Parameter(Mandatory=$true)][string]$BundleDirectory,[Parameter(Mandatory=$true)][string]$Destination,[string]$DataRoot='',[int]$Port=3210,[switch]$NoIntegrations,[switch]$AutoStart,[switch]$NoBrowser,[string]$BrowserCache='')
$ErrorActionPreference='Stop'
Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Utility','Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop
Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Management','Microsoft.PowerShell.Management.psd1')) -ErrorAction Stop
Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules','CimCmdlets','CimCmdlets.psd1')) -ErrorAction Stop
$stage=$null;$stageToken=$null
trap{if($_.Exception.Message -notmatch 'Unconfirmed setup cleanup'){Clear-Stage};[Console]::WriteLine('ERROR|'+($_.Exception.Message -replace '[\r\n]+',' '));exit 1}
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.IO.Compression.FileSystem
$homeRoot=[IO.Path]::GetFullPath([Environment]::GetFolderPath('UserProfile')).TrimEnd('\','/')
$Destination=[IO.Path]::GetFullPath($Destination).TrimEnd('\','/');if(-not $DataRoot){$DataRoot=Join-Path $homeRoot '.relay-data'};$DataRoot=[IO.Path]::GetFullPath($DataRoot).TrimEnd('\','/')
function No-Links([string]$path){$cursor=[IO.Path]::GetFullPath($path);while($cursor){if(Test-Path -LiteralPath $cursor){$item=Get-Item -LiteralPath $cursor -Force;if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked installation paths are not supported.'}};$parent=[IO.Path]::GetDirectoryName($cursor);if($parent -eq $cursor){break};$cursor=$parent}}
function Clear-Stage{if(-not $stage -or -not $stageToken){return};try{Under-Home $stage;No-Links $stage;$owned=Join-Path $stage '.setup-owner';if((Get-Content -LiteralPath $owned -Raw) -cne $stageToken){return};foreach($entry in Get-ChildItem -LiteralPath $stage -Recurse -Force){if($entry.Attributes -band [IO.FileAttributes]::ReparsePoint){return}};Remove-Item -LiteralPath $stage -Recurse -Force}catch{[Console]::WriteLine('NOTICE|Setup could not remove its temporary files; they are separate from your Relay data.')}}
function Under-Home([string]$path){if(-not $path.StartsWith($homeRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Relay installation and data must stay inside your Windows home folder.'};No-Links $path}
function Hash([string]$path){$stream=[IO.File]::OpenRead($path);$hash=[Security.Cryptography.SHA256]::Create();try{return [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose();$stream.Dispose()}}
function Write-Json([string]$path,$value){[IO.File]::WriteAllText($path,($value|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))}
function Phase([string]$message){[Console]::WriteLine('PHASE|'+$message)}
Under-Home $Destination;Under-Home $DataRoot;No-Links $BundleDirectory
if($Destination -ieq $DataRoot -or $DataRoot.StartsWith($Destination+'\',[StringComparison]::OrdinalIgnoreCase) -or $Destination.StartsWith($DataRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Relay application and data folders must be separate.'}
if($Port -lt 1024 -or $Port -gt 65535){throw 'Invalid Relay port.'};if($BrowserCache -and -not $NoIntegrations){throw 'A custom browser cache is only available in isolated setup verification.'}
if($BrowserCache){$BrowserCache=[IO.Path]::GetFullPath($BrowserCache);Under-Home $BrowserCache}
$markerPath=Join-Path $Destination '.relay-install.json';$launcher=Join-Path $Destination '.runtime\Relay.exe'
function Read-Marker{No-Links $markerPath;if(-not(Test-Path -LiteralPath $markerPath -PathType Leaf)){throw 'This folder has no verified Relay installation. Your files were left unchanged.'};$value=Get-Content -LiteralPath $markerPath -Raw|ConvertFrom-Json;if($value.state -ne 'ready' -or -not(Test-Path -LiteralPath (Join-Path $Destination 'Start-Relay.ps1') -PathType Leaf) -or -not(Test-Path -LiteralPath (Join-Path $Destination 'dist\server\index.js') -PathType Leaf)){throw 'This installation needs repair; no existing files were overwritten.'};return $value}
function Run-Process([string]$file,[string[]]$arguments,[string]$cwd,[hashtable]$extra=@{},[int]$seconds=600,[bool]$independent=$false){
 $info=New-Object Diagnostics.ProcessStartInfo;$info.FileName=$file;$info.WorkingDirectory=$cwd;$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
 $quoted=@($arguments|ForEach-Object{if($_ -match '["\x00\r\n]'){throw 'Invalid setup process argument.'};'"'+$_.Replace('\"','\\"').TrimEnd('\')+'"'});$info.Arguments=$quoted -join ' '
 $info.EnvironmentVariables.Clear();foreach($name in @('SystemRoot','WINDIR','ComSpec','PATHEXT','PATH','USERPROFILE','HOME','APPDATA','LOCALAPPDATA','TEMP','TMP','HOMEDRIVE','HOMEPATH','LANG')){$value=[Environment]::GetEnvironmentVariable($name);if($null -ne $value){$info.EnvironmentVariables[$name]=$value}}
 foreach($key in $extra.Keys){$info.EnvironmentVariables[$key]=[string]$extra[$key]}
 if(-not ('RelayProcessRunner' -as [type])){[Reflection.Assembly]::LoadFrom((Join-Path $BundleDirectory 'RelaySetup.exe'))|Out-Null}
 $result=if($independent){[RelayProcessRunner]::RunIndependent($info,$seconds)}else{[RelayProcessRunner]::Run($info,$seconds)};if($result.ExitCode -ne 0){throw ('A required setup step failed (exit '+$result.ExitCode+'). Check internet access and available disk space, then retry.')};return $result.Output+$result.Error
}
function New-ProbeEnvironment([string]$path){Under-Home $path;$probe=@{HOME=$path;USERPROFILE=$path;APPDATA=(Join-Path $path 'AppData\Roaming');LOCALAPPDATA=(Join-Path $path 'AppData\Local');CODEX_HOME=(Join-Path $path '.codex');CLAUDE_CONFIG_DIR=(Join-Path $path '.claude')};foreach($directory in @($probe.Values|Select-Object -Unique)){Under-Home $directory;$null=[IO.Directory]::CreateDirectory($directory)};return $probe}
$ps=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
function Launch-Relay{
 $value=Read-Marker;$selectedData=$DataRoot;$selectedPort=$Port
 if($value.installedBy -eq 'relay-windows-installer-v1'){$selectedData=[string]$value.dataDirectory;$selectedPort=[int]$value.port}
 $extra=@{RELAY_DATA_DIR=$selectedData};if($BrowserCache){$extra.PLAYWRIGHT_BROWSERS_PATH=$BrowserCache}
 $launchArgs=@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',(Join-Path $Destination 'Start-Relay.ps1'),'-LocalInstall','-NoBrowser','-Port',[string]$selectedPort)
 $text=Run-Process $ps $launchArgs $Destination $extra 100 $true
 [Console]::WriteLine('OPENED|'+$Destination)
}
if($Mode -eq 'launch'){Launch-Relay;exit 0}
function Shortcut-Specs{
 $list=@(@{path=(Join-Path ([Environment]::GetFolderPath('Desktop')) 'Relay.lnk');args='--launch'},@{path=(Join-Path ([Environment]::GetFolderPath('Programs')) 'Relay.lnk');args='--launch'})
 if($AutoStart){$list+=@{path=(Join-Path ([Environment]::GetFolderPath('Startup')) 'Relay.lnk');args='--launch --no-browser'}};return $list
}
function Check-Integrations{
 if($NoIntegrations){return};$shell=New-Object -ComObject WScript.Shell;foreach($spec in @(Shortcut-Specs)){if(Test-Path -LiteralPath $spec.path){No-Links $spec.path;$existing=$shell.CreateShortcut($spec.path);if($existing.TargetPath -ine $launcher -or $existing.Arguments -cne $spec.args){throw 'An unrelated Relay shortcut already exists. Rename it before installing.'}}}
 $key='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Relay';if(Test-Path -LiteralPath $key){$old=Get-ItemProperty -LiteralPath $key;if($old.InstallLocation -ine $Destination){throw 'Another Relay installation is registered. Open or uninstall that installation first.'}}
}
if($Mode -eq 'uninstall'){
 Phase 'Checking this installation';$marker=Read-Marker
 if($marker.installedBy -ne 'relay-windows-installer-v1' -or $marker.installDirectory -ine $Destination -or $marker.dataDirectory -ine $DataRoot -or [string]$marker.installId -notmatch '^[a-f0-9]{32}$'){throw 'Uninstall could not establish ownership. Nothing was removed.'}
 $runtime=Get-Content -LiteralPath (Join-Path $Destination '.runtime\install-owner.json') -Raw|ConvertFrom-Json;if($runtime.installId -cne $marker.installId){throw 'Installation ownership records disagree. Nothing was removed.'}
 . (Join-Path $Destination 'scripts\windows-tcp-listeners.ps1')
 $statePath=Join-Path $DataRoot ('supervisor\'+$Port+'\state.json');$state=$null;if(Test-Path -LiteralPath $statePath){No-Links $statePath;$state=Get-Content -LiteralPath $statePath -Raw|ConvertFrom-Json}
 if($state -and $state.appRoot -ieq $Destination -and $state.dataRoot -ieq $DataRoot -and $state.phase -ne 'stopped'){Phase 'Stopping Relay safely';$null=Run-Process $ps @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',(Join-Path $Destination 'Start-Relay.ps1'),'-LocalInstall','-NoBrowser','-Stop','-Port',[string]$Port) $Destination @{RELAY_DATA_DIR=$DataRoot} 100}
 if(@(Get-RelayTcpListeners -Port $Port).Count){throw 'A service still uses the Relay port. No application files were removed.'}
 $server=Join-Path $Destination 'dist\server\index.js';if(@(Get-CimInstance Win32_Process|Where-Object{$_.CommandLine -and $_.CommandLine.Contains($server)}).Count){throw 'A Relay process is still using this installation. Nothing was removed.'}
 No-Links $Destination;foreach($entry in Get-ChildItem -LiteralPath $Destination -Recurse -Force){if($entry.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Uninstall found a linked file. Remove that link manually before retrying.'}}
 if(-not $NoIntegrations){$shell=New-Object -ComObject WScript.Shell;foreach($folder in @('Desktop','Programs','Startup')){$link=Join-Path ([Environment]::GetFolderPath($folder)) 'Relay.lnk';if(Test-Path -LiteralPath $link){No-Links $link;$shortcut=$shell.CreateShortcut($link);if($shortcut.TargetPath -ieq $launcher -and $shortcut.Arguments -in @('--launch','--launch --no-browser')){Remove-Item -LiteralPath $link}}};$key='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Relay';if(Test-Path -LiteralPath $key){$entry=Get-ItemProperty -LiteralPath $key;if($entry.InstallLocation -ieq $Destination){Remove-Item -LiteralPath $key}}}
 Phase 'Removing application files; keeping your chats and accounts';Under-Home $Destination;No-Links $Destination;Remove-Item -LiteralPath $Destination -Recurse -Force
 [Console]::WriteLine('REMOVED|'+$Destination);exit 0
}
if(Test-Path -LiteralPath $Destination){$null=Read-Marker;[Console]::WriteLine('EXISTING|'+$Destination);exit 0}
Check-Integrations
if(-not [Environment]::Is64BitOperatingSystem -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64'){throw 'This beta installer supports Windows x64 only.'}
$drive=New-Object IO.DriveInfo([IO.Path]::GetPathRoot($Destination));if($drive.AvailableFreeSpace -lt 5GB){throw 'Relay setup needs at least 5 GB of free disk space.'}
$manifest=Get-Content -LiteralPath (Join-Path $BundleDirectory 'payload-manifest.json') -Raw|ConvertFrom-Json
if($manifest.schema -ne 1 -or $manifest.name -ne 'relay-agent-harness' -or $manifest.files.Count -lt 6 -or $manifest.files.Count -gt 10000 -or $manifest.unpackedBytes -gt 128MB -or $manifest.developmentFixture){throw 'Invalid release payload.'}
$zipPath=Join-Path $BundleDirectory 'payload.zip';if((Hash $zipPath) -cne $manifest.payloadSha256){throw 'Setup application payload is damaged. Download Relay Setup again.'}
$stage=Join-Path (Join-Path $homeRoot '.relay-stage') ([Guid]::NewGuid().ToString('N').Substring(0,12));Under-Home $stage;New-Item -ItemType Directory -Path $stage|Out-Null;$stageToken=[Guid]::NewGuid().ToString('N');[IO.File]::WriteAllText((Join-Path $stage '.setup-owner'),$stageToken)
$stageApp=Join-Path $stage 'app';New-Item -ItemType Directory -Path $stageApp|Out-Null
Phase 'Preparing Relay'
$zip=[IO.Compression.ZipFile]::OpenRead($zipPath);$seen=New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase);$expected=@{};foreach($file in $manifest.files){if($expected.ContainsKey([string]$file.path)){throw 'Duplicate payload manifest entry.'};$expected[[string]$file.path]=$file}
try{foreach($entry in $zip.Entries){$name=$entry.FullName;if($name.Length -gt 220 -or $name -match '(^/|\\|:|(^|/)\.\.?(/|$)|[\x00-\x1f])' -or -not $seen.Add($name) -or -not $expected.ContainsKey($name)){throw 'Unsafe setup payload path.'};$wanted=$expected[$name];if($entry.Length -ne $wanted.bytes -or $entry.Length -gt 8MB){throw 'Invalid setup payload size.'};$target=[IO.Path]::GetFullPath((Join-Path $stageApp $name));if(-not $target.StartsWith($stageApp+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Payload escaped its folder.'};$null=[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target));$stream=$entry.Open();$dest=[IO.File]::Open($target,[IO.FileMode]::CreateNew);try{$stream.CopyTo($dest)}finally{$stream.Dispose();$dest.Dispose()};if((Hash $target) -cne $wanted.sha256){throw 'Setup payload contents failed verification.'}}}finally{$zip.Dispose()}
if($seen.Count -ne $expected.Count){throw 'Incomplete setup payload.'}
$runtime=Join-Path $stageApp '.runtime';New-Item -ItemType Directory -Path $runtime|Out-Null
Phase 'Downloading the private Node runtime'
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
$nodeZip=Join-Path $stage 'node.zip';$request=[Net.HttpWebRequest]::Create('https://nodejs.org/dist/v22.23.5/node-v22.23.5-win-x64.zip');$request.AllowAutoRedirect=$false;$request.Timeout=120000;$request.ReadWriteTimeout=120000
$response=$request.GetResponse();try{if([int]$response.StatusCode -ne 200 -or $response.ContentLength -gt 128MB){throw 'Unexpected official Node download response.'};$input=$response.GetResponseStream();$output=[IO.File]::Open($nodeZip,[IO.FileMode]::CreateNew);try{$buffer=New-Object byte[] 65536;$received=0L;while(($count=$input.Read($buffer,0,$buffer.Length)) -gt 0){$received+=$count;if($received -gt 128MB){throw 'Official Node download exceeded its bound.'};$output.Write($buffer,0,$count)}}finally{$output.Dispose();$input.Dispose()}}finally{$response.Dispose()}
if((Hash $nodeZip) -cne '4a191082e9706866830379d577d2cc8a50c776fcd9436a8d061b063ed0d9a0e3'){throw 'Official Node download failed checksum verification.'}
$nodeExtract=Join-Path $stage 'node';New-Item -ItemType Directory -Path $nodeExtract|Out-Null
$zip=[IO.Compression.ZipFile]::OpenRead($nodeZip);try{foreach($entry in $zip.Entries){$name=$entry.FullName;if($name -notlike 'node-v22.23.5-win-x64/*' -or $name -match '(\\|:|(^|/)\.\.(/|$))' -or $entry.Length -gt 128MB){throw 'Invalid official Node archive layout.'};if($name.EndsWith('/')){continue};$target=[IO.Path]::GetFullPath((Join-Path $nodeExtract $name));if(-not $target.StartsWith($nodeExtract+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Invalid Node archive path.'};$null=[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target));$input=$entry.Open();$dest=[IO.File]::Open($target,[IO.FileMode]::CreateNew);try{$input.CopyTo($dest)}finally{$input.Dispose();$dest.Dispose()}}}finally{$zip.Dispose()}
Move-Item -LiteralPath (Join-Path $nodeExtract 'node-v22.23.5-win-x64') -Destination (Join-Path $runtime 'node')
$node=Join-Path $runtime 'node\node.exe';if((Hash $node) -cne '247e9693d316da9857e44990e5e11709f596f18112251b8026ec6eed80bdf38a'){throw 'Private Node executable failed verification.'}
Write-Json (Join-Path $runtime 'install-runtime.json') @{version=1;nodeVersion='22.23.5';nodeSha256=(Hash $node)}
$empty=Join-Path $stage 'empty-npmrc';[IO.File]::WriteAllText($empty,'');$cache=Join-Path $stage 'npm-cache';$npm=Join-Path $runtime 'node\node_modules\npm\bin\npm-cli.js';$envFor=@{PATH=((Join-Path $runtime 'node')+';'+$env:PATH);NODE_ENV='development'}
$npmArgs=@($npm,'ci','--ignore-scripts','--no-audit','--no-fund','--registry=https://registry.npmjs.org/',('--userconfig='+$empty),('--cache='+$cache))
Phase 'Installing Relay components automatically';$null=Run-Process $node $npmArgs $stageApp $envFor 1200
Phase 'Installing the official ChatGPT and Claude runtimes';$providers=Join-Path $runtime 'providers';New-Item -ItemType Directory -Path $providers|Out-Null
foreach($file in @('package.json','package-lock.json')){Copy-Item -LiteralPath (Join-Path $stageApp ('scripts\installer\providers\'+$file)) -Destination (Join-Path $providers $file)}
$null=Run-Process $node $npmArgs $providers $envFor 1200
$codex=Join-Path $providers 'node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe';$claude=Join-Path $providers 'node_modules\@anthropic-ai\claude-code-win32-x64\claude.exe'
$probeHome=Join-Path $stage 'probe-home';$probe=New-ProbeEnvironment $probeHome
Phase 'Checking private runtimes';if((Run-Process $codex @('--version') $stageApp $probe 30) -notmatch '^codex-cli 0\.169\.0\s*$'){throw 'The ChatGPT runtime version did not match its lock.'};if((Run-Process $claude @('--version') $stageApp $probe 30) -notmatch '^2\.1\.322 \(Claude Code\)\s*$'){throw 'The Claude runtime version did not match its lock.'}
Phase 'Downloading the bot browser';$browserEnv=@{};foreach($key in $envFor.Keys){$browserEnv[$key]=$envFor[$key]};if($BrowserCache){$browserEnv.PLAYWRIGHT_BROWSERS_PATH=$BrowserCache}
$null=Run-Process $node @((Join-Path $stageApp 'node_modules\playwright\cli.js'),'install','chromium','--no-shell') $stageApp $browserEnv 1200
Phase 'Installing the verified team runtime';$null=Run-Process $ps @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',(Join-Path $stageApp 'scripts\install-herdr.ps1')) $stageApp $envFor 300
$setupExe=Join-Path $BundleDirectory 'RelaySetup.exe';Copy-Item -LiteralPath $setupExe -Destination (Join-Path $runtime 'Relay.exe')
$installId=[Guid]::NewGuid().ToString('N');Write-Json (Join-Path $runtime 'install-owner.json') @{version=1;installId=$installId};Write-Json (Join-Path $runtime 'install-ui.json') @{version=1;destination=$Destination;data=$DataRoot;port=$Port;noIntegrations=[bool]$NoIntegrations;browserCache=$BrowserCache}
Write-Json (Join-Path $runtime 'third-party-components.json') @{schema=1;node='22.23.5';codex='0.169.0';claude='2.1.322';source='Official publisher and locked npm registry downloads on this computer';accountCredentialsIncluded=$false}
Write-Json (Join-Path $stageApp '.relay-install.json') @{state='ready';version=$manifest.version;installedBy='relay-windows-installer-v1';installId=$installId;installedAt=[DateTime]::UtcNow.ToString('o');installDirectory=$Destination;dataDirectory=$DataRoot;port=$Port}
Phase 'Publishing installation';Under-Home $Destination;No-Links $Destination;if(Test-Path -LiteralPath $Destination){throw 'The destination appeared during setup. Existing files were not replaced.'};$null=[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Destination));[IO.Directory]::Move($stageApp,$Destination)
if(-not $NoIntegrations){try{$shell=New-Object -ComObject WScript.Shell;foreach($spec in @(Shortcut-Specs)){$shortcut=$shell.CreateShortcut($spec.path);$shortcut.TargetPath=$launcher;$shortcut.Arguments=$spec.args;$shortcut.WorkingDirectory=$Destination;$shortcut.Description='Open your local Relay workspace';$shortcut.Save()};$key='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Relay';New-Item -Path $key -Force|Out-Null;foreach($pair in @{DisplayName='Relay (Beta)';DisplayVersion=[string]$manifest.version;Publisher='Relay contributors';InstallLocation=$Destination;UninstallString=('"'+$launcher+'" --uninstall');QuietUninstallString=('"'+$launcher+'" --uninstall');NoModify=1;NoRepair=1}.GetEnumerator()){New-ItemProperty -LiteralPath $key -Name $pair.Key -Value $pair.Value -Force|Out-Null}}catch{[Console]::WriteLine('NOTICE|Relay is installed. Windows shortcuts could not be created; use the Open Relay button.')}}
Clear-Stage
[Console]::WriteLine('READY|'+$Destination)
