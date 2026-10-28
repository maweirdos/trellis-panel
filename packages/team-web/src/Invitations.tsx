import { useState } from 'react'
import { teamInvitationSchema, teamInvitationTokenSchema, type TeamInvitation } from '../../../src/shared/team-invitations'
import { teamLocalUsernameSchema } from '../../../src/shared/team-auth'
import { teamIdSchema, teamMembershipRoleSchema, teamRoleSchema, teamProjectSchema, type TeamProject, type TeamSession } from './contracts'
import { request } from './client'
import { usePage, useQuery, useWrite } from './hooks'
import { ErrorLine, Modal, Notice, Pager, roleName, time } from './ui'

export function invitationFromLocation(): { invitationId: string; token: string } | null {
  const invitationId = new URLSearchParams(location.search).get('invitation')
  const token = new URLSearchParams(location.hash.slice(1)).get('token')
  const parsedId = teamIdSchema.safeParse(invitationId), parsedToken = teamInvitationTokenSchema.safeParse(token)
  return parsedId.success && parsedToken.success ? { invitationId: parsedId.data, token: parsedToken.data } : null
}
function randomInvitationToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return 'ti_' + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export function Invitations({ teamId, project, session }: { teamId: string; project: TeamProject | null; session: TeamSession }) {
  const invitations = usePage(`${session.person.userId}:${teamId}`, `/api/invitations?teamId=${encodeURIComponent(teamId)}`, teamInvitationSchema)
  const [creating, setCreating] = useState(false), [revoking, setRevoking] = useState<TeamInvitation | null>(null)
  return <section className="settings-section"><header><h2>邀请链接</h2><button type="button" onClick={() => setCreating(true)}>邀请加入团队和工作区</button></header><p>链接仅供指定账号使用。接受后才加入团队和工作区；管理员可随时撤销待接受的邀请。</p>
    {invitations.items.map((invitation) => <div className="member-row" key={invitation.invitationId}><div><strong>{invitation.projectName}</strong><small>{invitation.recipient.kind === 'person' ? invitation.recipient.userId : invitation.recipient.kind === 'local' ? `本地账号: ${invitation.recipient.username}` : `OIDC subject: ${invitation.recipient.subject}`} · {({ pending: '等待接受', accepted: '已接受', expired: '已过期', revoked: '已撤销' })[invitation.status]} · {time(invitation.expiresAt)}</small><small>{invitation.projectRoles.map(roleName).join(' · ')}</small></div>{invitation.status === 'pending' && <button type="button" onClick={() => setRevoking(invitation)}>撤销邀请</button>}</div>)}
    <Pager page={invitations} />
    {creating && <CreateInvitation key={teamId} teamId={teamId} project={project} onClose={() => { setCreating(false); invitations.refresh() }} onCreated={invitations.refresh} />}
    {revoking && <RevokeInvitation key={revoking.invitationId} invitation={revoking} onClose={() => setRevoking(null)} onDone={() => { setRevoking(null); invitations.refresh() }} />}
  </section>
}
function CreateInvitation({ teamId, project, onClose, onCreated }: { teamId: string; project: TeamProject | null; onClose: () => void; onCreated: () => void }) {
  const projects = usePage(`invitation-projects:${teamId}`, '/api/projects', teamProjectSchema)
  const [projectId, setProject] = useState(project?.teamId === teamId ? project.projectId : '')
  const [recipientKind, setKind] = useState<'local' | 'person' | 'oidc-subject'>('local'), [recipient, setRecipient] = useState('')
  const [teamRoles, setTeamRoles] = useState<string[]>(['member']), [projectRoles, setProjectRoles] = useState<string[]>(['developer'])
  const [days, setDays] = useState(1), [token] = useState(randomInvitationToken), [link, setLink] = useState('')
  const write = useWrite('/api/invitations', teamInvitationSchema, projectId || null, (result) => {
    const url = new URL('/', location.origin); url.searchParams.set('invitation', result.invitationId); url.hash = new URLSearchParams({ token }).toString()
    setLink(url.href); onCreated()
  })
  return <Modal title="创建邀请链接" onClose={onClose}>{link ? <><Notice>链接已创建。请复制并发给指定成员；关闭后不会再次显示密钥。</Notice><label>邀请链接<input aria-label="邀请链接" value={link} readOnly onFocus={(event) => event.currentTarget.select()} /></label><p>此页面不会发送邮件或消息。</p></> : <form onSubmit={(event) => { event.preventDefault(); void write.submit({ teamId, projectId, teamRoles, projectRoles, token, expiresInMs: days * 24 * 60 * 60_000, recipient: recipientKind === 'local' ? { kind: 'local', username: recipient } : recipientKind === 'person' ? { kind: 'person', userId: recipient } : { kind: 'oidc-subject', subject: recipient } }) }}>
    <fieldset disabled={write.busy || write.uncertain}><label>目标工作区<select aria-label="邀请工作区" required value={projectId} onChange={(event) => setProject(event.target.value)}><option value="" disabled>选择此团队的工作区</option>{projects.items.filter((item) => item.teamId === teamId).map((item) => <option key={item.projectId} value={item.projectId}>{item.name}</option>)}</select></label><Pager page={projects} />
    <label>指定账号<select aria-label="邀请账号类型" value={recipientKind} onChange={(event) => { setKind(event.target.value as 'local' | 'person' | 'oidc-subject'); setRecipient('') }}><option value="local">本地用户名（可先邀请后注册）</option><option value="oidc-subject">GitLab / 身份提供方 subject</option><option value="person">已有人员 ID</option></select></label>
    <label>{recipientKind === 'local' ? '本地用户名' : recipientKind === 'person' ? '人员 ID' : 'OIDC subject'}<input aria-label="邀请接收账号" value={recipient} maxLength={512} required onChange={(event) => setRecipient(event.target.value.trim())} /></label><p className="subtle">{recipientKind === 'local' ? '接收者需注册或登录此用户名，再明确接受邀请。用户名不区分大小写。' : '请核对接收者的人员 ID 或身份提供方签发的 subject；不要填写密码或访问令牌。'}</p>
    <RoleChoices label="团队权限" options={teamMembershipRoleSchema.options} selected={teamRoles} change={setTeamRoles} /><RoleChoices label="工作区职责" options={teamRoleSchema.options} selected={projectRoles} change={setProjectRoles} />
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
export function AcceptInvitation({ invitationId, token, session, onClose, onAccepted }: { invitationId: string; token: string; session: TeamSession; onClose: () => void; onAccepted: () => void }) {
  const query = useQuery(`invitation:${session.person.userId}:${invitationId}`, (signal) => request(`/api/invitations/${invitationId}/inspect`, teamInvitationSchema, { body: { token }, signal, notifyDenied: false }))
  const [accepted, setAccepted] = useState(false)
  const write = useWrite(`/api/invitations/${invitationId}/accept`, teamInvitationSchema, query.value?.projectId ?? null, () => { setAccepted(true); onAccepted(); query.refresh() })
  const invitation = query.value
  return <Modal title="接受团队邀请" onClose={onClose}><p>当前账号：{session.person.displayName} · {session.person.userId}</p><ErrorLine>{query.error}</ErrorLine>{query.error && <p>请确认使用邀请指定的账号登录，或联系管理员重新创建邀请。</p>}{query.loading && <p>正在核对邀请…</p>}{invitation && <><h3>{invitation.teamName} / {invitation.projectName}</h3><p>团队权限：{invitation.teamRoles.map(roleName).join(' · ')}</p><p>工作区职责：{invitation.projectRoles.map(roleName).join(' · ')}</p><p>有效期至 {time(invitation.expiresAt)}</p>{accepted || invitation.status === 'accepted' ? <Notice>邀请已接受。当前工作区权限以授权工作区列表为准。</Notice> : invitation.status !== 'pending' ? <Notice>邀请已{invitation.status === 'revoked' ? '撤销' : '过期'}。</Notice> : <><ErrorLine>{write.error}</ErrorLine><button type="button" className="primary" disabled={write.busy} onClick={() => { void write.submit({ token, expectedUserId: session.person.userId, expectedTeamId: invitation.teamId, expectedProjectId: invitation.projectId }) }}>{write.uncertain ? '以原操作标识重试' : '确认以当前账号加入'}</button></>}</>}</Modal>
}
