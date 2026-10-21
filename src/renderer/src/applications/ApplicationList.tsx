import { useEffect, useRef, useState, type JSX } from 'react'
import { CircleCheck, CircleHelp, CircleX, ChevronDown, ChevronRight, Loader2, Pause, Play, RefreshCw, Settings2, Square, Terminal, Trash2, TriangleAlert } from 'lucide-react'
import type { ApplicationLogsResult, ApplicationProcessState, ApplicationReadinessState, ApplicationSummary } from '@shared/app-runtime'
import { api, hasIpc } from '../api'
import { Button, Tooltip } from '../my/ui'
import { applicationsGeneration, matchesApplicationRoot, openApplicationEditor, refreshApplications, runApplication, useApplications } from './useApplications'

const PROCESS_LABELS: Record<ApplicationProcessState, string> = {
  stopped: '未启动', starting: '正在启动', running: '进程运行中', stopping: '正在停止',
  exited: '已退出', failed: '运行失败', unknown: '进程状态未知', 'cleanup-required': '停止未完成'
}
const READINESS_LABELS: Record<ApplicationReadinessState['state'], string> = {
  'not-configured': '未配置就绪检查', checking: '等待服务就绪', ready: '服务已就绪', unhealthy: '服务未就绪', unknown: '服务状态未知'
}

export function ProcessStatus({ app }: { app: ApplicationSummary }): JSX.Element {
  const working = app.processState === 'starting' || app.processState === 'stopping'
  const failure = app.processState === 'failed' || app.processState === 'cleanup-required'
  const Icon = working ? Loader2 : failure ? CircleX : app.processState === 'unknown' ? CircleHelp : Terminal
  return <span className={`inline-flex items-center gap-1.5 ${failure ? 'text-my-danger-text' : app.processState === 'unknown' ? 'text-my-warning-text' : 'text-my-secondary'}`} data-process-state={app.processState}>
    <Icon size={13} aria-hidden="true" className={working ? 'animate-spin' : undefined} />{PROCESS_LABELS[app.processState]}
  </span>
}

export function ReadinessStatus({ readiness }: { readiness: ApplicationReadinessState }): JSX.Element {
  const Icon = readiness.state === 'ready' ? CircleCheck : readiness.state === 'unhealthy' ? TriangleAlert : readiness.state === 'checking' ? Loader2 : CircleHelp
  return <span title={readiness.message} className={`inline-flex items-center gap-1.5 ${readiness.state === 'ready' ? 'text-my-success-text' : readiness.state === 'unhealthy' ? 'text-my-warning-text' : 'text-my-tertiary'}`} data-readiness-state={readiness.state}>
    <Icon size={13} aria-hidden="true" className={readiness.state === 'checking' ? 'animate-spin' : undefined} />{READINESS_LABELS[readiness.state]}
  </span>
}

export function ApplicationOutput({ app, root, generation, compact = false, docked = false }: { app: ApplicationSummary; root: string; generation: number; compact?: boolean; docked?: boolean }): JSX.Element {
  const [logs, setLogs] = useState<Extract<ApplicationLogsResult, { ok: true }> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [follow, setFollow] = useState(true)
  const preRef = useRef<HTMLPreElement>(null)
  const id = app.definition.id
  const runId = app.run?.id

  useEffect(() => {
    let live = true
    let sequence = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    setLogs(null)
    setError(null)
    const read = async (): Promise<void> => {
      const requested = ++sequence
      try {
        const result = await api.appRuntimeLogs(root, id)
        if (!live || generation !== applicationsGeneration() || requested !== sequence) return
        if (result.ok === true && matchesApplicationRoot(result.root) && result.appId === id && result.runId === (runId ?? null)) { setLogs(result); setError(null) }
        else if (result.ok === false) setError(result.error)
      } catch { if (live && generation === applicationsGeneration() && requested === sequence) setError('输出读取失败，请重新展开。') }
    }
    const unsubscribe = api.onAppRuntimeEvent((event) => {
      if (event.appId !== id || !matchesApplicationRoot(event.root)) return
      if (timer) return
      timer = setTimeout(() => { timer = undefined; void read() }, 150)
    })
    void read()
    const recovery = setInterval(() => { void read() }, 2000)
    return () => { live = false; sequence += 1; clearTimeout(timer); clearInterval(recovery); unsubscribe() }
  }, [root, generation, id, runId])

  useEffect(() => {
    if (follow && preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight
  }, [logs?.output, follow])

  return <section aria-label={`${app.definition.name} 输出`} className={`my-application-output ${docked ? 'is-docked' : ''}`}>
    <div className="flex flex-wrap items-center gap-2 px-3 py-2">
      <h4 className="flex-1 text-my-xs font-medium text-my-secondary">运行输出</h4>
      <Button variant="ghost" size="sm" aria-pressed={follow} onClick={() => setFollow((value) => !value)}>{follow ? <Pause size={12} /> : <Play size={12} />}{follow ? '暂停跟随' : '继续跟随'}</Button>
    </div>
    {logs?.outputTruncated && <p className="px-3 pb-2 text-my-xs text-my-tertiary">早期输出已截断</p>}
    {error ? <p role="alert" className="my-application-message text-my-danger-text">{error}</p>
      : <pre ref={preRef} aria-label="应用输出内容" tabIndex={0} className={`my-application-console my-scrollbar ${compact ? 'is-compact' : ''}`}>{logs ? logs.output || '暂无输出' : '正在读取输出…'}</pre>}
  </section>
}

export function ApplicationList({ compact = false, onOpenEditor }: { compact?: boolean; onOpenEditor?: () => void }): JSX.Element {
  const state = useApplications()
  const [expanded, setExpanded] = useState<string | null>(null)
  useEffect(() => setExpanded(null), [state.generation])

  if (!hasIpc) return <div className="my-application-empty"><Terminal size={20} aria-hidden="true" /><p>桌面端可管理本地应用</p></div>
  if (!state.root) return <div className="my-application-empty"><Terminal size={20} aria-hidden="true" /><p>选择项目后添加应用</p></div>
  if (state.loading && state.apps.length === 0) return <div className="my-application-empty" role="status"><Loader2 size={18} className="animate-spin" aria-hidden="true" /><p>正在读取应用…</p></div>

  return <div className="my-application-list" data-app-root={state.root}>
    {state.error && <div role="alert" className="my-application-message text-my-danger-text"><span>{state.error}</span><Button variant="ghost" size="sm" onClick={() => void refreshApplications()}>重试</Button></div>}
    {!state.loading && state.apps.length === 0 && !state.error && <div className="my-application-empty"><Terminal size={20} aria-hidden="true" /><p>还没有应用</p><span className="text-my-xs text-my-tertiary">添加启动命令，或导入项目的 npm 脚本。</span></div>}
    {state.apps.map((app) => {
      const { definition } = app
      const busy = state.busy[definition.id]
      const outputOpen = expanded === definition.id
      const error = state.errors[definition.id] || app.lastError
      return <article key={definition.id} className="my-application-card" data-app-id={definition.id}>
        <div className="flex min-w-0 items-start gap-2">
          <div className="min-w-0 flex-1"><h3 className="break-words text-my-sm font-semibold text-my-primary">{definition.name}</h3><p title={definition.cwd} className="mt-0.5 truncate text-my-xs text-my-tertiary">{definition.cwd === '.' ? '项目目录' : definition.cwd}</p></div>
          <Tooltip label={`编辑 ${definition.name}`}><button type="button" className="my-icon-control" disabled={Boolean(busy)} aria-label={`编辑 ${definition.name}`} onClick={(event) => { onOpenEditor?.(); openApplicationEditor({ kind: 'edit', definition }, state.generation, event.currentTarget) }}><Settings2 size={14} /></button></Tooltip>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1.5 text-my-xs"><ProcessStatus app={app} /><ReadinessStatus readiness={app.readiness} /></div>
        {app.ports.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5" aria-label="端口状态">{app.ports.map((port) => <span key={`${port.host}:${port.port}`} title={[port.host, port.pid ? `PID ${port.pid}` : '', port.message].filter(Boolean).join(' · ')} className={`my-chip ${port.state === 'external-conflict' ? 'bg-my-warning-subtle text-my-warning-text' : 'bg-my-layer-1 text-my-secondary'}`}>
          {port.port}{port.state === 'external-conflict' ? ' · 被占用' : port.state === 'unknown' ? ' · 未知' : port.state === 'owned' ? ' · 本应用' : app.processState === 'running' ? '' : ' · 可用'}
        </span>)}</div>}
        {app.run && <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-my-2xs text-my-tertiary">{app.run.pid !== null && <span>PID {app.run.pid}</span>}{app.run.exitCode !== null && <span>退出码 {app.run.exitCode}</span>}{app.run.signal && <span>{app.run.signal}</span>}</div>}
        {app.approval === 'pending' && <p role="status" className="mt-2 flex items-center gap-1.5 text-my-xs text-my-warning-text"><TriangleAlert size={13} />等待你确认启动配置</p>}
        {error && <p role="alert" className="my-application-message mt-2 text-my-danger-text">{error}</p>}
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {app.canStart && <Button size="sm" variant="primary" disabled={Boolean(busy)} onClick={() => void runApplication(app, 'start', state.generation)} aria-label={`启动 ${definition.name}`}><Play size={12} />{app.approval === 'approved' ? '启动' : '确认并启动'}</Button>}
          {app.canStop && <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => void runApplication(app, 'stop', state.generation)} aria-label={`停止 ${definition.name}`}><Square size={12} />停止</Button>}
          {app.canRestart && app.run && <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => void runApplication(app, 'restart', state.generation)} aria-label={`重启 ${definition.name}`}><RefreshCw size={12} />重启</Button>}
          {busy && <span role="status" className="inline-flex items-center gap-1.5 text-my-xs text-my-secondary"><Loader2 size={13} className="animate-spin" />{busy}</span>}
          <Button size="sm" variant="ghost" aria-expanded={outputOpen} aria-label={`${outputOpen ? '收起' : '查看'} ${definition.name} 输出`} onClick={() => setExpanded(outputOpen ? null : definition.id)}>{outputOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}输出</Button>
          <button type="button" className="my-icon-control ml-auto" aria-label={`删除 ${definition.name}`} disabled={Boolean(busy) || app.canStop || app.processState === 'unknown' || app.processState === 'cleanup-required'} onClick={(event) => { onOpenEditor?.(); openApplicationEditor({ kind: 'remove', definition }, state.generation, event.currentTarget) }}><Trash2 size={13} /></button>
        </div>
        {outputOpen && state.root && <ApplicationOutput key={`${state.generation}:${definition.id}:${app.run?.id ?? 'unstarted'}`} app={app} root={state.root} generation={state.generation} compact={compact} />}
      </article>
    })}
  </div>
}
