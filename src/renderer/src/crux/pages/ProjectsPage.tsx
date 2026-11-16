import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import { api } from '../../api'
import { confirmDialog } from '../../components/Dialogs'
import { useCrux, statusOf, memberOf } from '../store'
import { PageHeader, Field, inputClass, textareaClass, StatusBadge, MemberChip, Select } from '../ui'
import { FlowIcon } from '../icons'
import { Button, EmptyState, Modal } from '../../my/ui'
import { NewTaskModal } from './TaskDetailDrawer'
import type { CruxProject, CruxSnapshot } from '@shared/crux'

export function ProjectsPage(): JSX.Element | null {
  const snapshot = useCrux((s) => s.snapshot)
  const spaceId = useCrux((s) => s.currentSpaceId)
  const run = useCrux((s) => s.run)
  const busy = useCrux((s) => s.busy)
  const openTask = useCrux((s) => s.openTask)
  const [editing, setEditing] = useState<CruxProject | 'new' | null>(null)
  const [newTaskProject, setNewTaskProject] = useState<string | null>(null)
  const [scopeProject, setScopeProject] = useState<string | null>(null)
  const [taskId, setTaskId] = useState('')
  if (!snapshot) return null
  const projects = snapshot.projects.filter((p) => p.spaceId === spaceId)
  const archive = async (project: CruxProject): Promise<void> => {
    if (!await confirmDialog({ title: `归档专项「${project.name}」？`, message: '归档后保留专项与已有任务记录。', confirmText: '归档' })) return
    await run('归档专项', () => api.crux.updateProject({ id: project.id, status: 'archived' }))
  }
  const addTask = async (): Promise<void> => {
    if (!taskId || !scopeProject || busy) return
    const result = await run('归入专项', () => api.crux.updateTask({ id: taskId, patch: { projectId: scopeProject } }))
    if (result?.ok) setTaskId('')
  }
  return <div className="flex min-h-0 flex-1 flex-col gap-3">
    <PageHeader title="专项" description="围绕共同目标汇总任务，跟踪负责人和整体进度。" actions={<Button variant="primary" size="sm" disabled={!spaceId} onClick={() => setEditing('new')}><Plus size={14} />新建专项</Button>} />
    {projects.length === 0 ? <EmptyState title="暂无专项" description="创建专项，将相关任务归入同一目标" /> : <div className="my-scrollbar grid min-h-0 flex-1 auto-rows-min grid-cols-1 gap-3 overflow-y-auto xl:grid-cols-2" style={{ scrollbarGutter: 'stable' }}>{projects.map((project) => {
      const tasks = snapshot.tasks.filter((t) => t.projectId === project.id)
      const done = tasks.filter((t) => statusOf(snapshot, t.statusId)?.category === 'done').length
      const cancelled = tasks.filter((t) => statusOf(snapshot, t.statusId)?.category === 'cancelled').length
      const percent = tasks.length ? Math.round(done / tasks.length * 100) : 0
      return <section key={project.id} className="flex flex-col gap-3 rounded-my-md border border-my-line bg-my-layer-1 p-4" aria-label={`专项 ${project.name}`}>
        <header className="flex items-start gap-2"><FlowIcon name="projects" /><h2 className="min-w-0 flex-1 text-my-md font-medium text-my-primary">{project.name}</h2><span className="rounded-my-sm bg-my-layer-1-active px-2 py-1 text-my-xs text-my-secondary">{project.status === 'active' ? '进行中' : project.status === 'done' ? '已完成' : '已归档'}</span></header>
        <p className="whitespace-pre-wrap text-my-sm text-my-secondary">{project.goal || '尚未填写目标'}</p>
        <div className="flex items-center gap-2 text-my-xs text-my-tertiary"><span>已完成 {done}/{tasks.length}{cancelled > 0 ? ` · 已取消 ${cancelled}` : ''}</span><span className="ml-auto">{percent}%</span></div>
        <div role="progressbar" aria-label={`${project.name} 完成率`} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} className="h-1.5 overflow-hidden rounded-full bg-my-layer-1-active"><div className="h-full rounded-full bg-my-accent" style={{ width: `${percent}%` }} /></div>
        <div className="flex flex-wrap items-center gap-2"><span className="text-my-xs text-my-tertiary">负责人</span>{project.ownerIds.map((id) => <MemberChip key={id} member={memberOf(snapshot, id)} />)}{project.ownerIds.length === 0 && <span className="text-my-xs text-my-tertiary">尚未指定</span>}</div>
        <ul className="my-scrollbar max-h-64 space-y-1 overflow-y-auto">{tasks.map((task) => <li key={task.id} className="flex items-center gap-1"><button type="button" className="flex min-w-0 flex-1 items-center gap-2 rounded-my-md px-2 py-2 text-left hover:bg-my-layer-1-active" onClick={() => openTask(task.id)}><span className="shrink-0 font-mono text-my-2xs text-my-tertiary">{task.id}</span><span className="min-w-0 flex-1 truncate text-my-xs text-my-secondary">{task.title}</span><StatusBadge status={statusOf(snapshot, task.statusId)} /></button>{project.status === 'active' && <Button variant="ghost" size="sm" disabled={busy} aria-label={`移出专项 ${task.id}`} onClick={() => void run('移出专项', () => api.crux.updateTask({ id: task.id, patch: { projectId: null } }))}><X size={14} /></Button>}</li>)}</ul>
        {tasks.length === 0 && <p className="text-my-xs text-my-tertiary">专项中还没有任务。</p>}
        <div className="flex flex-wrap justify-end gap-2">{project.status !== 'archived' && <Button size="sm" onClick={() => setEditing(project)}>编辑目标</Button>}{project.status === 'active' ? <><Button size="sm" onClick={() => { setScopeProject(project.id); setTaskId('') }}>添加已有任务</Button><Button size="sm" onClick={() => setNewTaskProject(project.id)}>新建任务</Button><Button size="sm" disabled={busy} onClick={() => void run('完成专项', () => api.crux.updateProject({ id: project.id, status: 'done' }))}>标记完成</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => void archive(project)}>归档</Button></> : <Button size="sm" disabled={busy} onClick={() => void run('重新打开专项', () => api.crux.updateProject({ id: project.id, status: 'active' }))}>重新打开</Button>}</div>
      </section>
    })}</div>}
    {editing && spaceId && <ProjectEditor key={editing === 'new' ? 'new' : editing.id} snapshot={snapshot} spaceId={spaceId} project={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    <Modal open={Boolean(scopeProject)} onClose={() => setScopeProject(null)} width={460} ariaLabel="添加已有任务"><div className="flex flex-col gap-3 p-4"><h2 className="text-my-md font-medium text-my-primary">添加已有任务</h2><Field label="任务">
      <Select
        className="w-full"
        value={taskId}
        onChange={setTaskId}
        options={[
          { value: '', label: '选择任务…' },
          ...snapshot.tasks.filter((t) => t.spaceId === spaceId && t.projectId !== scopeProject).map((t) => ({ value: t.id, label: `${t.id} · ${t.title}${t.projectId ? '（将从原专项移入）' : ''}` }))
        ]}
      />
    </Field><div className="flex justify-end gap-2"><Button size="sm" onClick={() => setScopeProject(null)}>关闭</Button><Button variant="primary" size="sm" disabled={!taskId || busy} onClick={() => void addTask()}>添加到专项</Button></div></div></Modal>
    <NewTaskModal open={Boolean(newTaskProject)} onClose={() => setNewTaskProject(null)} projectId={newTaskProject ?? undefined} />
  </div>
}

function ProjectEditor({ snapshot, spaceId, project, onClose }: { snapshot: CruxSnapshot; spaceId: string; project?: CruxProject; onClose: () => void }): JSX.Element {
  const run = useCrux((s) => s.run)
  const busy = useCrux((s) => s.busy)
  const [name, setName] = useState(project?.name ?? '')
  const [goal, setGoal] = useState(project?.goal ?? '')
  const [ownerIds, setOwnerIds] = useState<string[]>(project?.ownerIds ?? [])
  const members = snapshot.members.filter((m) => snapshot.spaces.find((s) => s.id === spaceId)?.memberIds.includes(m.id))
  const save = async (): Promise<void> => {
    if (busy || !name.trim()) return
    const result = await run(project ? '更新专项' : '创建专项', () => project ? api.crux.updateProject({ id: project.id, name: name.trim(), goal: goal.trim(), ownerIds }) : api.crux.createProject({ spaceId, name: name.trim(), goal: goal.trim(), ownerIds }))
    if (result?.ok) onClose()
  }
  return <Modal open onClose={onClose} width={480} ariaLabel={project ? '编辑专项' : '新建专项'}><fieldset disabled={busy} className="flex min-w-0 flex-col gap-3 p-4"><h2 className="text-my-md font-semibold text-my-primary">{project ? '编辑专项' : '新建专项'}</h2><Field label="专项名称"><input autoFocus className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="如：协作体验升级" /></Field><Field label="专项目标"><textarea className={textareaClass} style={{ minHeight: 'var(--my-space-80)' }} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="要达成什么，如何判断完成" /></Field>{<section><h3 className="mb-2 text-my-xs text-my-tertiary">负责人</h3><div className="flex flex-wrap gap-2">{members.map((m) => <label key={m.id} className="flex items-center gap-2 text-my-sm text-my-secondary"><input type="checkbox" checked={ownerIds.includes(m.id)} onChange={(e) => setOwnerIds((prev) => e.target.checked ? [...prev, m.id] : prev.filter((id) => id !== m.id))} />{m.name}</label>)}</div></section>}<div className="flex justify-end gap-2"><Button size="sm" onClick={onClose}>取消</Button><Button size="sm" variant="primary" disabled={!name.trim()} onClick={() => void save()}>{project ? '保存专项' : '创建专项'}</Button></div></fieldset></Modal>
}
