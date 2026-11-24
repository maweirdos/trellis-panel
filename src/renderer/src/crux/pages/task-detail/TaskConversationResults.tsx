import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { ArrowUpRight, LockKeyhole, Monitor, RefreshCw, X } from 'lucide-react'
import type { CruxSnapshot, CruxTask } from '@shared/crux'
import { canRestoreLightweightTask } from '@shared/crux-domain/lightweight'
import type { DesignConversationSummary } from '@shared/design-workspace'
import { CREATION_MAX_BODY_BYTES, type CreationCommand } from '@shared/creations'
import { buildDesignPrototype } from '@shared/design-prototype'
import { Button, Modal } from '../../../my/ui'
import { useCrux } from '../../store'
import { conversationError, conversationValue } from '../../../conversations/client'
import { designClient } from '../../../designs/client'
import { openDesign } from '../../../designs/navigation'
import { creationApi, useCreationList } from '../../../creations/hooks'
import { openCreation } from '../../../creations/navigation'
import { stableCommandId } from '../../../utils/stable-command-id'
import { currentOutputReview, submitOutputPatch, TaskOutputReviewInlineActions } from '../../task-output-review/task-output-review'
import { api } from '../../../api'
import { useTaskMutation, useTaskSource } from './use-task-source'
import '../../collaboration.css'

export interface TaskConversationResultsProps {
  task: CruxTask
  actorId?: string
  embedded?: boolean
}

export type SharedTaskCreation = {
  creationId: string
  title: string
  revisionId: string
  bodyDigest: string
  revisionNumber: number
  ownerName: string
}

export function TaskConversationResults({ task, actorId, embedded = false }: TaskConversationResultsProps): JSX.Element | null {
  const snapshot = useCrux((state) => state.snapshot)
  const context = useCrux((state) => state.workspaceContext)
  const source = useTaskSource({ spaceId: task.spaceId, taskId: task.id, embedded })
  const { mutate, error: reviewError } = useTaskMutation(source)
  const conversations = useMemo(() => task.conversations?.filter(link => link.actorId === actorId && !link.id.startsWith('thr_')) ?? [], [task.conversations, actorId])
  const [documents, setDocuments] = useState<DesignConversationSummary[] | null>(null)
  const [readError, setReadError] = useState('')
  const [shareError, setShareError] = useState('')
  const [developmentDesign, setDevelopmentDesign] = useState<DesignConversationSummary>()
  const [shareDraft, setShareDraft] = useState<{ document: DesignConversationSummary; body: string; commandIds: { create: string; publish: string; adopt: string }; creationId: string; state: 'confirm' | 'running'; stage: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const request = useRef(0)
  const creations = useCreationList({ scope: 'team', taskId: task.id, spaceId: task.spaceId, enabled: context.state === 'connected' })
  const sharedCreations = useMemo<SharedTaskCreation[]>(() => (creations.data?.items ?? []).flatMap((creation) => {
    const adoption = creation.adoptions.filter((entry) => entry.taskId === task.id).at(-1)
    return creation.latestPublished && adoption ? [{
      creationId: creation.creationId,
      title: adoption.title,
      revisionId: adoption.revisionId,
      bodyDigest: adoption.bodyDigest,
      revisionNumber: adoption.revisionNumber,
      ownerName: snapshot?.members.find((member) => member.id === creation.ownerId)?.name ?? creation.ownerId
    }] : []
  }), [creations.data, snapshot, task.id])
  const authority = JSON.stringify([context.key, context.state, context.epoch, context.actorId, task.id, task.createdAt, task.spaceId, task.conversations])
  const sourceRef = useRef(source)
  sourceRef.current = source
  const conversationIds = useMemo(() => conversations.map((link) => link.id).join('|'), [conversations])

  const reloadDesigns = useCallback(async (): Promise<void> => {
    const client = designClient()
    const owner = sourceRef.current
    const ticket = owner.ticket()
    const links = conversationsRef.current
    if (!actorId || !links.length) {
      setDocuments([])
      setReadError('')
      return
    }
    if (!client) {
      setDocuments([])
      setReadError('本机设计接口当前不可用。')
      return
    }
    const read = ++request.current
    setBusy(true)
    try {
      const pages = await Promise.allSettled(links.map(async link => {
        const response = await client.listConversation({ conversationId: link.id })
        if (!response.ok && ['E_NOT_FOUND', 'E_DENIED'].includes(response.code)) return []
        return conversationValue(response).filter(document => document.conversationId === link.id)
      }))
      if (owner.owns(ticket) && read === request.current) {
        setDocuments(pages.flatMap(page => page.status === 'fulfilled' ? page.value : []))
        const failed = pages.find(page => page.status === 'rejected')
        setReadError(failed?.status === 'rejected' ? conversationError(failed.reason) : '')
      }
    } catch (cause) {
      if (owner.owns(ticket) && read === request.current) {
        setDocuments([])
        setReadError(conversationError(cause))
      }
    } finally {
      if (owner.owns(ticket) && read === request.current) setBusy(false)
    }
  }, [actorId])

  const conversationsRef = useRef(conversations)
  conversationsRef.current = conversations

  useEffect(() => {
    request.current++
    void reloadDesigns()
    const changed = () => { void reloadDesigns() }
    window.addEventListener('trellis-design-changed', changed)
    return () => { request.current++; window.removeEventListener('trellis-design-changed', changed) }
  }, [authority, conversationIds, reloadDesigns])

  if (!snapshot || !source.available) return null
  if (!conversations.length && !sharedCreations.length && !creations.error) return null
  if (!documents?.length && !sharedCreations.length && !busy && !readError && !creations.error) return null
  const openCanvas = (document: DesignConversationSummary, candidateId?: string): void => {
    if (source.owns()) openDesign(document.id, candidateId)
  }
  const openShared = (creation: SharedTaskCreation): void => {
    if (!context.actorId) return
    openCreation({ workspaceKey: context.key, actorId: context.actorId, creationId: creation.creationId, revisionId: creation.revisionId, scope: 'team', spaceId: task.spaceId })
  }
  const category = snapshot.taskStatuses.find(item => item.id === task.statusId)?.category
  const canRequestReview = (!task.workflow || canRestoreLightweightTask(task)) && category !== 'done' && category !== 'cancelled' && currentOutputReview(task).status !== 'awaiting_review'
  const canPrepareDevelopment = Boolean(actorId && (!task.workflow || canRestoreLightweightTask(task)) &&
    !task.triagePending && task.executor?.kind !== 'agent' && category !== 'done' && category !== 'cancelled')
  const share = async (requestReview: boolean): Promise<void> => {
    const draft = shareDraft
    const client = creationApi()
    const ticket = source.ticket()
    if (!draft || !client || !actorId || !context.epoch || !source.owns(ticket)) return
    const identity = JSON.stringify([context.key, actorId, context.epoch])
    const valid = (): boolean => {
      const live = useCrux.getState().workspaceContext
      return source.owns(ticket) && identity === JSON.stringify([live.key, live.actorId, live.epoch])
    }
    const create: Extract<CreationCommand, { action: 'create' }> = { action: 'create', commandId: draft.commandIds.create, creationId: draft.creationId,
      expectedRevision: null, expectedEpoch: context.epoch, title: draft.document.title, kind: 'prototype', home: 'team', spaceId: task.spaceId, body: draft.body, scenarios: [] }
    setShareDraft({ ...draft, state: 'running', stage: '创建团队草稿…' })
    try {
      const recovery = await client.recover({ workspaceKey: context.key, creationId: draft.creationId })
      if (!valid()) return
      if (!recovery.ok) throw new Error(recovery.error)
      const createReply = await client.command({ workspaceKey: context.key, command: create })
      if (!valid()) return
      if (!createReply.ok) throw new Error(createReply.error)
      setShareDraft({ ...draft, state: 'running', stage: '发布固定版本…' })
      const publishReply = await client.command({ workspaceKey: context.key, command: { action: 'publish', commandId: draft.commandIds.publish, creationId: draft.creationId, expectedRevision: createReply.value.result.revision, spaceId: task.spaceId, reviewerIds: [actorId] } })
      if (!valid()) return
      if (!publishReply.ok) throw new Error(publishReply.error)
      setShareDraft({ ...draft, state: 'running', stage: '固定采用到此任务…' })
      const revisionId = publishReply.value.result.revisionId
      if (!revisionId) throw Error('未收到共享版本编号，请重试。')
      const adoptReply = await client.command({ workspaceKey: context.key, command: { action: 'adoptForTask', commandId: draft.commandIds.adopt, creationId: draft.creationId, expectedRevision: publishReply.value.result.revision, taskId: task.id, revisionId, confirmedCommentIds: [] } })
      if (!valid()) return
      if (!adoptReply.ok) throw new Error(adoptReply.error)
      await creations.refresh()
      if (valid() && requestReview) {
        const receipt = await client.get({ workspaceKey: context.key, creationId: draft.creationId, revisionId })
        if (!valid()) return
        if (!receipt.ok) throw Error(receipt.error)
        const adoption = receipt.value.summary.adoptions.find(item => item.taskId === task.id && item.revisionId === revisionId)
        if (!adoption) throw Error('尚未核对到此任务的共享版本。')
        const patch = submitOutputPatch(task, { ...adoption, creationId: draft.creationId })
        if (patch && !await mutate('提交成果审阅', () => api.crux.updateTask({ id: task.id, patch: { outputReview: patch } }))) {
          setShareDraft(null)
          return
        }
      }
      if (valid()) setShareDraft(null)
    } catch (cause) {
      if (valid()) {
        setShareDraft({ ...draft, state: 'confirm', stage: '' })
        setShareError(cause instanceof Error ? cause.message : '共享此版本失败。')
      }
    }
  }
  const prepareShare = async (document: DesignConversationSummary): Promise<void> => {
    const client = designClient()
    const ticket = source.ticket()
    setShareError('')
    if (!client) {
      setShareError('本机设计接口当前不可用。')
      return
    }
    try {
      const full = conversationValue(await client.get({ documentId: document.id }))
      if (!source.owns(ticket)) return
      if (full.id !== document.id || full.conversationId !== document.conversationId || full.revision !== document.revision || full.sourceError) throw Error('画布版本已变化，请刷新后再共享。')
      const body = buildDesignPrototype({ id: full.id, title: full.title, revision: full.revision, pages: full.pages })
      if (new TextEncoder().encode(body).length > CREATION_MAX_BODY_BYTES) {
        setShareError('完整画布原型超过 256 KiB 发布上限，请先精简内嵌资源。')
        return
      }
      const identity = JSON.stringify(['task-design-share-v1', context.key, context.epoch, actorId, task.spaceId, task.id, task.createdAt, document.id, document.revision])
      const [creationId, create, publish, adopt] = await Promise.all(['creation', 'create', 'publish', 'adopt'].map(action => stableCommandId(`${identity}:${action}`)))
      if (source.owns(ticket)) setShareDraft({ document, body, commandIds: { create, publish, adopt }, creationId, state: 'confirm', stage: '' })
    } catch (cause) {
      if (source.owns(ticket)) setShareError(cause instanceof Error ? cause.message : '读取原画布失败。')
    }
  }

  return <section className="task-conversation-results" aria-label="对话成果">
    <header className="task-conversation-results-header">
      <h3 className="my-item-title">对话成果</h3>
      {busy && <span role="status" className="my-item-description">正在核对…</span>}
      <Button size="sm" variant="ghost" aria-label="重新核对对话成果" disabled={busy} onClick={() => void reloadDesigns()}>
        <RefreshCw size={13} className={busy ? 'animate-spin' : undefined} aria-hidden="true" />
      </Button>
    </header>
    {readError && <p role="alert" className="task-conversation-results-error">{readError}</p>}
    {shareError && <p role="alert" className="task-conversation-results-error">{shareError}</p>}
    {reviewError && <p role="alert" className="task-conversation-results-error">{reviewError}</p>}
    {documents?.map((document) => <article key={document.id} className="task-conversation-result">
      <LockKeyhole size={15} aria-hidden="true" />
      <span className="task-conversation-result-body">
        <span className="my-item-title">{document.title}</span>
        <span className="my-item-description">本机画布 · {document.pageCount} 页{document.candidates.length ? ` · ${document.candidates.length} 个修改候选` : ''}</span>
      </span>
      <Button size="sm" variant="ghost" onClick={() => openCanvas(document)}>查看设计</Button>
      {document.candidates.at(-1) && <Button size="sm" variant="ghost" onClick={() => openCanvas(document, document.candidates.at(-1)?.id)}>查看修改稿</Button>}
      {canPrepareDevelopment && !document.readOnly && !document.sourceError &&
        <Button size="sm" variant="ghost" onClick={() => setDevelopmentDesign(document)}>按此设计开发</Button>}
      {context.state === 'connected' && context.actorId && <Button size="sm" variant="ghost" onClick={() => void prepareShare(document)}>共享此版本</Button>}
    </article>)}
    {sharedCreations.map((creation) => <article key={creation.creationId} className="task-conversation-result">
      <Monitor size={15} aria-hidden="true" />
      <span className="task-conversation-result-body">
        <span className="my-item-title">{creation.title}</span>
        <span className="my-item-description">团队版本 R{creation.revisionNumber} · {creation.ownerName}</span>
      </span>
      <Button size="sm" variant="ghost" onClick={() => openShared(creation)}><ArrowUpRight size={13} aria-hidden="true" />打开版本</Button>
      <TaskOutputReviewInlineActions task={task} actorId={actorId} output={creation} source={source} />
    </article>)}
    {creations.error && <p role="alert" className="task-conversation-results-error">{creations.error.error}</p>}
    {developmentDesign && <Modal open width={520} ariaLabel="按此设计开发" onClose={() => setDevelopmentDesign(undefined)}>
      <section className="space-y-3 p-4">
        <h2 className="my-item-title">按此设计开发</h2>
        <p className="my-item-description break-all">{developmentDesign.title} · {developmentDesign.revision.slice(0, 12)}</p>
        <p className="my-item-description">当前任务入口还不能直接采用本机画布版本并启动开发。可以先把这个固定版本共享到任务。</p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setDevelopmentDesign(undefined)}>返回</Button>
          {context.state === 'connected' && context.actorId && <Button size="sm" variant="primary" onClick={() => {
            setDevelopmentDesign(undefined)
            void prepareShare(developmentDesign)
          }}>准备共享此版本</Button>}
        </div>
      </section>
    </Modal>}
    {shareDraft && context.actorId && <Modal open width={520} ariaLabel="共享设计版本" onClose={() => { if (shareDraft.state !== 'running') setShareDraft(null) }}>
      <div className="space-y-4 p-4">
        <header className="flex items-center gap-2"><h2 className="my-item-title min-w-0 flex-1 break-words">共享此版本</h2><Button size="sm" variant="ghost" aria-label="关闭共享设计" disabled={shareDraft.state === 'running'} onClick={() => setShareDraft(null)}><X size={15} /></Button></header>
        <p className="my-item-description">有权查看此任务的成员将能打开「{shareDraft.document.title}」的这个版本。</p>
        {shareError && <p role="alert" className="collab-inline-error">{shareError}</p>}
        {shareDraft.state === 'running' && <p role="status" className="my-item-description">{shareDraft.stage}</p>}
        {shareDraft.state === 'confirm' && <div className="flex flex-wrap justify-end gap-2"><Button variant={canRequestReview ? 'ghost' : 'primary'} onClick={() => void share(false)}>{canRequestReview ? '仅共享' : '确认共享'}</Button>{canRequestReview && <Button variant="primary" onClick={() => void share(true)}>共享并请审阅</Button>}</div>}
      </div>
    </Modal>}
  </section>
}
