param([ValidateSet('identity','secure-directory')][string]$Operation, [int]$ProcessId, [string]$DirectoryBase64)
$ErrorActionPreference = 'Stop'
# GUI launchers may inherit PowerShell 7's module search path. This adapter runs
# Windows PowerShell 5.1: resolve only its own inbox modules, never Core/user ones.
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
[Console]::OutputEncoding = [Text.Encoding]::UTF8
try {
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  if ($Operation -eq 'secure-directory') {
    $targetDirectory = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($DirectoryBase64))
    $item = Get-Item -LiteralPath $targetDirectory -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse directory denied' }
    # Change only the DACL on a directory we already own. Rebuilding an entire
    # descriptor and rewriting ownership can require privileges a normal GUI
    # process does not have; never take ownership of another user's directory.
    $security = Get-Acl -LiteralPath $targetDirectory
    if ($security.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Directory owner mismatch' }
    $security.SetAccessRuleProtection($true, $false)
    foreach ($existing in @($security.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))) {
      $security.RemoveAccessRuleSpecific($existing)
    }
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $security.AddAccessRule($rule)
    [IO.Directory]::SetAccessControl($targetDirectory, $security)
    $verified = Get-Acl -LiteralPath $targetDirectory
    $verifiedRules = @($verified.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if (-not $verified.AreAccessRulesProtected -or $verified.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or $verifiedRules.Count -ne 1 -or $verifiedRules[0].IdentityReference.Value -ne $sid.Value -or $verifiedRules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or ($verifiedRules[0].FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl) { throw 'Directory protection verification failed' }
    [Console]::Out.WriteLine('{"ok":true}')
  } else {
    $targetProcess = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $ProcessId)
    if ($null -eq $targetProcess) { [Console]::Out.WriteLine('{"state":"absent"}'); exit 0 }
    $owner = Invoke-CimMethod -InputObject $targetProcess -MethodName GetOwnerSid
    if ($owner.ReturnValue -ne 0 -or -not $targetProcess.ExecutablePath) { throw 'Identity unavailable' }
    @{state='present'; owner=@{pid=[int]$targetProcess.ProcessId; startedAt=[string]$targetProcess.CreationDate.ToUniversalTime().Ticks; userId=$owner.Sid; executable=$targetProcess.ExecutablePath}} | ConvertTo-Json -Compress -Depth 3
  }
} catch {
  # Exception class/HRESULT are diagnostics, never serialize paths or payloads.
  $missingCommand = $null
  if ($_.Exception -is [Management.Automation.CommandNotFoundException] -and $_.Exception.CommandName -match '^[A-Za-z][A-Za-z0-9-]{0,79}$') { $missingCommand = $_.Exception.CommandName }
  $nativeException = $_.Exception
  for ($depth = 0; $depth -lt 4 -and $null -ne $nativeException.InnerException; $depth++) { $nativeException = $nativeException.InnerException }
  @{state='unavailable'; operation=$Operation; exception=$nativeException.GetType().Name; hresult=$nativeException.HResult; command=$missingCommand; line=$_.InvocationInfo.ScriptLineNumber} | ConvertTo-Json -Compress
  exit 1
}
