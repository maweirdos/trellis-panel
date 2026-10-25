/** 本地人员名册及空间成员关系；不发送外部邀请。 */
import { useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import type { HifoxMember, HifoxRole } from '@shared/hifox'
import { api } from '../../api'
import { confirmDialog } from '../../components/Dialogs'
import { Button, EmptyState, Modal } from '../../my/ui'
import { FlowIcon } from '../icons'
import { useHifox } from '../store'
import { PageHeader, Field, inputClass, MemberChip } from '../ui'

const ROLE_LABEL: Record<HifoxRole, string> = { owner: 'Owner', admin: '管理员', member: '成员' }

export function MembersPage(): JSX.Element | null {
  const snapshot = useHifox((state) => state.snapshot)
  const currentSpaceId = useHifox((state) => state.currentSpaceId)
  const run = useHifox((state) => state.run)
  const busy = useHifox((state) => state.busy)
  const workspace = useHifox((state) => state.workspaceContext)
  const shared = workspace.state !== 'local'
  const [editing, setEditing] = useState<HifoxMember | 'new' | null>(null)
  const [keyword, setKeyword] = useState('')
  const [onlySpace, setOnlySpace] = useState(false)
  if (!snapshot) return null
  const space = snapshot.spaces.find((item) => item.id === currentSpaceId)
  const spaceMemberIds = new Set(space?.memberIds ?? [])
  const owners = snapshot.members.filter((member) => member.role === 'owner').length
  const members = snapshot.members.filter((member) => (!onlySpace || spaceMemberIds.has(member.id)) &&
    `${member.name} ${member.email ?? ''} ${member.title ?? ''}`.toLowerCase().includes(keyword.toLowerCase()))

  const toggleSpaceMember = (id: string): void => {
    if (!space) return
    const next = spaceMemberIds.has(id) ? space.memberIds.filter((value) => value !== id) : [...space.memberIds, id]
    void run('更新空间成员', () => api.hifox.setSpaceMembers({ spaceId: space.id, memberIds: next }))
  }
  const remove = async (member: HifoxMember): Promise<void> => {
    if (!await confirmDialog({ title: `移除「${member.name}」？`, message: '将从同事名册和空间中移除，并解除任务处理人及小队成员关系。', confirmText: '移除', danger: true })) return
    await run('移除同事', () => api.hifox.removeMember({ id: member.id }))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <PageHeader title="同事" description={shared ? `已登录的团队成员 · ${snapshot.members.length} 人，当前空间 ${spaceMemberIds.size} 人` : `本机同事名册 · ${snapshot.members.length} 人，当前空间 ${spaceMemberIds.size} 人 · 添加不会发送邀请`}
        actions={shared ? <Button variant="outline" size="sm" disabled={!workspace.origin} onClick={() => { if (workspace.origin) void api.openExternal(`${workspace.origin}/#people`) }}>管理团队与邀请</Button> : <Button variant="primary" size="sm" disabled={busy} onClick={() => setEditing('new')}><Plus size={14} />添加同事</Button>} />
      <div className="flex flex-wrap items-center gap-3">
        <input className={`${inputClass} max-w-xs`} aria-label="搜索同事" placeholder="搜索姓名、邮箱或职位" value={keyword} onChange={(event) => setKeyword(event.target.value)} />
        <label className="flex items-center gap-2 text-my-xs text-my-secondary"><input type="checkbox" checked={onlySpace} onChange={(event) => setOnlySpace(event.target.checked)} />仅当前空间</label>
      </div>
      {members.length === 0 ? <EmptyState title="没有匹配的同事" description="调整搜索，或添加一位同事" /> : (
        <div className="my-scrollbar min-h-0 flex-1 overflow-auto rounded-my-md border border-my-line">
          <table className="w-full border-collapse text-left text-my-sm">
            <thead className="sticky top-0 bg-my-canvas text-my-xs text-my-tertiary"><tr className="border-b border-my-line">
              <th className="px-3 py-2 font-medium">同事</th><th className="px-2 py-2 font-medium">角色</th><th className="px-2 py-2 font-medium">职位</th>
              <th className="px-2 py-2 font-medium">空间</th><th className="px-3 py-2 font-medium">操作</th>
            </tr></thead>
            <tbody>{members.map((member) => {
              const lastOwner = member.role === 'owner' && owners === 1
              return <tr key={member.id} className="border-b border-my-line hover:bg-my-layer-1-hover">
                <td className="px-3 py-2"><MemberChip member={member} /><p className="mt-1 text-my-xs text-my-tertiary">{member.email || '未填写邮箱'}</p></td>
                <td className="px-2 py-2"><span className="flex items-center gap-1.5 text-my-xs text-my-secondary"><FlowIcon name="members" size={14} />{ROLE_LABEL[member.role]}</span></td>
                <td className="px-2 py-2 text-my-secondary">{member.title || '—'}</td>
                <td className="px-2 py-2">
                  <label className="flex items-center gap-1.5 text-my-xs text-my-secondary"><input type="checkbox" disabled={busy || !space || (shared && !workspace.canManage)} checked={spaceMemberIds.has(member.id)} onChange={() => toggleSpaceMember(member.id)} />{space?.name ?? '未选择空间'}</label>
                  <p className="mt-1 text-my-2xs text-my-tertiary">{snapshot.spaces.filter((item) => item.memberIds.includes(member.id)).map((item) => item.name).join('、') || '尚未加入空间'}</p>
                </td>
                <td className="px-3 py-2">{shared ? <span className="text-my-xs text-my-tertiary">账号与权限由团队服务管理</span> : <div className="flex items-center gap-1">
                  <Button variant="ghost" size="sm" disabled={busy} aria-label={`编辑 ${member.name}`} onClick={() => setEditing(member)}><Pencil size={13} />编辑</Button>
                  <Button variant="ghost" size="sm" disabled={busy || lastOwner} title={lastOwner ? '需保留至少一位 Owner' : '移除同事'} aria-label={`移除 ${member.name}`} onClick={() => void remove(member)}><Trash2 size={13} /></Button>
                </div>}</td>
              </tr>
            })}</tbody>
          </table>
        </div>
      )}
      {editing && <MemberEditor key={`${currentSpaceId}:${editing === 'new' ? 'new' : editing.id}`} member={editing === 'new' ? null : editing} spaceId={space?.id} spaceName={space?.name} onClose={() => setEditing(null)} />}
    </div>
  )
}

function MemberEditor({ member, spaceId, spaceName, onClose }: { member: HifoxMember | null; spaceId?: string; spaceName?: string; onClose: () => void }): JSX.Element {
  const run = useHifox((state) => state.run)
  const busy = useHifox((state) => state.busy)
  const snapshot = useHifox((state) => state.snapshot)
  const [name, setName] = useState(member?.name ?? '')
  const [email, setEmail] = useState(member?.email ?? '')
  const [title, setTitle] = useState(member?.title ?? '')
  const [role, setRole] = useState<HifoxRole>(member?.role ?? 'member')
  const [joinSpace, setJoinSpace] = useState(Boolean(spaceId))
  const lastOwner = member?.role === 'owner' && snapshot?.members.filter((item) => item.role === 'owner').length === 1
  const submit = async (): Promise<void> => {
    if (busy || !name.trim()) return
    const result = await run(member ? '更新成员资料' : '添加同事', () => member
      ? api.hifox.updateMember({ id: member.id, name: name.trim(), email: email.trim(), title: title.trim(), role })
      : api.hifox.inviteMember({ name: name.trim(), email: email.trim() || undefined, title: title.trim() || undefined, role, spaceId: joinSpace ? spaceId : undefined }))
    if (result?.ok) onClose()
  }
  return <Modal open onClose={() => { if (!busy) onClose() }} width={460} ariaLabel={member ? '编辑同事' : '添加同事'}>
    <div className="flex max-h-[var(--my-modal-max-height)] flex-col gap-3 p-4">
      <h2 className="text-sm font-semibold text-my-primary">{member ? `编辑 ${member.name}` : '添加同事'}</h2>
      <div className="my-scrollbar min-h-0 overflow-y-auto pr-1"><div className="flex flex-col gap-3">
      <Field label="姓名"><input className={inputClass} autoFocus value={name} onChange={(event) => setName(event.target.value)} /></Field>
      <Field label="邮箱（可选，仅作联系记录）"><input className={inputClass} type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></Field>
      <Field label="职位（可选）"><input className={inputClass} value={title} onChange={(event) => setTitle(event.target.value)} /></Field>
      <Field label="名册角色" hint={lastOwner ? '需保留至少一位 Owner；先为另一位成员设置 Owner 后才能调整。' : '组织角色不自动加入任何空间。'}>
        <select className={inputClass} disabled={lastOwner} value={role} onChange={(event) => setRole(event.target.value as HifoxRole)}>
          {(['owner', 'admin', 'member'] as const).map((value) => <option key={value} value={value}>{ROLE_LABEL[value]}</option>)}
        </select>
      </Field>
      {!member && spaceId && <label className="flex items-center gap-2 text-my-xs text-my-secondary"><input type="checkbox" checked={joinSpace} onChange={(event) => setJoinSpace(event.target.checked)} />同时加入「{spaceName}」</label>}
      </div></div>
      <div className="flex shrink-0 justify-end gap-2"><Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" size="sm" disabled={busy || !name.trim()} onClick={() => void submit()}>{busy ? '保存中…' : member ? '保存' : '添加'}</Button></div>
    </div>
  </Modal>
}
