import { useEffect, useRef, useState, type JSX } from 'react'
import { ArrowUpRight, Check, Copy, FilePlus2, Globe2, Link2, Loader2, RefreshCw, ShieldCheck, Unplug, X } from 'lucide-react'
import type { DesktopTeamConnection, DesktopTeamConnectionContext } from '../../../shared/team-desktop'
import { api } from '../api'
import { Button, Modal } from '../my/ui'
import { ConnectionPanel } from '../crux/ConnectionPanel'
import { Select } from '../components/Select'
import { InteractionScope, useInteractionActive } from '../utils/interaction-scope'
import { DEFAULT_TEAM_ORIGIN } from '../team-service-origin'
import { connectionLabel, denied, errorText, roleLabel, timeLabel, valueOf } from './model'
import { useTeamOwner } from './use-team-owner'
import { Documents } from './Documents'
import { Outbox } from './Outbox'
import { PublicationDialog } from './PublicationDialog'
import './team.css'

export function TeamCollaborationEntry({ root }: { root: string }): JSX.Element | null {
  const interactive = useInteractionActive(), [opened, setOpened] = useState<{ root: string; view: 'sharing' | 'account' } | null>(null)
  const owner = useTeamOwner(root)
  useEffect(() => setOpened(null), [owner.lifetime])
  if (typeof api?.teamDesktop?.connections !== 'function') return null
  const visible = opened?.root === root && interactive
  return <>
    <Button variant="outline" onClick={() => setOpened({ root, view: 'sharing' })}><Globe2 size={14} />团队共享</Button>
    <TeamWorkspaceDialog root={root} open={visible && opened?.view === 'sharing'} onAccount={() => setOpened({ root, view: 'account' })} onClose={() => setOpened(null)} />
    <ConnectionPanel hideTrigger initialStep="auth" open={visible && opened?.view === 'account'} onOpenChange={(open) => { if (!open) setOpened({ root, view: 'sharing' }) }} />
  </>
}

function TeamWorkspaceDialog({ root, open, onAccount, onClose }: { root: string; open: boolean; onAccount: () => void; onClose: () => void }): JSX.Element {
  const owner = useTeamOwner(JSON.stringify([root, open])), [connections, setConnections] = useState<DesktopTeamConnection[]>([]), [selected, setSelected] = useState(''), [connecting, setConnecting] = useState(false)
  const [origin, setOrigin] = useState(DEFAULT_TEAM_ORIGIN), [deviceName, setDeviceName] = useState('我的桌面工作台'), [busy, setBusy] = useState(''), [error, setError] = useState('')
  const lock = useRef<symbol | null>(null), ticket = useRef(0)
  const refresh = async (): Promise<void> => {
    const captured = owner.capture(), request = ++ticket.current
    try {
      const values = valueOf(await api.teamDesktop.connections())
      if (!owner.valid(captured) || request !== ticket.current) return
      setConnections(values); setSelected((old) => values.some((item) => item.connectionId === old) ? old : values.find((item) => item.state === 'active' && !item.accessLocked)?.connectionId ?? values[0]?.connectionId ?? ''); setConnecting((old) => values.length ? old : true)
    } catch (cause) { if (owner.valid(captured) && request === ticket.current) setError(errorText(cause)) }
  }
  useEffect(() => { if (open) void refresh() }, [open, root])
  useEffect(() => {
    if (!open) return
    return api.teamDesktop.onChanged(() => { void refresh() })
  }, [open, root, owner.lifetime])
  useEffect(() => { lock.current = null; setBusy(''); if (!open) ticket.current++ }, [owner.lifetime])
  useEffect(() => { setConnections([]); setSelected(''); setError(''); setConnecting(false) }, [root])
  const begin = async (): Promise<void> => {
    if (lock.current || !origin.trim() || !deviceName.trim()) return
    const captured = owner.capture(), token = Symbol('pair')
    lock.current = token; setBusy('pair'); setError('')
    try {
      const value = valueOf(await api.teamDesktop.beginPairing({ origin: origin.trim(), deviceName: deviceName.trim(), capabilityClaims: [] }))
      if (!owner.valid(captured)) return
      setConnections((old) => [...old.filter((item) => item.connectionId !== value.connection.connectionId), value.connection]); setSelected(value.connection.connectionId); setConnecting(false)
      if (value.browser === 'unavailable') setError('配对已保存在本机，但浏览器没有打开。请使用下方“打开确认页面”继续。')
    } catch (cause) { if (owner.valid(captured)) { setError(`${errorText(cause)} 可刷新连接列表核对是否已保存，避免重复创建配对。`); void refresh() } }
    finally { if (lock.current === token) { lock.current = null; if (owner.valid(captured)) setBusy('') } }
  }
  const connection = connections.find((item) => item.connectionId === selected)
  return <Modal open={open} onClose={onClose} ariaLabel="团队共享工作台" width={1200}>
    <section className="team-workspace"><header className="team-dialog-header"><div><span className="team-eyebrow">协作资料</span><h2>团队共享</h2></div><div className="team-inline-actions"><Button size="sm" variant="ghost" onClick={() => { void refresh() }}><RefreshCw size={14} />刷新连接</Button><button type="button" className="my-icon-control" aria-label="关闭团队共享" onClick={onClose}><X size={18} /></button></div></header>
      <div className="team-connection-bar"><label className="team-field team-connection-picker">团队连接<Select ariaLabel="当前团队连接" value={selected} onChange={(val) => { ticket.current++; setSelected(val); setConnecting(false); setError('') }} options={[{ value: '', label: '选择连接' }, ...connections.map((item) => ({ value: item.connectionId, label: `${item.deviceName} · ${connectionLabel(item)}` }))]} /></label><Button size="sm" variant="outline" onClick={() => setConnecting(!connecting)}><Link2 size={14} />{connecting ? '返回已连接工作区' : '连接团队服务'}</Button></div>
      {error && <p role="alert" className="team-notice team-band">{error}</p>}
      {connecting ? <div className="team-setup my-scrollbar">
        <div className="team-setup-heading"><Globe2 size={30} /><h3>连接团队工作区</h3></div>
        <Button variant="primary" disabled={Boolean(busy)} onClick={onAccount}>在应用内登录 / 注册</Button>
        <details className="team-provenance">
          <summary>使用浏览器配对</summary>
          <label className="team-field">团队服务地址<input className="my-input" value={origin} disabled={Boolean(busy)} onChange={(event) => setOrigin(event.target.value)} placeholder="https://team.example.com" inputMode="url" spellCheck={false} /></label>
          <label className="team-field">这台设备的名称<input className="my-input" aria-label="本机设备名称" value={deviceName} maxLength={150} disabled={Boolean(busy)} onChange={(event) => setDeviceName(event.target.value)} /></label>
          <Button variant="outline" disabled={Boolean(busy) || !origin.trim() || !deviceName.trim()} onClick={() => { void begin() }}>{busy ? <Loader2 size={14} className="animate-spin" /> : <ArrowUpRight size={14} />}保存配对并打开浏览器</Button>
        </details>
      </div> : connection ? <ConnectionWorkspace key={JSON.stringify([root, connection.connectionId, connection.ownerId, connection.projectId, connection.state, connection.accessLocked])} root={root} connection={connection} onUpdated={() => { void refresh() }} /> : <div className="team-empty"><Globe2 size={30} /><h3>选择一个团队连接</h3><p>发布的文档可供授权成员阅读，本机原始会话不会默认共享。</p></div>}
    </section>
  </Modal>
}

function ConnectionWorkspace({ root, connection: c, onUpdated }: { root: string; connection: DesktopTeamConnection; onUpdated: () => void }): JSX.Element {
  const owner = useTeamOwner(JSON.stringify([root, c.connectionId, c.ownerId, c.projectId, c.state, c.accessLocked]))
  const [context, setContext] = useState<DesktopTeamConnectionContext | null>(null), [view, setView] = useState<'documents' | 'outbox'>('documents'), [publication, setPublication] = useState(false)
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [locked, setLocked] = useState(false), [confirmDisconnect, setConfirmDisconnect] = useState(false), [copied, setCopied] = useState(false)
  const lock = useRef<symbol | null>(null), contextTicket = useRef(0)
  const active = c.state === 'active' && !c.accessLocked && !locked
  const loadContext = async (): Promise<void> => {
    const captured = owner.capture(), request = ++contextTicket.current
    try {
      const value = valueOf(await api.teamDesktop.connectionContext(c.connectionId))
      if (!owner.valid(captured) || request !== contextTicket.current) return
      if (value.person.userId !== c.ownerId || value.project.projectId !== c.projectId) throw Error('接收方身份与原连接不一致。')
      setContext(value); setError('')
    } catch (cause) { if (owner.valid(captured) && request === contextTicket.current) { setError(errorText(cause)); if (denied(cause)) { setLocked(true); setContext(null) } } }
  }
  useEffect(() => { if (active) void loadContext() }, [c.connectionId, active, c.network])
  const action = async (name: string, work: () => Promise<unknown>): Promise<void> => {
    if (lock.current) return
    const captured = owner.capture(), token = Symbol(name); lock.current = token; setBusy(name); setError('')
    try { await work(); if (owner.valid(captured)) { if (name === 'poll') setLocked(false); onUpdated() } }
    catch (cause) { if (owner.valid(captured)) { setError(errorText(cause)); if (denied(cause)) { setLocked(true); setContext(null) } } }
    finally { if (lock.current === token) { lock.current = null; if (owner.valid(captured)) setBusy('') } }
  }
  const accessLost = (message: string): void => { setLocked(true); setContext(null); setError(message); onUpdated() }
  return <><div className="team-identity"><div><div className="team-identity-title"><ShieldCheck size={17} /><strong>{context?.project.name ?? c.deviceName}</strong><span className="team-status">{connectionLabel(c)}</span></div><p>{context ? `${context.person.displayName} · ${context.project.roles.map(roleLabel).join(' / ')}${c.network === 'offline' ? ' · 人员与角色为上次核验，不证明当前权限' : ''}` : c.state === 'pending' ? '在浏览器确认账号、工作区和配对码后，才会取得工作区访问权限。' : '工作区名称与人员身份需要服务端实际核验。'}</p></div><details className="team-provenance"><summary>连接来源</summary><p>{c.origin}</p><p>最近核对 {timeLabel(c.lastCheckedAt)}</p><p>最近心跳 {timeLabel(c.remoteDevice?.lastSeenAt ?? null)}</p><p>能力声明来自设备，不代表执行授权。</p><code>{c.connectionId}</code><code>{c.projectId ?? '尚未绑定工作区'}</code></details></div>
    {(error || c.network === 'offline') && <p role="alert" className="team-notice team-band">{error || '团队服务暂时离线。已发布版本的本机缓存会明确标注；新操作仍保留原身份等待核对。'}</p>}
    {c.state === 'pending' && <div className="team-pairing my-scrollbar"><span className="team-eyebrow">核对这台设备</span><h3>在浏览器继续确认</h3><p>选择你有权限的工作区，并确认下面的配对码。等待确认不代表设备在线或已获授权。</p><div className="team-pairing-code"><code>{c.userCode ?? '配对码不可用'}</code><Button size="sm" variant="ghost" disabled={!c.userCode} onClick={() => { const captured = owner.capture(); void api.copyToClipboard(c.userCode ?? '').then(() => { if (owner.valid(captured)) setCopied(true) }).catch(() => { if (owner.valid(captured)) setError('无法复制配对码。') }) }}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? '已复制' : '复制'}</Button></div><p className="team-muted">服务端配对期限：{timeLabel(c.expiresAt)}</p><div className="team-inline-actions"><Button variant="primary" disabled={Boolean(busy)} onClick={() => { void action('browser', () => api.teamDesktop.openPairing(c.connectionId).then(valueOf)) }}><ArrowUpRight size={14} />打开确认页面</Button><Button variant="outline" disabled={Boolean(busy)} onClick={() => { void action('poll', () => api.teamDesktop.pollPairing(c.connectionId).then(valueOf)) }}>核对配对状态</Button></div></div>}
    {active && <><nav className="team-workspace-tabs" aria-label="团队共享内容"><div><button type="button" className="my-control" aria-pressed={view === 'documents'} onClick={() => setView('documents')}>共享文档</button><button type="button" className="my-control" aria-pressed={view === 'outbox'} onClick={() => setView('outbox')}>待处理与回执</button></div><Button size="sm" variant="primary" onClick={() => setPublication(true)}><FilePlus2 size={14} />发布文档</Button></nav><div className="team-pane-holder" hidden={view !== 'documents'}><InteractionScope active={view === 'documents'}><Documents root={root} connection={c} context={context} active={view === 'documents'} onAccessLost={accessLost} /></InteractionScope></div><div className="team-pane-holder" hidden={view !== 'outbox'}><InteractionScope active={view === 'outbox'}><Outbox root={root} connection={c} active={view === 'outbox'} onAccessLost={accessLost} /></InteractionScope></div></>}
    {!active && c.state !== 'pending' && <><div className="team-locked"><Unplug size={24} /><div><h3>{locked || c.accessLocked ? '原授权需要核对' : connectionLabel(c)}</h3><p>共享正文已锁定。新的配对不会接管旧操作；下面仍可检查本机原回执。</p></div><Button variant="outline" disabled={Boolean(busy)} onClick={() => { void action('poll', () => api.teamDesktop.pollPairing(c.connectionId).then(valueOf)) }}>核对原连接</Button></div><div className="team-pane-holder"><Outbox root={root} connection={locked ? { ...c, accessLocked: true } : c} active onAccessLost={accessLost} /></div></>}
    <footer className="team-workspace-footer"><span>原始 AI 会话不随文档默认共享</span>{confirmDisconnect ? <div className="team-inline-actions"><span>仅在本机断开，不撤销远端授权。</span><Button size="sm" variant="ghost" onClick={() => setConfirmDisconnect(false)}>返回</Button><Button size="sm" variant="danger" disabled={Boolean(busy)} onClick={() => { void action('disconnect', () => api.teamDesktop.disconnect(c.connectionId).then(valueOf)) }}>确认断开</Button></div> : <Button size="sm" variant="ghost" disabled={c.state === 'disconnected'} onClick={() => setConfirmDisconnect(true)}>断开本机连接</Button>}</footer>
    <PublicationDialog open={publication && active} onClose={() => setPublication(false)} expectedRoot={root} connectionId={c.connectionId} onQueued={() => { setView('outbox') }} />
  </>
}
