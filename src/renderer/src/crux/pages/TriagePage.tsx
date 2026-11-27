import { useEffect, useState, type JSX } from 'react'
import { Bot, Clock, CopyCheck, Plus } from 'lucide-react'
import type { CruxApi, CruxExecutorRef, CruxPriority, CruxSnapshot, CruxTriageDisposition } from '@shared/crux'
import { api } from '../../api'
import { Button, EmptyState } from '../../my/ui'
import { useCollaborationPlatform } from '../collaboration-platform-store'
import { availableExecutionTargets, PRIORITY_LABEL, useCrux } from '../store'
import { Field, formatCollaborationTime, PageHeader, PriorityBadge, Select, textareaClass } from '../ui'
import { NewTaskModal } from './TaskDetailDrawer'

type QueueEntry = Extract<Awaited<ReturnType<CruxApi['triageQueue']>>, { ok: true }>['data'][number]
type ExtendedDisposition = CruxTriageDisposition | 'duplicate' | 'snooze'

const DISPOSITIONS: Array<{ id: ExtendedDisposition; label: string; hint: string }> = [
  { id: 'assign', label: '接纳并指派', hint: '安排处理人/Agent 并进入待办' },
  { id: 'iterate', label: '放入版本', hint: '排入所选迭代版本推进' },
  { id: 'park', label: '接纳到待规划', hint: '离开分拣台，暂放待办池' },
  { id: 'duplicate', label: '标记重复', hint: '关联已有原任务并关闭重复项' },
  { id: 'snooze', label: '暂缓处理', hint: '暂时移出待办，到期自动提醒' },
  { id: 'close', label: '不采纳 / 关闭', hint: '直接关闭，不再推进' }
]

const SNOOZE_PRESETS = [
  { id: '2h', label: '2 小时后', hours: 2 },
  { id: 'tomorrow', label: '明天上午', hours: 24 },
  { id: 'nextweek', label: '下周再看', hours: 168 }
] as const

export function TriagePage(): JSX.Element | null {
  const snapshot = useCrux((s) => s.snapshot)
  const spaceId = useCrux((s) => s.currentSpaceId)
  const triageSnoozes = useCollaborationPlatform((s) => s.triageSnoozes)
  const clearTriageSnooze = useCollaborationPlatform((s) => s.clearTriageSnooze)

  const [result, setResult] = useState<{ spaceId: string; queue: QueueEntry[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [retry, setRetry] = useState(0)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [filterTab, setFilterTab] = useState<'pending' | 'snoozed'>('pending')
  const [createOpen, setCreateOpen] = useState(false)

  useEffect(() => {
    let owned = true
    if (!spaceId) { setLoading(false); return }
    setLoading(true)
    setError(null)
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
  const allQueue = result?.spaceId === spaceId ? result.queue : []
  const now = Date.now()
  const isSnoozed = (taskId: string): boolean => {
    const entry = triageSnoozes[taskId]
    return Boolean(entry && Date.parse(entry.until) > now)
  }
  const pendingQueue = allQueue.filter((q) => !isSnoozed(q.task.id))
  const snoozedQueue = allQueue.filter((q) => isSnoozed(q.task.id))
  const visibleQueue = filterTab === 'pending' ? pendingQueue : snoozedQueue
  const entry = visibleQueue.find((q) => q.task.id === activeId) ?? visibleQueue[0]

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <PageHeader
        title="分拣台"
        description={`待分拣 ${pendingQueue.length} 条 · 已暂缓 ${snoozedQueue.length} 条。对标 HiFox 分拣流程：接纳、指派/委派 Agent、标记重复、暂缓或关闭。`}
        actions={<Button size="sm" variant="primary" disabled={!spaceId} onClick={() => setCreateOpen(true)}><Plus size={14} />新建待分拣任务</Button>}
      />

      <div className="flex items-center gap-1" role="tablist" aria-label="分拣队列筛选">
        <button
          type="button"
          role="tab"
          aria-selected={filterTab === 'pending'}
          onClick={() => setFilterTab('pending')}
          className={`my-control my-control-sm ${filterTab === 'pending' ? 'bg-my-navigation-selected font-medium text-my-primary' : 'text-my-secondary hover:bg-my-navigation-hover'}`}
        >
          待处理 ({pendingQueue.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={filterTab === 'snoozed'}
          onClick={() => setFilterTab('snoozed')}
          className={`my-control my-control-sm ${filterTab === 'snoozed' ? 'bg-my-navigation-selected font-medium text-my-primary' : 'text-my-secondary hover:bg-my-navigation-hover'}`}
        >
          已暂缓 ({snoozedQueue.length})
        </button>
      </div>

      {error ? (
        <div role="alert" className="rounded-my-base border border-my-line p-3 text-my-sm text-my-secondary">
          {error}<Button size="sm" className="ml-2" onClick={() => setRetry((value) => value + 1)}>重试</Button>
        </div>
      ) : loading ? (
        <p role="status" className="text-my-xs text-my-tertiary">正在刷新分拣队列…</p>
      ) : visibleQueue.length === 0 ? (
        <EmptyState title={filterTab === 'pending' ? '分拣台已清空' : '暂无已暂缓任务'} description={filterTab === 'pending' ? '所有新进需求都已处置完毕。' : '在待处理任务中选择「暂缓处理」后会显示在这里。'} />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-2">
          <ul className="my-scrollbar min-h-0 space-y-2 overflow-y-auto pr-1" style={{ scrollbarGutter: 'stable' }}>
            {visibleQueue.map((q) => {
              const snoozeInfo = triageSnoozes[q.task.id]
              const selected = entry?.task.id === q.task.id
              return (
                <li key={q.task.id}>
                  <button
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setActiveId(q.task.id)}
                    className={`w-full rounded-my-base border p-3 text-left transition-colors ${selected ? 'border-my-line-strong bg-my-navigation-selected' : 'border-my-line bg-my-panel hover:bg-my-layer-1-hover'}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-my-2xs text-my-tertiary">{q.task.id}</span>
                      {snoozeInfo && filterTab === 'snoozed' && (
                        <span className="inline-flex items-center gap-1 text-my-2xs text-my-tertiary">
                          <Clock size={11} />至 {formatCollaborationTime(snoozeInfo.until)}
                        </span>
                      )}
                    </div>
                    <p className="my-1 text-my-sm font-medium text-my-primary">{q.task.title}</p>
                    <span className="flex items-center gap-2 text-my-xs text-my-tertiary">
                      <PriorityBadge priority={q.suggested} />
                      <span className="truncate">{q.reason}</span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
          {entry && (
            <TriageDecision
              key={entry.task.id}
              snapshot={snapshot}
              entry={entry}
              snoozed={filterTab === 'snoozed'}
              onUnsnooze={() => clearTriageSnooze(entry.task.id)}
            />
          )}
        </div>
      )}
      <NewTaskModal open={createOpen} onClose={() => setCreateOpen(false)} triagePending />
    </div>
  )
}

function TriageDecision({
  snapshot,
  entry,
  snoozed,
  onUnsnooze
}: {
  snapshot: CruxSnapshot
  entry: QueueEntry
  snoozed: boolean
  onUnsnooze: () => void
}): JSX.Element {
  const run = useCrux((s) => s.run)
  const busy = useCrux((s) => s.busy)
  const openTask = useCrux((s) => s.openTask)
  const snoozeTriageTask = useCollaborationPlatform((s) => s.snoozeTriageTask)
  const clearTriageSnooze = useCollaborationPlatform((s) => s.clearTriageSnooze)

  const [disposition, setDisposition] = useState<ExtendedDisposition>('assign')
  const [assigneeIds, setAssigneeIds] = useState<string[]>([])
  const [executorKey, setExecutorKey] = useState<string>('')
  const [iterationId, setIterationId] = useState('')
  const [duplicateTargetId, setDuplicateTargetId] = useState('')
  const [snoozePreset, setSnoozePreset] = useState<'2h' | 'tomorrow' | 'nextweek'>('tomorrow')
  const [note, setNote] = useState('')

  const task = snapshot.tasks.find((t) => t.id === entry.task.id) ?? entry.task
  const space = snapshot.spaces.find((s) => s.id === task.spaceId)
  const members = snapshot.members.filter((m) => space?.memberIds.includes(m.id))
  const iterations = snapshot.iterations.filter((it) => it.spaceId === task.spaceId && it.status !== 'completed')
  const { agents, crews } = availableExecutionTargets(snapshot, task.spaceId)
  const otherTasks = snapshot.tasks.filter((t) => t.spaceId === task.spaceId && t.id !== task.id)

  const apply = async (): Promise<void> => {
    if (busy) return
    if (disposition === 'snooze') {
      const preset = SNOOZE_PRESETS.find((item) => item.id === snoozePreset) ?? SNOOZE_PRESETS[1]
      const until = new Date(Date.now() + preset.hours * 3600_000).toISOString()
      snoozeTriageTask(task.id, until, note.trim() || undefined)
      return
    }
    if (disposition === 'duplicate') {
      if (!duplicateTargetId) return
      await run('标记重复任务', async () => {
        const rel = await api.crux.addRelation({ taskId: task.id, relation: { kind: 'duplicate', taskId: duplicateTargetId } })
        if (!rel.ok) return rel
        return api.crux.triage({
          taskId: task.id,
          disposition: 'close',
          note: note.trim() ? `与 ${duplicateTargetId} 重复：${note.trim()}` : `标记为与 ${duplicateTargetId} 重复`,
          actorId: members.find((m) => m.role === 'owner')?.id ?? members[0]?.id
        })
      })
      clearTriageSnooze(task.id)
      return
    }

    let selectedExecutor: CruxExecutorRef | null = null
    if (executorKey.startsWith('agent:')) {
      const found = agents.find((a) => a.id === executorKey.slice(6))
      if (found) selectedExecutor = { kind: 'agent', id: found.id, name: found.name }
    } else if (executorKey.startsWith('crew:')) {
      const found = crews.find((c) => c.id === executorKey.slice(5))
      if (found) selectedExecutor = { kind: 'crew', id: found.id, name: found.name }
    }

    const res = await run('分拣处置', async () => {
      const triaged = await api.crux.triage({
        taskId: task.id,
        disposition,
        assigneeIds: disposition === 'assign' ? assigneeIds : undefined,
        iterationId: disposition === 'iterate' ? iterationId : undefined,
        note: note.trim() || undefined,
        actorId: members.find((m) => m.role === 'owner')?.id ?? members[0]?.id
      })
      if (!triaged.ok || !selectedExecutor || disposition !== 'assign') return triaged
      return api.crux.updateTask({ id: task.id, patch: { executor: selectedExecutor } })
    })
    if (res?.ok) clearTriageSnooze(task.id)
  }

  const submitDisabled = (disposition === 'assign' && !assigneeIds.length)
    || (disposition === 'iterate' && !iterationId)
    || (disposition === 'duplicate' && !duplicateTargetId)

  return (
    <section className="my-scrollbar min-h-0 overflow-y-auto rounded-my-base border border-my-line bg-my-panel p-4" style={{ scrollbarGutter: 'stable' }}>
      <fieldset disabled={busy} className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-my-md font-semibold text-my-primary">{task.title}</h2>
          <div className="flex items-center gap-1.5">
            {snoozed && <Button size="sm" variant="outline" onClick={onUnsnooze}>取消暂缓</Button>}
            <Button size="sm" variant="ghost" onClick={() => openTask(task.id)}>打开详情 · {task.id}</Button>
          </div>
        </div>
        {task.description && <p className="whitespace-pre-wrap text-my-sm text-my-secondary">{task.description}</p>}

        <Field label="任务优先级">
          <Select
            className="w-full"
            value={task.priority}
            onChange={(val) => void run('设置优先级', () => api.crux.updateTask({ id: task.id, patch: { priority: val as CruxPriority } }))}
            options={(Object.keys(PRIORITY_LABEL) as CruxPriority[]).map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))}
          />
        </Field>

        <div className="flex items-center gap-2 rounded-my-base bg-my-layer-1 px-3 py-2">
          <p className="min-w-0 flex-1 text-my-xs text-my-tertiary">{entry.reason}</p>
          <Button size="sm" variant="outline" disabled={task.priority === entry.suggested} onClick={() => void run('采用建议优先级', () => api.crux.updateTask({ id: task.id, patch: { priority: entry.suggested } }))}>采用建议</Button>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {DISPOSITIONS.map((d) => (
            <button
              key={d.id}
              type="button"
              aria-pressed={disposition === d.id}
              onClick={() => setDisposition(d.id)}
              className={`rounded-my-base border p-2.5 text-left transition-colors ${disposition === d.id ? 'border-my-line-strong bg-my-navigation-selected' : 'border-my-line bg-my-layer-1 hover:bg-my-layer-1-hover'}`}
            >
              <span className="text-my-xs font-medium text-my-primary">{d.label}</span>
              <p className="mt-0.5 text-my-2xs text-my-tertiary">{d.hint}</p>
            </button>
          ))}
        </div>

        {disposition === 'assign' && (
          <div className="flex flex-col gap-3 rounded-my-base border border-my-line bg-my-layer-1 p-3">
            <section>
              <h3 className="my-item-title mb-2">人类负责人{!space?.multiAssignee && '（单人）'}</h3>
              <div className="flex flex-wrap gap-2">
                {members.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    aria-pressed={assigneeIds.includes(m.id)}
                    onClick={() => setAssigneeIds((previous) => previous.includes(m.id) ? previous.filter((id) => id !== m.id) : space?.multiAssignee ? [...previous, m.id] : [m.id])}
                    className={`rounded-my-base border px-2.5 py-1 text-my-xs ${assigneeIds.includes(m.id) ? 'border-my-line-strong bg-my-navigation-selected font-medium text-my-primary' : 'border-my-line bg-my-panel text-my-secondary'}`}
                  >
                    {m.name}
                  </button>
                ))}
              </div>
            </section>
            <Field label="同时委派 AI 执行者（选填）" hint="分离人类兜底负责人与 AI 执行者，接纳后即可直接进入执行队列。">
              <Select
                className="w-full"
                value={executorKey}
                onChange={setExecutorKey}
                options={[
                  { value: '', label: '暂不委派 AI（人工推进）' },
                  ...agents.map((a) => ({ value: `agent:${a.id}`, label: `Agent · ${a.name}` })),
                  ...crews.map((c) => ({ value: `crew:${c.id}`, label: `小队 · ${c.name}` }))
                ]}
              />
            </Field>
          </div>
        )}

        {disposition === 'iterate' && (
          <Field label="目标版本">
            <Select
              className="w-full"
              value={iterationId}
              onChange={setIterationId}
              options={[
                { value: '', label: '选择版本…' },
                ...iterations.map((it) => ({ value: it.id, label: `${it.name}（${it.startDate} — ${it.endDate}）` }))
              ]}
            />
          </Field>
        )}

        {disposition === 'duplicate' && (
          <Field label="重复的原任务">
            <Select
              className="w-full"
              value={duplicateTargetId}
              onChange={setDuplicateTargetId}
              options={[
                { value: '', label: '选择已有原任务…' },
                ...otherTasks.map((t) => ({ value: t.id, label: `${t.id} · ${t.title}` }))
              ]}
            />
          </Field>
        )}

        {disposition === 'snooze' && (
          <Field label="暂缓至">
            <Select
              className="w-full"
              value={snoozePreset}
              onChange={(val) => setSnoozePreset(val as '2h' | 'tomorrow' | 'nextweek')}
              options={SNOOZE_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
            />
          </Field>
        )}

        <Field label="分拣备注">
          <textarea className={textareaClass} style={{ minHeight: 'var(--my-space-64)' }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="记录分拣结论、重复原因或后续安排" />
        </Field>

        <div className="flex justify-end">
          <Button variant="primary" size="sm" disabled={submitDisabled} onClick={() => void apply()}>
            {disposition === 'duplicate' ? <CopyCheck size={14} /> : disposition === 'snooze' ? <Clock size={14} /> : executorKey ? <Bot size={14} /> : null}
            执行处置
          </Button>
        </div>
      </fieldset>
    </section>
  )
}
