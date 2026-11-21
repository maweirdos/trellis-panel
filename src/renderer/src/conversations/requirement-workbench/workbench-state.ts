import { z } from 'zod'
import {
  requirementCommitSchema, requirementConfirmSchema, requirementRunSchema, requirementApplySelectionSchema, requirementFileSelectionSchema, requirementQuestionSchema, requirementCreateSuccessorSchema,
  type RequirementCommit, type RequirementConfirm, type RequirementDocument,
  type RequirementFileSelection, type RequirementObservation, type RequirementOperation,
  type RequirementQuestion, type RequirementReceipt, type RequirementRun, type RequirementView, type RequirementSelectionReceipt
} from '@shared/conversation-requirements'
import { requirementKnowledgeSelectionSchema, requirementKnowledgeSourceRefSchema, type RequirementKnowledgeSelection, type RequirementKnowledgeSourceRef } from '@shared/conversation-requirement-knowledge'
import type { Conversation } from '@shared/private-conversations'
import type { TimelineEvent } from '@shared/types'
import { emptyRequirementDesignContext, requirementDesignContextSchema, type RequirementDesignContext } from '@shared/requirement-design-context'
import { projectRootKey } from '../../my/navigation'

export interface WorkbenchQuote {
  text: string
  document: RequirementDocument
  documentRevision: string
  editVersion: number
  anchor?: { kind: 'markdown'; from: number; to: number }
  comparisonOnly?: boolean
}
export interface WorkbenchIssue { kind: 'load' | 'save' | 'operation' | 'handoff' | 'successor'; message: string }
export interface WorkbenchSavedSelectionFence {
  beforeRevision?: string
  beforeBodyRevision?: string
  afterRevision?: string
  afterBodyRevision?: string
  requirementVersion: number
  planVersion: number
  body: string
}
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
  designContext: RequirementDesignContext
  answers: Record<string, string>
  requirementVersion: number
  planVersion: number
  text: string
  textVersion: number
  textAction?: RequirementRun['action']
  document: RequirementDocument
  quote?: WorkbenchQuote
  fromConversation: boolean
  knowledgeSelection?: RequirementKnowledgeSelection
  knowledgeSources: RequirementKnowledgeSourceRef[]
  observations: Map<string, RequirementObservation>
  operations: RequirementOperation[]
  selectionOperations: string[]
  planSourceIntents: Array<{ commandId: string; sourceRevision: string; signature: string }>
  selectedHandoffSources: string[]
  selectionCommand?: { operationId: string; kind?: 'polish'; input: z.infer<typeof requirementApplySelectionSchema> }
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
  restored?: boolean
  recoveryBase?: string
  planSourcesChanged?: boolean
  savedSelectionFences?: Partial<Record<RequirementDocument, WorkbenchSavedSelectionFence>>
}

const recoverySchema = z.object({
  revision: z.string(), title: z.string().max(200), body: z.string().max(200_000), planBody: z.string().max(200_000),
  references: z.array(requirementFileSelectionSchema).max(8), questions: z.array(requirementQuestionSchema).max(32),
  answers: z.record(z.string(), z.string().max(8000)), text: z.string().max(16_000),
  requirementDirty: z.boolean(), planDirty: z.boolean(), textAction: z.enum(['clarify', 'research', 'draft', 'revise', 'acceptance', 'plan', 'discuss']).optional(), planSourcesChanged: z.boolean().optional(),
  fromConversation: z.boolean().optional(), knowledgeSelection: requirementKnowledgeSelectionSchema.optional(), knowledgeSources: z.array(requirementKnowledgeSourceRefSchema).max(8).optional(), selectedHandoffSources: z.array(z.string().max(8192)).max(144).optional(), designContext: requirementDesignContextSchema.optional()
}).strict()
const recoveryKey = (value: WorkbenchBuffer): string => `tpanel.requirement-draft.v1.${encodeURIComponent(JSON.stringify([value.conversation.creatorId, value.conversation.id, value.view?.draft.id, projectRootKey(value.conversation.workspace.root)]))}`
const successorSchema = requirementCreateSuccessorSchema.extend({ successorId: z.string().uuid().optional() }).strict()
const successorKey = (value: WorkbenchBuffer): string => `tpanel.requirement-successor.v1.${encodeURIComponent(JSON.stringify([value.conversation.creatorId, value.conversation.id, value.view?.draft.id, projectRootKey(value.conversation.workspace.root)]))}`
export async function workbenchSuccessorCommandId(value: WorkbenchBuffer, handoffCommandId: string): Promise<string> {
  if (!value.view) throw new Error('原需求暂不可读取。')
  const identity = JSON.stringify(['requirement-successor-v1', value.conversation.creatorId, value.conversation.id, projectRootKey(value.conversation.workspace.root), value.view.draft.id, handoffCommandId])
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity))).slice(0, 16)
  bytes[6] = bytes[6] & 0x0f | 0x40; bytes[8] = bytes[8] & 0x3f | 0x80
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
export function readWorkbenchSuccessor(value: WorkbenchBuffer): z.infer<typeof successorSchema> | undefined {
  const raw = localStorage.getItem(successorKey(value))
  if (!raw) return undefined
  try { return successorSchema.parse(JSON.parse(raw)) } catch { throw new Error('后续需求的原请求记录不可读取，请保留记录并核对。') }
}
export function persistWorkbenchSuccessor(value: WorkbenchBuffer, command: z.infer<typeof successorSchema>): void {
  if (!value.view) throw new Error('原需求暂不可读取。')
  localStorage.setItem(successorKey(value), JSON.stringify(successorSchema.parse(command)))
}
export function assertWorkbenchSuccessor(value: WorkbenchBuffer, incoming: RequirementView, receipt: RequirementReceipt): void {
  const original = value.view?.draft, next = incoming.draft, predecessor = next.predecessor
  if (!original || !original.confirmed || !receipt.task || !receipt.planRevision || receipt.state !== 'created' || receipt.draftId !== original.id || receipt.confirmedRevision && receipt.confirmedRevision !== original.confirmed.revision || !predecessor || next.id === original.id || next.conversationId !== original.conversationId || next.creatorId !== original.creatorId || predecessor.draftId !== original.id || predecessor.handoffCommandId !== receipt.commandId || predecessor.draftRevision !== receipt.draftRevision || predecessor.planRevision !== receipt.planRevision || predecessor.confirmedRevision !== original.confirmed.revision || predecessor.bodyRevision !== original.confirmed.bodyRevision || predecessor.task.taskId !== receipt.task.taskId || predecessor.task.taskDir !== receipt.task.taskDir || projectRootKey(predecessor.task.root) !== projectRootKey(receipt.task.root)) throw new Error('后续需求与原任务身份不一致；未跳转。')
}
export const designHandoffKey = (file: { snapshotPath: string; source: { revision: string } }): string => JSON.stringify(['design', file.snapshotPath, file.source.revision])
function pruneDesignHandoffSelections(value: WorkbenchBuffer, view: RequirementView): void {
  const available = new Set((view.draft.designContextFiles ?? []).map(designHandoffKey))
  value.selectedHandoffSources = value.selectedHandoffSources.filter(key => !key.startsWith('["design",') || available.has(key))
}
export function persistWorkbenchDraft(value: WorkbenchBuffer): void {
  if (!value.view) return
  const dirty = requirementDirty(value), dirtyPlan = planDirty(value)
  if (!dirty && !dirtyPlan && !value.text && !Object.keys(value.answers).length && !value.planSourcesChanged && !value.fromConversation && !value.knowledgeSelection && !value.knowledgeSources.length && !value.selectedHandoffSources.length) { localStorage.removeItem(recoveryKey(value)); value.recoveryBase = undefined; return }
  const revision = value.remote ? value.recoveryBase ?? value.view.draft.revision : value.view.draft.revision
  localStorage.setItem(recoveryKey(value), JSON.stringify(recoverySchema.parse({ revision, title: value.title, body: value.body, planBody: value.planBody, references: value.references, questions: value.questions, designContext: value.designContext, answers: value.answers, text: value.text, textAction: value.textAction, requirementDirty: dirty, planDirty: dirtyPlan, planSourcesChanged: value.planSourcesChanged, fromConversation: value.fromConversation, knowledgeSelection: value.knowledgeSelection, knowledgeSources: value.knowledgeSources, selectedHandoffSources: value.selectedHandoffSources })))
  value.recoveryBase = revision
}
const draftTimers = new Map<WorkbenchBuffer, { trailing: ReturnType<typeof setTimeout>; deadline: ReturnType<typeof setTimeout>; idle?: number }>()
export function flushWorkbenchDraft(value: WorkbenchBuffer): void {
  const timers = draftTimers.get(value)
  if (timers) { clearTimeout(timers.trailing); clearTimeout(timers.deadline); if (timers.idle !== undefined && typeof cancelIdleCallback === 'function') cancelIdleCallback(timers.idle); draftTimers.delete(value) }
  persistWorkbenchDraft(value)
}
export function scheduleWorkbenchDraft(value: WorkbenchBuffer): void {
  const fail = (): void => {
    try { flushWorkbenchDraft(value) }
    catch (cause) { value.issue = { kind: 'save', message: `本地恢复稿保存失败：${cause instanceof Error ? cause.message : String(cause)}` }; notifyWorkbench() }
  }
  const defer = (): void => {
    const timers = draftTimers.get(value)
    if (!timers) return
    if (typeof requestIdleCallback === 'function') timers.idle = requestIdleCallback(fail, { timeout: 500 })
    else fail()
  }
  const existing = draftTimers.get(value)
  if (existing) { clearTimeout(existing.trailing); if (existing.idle !== undefined && typeof cancelIdleCallback === 'function') cancelIdleCallback(existing.idle); existing.idle = undefined; existing.trailing = setTimeout(defer, 250); return }
  draftTimers.set(value, { trailing: setTimeout(defer, 250), deadline: setTimeout(fail, 1000) })
}
export function restoreWorkbenchDraft(value: WorkbenchBuffer): void {
  if (!value.view || value.restored) return
  value.restored = true
  const raw = localStorage.getItem(recoveryKey(value))
  if (!raw) return
  const saved = recoverySchema.parse(JSON.parse(raw)), incoming = value.view
  value.text = saved.text; value.answers = saved.answers; value.textAction = saved.textAction; value.planSourcesChanged = saved.planSourcesChanged
  value.fromConversation = saved.fromConversation ?? false; value.knowledgeSelection = saved.knowledgeSelection; value.knowledgeSources = saved.knowledgeSources ?? []
  value.selectedHandoffSources = saved.selectedHandoffSources ?? []
  pruneDesignHandoffSelections(value, incoming)
  if (saved.requirementDirty) { value.title = saved.title; value.body = saved.body; value.references = saved.references; value.questions = saved.questions; value.designContext = saved.designContext ?? emptyRequirementDesignContext(); value.requirementVersion++ }
  if (saved.planDirty) { value.planBody = saved.planBody; value.planVersion++ }
  if ((saved.requirementDirty || saved.planDirty) && saved.revision !== incoming.draft.revision) { value.remote = incoming; value.recoveryBase = saved.revision }
}

export function isDocumentEditInstruction(text: string): boolean {
  const paragraphs = text.trim().split(/\n\s*\n/).map(value => value.trim()).filter(Boolean)
  if (paragraphs.some(value => /(?:不要|无需|不用|禁止|别).{0,12}(?:修改|更新|完善|改写|重写|整理|补充|润色|生成)/.test(value))) return false
  return paragraphs.some(value => {
    if (/(?:请问|怎么|如何|为什么|是否|能否|能不能|可不可以|建议|举例|解释|讨论|看看|检查|分析|评估|判断|哪些|哪里|需要修改|说明|介绍|总结|列出|回顾)/.test(value)) return false
    if (/[?？]\s*$/.test(value) && !/(?:帮我|请直接|请你|请把|请将)/.test(value)) return false
    const imperative = /^(?:(?:请(?:你|帮我|直接)?|帮我|麻烦(?:你)?|直接)\s*)?(?:修改|更新|完善|改写|重写|整理|补充|润色|生成|把|将|根据)/.test(value)
    const explicit = imperative && /(?:修改|更新|完善|改写|重写|整理|补充|润色|生成)/.test(value) && /(?:需求|文档|正文|草稿|计划|选区|选中|这段|所引用)/.test(value)
    const directed = /^(?:请|帮我|把|将|直接|麻烦)/.test(value) && /(?:写入|写进|加入|添加|删除|移除)/.test(value) && /(?:需求|文档|正文|草稿|计划|范围|验收|选区|选中|这段)/.test(value)
    return explicit || directed
  })
}

const BUFFER_LIMIT = 16, COMMAND_LIMIT = 32, CANDIDATE_LIMIT = 8
const buffers = new Map<string, WorkbenchBuffer>(), aliases = new Map<string, string>()
const listeners = new Set<() => void>()
export const notifyWorkbench = (): void => { for (const listener of listeners) listener() }
export function subscribeWorkbench(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } }
export const workbenchKey = (conversation: Conversation, id: string): string => JSON.stringify([conversation.creatorId, conversation.id, projectRootKey(conversation.workspace.root), id])
const files = (view: RequirementView): RequirementFileSelection[] => view.draft.references.map(({ fileId, revision }) => ({ fileId, revision }))
const design = (view: RequirementView): RequirementDesignContext => requirementDesignContextSchema.parse((view.draft as typeof view.draft & { designContext?: unknown }).designContext ?? emptyRequirementDesignContext())
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
export const requirementDirty = (value: WorkbenchBuffer): boolean => Boolean(value.view && (value.title !== value.view.draft.title || value.body !== value.view.draft.body || !equal(value.references, files(value.view)) || !equal(value.questions, value.view.draft.questions) || !equal(value.designContext, design(value.view))))
export const planDirty = (value: WorkbenchBuffer): boolean => Boolean(value.view && value.planBody !== (value.view.draft.plan?.body ?? ''))
export const workbenchDirty = (value: WorkbenchBuffer): boolean => requirementDirty(value) || planDirty(value)
export const planSourceSignature = (value: WorkbenchBuffer): string => JSON.stringify([value.fromConversation, value.knowledgeSelection ?? null, value.knowledgeSources])
export function planSourcesMatch(value: WorkbenchBuffer, operation: RequirementOperation): boolean {
  const intent = value.planSourceIntents.find(item => item.commandId === operation.commandId)
  return Boolean(intent && intent.sourceRevision === operation.sourceRevision && intent.signature === planSourceSignature(value))
}
export function workbenchFileSaveBlock(view: RequirementView, includePlan: boolean): string | undefined {
  if (view.fileState !== 'saved' || view.fileRevision !== view.draft.bodyRevision) return '需求文件与已保存版本不一致，请先核对实际文件。'
  if (includePlan && view.draft.plan && (view.planFileState !== 'saved' || view.planFileRevision !== view.draft.plan.bodyRevision)) return '计划文件与已保存版本不一致，请先核对实际文件。'
  return undefined
}
export function runRejectionProven(result: { outcome?: unknown; notSent?: unknown }): boolean {
  return result.outcome === 'not-admitted' || result.notSent === true
}
export function selectionVersionMatches(value: WorkbenchBuffer, document: RequirementDocument, revision?: string, bodyRevision?: string): boolean {
  const draft = value.view?.draft
  if (!draft || !revision || !bodyRevision || document === 'plan' && !draft.plan) return false
  const current = document === 'requirement' ? draft.revision : draft.plan?.revision
  const currentBody = document === 'requirement' ? draft.bodyRevision : draft.plan?.bodyRevision
  if (revision === current && bodyRevision === currentBody) return true
  const saved = value.savedSelectionFences?.[document], body = document === 'requirement' ? value.body : value.planBody
  return Boolean(saved && revision === saved.beforeRevision && bodyRevision === saved.beforeBodyRevision && saved.afterRevision === current && saved.afterBodyRevision === currentBody && saved.body === body && saved.requirementVersion === value.requirementVersion && saved.planVersion === value.planVersion)
}
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
    conversation, createCommandId, title: '需求草稿', body: '', planBody: '', references: [], questions: [], designContext: emptyRequirementDesignContext(), answers: {},
    requirementVersion: 0, planVersion: 0, text: '', textVersion: 0, document: 'requirement', fromConversation: false,
    knowledgeSources: [], observations: new Map(), operations: [], selectionOperations: [], planSourceIntents: [], selectedHandoffSources: []
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
  const requirementChanged = previous && (previous.draft.title !== incoming.draft.title || previous.draft.bodyRevision !== incoming.draft.bodyRevision || !equal(previous.draft.questions, incoming.draft.questions) || !equal(files(previous), files(incoming)) || !equal(design(previous), design(incoming)))
  const planChanged = previous && previous.draft.plan?.bodyRevision !== incoming.draft.plan?.bodyRevision
  if (!acknowledgement && (wasRequirementDirty && requirementChanged || wasPlanDirty && planChanged)) {
    value.remote = incoming
    return
  }
  const keepRequirement = acknowledgement ? acknowledgement.document === 'plan' || acknowledgement.document === 'metadata' ? wasRequirementDirty : value.requirementVersion !== acknowledgement.requirementVersion : wasRequirementDirty
  const keepPlan = acknowledgement ? acknowledgement.document === 'requirement' || acknowledgement.document === 'metadata' ? wasPlanDirty : value.planVersion !== acknowledgement.planVersion : wasPlanDirty
  value.view = incoming; value.remote = undefined
  pruneDesignHandoffSelections(value, incoming)
  if (!incoming.draft.plan && value.document === 'plan') value.document = 'requirement'
  if (!keepRequirement) { value.title = incoming.draft.title; value.body = incoming.draft.body; value.references = files(incoming); value.questions = incoming.draft.questions.map(question => ({ ...question })); value.designContext = design(incoming) }
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
export function selectionReceiptIsCurrent(operation: RequirementOperation, receipt: RequirementSelectionReceipt, incoming: RequirementView, inputDigest: string, bodyDigest: string): boolean {
  const saved = incoming.draft.operations.find(item => item.id === operation.id)
  if (receipt.operationId !== operation.id || receipt.expectedRevision !== operation.sourceRevision || receipt.candidateRevision !== operation.candidateRevision || receipt.inputDigest !== inputDigest || receipt.bodyRevision !== bodyDigest || saved?.state !== 'adopted' || saved.commandId !== operation.commandId || JSON.stringify(saved.selectionReceipt) !== JSON.stringify(receipt)) throw new Error('选区采用回执与原操作不一致，已保留本地修改。')
  if (incoming.draft.revision !== receipt.adoptedRevision) return false
  const bodyRevision = operation.document === 'plan' ? incoming.draft.plan?.bodyRevision : incoming.draft.bodyRevision
  if (bodyRevision !== receipt.bodyRevision) throw new Error('选区采用版本与回执不一致，已保留本地修改。')
  return true
}
export function selectionRejectionProven(result: { code: string; outcome?: unknown }, operation: RequirementOperation, view?: RequirementView): boolean {
  if (result.outcome === 'not-admitted') return true
  if (!view || !['E_CONFLICT', 'E_INVALID_ARG', 'E_DENIED', 'E_BUSY', 'E_NOT_FOUND'].includes(result.code)) return false
  const prior = view.draft.operations.find(item => item.id === operation.id)
  return !view.pendingSave && view.draft.revision === operation.sourceRevision && view.fileState === 'saved' && (operation.document !== 'plan' || view.planFileState === 'saved') && prior?.state === 'candidate' && !prior.selectionReceipt && prior.commandId === operation.commandId && prior.candidateRevision === operation.candidateRevision
}

const commandsSchema = z.object({ run: requirementRunSchema.optional(), confirm: requirementConfirmSchema.optional(), commit: requirementCommitSchema.optional(), selections: z.array(z.string().uuid()).max(128).optional(), selection: z.object({ operationId: z.string().uuid(), kind: z.literal('polish').optional(), input: requirementApplySelectionSchema }).strict().optional(), plans: z.array(z.object({ commandId: z.string().uuid(), sourceRevision: z.string().uuid(), signature: z.string().max(32_000) }).strict()).max(8).optional() }).strict()
const commandPrefix = (value: WorkbenchBuffer): string => `tpanel.requirement-workbench.v1.${encodeURIComponent(value.conversation.creatorId)}.`
const commandKey = (value: WorkbenchBuffer): string => `${commandPrefix(value)}${value.conversation.id}.${value.view?.draft.id}`
export function persistWorkbenchCommands(value: WorkbenchBuffer): void {
  if (!value.view) throw new Error('请先读取需求。')
  const key = commandKey(value)
  if (!value.runCommand && !value.confirmCommand && !value.commitCommand && !value.selectionOperations.length && !value.selectionCommand && !value.planSourceIntents.length) { localStorage.removeItem(key); return }
  let count = 0
  for (let index = 0; index < localStorage.length; index++) if (localStorage.key(index)?.startsWith(commandPrefix(value))) count++
  if (localStorage.getItem(key) === null && count >= COMMAND_LIMIT) throw new Error('待核对操作已达上限，请先检查已有操作。')
  localStorage.setItem(key, JSON.stringify(commandsSchema.parse({ run: value.runCommand, confirm: value.confirmCommand, commit: value.commitCommand, selections: value.selectionOperations, selection: value.selectionCommand, plans: value.planSourceIntents })))
}
export function restoreWorkbenchCommands(value: WorkbenchBuffer): void {
  try {
    const raw = localStorage.getItem(commandKey(value))
    if (!raw) { value.commandIssue = undefined; return }
    const commands = commandsSchema.parse(JSON.parse(raw))
    value.runCommand = commands.run; value.confirmCommand = commands.confirm; value.commitCommand = commands.commit; value.selectionOperations = commands.selections ?? []; value.selectionCommand = commands.selection; value.planSourceIntents = commands.plans ?? []; value.commandIssue = undefined
  } catch { value.commandIssue = '原操作记录暂不可读取，请保留记录并重新核对。' }
}
export function settleWorkbenchCommands(value: WorkbenchBuffer): void {
  const run = value.runCommand, operation = run && value.operations.find(item => item.commandId === run.commandId)
  if (run && operation && (operation.action !== run.action || operation.document !== run.document || operation.sourceRevision !== run.expectedRevision)) throw new Error('原操作命令与已保存回执不一致，请保留记录并核对。')
  if (operation && !operationPending(operation) && operation.state !== 'unknown') value.runCommand = undefined
  const confirmed = value.view?.draft.confirmed
  if (confirmed && confirmed.commandId === value.confirmCommand?.commandId) value.confirmCommand = undefined
  if ((value.receipt?.state === 'not-admitted' || value.receipt?.state === 'created' && value.receipt.task) && value.receipt.commandId === value.commitCommand?.commandId) value.commitCommand = undefined
  value.selectionOperations = value.selectionOperations.filter(commandId => {
    const item = value.operations.find(operation => operation.commandId === commandId)
    return !item || !item.quote && (operationPending(item) || item.state === 'unknown' || item.state === 'candidate')
  })
  value.planSourceIntents = value.planSourceIntents.filter(intent => { const operation = value.operations.find(item => item.commandId === intent.commandId); return !operation || operationPending(operation) || operation.state === 'unknown' || operation.state === 'candidate' })
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
