import type { AppSlice, ObservationSlice, ObservationScopeKey, ObservationScopeState } from '../types'
import type { ObservationCursor, ObservationItem, ObservationStatusResult } from '../../../../shared/observability/store'

/**
 * 观测切片（S0 G3 第二片，design §5.1/§5.2）：
 * - 每个观察 scope（workspaceId+taskRef）一组有界事件缓冲（内存态，**不写
 *   localStorage**——store-conventions §5 无界数据不进持久化）；eventId 去重。
 * - 证据更新只落本切片：不触碰 readingSessions / 文档载荷（定向失效纪律——
 *   回执刷新绝不触发正文 reload 或 loading）。
 * - cursor/epoch 语义与主进程一致：reset 推送清空本 scope 缓冲并由 hook 重拉。
 */

/** 单 scope 内存缓冲上限（超出丢最旧；投影只展示最近回执）。 */
export const OBSERVATION_SCOPE_MAX_EVENTS = 400

export function observationScopeKey(scope: { workspaceId: string; taskRef?: string }): ObservationScopeKey {
  return `${scope.workspaceId}::${scope.taskRef ?? ''}`
}

function emptyScope(scope: { workspaceId: string; taskRef?: string }): ObservationScopeState {
  return { workspaceId: scope.workspaceId, taskRef: scope.taskRef, events: [], cursor: null, status: 'connecting', error: null, lastResetAtMs: null }
}

export const observationSlice: AppSlice<ObservationSlice> = (set) => ({
  observationScopes: {},
  observationStatus: null,

  observationScopeConnecting: (key, scope) => {
    set((s) => ({
      observationScopes: { ...s.observationScopes, [key]: { ...emptyScope(scope), lastResetAtMs: s.observationScopes[key]?.lastResetAtMs ?? null } }
    }))
  },

  observationScopeClosed: (key) => {
    set((s) => {
      const cur = s.observationScopes[key]
      if (cur === undefined) return s
      return { observationScopes: { ...s.observationScopes, [key]: { ...cur, status: 'closed' } } }
    })
  },

  observationScopeError: (key, error) => {
    set((s) => {
      const cur = s.observationScopes[key]
      if (cur === undefined) return s
      return { observationScopes: { ...s.observationScopes, [key]: { ...cur, status: 'error', error } } }
    })
  },

  observationEventsIngest: (key, items, cursor) => {
    set((s) => {
      const cur = s.observationScopes[key]
      if (cur === undefined) return s
      // eventId 去重（订阅推送与回补查询可能重叠；同 ID 取更大 seq 的载荷）
      const merged = new Map(cur.events.map((ev) => [ev.eventId, ev]))
      for (const item of items) {
        const existing = merged.get(item.eventId)
        if (existing === undefined || item.seq > existing.seq) merged.set(item.eventId, item)
      }
      const events = [...merged.values()].sort((a, b) => a.seq - b.seq).slice(-OBSERVATION_SCOPE_MAX_EVENTS)
      return { observationScopes: { ...s.observationScopes, [key]: { ...cur, events, cursor, status: 'live', error: null } } }
    })
  },

  observationScopeReset: (key, atMs) => {
    set((s) => {
      const cur = s.observationScopes[key]
      if (cur === undefined) return s
      // epoch 更换（清理/重建）：旧事件全部作废，等待 hook 全量重拉
      return { observationScopes: { ...s.observationScopes, [key]: { ...cur, events: [], cursor: null, status: 'connecting', lastResetAtMs: atMs } } }
    })
  },

  observationRemoveScope: (key) => {
    set((s) => {
      if (!(key in s.observationScopes)) return s
      const next = { ...s.observationScopes }
      delete next[key]
      return { observationScopes: next }
    })
  },

  observationSetStatus: (status) => {
    set((s) => (s.observationStatus === status ? s : { observationStatus: status }))
  },

  /** 项目切换/关闭：全部 scope 缓冲与健康状态丢弃（主进程同步取消订阅）。 */
  observationClearAllScopes: () => {
    set((s) =>
      Object.keys(s.observationScopes).length === 0 && s.observationStatus === null
        ? s
        : { observationScopes: {}, observationStatus: null }
    )
  }
})
