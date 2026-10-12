import { ipcEvent, ipcInvoke } from '../../shared/ipc-channels'
import type { ObservationCursor } from '../../shared/observability/store'
import {
  onObservationEvents,
  queryObservations,
  subscribeObservations,
  unsubscribeObservations,
  type ObservationPushEnvelope
} from '../services/observability'
import { broadcastToWindows } from '../services/bridge'
import { handle } from './registry'

/**
 * 观测域 IPC（S0 G3 第一片，design §5.1）：query/subscribe/unsubscribe 全链注册。
 * 渲染端消费（store slice、回执卡）留第二片；本片契约先行。
 *
 * 语义红线：
 * - 库未初始化/未绑定不是错误：query 返回哨兵空集 + resetRequired，不伪装 ipcFail。
 * - 订阅推送统一经 broadcastToWindows 广播（channel=ipcEvent.observationEvents，
 *   subscriptionId 关联；backend/ipc-conventions 约定），渲染端按 eventId 去重。
 */
export function registerObservationIpc(): void {
  handle(ipcInvoke.observation.query, (_e, scope: unknown, request: unknown) => queryObservations(scope, request))

  handle(ipcInvoke.observation.subscribe, (_e, scope: unknown, options: { afterCursor?: ObservationCursor } | undefined) =>
    subscribeObservations(scope, options)
  )

  handle(ipcInvoke.observation.unsubscribe, (_e, subscriptionId: unknown) => {
    if (typeof subscriptionId !== 'string' || subscriptionId.length === 0) return
    unsubscribeObservations(subscriptionId)
  })

  onObservationEvents((envelope: ObservationPushEnvelope) => {
    broadcastToWindows(ipcEvent.observationEvents, envelope)
  })
}
