param([ValidateSet('guardian','gui-guardian','gui-wait','controller','discover-gui','inspect')][string]$Mode, [string]$SpecPath)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
if ($Mode -ne 'gui-guardian') {
  [Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
  [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
}
Add-Type -Path ([IO.Path]::Combine($PSScriptRoot, 'windows-lifecycle-native.cs'))
function Read-Record([string]$file, [int]$limit = 1048576) {
  $item = Get-Item -LiteralPath $file -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -gt $limit) { throw 'invalid-record' }
  return ([IO.File]::ReadAllText($file) | ConvertFrom-Json)
}
function Save-Record([string]$file, $value) {
  $temporary = $file + '.' + [Guid]::NewGuid().ToString() + '.tmp'
  $bytes = [Text.Encoding]::UTF8.GetBytes(($value | ConvertTo-Json -Compress -Depth 16))
  $stream = New-Object IO.FileStream($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
  try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
  [IO.File]::Move($temporary, $file)
}
function Owner($value) {
  $result = New-Object CruxLifecycleNative+Owner
  $result.pid = [int]$value.pid; $result.startedAt = [string]$value.startedAt
  $result.userId = [string]$value.userId; $result.executable = [string]$value.executable
  return $result
}
function Emit($value) { [Console]::Out.WriteLine(($value | ConvertTo-Json -Depth 12 -Compress)); [Console]::Out.Flush() }
$script:lastReason = 'native-failure'
function Failure-Facts($failure, [string]$phase) {
  $exception = $failure.Exception
  while ($exception.InnerException) { $exception = $exception.InnerException }
  $reason = switch -Exact ($exception.Message) {
    'identity-changed' { 'identity-changed' }
    'foreign-owner' { 'identity-changed' }
    'original-command-changed' { 'identity-changed' }
    'job-root-changed' { 'identity-changed' }
    'legacy-scope-changed' { 'scope-changed' }
    'legacy-child-without-witness' { 'unwitnessed-child' }
    'job-membership' { 'job-mismatch' }
    'job-root-membership' { 'job-mismatch' }
    'outer-job-membership' { 'job-mismatch' }
    'command-unavailable' { 'command-unavailable' }
    'ambiguous-gui-installation' { 'identity-changed' }
    'missing-job' { 'job-mismatch' }
    'exit-deadline' { $script:lastReason }
    'termination-refused' { $script:lastReason }
    default { 'native-failure' }
  }
  $facts = @{code='native-exit-unconfirmed'; phase=$phase; reason=$reason; line=$failure.InvocationInfo.ScriptLineNumber}
  if ($exception -is [ComponentModel.Win32Exception]) {
    $facts.nativeError = $exception.NativeErrorCode
    if ($exception.NativeErrorCode -eq 5) { $facts.reason = 'access-denied' }
  }
  return $facts
}
function Arguments($process) {
  return ,([CruxLifecycleNative]::Arguments($process))
}
function Same-Arguments($actual, $expected) {
  if ($actual.Count -ne $expected.Count) { return $false }
  for ($i=0; $i -lt $actual.Count; $i++) { if ($actual[$i] -cne $expected[$i]) { return $false } }
  return $true
}
if ($Mode -in @('guardian','gui-guardian')) {
  $guardian = $null
  try {
    $spec = Read-Record $SpecPath
    $nonce = [Guid]::Parse($spec.nonce).ToString()
    $prefix = if ($Mode -eq 'gui-guardian') { 'Global\CruxGui-' } else { 'Global\CruxDaemon-' }
    if ($spec.version -ne 1 -or $spec.jobName -cne ($prefix + $nonce)) { throw 'launch-scope' }
    if ($Mode -eq 'gui-guardian') {
      $guiController = [CruxLifecycleNative]::Capture((Owner $spec.controller))
      if (-not $guiController -or $guiController.owner.userId -cne $spec.identity.userId) { throw 'launch-scope' }
    }
    $guardian = New-Object CruxLifecycleNative+Guardian([string]$spec.jobName, [string]$spec.executable, [string[]]$spec.args, ($Mode -eq 'gui-guardian'))
    $proof = @{version=1; nonce=$nonce; jobName=$spec.jobName; identity=$spec.identity; root=$guardian.root.owner; guardian=[CruxLifecycleNative]::Inspect($PID)}
    if ($Mode -eq 'gui-guardian') { $proof.controller=$guiController.owner }
    Save-Record ([IO.Path]::Combine([IO.Path]::GetDirectoryName($SpecPath), 'proof.json')) $proof
    $guardian.Resume()
    while (-not $guardian.root.Exited -and (-not $spec.watchController -or -not $guiController.Exited)) { [Threading.Thread]::Sleep(50) }
    $guardian.job.Terminate()
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while (-not $guardian.job.Empty -and $clock.ElapsedMilliseconds -lt 10000) { [Threading.Thread]::Sleep(20) }
    Save-Record ([IO.Path]::Combine([IO.Path]::GetDirectoryName($SpecPath), 'exit.json')) @{version=1; nonce=$nonce; root=$proof.root; cleaned=$guardian.job.Empty}
  } catch {
    if ($SpecPath) { try { Save-Record ([IO.Path]::Combine([IO.Path]::GetDirectoryName($SpecPath), 'failure.json')) @{version=1; code='native-launch-failed'; diagnostic=(Failure-Facts $_ 'capture')} } catch {} }
    exit 71
  } finally { if ($guardian) { $guardian.Dispose() }; if ($guiController) { $guiController.Dispose() } }
  exit 0
}
if ($Mode -eq 'gui-wait') {
  $waitingRoot=$null; $waitingGuardian=$null; $waitingJob=$null
  try {
    $spec=Read-Record $SpecPath
    $proof=Read-Record ([IO.Path]::Combine([IO.Path]::GetDirectoryName($SpecPath), 'proof.json'))
    if ($proof.nonce -cne $spec.nonce -or $proof.jobName -cne ('Global\CruxGui-' + $spec.nonce)) { throw 'launch-scope' }
    $waitingRoot=[CruxLifecycleNative]::CaptureOriginal((Owner $proof.root),$true)
    $waitingGuardian=[CruxLifecycleNative]::CaptureOriginal((Owner $proof.guardian),$true)
    while ($waitingRoot -and -not $waitingRoot.Exited -and $waitingGuardian -and -not $waitingGuardian.Exited) { [Threading.Thread]::Sleep(100) }
    $waitingJob=[CruxLifecycleNative]::OpenJob([string]$proof.jobName)
    if ($waitingJob) { $waitingJob.Terminate() }
    $waiting=[Diagnostics.Stopwatch]::StartNew()
    while (($waitingRoot -and -not $waitingRoot.Exited) -or ($waitingJob -and -not $waitingJob.Empty)) {
      if ($waiting.ElapsedMilliseconds -gt 10000) { throw 'exit-deadline' }; [Threading.Thread]::Sleep(25)
    }
    Emit @{nonce=$spec.nonce; cleaned=$true}; exit 0
  } catch { Emit @{cleaned=$false}; exit 71 }
  finally { if ($waitingRoot) {$waitingRoot.Dispose()}; if ($waitingGuardian) {$waitingGuardian.Dispose()}; if ($waitingJob) {$waitingJob.Dispose()} }
}
$root = $null
$jobs = New-Object 'Collections.Generic.List[CruxLifecycleNative+CapturedJob]'
$helpers = New-Object 'Collections.Generic.List[CruxLifecycleNative+CapturedProcess]'
$watch = [Diagnostics.Stopwatch]::StartNew()
$script:operationDeadline = 8000L
$armedAt = -1L
$terminationMs = 10000
$disconnected = $false
try {
  $line = [Console]::In.ReadLine()
  if (-not $line -or $line.Length -gt 1048576) { throw 'capture-input' }
  $spec = $line | ConvertFrom-Json
  if ($Mode -eq 'discover-gui') {
    $candidates = @()
    $ambiguous = $false
    if ($spec.appPath) { $spec.appPath = [CruxLifecycleNative]::CanonicalPath([string]$spec.appPath) }
    $spec.userData = [CruxLifecycleNative]::CanonicalPath([string]$spec.userData)
    $executables = if ($spec.executables) { @($spec.executables) } else { @($spec.executable) }
    if ($executables.Count -lt 1 -or $executables.Count -gt 3) { throw 'identity-changed' }
    if ($spec.daemonOwner) {
      $discoveryBoot = [long][CruxLifecycleNative]::BootStartedAt()
      $historicalDaemon = [long]$spec.daemonOwner.startedAt -gt 0 -and [long]$spec.daemonOwner.startedAt -lt $discoveryBoot
      $daemon = if ($historicalDaemon) { $null } else { [CruxLifecycleNative]::Capture((Owner $spec.daemonOwner)) }
      try {
        # A protected historical lease remains a bounded image hint after its
        # root exits. Live original owners additionally prove their native argv;
        # every discovered GUI still needs independent full identity/scope proof.
        if ($daemon -and -not $daemon.Exited) {
          $daemonArguments = Arguments $daemon
          $daemonArgs = @($daemonArguments | Select-Object -Skip 1)
          if ($spec.appPath) {
            if ($daemonArgs.Count -ne 3 -or -not [IO.Path]::IsPathRooted($daemonArgs[0]) -or
              [CruxLifecycleNative]::CanonicalPath($daemonArgs[0]) -ine $spec.appPath) { throw 'original-command-changed' }
            $daemonArgs = @($daemonArgs | Select-Object -Skip 1)
          }
          if ($daemonArgs.Count -ne 2 -or $daemonArgs[0] -cne '--trellis-role=daemon' -or
            $daemonArgs[1] -cnotmatch '^--trellis-user-data-base64=[A-Za-z0-9+/=]+$') { throw 'original-command-changed' }
          $daemonProfile = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($daemonArgs[1].Substring('--trellis-user-data-base64='.Length)))
          if ([CruxLifecycleNative]::CanonicalPath($daemonProfile) -ine $spec.userData) { throw 'original-command-changed' }
        }
      } finally { if ($daemon) { $daemon.Dispose() } }
    }
    $owners = @()
    $seen = New-Object 'Collections.Generic.HashSet[int]'
    foreach ($image in $executables) {
      foreach ($found in [CruxLifecycleNative]::FindInstallationProcesses([string]$image)) {
        if ($seen.Add($found.pid)) { $owners += $found }
      }
    }
    foreach ($owner in $owners) {
      if ($owner.pid -eq $spec.excludePid) { continue }
      if ($spec.excludeOwner -and [CruxLifecycleNative]::Same((Owner $spec.excludeOwner), $owner)) { continue }
      $argumentOwner = [CruxLifecycleNative]::Capture($owner)
      if (-not $argumentOwner) { continue }
      try { if ($argumentOwner.Exited) { continue }; $argv = Arguments $argumentOwner } finally { $argumentOwner.Dispose() }
      if (-not $owner -or $owner.userId -cne $spec.userId) { continue }
      $tail = @($argv | Select-Object -Skip 1)
      $relativeEntry = $false
      if ($spec.appPath) {
        if ($tail.Count -eq 0) { continue }
        if ([IO.Path]::IsPathRooted($tail[0])) {
          if ([CruxLifecycleNative]::CanonicalPath($tail[0]) -ine $spec.appPath) { continue }
        } else {
          if ($tail[0] -notin @('.', './', '.\', 'out/main/index.js')) { continue }
          $relativeEntry = $true
        }
        $tail = @($tail | Select-Object -Skip 1)
      }
      $roles = @($tail | Where-Object { $_ -like '--trellis-role=*' })
      $profiles = @($tail | Where-Object { $_ -like '--trellis-user-data-base64=*' })
      $other = @($tail | Where-Object { $_ -notlike '--trellis-role=*' -and $_ -notlike '--trellis-user-data-base64=*' -and $_ -notmatch '^--trellis-gui-contained=[a-f0-9-]{36}$' -and $_ -notmatch '^--(remote-debugging-port|inspect|inspect-brk)=\d+$' -and $_ -ne '--no-sandbox' })
      if ($roles.Count -gt 1 -or ($roles.Count -eq 1 -and $roles[0] -cne '--trellis-role=gui') -or $profiles.Count -gt 1 -or $other.Count -ne 0) { continue }
      if ($profiles.Count -eq 1) {
        $profile = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($profiles[0].Substring('--trellis-user-data-base64='.Length)))
        if ([CruxLifecycleNative]::CanonicalPath($profile) -ine $spec.userData) { continue }
      } elseif (-not $spec.allowDefaultProfile) { $ambiguous = $true; continue }
      $captured = [CruxLifecycleNative]::Capture($owner)
      if ($captured) {
        try {
          if ($captured.Exited) { continue }
          if ($relativeEntry) {
            $matched = $spec.guiOwner -and [CruxLifecycleNative]::Same((Owner $spec.guiOwner), $captured.owner)
            $foreign = $false
            foreach ($childId in [CruxLifecycleNative]::Children($captured)) {
              $childOwner = [CruxLifecycleNative]::Inspect($childId)
              if (-not $childOwner -or $childOwner.userId -cne $owner.userId -or $childOwner.executable -ine $owner.executable) { continue }
              $child = [CruxLifecycleNative]::Capture($childOwner)
              if (-not $child) { continue }
              try {
                if ($child.Exited) { continue }
                $childArgs = Arguments $child
                if ($childArgs -cnotcontains '--type=renderer') { continue }
                $paths = @($childArgs | Where-Object { $_ -like '--app-path=*' })
                if ($paths.Count -ne 1) { continue }
                $application = $paths[0].Substring('--app-path='.Length)
                if (-not [IO.Path]::IsPathRooted($application)) { continue }
                if ([CruxLifecycleNative]::CanonicalPath($application) -ieq $spec.appPath) { $matched = $true } else { $foreign = $true }
              } finally { $child.Dispose() }
            }
            if ($foreign) { continue }
            if (-not $matched) { $ambiguous = $true; continue }
          }
          $candidates += @{owner=$owner; argv=$argv}
        } finally { $captured.Dispose() }
      }
    }
    if ($ambiguous) { throw 'ambiguous-gui-installation' }
    Emit @{candidates=@($candidates)}; exit 0
  }
  $expected = Owner $spec.root
  if ($expected.pid -le 0 -or $expected.userId -cne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { throw 'foreign-owner' }
  $bootStartedAt = [CruxLifecycleNative]::BootStartedAt()
  $beforeBoot = [long]$expected.startedAt -gt 0 -and [long]$expected.startedAt -lt [long]$bootStartedAt
  $script:rebootVerified = $false
  if ($spec.bootStartedAt) {
    if ($spec.bootStartedAt -cne $bootStartedAt -or -not $beforeBoot -or $spec.contained -or @($spec.jobs).Count -or @($spec.helpers).Count) { throw 'identity-changed' }
    # A kernel boot boundary proves the entire original process tree ended.
    # Do not open its PID: a current, unrelated process may now use it.
    $root = $null
    $script:rebootVerified = $true
  } elseif ($Mode -eq 'controller' -and $beforeBoot) {
    $root = $null
    $script:rebootVerified = $true
  } elseif ($Mode -eq 'inspect' -and $beforeBoot) {
    $root = $null
  } else {
    $root = [CruxLifecycleNative]::CaptureOriginal($expected, [bool]$spec.recovering)
  }
  if ($Mode -eq 'inspect') {
    $rootDetails = $null; $details = @()
    if ($root -and -not $root.Exited) {
      $rootDetails = @{owner=$root.owner; argv=(Arguments $root)}
      foreach ($childId in $(if ($spec.children -ceq $false) { @() } else { [CruxLifecycleNative]::Children($root) })) {
        $identity = [CruxLifecycleNative]::Inspect($childId)
        if (-not $identity) { continue }
        $child = [CruxLifecycleNative]::Capture($identity)
        if ($child) {
          try { if (-not $child.Exited) { $details += @{owner=$child.owner; argv=(Arguments $child)} } } finally { $child.Dispose() }
        }
      }
    }
    Emit @{root=$rootDetails; children=@($details); bootStartedAt=$bootStartedAt}; exit 0
  }
  if (-not $spec.contained -and $root -and -not $root.Exited -and -not (Same-Arguments (Arguments $root) $spec.argv)) { throw 'original-command-changed' }
  foreach ($entry in $(if ($script:rebootVerified) { @() } else { @($spec.jobs) })) {
    $job = [CruxLifecycleNative]::OpenJob([string]$entry.name)
    if ($job) { $jobs.Add($job) }
    foreach ($witness in @($entry.roots)) {
      if (-not $witness) { continue }
      $actual = [CruxLifecycleNative]::Inspect([int]$witness.pid)
      if (-not $actual) { continue }
      if (-not [CruxLifecycleNative]::SameBirth([string]$actual.startedAt, [string]$witness.startedAt)) {
        if ($spec.recovering) { continue }
        throw 'job-root-changed'
      }
      if ($actual.userId -cne $expected.userId) { throw 'job-root-changed' }
      $process = [CruxLifecycleNative]::Capture($actual)
      if ($process) {
        if (-not $process.Exited -and (-not $job -or -not $job.Contains($process))) { $process.Dispose(); throw 'job-root-membership' }
        $helpers.Add($process)
      }
    }
    foreach ($witness in @($entry.processes)) {
      if (-not $witness) { continue }
      $process = [CruxLifecycleNative]::CaptureOriginal((Owner $witness), [bool]$spec.recovering)
      if ($process) {
        if ($job -and -not $process.Exited -and -not $job.Contains($process)) { $process.Dispose(); throw 'job-membership' }
        if (-not $job -and -not $process.Exited) { $process.Dispose(); throw 'missing-job' }
        $helpers.Add($process)
      }
    }
  }
  foreach ($witness in $(if ($script:rebootVerified) { @() } else { @($spec.helpers) })) {
    if (-not $witness) { continue }
    $process = [CruxLifecycleNative]::CaptureOriginal((Owner $witness), [bool]$spec.recovering)
    if ($process) { $helpers.Add($process) }
  }
  if (-not $spec.contained) {
    # Windows can create a console host outside an ACP wrapper's child Job.
    # Capture only a system conhost with the exact retained wrapper as parent.
    $consoleParents = @($helpers.ToArray())
    if ($root) { $consoleParents += $root }
    foreach ($parent in $consoleParents) {
      foreach ($childId in [CruxLifecycleNative]::Children($parent)) {
        $actual = [CruxLifecycleNative]::Inspect($childId)
        if (-not $actual -or $actual.userId -cne $expected.userId -or $actual.executable -ine [IO.Path]::Combine($env:SystemRoot, 'System32\conhost.exe')) { continue }
        $console = [CruxLifecycleNative]::Capture($actual)
        if (-not $console) { continue }
        try { $argv = Arguments $console } catch { $console.Dispose(); throw }
        if ($argv.Count -ne 2 -or $argv[1] -notmatch '^0x[0-9a-fA-F]+$' -or [long]$actual.startedAt -lt [long]$parent.owner.startedAt) { $console.Dispose(); throw 'console-host-scope' }
        if ($console) { $helpers.Add($console) }
      }
    }
  }
  if ($spec.contained -and $root -and -not $root.Exited) {
    if ($jobs.Count -ne 1 -or -not $jobs[0].Contains($root)) { throw 'outer-job-membership' }
  }
  function Check-LegacyInventory {
    if ($spec.contained -or $script:rebootVerified) { return }
    $found = @()
    foreach ($kind in @('acp-jobs','workcopy-commands')) {
      $directory = [IO.Path]::Combine([string]$spec.directory, $kind)
      if (-not [IO.Directory]::Exists($directory)) { continue }
      $directories = [IO.Directory]::GetDirectories($directory)
      if ($directories.Length -gt 4096) { throw 'inventory-limit' }
      foreach ($childDirectory in $directories) {
        if ($watch.ElapsedMilliseconds -ge $script:operationDeadline) { throw 'exit-deadline' }
        $file = [IO.Path]::Combine($childDirectory, $(if ($kind -eq 'acp-jobs') {'owner.json'} else {'operation.json'}))
        if (-not [IO.File]::Exists($file)) { continue }
        $record = Read-Record $file
        if ($record.host -and [CruxLifecycleNative]::Same((Owner $record.host), $expected)) {
          $found += $file + '|' + (@($record.launches) -join ',')
        }
      }
    }
    if (-not (Same-Arguments @($found | Sort-Object) @($spec.inventory | Sort-Object))) { throw 'legacy-scope-changed' }
  }
  function Check-Coverage {
    if ($spec.contained) { return }
    $parents = @($helpers)
    if ($root) { $parents += $root }
    foreach ($parent in $parents) {
    foreach ($childId in [CruxLifecycleNative]::Children($parent)) {
      if ($watch.ElapsedMilliseconds -ge $script:operationDeadline) { throw 'exit-deadline' }
      $identity = [CruxLifecycleNative]::Inspect($childId)
      if (-not $identity) { continue }
      $child = [CruxLifecycleNative]::Capture($identity)
      if (-not $child) { continue }
      try {
        if ($child.Exited) { continue }
        $covered = $false
        foreach ($helper in $helpers) { if ([CruxLifecycleNative]::Same($helper.owner, $child.owner)) { $covered = $true; break } }
        if (-not $covered) { foreach ($job in $jobs) { if ($job.Contains($child)) { $covered = $true; break } } }
        if (-not $covered) { throw 'legacy-child-without-witness' }
      } finally { $child.Dispose() }
    }
    }
  }
  function Is-Exited {
    Check-LegacyInventory
    Check-Coverage
    if ($root -and -not $root.Exited) { $script:lastReason='root-alive'; return $false }
    foreach ($job in $jobs) { if (-not $job.Empty) { $script:lastReason='job-not-empty'; return $false } }
    foreach ($helper in $helpers) { if (-not $helper.Exited) { $script:lastReason='helper-alive'; return $false } }
    return $true
  }
  function Finish-Scope([bool]$terminate, [int]$budget) {
    $deadline = $watch.ElapsedMilliseconds + $budget
    $previousDeadline = $script:operationDeadline
    $script:operationDeadline = $deadline
    try {
    Check-LegacyInventory
    if ($terminate) {
      Check-Coverage
      $failed = $false
      foreach ($job in $jobs) { try { $job.Terminate() } catch { $failed = $true } }
      if ($root -and -not $spec.contained) { try { $root.Terminate() } catch { $failed = $true } }
      foreach ($helper in $helpers) { try { $helper.Terminate() } catch { $failed = $true } }
      # A concurrent normal exit may make TerminateProcess return ACCESS_DENIED.
      # The retained handles, not that racing request result, decide completion.
    }
    while (-not (Is-Exited)) {
      if (-not $terminate -and $script:armedAt -ge 0 -and $watch.ElapsedMilliseconds -ge $script:armedAt) {
        $script:armedAt = -1
        Finish-Scope $true ([Math]::Min($terminationMs, [Math]::Max(1, $deadline - $watch.ElapsedMilliseconds)))
      }
      if ($watch.ElapsedMilliseconds -ge $deadline) { if ($failed) { throw 'termination-refused' }; throw 'exit-deadline' }
      [Threading.Thread]::Sleep(20)
    }
    } finally { $script:operationDeadline = $previousDeadline }
  }
  Check-LegacyInventory
  Check-Coverage
  $script:operationDeadline = [long]::MaxValue
  Emit @{type='ready'; helpers=@($helpers | ForEach-Object { $_.owner }); exitedBeforeBoot=$script:rebootVerified}
  $pending = [CruxLifecycleNative]::ReadControlLine()
  while ($true) {
    if ($armedAt -ge 0 -and $watch.ElapsedMilliseconds -ge $armedAt) {
      $armedAt = -1
      try { Finish-Scope $true $terminationMs; Emit @{type='watchdog'; ok=$true} }
      catch { $facts=Failure-Facts $_ 'watchdog'; $facts.type='watchdog'; $facts.ok=$false; Emit $facts }
      if ($disconnected) { break }
    }
    if (-not $disconnected -and $pending.IsCompleted) {
      $line = $pending.Result
      if ($null -eq $line) { $disconnected = $true; if ($armedAt -lt 0) { break }; continue }
      if ($line.Length -gt 4096) { throw 'control-size' }
      $request = $line | ConvertFrom-Json
      try {
        switch ($request.operation) {
          'arm' {
            if ($request.graceMs -lt 0 -or $request.graceMs -gt 15000 -or $request.timeoutMs -lt 1 -or $request.timeoutMs -gt 10000) { throw 'deadline' }
            if ($armedAt -lt 0) { $armedAt = $watch.ElapsedMilliseconds + [int]$request.graceMs; $terminationMs = [int]$request.timeoutMs }
          }
          'disarm' { $armedAt = -1 }
          'dispose' { $armedAt = -1 }
          'terminate' { $armedAt = -1; if ($request.timeoutMs -lt 1 -or $request.timeoutMs -gt 10000) { throw 'deadline' }; Finish-Scope $true ([int]$request.timeoutMs) }
          'verify' { if ($request.timeoutMs -lt 1 -or $request.timeoutMs -gt 30000) { throw 'deadline' }; Finish-Scope $false ([int]$request.timeoutMs) }
          default { throw 'operation' }
        }
        Emit @{id=$request.id; ok=$true}
        if ($request.operation -eq 'dispose') { break }
      } catch { $facts=Failure-Facts $_ ([string]$request.operation); $facts.id=$request.id; $facts.ok=$false; Emit $facts }
      $pending = [CruxLifecycleNative]::ReadControlLine()
    }
    [Threading.Thread]::Sleep(15)
  }
} catch { $facts=Failure-Facts $_ 'capture'; $facts.type='failed'; Emit $facts; exit 71 }
finally {
  if ($root) { $root.Dispose() }
  foreach ($process in $helpers) { $process.Dispose() }
  foreach ($job in $jobs) { $job.Dispose() }
}
