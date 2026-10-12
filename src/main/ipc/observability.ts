import { ipcEvent, ipcInvoke } from '../../shared/ipc-channels'
import { IpcErrorCode, ipcFail, noProject, type IpcFail } from '../../shared/ipc-errors'
import type { ObservationCursor, ObservationHealth } from '../../shared/observability/store'
import {
  cleanupObservationRetention,
  clearObservationEvents,
  enableObservation,
  observationStatus,
  onObservationEvents,
  queryObservations,
  setObservationCollectionEnabled,
  subscribeObservations,
  unsubscribeObservations,
  type ObservationPushEnvelope
} from '../services/observability'
import { getProjectRoot } from '../state'
import { broadcastToWindows } from '../services/bridge'
import { handle } from './registry'

/**
 * 观测域 IPC（S0 G3，design §5.1）：query/subscribe/unsubscribe + 健康/治理全链注册。
 *
 * 语义红线：
 * - 库未初始化/未绑定不是错误：query 返回哨兵空集 + resetRequired，不伪装 ipcFail。
 * - 订阅推送统一经 broadcastToWindows 广播（channel=ipcEvent.observationEvents，
 *   subscriptionId 关联；backend/ipc-conventions 约定），渲染端按 eventId 去重。
 * - set-enabled/cleanup 作用于当前打开项目的绑定（design §4.2：清理观测 ≠ 归档任务，
 *   不触碰 control.sqlite 与任务文档；范围预览由渲染端用 health 数据展示后确认）。
 */
export function registerObservationIpc(): void {
  handle(ipcInvoke.observation.query, (_e, scope: unknown, request: unknown) => queryObservations(scope, request))

  handle(
    ipcInvoke.observation.subscribe,
    (_e, scope: unknown, options: { afterCursor?: ObservationCursor; pollMs?: number } | undefined) =>
      subscribeObservations(scope, options)
  )

  handle(ipcInvoke.observation.unsubscribe, (_e, subscriptionId: unknown) => {
    if (typeof subscriptionId !== 'string' || subscriptionId.length === 0) return
    unsubscribeObservations(subscriptionId)
  })

  /* 健康与治理（S0 G3 第二片） */
  handle(ipcInvoke.observation.health, () => observationStatus())

  handle(ipcInvoke.observation.setEnabled, (_e, enabled: unknown): Promise<{ ok: true; health: ObservationHealth } | IpcFail> => {
    if (typeof enabled !== 'boolean') {
      return Promise.resolve(ipcFail(IpcErrorCode.InvalidArg, 'observation set-enabled 参数非法：enabled 必须是布尔值'))
    }
    const root = getProjectRoot()
    if (!root) return Promise.resolve(noProject())
    return setObservationCollectionEnabled(root, enabled)
  })

  /* 首次显式绑定（G3 走查补全：此前未绑定分支无任何入口；design §3.1 的 enableObservation 是唯一绑定路径） */
  handle(ipcInvoke.observation.bind, (): Promise<unknown> => {
    const root = getProjectRoot()
    if (!root) return Promise.resolve(noProject())
    return enableObservation(root).then(async (r) => ({ ...r, status: await observationStatus() }))
  })

  handle(
    ipcInvoke.observation.cleanup,
    (_e, mode: unknown): Promise<{ ok: true; removed: number; resumed: boolean } | { ok: true; storeEpoch: string } | IpcFail> => {
      if (mode !== 'retention' && mode !== 'all') {
        return Promise.resolve(ipcFail(IpcErrorCode.InvalidArg, 'observation cleanup 参数非法：mode 必须是 retention 或 all'))
      }
      // 未打开项目时观测库必未初始化——保持同一「未初始化」口径（中性，不伪装 noProject 语义差异）
      return mode === 'all' ? clearObservationEvents() : cleanupObservationRetention()
    }
  )

  onObservationEvents((envelope: ObservationPushEnvelope) => {
    broadcastToWindows(ipcEvent.observationEvents, envelope)
  })
}
