import { useCallback, useEffect, useId, useMemo, useRef, useState, type JSX } from 'react'
import { ChevronRight, CircleAlert, FileText, Loader2, Search, Send, Workflow, X } from 'lucide-react'
import { Button, Modal } from '../my/ui'
import { SavedArtifactModal } from './SavedArtifactModal'
import { KnowledgeSourceView } from '../knowledge/KnowledgeSourceView'
import { knowledgeBridge, knowledgeError, knowledgeUnavailableFor, requireKnowledge, useKnowledgeOwner } from '../knowledge/bridge'
import { useInteractionActive, useInteractionGuard } from '../utils/interaction-scope'
import { projectRootKey } from '../my/navigation'
import { knowledgeOperationDetail, knowledgeOperationLabel } from './knowledge-operations'
import type { AcpSessionRecord } from '../../../shared/types'
import type { KnowledgeArtifact, KnowledgeSource } from '../../../shared/knowledge-access'
import type { RenderItem } from './timeline'

type OperationItem = Extract<RenderItem, { type: 'knowledge-operation' }>

export function KnowledgeOperationRow({ item, session, onOpenTask, suppressWorkingIndicator = false }: { item: OperationItem; session?: AcpSessionRecord; onOpenTask: (taskDir: string) => void; suppressWorkingIndicator?: boolean }): JSX.Element | null {
  const { ev, operation } = item
  const root = ev.projectRoot
  const owner = useKnowledgeOwner(root, ev.sessionId)
  const interactive = useInteractionActive()
  const canInteract = useInteractionGuard()
  const regionId = useId()
  const [expanded, setExpanded] = useState(false)
  const [sources, setSources] = useState<KnowledgeSource[]>([])
  const [reading, setReading] = useState<KnowledgeSource | KnowledgeArtifact | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [savedDocument, setSavedDocument] = useState<KnowledgeArtifact | null>(null)
  const [documentLoading, setDocumentLoading] = useState(false)
  const [documentError, setDocumentError] = useState('')
  const documentSequence = useRef(0)
  const sequence = useRef(0)
  const viewGeneration = session?.connectionGeneration
  const sourceIds = useMemo(() => [...new Set(operation.sourceIds ?? [])], [operation.sourceIds])
  const sourceIdentity = JSON.stringify(sourceIds)
  const payloadIdentity = JSON.stringify([sourceIdentity, operation.artifactId, operation.artifactRevision])
  const active = Boolean(session && session.sessionId === ev.sessionId && projectRootKey(session.projectRoot) === projectRootKey(root))
  const live = active && session?.connectionGeneration === ev.connectionGeneration && session?.turnId === ev.turnId && ['busy', 'awaiting_permission', 'cancelling'].includes(session?.status ?? '')
  const currentView = useRef({ active, generation: viewGeneration, payloadIdentity })
  currentView.current = { active, generation: viewGeneration, payloadIdentity }
  const ownsView = useCallback((): boolean => owner.current() && canInteract() && currentView.current.active && currentView.current.generation === viewGeneration && currentView.current.payloadIdentity === payloadIdentity, [owner.current, canInteract, viewGeneration, payloadIdentity])
  const current = useCallback((token: number): boolean => ownsView() && sequence.current === token, [ownsView])
  useEffect(() => {
    sequence.current++; documentSequence.current++; setReading(null); setSources([]); setError(''); setLoading(false); setSavedDocument(null); setDocumentError(''); setDocumentLoading(false)
    return () => { sequence.current++; documentSequence.current++ }
  }, [owner.current, viewGeneration, sourceIdentity, operation.artifactId, operation.artifactRevision])
  useEffect(() => { if (!interactive || !active) { sequence.current++; documentSequence.current++; setReading(null); setExpanded(false); setLoading(false); setDocumentLoading(false) } }, [interactive, active])

  const loadSources = useCallback(async (): Promise<void> => {
    if (!owner.current() || !canInteract() || !active) return
    const token = ++sequence.current
    const bridge = knowledgeBridge(['source'])
    if (!bridge) { setError(knowledgeUnavailableFor('知识来源阅读')); return }
    setLoading(true); setError('')
    try {
      const responses = await Promise.allSettled(sourceIds.map(async (sourceId) => {
        const source = requireKnowledge(await bridge.source({ ...owner.input, sourceId }))
        const documentEvidence = ['save_document', 'publish_document', 'handoff'].includes(operation.kind)
        if (source.id !== sourceId || source.sessionId !== ev.sessionId || (source.turnId !== ev.turnId && (!documentEvidence || !source.suppliedToAgent))) throw new Error('资料所属会话或轮次已改变，请重新核对来源。')
        return source
      }))
      if (!current(token)) return
      setSources(responses.flatMap((response) => response.status === 'fulfilled' ? [response.value] : []))
      const failed = responses.find((response) => response.status === 'rejected')
      if (failed?.status === 'rejected') setError(knowledgeError(failed.reason, '知识来源阅读'))
    } finally { if (current(token)) setLoading(false) }
  }, [owner.current, owner.input, canInteract, active, sourceIds, ev.sessionId, ev.turnId, operation.kind, current])
  const readSavedDocument = useCallback(async (open = false): Promise<void> => {
    if (!operation.artifactId || !operation.artifactRevision || !owner.current() || !canInteract() || !active) return
    const bridge = knowledgeBridge(['artifact'])
    if (!bridge) { setDocumentError(knowledgeUnavailableFor('需求文档阅读')); return }
    const token = ++documentSequence.current
    setDocumentLoading(true); setDocumentError('')
    try {
      const artifact = requireKnowledge(await bridge.artifact({ ...owner.input, artifactId: operation.artifactId, revision: operation.artifactRevision }))
      if (!ownsView() || documentSequence.current !== token) return
      if (artifact.id !== operation.artifactId || artifact.revision !== operation.artifactRevision) throw new Error('文档身份或版本不匹配，请核对保存结果。')
      setSavedDocument(artifact)
      if (open) setReading(artifact)
    } catch (failure) { if (ownsView() && documentSequence.current === token) setDocumentError(knowledgeError(failure, '需求文档阅读')) }
    finally { if (ownsView() && documentSequence.current === token) setDocumentLoading(false) }
  }, [operation.artifactId, operation.artifactRevision, owner.current, owner.input, canInteract, active, ownsView])
  useEffect(() => {
    if (interactive && active && operation.phase === 'completed' && operation.artifactId && operation.artifactRevision) void readSavedDocument()
  }, [interactive, active, operation.phase, operation.artifactId, operation.artifactRevision, readSavedDocument])
  const openDocument = (): void => {
    if (!ownsView()) return
    if (savedDocument) setReading(savedDocument)
    else if (!documentLoading) void readSavedDocument(true)
  }
  const label = knowledgeOperationLabel(operation, live)
  const problem = ['failed', 'uncertain', 'needs_clarification', 'cancelled'].includes(operation.phase) || ['partial', 'not_configured', 'denied', 'unavailable', 'cancelled'].includes(operation.status ?? '') || operation.persistence === 'degraded'
  const Icon = problem ? CircleAlert : operation.kind === 'search' ? Search : operation.kind === 'publish_document' ? Send : operation.kind === 'handoff' ? Workflow : FileText
  const detail = knowledgeOperationDetail(operation)
  const hasDetails = Boolean(sourceIds.length || detail || operation.query || operation.relativePath || operation.publicationId || operation.taskDir)
  const documentReady = operation.phase === 'completed' && operation.artifactId && operation.artifactRevision
  const primaryDocument = documentReady && (operation.kind === 'save_document' || operation.kind === 'read')
  if (operation.phase === 'running' && live && suppressWorkingIndicator) return null
  const sourceLink = (source: KnowledgeSource): JSX.Element => <button type="button" key={source.id} className="acp-knowledge-source-link" onClick={() => { if (owner.current() && canInteract()) setReading(source) }}><FileText size={13} aria-hidden="true" /><span>{source.title}</span><span className="text-my-tertiary">{source.kind === 'weknora' ? '项目知识库' : '项目文件'} · {source.mode === 'full' ? '全文' : source.mode === 'unsupported' ? '不支持全文' : '摘录'}</span></button>
  const documentEntry = (): JSX.Element => <button type="button" className="acp-saved-document-entry" disabled={documentLoading || !active || !interactive} title={savedDocument?.relativePath} aria-label={savedDocument ? `${savedDocument.title}，Markdown 文档` : undefined} onClick={openDocument}>{primaryDocument && <FileText size={14} aria-hidden="true" />}<span className="acp-saved-document-name">{savedDocument ? savedDocument.title : documentLoading ? '正在读取文档名称…' : '重试读取已保存文档'}</span>{savedDocument && <span className="acp-saved-document-format" aria-hidden="true">MD</span>}</button>
  return <section data-acp-item={item.key} data-knowledge-operation={operation.operationId} className={`acp-knowledge-operation${problem ? ' is-attention' : ''}`}>
    <div className="acp-knowledge-operation-summary">
      {primaryDocument && documentEntry()}
      <button type="button" className="acp-knowledge-operation-toggle" disabled={!hasDetails} aria-label={primaryDocument ? `${label}，来源与保存信息` : undefined} aria-expanded={hasDetails ? expanded : undefined} aria-controls={hasDetails ? regionId : undefined} onClick={() => {
        if (!canInteract()) return
        setExpanded(!expanded)
        if (!expanded && sourceIds.length && !sources.length && !loading) void loadSources()
      }}>
        {!primaryDocument && (operation.phase === 'running' && live ? <Loader2 size={14} className="acp-progress-spinner" aria-hidden="true" /> : <Icon size={14} aria-hidden="true" />)}
        <span className={primaryDocument ? 'sr-only' : undefined}>{label}</span>
        {operation.query && <span className="acp-knowledge-operation-query" title={operation.query}>{operation.query}</span>}
        {hasDetails && <ChevronRight size={12} className={expanded ? 'is-open' : ''} aria-hidden="true" />}
      </button>
      {documentReady && !primaryDocument && documentEntry()}
      {operation.phase === 'completed' && operation.taskDir && <Button size="sm" variant="ghost" disabled={!active || !interactive} onClick={() => { if (operation.taskDir && owner.current() && canInteract()) onOpenTask(operation.taskDir) }}>查看任务</Button>}
    </div>
    {error && !expanded && <p role="alert" className="acp-knowledge-operation-details text-my-warning-text">{error}</p>}
    {documentError && <p role="alert" className="acp-knowledge-operation-details text-my-warning-text">{documentError}</p>}
    <div id={regionId} hidden={!expanded} className="acp-knowledge-operation-details">
      {detail && <p>{detail}</p>}
      {operation.relativePath && <p className="break-all">{operation.relativePath}</p>}
      {operation.artifactRevision && <p className="text-my-tertiary">已保存版本：{operation.artifactRevision.slice(0, 12)}</p>}
      {operation.taskDir && <p className="break-all">开发任务：{operation.taskDir}</p>}
      {operation.publicationId && <p className="break-all text-my-tertiary">发布记录：{operation.publicationId}</p>}
      {loading && <p>正在读取资料记录…</p>}
      {sources.length > 0 && <div aria-label="本次检索资料">{sources.map(sourceLink)}</div>}
      {error && <p role="alert" className="text-my-warning-text">{error}</p>}
    </div>
    {interactive && active && reading && !('sourceHandle' in reading) && <SavedArtifactModal key={`${reading.id}:${reading.revision}:${viewGeneration}`} root={root} sessionId={ev.sessionId ?? ''} artifact={reading} isCurrent={ownsView} onClose={() => setReading(null)} />}
    {interactive && active && reading && 'sourceHandle' in reading && <Modal open onClose={() => setReading(null)} width={760} ariaLabel={`知识来源：${reading.title}`}>
      <header className="flex items-center gap-3 border-b border-my-line px-4 py-3"><h2 className="min-w-0 flex-1 truncate text-my-md font-semibold">{reading.title}</h2><Button size="sm" variant="ghost" aria-label="关闭阅读" onClick={() => setReading(null)}><X size={16} /></Button></header>
      <div className="my-scrollbar max-h-[70vh] overflow-y-auto p-4"><KnowledgeSourceView root={root} sessionId={ev.sessionId} initial={reading} /></div>
    </Modal>}
  </section>
}
