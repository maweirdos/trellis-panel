import { useRef, useState, type JSX } from 'react'
import { FolderKanban, MoreHorizontal, Pencil, Archive, CheckCircle2, Plus, RotateCcw } from 'lucide-react'
import type { CruxProject } from '@shared/crux'
import { api } from '../../api'
import { confirmDialog } from '../../components/Dialogs'
import { Button, Dropdown, DropdownItem, EmptyState, Modal, SearchInput, Tabs, Tooltip, TriProgressBar } from '../../my/ui'
import { memberOf, statusOf, useCrux } from '../store'
import { Field, inputClass, MemberChip, PageHeader, Select, StatusBadge, textareaClass } from '../ui'
import { NewTaskModal } from './TaskDetailDrawer'

type ProjectTab = CruxProject['status']

export function ProjectsPage(): JSX.Element | null {
  const { snapshot, currentSpaceId, setTaskFilter, setModule, openTask, run, busy } = useCrux()
  const [tab, setTab] = useState<ProjectTab>('active')
  const [keyword, setKeyword] = useState('')
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<CruxProject | null>(null)
  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')
  const [ownerId, setOwnerId] = useState('')
  const [newTaskProjectId, setNewTaskProjectId] = useState<string | null>(null)

  const editorSnapshotRef = useRef({ title: '新建专项', isEdit: false })
  if (editorOpen) {
    editorSnapshotRef.current = {
      title: editing ? '编辑专项' : '新建专项',
      isEdit: Boolean(editing)
    }
  }

  if (!snapshot) return null

  const space = snapshot.spaces.find((item) => item.id === currentSpaceId)
  const readOnly = Boolean(space?.archived)
  const members = space
    ? snapshot.members.filter((member) => space.memberIds.includes(member.id))
    : snapshot.members
  const allProjects = snapshot.projects.filter((project) => !currentSpaceId || project.spaceId === currentSpaceId)

  const counts = {
    active: allProjects.filter((project) => project.status === 'active').length,
    done: allProjects.filter((project) => project.status === 'done').length,
    archived: allProjects.filter((project) => project.status === 'archived').length
  }

  const projects = allProjects.filter((project) => {
    if (project.status !== tab) return false
    if (!keyword.trim()) return true
    const query = keyword.trim().toLowerCase()
    return project.name.toLowerCase().includes(query) || (project.goal ?? '').toLowerCase().includes(query)
  })

  const openEditor = (project?: CruxProject): void => {
    setEditing(project ?? null)
    setName(project?.name ?? '')
    setGoal(project?.goal ?? '')
    setOwnerId(project?.ownerIds[0] ?? '')
    setEditorOpen(true)
  }

  const save = async (): Promise<void> => {
    if (!currentSpaceId || !name.trim()) return
    const ownerIds = ownerId ? [ownerId] : []
    const result = await run(editing ? '更新专项' : '创建专项', () =>
      editing
        ? api.crux.updateProject({
            id: editing.id,
            name: name.trim(),
            goal: goal.trim(),
            ownerIds
          })
        : api.crux.createProject({
            spaceId: currentSpaceId,
            name: name.trim(),
            goal: goal.trim() || undefined,
            ownerIds
          })
    )
    if (result?.ok) setEditorOpen(false)
  }

  const updateStatus = async (project: CruxProject, nextStatus: CruxProject['status']): Promise<void> => {
    if (nextStatus === 'archived') {
      const ok = await confirmDialog({
        title: `归档专项「${project.name}」？`,
        message: '归档后保留专项与已有任务记录，可在已归档标签中查看。',
        confirmText: '归档'
      })
      if (!ok) return
    }
    await run('更新专项状态', () => api.crux.updateProject({ id: project.id, status: nextStatus }))
  }

  const openProjectTasks = (project: CruxProject): void => {
    setTaskFilter({ projectId: project.id })
    setModule('tasks')
  }

  const saveDisabledReason = readOnly
    ? '已归档空间仅支持只读查看'
    : !name.trim()
      ? '请先输入专项名称'
      : null

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <PageHeader
        title="专项"
        description="按目标或产品线聚合长期任务，持续追踪完成进度与负责人。"
        actions={
          <Button size="sm" variant="primary" disabled={!currentSpaceId || busy || readOnly} onClick={() => openEditor()}>
            <Plus size={14} />
            <span>新建专项</span>
          </Button>
        }
      />

      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <Tabs
          tabs={[
            { id: 'active' as ProjectTab, label: '进行中', count: counts.active },
            { id: 'done' as ProjectTab, label: '已完成', count: counts.done },
            { id: 'archived' as ProjectTab, label: '已归档', count: counts.archived }
          ]}
          active={tab}
          onChange={setTab}
          ariaLabel="专项状态筛选"
        />
        <SearchInput
          size="sm"
          value={keyword}
          onChange={setKeyword}
          placeholder="搜索专项名称或目标"
          ariaLabel="搜索专项"
          className="w-60"
        />
      </div>

      {projects.length === 0 ? (
        <EmptyState
          icon={<FolderKanban size={28} />}
          title={keyword.trim() ? '没有匹配的专项' : tab === 'active' ? '当前没有进行中的专项' : '当前分类下暂无专项'}
          description={keyword.trim() ? '尝试调整搜索关键词或切换上方状态标签。' : '为跨迭代的长期目标创建一个专项，集中跟踪相关任务进展。'}
          action={
            !keyword.trim() && tab === 'active' && currentSpaceId && !readOnly ? (
              <Button size="sm" variant="primary" onClick={() => openEditor()}>
                <Plus size={14} />
                <span>新建专项</span>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="my-scrollbar min-h-0 flex-1 overflow-y-auto pr-1">
          <div key={tab} className="my-subview-stage grid gap-3 md:grid-cols-2">
            {projects.map((project) => {
            const projectTasks = snapshot.tasks.filter((task) => task.projectId === project.id)
            const doneCount = projectTasks.filter((task) => statusOf(snapshot, task.statusId)?.category === 'done').length
            const activeCount = projectTasks.filter((task) => {
              const category = statusOf(snapshot, task.statusId)?.category
              return category === 'in_progress' || category === 'in_review'
            }).length
            const owner = project.ownerIds[0] ? memberOf(snapshot, project.ownerIds[0]) : undefined
            const previewTasks = projectTasks.slice(0, 3)

            return (
              <article key={project.id} className="my-card flex flex-col gap-3 p-4 transition-colors hover:border-my-line-strong">
                <header className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1 space-y-1">
                    <h2 className="my-item-title truncate text-my-sm font-medium text-my-primary">{project.name}</h2>
                    {project.goal && <p className="line-clamp-2 text-my-xs text-my-secondary">{project.goal}</p>}
                  </div>
                  <Dropdown
                    align="right"
                    width={156}
                    trigger={({ toggle, open }) => (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`专项 ${project.name} 更多操作`}
                        aria-expanded={open}
                        onClick={toggle}
                      >
                        <MoreHorizontal size={14} />
                      </Button>
                    )}
                  >
                    {(close) => (
                      <>
                        <DropdownItem
                          disabled={busy || readOnly}
                          onClick={() => {
                            close()
                            openEditor(project)
                          }}
                        >
                          <Pencil size={13} />
                          <span>编辑专项</span>
                        </DropdownItem>
                        <DropdownItem
                          disabled={busy || readOnly}
                          onClick={() => {
                            close()
                            setNewTaskProjectId(project.id)
                          }}
                        >
                          <Plus size={13} />
                          <span>新建关联任务</span>
                        </DropdownItem>
                        {project.status === 'active' ? (
                          <DropdownItem
                            disabled={busy || readOnly}
                            onClick={() => {
                              close()
                              void updateStatus(project, 'done')
                            }}
                          >
                            <CheckCircle2 size={13} />
                            <span>标记完成</span>
                          </DropdownItem>
                        ) : (
                          <DropdownItem
                            disabled={busy || readOnly}
                            onClick={() => {
                              close()
                              void updateStatus(project, 'active')
                            }}
                          >
                            <RotateCcw size={13} />
                            <span>恢复进行中</span>
                          </DropdownItem>
                        )}
                        {project.status !== 'archived' && (
                          <DropdownItem
                            disabled={busy || readOnly}
                            onClick={() => {
                              close()
                              void updateStatus(project, 'archived')
                            }}
                          >
                            <Archive size={13} />
                            <span>归档专项</span>
                          </DropdownItem>
                        )}
                      </>
                    )}
                  </Dropdown>
                </header>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-my-xs text-my-secondary">
                    <span className="tabular-nums">已完成 {doneCount} / {projectTasks.length}</span>
                    {owner && <MemberChip member={owner} />}
                  </div>
                  <TriProgressBar
                    total={projectTasks.length}
                    done={doneCount}
                    started={activeCount}
                  />
                </div>

                {previewTasks.length > 0 && (
                  <ul className="space-y-1 border-t border-my-line pt-2.5">
                    {previewTasks.map((task) => (
                      <li key={task.id}>
                        <button
                          type="button"
                          onClick={() => openTask(task.id)}
                          className="flex w-full items-center gap-2 rounded-my-base px-1.5 py-1 text-left transition-colors hover:bg-my-layer-1"
                        >
                          <span className="shrink-0 font-mono text-my-2xs text-my-tertiary">{task.id}</span>
                          <span className="min-w-0 flex-1 truncate text-my-xs text-my-primary">{task.title}</span>
                          <StatusBadge status={statusOf(snapshot, task.statusId)} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                <footer className="mt-auto flex items-center justify-end border-t border-my-line pt-2.5">
                  <Button size="sm" variant="ghost" onClick={() => openProjectTasks(project)}>
                    在任务列表查看
                  </Button>
                </footer>
              </article>
            )
          })}
          </div>
        </div>
      )}

      <Modal open={editorOpen} onClose={() => setEditorOpen(false)} width={480} placement="center" ariaLabel={editorSnapshotRef.current.title}>
        <div className="flex max-h-[82vh] flex-col">
          <header className="shrink-0 border-b border-my-line px-6 py-4">
            <h2 className="text-my-base font-medium text-my-primary">{editorSnapshotRef.current.title}</h2>
          </header>
          <div className="my-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
            <Field label="专项名称">
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：多 Agent 协作工作流重构"
                className={inputClass}
              />
            </Field>
            <Field label="核心目标（可选）">
              <textarea
                rows={3}
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
                placeholder="简要描述本专项的关键产出与交付边界"
                className={textareaClass}
              />
            </Field>
            <Field label="专项负责人">
              <Select
                ariaLabel="专项负责人"
                value={ownerId}
                onChange={setOwnerId}
                options={[
                  { value: '', label: '暂不指定负责人' },
                  ...members.map((member) => ({ value: member.id, label: member.name }))
                ]}
              />
            </Field>
          </div>
          <footer className="flex shrink-0 justify-end gap-2 border-t border-my-line px-6 py-3.5">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditorOpen(false)}>
              取消
            </Button>
            {saveDisabledReason ? (
              <Tooltip label={saveDisabledReason} wrap>
                <span className="inline-flex">
                  <Button size="sm" variant="primary" disabled>
                    {editorSnapshotRef.current.isEdit ? '保存更改' : '创建专项'}
                  </Button>
                </span>
              </Tooltip>
            ) : (
              <Button size="sm" variant="primary" disabled={busy} onClick={() => void save()}>
                {editorSnapshotRef.current.isEdit ? '保存更改' : '创建专项'}
              </Button>
            )}
          </footer>
        </div>
      </Modal>

      <NewTaskModal
        open={Boolean(newTaskProjectId)}
        onClose={() => setNewTaskProjectId(null)}
        spaceId={currentSpaceId ?? undefined}
        projectId={newTaskProjectId ?? undefined}
      />
    </div>
  )
}
