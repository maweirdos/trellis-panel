import { useApp } from '../store'
import { EmptyState } from '../my/ui'
import { StatusBadge, PriorityBadge } from '../components/badges'
import { relTime } from '../utils/format'
import type { JSX } from 'react'

export function ArchivePage(): JSX.Element {
  const snapshot = useApp((s) => s.snapshot)
  const showTask = useApp((s) => s.showTask)
  const archived = snapshot?.archived ?? []

  return (
    <div>
      <div>
        {archived.length === 0 ? (
          <EmptyState title="暂无归档任务" description="由 task.py archive 移入 .trellis/archive 的任务会显示在这里" />
        ) : (
          <div className="divide-y divide-my-line overflow-hidden rounded-my-lg border border-my-line bg-my-surface-1">
            {archived.map((t) => (
              <button
                key={t.dirName}
                type="button"
                onClick={() => showTask(t.path, true)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-my-layer-1"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-my-sm font-medium text-my-primary">
                    {t.record?.title ?? t.dirName}
                    {t.parseError && <span className="ml-1.5 text-my-2xs text-my-danger-text">(解析失败)</span>}
                  </div>
                  <div className="truncate font-mono text-my-xs text-my-tertiary">
                    {t.dirName} · {t.record?.assignee || t.record?.creator || '—'}
                    {t.record?.completedAt ? ` · 完成于 ${t.record.completedAt}` : ''}
                  </div>
                </div>
                <span className="shrink-0 text-my-xs text-my-tertiary">{relTime(t.updatedAt)}</span>
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
