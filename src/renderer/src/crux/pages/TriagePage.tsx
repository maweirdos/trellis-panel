import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { api } from '../../api'
import { useCrux, PRIORITY_LABEL } from '../store'
import { PageHeader, PriorityBadge, Field, inputClass, textareaClass } from '../ui'
import { Button, EmptyState } from '../../my/ui'
import { NewTaskModal } from './TaskDetailDrawer'
import type { CruxApi, CruxSnapshot, CruxTriageDisposition, CruxPriority } from '@shared/crux'

type QueueEntry = Extract<Awaited<ReturnType<CruxApi['triageQueue']>>, { ok: true }>['data'][number]
const DISPOSITIONS: Array<{ id: CruxTriageDisposition; label: string; hint: string }> = [
  { id: 'assign', label: '指派推进', hint: '安排处理人，进入待办' },
  { id: 'iterate', label: '放入版本', hint: '排入所选版本' },
  { id: 'park', label: '接受到待规划', hint: '离开分拣台，稍后安排' },
  { id: 'close', label: '关闭', hint: '取消任务，不再推进' }
]

export function TriagePage(): JSX.Element | null {
  const snapshot = useCrux((s) => s.snapshot)
  const spaceId = useCrux((s) => s.currentSpaceId)
  const [result, setResult] = useState<{ spaceId: string; queue: QueueEntry[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [retry, setRetry] = useState(0)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  useEffect(() => {
    let owned = true
    if (!spaceId) { setLoading(false); return }
    setLoading(true); setError(null)
    void api.crux.triageQueue(spaceId).then((response) => {
      if (!owned) return
      if (response.ok) {
        setResult({ spaceId, queue: response.data })
        setActiveId((previous) => response.data.some((q) => q.task.id === previous) ? previous : response.data[0]?.task.id ?? null)
      } else setError(response.error)
    }).catch((e: unknown) => { if (owned) setError(e instanceof Error ? e.message : String(e)) }).finally(() => { if (owned) setLoading(false) })
    return () => { owned = false }
  }, [spaceId, snapshot, retry])
  if (!snapshot) return null
  const queue = result?.spaceId === spaceId ? result.queue : []
  const entry = queue.find((q) => q.task.id === activeId)
  return <div className="flex min-h-0 flex-1 flex-col gap-3">
    <PageHeader title="分拣台" description={`待分拣 ${queue.length} 条：确定优先级，再安排处理人、版本或接受到待规划。`} actions={<Button size="sm" variant="primary" disabled={!spaceId} onClick={() => setCreateOpen(true)}><Plus size={14} />新建待分拣任务</Button>} />
    {error ? <div role="alert" className="rounded-my-md border border-my-line p-3 text-my-sm text-my-secondary">{error}<Button size="sm" className="ml-2" onClick={() => setRetry((value) => value + 1)}>重试</Button></div> : loading ? <p role="status" className="text-my-xs text-my-tertiary">正在刷新分拣队列…</p> : queue.length === 0 ? <EmptyState title="分拣台已清空" description="没有等待分拣的任务" /> : <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-2">
      <ul className="my-scrollbar min-h-0 space-y-2 overflow-y-auto" style={{ scrollbarGutter: 'stable' }}>{queue.map((q) => <li key={q.task.id}><button type="button" aria-pressed={activeId === q.task.id} onClick={() => setActiveId(q.task.id)} className={`w-full rounded-my-md border p-3 text-left ${activeId === q.task.id ? 'border-my-line-strong bg-my-layer-1-active' : 'border-my-line hover:bg-my-layer-1'}`}><span className="font-mono text-my-2xs text-my-tertiary">{q.task.id}</span><p className="my-1 text-my-sm text-my-primary">{q.task.title}</p><span className="flex items-center gap-2 text-my-xs text-my-tertiary"><PriorityBadge priority={q.suggested} />{q.reason}</span></button></li>)}</ul>
      {entry && <TriageDecision key={entry.task.id} snapshot={snapshot} entry={entry} />}
    </div>}
    <NewTaskModal open={createOpen} onClose={() => setCreateOpen(false)} triagePending />
  </div>
}

function TriageDecision({ snapshot, entry }: { snapshot: CruxSnapshot; entry: QueueEntry }): JSX.Element {
  const run = useCrux((s) => s.run)
  const busy = useCrux((s) => s.busy)
  const openTask = useCrux((s) => s.openTask)
  const [disposition, setDisposition] = useState<CruxTriageDisposition>('assign')
  const [assigneeIds, setAssigneeIds] = useState<string[]>([])
  const [iterationId, setIterationId] = useState('')
  const [note, setNote] = useState('')
  const task = snapshot.tasks.find((t) => t.id === entry.task.id) ?? entry.task
  const space = snapshot.spaces.find((s) => s.id === task.spaceId)
  const members = snapshot.members.filter((m) => space?.memberIds.includes(m.id))
  const iterations = snapshot.iterations.filter((it) => it.spaceId === task.spaceId && it.status !== 'completed')
  const apply = async (): Promise<void> => {
    if (busy) return
    await run('分拣处置', () => api.crux.triage({ taskId: task.id, disposition, assigneeIds: disposition === 'assign' ? assigneeIds : undefined, iterationId: disposition === 'iterate' ? iterationId : undefined, note: note.trim() || undefined, actorId: members.find((m) => m.role === 'owner')?.id ?? members[0]?.id }))
  }
  return <section className="my-scrollbar min-h-0 overflow-y-auto rounded-my-md border border-my-line bg-my-layer-1 p-4" style={{ scrollbarGutter: 'stable' }}><fieldset disabled={busy} className="flex min-w-0 flex-col gap-3">
    <h2 className="text-my-md font-medium text-my-primary">{task.title}</h2><Button size="sm" variant="ghost" onClick={() => openTask(task.id)}>打开任务详情 · {task.id}</Button>
    {task.description && <p className="whitespace-pre-wrap text-my-sm text-my-secondary">{task.description}</p>}
    <Field label="任务优先级"><select className={inputClass} value={task.priority} onChange={(e) => void run('设置优先级', () => api.crux.updateTask({ id: task.id, patch: { priority: e.target.value as CruxPriority } }))}>{(Object.keys(PRIORITY_LABEL) as CruxPriority[]).map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}</select></Field>
    <div className="flex items-center gap-2"><p className="min-w-0 flex-1 text-my-xs text-my-tertiary">{entry.reason}</p><Button size="sm" disabled={task.priority === entry.suggested} onClick={() => void run('采用建议优先级', () => api.crux.updateTask({ id: task.id, patch: { priority: entry.suggested } }))}>采用建议</Button></div>
    <div className="grid grid-cols-2 gap-2">{DISPOSITIONS.map((d) => <button key={d.id} type="button" aria-pressed={disposition === d.id} onClick={() => setDisposition(d.id)} className={`rounded-my-md border p-3 text-left ${disposition === d.id ? 'border-my-line-strong bg-my-layer-1-active' : 'border-my-line hover:bg-my-layer-1-active'}`}><span className="text-my-xs font-medium text-my-primary">{d.label}</span><p className="mt-1 text-my-xs text-my-tertiary">{d.hint}</p></button>)}</div>
    {disposition === 'assign' && <section><h3 className="mb-2 text-my-xs text-my-tertiary">处理人{!space?.multiAssignee && '（单人）'}</h3><div className="flex flex-wrap gap-2">{members.map((m) => <button key={m.id} type="button" aria-pressed={assigneeIds.includes(m.id)} onClick={() => setAssigneeIds((previous) => previous.includes(m.id) ? previous.filter((id) => id !== m.id) : space?.multiAssignee ? [...previous, m.id] : [m.id])} className={`rounded-my-md border px-2 py-1 text-my-xs ${assigneeIds.includes(m.id) ? 'border-my-line-strong bg-my-layer-1-active text-my-primary' : 'border-my-line text-my-secondary'}`}>{m.name}</button>)}</div></section>}
    {disposition === 'iterate' && <Field label="目标版本"><select className={inputClass} value={iterationId} onChange={(e) => setIterationId(e.target.value)}><option value="">选择版本…</option>{iterations.map((it) => <option key={it.id} value={it.id}>{it.name}（{it.startDate} — {it.endDate}）</option>)}</select></Field>}
    <Field label="分拣备注"><textarea className={textareaClass} style={{ minHeight: 'var(--my-space-64)' }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="记录分拣原因和后续安排" /></Field><div className="flex justify-end"><Button variant="primary" size="sm" disabled={(disposition === 'assign' && !assigneeIds.length) || (disposition === 'iterate' && !iterationId)} onClick={() => void apply()}>执行处置</Button></div>
  </fieldset></section>
}
