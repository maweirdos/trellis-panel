import { z } from 'zod'
import {
  requirementCommitSchema, requirementConfirmSchema, requirementRunSchema,
  type RequirementCommit, type RequirementConfirm, type RequirementDocument,
  type RequirementFileSelection, type RequirementObservation, type RequirementOperation,
  type RequirementQuestion, type RequirementReceipt, type RequirementRun, type RequirementView
} from '@shared/conversation-requirements'
import type { RequirementKnowledgeSelection, RequirementKnowledgeSourceRef } from '@shared/conversation-requirement-knowledge'
import type { Conversation } from '@shared/private-conversations'
import type { TimelineEvent } from '@shared/types'
import { projectRootKey } from '../../my/navigation'

export interface WorkbenchQuote {
  text: string
  document: RequirementDocument
  documentRevision: string
  editVersion: number
}
export interface WorkbenchIssue { kind: 'load' | 'save' | 'operation' | 'handoff'; message: string }
export interface WorkbenchBuffer {
  conversation: Conversation
  createCommandId: string
  view?: RequirementView
  remote?: RequirementView
  title: string
  body: string
  planBody: string
  references: RequirementFileSelection[]
  questions: RequirementQuestion[]
  answers: Record<string, string>
  requirementVersion: number
  planVersion: number
  text: string
  textVersion: number
  document: RequirementDocument
  quote?: WorkbenchQuote
  fromConversation: boolean
  knowledgeSelection?: RequirementKnowledgeSelection
  knowledgeSources: RequirementKnowledgeSourceRef[]
  observations: Map<string, RequirementObservation>
  operations: RequirementOperation[]
  automatic?: { commandId: string; requirementVersion: number; planVersion: number; sourceRevision: string; sourceCurrent(): boolean }
  runCommand?: RequirementRun
  confirmCommand?: RequirementConfirm
  commitCommand?: RequirementCommit
  receipt?: RequirementReceipt
  commandIssue?: string
  issue?: WorkbenchIssue
  pending?: string
  task?: Promise<void>
  comparing?: string
}

const BUFFER_LIMIT = 16, COMMAND_LIMIT = 32, CANDIDATE_LIMIT = 8
const buffers = new Map<string, WorkbenchBuffer>(), aliases = new Map<string, string>()
const listeners = new Set<() => void>()
export const notifyWorkbench = (): void => { for (const listener of listeners) listener() }
export function subscribeWorkbench(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } }
export const workbenchKey = (conversation: Conversation, id: string): string => JSON.stringify([conversation.creatorId, conversation.id, id])
const files = (view: RequirementView): RequirementFileSelection[] => view.draft.references.map(({ fileId, revision }) => ({ fileId, revision }))
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
export const requirementDirty = (value: WorkbenchBuffer): boolean => Boolean(value.view && (value.title !== value.view.draft.title || value.body !== value.view.draft.body || !equal(value.references, files(value.view)) || !equal(value.questions, value.view.draft.questions)))
export const planDirty = (value: WorkbenchBuffer): boolean => Boolean(value.view && value.planBody !== (value.view.draft.plan?.body ?? ''))
export const workbenchDirty = (value: WorkbenchBuffer): boolean => requirementDirty(value) || planDirty(value)
export const operationPending = (operation: RequirementOperation): boolean => ['reserved', 'dispatching', 'running'].includes(operation.state)
export function findWorkbench(conversation: Conversation, id: string, createCommandId: string): WorkbenchBuffer | undefined {
  const key = workbenchKey(conversation, id || `new:${createCommandId}`)
  return buffers.get(aliases.get(key) ?? key)
}
export function acquireWorkbench(conversation: Conversation, id: string | undefined, createCommandId: string): WorkbenchBuffer {
  const key = workbenchKey(conversation, id ?? `new:${createCommandId}`), existing = buffers.get(aliases.get(key) ?? key)
  if (existing) return existing
  if (buffers.size >= BUFFER_LIMIT) {
    const candidate = [...buffers].find(([, value]) => !workbenchDirty(value) && !value.pending && !value.text && !value.quote && !Object.keys(value.answers).length && !value.runCommand && !value.commitCommand && !value.confirmCommand && !value.operations.some(operationPending))
    if (!candidate) throw new Error('未保存的需求已达上限，请先保存已有需求。')
    buffers.delete(candidate[0])
    for (const [alias, target] of aliases) if (target === candidate[0]) aliases.delete(alias)
  }
  const value: WorkbenchBuffer = {
    conversation, createCommandId, title: '需求草稿', body: '', planBody: '', references: [], questions: [], answers: {},
    requirementVersion: 0, planVersion: 0, text: '', textVersion: 0, document: 'requirement', fromConversation: false,
    knowledgeSources: [], observations: new Map(), operations: []
  }
  buffers.set(key, value)
  return value
}
export function assertWorkbenchView(value: WorkbenchBuffer, incoming: RequirementView): void {
  const { draft } = incoming
  if (draft.conversationId !== value.conversation.id || draft.creatorId !== value.conversation.creatorId || value.view && draft.id !== value.view.draft.id) throw new Error('需求来源不匹配，已有内容保留。')
  const receipt = draft.handoff
  if (receipt && (receipt.draftId !== draft.id || receipt.targetId !== draft.target?.id || receipt.task && projectRootKey(receipt.task.root) !== projectRootKey(draft.target?.root))) throw new Error('任务交接来源不匹配，请重新核对。')
}
/** Reads never replace a dirty document with an externally changed document. */
export function acceptWorkbenchView(value: WorkbenchBuffer, incoming: RequirementView, acknowledgement?: { requirementVersion: number; planVersion: number; document?: RequirementDocument | 'metadata' }): void {
  assertWorkbenchView(value, incoming)
  const previous = value.view, wasRequirementDirty = requirementDirty(value), wasPlanDirty = planDirty(value)
  value.operations = incoming.draft.operations
  for (const [id, cached] of value.observations) {
    const operation = incoming.draft.operations.find(item => item.id === id)
    if (!operation || operation.state !== 'candidate' || operation.candidateRevision !== cached.operation.candidateRevision) value.observations.delete(id)
  }
  const requirementChanged = previous && (previous.draft.title !== incoming.draft.title || previous.draft.bodyRevision !== incoming.draft.bodyRevision || !equal(previous.draft.questions, incoming.draft.questions) || !equal(files(previous), files(incoming)))
  const planChanged = previous && previous.draft.plan?.bodyRevision !== incoming.draft.plan?.bodyRevision
  if (!acknowledgement && (wasRequirementDirty && requirementChanged || wasPlanDirty && planChanged)) {
    value.remote = incoming
    return
  }
  const keepRequirement = acknowledgement ? acknowledgement.document === 'plan' || acknowledgement.document === 'metadata' ? wasRequirementDirty : value.requirementVersion !== acknowledgement.requirementVersion : wasRequirementDirty
  const keepPlan = acknowledgement ? acknowledgement.document === 'requirement' || acknowledgement.document === 'metadata' ? wasPlanDirty : value.planVersion !== acknowledgement.planVersion : wasPlanDirty
  value.view = incoming; value.remote = undefined
  if (!keepRequirement) { value.title = incoming.draft.title; value.body = incoming.draft.body; value.references = files(incoming); value.questions = incoming.draft.questions.map(question => ({ ...question })) }
  if (!keepPlan) value.planBody = incoming.draft.plan?.body ?? ''
  value.receipt = incoming.draft.handoff ?? value.receipt
  const canonical = workbenchKey(value.conversation, incoming.draft.id), original = workbenchKey(value.conversation, `new:${value.createCommandId}`)
  if (buffers.get(original) === value) buffers.delete(original)
  buffers.set(canonical, value); aliases.set(original, canonical)
}
export function rememberObservation(value: WorkbenchBuffer, observation: RequirementObservation, expected?: RequirementOperation | RequirementRun): void {
  const operation = observation.operation
  if (expected && (operation.commandId !== expected.commandId || operation.action !== expected.action || operation.document !== expected.document || operation.sourceRevision !== ('expectedRevision' in expected ? expected.expectedRevision : expected.sourceRevision))) throw new Error('需求操作来源不匹配，未展示返回内容。')
  if (expected && 'id' in expected && operation.id !== expected.id) throw new Error('需求操作回执不匹配。')
  const known = value.operations.find(item => item.id === operation.id)
  if (known && (known.commandId !== operation.commandId || known.requestId !== operation.requestId || known.sourceRevision !== operation.sourceRevision || known.sourceBodyRevision !== operation.sourceBodyRevision || known.sourceDigest !== operation.sourceDigest || known.inputDigest !== operation.inputDigest || known.sessionId && operation.sessionId !== known.sessionId || known.connectionGeneration && operation.connectionGeneration !== known.connectionGeneration || known.turnId && operation.turnId !== known.turnId)) throw new Error('需求操作的固定来源已改变。')
  if (observation.candidate && (!['candidate', 'adopted'].includes(operation.state) || !operation.candidateRevision || !operation.candidateBodyRevision)) throw new Error('候选尚未通过实际执行与文件校验。')
  value.operations = [...value.operations.filter(item => item.id !== operation.id), operation].sort((a, b) => a.createdAt - b.createdAt)
  if (observation.candidate && !value.observations.has(operation.id) && value.observations.size >= CANDIDATE_LIMIT) {
    const first = [...value.observations.keys()].find(id => id !== value.comparing)
    if (first) value.observations.delete(first)
  }
  if (observation.candidate && operation.state === 'candidate') value.observations.set(operation.id, observation)
  else if (operation.state !== 'candidate') value.observations.delete(operation.id)
}

const commandsSchema = z.object({ run: requirementRunSchema.optional(), confirm: requirementConfirmSchema.optional(), commit: requirementCommitSchema.optional() }).strict()
const commandPrefix = (value: WorkbenchBuffer): string => `tpanel.requirement-workbench.v1.${encodeURIComponent(value.conversation.creatorId)}.`
const commandKey = (value: WorkbenchBuffer): string => `${commandPrefix(value)}${value.conversation.id}.${value.view?.draft.id}`
export function persistWorkbenchCommands(value: WorkbenchBuffer): void {
  if (!value.view) throw new Error('请先读取需求。')
  const key = commandKey(value)
  if (!value.runCommand && !value.confirmCommand && !value.commitCommand) { localStorage.removeItem(key); return }
  let count = 0
  for (let index = 0; index < localStorage.length; index++) if (localStorage.key(index)?.startsWith(commandPrefix(value))) count++
  if (localStorage.getItem(key) === null && count >= COMMAND_LIMIT) throw new Error('待核对操作已达上限，请先检查已有操作。')
  localStorage.setItem(key, JSON.stringify(commandsSchema.parse({ run: value.runCommand, confirm: value.confirmCommand, commit: value.commitCommand })))
}
export function restoreWorkbenchCommands(value: WorkbenchBuffer): void {
  try {
    const raw = localStorage.getItem(commandKey(value))
    if (!raw) { value.commandIssue = undefined; return }
    const commands = commandsSchema.parse(JSON.parse(raw))
    value.runCommand = commands.run; value.confirmCommand = commands.confirm; value.commitCommand = commands.commit; value.commandIssue = undefined
  } catch { value.commandIssue = '原操作记录暂不可读取，请保留记录并重新核对。' }
}
export function settleWorkbenchCommands(value: WorkbenchBuffer): void {
  const run = value.runCommand, operation = run && value.operations.find(item => item.commandId === run.commandId)
  if (run && operation && (operation.action !== run.action || operation.document !== run.document || operation.sourceRevision !== run.expectedRevision)) throw new Error('原操作命令与已保存回执不一致，请保留记录并核对。')
  if (operation && !operationPending(operation) && operation.state !== 'unknown') value.runCommand = undefined
  const confirmed = value.view?.draft.confirmed
  if (confirmed && confirmed.commandId === value.confirmCommand?.commandId) value.confirmCommand = undefined
  if (value.receipt?.state === 'created' && value.receipt.task && value.receipt.commandId === value.commitCommand?.commandId) value.commitCommand = undefined
  persistWorkbenchCommands(value)
}

/** Project only receipted native turns. The saved event log and internal prompt stay untouched. */
export function projectRequirementEvents(events: readonly TimelineEvent[], operations: readonly RequirementOperation[], root: string): TimelineEvent[] {
  return events.flatMap(event => {
    const operation = operations.find(item => item.sessionId && item.connectionGeneration && item.turnId && event.sessionId === item.sessionId && event.connectionGeneration === item.connectionGeneration && event.turnId === item.turnId && projectRootKey(event.projectRoot) === projectRootKey(root))
    if (!operation) return []
    if (event.kind === 'message' && event.payload?.role === 'user') return [{ ...event, text: operation.displayText, payload: { ...event.payload, content: operation.displayText, images: undefined } }]
    return [event]
  })
}
