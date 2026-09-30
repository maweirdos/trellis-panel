import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Loader2, ShieldCheck, TriangleAlert, X } from 'lucide-react'
import type { TaskInfo } from '../../../shared/types'
import { api } from '../api'
import { useApp } from '../store'
import { MarkdownView } from './MarkdownView'

/**
 * T4 能力验证：一键派 codex + read-only worker 只读审阅。
 * 合同：报告固定三段（结论/风险/待确认）；worker 只喂任务材料；
 * 关闭弹窗可中止（主进程树杀整条 trellis 进程链）。
 * 验证点：确实未写源码（git status 无变化）、报告可解析、待确认问题回到人。
 */

const PHASES: Array<{ key: string; label: string }> = [
  { key: 'create', label: '创建临时频道' },
  { key: 'spawn', label: '拉起只读 worker（codex · read-only 沙箱）' },
  { key: 'send', label: '发送审阅指令（仅任务材料）' },
  { key: 'wait', label: '等待审阅完成（最长 20 分钟）' },
  { key: 'collect', label: '收取报告' },
  { key: 'cleanup', label: '清理临时频道' }
]

export function DispatchModal({ task, onClose }: { task: TaskInfo; onClose: () => void }): JSX.Element {
  const pushToast = useApp((s) => s.pushToast)
  const [running, setRunning] = useState(false)
  const [doneKey, setDoneKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [report, setReport] = useState<string | null>(null)
  const startedRef = useRef(false)

  useEffect(() => {
    const off = api.onDispatchPhase((p) => {
      setDoneKey(p.key)
    })
    return () => {
      off()
    }
  }, [])

  const run = async (): Promise<void> => {
    setRunning(true)
    setError(null)
    setReport(null)
    setDoneKey(null)
    const res = await api.taskDispatchReview(task.dirName)
    setRunning(false)
    if (res.ok && res.report) {
      setReport(res.report)
      pushToast({ kind: 'success', title: '只读审阅完成', body: task.dirName })
    } else {
      setError(res.error ?? `在 ${res.phase ?? '?'} 阶段失败`)
    }
  }

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    void run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const close = (): void => {
    if (running) {
      void api.taskDispatchAbort()
      pushToast({ kind: 'info', title: '已中止派发', body: '正在终止 trellis 进程链' })
    }
    onClose()
  }

  const activeIdx = PHASES.findIndex((p) => p.key === doneKey)

  return (
    <div
      className="fixed inset-0 z-[55] grid place-items-center bg-ink-950/60 p-6 backdrop-blur-sm"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-ink-600 bg-ink-900 shadow-2xl">
        <div className="flex items-center gap-2 border-b border-ink-700 px-4 py-3">
          <ShieldCheck size={14} className="text-leaf" />
          <span className="text-xs font-semibold text-mist-100">只读审阅（Codex worker）</span>
          <span className="min-w-0 flex-1 truncate text-[10.5px] text-mist-500">{task.record?.title ?? task.dirName}</span>
          <button onClick={close} className="btn-ghost justify-center px-1.5">
            <X size={13} />
          </button>
        </div>

        {/* 阶段进度 */}
        <div className="border-b border-ink-700/60 px-4 py-3">
          <div className="space-y-1">
            {PHASES.map((p, i) => {
              const state = !running && report
                ? 'done'
                : i < activeIdx
                  ? 'done'
                  : i === activeIdx
                    ? running
                      ? 'active'
                      : 'done'
                    : 'pending'
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
          <div className="mt-2 text-[10px] text-mist-600">
            派单铁律：trellis 子进程以本项目根为工作目录（频道记账不串项目）；worker 处于 read-only 沙箱，仅读取随指令附上的任务材料。
          </div>
        </div>

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
              <div className="mb-2 text-[11px] font-semibold text-mist-300">审阅报告（worker 产出，未写任何文件）</div>
              <div className="rounded-lg border border-ink-700 bg-ink-950 p-3">
                <MarkdownView content={report} />
              </div>
            </>
          )}
          {!running && !report && !error && (
            <div className="flex h-24 items-center justify-center text-[11px] text-mist-600">准备派发…</div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-ink-700 px-4 py-3">
          <span className="text-[10.5px] text-mist-600">关闭弹窗即中止在途派发；报告仅本次展示，不写任务目录</span>
          <div className="flex items-center gap-2">
            {running ? (
              <button onClick={close} className="btn-outline">中止派发</button>
            ) : (
              <>
                <button onClick={close} className="btn-ghost">关闭</button>
                <button onClick={() => void run()} className="btn-primary">重跑审阅</button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
