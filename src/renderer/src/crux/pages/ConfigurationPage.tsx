import { useState, type JSX } from 'react'
import { Archive, GitBranch, Loader2, Pencil, Plus, Trash2 } from 'lucide-react'
import type { CruxSnapshot, CruxStatusCategory, CruxTaskType } from '@shared/crux'
import { api } from '../../api'
import { confirmDialog } from '../../components/Dialogs'
import { Button, EmptyState, Modal, SearchInput, Tooltip } from '../../my/ui'
import {
  useCollaborationPlatform,
  workflowKey,
  type TaskTypeWorkflowConfig,
  type WorkflowMode
} from '../collaboration-platform-store'
import { statusDisplayName, useCrux } from '../store'
import { Field, inputClass, LabelChip, PageHeader, Select, StatusBadge } from '../ui'

export type ConfigurationKind = 'types' | 'statuses' | 'labels'

const TITLES: Record<ConfigurationKind, string> = { types: '任务类型 & 工作流', statuses: '任务状态', labels: '任务标签' }
const CATEGORIES: Array<[CruxStatusCategory, string, string]> = [
  ['backlog', '待规划', '进入正式排期前的创意与储备工作'],
  ['todo', '待开始', '已确认需求但尚未动手的任务'],
  ['in_progress', '进行中', '正在由成员或 Agent 积极推进的工作'],
  ['in_review', '待评审', '等待设计评审、代码审查、测试或验收'],
  ['blocked', '受阻', '等待补充信息、外部依赖或人工确认'],
  ['done', '已完成', '已通过验收并交付结束的任务'],
  ['cancelled', '已取消', '不再推进或标记重复关闭的任务']
]

export function ConfigurationPage({ kind }: { kind: ConfigurationKind }): JSX.Element | null {
  const snapshot = useCrux((state) => state.snapshot)
  const spaceId = useCrux((state) => state.currentSpaceId)
  const workspace = useCrux((state) => state.workspaceContext)
  const run = useCrux((state) => state.run)
  const busy = useCrux((state) => state.busy)
  const typeWorkflows = useCollaborationPlatform((state) => state.typeWorkflows)
  const saveTypeWorkflow = useCollaborationPlatform((state) => state.saveTypeWorkflow)

  const [keyword, setKeyword] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [editing, setEditing] = useState<{ kind: ConfigurationKind; spaceId: string; type?: CruxTaskType } | null>(null)
  if (!snapshot) return null

  const space = snapshot.spaces.find((item) => item.id === spaceId)
  const actorId = workspace.actorId ?? (workspace.state === 'local' ? snapshot.members.find((member) => member.role === 'owner')?.id : undefined)
  const canRead = Boolean(space && (space.visibility !== 'private' || (actorId && space.memberIds.includes(actorId))))
  const canConfigure = canRead && workspace.canManage && !space?.archived
  const matches = (name: string): boolean => name.toLowerCase().includes(keyword.toLowerCase())
  const types = snapshot.taskTypes.filter((item) => item.spaceId === spaceId && matches(item.name))
  const statuses = snapshot.taskStatuses.filter((item) => item.spaceId === spaceId && (matches(item.name) || matches(statusDisplayName(item)))).sort((a, b) => a.order - b.order)
  const labels = snapshot.taskLabels.filter((item) => (!item.spaceId || item.spaceId === spaceId) && (showArchived || !item.archived) && matches(item.name))
  const count = kind === 'types' ? types.length : kind === 'statuses' ? statuses.length : labels.length

  const remove = async (id: string, name: string): Promise<void> => {
    if (!canConfigure || busy) return
    const origin = workspace.key
    const confirmed = await confirmDialog({
      title: `${kind === 'labels' ? '归档' : '删除'}「${name}」？`,
      message: kind === 'labels' ? '归档后不可用于新任务，已有任务保留此标签。' : kind === 'types' ? '已有任务保留。正在使用的任务类型不能删除。' : '正在使用的状态不能删除。',
      confirmText: kind === 'labels' ? '归档' : '删除',
      danger: kind !== 'labels'
    })
    if (!confirmed || useCrux.getState().workspaceContext.key !== origin) return
    await run(kind === 'labels' ? '归档标签' : kind === 'types' ? '删除类型' : '删除状态', () => kind === 'types'
      ? api.crux.removeTaskType({ id }) : kind === 'statuses' ? api.crux.removeTaskStatus({ id }) : api.crux.archiveLabel({ id }))
  }

  return (
    <div className="my-fade flex min-h-0 flex-1 flex-col gap-3">
      <PageHeader
        title={TITLES[kind]}
        description={kind === 'types'
          ? '为每种任务类型定义可用状态与流转规则矩阵（对标 HiFox Task Type Workflow），看板与任务详情自动按规则流转。'
          : kind === 'statuses'
            ? '按 7 大标准状态分类管理空间状态；报表、看板与自动化始终以状态分类为基准。'
            : '统一管理组织级与空间级任务标签。'}
        actions={
          <Tooltip label={`新建${TITLES[kind]}`} side="bottom">
            <Button variant="primary" size="sm" disabled={busy || !canConfigure} onClick={() => { if (space) setEditing({ kind, spaceId: space.id }) }}>
              <Plus size={14} />新建
            </Button>
          </Tooltip>
        }
      />
      {!space || !canRead ? <EmptyState title={!space ? '未选择空间' : '加入空间后可查看配置'} /> : <>
        <div className="flex flex-wrap items-center gap-3">
          <SearchInput value={keyword} onChange={setKeyword} placeholder={`搜索${TITLES[kind]}`} />
          <span className="text-my-xs text-my-tertiary">{count} 项</span>
          {kind === 'labels' && <label className="flex items-center gap-2 text-my-xs text-my-secondary"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />含已归档</label>}
          {space.archived && <span className="text-my-xs text-my-tertiary">空间已归档</span>}
        </div>

        <div className="my-scrollbar flex min-h-0 flex-1 flex-col overflow-auto pr-1" style={{ scrollbarGutter: 'stable' }}>
          {kind === 'statuses' ? (
            <div className="flex flex-col gap-3">
              {CATEGORIES.map(([catKey, catLabel, catDesc]) => {
                const group = statuses.filter((status) => status.category === catKey)
                return (
                  <section key={catKey} className="rounded-my-base border border-my-line bg-my-panel p-3">
                    <header className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <h2 className="my-item-title">{catLabel}</h2>
                        <span className="text-my-2xs text-my-tertiary">{catDesc}</span>
                      </div>
                      <span className="text-my-2xs tabular-nums text-my-tertiary">{group.length} 个状态</span>
                    </header>
                    {group.length === 0 ? (
                      <p className="my-item-description">暂无此分类状态</p>
                    ) : (
                      <ul className="divide-y divide-my-line">
                        {group.map((status) => {
                          const taskCount = snapshot.tasks.filter((task) => task.statusId === status.id).length
                          const typeCount = snapshot.taskTypes.filter((t) => t.spaceId === spaceId && (!t.statusIds?.length || t.statusIds.includes(status.id))).length
                          return (
                            <li key={status.id} className="flex items-center justify-between gap-3 py-2">
                              <div className="flex items-center gap-2">
                                <StatusBadge status={status} />
                                <span className="text-my-2xs tabular-nums text-my-tertiary">{taskCount} 条任务 · {typeCount} 种类型使用</span>
                              </div>
                              <Tooltip label={taskCount > 0 ? '此状态正在使用' : `删除 ${statusDisplayName(status)}`}>
                                <Button variant="ghost" size="sm" className="my-icon-control" disabled={busy || !canConfigure || taskCount > 0} aria-label={`删除 ${statusDisplayName(status)}`} onClick={() => void remove(status.id, statusDisplayName(status))}>
                                  <Trash2 size={14} />
                                </Button>
                              </Tooltip>
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </section>
                )
              })}
            </div>
          ) : count === 0 ? <EmptyState title={keyword ? '没有匹配项' : `暂无${TITLES[kind]}`} /> : (
            <div className="overflow-hidden rounded-my-base border border-my-line">
              <table className="w-full border-collapse text-left text-my-sm">
                <thead className="sticky top-0 bg-my-canvas text-my-xs text-my-tertiary">
                  <tr className="border-b border-my-line">
                    <th className="px-3 py-2 font-medium">名称</th>
                    <th className="px-3 py-2 font-medium">{kind === 'types' ? '工作流与可用状态' : '范围'}</th>
                    <th className="px-3 py-2 font-medium"><span className="sr-only">操作</span></th>
                  </tr>
                </thead>
                <tbody>
                  {kind === 'types' && types.map((type) => {
                    const inUse = snapshot.tasks.some((task) => task.typeId === type.id)
                    const available = snapshot.taskStatuses.filter((status) => status.spaceId === spaceId && (!type.statusIds?.length || type.statusIds.includes(status.id))).sort((a, b) => a.order - b.order)
                    const wf = typeWorkflows[workflowKey(space.id, type.id)]
                    return (
                      <tr key={type.id} className="border-b border-my-line hover:bg-my-layer-1-hover">
                        <td className="px-3 py-2.5 text-my-primary">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{type.name}</span>
                            {type.isDefault && <span className="my-chip">默认</span>}
                            <span className="my-chip inline-flex items-center gap-1">
                              <GitBranch size={11} />
                              {wf?.mode === 'strict' ? '严格流转矩阵' : '自由流转'}
                            </span>
                          </div>
                          {Boolean(type.requiredHints?.length) && <p className="mt-1 text-my-xs text-my-tertiary">必填：{type.requiredHints?.join('、')}</p>}
                        </td>
                        <td className="px-3 py-2.5"><div className="flex flex-wrap gap-1">{available.map((status) => <StatusBadge key={status.id} status={status} />)}</div></td>
                        <td className="px-3 py-2.5">
                          <div className="flex justify-end gap-1">
                            <Button variant="outline" size="sm" disabled={busy || !canConfigure} onClick={() => setEditing({ kind, spaceId: space.id, type })}>
                              <Pencil size={13} />编辑工作流
                            </Button>
                            <Tooltip label={type.isDefault ? '默认类型不能删除' : inUse ? '此类型正在使用' : `删除 ${type.name}`}>
                              <Button variant="ghost" size="sm" className="my-icon-control" disabled={busy || !canConfigure || type.isDefault || inUse} aria-label={`删除 ${type.name}`} onClick={() => void remove(type.id, type.name)}>
                                <Trash2 size={14} />
                              </Button>
                            </Tooltip>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                  {kind === 'labels' && labels.map((label) => (
                    <tr key={label.id} className="border-b border-my-line hover:bg-my-layer-1-hover">
                      <td className="px-3 py-2"><span className={label.archived ? 'opacity-50' : undefined}><LabelChip label={label} /></span>{label.archived && <span className="ml-2 text-my-xs text-my-tertiary">已归档</span>}</td>
                      <td className="px-3 py-2 text-my-secondary">{label.spaceId ? space.name : '组织'}</td>
                      <td className="px-3 py-2"><div className="flex justify-end"><Tooltip label={`归档 ${label.name}`}><Button variant="ghost" size="sm" className="my-icon-control" disabled={busy || !canConfigure || label.archived} aria-label={`归档 ${label.name}`} onClick={() => void remove(label.id, label.name)}><Archive size={14} /></Button></Tooltip></div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </>}
      {editing && editing.kind === kind && editing.spaceId === spaceId && canConfigure && (
        <ConfigurationEditor
          key={`${editing.spaceId}:${kind}:${editing.type?.id ?? 'new'}`}
          kind={kind}
          spaceId={editing.spaceId}
          snapshot={snapshot}
          existing={editing.type}
          existingWorkflow={editing.type ? typeWorkflows[workflowKey(editing.spaceId, editing.type.id)] : undefined}
          onSaveWorkflow={saveTypeWorkflow}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

function ConfigurationEditor({
  kind,
  spaceId,
  snapshot,
  existing,
  existingWorkflow,
  onSaveWorkflow,
  onClose
}: {
  kind: ConfigurationKind
  spaceId: string
  snapshot: CruxSnapshot
  existing?: CruxTaskType
  existingWorkflow?: TaskTypeWorkflowConfig
  onSaveWorkflow: (spaceId: string, typeId: string, config: Omit<TaskTypeWorkflowConfig, 'updatedAt'>) => void
  onClose: () => void
}): JSX.Element {
  const run = useCrux((state) => state.run)
  const busy = useCrux((state) => state.busy)
  const statuses = snapshot.taskStatuses.filter((status) => status.spaceId === spaceId).sort((a, b) => a.order - b.order)

  const [tab, setTab] = useState<'basic' | 'statuses' | 'transitions'>('basic')
  const [name, setName] = useState(existing?.name ?? '')
  const [category, setCategory] = useState<CruxStatusCategory>('todo')
  const [organization, setOrganization] = useState(false)
  const [allStatuses, setAllStatuses] = useState(!existing?.statusIds?.length)
  const [statusIds, setStatusIds] = useState(existing?.statusIds?.length ? existing.statusIds : statuses.map((status) => status.id))
  const [workflowMode, setWorkflowMode] = useState<WorkflowMode>(existingWorkflow?.mode ?? 'simple')
  const [defaultStatusId, setDefaultStatusId] = useState<string>(existingWorkflow?.defaultStatusId ?? statuses[0]?.id ?? '')
  const [transitions, setTransitions] = useState<Record<string, string[]>>(() => {
    if (existingWorkflow?.transitions) return existingWorkflow.transitions
    const map: Record<string, string[]> = {}
    for (const st of statuses) {
      map[st.id] = statuses.filter((target) => target.id !== st.id).map((target) => target.id)
    }
    return map
  })
  const [error, setError] = useState<string | null>(null)

  const activeStatuses = allStatuses ? statuses : statuses.filter((status) => statusIds.includes(status.id))
  const invalidStatuses = kind === 'types' && !allStatuses && statusIds.length === 0

  const toggleTransition = (fromId: string, toId: string): void => {
    setTransitions((prev) => {
      const current = prev[fromId] ?? activeStatuses.filter((s) => s.id !== fromId).map((s) => s.id)
      const next = current.includes(toId) ? current.filter((id) => id !== toId) : [...current, toId]
      return { ...prev, [fromId]: next }
    })
  }

  const save = async (): Promise<void> => {
    if (busy || !name.trim() || invalidStatuses) return
    setError(null)
    const result = await run(`${existing ? '更新' : '新建'}${TITLES[kind]}`, () => {
      if (kind === 'types') {
        const fields = { name: name.trim(), statusIds: allStatuses ? [] : statusIds }
        return existing ? api.crux.updateTaskType({ id: existing.id, ...fields }) : api.crux.createTaskType({ spaceId, name: name.trim(), ...(allStatuses ? {} : { statusIds }) })
      }
      if (kind === 'statuses') return api.crux.createTaskStatus({ spaceId, name: name.trim(), category })
      return api.crux.createLabel({ spaceId: organization ? undefined : spaceId, name: name.trim() })
    })
    if (result?.ok) {
      if (kind === 'types') {
        const savedTypeId = existing?.id ?? [...result.data.taskTypes].reverse().find((item) => item.spaceId === spaceId && item.name === name.trim())?.id
        if (savedTypeId) {
          onSaveWorkflow(spaceId, savedTypeId, {
            mode: workflowMode,
            defaultStatusId: defaultStatusId || activeStatuses[0]?.id,
            transitions
          })
        }
      }
      onClose()
    } else if (result && !result.ok) setError(result.error)
    else setError('保存失败，请重试。')
  }

  return (
    <Modal open onClose={() => { if (!busy) onClose() }} width={kind === 'types' ? 680 : 460} ariaLabel={`${existing ? '编辑' : '新建'}${TITLES[kind]}`}>
      <fieldset disabled={busy} className="flex max-h-[var(--my-modal-max-height)] min-w-0 flex-col gap-4 p-4">
        <header className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-my-md font-semibold text-my-primary">{existing ? '编辑' : '新建'}{TITLES[kind]}</h2>
          {kind === 'types' && (
            <div className="flex items-center gap-1" role="tablist" aria-label="任务工作流编辑分页">
              {([
                ['basic', '基本信息'],
                ['statuses', `状态定义 (${activeStatuses.length})`],
                ['transitions', '流转规则']
              ] as const).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={tab === id}
                  onClick={() => setTab(id)}
                  className={`my-control my-control-sm ${tab === id ? 'bg-my-navigation-selected font-medium text-my-primary' : 'text-my-secondary hover:bg-my-navigation-hover'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </header>

        <div className="my-scrollbar min-h-0 flex-1 overflow-y-auto pr-1" style={{ scrollbarGutter: 'stable' }}>
          <div className="flex flex-col gap-3">
            {(kind !== 'types' || tab === 'basic') && (
              <>
                <Field label="名称"><input className={inputClass} autoFocus value={name} onChange={(event) => setName(event.target.value)} /></Field>
                {kind === 'types' && (
                  <>
                    <Field label="流转模式" hint="自由模式允许在可用状态间任意切换；严格模式按「流转规则」矩阵控制下一步可流转状态。">
                      <Select
                        className="w-full"
                        value={workflowMode}
                        onChange={(val) => setWorkflowMode(val as WorkflowMode)}
                        options={[
                          { value: 'simple', label: '自由流转模式（Simple）' },
                          { value: 'strict', label: '严格流转规则模式（Transitions）' }
                        ]}
                      />
                    </Field>
                    <Field label="新建任务默认初始状态">
                      <Select
                        className="w-full"
                        value={defaultStatusId}
                        onChange={setDefaultStatusId}
                        options={activeStatuses.map((status) => ({ value: status.id, label: statusDisplayName(status) }))}
                      />
                    </Field>
                  </>
                )}
                {kind === 'statuses' && (
                  <Field label="状态分类">
                    <Select
                      className="w-full"
                      value={category}
                      onChange={(val) => { const found = CATEGORIES.find(([v]) => v === val); if (found) setCategory(found[0]) }}
                      options={CATEGORIES.map(([v, label]) => ({ value: v, label }))}
                    />
                  </Field>
                )}
                {kind === 'labels' && (
                  <Field label="范围">
                    <Select
                      className="w-full"
                      value={organization ? 'organization' : 'space'}
                      onChange={(val) => setOrganization(val === 'organization')}
                      options={[
                        { value: 'space', label: '当前空间' },
                        { value: 'organization', label: '组织内所有空间' }
                      ]}
                    />
                  </Field>
                )}
              </>
            )}

            {kind === 'types' && tab === 'statuses' && (
              <fieldset className="flex flex-col gap-2">
                <legend className="my-item-title mb-1">可用状态集合</legend>
                <label className="flex items-center gap-2 text-my-sm text-my-secondary">
                  <input type="checkbox" checked={allStatuses} onChange={(event) => setAllStatuses(event.target.checked)} />
                  使用当前空间的全部状态
                </label>
                {!allStatuses && (
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    {statuses.map((status) => (
                      <label key={status.id} className="flex items-center gap-2 rounded-my-base border border-my-line bg-my-panel px-2.5 py-2">
                        <input
                          type="checkbox"
                          checked={statusIds.includes(status.id)}
                          onChange={(event) => setStatusIds((previous) => event.target.checked ? [...previous, status.id] : previous.filter((id) => id !== status.id))}
                        />
                        <StatusBadge status={status} />
                      </label>
                    ))}
                  </div>
                )}
                {invalidStatuses && <p role="alert" className="mt-2 text-my-xs text-my-danger-text">至少选择一个状态。</p>}
              </fieldset>
            )}

            {kind === 'types' && tab === 'transitions' && (
              <div className="flex flex-col gap-3">
                <p className="my-item-description">
                  {workflowMode === 'strict'
                    ? '勾选每个源状态允许直接流转到的目标状态；看板拖拽与任务详情流转栏将严格按此规则生效。'
                    : '当前为自由流转模式，下方规则已预配置；如需强制生效，请在「基本信息」切换为严格流转规则模式。'}
                </p>
                <div className="flex flex-col gap-2.5">
                  {activeStatuses.map((source) => {
                    const allowed = transitions[source.id] ?? activeStatuses.filter((t) => t.id !== source.id).map((t) => t.id)
                    return (
                      <div key={source.id} className="rounded-my-base border border-my-line bg-my-layer-1 p-3">
                        <div className="mb-2 flex items-center gap-2">
                          <StatusBadge status={source} />
                          <span className="text-my-xs text-my-tertiary">可流转至：</span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {activeStatuses.filter((target) => target.id !== source.id).map((target) => {
                            const checked = allowed.includes(target.id)
                            return (
                              <label key={target.id} className={`flex cursor-pointer items-center gap-1.5 rounded-my-base border px-2 py-1 text-my-xs ${checked ? 'border-my-line-strong bg-my-panel text-my-primary' : 'border-my-line text-my-tertiary'}`}>
                                <input type="checkbox" checked={checked} onChange={() => toggleTransition(source.id, target.id)} />
                                {statusDisplayName(target)}
                              </label>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {error && <p role="alert" className="text-my-xs text-my-danger-text">{error}</p>}
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-my-line pt-3">
          <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>取消</Button>
          <Button variant="primary" size="sm" aria-busy={busy} disabled={busy || !name.trim() || invalidStatuses} onClick={() => void save()}>
            {busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
            {existing ? '保存配置' : '创建'}
          </Button>
        </div>
      </fieldset>
    </Modal>
  )
}
