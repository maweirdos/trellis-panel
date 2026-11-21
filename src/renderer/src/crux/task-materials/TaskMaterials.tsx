import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { FileText, Plus, RefreshCw } from 'lucide-react'
import type { CruxSnapshot, CruxTask } from '@shared/crux'
import type { TeamTaskMaterialCommand, TeamTaskMaterialKind, TeamTaskMaterialList, TeamTaskMaterialMetadata, TeamTaskMaterialReceipt, TeamTaskMaterialView } from '@shared/team-task-materials'
import type { CruxMaterialPending } from '@shared/crux-task-materials'
import { api } from '../../api'
import { Button, Switch } from '../../my/ui'
import { useInteractionActive } from '../../utils/interaction-scope'
import { useCrux } from '../store'
import { Field, inputClass, textareaClass, Select } from '../ui'
import { taskSourceKey, useTaskSource, useTaskSurfaceGeneration } from '../pages/task-detail/use-task-source'
import { useTaskDraft, useTaskDraftField } from '../pages/task-detail/task-drafts'
import { TaskMaterialDocument, type MaterialSaveState } from './TaskMaterialDocument'
import { TASK_MATERIAL_LABELS, initialTaskMaterial, taskMaterialDigest } from './material-presentation'
import './task-materials.css'

type Draft = { documentId: string; baseDraftRevision: number; baseVersionId: string; title: string; text: string }
type CreateDraft = { kind: TeamTaskMaterialKind; title: string; text: string; approverId: string }
const message = (cause: unknown): string => cause instanceof Error ? cause.message : '任务材料暂不可用，请重试。'

export interface TaskMaterialEntryRequest { requestId: number; kind: TeamTaskMaterialKind; mode?: 'work' | 'review'; documentId?: string; versionId?: string; creationReference?: { creationId: string; revisionId: string; bodyDigest: string } }
export interface TaskMaterialReviewState {
  state: 'loading' | 'ready' | 'unavailable'
  document: TeamTaskMaterialMetadata | null
  versionNumber?: number
  refreshing: boolean
  incomplete: boolean
  error?: string
}
interface TaskMaterialsProps { snapshot: CruxSnapshot; task: CruxTask; entryRequest?: TaskMaterialEntryRequest; onReviewState?(state: TaskMaterialReviewState): void; onCommitted?(receipt: TeamTaskMaterialReceipt): void }

export function TaskMaterials({ snapshot, task, entryRequest, onReviewState, onCommitted }: TaskMaterialsProps): JSX.Element {
  const context = useCrux((state) => state.workspaceContext)
  const generation = useTaskSurfaceGeneration()
  return <Materials key={`${taskSourceKey(snapshot, context)}:${task.id}:${task.createdAt}:${generation}`} snapshot={snapshot} task={task} entryRequest={entryRequest} onReviewState={onReviewState} onCommitted={onCommitted} />
}

function Materials({ snapshot, task, entryRequest, onReviewState, onCommitted }: TaskMaterialsProps): JSX.Element {
  const context = useCrux((state) => state.workspaceContext)
  const active = useInteractionActive()
  const owner = useTaskSource({ spaceId: task.spaceId, taskId: task.id })
  const currentOwner = useRef(owner); currentOwner.current = owner
  const scope = useMemo(() => ({ workspaceKey: context.key, taskId: task.id, spaceId: task.spaceId, taskCreatedAt: task.createdAt }), [context.key, task.id, task.spaceId, task.createdAt])
  const bridge = api && Object.hasOwn(api, 'cruxMaterials') ? api.cruxMaterials : undefined
  const draftScope = useTaskDraft(snapshot, context, { kind: 'details', spaceId: task.spaceId, task, creationContext: ['shared-task-materials'] })
  const [draft, setDraft] = useTaskDraftField<Draft | null>(draftScope, 'editor', null)
  const [creation, setCreation] = useTaskDraftField<CreateDraft | null>(draftScope, 'create', null)
  const [intent, setIntent] = useTaskDraftField<TeamTaskMaterialCommand | null>(draftScope, 'command', null)
  const [list, setList] = useState<TeamTaskMaterialList | null>(null)
  const [view, setView] = useState<TeamTaskMaterialView | null>(null)
  const [pending, setPending] = useState<CruxMaterialPending[]>([])
  const [directoryLoading, setDirectoryLoading] = useState(false), [reading, setReading] = useState(false)
  const loading = directoryLoading || reading
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [directoryError, setDirectoryError] = useState('')
  const [notice, setNotice] = useState(''), [saveState, setSaveState] = useState<MaterialSaveState>('clean')
  const [autoSave, setAutoSave] = useState(true)
  const [access, setAccess] = useState<{ documentId: string; revision: number; editors: string[]; approvers: string[] } | null>(null)
  const flight = useRef(false), reads = useRef(0), directoryReads = useRef(0), editGeneration = useRef(0), mounted = useRef(false)
  const latest = useRef({ draft, view, intent, creation }); latest.current = { draft, view, intent, creation }
  const handledEntry = useRef(0)
  const latestEntry = useRef(entryRequest); latestEntry.current = entryRequest
  const announcedCommits = useRef(new Set<string>())
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; reads.current++; directoryReads.current++ } }, [])
  const actor = context.actorId ?? ''
  const isShared = context.state !== 'local'
  const writable = context.state === 'connected' && owner.canWrite() && Boolean(bridge)
  const members = snapshot.members.filter((member) => snapshot.spaces.find((space) => space.id === task.spaceId)?.memberIds.includes(member.id))
  const canCreate = writable && (task.creatorId === actor || (task.workflow ? task.workflow.handlerId === actor : task.assigneeIds.includes(actor)) || snapshot.spaces.find((space) => space.id === task.spaceId)?.ownerId === actor)
  const changed = Boolean(draft && view && draft.documentId === view.document.documentId && (draft.title !== view.selected.title || draft.text !== view.text))
  const stale = Boolean(draft && view && draft.documentId === view.document.documentId && draft.baseDraftRevision !== view.document.draftRevision)

  const load = useCallback(async (): Promise<TeamTaskMaterialList | null> => {
    if (!bridge || !isShared || !currentOwner.current.owns()) return null
    const ticket = ++directoryReads.current
    setDirectoryLoading(true); setDirectoryError('')
    try {
      const [documents, operations] = await Promise.all([bridge.list({ ...scope, limit: 20 }), bridge.pending(scope)])
      if (!currentOwner.current.owns() || ticket !== directoryReads.current) return null
      if (!documents.ok) { if (documents.code !== 'NETWORK_UNAVAILABLE') { setList(null); setView(null) }; throw Error(documents.error) }
      setList(documents.value)
      // Directory refreshes carry current ACL and review state, while the reader
      // keeps its explicitly selected, digest-verified version and body.
      setView((current) => {
        if (!current) return current
        const document = documents.value.page.items.find((item) => item.documentId === current.document.documentId)
        return document ? { ...current, document } : documents.value.page.hasMore ? current : null
      })
      if (operations.ok) setPending(operations.value)
      else setError(operations.error)
      return documents.value
    } catch (cause) { if (currentOwner.current.owns() && ticket === directoryReads.current) { setError(message(cause)); setDirectoryError(message(cause)) }; return null }
    finally { if (mounted.current && ticket === directoryReads.current) setDirectoryLoading(false) }
  }, [bridge, scope, isShared])
  useEffect(() => { if (active) void load() }, [active, load, task.updatedAt, context.authorizationRevision, context.revision, context.state])
  useEffect(() => {
    if (!isShared || !onReviewState) return
    const listed = list?.page.items.find((item) => item.kind === 'prd') ?? null
    const opened = view?.document.kind === 'prd' ? view.document : null
    const document = opened && (!listed || opened.revision > listed.revision) ? opened : listed
    const review = document?.latestSubmission ?? document?.approved
    const versionNumber = review ? document?.draft.versionId === review.versionId ? document.draft.number : view?.selected.versionId === review.versionId ? view.selected.number : undefined : document?.draft.number
    onReviewState({ state: !bridge || directoryError ? 'unavailable' : list ? 'ready' : 'loading', document, versionNumber,
      refreshing: directoryLoading, incomplete: Boolean(list?.page.hasMore), ...(!bridge ? { error: '当前客户端未加载共享材料能力。' } : directoryError ? { error: directoryError } : {}) })
  }, [isShared, onReviewState, list, view, bridge, directoryError, directoryLoading])

  async function open(documentId: string, versionId?: string, preserveDraft = false): Promise<TeamTaskMaterialView | null> {
    if (!bridge || !currentOwner.current.owns()) return null
    const ticket = ++reads.current
    const inputGeneration = editGeneration.current
    const resuming = !latest.current.view && !versionId && latest.current.draft?.documentId === documentId
    setReading(true); setError('')
    try {
      const result = await bridge.read({ ...scope, documentId, ...(versionId ? { versionId } : {}) })
      if (!currentOwner.current.owns() || ticket !== reads.current) return null
      if (!result.ok) { if (result.code !== 'NETWORK_UNAVAILABLE') setView(null); throw Error(result.error) }
      const next = result.value
      if (next.document.taskId !== task.id || next.document.taskCreatedAt !== task.createdAt || next.document.spaceId !== task.spaceId || next.document.documentId !== documentId || versionId && next.selected.versionId !== versionId) throw Error('返回的材料不属于原任务或选定版本。')
      setView(next)
      if (!preserveDraft && !resuming && inputGeneration === editGeneration.current) { setDraft(null); setSaveState('clean'); editGeneration.current++ }
      else if (resuming) {
        const retained = latest.current.draft
        setSaveState(latest.current.intent ? 'unknown' : retained && (retained.text !== next.text || retained.title !== next.selected.title) ? 'dirty' : 'clean')
      }
      return next
    } catch (cause) { if (currentOwner.current.owns() && ticket === reads.current) setError(message(cause)); return null }
    finally { if (mounted.current && ticket === reads.current) setReading(false) }
  }

  async function accept(receipt: TeamTaskMaterialReceipt, original: TeamTaskMaterialCommand | null, submittedGeneration: number): Promise<void> {
    if (!currentOwner.current.owns()) return
    if (receipt.taskId !== scope.taskId || receipt.spaceId !== scope.spaceId || receipt.taskCreatedAt !== scope.taskCreatedAt || receipt.epoch !== context.epoch) throw Error('材料回执不属于原任务。')
    // Material commits advance the workspace head. Refresh both native/Web client
    // caches and the visible source before a following workflow command can use CAS.
    const refreshed = await useCrux.getState().run('刷新材料评审工作区', async () => currentOwner.current.owns()
      ? api.crux.snapshot() : { ok: false as const, error: '原材料工作区已变化，请回原任务核对。' })
    if (!currentOwner.current.owns()) return
    if (!refreshed?.ok) setError(`材料操作已有回执，工作区刷新尚未确认。${refreshed && !refreshed.ok ? refreshed.error : '请重新加载原工作区后再交接任务。'}`)
    if (!announcedCommits.current.has(receipt.commandId)) { announcedCommits.current.add(receipt.commandId); onCommitted?.(receipt) }
    if (receipt.outcome === 'conflict-preserved') {
      setSaveState('conflict'); setAutoSave(false)
      setNotice('并发修改已另存为候选，当前共享草稿没有被覆盖。请先比较，再明确合并。')
      const next = await open(receipt.documentId, receipt.versionId ?? undefined, true)
      if (next) setIntent((current) => current?.commandId === receipt.commandId ? null : current)
    } else {
      if (receipt.action === 'setAccess') {
        setAccess(null)
        setIntent((current) => current?.commandId === receipt.commandId ? null : current)
        setNotice('文档协作者已更新。')
        await open(receipt.documentId, latest.current.view?.selected.versionId, true)
        await load()
        return
      }
      // A body read can be slower than the acknowledgement. Keep the live editor
      // until that read completes, then acknowledge only the submitted input.
      setNotice('已收到原操作回执，正在核对正文…')
      const next = await open(receipt.documentId, receipt.versionId ?? undefined, true)
      if (!next) {
        if (currentOwner.current.owns()) {
          setAutoSave(false); setSaveState('unknown')
          setNotice('原操作已有回执，正文尚未核对；请保留修改并核对原结果。')
        }
        await load()
        return
      }
      setIntent((current) => current?.commandId === receipt.commandId ? null : current)
      setNotice(receipt.action === 'approve' ? '此固定版本已批准，任务阶段保持原状态。' : receipt.action === 'submit' ? '此固定版本已提交评审。' : receipt.action === 'reject' ? '已记录退回意见。' : '共享草稿已保存。')
      if (original?.action === 'create' && latest.current.creation?.kind === original.kind && latest.current.creation.title === original.title
        && latest.current.creation.text === original.text && original.approverIds.includes(latest.current.creation.approverId)) setCreation(null)
      const editingContinued = editGeneration.current !== submittedGeneration
      if (editingContinued && latest.current.draft?.documentId === receipt.documentId && original?.action === 'saveDraft' && receipt.versionId) {
        setDraft({ ...latest.current.draft, baseDraftRevision: receipt.draftRevision, baseVersionId: receipt.versionId })
        setSaveState('dirty')
      } else if (!editingContinued) { setDraft(null); setSaveState('saved') }
      else if (!latest.current.draft && (!latest.current.intent || latest.current.intent.commandId === receipt.commandId)) setSaveState('saved')
    }
    await load()
  }

  async function execute(command: TeamTaskMaterialCommand): Promise<void> {
    if (!bridge || !writable || flight.current || latest.current.intent) return
    flight.current = true; setBusy(true); setError(''); setNotice(''); setIntent(command)
    const submitted = editGeneration.current
    if (command.action === 'saveDraft') setSaveState('saving')
    try {
      const result = await bridge.command({ ...scope, command })
      if (!currentOwner.current.owns()) return
      if (!result.ok) {
        if (!result.outcomeUnknown) setIntent(null)
        setAutoSave(false); setSaveState(result.outcomeUnknown ? 'unknown' : 'error'); setError(result.error)
        return
      }
      await accept(result.value.result, command, submitted)
    } catch (cause) { if (currentOwner.current.owns()) { setError(message(cause)); setAutoSave(false); setSaveState('unknown') } }
    finally { flight.current = false; if (mounted.current) setBusy(false); void load() }
  }

  async function recover(commandId: string, retry = false): Promise<void> {
    if (!bridge || !currentOwner.current.owns() || flight.current) return
    flight.current = true; setBusy(true); setError('')
    try {
      const result = retry ? await bridge.retry({ ...scope, commandId }) : await bridge.reconcile({ ...scope, commandId })
      if (!currentOwner.current.owns()) return
      if (!result.ok) throw Error(result.error)
      const value = result.value
      const receipt = value && ('result' in value ? value.result : value)
      if (receipt) await accept(receipt, latest.current.intent?.commandId === commandId ? latest.current.intent : null, -1)
      else setNotice('尚无确定回执；这不表示原操作被取消。可以继续核对，或明确使用原内容重试。')
    } catch (cause) { if (currentOwner.current.owns()) setError(message(cause)) }
    finally { flight.current = false; if (mounted.current) setBusy(false); void load() }
  }

  async function save(): Promise<void> {
    const editor = latest.current.draft, current = latest.current.view
    if (!editor || !current || !writable || flight.current || latest.current.intent || editor.baseDraftRevision !== current.document.draftRevision || !context.epoch) return
    const references = [...current.selected.references]
    const creationReference = latestEntry.current?.creationReference
    if (creationReference && current.document.kind === 'design' && !references.some((reference) => reference.kind === 'creation' && reference.creationId === creationReference.creationId && reference.revisionId === creationReference.revisionId)) references.push({ kind: 'creation', ...creationReference })
    const generation = editGeneration.current
    try {
      const expectedDigest = await taskMaterialDigest(editor.text)
      if (!currentOwner.current.canWrite() || generation !== editGeneration.current || flight.current || latest.current.intent) return
      await execute({ action: 'saveDraft', commandId: crypto.randomUUID(), expectedEpoch: context.epoch, spaceId: task.spaceId, taskCreatedAt: task.createdAt,
        documentId: editor.documentId, expectedDraftRevision: editor.baseDraftRevision, title: editor.title, text: editor.text, expectedDigest, references })
    } catch (cause) { if (currentOwner.current.owns()) { setError(message(cause)); setAutoSave(false) } }
  }
  useEffect(() => {
    if (!writable || !autoSave || !changed || stale || !active || busy || intent || saveState === 'unknown' || saveState === 'conflict' || !draft?.title.trim() || !draft.text.trim()) return
    const timer = window.setTimeout(() => { void save() }, 1000)
    return () => window.clearTimeout(timer)
    // The captured draft identity/value determines the next bounded autosave.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [writable, autoSave, changed, stale, active, busy, intent, saveState, draft, context.epoch])

  async function create(): Promise<void> {
    if (!creation || !canCreate || !actor || !context.epoch || !creation.approverId || flight.current || intent) return
    const captured = creation, generation = editGeneration.current
    try {
      const expectedDigest = await taskMaterialDigest(captured.text)
      if (!currentOwner.current.canWrite() || generation !== editGeneration.current || flight.current || latest.current.intent) return
      await execute({ action: 'create', commandId: crypto.randomUUID(), expectedEpoch: context.epoch, spaceId: task.spaceId, taskCreatedAt: task.createdAt,
        kind: captured.kind, title: captured.title, text: captured.text, expectedDigest, references: latestEntry.current?.creationReference && captured.kind === 'design' ? [{ kind: 'creation' as const, ...latestEntry.current.creationReference }] : [], editorIds: [actor], approverIds: [captured.approverId] })
    } catch (cause) { if (currentOwner.current.owns()) setError(message(cause)) }
  }
  useEffect(() => {
    if (!entryRequest || entryRequest.requestId === handledEntry.current || !active || loading || busy || !currentOwner.current.owns()) return
    handledEntry.current = entryRequest.requestId
    // Opening a work area must not replace an existing edit or unresolved command.
    if (latest.current.draft || latest.current.creation || latest.current.intent) { setNotice('当前编辑或原操作仍保留，请先保存或核对，再打开另一份材料。'); return }
    setNotice('')
    void (async () => {
      const current = await load()
      if (!current || !currentOwner.current.owns() || latestEntry.current?.requestId !== entryRequest.requestId) return
      if (latest.current.draft || latest.current.creation || latest.current.intent) { setNotice('当前编辑或原操作仍保留，请先保存或核对，再打开另一份材料。'); return }
      if (entryRequest.documentId) { await open(entryRequest.documentId, entryRequest.versionId); return }
      const existing = current.page.items.find((item) => item.kind === entryRequest.kind)
      if (existing) {
        const review = entryRequest.mode === 'review' ? existing.latestSubmission?.status === 'pending' ? existing.latestSubmission : existing.approved : null
        await open(existing.documentId, review?.versionId)
      }
      else if (entryRequest.mode === 'review') setNotice(`尚无${TASK_MATERIAL_LABELS[entryRequest.kind]}共享材料，请先创建或核对材料目录。`)
      else if (canCreate && !current.page.hasMore) { setCreation({ kind: entryRequest.kind, ...initialTaskMaterial(entryRequest.kind, task.title), approverId: '' }); editGeneration.current++ }
    })()
  }, [entryRequest, active, loading, busy, canCreate, load])
  function decide(action: 'submit' | 'approve' | 'reject', reason?: string): void {
    if (!view || !context.epoch || !writable || changed || intent) return
    const base = { commandId: crypto.randomUUID(), expectedEpoch: context.epoch, spaceId: task.spaceId, taskCreatedAt: task.createdAt, documentId: view.document.documentId, expectedRevision: view.document.revision }
    if (action === 'submit') void execute({ ...base, action, expectedDraftRevision: view.document.draftRevision, versionId: view.selected.versionId, bodyDigest: view.selected.bodyDigest })
    else {
      const submission = view.document.latestSubmission
      if (!submission || submission.status !== 'pending' || submission.versionId !== view.selected.versionId || submission.bodyDigest !== view.selected.bodyDigest) return
      if (action === 'approve') void execute({ ...base, action, submissionId: submission.submissionId, bodyDigest: submission.bodyDigest })
      else if (reason) void execute({ ...base, action, submissionId: submission.submissionId, bodyDigest: submission.bodyDigest, reason })
    }
  }

  if (!isShared) return <section className="rounded-my-md border border-my-line p-3 text-my-xs text-my-tertiary" aria-label="任务共享材料">连接团队服务后，可共享需求、设计和实施文档；现有本机材料仍保留。</section>
  return <section className="task-materials min-w-0 space-y-3 rounded-my-md border border-my-line p-3" aria-label="任务共享材料">
    <header className="flex flex-wrap items-center gap-2"><FileText size={16} /><h3 className="flex-1 text-my-sm font-medium text-my-primary">共享材料与评审</h3><Button size="sm" variant="ghost" aria-label="刷新任务材料" disabled={!bridge || loading || busy} onClick={() => void load()}><RefreshCw size={14} /></Button></header>
    {!bridge ? <p role="status" className="text-my-xs text-my-secondary">当前客户端尚未加载团队材料能力，请更新并重新打开。</p> : <>
      {error && <p role="alert" className="collab-inline-error">{error}</p>}{notice && <p role="status" className="text-my-xs text-my-secondary">{notice}</p>}
      {context.state === 'offline' && <p role="status" className="text-my-xs text-my-warning-text">{changed || creation ? '离线修改仅保留在当前页，尚未安全保存；关闭或刷新可能丢失。' : '当前离线，正在显示上次已核对的材料。'}</p>}
      {loading && !list && <p role="status" className="text-my-xs text-my-tertiary">正在读取任务材料…</p>}
      {list && <div className="flex flex-wrap gap-2">{list.page.items.map((item) => <Button key={item.documentId} size="sm" variant={view?.document.documentId === item.documentId ? 'neutral' : 'outline'} disabled={busy || changed} onClick={() => void open(item.documentId)}>{TASK_MATERIAL_LABELS[item.kind]} · v{item.draft.number}{item.approved ? ' · 已有批准版' : ''}</Button>)}
        {canCreate && !list.page.hasMore && (Object.keys(TASK_MATERIAL_LABELS) as TeamTaskMaterialKind[]).filter((kind) => !list.page.items.some((item) => item.kind === kind)).map((kind) => <Button key={kind} size="sm" variant="ghost" disabled={busy || Boolean(creation) || changed} onClick={() => { setCreation({ kind, ...initialTaskMaterial(kind, task.title), approverId: '' }); editGeneration.current++ }}><Plus size={13} />{TASK_MATERIAL_LABELS[kind]}</Button>)}
      </div>}
      {list?.page.hasMore && <p role="status" className="text-my-xs text-my-warning-text">材料目录尚不完整，请重新核对后再创建同类材料。</p>}
      {creation && <div className="space-y-3 rounded-my-md bg-my-layer-1 p-3">
        <h4 className="text-my-sm font-medium">创建{TASK_MATERIAL_LABELS[creation.kind]}共享草稿</h4>
        <Field label="标题"><input autoFocus className={inputClass} value={creation.title} disabled={busy} maxLength={300} onChange={(event) => { setCreation({ ...creation, title: event.target.value }); editGeneration.current++ }} /></Field>
        <Field label="正文"><textarea className={textareaClass} rows={12} value={creation.text} disabled={busy} onChange={(event) => { setCreation({ ...creation, text: event.target.value }); editGeneration.current++ }} /></Field>
        <Field label="评审人"><Select value={creation.approverId} disabled={busy} onChange={(val) => { setCreation({ ...creation, approverId: val }); editGeneration.current++ }} options={[{ value: '', label: '请选择空间成员' }, ...members.map((member) => ({ value: member.id, label: member.name }))]} /></Field>
        <div className="flex justify-end gap-2"><Button size="sm" variant="ghost" disabled={busy || Boolean(intent)} onClick={() => setCreation(null)}>取消</Button><Button size="sm" variant="primary" disabled={!canCreate || busy || Boolean(intent) || !creation.title.trim() || !creation.text.trim() || !creation.approverId} onClick={() => void create()}>创建共享草稿</Button></div>
      </div>}
      {view && <>
        {(canCreate || view.document.ownerId === actor && writable) && <Button size="sm" variant="ghost" disabled={busy || Boolean(intent)} onClick={() => setAccess({ documentId: view.document.documentId, revision: view.document.revision, editors: [...view.document.editorIds], approvers: [...view.document.approverIds] })}>管理文档协作者</Button>}
        {access?.documentId === view.document.documentId && <div className="space-y-3 rounded-my-md bg-my-layer-1 p-3" aria-label="文档协作者设置">
          <fieldset className="min-w-0 space-y-2" disabled={busy || Boolean(intent)}><legend className="text-my-xs font-medium">可编辑草稿</legend><div className="flex flex-wrap gap-3">{members.map((member) => <label key={member.id} className="flex items-center gap-2 text-my-xs"><input type="checkbox" checked={access.editors.includes(member.id)} onChange={(event) => setAccess({ ...access, editors: event.target.checked ? [...access.editors, member.id] : access.editors.filter((id) => id !== member.id) })} />{member.name}</label>)}</div></fieldset>
          <fieldset className="min-w-0 space-y-2" disabled={busy || Boolean(intent)}><legend className="text-my-xs font-medium">可批准或退回</legend><div className="flex flex-wrap gap-3">{members.map((member) => <label key={member.id} className="flex items-center gap-2 text-my-xs"><input type="checkbox" checked={access.approvers.includes(member.id)} onChange={(event) => setAccess({ ...access, approvers: event.target.checked ? [...access.approvers, member.id] : access.approvers.filter((id) => id !== member.id) })} />{member.name}</label>)}</div></fieldset>
          {access.revision !== view.document.revision && <p role="status" className="text-my-xs text-my-warning-text">协作者设置的原版本已变化，请重新打开并核对。</p>}
          <div className="flex justify-end gap-2"><Button size="sm" variant="ghost" disabled={busy} onClick={() => setAccess(null)}>取消</Button><Button size="sm" disabled={!writable || busy || Boolean(intent) || !context.epoch || !access.editors.length || !access.approvers.length || access.revision !== view.document.revision} onClick={() => { if (context.epoch) void execute({ action: 'setAccess', commandId: crypto.randomUUID(), expectedEpoch: context.epoch, spaceId: task.spaceId, taskCreatedAt: task.createdAt, documentId: access.documentId, expectedRevision: access.revision, editorIds: access.editors, approverIds: access.approvers }) }}>保存协作者</Button></div>
        </div>}
        {view.document.editorIds.includes(actor) && <div className="flex items-center gap-2 text-my-xs text-my-secondary"><span>自动保存草稿</span><Switch label="自动保存共享草稿" checked={autoSave} disabled={!writable || busy || Boolean(intent) || stale || saveState === 'conflict'} onChange={setAutoSave} /></div>}
        {(stale || saveState === 'conflict') && draft && <div className="space-y-2 rounded-my-md bg-my-warning-subtle p-3 text-my-xs text-my-warning-text"><p>共享草稿已变化，你的修改仍保留。先查看当前稿并合并，再重新确认编辑基线。</p><Button size="sm" disabled={busy} onClick={() => void open(view.document.documentId, view.document.draft.versionId, true)}>查看当前共享稿，保留我的修改</Button>{view.selected.versionId === view.document.draft.versionId && <Button size="sm" disabled={busy || Boolean(intent)} onClick={() => { setDraft({ ...draft, baseDraftRevision: view.document.draftRevision, baseVersionId: view.selected.versionId }); setSaveState('dirty'); setAutoSave(false) }}>已核对，按当前版本继续编辑</Button>}<details><summary>我的未提交正文</summary><pre className="my-scrollbar max-h-64 overflow-auto whitespace-pre-wrap break-words">{draft.text}</pre></details></div>}
        <TaskMaterialDocument key={`${view.document.documentId}:${entryRequest?.requestId ?? 0}`} view={view} actorId={actor} initialMode={entryRequest?.kind === view.document.kind && entryRequest.mode !== 'review' ? 'edit' : 'read'} title={draft?.documentId === view.document.documentId ? draft.title : view.selected.title}
          text={draft?.documentId === view.document.documentId ? draft.text : view.text} saveState={saveState} busy={busy} writable={writable} changed={changed}
          onChange={(value) => { if (!currentOwner.current.canWrite()) return; setDraft({ documentId: view.document.documentId, baseDraftRevision: draft?.baseDraftRevision ?? view.document.draftRevision, baseVersionId: draft?.baseVersionId ?? view.selected.versionId, ...value }); editGeneration.current++; setSaveState('dirty') }}
          onSave={() => void save()} onSubmit={() => decide('submit')} onDecide={decide} onSelectVersion={(versionId) => { if (!changed) void open(view.document.documentId, versionId) }} />
      </>}
      {(intent || pending.length > 0) && <div className="space-y-2 border-t border-my-line pt-3" aria-label="材料待核对操作"><h4 className="text-my-xs font-medium">待核对操作</h4>{[...new Set([...(intent ? [intent.commandId] : []), ...pending.map((item) => item.commandId)])].map((id) => <div key={id} data-command-id={id} className="flex flex-wrap items-center gap-2 text-my-xs"><span className="min-w-0 flex-1">{pending.find((item) => item.commandId === id)?.error ?? '原操作结果待核对'}</span><Button size="sm" disabled={busy} onClick={() => void recover(id)}>核对原结果</Button><Button size="sm" disabled={busy || !writable} onClick={() => void recover(id, true)}>以原内容重试</Button></div>)}</div>}
    </>}
  </section>
}
