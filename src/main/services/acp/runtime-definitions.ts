import type { AcpAgentConfig, AcpSessionRecord } from '../../../shared/types'
import { BUILTINS, BUNDLED, NATIVES, type BuiltinId, type BundledId, type NativeId } from './runtime-catalog'
import { validateLocalProviderSnapshot } from './local-providers'

export { BUILTINS, BUNDLED, NATIVES } from './runtime-catalog'
export type { BuiltinId, BundledId, NativeId } from './runtime-catalog'

export function isManaged(config: AcpAgentConfig): config is AcpAgentConfig & { id: BuiltinId } {
  if (!Object.hasOwn(BUILTINS, config.id) || config.launchKind === 'custom') return false
  const spec = BUILTINS[config.id as BuiltinId]
  return (config.launchKind === 'managed' || config.launchKind === undefined)
    && config.command === `${spec.packageName}@${spec.version}` && !config.executable && !config.args?.length
}
export function isNative(config: AcpAgentConfig): config is AcpAgentConfig & { id: NativeId } {
  if (config.launchKind !== 'native' || !Object.hasOwn(NATIVES, config.id)) return false
  const spec = NATIVES[config.id as NativeId]
  return config.command === [spec.commandName, ...spec.launchArgs].join(' ') && !config.executable && !config.args?.length
}
export function isBundled(config: AcpAgentConfig): config is AcpAgentConfig & { id: BundledId } {
  return config.launchKind === 'bundled' && Object.hasOwn(BUNDLED, config.id)
    && config.command === 'bundled ACP bridge（随应用提供）' && !config.executable && !config.args?.length
}
export function isSupportedRuntimeSnapshot(config: AcpAgentConfig, userData: string): boolean {
  return isManaged(config) || isNative(config) || isBundled(config)
    || config.id === 'pi' && config.launchKind === 'sdk' && /^Pi SDK \S+$/.test(config.command)
      && !config.executable && !config.args?.length
    || (config.launchKind === 'local' ? !!validateLocalProviderSnapshot(userData, config) : false)
}

export function isRecoverableRuntimeRecord(meta: Pick<AcpSessionRecord, 'agentId' | 'engine' | 'runtimeSnapshot'>, legacyIds: readonly string[], userData: string): boolean {
  const config = meta.runtimeSnapshot
  return !!config && isSupportedRuntimeSnapshot(config, userData) && config.id === meta.agentId
    && (meta.engine ?? 'acp') === (config.launchKind === 'sdk' ? 'pi' : 'acp')
    && (config.launchKind !== undefined || !legacyIds.includes(config.id))
}

/** Bind the saved runtime's original launch to the admitted argv. */
export function matchesRuntimeRecordLaunch(record: { agentCommand: string; agentArgv?: string[] }, argv: readonly string[]): boolean {
  return record.agentCommand === runtimeArgvIdentity(argv) && (!record.agentArgv
    || record.agentArgv.length === argv.length && record.agentArgv.every((arg, index) => arg === argv[index]))
}

export function runtimeArgvIdentity(argv: readonly string[]): string {
  return argv.map(arg => /^[A-Za-z0-9_@%+=:,./^~-]+$/u.test(arg) ? arg : JSON.stringify(arg)).join(' ')
}

/** A supported snapshot may move its executable paths, but not its protocol or saved extra arguments. */
export function matchesHistoricalRuntimePaths(record: { agentCommand: string; agentArgv?: string[] }, argv: readonly string[], config: AcpAgentConfig): boolean {
  const previous = record.agentArgv
  if (!previous || previous.length !== argv.length || !matchesRuntimeRecordLaunch(record, previous)) return false
  if (config.launchKind === 'local') return previous.every((value, index) => value === argv[index])
  const pathPositions = isManaged(config) ? [0, 1] : isNative(config) ? [0] : isBundled(config) ? [0, 2, 4] : []
  if (!pathPositions.length || pathPositions.some(index => !previous[index] || !argv[index])) return false
  return previous.every((value, index) => pathPositions.includes(index) || value === argv[index])
}
