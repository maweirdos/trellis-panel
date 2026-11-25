import { useEffect, useRef, useState, type ReactNode } from 'react'
import { z } from 'zod'
import { BookOpen, Users, Monitor, LogOut, Sun, Moon, RefreshCw, LayoutDashboard, Plus, Link as LinkIcon } from 'lucide-react'
import { teamSessionSchema, teamProjectSchema, teamIdSchema, teamEventPageSchema, type TeamSession } from './contracts'
import { ApiError, authEvents, setClientSession, publishSessionChange, listenForSessionChanges, request, pendingCommands, commandEvents, reconcileCommand, retryCommand, canRetry, type PendingCommand } from './client'
import { usePage, useQuery } from './hooks'
import { Documents } from './Documents'
import { Devices, Pairing, People } from './People'
import { AcceptInvitation, InvitationLinkForm, invitationFromLocation, invitationReturnTo, rememberInvitation, type InvitationIntent } from './Invitations'
import { WorkspaceOnboarding, WorkspaceSetup } from './WorkspaceSetup'
import { SpaceOnboarding } from './SpaceOnboarding'
import { SignIn } from './SignIn'
import { CruxWorkspace } from './CruxWorkspace'
import { workspaceProjectFromLocation } from './WorkspaceTaskLocation'
import './shell.css'
import { Empty, ErrorLine, Modal, Notice, Pager, time } from './ui'
import { dispatchEscKey } from '../../../src/renderer/src/utils/esc-layer'

export function App() {
  useEffect(() => {
    const onEsc = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat) return
      if (event.key === 'Escape' && dispatchEscKey()) event.preventDefault()
    }
    window.addEventListener('keydown', onEsc)
    return () => window.removeEventListener('keydown', onEsc)
  }, [])
  const [invitation, setInvitation] = useState(invitationFromLocation)
  useEffect(() => {
    rememberInvitation(invitation)
    // Strip the fragment before either login flow constructs its return URL.
    history.replaceState(null, '', invitationReturnTo())
  }, [invitation])
  const [session, setSession] = useState<TeamSession | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState(''), [epoch, setEpoch] = useState(0), [theme, setTheme] = useState<'light' | 'dark'>(() => matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  const [loggingOut, setLoggingOut] = useState(false)
  const logoutLock = useRef(false)
  const reload = useRef<() => Promise<void>>(async () => {})
  const identityEpoch = useRef(0)
  const hadSession = useRef(false)
  useEffect(() => {
    let live = true, active = false, again = false
    const load = async (): Promise<void> => {
      if (active) { again = true; return }; active = true
      const ticket = identityEpoch.current
      try { const next = await request('/api/session', teamSessionSchema, { notifyDenied: false }); if (next.authentication !== 'browser') throw Error('网页版需要浏览器登录'); if (live && ticket === identityEpoch.current) { hadSession.current = true; setClientSession(next); setSession((old) => old?.person.userId === next.person.userId && old.person.revision === next.person.revision && old.csrfToken === next.csrfToken ? old : next); setError(''); try { const key = 'trellis-team-last-account-v1'; if (sessionStorage.getItem(key) !== next.person.userId) { sessionStorage.setItem(key, next.person.userId); publishSessionChange() } } catch { /* Session proof still guards each scoped request. */ } } }
      catch (reason) {
        if (live && ticket === identityEpoch.current) {
          const unauthenticated = reason instanceof ApiError && reason.status === 401
          if (reason instanceof ApiError && [401, 403].includes(reason.status)) { setClientSession(null); setSession(null) }
          setError(unauthenticated ? hadSession.current ? '登录已过期或失效，请重新登录。' : '' : reason instanceof Error ? reason.message : '登录状态读取失败')
        }
      }
      finally { active = false; if (live) { if (again) { again = false; void load() } else setLoading(false) } }
    }
    reload.current = load; void load()
    const denied = (event: Event): void => { identityEpoch.current++; if ((event as CustomEvent<number>).detail === 401) { setClientSession(null); setSession(null) }; setEpoch((old) => old + 1); void load() }
    const changed = (): void => { identityEpoch.current++; setClientSession(null); setSession(null); setLoading(true); setEpoch((old) => old + 1); void load() }
    const visibility = (): void => { if (document.visibilityState === 'visible') void load() }
    authEvents.addEventListener('denied', denied); authEvents.addEventListener('external-session-changed', changed); document.addEventListener('visibilitychange', visibility)
    const stopSessionChanges = listenForSessionChanges(changed)
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void load() }, 30_000)
    return () => { live = false; stopSessionChanges(); authEvents.removeEventListener('denied', denied); authEvents.removeEventListener('external-session-changed', changed); document.removeEventListener('visibilitychange', visibility); clearInterval(timer) }
  }, [])
  useEffect(() => { document.documentElement.dataset.myTheme = theme; document.documentElement.classList.toggle('dark', theme === 'dark') }, [theme])
  const login = (): void => {
    if (invitation && !rememberInvitation(invitation)) { setError('浏览器无法保留邀请。请允许标签页存储后重试，或取消此邀请、登录后重新粘贴链接。'); return }
    location.assign('/auth/login?returnTo=' + encodeURIComponent(invitationReturnTo()))
  }
  const openInvitation = (next: InvitationIntent): void => { rememberInvitation(next); setInvitation(next); setError('') }
  const closeInvitation = (): void => { rememberInvitation(null); setInvitation(null); history.replaceState(null, '', invitationReturnTo()) }
  const logout = async (): Promise<void> => {
    if (logoutLock.current) throw new Error('正在退出，请稍候')
    logoutLock.current = true; setLoggingOut(true)
    try {
      await request('/auth/logout', z.object({ loggedOut: z.literal(true) }).strict(), { body: {} })
      identityEpoch.current++; hadSession.current = false; setClientSession(null); setSession(null); setError(''); setEpoch((old) => old + 1)
      try { sessionStorage.removeItem('trellis-team-last-account-v1') } catch { /* No credential is stored here. */ }
      publishSessionChange()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '退出失败'); throw reason }
    finally { logoutLock.current = false; setLoggingOut(false) }
  }
  return <div className="team-app" data-my-theme={theme}>
    {loading ? <Empty title="正在核对登录状态…" /> : !session ? <main className="login"><div className="team-login-brand" role="img" aria-label="Crux 团队协作"><span className="team-brand-mark" aria-hidden="true" /><span className="team-brand-wordmark" aria-hidden="true" /></div><div className="login-body"><span className="eyebrow">共同推进每一份需求</span><h1>一起规划工作区，<br />协作推进任务。</h1><p>使用个人账号加入组织；也可使用服务已配置的 GitLab 登录。</p>{teamIdSchema.safeParse(new URLSearchParams(location.search).get('pairing')).success && <Notice>已保留电脑连接请求。请登录要授权这台电脑的个人账号。</Notice>}{invitation ? <Notice>已保留团队邀请，登录或注册后即可核对并加入。<button type="button" onClick={closeInvitation}>取消邀请</button></Notice> : <details className="team-login-invitation"><summary>已有邀请链接</summary><InvitationLinkForm onOpen={openInvitation} /></details>}<SignIn onOidcLogin={login} onSignedIn={(next, returnTo) => { identityEpoch.current++; hadSession.current = true; setClientSession(next); setSession(next); setError(''); setEpoch((old) => old + 1); history.replaceState(null, '', returnTo); try { sessionStorage.setItem('trellis-team-last-account-v1', next.person.userId) } catch { /* Session proof remains authoritative. */ }; publishSessionChange() }} /><ErrorLine>{error}</ErrorLine></div><button type="button" className="theme-button" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}切换主题</button></main> : <SignedIn key={session.person.userId} session={session} theme={theme} epoch={epoch} invitation={invitation} onInvitation={openInvitation} onCloseInvitation={closeInvitation} refreshIdentity={() => { setEpoch((old) => old + 1); void reload.current() }} onLogout={() => { void logout().catch(() => {}) }} onSwitchAccount={logout} loggingOut={loggingOut} onTheme={() => setTheme(theme === 'light' ? 'dark' : 'light')} error={error} />}
  </div>
}
type WebTab = 'collaboration' | 'documents' | 'people' | 'devices'
const WEB_MODULES = [{ id: 'collaboration', label: '工作台', Icon: LayoutDashboard }, { id: 'documents', label: '资料', Icon: BookOpen }, { id: 'people', label: '成员与设置', Icon: Users }, { id: 'devices', label: '设备', Icon: Monitor }] as const
const locationTab = (): WebTab => { const hash = location.hash.slice(1); return hash === 'people' || hash === 'documents' || hash === 'devices' ? hash : 'collaboration' }
function SignedIn({ session, theme, epoch, invitation, onInvitation, onCloseInvitation, refreshIdentity, onLogout, onSwitchAccount, loggingOut, onTheme, error }: { session: TeamSession; theme: 'light' | 'dark'; epoch: number; invitation: InvitationIntent | null; onInvitation: (invitation: InvitationIntent) => void; onCloseInvitation: () => void; refreshIdentity: () => void; onLogout: () => void; onSwitchAccount: () => Promise<void>; loggingOut: boolean; onTheme: () => void; error: string }) {
  const [tab, setTab] = useState<WebTab>(locationTab), [projectId, setProject] = useState(workspaceProjectFromLocation)
  const [creatingOrganization, setCreatingOrganization] = useState(false), [creatingWorkspace, setCreatingWorkspace] = useState(false), [joiningWorkspace, setJoiningWorkspace] = useState(false)
  const [invitedSpace, setInvitedSpace] = useState<{ projectId: string; accountId: string; spaceId: string } | null>(null)
  const invitationOwner = useRef({ invitation, revision: 0 })
  if (invitationOwner.current.invitation !== invitation) invitationOwner.current = { invitation, revision: invitationOwner.current.revision + 1 }
  useEffect(() => { const changed = (): void => setTab(locationTab()); addEventListener('hashchange', changed); return () => removeEventListener('hashchange', changed) }, [])
  const navigate = (next: WebTab): void => { setTab(next); const url = new URL(location.href); url.hash = next === 'collaboration' ? '' : next; history.replaceState(null, '', url.pathname + url.search + url.hash) }
  const projects = usePage(`${session.person.userId}:${epoch}`, '/api/projects', teamProjectSchema)
  const project = projects.items.find((item) => item.projectId === projectId) ?? (!projectId ? projects.items[0] ?? null : null)
  useEffect(() => {
    if (project && !projectId) setProject(project.projectId)
    // A newly joined/created project may be beyond the first authorized page.
    if (projectId && !project && !projects.loading && !projects.error && projects.more) projects.next()
  }, [projectId, project, projects.loading, projects.error, projects.more, projects.next])
  const [pairing, setPairing] = useState<string | null>(() => { const id = new URLSearchParams(location.search).get('pairing'); return teamIdSchema.safeParse(id).success ? id : null })
  const eventKey = `${session.person.userId}:${project?.projectId}:${epoch}`, cursor = useRef<{ key: string; value: string | null }>({ key: '', value: null })
  const [gap, setGap] = useState(false), [change, setChange] = useState(false)
  const projectsChanged = (selectedProjectId?: string, selectedSpaceId?: string): void => {
    if (selectedProjectId) { setProject(selectedProjectId); navigate('collaboration'); setGap(false); setChange(false); if (selectedSpaceId) setInvitedSpace({ projectId: selectedProjectId, accountId: session.person.userId, spaceId: selectedSpaceId }) }
    refreshIdentity()
  }
  const events = useQuery(eventKey, async (signal) => {
    if (cursor.current.key !== eventKey) cursor.current = { key: eventKey, value: null }
    const previous = cursor.current.value
    const page = await request('/api/events?limit=50' + (project ? '&projectId=' + project.projectId : '') + (previous ? '&cursor=' + encodeURIComponent(previous) : ''), teamEventPageSchema, { signal, notifyDenied: false })
    if (cursor.current.key === eventKey && !signal.aborted) { cursor.current.value = page.cursor; if (page.resetRequired) { setGap(true); cursor.current.value = null } else if (previous && page.items.length) setChange(true) }
    return page
  }, Boolean(project), 12_000)
  const closePairing = (): void => { setPairing(null); const url = new URL(location.href); url.searchParams.delete('pairing'); history.replaceState(null, '', url.pathname + url.search + url.hash) }
  let content: ReactNode
  if (tab === 'people') content = <People key={epoch} session={session} project={project} epoch={epoch} onProjectsChanged={projectsChanged} />
  else if (tab === 'devices') content = <Devices key={epoch} accountId={session.person.userId} epoch={epoch} />
  else if (project) content = tab === 'collaboration' ? <><SpaceOnboarding projectId={project.projectId} accountId={session.person.userId} /><CruxWorkspace key={`${session.person.userId}:${project.projectId}`} project={project} session={session} theme={theme} authEpoch={epoch} invitedSpaceId={invitedSpace?.projectId === project.projectId && invitedSpace.accountId === session.person.userId ? invitedSpace.spaceId : undefined} onInvitedSpaceOpened={() => setInvitedSpace(null)} /></> : <Documents key={`${project.projectId}:${epoch}`} project={project} session={session} authEpoch={epoch} />
  else if (projects.loading || projectId && projects.more && !projects.error) content = <section className="team-workspace-state" role="status"><RefreshCw size={22} aria-hidden="true" /><h2>正在读取工作区…</h2></section>
  else if (projects.error) content = <section className="team-workspace-state"><h2>暂时无法读取工作区</h2><ErrorLine>{projects.error}</ErrorLine><button type="button" onClick={projects.refresh}>重新读取工作区</button></section>
  else if (projectId || projects.items.length) content = <section className="team-workspace-state"><h2>原工作区当前不可用</h2><p>请选择其他已授权工作区，或重新核对权限。</p><div className="team-workspace-actions">{projects.items[0] && <button type="button" className="primary" onClick={() => setProject(projects.items[0].projectId)}>进入 {projects.items[0].name}</button>}<button type="button" onClick={projects.refresh}>重新核对</button>{!projects.items.length && <button type="button" onClick={() => setProject('')}>创建或加入工作区</button>}</div></section>
  else content = <WorkspaceOnboarding onCreate={() => setCreatingOrganization(true)} onInvitation={onInvitation} />
  return <><div className="team-shell">
    <aside className="team-module-rail" aria-label="模块栏">
      <div className="team-rail-brand" role="img" aria-label="Crux 团队协作"><span className="team-brand-mark" aria-hidden="true" /></div>
      <nav className="team-module-navigation" aria-label="团队导航">
        {WEB_MODULES.map(({ id, label, Icon }) => <button type="button" className="team-module-button" aria-label={label} title={label} aria-current={tab === id ? 'page' : undefined} key={id} onClick={() => navigate(id)}><Icon aria-hidden="true" /><span>{label}</span></button>)}
      </nav>
    </aside>
    <div className="team-shell-center">
      <header className="topbar team-topbar">
        <div className="team-project-control"><label><span className="team-sr-only">工作区</span><select aria-label="当前工作区" title={project?.name ?? '选择工作区'} disabled={!projects.items.length} value={project?.projectId ?? ''} onChange={(event) => { setProject(event.target.value); setGap(false); setChange(false) }}><option value="" disabled>{projects.loading ? '正在读取工作区…' : projects.error ? '工作区读取失败' : projects.items.length ? '选择工作区' : '尚未加入工作区'}</option>{projects.items.map((item) => <option value={item.projectId} key={item.projectId}>{item.name}</option>)}</select></label><Pager page={projects} /></div>
        <span className="team-section-name">{WEB_MODULES.find((item) => item.id === tab)?.label}</span>
        <div className="team-workspace-actions"><button type="button" onClick={() => setCreatingWorkspace(true)}><Plus size={15} />创建工作区</button><button type="button" onClick={() => setJoiningWorkspace(true)}><LinkIcon size={15} />接受邀请</button></div>
        <div className="account"><span title={session.person.displayName}>{session.person.displayName}</span><button type="button" disabled={loggingOut} onClick={onLogout}>切换账号</button><button className="icon" type="button" aria-label="切换主题" title={theme === 'light' ? '切换到深色主题' : '切换到浅色主题'} onClick={onTheme}>{theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}</button><button className="icon" type="button" disabled={loggingOut} aria-label="退出登录" title="退出登录" onClick={onLogout}><LogOut size={17} /></button></div>
      </header>
    <div className="app-layout team-shell-layout">
      <main className="workspace"><Pending accountId={session.person.userId} refresh={refreshIdentity} /><ErrorLine>{error}</ErrorLine>{events.error && <Notice>同步暂不可用。{events.at ? `上次核对 ${time(events.at)}` : '尚未完成同步核对'}。<button type="button" onClick={events.refresh}>重试</button></Notice>}{events.value?.hasMore && <Notice>还有协作记录待同步。<button type="button" onClick={events.refresh}>继续同步</button></Notice>}{(gap || change) && <Notice>{gap ? '同步游标已变化，请重新载入授权资料。' : '团队资料有更新，当前阅读版本保持不变。'}<button type="button" onClick={() => { setGap(false); setChange(false); refreshIdentity() }}>重新核对资料列表</button></Notice>}
        {content}
      </main>
    </div>
    </div>
  </div>{pairing && <Pairing key={`${pairing}:${epoch}`} id={pairing} projects={projects.items} session={session} onSwitchAccount={onSwitchAccount} onClose={closePairing} />}
    {creatingOrganization && <WorkspaceSetup key="organization" session={session} epoch={epoch} initialMode="organization" onClose={() => { setCreatingOrganization(false); refreshIdentity() }} onCreated={(created, spaceId) => { setCreatingOrganization(false); projectsChanged(created.projectId, spaceId) }} />}
    {creatingWorkspace && <WorkspaceSetup session={session} epoch={epoch} initialTeamId={project?.teamId} onClose={() => { setCreatingWorkspace(false); refreshIdentity() }} onCreated={(created, spaceId) => { setCreatingWorkspace(false); projectsChanged(created.projectId, spaceId) }} />}
    {joiningWorkspace && <Modal title="接受工作区邀请" onClose={() => setJoiningWorkspace(false)}><InvitationLinkForm onOpen={(next) => { setJoiningWorkspace(false); onInvitation(next) }} /></Modal>}
    {invitation && <AcceptInvitation key={`${session.person.userId}:${invitation.invitationId}:${invitationOwner.current.revision}`} {...invitation} session={session} onSwitchAccount={onSwitchAccount} onClose={onCloseInvitation} onAccepted={(accepted) => { if (accepted.space) setInvitedSpace({ projectId: accepted.projectId, accountId: session.person.userId, spaceId: accepted.space.id }); onCloseInvitation(); projectsChanged(accepted.projectId) }} />}
  </>
}
function Pending({ accountId, refresh }: { accountId: string; refresh: () => void }) {
  const [version, setVersion] = useState(0), [message, setMessage] = useState(''), [busy, setBusy] = useState('')
  useEffect(() => { const update = (): void => setVersion((old) => old + 1); commandEvents.addEventListener('change', update); return () => commandEvents.removeEventListener('change', update) }, [])
  let records: PendingCommand[] = [], failure = ''
  try { records = pendingCommands(accountId).filter((entry) => !entry.path.endsWith('/progress/commands')) } catch (error) { failure = error instanceof Error ? error.message : '操作引用读取失败' }
  void version
  return records.length || failure ? <section className="pending-commands" aria-label="待核对操作"><h2>有 {records.length} 项操作需要核对</h2><p>仅保留操作引用与摘要，不保存正文或登录凭据。已提交的结果与当前状态分别核对。</p>{records.map((entry) => <div className="pending-row" key={entry.commandId}><details><summary>{entry.path.split('/')[2] === 'materials' ? '资料发布' : entry.path.split('/')[2] === 'feedback' ? '记录反馈' : '团队设置'} · {entry.state === 'unknown' ? '结果未确认' : '已保留操作引用'}</summary><code>{entry.commandId}</code><p>{time(entry.createdAt)}</p><p>原工作区 {entry.projectId ?? '账号范围'}</p></details><button type="button" disabled={Boolean(busy)} onClick={() => { setBusy(entry.commandId); void reconcileCommand(entry).then((state) => { setMessage(state === 'committed' ? '原操作已提交；请刷新目标内容核对当前状态。' : '此刻尚无已提交回执，不能据此认定原请求不会继续提交。'); if (state === 'committed') refresh() }).catch((error) => setMessage(error instanceof Error ? error.message : '核对失败')).finally(() => setBusy('')) }}><RefreshCw size={13} />核对原操作</button>{canRetry(entry) && <button type="button" disabled={Boolean(busy)} onClick={() => { setBusy(entry.commandId); void retryCommand(entry).then(() => { setMessage('原操作已取得回执，请核对目标内容。'); refresh() }).catch((error) => setMessage(error instanceof Error ? error.message : '重试失败')).finally(() => setBusy('')) }}>以原内容重试</button>}</div>)}<ErrorLine>{failure}</ErrorLine>{message && <Notice>{message}</Notice>}</section> : message ? <Notice>{message}</Notice> : null
}
