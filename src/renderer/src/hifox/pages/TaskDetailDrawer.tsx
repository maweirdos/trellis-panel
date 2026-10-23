/**
 * 任务详情抽屉 + 新建任务弹窗：字段编辑、评论、活动、子任务、关联、关注、派发状态。
 */
import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { api } from '../../api'
import { useHifox, memberOf, statusOf } from '../store'
import { Drawer, Field, StatusBadge, PriorityBadge, LabelChip, MemberChip, ExecutorBadge, DispatchNote, inputClass } from '../ui'
import { Button, Modal, Checkbox, EmptyState, formatDate } from '../../my/ui'
import type { HifoxID, HifoxPriority, HifoxTask } from '@shared/hifox'

/** 面板视角：当前登录成员（演示数据中的 owner） */
const CURRENT_MEMBER = 'm-lin'

export function TaskDetailDrawer(): JSX.Element | null {
  const snapshot = useHifox((s) => s.snapshot)!
  const openTaskId = useHifox((s) => s.openTaskId)
  const openTask = useHifox((s) => s.openTask)
  const run = useHifox((s) => s.run)
  const [commentDraft, setCommentDraft] = useState('')
  const [relationTarget, setRelationTarget] = useState('')
  const [relationKind, setRelationKind] = useState<'blocks' | 'related' | 'duplicate'>('blocks')
  const [subtaskTitle, setSubtaskTitle] = useState('')

  const task = snapshot.tasks.find((t) => t.id === openTaskId)
  if (!task) return null
  const space = snapshot.spaces.find((s) => s.id === task.spaceId)!
  const statuses = snapshot.taskStatuses.filter((s) => s.spaceId === task.spaceId).sort((a, b) => a.order - b.order)
  const types = snapshot.taskTypes.filter((t) => t.spaceId === task.spaceId)
  const labels = snapshot.taskLabels.filter((l) => l.spaceId === task.spaceId && !l.archived)
  const members = space.memberIds.map((id) => memberOf(snapshot, id)).filter((m): m is NonNullable<typeof m> => Boolean(m))
  const agents = snapshot.agents.filter((a) => a.spaceId === task.spaceId && a.enabled)
  const crews = snapshot.crews.filter((c) => c.spaceId === task.spaceId)
  const projects = snapshot.projects.filter((p) => p.spaceId === task.spaceId && p.status === 'active')
  const iterations = snapshot.iterations.filter((it) => it.spaceId === task.spaceId && it.status !== 'completed')
  const comments = snapshot.comments.filter((c) => c.taskId === task.id)
  const activities = snapshot.activities.filter((a) => a.taskId === task.id)
  const subtasks = snapshot.tasks.filter((t) => t.parentTaskId === task.id)
  const following = task.followerIds.includes(CURRENT_MEMBER)
  const siblingTasks = snapshot.tasks.filter((t) => t.spaceId === task.spaceId && t.id !== task.id)

  const patch = (input: Parameters<typeof api.hifox.updateTask>[0]['patch']) =>
    void run('更新任务', () => api.hifox.updateTask({ id: task.id, patch: input }))

  const toggleAssignee = (id: HifoxID) => {
    const next = task.assigneeIds.includes(id)
      ? task.assigneeIds.filter((x) => x !== id)
      : space.multiAssignee ? [...task.assigneeIds, id] : [id]
    patch({ assigneeIds: next })
  }

  return (
    <Drawer open onClose={() => openTask(null)} title={`${task.id} · ${task.title}`}>
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <StatusBadge status={statusOf(snapshot, task.statusId)} />
          <PriorityBadge priority={task.priority} />
          <ExecutorBadge executor={task.executor} dispatchNote={task.dispatch?.note} />
          <span className="ml-auto text-my-xs text-my-tertiary">创建人 {memberOf(snapshot, task.creatorId)?.name ?? '—'}</span>
        </div>
        <DispatchNote dispatch={task.dispatch} />

        <div className="grid grid-cols-2 gap-2.5">
          <Field label="标题">
            <input className={inputClass} defaultValue={task.title} onBlur={(e) => { if (e.target.value.trim() && e.target.value !== task.title) patch({ title: e.target.value }) }} />
          </Field>
          <Field label="状态">
            <select className={inputClass} value={task.statusId} onChange={(e) => patch({ statusId: e.target.value })}>
              {statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="优先级">
            <select className={inputClass} value={task.priority} onChange={(e) => patch({ priority: e.target.value as HifoxPriority })}>
              <option value="urgent">紧急</option><option value="high">高</option><option value="medium">中</option><option value="low">低</option><option value="none">无</option>
            </select>
          </Field>
          <Field label="类型">
            <select className={inputClass} value={task.typeId ?? ''} onChange={(e) => patch({ typeId: e.target.value || null })}>
              <option value="">未设置</option>
              {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
          <Field label="专项">
            <select className={inputClass} value={task.projectId ?? ''} onChange={(e) => patch({ projectId: e.target.value || null })}>
              <option value="">不属于任何专项</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="迭代">
            <select
              className={inputClass}
              value={task.iterationIds[0] ?? ''}
              onChange={(e) => patch({ iterationIds: e.target.value ? [e.target.value] : [] })}
            >
              <option value="">未排期</option>
              {iterations.map((it) => <option key={it.id} value={it.id}>{it.name}</option>)}
            </select>
          </Field>
        </div>

        <Field label="描述（背景 / 目标 / 验收标准）">
          <textarea className={`${inputClass} min-h-24 resize-y`} defaultValue={task.description ?? ''} onBlur={(e) => { if (e.target.value.trim() !== (task.description ?? '')) patch({ description: e.target.value }) }} />
        </Field>

        <div>
          <p className="mb-1.5 text-my-xs font-medium text-my-tertiary">
            处理人{!space.multiAssignee && '（该空间为单人处理人）'}
          </p>
          <div className="flex flex-wrap gap-2">
            {members.map((m) => (
              <button key={m.id} type="button" onClick={() => toggleAssignee(m.id)}
                className={`flex items-center gap-1.5 rounded-my-md border px-2 py-1 text-my-xs transition-colors ${task.assigneeIds.includes(m.id) ? 'border-indigo-400/60 bg-indigo-500/10 text-indigo-300' : 'border-my-line text-my-secondary hover:bg-my-layer'}`}>
                <MemberChip member={m} size="sm" />{m.name}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="mb-1.5 text-my-xs font-medium text-my-tertiary">执行槽（Agent / 小队，单选；派发推进到等待 Runtime）</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => patch({ executor: null })}
              className={`rounded-my-md border px-2 py-1 text-my-xs ${!task.executor ? 'border-indigo-400/60 bg-indigo-500/10 text-indigo-300' : 'border-my-line text-my-secondary hover:bg-my-layer'}`}>
              不指派
            </button>
            {agents.map((a) => (
              <button key={a.id} type="button" onClick={() => patch({ executor: { kind: 'agent', id: a.id, name: a.name } })}
                className={`rounded-my-md border px-2 py-1 text-my-xs ${task.executor?.kind === 'agent' && task.executor.id === a.id ? 'border-indigo-400/60 bg-indigo-500/10 text-indigo-300' : 'border-my-line text-my-secondary hover:bg-my-layer'}`}>
                Ⓐ {a.name}
              </button>
            ))}
            {crews.map((c) => (
              <button key={c.id} type="button" onClick={() => patch({ executor: { kind: 'crew', id: c.id, name: c.name } })}
                className={`rounded-my-md border px-2 py-1 text-my-xs ${task.executor?.kind === 'crew' && task.executor.id === c.id ? 'border-indigo-400/60 bg-indigo-500/10 text-indigo-300' : 'border-my-line text-my-secondary hover:bg-my-layer'}`}>
                Ⓒ {c.name}
              </button>
            ))}
            {agents.length === 0 && crews.length === 0 && <span className="text-my-xs text-my-tertiary">该空间暂无启用的 Agent / 小队</span>}
          </div>
        </div>

        {labels.length > 0 && (
          <div>
            <p className="mb-1.5 text-my-xs font-medium text-my-tertiary">标签</p>
            <div className="flex flex-wrap gap-1.5">
              {labels.map((l) => {
                const on = task.labelIds.includes(l.id)
                return (
                  <button key={l.id} type="button" onClick={() => patch({ labelIds: on ? task.labelIds.filter((x) => x !== l.id) : [...task.labelIds, l.id] })}
                    className={`rounded-my-sm px-1.5 py-0.5 text-my-xs transition-opacity ${on ? 'opacity-100' : 'opacity-40 hover:opacity-75'}`}
                    style={{ backgroundColor: `${l.color}22`, color: l.color }}>
                    {on ? '✓ ' : ''}{l.name}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {task.parentTaskId && (
          <p className="text-my-xs text-my-tertiary">父任务：<button type="button" className="text-indigo-400 hover:underline" onClick={() => openTask(task.parentTaskId!)}>{task.parentTaskId}</button></p>
        )}

        {/* 子任务 */}
        <section className="rounded-my-md border border-my-line p-2.5">
          <h3 className="mb-2 text-my-xs font-medium text-my-tertiary">子任务（{subtasks.length}）</h3>
          <ul className="space-y-1">
            {subtasks.map((sub) => (
              <li key={sub.id} className="flex items-center gap-2 text-my-xs">
                <button type="button" className="min-w-0 flex-1 truncate text-left text-my-secondary hover:text-my-primary hover:underline" onClick={() => openTask(sub.id)}>
                  <span className="mr-1 font-mono text-[10px] text-my-tertiary">{sub.id}</span>{sub.title}
                </button>
                <StatusBadge status={statusOf(snapshot, sub.statusId)} />
              </li>
            ))}
          </ul>
          <div className="mt-2 flex gap-1.5">
            <input className={inputClass} placeholder="新增子任务标题" value={subtaskTitle} onChange={(e) => setSubtaskTitle(e.target.value)} />
            <Button size="sm" disabled={!subtaskTitle.trim()} onClick={() => {
              void run('创建子任务', () => api.hifox.createTask({ spaceId: task.spaceId, title: subtaskTitle.trim(), parentTaskId: task.id }))
              setSubtaskTitle('')
            }}><Plus size={13} /></Button>
          </div>
        </section>

        {/* 关联 */}
        <section className="rounded-my-md border border-my-line p-2.5">
          <h3 className="mb-2 text-my-xs font-medium text-my-tertiary">关联（{task.relations.length}）</h3>
          <ul className="space-y-1">
            {task.relations.map((rel) => (
              <li key={rel.taskId} className="flex items-center gap-2 text-my-xs">
                <span className="shrink-0 rounded-my-sm bg-my-layer px-1 py-0.5 text-[10px] text-my-tertiary">
                  {rel.kind === 'blocks' ? '阻塞' : rel.kind === 'duplicate' ? '重复' : '相关'}
                </span>
                <button type="button" className="min-w-0 flex-1 truncate text-left text-my-secondary hover:underline" onClick={() => openTask(rel.taskId)}>
                  {rel.taskId} · {snapshot.tasks.find((t) => t.id === rel.taskId)?.title}
                </button>
                <button type="button" aria-label="移除关联" className="text-my-tertiary hover:text-red-400" onClick={() => patch({}) || void run('移除关联', () => api.hifox.removeRelation({ taskId: task.id, targetTaskId: rel.taskId }))}>
                  <Trash2 size={12} />
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex gap-1.5">
            <select className={inputClass} value={relationKind} onChange={(e) => setRelationKind(e.target.value as typeof relationKind)}>
              <option value="blocks">阻塞</option><option value="related">相关</option><option value="duplicate">重复</option>
            </select>
            <select className={inputClass} value={relationTarget} onChange={(e) => setRelationTarget(e.target.value)}>
              <option value="">选择任务…</option>
              {siblingTasks.slice(0, 50).map((t) => <option key={t.id} value={t.id}>{t.id} · {t.title.slice(0, 24)}</option>)}
            </select>
            <Button size="sm" disabled={!relationTarget} onClick={() => {
              void run('添加关联', () => api.hifox.addRelation({ taskId: task.id, relation: { kind: relationKind, taskId: relationTarget } }))
              setRelationTarget('')
            }}><Plus size={13} /></Button>
          </div>
        </section>

        {/* 评论 */}
        <section className="flex flex-col gap-2">
          <h3 className="text-my-xs font-medium text-my-tertiary">评论（{comments.length}）</h3>
          {comments.length === 0 && <p className="text-my-xs text-my-tertiary">还没有讨论。@成员姓名 可提醒对方。</p>}
          {comments.map((comment) => {
            const author = comment.authorId.startsWith('agent:')
              ? `Agent · ${snapshot.agents.find((a) => a.id === comment.authorId.slice(6))?.name ?? 'Agent'}`
              : memberOf(snapshot, comment.authorId)?.name ?? comment.authorId
            return (
              <div key={comment.id} className={`rounded-my-md border p-2.5 ${comment.resolved ? 'border-my-line/50 opacity-60' : 'border-my-line'}`}>
                <div className="mb-1 flex items-center gap-2 text-my-xs">
                  <span className="font-medium text-my-secondary">{author}</span>
                  <span className="text-my-tertiary">{formatDate(comment.createdAt)}</span>
                  <button
                    type="button"
                    className={`ml-auto rounded-my-sm px-1.5 py-0.5 text-[10px] ${comment.resolved ? 'bg-emerald-500/15 text-emerald-500' : 'bg-my-layer text-my-tertiary hover:text-my-secondary'}`}
                    onClick={() => void run('更新评论', () => api.hifox.resolveComment({ id: comment.id, resolved: !comment.resolved }))}
                  >
                    {comment.resolved ? '已解决' : '标记解决'}
                  </button>
                </div>
                <p className="whitespace-pre-wrap text-my-sm leading-relaxed text-my-primary">{comment.body}</p>
              </div>
            )
          })}
          <div className="flex gap-1.5">
            <input
              className={inputClass}
              placeholder="回复 / 补充上下文，@成员 可提醒"
              value={commentDraft}
              onChange={(e) => setCommentDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && commentDraft.trim()) {
                  void run('发表评论', () => api.hifox.addComment({ taskId: task.id, body: commentDraft.trim(), authorId: CURRENT_MEMBER }))
                  setCommentDraft('')
                }
              }}
            />
            <Button size="sm" disabled={!commentDraft.trim()} onClick={() => {
              void run('发表评论', () => api.hifox.addComment({ taskId: task.id, body: commentDraft.trim(), authorId: CURRENT_MEMBER }))
              setCommentDraft('')
            }}>发送</Button>
          </div>
        </section>

        {/* 活动记录 */}
        <section>
          <h3 className="mb-2 text-my-xs font-medium text-my-tertiary">活动（{activities.length}）</h3>
          <ol className="space-y-1">
            {activities.slice(0, 12).map((activity) => (
              <li key={activity.id} className="flex items-baseline gap-2 text-my-xs">
                <span className="shrink-0 text-my-tertiary">{formatDate(activity.at)}</span>
                <span className="text-my-secondary">{activity.text}</span>
              </li>
            ))}
          </ol>
        </section>

        <div className="flex items-center gap-2 border-t border-my-line pt-3">
          <Button variant={following ? 'primary' : 'outline'} size="sm" onClick={() => patch({ followerToggle: CURRENT_MEMBER })}>
            {following ? '已关注' : '关注任务'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void run('删除任务', () => api.hifox.removeTask({ id: task.id })).then((r) => { if (r?.ok) openTask(null) })}>
            删除任务
          </Button>
        </div>
      </div>
    </Drawer>
  )
}

export function NewTaskModal({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element {
  const snapshot = useHifox((s) => s.snapshot)!
  const currentSpaceId = useHifox((s) => s.currentSpaceId)
  const run = useHifox((s) => s.run)
  const openTask = useHifox((s) => s.openTask)
  const setModule = useHifox((s) => s.setModule)

  const space = snapshot.spaces.find((s) => s.id === currentSpaceId)
  const statuses = snapshot.taskStatuses.filter((s) => s.spaceId === currentSpaceId).sort((a, b) => a.order - b.order)
  const types = snapshot.taskTypes.filter((t) => t.spaceId === currentSpaceId)
  const labels = snapshot.taskLabels.filter((l) => l.spaceId === currentSpaceId && !l.archived)
  const members = space?.memberIds.map((id) => memberOf(snapshot, id)).filter((m): m is NonNullable<typeof m> => Boolean(m)) ?? []
  const agents = snapshot.agents.filter((a) => a.spaceId === currentSpaceId && a.enabled)
  const crews = snapshot.crews.filter((c) => c.spaceId === currentSpaceId)
  const projects = snapshot.projects.filter((p) => p.spaceId === currentSpaceId && p.status === 'active')

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [typeId, setTypeId] = useState('')
  const [statusId, setStatusId] = useState('')
  const [priority, setPriority] = useState<HifoxPriority>('none')
  const [assigneeIds, setAssigneeIds] = useState<string[]>([])
  const [executor, setExecutor] = useState('')
  const [labelIds, setLabelIds] = useState<string[]>([])
  const [projectId, setProjectId] = useState('')

  if (!space) return <></>

  const submit = async (): Promise<void> => {
    const result = await run('新建任务', () => api.hifox.createTask({
      spaceId: space.id,
      title: title.trim(),
      description: description.trim() || undefined,
      typeId: typeId || undefined,
      statusId: statusId || undefined,
      priority,
      assigneeIds,
      executor: executor ? (executor.startsWith('agent:')
        ? { kind: 'agent', id: executor.slice(6), name: agents.find((a) => `agent:${a.id}` === executor)!.name }
        : { kind: 'crew', id: executor.slice(5), name: crews.find((c) => `crew:${c.id}` === executor)!.name }) : undefined,
      labelIds,
      projectId: projectId || undefined
    }))
    if (result?.ok) {
      setTitle(''); setDescription(''); setAssigneeIds([]); setExecutor(''); setLabelIds([]); setProjectId(''); setTypeId(''); setPriority('none')
      onClose()
      if ('taskId' in result) {
        openTask(result.taskId as string)
        setModule('tasks')
      }
    }
  }

  return (
    <Modal open={open} onClose={onClose} width={520} ariaLabel="新建任务">
      <div className="flex flex-col gap-3 p-1">
        <h2 className="text-sm font-semibold text-my-primary">新建任务（{space.key}）</h2>
        <Field label="标题">
          <input className={inputClass} autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="一句话说清要做什么" />
        </Field>
        <Field label="描述">
          <textarea className={`${inputClass} min-h-20 resize-y`} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="背景、目标、验收标准；也可交给 Agent 先调研补全" />
        </Field>
        <div className="grid grid-cols-3 gap-2">
          <Field label="类型">
            <select className={inputClass} value={typeId} onChange={(e) => setTypeId(e.target.value)}>
              <option value="">默认</option>
              {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
          <Field label="状态">
            <select className={inputClass} value={statusId} onChange={(e) => setStatusId(e.target.value)}>
              <option value="">Backlog（默认）</option>
              {statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="优先级">
            <select className={inputClass} value={priority} onChange={(e) => setPriority(e.target.value as HifoxPriority)}>
              <option value="none">无</option><option value="urgent">紧急</option><option value="high">高</option><option value="medium">中</option><option value="low">低</option>
            </select>
          </Field>
        </div>
        <div>
          <p className="mb-1.5 text-my-xs font-medium text-my-tertiary">处理人{!space.multiAssignee && '（单人）'}</p>
          <div className="flex flex-wrap gap-2">
            {members.map((m) => (
              <button key={m.id} type="button"
                onClick={() => setAssigneeIds((prev) => prev.includes(m.id) ? prev.filter((x) => x !== m.id) : space.multiAssignee ? [...prev, m.id] : [m.id])}
                className={`flex items-center gap-1 rounded-my-md border px-2 py-1 text-my-xs ${assigneeIds.includes(m.id) ? 'border-indigo-400/60 bg-indigo-500/10 text-indigo-300' : 'border-my-line text-my-secondary hover:bg-my-layer'}`}>
                {m.name}
              </button>
            ))}
          </div>
        </div>
        <Field label="执行槽（可选）">
          <select className={inputClass} value={executor} onChange={(e) => setExecutor(e.target.value)}>
            <option value="">暂不指派 Agent / 小队</option>
            {agents.map((a) => <option key={a.id} value={`agent:${a.id}`}>Agent · {a.name}</option>)}
            {crews.map((c) => <option key={c.id} value={`crew:${c.id}`}>小队 · {c.name}</option>)}
          </select>
        </Field>
        {labels.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {labels.map((l) => (
              <button key={l.id} type="button" onClick={() => setLabelIds((prev) => prev.includes(l.id) ? prev.filter((x) => x !== l.id) : [...prev, l.id])}
                className={`rounded-my-sm px-1.5 py-0.5 text-my-xs ${labelIds.includes(l.id) ? 'opacity-100' : 'opacity-40'}`}
                style={{ backgroundColor: `${l.color}22`, color: l.color }}>
                {labelIds.includes(l.id) ? '✓ ' : ''}{l.name}
              </button>
            ))}
          </div>
        )}
        {projects.length > 0 && (
          <Field label="专项">
            <select className={inputClass} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">不归属专项</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={onClose}>取消</Button>
          <Button variant="primary" size="sm" disabled={!title.trim()} onClick={() => void submit()}>创建</Button>
        </div>
      </div>
    </Modal>
  )
}

export type { HifoxTask }
