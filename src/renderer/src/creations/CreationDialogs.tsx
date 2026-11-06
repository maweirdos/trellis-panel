import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import { ArrowUpRight, Check, ChevronDown, FileText, Link2, Loader2, Monitor, Upload, X } from 'lucide-react'
import type { CreationCommandReply, CreationPrivateSource, CreationView } from '@shared/creations'
import { CREATION_MAX_BODY_BYTES } from '@shared/creations'
import { Button, Dropdown, DropdownItem, Modal } from '../my/ui'
import { useHifox } from '../hifox/store'
import { bodySize, validateDraft } from './creation-state'
import { useCreationCommands, useCreationOwner } from './hooks'
import { discardCreationForm, openCreationForm, readCreationForm, settleCreationForm, subscribeCreationForm, updateCreationForm, type CreationFormIdentity, type RetainedCreationForm } from './creation-form-memory'

type Commands = ReturnType<typeof useCreationCommands>

export function OperationError({ commands, onRecovered, onRefresh }: { commands: Commands; onRecovered: (receipt: CreationCommandReply | null) => void; onRefresh?: () => void }): JSX.Element | null {
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  if (!commands.error) return null
  return <div className="creation-error" role="alert"><span className="creation-grow">{commands.error.error}</span>
    {commands.recoveryRequired && <Button size="sm" disabled={commands.busy} onClick={() => { void commands.recover().then((receipt) => { if (receipt !== false && mounted.current) onRecovered(receipt) }) }}>核对原操作</Button>}
    {!commands.recoveryRequired && /CONFLICT|STALE/.test(commands.error.code) && onRefresh && <Button size="sm" disabled={commands.busy} onClick={onRefresh}>刷新</Button>}
  </div>
}

function PeoplePicker({ label, people, value, onChange, disabled }: {
  label: string; people: Array<{ id: string; name: string }>; value: string[]; onChange: (value: string[]) => void; disabled?: boolean
}): JSX.Element {
  return <fieldset className="creation-people-picker" disabled={disabled}><legend>{label}</legend>
    {people.length === 0 ? <p className="creation-meta">此空间暂无可选成员</p> : <div className="creation-people-list my-scrollbar">{people.map((person) => <label key={person.id}><input type="checkbox" checked={value.includes(person.id)} disabled={disabled || (!value.includes(person.id) && value.length >= 32)} onChange={(event) => onChange(event.target.checked ? [...value, person.id] : value.filter((id) => id !== person.id))} /><span>{person.name}</span></label>)}</div>}
  </fieldset>
}

type CreateCreationDialogProps = {
  scope: 'personal' | 'team'; spaceId?: string
  initialDraft?: { title: string; kind: 'prototype' | 'document'; body: string; privateSource?: CreationPrivateSource }
  resume?: { identity: CreationFormIdentity; creationId: string }
  onClose: () => void; onCreated: (creationId: string) => void
}

export function CreateCreationDialog(props: CreateCreationDialogProps): JSX.Element {
  const context = useHifox((state) => state.workspaceContext)
  const snapshot = useHifox((state) => state.snapshot)
  const principal = JSON.stringify([context.key, context.actorId, context.epoch ?? null])
  const originalPrincipal = useRef(principal)
  const space = snapshot?.spaces.find((entry) => entry.id === props.spaceId)
  const authorized = Boolean(originalPrincipal.current === principal && context.actorId && (context.state === 'local' || (context.state === 'connected' && context.epoch))
    && (!props.resume || (props.resume.identity.workspaceKey === context.key && props.resume.identity.actorId === context.actorId
      && props.resume.identity.epoch === (context.epoch ?? null) && props.resume.identity.scope === props.scope
      && props.resume.identity.spaceId === (props.scope === 'team' ? props.spaceId ?? null : null)))
    && (props.scope === 'personal' || (space && !space.archived && space.memberIds.includes(context.actorId))))
  if (!authorized || !context.actorId) return <Modal open ariaLabel="新建创作" width={480} onClose={props.onClose}><div className="creation-dialog">
    <p role="alert">原工作区不可用或无权访问，表单已保留。请恢复原来源后继续。</p>
    <div className="creation-dialog-footer"><Button onClick={props.onClose}>关闭</Button></div>
  </div></Modal>
  const identity: CreationFormIdentity = props.resume?.identity ?? { workspaceKey: context.key, actorId: context.actorId, epoch: context.epoch ?? null,
    scope: props.scope, spaceId: props.scope === 'team' ? props.spaceId ?? null : null, source: props.initialDraft?.privateSource ?? null }
  return <CreationFormEntry key={JSON.stringify(identity)} {...props} identity={identity} />
}

function CreationFormEntry(props: CreateCreationDialogProps & { identity: CreationFormIdentity }): JSX.Element {
  const [form] = useState(() => props.resume ? readCreationForm(props.identity) : openCreationForm(props.identity, props.initialDraft))
  if (props.resume && (!form || form.creationId !== props.resume.creationId || readCreationForm(props.identity) !== form)) return <Modal open ariaLabel="继续未完成" width={480} onClose={props.onClose}><div className="creation-dialog">
    <p role="alert">此表单已不可用，请返回列表。</p><div className="creation-dialog-footer"><Button onClick={props.onClose}>关闭</Button></div>
  </div></Modal>
  if (!form) return <Modal open ariaLabel="新建创作" width={480} onClose={props.onClose}><div className="creation-dialog">
    <p role="alert">待处理表单已达上限，请先返回并完成或取消其他表单。</p>
    <div className="creation-dialog-footer"><Button onClick={props.onClose}>关闭</Button></div>
  </div></Modal>
  return <CreationForm {...props} form={form} />
}

function CreationForm({ scope, spaceId, onClose, onCreated, form }: CreateCreationDialogProps & { form: RetainedCreationForm }): JSX.Element {
  const { creationId } = form
  useSyncExternalStore((listener) => subscribeCreationForm(form, listener), () => form.version)
  const { actorId, capture } = useCreationOwner(`new:${creationId}`)
  const snapshot = useHifox((state) => state.snapshot)
  const commands = useCreationCommands(creationId, null, 'create', form.identity)
  const { title, kind, body, privateSource, editors } = form
  const update = (values: Partial<Pick<RetainedCreationForm, 'title' | 'kind' | 'body' | 'privateSource' | 'editors' | 'pending'>>): void => {
    updateCreationForm(form, values)
  }
  const [error, setError] = useState('')
  const [importing, setImporting] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const space = snapshot?.spaces.find((entry) => entry.id === spaceId)
  const people = snapshot?.members.filter((person) => space?.memberIds.includes(person.id) && person.id !== actorId) ?? []
  const locked = importing || commands.busy || commands.recoveryRequired || form.pending
  const close = (): void => { discardCreationForm(form); onClose() }
  const save = async (): Promise<void> => {
    const validation = validateDraft({ title, body, scenarios: [] })
    if (validation) { setError(validation); return }
    if (scope === 'team' && !spaceId) { setError('请先选择团队空间'); return }
    const valid = capture()
    commands.clearError()
    update({ pending: true })
    const result = await commands.run({ action: 'create', title: title.trim(), kind, home: scope, spaceId: scope === 'team' ? spaceId ?? null : null, body, scenarios: [], ...(scope === 'team' ? { editorIds: editors } : privateSource ? { privateSource } : {}) })
    if (result && valid() && result.result.action === 'create' && result.result.creationId === creationId) { settleCreationForm(form); onCreated(creationId) }
  }
  return <Modal open ariaLabel="新建创作" width={720} onClose={close}>
    <div className="creation-dialog"><div className="creation-section-heading"><h2>新建创作</h2><Button size="sm" variant="ghost" aria-label="关闭" onClick={close}><X size={16} /></Button></div>
      <div className="creation-form-grid"><label>标题<input autoFocus className="my-input" value={title} maxLength={200} disabled={locked} onChange={(event) => update({ title: event.target.value })} /></label>
        <div className="creation-row"><Dropdown trigger={({ toggle, open }) => <Button onClick={toggle} aria-expanded={open} disabled={locked}>{kind === 'prototype' ? <Monitor size={15} /> : <FileText size={15} />}{kind === 'prototype' ? '交互原型 · HTML' : '文档 · 纯文本'}<ChevronDown size={13} /></Button>}>
          {(close) => <><DropdownItem selected={kind === 'prototype'} onClick={() => { update({ kind: 'prototype' }); close() }}>交互原型 · HTML</DropdownItem><DropdownItem selected={kind === 'document'} onClick={() => { update({ kind: 'document' }); close() }}>文档 · 纯文本</DropdownItem></>}
        </Dropdown><span className="creation-grow" /><Button disabled={locked} onClick={() => fileInput.current?.click()}><Upload size={15} />{importing ? '正在导入…' : '导入文件'}</Button></div>
        <input ref={fileInput} type="file" accept=".html,.htm,.txt,.md" className="creation-file-input" aria-label="导入 HTML 或文本文件" onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (!file) return
          if (!/\.(html?|txt|md)$/i.test(file.name)) { setError('请选择 HTML、TXT 或 Markdown 文件'); return }
          if (file.size > CREATION_MAX_BODY_BYTES) { setError('文件超过 256 KiB 上限'); return }
          const valid = capture()
          setImporting(true)
          void file.text().then((text) => {
            if (!valid()) return
            update({ body: text, privateSource: undefined, title: form.title || file.name.replace(/\.[^.]+$/, ''), kind: /\.html?$/i.test(file.name) ? 'prototype' : 'document' }); setError('')
          }).catch((failure: unknown) => { if (valid()) setError(failure instanceof Error ? failure.message : '读取文件失败') }).finally(() => { if (valid()) setImporting(false) })
        }} />
        <label>{kind === 'prototype' ? '自包含 HTML' : '正文'}<textarea className={`my-input creation-import-source ${kind === 'prototype' ? 'creation-code' : ''}`} spellCheck={kind !== 'prototype'} value={body} rows={11} disabled={locked} onChange={(event) => update({ body: event.target.value })} placeholder={kind === 'prototype' ? '粘贴包含样式与脚本的完整 HTML…' : '写下正文…'} /></label>
        <div className="creation-meta">{bodySize(body)}</div>
        {scope === 'team' && <PeoplePicker label="可编辑成员" people={people} value={editors} onChange={(value) => update({ editors: value })} disabled={locked} />}
      </div>
      {error && <p className="creation-inline-error" role="alert">{error}</p>}
      {commands.error && <div className="creation-error" role="alert">{commands.error.error}</div>}
      {form.pending && <div className="creation-error" role="status"><span className="creation-grow">{form.receipt ? '原操作已确认，草稿已创建。' : '原操作结果尚未确认，表单已保留。'}</span>{form.receipt ? <Button size="sm" onClick={() => { if (capture()()) { settleCreationForm(form); onCreated(creationId) } }}>打开草稿</Button> : <Button size="sm" disabled={commands.busy} onClick={() => {
        const valid = capture()
        void commands.recover().then((receipt) => {
          if (!valid()) return
          if (receipt && form.command && receipt.result.action === 'create' && receipt.result.creationId === creationId && receipt.commandId === form.command.commandId) { settleCreationForm(form); onCreated(creationId) }
          else if (receipt === null) setError('未找到可核对的原操作，结果仍未确认。')
        })
      }}>核对原操作</Button>}</div>}
      <div className="creation-dialog-footer"><Button variant="ghost" onClick={close}>{form.pending || commands.busy ? '关闭' : '取消'}</Button><Button variant="primary" disabled={locked || !actorId || (scope === 'team' && (!space || space.archived))} onClick={() => void save()}>{commands.busy ? <Loader2 className="creation-spinner" size={15} /> : <Check size={15} />}创建草稿</Button></div>
    </div>
  </Modal>
}

export function PublishCreationDialog({ view, commands, onClose, onPublished, onRefresh }: {
  view: CreationView; commands: Commands; onClose: () => void; onPublished: (revisionId: string) => void; onRefresh: () => void
}): JSX.Element {
  const snapshot = useHifox((state) => state.snapshot)
  const actorId = useHifox((state) => state.workspaceContext.actorId)
  const [spaceId, setSpaceId] = useState(view.summary.spaceId ?? '')
  const [reviewers, setReviewers] = useState<string[]>([])
  const [editors, setEditors] = useState<string[]>([])
  const [changeEditors, setChangeEditors] = useState(false)
  const spaces = snapshot?.spaces.filter((space) => !space.archived && actorId && space.memberIds.includes(actorId) && (!view.summary.spaceId || view.summary.spaceId === space.id)) ?? []
  const space = spaces.find((entry) => entry.id === spaceId)
  const people = snapshot?.members.filter((person) => space?.memberIds.includes(person.id)) ?? []
  const allowed = people.map((person) => person.id)
  const validReviewers = reviewers.filter((id) => allowed.includes(id))
  const validEditors = editors.filter((id) => allowed.includes(id) && id !== view.summary.ownerId)
  const [busy, setBusy] = useState(false)
  const { capture } = useCreationOwner(`publish:${view.summary.creationId}:${view.draft?.revisionId}`)
  return <Modal open ariaLabel="发布评审版" width={540} onClose={onClose}><div className="creation-dialog">
    <div className="creation-section-heading"><h2>发布评审版 R{view.revisions.length + 1}</h2><Button size="sm" variant="ghost" aria-label="关闭" onClick={onClose}><X size={16} /></Button></div>
    <p>{view.summary.title}</p>
    <div className="creation-form-grid"><label>发布空间<Dropdown trigger={({ toggle, open }) => <Button variant="outline" className="creation-space-select" onClick={toggle} aria-expanded={open}>{space?.name ?? '选择空间'}<ChevronDown size={14} /></Button>}>
      {(close) => <>{spaces.map((entry) => <DropdownItem key={entry.id} selected={spaceId === entry.id} onClick={() => { setSpaceId(entry.id); setReviewers([]); setEditors([]); close() }}>{entry.name}</DropdownItem>)}</>}
    </Dropdown></label>
      <PeoplePicker label="邀请评审" people={people} value={validReviewers} onChange={setReviewers} disabled={commands.busy} />
      {actorId === view.summary.ownerId && <><label className="creation-checkbox-label"><input type="checkbox" checked={changeEditors} onChange={(event) => setChangeEditors(event.target.checked)} />更新可编辑成员</label>
        {changeEditors && <PeoplePicker label="可编辑成员（替换原授权）" people={people.filter((person) => person.id !== actorId)} value={validEditors} onChange={setEditors} disabled={commands.busy} />}</>}
    </div>
    <OperationError commands={commands} onRecovered={(receipt) => { if (receipt?.result.action === 'publish') onPublished(receipt.result.revisionId ?? receipt.commandId); else onRefresh() }} onRefresh={onRefresh} />
    <div className="creation-dialog-footer"><Button variant="ghost" onClick={onClose}>取消</Button><Button variant="primary" disabled={!space || commands.busy || commands.recoveryRequired || busy} onClick={() => {
      const valid = capture()
      setBusy(true)
      void commands.run({ action: 'publish', spaceId, reviewerIds: validReviewers, ...(changeEditors && actorId === view.summary.ownerId ? { editorIds: validEditors } : {}) }).then((result) => { if (valid()) { setBusy(false); if (result) onPublished(result.result.revisionId ?? result.commandId) } })
    }}><ArrowUpRight size={15} />发布评审版</Button></div>
  </div></Modal>
}

export function AdoptCreationDialog({ view, commands, onClose, onAdopted, onLoadMore, loadingMore, onRefresh }: {
  view: CreationView; commands: Commands; onClose: () => void; onAdopted: () => void; onLoadMore: () => Promise<void>; loadingMore: boolean
  onRefresh: () => void
}): JSX.Element {
  const snapshot = useHifox((state) => state.snapshot)
  const [taskId, setTaskId] = useState('')
  const [ids, setIds] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const rules = view.comments.filter((comment) => !comment.private && comment.status === 'confirmed' && comment.finalRule && comment.reviewedRevisionId === view.selected.revisionId)
  const earlierRules = view.comments.filter((comment) => !comment.private && comment.status === 'confirmed' && comment.finalRule && comment.reviewedRevisionId !== view.selected.revisionId).length
  const tasks = useMemo(() => snapshot?.tasks.filter((task) => task.spaceId === view.summary.spaceId) ?? [], [snapshot, view.summary.spaceId])
  const selectedTask = tasks.find((task) => task.id === taskId)
  const requiredOpen = view.comments.some((comment) => comment.severity === 'required' && (comment.status === 'open' || (comment.status === 'confirmed' && (!comment.reviewedRevisionId || (view.revisions.find((revision) => revision.revisionId === comment.reviewedRevisionId)?.number ?? Infinity) > (view.selected.number ?? 0)))))
  const { capture } = useCreationOwner(`adopt:${view.summary.creationId}:${view.selected.revisionId}`)
  return <Modal open ariaLabel="采纳到任务" width={560} onClose={onClose}><div className="creation-dialog">
    <div className="creation-section-heading"><h2>采纳到任务</h2><Button size="sm" variant="ghost" aria-label="关闭" onClick={onClose}><X size={16} /></Button></div>
    <div className="creation-row"><span className="my-chip">R{view.selected.number}</span><span className="creation-truncate">{view.selected.title}</span><span className="creation-meta" title={view.selected.bodyDigest}>{view.selected.bodyDigest.slice(0, 10)}</span></div>
    <div className="creation-form-grid"><label>现有任务<Dropdown width={440} trigger={({ toggle, open }) => <Button variant="outline" className="creation-space-select" onClick={toggle} aria-expanded={open}>{selectedTask?.title ?? '选择同空间任务'}<ChevronDown size={14} /></Button>}>
      {(close) => <><div className="creation-task-search"><input className="my-input" aria-label="搜索任务" placeholder="搜索任务…" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
        <div className="creation-task-options my-scrollbar">{tasks.filter((task) => task.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map((task) => <DropdownItem key={task.id} selected={task.id === taskId} onClick={() => { setTaskId(task.id); close() }}>{task.title}</DropdownItem>)}</div>
        {tasks.length === 0 && <p className="creation-meta creation-task-search">此空间暂无任务</p>}</>}
    </Dropdown></label>
      <fieldset className="creation-people-picker"><legend>已确认规则 · 选择本次采用的内容</legend>
        {rules.length === 0 && <p className="creation-meta">此修订暂无已确认规则</p>}
        {earlierRules > 0 && <p className="creation-meta">{earlierRules} 条规则需在 R{view.selected.number} 重新确认后采用</p>}
        {rules.map((comment) => <label className="creation-rule-option" key={comment.commentId}><input type="checkbox" checked={ids.includes(comment.commentId)} onChange={(event) => setIds(event.target.checked ? [...ids, comment.commentId] : ids.filter((id) => id !== comment.commentId))} /><span>{comment.finalRule}<span className="creation-rule-source creation-meta">来源 R{view.revisions.find((entry) => entry.revisionId === comment.revisionId)?.number ?? '?'}{'reviewedRevisionId' in comment && typeof comment.reviewedRevisionId === 'string' ? ` · 确认于 R${view.revisions.find((entry) => entry.revisionId === comment.reviewedRevisionId)?.number ?? '?'}` : ''}</span></span></label>)}
      </fieldset>
      {view.nextCommentOffset !== null && <Button disabled={loadingMore} onClick={() => void onLoadMore()}>{loadingMore ? '正在加载…' : '加载剩余批注后采纳'}</Button>}
      {requiredOpen && <p className="creation-inline-error">请先处理此修订的必须修改意见</p>}
    </div>
    <OperationError commands={commands} onRecovered={onAdopted} onRefresh={onRefresh} />
    <div className="creation-dialog-footer"><Button variant="ghost" onClick={onClose}>取消</Button><Button variant="primary" disabled={!selectedTask || !view.selected.published || commands.busy || commands.recoveryRequired || requiredOpen || view.nextCommentOffset !== null} onClick={() => {
      const valid = capture()
      void commands.run({ action: 'adoptForTask', taskId, revisionId: view.selected.revisionId, confirmedCommentIds: ids.filter((id) => rules.some((comment) => comment.commentId === id)) }).then((result) => { if (result && valid()) onAdopted() })
    }}><Link2 size={15} />固定采用 R{view.selected.number}</Button></div>
  </div></Modal>
}
