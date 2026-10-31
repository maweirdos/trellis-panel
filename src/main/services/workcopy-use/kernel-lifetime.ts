import { execFile } from 'node:child_process'
import { z } from 'zod'
import { powershellPath } from '../../daemon/native'
import { DaemonError } from '../../daemon/errors'

export const kernelLifetimeSchema = z.object({
  systemStartedAt: z.string().regex(/^\d+$/), recordId: z.string().regex(/^\d+$/), startTime: z.string().min(1).max(100)
}).strict()
export type KernelLifetime = z.infer<typeof kernelLifetimeSchema>
let pending: Promise<KernelLifetime> | undefined
/** System's immutable birth plus a kernel-authored startup event, not wall-clock uptime. */
export function kernelLifetime(): Promise<KernelLifetime> {
  return pending ??= new Promise<KernelLifetime>((accept, reject) => {
    const script = String.raw`$ErrorActionPreference='Stop';$env:PSModulePath=Join-Path $PSHOME 'Modules';[Console]::OutputEncoding=[Text.Encoding]::UTF8
$process=Get-CimInstance Win32_Process -Filter 'ProcessId = 4'
$event=Get-WinEvent -FilterHashtable @{LogName='System';ProviderName='Microsoft-Windows-Kernel-General';Id=12} -MaxEvents 1
[xml]$xml=$event.ToXml();$system=$xml.Event.System
if($process.Name -ne 'System' -or !$process.CreationDate -or $system.Provider.Guid -ne '{a68ca8b7-004f-d7b6-a698-07e2de0f1f5d}' -or $system.Execution.ProcessID -ne '4' -or $system.Security.UserID -ne 'S-1-5-18' -or $system.Channel -ne 'System'){throw 'Kernel witness unavailable'}
$start=[string]($xml.Event.EventData.Data|Where-Object {$_.Name -eq 'StartTime'}).'#text'
if(!$start -or [Math]::Abs(($process.CreationDate.ToUniversalTime()-[DateTime]::Parse($start).ToUniversalTime()).TotalMinutes) -gt 10){throw 'Kernel witness is incoherent'}
@{systemStartedAt=[string]$process.CreationDate.ToUniversalTime().Ticks;recordId=[string]$event.RecordId;startTime=$start}|ConvertTo-Json -Compress`
    execFile(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 8000, maxBuffer: 4096, encoding: 'utf8' }, (error, stdout) => {
      if (error) { reject(new DaemonError('E_UNAVAILABLE', '无法核对原生 kernel 生命周期；旧执行登记已保留。')); return }
      try { accept(kernelLifetimeSchema.parse(JSON.parse(stdout.replace(/^\uFEFF/, '').trim()))) }
      catch { reject(new DaemonError('E_UNAVAILABLE', '原生 kernel 生命周期见证无效，未解除旧登记。')) }
    })
  }).catch(error => { pending = undefined; throw error })
}
export function kernelReplaced(original: KernelLifetime, current: KernelLifetime): boolean {
  return original.systemStartedAt !== current.systemStartedAt && original.startTime !== current.startTime && original.recordId !== current.recordId
}
