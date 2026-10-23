import type { DaemonData, DaemonResult, DaemonPreferences, DaemonStatus } from './protocol'

/** Renderer facade intentionally has no generic request, credential or workspace-grant endpoint. */
export interface DaemonApi {
  protocolVersion: 1
  status(): Promise<DaemonResult<DaemonStatus>>
  start(): Promise<DaemonResult<DaemonStatus>>
  stop(): Promise<DaemonResult<null>>
  restart(): Promise<DaemonResult<DaemonStatus>>
  preferences(): Promise<DaemonResult<DaemonPreferences>>
  setPreferences(input: DaemonPreferences): Promise<DaemonResult<DaemonPreferences>>
  /** Feature-scoped addition: absent on older preload, without disabling existing management. */
  reconcileStartup?(originalCommandId: string): Promise<DaemonResult<DaemonPreferences>>
  logs(input: { after?: number; limit?: number }): Promise<DaemonResult<DaemonData<'daemon.logs'>>>
}
/** Feature-scoped guard: older preload keeps its unrelated capabilities. */
export function hasDaemonApi(value: unknown): value is DaemonApi {
  if (!value || typeof value !== 'object') return false
  const api = value as Record<string, unknown>
  return api.protocolVersion === 1 && ['status', 'start', 'stop', 'restart', 'preferences', 'setPreferences', 'logs'].every((key) => typeof api[key] === 'function')
}
