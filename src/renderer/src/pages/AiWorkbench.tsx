import { useEffect, useRef, useState } from 'react'
import { Bot, Square, ChevronDown, ChevronRight, Sparkles, Terminal, RefreshCw, FileText } from 'lucide-react'
import { useApp } from '../store'
import { api } from '../api'
import { clsx } from 'clsx'
import type { JSX } from 'react'
import type { AiRunCard } from '../store'

/**
 * AI 工作台 —— 面板内驱动 AI 的执行台：
 * 每次发起需求/交给 AI，在面板后台以非交互模式运行（codex exec / claude -p），
 * 输出实时流回卡片。任务文件落盘后看板/收件箱自动更新。
 */
export function AiWorkbenchPage(): JSX.Element {
  const aiRuns = useApp((s) => s.aiRuns)
  const snapshot = useApp((s) => s.snapshot)!
  const setIntakeOpen = useApp((s) => s.setIntakeOpen)
  const setPage = useApp((s) => s.setPage)
  const showTask = useApp((s) => s.showTask)
  const pushToast = useApp((s) => s.pushToast)

  const running = aiRuns.filter((r) => r.status === 'running')
  const finished = aiRuns.filter((r) => r.status !== 'running')

  const openTask = (dirName: string | null): void => {
    if (!dirName) return
    setPage('tasks')
    showTask(dirName)
  }

  return (
    <div className="flex h-full min-w-0 animate-fade-in flex-col">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-700 bg-ink-850/40 px-5 py-2.5">
        <Bot size={15} className="text-leaf" />
        <h1 className="text-base font-semibold text-mist-50">AI 工作台</h1>
        {running.length > 0 && (
          <span className="chip border border-amber-400/30 bg-amber-500/15 text-amber-300">
            <RefreshCw size={10} className="animate-spin" /> {running.length} 个执行中
          </span>
        )}
        <div className="ml-auto flex gap-1.5">
          <button onClick={() => setIntakeOpen(true)} className="btn-primary">
            <Sparkles size={12} /> 发起需求
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {aiRuns.length === 0 && (
          <div className="grid place-items-center gap-3 py-24 text-mist-600">
            <Terminal size={36} strokeWidth={1.2} />
            <div className="text-sm">还没有 AI 执行记录</div>
            <div className="max-w-md text-center text-[11.5px] leading-5">
              点「发起需求」写需求并选择 AI，它会在面板后台执行（codex / claude 非交互模式），
              进度和输出实时流到这里；AI 建的任务文件会自动出现在看板与收件箱。
            </div>
            <button onClick={() => setIntakeOpen(true)} className="btn-primary mt-1">
              <Sparkles size={12} /> 发起第一个需求
            </button>
          </div>
        )}

        {running.length > 0 && (
          <>
            <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-mist-500">执行中</div>
            <div className="space-y-3">
              {running.map((r) => (
                <RunCard key={r.runId} run={r} openTask={openTask} pushToast={pushToast} defaultOpen />
              ))}
            </div>
          </>
        )}

        {finished.length > 0 && (
          <>
            <div className="mb-2 mt-6 text-[11px] font-medium uppercase tracking-wide text-mist-500">历史</div>
            <div className="space-y-3">
              {finished.map((r) => (
                <RunCard key={r.runId} run={r} openTask={openTask} pushToast={pushToast} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function RunCard({
  run,
  openTask,
  pushToast,
  defaultOpen
}: {
  run: AiRunCard
  openTask: (dir: string | null) => void
  pushToast: (t: { kind: 'info' | 'success' | 'warn' | 'error'; title: string; body?: string }) => void
  defaultOpen?: boolean
}): JSX.Element {
  const [open, setOpen] = useState(Boolean(defaultOpen))
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open && run.status === 'running') {
      boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight })
    }
  }, [run.lines.length, open, run.status])

  const status = {
    running: { label: '执行中', cls: 'border-amber-400/30 bg-amber-500/15 text-amber-300', spin: true },
    done: { label: '完成', cls: 'border-emerald-400/30 bg-emerald-500/15 text-emerald-300', spin: false },
    failed: { label: '失败', cls: 'border-rose-400/30 bg-rose-500/15 text-rose-300', spin: false },
    aborted: { label: '已中止', cls: 'border-ink-500 bg-ink-700/60 text-mist-300', spin: false }
  }[run.status]

  const lastLine = run.lines[run.lines.length - 1]?.text ?? ''

  return (
    <div
      className={clsx(
        'overflow-hidden rounded-xl border bg-ink-800',
        run.status === 'running' ? 'border-amber-400/25' : 'border-ink-700'
      )}
    >
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2.5 px-4 py-3 text-left">
        {open ? <ChevronDown size={13} className="shrink-0 text-mist-500" /> : <ChevronRight size={13} className="shrink-0 text-mist-500" />}
        <span
          className={clsx(
            'grid h-7 w-7 shrink-0 place-items-center rounded-lg text-[11px] font-bold',
            run.app === 'codex' ? 'bg-sky-500/15 text-sky-300' : 'bg-violet-500/15 text-violet-300'
          )}
        >
          {run.app === 'codex' ? 'CX' : 'CL'}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-mist-100">{run.label}</div>
          <div className="truncate font-mono text-[10px] text-mist-500">
            {run.app} · {new Date(run.startedAt).toLocaleTimeString()}
            {run.status === 'running' ? '' : ` · 退出码 ${run.code ?? '?'}`}
            {lastLine ? ` · ${lastLine.slice(0, 60)}` : ''}
          </div>
        </div>
        <span className={clsx('chip flex shrink-0 items-center gap-1 border', status.cls)}>
          {status.spin && <RefreshCw size={10} className="animate-spin" />}
          {status.label}
        </span>
      </button>

      {open && (
        <div className="border-t border-ink-700/70">
          <div
            ref={boxRef}
            className="max-h-72 overflow-y-auto bg-ink-950 px-4 py-2.5 font-mono text-[11px] leading-[1.6]"
          >
            {run.lines.length === 0 && <div className="text-mist-600">等待输出…</div>}
            {run.lines.map((l, i) => (
              <div key={i} className={clsx('whitespace-pre-wrap break-words', l.err ? 'text-rose-300/90' : 'text-mist-300')}>
                {l.text}
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 px-4 py-2">
            {run.status === 'running' ? (
              <button
                onClick={async () => {
                  await api.aiAbortRun(run.runId)
                  pushToast({ kind: 'info', title: '已发送中止信号', body: run.label })
                }}
                className="btn bg-rose-500/15 text-rose-300 hover:bg-rose-500/25"
              >
                <Square size={11} /> 中止
              </button>
            ) : null}
            {run.taskDir && (
              <button onClick={() => openTask(run.taskDir)} className="btn-outline">
                <FileText size={11} /> 打开任务
              </button>
            )}
            <span className="ml-auto font-mono text-[10px] text-mist-600">#{run.runId}</span>
          </div>
        </div>
      )}
    </div>
  )
}
