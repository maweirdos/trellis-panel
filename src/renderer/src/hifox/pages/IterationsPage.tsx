import { useState, type ReactNode } from 'react'
import { ArrowDownToLine, CheckCheck, GitBranch, Loader2, Pencil, Play, Plus } from 'lucide-react'
import type { HifoxIteration, HifoxRecordVersionDeliveryInput, HifoxSnapshot, HifoxTask } from '@shared/hifox'
import { api } from '../../api'
import { confirmDialog } from '../../components/Dialogs'
import { Button, EmptyState, Modal, SearchInput, Tabs, Tooltip, TriProgressBar } from '../../my/ui'
import { useHifox, statusOf, isTriagePending } from '../store'
import { PageHeader, Field, inputClass, textareaClass, StatusBadge, formatCollaborationTime } from '../ui'
import { NewTaskModal } from './TaskDetailDrawer'

export interface IterationsPageProps {
  renderTasks?: (tasks: HifoxTask[], iteration: HifoxIteration) => ReactNode
}

const STATUS_LABEL: Record<HifoxIteration['status'], string> = { pending: '待开始', active: '进行中', completed: '已截版' }

function dateRange(): { start: string; end: string } {
  const format = (date: Date): string => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const start = new Date()
  const end = new Date(start)
  end.setDate(end.getDate() + 13)
  return { start: format(start), end: format(end) }
}

function isFinished(snapshot: HifoxSnapshot, task: HifoxTask): boolean {
  return !task.triagePending && (task.workflow ? task.workflow.stage === 'done' : ['done', 'cancelled'].includes(statusOf(snapshot, task.statusId)?.category ?? ''))
}

function scopeTasks(snapshot: HifoxSnapshot, iteration: HifoxIteration): HifoxTask[] {
  const ids = new Set(iteration.taskIds)
  return snapshot.tasks.filter((task) => task.spaceId === iteration.spaceId && ids.has(task.id))
}

export function IterationsPage({ renderTasks }: IterationsPageProps = {}): JSX.Element | null {
  const snapshot = useHifox((state) => state.snapshot)
  const spaceId = useHifox((state) => state.currentSpaceId)
  const run = useHifox((state) => state.run)
  const busy = useHifox((state) => state.busy)
  const openTask = useHifox((state) => state.openTask)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [keyword, setKeyword] = useState('')
  const [pane, setPane] = useState<'tasks' | 'deliveries'>('tasks')
  const [unfinishedOnly, setUnfinishedOnly] = useState(false)
  const [editing, setEditing] = useState<HifoxIteration | 'new' | null>(null)
  const [confirmEndId, setConfirmEndId] = useState<string | null>(null)
  const [deliveryTarget, setDeliveryTarget] = useState<string | null>(null)
  const [moveTarget, setMoveTarget] = useState<string | null>(null)
  const [newTaskIteration, setNewTaskIteration] = useState<string | null>(null)
  const [closeError, setCloseError] = useState<string | null>(null)
  if (!snapshot) return null

  const space = snapshot.spaces.find((item) => item.id === spaceId)
  const writable = Boolean(space && !space.archived)
  const iterations = snapshot.iterations.filter((item) => item.spaceId === spaceId).sort((a, b) => a.startDate.localeCompare(b.startDate))
  const visibleIterations = iterations.filter((item) => `${item.name} ${item.goal ?? ''}`.toLowerCase().includes(keyword.toLowerCase()))
  const selected = iterations.find((item) => item.id === selectedId) ?? iterations.find((item) => item.status === 'active') ?? iterations[0]
  const tasks = selected ? scopeTasks(snapshot, selected) : []
  const pending = tasks.filter((task) => !isFinished(snapshot, task))
  const shownTasks = unfinishedOnly ? pending : tasks
  const deliveries = (snapshot.versionDeliveries ?? []).filter((item) => item.targetIterationId === selected?.id).sort((a, b) => b.at.localeCompare(a.at))
  const predecessor = iterations.find((item) => item.id === selected?.predecessorId)
  const predecessorReady = !selected?.predecessorId || predecessor?.status === 'completed'
  const ending = iterations.find((item) => item.id === confirmEndId)
  const unfinished = ending ? scopeTasks(snapshot, ending).filter((task) => !isFinished(snapshot, task)) : []
  const complete = async (): Promise<void> => {
    if (!ending || busy || !writable || unfinished.length > 0) return
    setCloseError(null)
    const result = await run('截版', () => api.hifox.completeIteration({ id: ending.id }))
    if (result?.ok) setConfirmEndId(null)
    else if (result && !result.ok) setCloseError(result.error)
    else setCloseError('截版失败，请重试。')
  }

  return <div className="my-fade flex min-h-0 flex-1 flex-col gap-3">
    <PageHeader title="版本" actions={<Tooltip label="新建版本" side="bottom"><Button variant="primary" size="sm" className="my-icon-control" disabled={busy || !writable} aria-label="新建版本" onClick={() => setEditing('new')}><Plus size={16} /></Button></Tooltip>} />
    <div className="flex flex-wrap items-center gap-3"><SearchInput value={keyword} onChange={setKeyword} placeholder="搜索版本" /><span className="text-my-xs text-my-tertiary">{visibleIterations.length} 个</span></div>
    {iterations.length === 0 ? <EmptyState title="暂无版本" /> : <>
      <div className="my-scrollbar max-h-56 shrink-0 overflow-y-auto rounded-my-md border border-my-line" style={{ scrollbarGutter: 'stable' }}>
        {visibleIterations.length === 0 && <EmptyState title="没有匹配版本" />}
        {visibleIterations.map((iteration) => {
          const ownTasks = scopeTasks(snapshot, iteration)
          const done = ownTasks.filter((task) => isFinished(snapshot, task) && statusOf(snapshot, task.statusId)?.category !== 'cancelled').length
          const started = ownTasks.filter((task) => !isFinished(snapshot, task) && ['in_progress', 'in_review', 'blocked'].includes(statusOf(snapshot, task.statusId)?.category ?? '')).length
          const total = iteration.taskIds.length
          const prior = iterations.find((item) => item.id === iteration.predecessorId)
          return <button key={iteration.id} type="button" aria-pressed={selected?.id === iteration.id} onClick={() => { setSelectedId(iteration.id); setUnfinishedOnly(false) }} className={`my-row flex w-full flex-wrap items-center gap-3 border-b border-my-line px-3 py-2 text-left ${selected?.id === iteration.id ? 'bg-my-navigation-selected' : 'hover:bg-my-layer-1-hover'}`}>
            <GitBranch size={16} className="shrink-0 text-my-icon-secondary" /><span className="min-w-0 flex-1 truncate text-my-sm font-medium text-my-primary">{iteration.name}</span><span className="text-my-xs text-my-secondary">{STATUS_LABEL[iteration.status]}</span><span className="text-my-xs text-my-tertiary">{iteration.startDate} — {iteration.endDate}</span><div className="flex w-32 items-center gap-2" role="progressbar" aria-label={`${iteration.name} 完成进度`} aria-valuenow={total ? Math.round(done / total * 100) : 0} aria-valuemin={0} aria-valuemax={100}><TriProgressBar done={done} started={started} total={total} /><span className="shrink-0 text-my-xs text-my-tertiary">{done}/{total}</span></div>{prior && <span className="text-my-xs text-my-tertiary">接续 {prior.name}</span>}
          </button>
        })}
      </div>
      {selected && <section className="flex min-h-0 flex-1 flex-col gap-3" aria-label={`版本 ${selected.name}`}>
        <header className="flex shrink-0 flex-wrap items-center gap-2"><h2 className="min-w-0 flex-1 truncate text-my-md font-medium text-my-primary">{selected.name}</h2>
          {selected.status !== 'completed' && <>
            <Tooltip label="新建任务"><Button variant="ghost" size="sm" className="my-icon-control" disabled={busy || !writable} aria-label="新建版本任务" onClick={() => setNewTaskIteration(selected.id)}><Plus size={15} /></Button></Tooltip>
            <Tooltip label="编辑范围与目标"><Button variant="ghost" size="sm" className="my-icon-control" disabled={busy || !writable} aria-label="编辑版本范围与目标" onClick={() => setEditing(selected)}><Pencil size={15} /></Button></Tooltip>
            <Tooltip label="移入已排期任务"><Button variant="ghost" size="sm" className="my-icon-control" disabled={busy || !writable} aria-label="移入已排期任务" onClick={() => setMoveTarget(selected.id)}><ArrowDownToLine size={15} /></Button></Tooltip>
            {selected.status === 'pending' && <Tooltip label={predecessorReady ? '开始版本' : predecessor ? `等待 ${predecessor.name} 截版` : '前置版本不可用'}><Button variant="primary" size="sm" className="my-icon-control" disabled={busy || !writable || !predecessorReady} aria-label="开始版本" onClick={() => void run('开始版本', () => api.hifox.updateIteration({ id: selected.id, status: 'active' }))}><Play size={15} /></Button></Tooltip>}
            {selected.status === 'active' && <Tooltip label="截版"><Button variant="primary" size="sm" className="my-icon-control" disabled={busy || !writable} aria-label="截版" onClick={() => { setConfirmEndId(selected.id); setCloseError(null) }}><CheckCheck size={15} /></Button></Tooltip>}
          </>}
        </header>
        {selected.goal && <p className="shrink-0 whitespace-pre-wrap text-my-sm text-my-secondary">{selected.goal}</p>}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-my-line pb-2"><Tabs tabs={[{ id: 'tasks' as const, label: '任务范围', count: selected.taskIds.length }, { id: 'deliveries' as const, label: '交付来源', count: deliveries.length }]} active={pane} onChange={setPane} />{pane === 'tasks' ? <label className="flex items-center gap-2 text-my-xs text-my-secondary"><input type="checkbox" checked={unfinishedOnly} onChange={(event) => setUnfinishedOnly(event.target.checked)} />未完成 {pending.length}</label> : <Tooltip label="登记交付"><Button variant="ghost" size="sm" className="my-icon-control" disabled={busy || !writable || iterations.length < 2} aria-label="登记交付" onClick={() => setDeliveryTarget(selected.id)}><Plus size={15} /></Button></Tooltip>}</div>
        {pane === 'tasks' ? <div className="flex min-h-0 flex-1 flex-col">{renderTasks ? renderTasks(shownTasks, selected) : <div className="my-scrollbar min-h-0 flex-1 overflow-y-auto" style={{ scrollbarGutter: 'stable' }}>{shownTasks.length === 0 ? <EmptyState title={unfinishedOnly ? '没有未完成任务' : '暂无范围任务'} /> : <ul>{shownTasks.map((task) => <li key={task.id}><button type="button" className="my-control flex w-full items-center gap-2 border-b border-my-line px-3 py-2 text-left hover:bg-my-layer-1-hover" onClick={() => openTask(task.id)}><span className="font-mono text-my-xs text-my-tertiary">{task.id}</span><span className="min-w-0 flex-1 truncate text-my-sm text-my-primary">{task.title}</span><StatusBadge status={statusOf(snapshot, task.statusId)} /></button></li>)}</ul>}</div>}</div> : <div className="my-scrollbar min-h-0 flex-1 overflow-auto rounded-my-md border border-my-line" style={{ scrollbarGutter: 'stable' }}>
          {deliveries.length === 0 ? <EmptyState title="暂无交付来源" /> : <table className="w-full border-collapse text-left text-my-sm"><thead className="sticky top-0 bg-my-canvas text-my-xs text-my-tertiary"><tr className="border-b border-my-line">{['来源版本', '类型', '引用', '修订', '登记'].map((label) => <th key={label} className="px-3 py-2 font-medium">{label}</th>)}</tr></thead><tbody>{deliveries.map((delivery) => <tr key={delivery.id} className="border-b border-my-line hover:bg-my-layer-1-hover"><td className="px-3 py-2 text-my-secondary">{iterations.find((item) => item.id === delivery.sourceIterationId)?.name ?? delivery.sourceIterationId}</td><td className="px-3 py-2 text-my-secondary">{delivery.kind === 'code' ? '代码' : '制品'}</td><td className="px-3 py-2 text-my-primary">{delivery.name && <span className="block">{delivery.name}</span>}<span className="break-all font-mono text-my-xs">{delivery.reference}</span></td><td className="break-all px-3 py-2 font-mono text-my-xs text-my-secondary">{delivery.revision ?? '—'}</td><td className="px-3 py-2 text-my-xs text-my-tertiary"><span className="block">{snapshot.members.find((member) => member.id === delivery.actorId)?.name ?? delivery.actorId}</span>{formatCollaborationTime(delivery.at)}</td></tr>)}</tbody></table>}
        </div>}
      </section>}
    </>}
    {editing && spaceId && <VersionEditor key={editing === 'new' ? 'new' : editing.id} snapshot={snapshot} spaceId={spaceId} iteration={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onSaved={(id) => { setSelectedId(id); setUnfinishedOnly(false) }} />}
    <Modal open={Boolean(ending)} onClose={() => { if (!busy) setConfirmEndId(null) }} width={460} ariaLabel="截版"><div className="flex flex-col gap-4 p-4"><h2 className="text-my-md font-semibold text-my-primary">截版「{ending?.name}」</h2>{unfinished.length > 0 ? <div className="flex flex-col gap-2"><p role="status" className="text-my-sm text-my-danger-text">还有 {unfinished.length} 条未完成任务，暂不能截版。</p><Button size="sm" variant="outline" onClick={() => { if (ending) setSelectedId(ending.id); setPane('tasks'); setUnfinishedOnly(true); setConfirmEndId(null) }}>查看未完成任务</Button></div> : <p className="text-my-sm text-my-secondary">将本版本标记为已截版，保留当前任务范围、任务和交付记录。</p>}{closeError && <p role="alert" className="text-my-xs text-my-danger-text">{closeError}</p>}<div className="flex justify-end gap-2"><Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmEndId(null)}>取消</Button><Button size="sm" variant="primary" disabled={busy || !ending || unfinished.length > 0 || !writable} onClick={() => void complete()}>确认截版</Button></div></div></Modal>
    {deliveryTarget && <DeliveryEditor key={deliveryTarget} snapshot={snapshot} targetId={deliveryTarget} onClose={() => setDeliveryTarget(null)} onSaved={() => setPane('deliveries')} />}
    {moveTarget && <MoveScopeEditor key={moveTarget} snapshot={snapshot} targetId={moveTarget} onClose={() => setMoveTarget(null)} />}
    <NewTaskModal open={Boolean(newTaskIteration)} onClose={() => setNewTaskIteration(null)} iterationId={newTaskIteration ?? undefined} />
  </div>
}

function VersionEditor({ snapshot, spaceId, iteration, onClose, onSaved }: { snapshot: HifoxSnapshot; spaceId: string; iteration?: HifoxIteration; onClose: () => void; onSaved: (id: string) => void }): JSX.Element {
  const run = useHifox((state) => state.run)
  const busy = useHifox((state) => state.busy)
  const [name, setName] = useState(iteration?.name ?? '')
  const [goal, setGoal] = useState(iteration?.goal ?? '')
  const [range, setRange] = useState(() => iteration ? { start: iteration.startDate, end: iteration.endDate } : dateRange())
  const [taskIds, setTaskIds] = useState(iteration?.taskIds ?? [])
  const [predecessorId, setPredecessorId] = useState(iteration?.predecessorId ?? '')
  const [keyword, setKeyword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const candidates = snapshot.iterations.filter((candidate) => {
    if (candidate.spaceId !== spaceId || candidate.id === iteration?.id) return false
    const seen = new Set<string>()
    let prior: HifoxIteration | undefined = candidate
    while (prior) { if (prior.id === iteration?.id || seen.has(prior.id)) return false; seen.add(prior.id); prior = snapshot.iterations.find((item) => item.id === prior?.predecessorId) }
    return true
  })
  const tasks = snapshot.tasks.filter((task) => task.spaceId === spaceId && (iteration?.taskIds.includes(task.id) || (!isTriagePending(snapshot, task) && task.iterationIds.length === 0)) && `${task.id} ${task.title}`.toLowerCase().includes(keyword.toLowerCase()))
  const invalidDates = !range.start || !range.end || range.end < range.start
  const save = async (): Promise<void> => {
    if (busy || !name.trim() || invalidDates) return
    setError(null)
    const fields = { name: name.trim(), goal: goal.trim(), startDate: range.start, endDate: range.end, taskIds }
    const result = await run(iteration ? '更新版本' : '创建版本', () => iteration ? api.hifox.updateIteration({ id: iteration.id, ...fields, predecessorId: predecessorId || null }) : api.hifox.createIteration({ spaceId, ...fields, ...(predecessorId ? { predecessorId } : {}) }))
    if (result?.ok) {
      const id = iteration?.id ?? result.data.iterations.find((item) => !snapshot.iterations.some((prior) => prior.id === item.id))?.id
      if (id) onSaved(id)
      onClose()
    } else if (result && !result.ok) setError(result.error)
    else setError('保存失败，请重试。')
  }
  return <Modal open onClose={() => { if (!busy) onClose() }} width={600} ariaLabel={iteration ? '编辑版本' : '新建版本'}><fieldset disabled={busy} className="flex max-h-[var(--my-modal-max-height)] min-w-0 flex-col gap-4 p-4"><h2 className="text-my-md font-semibold text-my-primary">{iteration ? '编辑版本' : '新建版本'}</h2><div className="my-scrollbar min-h-0 overflow-y-auto" style={{ scrollbarGutter: 'stable' }}><div className="flex flex-col gap-3">
    <Field label="版本名称"><input autoFocus className={inputClass} value={name} onChange={(event) => setName(event.target.value)} /></Field>
    <Field label="交付目标（选填）"><textarea className={textareaClass} rows={2} value={goal} onChange={(event) => setGoal(event.target.value)} /></Field>
    <Field label="启动安排"><select className={inputClass} disabled={iteration?.status === 'active'} value={predecessorId} onChange={(event) => setPredecessorId(event.target.value)}><option value="">并行开始</option>{candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>在 {candidate.name} 截版后开始</option>)}</select></Field>
    <div className="grid grid-cols-2 gap-2"><Field label="开始日期"><input type="date" disabled={iteration?.status === 'active'} className={inputClass} value={range.start} onChange={(event) => setRange((previous) => ({ ...previous, start: event.target.value }))} /></Field><Field label="结束日期"><input type="date" min={range.start} className={inputClass} value={range.end} onChange={(event) => setRange((previous) => ({ ...previous, end: event.target.value }))} /></Field></div>
    {invalidDates && <p role="alert" className="text-my-xs text-my-danger-text">请填写完整日期，结束日期不能早于开始日期。</p>}
    <fieldset className="min-w-0"><legend className="mb-2 text-my-xs font-medium text-my-tertiary">任务范围 · 已选 {taskIds.length}</legend><SearchInput value={keyword} onChange={setKeyword} placeholder="搜索未排期任务" /><ul className="my-scrollbar mt-2 max-h-56 overflow-y-auto divide-y divide-my-line" style={{ scrollbarGutter: 'stable' }}>{tasks.map((task) => <li key={task.id}><label className="flex cursor-pointer items-center gap-2 py-2"><input type="checkbox" checked={taskIds.includes(task.id)} onChange={(event) => setTaskIds((previous) => event.target.checked ? [...previous, task.id] : previous.filter((id) => id !== task.id))} /><span className="font-mono text-my-xs text-my-tertiary">{task.id}</span><span className="min-w-0 flex-1 truncate text-my-sm text-my-secondary">{task.title}</span><StatusBadge status={statusOf(snapshot, task.statusId)} /></label></li>)}{tasks.length === 0 && <li className="py-3 text-my-xs text-my-tertiary">没有可选任务</li>}</ul></fieldset>
    {error && <p role="alert" className="text-my-xs text-my-danger-text">{error}</p>}
  </div></div><div className="flex justify-end gap-2"><Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>取消</Button><Button size="sm" variant="primary" disabled={busy || !name.trim() || invalidDates} onClick={() => void save()}>{busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}{iteration ? '保存' : '创建'}</Button></div></fieldset></Modal>
}

function DeliveryEditor({ snapshot, targetId, onClose, onSaved }: { snapshot: HifoxSnapshot; targetId: string; onClose: () => void; onSaved: () => void }): JSX.Element {
  const run = useHifox((state) => state.run)
  const busy = useHifox((state) => state.busy)
  const target = snapshot.iterations.find((item) => item.id === targetId)
  const sources = snapshot.iterations.filter((item) => item.spaceId === target?.spaceId && item.id !== targetId)
  const [sourceId, setSourceId] = useState('')
  const [kind, setKind] = useState<HifoxRecordVersionDeliveryInput['kind']>('code')
  const [reference, setReference] = useState('')
  const [revision, setRevision] = useState('')
  const [error, setError] = useState<string | null>(null)
  const save = async (): Promise<void> => {
    if (busy || !target || !sourceId || !reference.trim()) return
    setError(null)
    const result = await run('登记交付', () => api.hifox.recordVersionDelivery({ sourceIterationId: sourceId, targetIterationId: target.id, kind, reference: reference.trim(), ...(revision.trim() ? { revision: revision.trim() } : {}) }))
    if (result?.ok) { onSaved(); onClose() }
    else if (result && !result.ok) setError(result.error)
    else setError('保存失败，请重试。')
  }
  return <Modal open onClose={() => { if (!busy) onClose() }} width={460} ariaLabel="登记交付">
    <fieldset disabled={busy} className="flex max-h-[var(--my-modal-max-height)] min-w-0 flex-col gap-4 p-4">
      <h2 className="shrink-0 text-my-md font-semibold text-my-primary">登记交付 · {target?.name}</h2>
      <div className="my-scrollbar min-h-0 overflow-y-auto" style={{ scrollbarGutter: 'stable' }}><div className="flex flex-col gap-3">
        <Field label="来源版本"><select className={inputClass} value={sourceId} onChange={(event) => setSourceId(event.target.value)}><option value="">选择来源版本</option>{sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}</select></Field>
        <Field label="交付类型"><select className={inputClass} value={kind} onChange={(event) => setKind(event.target.value === 'artifact' ? 'artifact' : 'code')}><option value="code">代码</option><option value="artifact">制品</option></select></Field>
        <Field label="引用"><input className={inputClass} maxLength={10000} value={reference} onChange={(event) => setReference(event.target.value)} placeholder={kind === 'code' ? '提交、合并请求或代码引用' : '制品地址或标识'} /></Field>
        <Field label="修订（选填）"><input className={inputClass} maxLength={1000} value={revision} onChange={(event) => setRevision(event.target.value)} /></Field>
        {error && <p role="alert" className="text-my-xs text-my-danger-text">{error}</p>}
      </div></div>
      <div className="flex shrink-0 justify-end gap-2"><Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" size="sm" aria-busy={busy} disabled={busy || !sourceId || !reference.trim()} onClick={() => void save()}>{busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}登记交付</Button></div>
    </fieldset>
  </Modal>
}

function MoveScopeEditor({ snapshot, targetId, onClose }: { snapshot: HifoxSnapshot; targetId: string; onClose: () => void }): JSX.Element {
  const run = useHifox((state) => state.run)
  const busy = useHifox((state) => state.busy)
  const workspaceKey = useHifox((state) => state.workspaceContext.key)
  const [taskId, setTaskId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const target = snapshot.iterations.find((item) => item.id === targetId)
  const candidates = snapshot.tasks.filter((task) => task.spaceId === target?.spaceId && !task.iterationIds.includes(targetId) && task.iterationIds.length > 0 && !task.triagePending && !isFinished(snapshot, task) && task.iterationIds.every((id) => snapshot.iterations.some((item) => item.id === id && item.status !== 'completed')))
  const task = candidates.find((item) => item.id === taskId)
  const sourceNames = task?.iterationIds.map((id) => snapshot.iterations.find((item) => item.id === id)?.name ?? id).join('、')
  const move = async (): Promise<void> => {
    if (busy || !target || target.status === 'completed' || !task) return
    setError(null)
    if (!await confirmDialog({ title: `移入 ${target.name}？`, message: `将 ${task.id} 从 ${sourceNames} 移入 ${target.name}，修改原版本范围并保留操作历史。`, confirmText: '移入此版本' })) return
    if (useHifox.getState().workspaceContext.key !== workspaceKey) return
    const result = await run('移入版本任务', () => {
      const current = useHifox.getState()
      const currentSnapshot = current.snapshot
      const currentTask = currentSnapshot?.tasks.find((item) => item.id === task.id)
      const currentTarget = currentSnapshot?.iterations.find((item) => item.id === target.id)
      const sameScope = currentTask?.iterationIds.length === task.iterationIds.length && currentTask.iterationIds.every((id) => task.iterationIds.includes(id))
      if (!currentSnapshot || current.workspaceContext.key !== workspaceKey || !currentTask || !currentTarget || currentTarget.status === 'completed' || !sameScope ||
        currentSnapshot.spaces.find((item) => item.id === currentTarget.spaceId)?.archived || isFinished(currentSnapshot, currentTask) || currentTask.triagePending ||
        currentTask.iterationIds.some((id) => currentSnapshot.iterations.find((item) => item.id === id)?.status === 'completed')) {
        return Promise.resolve({ ok: false as const, error: '任务范围已变化，请重新选择。' })
      }
      return api.hifox.updateTask({ id: task.id, patch: { iterationIds: [target.id] } })
    })
    if (result?.ok) onClose()
    else if (result && !result.ok) setError(result.error)
    else setError('保存失败，请重试。')
  }
  return <Modal open onClose={() => { if (!busy) onClose() }} width={520} ariaLabel="移入已排期任务">
    <fieldset disabled={busy} className="flex max-h-[var(--my-modal-max-height)] min-w-0 flex-col gap-4 p-4">
      <h2 className="shrink-0 text-my-md font-semibold text-my-primary">移入任务 · {target?.name}</h2>
      <div className="my-scrollbar min-h-0 overflow-y-auto" style={{ scrollbarGutter: 'stable' }}><div className="flex flex-col gap-3">
        {candidates.length === 0 ? <EmptyState title="没有可移入任务" /> : <><Field label="任务"><select className={inputClass} value={taskId} onChange={(event) => setTaskId(event.target.value)}><option value="">选择已排期任务</option>{candidates.map((item) => <option key={item.id} value={item.id}>{item.id} · {item.title}</option>)}</select></Field>{task && <p className="text-my-xs text-my-secondary">当前版本：{sourceNames}</p>}</>}
        {error && <p role="alert" className="text-my-xs text-my-danger-text">{error}</p>}
      </div></div>
      <div className="flex shrink-0 justify-end gap-2"><Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" size="sm" aria-busy={busy} disabled={busy || !task} onClick={() => void move()}>{busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}移入此版本</Button></div>
    </fieldset>
  </Modal>
}
