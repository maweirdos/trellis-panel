import { useRef, useState } from 'react'
import { teamInvitationSchema, teamInvitationTokenSchema, type TeamInvitation } from '../../../src/shared/team-invitations'
import { teamLocalUsernameSchema } from '../../../src/shared/team-auth'
import { cruxRemoteSnapshotSchema } from '../../../src/shared/crux-remote'
import { teamIdSchema, teamMembershipRoleSchema, teamRoleSchema, teamProjectSchema, type TeamProject, type TeamSession } from './contracts'
import { ApiError, isClientSession, request } from './client'
import { usePage, useQuery, useWrite } from './hooks'
import { ErrorLine, Modal, Notice, Pager, roleName, time } from './ui'

export type InvitationIntent = { invitationId: string; token: string }
const INVITATION_STORAGE = 'trellis-team-invitation-v1'
function parseInvitation(url: URL): InvitationIntent | null {
  const invitationId = url.searchParams.get('invitation')
  const token = new URLSearchParams(url.hash.slice(1)).get('token')
  const parsedId = teamIdSchema.safeParse(invitationId), parsedToken = teamInvitationTokenSchema.safeParse(token)
  return parsedId.success && parsedToken.success ? { invitationId: parsedId.data, token: parsedToken.data } : null
}
export function invitationFromLocation(): InvitationIntent | null {
  const url = new URL(location.href)
  if (url.searchParams.has('invitation')) return parseInvitation(url)
  try {
    const raw = sessionStorage.getItem(INVITATION_STORAGE)
    if (!raw) return null
    const stored: unknown = JSON.parse(raw)
    if (!stored || typeof stored !== 'object' || !('invitationId' in stored) || !('token' in stored)) return null
    const id = teamIdSchema.safeParse(stored.invitationId), token = teamInvitationTokenSchema.safeParse(stored.token)
    return id.success && token.success ? { invitationId: id.data, token: token.data } : null
  } catch { return null }
}
export function rememberInvitation(invitation: InvitationIntent | null): boolean {
  try {
    if (invitation) sessionStorage.setItem(INVITATION_STORAGE, JSON.stringify(invitation))
    else sessionStorage.removeItem(INVITATION_STORAGE)
    return true
  } catch { return false }
}
export function invitationReturnTo(): string {
  const url = new URL(location.href)
  url.searchParams.delete('invitation')
  const fragment = new URLSearchParams(url.hash.slice(1))
  if (fragment.has('token')) { fragment.delete('token'); url.hash = fragment.toString() }
  return url.pathname + url.search + url.hash
}
export function InvitationLinkForm({ onOpen }: { onOpen: (invitation: InvitationIntent) => void }) {
  const [link, setLink] = useState(''), [error, setError] = useState('')
  return <form className="team-invitation-form" onSubmit={(event) => {
    event.preventDefault()
    let invitation: InvitationIntent | null = null
    try { const url = new URL(link.trim(), location.origin); if (url.origin === location.origin) invitation = parseInvitation(url) } catch { /* Invalid links stay in the field for correction. */ }
    if (!invitation) { setError('邀请链接不完整或不属于此站点，请重新复制完整链接。'); return }
    onOpen(invitation); setLink(''); setError('')
  }}><label>邀请链接<input aria-label="要接受的邀请链接" value={link} autoComplete="off" spellCheck={false} maxLength={4096} required placeholder="粘贴完整邀请链接" onChange={(event) => { setLink(event.target.value); setError('') }} /></label><ErrorLine>{error}</ErrorLine><button type="submit" disabled={!link.trim()}>核对邀请</button></form>
}
function randomInvitationToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return 'ti_' + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export function Invitations({ teamId, project, session }: { teamId: string; project: TeamProject | null; session: TeamSession }) {
  const invitations = usePage(`${session.person.userId}:${teamId}`, `/api/invitations?teamId=${encodeURIComponent(teamId)}`, teamInvitationSchema)
  const [creating, setCreating] = useState(false), [revoking, setRevoking] = useState<TeamInvitation | null>(null)
  return <section className="settings-section"><header><h2>邀请链接</h2><button type="button" onClick={() => setCreating(true)}>邀请加入团队和工作区</button></header><p>邀请可为指定账号授予团队、工作区及一个可管理空间的成员权限。管理员可撤销待接受的邀请。</p>
    {invitations.items.map((invitation) => <div className="member-row" key={invitation.invitationId}><div><strong>{invitation.teamName} / {invitation.projectName}{invitation.space ? ` / ${invitation.space.name}` : ''}</strong><small>{invitation.recipient.kind === 'person' ? `人员 ID: ${invitation.recipient.userId}` : invitation.recipient.kind === 'local' ? `本地账号: ${invitation.recipient.username}` : `OIDC subject: ${invitation.recipient.subject}`} · {({ pending: '等待接受', accepted: '已接受', expired: '已过期', revoked: '已撤销' })[invitation.status]} · {time(invitation.expiresAt)}</small><small>团队：{invitation.teamRoles.map(roleName).join(' · ')}；工作区：{invitation.projectRoles.map(roleName).join(' · ')}；空间：{invitation.space ? '成员' : '未指定'}</small></div>{invitation.status === 'pending' && <button type="button" onClick={() => setRevoking(invitation)}>撤销邀请</button>}</div>)}
    <Pager page={invitations} />
    {creating && <CreateInvitation key={teamId} teamId={teamId} project={project} session={session} onClose={() => { setCreating(false); invitations.refresh() }} onCreated={invitations.refresh} />}
    {revoking && <RevokeInvitation key={revoking.invitationId} invitation={revoking} onClose={() => setRevoking(null)} onDone={() => { setRevoking(null); invitations.refresh() }} />}
  </section>
}
function CreateInvitation({ teamId, project, onClose, onCreated, session }: { teamId: string; project: TeamProject | null; onClose: () => void; onCreated: () => void; session: TeamSession }) {
  const projects = usePage(`invitation-projects:${teamId}`, '/api/projects', teamProjectSchema)
  const [projectId, setProject] = useState(project?.teamId === teamId ? project.projectId : ''), [spaceId, setSpace] = useState('')
  const spaces = useQuery(`invitation-spaces:${session.person.userId}:${projectId}`, async (signal) => {
    try { return await request(`/api/projects/${projectId}/crux/snapshot`, cruxRemoteSnapshotSchema, { signal, notifyDenied: false }) }
    catch (error) { if (error instanceof ApiError && error.status === 403) throw new Error('当前账号无法读取此工作区的空间。'); throw error }
  }, Boolean(projectId))
  const manageableSpaces = spaces.value?.snapshot.spaces.filter((space) => !space.archived && (space.visibility !== 'private' || space.memberIds.includes(session.person.userId)) && (spaces.value?.actor.role !== 'member' || space.ownerId === session.person.userId && space.memberIds.includes(session.person.userId))) ?? []
  const [recipientKind, setKind] = useState<'local' | 'person' | 'oidc-subject'>('local'), [recipient, setRecipient] = useState('')
  const [teamRoles, setTeamRoles] = useState<string[]>(['member']), [projectRoles, setProjectRoles] = useState<string[]>(['developer'])
  const [days, setDays] = useState(1), [token] = useState(randomInvitationToken), [link, setLink] = useState('')
  const write = useWrite('/api/invitations', teamInvitationSchema, projectId || null, (result) => {
    const url = new URL('/', location.origin); url.searchParams.set('invitation', result.invitationId); url.hash = new URLSearchParams({ token }).toString()
    setLink(url.href); onCreated()
  })
  return <Modal title="创建邀请链接" onClose={onClose}>{link ? <><Notice>链接已创建。请复制并发给指定成员；关闭后不会再次显示密钥。</Notice><label>邀请链接<input aria-label="邀请链接" value={link} readOnly onFocus={(event) => event.currentTarget.select()} /></label><p>此页面不会发送邮件或消息。</p></> : <form onSubmit={(event) => { event.preventDefault(); if (!isClientSession(session) || spaceId && !write.uncertain && !manageableSpaces.some((space) => space.id === spaceId)) return; void write.submit({ teamId, projectId, ...(spaceId ? { spaceId } : {}), teamRoles, projectRoles, token, expiresInMs: days * 24 * 60 * 60_000, recipient: recipientKind === 'local' ? { kind: 'local', username: recipient } : recipientKind === 'person' ? { kind: 'person', userId: recipient } : { kind: 'oidc-subject', subject: recipient } }) }}>
    <fieldset disabled={write.busy || write.uncertain}><label>目标工作区<select aria-label="邀请工作区" required value={projectId} onChange={(event) => { setProject(event.target.value); setSpace('') }}><option value="" disabled>选择此团队的工作区</option>{projects.items.filter((item) => item.teamId === teamId).map((item) => <option key={item.projectId} value={item.projectId}>{item.name}</option>)}</select></label><Pager page={projects} />
    <label>协作空间（选填）<select aria-label="邀请空间" value={spaceId} disabled={!projectId || spaces.loading || Boolean(spaces.error)} onChange={(event) => setSpace(event.target.value)}><option value="">不指定空间</option>{manageableSpaces.map((space) => <option key={space.id} value={space.id}>{space.name}</option>)}</select></label>{spaces.loading && <p role="status">正在核对可管理空间…</p>}<ErrorLine>{spaces.error}</ErrorLine>{spaces.error && <button type="button" onClick={spaces.refresh}>重新读取空间</button>}
    <label>指定账号<select aria-label="邀请账号类型" value={recipientKind} onChange={(event) => { setKind(event.target.value as 'local' | 'person' | 'oidc-subject'); setRecipient('') }}><option value="local">本地用户名（可先邀请后注册）</option><option value="oidc-subject">GitLab / 身份提供方 subject</option><option value="person">已有人员 ID</option></select></label>
    <label>{recipientKind === 'local' ? '本地用户名' : recipientKind === 'person' ? '人员 ID' : 'OIDC subject'}<input aria-label="邀请接收账号" value={recipient} maxLength={512} required onChange={(event) => setRecipient(event.target.value.trim())} /></label><p className="subtle">{recipientKind === 'local' ? '接收者需注册或登录此用户名，再明确接受邀请。用户名不区分大小写。' : '请核对接收者的人员 ID 或身份提供方签发的 subject；不要填写密码或访问令牌。'}</p>
    <RoleChoices label="团队权限" options={teamMembershipRoleSchema.options} selected={teamRoles} change={setTeamRoles} /><RoleChoices label="工作区职责" options={teamRoleSchema.options} selected={projectRoles} change={setProjectRoles} /><p className="subtle">接受时这些职责会加入已有职责。{spaceId ? '将同时加入所选空间；空间失效或授权撤销后需要重新邀请。' : '未指定空间时不授予空间成员权限。'}</p>
    <label>有效期<select value={days} onChange={(event) => setDays(Number(event.target.value))}><option value={1}>1 天</option><option value={3}>3 天</option><option value={7}>7 天</option></select></label></fieldset>
    <ErrorLine>{write.error}</ErrorLine>{write.uncertain && <Notice>创建结果尚未确认。保留此窗口，以原内容重试后才能取得原邀请链接。</Notice>}<button type="submit" className="primary" disabled={write.busy || !projects.items.some((item) => item.projectId === projectId && item.teamId === teamId) || !recipient || !teamRoles.length || !projectRoles.length || recipientKind === 'person' && !teamIdSchema.safeParse(recipient).success || recipientKind === 'local' && !teamLocalUsernameSchema.safeParse(recipient).success}>{write.uncertain ? '以原操作标识重试' : '创建邀请链接'}</button>
  </form>}</Modal>
}
function RoleChoices({ label, options, selected, change }: { label: string; options: readonly string[]; selected: string[]; change: (roles: string[]) => void }) {
  return <fieldset><legend>{label}</legend><div className="role-choices">{options.map((role) => <label key={role}><input type="checkbox" checked={selected.includes(role)} onChange={(event) => change(event.target.checked ? [...selected, role] : selected.filter((value) => value !== role))} />{roleName(role)}</label>)}</div></fieldset>
}
function RevokeInvitation({ invitation, onClose, onDone }: { invitation: TeamInvitation; onClose: () => void; onDone: () => void }) {
  const write = useWrite(`/api/invitations/${invitation.invitationId}/revoke`, teamInvitationSchema, invitation.projectId, onDone)
  return <Modal title="撤销邀请" onClose={onClose}><p>撤销后，原链接不能再加入 {invitation.projectName}。</p><ErrorLine>{write.error}</ErrorLine><button type="button" className="danger" disabled={write.busy} onClick={() => { void write.submit({}) }}>{write.uncertain ? '以原操作标识重试' : '确认撤销邀请'}</button></Modal>
}
export function AcceptInvitation({ invitationId, token, session, onClose, onAccepted, onSwitchAccount }: { invitationId: string; token: string; session: TeamSession; onClose: () => void; onAccepted: (invitation: TeamInvitation) => void; onSwitchAccount?: () => Promise<void> }) {
  const [switching, setSwitching] = useState(false), [switchError, setSwitchError] = useState('')
  const owner = useRef({ csrf: session.csrfToken, token, generation: 0 })
  if (owner.current.csrf !== session.csrfToken || owner.current.token !== token) owner.current = { csrf: session.csrfToken, token, generation: owner.current.generation + 1 }
  const query = useQuery(`invitation:${session.person.userId}:${invitationId}:${owner.current.generation}`, async (signal) => {
    try { return await request(`/api/invitations/${invitationId}/inspect`, teamInvitationSchema, { body: { token }, signal, notifyDenied: false }) }
    catch (error) { if (error instanceof ApiError && error.status === 403) throw new Error('邀请不可用于当前账号，请核对账号或联系管理员。'); throw error }
  })
  const write = useWrite(`/api/invitations/${invitationId}/accept`, teamInvitationSchema, query.value?.projectId ?? null, (result) => { if (isClientSession(session) && result.acceptedBy === session.person.userId) onAccepted(result) })
  const invitation = query.error || query.loading ? null : query.value
  return <Modal title="接受团队邀请" onClose={onClose}><p>当前账号：{session.person.displayName} · {session.person.userId}</p>{onSwitchAccount && <button type="button" disabled={switching || write.busy || write.uncertain} onClick={() => { if (!rememberInvitation({ invitationId, token })) { setSwitchError('无法保留邀请，请允许标签页存储后重试。'); return }; setSwitching(true); setSwitchError(''); void onSwitchAccount().catch((reason) => { setSwitchError(reason instanceof Error ? reason.message : '切换账号失败'); setSwitching(false) }) }}>{switching ? '正在切换账号…' : '使用其他账号'}</button>}<ErrorLine>{switchError}</ErrorLine><ErrorLine>{query.error}</ErrorLine>{query.error && <><p>请确认使用邀请指定的账号登录，或联系管理员重新创建邀请。</p><button type="button" onClick={query.refresh}>重新核对邀请</button></>}{query.loading && <p role="status">正在核对邀请…</p>}{invitation && <><h3>{invitation.teamName} / {invitation.projectName}</h3><p>指定接收者：{invitation.recipient.kind === 'person' ? `人员 ID ${invitation.recipient.userId}` : invitation.recipient.kind === 'local' ? `本地用户名 ${invitation.recipient.username}` : `身份提供方 subject ${invitation.recipient.subject}`}</p><p>团队新增权限：{invitation.teamRoles.map(roleName).join(' · ')}</p><p>工作区新增职责：{invitation.projectRoles.map(roleName).join(' · ')}</p><p>{invitation.space ? `空间成员：${invitation.space.name}（${invitation.space.id}）` : '此邀请不授予空间成员权限；加入工作区后可浏览并加入公开空间。'}</p><p>已有职责保留。{invitation.space && '空间失效或授权撤销后需联系管理员重新邀请。'}</p><p>有效期至 {time(invitation.expiresAt)}</p>{invitation.status === 'accepted' ? <><Notice>邀请此前已接受。当前工作区权限将在进入时重新核对。</Notice><button type="button" className="primary" onClick={() => { if (isClientSession(session)) onAccepted(invitation) }}>核对并进入工作区</button></> : invitation.status !== 'pending' ? <Notice>邀请已{invitation.status === 'revoked' ? '撤销' : '过期'}。请联系管理员重新邀请。</Notice> : <><ErrorLine>{write.error}</ErrorLine><button type="button" className="primary" disabled={switching || write.busy || query.loading} onClick={() => { if (isClientSession(session)) void write.submit({ token, expectedUserId: session.person.userId, expectedTeamId: invitation.teamId, expectedProjectId: invitation.projectId, ...(invitation.space ? { expectedSpaceId: invitation.space.id } : {}) }) }}>{write.busy ? '正在加入…' : write.uncertain ? '以原操作标识重试' : '确认以当前账号加入'}</button></>}</>}</Modal>
}
