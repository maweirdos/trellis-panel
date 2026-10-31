import type { AcpProcessLaunch } from 'acpx/runtime'
import type { SpawnOptions } from 'node:child_process'
import { DaemonError } from '../../daemon/errors'
import type { AcpJobOwner } from './acp-jobs'

export class OwnedProbeCleanupError extends DaemonError {
  constructor() { super('E_UNKNOWN', '原版本探测 Job 清理未确认，不能继续启动执行器；请重试原清理。', 'unknown') }
}
/** Auxiliary executables get their own launch nonce and cannot escape the session's cleanup. */
export async function runOwnedProbe(owner: AcpJobOwner, launch: AcpProcessLaunch, options: SpawnOptions, timeoutMs = 5000): Promise<{ code: number; stdout: string }> {
  const child = owner.spawn(launch, options)
  const chunks: Buffer[] = []
  let count = 0, timer: ReturnType<typeof setTimeout> | undefined
  const result = new Promise<{ code: number; stdout: string }>((accept, reject) => {
    child.stdout?.on('data', (chunk: Buffer) => { count += chunk.length; if (count <= 4096) chunks.push(chunk); else reject(new Error('版本探测输出超过上限')) })
    child.stderr?.resume()
    child.once('error', reject)
    child.once('close', code => accept({ code: code ?? -1, stdout: Buffer.concat(chunks).toString('utf8') }))
    timer = setTimeout(() => reject(new Error('版本探测超时')), timeoutMs)
  })
  void result.catch(() => {})
  try {
    if (!child.pid) throw new Error('版本探测未能启动')
    await owner.spawned({ ...launch, pid: child.pid, startedAt: new Date().toISOString() })
    return await result
  } finally {
    if (timer) clearTimeout(timer)
    try { await owner.cleanupLaunch(launch.launchId) } catch { throw new OwnedProbeCleanupError() }
  }
}
