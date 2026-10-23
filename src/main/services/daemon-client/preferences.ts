import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { daemonPreferencesSchema, type DaemonPreferences } from '../../../shared/daemon'
import { readBounded } from '../../daemon/files'
import { daemonClientContext } from './manager'
/** Read-only management preference projection; never writes the daemon ledger or application settings. */
export async function readDaemonLaunchPreferences(): Promise<DaemonPreferences> {
  const context = await daemonClientContext(), path = join(context.directory, 'integration-ledger.json')
  if (!existsSync(path)) return { revision: 1, keepRunning: true, startup: 'client' }
  const value: unknown = JSON.parse(readBounded(path, 8 * 1024 * 1024))
  if (!value || typeof value !== 'object' || !('preferences' in value)) throw new Error('后台启动设置不可读取；原文件已保留')
  return daemonPreferencesSchema.parse(value.preferences)
}
