import { useState } from 'react'
import { Archive, Loader2, Pencil, Plus, Trash2 } from 'lucide-react'
import type { CruxSnapshot, CruxStatusCategory, CruxTaskType } from '@shared/crux'
import { api } from '../../api'
import { confirmDialog } from '../../components/Dialogs'
import { Button, EmptyState, Modal, SearchInput, Tooltip } from '../../my/ui'
import { useCrux } from '../store'
import { Field, inputClass, LabelChip, PageHeader, StatusBadge } from '../ui'

export type ConfigurationKind = 'types' | 'statuses' | 'labels'

const TITLES: Record<ConfigurationKind, string> = { types: '任务类型', statuses: '任务状态', labels: '任务标签' }
const CATEGORIES: Array<[CruxStatusCategory, string]> = [
  ['backlog', '待规划'], ['todo', '待开始'], ['in_progress', '处理中'],
  ['in_review', '待评审'], ['done', '已完成'], ['blocked', '受阻'], ['cancelled', '已取消']
]

export function ConfigurationPage({ kind }: { kind: ConfigurationKind }): JSX.Element | null {
  const snapshot = useCrux((state) => state.snapshot)
  const spaceId = useCrux((state) => state.currentSpaceId)
  const workspace = useCrux((state) => state.workspaceContext)
  const run = useCrux((state) => state.run)
  const busy = useCrux((state) => state.busy)
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
  const statuses = snapshot.taskStatuses.filter((item) => item.spaceId === spaceId && matches(item.name)).sort((a, b) => a.order - b.order)
  const labels = snapshot.taskLabels.filter((item) => (!item.spaceId || item.spaceId === spaceId) && (showArchived || !item.archived) && matches(item.name))
  const count = kind === 'types' ? types.length : kind === 'statuses' ? statuses.length : labels.length
  const remove = async (id: string, name: string): Promise<void> => {
    if (!canConfigure || busy) return
    const origin = workspace.key
    const confirmed = await confirmDialog({
      title: `${kind === 'labels' ? '归档' : '删除'}「${name}」？`,
      message: kind === 'labels' ? '归档后不可用于新任务，已有任务保留此标签。' : kind === 'types' ? '已有任务保留。正在使用的任务类型不能删除。' : '正在使用的状态不能删除。',
      confirmText: kind === 'labels' ? '归档' : '删除', danger: kind !== 'labels'
    })
    if (!confirmed || useCrux.getState().workspaceContext.key !== origin) return
    await run(kind === 'labels' ? '归档标签' : kind === 'types' ? '删除类型' : '删除状态', () => kind === 'types'
      ? api.crux.removeTaskType({ id }) : kind === 'statuses' ? api.crux.removeTaskStatus({ id }) : api.crux.archiveLabel({ id }))
  }

  return <div className="my-fade flex min-h-0 flex-1 flex-col gap-3">
    <PageHeader title={TITLES[kind]} actions={<Tooltip label={`新建${TITLES[kind]}`} side="bottom"><Button variant="primary" size="sm" className="my-icon-control" disabled={busy || !canConfigure} aria-label={`新建${TITLES[kind]}`} onClick={() => { if (space) setEditing({ kind, spaceId: space.id }) }}><Plus size={16} /></Button></Tooltip>} />
    {!space || !canRead ? <EmptyState title={!space ? '未选择空间' : '加入空间后可查看配置'} /> : <>
      <div className="flex flex-wrap items-center gap-3"><SearchInput value={keyword} onChange={setKeyword} placeholder={`搜索${TITLES[kind]}`} /><span className="text-my-xs text-my-tertiary">{count} 项</span>{kind === 'labels' && <label className="flex items-center gap-2 text-my-xs text-my-secondary"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />含已归档</label>}{space.archived && <span className="text-my-xs text-my-tertiary">空间已归档</span>}</div>
      <div className="my-scrollbar min-h-0 flex-1 overflow-auto rounded-my-md border border-my-line" style={{ scrollbarGutter: 'stable' }}>
        {count === 0 ? <EmptyState title={keyword ? '没有匹配项' : `暂无${TITLES[kind]}`} /> : <table className="w-full border-collapse text-left text-my-sm">
          <thead className="sticky top-0 bg-my-canvas text-my-xs text-my-tertiary"><tr className="border-b border-my-line"><th className="px-3 py-2 font-medium">名称</th><th className="px-3 py-2 font-medium">{kind === 'types' ? '可用状态' : kind === 'statuses' ? '状态分类' : '范围'}</th><th className="px-3 py-2 font-medium"><span className="sr-only">操作</span></th></tr></thead>
          <tbody>
            {kind === 'types' && types.map((type) => {
              const inUse = snapshot.tasks.some((task) => task.typeId === type.id)
              const available = snapshot.taskStatuses.filter((status) => status.spaceId === spaceId && (!type.statusIds?.length || type.statusIds.includes(status.id))).sort((a, b) => a.order - b.order)
              return <tr key={type.id} className="border-b border-my-line hover:bg-my-layer-1-hover"><td className="px-3 py-2 text-my-primary">{type.name}{type.isDefault && <span className="ml-2 text-my-xs text-my-tertiary">默认</span>}{Boolean(type.requiredHints?.length) && <p className="mt-1 text-my-xs text-my-tertiary">必填：{type.requiredHints?.join('、')}</p>}</td><td className="px-3 py-2"><div className="flex flex-wrap gap-1">{available.map((status) => <StatusBadge key={status.id} status={status} />)}</div></td><td className="px-3 py-2"><div className="flex justify-end gap-1"><Tooltip label={`编辑 ${type.name}`}><Button variant="ghost" size="sm" className="my-icon-control" disabled={busy || !canConfigure} aria-label={`编辑 ${type.name}`} onClick={() => setEditing({ kind, spaceId: space.id, type })}><Pencil size={14} /></Button></Tooltip><Tooltip label={type.isDefault ? '默认类型不能删除' : inUse ? '此类型正在使用' : `删除 ${type.name}`}><Button variant="ghost" size="sm" className="my-icon-control" disabled={busy || !canConfigure || type.isDefault || inUse} aria-label={`删除 ${type.name}`} onClick={() => void remove(type.id, type.name)}><Trash2 size={14} /></Button></Tooltip></div></td></tr>
            })}
            {kind === 'statuses' && statuses.map((status) => {
              const inUse = snapshot.tasks.some((task) => task.statusId === status.id)
              return <tr key={status.id} className="border-b border-my-line hover:bg-my-layer-1-hover"><td className="px-3 py-2"><StatusBadge status={status} /></td><td className="px-3 py-2 text-my-secondary">{CATEGORIES.find(([category]) => category === status.category)?.[1]}</td><td className="px-3 py-2"><div className="flex justify-end"><Tooltip label={inUse ? '此状态正在使用' : `删除 ${status.name}`}><Button variant="ghost" size="sm" className="my-icon-control" disabled={busy || !canConfigure || inUse} aria-label={`删除 ${status.name}`} onClick={() => void remove(status.id, status.name)}><Trash2 size={14} /></Button></Tooltip></div></td></tr>
            })}
            {kind === 'labels' && labels.map((label) => <tr key={label.id} className="border-b border-my-line hover:bg-my-layer-1-hover"><td className="px-3 py-2"><span className={label.archived ? 'opacity-50' : undefined}><LabelChip label={label} /></span>{label.archived && <span className="ml-2 text-my-xs text-my-tertiary">已归档</span>}</td><td className="px-3 py-2 text-my-secondary">{label.spaceId ? space.name : '组织'}</td><td className="px-3 py-2"><div className="flex justify-end"><Tooltip label={`归档 ${label.name}`}><Button variant="ghost" size="sm" className="my-icon-control" disabled={busy || !canConfigure || label.archived} aria-label={`归档 ${label.name}`} onClick={() => void remove(label.id, label.name)}><Archive size={14} /></Button></Tooltip></div></td></tr>)}
          </tbody>
        </table>}
      </div>
    </>}
    {editing && editing.kind === kind && editing.spaceId === spaceId && canConfigure && <ConfigurationEditor key={`${editing.spaceId}:${kind}:${editing.type?.id ?? 'new'}`} kind={kind} spaceId={editing.spaceId} snapshot={snapshot} existing={editing.type} onClose={() => setEditing(null)} />}
  </div>
}

function ConfigurationEditor({ kind, spaceId, snapshot, existing, onClose }: { kind: ConfigurationKind; spaceId: string; snapshot: CruxSnapshot; existing?: CruxTaskType; onClose: () => void }): JSX.Element {
  const run = useCrux((state) => state.run)
  const busy = useCrux((state) => state.busy)
  const [name, setName] = useState(existing?.name ?? '')
  const [category, setCategory] = useState<CruxStatusCategory>('todo')
  const [organization, setOrganization] = useState(false)
  const [allStatuses, setAllStatuses] = useState(!existing?.statusIds?.length)
  const statuses = snapshot.taskStatuses.filter((status) => status.spaceId === spaceId).sort((a, b) => a.order - b.order)
  const [statusIds, setStatusIds] = useState(existing?.statusIds ?? statuses.map((status) => status.id))
  const [error, setError] = useState<string | null>(null)
  const invalidStatuses = kind === 'types' && !allStatuses && statusIds.length === 0
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
    if (result?.ok) onClose()
    else if (result && !result.ok) setError(result.error)
    else setError('保存失败，请重试。')
  }
  return <Modal open onClose={() => { if (!busy) onClose() }} width={460} ariaLabel={`${existing ? '编辑' : '新建'}${TITLES[kind]}`}><fieldset disabled={busy} className="flex max-h-[var(--my-modal-max-height)] min-w-0 flex-col gap-4 p-4">
    <h2 className="text-my-md font-semibold text-my-primary">{existing ? '编辑' : '新建'}{TITLES[kind]}</h2>
    <div className="my-scrollbar min-h-0 overflow-y-auto" style={{ scrollbarGutter: 'stable' }}><div className="flex flex-col gap-3">
      <Field label="名称"><input className={inputClass} autoFocus value={name} onChange={(event) => setName(event.target.value)} /></Field>
      {kind === 'statuses' && <Field label="状态分类"><select className={inputClass} value={category} onChange={(event) => { const found = CATEGORIES.find(([value]) => value === event.target.value); if (found) setCategory(found[0]) }}>{CATEGORIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>}
      {kind === 'labels' && <Field label="范围"><select className={inputClass} value={organization ? 'organization' : 'space'} onChange={(event) => setOrganization(event.target.value === 'organization')}><option value="space">当前空间</option><option value="organization">组织内所有空间</option></select></Field>}
      {kind === 'types' && <fieldset><legend className="mb-2 text-my-xs font-medium text-my-tertiary">可用状态</legend><label className="flex items-center gap-2 text-my-sm text-my-secondary"><input type="checkbox" checked={allStatuses} onChange={(event) => setAllStatuses(event.target.checked)} />全部空间状态</label>{!allStatuses && <div className="mt-2 flex flex-col gap-2">{statuses.map((status) => <label key={status.id} className="flex items-center gap-2"><input type="checkbox" checked={statusIds.includes(status.id)} onChange={(event) => setStatusIds((previous) => event.target.checked ? [...previous, status.id] : previous.filter((id) => id !== status.id))} /><StatusBadge status={status} /></label>)}</div>}{invalidStatuses && <p role="alert" className="mt-2 text-my-xs text-my-danger-text">至少选择一个状态。</p>}</fieldset>}
      {error && <p role="alert" className="text-my-xs text-my-danger-text">{error}</p>}
    </div></div>
    <div className="flex justify-end gap-2"><Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" size="sm" aria-busy={busy} disabled={busy || !name.trim() || invalidStatuses} onClick={() => void save()}>{busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}{existing ? '保存' : '创建'}</Button></div>
  </fieldset></Modal>
}
