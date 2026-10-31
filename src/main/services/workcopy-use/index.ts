import { join } from 'node:path'
import { WorkcopyUseRegistry } from './registry'
import { DaemonError } from '../../daemon/errors'

let registry: WorkcopyUseRegistry | undefined
let stateDirectory: string | undefined
/** Installed only by the existing daemon composition root, before ACP admission. */
export function installWorkcopyUse(directory: string, assertOwner: () => void): WorkcopyUseRegistry {
  if (registry) throw new DaemonError('E_CONFLICT', '工作副本协调者已安装。')
  registry = new WorkcopyUseRegistry(join(directory, 'workcopy-use.json'), assertOwner)
  stateDirectory = directory
  return registry
}
export function workcopyUseDirectory(): string {
  if (!stateDirectory) throw new DaemonError('E_UNAVAILABLE', '原生工作副本状态目录尚未安装。')
  return stateDirectory
}
export function workcopyUseRegistry(): WorkcopyUseRegistry {
  if (!registry) throw new DaemonError('E_UNAVAILABLE', '工作副本协调者尚未准备好，未接纳执行。')
  return registry
}
export { resolveWorkcopy, assertWorkcopyObservation } from './identity'
export { WorkcopyUseConflict } from './registry'
