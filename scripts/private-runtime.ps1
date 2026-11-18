# Relay's installer owns this fixed private runtime. No global PATH or Node installation is changed.
function Get-RelayPrivateRuntime([string]$AppRoot) {
 $ErrorActionPreference='Stop'
 $root=[IO.Path]::GetFullPath($AppRoot)
 $runtime=Join-Path $root '.runtime'
 if(-not(Test-Path -LiteralPath $runtime)){return $null}
 function Assert-RelayRuntimePath([string]$Path,[bool]$Directory) {
  $item=Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if([bool]$item.PSIsContainer -ne $Directory -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.LinkType -eq 'HardLink'){throw 'Relay private runtime contains a linked or invalid path.'}
  $cursor=[IO.Path]::GetFullPath($Path)
  while($cursor){$ancestor=Get-Item -LiteralPath $cursor -Force -ErrorAction Stop;if(($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Relay private runtime refuses linked ancestors.'};$parent=[IO.Path]::GetDirectoryName($cursor);if($parent -eq $cursor){break};$cursor=$parent}
 }
 Assert-RelayRuntimePath $runtime $true
 $marker=Join-Path $runtime 'install-runtime.json';Assert-RelayRuntimePath $marker $false
 if((Get-Item -LiteralPath $marker).Length -gt 4096){throw 'Relay private runtime marker exceeds its bounds.'}
 try{$saved=Get-Content -LiteralPath $marker -Raw -Encoding UTF8|ConvertFrom-Json}catch{throw 'Relay private runtime marker is invalid.'}
 if($saved -isnot [pscustomobject] -or @($saved.PSObject.Properties).Count -ne 3 -or @($saved.PSObject.Properties.Name|Where-Object{$_ -notin @('version','nodeVersion','nodeSha256')}).Count -or ($saved.version -isnot [int] -and $saved.version -isnot [long]) -or $saved.version -ne 1 -or $saved.nodeVersion -isnot [string] -or $saved.nodeVersion -cne '22.23.5' -or $saved.nodeSha256 -isnot [string] -or $saved.nodeSha256 -cne '247e9693d316da9857e44990e5e11709f596f18112251b8026ec6eed80bdf38a'){throw 'Relay private runtime marker does not match the supported verified runtime.'}
 $nodeDirectory=Join-Path $runtime 'node';Assert-RelayRuntimePath $nodeDirectory $true
 $node=Join-Path $nodeDirectory 'node.exe';Assert-RelayRuntimePath $node $false
 $stream=[IO.File]::OpenRead($node);$sha=[Security.Cryptography.SHA256]::Create()
 try{$actualHash=([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}finally{$stream.Dispose();$sha.Dispose()}
 if($actualHash -cne $saved.nodeSha256){throw 'Relay private Node verification failed. Repair Relay using its official installer.'}
 $npm=Join-Path $nodeDirectory 'node_modules/npm/bin/npm-cli.js';Assert-RelayRuntimePath $npm $false
 $prefix=@($nodeDirectory)
 foreach($relative in @('providers/node_modules/@anthropic-ai/claude-code-win32-x64','providers/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin','providers/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/codex-path')){
  $candidate=Join-Path $runtime $relative
  if(Test-Path -LiteralPath $candidate){Assert-RelayRuntimePath $candidate $true;$prefix+=$candidate}
 }
 $path=($prefix+@($env:PATH)-join [IO.Path]::PathSeparator)
 return [pscustomobject]@{NodePath=$node;Path=$path;NodeVersion=$saved.nodeVersion}
}
