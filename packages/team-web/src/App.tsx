import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { BookOpen, Users, Monitor, LogOut, Sun, Moon, GitBranch, RefreshCw, LayoutDashboard } from 'lucide-react'
import { teamSessionSchema, teamProjectSchema, teamIdSchema, teamEventPageSchema, type TeamSession } from './contracts'
import { ApiError, authEvents, setClientSession, request, pendingCommands, commandEvents, reconcileCommand, retryCommand, canRetry, type PendingCommand } from './client'
import { usePage, useQuery } from './hooks'
import { Documents } from './Documents'
import { Devices, Pairing, People } from './People'
import { AcceptInvitation, invitationFromLocation } from './Invitations'
import { SignIn } from './SignIn'
import { HifoxWorkspace } from './HifoxWorkspace'
import './shell.css'
import { Empty, ErrorLine, Notice, Pager, time } from './ui'
import { ShellViewSwitcher } from '../../../src/renderer/src/my/layout/ShellViewSwitcher'
import { useMy } from '../../../src/renderer/src/my/store'

export function App() {
  const [invitation, setInvitation] = useState(invitationFromLocation)
  const [session, setSession] = useState<TeamSession | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState(''), [epoch, setEpoch] = useState(0), [theme, setTheme] = useState<'light' | 'dark'>(() => matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  const reload = useRef<() => Promise<void>>(async () => {})
  const identityEpoch = useRef(0)
  useEffect(() => {
    let live = true, active = false, again = false
    const load = async (): Promise<void> => {
      if (active) { again = true; return }; active = true
      const ticket = identityEpoch.current
      try { const next = await request('/api/session', teamSessionSchema, { notifyDenied: false }); if (next.authentication !== 'browser') throw Error('网页版需要浏览器登录'); if (live && ticket === identityEpoch.current) { setClientSession(next); setSession((old) => old?.person.userId === next.person.userId && old.person.revision === next.person.revision && old.csrfToken === next.csrfToken ? old : next); setError('') } }
      catch (reason) { if (live && ticket === identityEpoch.current) { if (reason instanceof ApiError && [401, 403].includes(reason.status)) { setClientSession(null); setSession(null) }; setError(reason instanceof Error ? reason.message : '登录状态读取失败') } }
      finally { active = false; if (live) { setLoading(false); if (again) { again = false; void load() } } }
    }
    reload.current = load; void load()
    const denied = (event: Event): void => { identityEpoch.current++; if ((event as CustomEvent<number>).detail === 401) { setClientSession(null); setSession(null) }; setEpoch((old) => old + 1); void load() }
    const visibility = (): void => { if (document.visibilityState === 'visible') void load() }
    authEvents.addEventListener('denied', denied); document.addEventListener('visibilitychange', visibility)
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void load() }, 30_000)
    return () => { live = false; authEvents.removeEventListener('denied', denied); document.removeEventListener('visibilitychange', visibility); clearInterval(timer) }
  }, [])
  useEffect(() => { document.documentElement.dataset.myTheme = theme; document.documentElement.classList.toggle('dark', theme === 'dark') }, [theme])
  const login = (): void => { const target = location.pathname + location.search + location.hash; location.assign('/auth/login?returnTo=' + encodeURIComponent(target)) }
  const closeInvitation = (): void => { setInvitation(null); const url = new URL(location.href); url.searchParams.delete('invitation'); const fragment = new URLSearchParams(url.hash.slice(1)); fragment.delete('token'); url.hash = fragment.toString(); history.replaceState(null, '', url.pathname + url.search + url.hash) }
  return <div className="team-app" data-my-theme={theme}>
    {loading ? <Empty title="正在核对登录状态…" /> : !session ? <main className="login"><div className="brand"><GitBranch size={22} /><strong>Trellis</strong><span>团队协作</span></div><div className="login-body"><span className="eyebrow">共同推进每一份需求</span><h1>一起规划工作区，<br />协作推进任务。</h1><p>创建独立账号即可加入协作；也可使用服务已配置的 GitLab 登录。</p><SignIn onOidcLogin={login} onSignedIn={(next, returnTo) => { identityEpoch.current++; setClientSession(next); setSession(next); setError(''); setEpoch((old) => old + 1); history.replaceState(null, '', returnTo) }} /><ErrorLine>{error}</ErrorLine></div><button type="button" className="theme-button" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}切换主题</button></main> : <SignedIn key={session.person.userId} session={session} theme={theme} epoch={epoch} refreshIdentity={() => { setEpoch((old) => old + 1); void reload.current() }} onLogout={() => { void request('/auth/logout', z.object({ loggedOut: z.literal(true) }).strict(), { body: {} }).then(() => { identityEpoch.current++; setClientSession(null); setSession(null); setEpoch((old) => old + 1) }).catch((reason) => setError(reason instanceof Error ? reason.message : '退出失败')) }} onTheme={() => setTheme(theme === 'light' ? 'dark' : 'light')} error={error} />}
    {session && invitation && <AcceptInvitation key={`${session.person.userId}:${invitation.invitationId}`} {...invitation} session={session} onClose={closeInvitation} onAccepted={() => { setEpoch((old) => old + 1); void reload.current() }} />}
  </div>
}
type WebTab = 'collaboration' | 'documents' | 'people' | 'devices'
const WEB_MODULES = [{ id: 'collaboration', label: '团队', Icon: LayoutDashboard }, { id: 'documents', label: '工作区资料', Icon: BookOpen }, { id: 'people', label: '团队与成员', Icon: Users }, { id: 'devices', label: '我的设备', Icon: Monitor }] as const
const locationTab = (): WebTab => { const hash = location.hash.slice(1); return hash === 'people' || hash === 'documents' || hash === 'devices' ? hash : 'collaboration' }
function SignedIn({ session, theme, epoch, refreshIdentity, onLogout, onTheme, error }: { session: TeamSession; theme: 'light' | 'dark'; epoch: number; refreshIdentity: () => void; onLogout: () => void; onTheme: () => void; error: string }) {
  const shellView = useMy((state) => state.shellView)
  const fontSize = useMy((state) => state.fontSize)
  const [tab, setTab] = useState<WebTab>(locationTab), [projectId, setProject] = useState('')
  useEffect(() => { const changed = (): void => setTab(locationTab()); addEventListener('hashchange', changed); return () => removeEventListener('hashchange', changed) }, [])
  const navigate = (next: WebTab): void => { setTab(next); const url = new URL(location.href); if (!url.searchParams.has('invitation')) { url.hash = next === 'collaboration' ? '' : next; history.replaceState(null, '', url.pathname + url.search + url.hash) } }
  const projects = usePage(`${session.person.userId}:${epoch}`, '/api/projects', teamProjectSchema)
  const project = projects.items.find((item) => item.projectId === projectId) ?? (!projectId ? projects.items[0] ?? null : null)
  const [pairing, setPairing] = useState<string | null>(() => { const id = new URLSearchParams(location.search).get('pairing'); return teamIdSchema.safeParse(id).success ? id : null })
  const eventKey = `${session.person.userId}:${project?.projectId}:${epoch}`, cursor = useRef<{ key: string; value: string | null }>({ key: '', value: null })
  const [gap, setGap] = useState(false), [change, setChange] = useState(false)
  const events = useQuery(eventKey, async (signal) => {
    if (cursor.current.key !== eventKey) cursor.current = { key: eventKey, value: null }
    const previous = cursor.current.value
    const page = await request('/api/events?limit=50' + (project ? '&projectId=' + project.projectId : '') + (previous ? '&cursor=' + encodeURIComponent(previous) : ''), teamEventPageSchema, { signal, notifyDenied: false })
    if (cursor.current.key === eventKey && !signal.aborted) { cursor.current.value = page.cursor; if (page.resetRequired) { setGap(true); cursor.current.value = null } else if (previous && page.items.length) setChange(true) }
    return page
  }, Boolean(project), 12_000)
  const closePairing = (): void => { setPairing(null); const url = new URL(location.href); url.searchParams.delete('pairing'); history.replaceState(null, '', url.pathname + url.search + url.hash) }
  return <><div className="team-shell">
    <aside className="team-module-rail" aria-label="模块栏">
      <div className="team-rail-brand" role="img" aria-label="Trellis 团队协作"><span className="team-brand-mark" /></div>
      <nav className="team-module-navigation" aria-label="团队导航">
        {WEB_MODULES.map(({ id, label, Icon }) => <button type="button" className="team-module-button" aria-label={label} title={label} aria-current={tab === id ? 'page' : undefined} key={id} onClick={() => navigate(id)}><Icon aria-hidden="true" /></button>)}
      </nav>
    </aside>
    <div className="team-shell-center">
      <header className="topbar team-topbar">
        <div className="my-root hifox-host team-view-control" data-my-theme={theme} data-my-font-size={fontSize}><ShellViewSwitcher host="web" /></div>
        <div className="team-project-control"><label><span className="team-sr-only">工作区</span><select aria-label="当前工作区" title={project?.name ?? '选择工作区'} value={project?.projectId ?? ''} onChange={(event) => { setProject(event.target.value); setGap(false); setChange(false) }}><option value="" disabled>选择工作区</option>{projects.items.map((item) => <option value={item.projectId} key={item.projectId}>{item.name}</option>)}</select></label><Pager page={projects} /></div>
        <span className="team-section-name">{WEB_MODULES.find((item) => item.id === tab)?.label}</span>
        <div className="account"><span title={session.person.displayName}>{session.person.displayName}</span><button className="icon" type="button" aria-label="切换主题" title={theme === 'light' ? '切换到深色主题' : '切换到浅色主题'} onClick={onTheme}>{theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}</button><button className="icon" type="button" aria-label="退出登录" title="退出登录" onClick={onLogout}><LogOut size={17} /></button></div>
      </header>
    <div className="app-layout team-shell-layout">
      <main className="workspace">{shellView === 'development' && <p role="status" className="team-development-notice">网页版可查看协作进度；本机工程、Git 与 Agent 执行请使用桌面端。</p>}<Pending accountId={session.person.userId} refresh={refreshIdentity} /><ErrorLine>{error}</ErrorLine>{events.error && <Notice>同步暂不可用。{events.at ? `上次核对 ${time(events.at)}` : '尚未完成同步核对'}。<button type="button" onClick={events.refresh}>重试</button></Notice>}{events.value?.hasMore && <Notice>还有协作记录待同步。<button type="button" onClick={events.refresh}>继续同步</button></Notice>}{(gap || change) && <Notice>{gap ? '同步游标已变化，请重新载入授权资料。' : '团队资料有更新，当前阅读版本保持不变。'}<button type="button" onClick={() => { setGap(false); setChange(false); refreshIdentity() }}>重新核对资料列表</button></Notice>}
        {tab === 'collaboration' || tab === 'documents' ? project ? tab === 'collaboration' ? <HifoxWorkspace key={`${session.person.userId}:${project.projectId}`} project={project} session={session} theme={theme} authEpoch={epoch} /> : <Documents key={`${project.projectId}:${epoch}`} project={project} session={session} authEpoch={epoch} /> : <Empty title={projects.loading ? '正在读取工作区…' : '还没有可用工作区'}>{projectId ? '原工作区当前不可用，请从顶部选择已授权工作区。' : '在“团队与成员”中创建团队与工作区，或接受管理员发给你的邀请链接。'}</Empty> : tab === 'people' ? <People key={epoch} session={session} project={project} epoch={epoch} onProjectsChanged={refreshIdentity} /> : <Devices key={epoch} accountId={session.person.userId} epoch={epoch} />}
      </main>
    </div>
    </div>
  </div>{pairing && <Pairing key={`${pairing}:${epoch}`} id={pairing} projects={projects.items} onClose={closePairing} />}
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
