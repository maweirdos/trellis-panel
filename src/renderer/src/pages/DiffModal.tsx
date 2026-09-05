import { GitCompare, Save, X } from 'lucide-react'
import { statusLabel } from '../utils/labels'
import type { JSX } from 'react'
import type { TaskInfo, TaskPatch } from '../../../shared/types'

const FIELD_LABEL: Record<string, string> = {
  title: '标题',
  description: '描述',
  status: '状态',
  priority: '优先级',
  assignee: '负责人',
  notes: '备注',
  branch: '分支',
  pr_url: 'PR 链接',
  subtasks: '子任务'
}

/** 任务修改预览：保存前逐字段对比旧值 → 新值。 */
export function DiffModal({
  task,
  pending,
  onCancel,
  onSave
}: {
  task: TaskInfo
  pending: TaskPatch
  onCancel: () => void
  onSave: () => void
}): JSX.Element {
  const r = task.record
  const entries = Object.entries(pending) as Array<[keyof TaskPatch, unknown]>
  if (!r) return <></>

  return (
    <div className="absolute inset-0 z-30 grid animate-fade-in place-items-center bg-black/50 p-4" onClick={onCancel}>
      <div
        className="card flex max-h-[80%] w-full max-w-sm flex-col overflow-hidden !bg-ink-800 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-ink-700 px-4 py-2.5">
          <GitCompare size={13} className="text-leaf" />
          <span className="text-xs font-semibold text-mist-100">保存预览 — {entries.length} 处修改</span>
          <button onClick={onCancel} className="btn-ghost ml-auto px-1.5 py-1">
            <X size={14} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {entries.map(([field, newVal]) => {
            const oldVal = (r as any)[field]
            const fmt = (v: unknown): string => {
              if (v === null || v === undefined || v === '') return '（空）'
              if (Array.isArray(v)) return v.join('\n')
              return String(v)
            }
            return (
              <div key={String(field)} className="mb-2.5 rounded-lg border border-ink-700 bg-ink-850 px-3 py-2">
                <div className="mb-1 text-[10.5px] font-medium text-mist-400">
                  {FIELD_LABEL[String(field)] ?? String(field)}
                  {String(field) === 'status' && (
                    <span className="ml-1.5 text-mist-600">
                      （{statusLabel(String(oldVal))} → {statusLabel(String(newVal))}）
                    </span>
                  )}
                </div>
                <div className="space-y-1 text-[11px] leading-5">
                  <div className="rounded bg-rose-500/10 px-2 py-0.5 text-rose-300/90 line-through decoration-rose-400/50">
                    {fmt(oldVal)}
                  </div>
                  <div className="whitespace-pre-wrap rounded bg-emerald-500/10 px-2 py-0.5 text-emerald-300">
                    {fmt(newVal)}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
        <div className="flex justify-end gap-2 border-t border-ink-700 px-3 py-2.5">
          <button onClick={onCancel} className="btn-ghost">继续编辑</button>
          <button
            onClick={() => {
              onSave()
              onCancel()
            }}
            className="btn-primary"
          >
            <Save size={12} /> 确认写入
          </button>
        </div>
      </div>
    </div>
  )
}
