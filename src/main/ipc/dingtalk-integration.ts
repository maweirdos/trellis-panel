import type { ProviderSchemaParsers } from '../../shared/daemon-domains'
import { DINGTALK_IPC, dingtalkRequests, dingtalkResults, type DingInput, type DingMethod, type DingOutput } from '../../shared/dingtalk-integration'
import { ipcFail, IpcErrorCode } from '../../shared/ipc-errors'
import { IntegrationError } from '../services/integrations/types'
import { DaemonError } from '../daemon/errors'
import type { DingTalkActions } from '../services/integrations/dingtalk-workspace'
import { handle } from './registry'

/** Central main must declare DINGTALK_IPC in the common channel registry first.
 * Pass an authenticated daemon forwarding facade, never a second GUI writer. */
export function registerDingTalkIntegrationIpc(actions: DingTalkActions, isAllowed: (event: Electron.IpcMainInvokeEvent) => boolean): void {
  const requests: ProviderSchemaParsers<typeof dingtalkRequests> = dingtalkRequests
  const reads = new Map<string, AbortController>()
  const counts = new Map<number, number>()
  const transient = new Set<DingMethod>(['snapshot', 'inbox', 'deliveries', 'authorizeAccount'])
  function register<M extends Exclude<DingMethod, 'cancelRead'>>(method: M, action: (input: DingInput<M>, signal?: AbortSignal) => Promise<DingOutput<M>>): void {
    handle(DINGTALK_IPC[method], async (event, raw: unknown) => {
      if (!isAllowed(event)) return ipcFail(IpcErrorCode.Denied, '钉钉工作区仅允许原生主窗口访问。')
      const input = requests[method].safeParse(raw)
      if (!input.success) return ipcFail(IpcErrorCode.InvalidArg, '钉钉请求参数无效')
      if ((counts.get(event.sender.id) ?? 0) >= 4) return ipcFail(IpcErrorCode.Busy, '钉钉请求过多，请等待当前请求完成')
      const controller = new AbortController(), senderId = event.sender.id
      counts.set(senderId, (counts.get(senderId) ?? 0) + 1)
      const requestId = 'requestId' in input.data ? String(input.data.requestId) : null
      const key = requestId ? `${senderId}:${requestId}` : null
      if (key && reads.has(key)) { counts.set(senderId, (counts.get(senderId) ?? 1) - 1); return ipcFail(IpcErrorCode.Conflict, '原授权请求仍在进行中') }
      if (key) reads.set(key, controller)
      const destroyed = (): void => { if (transient.has(method)) controller.abort() }
      event.sender.once('destroyed', destroyed)
      try {
        const result = await action(input.data, transient.has(method) ? AbortSignal.any([controller.signal, AbortSignal.timeout(method === 'authorizeAccount' ? 300000 : 15000)]) : undefined)
        const data = dingtalkResults[method].parse(result)
        if (Buffer.byteLength(JSON.stringify(data)) > 230000) return ipcFail(IpcErrorCode.Unavailable, '钉钉单页响应超过容量，请缩小范围')
        return { ok: true as const, data }
      } catch (error) {
        if (error instanceof IntegrationError) return ipcFail(error.kind === 'invalid' ? IpcErrorCode.InvalidArg : error.kind === 'denied' ? IpcErrorCode.Denied : error.kind === 'conflict' ? IpcErrorCode.Conflict : error.kind === 'io' ? IpcErrorCode.Io : error.kind === 'uncertain' ? IpcErrorCode.Unknown : IpcErrorCode.Upstream, error.message)
        const code = error && typeof error === 'object' && 'code' in error ? Object.values(IpcErrorCode).find(value => value === error.code) : undefined
        return ipcFail(code ?? IpcErrorCode.Unknown, error instanceof DaemonError ? error.message : '钉钉后台操作未完成，请读取原配置或回执核实结果')
      } finally { if (key) reads.delete(key); const count = (counts.get(senderId) ?? 1) - 1; if (count) counts.set(senderId, count); else counts.delete(senderId); if (!event.sender.isDestroyed()) event.sender.removeListener('destroyed', destroyed) }
    })
  }
  register('snapshot', actions.snapshot); register('saveApp', actions.saveApp); register('verifyApp', actions.verifyApp); register('revokeApp', actions.revokeApp)
  register('authorizeAccount', actions.authorizeAccount); register('claimAccount', actions.claimAccount); register('unlinkAccount', actions.unlinkAccount)
  register('saveAssistant', actions.saveAssistant); register('setAssistant', actions.setAssistant); register('retryAssistant', actions.retryAssistant)
  register('setNotifications', actions.setNotifications); register('previewNotification', actions.previewNotification); register('sendNotification', actions.sendNotification)
  register('deliveries', actions.deliveries); register('reconcileDelivery', actions.reconcileDelivery); register('inbox', actions.inbox)
  register('execute', actions.execute); register('queryExecution', actions.queryExecution); register('cancelExecution', actions.cancelExecution)
  handle(DINGTALK_IPC.cancelRead, (event, raw: unknown) => { if (!isAllowed(event)) return ipcFail(IpcErrorCode.Denied, '钉钉工作区仅允许原生主窗口访问。'); const input = dingtalkRequests.cancelRead.safeParse(raw); if (!input.success) return ipcFail(IpcErrorCode.InvalidArg, '取消请求参数无效'); reads.get(`${event.sender.id}:${input.data.requestId}`)?.abort(); return { ok: true as const, data: null } })
}
