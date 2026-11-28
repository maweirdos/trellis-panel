import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { CheckCheck, ChevronRight, RefreshCw } from 'lucide-react'
import type { DesktopTeamConnection, DesktopTeamOutbox } from '../../../shared/team-desktop'
import { api } from '../api'
import { Button, DisclosureGrid } from '../my/ui'
import { clearIntent, denied, errorText, outboxLabel, readIntents, timeLabel, valueOf, type SavedIntent } from './model'
import { useTeamOwner } from './use-team-owner'

function TeamDisclosure({ label, className, children }: { label: string; className?: string; children: ReactNode }): JSX.Element {
  const [open, setOpen] = useState(false)
  return <div className={className}>
    <button type="button" className="flex cursor-pointer items-center gap-1.5 text-left text-my-xs text-my-secondary transition-colors hover:text-my-primary" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
      <ChevronRight size={12} className="my-disclosure-chevron shrink-0 text-my-tertiary" data-open={open || undefined} />
      <span>{label}</span>
    </button>
    <DisclosureGrid open={open}>{children}</DisclosureGrid>
  </div>
}

export function Outbox({ root, connection: c, active, onAccessLost }: { root: string; connection: DesktopTeamConnection; active: boolean; onAccessLost: (message: string) => void }): JSX.Element {
  const owner = useTeamOwner(JSON.stringify([root, c.connectionId, c.ownerId, c.projectId, c.state, c.accessLocked, active]))
  const [rows, setRows] = useState<DesktopTeamOutbox[]>([]), [cursor, setCursor] = useState<string | null>(null), [hasMore, setHasMore] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(''), [references, setReferences] = useState<SavedIntent[]>([])
  const ticket = useRef(0), locks = useRef(new Set<string>())
  const refs = (): void => { try { setReferences(readIntents().filter((item) => item.connectionId === c.connectionId)) } catch (cause) { setError(errorText(cause)) } }
  const refresh = async (after?: string): Promise<void> => {
    const captured = owner.capture(), request = ++ticket.current
    setBusy((old) => old || 'list')
    try {
      const value = valueOf(await api.teamDesktop.outbox(c.connectionId, { limit: 50, ...(after ? { cursor: after } : {}) }))
      if (!owner.valid(captured) || request !== ticket.current) return
      setRows((old) => after ? [...new Map([...old, ...value.items].map((row) => [row.commandId, row])).values()] : value.items); setCursor(value.nextCursor); setHasMore(value.hasMore); refs()
    } catch (cause) { if (owner.valid(captured) && request === ticket.current) setError(errorText(cause)) }
    finally { if (owner.valid(captured) && request === ticket.current) setBusy((old) => old === 'list' ? '' : old) }
  }
  useEffect(() => { if (active) { refs(); void refresh() } }, [active, c.connectionId])
  useEffect(() => {
    if (!active) return
    const off = api.teamDesktop.onChanged((event) => { if (event.connectionId === null || event.connectionId === c.connectionId) void refresh() })
    const storage = (): void => refs()
    window.addEventListener('storage', storage)
    return () => { off(); window.removeEventListener('storage', storage); ticket.current++ }
  }, [active, c.connectionId, owner.lifetime])
  const act = async (row: DesktopTeamOutbox, operation: 'cancel' | 'reconcile' | 'retry'): Promise<void> => {
    if (locks.current.has(row.commandId)) return
    const captured = owner.capture(); locks.current.add(row.commandId); setBusy(row.commandId); setError('')
    try {
      const reply = operation === 'cancel' ? await api.teamDesktop.cancelQueued(row.commandId) : operation === 'reconcile' ? await api.teamDesktop.reconcile(row.commandId) : await api.teamDesktop.dispatch(row.commandId, { retryUnknown: true })
      if (!owner.valid(captured)) return
      const result = valueOf(reply)
      if (result.commandId !== row.commandId || result.connectionId !== c.connectionId) throw Error('回执不属于原操作。')
      setRows((old) => old.map((item) => item.commandId === result.commandId ? result : item))
    } catch (cause) { if (owner.valid(captured)) { setError(errorText(cause)); if (denied(cause)) onAccessLost(errorText(cause)) } }
    finally { locks.current.delete(row.commandId); if (owner.valid(captured)) setBusy('') }
  }
  const inspectSaved = async (reference: SavedIntent): Promise<void> => {
    if (locks.current.has(reference.commandId)) return
    locks.current.add(reference.commandId); const captured = owner.capture(); setBusy(reference.commandId); setError('')
    try {
      let after: string | undefined, found: DesktopTeamOutbox | undefined
      for (let index = 0; index < 50; index++) {
        const page = valueOf(await api.teamDesktop.outbox(c.connectionId, { limit: 100, ...(after ? { cursor: after } : {}) }))
        if (!owner.valid(captured)) return
        found = page.items.find((item) => item.commandId === reference.commandId)
        if (found || !page.hasMore) break
        if (!page.nextCursor || page.nextCursor === after) throw Error('本地分页没有前进，未宣称已经查全。')
        after = page.nextCursor
        if (index === 49) throw Error('本地记录检查达到限界，仍需继续核对。')
      }
      if (!found) throw Error('当前读取点未找到本地回执，不证明原请求以后不会保存；标识继续保留。原文未存入浏览器，重载后不会重建并自动重发。')
      clearIntent(reference); refs(); setRows((old) => [...new Map([found, ...old].map((row) => [row.commandId, row])).values()])
    } catch (cause) { if (owner.valid(captured)) setError(errorText(cause)) }
    finally { locks.current.delete(reference.commandId); if (owner.valid(captured)) setBusy('') }
  }
  const remoteAllowed = c.state === 'active' && !c.accessLocked
  return <section className="team-outbox my-scrollbar" aria-label="待处理与回执"><header className="team-section-header"><div><h3>待处理与回执</h3><p>已存队列会在原授权可用时发送。不确定的原操作不会自动重试。</p></div><Button size="sm" variant="outline" disabled={busy === 'list'} onClick={() => { setError(''); void refresh() }}><RefreshCw size={14} />刷新记录</Button></header>
    {error && <p role="alert" className="team-notice">{error}</p>}
    {references.length > 0 && <section className="team-pending-references"><h4>页面请求尚待核对</h4><p>这里只保留操作标识，不保存正文或凭据。先查找本机保存结果。</p>{references.map((item) => <div className="team-outbox-row" key={item.commandId}><div><strong>{item.kind === 'feedback' ? '反馈保存请求' : '文档保存请求'}</strong><small className="team-outbox-time">{timeLabel(item.createdAt)}</small><TeamDisclosure label="原操作标识"><code className="mt-1 block">{item.commandId}</code></TeamDisclosure></div><Button size="sm" variant="outline" disabled={locks.current.has(item.commandId)} onClick={() => { void inspectSaved(item) }}>核对本地记录</Button></div>)}</section>}
    {rows.map((row) => <article className="team-outbox-row" key={row.commandId} data-command-id={row.commandId}><div className="team-outbox-description"><strong>{row.title ?? (row.kind === 'feedback' ? '固定版本反馈' : '文档发布')}</strong><span>{outboxLabel(row)}</span><small className="team-outbox-time">{timeLabel(row.updatedAt)}{row.version ? ` · v${row.version}` : ''}</small>{row.reconciliation === 'missing-at-read-point' && <p>上次核对未找到回执，不证明原请求以后不会提交。</p>}{row.lastErrorCode && <small>最近结果：{row.lastErrorCode}</small>}<TeamDisclosure label="操作来源"><code className="mt-1 block">{row.commandId}</code><code>{row.payloadDigest}</code><p>已尝试 {row.attempts} 次；身份始终属于原连接。</p></TeamDisclosure></div><div className="team-outbox-actions">{row.state === 'committed' && <CheckCheck size={17} aria-label="已有确定回执" />}{row.state === 'queued' && <Button size="sm" variant="ghost" disabled={locks.current.has(row.commandId)} onClick={() => { void act(row, 'cancel') }}>发送前取消</Button>}{(row.outcomeUnknown || row.state === 'acknowledgement-unknown' || row.state === 'dispatching') && <Button size="sm" variant="outline" disabled={!remoteAllowed || locks.current.has(row.commandId)} onClick={() => { void act(row, 'reconcile') }}>核对原操作</Button>}{row.state === 'acknowledgement-unknown' && row.reconciliation === 'missing-at-read-point' && <Button size="sm" variant="outline" disabled={!remoteAllowed || locks.current.has(row.commandId)} onClick={() => { void act(row, 'retry') }}>按原操作重试发送</Button>}</div></article>)}
    {!rows.length && !references.length && <div className="team-empty"><CheckCheck size={26} /><p>{busy === 'list' ? '正在读取本机记录…' : hasMore ? '本页暂无匹配记录，可继续读取后续页面。' : '当前连接没有已加载的待处理记录。'}</p></div>}
    {hasMore && <Button variant="ghost" size="sm" disabled={busy === 'list'} onClick={() => { if (cursor) void refresh(cursor) }}>读取更多记录</Button>}
  </section>
}
