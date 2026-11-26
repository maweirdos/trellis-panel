param([string]$SpecPath)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
try {
  $spec = [IO.File]::ReadAllText($SpecPath) | ConvertFrom-Json
  $nonce = [Guid]::Parse($spec.nonce).ToString()
  if ($spec.version -ne 1 -or $spec.jobName -cne ('Global\CruxGui-' + $nonce)) { throw 'launch-scope' }
  $guiArguments = [string[]]$spec.args
  if (-not [IO.Path]::IsPathRooted($spec.executable) -or -not [IO.File]::Exists($spec.executable) -or $guiArguments.Count -lt 2 -or $guiArguments.Count -gt 256) { throw 'launch-arguments' }
  if (@($guiArguments | Where-Object { $_ -like '--trellis-role=*' }).Count -ne 1 -or $guiArguments -cnotcontains '--trellis-role=gui' -or
      @($guiArguments | Where-Object { $_ -like '--trellis-gui-contained=*' }).Count -ne 1 -or $guiArguments -cnotcontains ('--trellis-gui-contained=' + $nonce)) { throw 'launch-role' }
  $nativeSourceFile = [IO.Path]::Combine($PSScriptRoot, 'windows-lifecycle-native.cs')
  $nativeLoaded = $false
  try {
    $modeDir = [IO.Path]::GetDirectoryName([IO.Path]::GetDirectoryName([IO.Path]::GetDirectoryName($SpecPath)))
    if ($modeDir -and [IO.Directory]::Exists($modeDir)) {
      $nativeCacheRoot = [IO.Path]::Combine($modeDir, 'native-cache')
      if (-not [IO.Directory]::Exists($nativeCacheRoot)) { [void][IO.Directory]::CreateDirectory($nativeCacheRoot) }
      if (([IO.File]::GetAttributes($nativeCacheRoot) -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
        $sha = [Security.Cryptography.SHA256]::Create()
        try {
          $rawBytes = [IO.File]::ReadAllBytes($nativeSourceFile)
          $metaBytes = [Text.Encoding]::UTF8.GetBytes('|' + [Environment]::Version.ToString() + '|' + [IntPtr]::Size)
          $allBytes = New-Object byte[] ($rawBytes.Length + $metaBytes.Length)
          [Buffer]::BlockCopy($rawBytes, 0, $allBytes, 0, $rawBytes.Length)
          [Buffer]::BlockCopy($metaBytes, 0, $allBytes, $rawBytes.Length, $metaBytes.Length)
          $nativeHash = ([BitConverter]::ToString($sha.ComputeHash($allBytes))).Replace('-', '').ToLowerInvariant()
        } finally { $sha.Dispose() }
        $nativeDll = [IO.Path]::Combine($nativeCacheRoot, 'crux-lifecycle-' + $nativeHash + '.dll')
        if (-not [IO.File]::Exists($nativeDll)) {
          $tmpDll = $nativeDll + '.' + [Guid]::NewGuid().ToString('N') + '.tmp.dll'
          try {
            Add-Type -Path $nativeSourceFile -OutputAssembly $tmpDll -OutputType Library
            try { [IO.File]::Move($tmpDll, $nativeDll) } catch { if ([IO.File]::Exists($tmpDll)) { [IO.File]::Delete($tmpDll) } }
          } catch { if ([IO.File]::Exists($tmpDll)) { try { [IO.File]::Delete($tmpDll) } catch {} } }
        }
        if ([IO.File]::Exists($nativeDll) -and (([IO.File]::GetAttributes($nativeDll) -band [IO.FileAttributes]::ReparsePoint) -eq 0)) {
          [void][Reflection.Assembly]::LoadFrom($nativeDll)
          $nativeLoaded = $true
        }
      }
    }
  } catch {}
  if (-not $nativeLoaded) { Add-Type -Path $nativeSourceFile }
  if ($spec.controller.userId -cne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -or
      [CruxLifecycleNative]::CanonicalPath([string]$spec.controller.executable) -ine [CruxLifecycleNative]::CanonicalPath([string]$spec.executable)) { throw 'launch-owner' }
  $guardian = [CruxLifecycleNative]::Detach(([IO.Path]::Combine($PSHOME, 'powershell.exe')), [string[]]@('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
    [IO.Path]::Combine($PSScriptRoot, 'windows-lifecycle.ps1'),'-Mode','gui-guardian','-SpecPath',$SpecPath))
  @{guardian=$guardian} | ConvertTo-Json -Depth 5 -Compress
  exit 0
} catch { [Console]::Out.WriteLine('{"code":"gui-launch-unconfirmed"}'); exit 1 }
