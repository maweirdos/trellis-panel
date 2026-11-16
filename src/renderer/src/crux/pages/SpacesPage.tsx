import { useState } from 'react'
import { Archive, Globe, Lock, LogIn, Loader2, Pencil, Plus, RotateCcw, Users } from 'lucide-react'
import type { CruxRole, CruxSnapshot, CruxSpace } from '@shared/crux'
import { api } from '../../api'
import { confirmDialog } from '../../components/Dialogs'
import { Button, EmptyState, Modal, SearchInput, Switch, Tooltip } from '../../my/ui'
import { useCrux, statusOf } from '../store'
import { Field, inputClass, MemberChip, PageHeader, textareaClass, Select } from '../ui'
import { SpaceCodeResources } from '../code-resources/SpaceCodeResources'
import { SpaceGovernancePanel } from '../governance/SpaceGovernancePanel'

const ROLE_LABEL: Record<CruxRole, string> = { owner: 'Owner', admin: '管理员', member: '成员' }

export function SpacesPage(): JSX.Element | null {
  const snapshot = useCrux((state) => state.snapshot)
  const spaceId = useCrux((state) => state.currentSpaceId)
  const setCurrentSpace = useCrux((state) => state.setCurrentSpace)
  const workspace = useCrux((state) => state.workspaceContext)
  const run = useCrux((state) => state.run)
  const busy = useCrux((state) => state.busy)
  const [keyword, setKeyword] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [editing, setEditing] = useState<CruxSpace | 'new' | null>(null)
  const [editingMembers, setEditingMembers] = useState<string | null>(null)
  if (!snapshot) return null

  const space = snapshot.spaces.find((item) => item.id === spaceId)
  const actorId = workspace.actorId ?? (workspace.state === 'local' ? snapshot.members.find((member) => member.role === 'owner')?.id : undefined)
  const isMember = Boolean(actorId && space?.memberIds.includes(actorId))
  const canRead = Boolean(space && (space.visibility !== 'private' || isMember))
  const canConfigure = workspace.canManage && Boolean(space && !space.archived)
  const spaces = snapshot.spaces.filter((item) => (showArchived || !item.archived || item.id === spaceId) && `${item.name} ${item.key}`.toLowerCase().includes(keyword.toLowerCase()))
  const members = snapshot.members.filter((member) => space?.memberIds.includes(member.id))
  const pendingCount = space ? snapshot.tasks.filter((task) => task.spaceId === space.id && !['done', 'cancelled'].includes(statusOf(snapshot, task.statusId)?.category ?? '')).length : 0
  const archive = async (): Promise<void> => {
    if (!space || busy || !workspace.canManage) return
    const targetId = space.id
    if (space.archived) { await run('恢复空间', () => api.crux.updateSpace({ id: targetId, archived: false })); return }
    if (canRead && pendingCount > 0) return
    const origin = workspace.key
    if (!await confirmDialog({ title: `归档「${space.name}」？`, message: '归档后空间只读，任务、成员与历史记录保留，可随时恢复。未完成任务必须先完成、取消或调整归属。', confirmText: '归档空间' })) return
    if (useCrux.getState().workspaceContext.key !== origin) return
    await run('归档空间', () => api.crux.updateSpace({ id: targetId, archived: true }))
  }

  return <div className="my-fade flex min-h-0 flex-1 flex-col gap-3">
    <PageHeader title="空间设置" actions={workspace.canManage && <Tooltip label="新建空间" side="bottom"><Button variant="primary" size="sm" className="my-icon-control" disabled={busy} aria-label="新建空间" onClick={() => setEditing('new')}><Plus size={16} /></Button></Tooltip>} />
    <div className="flex flex-wrap items-center gap-3"><SearchInput value={keyword} onChange={setKeyword} placeholder="搜索空间" /><label className="flex items-center gap-2 text-my-xs text-my-secondary"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />含已归档</label><span className="text-my-xs text-my-tertiary">{spaces.length} 个</span></div>
    <div className="my-scrollbar flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto" style={{ scrollbarGutter: 'stable' }}>
      <section className="rounded-my-md border border-my-line" aria-label="可见空间">
        {spaces.length === 0 ? <EmptyState title={keyword ? '没有匹配空间' : '暂无可见空间'} /> : <table className="w-full border-collapse text-left text-my-sm"><thead className="text-my-xs text-my-tertiary"><tr className="border-b border-my-line"><th className="px-3 py-2 font-medium">空间</th><th className="px-3 py-2 font-medium">访问权限</th><th className="px-3 py-2 font-medium">成员</th><th className="px-3 py-2 font-medium"><span className="sr-only">操作</span></th></tr></thead><tbody>{spaces.map((item) => {
          const joined = Boolean(actorId && item.memberIds.includes(actorId))
          const readable = item.visibility !== 'private' || joined
          return <tr key={item.id} className={`border-b border-my-line ${item.id === spaceId ? 'bg-my-navigation-selected' : 'hover:bg-my-layer-1-hover'}`}><td className="px-3 py-2"><button type="button" aria-pressed={item.id === spaceId} onClick={() => setCurrentSpace(item.id)} className="my-row flex w-full min-w-0 items-center gap-2 rounded-my-md text-left text-my-primary hover:bg-my-layer-transparent-hover"><span className="min-w-0 truncate">{item.name}</span><span className="font-mono text-my-xs text-my-tertiary">{item.key}</span>{item.archived && <span className="text-my-xs text-my-tertiary">已归档</span>}</button></td><td className="px-3 py-2"><span className="flex items-center gap-1.5 text-my-xs text-my-secondary">{item.visibility === 'private' ? <Lock size={13} /> : <Globe size={13} />}{item.visibility === 'private' ? '私有' : '组织内公开'}</span></td><td className="px-3 py-2 text-my-secondary">{readable ? item.memberIds.length : '—'}</td><td className="px-3 py-2"><div className="flex justify-end">{joined ? <span className="text-my-xs text-my-tertiary">已加入</span> : !item.archived && item.visibility !== 'private' && <Tooltip label={`加入 ${item.name}`}><Button size="sm" variant="ghost" className="my-icon-control" disabled={busy || !actorId} aria-label={`加入 ${item.name}`} onClick={() => void run('加入空间', () => api.crux.joinSpace({ spaceId: item.id }))}><LogIn size={15} /></Button></Tooltip>}</div></td></tr>
        })}</tbody></table>}
      </section>
      {space && <section className="flex flex-col gap-4 rounded-my-md border border-my-line p-4" aria-label="当前空间设置">
        <header className="flex flex-wrap items-center gap-2"><h2 className="min-w-0 flex-1 truncate text-my-md font-medium text-my-primary">{space.name}</h2><span className="font-mono text-my-xs text-my-tertiary">{space.key}</span>{workspace.canManage && <><Tooltip label="编辑空间"><Button variant="ghost" size="sm" className="my-icon-control" disabled={busy || !canConfigure} aria-label="编辑空间" onClick={() => setEditing(space)}><Pencil size={14} /></Button></Tooltip><Tooltip label={space.archived ? '恢复空间' : canRead && pendingCount > 0 ? `还有 ${pendingCount} 条未完成任务` : '归档空间'}><Button variant="ghost" size="sm" className="my-icon-control" disabled={busy || (!space.archived && canRead && pendingCount > 0)} aria-label={space.archived ? '恢复空间' : '归档空间'} onClick={() => void archive()}>{space.archived ? <RotateCcw size={14} /> : <Archive size={14} />}</Button></Tooltip></>}</header>
        {space.description && <p className="whitespace-pre-wrap text-my-sm text-my-secondary">{space.description}</p>}
        <div className="flex flex-wrap items-center gap-4 text-my-xs text-my-secondary"><span>{space.visibility === 'private' ? '私有' : '组织内公开'}</span><span>{space.archived ? '已归档 · 只读' : isMember ? '已加入' : '未加入'}</span>{canRead && <span>{pendingCount} 条未完成任务</span>}</div>
        {canRead && <div className="flex items-center justify-between gap-3 border-t border-my-line pt-3"><span className="text-my-sm text-my-secondary">允许多个处理人</span><Switch label="允许多个处理人" checked={space.multiAssignee} disabled={busy || !canConfigure} onChange={(multiAssignee) => void run('更新空间', () => api.crux.updateSpace({ id: space.id, multiAssignee }))} /></div>}
        {canRead ? <div className="border-t border-my-line pt-3"><div className="mb-2 flex items-center gap-2"><Users size={16} className="text-my-icon-secondary" /><h3 className="flex-1 text-my-sm font-medium text-my-primary">成员 <span className="text-my-xs font-normal text-my-tertiary">{members.length}</span></h3>{canConfigure && <Tooltip label="管理空间成员"><Button variant="ghost" size="sm" className="my-icon-control" disabled={busy} aria-label="管理空间成员" onClick={() => setEditingMembers(space.id)}><Pencil size={14} /></Button></Tooltip>}</div><ul className="divide-y divide-my-line">{members.map((member) => <li key={member.id} className="flex items-center gap-2 py-2"><MemberChip member={member} /><span className="ml-auto text-my-xs text-my-tertiary">{member.title || ROLE_LABEL[member.role]}</span></li>)}</ul>{members.length === 0 && <p className="py-2 text-my-xs text-my-tertiary">暂无成员</p>}</div> : <p className="text-my-xs text-my-tertiary">私有空间的内容与成员仅对空间成员开放。</p>}
      </section>}
      {space && (canRead || canConfigure) && <SpaceCodeResources spaceId={space.id} />}
      {space && isMember && actorId && workspace.state !== 'local' && Object.hasOwn(api, 'cruxGovernance') && api.cruxGovernance && <SpaceGovernancePanel key={`${workspace.key}:${actorId}:${space.id}`} api={api.cruxGovernance} workspaceKey={workspace.key} spaceId={space.id} actorId={actorId} people={members.map(member => ({ id: member.id, name: member.name }))} canManage={!space.archived && (workspace.canManage || space.ownerId === actorId)} />}
    </div>
    {editing && <SpaceEditor key={editing === 'new' ? 'new' : editing.id} space={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    {editingMembers && space?.id === editingMembers && canConfigure && <SpaceMembersEditor key={space.id} snapshot={snapshot} space={space} onClose={() => setEditingMembers(null)} />}
  </div>
}

export function SpaceEditor({ space, onClose }: { space?: CruxSpace; onClose: () => void }): JSX.Element {
  const run = useCrux((state) => state.run)
  const busy = useCrux((state) => state.busy)
  const setCurrentSpace = useCrux((state) => state.setCurrentSpace)
  const [name, setName] = useState(space?.name ?? '')
  const [key, setKey] = useState(space?.key ?? '')
  const [description, setDescription] = useState(space?.description ?? '')
  const [visibility, setVisibility] = useState<'public' | 'private'>(space?.visibility ?? 'public')
  const [error, setError] = useState<string | null>(null)
  const validKey = /^[A-Z0-9]{2,7}$/.test(key)
  const save = async (): Promise<void> => {
    if (busy || !name.trim() || (!space && !validKey)) return
    setError(null)
    const fields = { name: name.trim(), description: description.trim(), visibility }
    const result = await run(space ? '编辑空间' : '创建空间', () => space ? api.crux.updateSpace({ id: space.id, ...fields }) : api.crux.createSpace({ key, ...fields }))
    if (result?.ok) {
      if (!space) { const created = result.data.spaces.find((item) => item.key === key); if (created) setCurrentSpace(created.id) }
      onClose()
    } else if (result && !result.ok) setError(result.error)
    else setError('保存失败，请重试。')
  }
  return <Modal open onClose={() => { if (!busy) onClose() }} width={460} ariaLabel={space ? '编辑空间' : '新建空间'}><fieldset disabled={busy} className="flex max-h-[var(--my-modal-max-height)] min-w-0 flex-col gap-4 p-4"><h2 className="text-my-md font-semibold text-my-primary">{space ? '编辑空间' : '新建空间'}</h2><div className="my-scrollbar min-h-0 overflow-y-auto" style={{ scrollbarGutter: 'stable' }}><div className="flex flex-col gap-3">
    <Field label="空间名称"><input className={inputClass} autoFocus value={name} onChange={(event) => setName(event.target.value)} /></Field>
    {!space && <Field label="任务前缀" hint="2～7 个英文字母或数字"><input className={inputClass} maxLength={7} value={key} aria-invalid={key.length > 0 && !validKey} onChange={(event) => setKey(event.target.value.toUpperCase())} /></Field>}
    <Field label="描述（选填）"><textarea className={textareaClass} rows={3} value={description} onChange={(event) => setDescription(event.target.value)} /></Field>
    <Field label="访问权限" hint={visibility === 'public' ? '组织成员可发现并自行加入。' : '仅空间成员可查看内容，由管理员添加成员。'}>
      <Select
        className="w-full"
        value={visibility}
        onChange={(val) => setVisibility(val === 'private' ? 'private' : 'public')}
        options={[
          { value: 'public', label: '组织内公开' },
          { value: 'private', label: '私有' }
        ]}
      />
    </Field>
    {error && <p role="alert" className="text-my-xs text-my-danger-text">{error}</p>}
  </div></div><div className="flex justify-end gap-2"><Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" size="sm" disabled={busy || !name.trim() || (!space && !validKey)} onClick={() => void save()}>{busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}{space ? '保存' : '创建'}</Button></div></fieldset></Modal>
}

function SpaceMembersEditor({ snapshot, space, onClose }: { snapshot: CruxSnapshot; space: CruxSpace; onClose: () => void }): JSX.Element {
  const run = useCrux((state) => state.run)
  const busy = useCrux((state) => state.busy)
  const [memberIds, setMemberIds] = useState(space.memberIds)
  const [keyword, setKeyword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const members = snapshot.members.filter((member) => `${member.name} ${member.email ?? ''}`.toLowerCase().includes(keyword.toLowerCase()))
  const save = async (): Promise<void> => {
    if (busy) return
    setError(null)
    const result = await run('更新空间成员', () => api.crux.setSpaceMembers({ spaceId: space.id, memberIds }))
    if (result?.ok) onClose()
    else if (result && !result.ok) setError(result.error)
    else setError('保存失败，请重试。')
  }
  return <Modal open onClose={() => { if (!busy) onClose() }} width={460} ariaLabel="管理空间成员"><fieldset disabled={busy} className="flex max-h-[var(--my-modal-max-height)] min-w-0 flex-col gap-3 p-4"><h2 className="text-my-md font-semibold text-my-primary">管理空间成员</h2><SearchInput value={keyword} onChange={setKeyword} placeholder="搜索工作区成员" /><div className="my-scrollbar min-h-0 overflow-y-auto" style={{ scrollbarGutter: 'stable' }}><ul className="divide-y divide-my-line">{members.map((member) => <li key={member.id}><label className="flex items-center gap-2 py-2 text-my-sm text-my-secondary"><input type="checkbox" checked={member.id === space.ownerId || memberIds.includes(member.id)} disabled={member.id === space.ownerId} onChange={(event) => setMemberIds((previous) => event.target.checked ? [...previous, member.id] : previous.filter((id) => id !== member.id))} /><MemberChip member={member} /><span className="ml-auto text-my-xs text-my-tertiary">{member.id === space.ownerId ? '空间负责人' : member.title || ROLE_LABEL[member.role]}</span></label></li>)}</ul>{members.length === 0 && <EmptyState title="没有匹配成员" />}</div>{error && <p role="alert" className="text-my-xs text-my-danger-text">{error}</p>}<div className="flex justify-end gap-2"><Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" size="sm" disabled={busy} onClick={() => void save()}>{busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}保存</Button></div></fieldset></Modal>
}
