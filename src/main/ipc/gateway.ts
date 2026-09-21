import { ipcInvoke } from '../../shared/ipc-channels'
import type { GatewaySecurityConfig } from '../../shared/types'
import { GatewayManager } from '../services/gateway/manager'
import { getProjectRoot } from '../state'
import { handle } from './registry'

export function registerGatewayIpc(): void {
  handle(ipcInvoke.gateway.status, async () => {
    return GatewayManager.getStatus(getProjectRoot() || '')
  })

  handle(ipcInvoke.gateway.search, async (_e, query: string, limit?: number) => {
    return GatewayManager.search(String(query ?? ''), {
      limit: typeof limit === 'number' ? limit : 10,
      root: getProjectRoot() || ''
    })
  })

  handle(ipcInvoke.gateway.recentLogs, async () => {
    return GatewayManager.getLogs()
  })

  handle(ipcInvoke.gateway.syncSpec, async (_e, remoteDocId: string, targetFileName: string) => {
    return GatewayManager.syncSpecFromRemote(getProjectRoot() || '', remoteDocId, targetFileName)
  })

  handle(ipcInvoke.gateway.testProvider, async (_e, providerId: string) => {
    return GatewayManager.testProvider(String(providerId), getProjectRoot() || '')
  })

  handle(ipcInvoke.gateway.testTool, async (_e, toolName: string, args: Record<string, unknown>) => {
    return GatewayManager.executeTool(String(toolName), args || {}, getProjectRoot() || '')
  })

  handle(ipcInvoke.gateway.updateSecurity, async (_e, security: GatewaySecurityConfig) => {
    GatewayManager.updateSecurity(security)
    return { ok: true }
  })
}
