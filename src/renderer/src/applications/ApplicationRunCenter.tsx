import { useEffect, useRef, useState } from 'react'
import { Activity, ArrowLeft, FolderOpen, Loader2, Pause, Play, RefreshCw, Square, Terminal, X } from 'lucide-react'
import type { ApplicationInstanceSummary, ApplicationLogsResult, ApplicationTaskServiceUse } from '@shared/app-runtime'
import { api, hasIpc } from '../api'
import { Button, Modal, Tooltip } from '../my/ui'
import { useApp } from '../store'
import { useMy } from '../my/store'
import { projectRootKey } from '../my/navigation'
import { ProcessStatus, ReadinessStatus } from './ApplicationList'
import { ApplicationRunFacts } from './ApplicationRunFacts'
import { instanceKey, operateInstance, refreshApplicationInstances, runReceiptMessage, useApplicationInstances } from './useApplicationInstances'

function InstanceOutput({ instance }: { instance: ApplicationInstanceSummary }): JSX.Element {
  const [logs, setLogs] = useState<Extract<ApplicationLogsResult, { ok: true }> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [follow, setFollow] = useState(true)
  const [retry, setRetry] = useState(0)
  const output = useRef<HTMLPreElement>(null)
  const { root, appId, expectedRunId, handle } = instance.target
  useEffect(() => {
    let live = true, reading = false
    const read = async (): Promise<void> => {
      if (reading) return
      reading = true
      try {
        const result = await api.appRuntimeLogsInstance({ root, appId, expectedRunId, handle })
        if (!live) return
        if (!result.ok) setError(result.error)
        else if (result.root === root && result.appId === appId && result.runId === expectedRunId) { setLogs(result); setError(null) }
        else setError('输出实例不匹配，请重新核对')
      } catch { if (live) setError('输出读取失败，请重试') }
      finally { reading = false }
    }
    void read()
    const timer = setInterval(() => { void read() }, 2000)
    return () => { live = false; clearInterval(timer) }
  }, [root, appId, expectedRunId, handle, retry])
  useEffect(() => { if (follow && output.current) output.current.scrollTop = output.current.scrollHeight }, [follow, logs?.output])
  return <section className="my-application-output" aria-label="原实例输出">
    <div className="flex items-center gap-2 px-3 py-2"><h4 className="flex-1 text-my-xs text-my-secondary">实例输出</h4><Button variant="ghost" size="sm" aria-pressed={follow} onClick={() => setFollow(!follow)}>{follow ? <Pause size={12} /> : <Play size={12} />}{follow ? '暂停跟随' : '继续跟随'}</Button></div>
    {logs?.outputTruncated && <p className="px-3 text-my-xs text-my-tertiary">早期输出已截断或不可恢复</p>}
    {error && <div role="alert" className="my-application-message text-my-danger-text">{error}<Button variant="ghost" size="sm" onClick={() => setRetry(retry + 1)}>重试</Button></div>}
    <pre ref={output} tabIndex={0} aria-label="原实例日志内容" className="my-application-console my-scrollbar is-compact">{logs ? logs.output || '暂无输出' : error ? '输出尚未取得' : '正在读取输出…'}</pre>
  </section>
}

function nameOf(instance: ApplicationInstanceSummary): string { return instance.run.snapshot.status === 'known' ? instance.run.snapshot.name : instance.target.appId }
function copyName(root: string): string { return root.split(/[\\/]/).filter(Boolean).at(-1) ?? root }
type ReferenceOperation = { targetKey: string; pending: boolean; message?: string; failed?: boolean; sequence: number }

export function ApplicationRunCenter({ variant = 'default' }: { variant?: 'default' | 'activity' } = {}): JSX.Element {
  const state = useApplicationInstances()
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<ApplicationInstanceSummary | null>(null)
  const [locating, setLocating] = useState(false)
  const [locateError, setLocateError] = useState<{ key: string; message: string } | null>(null)
  const [referenceOps, setReferenceOps] = useState<Record<string, ReferenceOperation>>({})
  const referencePending = useRef(new Set<string>())
  const referenceSequence = useRef(0)
  const selectedKey = selected ? instanceKey(selected.target) : null
  const current = state.instances.find((item) => instanceKey(item.target) === selectedKey)
  const detail = current ?? selected
  const groups = new Map<string, ApplicationInstanceSummary[]>()
  for (const item of state.instances) groups.set(item.target.root, [...groups.get(item.target.root) ?? [], item])
  const pending = detail && state.receipts.some((item) => item.pending && item.root === detail.target.root && item.appId === detail.target.appId)
  const uncertain = state.receipts.some((item) => item.unknown || item.result?.ok === false)
  const referenceFeedback = Object.values(referenceOps).filter(item => item.targetKey === selectedKey).sort((a, b) => a.sequence - b.sequence).at(-1)
  const referenceBusy = Object.values(referenceOps).some(item => item.targetKey === selectedKey && item.pending)
  const count = state.total === null ? '—' : `${state.total}${state.partial ? '+' : ''}`
  const activityLabel = !hasIpc ? '本机运行 · 仅桌面端可查看' : `本机运行${state.total === null ? '数量待核对' : ` ${count} 项`}${state.loading ? '，正在刷新' : ''}${state.partial ? '，清单不完整' : ''}${state.error ? '，读取失败' : ''}${uncertain ? '，有待核对结果' : ''}`
  const recordReferenceOperation = (key: string, value: Omit<ReferenceOperation, 'sequence'>): void => {
    const receipt = { ...value, sequence: ++referenceSequence.current }
    setReferenceOps(before => ({ ...before, [key]: receipt }))
  }
  const locate = async (instance: ApplicationInstanceSummary): Promise<void> => {
    const key = instanceKey(instance.target), root = instance.target.root
    setLocating(true)
    setLocateError(null)
    try {
      await useApp.getState().openProjectPath(root)
      const opened = useApp.getState()
      if (opened.openError) setLocateError({ key, message: opened.openError })
      else if (projectRootKey(opened.snapshot?.meta.root) === projectRootKey(root)) { useMy.getState().setChatWorkdirMode('directory'); setOpen(false) }
      else setLocateError({ key, message: '工程查看目标已变化，请重新定位' })
    } catch { setLocateError({ key, message: '原工程未能打开，请核对目录' }) }
    finally { setLocating(false) }
  }
  const detachReference = async (instance: ApplicationInstanceSummary, reference: ApplicationTaskServiceUse): Promise<void> => {
    const target = { ...instance.target }, targetKey = instanceKey(target), operationKey = `${targetKey}:${reference.id}`
    if (referencePending.current.has(operationKey) || typeof api.appRuntimeDetachInstanceReference !== 'function') return
    referencePending.current.add(operationKey)
    recordReferenceOperation(operationKey, { targetKey, pending: true })
    try {
      const result = await api.appRuntimeDetachInstanceReference(target, reference.id)
      if (!result.ok) recordReferenceOperation(operationKey, { targetKey, pending: false, failed: result.error !== '已取消解绑', message: result.error })
      else if (result.reference.id !== reference.id || result.reference.runId !== target.expectedRunId) recordReferenceOperation(operationKey, { targetKey, pending: false, failed: true, message: '原引用回执不匹配，请核对原实例' })
      else {
        setSelected(before => before && instanceKey(before.target) === targetKey ? { ...before, serviceUses: before.serviceUses?.filter(use => use.id !== reference.id) } : before)
        recordReferenceOperation(operationKey, { targetKey, pending: false, message: '原引用已解除；其他任务引用保留' })
      }
      await refreshApplicationInstances()
    } catch { recordReferenceOperation(operationKey, { targetKey, pending: false, failed: true, message: '解绑结果尚未确认，请按原实例重试此引用' }) }
    finally { referencePending.current.delete(operationKey) }
  }
  return <>
    {variant === 'activity' ? <Tooltip label={activityLabel} side="bottom" align="right"><Button variant="ghost" className="my-header-activity no-drag" aria-label={activityLabel} aria-haspopup="dialog" aria-expanded={open} onClick={() => { setOpen(true); void refreshApplicationInstances() }}><Activity size={16} aria-hidden="true" /><span className="my-item-title">活动</span><span className="my-header-activity-count">{count}</span>{(state.error || state.partial || uncertain) && <span className="text-my-warning-text" aria-hidden="true">!</span>}</Button></Tooltip> : <button type="button" className="no-drag my-control my-button-ghost mr-1 shrink-0" aria-label={`本机运行 ${count} 项${uncertain ? '，有待核对结果' : ''}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => { setOpen(true); void refreshApplicationInstances() }}>
      <Terminal size={14} aria-hidden="true" /><span className="whitespace-nowrap text-my-xs">本机运行 {count}</span>{(state.error || state.partial || uncertain) && <span className="text-my-warning-text" aria-hidden="true">!</span>}
    </button>}
    <Modal open={open} onClose={() => setOpen(false)} ariaLabel="本机运行中心" width="var(--my-run-config-width)">
      <div className="flex min-h-0 flex-col">
        <header className="flex shrink-0 items-center gap-2 border-b border-my-line p-4"><h2 className="min-w-0 flex-1 text-my-lg font-semibold text-my-primary">本机运行 <span className="text-my-sm text-my-tertiary">{count} 项</span></h2><Button variant="ghost" size="sm" disabled={state.loading || !hasIpc} onClick={() => void refreshApplicationInstances()}><RefreshCw size={14} className={state.loading ? 'animate-spin' : undefined} />刷新</Button><button className="my-icon-control" type="button" aria-label="关闭本机运行中心" onClick={() => setOpen(false)}><X size={16} /></button></header>
        <div className="my-scrollbar min-h-0 overflow-y-auto p-4" style={{ maxHeight: '70dvh', scrollbarGutter: 'stable' }}>
          {!hasIpc ? <p className="my-application-empty">桌面端可查看本机运行</p> : <>
            {state.error && <div role="alert" className="my-application-message text-my-danger-text">{state.error}<Button variant="ghost" size="sm" onClick={() => void refreshApplicationInstances()}>重试</Button></div>}
            {state.partial && <p role="status" className="mb-3 text-my-xs text-my-warning-text">清单不完整 · {state.unavailableProjects} 个工程记录不可读取</p>}
            {state.total === null && state.loading && <p role="status" className="flex items-center gap-2 text-my-sm text-my-secondary"><Loader2 size={14} className="animate-spin" />正在读取本机实例…</p>}
            {state.total === 0 && !state.error && !state.partial && <p className="my-application-empty">当前没有受管运行实例</p>}
            <div className={detail ? 'grid min-w-0 gap-4 md:grid-cols-2' : 'min-w-0'}>
              <div className="min-w-0 space-y-4">
                {[...groups].map(([root, instances]) => <section key={root} aria-label={`工作副本 ${root}`}>
                  <h3 className="text-my-sm font-semibold text-my-primary">{copyName(root)}</h3><p className="mb-2 break-all text-my-xs text-my-tertiary">{root}</p>
                  <div className="space-y-2">{instances.map((item) => <article key={instanceKey(item.target)} className="rounded-my-lg border border-my-line p-3" data-run-id={item.run.id}>
                    <button type="button" className="my-control my-button-ghost w-full justify-start text-left" aria-pressed={selectedKey === instanceKey(item.target)} onClick={() => setSelected(item)}><Terminal size={14} className="shrink-0" /><span className="my-item-title min-w-0 break-words text-inherit">{nameOf(item)}</span></button>
                    <div className="mt-2 flex flex-wrap gap-2 text-my-xs"><ProcessStatus app={item} /><ReadinessStatus readiness={item.readiness} /></div>
                    <p className="mt-2 text-my-xs text-my-secondary">{item.runEnvironmentCheck?.status === 'verified' ? '环境已人工核对' : item.environmentCheck?.status === 'changed' ? '环境已变化' : '环境待核实'}{item.configChanged === true ? ' · 有配置变更' : item.configChanged === null ? ' · 启动快照未知' : ''}</p>
                    <p className="mt-1 break-words text-my-xs text-my-tertiary">{item.serviceUses?.length ? `任务引用 ${item.serviceUses.length} 项 · ${item.serviceUses.map(use => use.taskLabel).join('、')}` : '独立运行 · 未登记任务引用'}</p>
                    <p className="mt-1 break-words text-my-xs text-my-secondary">{item.ports.length ? item.ports.map((port) => `${port.host}:${port.port} · ${{ available: '可用', owned: '本实例', 'external-conflict': '外部占用', unknown: '归属未知' }[port.state]}`).join(' / ') : '端口未声明'}</p>
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2"><time className="text-my-xs text-my-tertiary">{new Date(item.run.startedAt).toLocaleString()}</time><Button size="sm" variant="outline" onClick={() => setSelected(item)}>详情与日志</Button></div>
                  </article>)}</div>
                </section>)}
              </div>
              {detail && <section className="min-w-0 rounded-my-lg border border-my-line p-3" aria-label="原实例详情">
                <div className="flex items-center gap-2"><h3 className="my-item-title min-w-0 flex-1 break-words">{nameOf(detail)}</h3><button type="button" className="my-icon-control" aria-label="收起实例详情" onClick={() => setSelected(null)}><ArrowLeft size={14} /></button></div>
                {!current && <p role="status" className="mt-2 text-my-xs text-my-tertiary">原实例已不在当前运行清单</p>}
                <ApplicationRunFacts run={detail.run} configChanged={detail.configChanged} serviceUses={detail.serviceUses} environmentCheck={detail.environmentCheck} runEnvironmentCheck={detail.runEnvironmentCheck} />
                {detail.serviceUses && detail.serviceUses.length > 0 && <section aria-label="原实例任务引用" className="mt-3 space-y-2">
                  <h4 className="text-my-xs font-medium text-my-primary">原实例任务引用</h4>
                  {detail.serviceUses.map(reference => <div key={reference.id} className="flex min-w-0 flex-wrap items-center gap-2 rounded-my-lg border border-my-line p-2 text-my-xs">
                    <div className="min-w-0 flex-1 break-words text-my-secondary">{reference.taskLabel}<br /><span className="text-my-tertiary">尝试 {reference.contextRevision.split(':')[0]} · {reference.coordination === 'ready' ? '使用范围已确认' : '原变更待核对'}</span></div>
                    <Button size="sm" variant="outline" aria-label={`解除 ${reference.taskLabel} 的原引用 ${reference.id.slice(0, 8)}`} disabled={referenceBusy || Boolean(pending) || typeof api.appRuntimeDetachInstanceReference !== 'function'} onClick={() => void detachReference(detail, reference)}>{reference.coordination === 'releasing' ? '重试原解绑' : '解除此引用'}</Button>
                  </div>)}
                </section>}
                {referenceFeedback?.message && <p role={referenceFeedback.failed ? 'alert' : 'status'} className={`mt-2 break-words text-my-xs ${referenceFeedback.failed ? 'text-my-warning-text' : 'text-my-secondary'}`}>{referenceFeedback.message}</p>}
                {detail.lastError && <p role="alert" className="my-application-message text-my-danger-text">{detail.lastError}</p>}
                <div className="mt-3 flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={!current?.canStop || Boolean(pending) || referenceBusy} onClick={() => void operateInstance(detail, 'stop')}><Square size={12} />停止此实例</Button><Button size="sm" variant="outline" disabled={!current?.canRestart || Boolean(pending) || referenceBusy} onClick={() => void operateInstance(detail, 'restart')}><RefreshCw size={12} />核对并重启</Button></div>
                <div className="mt-2"><Button size="sm" variant="ghost" disabled={locating} onClick={() => void locate(detail)}>{locating ? <Loader2 size={12} className="animate-spin" /> : <FolderOpen size={12} />}查看原工程</Button></div>
                {locateError?.key === selectedKey && <p role="alert" className="my-application-message text-my-danger-text">{locateError.message}</p>}
                <InstanceOutput key={instanceKey(detail.target)} instance={detail} />
              </section>}
            </div>
            {state.receipts.length > 0 && <section className="mt-4 border-t border-my-line pt-3" aria-label="运行操作结果"><h3 className="text-my-sm font-semibold text-my-primary">操作结果</h3><ol className="mt-2 space-y-2">{[...state.receipts].reverse().map((item) => <li key={item.id} className="rounded-my-lg border border-my-line p-3 text-my-xs"><div className="flex items-center gap-2 text-my-primary">{item.pending && <Loader2 size={12} className="animate-spin" />}<span className="break-words">{item.name} · {{ start: '启动', stop: '停止', restart: '重启' }[item.action]}</span></div><p role="status" className={`mt-1 break-words ${item.unknown || item.result?.ok === false ? 'text-my-warning-text' : 'text-my-secondary'}`}>{runReceiptMessage(item)}</p><details className="mt-1 text-my-tertiary"><summary className="cursor-pointer">原目标</summary><p className="break-all">{item.root}<br />{item.appId} · {item.runId ?? '新启动'}{item.result?.restart && <><br />重启阶段：{item.result.restart.phase}</>}</p></details></li>)}</ol></section>}
          </>}
        </div>
      </div>
    </Modal>
  </>
}
