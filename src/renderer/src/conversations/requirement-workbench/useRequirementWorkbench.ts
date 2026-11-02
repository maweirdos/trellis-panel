import { useEffect, useMemo, useRef, useState } from 'react'
import {
  REQUIREMENT_BODY_BYTES, requirementAdoptSchema, requirementCommitSchema, requirementConfirmSchema,
  requirementRunSchema, requirementSavePlanSchema, requirementSaveSchema,
  type ConversationRequirementsApi, type RequirementAction, type RequirementDocument,
  type RequirementFileSelection, type RequirementObservation, type RequirementOperation,
  type RequirementQuestion, type RequirementReceipt, type RequirementTargetSelection, type RequirementView
} from '@shared/conversation-requirements'
import type { RequirementKnowledgeSelection, RequirementKnowledgeSourceRef } from '@shared/conversation-requirement-knowledge'
import type { ProjectSnapshot, TimelineEvent } from '@shared/types'
import { confirmDialog } from '../../components/Dialogs'
import { projectRootKey } from '../../my/navigation'
import { useInteractionActive, useInteractionGuard, useInteractionSignal } from '../../utils/interaction-scope'
import { conversationClient, conversationError, conversationValue } from '../client'
import { isPrivateEntrySelected } from '../source'
import { ensureConversation, readConversation, refreshFiles, saveDraft, sessionRunning, useConversations, type WorkspaceEntry } from '../workspace'
import type { DocumentEditorSelection } from './DocumentEditor'
import {
  acceptWorkbenchView, acquireWorkbench, assertWorkbenchView, findWorkbench, notifyWorkbench, operationPending,
  persistWorkbenchCommands, planDirty, projectRequirementEvents, rememberObservation, requirementDirty,
  restoreWorkbenchCommands, settleWorkbenchCommands, subscribeWorkbench, workbenchDirty,
  type WorkbenchBuffer, type WorkbenchIssue, type WorkbenchQuote
} from './workbench-state'

export interface RequirementWorkbenchOptions {
  entryKey: string
  requirementId?: string
  createCommandId: string
  onOpenTask(result: { snapshot: ProjectSnapshot; taskDir: string }): void | Promise<void>
  onStartTrellis?(result: { snapshot: ProjectSnapshot; taskDir: string; draftId: string }): void | Promise<void>
}
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
  events: TimelineEvent[]
  questions: RequirementQuestion[]
  candidates: RequirementObservation[]
  pendingOperations: RequirementOperation[]
  comparison?: RequirementObservation
  nextLabel: string
  nextDisabled: boolean
  editTitle(title: string): void
  editBody(body: string): void
  setDocument(document: RequirementDocument): void
  setText(text: string): void
  setFromConversation(checked: boolean): void
  setKnowledge(selection: RequirementKnowledgeSelection | undefined, sources: RequirementKnowledgeSourceRef[]): void
  quote(selection: DocumentEditorSelection, polish?: boolean): boolean
  clearQuote(): void
  answer(id: string, text: string): void
  toggleReference(reference: RequirementFileSelection, checked: boolean): void
  importInput(): void
  save(): Promise<void>
  reload(): Promise<void>
  useRemote(): Promise<void>
  keepLocal(): Promise<void>
  syncFile(): Promise<void>
  runAction(action: RequirementAction): Promise<void>
  submitAnswers(): Promise<void>
  checkOperations(): Promise<void>
  compare(operationId?: string): void
  adopt(operationId: string): Promise<void>
  next(): Promise<void>
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
function acceptReceipt(value: WorkbenchBuffer, receipt: RequirementReceipt): void {
  const command = value.commitCommand, draft = value.view?.draft
  if (!command || !draft || receipt.draftId !== draft.id || receipt.commandId !== command.commandId || receipt.draftRevision !== command.expectedRevision || receipt.targetId !== command.targetId || receipt.task && projectRootKey(receipt.task.root) !== projectRootKey(draft.target?.root)) throw new Error('任务交接回执来源不匹配，请核对原交接。')
  value.receipt = receipt
  settleWorkbenchCommands(value)
}

export function useRequirementWorkbench({ entryKey, requirementId, createCommandId, onOpenTask, onStartTrellis }: RequirementWorkbenchOptions): RequirementWorkbenchController {
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
  const readonly = Boolean(current?.locked || current?.conversation?.archivedAt !== undefined || value?.receipt || view?.draft.handoff || value?.commitCommand)

  const read = async (target: WorkbenchBuffer, fence: SourceFence): Promise<void> => {
    const api = requirementsApi(), id = target.view?.draft.id ?? requirementId
    const incoming = conversationValue(id ? await api.read(fence.conversationId, id) : await api.create(fence.conversationId, { commandId: createCommandId }))
    if (!fence.current()) return
    assertWorkbenchView(target, incoming)
    if (id && incoming.draft.id !== id) throw new Error('需求标识不匹配。')
    acceptWorkbenchView(target, incoming)
    restoreWorkbenchCommands(target)
    const receipt = target.receipt
    if (!target.commitCommand && receipt && receipt.state !== 'created' && target.view?.draft.plan) {
      target.commitCommand = requirementCommitSchema.parse({ commandId: receipt.commandId, expectedRevision: receipt.draftRevision, expectedPlanRevision: receipt.planRevision ?? target.view.draft.plan.revision, targetId: receipt.targetId })
      persistWorkbenchCommands(target)
    }
    settleWorkbenchCommands(target)
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

  const perform = async (kind: WorkbenchIssue['kind'], pending: string, action: (target: WorkbenchBuffer, api: ConversationRequirementsApi, fence: SourceFence) => Promise<void>): Promise<void> => {
    if (!value || value.pending || !canInteract() || displayOwner.current !== renderedOwner) return
    let fence: SourceFence
    try { fence = capture() } catch (cause) { value.issue = { kind, message: conversationError(cause) }; notifyWorkbench(); return }
    value.pending = pending; value.issue = undefined; notifyWorkbench()
    if (kind === 'load') setLoadIssue(undefined)
    const task = (async () => action(value, requirementsApi(), fence))()
    value.task = task
    try { await task }
    catch (cause) { if (fence.current()) value.issue = { kind, message: conversationError(cause) } }
    finally { if (value.task === task) { value.pending = undefined; value.task = undefined }; notifyWorkbench() }
  }
  const assertEditable = (target: WorkbenchBuffer): void => {
    if (!target.view || target.receipt || target.view.draft.handoff || target.commitCommand || target.commandIssue || current?.conversation?.archivedAt !== undefined) throw new Error('此需求暂不可编辑，请先核对交接状态。')
    if (target.remote) throw new Error('需求已有新版本，请先比较并处理本地修改。')
  }
  const saveAll = async (target: WorkbenchBuffer, api: ConversationRequirementsApi, fence: SourceFence, includePlan = true): Promise<boolean> => {
    assertEditable(target)
    const captured = versions(target)
    if (requirementDirty(target) && target.view) {
      const incoming = conversationValue(await api.save(fence.conversationId, target.view.draft.id, requirementSaveSchema.parse({ expectedRevision: target.view.draft.revision, title: target.title, body: target.body, references: target.references, questions: target.questions, expectedFileRevision: target.view.fileRevision ?? null })))
      if (!fence.current()) return false
      acceptWorkbenchView(target, incoming, { ...captured, document: 'requirement' }); notifyWorkbench()
    }
    if (!unchanged(target, captured)) return false
    if (includePlan && planDirty(target) && target.view) {
      const incoming = conversationValue(await api.savePlan(fence.conversationId, target.view.draft.id, requirementSavePlanSchema.parse({ expectedRevision: target.view.draft.revision, expectedPlanRevision: target.view.draft.plan?.revision ?? null, body: target.planBody, expectedFileRevision: target.view.planFileRevision ?? null })))
      if (!fence.current()) return false
      acceptWorkbenchView(target, incoming, { ...captured, document: 'plan' }); notifyWorkbench()
    }
    return fence.current() && unchanged(target, captured) && !requirementDirty(target) && (!includePlan || !planDirty(target))
  }
  const adoptCandidate = async (target: WorkbenchBuffer, api: ConversationRequirementsApi, fence: SourceFence, observation: RequirementObservation, automatic: boolean): Promise<void> => {
    assertEditable(target)
    const { operation, candidate } = observation, saved = target.view?.draft
    if (!candidate || operation.state !== 'candidate' || !operation.candidateRevision || !saved) throw new Error('候选尚不可采用，请检查执行与文件状态。')
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

  const sendOperation = async (target: WorkbenchBuffer, api: ConversationRequirementsApi, fence: SourceFence, action: RequirementAction, text: string, document: RequirementDocument, consumeText = true, quoteOverride?: WorkbenchQuote): Promise<void> => {
    assertEditable(target)
    if (target.runCommand || target.operations.some(operation => operationPending(operation) || operation.state === 'unknown')) throw new Error('请先检查上一次操作的实际状态。')
    const quote = quoteOverride ?? (consumeText ? target.quote : undefined)
    const quoteRevision = document === 'requirement' ? target.view?.draft.revision : target.view?.draft.plan?.revision
    if (quote && (quote.document !== document || quote.documentRevision !== quoteRevision || quote.editVersion !== (document === 'requirement' ? target.requirementVersion : target.planVersion))) throw new Error('引用后文档已改变，请重新选择引用。')
    const includePlan = document === 'plan' && action !== 'plan'
    if (!await saveAll(target, api, fence, includePlan) || !target.view || !fence.current()) return
    const captured = versions(target), textVersion = target.textVersion, savedRevision = target.view.draft.revision
    if (quote && !currentRevision(target, document)) throw new Error('请先保存被引用的文档。')
    // Persist the ordinary draft's configuration without dispatching its text or images.
    await saveDraft(entryKey)
    if (!fence.current() || !unchanged(target, captured) || requirementDirty(target) || includePlan && planDirty(target) || consumeText && target.textVersion !== textVersion) return
    if (target.view.draft.revision !== savedRevision) throw new Error('文档已更新，请核对后重新操作。')
    const input = requirementRunSchema.parse({
      expectedRevision: target.view.draft.revision, commandId: crypto.randomUUID(), action, document,
      ...(text.trim() ? { text: text.trim() } : {}), ...(quote ? { quote: { text: quote.text, bodyRevision: currentRevision(target, document) } } : {}),
      ...(target.fromConversation ? { fromConversation: true } : {}),
      ...(target.knowledgeSelection ? { knowledgeSelection: target.knowledgeSelection } : {}),
      ...(target.knowledgeSources.length ? { knowledgeSources: target.knowledgeSources } : {})
    })
    target.runCommand = input
    try { persistWorkbenchCommands(target) } catch (cause) { target.runCommand = undefined; throw cause }
    target.automatic = { commandId: input.commandId, sourceRevision: input.expectedRevision, sourceCurrent: fence.interactive, ...captured }
    notifyWorkbench()
    const result = await api.run(fence.conversationId, target.view.draft.id, input)
    // A first native binding may replace the generation before the RPC resolves.
    // Its receipted data belongs to this original buffer; interactive continuations
    // still require the exact current source below.
    if (!fence.ownsBuffer()) return
    const observation = conversationValue(result)
    rememberObservation(target, observation, input)
    settleWorkbenchCommands(target)
    const accepted = observation.operation.sessionId && observation.operation.connectionGeneration && observation.operation.turnId && ['running', 'candidate', 'adopted'].includes(observation.operation.state)
    if (accepted && consumeText && target.textVersion === textVersion) { target.text = ''; target.textVersion++ }
    if (accepted && quote && target.quote === quote) target.quote = undefined
    void readConversation(entryKey)
    if (fence.current() && observation.candidate && !workbenchDirty(target) && unchanged(target, captured)) await adoptCandidate(target, api, fence, observation, true)
  }

  const edit = (action: (target: WorkbenchBuffer) => void): boolean => {
    if (!value || readonly || value.commandIssue || !canInteract() || !isPrivateEntrySelected(entryKey) || displayOwner.current !== renderedOwner) return false
    try { action(value); value.issue = undefined; notifyWorkbench(); return true }
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
  const planStale = Boolean(view?.draft.plan?.stale || hasPlan && value && requirementDirty(value))
  const receipt = value?.receipt ?? view?.draft.handoff
  const canRun = Boolean(active && value?.view && !readonly && !busy && !value.commandIssue && !value.remote && !value.runCommand && !pendingOperations.length && !current?.action && current && !sessionRunning(current))

  const confirmRequirement = async (target: WorkbenchBuffer, api: ConversationRequirementsApi, fence: SourceFence): Promise<boolean> => {
    if (!await saveAll(target, api, fence, false) || !target.view || !fence.current()) return false
    if (!target.body.trim()) throw new Error('请先填写需求。')
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
    if (!target.view?.draft.plan || target.view.draft.plan.stale) throw new Error('请先完成当前需求的计划。')
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
      if (!draft.confirmed || !draft.plan || draft.plan.stale || !draft.target) throw new Error('请先保存计划并选择 Trellis 工程。')
      const controller = new AbortController(); confirmation.current = controller
      const confirmed = await confirmDialog({ title: '创建 Trellis 任务', message: `${draft.title}\n${draft.target.root}\n将固定当前需求与计划作为任务材料。`, confirmText: '创建任务' }, controller.signal)
      if (!confirmed || !fence.current()) return
      if (!unchanged(target, captured) || workbenchDirty(target) || target.view.draft.revision !== draft.revision) throw new Error('材料已改变，请保存后重新确认。')
      target.commitCommand = requirementCommitSchema.parse({ expectedRevision: draft.revision, expectedPlanRevision: draft.plan.revision, targetId: draft.target.id, commandId: crypto.randomUUID() })
      try { persistWorkbenchCommands(target) } catch (cause) { target.commitCommand = undefined; throw cause }
    }
    const result = conversationValue(await api.commit(fence.conversationId, target.view.draft.id, target.commitCommand))
    if (fence.current()) acceptReceipt(target, result)
  })
  const openTask = async (start = false): Promise<void> => perform('handoff', start ? 'start' : 'open', async (target, api, fence) => {
    const task = (target.receipt ?? target.view?.draft.handoff)?.task
    if (!target.view || !task) throw new Error('尚未收到实际任务回执。')
    if (start && (target.receipt ?? target.view.draft.handoff)?.state !== 'created') throw new Error('请先补全任务材料。')
    const opened = conversationValue(await api.open(fence.conversationId, target.view.draft.id))
    if (!fence.current()) return
    if (opened.conversationId !== fence.conversationId || opened.draftId !== target.view.draft.id || opened.task.taskId !== task.taskId || opened.taskDir !== task.taskDir || opened.task.taskDir !== task.taskDir || projectRootKey(opened.task.root) !== projectRootKey(task.root) || projectRootKey(opened.snapshot.meta.root) !== projectRootKey(task.root)) throw new Error('任务来源不匹配，未打开其他工程。')
    const result = { snapshot: opened.snapshot, taskDir: opened.taskDir }
    if (start && onStartTrellis) await onStartTrellis({ ...result, draftId: opened.draftId })
    else await onOpenTask(result)
  })
  return {
    current, buffer: value, view, issue: loadIssue ?? value?.issue, loading: !view && !loadIssue, active, readOnly: readonly,
    busy, assistantPending: Boolean(value?.pending === 'run' || pendingOperations.some(operationPending)), canRun,
    dirty: Boolean(value && workbenchDirty(value)), requirementDirty: Boolean(value && requirementDirty(value)), planDirty: Boolean(value && planDirty(value)),
    events, questions, candidates, pendingOperations, comparison: value?.comparing ? value.observations.get(value.comparing) : undefined,
    nextLabel: receipt?.task ? receipt.state === 'created' ? '打开任务' : '补全交接' : value?.commitCommand ? '检查本次交接' : hasPlan && !planStale ? view?.draft.target ? '创建 Trellis 任务' : '选择工程并交接' : hasPlan ? '更新计划' : '下一步：生成计划',
    nextDisabled: !active || !view || busy || Boolean(value?.commandIssue) || !receipt && !value?.commitCommand && (!value?.body.trim() || Boolean(value?.remote) || !hasPlan && !canRun || planStale && !canRun),
    editTitle: title => edit(target => { target.title = title; target.requirementVersion++ }),
    editBody: body => edit(target => { validateBody(body); if (target.document === 'requirement') { target.body = body; target.requirementVersion++ } else { target.planBody = body; target.planVersion++ } }),
    setDocument: document => { if (value && canInteract()) { value.document = document; notifyWorkbench() } },
    setText: text => { if (value && canInteract() && text.length <= 16_000) { value.text = text; value.textVersion++; notifyWorkbench() } },
    setFromConversation: checked => { if (value && canInteract()) { value.fromConversation = checked; notifyWorkbench() } },
    setKnowledge: (selection, sources) => { if (value && canInteract()) { value.knowledgeSelection = selection; value.knowledgeSources = sources.slice(0, 8); notifyWorkbench() } },
    quote: (selection, polish = false) => {
      let selected: WorkbenchQuote | undefined
      const accepted = edit(target => {
        if (!target.view || !selection.text.trim() || selection.text.length > 16_000) throw new Error('请选择不超过 16000 字的内容。')
        const document = target.document, revision = document === 'requirement' ? target.view.draft.revision : target.view.draft.plan?.revision
        if (selection.documentKey !== `${target.view.draft.id}:${document}` || selection.docRevision !== revision || selection.bodyRevision !== currentRevision(target, document)) throw new Error('选区来源已改变，请重新选择。')
        selected = { text: selection.text, document, documentRevision: revision ?? '', editVersion: document === 'requirement' ? target.requirementVersion : target.planVersion }
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
    clearQuote: () => { if (value && canInteract()) { value.quote = undefined; notifyWorkbench() } },
    answer: (id, text) => { if (value && canInteract() && text.length <= 8000) { value.answers = { ...value.answers, [id]: text }; notifyWorkbench() } },
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
    runAction: action => perform('operation', 'run', async (target, api, fence) => {
      if (action === 'plan' && !await confirmRequirement(target, api, fence)) return
      await sendOperation(target, api, fence, action, target.text, action === 'plan' ? 'plan' : target.document)
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
      if (!fence.current() || !target.view) return
      for (const operation of [...target.operations].filter(item => operationPending(item) || item.state === 'unknown' || item.state === 'candidate')) {
        const observation = conversationValue(await api.observe(fence.conversationId, target.view.draft.id, operation.id))
        if (!fence.current()) return
        rememberObservation(target, observation, operation)
      }
      settleWorkbenchCommands(target)
      if (target.runCommand && !target.operations.some(operation => operation.commandId === target.runCommand?.commandId)) target.issue = { kind: 'operation', message: '尚未核实原操作是否派发，已保留原请求。请检查原会话后再次核对。' }
      if (fence.current()) void readConversation(entryKey)
    }),
    compare: operationId => { if (value && canInteract()) { value.comparing = operationId; notifyWorkbench() } },
    adopt: operationId => perform('operation', 'adopt', async (target, api, fence) => {
      const candidate = target.observations.get(operationId)
      if (!candidate) throw new Error('请先读取实际候选。')
      await adoptCandidate(target, api, fence, candidate, false)
    }),
    next: async () => {
      if (receipt?.task && receipt.state === 'created') return openTask()
      if (receipt || value?.commitCommand) return commit()
      if (hasPlan && !planStale) { if (!view?.draft.target) return selectTarget(); return commit() }
      await perform('operation', 'run', async (target, api, fence) => {
        if (!await confirmRequirement(target, api, fence)) return
        await sendOperation(target, api, fence, 'plan', target.text, 'plan')
      })
    },
    selectTarget, commit, openTask,
    refreshFiles: () => { if (active && canInteract() && isPrivateEntrySelected(entryKey)) void refreshFiles(entryKey) }
  }
}
