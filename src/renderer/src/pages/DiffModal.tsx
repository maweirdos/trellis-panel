import { GitCompare, Save, X } from 'lucide-react'
import { statusLabel } from '../utils/labels'
import { Button } from '../my/ui'
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
    <div className="absolute inset-0 z-30 grid animate-fade-in place-items-center bg-my-backdrop p-4" onClick={onCancel}>
      <div
        className="flex max-h-[80%] w-full max-w-sm flex-col overflow-hidden rounded-my-lg border border-my-line bg-my-layer-2 shadow-[var(--my-shadow-raised-200)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-my-line px-4 py-2.5">
          <GitCompare size={13} className="text-my-icon-accent" />
          <span className="text-my-xs font-semibold text-my-primary">保存预览 — {entries.length} 处修改</span>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={onCancel}>
            <X size={14} />
          </Button>
        </div>
        <div className="my-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
          {entries.map(([field, newVal]) => {
            const oldVal = (r as unknown as Record<string, unknown>)[field]
            const fmt = (v: unknown): string => {
              if (v === null || v === undefined || v === '') return '（空）'
              if (Array.isArray(v)) return v.join('\n')
              return String(v)
            }
            return (
              <div key={String(field)} className="mb-2.5 rounded-my-lg border border-my-line bg-my-layer-1 px-3 py-2">
                <div className="mb-1 text-my-2xs font-medium text-my-secondary">
                  {FIELD_LABEL[String(field)] ?? String(field)}
                  {String(field) === 'status' && (
                    <span className="ml-1.5 text-my-tertiary">
                      （{statusLabel(String(oldVal))} → {statusLabel(String(newVal))}）
                    </span>
                  )}
                </div>
                <div className="space-y-1 text-my-xs leading-5">
                  <div className="rounded-my-sm bg-my-danger-subtle px-2 py-0.5 text-my-danger-text line-through">
                    {fmt(oldVal)}
                  </div>
                  <div className="whitespace-pre-wrap rounded-my-sm bg-my-success-subtle px-2 py-0.5 text-my-success-text">
                    {fmt(newVal)}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
        <div className="flex justify-end gap-2 border-t border-my-line px-3 py-2.5">
          <Button variant="ghost" onClick={onCancel}>继续编辑</Button>
          <Button
            variant="primary"
            onClick={() => {
              onSave()
              onCancel()
            }}
          >
            <Save size={12} /> 确认写入
          </Button>
        </div>
      </div>
    </div>
  )
}
