import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { useApp } from '../store'
import { observationScopeKey } from '../store/slices/observation'
import { projectReceipts, type ReceiptProjectionResult } from '../../../shared/observability/receipt'
import type { ObservationCursor, ObservationHealth, ObservationScope } from '../../../shared/observability/store'

/**
 * useObservationScope（S0 G3 第二片，design §5.1/§5.2）：观察 scope 的订阅编排。
 *
 * - 观测 scope 的 workspaceId 是**绑定 workspaceId**（非项目根）：首次经
 *   observation:health 解析并缓存在闭包 ref，跨可见性重订复用。
 * - 轮询策略：可见 1s / 窗口后台 5s / 关闭（卸载）停读——后台切换 = 退订后携
 *   afterCursor 重订（epoch 不符会收到 reset，不默默跳过）；主进程夹取 [1000,5000]。
 * - 快照回补：订阅基准 highWatermark 向前取最近 ≤100 条（after=max(0,H-100)），
 *   增量推送按 eventId 去重落切片（store-conventions：无界数据不进 localStorage）。
 * - 未绑定是中性事实：status='closed'（未观察到 ≠ 故障），不重试轰炸。
 * - 证据只落 observation 切片：不触碰 readingSessions / 文档载荷（回执刷新
 *   绝不触发正文 reload——定向失效纪律）。
 */

/** 初始回补窗口（订阅基准向前的事件条数上限）。 */
const BACKFILL_WINDOW = 100
/** 后台（窗口隐藏）订阅轮询请求（design §5.2：后台初始 5s）。 */
const BACKGROUND_POLL_MS = 5000

export interface UseObservationScopeParams {
  /** 项目根（文档域 workspaceId；仅用于材料核对等文档域调用）。 */
  workspaceId: string
  /** 任务范围（`task:<id>` / `dir:<repo-relative-dir>`；缺省=工作区级）。 */
  taskRef?: string
}

export interface ObservationScopeController {
  scopeKey: string
  status: 'connecting' | 'live' | 'closed' | 'error'
  error: string | null
  events: Array<import('../../../shared/observability/store').ObservationItem>
  cursor: ObservationCursor | null
  lastResetAtMs: number | null
  receipts: ReceiptProjectionResult
  /** 请求级失败后的显式重试（重新走 health → 订阅链）。 */
  reload: () => void
}

export function useObservationScope(params: UseObservationScopeParams): ObservationScopeController {
  const { workspaceId, taskRef } = params
  const scopeKey = observationScopeKey({ workspaceId, taskRef })
  const scopeState = useApp((s) => s.observationScopes[scopeKey])
  const subscriptionIdRef = useRef<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let alive = true
    /** 可见性重订序号（单调递增；过期订阅完成时自行退订防泄漏）。 */
    let resubscribeToken = 0
    const store = () => useApp.getState()
    // 绑定 workspaceId 闭包缓存（health 解析一次；跨可见性重订复用）
    let bindingWorkspaceId: string | null = useApp.getState().observationStatus?.binding.workspaceId ?? null

    const obsScopeOf = (): ObservationScope | null =>
      bindingWorkspaceId === null ? null : { workspaceId: bindingWorkspaceId, ...(taskRef !== undefined ? { taskRef } : {}) }

    const unsubscribeCurrent = (): void => {
      const id = subscriptionIdRef.current
      subscriptionIdRef.current = null
      if (id !== null) void api.observationUnsubscribe(id).catch(() => undefined)
    }

    /** 订阅（可见 1s / 后台 5s）；携切片当前 cursor 续订不丢增量。
     * token=可见性重订序号：快速 hidden→visible 时并发订阅的先完成者过期，
     * 立即退订自己，防止 subscriptionId 被覆写后在主进程泄漏（check P2-1）。 */
    const subscribe = async (pollMs: number | undefined, token: number): Promise<boolean> => {
      if (bindingWorkspaceId === null) {
        const status = await api.observationHealth()
        if (!alive) return false
        if (status.ok !== true) {
          store().observationScopeError(scopeKey, status.error)
          return false
        }
        store().observationSetStatus(status)
        if (status.binding.workspaceId == null) {
          // 未绑定：中性停读（未观察到 ≠ 故障），不重试轰炸
          store().observationScopeClosed(scopeKey)
          return false
        }
        bindingWorkspaceId = status.binding.workspaceId
      }
      const obsScope = obsScopeOf()
      if (obsScope === null) return false
      return subscribeWith(obsScope, store().observationScopes[scopeKey]?.cursor ?? undefined, pollMs, token)
    }

    const subscribeWith = async (
      obsScope: ObservationScope,
      afterCursor: ObservationCursor | undefined,
      pollMs: number | undefined,
      token: number
    ): Promise<boolean> => {
      const res = await api.observationSubscribe(obsScope, { afterCursor, pollMs })
      if (!alive || token !== resubscribeToken) {
        if (res.ok === true) void api.observationUnsubscribe(res.subscriptionId).catch(() => undefined)
        return false
      }
      if (res.ok !== true) {
        store().observationScopeError(scopeKey, res.error)
        return false
      }
      subscriptionIdRef.current = res.subscriptionId
      // 快照回补：从 highWatermark 向前取最近一窗（订阅只推此后增量）
      const high = res.snapshotCursor.seq
      const back = await api.observationQuery(obsScope, { after: Math.max(0, high - BACKFILL_WINDOW), limit: BACKFILL_WINDOW })
      if (!alive) return false
      if (back.ok === true) {
        store().observationEventsIngest(scopeKey, back.items, back.nextCursor)
      }
      return true
    }

    /** epoch reset 后的全量重拉（清理/重建：旧 cursor 作废，不默默跳过）。 */
    const backfillAfterReset = (obsScope: ObservationScope): void => {
      void api
        .observationQuery(obsScope, { after: 0, limit: BACKFILL_WINDOW })
        .then((res) => {
          if (alive && res.ok === true) store().observationEventsIngest(scopeKey, res.items, res.nextCursor)
        })
        .catch(() => undefined)
    }

    /** 订阅推送携带的 health 落切片（binding 部分保留已有；无则补一次 health 查询）。 */
    const applyPushHealth = (health: ObservationHealth): void => {
      const cur = store().observationStatus
      if (cur !== null) {
        store().observationSetStatus({ ...cur, health })
      } else {
        void api
          .observationHealth()
          .then((s) => {
            if (alive && s.ok === true) store().observationSetStatus(s)
          })
          .catch(() => undefined)
      }
    }

    store().observationScopeConnecting(scopeKey, { workspaceId, taskRef })
    void subscribe(undefined, resubscribeToken)

    const offEvents = api.onObservationEvents((envelope) => {
      if (subscriptionIdRef.current !== envelope.subscriptionId) return
      if (envelope.event.type === 'events') {
        store().observationEventsIngest(scopeKey, envelope.event.items, envelope.event.cursor)
        applyPushHealth(envelope.event.health)
      } else {
        store().observationScopeReset(scopeKey, Date.now())
        applyPushHealth(envelope.event.health)
        const obsScope = obsScopeOf()
        if (obsScope !== null) backfillAfterReset(obsScope)
      }
    })

    // 可见性降频：窗口隐藏 → 退订并以 5s 重订（携 cursor 续订）；恢复可见 → 1s
    const onVisibility = (): void => {
      if (!alive) return
      resubscribeToken += 1
      unsubscribeCurrent()
      void subscribe(document.visibilityState === 'hidden' ? BACKGROUND_POLL_MS : undefined, resubscribeToken)
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      alive = false
      document.removeEventListener('visibilitychange', onVisibility)
      offEvents()
      unsubscribeCurrent()
      useApp.getState().observationRemoveScope(scopeKey)
    }
    // attempt：显式重试（请求级失败后用户点击）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, workspaceId, taskRef, attempt])

  const events = scopeState?.events ?? []
  const receipts = useMemo(() => projectReceipts(events), [events])

  return {
    scopeKey,
    status: scopeState?.status ?? 'connecting',
    error: scopeState?.error ?? null,
    events,
    cursor: scopeState?.cursor ?? null,
    lastResetAtMs: scopeState?.lastResetAtMs ?? null,
    receipts,
    reload: () => setAttempt((n) => n + 1)
  }
}

/**
 * 材料当时摘要与当前文件的核对（design §3.3）：只对**最新**回执的 file 来源材料
 * 有界执行（≤8 个），经 documents 层 revision（sha256 前 16 hex）与材料完整摘要
 * 的可比前缀对比；读不到/超限/越界 → null（无法核对）。独立 requestId，不触碰
 * 阅读会话状态（不触发正文 reload）。
 */
const CURRENCY_MAX_MATERIALS = 8

export function useMaterialCurrency(
  receipts: ReceiptProjectionResult,
  workspaceId: string,
  taskRef?: string
): Readonly<Record<string, string | null>> {
  const latest = receipts.receipts[0] ?? null
  const latestKey = latest !== null ? `${latest.injectionId}:${latest.materials.length}` : 'none'
  const [digests, setDigests] = useState<Readonly<Record<string, string | null>>>({})

  useEffect(() => {
    let alive = true
    if (latest === null) {
      setDigests({})
      return
    }
    const sources = latest.materials
      .filter((m) => m.origin === 'file' && m.sourceDigest !== null && !m.source.includes('://'))
      .slice(0, CURRENCY_MAX_MATERIALS)
      .map((m) => m.source)
    if (sources.length === 0) {
      setDigests({})
      return
    }
    void (async () => {
      const next: Record<string, string | null> = {}
      for (const source of sources) {
        try {
          const res = await api.documentRead(
            { workspaceId, taskRef },
            { relativePath: source, requestId: `obs-currency-${latest.injectionId}` }
          )
          if (!alive) return
          // revision=null 是文档级事实（缺失/不可读/超限）：不可比 → 无法核对
          next[source] = res.ok && res.revision !== null ? res.revision : null
        } catch {
          if (!alive) return
          next[source] = null
        }
      }
      if (alive) setDigests(next)
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestKey, workspaceId, taskRef])

  return digests
}
