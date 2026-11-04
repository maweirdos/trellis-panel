import { useEffect, useMemo, useRef, useState } from 'react'
import {
  REQUIREMENT_BODY_BYTES, REQUIREMENT_TEMPLATE, hasRequirementContent, requirementAdoptSchema, requirementCommitSchema, requirementConfirmSchema, requirementCreateSuccessorSchema,
  requirementRunSchema, requirementSavePlanSchema, requirementSaveSchema, requirementApplySelectionSchema, requirementResolveConflictSchema,
  type ConversationRequirementsApi, type RequirementAction, type RequirementDocument,
  type RequirementFileSelection, type RequirementObservation, type RequirementOperation,
  type RequirementQuestion, type RequirementReceipt, type RequirementTargetSelection, type RequirementView, type RequirementCommit, type RequirementRun, type RequirementRunResult
} from '@shared/conversation-requirements'
import type { RequirementKnowledgeSelection, RequirementKnowledgeSourceRef } from '@shared/conversation-requirement-knowledge'
import { emptyRequirementDesignContext, requirementDesignContextSchema, type RequirementDesignContext } from '@shared/requirement-design-context'
import type { ProjectSnapshot, TimelineEvent } from '@shared/types'
import { confirmDialog } from '../../components/Dialogs'
import { projectRootKey } from '../../my/navigation'
import { useInteractionActive, useInteractionGuard, useInteractionSignal } from '../../utils/interaction-scope'
import { conversationClient, conversationError, conversationValue } from '../client'
import { isPrivateEntrySelected } from '../source'
import { ensureConversation, readConversation, refreshFiles, saveDraft, sessionRunning, useConversations, type WorkspaceEntry } from '../workspace'
import type { DocumentEditorSelection } from './DocumentEditor'
import type { RequirementBuildChoice } from './BuildPreparation'
import {
  acceptWorkbenchView, acquireWorkbench, assertWorkbenchView, assertWorkbenchSuccessor, designHandoffKey, findWorkbench, isDocumentEditInstruction, notifyWorkbench, operationPending, planSourceSignature, planSourcesMatch,
  persistWorkbenchCommands, persistWorkbenchSuccessor, readWorkbenchSuccessor, workbenchSuccessorCommandId, flushWorkbenchDraft, scheduleWorkbenchDraft, planDirty, projectRequirementEvents, rememberObservation, requirementDirty,
  restoreWorkbenchCommands, restoreWorkbenchDraft, settleWorkbenchCommands, selectionReceiptIsCurrent, selectionRejectionProven, selectionVersionMatches, subscribeWorkbench, workbenchDirty, workbenchFileSaveBlock, runRejectionProven,
  type WorkbenchBuffer, type WorkbenchIssue, type WorkbenchQuote
} from './workbench-state'

export interface RequirementWorkbenchOptions {
  entryKey: string
  requirementId?: string
  createCommandId: string
  onOpenTask(result: { snapshot: ProjectSnapshot; taskDir: string }): void | Promise<void>
  onStartTrellis?(result: { snapshot: ProjectSnapshot; taskDir: string; draftId: string; agentId?: string; planRevision?: string }): void | Promise<void>
  onPrepareBuild?(result: RequirementBuildPreparation): Promise<RequirementBuildChoice | null>
  onOpenSuccessor?(result: { draftId: string; commandId: string }): void | Promise<void>
}
export type RequirementBuildPreparation = Pick<RequirementCommit, 'expectedRevision' | 'expectedPlanRevision' | 'knowledgeSources' | 'directKnowledge' | 'designSources'> & { draftId: string }
interface SourceFence { conversationId: string; current(): boolean; ownsBuffer(): boolean; interactive(): boolean }
export interface RequirementWorkbenchController {
  current?: WorkspaceEntry
  buffer?: WorkbenchBuffer
  view?: RequirementView
  issue?: WorkbenchIssue
  loading: boolean
  active: boolean
  readOnly: boolean
  busy: boolean
  assistantPending: boolean
  canRun: boolean
  dirty: boolean
  requirementDirty: boolean
  planDirty: boolean
  planStale: boolean
  events: TimelineEvent[]
  questions: RequirementQuestion[]
  candidates: RequirementObservation[]
  pendingOperations: RequirementOperation[]
  comparison?: RequirementObservation
  nextLabel: string
  nextDisabled: boolean
  editTitle(title: string): void
  editBody(body: string): void
  editDocumentBody(document: RequirementDocument, body: string): void
  setDocument(document: RequirementDocument): void
  setText(text: string): void
  appendInstruction(action: RequirementAction, text: string): void
  setTextAction(action: RequirementAction | undefined): void
  setFromConversation(checked: boolean): void
  setKnowledge(selection: RequirementKnowledgeSelection | undefined, sources: RequirementKnowledgeSourceRef[]): void
  setHandoffSource(key: string, included: boolean): void
  setDesignContext(context: RequirementDesignContext): void
  quote(selection: DocumentEditorSelection, polish?: boolean): boolean
  editSelection(selection: DocumentEditorSelection): Promise<string>
  selectionApplied(selection: DocumentEditorSelection, replacement: string, body: string): Promise<void>
  clearQuote(): void
  answer(id: string, text: string): void
  toggleReference(reference: RequirementFileSelection, checked: boolean): void
  importInput(): void
  save(): Promise<void>
  reload(): Promise<void>
  useRemote(): Promise<void>
  keepLocal(): Promise<void>
  syncFile(): Promise<void>
  resolveFileConflict(document: RequirementDocument, decision: 'keep-local' | 'use-file'): Promise<void>
  resolvePendingSave(): Promise<void>
  runAction(action: RequirementAction): Promise<void>
  submitAnswers(): Promise<void>
  checkOperations(): Promise<void>
  resumeOperation(): Promise<void>
  compare(operationId?: string): void
  adopt(operationId: string): Promise<void>
  next(): Promise<void>
  beginBuild(): Promise<void>
  openSuccessor(): Promise<void>
  selectTarget(selection?: RequirementTargetSelection): Promise<void>
  commit(): Promise<void>
  openTask(start?: boolean): Promise<void>
  refreshFiles(): void
}

function requirementsApi(): ConversationRequirementsApi {
  const client = conversationClient()
  if (!client?.requirements) throw new Error('需求接口暂不可用，请重试。')
  return client.requirements
}
const versions = (value: WorkbenchBuffer): { requirementVersion: number; planVersion: number } => ({ requirementVersion: value.requirementVersion, planVersion: value.planVersion })
const unchanged = (value: WorkbenchBuffer, captured: ReturnType<typeof versions>): boolean => value.requirementVersion === captured.requirementVersion && value.planVersion === captured.planVersion
function validateBody(body: string): void {
  if (body.length > 200_000 || new TextEncoder().encode(body).byteLength > REQUIREMENT_BODY_BYTES) throw new Error('文档最多 256 KiB，请缩短后保存。')
}
function currentRevision(value: WorkbenchBuffer, document: RequirementDocument): string | undefined {
  return document === 'requirement' ? value.view?.draft.bodyRevision : value.view?.draft.plan?.bodyRevision
}
function selectionAnchor(selection: DocumentEditorSelection, body: string): WorkbenchQuote['anchor'] {
  const mapped = selection.markdownAnchor
  const anchor = mapped ?? (selection.positionKind === 'markdown' ? { kind: 'markdown' as const, from: selection.from, to: selection.to } : undefined)
  if (!anchor || anchor.kind !== 'markdown' || !Number.isInteger(anchor.from) || !Number.isInteger(anchor.to) || anchor.from < 0 || anchor.to <= anchor.from || anchor.to > body.length || body.slice(anchor.from, anchor.to) !== selection.text) return undefined
  const split = (at: number): boolean => at > 0 && at < body.length && /[\uD800-\uDBFF]/.test(body[at - 1]) && /[\uDC00-\uDFFF]/.test(body[at])
  return split(anchor.from) || split(anchor.to) ? undefined : anchor
}
function acceptReceipt(value: WorkbenchBuffer, receipt: RequirementReceipt): void {
  const command = value.commitCommand, draft = value.view?.draft
  if (!command || !draft || receipt.draftId !== draft.id || receipt.commandId !== command.commandId || receipt.draftRevision !== command.expectedRevision || receipt.targetId !== command.targetId || receipt.task && projectRootKey(receipt.task.root) !== projectRootKey(draft.target?.root)) throw new Error('任务交接回执来源不匹配，请核对原交接。')
  value.receipt = receipt
  settleWorkbenchCommands(value)
}

export function useRequirementWorkbench({ entryKey, requirementId, createCommandId, onOpenTask, onStartTrellis, onPrepareBuild, onOpenSuccessor }: RequirementWorkbenchOptions): RequirementWorkbenchController {
  const current = useConversations(state => state.entries[entryKey])
  const active = useInteractionActive(), canInteract = useInteractionGuard(), signal = useInteractionSignal()
  const [buffer, setBuffer] = useState<WorkbenchBuffer>(), [loadIssue, setLoadIssue] = useState<WorkbenchIssue>(), [attempt, setAttempt] = useState(0)
  const [, render] = useState(0), mounted = useRef(true)
  const identity = JSON.stringify([entryKey, requirementId, createCommandId, current?.owner, current?.conversation?.id, current?.conversation?.creatorId, current?.conversation?.workspace.root, current?.conversation?.nativeRef?.sessionId, current?.session?.connectionGeneration, current?.locked, active])
  const displayIdentity = JSON.stringify([entryKey, requirementId, createCommandId, current?.owner, current?.conversation?.id, current?.conversation?.creatorId, current?.conversation?.workspace.root, current?.locked, active])
  const displayOwner = useRef({ identity: displayIdentity, signal })
  if (displayOwner.current.identity !== displayIdentity || displayOwner.current.signal !== signal) displayOwner.current = { identity: displayIdentity, signal }
  const renderedOwner = displayOwner.current
  const live = useRef({ identity, displayIdentity, signal })
  if (live.current.identity !== identity || live.current.signal !== signal) live.current = { identity, displayIdentity, signal }
  const confirmation = useRef<AbortController>()
  const selectionResults = useRef(new Map<string, { selection: DocumentEditorSelection; operation: RequirementOperation; replacement: string; documentRevision: string; target: WorkbenchBuffer; sourceCurrent(): boolean }>())
  const selectionStarting = useRef(false)
  useEffect(() => subscribeWorkbench(() => render(value => value + 1)), [])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; confirmation.current?.abort() } }, [])
  useEffect(() => () => confirmation.current?.abort(), [identity, signal])

  const capture = (): SourceFence => {
    const original = useConversations.getState().entries[entryKey], captured = live.current, capturedDisplay = displayOwner.current
    if (!original?.conversation || original.locked || !canInteract() || !isPrivateEntrySelected(entryKey)) throw new Error('请返回原会话后继续。')
    const conversation = original.conversation
    const ownsBuffer = (): boolean => {
      const latest = useConversations.getState().entries[entryKey]
      return !latest?.locked && latest?.owner === original.owner && latest?.conversation?.id === conversation.id && latest.conversation.creatorId === conversation.creatorId && projectRootKey(latest.conversation.workspace.root) === projectRootKey(conversation.workspace.root)
    }
    const interactive = (): boolean => mounted.current && displayOwner.current === capturedDisplay && canInteract() && isPrivateEntrySelected(entryKey) && ownsBuffer()
    return { conversationId: conversation.id, ownsBuffer, interactive, current: () => {
      const latest = useConversations.getState().entries[entryKey]
      return interactive() && live.current === captured && latest?.conversation?.nativeRef?.sessionId === conversation.nativeRef?.sessionId && latest?.session?.connectionGeneration === original.session?.connectionGeneration
    } }
  }
  const value = current?.conversation && findWorkbench(current.conversation, requirementId ?? '', createCommandId) === buffer ? buffer : undefined
  const view = value?.view
  useEffect(() => {
    if (!value) return
    const flush = (): void => { try { flushWorkbenchDraft(value) } catch (cause) { value.issue = { kind: 'save', message: `本地恢复稿保存失败：${conversationError(cause)}` }; notifyWorkbench() } }
    const hidden = (): void => { if (document.visibilityState === 'hidden') flush() }
    window.addEventListener('pagehide', flush); window.addEventListener('beforeunload', flush); document.addEventListener('visibilitychange', hidden)
    return () => { window.removeEventListener('pagehide', flush); window.removeEventListener('beforeunload', flush); document.removeEventListener('visibilitychange', hidden); flush() }
  }, [value])
  const lockedReceipt = value?.receipt ?? view?.draft.handoff
  const readonly = Boolean(current?.locked || current?.conversation?.archivedAt !== undefined || lockedReceipt && lockedReceipt.state !== 'not-admitted' || value?.commitCommand)

  const read = async (target: WorkbenchBuffer, fence: SourceFence): Promise<void> => {
    const api = requirementsApi(), id = target.view?.draft.id ?? requirementId
    const incoming = conversationValue(id ? await api.read(fence.conversationId, id) : await api.create(fence.conversationId, { commandId: createCommandId, body: REQUIREMENT_TEMPLATE }))
    if (!fence.current()) return
    assertWorkbenchView(target, incoming)
    if (id && incoming.draft.id !== id) throw new Error('需求标识不匹配。')
    acceptWorkbenchView(target, incoming)
    restoreWorkbenchDraft(target)
    if (!target.selectionCommand) restoreWorkbenchCommands(target)
    if (target.commandIssue) return
    const receipt = target.receipt
    if (!target.commitCommand && receipt && receipt.state !== 'created' && receipt.state !== 'not-admitted') { target.commandIssue = '原交接请求记录缺失，无法核对当时授权的知识来源。请检查原任务与交接记录，勿重新创建。'; return }
    if (!target.selectionCommand) settleWorkbenchCommands(target)
    target.issue = undefined
    if (target.operations.some(operationPending) && fence.current()) void readConversation(entryKey)
  }
  useEffect(() => {
    if (!active) return
    let disposed = false
    setLoadIssue(undefined)
    const load = async (): Promise<void> => {
      if (!current?.conversation) { await ensureConversation(entryKey); return }
      const fence = capture(), target = acquireWorkbench(current.conversation, requirementId, createCommandId)
      if (disposed || !fence.current()) return
      setBuffer(target)
      if (target.task) { await target.task; if (disposed || !fence.current()) return }
      if (target.pending) return
      target.pending = 'read'; notifyWorkbench()
      const task = read(target, fence)
      target.task = task
      try { await task } finally { if (target.task === task) { target.pending = undefined; target.task = undefined }; notifyWorkbench() }
    }
    void load().catch(cause => { if (!disposed && mounted.current && canInteract()) setLoadIssue({ kind: 'load', message: conversationError(cause) }) })
    return () => { disposed = true }
  }, [identity, attempt])

  const perform = async (kind: WorkbenchIssue['kind'], pending: string, action: (target: WorkbenchBuffer, api: ConversationRequirementsApi, fence: SourceFence) => Promise<void>, propagate = false): Promise<void> => {
    if (!value || value.pending || !canInteract() || displayOwner.current !== renderedOwner) { if (propagate) throw new Error('原会话暂不可操作，请检查原应用。'); return }
    let fence: SourceFence
    try { fence = capture() } catch (cause) { value.issue = { kind, message: conversationError(cause) }; notifyWorkbench(); if (propagate) throw cause; return }
    value.pending = pending; value.issue = undefined; notifyWorkbench()
    if (kind === 'load') setLoadIssue(undefined)
    const task = (async () => action(value, requirementsApi(), fence))()
    value.task = task
    try { await task }
    catch (cause) { if (fence.current()) value.issue = { kind, message: conversationError(cause) }; if (propagate) throw cause }
    finally { if (value.task === task) { value.pending = undefined; value.task = undefined }; try { flushWorkbenchDraft(value) } catch (cause) { value.issue = { kind: 'save', message: `本地恢复稿保存失败：${conversationError(cause)}` } }; notifyWorkbench() }
  }
  const assertEditable = (target: WorkbenchBuffer): void => {
    const receipt = target.receipt ?? target.view?.draft.handoff
    if (!target.view || receipt && receipt.state !== 'not-admitted' || target.commitCommand || target.commandIssue || current?.conversation?.archivedAt !== undefined) throw new Error('此需求暂不可编辑，请先核对交接状态。')
    if (target.selectionCommand) throw new Error('请先核对上次选区应用回执。')
    if (target.view.pendingSave) throw new Error('上次保存中断，请先核对并恢复待保存内容。')
    if (target.remote) throw new Error('需求已有新版本，请先比较并处理本地修改。')
  }
  const saveAll = async (target: WorkbenchBuffer, api: ConversationRequirementsApi, fence: SourceFence, includePlan = true): Promise<boolean> => {
    assertEditable(target)
    const blocked = target.view && workbenchFileSaveBlock(target.view, includePlan)
    if (blocked) throw new Error(blocked)
    const captured = versions(target)
    if (requirementDirty(target) && target.view) {
      const previous = target.view.draft, body = target.body
      const supportsDesign = 'designContext' in requirementSaveSchema.shape
      if (!supportsDesign && (target.designContext.direction || target.designContext.standards.length || target.designContext.materials.length)) throw new Error('设计语境保存能力尚不可用；本地内容已保留。')
      const incoming = conversationValue(await api.save(fence.conversationId, target.view.draft.id, requirementSaveSchema.parse({ expectedRevision: target.view.draft.revision, title: target.title, body: target.body, references: target.references, questions: target.questions, expectedFileRevision: target.view.draft.bodyRevision, ...(supportsDesign ? { designContext: target.designContext } : {}) })))
      if (!fence.current()) return false
      acceptWorkbenchView(target, incoming, { ...captured, document: 'requirement' }); notifyWorkbench()
      if (unchanged(target, captured) && target.body === body && incoming.draft.body === body) target.savedSelectionFences = { ...target.savedSelectionFences, requirement: { beforeRevision: previous.revision, beforeBodyRevision: previous.bodyRevision, afterRevision: incoming.draft.revision, afterBodyRevision: incoming.draft.bodyRevision, body, ...captured } }
    }
    if (!unchanged(target, captured)) return false
    if (includePlan && planDirty(target) && target.view) {
      const previous = target.view.draft.plan, body = target.planBody
      const incoming = conversationValue(await api.savePlan(fence.conversationId, target.view.draft.id, requirementSavePlanSchema.parse({ expectedRevision: target.view.draft.revision, expectedPlanRevision: target.view.draft.plan?.revision ?? null, body: target.planBody, expectedFileRevision: target.view.draft.plan?.bodyRevision ?? null })))
      if (!fence.current()) return false
      acceptWorkbenchView(target, incoming, { ...captured, document: 'plan' }); notifyWorkbench()
      if (unchanged(target, captured) && target.planBody === body && incoming.draft.plan?.body === body) target.savedSelectionFences = { ...target.savedSelectionFences, plan: { beforeRevision: previous?.revision, beforeBodyRevision: previous?.bodyRevision, afterRevision: incoming.draft.plan.revision, afterBodyRevision: incoming.draft.plan.bodyRevision, body, ...captured } }
    }
    return fence.current() && unchanged(target, captured) && !requirementDirty(target) && (!includePlan || !planDirty(target))
  }
  const adoptCandidate = async (target: WorkbenchBuffer, api: ConversationRequirementsApi, fence: SourceFence, observation: RequirementObservation, automatic: boolean): Promise<void> => {
    assertEditable(target)
    const { operation, candidate } = observation, saved = target.view?.draft
    if (!candidate || operation.state !== 'candidate' || !operation.candidateRevision || !saved) throw new Error('候选尚不可采用，请检查执行与文件状态。')
    if (operation.quote || target.selectionOperations.includes(operation.commandId)) throw new Error('选区候选必须在编辑器中逐段审阅和应用；请先复制所需内容。')
    const captured = versions(target), automaticIntent = target.automatic
    if (saved.revision !== operation.sourceRevision) throw new Error('候选基于旧版本，请比较后按当前版本重新生成。')
    if (workbenchDirty(target)) {
      if (automatic) return
      if (operation.document === 'plan' ? requirementDirty(target) : planDirty(target)) throw new Error('另一份文档有未保存修改，请先处理后采用。')
      const controller = new AbortController(); confirmation.current = controller
      const confirmed = await confirmDialog({ title: '采用候选并替换本地修改？', message: '已保存的基准版本相同，将采用比较中的完整候选。', confirmText: '替换并采用' }, controller.signal)
      if (!confirmed || !fence.current() || !unchanged(target, captured)) return
    }
    if (automatic && (!automaticIntent || !automaticIntent.sourceCurrent() || automaticIntent.commandId !== operation.commandId || automaticIntent.sourceRevision !== operation.sourceRevision || automaticIntent.sourceRevision !== saved.revision || !unchanged(target, automaticIntent))) return
    const incoming = conversationValue(await api.adopt(fence.conversationId, saved.id, operation.id, requirementAdoptSchema.parse({ expectedRevision: saved.revision, candidateRevision: operation.candidateRevision })))
    if (!fence.current()) return
    acceptWorkbenchView(target, incoming, { ...captured, document: operation.document })
    target.observations.delete(operation.id); target.automatic = undefined; target.comparing = undefined
    if (operation.action === 'plan' && incoming.draft.plan?.operationId === operation.id && !incoming.draft.plan.stale && target.requirementVersion === captured.requirementVersion && (planSourcesMatch(target, operation) || automaticIntent && automaticIntent.commandId === operation.commandId && automaticIntent.sourceRevision === operation.sourceRevision && automaticIntent.requirementVersion === target.requirementVersion && automaticIntent.sourceCurrent())) target.planSourcesChanged = false
    if (operation.document === 'plan' && unchanged(target, captured)) target.document = 'plan'
    settleWorkbenchCommands(target)
  }
  const receiveObservation = async (target: WorkbenchBuffer, api: ConversationRequirementsApi, fence: SourceFence, observation: RequirementObservation, expected: RequirementOperation | NonNullable<WorkbenchBuffer['runCommand']>): Promise<void> => {
    if (!fence.current()) return
    rememberObservation(target, observation, expected)
    settleWorkbenchCommands(target); notifyWorkbench()
    if (observation.candidate && target.automatic?.commandId === observation.operation.commandId && !target.pending && !workbenchDirty(target) && !target.remote) {
      target.pending = 'adopt'; notifyWorkbench()
      try { await adoptCandidate(target, api, fence, observation, true) }
      finally { target.pending = undefined; notifyWorkbench() }
    }
  }
  const pendingKey = value?.operations.filter(operation => operationPending(operation) || operation.state === 'candidate' && (!value.observations.has(operation.id) || value.automatic?.commandId === operation.commandId && value.automatic.sourceCurrent() && value.automatic.sourceRevision === value.view?.draft.revision && unchanged(value, value.automatic) && !workbenchDirty(value) && !value.remote)).slice(-8).map(operation => operation.id).join(',') ?? ''
  useEffect(() => {
    if (!active || !value?.view || !pendingKey) return
    const target = value, fence = capture()
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      if (disposed || !fence.current()) return
      if (!target.pending) {
        const api = requirementsApi()
        for (const operation of [...target.operations].filter(item => pendingKey.split(',').includes(item.id))) {
          if (!operationPending(operation) && operation.state !== 'candidate') continue
          const observation = conversationValue(await api.observe(fence.conversationId, target.view?.draft.id ?? '', operation.id))
          if (disposed || !fence.current()) return
          await receiveObservation(target, api, fence, observation, operation)
          if (!fence.current()) return
        }
      }
      if (!disposed && fence.current()) timer = setTimeout(() => { void poll().catch(fail) }, 1500)
    }
    const fail = (cause: unknown): void => { if (!disposed && fence.current()) { target.issue = { kind: 'operation', message: conversationError(cause) }; notifyWorkbench() } }
    void poll().catch(fail)
    return () => { disposed = true; if (timer) clearTimeout(timer) }
  }, [identity, pendingKey])

  const rejectRun = async (target: WorkbenchBuffer, fence: SourceFence, input: RequirementRun, result: Extract<RequirementRunResult, { ok: false }>): Promise<never> => {
    const notAdmitted = runRejectionProven(result)
    if (notAdmitted && fence.ownsBuffer() && target.runCommand?.commandId === input.commandId) { target.runCommand = undefined; target.automatic = undefined; target.selectionOperations = target.selectionOperations.filter(id => id !== input.commandId); target.planSourceIntents = target.planSourceIntents.filter(item => item.commandId !== input.commandId); persistWorkbenchCommands(target) }
    throw new Error(notAdmitted ? `${result.error} 本次未发送，内容已保留。` : `${result.error} 原操作结果待核对，请勿重复发送。`)
  }
  const sendOperation = async (target: WorkbenchBuffer, api: ConversationRequirementsApi, fence: SourceFence, action: RequirementAction, text: string, document: RequirementDocument, consumeText = true, quoteOverride?: WorkbenchQuote): Promise<string | undefined> => {
    assertEditable(target)
    if (target.runCommand || target.operations.some(operation => operationPending(operation) || operation.state === 'unknown')) throw new Error('请先检查上一次操作的实际状态。')
    const quote = quoteOverride ?? (consumeText ? target.quote : undefined)
    const quoteRevision = document === 'requirement' ? target.view?.draft.revision : target.view?.draft.plan?.revision
    if (quote && (quote.document !== document || quote.documentRevision !== quoteRevision || quote.editVersion !== (document === 'requirement' ? target.requirementVersion : target.planVersion))) throw new Error('引用后文档已改变，请重新选择引用。')
    const includePlan = document === 'plan' && action !== 'plan'
    if (!await saveAll(target, api, fence, includePlan) || !target.view || !fence.current()) return
    if (!hasRequirementContent(target.body)) throw new Error('请先描述需求，空模板不能发送给需求助手。')
    const captured = versions(target), textVersion = target.textVersion, savedRevision = target.view.draft.revision
    if (quote && !currentRevision(target, document)) throw new Error('请先保存被引用的文档。')
    // Persist the ordinary draft's configuration without dispatching its text or images.
    await saveDraft(entryKey)
    if (!fence.current() || !unchanged(target, captured) || requirementDirty(target) || includePlan && planDirty(target) || consumeText && target.textVersion !== textVersion) return
    if (target.view.draft.revision !== savedRevision) throw new Error('文档已更新，请核对后重新操作。')
    const input = requirementRunSchema.parse({
      expectedRevision: target.view.draft.revision, commandId: crypto.randomUUID(), action, document,
      ...(text.trim() ? { text: text.trim() } : {}), ...(quote ? { quote: { text: quote.text, bodyRevision: currentRevision(target, document), ...(quote.anchor ? { anchor: quote.anchor } : {}), ...(quote.comparisonOnly ? { comparisonOnly: true } : {}) } } : {}),
      ...(!quote?.comparisonOnly && target.fromConversation ? { fromConversation: true } : {}),
      ...(!quote?.comparisonOnly && target.knowledgeSelection ? { knowledgeSelection: target.knowledgeSelection } : {}),
      ...(!quote?.comparisonOnly && target.knowledgeSources.length ? { knowledgeSources: target.knowledgeSources } : {})
    })
    target.runCommand = input
    if (quote && action === 'revise') target.selectionOperations = [...new Set([...target.selectionOperations, input.commandId])]
    const previousPlanIntents = target.planSourceIntents
    if (action === 'plan') target.planSourceIntents = [...previousPlanIntents.slice(-7), { commandId: input.commandId, sourceRevision: input.expectedRevision, signature: planSourceSignature(target) }]
    try { persistWorkbenchCommands(target) } catch (cause) { target.runCommand = undefined; target.planSourceIntents = previousPlanIntents; throw cause }
    target.automatic = quote && action === 'revise' || action === 'discuss' ? undefined : { commandId: input.commandId, sourceRevision: input.expectedRevision, sourceCurrent: fence.interactive, ...captured }
    notifyWorkbench()
    const result = await api.run(fence.conversationId, target.view.draft.id, input)
    // A first native binding may replace the generation before the RPC resolves.
    // Its receipted data belongs to this original buffer; interactive continuations
    // still require the exact current source below.
    if (!fence.ownsBuffer()) return
    if (!result.ok) return rejectRun(target, fence, input, result)
    const observation = result.value
    rememberObservation(target, observation, input)
    settleWorkbenchCommands(target)
    const accepted = observation.operation.sessionId && observation.operation.connectionGeneration && observation.operation.turnId && ['running', 'completed', 'candidate', 'adopted'].includes(observation.operation.state)
    if (accepted && consumeText && target.textVersion === textVersion) { target.text = ''; target.textAction = undefined; target.textVersion++ }
    if (accepted && quote && target.quote === quote) target.quote = undefined
    void readConversation(entryKey)
    if (target.automatic && fence.current() && observation.candidate && !workbenchDirty(target) && unchanged(target, captured)) await adoptCandidate(target, api, fence, observation, true)
    return input.commandId
  }

  const edit = (action: (target: WorkbenchBuffer) => void): boolean => {
    if (!value || readonly || value.commandIssue || !canInteract() || !isPrivateEntrySelected(entryKey) || displayOwner.current !== renderedOwner) return false
    try { action(value); scheduleWorkbenchDraft(value); value.issue = undefined; notifyWorkbench(); return true }
    catch (cause) { value.issue = { kind: 'save', message: conversationError(cause) }; notifyWorkbench(); return false }
  }
  const questions = useMemo(() => {
    const latest = value && [...value.observations.values()].reverse().find(observation => observation.candidate?.questions.length)
    return latest?.candidate?.questions ?? value?.questions ?? []
  }, [value, value?.questions, value?.observations.size, value?.operations])
  const events = useMemo(() => current?.conversation ? projectRequirementEvents(current.events, value?.operations ?? [], current.conversation.workspace.root) : [], [current?.events, current?.conversation?.workspace.root, value?.operations])
  const candidates = value ? [...value.observations.values()].filter(observation => observation.candidate && observation.operation.state === 'candidate').reverse() : []
  const pendingOperations = value?.operations.filter(operation => operationPending(operation) || operation.state === 'unknown') ?? []
  const busy = Boolean(value?.pending), hasPlan = Boolean(view?.draft.plan)
  const planStale = Boolean(view?.draft.plan?.stale || hasPlan && value && (requirementDirty(value) || value.planSourcesChanged))
  const receipt = lockedReceipt?.state === 'not-admitted' ? undefined : lockedReceipt
  const canRun = Boolean(active && value?.view && !value.view.pendingSave && !readonly && !busy && !value.commandIssue && !value.remote && !value.runCommand && !value.selectionCommand && !pendingOperations.length && !current?.action && current && !sessionRunning(current))

  const confirmRequirement = async (target: WorkbenchBuffer, api: ConversationRequirementsApi, fence: SourceFence): Promise<boolean> => {
    if (!await saveAll(target, api, fence, false) || !target.view || !fence.current()) return false
    if (!hasRequirementContent(target.body)) throw new Error('请先描述需求，空模板不能生成计划。')
    const captured = versions(target)
    if (!target.confirmCommand) {
      target.confirmCommand = requirementConfirmSchema.parse({ expectedRevision: target.view.draft.revision, commandId: crypto.randomUUID() })
      try { persistWorkbenchCommands(target) } catch (cause) { target.confirmCommand = undefined; throw cause }
    }
    const incoming = conversationValue(await api.confirmRequirement(fence.conversationId, target.view.draft.id, target.confirmCommand))
    if (!fence.current()) return false
    acceptWorkbenchView(target, incoming, { ...captured, document: 'metadata' }); settleWorkbenchCommands(target)
    return unchanged(target, captured) && !requirementDirty(target)
  }
  const selectTarget = async (selection?: RequirementTargetSelection): Promise<void> => perform('handoff', 'target', async (target, api, fence) => {
    if (!target.view?.draft.plan || target.view.draft.plan.stale || target.planSourcesChanged) throw new Error('请先完成当前需求和资料的计划。')
    if (!await saveAll(target, api, fence) || !target.view || !fence.current()) return
    if (!selection) {
      const client = conversationClient()
      if (!client) throw new Error('工程选择暂不可用。')
      const grant = conversationValue(await client.pickDirectory({ purpose: 'trellis-requirement' }))
      if (!grant || !fence.current()) return
      selection = { kind: 'directory', grantId: grant.grantId }
    }
    const captured = versions(target), incoming = conversationValue(await api.target(fence.conversationId, target.view.draft.id, { expectedRevision: target.view.draft.revision, selection }))
    if (fence.current()) acceptWorkbenchView(target, incoming, { ...captured, document: 'metadata' })
  })
  const commit = async (): Promise<void> => perform('handoff', 'commit', async (target, api, fence) => {
    if (target.commandIssue || !target.view) return
    if (!target.commitCommand) {
      if (!await saveAll(target, api, fence) || !target.view || !fence.current()) return
      const draft = target.view.draft, captured = versions(target)
      if (!draft.confirmed || !draft.plan || draft.plan.stale || target.planSourcesChanged || !draft.target) throw new Error('请先保存当前资料的计划并选择 Trellis 工程。')
      const selectedSources = JSON.stringify(target.selectedHandoffSources)
      const knowledgeSources = target.operations.filter(operation => operation.state === 'adopted').flatMap(operation => operation.knowledge.map(source => ({ operationId: operation.id, sourceId: source.sourceId, returnedRevision: source.returnedRevision }))).filter(source => target.selectedHandoffSources.includes(JSON.stringify([source.operationId, source.sourceId, source.returnedRevision])))
      const selection = target.knowledgeSelection, availableDirect = target.knowledgeSources
      const directSources = selection ? availableDirect.filter(source => target.selectedHandoffSources.includes(JSON.stringify(['direct', selection.connectionId, selection.connectionRevision, source.sourceId, source.returnedRevision]))) : []
      const directKnowledge = selection && directSources.length ? { version: 1 as const, selection, sources: directSources } : undefined
      const designSources = draft.designContextFiles.filter(file => target.selectedHandoffSources.includes(designHandoffKey(file))).map(file => file.source)
      if (designSources.length !== draft.designContextFiles.length) throw new Error('请在资料中逐项选择要交接的设计文件；不交接的文件请先从设计语境移除并更新计划。')
      const directSnapshot = JSON.stringify([selection, availableDirect])
      const controller = new AbortController(); confirmation.current = controller
      const confirmed = await confirmDialog({ title: '创建 Trellis 任务', message: `${draft.title}\n${draft.target.root}\n将固定当前需求、计划、${knowledgeSources.length + directSources.length} 项知识来源和 ${designSources.length} 项设计文件。未选来源和私人对话不会交接。`, confirmText: '创建任务' }, controller.signal)
      if (!confirmed || !fence.current()) return
      if (!unchanged(target, captured) || workbenchDirty(target) || target.view.draft.revision !== draft.revision || JSON.stringify(target.selectedHandoffSources) !== selectedSources || JSON.stringify([target.knowledgeSelection, target.knowledgeSources]) !== directSnapshot) throw new Error('材料已改变，请保存后重新确认。')
      target.commitCommand = requirementCommitSchema.parse({ expectedRevision: draft.revision, expectedPlanRevision: draft.plan.revision, targetId: draft.target.id, commandId: crypto.randomUUID(), knowledgeSources, designSources, ...(directKnowledge ? { directKnowledge } : {}) })
      try { persistWorkbenchCommands(target) } catch (cause) { target.commitCommand = undefined; throw cause }
    }
    const result = conversationValue(await api.commit(fence.conversationId, target.view.draft.id, target.commitCommand))
    if (fence.current()) { acceptReceipt(target, result); if (result.state === 'not-admitted') target.issue = { kind: 'handoff', message: result.detail ?? '交接未准入，请调整资料后重试。' } }
  })
  const beginBuild = async (): Promise<void> => perform('handoff', 'prepare-build', async (target, api, fence) => {
    if (!onPrepareBuild) throw new Error('统一执行准备入口尚未就绪，请稍后重试。')
    const existing = target.receipt ?? target.view?.draft.handoff
    if (existing?.state === 'created' && existing.task) {
      if (!target.view || workbenchDirty(target) || !fence.current()) throw new Error('原任务对应的本地材料尚未核对，请先处理后继续。')
    } else if (!await saveAll(target, api, fence) || !target.view || !fence.current()) return
    if (!target.view) return
    const draft = target.view.draft
    if (!draft.confirmed || !draft.plan || draft.plan.stale || target.planSourcesChanged) throw new Error('请先完成当前需求和资料的计划。')
    const captured = versions(target), selectedSnapshot = JSON.stringify(target.selectedHandoffSources), sourceSnapshot = JSON.stringify([target.knowledgeSelection, target.knowledgeSources])
    const knowledgeSources = target.operations.filter(operation => operation.state === 'adopted').flatMap(operation => operation.knowledge.map(source => ({ operationId: operation.id, sourceId: source.sourceId, returnedRevision: source.returnedRevision }))).filter(source => target.selectedHandoffSources.includes(JSON.stringify([source.operationId, source.sourceId, source.returnedRevision])))
    const selection = target.knowledgeSelection
    const directSources = selection ? target.knowledgeSources.filter(source => target.selectedHandoffSources.includes(JSON.stringify(['direct', selection.connectionId, selection.connectionRevision, source.sourceId, source.returnedRevision]))) : []
    const directKnowledge = selection && directSources.length ? { version: 1 as const, selection, sources: directSources } : undefined
    const designSources = draft.designContextFiles.filter(file => target.selectedHandoffSources.includes(designHandoffKey(file))).map(file => file.source)
    if (designSources.length !== draft.designContextFiles.length) throw new Error('请在资料中逐项选择要交接的设计文件；不交接的文件请先从设计语境移除并更新计划。')
    const choice = await onPrepareBuild({ draftId: draft.id, expectedRevision: draft.revision, expectedPlanRevision: draft.plan.revision, knowledgeSources, ...(directKnowledge ? { directKnowledge } : {}), designSources })
    if (!choice || !fence.current()) return
    if (!unchanged(target, captured) || workbenchDirty(target) || !target.view || target.view.draft.revision !== draft.revision || JSON.stringify(target.selectedHandoffSources) !== selectedSnapshot || JSON.stringify([target.knowledgeSelection, target.knowledgeSources]) !== sourceSnapshot) throw new Error('准备期间材料已变化，请重新核对。')
    let receipt = target.receipt ?? target.view.draft.handoff
    if (!receipt?.task || receipt.state !== 'created') {
      if (!target.commitCommand) {
        if (choice.selection) {
          const incoming = conversationValue(await api.target(fence.conversationId, draft.id, { expectedRevision: draft.revision, selection: choice.selection }))
          if (!fence.current()) return
          if (!unchanged(target, captured) || incoming.draft.id !== draft.id || incoming.draft.bodyRevision !== draft.bodyRevision || incoming.draft.plan?.revision !== draft.plan.revision || incoming.draft.plan.bodyRevision !== draft.plan.bodyRevision || projectRootKey(incoming.draft.target?.root) !== projectRootKey(choice.root)) throw new Error('目标或固定版本已变化，请重新核对。')
          acceptWorkbenchView(target, incoming, { ...captured, document: 'metadata' })
        }
        const actual = target.view?.draft
        if (!actual?.target || projectRootKey(actual.target.root) !== projectRootKey(choice.root) || choice.targetId && actual.target.id !== choice.targetId || actual.plan?.revision !== draft.plan.revision) throw new Error('目标工程与确认内容不一致，未创建任务。')
        target.commitCommand = requirementCommitSchema.parse({ commandId: crypto.randomUUID(), expectedRevision: actual.revision, expectedPlanRevision: draft.plan.revision, targetId: actual.target.id, knowledgeSources, designSources, ...(directKnowledge ? { directKnowledge } : {}) })
        try { persistWorkbenchCommands(target) } catch (cause) { target.commitCommand = undefined; throw cause }
      }
      receipt = conversationValue(await api.commit(fence.conversationId, draft.id, target.commitCommand))
      if (!fence.current()) return
      acceptReceipt(target, receipt)
      if (receipt.state !== 'created' || !receipt.task) { target.issue = { kind: 'handoff', message: receipt.detail ?? '交接尚未完成，请检查原命令。' }; return }
    }
    if (!receipt.task || projectRootKey(receipt.task.root) !== projectRootKey(choice.root) || receipt.planRevision !== draft.plan.revision) throw new Error('原任务与确认的工程或计划不一致，未进入执行。')
    const opened = conversationValue(await api.open(fence.conversationId, draft.id))
    if (!fence.current()) return
    if (opened.conversationId !== fence.conversationId || opened.draftId !== draft.id || opened.task.taskId !== receipt.task.taskId || opened.taskDir !== receipt.task.taskDir || projectRootKey(opened.task.root) !== projectRootKey(receipt.task.root) || projectRootKey(opened.snapshot.meta.root) !== projectRootKey(receipt.task.root)) throw new Error('实际打开结果不是原任务。')
    if (onStartTrellis) await onStartTrellis({ snapshot: opened.snapshot, taskDir: opened.taskDir, draftId: draft.id, agentId: choice.agentId, planRevision: receipt.planRevision })
    else await onOpenTask({ snapshot: opened.snapshot, taskDir: opened.taskDir })
  })
  const openTask = async (start = false): Promise<void> => perform('handoff', start ? 'start' : 'open', async (target, api, fence) => {
    const task = (target.receipt ?? target.view?.draft.handoff)?.task
    if (!target.view || !task) throw new Error('尚未收到实际任务回执。')
    if (start && (target.receipt ?? target.view.draft.handoff)?.state !== 'created') throw new Error('请先补全任务材料。')
    const opened = conversationValue(await api.open(fence.conversationId, target.view.draft.id))
    if (!fence.current()) return
    if (opened.conversationId !== fence.conversationId || opened.draftId !== target.view.draft.id || opened.task.taskId !== task.taskId || opened.taskDir !== task.taskDir || opened.task.taskDir !== task.taskDir || projectRootKey(opened.task.root) !== projectRootKey(task.root) || projectRootKey(opened.snapshot.meta.root) !== projectRootKey(task.root)) throw new Error('任务来源不匹配，未打开其他工程。')
    const result = { snapshot: opened.snapshot, taskDir: opened.taskDir }
    if (start && onStartTrellis) await onStartTrellis({ ...result, draftId: opened.draftId, planRevision: (target.receipt ?? target.view.draft.handoff)?.planRevision })
    else await onOpenTask(result)
  })
  const openSuccessor = async (): Promise<void> => perform('successor', 'successor', async (target, api, fence) => {
    const original = target.view?.draft, receipt = target.receipt ?? original?.handoff
    if (!original || !receipt?.task || receipt.state !== 'created' || !receipt.planRevision || !original.confirmed) throw new Error('原任务或固定需求尚未核对完成。')
    if (!onOpenSuccessor) throw new Error('后续需求导航尚未就绪；原任务和材料已保留。')
    if (typeof api.createSuccessor !== 'function') throw new Error('后续需求服务尚未就绪；原任务和材料已保留。')
    let command = readWorkbenchSuccessor(target)
    if (command && command.expectedHandoffCommandId !== receipt.commandId) throw new Error('后续需求记录属于另一交接，请先核对原任务。')
    if (!command) { const commandId = await workbenchSuccessorCommandId(target, receipt.commandId); if (!fence.current()) return; command = requirementCreateSuccessorSchema.parse({ commandId, expectedHandoffCommandId: receipt.commandId }); persistWorkbenchSuccessor(target, command) }
    const incoming = conversationValue(command.successorId ? await api.read(fence.conversationId, command.successorId) : await api.createSuccessor(fence.conversationId, original.id, command))
    if (!fence.current()) return
    const next = incoming.draft
    assertWorkbenchSuccessor(target, incoming, receipt)
    if (command.successorId && command.successorId !== next.id) throw new Error('后续需求标识已改变；未跳转。')
    persistWorkbenchSuccessor(target, { ...command, successorId: next.id })
    await onOpenSuccessor({ draftId: next.id, commandId: command.commandId })
  })
  useEffect(() => {
    if (!active || !value?.view || value.view.pendingSave || !workbenchDirty(value) || value.pending || value.remote || readonly || value.commandIssue || value.selectionCommand || value.issue?.kind === 'save') return
    const timer = setTimeout(() => { void perform('save', 'save', async (target, api, fence) => { await saveAll(target, api, fence) }) }, 800)
    return () => clearTimeout(timer)
  }, [identity, value, value?.requirementVersion, value?.planVersion, value?.pending, value?.remote, value?.issue?.kind, value?.selectionCommand, readonly])
  const preparePlan = async (target: WorkbenchBuffer, api: ConversationRequirementsApi, fence: SourceFence): Promise<void> => {
    const answered = questions.map(question => ({ ...question, answer: target.answers[question.id] ?? question.answer ?? '' }))
    if (answered.some(question => question.required && !question.answer.trim())) {
      const controller = new AbortController(); confirmation.current = controller
      const proceed = await confirmDialog({ title: '仍有必答问题', message: '可以先回答，也可以带着未决问题生成计划。', confirmText: '带未决问题生成' }, controller.signal)
      if (!proceed || !fence.current()) return
    }
    if (JSON.stringify(answered) !== JSON.stringify(target.questions)) { target.questions = answered; target.requirementVersion++; flushWorkbenchDraft(target) }
    if (!await confirmRequirement(target, api, fence)) return
    await sendOperation(target, api, fence, 'plan', '', 'plan', false)
  }
  const editSelection = async (selection: DocumentEditorSelection): Promise<string> => {
    if (!value || !value.view) throw new Error('请先读取文档，再润色选区。')
    if (selectionStarting.current || value.pending && value.pending !== 'save') throw new Error('请先完成当前操作，再润色选区。')
    const target = value, saved = value.view, fence = capture(), document = target.document
    const captured = versions(target), body = document === 'requirement' ? target.body : target.planBody, anchor = selectionAnchor(selection, body), pendingSave = target.pending === 'save' ? target.task : undefined
    if (!selection.text.trim() || selection.text.length > 16_000 || selection.documentKey !== `${saved.draft.id}:${document}` || !selectionVersionMatches(target, document, selection.docRevision, selection.bodyRevision)) throw new Error('选区来源已改变，请重新选择。')
    selectionStarting.current = true
    let claimed = false
    try {
      if (pendingSave) { await pendingSave; await Promise.resolve() }
      if (!fence.current() || !unchanged(target, captured) || (document === 'requirement' ? target.body : target.planBody) !== body || target.document !== document) throw new Error('保存期间文档或来源已变化，请重新选择。')
      const entry = useConversations.getState().entries[entryKey]
      if (target.pending || target.runCommand || target.selectionCommand || target.commandIssue || target.remote || target.operations.some(item => operationPending(item) || item.state === 'unknown') || !entry || entry.action || sessionRunning(entry)) throw new Error('请先完成当前操作，再润色选区。')
      target.pending = 'selection'; target.issue = undefined; claimed = true; notifyWorkbench()
      const api = requirementsApi()
      if (!await saveAll(target, api, fence, document === 'plan') || !target.view || !unchanged(target, captured) || (document === 'requirement' ? target.body : target.planBody) !== body) throw new Error('保存期间文档已变化，请重新选择。')
      const documentRevision = document === 'requirement' ? target.view.draft.revision : target.view.draft.plan?.revision
      if (!documentRevision) throw new Error('原文档版本不可读取，请重新选择。')
      const quote: WorkbenchQuote = { text: selection.text, document, documentRevision, editVersion: document === 'requirement' ? target.requirementVersion : target.planVersion, ...(anchor ? { anchor } : { comparisonOnly: true }) }
      const commandId = await sendOperation(target, api, fence, 'revise', '仅润色所引用的内容，保留原意；返回选区替换文本。', document, false, quote)
      if (!commandId) throw new Error('选区操作尚未派发，请检查文档与原操作状态。')
      for (;;) {
        if (!fence.interactive() || !target.view) throw new Error('已离开原会话，请返回后检查原操作。')
        const operation = target.operations.find(item => item.commandId === commandId)
        if (!operation) throw new Error('原操作尚未登记，请检查原操作。')
        const observation = conversationValue(await api.observe(fence.conversationId, target.view.draft.id, operation.id))
        if (!fence.interactive()) throw new Error('已离开原会话，请返回后检查原操作。')
        rememberObservation(target, observation, operation); settleWorkbenchCommands(target); notifyWorkbench()
        if (observation.operation.state === 'candidate') {
          const currentEntry = useConversations.getState().entries[entryKey]
          const actual = observation.operation
          if (!actual.sessionId || !actual.connectionGeneration || !actual.turnId || currentEntry?.conversation?.nativeRef?.sessionId !== actual.sessionId || currentEntry.session?.connectionGeneration !== actual.connectionGeneration) throw new Error('选区候选的原生会话或生成轮次无法核对，请检查原操作。')
          const replacement = observation.candidate?.selectionReplacement
          if (replacement === undefined || !replacement.trim()) throw new Error('已校验候选缺少选区替换文本。')
          selectionResults.current.set(JSON.stringify(selection), { selection, operation: actual, replacement, documentRevision, target, sourceCurrent: () => { const latest = useConversations.getState().entries[entryKey]; return fence.interactive() && latest?.conversation?.nativeRef?.sessionId === actual.sessionId && latest.session?.connectionGeneration === actual.connectionGeneration } })
          if (selectionResults.current.size > 8) selectionResults.current.delete(selectionResults.current.keys().next().value as string)
          return replacement
        }
        if (!operationPending(observation.operation)) throw new Error(observation.operation.detail || '选区操作未生成可用候选，请检查原操作。')
        await new Promise(resolve => setTimeout(resolve, 1500))
      }
    } finally {
      if (claimed && target.pending === 'selection') target.pending = undefined
      selectionStarting.current = false
      try { flushWorkbenchDraft(target) } catch (cause) { target.issue = { kind: 'save', message: `本地恢复稿保存失败：${conversationError(cause)}` } }
      notifyWorkbench()
    }
  }
  const resolveSelection = async (target: WorkbenchBuffer, api: ConversationRequirementsApi, fence: SourceFence): Promise<void> => {
    const command = target.selectionCommand, saved = target.view?.draft
    if (!command || !saved) throw new Error('原选区应用请求不可读取，请检查原操作。')
    try { persistWorkbenchCommands(target) } catch { throw new Error('选区应用记录未能保存，本次尚未发送；请释放本地存储后检查原应用。') }
    const operation = target.operations.find(item => item.id === command.operationId)
    if (!operation || operation.candidateRevision !== command.input.candidateRevision || operation.sourceRevision !== command.input.expectedRevision) throw new Error('选区原操作与待核对请求不一致，已保留记录。')
    const captured = versions(target), unchangedBody = (operation.document === 'plan' ? target.planBody : target.body) === command.input.body
    const hash = async (text: string): Promise<string> => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), byte => byte.toString(16).padStart(2, '0')).join('')
    const digest = await hash(JSON.stringify(command.input)), bodyDigest = await hash(command.input.body)
    if (!fence.current()) throw new Error('已离开原会话，请返回后检查原选区应用。')
    const result = await api.applySelection(fence.conversationId, saved.id, operation.id, command.input)
    if (!fence.current()) throw new Error('原选区应用回执待核对，请返回原会话检查。')
    if (!result.ok) {
      const failure = { code: result.code, outcome: 'outcome' in result ? result.outcome : undefined }
      let rejected = selectionRejectionProven(failure, operation)
      if (!rejected && ['E_CONFLICT', 'E_INVALID_ARG', 'E_DENIED', 'E_BUSY', 'E_NOT_FOUND'].includes(result.code)) {
        const check = await api.read(fence.conversationId, saved.id)
        if (!fence.current()) throw new Error('原选区应用回执待核对，请返回原会话检查。')
        if (check.ok) {
          assertWorkbenchView(target, check.value)
          rejected = selectionRejectionProven(failure, operation, check.value)
        }
      }
      if (rejected) { target.selectionCommand = undefined; for (const [key, item] of selectionResults.current) if (item.operation.id === operation.id) selectionResults.current.delete(key); settleWorkbenchCommands(target); throw new Error(`原选区应用已明确拒绝，未写入；本地正文已保留。${result.error}`) }
      throw new Error(`原选区应用结果待核对，本地正文已保留。${result.error}`)
    }
    const { receipt, view: incoming } = result.value
    assertWorkbenchView(target, incoming)
    if (selectionReceiptIsCurrent(operation, receipt, incoming, digest, bodyDigest)) {
      const acknowledgement = unchangedBody ? captured : { requirementVersion: -1, planVersion: -1 }
      acceptWorkbenchView(target, incoming, { ...acknowledgement, document: operation.document })
    } else acceptWorkbenchView(target, incoming)
    target.observations.delete(operation.id); target.selectionCommand = undefined; settleWorkbenchCommands(target); for (const [key, item] of selectionResults.current) if (item.operation.id === operation.id) selectionResults.current.delete(key)
  }
  return {
    current, buffer: value, view, issue: loadIssue ?? value?.issue, loading: !view && !loadIssue, active, readOnly: readonly,
    busy, assistantPending: Boolean(value?.pending === 'run' || pendingOperations.some(operationPending)), canRun,
    dirty: Boolean(value && workbenchDirty(value)), requirementDirty: Boolean(value && requirementDirty(value)), planDirty: Boolean(value && planDirty(value)), planStale,
    events, questions, candidates, pendingOperations, comparison: value?.comparing ? value.observations.get(value.comparing) : undefined,
    nextLabel: receipt?.task ? receipt.state === 'created' ? onStartTrellis ? '进入执行流程' : '打开任务' : '补全交接' : value?.commitCommand ? '检查本次交接' : hasPlan && !planStale ? value?.document === 'requirement' ? '查看计划' : '开始构建' : hasPlan ? '更新计划' : '下一步',
    nextDisabled: !active || !view || Boolean(view.pendingSave) || busy || Boolean(value?.commandIssue || value?.selectionCommand) || !receipt && !value?.commitCommand && (!value || !hasRequirementContent(value.body) || Boolean(value.remote) || !hasPlan && !canRun || planStale && !canRun),
    editTitle: title => edit(target => { target.title = title; target.requirementVersion++ }),
    editBody: body => edit(target => { validateBody(body); if (target.document === 'requirement') { target.body = body; target.requirementVersion++ } else { target.planBody = body; target.planVersion++ } }),
    editDocumentBody: (document, body) => edit(target => { validateBody(body); if (document === 'requirement') { target.body = body; target.requirementVersion++ } else if (target.view?.draft.plan) { target.planBody = body; target.planVersion++ } }),
    setDocument: document => { if (value && canInteract() && (document === 'requirement' || value.view?.draft.plan)) { value.document = document; notifyWorkbench() } },
    setText: text => { if (text.length <= 16_000) edit(target => { target.text = text; target.textAction = isDocumentEditInstruction(text) ? 'revise' : undefined; target.textVersion++ }) },
    appendInstruction: (_action, text) => edit(target => { const next = target.text.trimEnd() ? `${target.text.trimEnd()}\n\n${text}` : text; if (next.length > 16_000) throw new Error('助手输入最多 16000 字。'); target.text = next; target.textAction = isDocumentEditInstruction(next) ? 'revise' : undefined; target.textVersion++ }),
    setTextAction: action => edit(target => { target.textAction = action }),
    setFromConversation: checked => edit(target => { if (target.fromConversation !== checked) { target.planSourcesChanged = true; target.requirementVersion++ }; target.fromConversation = checked }),
    setKnowledge: (selection, sources) => edit(target => { const next = sources.slice(0, 8); if (JSON.stringify(target.knowledgeSelection) !== JSON.stringify(selection) || JSON.stringify(target.knowledgeSources) !== JSON.stringify(next)) { target.planSourcesChanged = true; target.requirementVersion++ }; target.knowledgeSelection = selection; target.knowledgeSources = next; const available = new Set(selection ? next.map(source => JSON.stringify(['direct', selection.connectionId, selection.connectionRevision, source.sourceId, source.returnedRevision])) : []); target.selectedHandoffSources = target.selectedHandoffSources.filter(key => !key.startsWith('["direct",') || available.has(key)) }),
    setHandoffSource: (key, included) => edit(target => { const selected = target.selectedHandoffSources.filter(value => value !== key); if (included) selected.push(key); if (selected.length > 144) throw new Error('交接来源已达上限。'); target.selectedHandoffSources = selected }),
    setDesignContext: context => edit(target => { const next = requirementDesignContextSchema.parse(context); if (JSON.stringify(next) !== JSON.stringify(target.designContext)) { target.designContext = next; target.requirementVersion++ } }),
    quote: (selection, polish = false) => {
      let selected: WorkbenchQuote | undefined
      const accepted = edit(target => {
        if (!target.view || !selection.text.trim() || selection.text.length > 16_000) throw new Error('请选择不超过 16000 字的内容。')
        const document = target.document, revision = document === 'requirement' ? target.view.draft.revision : target.view.draft.plan?.revision
        if (selection.documentKey !== `${target.view.draft.id}:${document}` || selection.docRevision !== revision || selection.bodyRevision !== currentRevision(target, document)) throw new Error('选区来源已改变，请重新选择。')
        const anchor = selectionAnchor(selection, document === 'requirement' ? target.body : target.planBody)
        if (!anchor) throw new Error('无法验证选区的 Markdown 位置，请重新选择可定位的文本。')
        selected = { text: selection.text, document, documentRevision: revision ?? '', editVersion: document === 'requirement' ? target.requirementVersion : target.planVersion, anchor }
        target.quote = selected
      })
      if (!accepted || !selected) return false
      if (polish) {
        const sentQuote = selected
        void perform('operation', 'run', async (target, api, fence) => {
          await sendOperation(target, api, fence, 'revise', '润色所引用的内容，保留原意和其他内容。', sentQuote.document, false, sentQuote)
        })
      }
      return true
    },
    editSelection,
    selectionApplied: (selection, replacement, body) => perform('save', 'selection-receipt', async (target, api, fence) => {
      const result = selectionResults.current.get(JSON.stringify(selection)), operation = result?.operation, saved = target.view?.draft
      if (!result || result.target !== target || !result.sourceCurrent() || !operation || !saved || JSON.stringify(result.selection) !== JSON.stringify(selection) || result.replacement !== replacement || !operation.candidateRevision) throw new Error('选区结果与原操作不一致，已保留本地修改。')
      if (operation.quote?.comparisonOnly || !selectionAnchor(selection, operation.document === 'plan' ? saved.plan?.body ?? '' : saved.body)) throw new Error('此候选只能比较或复制，不能自动应用。')
      if (operation.sourceRevision !== saved.revision || selection.documentKey !== `${saved.id}:${operation.document}` || (operation.document === 'plan' ? target.planBody : target.body) !== body) throw new Error('选区应用后的文档已变化，已保留本地修改。')
      const input = requirementApplySelectionSchema.parse({ expectedRevision: operation.sourceRevision, candidateRevision: operation.candidateRevision, body, ...(operation.document === 'plan' ? { expectedPlanRevision: result.documentRevision } : {}) })
      target.selectionCommand = { operationId: operation.id, input }
      await resolveSelection(target, api, fence)
    }, true),
    clearQuote: () => { if (value && canInteract()) { value.quote = undefined; notifyWorkbench() } },
    answer: (id, text) => { if (text.length <= 8000) edit(target => { target.answers = { ...target.answers, [id]: text } }) },
    toggleReference: (reference, checked) => edit(target => {
      const next = target.references.filter(item => item.fileId !== reference.fileId)
      if (checked) next.push(reference)
      if (next.length > 8) throw new Error('最多引用 8 个文件版本。')
      target.references = next; target.requirementVersion++
    }),
    importInput: () => edit(target => { const text = useConversations.getState().entries[entryKey]?.text; if (!text?.trim()) return; const body = target.body ? `${target.body}\n\n${text}` : text; validateBody(body); target.body = body; target.requirementVersion++; target.document = 'requirement' }),
    save: () => perform('save', 'save', async (target, api, fence) => { await saveAll(target, api, fence) }),
    reload: async () => { if (!value) { setAttempt(value => value + 1); return }; await perform('load', 'read', async (target, _api, fence) => { await read(target, fence) }) },
    useRemote: () => perform('load', 'read', async (target, _api, fence) => {
      if (!target.remote) return
      const captured = versions(target), controller = new AbortController(); confirmation.current = controller
      const confirmed = await confirmDialog({ title: '使用已保存的新版本？', message: '将替换当前文档的本地修改。', confirmText: '使用新版本' }, controller.signal)
      if (!confirmed || !fence.current() || !unchanged(target, captured) || !target.remote) return
      acceptWorkbenchView(target, target.remote, captured); target.requirementVersion++; target.planVersion++
    }),
    keepLocal: () => perform('save', 'save', async (target, api, fence) => {
      if (!target.remote) return
      const captured = versions(target), controller = new AbortController(); confirmation.current = controller
      const confirmed = await confirmDialog({ title: '将本地稿保存为新版本？', message: '请先比较两份内容。这将以本地稿替换最新保存内容。', confirmText: '保存本地稿' }, controller.signal)
      if (!confirmed || !fence.current() || !unchanged(target, captured) || !target.remote) return
      // Explicitly rebase after comparison; the following save still uses native CAS.
      target.view = target.remote; target.remote = undefined
      await saveAll(target, api, fence)
    }),
    syncFile: () => perform('save', 'sync', async (target, api, fence) => {
      assertEditable(target)
      if (workbenchDirty(target) || !target.view) throw new Error('请先保存本地修改。')
      const captured = versions(target), incoming = conversationValue(await api.read(fence.conversationId, target.view.draft.id))
      if (!fence.current() || !unchanged(target, captured) || workbenchDirty(target)) return
      acceptWorkbenchView(target, incoming)
      if (incoming.fileState !== 'changed' || !incoming.fileRevision) return
      const synced = conversationValue(await api.sync(fence.conversationId, incoming.draft.id, { expectedRevision: incoming.draft.revision, fileRevision: incoming.fileRevision }))
      if (fence.current()) acceptWorkbenchView(target, synced, captured)
    }),
    resolveFileConflict: (document, decision) => perform('save', 'file-conflict', async (target, api, fence) => {
      const view = target.view
      if (!view || view.pendingSave || target.remote || target.selectionCommand || target.commandIssue || target.commitCommand) throw new Error('请先核对原操作和其他冲突。')
      const fileState = document === 'plan' ? view.planFileState : view.fileState
      const fileRevision = document === 'plan' ? view.planFileRevision : view.fileRevision
      const fileBody = document === 'plan' ? view.planFileBody : view.fileBody
      if (!['changed', 'missing'].includes(fileState ?? '') || fileState === 'changed' && (!fileRevision || fileBody === undefined) || decision === 'use-file' && fileBody === undefined) throw new Error('实际文件内容尚不可核对，请先重新读取。')
      const captured = versions(target), body = document === 'plan' ? target.planBody : target.body, dialog = new AbortController(); confirmation.current = dialog
      const confirmed = await confirmDialog({ title: decision === 'keep-local' ? '保留本地稿？' : '采用实际文件？', message: decision === 'keep-local' ? '已比较的实际文件会先备份，再保存当前本地稿。' : '当前本地稿和已保存版本会先保留，再采用实际文件。', confirmText: decision === 'keep-local' ? '备份并保存本地稿' : '采用实际文件' }, dialog.signal)
      if (!confirmed || !fence.current() || !unchanged(target, captured)) return
      const latest = conversationValue(await api.read(fence.conversationId, view.draft.id))
      if (!fence.current() || !unchanged(target, captured)) return
      assertWorkbenchView(target, latest)
      const latestRevision = document === 'plan' ? latest.planFileRevision : latest.fileRevision, latestState = document === 'plan' ? latest.planFileState : latest.fileState
      if (latest.draft.revision !== view.draft.revision || latestRevision !== fileRevision || latestState !== fileState) { acceptWorkbenchView(target, latest); throw new Error('实际文件再次变化，请重新比较。') }
      const incoming = conversationValue(await api.resolveConflict(fence.conversationId, view.draft.id, requirementResolveConflictSchema.parse({ expectedRevision: view.draft.revision, document, ...(document === 'plan' ? { expectedPlanRevision: view.draft.plan?.revision ?? null } : {}), expectedFileRevision: fileRevision ?? null, decision, body })))
      if (!fence.current()) return
      if (decision === 'use-file' && unchanged(target, captured)) { if (document === 'plan') { target.planBody = incoming.draft.plan?.body ?? ''; target.planVersion++ } else { target.body = incoming.draft.body; target.requirementVersion++ } }
      acceptWorkbenchView(target, incoming, { ...captured, document: 'metadata' })
    }),
    resolvePendingSave: () => perform('save', 'recovery', async (target, api, fence) => {
      const view = target.view, pending = view?.pendingSave
      if (!view || !pending) return
      const captured = versions(target), dialog = new AbortController(); confirmation.current = dialog
      const confirmed = await confirmDialog({ title: '恢复中断的保存？', message: '会先保留实际文件的当前版本，再恢复待保存内容；本地继续编辑的内容也会保留。', confirmText: '恢复待保存内容' }, dialog.signal)
      if (!confirmed || !fence.current() || !unchanged(target, captured)) return
      const draft = pending.draft, document = pending.document
      if (pending.actual.state === 'unavailable') throw new Error('实际文件暂不可读取，请重新读取后再恢复。')
      const expectedFileRevision = pending.actual.revision ?? null
      const incoming = document === 'plan' ? conversationValue(await api.savePlan(fence.conversationId, view.draft.id, requirementSavePlanSchema.parse({ expectedRevision: view.draft.revision, expectedPlanRevision: view.draft.plan?.revision ?? null, body: draft.plan?.body ?? '', expectedFileRevision, resolvePending: true }))) : conversationValue(await api.save(fence.conversationId, view.draft.id, requirementSaveSchema.parse({ expectedRevision: view.draft.revision, title: draft.title, body: draft.body, references: draft.references.map(({ fileId, revision }) => ({ fileId, revision })), questions: draft.questions, expectedFileRevision, resolvePending: true })))
      if (!fence.current()) return
      if (incoming.pendingSave) throw new Error('待保存内容仍需核对，未标记为恢复完成。')
      const localMatches = document === 'plan' ? target.planBody === draft.plan?.body : target.body === draft.body && target.title === draft.title && JSON.stringify(target.questions) === JSON.stringify(draft.questions) && JSON.stringify(target.designContext) === JSON.stringify(draft.designContext ?? emptyRequirementDesignContext()) && JSON.stringify(target.references) === JSON.stringify(draft.references.map(({ fileId, revision }) => ({ fileId, revision })))
      acceptWorkbenchView(target, incoming, { ...(localMatches ? captured : { requirementVersion: -1, planVersion: -1 }), document })
    }),
    runAction: action => perform('operation', 'run', async (target, api, fence) => {
      if (action === 'plan') return preparePlan(target, api, fence)
      await sendOperation(target, api, fence, action, target.text, target.document)
    }),
    submitAnswers: () => perform('operation', 'run', async (target, api, fence) => {
      const answered = questions.map(question => ({ ...question, answer: target.answers[question.id] ?? question.answer ?? '' }))
      if (answered.some(question => question.required && !question.answer.trim())) throw new Error('请补充必答问题。')
      if (!answered.some(question => question.answer.trim())) throw new Error('请先填写补充。')
      target.questions = answered; target.requirementVersion++
      const text = answered.filter(question => question.answer.trim()).map(question => `${question.question}\n${question.answer}`).join('\n\n')
      if (text.length > 16_000) throw new Error('本次补充过长，请分次提交。')
      await sendOperation(target, api, fence, 'discuss', text, target.document, false)
    }),
    checkOperations: () => perform('operation', 'observe', async (target, api, fence) => {
      await read(target, fence)
      if (!fence.current() || !target.view || target.commandIssue) return
      if (target.selectionCommand) await resolveSelection(target, api, fence)
      for (const operation of [...target.operations].filter(item => operationPending(item) || item.state === 'unknown' || item.state === 'candidate')) {
        const observation = conversationValue(await api.observe(fence.conversationId, target.view.draft.id, operation.id))
        if (!fence.current()) return
        rememberObservation(target, observation, operation)
      }
      settleWorkbenchCommands(target)
      if (target.runCommand && !target.operations.some(operation => operation.commandId === target.runCommand?.commandId)) target.issue = { kind: 'operation', message: '尚未核实原操作是否派发，已保留原请求。请检查原会话后再次核对。' }
      if (fence.current()) void readConversation(entryKey)
    }),
    resumeOperation: () => perform('operation', 'observe', async (target, api, fence) => {
      if (!target.view || !target.runCommand) return
      await read(target, fence)
      if (!fence.current() || !target.view || target.commandIssue || !target.runCommand) return
      if (target.operations.some(operation => operation.commandId === target.runCommand?.commandId)) throw new Error('原操作已有登记，请检查原回执。')
      const command = target.runCommand
      const reply = await api.run(fence.conversationId, target.view.draft.id, command)
      if (!fence.ownsBuffer()) return
      if (!reply.ok) return rejectRun(target, fence, command, reply)
      const observation = reply.value
      rememberObservation(target, observation, command); settleWorkbenchCommands(target)
      if (observation.operation.sessionId && observation.operation.connectionGeneration && observation.operation.turnId && target.text.trim() === (command.text ?? '')) { target.text = ''; target.textAction = undefined; target.textVersion++ }
      void readConversation(entryKey)
    }),
    compare: operationId => { if (value && canInteract()) { value.comparing = operationId; notifyWorkbench() } },
    adopt: operationId => perform('operation', 'adopt', async (target, api, fence) => {
      const candidate = target.observations.get(operationId)
      if (!candidate) throw new Error('请先读取实际候选。')
      await adoptCandidate(target, api, fence, candidate, false)
    }),
    next: async () => {
      if (receipt?.task && receipt.state === 'created') return openTask(Boolean(onStartTrellis))
      if (receipt || value?.commitCommand) return commit()
      if (hasPlan && !planStale) { if (value?.document === 'requirement') { value.document = 'plan'; notifyWorkbench(); return }; return beginBuild() }
      await perform('operation', 'run', preparePlan)
    },
    beginBuild, selectTarget, commit, openTask, openSuccessor,
    refreshFiles: () => { if (active && canInteract() && isPrivateEntrySelected(entryKey)) void refreshFiles(entryKey) }
  }
}
