import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readBounded, writeExclusiveAtomic } from '../../daemon/files'
import { DaemonError } from '../../daemon/errors'
import { WINDOWS_WORKCOPY_COMMAND } from './windows-command'

/** Shared fixed launcher for Git/CLI and native ACP transports. */
export function workcopyJobLauncher(directory: string): string {
  const digest = createHash('sha256').update(WINDOWS_WORKCOPY_COMMAND).digest('hex')
  const file = join(directory, `workcopy-command-${digest}.ps1`)
  if (!existsSync(file)) {
    try { writeExclusiveAtomic(file, WINDOWS_WORKCOPY_COMMAND) }
    catch (error) { if (!existsSync(file)) throw error }
  }
  if (readBounded(file, 64 * 1024) !== WINDOWS_WORKCOPY_COMMAND) throw new DaemonError('E_DENIED', '原生命令容器内容无法核对。')
  return file
}
