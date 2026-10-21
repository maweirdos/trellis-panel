import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ExecutionEvent, RunRef } from '../../../../shared/workflow'
import type { WorkflowApplicationPreview, WorkflowApplicationSnapshot } from '../../../../shared/workflow-application'
import type { WorkflowDesktopUpdate } from '../../../../shared/workflow-desktop'
import { api } from '../../api'
import { projectRootKey } from '../../my/navigation'
import { useInteractionGuard, useInteractionSignal } from '../../utils/interaction-scope'
import { mergeWorkflowEvents, viewKey } from './model'

const errorText = (error: unknown): string => error instanceof Error ? error.message : '工作流操作失败，请核对当前状态'
type Data = { key: string; snapshot: WorkflowApplicationSnapshot | null; events: ExecutionEvent[]; loading: boolean; error: string; gap: boolean; retiredEpochs: string[] }
function adoptSnapshot(old: Data, snapshot: WorkflowApplicationSnapshot, key: string): Data {
  const base: Data = old.key === key ? old : { key, snapshot: null, events: [], loading: true, error: '', gap: false, retiredEpochs: [] }
  const previousCursor = base.snapshot?.cursor ?? base.snapshot?.snapshot?.cursor
  const nextCursor = snapshot.cursor ?? snapshot.snapshot?.cursor
  const previous = base.snapshot?.snapshot?.run.run
  const next = snapshot.snapshot?.run.run
  if (nextCursor && base.retiredEpochs.includes(nextCursor.epoch)) return old
  if (previousCursor && nextCursor && previousCursor.epoch === nextCursor.epoch && previousCursor.sequence > nextCursor.sequence) return old
  if ((!previousCursor || !nextCursor || previousCursor.epoch === nextCursor.epoch) && previous && next && previous.runId === next.runId && previous.revision > next.revision) return old
  const changedEpoch = Boolean(previousCursor && nextCursor && previousCursor.epoch !== nextCursor.epoch)
  return { ...base, snapshot, loading: false, error: '', gap: base.gap || changedEpoch,
    retiredEpochs: changedEpoch && previousCursor ? [...base.retiredEpochs, previousCursor.epoch].slice(-16) : base.retiredEpochs }
}
export function useManagedWorkflow(input: { root: string; taskDir?: string; sessionId?: string; generation?: string; enabled: boolean }) {
  const { root, taskDir = '', sessionId = '', generation = '', enabled } = input
  const available = (['snapshot', 'subscribe', 'unsubscribe', 'onOutput', 'onDone'] as const).every((name) => typeof api?.managedWorkflow?.[name] === 'function')
  const key = viewKey(root, taskDir)
  const canInteract = useInteractionGuard()
  const interactionSignal = useInteractionSignal()
  const lifetime = useMemo(() => Symbol('workflow-owner'), [key, sessionId, generation, enabled, interactionSignal])
  const owner = useRef({ key, sessionId, generation, enabled, lifetime })
  owner.current = { key, sessionId, generation, enabled, lifetime }
  const [data, setData] = useState<Data>({ key, snapshot: null, events: [], loading: Boolean(available && enabled && root && taskDir), error: '', gap: false, retiredEpochs: [] })
  const [preview, setPreview] = useState<{ owner: string; value: WorkflowApplicationPreview } | null>(null)
  const [operation, setOperation] = useState('')
  const [notice, setNotice] = useState('')
  const [subscriptionEpoch, setSubscriptionEpoch] = useState(0)
  const action = useRef<symbol | null>(null)
  const delivery = useRef(0)
  const command = useRef<{ preview: string; id: string } | null>(null)
  const stopCommand = useRef<{ run: string; id: string } | null>(null)
  const valid = useCallback((captured: typeof owner.current): boolean => owner.current.lifetime === captured.lifetime && owner.current.enabled && canInteract(), [canInteract])
  const accept = useCallback((snapshot: WorkflowApplicationSnapshot, expectedKey: string): void => {
    if (owner.current.key !== expectedKey) return
    setData((old) => adoptSnapshot(old, snapshot, expectedKey))
  }, [])
  const refresh = useCallback(async (): Promise<void> => {
    if (!available || !root || !taskDir || !enabled) return
    const ticket = delivery.current
    try {
      const result = await api.managedWorkflow.snapshot(root, { taskDir })
      if (owner.current.key !== key || ticket !== delivery.current) return
      if (result.ok) accept(result.value, key)
      else setData((old) => ({ ...old, key, loading: false, error: result.error }))
    } catch (error) { if (owner.current.key === key && ticket === delivery.current) setData((old) => ({ ...old, key, loading: false, error: errorText(error) })) }
  }, [available, root, taskDir, enabled, key, accept])
  useEffect(() => {
    if (!available || !enabled || !root || !taskDir) return
    let live = true; let lease: string | null = null
    const buffered: WorkflowDesktopUpdate[] = []
    setData({ key, snapshot: null, events: [], loading: true, error: '', gap: false, retiredEpochs: [] })
    setPreview(null); setNotice(''); setOperation(''); action.current = null
    const apply = (update: WorkflowDesktopUpdate): void => {
      if (!live || update.leaseId !== lease || update.taskDir !== taskDir || projectRootKey(update.projectRoot) !== projectRootKey(root)) return
      delivery.current++
      setData((old) => {
        const next = update.snapshot ? adoptSnapshot(old, update.snapshot, key) : old
        if (update.snapshot && next === old) return old
        const reset = update.page?.resetRequired === true
        return { ...next, key, loading: false, error: update.error?.error ?? next.error, gap: reset || next.gap,
          events: mergeWorkflowEvents(reset ? [] : next.events, update.page?.items.map((item) => item.event) ?? []) }
      })
    }
    const receive = (update: WorkflowDesktopUpdate): void => {
      if (update.taskDir !== taskDir || projectRootKey(update.projectRoot) !== projectRootKey(root)) return
      if (!lease) {
        if (buffered.length >= 8) { buffered.shift(); setData((old) => ({ ...old, gap: true })) }
        buffered.push(update)
      } else apply(update)
    }
    const offOutput = api.managedWorkflow.onOutput(receive), offDone = api.managedWorkflow.onDone(receive)
    void api.managedWorkflow.subscribe(root, { taskDir, cursor: null }).then((result) => {
      if (!result.ok) { if (live) setData((old) => ({ ...old, loading: false, error: result.error })); return }
      lease = result.value.leaseId
      if (!live) { void api.managedWorkflow.unsubscribe(lease); return }
      for (const update of buffered) apply(update)
      void refresh().catch((error) => { if (live) setData((old) => ({ ...old, loading: false, error: errorText(error) })) })
    }).catch((error) => { if (live) setData((old) => ({ ...old, loading: false, error: errorText(error) })) })
    return () => { live = false; delivery.current++; offOutput(); offDone(); if (lease) void api.managedWorkflow.unsubscribe(lease) }
  }, [available, enabled, root, taskDir, key, accept, refresh, subscriptionEpoch])
  useEffect(() => { setPreview(null); setOperation(''); setNotice(''); action.current = null }, [lifetime])
  const perform = async (name: string, callback: (captured: typeof owner.current) => Promise<void>): Promise<boolean> => {
    const captured = owner.current
    if (action.current || !available || !taskDir || !valid(captured)) return false
    const token = Symbol(name)
    action.current = token; setOperation(name); setNotice('')
    try { await callback(captured); return valid(captured) }
    catch (error) { if (valid(captured)) setNotice(errorText(error)); return false }
    finally { if (action.current === token) { action.current = null; if (valid(captured)) setOperation('') } }
  }
  const createPreview = async (flowId: string, inputs: Record<string, string>): Promise<boolean> => perform('preview', async (captured) => {
    const result = await api.managedWorkflow.preview(root, { taskDir, flowId, origin: { sessionId, connectionGeneration: generation }, inputs })
    if (!valid(captured)) return
    if (!result.ok) throw Error(result.error)
    setPreview({ owner: key, value: result.value })
  })
  const start = async (): Promise<boolean> => perform('start', async (captured) => {
    if (preview?.owner !== key) return
    const id = command.current?.preview === preview.value.previewId ? command.current.id : crypto.randomUUID()
    command.current = { preview: preview.value.previewId, id }
    const result = await api.managedWorkflow.start(root, { taskDir, commandId: id, previewId: preview.value.previewId })
    if (!valid(captured)) return
    if (!result.ok) throw Error(`${result.error}；请先刷新核对，重试仍使用原命令标识。`)
    setNotice('命令已接纳，等待实际阶段记录。'); setPreview(null)
    setSubscriptionEpoch((value) => value + 1)
    await refresh()
  })
  const stop = async (): Promise<boolean> => perform('stop', async (captured) => {
    const run = data.key === key ? data.snapshot?.snapshot?.run.run : undefined
    if (!run) return
    const runKey = JSON.stringify(run)
    const id = stopCommand.current?.run === runKey ? stopCommand.current.id : crypto.randomUUID()
    stopCommand.current = { run: runKey, id }
    const result = await api.managedWorkflow.stop(root, { taskDir, commandId: id, run })
    if (!valid(captured)) return
    if (!result.ok) throw Error(result.error)
    setNotice(result.value.status === 'stopped' ? '停止已确认，已有修改和记录已保留。' : result.value.status === 'unconfirmed' ? '停止尚未确认，请核对状态，暂不启动冲突工作。' : '停止请求已记录，等待实际停止结果。')
    await refresh()
  })
  const openArtifact = async (ref: string, run?: RunRef): Promise<boolean> => perform('artifact', async (captured) => {
    const result = await api.managedWorkflow.artifact(root, { taskDir, ref, ...(run ? { run } : {}) })
    if (!valid(captured)) return
    if (!result.ok) throw Error(result.error)
    const opened = await api.documentOpenWindow({ token: result.value.token, origin: { taskDir, sessionId, connectionGeneration: generation || undefined } })
    if (valid(captured) && !opened.ok) throw Error(opened.error)
  })
  return { available, key, snapshot: data.key === key ? data.snapshot : null, events: data.key === key ? data.events : [], loading: Boolean(available && enabled && taskDir && (data.key !== key || data.loading)), error: data.key === key ? data.error : '', gap: data.key === key && data.gap, preview: preview?.owner === key ? preview.value : null, operation, notice, refresh, createPreview, start, stop, openArtifact, clearPreview: () => setPreview(null) }
}
export type ManagedWorkflowController = ReturnType<typeof useManagedWorkflow>
