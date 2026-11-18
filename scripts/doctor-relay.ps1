param([string]$AppRoot = (Split-Path -Parent $PSScriptRoot), [string]$DataRoot = '', [switch]$Json)
$ErrorActionPreference='Stop'
$nativeWindows=([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT)
$homeRoot=$(if($env:USERPROFILE){$env:USERPROFILE}else{[Environment]::GetFolderPath('UserProfile')})
if(-not $DataRoot){$DataRoot=Join-Path $homeRoot '.relay-data'}
$checks=@()
$node=Get-Command node.exe -ErrorAction SilentlyContinue
$nodeVersion=$null
if($node){try{$nodeVersion=[Version]((& $node.Source --version).Trim().TrimStart('v'))}catch{}}
$checks+=[pscustomobject]@{name='Node.js';ready=($null -ne $nodeVersion -and $nodeVersion -ge [Version]'22.13.0');detail=if($nodeVersion){$nodeVersion.ToString()}else{'Install Node.js 22.13 or later from nodejs.org'}}
$checks+=[pscustomobject]@{name='npm';ready=[bool](Get-Command npm.cmd -ErrorAction SilentlyContinue);detail='Required to install and update Relay dependencies'}
foreach($provider in @(@{name='OpenAI';command='codex'},@{name='Claude';command='claude'})){
 $command=Get-Command $provider.command -ErrorAction SilentlyContinue
 $checks+=[pscustomobject]@{name=$provider.name;ready=[bool]$command;detail=if($command){'Native runtime found. Authentication and subscription entitlement not verified; sign in and confirm billing inside Relay.'}else{'Install the official provider CLI. Other available connections can still be used.'}}
}
$checks+=[pscustomobject]@{name='Application build';ready=(Test-Path -LiteralPath (Join-Path $AppRoot 'dist/server/index.js') -PathType Leaf);detail='Open Setup Relay.cmd, or run scripts\setup-relay.ps1 -Apply; in a source checkout, npm run build'}
$checks+=[pscustomobject]@{name='Herdr delegation';ready=(Test-Path -LiteralPath (Join-Path $AppRoot '.data-herdr-tools/0.9.5/herdr.exe') -PathType Leaf);detail='Optional for lead-and-worker execution; open Setup Relay.cmd or run scripts\setup-relay.ps1 -Apply -InstallHerdr'}
$browserReady=$false
if($node -and (Test-Path -LiteralPath (Join-Path $AppRoot 'node_modules/playwright/package.json'))){
 try{
  $probe='const{createRequire}=require("node:module");const{pathToFileURL}=require("node:url");const resolver=createRequire(pathToFileURL(process.argv[2]));process.stdout.write(require("node:fs").existsSync(resolver("playwright").chromium.executablePath())?"true":"false");'
  $browserReady=(($probe | & $node.Source --input-type=commonjs - (Join-Path $AppRoot 'package.json') 2>$null|Select-Object -Last 1) -eq 'true')
 }catch{}
}
$checks+=[pscustomobject]@{name='Shared browser';ready=$browserReady;detail='Open Setup Relay.cmd, or run scripts\setup-relay.ps1 -Apply; in the app folder, npm exec -- playwright install chromium. Then grant browser access per bot in Relay'}
# Read only the installed connector's public package metadata, never its account/profile state.
$cursorVersion=$null
$cursorPackagePath=Join-Path $AppRoot 'node_modules/@cursor/sdk/package.json'
if(Test-Path -LiteralPath $cursorPackagePath -PathType Leaf){
 try{
  $cursorPackage=Get-Content -LiteralPath $cursorPackagePath -Raw -Encoding UTF8|ConvertFrom-Json
  if($cursorPackage.name -ceq '@cursor/sdk' -and $cursorPackage.version -is [string] -and $cursorPackage.version -cmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$'){$cursorVersion=$cursorPackage.version}
 }catch{}
}
$cursorNative=if($nativeWindows){'Native Work/Agent sessions are unavailable on this Windows host.'}else{'Native Work/Agent runtime availability is not checked.'}
$checks+=[pscustomobject]@{name='Cursor';ready=($null -ne $cursorVersion);detail=if($cursorVersion){('@cursor/sdk '+$cursorVersion+' installed for the app-only Relay Agent/Chat transport. '+$cursorNative+' Authentication and subscription entitlement not verified.')}else{('Cursor connector package missing or invalid. Open Setup Relay.cmd or run scripts\setup-relay.ps1 -Apply. '+$cursorNative+' Other connections can still be used.')}}
# Synthetic CurrentUser capability probe only: no vault/profile/credential files or ciphertext output.
$dpapiReady=$false
$sample=$null;$protected=$null;$recovered=$null
try{
 if(-not $nativeWindows){throw 'Windows DPAPI unavailable'}
 Add-Type -AssemblyName System.Security | Out-Null
 $sample=[Guid]::NewGuid().ToByteArray()
 $protected=[Security.Cryptography.ProtectedData]::Protect($sample,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
 $recovered=[Security.Cryptography.ProtectedData]::Unprotect($protected,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
 if($sample.Length -ne $recovered.Length){throw 'DPAPI roundtrip mismatch'}
 for($offset=0;$offset -lt $sample.Length;$offset++){if($sample[$offset] -ne $recovered[$offset]){throw 'DPAPI roundtrip mismatch'}}
 $dpapiReady=$true
}catch{
 # Exceptions can contain environment details; report only bounded capability status.
}finally{
 foreach($buffer in @($sample,$protected,$recovered)){if($null -ne $buffer){[Array]::Clear($buffer,0,$buffer.Length)}}
}
$checks+=[pscustomobject]@{name='Managed secrets (DPAPI)';ready=$dpapiReady;detail=if($dpapiReady){'CurrentUser memory-only Protect/Unprotect roundtrip succeeded. Managed-secret encryption capability is available; stored credentials were not checked.'}else{'Managed secrets are unavailable: the CurrentUser DPAPI memory-only roundtrip failed. Check the Windows user profile/session before configuring managed credentials.'}}
$baseReady=$true
foreach($required in @('Node.js','npm','Application build')){if(-not ($checks|Where-Object {$_.name -eq $required}).ready){$baseReady=$false}}
$report=[pscustomobject]@{appRoot=[IO.Path]::GetFullPath($AppRoot);dataRoot=[IO.Path]::GetFullPath($DataRoot);homeDirectory=$homeRoot;checks=$checks;ready=$baseReady;notes=@('This check does not authenticate, send model requests, read provider credentials or change billing.','Overall ready describes the base application: Node.js, npm and the application build. Optional connections and managed-secret readiness are reported separately.','The DPAPI result is a synthetic capability check, not a full vault security assessment.','The server must remain running for local scheduled tasks. A sleeping or offline computer cannot execute them.')}
if($Json){$report|ConvertTo-Json -Depth 5}else{$checks|Format-Table name,ready,detail -AutoSize;Write-Output ('App: '+$report.appRoot);Write-Output ('Data: '+$report.dataRoot);Write-Output $report.notes}
