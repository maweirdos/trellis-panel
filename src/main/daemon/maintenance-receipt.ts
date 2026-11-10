import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { lstatSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import type { LifecycleAttempt } from '../services/daemon-client/lifecycle'
import { DaemonError } from './errors'
import { writeExclusiveAtomic } from './files'

/** The original uninstaller receives both identities: stop IDs remain stable
 * across retries, so an older target's receipt must not reconcile a new target. */
export function writeMaintenanceReceipt(file: string, attempt: Pick<LifecycleAttempt, 'attemptId' | 'targetBuild'>): void {
  z.object({ attemptId: z.string().uuid(), targetBuild: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(attempt)
  if (!isAbsolute(file) || file.length > 4096 || file.includes('\0') || basename(file) !== 'crux-lifecycle-receipt.txt' || lstatSync(dirname(file)).isSymbolicLink()) throw new DaemonError('E_INVALID_ARG', '安装交接回执路径无效。')
  const directory = realpathSync.native(dirname(file)), temporary = realpathSync.native(tmpdir())
  const delta = relative(temporary, directory)
  if (!delta || isAbsolute(delta) || delta === '..' || delta.startsWith(`..${sep}`)) throw new DaemonError('E_DENIED', '安装交接回执必须位于本机临时目录的独立子目录。')
  writeExclusiveAtomic(join(directory, basename(file)), `${attempt.attemptId}:${attempt.targetBuild}\r\n`)
}
