import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Loader2, Sparkles, TriangleAlert, X } from 'lucide-react'
import { api } from '../api'
import { useApp } from '../store'
import { MarkdownView } from './MarkdownView'

/**
 * T4 扩展：AI 起草任务。一句话需求 → planner worker（项目内官方流程：
 * task.py create + 仅写 prd.md）→ 报告含任务目录名，可一键直达审阅。
 * 面板自身不建任务（R0 边界）：写入全部由有工作流身份的 worker 完成。
 */

const PHASES: Array<{ key: string; label: string }> = [
  { key: 'create', label: '创建临时频道' },
  { key: 'spawn', label: '拉起 planner worker（codex · workspace-write）' },
  { key: 'send', label: '发送需求' },
  { key: 'wait', label: '等待起草完成（最长 15 分钟）' },
  { key: 'collect', label: '收取起草报告' },
  { key: 'cleanup', label: '留存频道（对话可在 AI 频道页回看）' }
]

/** 从报告里抠任务目录名（planner 档案规定的格式：`- 任务目录：<dir>`） */
function extractDirName(report: string): string | null {
  const m = /任务目录[:：]\s*`?([\w.-]+)`?/.exec(report)
  return m?.[1] ?? null
}

export function PlannerModal({ onClose }: { onClose: () => void }): JSX.Element {
  const pushToast = useApp((s) => s.pushToast)
  const showTask = useApp((s) => s.showTask)
  const refresh = useApp((s) => s.refresh)
  const [title, setTitle] = useState('')
  const [requirement, setRequirement] = useState('')
  const [running, setRunning] = useState(false)
  const [doneKey, setDoneKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [report, setReport] = useState<string | null>(null)
  const busyRef = useRef(false)

  useEffect(() => {
    const off = api.onDispatchPhase?.((p) => setDoneKey(p.key))
    return () => {
      off?.()
    }
  }, [])

  const run = async (): Promise<void> => {
    if (!title.trim() || !requirement.trim()) return
    setRunning(true)
    setError(null)
    setReport(null)
    setDoneKey(null)
    try {
      if (typeof api.taskDispatchPlan !== 'function') {
        throw new Error('当前会话的 preload 过期（缺少派发 API）——请重启 npm run dev 同步')
      }
      const res = await api.taskDispatchPlan({ title: title.trim(), requirement: requirement.trim() })
      setRunning(false)
      if (res.ok && res.report) {
        setReport(res.report)
        pushToast({ kind: 'success', title: '任务已起草', body: 'PRD 待你审阅' })
        void refresh()
      } else {
        setError(res.error ?? `在 ${res.phase ?? '?'} 阶段失败`)
      }
    } catch (e) {
      setRunning(false)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const close = (): void => {
    if (running && !busyRef.current) {
      void api.taskDispatchAbort()
      pushToast({ kind: 'info', title: '已中止起草', body: '正在终止进程链' })
    }
    onClose()
  }

  const newDir = report ? extractDirName(report) : null
  const activeIdx = PHASES.findIndex((p) => p.key === doneKey)

  return (
    <div
      className="fixed inset-0 z-[55] grid place-items-center bg-ink-950/60 p-6 backdrop-blur-sm"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-ink-600 bg-ink-900 shadow-2xl">
        <div className="flex items-center gap-2 border-b border-ink-700 px-4 py-3">
          <Sparkles size={14} className="text-leaf" />
          <span className="text-xs font-semibold text-mist-100">AI 起草任务</span>
          <span className="min-w-0 flex-1 truncate text-[10.5px] text-mist-500">一句话需求 → planner worker 在项目内走官方流程建任务写 PRD</span>
          <button onClick={close} className="btn-ghost justify-center px-1.5">
            <X size={13} />
          </button>
        </div>

        {/* 输入区（运行后收起） */}
        {!running && !report && !error && (
          <div className="space-y-3 border-b border-ink-700/60 p-4">
            <label className="block">
              <span className="mb-1 block text-[11px] text-mist-400">任务标题</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：给 Jira 页加只读对照视图" className="field w-full text-xs" />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] text-mist-400">需求描述（一两句话即可，模糊处 worker 会写进 PRD 的开放问题）</span>
              <textarea
                value={requirement}
                onChange={(e) => setRequirement(e.target.value)}
                rows={4}
                placeholder="例如：Jira 页改成并排对照，本地阶段和 Jira 状态各显示各的，不自动同步"
                className="field w-full resize-none text-xs"
              />
            </label>
            <div className="flex items-center justify-between">
              <span className="text-[10.5px] text-mist-600">worker 只建任务和写 PRD，不实施；完成后你来审阅</span>
              <button onClick={() => void run()} disabled={!title.trim() || !requirement.trim()} className="btn-primary disabled:opacity-40">
                <Sparkles size={12} /> 派发起草
              </button>
            </div>
          </div>
        )}

        {/* 阶段进度 */}
        {(running || report || error) && (
          <div className="border-b border-ink-700/60 px-4 py-3">
            <div className="space-y-1">
              {PHASES.map((p, i) => {
                const state = !running && report ? 'done' : i < activeIdx ? 'done' : i === activeIdx ? (running ? 'active' : 'done') : 'pending'
                return (
                  <div key={p.key} className="flex items-center gap-2 text-[11px]">
                    {state === 'done' && <CheckCircle2 size={12} className="shrink-0 text-leaf" />}
                    {state === 'active' && <Loader2 size={12} className="shrink-0 animate-spin text-leaf-soft" />}
                    {state === 'pending' && <span className="h-3 w-3 shrink-0 rounded-full border border-ink-600" />}
                    <span className={state === 'pending' ? 'text-mist-600' : 'text-mist-300'}>{p.label}</span>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* 结果区 */}
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {error && (
            <div className="flex items-start gap-1.5 rounded-lg border border-rose-500/30 bg-rose-500/5 p-2.5 text-[11px] text-rose-300">
              <TriangleAlert size={12} className="mt-0.5 shrink-0" />
              <span className="whitespace-pre-wrap">{error}</span>
            </div>
          )}
          {report && (
            <>
              <div className="mb-2 text-[11px] font-semibold text-mist-300">起草报告</div>
              <div className="rounded-lg border border-ink-700 bg-ink-950 p-3">
                <MarkdownView content={report} />
              </div>
            </>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-ink-700 px-4 py-3">
          <span className="text-[10.5px] text-mist-600">PRD 由 worker 写入任务目录；实施永远等你审阅后另行派发</span>
          <div className="flex items-center gap-2">
            {running ? (
              <button onClick={close} className="btn-outline">中止起草</button>
            ) : (
              <>
                <button onClick={close} className="btn-ghost">关闭</button>
                {newDir && (
                  <button
                    onClick={() => {
                      showTask(newDir)
                      close()
                    }}
                    className="btn-primary"
                  >
                    查看新任务 →
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
