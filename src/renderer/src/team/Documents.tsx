import { useEffect, useRef, useState, type JSX } from 'react'
import { ArrowDownToLine, FileText, MessageSquare, RefreshCw } from 'lucide-react'
import type { DesktopTeamConnection, DesktopTeamConnectionContext, DesktopTeamDocument, DesktopTeamOutbox, DesktopTeamSnapshot } from '../../../shared/team-desktop'
import type { TeamFeedback, TeamMaterialVersion } from '../../../shared/team-platform'
import { api } from '../api'
import { Button } from '../my/ui'
import { clearIntent, denied, errorText, exactQuote, intentDigest, kindLabel, saveIntent, timeLabel, valueOf, verifyDocument, visibilityLabel, type SavedIntent, TeamUiError } from './model'
import { TeamMarkdown } from './TeamMarkdown'
import { useTeamOwner } from './use-team-owner'

type Props = { root: string; connection: DesktopTeamConnection; context: DesktopTeamConnectionContext | null; active: boolean; onAccessLost: (message: string) => void }
export function Documents({ root, connection: c, context, active, onAccessLost }: Props): JSX.Element {
  const owner = useTeamOwner(JSON.stringify([root, c.connectionId, c.ownerId, c.projectId, c.state, c.accessLocked, active]))
  const [items, setItems] = useState<TeamMaterialVersion[]>([]), [cursor, setCursor] = useState<string | null>(null), [hasMore, setHasMore] = useState(false), [cached, setCached] = useState<DesktopTeamSnapshot | null>(null), [receiptDirectory, setReceiptDirectory] = useState(false)
  const [document, setDocument] = useState<DesktopTeamDocument | null>(null), [versions, setVersions] = useState<TeamMaterialVersion[]>([]), [versionCursor, setVersionCursor] = useState<string | null>(null), [versionsMore, setVersionsMore] = useState(false)
  const [error, setError] = useState(''), [busy, setBusy] = useState(''), [updates, setUpdates] = useState(false), [raw, setRaw] = useState(false)
  const listTicket = useRef(0), documentTicket = useRef(0), versionTicket = useRef(0), currentDocument = useRef(document); currentDocument.current = document
  const reader = useRef<HTMLDivElement>(null), quoteRef = useRef<((text: string) => void) | null>(null)
  const validateDirectory = (values: TeamMaterialVersion[]): void => { if (values.some((item) => item.projectId !== c.projectId || (item.visibility === 'personal' && item.ownerId !== c.ownerId))) throw new TeamUiError('BINDING_CHANGED', '目录内容不属于原连接的项目或个人范围，未展示。') }
  const reject = (cause: unknown): void => { setError(errorText(cause)); if (denied(cause)) { setDocument(null); setItems([]); setVersions([]); setCached(null); onAccessLost(errorText(cause)) } }
  const loadCache = async (captured: symbol, request: number): Promise<void> => {
    const snapshot = valueOf(await api.teamDesktop.cachedSnapshot(c.connectionId))
    if (!owner.valid(captured) || request !== listTicket.current) return
    if (snapshot) { validateDirectory(snapshot.items); setItems(snapshot.items); setCached(snapshot); setReceiptDirectory(false); setHasMore(false); setCursor(null); return }
    const page = valueOf(await api.teamDesktop.outbox(c.connectionId, { limit: 100 }))
    if (!owner.valid(captured) || request !== listTicket.current) return
    const found = page.items.flatMap((row) => row.kind === 'publication' && row.state === 'committed' && row.receipt && 'bodyDigest' in row.receipt ? [row.receipt] : [])
    validateDirectory(found); setItems([...new Map(found.map((item) => [item.materialId, item])).values()]); setCached(null); setReceiptDirectory(true); setHasMore(false); setCursor(null)
    if (page.hasMore) setError('这是本页发布回执中的文档线索，目录不完整。可在待处理中继续读取回执；本机不一定缓存了正文。')
  }
  const loadList = async (after?: string, fromCache = false): Promise<void> => {
    const captured = owner.capture(), request = ++listTicket.current; setBusy('list'); setError('')
    try {
      if (fromCache) { await loadCache(captured, request); return }
      const page = valueOf(await api.teamDesktop.listMaterials({ connectionId: c.connectionId, ...(after ? { cursor: after } : {}), limit: 50 }))
      if (!owner.valid(captured) || request !== listTicket.current) return
      validateDirectory(page.items)
      setItems((old) => after ? [...new Map([...old, ...page.items].map((item) => [item.materialId, item])).values()] : page.items); setCursor(page.nextCursor); setHasMore(page.hasMore); setCached(null); setReceiptDirectory(false); setUpdates(false)
    } catch (cause) {
      if (!owner.valid(captured) || request !== listTicket.current) return
      if (denied(cause)) { reject(cause); return }
      setError(errorText(cause))
      if (cause instanceof TeamUiError && cause.code === 'NETWORK_UNAVAILABLE') {
        try { await loadCache(captured, request) } catch (cacheError) { if (owner.valid(captured) && request === listTicket.current) reject(cacheError) }
      }
    } finally { if (owner.valid(captured) && request === listTicket.current) setBusy((old) => old === 'list' ? '' : old) }
  }
  const syncDirectory = async (): Promise<void> => {
    const captured = owner.capture(), request = ++listTicket.current; setBusy('list'); setError('')
    try {
      const snapshot = valueOf(await api.teamDesktop.refreshSharedSnapshot(c.connectionId))
      if (!owner.valid(captured) || request !== listTicket.current) return
      validateDirectory(snapshot.items)
      setItems(snapshot.items); setCached(snapshot); setReceiptDirectory(false); setCursor(null); setHasMore(false); setUpdates(false)
    } catch (cause) { if (owner.valid(captured) && request === listTicket.current) reject(cause) }
    finally { if (owner.valid(captured) && request === listTicket.current) setBusy('') }
  }
  const seedDirectory = async (): Promise<void> => {
    const captured = owner.capture()
    try { valueOf(await api.teamDesktop.refreshSharedSnapshot(c.connectionId)) }
    catch (cause) { if (owner.valid(captured) && denied(cause)) reject(cause) }
  }
  useEffect(() => { if (active) { void loadList(); void seedDirectory() } }, [c.connectionId, active])
  useEffect(() => {
    if (!active) return
    return api.teamDesktop.onChanged((event) => { if (event.connectionId === null || event.connectionId === c.connectionId) setUpdates(true) })
  }, [active, c.connectionId])
  const loadVersions = async (materialId: string, after?: string): Promise<void> => {
    const captured = owner.capture(), request = ++versionTicket.current
    try {
      const page = valueOf(await api.teamDesktop.listVersions({ connectionId: c.connectionId, materialId, ...(after ? { cursor: after } : {}), limit: 50 }))
      if (!owner.valid(captured) || request !== versionTicket.current || currentDocument.current?.document.material.materialId !== materialId) return
      validateDirectory(page.items)
      if (page.items.some((item) => item.materialId !== materialId)) throw new TeamUiError('INVALID_RESPONSE', '版本目录包含其他文档，未更改选择。')
      setVersions((old) => after ? [...new Map([...old, ...page.items].map((item) => [item.version, item])).values()] : page.items); setVersionCursor(page.nextCursor); setVersionsMore(page.hasMore)
    } catch (cause) { if (owner.valid(captured) && request === versionTicket.current) reject(cause) }
  }
  const read = async (materialId: string, version: number, allowOffline: boolean): Promise<void> => {
    const captured = owner.capture(), request = ++documentTicket.current; setBusy('document'); setError('')
    try {
      const value = await verifyDocument(valueOf(await api.teamDesktop.readDocument({ connectionId: c.connectionId, materialId, version, allowOffline })))
      if (!owner.valid(captured) || request !== documentTicket.current) return
      const material = value.document.material
      if (material.materialId !== materialId || material.version !== version || material.projectId !== c.projectId || (material.visibility === 'personal' && material.ownerId !== c.ownerId)) throw Error('固定版本不属于所选文档或连接范围。')
      setDocument(value); currentDocument.current = value; setVersions([material]); setRaw(false); quoteRef.current = null; void loadVersions(materialId)
    } catch (cause) { if (owner.valid(captured) && request === documentTicket.current) reject(cause) }
    finally { if (owner.valid(captured) && request === documentTicket.current) setBusy((old) => old === 'document' ? '' : old) }
  }
  const material = document?.document.material, latest = material ? items.find((item) => item.materialId === material.materialId) : null
  const options = material ? [...new Map([material, ...versions].map((item) => [item.version, item])).values()].sort((a, b) => b.version - a.version) : []
  const selectQuote = (): void => {
    const selection = window.getSelection()
    if (!selection || !selection.rangeCount || !reader.current?.contains(selection.getRangeAt(0).commonAncestorContainer)) { setError('请先在当前固定正文中选中文字。'); return }
    const text = selection.toString()
    if (!text || text.length > 4000) { setError('引用需要为 1—4000 个字符。'); return }
    try { exactQuote(document?.document.text ?? '', text); quoteRef.current?.(text) } catch (cause) { setError(`${errorText(cause)} 可切换“查看原文”后重新选择。`) }
  }
  return <section className="team-documents"><aside className="team-material-list my-scrollbar" aria-label="共享文档目录"><header><h3>已发布文档</h3><div className="team-inline-actions"><button type="button" className="my-icon-control" title="刷新目录" aria-label="刷新共享目录" onClick={() => { void loadList() }}><RefreshCw size={14} /></button><button type="button" className="my-icon-control" title="同步到本机目录快照" aria-label="同步共享目录快照" onClick={() => { void syncDirectory() }}><ArrowDownToLine size={14} /></button></div></header>
    {updates && <p className="team-small-notice">有新的协作状态，刷新目录查看；当前正文保持不变。</p>}
    {(cached || receiptDirectory) && <p className="team-small-notice">{cached ? `目录快照 · ${timeLabel(cached.fetchedAt)} · 只代表上次可见范围` : '本机发布回执中的文档线索，目录不完整。'}{cached?.resetRequired ? ' · 同步需重新建立基线' : ''}{cached?.eventsHasMore ? ' · 事件仍在追赶' : ''}</p>}
    {items.map((item) => <button type="button" key={item.materialId} data-material-id={item.materialId} aria-pressed={material?.materialId === item.materialId} className="team-material-item" onClick={() => { void read(item.materialId, item.version, Boolean(cached || receiptDirectory || c.network === 'offline')) }}><FileText size={16} /><span><strong>{item.title}</strong><small>{kindLabel(item.kind)} · v{item.version} · {visibilityLabel(item.visibility)}</small></span></button>)}
    {!items.length && <p className="team-list-empty">{busy === 'list' ? '正在读取…' : hasMore ? '本页暂无可见条目，可继续读取。' : '暂无已加载文档。可发布新文档，或读取本机目录快照。'}</p>}
    {hasMore && <Button size="sm" variant="ghost" disabled={busy === 'list'} onClick={() => { if (cursor) void loadList(cursor) }}>读取更多文档</Button>}
    <Button size="sm" variant="ghost" onClick={() => { void loadList(undefined, true) }}>读取本机目录线索</Button>
  </aside><div className="team-reader-column"><div className="team-reader-status" role="status">{busy === 'document' ? '正在读取所选版本，已有正文暂时保留。' : material ? `固定阅读 v${material.version} · ${document?.freshness === 'cached-offline' ? '离线缓存 · 上次授权可见' : `服务端核验于 ${timeLabel(document?.fetchedAt ?? null)}`}` : '选择一份文档，阅读明确的固定版本。'}{latest && material && latest.version > material.version && <span>目录已有 v{latest.version}，可主动选择切换。</span>}</div>
    {error && <p role="alert" className="team-notice team-band">{error}</p>}
    {document && material ? <><header className="team-reader-header"><div><h3>{material.title}</h3><p>{kindLabel(material.kind)} · {visibilityLabel(material.visibility)} · 发布于 {timeLabel(material.createdAt)}</p></div><div className="team-inline-actions"><select className="my-input" aria-label="固定文档版本" value={material.version} disabled={busy === 'document'} onChange={(event) => { void read(material.materialId, Number(event.target.value), Boolean(cached || c.network === 'offline')) }}>{options.map((item) => <option key={item.version} value={item.version}>v{item.version}</option>)}</select><Button size="sm" variant="ghost" onClick={() => { void loadVersions(material.materialId) }}>查看版本</Button>{versionsMore && <Button size="sm" variant="ghost" onClick={() => { if (versionCursor) void loadVersions(material.materialId, versionCursor) }}>更多版本</Button>}<Button size="sm" variant="ghost" onClick={() => setRaw(!raw)}>{raw ? '阅读排版' : '查看原文'}</Button></div></header><div className="team-reader-body my-scrollbar" ref={reader} data-document-version={material.version}>{raw ? <pre className="team-raw-document">{document.document.text}</pre> : <TeamMarkdown text={document.document.text} identity={JSON.stringify([c.connectionId, material.materialId, material.version, material.bodyDigest])} />}</div><details className="team-document-source"><summary>固定版本与来源</summary><p>正文摘要 {material.bodyDigest}</p><p>版本 {material.version} · {material.byteLength} 字节 · {document.authorization === 'last-observed' ? '缓存不证明当前授权' : '授权在本次服务端读取时核对'}</p><pre>{JSON.stringify(material.source, null, 2)}</pre></details><div className="team-feedback-region"><div className="team-section-header"><h4><MessageSquare size={15} />围绕 v{material.version} 的反馈</h4><Button size="sm" variant="ghost" onMouseDown={(event) => event.preventDefault()} onClick={selectQuote}>引用所选文字</Button></div><Feedback key={JSON.stringify([c.connectionId, material.materialId, material.version, material.bodyDigest])} root={root} connection={c} context={context} document={document} active={active} quoteRef={quoteRef} onAccessLost={onAccessLost} /></div></> : <div className="team-empty"><FileText size={30} /><h3>资料与讨论，留在同一版本里</h3><p>已发布内容可供授权成员查阅。新版不会自动替换当前阅读，反馈先记录，再由工作流决定何时接入。</p></div>}
  </div></section>
}

function Feedback({ root, connection: c, context, document, active, quoteRef, onAccessLost }: Props & { document: DesktopTeamDocument; quoteRef: React.MutableRefObject<((text: string) => void) | null> }): JSX.Element {
  const material = document.document.material, owner = useTeamOwner(JSON.stringify([root, c.connectionId, material.materialId, material.version, material.bodyDigest, active]))
  const [items, setItems] = useState<TeamFeedback[]>([]), [cursor, setCursor] = useState<string | null>(null), [hasMore, setHasMore] = useState(false), [body, setBody] = useState(''), [quote, setQuote] = useState(''), [busy, setBusy] = useState(''), [error, setError] = useState(''), [saved, setSaved] = useState<DesktopTeamOutbox | null>(null), [frozen, setFrozen] = useState(false)
  const ticket = useRef(0), lock = useRef<symbol | null>(null), pending = useRef<{ payload: Parameters<typeof api.teamDesktop.queueFeedback>[0]; metadata: SavedIntent } | null>(null)
  quoteRef.current = (text) => { if (!frozen && !saved) setQuote(text) }
  const load = async (after?: string): Promise<void> => {
    const captured = owner.capture(), request = ++ticket.current
    try {
      const page = valueOf(await api.teamDesktop.listFeedback({ connectionId: c.connectionId, materialId: material.materialId, version: material.version, limit: 50, ...(after ? { cursor: after } : {}) }))
      if (!owner.valid(captured) || request !== ticket.current) return
      if (page.items.some((item) => item.materialId !== material.materialId || item.version !== material.version)) throw new TeamUiError('INVALID_RESPONSE', '反馈不属于当前固定版本，未展示。')
      setItems((old) => after ? [...new Map([...old, ...page.items].map((item) => [item.feedbackId, item])).values()] : page.items); setCursor(page.nextCursor); setHasMore(page.hasMore)
    } catch (cause) { if (owner.valid(captured) && request === ticket.current) { setError(errorText(cause)); if (denied(cause)) onAccessLost(errorText(cause)) } }
  }
  useEffect(() => { if (active) void load(); return () => { quoteRef.current = null } }, [active, c.connectionId, material.materialId, material.version])
  // Suspending the document pane invalidates its old UI completion, not the
  // already-saved intent. Resume with that exact intent available for inspection
  // or explicit retry rather than leaving the retained form permanently busy.
  useEffect(() => { lock.current = null; setBusy(''); setFrozen(Boolean(pending.current)) }, [owner.lifetime])
  const submit = async (): Promise<void> => {
    if (!body.trim() || lock.current || saved) return
    const captured = owner.capture(), token = Symbol('feedback'); lock.current = token; setBusy('save'); setFrozen(true); setError('')
    try {
      let intent = pending.current
      if (!intent) {
        const selected = exactQuote(document.document.text, quote), commandId = crypto.randomUUID(), payload = { connectionId: c.connectionId, commandId, feedbackId: crypto.randomUUID(), materialId: material.materialId, version: material.version, body: body.trim(), ...(selected.quote ? selected : {}) }
        const digest = await intentDigest(payload)
        if (!owner.valid(captured) || lock.current !== token) return
        const metadata: SavedIntent = { version: 1, commandId, connectionId: c.connectionId, materialId: material.materialId, kind: 'feedback', digest, createdAt: Date.now() }
        saveIntent(metadata); intent = { payload, metadata }; pending.current = intent; setFrozen(true)
      }
      const result = valueOf(await api.teamDesktop.queueFeedback(intent.payload))
      if (!owner.valid(captured)) return
      if (result.commandId !== intent.metadata.commandId || result.connectionId !== c.connectionId) throw Error('保存回执不属于原反馈。')
      clearIntent(intent.metadata); setSaved(result)
    } catch (cause) { if (owner.valid(captured)) { setError(`${errorText(cause)}${pending.current ? ' 原反馈标识与内容保留，重试不会创建新操作。' : ''}`); if (denied(cause)) onAccessLost(errorText(cause)) } }
    finally { if (lock.current === token) { lock.current = null; if (owner.valid(captured)) { setBusy(''); if (!pending.current) setFrozen(false) } } }
  }
  return <div className="team-feedback"><div className="team-inline-actions"><Button size="sm" variant="ghost" onClick={() => { void load() }}>刷新已记录反馈</Button>{hasMore && <Button size="sm" variant="ghost" onClick={() => { if (cursor) void load(cursor) }}>读取更多反馈</Button>}</div>{items.map((item) => <article key={item.feedbackId} className="team-feedback-item"><div><strong>{item.authorId === context?.person.userId ? context.person.displayName : '项目成员'}</strong><small>{timeLabel(item.createdAt)} · 已记录，未自动应用</small></div>{item.quote && <blockquote>{item.quote}</blockquote>}<p>{item.body}</p><details><summary>反馈来源</summary><code>{item.feedbackId}</code><code>{item.authorId}</code><p>文档 v{item.version}，{item.anchor ? `原文范围 ${item.anchor.start}—${item.anchor.end}` : '未声明精确范围'}</p></details></article>)}{!items.length && <p className="team-muted">{hasMore ? '本页暂无反馈，可继续读取。' : '尚未加载到此版本的已记录反馈。'}</p>}
    {!saved ? <div className="team-feedback-form"><label className="team-field">引用原文（可选）<textarea className="my-input" aria-label="反馈引用原文" value={quote} maxLength={4000} disabled={frozen} onChange={(event) => setQuote(event.target.value)} rows={2} /></label>{quote && document.document.text.indexOf(quote) !== document.document.text.lastIndexOf(quote) && <p className="team-muted">原文多处包含这段引用，将保留引用和固定版本，不猜测精确位置。</p>}<label className="team-field">你的反馈<textarea className="my-input" aria-label="版本反馈正文" value={body} maxLength={20000} disabled={frozen} onChange={(event) => setBody(event.target.value)} rows={3} placeholder="描述需要调整的业务规则或使用场景…" /></label><div className="team-form-actions"><span>反馈绑定 v{material.version}，不会直接打断开发。</span><Button size="sm" variant="primary" disabled={!body.trim() || Boolean(busy)} onClick={() => { void submit() }}>{pending.current ? '按原反馈再次请求保存' : '保存反馈到队列'}</Button></div></div> : <p role="status" className="team-notice">反馈已保存在本机队列，远端记录结果请查看待处理；尚未表示已应用到开发。</p>}
    {error && <p role="alert" className="team-notice">{error}</p>}
  </div>
}
