import { useEffect, useState, type JSX } from 'react'
import { Bot, CheckCircle2, Clock, CopyCheck, Plus } from 'lucide-react'
import type { CruxApi, CruxExecutorRef, CruxPriority, CruxSnapshot, CruxTriageDisposition } from '@shared/crux'
import { api } from '../../api'
import { Button, EmptyState, Tooltip } from '../../my/ui'
import { availableExecutionTargets, PRIORITY_LABEL, useCrux } from '../store'
import { Field, formatCollaborationTime, PageHeader, PriorityBadge, Select, textareaClass } from '../ui'

type QueueItem = Extract<Awaited<ReturnType<CruxApi['triageQueue']>>, { ok: true }>['data'][number]

export function TriagePage(): JSX.Element | null {
  const snapshot = useCrux((s) => s.snapshot)
  const currentSpaceId = useCrux((s) => s.currentSpaceId)
  const openTask = useCrux((s) => s.openTask)
  const beginCreateTask = useCrux((s) => s.beginCreateTask)
  const run = useCrux((s) => s.run)
  const busy = useCrux((s) => s.busy)
  const workspaceKey = useCrux((s) => s.workspaceContext.key)

  const [queue, setQueue] = useState<QueueItem[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [disposition, setDisposition] = useState<CruxTriageDisposition>('assign')
  const [assigneeId, setAssigneeId] = useState('')
  const [executorValue, setExecutorValue] = useState('')
  const [iterationId, setIterationId] = useState('')
  const [note, setNote] = useState('')

  useEffect(() => {
    if (!currentSpaceId) {
      setQueue([])
      return
    }
    let active = true
    setLoading(true)
    void api.crux
      .triageQueue(currentSpaceId)
      .then((res) => {
        if (!active) return
        if (res.ok) setQueue(res.data)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [currentSpaceId, snapshot?.tasks.length, snapshot?.triageDecisions.length, workspaceKey])

  if (!snapshot) return null

  const space = snapshot.spaces.find((item) => item.id === currentSpaceId)
  const readOnly = Boolean(space?.archived)
  const members = space
    ? snapshot.members.filter((member) => space.memberIds.includes(member.id))
    : snapshot.members
  const iterations = snapshot.iterations.filter(
    (item) => (!currentSpaceId || item.spaceId === currentSpaceId) && item.status !== 'completed'
  )
  const targets = availableExecutionTargets(snapshot, currentSpaceId)

  const currentItem = queue.find((item) => item.task.id === selectedTaskId) ?? queue[0] ?? null
  const task = currentItem?.task ?? null

  const parseExecutor = (value: string): CruxExecutorRef | undefined => {
    if (!value) return undefined
    const [kind, id] = value.split(':')
    if (kind === 'agent') {
      const agent = targets.agents.find((item) => item.id === id)
      return agent ? { kind: 'agent', id: agent.id, name: agent.name } : undefined
    }
    if (kind === 'crew') {
      const crew = targets.crews.find((item) => item.id === id)
      return crew ? { kind: 'crew', id: crew.id, name: crew.name } : undefined
    }
    return undefined
  }

  const submitDisabledReason = !task
    ? '当前没有选中的待分拣任务'
    : readOnly
      ? '已归档空间仅支持只读查看'
      : disposition === 'assign' && !assigneeId && !executorValue
        ? '指派推进前请先选择处理人或执行 Agent / 小队'
        : disposition === 'iterate' && !iterationId
          ? '放入迭代前请先选择目标迭代版本'
          : null

  const applyPriority = async (priority: CruxPriority): Promise<void> => {
    if (!task || readOnly) return
    await run('更新优先级', () =>
      api.crux.updateTask({
        id: task.id,
        patch: { priority }
      })
    )
  }

  const submitDecision = async (): Promise<void> => {
    if (!task || submitDisabledReason) return
    const nextExecutor = parseExecutor(executorValue)
    if (disposition === 'assign' && nextExecutor) {
      await run('设置任务执行者', () =>
        api.crux.updateTask({
          id: task.id,
          patch: { executor: nextExecutor }
        })
      )
    }
    const result = await run('提交分拣处置', () =>
      api.crux.triage({
        taskId: task.id,
        disposition,
        assigneeIds: disposition === 'assign' && assigneeId ? [assigneeId] : undefined,
        iterationId: disposition === 'iterate' ? iterationId : undefined,
        note: note.trim() || undefined,
        expectedUpdatedAt: task.updatedAt
      })
    )
    if (result?.ok) {
      setNote('')
      const refreshed: { ok: true; data: CruxSnapshot } = result
      const remaining = refreshed.data.tasks.find((item) => item.spaceId === currentSpaceId && item.triagePending && item.id !== task.id)
      setSelectedTaskId(remaining?.id ?? null)
    }
  }

  const dispositionLabels: Array<{ id: CruxTriageDisposition; label: string; hint: string }> = [
    { id: 'assign', label: '指派推进', hint: '确认处理人或执行 Agent，进入常规推进队列' },
    { id: 'iterate', label: '放入迭代', hint: '排入指定版本迭代并明确推进节奏' },
    { id: 'park', label: '暂存 Backlog', hint: '先移入待规划，稍后再排期' },
    { id: 'close', label: '关闭任务', hint: '重复、失效或无需处理，直接关闭' }
  ]

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <PageHeader
        title="分拣台"
        description="集中评估新收到的外部或草稿需求，补充优先级并决定后续流向。"
        actions={
          <Button
            size="sm"
            variant="primary"
            disabled={!currentSpaceId || busy || readOnly}
            onClick={() => beginCreateTask({ spaceId: currentSpaceId ?? undefined, triagePending: true })}
          >
            <Plus size={14} />
            <span>提交待分拣任务</span>
          </Button>
        }
      />

      {loading && queue.length === 0 ? (
        <div className="my-card flex items-center justify-center py-12 text-my-sm text-my-tertiary">正在加载待分拣队列...</div>
      ) : queue.length === 0 ? (
        <EmptyState
          icon={<CheckCircle2 size={28} />}
          title="待分拣队列已清空"
          description="所有新进入的任务都已经完成归类、排期或分派。"
          action={
            !readOnly && currentSpaceId ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => beginCreateTask({ spaceId: currentSpaceId, triagePending: true })}
              >
                <Plus size={14} />
                <span>新增待分拣任务</span>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(280px,340px)_1fr]">
          <section className="my-card my-scrollbar min-h-0 overflow-y-auto p-1.5" aria-label="待分拣任务队列">
            <ul className="space-y-1">
              {queue.map((item) => {
                const active = task?.id === item.task.id
                return (
                  <li key={item.task.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedTaskId(item.task.id)}
                      className={`flex w-full flex-col gap-1.5 rounded-my-base border px-3 py-2.5 text-left transition-colors duration-150 ease-out ${
                        active ? 'border-my-line-strong bg-my-layer-2' : 'border-transparent hover:bg-my-layer-1'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-my-2xs text-my-tertiary">{item.task.id}</span>
                        <PriorityBadge priority={item.task.priority} />
                        <span className="ml-auto inline-flex items-center gap-1 rounded-my-sm bg-my-layer-1 px-1.5 py-0.5 text-my-2xs text-my-secondary">
                          <Bot size={11} />
                          <span>建议：{PRIORITY_LABEL[item.suggested]}</span>
                        </span>
                      </div>
                      <div className="my-item-title truncate text-my-sm font-medium text-my-primary">{item.task.title}</div>
                      <p className="line-clamp-2 text-my-xs text-my-tertiary">{item.reason}</p>
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>

          {task && (
            <section className="my-card my-scrollbar flex min-h-0 flex-col gap-4 overflow-y-auto p-5" aria-label="分拣决策面板">
              <header className="flex flex-wrap items-start justify-between gap-3 border-b border-my-line pb-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-2 text-my-xs text-my-tertiary">
                    <span className="font-mono">{task.id}</span>
                    <span className="inline-flex items-center gap-1">
                      <Clock size={12} />
                      <span>{formatCollaborationTime(task.createdAt)}</span>
                    </span>
                  </div>
                  <h2 className="text-my-base font-medium text-my-primary">{task.title}</h2>
                </div>
                <Button size="sm" variant="ghost" onClick={() => openTask(task.id)}>
                  查看完整任务
                </Button>
              </header>

              {task.description && (
                <div className="rounded-my-base bg-my-layer-1 px-3.5 py-2.5 text-my-sm leading-relaxed text-my-secondary">
                  {task.description}
                </div>
              )}

              {currentItem && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-my-base border border-my-line px-3.5 py-2.5 text-my-xs">
                  <div className="flex items-center gap-2 text-my-secondary">
                    <Bot size={14} className="text-my-accent" />
                    <span>系统建议优先级为「{PRIORITY_LABEL[currentItem.suggested]}」：{currentItem.reason}</span>
                  </div>
                  {task.priority !== currentItem.suggested && !readOnly && (
                    <Button size="sm" variant="soft" disabled={busy} onClick={() => void applyPriority(currentItem.suggested)}>
                      采纳建议
                    </Button>
                  )}
                </div>
              )}

              <div className="space-y-2">
                <div className="collab-form-label">选择处置方式</div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {dispositionLabels.map((item) => {
                    const selected = disposition === item.id
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setDisposition(item.id)}
                        className={`flex flex-col gap-1 rounded-my-base border px-3 py-2.5 text-left transition-colors duration-150 ease-out ${
                          selected
                            ? 'border-my-accent bg-my-accent-subtle text-my-primary'
                            : 'border-my-line bg-my-canvas text-my-secondary hover:bg-my-layer-1'
                        }`}
                      >
                        <span className="text-my-sm font-medium text-my-primary">{item.label}</span>
                        <span className="text-my-xs text-my-tertiary">{item.hint}</span>
                      </button>
                    )
                  })}
                </div>
              </div>

              {disposition === 'assign' && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="指派成员">
                    <Select
                      ariaLabel="指派成员"
                      value={assigneeId}
                      onChange={setAssigneeId}
                      options={[
                        { value: '', label: '不指定人工处理人' },
                        ...members.map((member) => ({ value: member.id, label: member.name }))
                      ]}
                    />
                  </Field>
                  <Field label="委派 Agent / 小队">
                    <Select
                      ariaLabel="委派 Agent 或小队"
                      value={executorValue}
                      onChange={setExecutorValue}
                      options={[
                        { value: '', label: '暂不委派 AI 执行' },
                        ...targets.agents.map((agent) => ({ value: `agent:${agent.id}`, label: `Agent · ${agent.name}` })),
                        ...targets.crews.map((crew) => ({ value: `crew:${crew.id}`, label: `小队 · ${crew.name}` }))
                      ]}
                    />
                  </Field>
                </div>
              )}

              {disposition === 'iterate' && (
                <Field label="目标迭代版本">
                  <Select
                    ariaLabel="目标迭代版本"
                    value={iterationId}
                    onChange={setIterationId}
                    options={[
                      { value: '', label: '请选择一个未完结迭代' },
                      ...iterations.map((item) => ({ value: item.id, label: item.name }))
                    ]}
                  />
                </Field>
              )}

              <Field label="分拣备注（可选）">
                <textarea
                  rows={2}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="补充背景说明、验收提醒或优先级判定依据"
                  className={textareaClass}
                />
              </Field>

              <footer className="flex items-center justify-end gap-2 border-t border-my-line pt-3">
                {submitDisabledReason ? (
                  <Tooltip label={submitDisabledReason} wrap>
                    <span className="inline-flex">
                      <Button size="sm" variant="primary" disabled>
                        <CopyCheck size={14} />
                        <span>确认并处理下一条</span>
                      </Button>
                    </span>
                  </Tooltip>
                ) : (
                  <Button size="sm" variant="primary" disabled={busy} onClick={() => void submitDecision()}>
                    <CopyCheck size={14} />
                    <span>确认并处理下一条</span>
                  </Button>
                )}
              </footer>
            </section>
          )}
        </div>
      )}
    </div>
  )
}
