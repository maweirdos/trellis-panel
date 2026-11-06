import { useEffect, useRef, useState, type JSX } from 'react'
import type { CreationCommandReply } from '@shared/creations'
import { createEmptyWhiteboard, whiteboardDocumentSchema, type WhiteboardDocument } from '@shared/creation-whiteboard'
import { whiteboardV2CapabilitiesSchema, whiteboardV2ListSchema, whiteboardV2ViewSchema, type WhiteboardV2Capabilities, type WhiteboardV2List, type WhiteboardV2View } from '@shared/creation-whiteboard-v2'
import { whiteboardV2ClientCommandSchema, type WhiteboardV2Api, type WhiteboardV2ClientCommand } from '@shared/whiteboard-v2-api'
import { Button, Dropdown, DropdownItem } from '../my/ui'
import { WhiteboardEditor } from './WhiteboardEditor'
import './whiteboard-workspace.css'

/** The host must supply an authorization generation that changes on every authority transition. */
export type WhiteboardWorkspaceOwner = {
  workspaceKey: string; actorId: string; epoch: string | null; sourceId: string
  authorizationRevision: number | null; generation: number; local: boolean; authorized: boolean
}
export type WhiteboardWorkspaceAdapter = {
  /** Keep this object and its API stable for one mounted authority generation. */
  api: WhiteboardV2Api
  /**
   * Immutable for this generation; each candidate is checked against the current
   * local source and membership and is guaranteed to retain owner-only access.
   * Any candidate or grant change invalidates isCurrent and the generation.
   */
  localPublication?: readonly { id: string; name: string; ownerOnly: true }[]
  localOpinions?: true
}
export type WhiteboardWorkspaceProps = {
  owner: WhiteboardWorkspaceOwner; adapter?: WhiteboardWorkspaceAdapter; enabled?: boolean
  /**
   * Read the live authority store synchronously, comparing it with the owner and
   * monotonic generation captured for this mount. It must remain false after any
   * transition, including A → B → A, until the host mounts a new generation.
   * Keep the callback stable within that generation; never use render state alone.
   */
  isCurrent: () => boolean
}

type Selection = { revisionId: string; kind: 'draft' | 'published' }
type PublicationTarget = { id: string; name: string; ownerOnly: true }
function publicationTargets(adapter: WhiteboardWorkspaceAdapter, boundSpaceId: string | null): PublicationTarget[] {
  if (!Array.isArray(adapter.localPublication)) return []
  const candidates = adapter.localPublication.filter((item): item is PublicationTarget => Boolean(item &&
    typeof item.id === 'string' && item.id.trim() && item.id.length <= 256 &&
    typeof item.name === 'string' && item.name.trim() && item.name.length <= 200 && item.ownerOnly === true))
  const counts = new Map<string, number>()
  for (const item of candidates) counts.set(item.id, (counts.get(item.id) ?? 0) + 1)
  return candidates.filter((item) => (!boundSpaceId || item.id === boundSpaceId) && counts.get(item.id) === 1)
}
function targetLabel(target: PublicationTarget, targets: PublicationTarget[]): string {
  return targets.filter((entry) => entry.name === target.name).length > 1 ? `${target.id} · ${target.name}` : target.name
}
type Draft = { creationId: string; title: string; document: WhiteboardDocument; revision: number | null; revisionId: string | null; dirty: boolean; conflict: boolean; pending: WhiteboardV2ClientCommand | null; opinion: string; opinionRevisionId: string | null }
// Inputs and command payloads remain in renderer memory, bound to the original principal.
const drafts = new Map<string, Map<string, Draft>>()
const MAX_RETAINED_DRAFTS = 24
const MAX_RETAINED_BYTES = 16 * 1024 * 1024
const encoder = new TextEncoder()
function draftBytes(draft: Draft): number { return encoder.encode(JSON.stringify(draft)).length }
function hasUnsavedWork(draft: Draft): boolean { return Boolean(draft.dirty || draft.pending || draft.conflict || draft.opinion.trim()) }
function storeDraft(key: string, draft: Draft): boolean {
  const previous = drafts.get(key)?.get(draft.creationId)
  if (!hasUnsavedWork(draft)) {
    const map = drafts.get(key)
    map?.delete(draft.creationId)
    if (map?.size === 0) drafts.delete(key)
    return true
  }
  if (draft.title.length > 200 || draft.opinion.length > 2000 || !whiteboardDocumentSchema.safeParse(draft.document).success || (draft.pending && !whiteboardV2ClientCommandSchema.safeParse(draft.pending).success)) return false
  let count = 0, bytes = 0
  for (const map of drafts.values()) for (const entry of map.values()) { count++; bytes += draftBytes(entry) }
  if ((!previous && count >= MAX_RETAINED_DRAFTS) || bytes - (previous ? draftBytes(previous) : 0) + draftBytes(draft) > MAX_RETAINED_BYTES) return false
  let map = drafts.get(key)
  if (!map) { map = new Map(); drafts.set(key, map) }
  map.set(draft.creationId, draft)
  return true
}
const adapterIds = new WeakMap<WhiteboardWorkspaceAdapter, number>()
let nextAdapterId = 0
function adapterId(adapter: WhiteboardWorkspaceAdapter | undefined): number {
  if (!adapter) return 0
  const existing = adapterIds.get(adapter)
  if (existing) return existing
  const id = ++nextAdapterId
  adapterIds.set(adapter, id)
  return id
}
function principal(owner: WhiteboardWorkspaceOwner): string { return JSON.stringify([owner.workspaceKey, owner.actorId, owner.epoch, owner.sourceId]) }
function matches(reply: CreationCommandReply, command: WhiteboardV2ClientCommand, owner: WhiteboardWorkspaceOwner): boolean {
  const result = reply.result
  return reply.commandId === command.commandId && result.creationId === command.creationId && result.action === command.action &&
    result.projectId === 'local' && (result.epoch ?? null) === owner.epoch && result.revision === (command.expectedRevision ?? 0) + 1 &&
    (!['create', 'saveDraft', 'publish'].includes(command.action) || result.revisionId === command.commandId) &&
    result.private && result.scopeSpaceIds.length === 0 && result.scopeTaskIds.length === 0 &&
    result.scopePersonIds.length === 1 && result.scopePersonIds[0] === owner.actorId &&
    (command.action !== 'annotate' || (result.revisionId === command.revisionId && result.commentId === command.commandId))
}
function parseBody(body: string): WhiteboardDocument | null {
  try { const parsed = whiteboardDocumentSchema.safeParse(JSON.parse(body)); return parsed.success ? parsed.data : null } catch { return null }
}
function denied(code: string): boolean { return /FORBIDDEN|REVOKED|UNAUTHORIZED|SOURCE_CHANGED|EPOCH_CONFLICT/.test(code) }
function uncertain(code: string): boolean { return /PENDING_OPERATION|SOURCE_CHANGED|EPOCH_CONFLICT|SERVICE_CLOSED|RECEIPT_MISMATCH/.test(code) }

/** The host must explicitly enable the local-only workspace for a verified source. */
export function WhiteboardWorkspace({ owner, adapter, isCurrent, enabled = false }: WhiteboardWorkspaceProps): JSX.Element {
  const identity = JSON.stringify([principal(owner), owner.authorizationRevision, owner.generation, owner.local, owner.authorized, enabled, adapterId(adapter)])
  const current = useRef(identity)
  current.current = identity
  const checkCurrent = (): boolean => { try { return isCurrent() === true } catch { return false } }
  if (!enabled || !adapter || !owner.local || !owner.authorized || !owner.workspaceKey || owner.workspaceKey.length > 8192 || !owner.actorId || owner.actorId.length > 256 || !owner.sourceId || owner.sourceId.length > 8192 || !checkCurrent()) {
    return <section className="whiteboard-workspace whiteboard-workspace-state"><h2>本机白板</h2><p>白板工作台尚未开放。</p></section>
  }
  return <WhiteboardSession key={identity} owner={owner} adapter={adapter} validOwner={() => current.current === identity && checkCurrent()} />
}

function WhiteboardSession({ owner, adapter, validOwner }: { owner: WhiteboardWorkspaceOwner; adapter: WhiteboardWorkspaceAdapter; validOwner: () => boolean }): JSX.Element {
  const ownerKey = principal(owner)
  const [capability, setCapability] = useState<WhiteboardV2Capabilities | null>(null)
  const [list, setList] = useState<WhiteboardV2List | null>(null)
  const [sort, setSort] = useState<'updated' | 'name'>('updated')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [view, setView] = useState<WhiteboardV2View | null>(null)
  const [selected, setSelected] = useState('')
  const [locked, setLocked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirmPublish, setConfirmPublish] = useState(false)
  const [publicationTarget, setPublicationTarget] = useState<PublicationTarget | null>(null)
  const alive = useRef(true)
  const request = useRef(0)
  const busyRef = useRef(false)
  const invalidated = useRef(false)
  const valid = (): boolean => {
    if (!alive.current || invalidated.current) return false
    if (!validOwner()) { invalidated.current = true; return false }
    return true
  }
  useEffect(() => { alive.current = true; return () => { alive.current = false; request.current++ } }, [])
  function retain(next: Draft): boolean {
    if (!valid()) return false
    if (!storeDraft(ownerKey, next)) { setError('未完成的白板已达到内存上限，请先保存或核对已有工作。'); return false }
    setDraft(next)
    return true
  }
  function fail(message: string, code = ''): void {
    if (!valid()) return
    if (denied(code)) { setView(null); setDraft(null); setList(null); setCapability(null); setLocked(true) }
    setError(message)
  }
  useEffect(() => {
    let active = true
    void adapter.api.capabilities({ workspaceKey: owner.workspaceKey }).then((reply) => {
      if (!active || !valid()) return
      if (reply.ok) { const result = whiteboardV2CapabilitiesSchema.safeParse(reply.value); if (result.success) setCapability(result.data); else fail('白板能力信息无效。') }
      else fail(reply.error, reply.code)
    }).catch(() => { if (active) fail('无法检查白板能力，请重试。') })
    return () => { active = false }
  }, [adapter, owner.workspaceKey])
  async function loadList(nextSort: 'updated' | 'name', append = false): Promise<void> {
    if (!valid() || !capability?.read || busyRef.current || (append && !list?.nextCursor)) return
    const ticket = ++request.current
    setBusy(true); setError('')
    try {
      const reply = await adapter.api.list({ workspaceKey: owner.workspaceKey, sort: nextSort, limit: 20, ...(append && list?.nextCursor ? { cursor: list.nextCursor } : {}) })
      if (!valid() || ticket !== request.current) return
      if (!reply.ok) { fail(reply.error, reply.code); return }
      const parsed = whiteboardV2ListSchema.safeParse(reply.value)
      if (!parsed.success || parsed.data.items.some((item) => item.ownerId !== owner.actorId || item.projectId !== 'local')) { fail('白板列表身份无法核对。', 'SOURCE_CHANGED'); return }
      setList(append && list ? { ...parsed.data, items: [...list.items, ...parsed.data.items.filter((item) => !list.items.some((old) => old.creationId === item.creationId))] } : parsed.data)
    } catch { if (valid() && ticket === request.current) fail('白板列表加载失败，请重试。') }
    finally { if (valid() && ticket === request.current) setBusy(false) }
  }
  useEffect(() => { if (capability?.read) void loadList(sort) }, [capability, sort])
  async function open(creationId: string, selection: Selection, preserveNotice = false): Promise<void> {
    if (!valid() || !capability?.read || busyRef.current) return
    const ticket = ++request.current
    setBusy(true); setError(''); if (!preserveNotice) setNotice(''); setConfirmPublish(false); setPublicationTarget(null)
    try {
      const reply = await adapter.api.get({ workspaceKey: owner.workspaceKey, creationId, revisionId: selection.revisionId, commentLimit: 20 })
      if (!valid() || ticket !== request.current) return
      if (!reply.ok) { fail(reply.code === 'REVISION_NOT_FOUND' ? '草稿或版本已变化，请返回并重新加载列表。' : reply.error, reply.code); return }
      const parsed = whiteboardV2ViewSchema.safeParse(reply.value)
      const value = parsed.success ? parsed.data : null
      if (!value || value.summary.ownerId !== owner.actorId || value.summary.projectId !== 'local' || value.summary.creationId !== creationId || value.selected.revisionId !== selection.revisionId || value.selected.published !== (selection.kind === 'published')) { fail('白板或所选版本不可用，请重新加载列表。'); return }
      const document = parseBody(value.selected.body)
      if (!document) { fail('白板内容无效或版本不受支持。'); return }
      const retained = drafts.get(ownerKey)?.get(creationId)
      if (selection.kind === 'draft') {
        const preserve = retained && (retained.dirty || retained.pending || retained.conflict || retained.opinion.trim())
        const fresh: Draft = { creationId, title: value.summary.title, document, revision: value.summary.revision, revisionId: value.selected.revisionId, dirty: false, conflict: false, pending: null, opinion: '', opinionRevisionId: null }
        if (!retain(preserve ? { ...retained, conflict: retained.conflict || (!retained.pending && (retained.revision !== value.summary.revision || retained.revisionId !== value.selected.revisionId)) } : fresh)) return
      } else if (retained) setDraft(retained)
      setView(value); setSelected(value.selected.revisionId)
    } catch { if (valid() && ticket === request.current) fail('白板打开失败，请重试。') }
    finally { if (valid() && ticket === request.current) setBusy(false) }
  }
  function start(): void {
    if (!valid() || !capability?.create) return
    const next: Draft = { creationId: crypto.randomUUID(), title: '', document: createEmptyWhiteboard(), revision: null, revisionId: null, dirty: true, conflict: false, pending: null, opinion: '', opinionRevisionId: null }
    if (!retain(next)) return
    setView(null); setSelected(''); setError(''); setNotice(''); setConfirmPublish(false); setPublicationTarget(null)
  }
  function back(): void { if (!valid()) return; request.current++; setDraft(null); setView(null); setSelected(''); setError(''); setNotice(''); setConfirmPublish(false); setPublicationTarget(null); setBusy(false); void loadList(sort) }
  function receipt(command: WhiteboardV2ClientCommand, result: CreationCommandReply): Selection | null {
    const original = drafts.get(ownerKey)?.get(command.creationId)
    if (!original || original.pending?.commandId !== command.commandId) { fail('原操作与回执无法核对，请保留输入。'); return null }
    if (!matches(result, command, owner)) { fail('操作回执不匹配，请核对原操作。'); return null }
    const next: Draft = { ...original, pending: null, revision: result.result.revision,
      ...(command.action === 'create' || command.action === 'saveDraft' ? { revisionId: command.commandId, dirty: false, conflict: false } : {}),
      ...(command.action === 'annotate' && original.opinion.trim() === command.body ? { opinion: '', opinionRevisionId: null } : {}) }
    retain(next); setNotice(command.action === 'publish' ? '固定版本已保存。' : command.action === 'annotate' ? '意见已记录。' : '草稿已保存。')
    setError(''); setConfirmPublish(false); setPublicationTarget(null)
    if (command.action === 'publish') return { revisionId: command.commandId, kind: 'published' }
    if (command.action === 'annotate') return { revisionId: command.revisionId, kind: view?.selected.published ? 'published' : 'draft' }
    return next.revisionId ? { revisionId: next.revisionId, kind: 'draft' } : null
  }
  async function execute(command: WhiteboardV2ClientCommand, recover = false): Promise<void> {
    if (!valid() || !draft || busyRef.current || (!recover && draft.pending) || (recover && !capability?.recover)) return
    const permitted = command.action === 'create' ? capability?.create : command.action === 'saveDraft' ? capability?.save : command.action === 'publish' ? capability?.publish : capability?.review
    if (!permitted) return
    if (!recover && !retain({ ...draft, pending: command })) return
    busyRef.current = true
    setBusy(true); setError(''); setNotice('')
    let reloadRevision: Selection | null = null
    try {
      const reply = recover ? await adapter.api.recover({ workspaceKey: owner.workspaceKey, command }) : await adapter.api.command({ workspaceKey: owner.workspaceKey, command })
      if (!valid()) return
      if (!reply.ok) {
        if (!reply.outcomeUnknown && !uncertain(reply.code)) {
          const original = drafts.get(ownerKey)?.get(command.creationId)
          if (original?.pending?.commandId === command.commandId) retain({ ...original, pending: null, conflict: /CONFLICT/.test(reply.code) || original.conflict })
        }
        fail(reply.error, reply.code); return
      }
      if (!reply.value) { fail('尚未找到原操作回执，结果仍未确认。'); return }
      reloadRevision = receipt(command, reply.value)
    } catch { if (valid()) fail('操作结果未知，请核对原操作。') }
    finally { busyRef.current = false; if (valid()) setBusy(false) }
    if (reloadRevision && valid()) void open(command.creationId, reloadRevision, true)
  }
  function save(): void {
    if (!valid() || !draft || !draft.title.trim() || draft.title.trim().length > 200 || draft.pending || draft.conflict) return
    const common = { commandId: crypto.randomUUID(), creationId: draft.creationId, expectedRevision: draft.revision }
    const body = JSON.stringify(draft.document)
    const command: WhiteboardV2ClientCommand = draft.revision === null
      ? { ...common, action: 'create', title: draft.title.trim(), body }
      : { ...common, action: 'saveDraft', title: draft.title.trim(), body }
    void execute(command)
  }
  const activeDraft = draft && (draft.revision === null || (view && !view.selected.published && view.selected.revisionId === draft.revisionId))
  const canEdit = Boolean(activeDraft && (draft?.revision === null ? capability?.create : capability?.save) && !draft?.pending && !draft?.conflict && !busy)
  const targets = publicationTargets(adapter, view?.summary.spaceId ?? null)
  const canPublish = Boolean(activeDraft && view && draft && draft.revision !== null && !draft.dirty && !draft.pending && !draft.conflict && capability?.publish && targets.length && !busy)
  function chooseTarget(target: PublicationTarget): void {
    if (!valid()) return
    const current = publicationTargets(adapter, view?.summary.spaceId ?? null).find((item) => item.id === target.id && item.name === target.name)
    if (!current) { setPublicationTarget(null); fail('所选本机目标不可用，请重新选择。'); return }
    setPublicationTarget({ ...current }); setError('')
  }
  function publish(): void {
    if (!valid() || !canPublish || !draft || !publicationTarget) return
    const target = publicationTargets(adapter, view?.summary.spaceId ?? null).find((item) => item.id === publicationTarget.id && item.name === publicationTarget.name)
    if (!target) { setPublicationTarget(null); fail('所选本机目标不可用，请重新选择。'); return }
    void execute({ action: 'publish', commandId: crypto.randomUUID(), creationId: draft.creationId, expectedRevision: draft.revision, spaceId: target.id })
  }
  const retained = [...(drafts.get(ownerKey)?.values() ?? [])].filter(hasUnsavedWork)
  return <section className="whiteboard-workspace" aria-label="本机白板工作台">
    <header className="whiteboard-workspace-header">
      <div><h2>{draft ? (draft.title || '新白板') : '本机白板'}</h2><p className="my-item-description">仅本机个人使用 · 不支持团队分享和任务采用</p></div>
      <div className="whiteboard-workspace-actions">{draft ? <Button onClick={back} disabled={busy}>返回列表</Button> : <Button variant="primary" disabled={!capability?.create || busy} onClick={start}>新建白板</Button>}</div>
    </header>
    {error && <div className="whiteboard-workspace-message" role="alert">{error} {!capability && !locked && <Button size="sm" onClick={() => { if (!valid()) return; setError(''); void adapter.api.capabilities({ workspaceKey: owner.workspaceKey }).then((reply) => { if (!valid()) return; if (reply.ok) { const result = whiteboardV2CapabilitiesSchema.safeParse(reply.value); if (result.success) setCapability(result.data); else fail('白板能力信息无效。') } else fail(reply.error, reply.code) }).catch(() => fail('无法检查白板能力，请重试。')) }}>重试</Button>}</div>}
    {notice && <div className="whiteboard-workspace-message" role="status">{notice}</div>}
    {!capability && !error && <p role="status">正在检查白板能力…</p>}
    {capability && !capability.read && <p>本机白板尚未开放。</p>}
    {capability?.read && !draft && <div className="whiteboard-workspace-list">
      <div className="whiteboard-workspace-list-heading"><h3>白板</h3><Dropdown trigger={({ toggle, open: opened }) => <Button size="sm" aria-expanded={opened} onClick={toggle}>{sort === 'updated' ? '最近更新' : '按名称'}</Button>}>{(close) => <><DropdownItem selected={sort === 'updated'} onClick={() => { setSort('updated'); close() }}>最近更新</DropdownItem><DropdownItem selected={sort === 'name'} onClick={() => { setSort('name'); close() }}>按名称</DropdownItem></>}</Dropdown></div>
      {retained.length > 0 && <div className="whiteboard-workspace-retained"><h4>未完成的工作</h4>{retained.map((item) => <div className="whiteboard-workspace-row" key={item.creationId}><div><div className="my-item-title">{item.title || '未命名白板'}</div><div className="my-item-description">{item.pending ? '操作结果待核对' : item.conflict ? '需要处理冲突' : '未保存'}</div></div><Button size="sm" onClick={() => { if (!valid()) return; if (item.revision !== null && !item.pending && item.revisionId) { void open(item.creationId, { revisionId: list?.items.find((entry) => entry.creationId === item.creationId)?.draftRevisionId ?? item.revisionId, kind: 'draft' }); return } setDraft(item); setView(null); setSelected(''); setError('') }}>继续</Button></div>)}</div>}
      {busy && !list && <p role="status">正在加载白板…</p>}
      {list && list.items.length === 0 && <p className="my-item-description">还没有已保存的白板。</p>}
      {list?.items.map((item) => <div className="whiteboard-workspace-row" key={item.creationId}><div><div className="my-item-title">{item.title}</div><div className="my-item-description">{item.latestPublished ? `固定版本 ${item.latestPublished.number}` : '草稿'} · {new Date(item.updatedAt).toLocaleString()}</div></div><Button size="sm" disabled={busy} onClick={() => void open(item.creationId, { revisionId: item.draftRevisionId, kind: 'draft' })}>打开</Button></div>)}
      {list?.hasMore && <Button disabled={busy || !list.nextCursor} onClick={() => void loadList(sort, true)}>{busy ? '加载中…' : '加载更多'}</Button>}
      {error && <Button size="sm" disabled={busy} onClick={() => void loadList(sort)}>重新加载列表</Button>}
    </div>}
    {draft && <div className="whiteboard-workspace-content">
      {draft.pending && <div className="whiteboard-workspace-message" role="status">原操作结果尚未确认。<Button size="sm" disabled={busy || !capability?.recover} onClick={() => void execute(draft.pending as WhiteboardV2ClientCommand, true)}>核对原操作</Button></div>}
      {draft.conflict && <div className="whiteboard-workspace-message" role="alert">白板已在别处更改。当前输入已保留，冲突合并尚未开放。</div>}
      <div className="whiteboard-workspace-edit-header">
        <label className="whiteboard-workspace-title"><span className="my-item-title">名称</span><input className="my-input" maxLength={200} value={draft.title} disabled={!canEdit} onChange={(event) => { if (retain({ ...draft, title: event.target.value, dirty: true })) setNotice('') }} /></label>
        <div className="whiteboard-workspace-actions">
          {view && <Dropdown trigger={({ toggle, open: opened }) => <Button size="sm" aria-expanded={opened} onClick={toggle}>{view.selected.published ? `版本 ${view.selected.number}` : '草稿'}</Button>}>{(close) => <><DropdownItem selected={!view.selected.published} disabled={!draft.revisionId} onClick={() => { close(); if (draft.revisionId) void open(draft.creationId, { revisionId: draft.revisionId, kind: 'draft' }) }}>草稿</DropdownItem>{view.revisions.map((version) => <DropdownItem key={version.revisionId} selected={version.revisionId === selected} onClick={() => { close(); void open(draft.creationId, { revisionId: version.revisionId, kind: 'published' }) }}>版本 {version.number} · {version.title}</DropdownItem>)}</>}</Dropdown>}
          <Button variant="primary" disabled={!canEdit || !draft.dirty || !draft.title.trim()} onClick={save}>{busy ? '处理中…' : '保存草稿'}</Button>
          <Button disabled={!canPublish} onClick={() => { if (valid()) { setPublicationTarget(null); setConfirmPublish(true) } }}>发布固定版本</Button>
        </div>
      </div>
      {confirmPublish && <div className="whiteboard-workspace-message" role="group" aria-label="选择本机发布目标">
        <span>将已保存草稿固定为本机个人版本。</span>
        <Dropdown disabled={!targets.length || busy} trigger={({ toggle, open: opened }) => <Button size="sm" aria-label="本机发布目标" aria-expanded={opened} onClick={() => { if (valid()) toggle() }}>{publicationTarget ? targetLabel(publicationTarget, targets) : '选择本机目标'}</Button>}>
          {(close) => <>{targets.map((target) => <DropdownItem key={target.id} selected={publicationTarget?.id === target.id} onClick={() => { if (!valid()) return; chooseTarget(target); close() }}>{targetLabel(target, targets)}</DropdownItem>)}</>}
        </Dropdown>
        <Button size="sm" disabled={!canPublish || !publicationTarget} onClick={publish}>确认发布</Button>
        <Button size="sm" variant="ghost" onClick={() => { if (valid()) { setConfirmPublish(false); setPublicationTarget(null) } }}>取消</Button>
      </div>}
      {!capability?.publish ? <p className="my-item-description">本机固定版本发布尚未开放。</p> : targets.length === 0 && <p className="my-item-description">{view?.summary.spaceId ? '白板原本机目标不可用，无法发布新版本。' : '没有可用的本机发布目标。'}</p>}
      <WhiteboardEditor key={view?.selected.revisionId ?? draft.creationId} value={view?.selected.published ? parseBody(view.selected.body) : draft.document} readonly={!canEdit} onChange={(document) => { if (canEdit && retain({ ...draft, document, dirty: true })) setNotice('') }} />
      {view && <section className="whiteboard-workspace-opinions"><h3>整体意见</h3>
        {view.comments.length === 0 && <p className="my-item-description">此版本暂无意见。</p>}
        {view.comments.map((comment) => <article key={comment.commentId} className="whiteboard-workspace-comment"><div className="my-item-description">{comment.severity === 'required' ? '需处理' : comment.severity === 'question' ? '问题' : '建议'} · {comment.status === 'open' ? '待处理' : comment.status === 'confirmed' ? '已确认' : '已关闭'}</div><p>{comment.body}</p>{comment.replies.map((reply) => <p key={reply.replyId}>{reply.body}</p>)}</article>)}
        {view.nextCommentOffset !== null && <Button size="sm" disabled={busy} onClick={() => { if (!valid()) return; const offset = view.nextCommentOffset; if (offset === null) return; const ticket = ++request.current; setBusy(true); void adapter.api.get({ workspaceKey: owner.workspaceKey, creationId: draft.creationId, revisionId: view.selected.revisionId, commentOffset: offset, commentLimit: 20 }).then((reply) => { if (!valid() || ticket !== request.current) return; if (!reply.ok) { fail(reply.error, reply.code); return } if (!reply.value || reply.value.summary.revision !== view.summary.revision || reply.value.selected.revisionId !== view.selected.revisionId) { fail('意见已变化，请重新打开版本。'); return } setView({ ...reply.value, comments: [...view.comments, ...reply.value.comments] }) }).catch(() => { if (valid() && ticket === request.current) fail('意见加载失败，请重试。') }).finally(() => { if (valid() && ticket === request.current) setBusy(false) }) }}>加载更多意见</Button>}
        {adapter.localOpinions && capability?.review && draft.opinionRevisionId && draft.opinionRevisionId !== view.selected.revisionId && <p className="my-item-description">有一条未提交的意见属于其他版本；返回原版本继续编辑。</p>}
        {adapter.localOpinions && capability?.review && (!draft.opinionRevisionId || draft.opinionRevisionId === view.selected.revisionId) && <div className="whiteboard-workspace-opinion-form"><label><span className="my-item-title">添加整体意见</span><textarea className="my-input" maxLength={2000} value={draft.opinion} disabled={!!draft.pending} onChange={(event) => { if (retain({ ...draft, opinion: event.target.value, opinionRevisionId: event.target.value ? view.selected.revisionId : null })) setNotice('') }} /></label><Button size="sm" disabled={busy || !!draft.pending || draft.dirty || draft.conflict || draft.revision === null || !draft.opinion.trim()} onClick={() => { if (!valid()) return; const body = draft.opinion.trim(); if (!body) return; void execute({ action: 'annotate', commandId: crypto.randomUUID(), creationId: draft.creationId, expectedRevision: draft.revision, revisionId: view.selected.revisionId, body, severity: 'suggestion' }) }}>记录意见</Button></div>}
      </section>}
    </div>}
  </section>
}
