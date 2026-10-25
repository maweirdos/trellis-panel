import { useEffect, useState } from 'react'
import { z } from 'zod'
import { Monitor, ShieldCheck, Users } from 'lucide-react'
import { parseTeamDevicePairing, teamDeviceApprovalSchema, teamDeviceSchema, teamMembershipSchema, teamTeamMembershipSchema, teamPersonSchema, teamTeamSchema, teamProjectSchema, teamRoleSchema, teamMembershipRoleSchema, teamIdSchema, type TeamSession, type TeamProject, type TeamDevicePairing } from './contracts'
import { request } from './client'
import { usePage, useQuery, useWrite } from './hooks'
import { Empty, ErrorLine, Modal, Notice, Pager, roleName, time } from './ui'
import { Invitations } from './Invitations'

export function Pairing({ id, projects, onClose }: { id: string; projects: TeamProject[]; onClose: () => void }) {
  const query = useQuery(id, async (signal) => parseTeamDevicePairing(await request(`/api/device-pairings/${id}`, z.unknown(), { signal, notifyDenied: false })))
  return <Modal title="连接你的桌面" onClose={onClose}><p>请核对正在操作的桌面名称，填写桌面显示的配对码。</p><ErrorLine>{query.error}</ErrorLine>{query.value ? <PairingForm key={id} pairing={query.value} projects={projects} refresh={query.refresh} /> : query.loading && <p>正在核对配对请求…</p>}</Modal>
}
function PairingForm({ pairing, projects, refresh }: { pairing: TeamDevicePairing; projects: TeamProject[]; refresh: () => void }) {
  const [projectId, setProject] = useState(pairing.projectId ?? projects[0]?.projectId ?? ''), [code, setCode] = useState(''), [approved, setApproved] = useState(false)
  const write = useWrite(`/api/device-pairings/${pairing.pairingId}/approve`, teamDeviceApprovalSchema, projectId || null, () => { setApproved(true); refresh() })
  const validProjects = pairing.projectId ? projects.filter((project) => project.projectId === pairing.projectId) : projects
  return <><div className="pairing-device"><Monitor size={25} /><div><h3>{pairing.deviceName}</h3><p>有效期至 {time(pairing.expiresAt)}</p></div></div>
    {approved || pairing.status === 'active' ? <Notice>配对批准已记录。请回到桌面继续；是否在线以桌面实际心跳为准。</Notice> : pairing.status !== 'pending' || pairing.expiresAt <= Date.now() ? <Notice>这次配对已{pairing.status === 'revoked' ? '撤销' : '失效'}，请从桌面重新发起。</Notice> : <form onSubmit={(event) => { event.preventDefault(); void write.submit({ userCode: code, expectedProjectId: projectId }) }}>
      <fieldset disabled={write.busy || write.uncertain}><label>连接到项目<select aria-label="配对项目" value={projectId} onChange={(event) => setProject(event.target.value)}><option value="" disabled>选择一个已授权项目</option>{validProjects.map((project) => <option value={project.projectId} key={project.projectId}>{project.name}</option>)}</select></label><label>桌面上的配对码<input aria-label="桌面配对码" autoComplete="off" spellCheck={false} value={code} maxLength={10} pattern="[A-Z2-9]{10}" onChange={(event) => setCode(event.target.value.toUpperCase().replace(/\s/g, ''))} required /></label></fieldset>
      {!validProjects.length && <Notice>{pairing.projectId ? '此连接已绑定指定项目。请先获得该项目的成员权限，再回到桌面重新打开待配对连接。' : '首次使用请关闭此窗口，打开左侧模块栏中的“团队与成员”，创建团队并在团队内创建项目，或接受管理员邀请。完成后回到桌面重新打开待配对连接；已有项目可先加载更多项目。'}若配对已过期，请从桌面重新发起。</Notice>}<ErrorLine>{write.error}</ErrorLine>{write.uncertain && <Notice>批准结果尚未确认，请在顶部核对原操作。</Notice>}<button className="primary" type="submit" disabled={write.busy || !validProjects.some((project) => project.projectId === projectId) || !/^[A-Z2-9]{10}$/.test(code)}><ShieldCheck size={15} />{write.uncertain ? '以原操作标识重试' : '批准连接这个项目'}</button>
    </form>}<details><summary>设备声明的能力</summary><p>{pairing.capabilityClaims.join('、') || '未声明'}</p><p>声明不授予机器执行或账号权限。</p></details></>
}
export function Devices({ accountId, epoch }: { accountId: string; epoch: number }) {
  const devices = usePage(`${accountId}:${epoch}`, '/api/devices', teamDeviceSchema)
  const [target, setTarget] = useState<string | null>(null)
  const [checkedAt, setCheckedAt] = useState<number | null>(null)
  useEffect(() => { if (!devices.loading && !devices.error) setCheckedAt(Date.now()) }, [devices.loading, devices.error])
  return <section className="content-page"><header className="section-heading"><div><div className="eyebrow">个人设置</div><h1>执行设备</h1><p>只显示你自己的设备及服务端最近观察到的心跳。</p></div><button type="button" disabled={devices.loading} onClick={devices.refresh}>刷新状态</button></header>
    <p className="subtle">状态核对于 {time(checkedAt)}；需要当前情况时请刷新。在线不代表模型或任务正在执行。</p><div className="device-list">{devices.items.map((device) => <article className="device-row" key={device.deviceId}><Monitor size={23} /><div><h3>{device.deviceName}</h3><p>{device.status === 'active' ? device.online ? '核对时近期在线' : '离线或尚未收到心跳' : ({ pending: '等待配对', expired: '配对过期', revoked: '已撤销' })[device.status]} · 最近心跳 {time(device.lastSeenAt)}</p><details><summary>设备来源</summary><p>设备 {device.deviceId}</p><p>项目 {device.projectId ?? '尚未绑定'}</p><p>声明能力：{device.capabilityClaims.join('、') || '未声明'}；这不是权限授予。</p></details></div>{device.status === 'active' && <button type="button" onClick={() => setTarget(device.deviceId)}>撤销连接</button>}</article>)}</div>
    {!devices.items.length && !devices.loading && !devices.error && <Empty title="还没有已连接设备">在桌面设置中发起配对，然后在这里管理连接。</Empty>}<Pager page={devices} />
    {target && <Revoke key={target} id={target} onClose={() => setTarget(null)} onDone={() => { setTarget(null); devices.refresh() }} />}
  </section>
}
function Revoke({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const write = useWrite(`/api/devices/${id}/revoke`, z.object({ deviceId: teamIdSchema, status: z.literal('revoked') }).strict(), null, onDone)
  return <Modal title="撤销设备连接" onClose={onClose}><p>撤销后，这个设备需要重新配对才能访问团队资料。既有发布记录会保留。</p><ErrorLine>{write.error}</ErrorLine><button type="button" className="danger" disabled={write.busy} onClick={() => { void write.submit({}) }}>{write.uncertain ? '以原操作标识重试' : '确认撤销'}</button></Modal>
}
const teamResult = teamTeamSchema.omit({ createdAt: true })
const projectResult = teamProjectSchema.omit({ roles: true, createdAt: true })
const teamMemberResult = teamTeamMembershipSchema.omit({ displayName: true }).extend({ teamId: teamIdSchema })
const projectMemberResult = teamMembershipSchema.omit({ displayName: true }).extend({ projectId: teamIdSchema })
export function People({ session, project, epoch, onProjectsChanged }: { session: TeamSession; project: TeamProject | null; epoch: number; onProjectsChanged: () => void }) {
  const [manageTeam, setTeam] = useState(''), [modal, setModal] = useState<'team' | 'project' | 'team-member' | 'project-member' | null>(null)
  const teams = usePage(`${session.person.userId}:${epoch}`, '/api/teams', teamTeamSchema)
  const team = manageTeam || project?.teamId || teams.items[0]?.teamId || ''
  const teamMembers = usePage(`${session.person.userId}:${team}:${epoch}`, `/api/teams/${team}/members`, teamTeamMembershipSchema, Boolean(team), false)
  const ownTeam = teamMembers.items.find((member) => member.userId === session.person.userId)
  const teamAdmin = session.person.isPlatformAdmin || Boolean(ownTeam?.active && ownTeam.roles.some((role) => role === 'owner' || role === 'admin'))
  const projectAdmin = Boolean(project && (session.person.isPlatformAdmin || project.roles.includes('admin') || teamAdmin && project.teamId === team))
  const members = usePage(`${session.person.userId}:${project?.projectId}:${epoch}`, `/api/projects/${project?.projectId}/members`, teamMembershipSchema, projectAdmin)
  const people = usePage(`${session.person.userId}:${epoch}`, '/api/people', teamPersonSchema, Boolean(session.person.isPlatformAdmin || teamAdmin || projectAdmin))
  const [editing, setEditing] = useState<{ userId: string; roles: string[]; active: boolean; revision: number } | null>(null)
  const [accountTarget, setAccount] = useState<z.infer<typeof teamPersonSchema> | null>(null)
  return <section className="content-page"><header className="section-heading"><div><div className="eyebrow">协作设置</div><h1>团队与成员</h1><p>同一成员可以兼任产品、项目经理、开发与测试。</p></div><button type="button" onClick={() => setModal('team')}>创建团队</button></header>
    <div className="membership-grid"><section className="settings-section"><header><h2><Users size={17} />团队</h2>{teamAdmin && <button type="button" disabled={!team} onClick={() => { setEditing(null); setModal('team-member') }}>添加成员</button>}</header><label>当前团队<select aria-label="管理团队" value={team} onChange={(event) => setTeam(event.target.value)}><option value="" disabled>选择团队</option>{teams.items.map((item) => <option key={item.teamId} value={item.teamId}>{item.name}</option>)}</select></label><Pager page={teams} />
      {teamMembers.items.map((member) => <div className="member-row" key={member.userId}><div><strong>{member.displayName}</strong><small>{member.roles.map(roleName).join(' · ')}{!member.active && ' · 已停用'}</small></div>{teamAdmin && <button type="button" onClick={() => { setEditing(member); setModal('team-member') }}>调整</button>}</div>)}<Pager page={teamMembers} />
      {teamAdmin && <button type="button" disabled={!team} onClick={() => setModal('project')}>在此团队创建项目</button>}
    </section><section className="settings-section"><header><h2>项目成员</h2>{projectAdmin && <button type="button" onClick={() => { setEditing(null); setModal('project-member') }}>添加成员</button>}</header><p>{project?.name ?? '尚未选择项目'}</p>
      {projectAdmin ? <>{members.items.map((member) => <div className="member-row" key={member.userId}><div><strong>{member.displayName}</strong><small>{member.roles.map(roleName).join(' · ')}{!member.active && ' · 已停用'}</small></div><button type="button" onClick={() => { setEditing(member); setModal('project-member') }}>调整</button></div>)}<Pager page={members} /></> : <p className="subtle">成员权限的调整需要该项目或团队的管理权限。</p>}
    </section></div>{team && teamAdmin && <Invitations key={team} teamId={team} project={project} session={session} />}<details className="identity-note"><summary>我的身份</summary><p>{session.person.displayName} · {session.person.userId}</p><p>登录方式：{session.person.provider === 'local' ? '独立账号' : session.person.provider === 'gitlab' ? 'GitLab' : '身份提供方'}</p><p>管理员可创建指定账号的邀请链接。新成员注册或登录后，核对团队、项目和职责，再明确接受邀请。</p></details>
    {modal === 'team' && <Create key="team" title="创建团队" label="团队名称" path="/api/teams" schema={teamResult} extra={{}} projectId={null} onClose={() => setModal(null)} onDone={() => { setModal(null); teams.refresh(); onProjectsChanged() }} />}
    {modal === 'project' && <Create key={'project:' + team} title="创建项目" label="项目名称" path="/api/projects" schema={projectResult} extra={{ teamId: team }} projectId={null} onClose={() => setModal(null)} onDone={() => { setModal(null); onProjectsChanged() }} />}
    {(modal === 'team-member' || modal === 'project-member' && project) && <MemberEditor key={modal + team + project?.projectId + editing?.userId} target={modal === 'team-member' ? 'team' : 'project'} id={modal === 'team-member' ? team : project?.projectId ?? ''} editing={editing} directory={people.items} more={people.more} next={people.next} onClose={() => setModal(null)} onDone={() => { setModal(null); teamMembers.refresh(); members.refresh(); onProjectsChanged() }} />}
    {session.person.isPlatformAdmin && <section className="settings-section account-directory"><header><h2>账号状态</h2><button type="button" onClick={people.refresh}>刷新人员</button></header>{people.items.map((person) => <div className="member-row" key={person.userId}><div><strong>{person.displayName}</strong><small>{person.active ? '已启用' : '已停用'} · {person.userId}</small></div><button type="button" onClick={() => setAccount(person)}>{person.active ? '停用账号' : '重新启用'}</button></div>)}<Pager page={people} /></section>}
    {accountTarget && <AccountStatus key={accountTarget.userId + accountTarget.revision} person={accountTarget} self={session.person.userId === accountTarget.userId} onClose={() => setAccount(null)} onDone={() => { setAccount(null); people.refresh(); onProjectsChanged() }} />}
    <ErrorLine>{people.error}</ErrorLine>
  </section>
}
function AccountStatus({ person, self, onClose, onDone }: { person: z.infer<typeof teamPersonSchema>; self: boolean; onClose: () => void; onDone: () => void }) {
  const write = useWrite(`/api/people/${person.userId}/status`, teamPersonSchema, null, onDone)
  return <Modal title={person.active ? '停用账号' : '重新启用账号'} onClose={onClose}><p>{person.displayName}</p><Notice>{person.active ? '停用将撤销此账号的现有登录和设备连接。既有发布记录保留。' : '重新启用后仍需重新登录和配对；旧设备凭据不会恢复。'}{self && person.active && '当前管理账号暂不能停用，请先完成管理身份交接。'}</Notice><ErrorLine>{write.error}</ErrorLine><button type="button" className={person.active ? 'danger' : 'primary'} disabled={write.busy || self && person.active} onClick={() => { void write.submit({ active: !person.active, expectedRevision: person.revision }) }}>{write.uncertain ? '以原操作标识重试' : '确认变更账号状态'}</button></Modal>
}
function Create<T>({ title, label, path, schema, extra, projectId, onClose, onDone }: { title: string; label: string; path: string; schema: z.ZodType<T>; extra: Record<string, unknown>; projectId: string | null; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(''), write = useWrite(path, schema, projectId, onDone)
  return <Modal title={title} onClose={onClose}><form onSubmit={(event) => { event.preventDefault(); void write.submit({ ...extra, name }) }}><label>{label}<input aria-label={label} value={name} required maxLength={200} disabled={write.busy || write.uncertain} onChange={(event) => setName(event.target.value)} /></label><ErrorLine>{write.error}</ErrorLine><button className="primary" type="submit" disabled={write.busy || !name.trim()}>{write.uncertain ? '以原操作标识重试' : '确认创建'}</button></form></Modal>
}
function MemberEditor({ target, id, editing, directory, more, next, onClose, onDone }: { target: 'team' | 'project'; id: string; editing: { userId: string; roles: string[]; active: boolean; revision: number } | null; directory: z.infer<typeof teamPersonSchema>[]; more: boolean; next: () => void; onClose: () => void; onDone: () => void }) {
  const [userId, setUser] = useState(editing?.userId ?? ''), [roles, setRoles] = useState(editing?.roles ?? [target === 'team' ? 'member' : 'developer']), [active, setActive] = useState(editing?.active ?? true)
  const write = useWrite<unknown>(`/api/${target === 'team' ? 'teams' : 'projects'}/${id}/members`, target === 'team' ? teamMemberResult : projectMemberResult, target === 'project' ? id : null, onDone)
  const options = target === 'team' ? teamMembershipRoleSchema.options : teamRoleSchema.options
  return <Modal title={editing ? '调整成员' : '添加成员'} onClose={onClose}><form onSubmit={(event) => { event.preventDefault(); void write.submit({ userId, roles, active, expectedRevision: editing?.revision ?? null }) }}><fieldset disabled={write.busy || write.uncertain}><label>人员 ID<input aria-label="人员 ID" list="people-directory" value={userId} readOnly={Boolean(editing)} onChange={(event) => setUser(event.target.value)} required /><datalist id="people-directory">{directory.map((person) => <option key={person.userId} value={person.userId}>{person.displayName}</option>)}</datalist></label>{more && <button type="button" onClick={next}>加载更多可管理人员</button>}<fieldset><legend>职责（可多选）</legend><div className="role-choices">{options.map((role) => <label key={role}><input type="checkbox" checked={roles.includes(role)} onChange={(event) => setRoles((old) => event.target.checked ? [...old, role] : old.filter((item) => item !== role))} />{roleName(role)}</label>)}</div></fieldset><label className="check-label"><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} />启用此成员</label></fieldset><ErrorLine>{write.error}</ErrorLine><button className="primary" type="submit" disabled={write.busy || !teamIdSchema.safeParse(userId).success || !roles.length}>{write.uncertain ? '以原操作标识重试' : '确认保存分工'}</button></form></Modal>
}
