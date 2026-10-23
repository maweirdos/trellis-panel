param([Parameter(Mandatory=$true)][ValidateSet('protect','unprotect')][string]$Operation)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false, $true)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false, $true)
$bytes = $null
$result = $null
$entropy = $null
$characters = New-Object char[] 24000
$failed = $false
try {
  Add-Type -AssemblyName System.Security
  # The caller closes its private stdin after one canonical bounded frame. Do
  # not use ReadLine/ReadToEnd, which allocate before enforcing a capacity.
  $length = 0
  while ($true) {
    $next = [Console]::In.Read()
    if ($next -eq 10) { break }
    if ($next -lt 0 -or $length -ge $characters.Length) { throw 'Invalid protection frame' }
    $characters[$length] = [char]$next
    $length++
  }
  if ([Console]::In.Read() -ne -1) { throw 'Trailing protection frame' }
  $line = [string]::new($characters, 0, $length)
  # Canonical shape rejects duplicate/unknown fields and type coercion before
  # any OS key operation. The operation must match the fixed launch argument.
  $pattern = '\A\{"version":1,"nonce":"([a-f0-9]{64})","operation":"(protect|unprotect)","value":"([A-Za-z0-9+/]+={0,2})","entropy":"([a-f0-9]{64}|)"\}\z'
  $frame = [regex]::Match($line, $pattern)
  if (-not $frame.Success -or $frame.Groups[2].Value -cne $Operation) { throw 'Invalid protection fields' }
  $bytes = [Convert]::FromBase64String($frame.Groups[3].Value)
  if ($bytes.Length -lt 1 -or $bytes.Length -gt 16384 -or [Convert]::ToBase64String($bytes) -cne $frame.Groups[3].Value) { throw 'Protection capacity or encoding' }
  if ($frame.Groups[4].Value) { $entropy = [Text.Encoding]::UTF8.GetBytes($frame.Groups[4].Value) }
  if ($Operation -eq 'protect') {
    if ($bytes.Length -ne 32 -or $null -eq $entropy) { throw 'Only profile keys may be protected' }
    $result = [Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    if ($result.Length -lt 1 -or $result.Length -gt 16384) { throw 'Invalid protected key length' }
  } else {
    $result = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    if ($result.Length -ne 32) { throw 'Invalid profile key length' }
  }
  [ordered]@{version=1; nonce=$frame.Groups[1].Value; operation=$Operation; ok=$true; value=[Convert]::ToBase64String($result)} | ConvertTo-Json -Compress
} catch {
  # No inputs, key bytes, plaintext or arbitrary exception messages on failure.
  [Console]::Out.WriteLine('{"ok":false}')
  $failed = $true
} finally {
  if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
  if ($null -ne $result) { [Array]::Clear($result, 0, $result.Length) }
  if ($null -ne $entropy) { [Array]::Clear($entropy, 0, $entropy.Length) }
  [Array]::Clear($characters, 0, $characters.Length)
  $line = $null
  $frame = $null
}
if ($failed) { exit 1 }
