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
  Add-Type -Path ([IO.Path]::Combine($PSScriptRoot, 'windows-lifecycle-native.cs'))
  if ($spec.controller.userId -cne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -or
      [CruxLifecycleNative]::CanonicalPath([string]$spec.controller.executable) -ine [CruxLifecycleNative]::CanonicalPath([string]$spec.executable)) { throw 'launch-owner' }
  $guardian = [CruxLifecycleNative]::Detach(([IO.Path]::Combine($PSHOME, 'powershell.exe')), [string[]]@('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
    [IO.Path]::Combine($PSScriptRoot, 'windows-lifecycle.ps1'),'-Mode','gui-guardian','-SpecPath',$SpecPath))
  @{guardian=$guardian} | ConvertTo-Json -Depth 5 -Compress
  exit 0
} catch { [Console]::Out.WriteLine('{"code":"gui-launch-unconfirmed"}'); exit 1 }
