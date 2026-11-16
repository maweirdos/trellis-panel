import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { ArrowUpRight, FilePlus2, Loader2, X } from 'lucide-react'
import type { DesktopTeamConnection, DesktopTeamConnectionContext, DesktopTeamOutbox } from '../../../shared/team-desktop'
import type { DesktopWorkflowPublicationInput } from '../../../shared/team-desktop-bridge'
import type { TeamMaterialVersion, TeamVisibility, TeamPublicationInput } from '../../../shared/team-platform'
import { api } from '../api'
import { Button, Modal } from '../my/ui'
import { Select } from '../components/Select'
import { useInteractionActive } from '../utils/interaction-scope'
import { clearIntent, denied, errorText, intentDigest, kindLabel, saveIntent, valueOf, visibilityLabel, type SavedIntent } from './model'
import { useTeamOwner } from './use-team-owner'

export type WorkflowPublicationSource = DesktopWorkflowPublicationInput['source']
type Props = { open: boolean; onClose: () => void; expectedRoot: string; source?: WorkflowPublicationSource; title?: string; kind?: TeamPublicationInput['kind']; connectionId?: string; onQueued?: (value: DesktopTeamOutbox) => void }
/** Public inputs describe an exact source reference; immutable bytes are resolved in main. */
export function PublicationDialog(props: Props): JSX.Element {
  const interactive = useInteractionActive(), owner = useTeamOwner(JSON.stringify([props.expectedRoot, props.open, props.source ?? 'authored']))
  const [connections, setConnections] = useState<DesktopTeamConnection[]>([]), [selected, setSelected] = useState(props.connectionId ?? ''), [error, setError] = useState('')
  useEffect(() => {
    if (!props.open || !interactive) return
    const captured = owner.capture()
    let ticket = 0
    const refresh = (): void => {
      const request = ++ticket
      void api.teamDesktop.connections().then(valueOf).then((items) => { if (owner.valid(captured) && request === ticket) { setConnections(items); setSelected((old) => items.some((item) => item.connectionId === old) ? old : props.connectionId ?? items.find((item) => item.state === 'active' && !item.accessLocked)?.connectionId ?? ''); setError('') } }).catch((cause) => { if (owner.valid(captured) && request === ticket) setError(errorText(cause)) })
    }
    refresh()
    return api.teamDesktop.onChanged(refresh)
  }, [props.open, props.expectedRoot, interactive, owner.lifetime])
  const connection = connections.find((item) => item.connectionId === selected)
  return <Modal open={props.open && interactive} onClose={props.onClose} ariaLabel={props.source ? '发布固定文档版本' : '发布共享文档'} width={760}>
    <section className="team-publication"><header className="team-dialog-header"><div><span className="team-eyebrow">显式发布</span><h2>{props.source ? '发布这个固定版本' : '发布共享文档'}</h2></div><button type="button" className="my-icon-control" aria-label="关闭文档发布" onClick={props.onClose}><X size={17} /></button></header>
      <div className="team-publication-scroll my-scrollbar"><p className="team-muted">正文与来源会保存为不可变版本。保存到本机队列后，原授权可用时会自动发送；尚未确认的操作先核对。</p>
        <label className="team-field">发布到<Select ariaLabel="发布使用的团队连接" value={selected} onChange={setSelected} options={[{ value: '', label: '选择已授权连接' }, ...connections.map((entry) => ({ value: entry.connectionId, label: `${entry.deviceName} · ${entry.origin}${entry.state !== 'active' ? '（尚未授权）' : ''}`, disabled: entry.state !== 'active' || entry.accessLocked }))]} /></label>
        {error && <p role="alert" className="team-notice">{error}</p>}
        {connection?.state === 'active' && !connection.accessLocked ? <PublicationForm key={JSON.stringify([props.expectedRoot, props.source ?? 'authored', connection.connectionId, connection.ownerId, connection.projectId, connection.state, connection.accessLocked])} {...props} connection={connection} /> : <div className="team-empty"><FilePlus2 size={24} /><p>先在团队共享中完成设备配对，再选择明确的接收范围。</p></div>}
      </div>
    </section>
  </Modal>
}

function PublicationForm({ expectedRoot, source, title: initialTitle, kind: initialKind, connection, onClose, onQueued }: Props & { connection: DesktopTeamConnection }): JSX.Element {
  const owner = useTeamOwner(JSON.stringify([expectedRoot, connection.connectionId, connection.ownerId, connection.projectId, connection.state, connection.accessLocked, source ?? 'authored']))
  const [context, setContext] = useState<DesktopTeamConnectionContext | null>(null), [materials, setMaterials] = useState<TeamMaterialVersion[]>([]), [cursor, setCursor] = useState<string | null>(null), [hasMore, setHasMore] = useState(false)
  const [mode, setMode] = useState<'new' | 'next'>('new'), [target, setTarget] = useState<TeamMaterialVersion | null>(null)
  const [title, setTitle] = useState(initialTitle ?? ''), [text, setText] = useState(''), [kind, setKind] = useState<TeamPublicationInput['kind']>(initialKind ?? 'product-requirement'), [visibility, setVisibility] = useState<TeamVisibility>('personal')
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [queued, setQueued] = useState<DesktopTeamOutbox | null>(null), [frozen, setFrozen] = useState(false), [blocked, setBlocked] = useState(false)
  const lock = useRef<symbol | null>(null)
  const pending = useRef<{ payload: DesktopWorkflowPublicationInput | Parameters<typeof api.teamDesktop.queueAuthoredPublication>[0]; metadata: SavedIntent } | null>(null)
  const scope = useMemo(() => JSON.stringify([expectedRoot, connection.connectionId, source ?? 'authored']), [expectedRoot, connection.connectionId, source])
  const load = async (after?: string): Promise<void> => {
    const captured = owner.capture()
    try {
      const [identity, page] = await Promise.all([api.teamDesktop.connectionContext(connection.connectionId).then(valueOf), api.teamDesktop.listMaterials({ connectionId: connection.connectionId, ...(after ? { cursor: after } : {}), limit: 50 }).then(valueOf)])
      if (!owner.valid(captured)) return
      if (identity.person.userId !== connection.ownerId || identity.project.projectId !== connection.projectId) throw Error('返回的项目或账号不属于原连接。')
      setContext(identity); setMaterials((old) => after ? [...new Map([...old, ...page.items].map((item) => [item.materialId, item])).values()] : page.items); setCursor(page.nextCursor); setHasMore(page.hasMore)
    } catch (cause) {
      if (!owner.valid(captured)) return
      setError(errorText(cause))
      if (denied(cause)) { setContext(null); setMaterials([]); setBlocked(true); return }
      // Saving an offline intent needs the original still-unlocked local
      // binding, not a newly fetched display name. Server rights/CAS are checked
      // again before actual dispatch. Cached metadata only helps choose a target.
      try {
        const snapshot = valueOf(await api.teamDesktop.cachedSnapshot(connection.connectionId))
        if (owner.valid(captured) && snapshot) { setMaterials(snapshot.items); setCursor(null); setHasMore(false) }
      } catch (cacheError) { if (owner.valid(captured) && denied(cacheError)) { setBlocked(true); setMaterials([]); setError(errorText(cacheError)) } }
    }
  }
  useEffect(() => { void load() }, [scope])
  const own = materials.filter((item) => item.ownerId === (context?.person.userId ?? connection.ownerId) && item.projectId === connection.projectId && (!source || !initialKind || item.kind === initialKind))
  const canSave = Boolean(!blocked && connection.state === 'active' && !connection.accessLocked && connection.ownerId && connection.projectId && title.trim() && (source || text.trim()) && (mode === 'new' || target) && !busy && !queued)
  const submit = async (): Promise<void> => {
    if (!canSave || lock.current) return
    const captured = owner.capture(), token = Symbol('publication')
    lock.current = token; setBusy('save'); setFrozen(true); setError('')
    try {
      let intent = pending.current
      if (!intent) {
        const commandId = crypto.randomUUID(), materialId = mode === 'next' && target ? target.materialId : crypto.randomUUID()
        const base = { connectionId: connection.connectionId, commandId, materialId, title: title.trim(), visibility, expectedVersion: mode === 'next' && target ? target.version : null }
        const payload = source ? { ...base, source: structuredClone(source) } : { ...base, text, kind, sourceVersion: crypto.randomUUID() }
        const digest = await intentDigest(payload)
        if (!owner.valid(captured) || lock.current !== token) return
        const metadata: SavedIntent = { version: 1, commandId, connectionId: connection.connectionId, materialId, kind: 'publication', digest, createdAt: Date.now() }
        saveIntent(metadata); intent = { payload, metadata }; pending.current = intent; setFrozen(true)
      }
      const reply = source ? await api.teamDesktop.queueWorkflowMaterial(expectedRoot, intent.payload as DesktopWorkflowPublicationInput) : await api.teamDesktop.queueAuthoredPublication(intent.payload as Parameters<typeof api.teamDesktop.queueAuthoredPublication>[0])
      if (!owner.valid(captured)) return
      const value = valueOf(reply)
      if (value.commandId !== intent.metadata.commandId || value.connectionId !== connection.connectionId) throw Error('保存回执不属于原操作，请保留原标识核对。')
      clearIntent(intent.metadata); setQueued(value); onQueued?.(value)
    } catch (cause) { if (owner.valid(captured)) { setError(`${errorText(cause)}${pending.current ? ' 原操作标识已保留；再次请求仍使用同一内容和标识。' : ''}`); if (denied(cause)) setBlocked(true) } }
    finally { if (lock.current === token) { lock.current = null; if (owner.valid(captured)) { setBusy(''); if (!pending.current) setFrozen(false) } } }
  }
  return <div className="team-publication-form"><div className="team-scope-line"><strong>{context?.project.name ?? '原绑定项目 · 名称暂不可核验'}</strong><span>{context?.person.displayName ?? '使用原设备与账号绑定'}</span></div>{(!context || connection.network === 'offline') && <div className="team-notice">这里只保存到原连接的本机队列，不宣称当前服务端授权已确认。恢复连接后仍须核对权限与版本。<details><summary>原绑定身份</summary><code>{connection.origin}</code><code>项目 {connection.projectId}</code><code>账号 {connection.ownerId}</code></details></div>}
    <div className="team-choice-row" role="group" aria-label="文档发布方式"><button type="button" className="my-control" aria-pressed={mode === 'new'} disabled={frozen} onClick={() => { setMode('new'); setTarget(null) }}>新建文档</button><button type="button" className="my-control" aria-pressed={mode === 'next'} disabled={frozen} onClick={() => setMode('next')}>已有文档的新版本</button></div>
    {mode === 'next' && <div><label className="team-field">已有文档<Select ariaLabel="待更新的共享文档" disabled={frozen} value={target?.materialId ?? ''} onChange={(val) => { const value = own.find((entry) => entry.materialId === val) ?? null; setTarget(value); if (value) { setTitle(value.title); if (!source) setKind(value.kind) } }} options={[{ value: '', label: '选择自己的已发布文档' }, ...own.map((item) => ({ value: item.materialId, label: `${item.title} · v${item.version}` }))]} /></label>{hasMore && <Button size="sm" variant="ghost" disabled={frozen} onClick={() => { if (cursor) void load(cursor) }}>继续查找文档</Button>}{target && <p className="team-muted">基于已观察的 v{target.version} 创建下一版；其他人先发布时会返回版本冲突。</p>}</div>}
    <label className="team-field">标题<input className="my-input" aria-label="发布文档标题" maxLength={300} value={title} disabled={frozen} onChange={(event) => setTitle(event.target.value)} /></label>
    {!source && <><label className="team-field">文档类型<Select ariaLabel="发布文档类型" value={kind} disabled={frozen} onChange={(val) => setKind(val as TeamPublicationInput['kind'])} options={['product-requirement', 'trellis-prd', 'design', 'spec', 'other'].map((value) => ({ value, label: kindLabel(value) }))} /></label><label className="team-field">正文<textarea className="my-input team-author-text" aria-label="发布文档正文" value={text} disabled={frozen} onChange={(event) => setText(event.target.value)} placeholder="使用 Markdown 描述场景、规则和验收标准…" /></label></>}
    {source && <div className="team-source-note"><ArrowUpRight size={15} /><p>只发布所选固定产物。正文、版本与来源由主进程核对，不会换成磁盘上的最新文件。</p></div>}
    <label className="team-field">本版本可见范围<Select ariaLabel="发布可见范围" value={visibility} disabled={frozen} onChange={(val) => setVisibility(val as TeamVisibility)} options={['personal', 'project', 'team'].map((value) => ({ value, label: visibilityLabel(value) }))} /></label>
    {error && <p role="alert" className="team-notice">{error}</p>}
    {queued && <div role="status" className="team-notice">已保存原操作到本机队列。授权可用时自动发送；发布结果请在“待处理”核对。<details><summary>操作来源</summary><code>{queued.commandId}</code></details></div>}
    <footer className="team-form-actions"><Button variant="ghost" onClick={onClose}>{queued ? '完成' : '返回'}</Button><Button variant="primary" disabled={!canSave} onClick={() => { void submit() }}>{busy ? <Loader2 size={14} className="animate-spin" /> : <FilePlus2 size={14} />}{pending.current && !queued ? '按原操作再次请求保存' : '保存并发布'}</Button></footer>
  </div>
}
