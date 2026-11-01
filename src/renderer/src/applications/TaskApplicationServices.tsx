import { useEffect, useRef, useState } from 'react'
import { Check, Link, Loader2, Play, RefreshCw, Unlink } from 'lucide-react'
import type { ApplicationTaskPlanResult, ApplicationTaskRuntimeApi, ApplicationTaskScope, ApplicationTaskPlan } from '@shared/app-task-runtime'
import type { ApplicationRuntimeApi, ApplicationTaskServiceUse } from '@shared/app-runtime'
import { api, hasIpc } from '../api'
import { Button } from '../my/ui'
import { ApplicationSnapshotFacts } from './ApplicationRunFacts'
import { ProcessStatus, ReadinessStatus } from './ApplicationStatus'

const ENVIRONMENT_LABELS = { unknown: '环境待核实', local: '本地环境', test: '测试环境', other: '其他环境' } as const
type ScopedResult = { generation: number; result: Extract<ApplicationTaskPlanResult, { ok: true }> }
type ProjectionRead = { generation: number; again: 'automatic' | 'explicit' | null }

function canAutoRefresh(section: HTMLElement | null): boolean {
  if (document.hidden || !section?.isConnected) return false
  for (let parent = section.parentElement; parent; parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement && !parent.open) return false
  }
  return true
}

/** Mount in the task workspace with its fixed native development reference. */
export function TaskApplicationServices({ query, expected, contextKey, runtimeApi }: ApplicationTaskScope & { contextKey: string; runtimeApi?: ApplicationTaskRuntimeApi }): JSX.Element {
  const client: Partial<ApplicationTaskRuntimeApi & Pick<ApplicationRuntimeApi, 'onAppRuntimeEvent'>> = runtimeApi ?? api ?? {}
  const identity = JSON.stringify([contextKey, query.workspaceKey, query.taskId, expected.contextId, expected.generation])
  const owner = useRef({ identity, generation: 0 })
  if (owner.current.identity !== identity) owner.current = { identity, generation: owner.current.generation + 1 }
  const generation = owner.current.generation
  const active = useRef(true)
  const section = useRef<HTMLElement>(null)
  const requests = useRef(0)
  const busyRef = useRef(false)
  const projectionRead = useRef<ProjectionRead | null>(null)
  const [state, setState] = useState<ScopedResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<{ generation: number; appId: string } | null>(null)
  const [error, setError] = useState<{ generation: number; message: string } | null>(null)
  const [operationError, setOperationError] = useState<{ generation: number; message: string } | null>(null)
  const [receipt, setReceipt] = useState<{ generation: number; message: string } | null>(null)
  const available = Boolean(runtimeApi || hasIpc) && typeof client.appRuntimeTaskPlan === 'function' && typeof client.appRuntimeTaskVerify === 'function' && typeof client.appRuntimeTaskStart === 'function' && typeof client.appRuntimeTaskReuse === 'function' && typeof client.appRuntimeTaskDetach === 'function'
  const current = state?.generation === generation ? state.result : null
  const currentError = error?.generation === generation ? error.message : operationError?.generation === generation ? operationError.message : null
  const isBusy = busy?.generation === generation
  const live = (submitted: number): boolean => active.current && owner.current.generation === submitted
  const scope: ApplicationTaskScope = { query, expected }
  const refresh = async (automatic = false): Promise<void> => {
    if (!client.appRuntimeTaskPlan || automatic && !canAutoRefresh(section.current)) return
    if (projectionRead.current?.generation === generation) {
      if (!automatic || projectionRead.current.again !== 'explicit') projectionRead.current.again = automatic ? 'automatic' : 'explicit'
      return
    }
    const reading: ProjectionRead = { generation, again: null }
    projectionRead.current = reading
    const requested = ++requests.current
    setLoading(true)
    try {
      const result = await client.appRuntimeTaskPlan(scope)
      if (!live(generation) || requested !== requests.current) return
      if (result.ok) { setState({ generation, result }); setError(null) }
      else setError({ generation, message: result.error })
    } catch { if (live(generation) && requested === requests.current) setError({ generation, message: '任务启动计划未能读取，请重新核对' }) }
    finally {
      if (live(generation) && requested === requests.current) setLoading(false)
      if (projectionRead.current === reading) {
        projectionRead.current = null
        if (reading.again && live(generation) && !busyRef.current) void refresh(reading.again === 'automatic')
      }
    }
  }
  useEffect(() => {
    active.current = true
    setError(null)
    setOperationError(null)
    setReceipt(null)
    setBusy(null)
    const refreshVisible = (): void => { if (!busyRef.current) void refresh(true) }
    const details: HTMLDetailsElement[] = []
    for (let parent = section.current?.parentElement; parent; parent = parent.parentElement) {
      if (parent instanceof HTMLDetailsElement) { details.push(parent); parent.addEventListener('toggle', refreshVisible) }
    }
    document.addEventListener('visibilitychange', refreshVisible)
    refreshVisible()
    const timer = setInterval(refreshVisible, 60000)
    return () => {
      active.current = false; requests.current += 1; projectionRead.current = null; clearInterval(timer)
      document.removeEventListener('visibilitychange', refreshVisible)
      details.forEach(parent => parent.removeEventListener('toggle', refreshVisible))
    }
  }, [identity, available, runtimeApi])
  useEffect(() => {
    if (!available || !client.onAppRuntimeEvent) return
    return client.onAppRuntimeEvent(event => {
      if (!live(generation) || event.kind === 'output' || event.app.definition.id !== event.appId || (event.app.run?.id ?? null) !== event.runId) return
      setState(previous => {
        if (!previous || previous.generation !== generation || previous.result.root !== event.root) return previous
        let changed = false
        const plans = previous.result.plans.map(plan => {
          const app = plan.app
          if (app.definition.id !== event.appId || app.definition.revision !== event.app.definition.revision || (app.run?.id ?? null) !== event.runId) return plan
          changed = true
          // Events update original-instance telemetry, never task admission or fixed snapshots.
          return { ...plan, app: { ...app, processState: event.app.processState, readiness: event.app.readiness,
            ports: event.app.ports, configChanged: event.app.configChanged, lastError: event.app.lastError,
            run: app.run && event.app.run ? { ...app.run, pid: event.app.run.pid, pidRole: event.app.run.pidRole,
              exitedAt: event.app.run.exitedAt, exitCode: event.app.run.exitCode, signal: event.app.run.signal } : app.run } }
        })
        return changed ? { ...previous, result: { ...previous.result, plans } } : previous
      })
    })
  }, [identity, available, runtimeApi])
  const operate = async (plan: ApplicationTaskPlan, action: 'verify' | 'start' | 'reuse'): Promise<void> => {
    if (!available || busyRef.current) return
    busyRef.current = true
    projectionRead.current = null
    requests.current += 1
    setBusy({ generation, appId: plan.app.definition.id })
    setOperationError(null)
    setReceipt(null)
    try {
      const request = { ...scope, appId: plan.app.definition.id, expectedRevision: plan.app.definition.revision, expectedPlanId: plan.id, expectedCheckId: plan.environment.id }
      const result = action === 'verify' && client.appRuntimeTaskVerify ? await client.appRuntimeTaskVerify({ ...scope, appId: request.appId, expectedRevision: request.expectedRevision, expectedPlanId: request.expectedPlanId })
        : action === 'start' && client.appRuntimeTaskStart ? await client.appRuntimeTaskStart(request)
          : action === 'reuse' && client.appRuntimeTaskReuse && plan.reusable[0] ? await client.appRuntimeTaskReuse({ ...request, target: plan.reusable[0] }) : null
      if (!live(generation)) return
      if (!result) setOperationError({ generation, message: '操作能力或原实例已不可用，请重新读取计划' })
      else if (!result.ok) setOperationError({ generation, message: result.error })
      else {
        setReceipt({ generation, message: action === 'verify' ? '环境已完成本机人工核对' : action === 'start' ? '服务已启动并固定引用' : '已引用原兼容实例' })
        if ('plans' in result) setState({ generation, result })
        else await refresh()
      }
    } catch { if (live(generation)) setOperationError({ generation, message: '操作结果尚未确认，请刷新原计划并查看本机运行' }) }
    finally { busyRef.current = false; if (live(generation)) { setBusy(null); setLoading(false) } }
  }
  const detach = async (reference: ApplicationTaskServiceUse): Promise<void> => {
    if (!client.appRuntimeTaskDetach || busyRef.current) return
    busyRef.current = true
    projectionRead.current = null
    requests.current += 1
    setBusy({ generation, appId: reference.appId })
    setOperationError(null)
    setReceipt(null)
    try {
      const result = await client.appRuntimeTaskDetach({ ...scope, referenceId: reference.id })
      if (!live(generation)) return
      if (!result.ok) setOperationError({ generation, message: result.error })
      else { setReceipt({ generation, message: '引用已解绑；实例继续独立运行或供其他任务使用' }); await refresh() }
    } catch { if (live(generation)) setOperationError({ generation, message: '解绑结果尚未确认，请刷新原任务服务' }) }
    finally { busyRef.current = false; if (live(generation)) setBusy(null) }
  }
  return <section ref={section} aria-label="任务启动环境与服务" className="min-w-0 space-y-3">
    <header className="flex flex-wrap items-center gap-2"><h3 className="min-w-0 flex-1 text-my-sm font-semibold text-my-primary">启动环境与服务</h3><Button variant="ghost" size="sm" disabled={!available || loading || isBusy} onClick={() => { setOperationError(null); void refresh() }}><RefreshCw size={13} className={loading ? 'animate-spin' : undefined} />刷新计划</Button></header>
    {!available && <p className="text-my-xs text-my-tertiary">桌面端接入任务运行服务后可核对本机启动计划</p>}
    {currentError && <p role="alert" className="my-application-message break-words text-my-danger-text">{currentError}</p>}
    {receipt?.generation === generation && <p role="status" className="break-words text-my-xs text-my-secondary">{receipt.message}</p>}
    {available && loading && !current && <p role="status" className="flex items-center gap-2 text-my-xs text-my-secondary"><Loader2 size={13} className="animate-spin" />正在核对原任务的本机配置…</p>}
    {current && <>
      <p className="break-all text-my-xs text-my-tertiary">本人工作副本 · {current.root}</p>
      {current.referencesPartial && <p role="status" className="text-my-xs text-my-warning-text">部分本机服务引用不可读取，请同时核对本机运行中心</p>}
      {current.plans.length === 0 && <p className="text-my-xs text-my-tertiary">此副本尚无启动配置；在应用配置中添加后刷新计划</p>}
      {current.plans.map(plan => <article key={plan.app.definition.id} className="min-w-0 rounded-my-lg border border-my-line p-3">
        <div className="flex flex-wrap items-start gap-2"><h4 className="my-item-title min-w-0 flex-1 break-words">{plan.app.definition.name} <span className="font-normal text-my-xs text-my-tertiary">{plan.app.definition.id}</span></h4><span className="text-my-xs text-my-secondary">{ENVIRONMENT_LABELS[plan.environment.selection]}</span></div>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-my-xs"><ProcessStatus app={plan.app} /><ReadinessStatus readiness={plan.app.readiness} /><span className={plan.environment.status === 'verified' ? 'text-my-secondary' : 'text-my-warning-text'}>{plan.environment.status === 'verified' ? '人工已核对' : plan.environment.status === 'changed' ? '环境已变化' : '环境待核实'}</span></div>
        <p className="mt-2 break-all text-my-xs text-my-secondary">{plan.snapshot.status === 'known' ? plan.snapshot.cwd : plan.blockedReason}</p>
        {plan.blockedReason && <p className="mt-2 break-words text-my-xs text-my-warning-text">{plan.blockedReason}</p>}
        {plan.app.configChanged && <p className="mt-2 text-my-xs text-my-warning-text">新配置尚未应用到原运行实例</p>}
        <details className="mt-2 text-my-xs text-my-secondary"><summary className="cursor-pointer">启动计划与环境事实</summary><dl className="mt-2 grid min-w-0 gap-2 break-words"><ApplicationSnapshotFacts snapshot={plan.snapshot} /></dl></details>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={!available || !plan.canVerify || isBusy || Boolean(currentError)} onClick={() => void operate(plan, 'verify')}><Check size={12} />人工核对环境</Button>
          <Button size="sm" variant="primary" disabled={!available || !plan.canStart || isBusy || Boolean(currentError)} onClick={() => void operate(plan, 'start')}><Play size={12} />启动并引用</Button>
          {plan.reusable.length > 0 && <Button size="sm" variant="outline" disabled={!available || isBusy || Boolean(currentError)} onClick={() => void operate(plan, 'reuse')}><Link size={12} />复用原实例</Button>}
          {isBusy && busy.appId === plan.app.definition.id && <Loader2 size={14} className="animate-spin" aria-label="操作进行中" />}
        </div>
      </article>)}
      {current.references.length > 0 && <div className="space-y-2"><h4 className="text-my-xs font-medium text-my-primary">固定服务引用</h4>{current.references.map(reference => {
        const referencePlan = current.plans.find(plan => plan.app.definition.id === reference.appId && reference.root === current.root)
        const original = referencePlan?.app
        return <div key={reference.id} className="flex min-w-0 flex-wrap items-center gap-2 rounded-my-lg border border-my-line p-3 text-my-xs"><div className="min-w-0 flex-1 break-all text-my-secondary">{reference.appId} · {reference.disposition === 'created' ? '本任务创建' : '兼容复用'}<br />{reference.root}<br />{reference.runId}<br />配置 {reference.configRevision}<br />{reference.coordination !== 'ready' && <><span className="text-my-warning-text">{reference.coordination === 'releasing' ? '原解绑待确认' : '原使用授权待确认'}</span><br /></>}{original?.run?.id === reference.runId ? <ProcessStatus app={original} /> : '原实例已更换或属于其他开发副本；在本机运行中心核对'}</div>{reference.coordination !== 'ready' && reference.coordination !== 'releasing' && referencePlan?.reusable.length ? <Button size="sm" variant="outline" disabled={!available || isBusy} onClick={() => void operate(referencePlan, 'reuse')}>重试原使用授权</Button> : null}<Button size="sm" variant="ghost" disabled={!available || isBusy} onClick={() => void detach(reference)}><Unlink size={12} />{reference.coordination === 'releasing' ? '重试原解绑' : '解绑引用'}</Button></div>
      })}</div>}
    </>}
  </section>
}
