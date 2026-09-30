import { useEffect, useRef, useState } from 'react'
import { ClipboardCopy, Loader2, TriangleAlert, X } from 'lucide-react'
import type { TaskInfo } from '../../../shared/types'
import { api } from '../api'
import { useApp } from '../store'
import { Select } from './Select'

/**
 * T3：任务交接包弹窗（06 v2 §2 / 05 §5.2 合同）。
 * 确定性文本可预览可编辑可复制；意图默认"只核对与阅读"；
 * 附加 PRD 原文必须显式勾选（勾选即预览到将离开本机的内容）。
 */

const INTENTS = [
  { value: 'read', label: '只核对与阅读' },
  { value: 'review', label: '审阅计划并给意见' },
  { value: 'implement', label: '继续实施（按工作流推进）' },
  { value: 'custom', label: '自定义…' }
] as const

const INTENT_TEXT: Record<string, string> = {
  read: '只核对与阅读，不开始实施',
  review: '审阅当前计划与材料，给出修改意见与风险，不开始实施',
  implement: '继续实施本任务，按 workflow.md 当前阶段推进，重大范围变化先停下确认'
}

export function HandoffModal({ task, onClose }: { task: TaskInfo; onClose: () => void }): JSX.Element {
  const pushToast = useApp((s) => s.pushToast)
  const [intentKind, setIntentKind] = useState<string>('read')
  const [customIntent, setCustomIntent] = useState('')
  const [text, setText] = useState('')
  const [issues, setIssues] = useState<string[]>([])
  const [includePrd, setIncludePrd] = useState(false)
  const [building, setBuilding] = useState(true)
  const seqRef = useRef(0)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const effectiveIntent =
    intentKind === 'custom' ? customIntent : INTENT_TEXT[intentKind] ?? INTENT_TEXT.read

  useEffect(() => {
    const run = (): void => {
      const seq = (seqRef.current += 1)
      setBuilding(true)
      void api.taskHandoffBuild(task.dirName, effectiveIntent, includePrd).then((res) => {
        if (seq !== seqRef.current) return
        setBuilding(false)
        if (res.ok) {
          setText(res.text)
          setIssues(res.issues)
        } else {
          setText('')
          setIssues([res.error ?? '构建失败'])
        }
      })
    }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(run, intentKind === 'custom' ? 400 : 0)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [task.dirName, effectiveIntent, includePrd])

  const copy = async (): Promise<void> => {
    if (!text.trim()) return
    await api.copyToClipboard(text)
    pushToast({ kind: 'success', title: '交接包已复制', body: '粘贴到任意 AI 会话即可接续；内容将离开本机' })
  }

  return (
    <div
      className="fixed inset-0 z-[55] grid place-items-center bg-ink-950/60 p-6 backdrop-blur-sm"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-ink-600 bg-ink-900 shadow-2xl">
        <div className="flex items-center gap-2 border-b border-ink-700 px-4 py-3">
          <ClipboardCopy size={14} className="text-leaf" />
          <span className="text-xs font-semibold text-mist-100">任务交接包</span>
          <span className="min-w-0 flex-1 truncate text-[10.5px] text-mist-500">
            {task.record?.title ?? task.dirName}
          </span>
          <button onClick={onClose} className="btn-ghost justify-center px-1.5">
            <X size={13} />
          </button>
        </div>

        <div className="flex items-center gap-3 border-b border-ink-700/60 px-4 py-2.5">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-mist-400">本次意图</span>
            <Select value={intentKind} onChange={setIntentKind} options={INTENTS.map((i) => ({ value: i.value, label: i.label }))} className="w-44" size="sm" />
          </div>
          {intentKind === 'custom' && (
            <input
              value={customIntent}
              onChange={(e) => setCustomIntent(e.target.value)}
              placeholder="例如：只评审设计文档第 3 节"
              className="field h-7 flex-1 text-xs"
            />
          )}
          <label className="ml-auto flex shrink-0 cursor-pointer items-center gap-1.5 text-[11px] text-mist-400" title="默认只带索引与路径；勾选后 PRD 原文进入剪贴板，粘贴给外部模型即离开本机">
            <input
              type="checkbox"
              checked={includePrd}
              onChange={(e) => setIncludePrd(e.target.checked)}
              className="accent-emerald-500"
            />
            附加 PRD 原文
          </label>
        </div>

        {issues.length > 0 && (
          <div className="flex items-start gap-1.5 border-b border-ink-700/60 bg-amber-500/5 px-4 py-2 text-[11px] text-amber-300/90">
            <TriangleAlert size={12} className="mt-0.5 shrink-0" />
            <span>已知读取问题（已写入交接包）：{issues.join('；')}</span>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {building ? (
            <div className="flex h-40 items-center justify-center text-mist-500">
              <Loader2 size={16} className="animate-spin" />
            </div>
          ) : (
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
              className="h-full min-h-[240px] w-full resize-none rounded-lg border border-ink-700 bg-ink-950 p-3 font-mono text-[11.5px] leading-5 text-mist-200 focus:border-leaf-dim/50 focus:outline-none"
            />
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-ink-700 px-4 py-3">
          <span className="text-[10.5px] text-mist-600">粘贴给外部模型时，以上内容将离开本机——可先编辑删减</span>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="btn-ghost">关闭</button>
            <button onClick={() => void copy()} disabled={!text.trim()} className="btn-primary disabled:opacity-40">
              <ClipboardCopy size={12} /> 复制交接包
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
