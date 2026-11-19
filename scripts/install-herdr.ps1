param([string]$DestinationRoot = '')
$ErrorActionPreference = 'Stop'
Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Utility','Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop
Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Management','Microsoft.PowerShell.Management.psd1')) -ErrorAction Stop
Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Archive','Microsoft.PowerShell.Archive.psd1')) -ErrorAction Stop
if($PSVersionTable.PSVersion.Major -lt 6){$env:PSModulePath=(Join-Path $PSHOME 'Modules')+';'+$env:PSModulePath}
function Get-RelaySha256([string]$Path){$stream=[IO.File]::OpenRead($Path);$algorithm=[Security.Cryptography.SHA256]::Create();try{return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','').ToLowerInvariant()}finally{$stream.Dispose();$algorithm.Dispose()}}
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'dist\server\herdr\worker.js') -PathType Leaf)) {
  throw 'Build Relay first (npm run build); the compiled bridge worker is required before installing its runtime.'
}
if (-not [Environment]::Is64BitOperatingSystem -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
  throw 'This pinned Herdr package supports Windows x64 only.'
}
if (-not $DestinationRoot) { $DestinationRoot = Join-Path $projectRoot '.data-herdr-tools' }
$version = '0.9.5'
$releaseUrl = 'https://github.com/herdrdev/herdr/releases/download/v0.9.5/herdr-windows-x86_64.zip'
$archiveSha = 'd2c6c9c971c43a0bfdde8c692a9a1a7a45c3e4807cd01ae45662b4734fac1cbf'
$binarySha = 'cd877c8744296f4a38a2703bf13cf11728973649ec54959959c4587ffe5368b2'
$destination = Join-Path ([IO.Path]::GetFullPath($DestinationRoot)) $version
New-Item -ItemType Directory -Path $destination -Force | Out-Null
$archive = Join-Path $destination 'herdr-windows-x86_64.zip'
if (-not (Test-Path -LiteralPath $archive) -or (Get-RelaySha256 $archive) -ne $archiveSha) {
  Invoke-WebRequest -Uri $releaseUrl -OutFile $archive
}
if ((Get-RelaySha256 $archive) -ne $archiveSha) { throw 'Official Herdr archive checksum mismatch; refusing to extract or execute.' }
$existingBinary = Join-Path $destination 'herdr.exe'
if (Test-Path -LiteralPath $existingBinary) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($archive)
  try {
    foreach ($entry in $zip.Entries) {
      if ($entry.FullName.EndsWith('/')) { continue }
      $entryPath = [IO.Path]::GetFullPath((Join-Path $destination $entry.FullName))
      if (-not $entryPath.StartsWith($destination + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid archive entry path' }
      if (-not (Test-Path -LiteralPath $entryPath -PathType Leaf)) { throw 'Private runtime is incomplete; stop its private session and install into a fresh private destination.' }
      $stream = $entry.Open(); $sha = [Security.Cryptography.SHA256]::Create()
      try { $expected = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() } finally { $stream.Dispose(); $sha.Dispose() }
      if ((Get-RelaySha256 $entryPath) -ne $expected) { throw 'Private runtime differs from the pinned archive; install into a fresh private destination.' }
    }
  } finally { $zip.Dispose() }
} else {
  Expand-Archive -LiteralPath $archive -DestinationPath $destination
}
$binary = Join-Path $destination 'herdr.exe'
if ((Get-RelaySha256 $binary) -ne $binarySha) { throw 'Herdr binary checksum mismatch; refusing to execute.' }
$manifest = @{
  version = $version; releaseUrl = $releaseUrl; archiveSha256 = $archiveSha; binarySha256 = $binarySha
  scope = 'Private Relay runtime; no global PATH, hooks, profiles, or provider integrations changed'
  files = @(Get-ChildItem -LiteralPath $destination -File -Recurse | Where-Object { $_.Name -ne 'manifest.json' } | ForEach-Object {
    @{ path = $_.FullName.Substring($destination.Length+1); sha256 = (Get-RelaySha256 $_.FullName) }
  })
}
[IO.File]::WriteAllText((Join-Path $destination 'manifest.json'), ($manifest | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
Write-Output ('Verified private Herdr ' + $version + ': ' + $binary)
