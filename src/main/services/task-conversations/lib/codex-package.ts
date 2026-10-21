import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { z } from 'zod'
import type { LaunchTarget } from '../types'
import { TaskConversationError } from '../types'
import { windowsPowerShellEnvironment } from './windows-launch'
import { CODEX_PACKAGE_FAMILY, createCodexPackageProbeCache, type VerifiedCodexPackage } from './codex-package-cache'

export { CODEX_PACKAGE_FAMILY } from './codex-package-cache'
const PACKAGE_PUBLISHER = 'CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B'
const execute = promisify(execFile)
const PRELUDE = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue';
Add-Type -AssemblyName System.Runtime.WindowsRuntime;
$null=[Windows.System.Launcher,Windows.System,ContentType=WindowsRuntime];
$taskAsyncMethod=[System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
 $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetGenericArguments().Length -eq 1 -and
 $_.GetParameters().Length -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
} | Select-Object -First 1;
if ($null -eq $taskAsyncMethod) { throw 'WinRT task adapter unavailable' };`

function invocation(script: string): { executable: string; args: string[] } {
  return { executable: join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] }
}
/** Read-only package/catalog/signature/URI-support checks. This script never activates an app. */
export function codexPackageProbeInvocation(): { executable: string; args: string[] } {
  return invocation(`${PRELUDE}
$taskPackages=@(Get-AppxPackage -Name OpenAI.Codex | Where-Object {
 $_.PackageFamilyName -eq '${CODEX_PACKAGE_FAMILY}' -and $_.Publisher -eq '${PACKAGE_PUBLISHER}' -and
 $_.Status.ToString() -eq 'Ok' -and $_.SignatureKind.ToString() -eq 'Store'
});
if ($taskPackages.Count -ne 1) { throw 'Verified Codex package unavailable' };
$taskPackage=$taskPackages[0];
$taskManifestFile=Join-Path $taskPackage.InstallLocation 'AppxManifest.xml';
if ((Get-Item -LiteralPath $taskManifestFile).Length -gt 1048576) { throw 'Manifest exceeds read budget' };
[xml]$taskManifest=Get-Content -LiteralPath $taskManifestFile -Raw;
if ($taskManifest.Package.Identity.Publisher -ne '${PACKAGE_PUBLISHER}') { throw 'Unexpected manifest publisher' };
$taskApps=@($taskManifest.Package.Applications.Application | Where-Object {
 @($_.Extensions.Extension | Where-Object { $_.Category -eq 'windows.protocol' -and $_.Protocol.Name -eq 'codex' -and
 $_.Protocol.Parameters -eq '--single-argument %1' }).Count -eq 1
});
if ($taskApps.Count -ne 1 -or $taskApps[0].EntryPoint -ne 'Windows.FullTrustApplication') { throw 'Ambiguous Codex protocol registration' };
$taskRelative=$taskApps[0].Executable.Replace('/',[IO.Path]::DirectorySeparatorChar);
if ([IO.Path]::IsPathRooted($taskRelative) -or $taskRelative.Split([IO.Path]::DirectorySeparatorChar) -contains '..') { throw 'Invalid package executable' };
$taskExe=Join-Path $taskPackage.InstallLocation $taskRelative;
if ([Diagnostics.FileVersionInfo]::GetVersionInfo($taskExe).ProductName -ne 'Codex') { throw 'Unexpected executable product' };
$taskSignature=Get-AuthenticodeSignature -LiteralPath $taskExe;
if ($taskSignature.Status.ToString() -ne 'Valid' -or $taskSignature.SignerCertificate.Subject -notmatch 'O="OpenAI OpCo, LLC"') { throw 'Unverified OpenAI executable signature' };
$null=[Windows.System.LaunchQuerySupportType,Windows.System,ContentType=WindowsRuntime];
$null=[Windows.System.LaunchQuerySupportStatus,Windows.System,ContentType=WindowsRuntime];
$taskOperation=[Windows.System.Launcher]::QueryUriSupportAsync([Uri]'codex://threads/00000000-0000-0000-0000-000000000000',[Windows.System.LaunchQuerySupportType]::Uri,'${CODEX_PACKAGE_FAMILY}');
$taskAwaitable=$taskAsyncMethod.MakeGenericMethod([Windows.System.LaunchQuerySupportStatus]).Invoke($null,@($taskOperation));
if (-not $taskAwaitable.Wait(2000) -or $taskAwaitable.Result.ToString() -ne 'Available') { throw 'Codex package URI unsupported' };
@{packageFamilyName='${CODEX_PACKAGE_FAMILY}';verified=$true} | ConvertTo-Json -Compress;`)
}
const probeSchema = z.object({ packageFamilyName: z.literal(CODEX_PACKAGE_FAMILY), verified: z.literal(true) })
async function readCodexPackage(): Promise<VerifiedCodexPackage | null> {
  try {
    const call = codexPackageProbeInvocation()
    const result = await execute(call.executable, call.args, { windowsHide: true, timeout: 7000, maxBuffer: 32 * 1024, env: windowsPowerShellEnvironment() })
    const parsed = probeSchema.parse(JSON.parse(result.stdout.trim()))
    return { packageFamilyName: parsed.packageFamilyName }
  } catch { return null }
}
const packageProbe = createCodexPackageProbeCache(readCodexPackage)
/** Discovery and repeated open preflights share this fixed-package, bounded TTL cache. */
export function probeCodexPackage(): Promise<VerifiedCodexPackage | null> { return packageProbe.read() }
/** Documented LauncherOptions target; URI/session ID is identical to the normal protocol route. */
export function codexPackageLaunchInvocation(target: Extract<LaunchTarget, { kind: 'packaged-protocol' }>): { executable: string; args: string[] } {
  if (target.packageFamilyName !== CODEX_PACKAGE_FAMILY || !/^codex:\/\/threads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target.url)) {
    throw new TaskConversationError('E_INVALID_ARG', 'Codex 安装包或会话 URI 无效')
  }
  // TargetApplicationPackageFamilyName is the official Windows packaged URI routing option.
  // https://learn.microsoft.com/uwp/api/windows.system.launcheroptions.targetapplicationpackagefamilyname
  return invocation(`${PRELUDE}
$null=[Windows.System.LauncherOptions,Windows.System,ContentType=WindowsRuntime];
$taskOptions=New-Object Windows.System.LauncherOptions;
$taskOptions.TargetApplicationPackageFamilyName='${CODEX_PACKAGE_FAMILY}';
$taskOperation=[Windows.System.Launcher]::LaunchUriAsync([Uri]'${target.url}',$taskOptions);
$taskAwaitable=$taskAsyncMethod.MakeGenericMethod([bool]).Invoke($null,@($taskOperation));
if (-not $taskAwaitable.Wait(5000) -or -not $taskAwaitable.Result) { throw 'Codex package activation was not accepted' };
@{launched=$true} | ConvertTo-Json -Compress;`)
}
export async function launchCodexPackage(target: Extract<LaunchTarget, { kind: 'packaged-protocol' }>): Promise<void> {
  const call = codexPackageLaunchInvocation(target)
  try {
    const result = await execute(call.executable, call.args, { windowsHide: true, timeout: 8000, maxBuffer: 32 * 1024, env: windowsPowerShellEnvironment() })
    z.object({ launched: z.literal(true) }).parse(JSON.parse(result.stdout.trim()))
  } catch {
    packageProbe.invalidate()
    throw new TaskConversationError('E_UNAVAILABLE', 'Codex 未确认接受打开请求，请检查客户端是否仍已安装并重试')
  }
}
