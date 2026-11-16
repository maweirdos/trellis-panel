import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { BookOpen, GitBranch, Plus, RefreshCw } from 'lucide-react'
import { GOVERNANCE_PRESETS, createEngineeringImplementationPreset, type GovernanceCommand, type GovernanceLessonOrigin, type GovernancePackage, type GovernanceSettings, type GovernanceVersion, type TeamGovernanceApi } from '@shared/team-governance'
import { cruxTaskStageSchema } from '@shared/crux-schema'
import { Button } from '../../my/ui'
import { TeamMarkdown } from '../../team/TeamMarkdown'
import { Field, inputClass, textareaClass, Select } from '../ui'
import { GovernanceRecovery, useGovernanceCommands } from './governance-state'
import { productTaskApi } from '../development/ProductTaskEntry'
import { useInteractionGuard } from '../../utils/interaction-scope'

export type GovernanceLessonSource = Pick<GovernanceLessonOrigin, 'task' | 'artifact'> & { title: string }
export type GovernanceEditorDraft = { base: GovernancePackage | null; epoch: string; title: string; text: string; settings: GovernanceSettings; maintainerIds: string[]; approverIds: string[];
  compared?: { version: GovernanceVersion; text: string }; lessonOrigin?: GovernanceLessonOrigin; promoting?: boolean }
type Editor = GovernanceEditorDraft
export type SpaceGovernancePanelProps = { api: TeamGovernanceApi; workspaceKey: string; spaceId: string; actorId: string; people: { id: string; name: string }[]; canManage: boolean;
  lessonSource?: GovernanceLessonSource; lessonDraft?: Editor | null; onLessonDraftChange?(draft: Editor | null): void; active?: boolean }
const statusLabel: Record<GovernancePackage['status'], string> = { draft: '草稿', review: '待评审', published: '已发布', disabled: '已停用' }
const stageLabel: Record<string, string> = { accepted: '已接受', needs_info: '待补充', design_ready: '待设计', designing: '设计中', design_review: '设计评审', dev_ready: '待开发', planning: '技术规划', developing: '开发中', testing: '测试中', acceptance: '验收中', done: '完成' }
const emptyRule = (): GovernanceSettings => ({ kind: 'rule', applicability: { modules: [], paths: [], stages: [], taskTypeIds: [] }, obligation: 'required', priority: 100, conflictKey: '' })
const preset = (key: 'small-change' | 'standard'): GovernanceSettings => ({ kind: 'workflow-template', preset: key, nodes: GOVERNANCE_PRESETS[key].map(node => ({ ...node, inputs: [...node.inputs], outputs: [...node.outputs] })) })
const split = (value: string): string[] => [...new Set(value.split(/[,，\n]/).map(part => part.trim()).filter(Boolean))]

export function SpaceGovernancePanel(props: SpaceGovernancePanelProps): JSX.Element { return <SpaceGovernance key={`${props.workspaceKey}:${props.spaceId}:${props.actorId}`} {...props} /> }
function SpaceGovernance({ api, workspaceKey, spaceId, actorId, people, canManage, lessonSource, lessonDraft, onLessonDraftChange, active = true }: SpaceGovernancePanelProps): JSX.Element {
  const [packages, setPackages] = useState<GovernancePackage[]>([]), [epoch, setEpoch] = useState(''), [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [localEditor, setLocalEditor] = useState<Editor | null>(null), [accessLocked, setAccessLocked] = useState(false)
  const editor = onLessonDraftChange ? lessonDraft ?? null : localEditor
  const setEditor = (value: Editor | null): void => { if (onLessonDraftChange) onLessonDraftChange(value); else setLocalEditor(value) }
  const [preview, setPreview] = useState<{ version: GovernanceVersion; text: string; pkg: GovernancePackage; epoch: string } | null>(null), [withdraw, setWithdraw] = useState<GovernancePackage | null>(null), [reason, setReason] = useState('')
  const [selecting, setSelecting] = useState(false), [sourceReady, setSourceReady] = useState(false)
  const sourceAvailability = useCallback((ready: boolean): void => setSourceReady(ready), [])
  const canInteract = useInteractionGuard(), activeRef = useRef(active); activeRef.current = active
  const form = useRef<HTMLFormElement>(null)
  const owns = (): boolean => activeRef.current && canInteract()
  const alive = useRef(0), loadId = useRef(0), selectId = useRef(0)
  const load = async (more = false): Promise<void> => {
    if (!owns()) return
    const generation = alive.current, requestId = ++loadId.current
    setLoading(true); setError('')
    try {
      const reply = await api.list({ workspaceKey, spaceId, limit: 24, ...(more && cursor ? { cursor } : {}) })
      if (generation !== alive.current || requestId !== loadId.current || !owns()) return
      if (!reply.ok) { setError(reply.error); if (/FORBIDDEN|UNAUTHORIZED|OWNER|BINDING|GOVERNANCE_UNAVAILABLE|ACCESS_LOCKED/.test(reply.code)) { setPackages([]); setPreview(null); setAccessLocked(true) }; return }
      setPackages(old => more ? [...old, ...reply.value.page.items.filter(pkg => !old.some(prior => prior.packageId === pkg.packageId))] : reply.value.page.items)
      setEpoch(reply.value.epoch); setCursor(reply.value.page.nextCursor); setAccessLocked(false)
    } catch { if (generation === alive.current) setError('空间规则暂不可用，请重试。') }
    finally { if (generation === alive.current && requestId === loadId.current) setLoading(false) }
  }
  const commands = useGovernanceCommands(api, { workspaceKey, spaceId, lane: 'governance' }, () => { void load(); setWithdraw(null); setReason('') })
  useEffect(() => { alive.current++; void load(); return () => { alive.current++; selectId.current++ } }, [api, workspaceKey, spaceId, active])
  useEffect(() => { if (editor && active) form.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true }) }, [editor?.base?.packageId, active])
  const stale = Boolean(editor && (editor.epoch !== epoch || editor.base && packages.find(pkg => pkg.packageId === editor.base?.packageId)?.revision !== editor.base.revision))
  const select = async (pkg: GovernancePackage, editing: boolean, versionId?: string): Promise<void> => {
    if (!owns() || commands.busy || editing && (editor || lessonSource && pkg.kind !== 'rule')) return
    const generation = alive.current, selected = ++selectId.current
    setError(''); setSelecting(true)
    try {
    const reply = await api.read({ workspaceKey, spaceId, packageId: pkg.packageId, ...(versionId ? { versionId } : {}) })
    if (generation !== alive.current || selected !== selectId.current || !owns()) return
    if (!reply.ok) { setError(reply.error); setPreview(null); if (/FORBIDDEN|UNAUTHORIZED|OWNER|BINDING|GOVERNANCE_UNAVAILABLE|ACCESS_LOCKED/.test(reply.code)) { setPackages([]); setAccessLocked(true) }; return }
    const value = reply.value
    if (editing && (value.selected.versionId !== value.package.draft.versionId || value.selected.bodyDigest !== value.package.draft.bodyDigest || lessonSource && value.selected.settings.kind !== 'rule')) { setError('目标草稿已变化，请重新选择当前规范。'); return }
    setPackages(old => old.map(item => item.packageId === value.package.packageId ? value.package : item)); setEpoch(value.epoch)
    if (editing) {
      const origin = lessonSource ? { task: lessonSource.task, artifact: lessonSource.artifact, base: { packageId: value.package.packageId, versionId: value.selected.versionId, bodyDigest: value.selected.bodyDigest, revision: value.package.revision } } : value.selected.lessonOrigin
      setEditor({ base: value.package, epoch: value.epoch, title: value.selected.title, text: value.text, settings: value.selected.settings,
        maintainerIds: value.package.maintainerIds, approverIds: value.package.approverIds, compared: { version: value.selected, text: value.text },
        ...(origin ? { lessonOrigin: origin } : {}), ...(lessonSource ? { promoting: true } : {}) }); setPreview(null)
    } else setPreview({ version: value.selected, text: value.text, pkg: value.package, epoch: value.epoch })
    } catch (cause) { if (generation === alive.current && owns()) setError(cause instanceof Error ? cause.message : '当前草稿读取失败，请重试。') }
    finally { if (generation === alive.current) setSelecting(false) }
  }
  const create = (kind: 'rule' | 'workflow-template'): void => { setEditor({ base: null, epoch, title: '', text: '', settings: kind === 'rule' ? emptyRule() : preset('small-change'), maintainerIds: [actorId], approverIds: [actorId] }); setPreview(null) }
  const save = async (): Promise<void> => {
    if (!owns() || accessLocked || selecting || !editor || lessonSource && (!sourceReady || !editor.base || editor.settings.kind !== 'rule' || !editor.lessonOrigin) || commands.locked || stale || !editor.title.trim() || !editor.text.trim() || !editor.approverIds.length || !editor.maintainerIds.length) return
    const generation = alive.current, selected = ++selectId.current
    const base = { commandId: crypto.randomUUID(), expectedEpoch: editor.epoch, spaceId, title: editor.title, text: editor.text, settings: editor.settings }
    const command: GovernanceCommand = editor.base ? { ...base, action: 'saveDraft', packageId: editor.base.packageId, expectedRevision: editor.base.revision,
      ...(editor.promoting && editor.lessonOrigin ? { lessonOrigin: editor.lessonOrigin } : {}) } : { ...base, action: 'create', maintainerIds: editor.maintainerIds, approverIds: editor.approverIds }
    const receipt = await commands.submit(command)
    if (receipt && 'packageId' in receipt && generation === alive.current && selected === selectId.current && owns()) {
      try {
        const reply = await api.read({ workspaceKey, spaceId, packageId: receipt.packageId, ...(receipt.versionId ? { versionId: receipt.versionId } : {}) })
        if (reply.ok && generation === alive.current && selected === selectId.current && owns()) { if (reply.value.selected.versionId !== reply.value.package.draft.versionId) { setError('草稿保存后又有新修订，请比较当前版本。编辑内容仍保留。'); return }; setEditor({ base: reply.value.package, epoch: reply.value.epoch, title: reply.value.selected.title, text: reply.value.text, settings: reply.value.selected.settings, maintainerIds: reply.value.package.maintainerIds, approverIds: reply.value.package.approverIds,
          compared: { version: reply.value.selected, text: reply.value.text }, ...(reply.value.selected.lessonOrigin ? { lessonOrigin: reply.value.selected.lessonOrigin } : {}), promoting: false }) }
      } catch { if (owns()) setError('草稿已保存，版本暂未读回。请刷新并比较，编辑内容仍保留。') }
    }
  }
  const mutate = (pkg: GovernancePackage, action: 'submit' | 'publish' | 'disable'): void => {
    if (!owns() || commands.locked || !epoch) return
    const base = { commandId: crypto.randomUUID(), expectedEpoch: epoch, spaceId, packageId: pkg.packageId, expectedRevision: pkg.revision }
    void commands.submit(action === 'disable' ? { ...base, action } : { ...base, action, versionId: pkg.draft.versionId })
  }
  const updateSettings = (settings: GovernanceSettings): void => { if (editor) setEditor({ ...editor, settings }) }
  const locked = !active || loading || selecting || commands.locked || Boolean(error) || accessLocked
  return <section aria-label={lessonSource ? '从任务成果沉淀规范' : '空间规则与流程模板'} className="min-w-0 space-y-4 rounded-my-md border border-my-line p-4">
    <header className="flex flex-wrap items-center gap-2"><div className="min-w-44 flex-1"><h3 className="text-my-sm font-medium text-my-primary">{lessonSource ? '选择现有规范' : '规则与流程模板'}</h3>{!lessonSource && <p className="mt-1 text-my-xs text-my-tertiary">发布固定版本，由任务明确采纳。</p>}</div><Button size="sm" variant="ghost" disabled={loading || commands.busy} onClick={() => { void load(); void commands.refreshPending() }}><RefreshCw size={14} />刷新</Button>{canManage && !lessonSource && <><Button size="sm" disabled={locked || !!editor} onClick={() => create('rule')}><Plus size={14} />新建规则</Button><Button size="sm" disabled={locked || !!editor} onClick={() => create('workflow-template')}><GitBranch size={14} />新建流程</Button></>}</header>
    {lessonSource && <div className={editor?.compared ? 'grid min-w-0 gap-3 md:grid-cols-2' : ''}><LessonEvidence origin={lessonSource} workspaceKey={workspaceKey} title={lessonSource.title} active={active && !accessLocked} autoRead onAvailability={sourceAvailability} />
      {editor?.compared && <section aria-label="比较基线" className="min-w-0 space-y-2 rounded-my-md border border-my-line bg-my-layer-1 p-3"><h4 className="my-item-title">比较基线 · {editor.compared.version.title} · v{editor.compared.version.number}</h4><div className="my-scrollbar max-h-56 overflow-auto"><TeamMarkdown text={editor.compared.text} identity={`${spaceId}:${editor.compared.version.versionId}:base`} /></div><details className="text-my-xs text-my-secondary"><summary className="cursor-pointer">基线版本</summary><p className="break-all">{editor.compared.version.versionId}</p><p className="break-all">{editor.compared.version.bodyDigest}</p></details></section>}
    </div>}
    {!active && <p role="status" className="text-my-xs text-my-warning-text">原任务来源已不可操作，请返回原任务核对。编辑内容仍按原来源保留。</p>}
    {loading && !packages.length && <p role="status" className="text-my-xs text-my-secondary">正在读取空间版本…</p>}
    {error && <p role="alert" className="text-my-xs text-my-danger-text">{error}<Button size="sm" variant="ghost" onClick={() => void load()}>重试</Button></p>}
    {!loading && !error && !packages.length && <p className="text-my-sm text-my-tertiary">尚未发布空间规则或流程模板。</p>}
    <ul className="divide-y divide-my-line">{packages.filter(pkg => !lessonSource || pkg.kind === 'rule' && (!editor || pkg.packageId === editor.base?.packageId)).map(pkg => {
      const editable = canManage || pkg.maintainerIds.includes(actorId), publisher = pkg.approverIds.includes(actorId)
      return <li key={pkg.packageId} className="flex min-w-0 flex-wrap items-center gap-3 py-3"><span className="text-my-tertiary">{pkg.kind === 'rule' ? <BookOpen size={17} /> : <GitBranch size={17} />}</span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="text-my-sm font-medium text-my-primary">{pkg.draft.title}</span><span className="my-chip text-my-secondary">{statusLabel[pkg.status]}</span>{pkg.draft.settings.kind === 'rule' && <span className="text-my-xs text-my-tertiary">{pkg.draft.settings.obligation === 'required' ? '必需' : '建议'} · 优先级 {pkg.draft.settings.priority}</span>}</div><p className="mt-1 text-my-xs text-my-tertiary">草稿 v{pkg.draft.number}{pkg.published ? ` · 已发布 v${pkg.published.number}` : ' · 尚未发布'}</p></div><div className="flex w-full flex-wrap gap-1 sm:w-auto"><Button size="sm" variant="ghost" disabled={commands.busy} onClick={() => void select(pkg, false)}>查看草稿</Button>{pkg.published && <Button size="sm" variant="ghost" disabled={commands.busy} onClick={() => void select(pkg, false, pkg.published?.versionId)}>已发布正文</Button>}{editable && <><Button size="sm" disabled={locked || !!editor} onClick={() => void select(pkg, true)}>{lessonSource ? '选择此规范' : '编辑'}</Button>{pkg.status === 'draft' && <Button size="sm" disabled={locked || !!editor} onClick={() => mutate(pkg, 'submit')}>提交评审</Button>}</>}{publisher && pkg.status === 'review' && <Button size="sm" variant="primary" disabled={locked || !!editor} onClick={() => mutate(pkg, 'publish')}>批准并发布</Button>}{!lessonSource && (canManage || pkg.ownerId === actorId) && pkg.published && pkg.status !== 'disabled' && <Button size="sm" variant="ghost" disabled={locked || !!editor} onClick={() => mutate(pkg, 'disable')}>停用</Button>}{!lessonSource && (canManage || pkg.ownerId === actorId) && pkg.published && !pkg.withdrawnVersionIds.includes(pkg.published.versionId) && <Button size="sm" variant="ghost" disabled={locked || !!editor} onClick={() => { setWithdraw(pkg); setReason('') }}>撤回版本</Button>}</div></li>
    })}</ul>
    {cursor && <Button size="sm" disabled={loading || commands.busy} onClick={() => void load(true)}>加载更多</Button>}
    {lessonSource && !loading && !packages.some(pkg => pkg.kind === 'rule') && <p role="status" className="text-my-sm text-my-secondary">此空间尚无可更新的规范，请先在空间设置中建立规则。</p>}
    {preview && <div className="space-y-2 rounded-my-md border border-my-line p-4"><header className="flex items-center gap-2"><h4 className="flex-1 text-my-sm font-medium text-my-primary">{preview.version.title} · v{preview.version.number}</h4><Button size="sm" variant="ghost" onClick={() => setPreview(null)}>关闭预览</Button></header><div className="my-scrollbar max-h-96 overflow-auto"><TeamMarkdown text={preview.text} identity={`${spaceId}:${preview.version.packageId}:${preview.version.versionId}`} /></div><>{preview.version.lessonOrigin && <LessonEvidence origin={preview.version.lessonOrigin} workspaceKey={workspaceKey} active={active && !accessLocked} />}</><details className="text-my-xs text-my-tertiary"><summary>固定版本信息</summary><p className="break-all">{preview.version.bodyDigest}</p><p>{preview.version.byteLength} 字节</p></details></div>}
    {editor && !accessLocked && <form ref={form} aria-label={editor.base ? '编辑规则或流程' : '创建规则或流程'} className="space-y-3 border-t border-my-line pt-4" onSubmit={event => { event.preventDefault(); void save() }}>
      <fieldset disabled={commands.busy || !active} className="min-w-0 space-y-3"><Field label="名称"><input className={inputClass} aria-label="规则或流程名称" required maxLength={300} value={editor.title} onChange={event => setEditor({ ...editor, title: event.target.value })} /></Field>
        {editor.settings.kind === 'rule' ? <RuleSettings settings={editor.settings} change={updateSettings} /> : <WorkflowSettings settings={editor.settings} change={updateSettings} />}
        {!editor.base && <div className="grid gap-3 md:grid-cols-2"><PeoplePicker label="维护人" people={people} selected={editor.maintainerIds} change={maintainerIds => setEditor({ ...editor, maintainerIds })} /><PeoplePicker label="发布审批人" people={people} selected={editor.approverIds} change={approverIds => setEditor({ ...editor, approverIds })} /></div>}
        {!lessonSource && editor.lessonOrigin && <LessonEvidence origin={editor.lessonOrigin} workspaceKey={workspaceKey} active={active && !accessLocked} />}
        <Field label={lessonSource ? '规范修订建议' : '正文'}><textarea className={`${textareaClass} min-h-48 font-mono`} aria-label={lessonSource ? '规范修订建议' : '规则或流程正文'} required maxLength={1024 * 1024} rows={10} value={editor.text} onChange={event => setEditor({ ...editor, text: event.target.value })} /></Field>
        {stale && <div role="alert" className="space-y-2 text-my-xs text-my-warning-text"><p>共享版本已变化，编辑内容仍保留。请先比较当前版本。</p>{editor.base && <Button size="sm" onClick={() => { const pkg = packages.find(item => item.packageId === editor.base?.packageId); if (pkg) void select(pkg, false) }}>比较当前草稿</Button>}{preview && editor.base && preview.version.packageId === editor.base.packageId && preview.version.versionId === preview.pkg.draft.versionId && preview.version.versionId === packages.find(pkg => pkg.packageId === editor.base?.packageId)?.draft.versionId && preview.pkg.revision === packages.find(pkg => pkg.packageId === editor.base?.packageId)?.revision && <Button disabled={commands.locked || !active} size="sm" onClick={() => { if (!owns() || commands.locked) return; setEditor({ ...editor, base: preview.pkg, epoch: preview.epoch, compared: { version: preview.version, text: preview.text }, ...(editor.promoting && editor.lessonOrigin ? { lessonOrigin: { ...editor.lessonOrigin, base: { packageId: preview.pkg.packageId, versionId: preview.version.versionId, bodyDigest: preview.version.bodyDigest, revision: preview.pkg.revision } } } : {}) }) }}>已核对，保留编辑并使用当前修订</Button>}</div>}
        <div className="flex flex-wrap gap-2"><Button size="sm" variant="primary" disabled={locked || stale || Boolean(lessonSource && !sourceReady) || !editor.text.trim() || !editor.title.trim() || !editor.approverIds.length || !editor.maintainerIds.length} onClick={() => void save()}>{commands.busy ? '保存中…' : '保存共享草稿'}</Button><Button size="sm" variant="ghost" disabled={commands.busy} onClick={() => { setEditor(null); setPreview(null) }}>{lessonSource && editor.promoting ? '放弃编辑，重新选择' : '关闭编辑'}</Button></div>
      </fieldset>
    </form>}
    {withdraw?.published && <div className="space-y-3 rounded-my-md border border-my-line p-3" aria-label="撤回已发布版本"><p className="text-my-sm text-my-primary">撤回「{withdraw.published.title}」v{withdraw.published.number}，采用该版的任务将要求重新审阅。</p><Field label="撤回原因"><textarea className={textareaClass} aria-label="撤回原因" value={reason} maxLength={2000} onChange={event => setReason(event.target.value)} /></Field><div className="flex gap-2"><Button size="sm" variant="danger" disabled={commands.locked || !reason.trim()} onClick={() => { if (withdraw.published) void commands.submit({ action: 'withdrawVersion', commandId: crypto.randomUUID(), expectedEpoch: epoch, spaceId, packageId: withdraw.packageId, expectedRevision: withdraw.revision, versionId: withdraw.published.versionId, reason }) }}>确认撤回</Button><Button size="sm" variant="ghost" disabled={commands.busy} onClick={() => setWithdraw(null)}>取消</Button></div></div>}
    <fieldset disabled={!active}><GovernanceRecovery commands={commands} /></fieldset>
  </section>
}

function LessonEvidence({ origin, workspaceKey, title, active, autoRead = false, onAvailability }: {
  origin: Pick<GovernanceLessonOrigin, 'task' | 'artifact'> & Partial<Pick<GovernanceLessonOrigin, 'base'>>; workspaceKey: string; title?: string; active: boolean; autoRead?: boolean; onAvailability?(ready: boolean): void
}): JSX.Element {
  const [text, setText] = useState<string | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const sequence = useRef(0), canInteract = useInteractionGuard()
  const identity = JSON.stringify([workspaceKey, origin.task, origin.artifact])
  useEffect(() => {
    const ticket = ++sequence.current
    setText(null); setError(''); onAvailability?.(false)
    if (!active || !autoRead && !refresh) return
    const client = productTaskApi()
    if (!client) { setError('当前客户端无法读取原成果。'); return }
    setLoading(true)
    void client.artifact({ workspaceKey, spaceId: origin.task.spaceId, taskId: origin.task.taskId, taskCreatedAt: origin.task.taskCreatedAt, ref: origin.artifact })
      .then(reply => {
        if (ticket !== sequence.current || !canInteract()) return
        if (!reply.ok) { setError(reply.error); return }
        const artifact = reply.value.artifact, ref = origin.artifact
        if (artifact.executionId !== ref.executionId || artifact.artifactId !== ref.artifactId || artifact.versionId !== ref.versionId || artifact.bodyDigest !== ref.bodyDigest || artifact.disposition !== 'confirmed') {
          setError('原成果版本不一致，请返回任务核对。'); return
        }
        setText(reply.value.text); onAvailability?.(true)
      }).catch(cause => { if (ticket === sequence.current) setError(cause instanceof Error ? cause.message : '原成果暂不可读。') })
      .finally(() => { if (ticket === sequence.current) setLoading(false) })
    return () => { sequence.current++ }
  }, [identity, active, autoRead, refresh, onAvailability])
  return <section aria-label="规范来源" className="space-y-2 rounded-my-md border border-my-line bg-my-layer-1 p-3">
    <header className="flex flex-wrap items-center gap-2"><h4 className="my-item-title min-w-0 flex-1 break-words">{title ?? `来源任务 ${origin.task.taskId}`}</h4>
      <Button size="sm" variant="ghost" disabled={!active || loading} onClick={() => setRefresh(value => value + 1)}>{loading ? '正在读取…' : text === null ? '阅读原固定成果' : '核对原成果'}</Button>
    </header>
    {text !== null && active && <div className="my-scrollbar max-h-56 overflow-auto"><TeamMarkdown text={text} identity={identity} /></div>}
    {error && <p role="alert" className="text-my-xs text-my-danger-text">{error}</p>}
    <details className="text-my-xs text-my-secondary"><summary className="cursor-pointer">来源版本</summary><dl className="mt-2 space-y-1 break-all">
      <div>任务：{origin.task.taskId}</div><div>执行：{origin.artifact.executionId}</div><div>版本：{origin.artifact.versionId}</div><div>摘要：{origin.artifact.bodyDigest}</div>{origin.base && <><div>比较规则版本：{origin.base.versionId}</div><div>比较修订：{origin.base.revision}</div><div>比较摘要：{origin.base.bodyDigest}</div></>}
    </dl></details>
  </section>
}

function PeoplePicker({ label, people, selected, change }: { label: string; people: SpaceGovernancePanelProps['people']; selected: string[]; change(ids: string[]): void }): JSX.Element {
  return <fieldset className="rounded-my-md border border-my-line p-3"><legend className="px-1 text-my-xs text-my-secondary">{label}</legend><div className="flex flex-wrap gap-3">{people.map(person => <label key={person.id} className="flex items-center gap-2 text-my-xs text-my-secondary"><input type="checkbox" checked={selected.includes(person.id)} onChange={event => change(event.target.checked ? [...selected, person.id] : selected.filter(id => id !== person.id))} />{person.name}</label>)}</div></fieldset>
}
function RuleSettings({ settings, change }: { settings: Extract<GovernanceSettings, { kind: 'rule' }>; change(settings: GovernanceSettings): void }): JSX.Element {
  const [modules, setModules] = useState(settings.applicability.modules.join(', ')), [paths, setPaths] = useState(settings.applicability.paths.join(', '))
  return <div className="grid gap-3 md:grid-cols-2"><Field label="约束级别"><Select ariaLabel="约束级别" value={settings.obligation} onChange={val => change({ ...settings, obligation: val === 'required' ? 'required' : 'recommended' })} options={[{ value: 'required', label: '必需' }, { value: 'recommended', label: '建议' }]} /></Field><Field label="优先级"><input className={inputClass} aria-label="规则优先级" type="number" min={0} max={1000} value={settings.priority} onChange={event => change({ ...settings, priority: Number(event.target.value) })} /></Field><Field label="适用模块（逗号分隔）"><input className={inputClass} aria-label="适用模块" value={modules} onChange={event => setModules(event.target.value)} onBlur={() => change({ ...settings, applicability: { ...settings.applicability, modules: split(modules) } })} /></Field><Field label="代码路径（逗号分隔）"><input className={inputClass} aria-label="代码路径" value={paths} onChange={event => setPaths(event.target.value)} onBlur={() => change({ ...settings, applicability: { ...settings.applicability, paths: split(paths) } })} /></Field><Field label="同类约束标识"><input className={inputClass} aria-label="同类约束标识" maxLength={100} value={settings.conflictKey} onChange={event => change({ ...settings, conflictKey: event.target.value })} /></Field><fieldset className="space-y-2"><legend className="text-my-xs text-my-secondary">适用阶段（未选则适用全程）</legend><div className="flex flex-wrap gap-2">{cruxTaskStageSchema.options.map(stage => <label key={stage} className="flex items-center gap-1 text-my-xs text-my-secondary"><input type="checkbox" checked={settings.applicability.stages.includes(stage)} onChange={event => change({ ...settings, applicability: { ...settings.applicability, stages: event.target.checked ? [...settings.applicability.stages, stage] : settings.applicability.stages.filter(item => item !== stage) } })} />{stageLabel[stage]}</label>)}</div></fieldset></div>
}
function WorkflowSettings({ settings, change }: { settings: Extract<GovernanceSettings, { kind: 'workflow-template' }>; change(settings: GovernanceSettings): void }): JSX.Element {
  const engineering = createEngineeringImplementationPreset()
  const engineeringExecution = JSON.stringify(settings.execution) === JSON.stringify(engineering.execution)
  const selectedPreset = engineeringExecution && settings.preset === 'custom' && JSON.stringify(settings.nodes) === JSON.stringify(engineering.nodes)
    ? 'engineering-implementation' : settings.execution ? 'custom' : settings.preset
  const editNode = (index: number, patch: Partial<typeof settings.nodes[number]>): void => change({ ...settings, preset: 'custom', nodes: settings.nodes.map((node, i) => i === index ? { ...node, ...patch } : node).sort((a, b) => cruxTaskStageSchema.options.indexOf(a.stage) - cruxTaskStageSchema.options.indexOf(b.stage)) })
  return <div className="space-y-3"><Field label="预设流程"><Select ariaLabel="预设流程" value={selectedPreset} onChange={val => { if (val === 'engineering-implementation') change(createEngineeringImplementationPreset()); else if (val === 'small-change' || val === 'standard') change(preset(val as 'small-change' | 'standard')) }} options={[{ value: 'small-change', label: settings.execution ? '小改动（移除工程实施）' : '小改动' }, { value: 'standard', label: settings.execution ? '标准流程（移除工程实施）' : '标准流程' }, { value: 'engineering-implementation', label: '工程实施' }, { value: 'custom', label: '自定义节点' }]} /></Field>{engineeringExecution && <p className="my-item-description">代码文件 · 实施报告 · Codex / Claude</p>}<p className="text-my-xs text-my-secondary">节点沿用正式阶段顺序；输入和必需产物须明确采纳为已批准固定版本。</p><ol className="space-y-3">{settings.nodes.map((node, index) => <li key={`${node.stage}:${index}`} className="space-y-2 rounded-my-md border border-my-line p-3"><div className="flex flex-wrap items-center gap-2"><span className="text-my-xs text-my-tertiary">{index + 1}</span><Select ariaLabel={`节点 ${index + 1} 正式阶段`} className="max-w-40" value={node.stage} onChange={val => editNode(index, { stage: cruxTaskStageSchema.parse(val) })} options={cruxTaskStageSchema.options.map(stage => ({ value: stage, label: stageLabel[stage], disabled: settings.nodes.some((other, i) => i !== index && other.stage === stage) }))} /><input className={`${inputClass} min-w-28 flex-1`} aria-label={`节点 ${index + 1} 名称`} value={node.label} maxLength={100} onChange={event => editNode(index, { label: event.target.value })} /><Button size="sm" variant="ghost" disabled={settings.nodes.length <= 1} onClick={() => change({ ...settings, preset: 'custom', nodes: settings.nodes.filter((_, i) => i !== index) })}>移除</Button></div><div className="grid gap-3 md:grid-cols-3">{(['inputs', 'outputs'] as const).map(field => <fieldset key={field}><legend className="mb-1 text-my-xs text-my-tertiary">{field === 'inputs' ? '固定输入' : '必需产物'}</legend><div className="flex flex-wrap gap-2">{(['prd', 'design', 'implement', 'delivery-note'] as const).map(kind => <label key={kind} className="flex items-center gap-1 text-my-xs text-my-secondary"><input type="checkbox" checked={node[field].includes(kind)} onChange={event => editNode(index, { [field]: event.target.checked ? [...node[field], kind] : node[field].filter(item => item !== kind) })} />{{ prd: 'PRD', design: '设计', implement: '实施计划', 'delivery-note': '交付说明' }[kind]}</label>)}</div></fieldset>)}<Field label="审批角色"><Select ariaLabel={`节点 ${index + 1} 审批角色`} value={node.approvalRole} onChange={val => editNode(index, { approvalRole: val as typeof node.approvalRole })} options={Object.entries({ none: '无需额外审批', product: '产品', design: '设计', development: '开发', testing: '测试', 'space-owner': '空间负责人' }).map(([id, label]) => ({ value: id, label }))} /></Field></div></li>)}</ol><Button size="sm" disabled={settings.nodes.length >= cruxTaskStageSchema.options.length} onClick={() => { const stage = cruxTaskStageSchema.options.find(item => !settings.nodes.some(node => node.stage === item)); if (stage) change({ ...settings, preset: 'custom', nodes: [...settings.nodes, { stage, label: stageLabel[stage], inputs: [], outputs: [], approvalRole: 'none' as const }].sort((a, b) => cruxTaskStageSchema.options.indexOf(a.stage) - cruxTaskStageSchema.options.indexOf(b.stage)) }) }}>添加正式阶段节点</Button></div>
}
