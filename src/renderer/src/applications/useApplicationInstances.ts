import { useEffect, useSyncExternalStore } from 'react'
import type { ApplicationInstanceSummary, ApplicationInstanceTarget, ApplicationResult } from '@shared/app-runtime'
import { api, hasIpc } from '../api'

export type RunReceipt = { id: number; root: string; appId: string; runId: string | null; name: string; action: 'start' | 'stop' | 'restart'; pending: boolean; result?: ApplicationResult; unknown?: boolean }
type Inventory = { instances: ApplicationInstanceSummary[]; total: number | null; loading: boolean; partial: boolean; unavailableProjects: number; error: string | null; receipts: RunReceipt[] }
let state: Inventory = { instances: [], total: null, loading: false, partial: false, unavailableProjects: 0, error: null, receipts: [] }
const listeners = new Set<() => void>()
let receiptId = 0
let refreshing: Promise<void> | undefined
let refreshAgain = false

function publish(patch: Partial<Inventory>): void { state = { ...state, ...patch }; listeners.forEach((listener) => listener()) }
export function instanceKey(target: ApplicationInstanceTarget): string { return JSON.stringify([target.root, target.appId, target.expectedRunId]) }
export function beginRunReceipt(input: Omit<RunReceipt, 'id' | 'pending'>): number {
  const id = ++receiptId
  publish({ receipts: [...state.receipts.filter((item) => item.pending || item.id > receiptId - 50), { ...input, id, pending: true }] })
  return id
}
export function finishRunReceipt(id: number, result?: ApplicationResult): void {
  publish({ receipts: state.receipts.map((item) => item.id === id ? { ...item, pending: false, result, unknown: result === undefined } : item) })
  void refreshApplicationInstances()
}

export async function refreshApplicationInstances(): Promise<void> {
  if (!hasIpc) return
  if (refreshing) { refreshAgain = true; return refreshing }
  refreshing = (async () => {
    do {
      refreshAgain = false
      publish({ loading: true })
      try {
        const instances = new Map<string, ApplicationInstanceSummary>()
        const cursors = new Set<string>()
        let cursor: string | undefined
        let total = 0, unavailableProjects = 0, partial = false
        do {
          const result = await api.appRuntimeInventory({ cursor, limit: 100 })
          if (!result.ok) throw new Error(result.error)
          for (const item of result.instances) instances.set(instanceKey(item.target), item)
          total = result.total
          partial ||= result.partial
          unavailableProjects = Math.max(unavailableProjects, result.unavailableProjects)
          cursor = result.nextCursor ?? undefined
          if (cursor && cursors.has(cursor)) throw new Error('运行清单已变化，请重新读取')
          if (cursor) cursors.add(cursor)
        } while (cursor)
        // Partial reads never silently remove previously observed ownership.
        if (partial) for (const item of state.instances) if (!instances.has(instanceKey(item.target))) instances.set(instanceKey(item.target), item)
        publish({ instances: [...instances.values()], total, partial, unavailableProjects, error: null })
      } catch (error) { publish({ error: error instanceof Error ? error.message : '运行清单读取失败' }) }
      finally { publish({ loading: false }) }
    } while (refreshAgain)
  })().finally(() => { refreshing = undefined })
  return refreshing
}

export async function operateInstance(instance: ApplicationInstanceSummary, action: 'stop' | 'restart'): Promise<void> {
  const target = { ...instance.target }
  if (state.receipts.some((item) => item.pending && item.root === target.root && item.appId === target.appId)) return
  const name = instance.run.snapshot.status === 'known' ? instance.run.snapshot.name : target.appId
  const id = beginRunReceipt({ root: target.root, appId: target.appId, runId: target.expectedRunId, name, action })
  try {
    const result = action === 'stop' ? await api.appRuntimeStopInstance(target) : await api.appRuntimeRestartInstance(target, instance.currentRevision)
    finishRunReceipt(id, result)
  } catch { finishRunReceipt(id) }
}

// Mounted by the stable title bar, independent of project and collaboration view.
export function useApplicationInstances(): Inventory {
  const snapshot = useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => state)
  useEffect(() => {
    if (!hasIpc) return
    void refreshApplicationInstances()
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = api.onAppRuntimeEvent((event) => {
      if (event.kind === 'output' || timer) return
      timer = setTimeout(() => { timer = undefined; void refreshApplicationInstances() }, 150)
    })
    const recovery = setInterval(() => { void refreshApplicationInstances() }, 5000)
    return () => { unsubscribe(); clearTimeout(timer); clearInterval(recovery) }
  }, [])
  return snapshot
}

export function runReceiptMessage(receipt: RunReceipt): string {
  if (receipt.pending) return { start: '正在启动', stop: '正在停止', restart: '正在重启' }[receipt.action]
  if (receipt.unknown || !receipt.result) return '结果未知，请核对原实例'
  const result = receipt.result
  if (!result.ok) {
    const progress = result.restart
    return `${result.error}${progress?.previousStopped ? '；原实例已停止' : ''}${progress?.replacementRunId ? '；已产生后继实例，请核对状态' : ''}`
  }
  return receipt.action === 'stop' ? '原实例已停止' : result.disposition === 'reused' ? '沿用原实例' : receipt.action === 'restart' ? '已创建新实例' : '已创建运行实例'
}
