import { Archive as ArchiveIcon } from 'lucide-react'
import { useApp } from '../store'
import { StatusBadge, PriorityBadge } from '../components/badges'
import { relTime } from '../utils/format'
import type { JSX } from 'react'

export function ArchivePage(): JSX.Element {
  const snapshot = useApp((s) => s.snapshot)!
  const showTask = useApp((s) => s.showTask)
  const archived = snapshot.archived

  return (
    <div className="h-full animate-fade-in overflow-y-auto p-6">
      <div className="mx-auto max-w-4xl">
        <div className="mb-4 flex items-center gap-2">
          <ArchiveIcon size={16} className="text-mist-400" />
          <h1 className="text-base font-semibold text-mist-50">归档任务</h1>
          <span className="rounded bg-ink-750 px-1.5 font-mono text-[10.5px] text-mist-400">{archived.length}</span>
          <span className="ml-2 text-[11px] text-mist-500">由 task.py archive 移入 .trellis/archive</span>
        </div>

        {archived.length === 0 ? (
          <div className="card grid place-items-center gap-2 py-16 text-mist-500">
            <ArchiveIcon size={22} />
            <span className="text-xs">暂无归档任务</span>
          </div>
        ) : (
          <div className="card divide-y divide-ink-700/60">
            {archived.map((t) => (
              <button
                key={t.dirName}
                onClick={() => showTask(t.path, true)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-ink-750/50"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-mist-100">
                    {t.record?.title ?? t.dirName}
                    {t.parseError && <span className="ml-1.5 text-[10px] text-rose-400">(解析失败)</span>}
                  </div>
                  <div className="truncate font-mono text-[10.5px] text-mist-500">
                    {t.dirName} · {t.record?.assignee || t.record?.creator || '—'}
                    {t.record?.completedAt ? ` · 完成于 ${t.record.completedAt}` : ''}
                  </div>
                </div>
                <span className="shrink-0 text-[10.5px] text-mist-500">{relTime(t.updatedAt)}</span>
                {t.record && (
                  <>
                    <PriorityBadge priority={t.record.priority} />
                    <StatusBadge status={t.record.status} />
                  </>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
