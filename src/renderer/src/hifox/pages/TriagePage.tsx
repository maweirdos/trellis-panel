/**
 * 分拣台：未分配 Backlog 任务队列 + 优先级建议 + 四种处置（指派/入迭代/保留/关闭）。
 */
import { useEffect, useState } from 'react'
import { api } from '../../api'
import { useHifox, statusOf } from '../store'
import { PageHeader, PriorityBadge, Field, inputClass } from '../ui'
import { Button, EmptyState } from '../../my/ui'
import type { HifoxTriageDisposition } from '@shared/hifox'

interface QueueEntry {
  task: { id: string; title: string; priority: string; statusId: string; relations: Array<{ kind: string }> }
  suggested: 'urgent' | 'high' | 'medium' | 'low'
  reason: string
}

const DISPOSITIONS: Array<{ id: HifoxTriageDisposition; label: string; hint: string }> = [
  { id: 'assign', label: '指派推进', hint: '设定处理人并进入 Todo' },
  { id: 'iterate', label: '放入迭代', hint: '排入所选迭代' },
  { id: 'park', label: '保留待定', hint: '留在 Backlog 继续观察' },
  { id: 'close', label: '关闭', hint: '不再处理，进入 Cancelled' }
]

export function TriagePage(): JSX.Element {
  const snapshot = useHifox((s) => s.snapshot)!
  const currentSpaceId = useHifox((s) => s.currentSpaceId)
  const run = useHifox((s) => s.run)
  const [queue, setQueue] = useState<QueueEntry[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [disposition, setDisposition] = useState<HifoxTriageDisposition>('assign')
  const [assigneeIds, setAssigneeIds] = useState<string[]>([])
  const [iterationId, setIterationId] = useState('')
  const [note, setNote] = useState('')

  useEffect(() => {
    if (!currentSpaceId) return
    void api.hifox.triageQueue(currentSpaceId).then((result) => {
      if (result.ok) {
        setQueue(result.data as QueueEntry[])
        setActiveId((prev) => prev && result.data.some((q) => q.task.id === prev) ? prev : result.data[0]?.task.id ?? null)
      }
    })
  }, [currentSpaceId, snapshot])

  const space = snapshot.spaces.find((s) => s.id === currentSpaceId)
  const members = space?.memberIds ?? []
  const iterations = snapshot.iterations.filter((it) => it.spaceId === currentSpaceId && it.status !== 'completed')
  const entry = queue.find((q) => q.task.id === activeId)

  const apply = async (): Promise<void> => {
    if (!entry) return
    const result = await run('分拣处置', () => api.hifox.triage({
      taskId: entry.task.id,
      disposition,
      assigneeIds: disposition === 'assign' ? assigneeIds : undefined,
      iterationId: disposition === 'iterate' ? iterationId || undefined : undefined,
      note: note.trim() || undefined
    }))
    if (result?.ok) {
      setAssigneeIds([]); setIterationId(''); setNote('')
      const refreshed = await api.hifox.triageQueue(currentSpaceId!)
      if (refreshed.ok) {
        setQueue(refreshed.data as QueueEntry[])
        setActiveId((prev) => {
          const rest = (refreshed.data as QueueEntry[]).filter((q) => q.task.id !== prev)
          return rest[0]?.task.id ?? null
        })
      }
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <PageHeader title="分拣台" description={`待分拣 ${queue.length} 条：Backlog 中未分配的任务，附优先级建议`} />
      {queue.length === 0
        ? <EmptyState title="分拣台已清空" description="没有等待分拣的任务" />
        : (
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[minmax(280px,1fr)_minmax(300px,1fr)]">
            <ul className="my-scrollbar min-h-0 space-y-2 overflow-y-auto pr-1">
              {queue.map((q) => {
                const isBug = snapshot.taskTypes.find((t) => t.id === snapshot.tasks.find((x) => x.id === q.task.id)?.typeId)?.name === 'Bug'
                return (
                  <li key={q.task.id}>
                    <button type="button" onClick={() => setActiveId(q.task.id)}
                      className={`w-full rounded-my-md border p-2.5 text-left transition-colors ${activeId === q.task.id ? 'border-indigo-400/60 bg-indigo-500/5' : 'border-my-line hover:bg-my-layer'}`}>
                      <p className="mb-1 flex items-center gap-2 text-my-xs text-my-tertiary">
                        <span className="font-mono text-[10px]">{q.task.id}</span>
                        {isBug && <span className="rounded-my-sm bg-red-500/15 px-1 text-[10px] text-red-400">Bug</span>}
                      </p>
                      <p className="mb-1.5 truncate text-my-sm text-my-primary">{q.task.title}</p>
                      <p className="flex items-center gap-2 text-my-xs">
                        <PriorityBadge priority={q.suggested} />
                        <span className="truncate text-my-tertiary">{q.reason}</span>
                      </p>
                    </button>
                  </li>
                )
              })}
            </ul>
            {entry && (
              <section className="my-scrollbar min-h-0 overflow-y-auto rounded-my-md border border-my-line bg-my-layer/40 p-3">
                <h2 className="mb-1 text-sm font-medium text-my-primary">{entry.task.title}</h2>
                <p className="mb-3 text-my-xs text-my-tertiary">{entry.task.id} · 建议：{entry.reason}</p>
                <div className="mb-3 grid grid-cols-2 gap-1.5">
                  {DISPOSITIONS.map((d) => (
                    <button key={d.id} type="button" onClick={() => setDisposition(d.id)}
                      className={`rounded-my-md border px-2.5 py-2 text-left transition-colors ${disposition === d.id ? 'border-indigo-400/60 bg-indigo-500/10' : 'border-my-line hover:bg-my-layer'}`}>
                      <p className="text-my-xs font-medium text-my-primary">{d.label}</p>
                      <p className="text-[10px] text-my-tertiary">{d.hint}</p>
                    </button>
                  ))}
                </div>
                {disposition === 'assign' && (
                  <div className="mb-3">
                    <p className="mb-1.5 text-my-xs font-medium text-my-tertiary">处理人{!space?.multiAssignee && '（单人）'}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {members.map((id) => {
                        const member = snapshot.members.find((m) => m.id === id)
                        return member
                          ? (
                            <button key={id} type="button"
                              onClick={() => setAssigneeIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : space?.multiAssignee ? [...prev, id] : [id])}
                              className={`rounded-my-md border px-2 py-1 text-my-xs ${assigneeIds.includes(id) ? 'border-indigo-400/60 bg-indigo-500/10 text-indigo-300' : 'border-my-line text-my-secondary hover:bg-my-layer'}`}>
                              {member.name}
                            </button>
                          )
                          : null
                      })}
                    </div>
                  </div>
                )}
                {disposition === 'iterate' && (
                  <Field label="目标迭代" hint="放入迭代后任务将进入 Todo">
                    <select className={inputClass} value={iterationId} onChange={(e) => setIterationId(e.target.value)}>
                      <option value="">选择迭代…</option>
                      {iterations.map((it) => <option key={it.id} value={it.id}>{it.name}（{it.startDate} ~ {it.endDate}）</option>)}
                    </select>
                  </Field>
                )}
                <Field label="备注（可选）">
                  <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} placeholder="记录分拣原因或后续安排" />
                </Field>
                <div className="mt-3 flex justify-end">
                  <Button variant="primary" size="sm"
                    disabled={(disposition === 'assign' && assigneeIds.length === 0) || (disposition === 'iterate' && !iterationId)}
                    onClick={() => void apply()}>
                    执行处置
                  </Button>
                </div>
              </section>
            )}
          </div>
        )}
    </div>
  )
}
