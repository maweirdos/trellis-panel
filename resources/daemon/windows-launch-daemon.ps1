param([string]$SpecPath)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
try {
  $spec = [IO.File]::ReadAllText($SpecPath) | ConvertFrom-Json
  $arguments = [string[]]$spec.args
  if ($spec.version -ne 1 -or -not [IO.Path]::IsPathRooted($spec.executable) -or -not [IO.File]::Exists($spec.executable) -or $arguments.Count -lt 2 -or $arguments.Count -gt 3) { throw 'Invalid native launch' }
  if ($arguments[-2] -cne '--trellis-role=daemon' -or $arguments[-1] -cnotmatch '^--trellis-user-data-base64=[A-Za-z0-9+/=]+$') { throw 'Invalid daemon arguments' }
  Add-Type -Path ([IO.Path]::Combine($PSScriptRoot, 'windows-lifecycle-native.cs'))
  $powershell = [IO.Path]::Combine($PSHOME, 'powershell.exe')
  $guardian = [CruxLifecycleNative]::Detach($powershell, [string[]]@('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
    [IO.Path]::Combine($PSScriptRoot, 'windows-lifecycle.ps1'),'-Mode','guardian','-SpecPath',$SpecPath), $true)
  $directory = [IO.Path]::GetDirectoryName($SpecPath)
  $watch = [Diagnostics.Stopwatch]::StartNew()
  do {
    $proofFile = [IO.Path]::Combine($directory, 'proof.json')
    if ([IO.File]::Exists($proofFile)) {
      $proof = [IO.File]::ReadAllText($proofFile) | ConvertFrom-Json
      if ($proof.nonce -cne $spec.nonce -or $proof.guardian.pid -ne $guardian.pid -or $proof.guardian.startedAt -cne $guardian.startedAt) { throw 'Launch witness mismatch' }
      @{pid=[int]$proof.root.pid} | ConvertTo-Json -Compress
      exit 0
    }
    if ([IO.File]::Exists([IO.Path]::Combine($directory, 'failure.json'))) { throw 'Guardian failed' }
    [Threading.Thread]::Sleep(25)
  } while ($watch.ElapsedMilliseconds -lt 8000)
  throw 'Launch witness timed out'
} catch { [Console]::Out.WriteLine('{"state":"unavailable","code":"native-launch-unconfirmed"}'); exit 1 }
