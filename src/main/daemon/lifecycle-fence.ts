import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { DaemonContext } from './context'
import { readBounded } from './files'
import { DaemonError } from './errors'
import { currentDaemonBuild } from './build-identity'

/** Shared by GUI start, role startup and stale-lease recovery. A dead root alone
 * never releases an unfinished lifecycle's child-process/GUI verification. */
export function assertLifecycleReleased(context: DaemonContext, verifyingAttemptId?: string): void {
  const file = join(context.directory, 'lifecycle-attempt.json')
  if (!existsSync(file)) {
    if (existsSync(join(context.directory, 'lifecycle-lock'))) throw new DaemonError('E_BUSY', '原退出控制器正在固定目标，暂不能建立新后台。')
    return
  }
  const attempt = z.object({ attemptId: z.string().uuid(), phase: z.string(), reason: z.string(), targetBuild: z.string(), profileId: z.string(), installationId: z.string() }).passthrough().parse(JSON.parse(readBounded(file, 32 * 1024)))
  if (attempt.profileId !== context.identity.profileId || attempt.installationId !== context.identity.installationId) throw new DaemonError('E_DENIED', '退出交接记录不属于当前安装。')
  if (attempt.phase === 'released') {
    if (attempt.reason === 'upgrade' && currentDaemonBuild().sha256 !== attempt.targetBuild) throw new DaemonError('E_UNAVAILABLE', '安装交接已就绪，等待新版程序文件安装完成。')
    return
  }
  if (attempt.phase === 'cancelled') return
  if (verifyingAttemptId === attempt.attemptId && attempt.phase === 'verifying' && existsSync(join(context.directory, 'lifecycle-lock'))) return
  throw new DaemonError('E_UNAVAILABLE', '原退出请求尚未完成进程范围核验；不能启动第二个后台。')
}
