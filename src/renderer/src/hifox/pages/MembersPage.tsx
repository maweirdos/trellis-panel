/**
 * 成员：组织成员列表 + 邀请 + 角色维护 + 空间成员配置（PRD 3.3）。
 */
import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { api } from '../../api'
import { useHifox } from '../store'
import { PageHeader, Field, inputClass, MemberChip } from '../ui'
import { Button } from '../../my/ui'
import type { HifoxRole } from '@shared/hifox'

const ROLE_LABEL: Record<HifoxRole, string> = { owner: 'Owner', admin: '管理员', member: '成员' }

export function MembersPage(): JSX.Element {
  const snapshot = useHifox((s) => s.snapshot)!
  const currentSpaceId = useHifox((s) => s.currentSpaceId)
  const run = useHifox((s) => s.run)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [title, setTitle] = useState('')
  const [role, setRole] = useState<HifoxRole>('member')

  const space = snapshot.spaces.find((s) => s.id === currentSpaceId)
  const spaceMemberIds = new Set(space?.memberIds ?? [])

  const invite = async (): Promise<void> => {
    const result = await run('邀请成员', () => api.hifox.inviteMember({
      name: name.trim(), email: email.trim() || undefined, title: title.trim() || undefined, role,
      spaceId: currentSpaceId ?? undefined
    }))
    if (result?.ok) { setName(''); setEmail(''); setTitle(''); setRole('member'); setInviteOpen(false) }
  }

  const toggleSpaceMember = (id: string) => {
    if (!space) return
    const next = spaceMemberIds.has(id) ? space.memberIds.filter((x) => x !== id) : [...space.memberIds, id]
    void run('更新空间成员', () => api.hifox.setSpaceMembers({ spaceId: space.id, memberIds: next }))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <PageHeader
        title="成员"
        description={`组织成员 ${snapshot.members.length} 人 · 当前空间 ${spaceMemberIds.size} 人`}
        actions={<Button variant="primary" size="sm" onClick={() => setInviteOpen(true)}><Plus size={14} />邀请成员</Button>}
      />
      <div className="my-scrollbar min-h-0 flex-1 overflow-y-auto rounded-my-md border border-my-line">
        <table className="w-full border-collapse text-left text-my-sm">
          <thead className="sticky top-0 bg-my-canvas">
            <tr className="border-b border-my-line text-my-xs text-my-tertiary">
              <th className="px-3 py-2 font-medium">成员</th>
              <th className="w-24 px-2 py-2 font-medium">角色</th>
              <th className="w-40 px-2 py-2 font-medium">职位</th>
              <th className="w-44 px-2 py-2 font-medium">所属空间</th>
              <th className="w-10 px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {snapshot.members.map((member) => (
              <tr key={member.id} className="border-b border-my-line/60 hover:bg-my-layer-transparent-hover">
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <MemberChip member={member} />
                    <span className="text-my-xs text-my-tertiary">{member.email}</span>
                  </div>
                </td>
                <td className="px-2 py-2">
                  <select
                    className={`${inputClass} w-20 px-1.5 py-1 text-my-xs`}
                    value={member.role}
                    onChange={(e) => void run('更新角色', () => api.hifox.updateMember({ id: member.id, role: e.target.value as HifoxRole }))}
                  >
                    {(['owner', 'admin', 'member'] as HifoxRole[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                  </select>
                </td>
                <td className="px-2 py-2">
                  <input
                    className={`${inputClass} px-1.5 py-1 text-my-xs`}
                    defaultValue={member.title ?? ''}
                    onBlur={(e) => { if (e.target.value.trim() !== (member.title ?? '')) void run('更新职位', () => api.hifox.updateMember({ id: member.id, title: e.target.value })) }}
                  />
                </td>
                <td className="px-2 py-2">
                  <label className="flex cursor-pointer items-center gap-1.5 text-my-xs text-my-secondary">
                    <input type="checkbox" checked={spaceMemberIds.has(member.id)} onChange={() => toggleSpaceMember(member.id)} />
                    {space?.name ?? '—'}
                  </label>
                </td>
                <td className="px-3 py-2">
                  <button type="button" aria-label={`移除 ${member.name}`} className="text-my-tertiary hover:text-red-400"
                    onClick={() => void run('移除成员', () => api.hifox.removeMember({ id: member.id }))}>
                    <Trash2 size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {inviteOpen && (
        <div className="fixed inset-0 z-30 grid place-items-center bg-black/40" role="dialog" aria-label="邀请成员">
          <div className="w-80 rounded-my-lg border border-my-line bg-my-canvas p-4">
            <h2 className="mb-3 text-sm font-semibold text-my-primary">邀请成员</h2>
            <div className="flex flex-col gap-2.5">
              <Field label="姓名"><input className={inputClass} autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
              <Field label="邮箱（可选）"><input className={inputClass} value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
              <Field label="职位（可选）"><input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
              <Field label="组织角色">
                <select className={inputClass} value={role} onChange={(e) => setRole(e.target.value as HifoxRole)}>
                  <option value="member">成员</option><option value="admin">管理员</option><option value="owner">Owner</option>
                </select>
              </Field>
              <p className="text-my-xs text-my-tertiary">将自动加入当前空间「{space?.name}」。</p>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setInviteOpen(false)}>取消</Button>
                <Button variant="primary" size="sm" disabled={!name.trim()} onClick={() => void invite()}>邀请</Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
