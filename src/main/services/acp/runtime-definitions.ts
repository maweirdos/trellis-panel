import type { AcpAgentConfig, AcpSessionRecord } from '../../../shared/types'
import { OPENCODE_V2_PACKAGE } from './native-releases'
import { validateLocalProviderSnapshot } from './local-providers'

export const BUILTINS = {
  codex: { name: 'Codex', packageName: '@agentclientprotocol/codex-acp', version: '2.2.2', bin: 'codex-acp' },
  claude: { name: 'Claude Code', packageName: '@agentclientprotocol/claude-agent-acp', version: '0.91.0', bin: 'claude-agent-acp' }
} as const
export const BUNDLED = { zcode: { name: 'ZCode', commandName: 'zcode' } } as const
export const NATIVES = {
  opencode: { name: 'OpenCode', commandName: 'opencode', launchArgs: ['acp'], npmPackage: OPENCODE_V2_PACKAGE, installHint: `npm install -g ${OPENCODE_V2_PACKAGE}`, missingHint: `未找到 opencode；可通过「安装」安装 OpenCode v2（npm install -g ${OPENCODE_V2_PACKAGE}）或使用官方安装方式` },
  dsh: { name: 'DeepSeek DSH', commandName: 'dsh', launchArgs: ['--profile', 'acp'], npmPackage: '@deepseek-ai/dsh', installHint: 'npm install -g @deepseek-ai/dsh', missingHint: '未找到 dsh；可通过「安装执行引擎」（npm install -g @deepseek-ai/dsh）安装（需要 Node >=22.19）' }
} as const
export type BuiltinId = keyof typeof BUILTINS
export type NativeId = keyof typeof NATIVES
export type BundledId = keyof typeof BUNDLED

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
export function isSupportedRuntimeSnapshot(config: AcpAgentConfig): boolean {
  return isManaged(config) || isNative(config) || isBundled(config)
    || config.id === 'pi' && config.launchKind === 'sdk' && /^Pi SDK \S+$/.test(config.command)
      && !config.executable && !config.args?.length
    || (() => {
      if (config.launchKind !== 'local') return false
      validateLocalProviderSnapshot(config)
      return true
    })()
}

export function isRecoverableRuntimeRecord(meta: Pick<AcpSessionRecord, 'agentId' | 'engine' | 'runtimeSnapshot'>, legacyIds: readonly string[]): boolean {
  const config = meta.runtimeSnapshot
  return !!config && isSupportedRuntimeSnapshot(config) && config.id === meta.agentId
    && (meta.engine ?? 'acp') === (config.launchKind === 'sdk' ? 'pi' : 'acp')
    && (config.launchKind !== undefined || !legacyIds.includes(config.id))
}

/** acpx may create a client directly from a loaded record; keep its original launch bound to the admitted argv. */
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
  const pathPositions = isManaged(config) ? [0, 1] : isNative(config) ? [0] : isBundled(config) ? [0, 2, 4] : []
  if (config.launchKind === 'local') return previous.every((value, index) => value === argv[index])
  if (!pathPositions.length || pathPositions.some(index => !previous[index] || !argv[index])) return false
  return previous.every((value, index) => pathPositions.includes(index) || value === argv[index])
}
