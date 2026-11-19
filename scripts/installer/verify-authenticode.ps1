param([Parameter(Mandatory=$true)][string]$LiteralPath,[Parameter(Mandatory=$true)][ValidateNotNullOrEmpty()][string]$ExpectedSubject)
$ErrorActionPreference='Stop'
if([string]::IsNullOrWhiteSpace($ExpectedSubject)){throw 'An exact verified publisher Subject is required.'}
Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Utility','Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop
Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Security','Microsoft.PowerShell.Security.psd1')) -ErrorAction Stop
function Assert-RelaySignatureObservation($Value,[string]$Subject){
 if([string]::IsNullOrWhiteSpace($Subject) -or $Value.Status -cne 'Valid' -or $Value.SignatureType -cne 'Authenticode' -or $Value.Subject -cne $Subject -or $Value.Subject -ceq $Value.Issuer -or $Value.CodeSigningEku -ne $true -or $Value.TimestampPresent -ne $true -or $Value.TimestampEku -ne $true -or $Value.NativeExitCode -ne 0 -or $Value.SingleSignature -ne $true -or $Value.Sha256FileDigest -ne $true){throw 'The file does not have the required trusted publisher, SHA256 Authenticode signature and verified timestamp.'}
}
# Supported Windows SDK English verification output is explicit evidence, not a permissive parser.
# Unknown/localized layouts and multiple signatures fail closed rather than guessing attribution.
function Get-RelayNativeSignatureLayout([string]$Text){
 $contexts=[regex]::Matches($Text,'(?im)^\s*Signature Index:\s*([^\r\n]+?)\s*$');$digests=[regex]::Matches($Text,'(?im)^\s*Hash of file \(([^)]+)\):\s*([a-f0-9]+)\s*$')
 return @{SingleSignature=($contexts.Count -eq 1 -and $contexts[0].Groups[1].Value -ceq '0 (Primary Signature)');Sha256FileDigest=($digests.Count -eq 1 -and $digests[0].Groups[1].Value -ieq 'sha256' -and $digests[0].Groups[2].Value.Length -eq 64)}
}
function Assert-RelayNoLinks([string]$Path){$cursor=[IO.Path]::GetFullPath($Path);while($cursor){if(([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Linked signing inputs are refused.'};$parent=[IO.Path]::GetDirectoryName($cursor);if($parent -eq $cursor){break};$cursor=$parent}}
function Hash-RelayBytes([byte[]]$Bytes){$hash=[Security.Cryptography.SHA256]::Create();try{return [BitConverter]::ToString($hash.ComputeHash($Bytes)).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}}
function Test-RelayEku($Certificate,[string]$Oid){if(-not $Certificate){return $false};$extensions=@($Certificate.Extensions|Where-Object {$_.Oid.Value -ceq '2.5.29.37'});if($extensions.Count -ne 1){return $false};return @($extensions[0].EnhancedKeyUsages|Where-Object {$_.Value -ceq $Oid}).Count -eq 1}
function Invoke-RelaySignatureTool([string]$Tool,[string]$File){
 $start=[Diagnostics.ProcessStartInfo]::new();$start.FileName=$Tool;$start.Arguments='verify /pa /all /v /tw "'+$File+'"';$start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true;$start.WorkingDirectory=[IO.Path]::GetDirectoryName($Tool)
 $start.EnvironmentVariables.Clear();foreach($key in @('SystemRoot','WINDIR','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','PROGRAMDATA')){$value=[Environment]::GetEnvironmentVariable($key);if($null -ne $value){$start.EnvironmentVariables[$key]=$value}};$start.EnvironmentVariables['PATH']=[IO.Path]::Combine([Environment]::GetEnvironmentVariable('SystemRoot'),'System32')
 $process=[Diagnostics.Process]::new();$process.StartInfo=$start;$started=$false;$out=[IO.MemoryStream]::new();$err=[IO.MemoryStream]::new();$clock=[Diagnostics.Stopwatch]::StartNew()
 try{
  if(-not $process.Start()){throw 'Signature verification did not start.'};$started=$true
  $streams=@($process.StandardOutput.BaseStream,$process.StandardError.BaseStream);$buffers=@([byte[]]::new(4096),[byte[]]::new(4096));$sinks=@($out,$err);$pending=@($null,$null);$closed=@($false,$false)
  for($i=0;$i -lt 2;$i++){$pending[$i]=$streams[$i].BeginRead($buffers[$i],0,4096,$null,$null)}
  while(-not ($closed[0] -and $closed[1] -and $process.HasExited)){
   if($clock.ElapsedMilliseconds -ge 120000){throw 'Signature verification exceeded its absolute 120 second deadline.'}
   for($i=0;$i -lt 2;$i++){if(-not $closed[$i] -and $pending[$i].IsCompleted){$count=$streams[$i].EndRead($pending[$i]);if($count -eq 0){$closed[$i]=$true}else{if($sinks[$i].Length+$count -gt 65536){throw 'Signature verification exceeded its per-stream 65536 byte limit.'};$sinks[$i].Write($buffers[$i],0,$count);$pending[$i]=$streams[$i].BeginRead($buffers[$i],0,4096,$null,$null)}}}
   [Threading.Thread]::Sleep(10)
  }
  return @{ExitCode=$process.ExitCode;Text=([Text.Encoding]::UTF8.GetString($out.ToArray())+"`n"+[Text.Encoding]::UTF8.GetString($err.ToArray()))}
 }finally{
  try{if($started -and -not $process.HasExited){$process.Kill();if(-not $process.WaitForExit(5000)){throw 'Signature verifier termination is unconfirmed; inspect before retrying.'}}}finally{if($started){$process.StandardOutput.Dispose();$process.StandardError.Dispose()};$out.Dispose();$err.Dispose();$process.Dispose()}
 }
}
if([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT){throw 'Authenticode release verification requires Windows.'}
$LiteralPath=[IO.Path]::GetFullPath($LiteralPath);Assert-RelayNoLinks $LiteralPath
$info=[IO.FileInfo]::new($LiteralPath);if(-not $info.Exists -or $info.Extension -ine '.exe' -or $info.Length -lt 1 -or $info.Length -gt 128MB){throw 'Expected a bounded regular installer executable.'}
$before=Hash-RelayBytes ([IO.File]::ReadAllBytes($LiteralPath))
$kits=[IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86),'Windows Kits','10','bin');Assert-RelayNoLinks $kits
$tools=@([IO.Directory]::EnumerateDirectories($kits)|Where-Object {[IO.Path]::GetFileName($_) -cmatch '^\d+\.\d+\.\d+\.\d+$'}|Sort-Object {[version][IO.Path]::GetFileName($_)} -Descending)
$tool=$null
foreach($folder in $tools){$candidate=[IO.Path]::Combine($folder,'x64','signtool.exe');if([IO.File]::Exists($candidate)){$tool=$candidate;break}}
if(-not $tool){throw 'Install a supported Windows SDK in its standard protected location to verify this release.'}
Assert-RelayNoLinks $tool;$sdk=Get-AuthenticodeSignature -LiteralPath $tool
if($sdk.Status.ToString() -cne 'Valid' -or $sdk.SignerCertificate.Subject -cnotmatch '(^|,\s*)O=Microsoft Corporation(,|$)' -or -not (Test-RelayEku $sdk.SignerCertificate '1.3.6.1.5.5.7.3.3')){throw 'The SDK signature verifier is not a trusted Microsoft code-signing executable.'}
# This verifies the embedded signature, trust/revocation policy and timestamp; warnings are failures.
$native=Invoke-RelaySignatureTool $tool $LiteralPath;$nativeCode=$native.ExitCode;$text=$native.Text
$layout=Get-RelayNativeSignatureLayout $text
$signature=Get-AuthenticodeSignature -LiteralPath $LiteralPath
$observation=@{Status=$signature.Status.ToString();SignatureType=$signature.SignatureType.ToString();Subject=$signature.SignerCertificate.Subject;Issuer=$signature.SignerCertificate.Issuer;CodeSigningEku=(Test-RelayEku $signature.SignerCertificate '1.3.6.1.5.5.7.3.3');TimestampPresent=($null -ne $signature.TimeStamperCertificate);TimestampEku=(Test-RelayEku $signature.TimeStamperCertificate '1.3.6.1.5.5.7.3.8');NativeExitCode=$nativeCode;SingleSignature=$layout.SingleSignature;Sha256FileDigest=$layout.Sha256FileDigest}
Assert-RelaySignatureObservation $observation $ExpectedSubject
$after=Hash-RelayBytes ([IO.File]::ReadAllBytes($LiteralPath));if($before -cne $after){throw 'Installer bytes changed during signature verification.'}
[ordered]@{schema=1;verified=$true;artifactSha256=$after;subject=$signature.SignerCertificate.Subject;issuer=$signature.SignerCertificate.Issuer;signerCertificateSha256=(Hash-RelayBytes $signature.SignerCertificate.RawData);timestampSubject=$signature.TimeStamperCertificate.Subject;timestampCertificateSha256=(Hash-RelayBytes $signature.TimeStamperCertificate.RawData);verification='signtool-authenticode';timestampRequired=$true;fileDigest='SHA256'}|ConvertTo-Json -Compress
