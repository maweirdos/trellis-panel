import { useState } from 'react'
import { ShieldCheck, X } from 'lucide-react'
import { api } from '../api'
import type { TaskInfo } from '../../../shared/types'
import type { JSX } from 'react'

const DEFAULT_ITEMS = ['测试通过（单测 / 手工验证）', 'spec 已更新或确认无需更新', '相关文档已同步']

/**
 * 完成门禁（Definition of Done）：任务标记 completed 前的检查清单，
 * 勾选结果写入 task.json meta.dod。
 */
export function DoDModal({
  task,
  onClose,
  onDone
}: {
  task: TaskInfo
  onClose: () => void
  onDone: () => void
}): JSX.Element {
  const [checks, setChecks] = useState<boolean[]>(() => DEFAULT_ITEMS.map(() => false))
  const allChecked = checks.every(Boolean)

  const confirm = async (skip: boolean): Promise<void> => {
    const dod = {
      items: skip ? [] : DEFAULT_ITEMS.filter((_, i) => checks[i]),
      skipped: skip,
      at: new Date().toISOString()
    }
    const meta = { ...(task.record?.meta ?? {}), dod }
    await api.updateTask(task.path, { status: 'completed', meta } as never)
    onDone()
  }

  return (
    <div className="fixed inset-0 z-[55] grid place-items-center bg-ink-950/60 p-6 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-ink-600 bg-ink-900 shadow-2xl">
        <div className="flex items-center gap-2 border-b border-ink-700 px-4 py-3">
          <ShieldCheck size={14} className="text-leaf" />
          <span className="text-xs font-semibold text-mist-100">完成前检查</span>
          <span className="min-w-0 flex-1 truncate text-[10.5px] text-mist-500">{task.record?.title ?? task.dirName}</span>
          <button onClick={onClose} className="btn-ghost justify-center px-1.5">
            <X size={13} />
          </button>
        </div>
        <div className="space-y-2 p-4">
          {DEFAULT_ITEMS.map((item, i) => (
            <label key={item} className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-ink-700 px-3 py-2 text-[12px] text-mist-200 hover:border-ink-500">
              <input
                type="checkbox"
                checked={checks[i]}
                onChange={(e) => setChecks((c) => c.map((v, j) => (j === i ? e.target.checked : v)))}
              />
              {item}
            </label>
          ))}
        </div>
        <div className="flex items-center gap-2 border-t border-ink-700 px-4 py-3">
          <button onClick={() => void confirm(false)} disabled={!allChecked} className="btn-primary disabled:opacity-40" title={!allChecked ? '勾选全部检查项后可完成' : undefined}>
            <ShieldCheck size={12} /> 确认完成
          </button>
          <button onClick={() => void confirm(true)} className="btn-ghost text-[11px]">
            跳过检查
          </button>
        </div>
      </div>
    </div>
  )
}
