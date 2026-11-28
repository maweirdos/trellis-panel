import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { Check, ChevronRight, FileText, RefreshCw } from 'lucide-react'
import type { GovernanceVersion, TeamGovernanceApi } from '@shared/team-governance'
import type { TaskMaterialInputReference } from '@shared/task-material-inputs'
import type { CruxTaskMaterialsApi } from '@shared/crux-task-materials'
import type { TaskInputBundle, TaskInputCandidates, TaskInputRead } from '@shared/team-task-inputs'
import { Button, Checkbox, DisclosureGrid } from '../../my/ui'
import { TeamMarkdown } from '../../team/TeamMarkdown'
import { Field, textareaClass } from '../ui'
import { Select } from '../../components/Select'
import { GovernanceRecovery, useGovernanceCommands } from './governance-state'

export type TaskInputPanelProps = {
  api: TeamGovernanceApi; workspaceKey: string; spaceId: string; taskId: string; taskCreatedAt: string; canAdopt: boolean;
  actorId?: string; materialsApi?: CruxTaskMaterialsApi; onAdopted?(bundle: TaskInputBundle): void | Promise<void>
  onRead?(inputs: TaskInputRead | null): void
  refreshRevision?: number
  workspaceRevision?: number
}
type Selection = { documents: { documentId: string; versionId: string }[]; rules: { packageId: string; versionId: string }[]; template: { packageId: string; versionId: string } | null }
type Preview = { title: string; previous: { title: string; text: string } | null; selected: { title: string; text: string }; withdrawal: { documentId: string; versionId: string } | null }
const docName = { prd: 'PRD', design: '设计', implement: '实施计划', 'delivery-note': '交付说明' }
const short = (digest: string): string => digest.slice(0, 10)
const same = (a: Selection, b: Selection): boolean => JSON.stringify({ documents: [...a.documents].sort((x, y) => x.documentId.localeCompare(y.documentId)), rules: [...a.rules].sort((x, y) => x.packageId.localeCompare(y.packageId)), template: a.template }) === JSON.stringify({ documents: [...b.documents].sort((x, y) => x.documentId.localeCompare(y.documentId)), rules: [...b.rules].sort((x, y) => x.packageId.localeCompare(y.packageId)), template: b.template })

function InlineDisclosure({ summary, children, className = 'text-my-xs text-my-tertiary' }: { summary: ReactNode; children: ReactNode; className?: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className={className}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex cursor-pointer items-center gap-1 text-left hover:text-my-primary">
        <ChevronRight size={12} className="my-disclosure-chevron shrink-0" data-open={open || undefined} />
        {summary}
      </button>
      <DisclosureGrid open={open} innerClassName="pt-2">
        {children}
      </DisclosureGrid>
    </div>
  )
}

export function TaskInputPanel(props: TaskInputPanelProps): JSX.Element { return <TaskInputs key={`${props.workspaceKey}:${props.spaceId}:${props.taskId}:${props.taskCreatedAt}`} {...props} /> }
function TaskInputs({ api, workspaceKey, spaceId, taskId, taskCreatedAt, canAdopt, actorId, materialsApi, onAdopted, onRead, refreshRevision = 0, workspaceRevision = 0 }: TaskInputPanelProps): JSX.Element {
  const [inputs, setInputs] = useState<TaskInputRead | null>(null), [candidates, setCandidates] = useState<TaskInputCandidates | null>(null)
  const [selection, setSelection] = useState<Selection>({ documents: [], rules: [], template: null }), [selectionRevision, setSelectionRevision] = useState<number | null>(null)
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [review, setReview] = useState(false), [preview, setPreview] = useState<Preview | null>(null), [previewing, setPreviewing] = useState(false), [reason, setReason] = useState('')
  useEffect(() => { onRead?.(loading || error ? null : inputs) }, [inputs, loading, error, onRead])
  const alive = useRef(0), loadId = useRef(0), previewId = useRef(0), initialized = useRef(false)
  const seenRefresh = useRef([refreshRevision, workspaceRevision])
  const scope = { workspaceKey, spaceId, taskId, taskCreatedAt }
  const load = async (resetSelection = false): Promise<void> => {
    const generation = alive.current, requestId = ++loadId.current
    setLoading(true); setError('')
    try {
      const results = await Promise.allSettled([api.inputs(scope), api.candidates(scope)])
      if (generation !== alive.current || requestId !== loadId.current) return
      const a = results[0], b = results[1]
      if (a.status !== 'fulfilled' || b.status !== 'fulfilled') { setError('任务输入暂不可用，请重试。'); return }
      if (!a.value.ok || !b.value.ok) {
        const failure = !a.value.ok ? a.value : !b.value.ok ? b.value : null
        setError(failure?.error ?? '任务输入暂不可用。')
        // A failed authority check must not leave old body content presented as readable.
        setInputs(null); setCandidates(null); setPreview(null)
        return
      }
      const read = a.value.value, available = b.value.value
      setInputs(read); setCandidates(available)
      if (!initialized.current || resetSelection) {
        setSelection(read.current ? { documents: read.current.documents.map(doc => ({ documentId: doc.documentId, versionId: doc.versionId })), rules: read.current.rules.map(rule => ({ packageId: rule.packageId, versionId: rule.versionId })), template: read.current.template ? { packageId: read.current.template.packageId, versionId: read.current.template.versionId } : null } : { documents: available.documents.filter(doc => doc.kind === 'prd').map(doc => ({ documentId: doc.documentId, versionId: doc.versionId })), rules: available.rules.filter(rule => rule.settings.kind === 'rule' && rule.settings.obligation === 'required').map(rule => ({ packageId: rule.packageId, versionId: rule.versionId })), template: null })
        setSelectionRevision(read.revision); initialized.current = true
      }
    } catch { if (generation === alive.current) setError('任务输入暂不可用，请重试。') }
    finally { if (generation === alive.current && requestId === loadId.current) setLoading(false) }
  }
  const commands = useGovernanceCommands(api, { ...scope, lane: 'inputs' }, () => { setReview(false); void load(true) })
  useEffect(() => { alive.current++; void load(); return () => { alive.current++; previewId.current++ } }, [api, workspaceKey, spaceId, taskId, taskCreatedAt])
  useEffect(() => {
    if (seenRefresh.current[0] === refreshRevision && seenRefresh.current[1] === workspaceRevision) return
    seenRefresh.current = [refreshRevision, workspaceRevision]
    setReview(false)
    // Recheck approval/candidates while retaining the original input selection.
    void load()
  }, [refreshRevision, workspaceRevision])
  const current = inputs?.current
  const priorSelection: Selection = { documents: current?.documents.map(doc => ({ documentId: doc.documentId, versionId: doc.versionId })) ?? [], rules: current?.rules.map(rule => ({ packageId: rule.packageId, versionId: rule.versionId })) ?? [], template: current?.template ? { packageId: current.template.packageId, versionId: current.template.versionId } : null }
  const dirty = !same(selection, priorSelection)
  const stale = inputs !== null && selectionRevision !== inputs.revision
  const locked = loading || commands.locked || !canAdopt || !!error
  const docs = [...(candidates?.documents ?? []), ...(current?.documents ?? [])].filter((doc, i, all) => all.findIndex(other => other.documentId === doc.documentId && other.versionId === doc.versionId) === i)
  const rules = [...(candidates?.rules ?? []), ...(current?.rules ?? [])].filter((rule, i, all) => all.findIndex(other => other.packageId === rule.packageId && other.versionId === rule.versionId) === i)
  const templates = [...(candidates?.templates ?? []), ...(current?.template ? [current.template] : [])].filter((template, i, all) => all.findIndex(other => other.packageId === template.packageId && other.versionId === template.versionId) === i)
  const selectedDocs = selection.documents.map(ref => docs.find(doc => doc.documentId === ref.documentId && doc.versionId === ref.versionId)).filter((doc): doc is TaskMaterialInputReference => Boolean(doc))
  const selectedRules = selection.rules.map(ref => rules.find(rule => rule.packageId === ref.packageId && rule.versionId === ref.versionId)).filter((rule): rule is GovernanceVersion => Boolean(rule))
  const selectedTemplate = templates.find(template => template.packageId === selection.template?.packageId && template.versionId === selection.template.versionId)
  const blockers = [...new Set(candidates?.blockers ?? [])]
  const adoptionMissing = (candidates?.documents.some(doc => doc.kind === 'prd') && !selectedDocs.some(doc => doc.kind === 'prd')) || candidates?.rules.some(rule => rule.settings.kind === 'rule' && rule.settings.obligation === 'required' && !selectedRules.some(selected => selected.packageId === rule.packageId && selected.settings.kind === 'rule' && selected.settings.obligation === 'required'))
  const change = (value: Selection): void => { setSelection(value); setReview(false); setPreview(null); previewId.current++ }
  const showDocument = async (doc: TaskMaterialInputReference): Promise<void> => {
    if (typeof api.readDocument !== 'function') { setError('当前客户端尚不支持固定正文比较，请更新客户端后重试。'); return }
    const generation = alive.current, requestId = ++previewId.current, previous = current?.documents.find(item => item.documentId === doc.documentId)
    setPreviewing(true); setPreview(null); setError('')
    const [a, b] = await Promise.allSettled([api.readDocument({ ...scope, reference: doc }), previous && previous.versionId !== doc.versionId ? api.readDocument({ ...scope, reference: previous }) : Promise.resolve(null)])
    if (generation !== alive.current || requestId !== previewId.current) return
    setPreviewing(false)
    if (a.status !== 'fulfilled' || !a.value.ok || b.status === 'rejected' || b.value && !b.value.ok) { setError(a.status === 'fulfilled' && !a.value.ok ? a.value.error : '固定正文无法读取，请核对访问权限。'); return }
    setPreview({ title: doc.title, selected: { title: `${docName[doc.kind]} · ${short(doc.bodyDigest)}`, text: a.value.value.text }, previous: b.value?.ok ? { title: `当前采用 · ${short(previous?.bodyDigest ?? '')}`, text: b.value.value.text } : null, withdrawal: actorId && a.value.value.canWithdraw && previous?.versionId === doc.versionId ? { documentId: doc.documentId, versionId: doc.versionId } : null })
  }
  const showRule = async (ref: GovernanceVersion, previous?: GovernanceVersion): Promise<void> => {
    const generation = alive.current, requestId = ++previewId.current
    setPreviewing(true); setPreview(null); setError('')
    const [a, b] = await Promise.allSettled([api.read({ workspaceKey, spaceId, packageId: ref.packageId, versionId: ref.versionId }), previous && previous.versionId !== ref.versionId ? api.read({ workspaceKey, spaceId, packageId: previous.packageId, versionId: previous.versionId }) : Promise.resolve(null)])
    if (generation !== alive.current || requestId !== previewId.current) return
    setPreviewing(false)
    if (a.status !== 'fulfilled' || !a.value.ok || b.status === 'rejected' || b.value && !b.value.ok) { setError(a.status === 'fulfilled' && !a.value.ok ? a.value.error : '固定正文无法读取，请核对访问权限。'); return }
    setPreview({ title: ref.title, selected: { title: `选择版本 v${ref.number}`, text: a.value.value.text }, previous: b.value?.ok ? { title: `当前采用 v${previous?.number}`, text: b.value.value.text } : null, withdrawal: null })
  }
  const adopt = async (): Promise<void> => {
    if (!inputs || !review || locked || stale || !dirty || blockers.length || adoptionMissing) return
    const generation = alive.current
    const receipt = await commands.submit({ commandId: crypto.randomUUID(), expectedEpoch: inputs.epoch, expectedRevision: inputs.revision, action: 'adopt', spaceId, taskCreatedAt, ...selection })
    if (!receipt || !('taskId' in receipt) || generation !== alive.current) return
    const read = await api.inputs(scope)
    if (generation !== alive.current) return
    if (read.ok && read.value.current) {
      try { await onAdopted?.(read.value.current) }
      catch { if (generation === alive.current) setError('团队输入已采纳；本机衔接未确认，请从原任务核对后继续。') }
    }
  }
  return <section aria-label="任务固定输入" className="my-card min-w-0 space-y-4 p-4">
    <header className="flex flex-wrap items-center gap-2"><FileText size={16} className="text-my-tertiary" /><h3 className="flex-1 text-my-sm font-medium text-my-primary">任务固定输入</h3>{current && <span className="my-chip text-my-secondary">已采纳 r{current.revision}</span>}<Button size="sm" variant="ghost" disabled={loading || commands.busy} onClick={() => { void load(); void commands.refreshPending() }}><RefreshCw size={14} />刷新</Button></header>
    {loading && !inputs && <p role="status" className="text-my-xs text-my-secondary">正在核对任务输入…</p>}
    {error && <p role="alert" className="text-my-xs text-my-danger-text">{error}<Button size="sm" variant="ghost" onClick={() => void load()}>重新核对</Button></p>}
    {inputs && <>
      {inputs.admission.status !== 'ready' && <div role="status" className="space-y-1 rounded-my-base bg-my-layer-1 p-3 text-my-xs text-my-warning-text">{inputs.admission.blockers.map(blocker => <p key={blocker}>{blocker}</p>)}</div>}
      {inputs.legacySummary && <div className="rounded-my-base bg-my-layer-1 p-3"><p className="text-my-xs text-my-secondary">本任务尚无必需共享资料，可使用当前正式任务摘要。</p><p className="mt-2 text-my-sm text-my-primary">{inputs.legacySummary.title}</p><InlineDisclosure className="mt-2 text-my-xs text-my-tertiary" summary="固定摘要信息"><code className="break-all">{inputs.legacySummary.bodyDigest}</code></InlineDisclosure></div>}
      <div className="space-y-4">
        <div><h4 className="mb-2 text-my-xs font-medium text-my-secondary">已批准文档</h4>{docs.length === 0 && <p className="text-my-xs text-my-tertiary">暂无可采用的批准文档。</p>}{[...new Set(docs.map(doc => doc.documentId))].map(documentId => {
          const versions = docs.filter(doc => doc.documentId === documentId), chosen = selection.documents.find(doc => doc.documentId === documentId), latest = versions[0], previous = current?.documents.find(doc => doc.documentId === documentId)
          return <div key={documentId} className="flex min-w-0 flex-wrap items-center gap-2 border-b border-my-line py-2"><label className={`flex min-w-0 basis-full items-center gap-2 text-my-sm text-my-primary sm:basis-auto sm:flex-1 ${locked ? 'cursor-not-allowed' : 'cursor-pointer'}`}><Checkbox disabled={locked} checked={!!chosen} ariaLabel={`${docName[latest.kind]} · ${latest.title}`} onChange={checked => change({ ...selection, documents: checked ? [...selection.documents, { documentId, versionId: latest.versionId }] : selection.documents.filter(doc => doc.documentId !== documentId) })} /><span>{docName[latest.kind]} · {latest.title}</span></label><Select ariaLabel={`${docName[latest.kind]} 固定版本`} size="sm" className="max-w-full text-my-xs sm:w-auto" value={chosen?.versionId ?? latest.versionId} disabled={locked || !chosen} onChange={val => change({ ...selection, documents: selection.documents.map(doc => doc.documentId === documentId ? { documentId, versionId: val } : doc) })} options={versions.map(version => ({ value: version.versionId, label: `${version.versionId === previous?.versionId ? '当前采用' : '已批准候选'} · ${short(version.bodyDigest)}` }))} />{materialsApi && <Button size="sm" variant="ghost" disabled={commands.busy || previewing} onClick={() => void showDocument(versions.find(doc => doc.versionId === chosen?.versionId) ?? latest)}>比较正文</Button>}</div>
        })}</div>
        <div><h4 className="mb-2 text-my-xs font-medium text-my-secondary">团队规则</h4>{rules.length === 0 && <p className="text-my-xs text-my-tertiary">暂无发布规则。</p>}{[...new Set(rules.map(rule => rule.packageId))].map(packageId => {
          const versions = rules.filter(rule => rule.packageId === packageId), chosen = selection.rules.find(rule => rule.packageId === packageId), latest = versions[0], selected = versions.find(rule => rule.versionId === chosen?.versionId) ?? latest
          return <div key={packageId} className="flex min-w-0 flex-wrap items-center gap-2 border-b border-my-line py-2"><label className={`flex min-w-0 basis-full items-center gap-2 text-my-sm text-my-primary sm:basis-auto sm:flex-1 ${locked ? 'cursor-not-allowed' : 'cursor-pointer'}`}><Checkbox disabled={locked} checked={!!chosen} ariaLabel={latest.title} onChange={checked => change({ ...selection, rules: checked ? [...selection.rules, { packageId, versionId: latest.versionId }] : selection.rules.filter(rule => rule.packageId !== packageId) })} /><span>{latest.title}</span><span className="text-my-xs text-my-tertiary">{latest.settings.kind === 'rule' && latest.settings.obligation === 'required' ? '必需' : '建议'}</span></label><Select ariaLabel={`${latest.title} 固定版本`} size="sm" className="max-w-full text-my-xs sm:w-auto" value={selected.versionId} disabled={locked || !chosen} onChange={val => change({ ...selection, rules: selection.rules.map(rule => rule.packageId === packageId ? { packageId, versionId: val } : rule) })} options={versions.map(version => ({ value: version.versionId, label: `v${version.number}${current?.rules.some(rule => rule.versionId === version.versionId) ? ' · 当前采用' : ' · 已发布候选'}` }))} /><Button size="sm" variant="ghost" disabled={commands.busy || previewing} onClick={() => void showRule(selected, current?.rules.find(rule => rule.packageId === packageId))}>比较正文</Button></div>
        })}</div>
        <Field label="流程模板"><Select ariaLabel="任务流程模板" value={selection.template ? `${selection.template.packageId}:${selection.template.versionId}` : ''} disabled={locked} onChange={val => { const template = templates.find(item => `${item.packageId}:${item.versionId}` === val); change({ ...selection, template: template ? { packageId: template.packageId, versionId: template.versionId } : null }) }} options={[{ value: '', label: '沿用当前正式任务阶段' }, ...templates.map(template => ({ value: `${template.packageId}:${template.versionId}`, label: `${template.title} · v${template.number}${current?.template?.versionId === template.versionId ? ' · 当前采用' : ''}` }))]} /></Field>
        {selectedTemplate && <div className="flex flex-wrap items-center gap-2 text-my-xs text-my-secondary"><span className="flex-1">{selectedTemplate.settings.kind === 'workflow-template' && selectedTemplate.settings.nodes.map(node => node.label).join(' → ')}</span><Button size="sm" variant="ghost" disabled={commands.busy || previewing} onClick={() => void showRule(selectedTemplate, current?.template ?? undefined)}>比较流程正文</Button></div>}
      </div>
      {previewing && <p role="status" className="text-my-xs text-my-secondary">正在读取受权固定正文…</p>}
      {preview && <div className="space-y-3 rounded-my-base border border-my-line p-3"><header className="flex items-center gap-2"><h4 className="min-w-0 flex-1 text-my-sm font-medium text-my-primary">{preview.title}</h4><Button size="sm" variant="ghost" onClick={() => { setPreview(null); setReason('') }}>关闭比较</Button></header><div className={`grid gap-4 ${preview.previous ? 'lg:grid-cols-2' : ''}`}>{[preview.previous, preview.selected].filter((item): item is NonNullable<typeof item> => Boolean(item)).map((item, i) => <div key={i} className="min-w-0"><h5 className="mb-2 text-my-xs font-medium text-my-secondary">{item.title}</h5><div className="my-scrollbar max-h-80 overflow-auto"><TeamMarkdown text={item.text} identity={`${workspaceKey}:${taskId}:${item.title}:${i}`} /></div></div>)}</div>{preview.withdrawal && <InlineDisclosure className="border-t border-my-line pt-3 text-my-xs text-my-secondary" summary="撤回该版批准并要求重审"><div className="space-y-2"><p>保留原输入和历史回执，后续执行需要重新审阅。</p><textarea className={textareaClass} aria-label="文档批准撤回原因" maxLength={2000} placeholder="撤回原因" value={reason} onChange={event => setReason(event.target.value)} /><Button size="sm" variant="danger" disabled={commands.locked || !reason.trim()} onClick={() => { if (inputs && preview.withdrawal) void commands.submit({ action: 'withdrawDocument', commandId: crypto.randomUUID(), expectedEpoch: inputs.epoch, expectedRevision: inputs.revision, spaceId, taskCreatedAt, ...preview.withdrawal, reason }) }}>确认撤回批准</Button></div></InlineDisclosure>}</div>}
      {blockers.length > 0 && <div role="alert" className="space-y-1 text-my-xs text-my-warning-text">{blockers.map(blocker => <p key={blocker}>{blocker}</p>)}</div>}
      {stale && <p role="alert" className="text-my-xs text-my-warning-text">共享输入已变更，选择仍保留。<Button size="sm" variant="ghost" disabled={commands.busy} onClick={() => { setSelectionRevision(inputs.revision); setReview(false) }}>已比较，按当前修订继续选择</Button></p>}
      {canAdopt && <div className="flex flex-wrap items-center gap-2 border-t border-my-line pt-3"><Button size="sm" variant="primary" disabled={locked || stale || blockers.length > 0 || !!adoptionMissing || !dirty || !selectedDocs.length && !selectedRules.length && !selectedTemplate} onClick={() => setReview(true)}>比较并采纳</Button>{dirty && <Button size="sm" variant="ghost" disabled={commands.busy} onClick={() => void load(true)}>恢复当前采用选择</Button>}{adoptionMissing && <span className="text-my-xs text-my-warning-text">请选择必需 PRD 与规则。</span>}</div>}
      {review && <div aria-label="确认采纳固定输入" className="space-y-3 rounded-my-base border border-my-line bg-my-layer-1 p-3"><h4 className="text-my-sm font-medium text-my-primary">{current ? `从输入 r${current.revision} 采纳新版本` : '首次采纳固定输入'}</h4><ul className="space-y-1 text-my-xs text-my-secondary">{selectedDocs.map(doc => <li key={doc.documentId}>{docName[doc.kind]} · {doc.title} · {short(doc.bodyDigest)}</li>)}{selectedRules.map(rule => <li key={rule.packageId}>{rule.title} · v{rule.number} · {short(rule.bodyDigest)}</li>)}{selectedTemplate && <li>{selectedTemplate.title} · v{selectedTemplate.number}</li>}</ul><p className="text-my-xs text-my-secondary">旧输入与本机编辑保留；运行中的会话继续使用原输入，新输入在安全边界核对后用于新的执行尝试。</p><div className="flex gap-2"><Button size="sm" variant="primary" disabled={locked || stale || !dirty} onClick={() => void adopt()}><Check size={14} />确认采纳固定输入</Button><Button size="sm" variant="ghost" disabled={commands.busy} onClick={() => setReview(false)}>取消</Button></div></div>}
      {current && <InlineDisclosure summary="当前输入回执"><p className="break-all">{current.bundleId}</p><code className="break-all">{current.digest}</code><p className="mt-1">采纳人 {current.adoptedBy} · {new Date(current.adoptedAt).toLocaleString()}</p></InlineDisclosure>}
    </>}
    <GovernanceRecovery commands={commands} />
  </section>
}
