/** Native allowlist. Workspace authority comes from the authenticated host, never these bodies. */
import { z } from 'zod'
import { conversationProjectRoleSelectionSchema } from './conversation/project-role'
import { acpHistoryEventsInputSchema, acpHistoryUpdateInputSchema, acpHistoryDeleteInputSchema } from './acp-history'
import { workflowPreviewInputSchema, workflowStartInputSchema, workflowSnapshotInputSchema, workflowEventsInputSchema, workflowStopInputSchema, workflowArtifactInputSchema } from './workflow-application'
import { workflowRevisionPreviewInputSchema, workflowRevisionAcceptInputSchema, workflowRevisionStatusInputSchema } from './workflow-revisions'
import { workflowWorkspaceRecoveryInputSchema, workflowRecoveryArtifactInputSchema } from './workflow-recovery'
import { knowledgeRuntimeBody } from './daemon-runtime-knowledge'
import { acpHandoffPreviewInputSchema, acpHandoffCreateInputSchema, acpHandoffCancelInputSchema } from './acp-handoff'
import { taskProgressNativeSchema } from './crux-task-progress-native'
import { workcopyUseRequestSchema, workcopyCleanupRequestSchema } from './workcopy-use'
import { privateNativeReadSchema, privateNativeSendSchema, privateNativeControlSchema } from './private-conversations'
import { modelSelectionIdSchema } from './model-selection'
import { privateNativeConfigureSchema, privateNativeRecoverModelSchema } from './private-conversation-controls'
import { requirementPredecessorSchema } from './conversation-requirements'
import { runRefSchema } from './workflow'
import { nativeWorkflowCutoverRequestSchema } from './native-workflow-cutover'
import { nativeTaskPreparationRequestSchema } from './native-task-preparation'
import { nativeTaskExecutionRequestSchema, nativeTaskStartSchema } from './native-task-execution'
import { conversationModelOptionsSchema, conversationThreadCommandSchema } from './conversation/command-runtime'
import { CONVERSATION_READ_PAGE_LIMIT } from './conversation/desktop'
import { conversationTaskLocatorSchema } from './conversation/task-scope'
import { nativeConversationTaskSchema } from './conversation/task-native'
import { taskPlanningRuntimeBodies } from './conversation/task-planning-runtime'
import { openArtifactMcpGrantSchema } from './open-artifact'
import {
  ConversationAttachmentDraftTargetSchema, ConversationAttachmentIdSchema, ConversationAttachmentReadSchema,
  ConversationAttachmentWireBytesSchema, ConversationAttachmentWireKnowledgeSchema, conversationAttachmentReferenceFields,
} from './conversation/attachments'

export const RUNTIME_BULK = { chunkBytes: 96 * 1024, valueBytes: 128 * 1024 * 1024, spoolBytes: 512 * 1024 * 1024, transfers: 16, ttlMs: 10 * 60_000 } as const
const id = z.string().min(1).max(200).regex(/^[\w.-]+$/)
const empty = z.object({}).strict()
const conversationSequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const conversationPageLimit = z.number().int().min(1).max(CONVERSATION_READ_PAGE_LIMIT).optional()
const taskConversation = z.object({ task: nativeConversationTaskSchema.optional() }).strict()
export const desktopConversationTaskFields = { task: conversationTaskLocatorSchema.optional() }
export const runtimeBlobSchema = z.object({ id: z.string().uuid(), bytes: z.number().int().min(0).max(RUNTIME_BULK.valueBytes), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export type RuntimeBlob = z.infer<typeof runtimeBlobSchema>
/** Inline values stay below the control limit; a blob preserves original, untruncated JSON bytes. */
export const runtimeWireSchema = z.union([z.object({ inline: z.unknown() }).strict(), z.object({ blob: runtimeBlobSchema }).strict()])
export type RuntimeWire = z.infer<typeof runtimeWireSchema>
export const runtimeStatusSchema = z.object({ authority: z.enum(['legacy', 'daemon']), admission: z.enum(['open', 'closed']), sessions: z.number().int().nonnegative(), workflows: z.number().int().nonnegative(), operations: z.number().int().nonnegative(), released: z.boolean(), reason: z.string().max(400).optional() }).strict()
export const runtimeCursorSchema = z.object({ epoch: z.string().uuid(), sequence: z.number().int().nonnegative().safe() }).strict()
export type RuntimeCursor = z.infer<typeof runtimeCursorSchema>
const session = z.object({ sessionId: id }).strict()
/** Payloads are parsed after bounded wire/blob resolution, immediately before invoking the real facade. */
export const CONVERSATION_RUNTIME_METHODS: ReadonlySet<string> = new Set([
  'runtime.conversationModels',
  'runtime.conversationTaskScope',
  'runtime.conversationCreate',
  'runtime.conversationList',
  'runtime.conversationRead',
  'runtime.conversationCommand',
  'runtime.conversationEvents',
  'runtime.conversationApply',
  'runtime.conversationThreadCommand',
  'runtime.conversationEventDelta',
  'runtime.conversationHistory',
  'runtime.conversationDrivers',
  'runtime.conversationDescribeDriver',
  'runtime.conversationAttachmentStage',
  'runtime.conversationAttachmentList',
  'runtime.conversationAttachmentRelease',
  'runtime.conversationAttachmentRead',
  'runtime.taskPlanningCatalog',
  'runtime.taskPlanningLaunch',
  'runtime.taskPlanningObserve',
  'runtime.taskPlanningStop',
])

export const runtimeBodies = {
  ...taskPlanningRuntimeBodies,
  'runtime.workflowCutover': nativeWorkflowCutoverRequestSchema,
  'runtime.taskPreparation': nativeTaskPreparationRequestSchema,
  'runtime.taskExecution': nativeTaskExecutionRequestSchema,
  'runtime.taskExecutionPlan': z.object({ engine: nativeTaskStartSchema.shape.engine }).strict(),
  'runtime.privateRead': privateNativeReadSchema,
  'runtime.privateSend': privateNativeSendSchema,
  'runtime.privateCancel': privateNativeControlSchema,
  'runtime.privateEnd': privateNativeControlSchema,
  'runtime.privateRespond': privateNativeControlSchema,
  'runtime.privateConfigure': privateNativeConfigureSchema,
  'runtime.privateRecoverModel': privateNativeRecoverModelSchema,
  'runtime.workcopyUse': workcopyUseRequestSchema,
  'runtime.workcopyCleanup': workcopyCleanupRequestSchema,
  'runtime.cruxProgress': taskProgressNativeSchema,
  'runtime.conversationTaskScope': nativeConversationTaskSchema,
  'runtime.conversationModels': taskConversation.extend({ instanceId: z.string().min(1).max(64).default('codex') }),
  'runtime.conversationDrivers': taskConversation,
  'runtime.conversationDescribeDriver': taskConversation.extend({ instanceId: z.string().min(1).max(64).regex(/^[\w.-]+$/) }),
  'runtime.conversationCreate': taskConversation.extend({
    title: z.string().max(500).optional(), text: z.string().max(120000),
    model: z.string().min(1).max(8192), instanceId: z.string().min(1).max(64),
    commandId: z.string().uuid(), messageId: z.string().uuid().optional(),
    options: conversationModelOptionsSchema.optional(),
    role: conversationProjectRoleSelectionSchema.optional(),
    tags: z.array(z.string().trim().min(1).max(64).refine(value => !/[\p{Cc}]/u.test(value), 'Invalid thread tag.')).max(16).optional(),
    knowledgePageId: z.uuid().optional(),
    artifactMcp: openArtifactMcpGrantSchema.optional(),
    ...conversationAttachmentReferenceFields,
  }),
  'runtime.conversationList': taskConversation.extend({ archived: z.boolean().optional(), query: z.string().trim().max(160).optional() }),
  'runtime.conversationRead': taskConversation.extend({ threadId: z.string().min(1).max(200), artifactMcp: openArtifactMcpGrantSchema.optional() }),
  'runtime.conversationCommand': taskConversation.extend({ commandId: z.string().uuid() }),
  'runtime.conversationEvents': taskConversation.extend({
    threadId: z.string().min(1).max(200),
    afterSequence: conversationSequence,
    limit: conversationPageLimit,
  }),
  'runtime.conversationApply': taskConversation.extend({ command: conversationThreadCommandSchema, knowledgePageId: z.uuid().optional(), artifactMcp: openArtifactMcpGrantSchema.optional() }),
  'runtime.conversationThreadCommand': taskConversation.extend({ threadId: id, commandId: z.string().uuid() }),
  'runtime.conversationEventDelta': taskConversation.extend({
    threadId: id,
    cursor: z.object({ storageId: id, threadId: id, sequence: conversationSequence }).strict(),
    limit: conversationPageLimit,
  }),
  'runtime.conversationHistory': taskConversation.extend({
    threadId: id,
    cursor: z.object({ storageId: id, threadId: id, beforeRunOrdinal: conversationSequence }).strict(),
    limit: conversationPageLimit,
  }),
  'runtime.conversationAttachmentStage': z.union([
    ConversationAttachmentWireBytesSchema.extend(taskConversation.shape),
    ConversationAttachmentWireKnowledgeSchema.extend(taskConversation.shape),
  ]),
  'runtime.conversationAttachmentList': ConversationAttachmentDraftTargetSchema.extend(taskConversation.shape),
  'runtime.conversationAttachmentRelease': ConversationAttachmentDraftTargetSchema.extend({ ...taskConversation.shape, attachmentId: ConversationAttachmentIdSchema }),
  'runtime.conversationAttachmentRead': ConversationAttachmentReadSchema.extend(taskConversation.shape),
  'runtime.knowledge': knowledgeRuntimeBody,
  'runtime.sessions': z.object({ limit: z.number().int().min(1).max(200).optional() }).strict(),
  'runtime.agents': z.object({ refresh: z.boolean().optional() }).strict(),
  'runtime.setup': z.object({ runtimeId: id }).strict(),
  'runtime.setupStatus': z.object({ runtimeId: id.optional() }).strict(),
  'runtime.probe': z.object({ runtimeId: id }).strict(),
  'runtime.profiles': empty,
  'runtime.profileSave': z.object({ input: z.unknown() }).strict(),
  'runtime.profileDelete': z.object({ profileId: id }).strict(),
  'runtime.historySession': session,
  'runtime.historyEvents': session.extend({ input: acpHistoryEventsInputSchema }).strict(),
  'runtime.piImage': session.extend({ imageId: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  'runtime.historyUpdate': session.extend({ input: acpHistoryUpdateInputSchema }).strict(),
  'runtime.historyDeletePreview': session,
  'runtime.historyDelete': session.extend({ input: acpHistoryDeleteInputSchema }).strict(),
  'runtime.historyRegenerateTitle': session,
  'runtime.historyRetry': session,
  'runtime.new': z.object({ input: z.unknown() }).strict(),
  'runtime.handoffPreview': session.extend({ input: acpHandoffPreviewInputSchema }).strict(),
  'runtime.handoffCreate': session.extend({ input: acpHandoffCreateInputSchema }).strict(),
  'runtime.handoffStatus': session.extend({ operationId: z.string().uuid() }).strict(),
  'runtime.handoffCancel': session.extend({ input: acpHandoffCancelInputSchema }).strict(),
  'runtime.prompt': session.extend({ text: z.string().max(2 * 1024 * 1024), options: z.unknown().optional() }).strict(),
  'runtime.cancel': session, 'runtime.end': session, 'runtime.resume': session,
  'runtime.configure': session.extend({ input: z.unknown() }).strict(),
  'runtime.recover': session.extend({ input: z.object({ modelId: modelSelectionIdSchema, expectedConnectionGeneration: id }).strict() }).strict(),
  'runtime.bind': session.extend({ input: z.object({ taskDir: z.string().max(200).nullable(), expectedConnectionGeneration: id }).strict() }).strict(),
  'runtime.permission': z.object({ requestId: id, optionId: z.string().min(1).max(1000) }).strict(),
  'runtime.watcher': z.object({ path: z.string().min(1).max(8192), event: z.enum(['add', 'change', 'unlink']) }).strict(),
  'runtime.notify': z.object({ text: z.string().max(32000) }).strict(),
  'runtime.materialChange': z.object({ material: z.unknown() }).strict(),
  'runtime.timeline': z.object({ input: z.unknown() }).strict(),
  'runtime.workflow.templates': empty,
  'runtime.workflow.preview': workflowPreviewInputSchema,
  'runtime.workflow.start': workflowStartInputSchema,
  'runtime.workflow.snapshot': workflowSnapshotInputSchema,
  'runtime.workflow.requirementPredecessor': z.object({ predecessor: requirementPredecessorSchema, expectedRun: runRefSchema.optional() }).strict(),
  'runtime.workflow.events': workflowEventsInputSchema,
  'runtime.workflow.stop': workflowStopInputSchema,
  'runtime.workflow.previewRevision': workflowRevisionPreviewInputSchema,
  'runtime.workflow.acceptRevision': workflowRevisionAcceptInputSchema,
  'runtime.workflow.cancelRevision': workflowRevisionStatusInputSchema,
  'runtime.workflow.revisionStatus': workflowRevisionStatusInputSchema,
  'runtime.workflow.inspectWorkspaceRecovery': workflowWorkspaceRecoveryInputSchema,
  'runtime.workflow.readArtifact': workflowArtifactInputSchema,
  'runtime.workflow.readRecoveryArtifact': workflowRecoveryArtifactInputSchema,
  'runtime.workflow.resolveMaterialOwner': z.object({ relativePath: z.string().min(1).max(8192) }).strict(),
  'runtime.workflow.isManagedOrigin': session.extend({ generation: id.optional(), associationOnly: z.boolean().optional() }).strict(),
  'runtime.events': z.object({ after: runtimeCursorSchema.nullable(), limit: z.number().int().min(1).max(100).default(100) }).strict()
} as const
const wireRequests = Object.fromEntries(Object.keys(runtimeBodies).map(key => [key, runtimeWireSchema])) as { [M in keyof typeof runtimeBodies]: typeof runtimeWireSchema }
const wireResults = Object.fromEntries(Object.keys(runtimeBodies).map(key => [key, runtimeWireSchema])) as { [M in keyof typeof runtimeBodies]: typeof runtimeWireSchema }
export const runtimeRequests = {
  ...wireRequests,
  'runtime.status': empty,
  'runtime.command': z.object({ commandId: z.string().uuid() }).strict(),
  'runtime.blob.open': z.object({ bytes: runtimeBlobSchema.shape.bytes, sha256: runtimeBlobSchema.shape.sha256 }).strict(),
  'runtime.blob.append': z.object({ id: z.string().uuid(), offset: z.number().int().nonnegative().safe(), data: z.string().max(RUNTIME_BULK.chunkBytes * 4 / 3) }).strict(),
  'runtime.blob.seal': z.object({ id: z.string().uuid() }).strict(),
  'runtime.blob.read': z.object({ blob: runtimeBlobSchema, offset: z.number().int().nonnegative().safe() }).strict(),
  'runtime.blob.release': z.object({ id: z.string().uuid() }).strict()
} as const
export const runtimeResults = {
  ...wireResults,
  'runtime.status': runtimeStatusSchema,
  'runtime.command': z.object({ state: z.enum(['absent', 'dispatching', 'completed', 'unknown']), result: runtimeWireSchema.optional() }).strict(),
  'runtime.blob.open': runtimeBlobSchema,
  'runtime.blob.append': z.object({ offset: z.number().int().nonnegative().safe() }).strict(),
  'runtime.blob.seal': runtimeBlobSchema,
  'runtime.blob.read': z.object({ data: z.string().max(RUNTIME_BULK.chunkBytes * 4 / 3), next: z.number().int().nonnegative().safe(), done: z.boolean() }).strict(),
  'runtime.blob.release': z.null()
} as const
export type RuntimeMethod = keyof typeof runtimeRequests
export type RuntimeBodyMethod = keyof typeof runtimeBodies
export type RuntimeBody<M extends RuntimeBodyMethod> = z.input<(typeof runtimeBodies)[M]>
export type ConversationDesktopBody<M extends RuntimeBodyMethod> = Omit<RuntimeBody<M>, 'task'> & {
  task?: z.input<typeof conversationTaskLocatorSchema>
}
export type RuntimeRequest<M extends RuntimeMethod> = z.input<(typeof runtimeRequests)[M]>
export type RuntimeResult<M extends RuntimeMethod> = z.infer<(typeof runtimeResults)[M]>
export const RUNTIME_MUTATING_METHODS: readonly RuntimeMethod[] = [
  'runtime.taskPlanningLaunch', 'runtime.taskPlanningStop',
  'runtime.workflowCutover',
  'runtime.taskPreparation',
  'runtime.taskExecution',
  'runtime.privateSend', 'runtime.privateCancel', 'runtime.privateEnd', 'runtime.privateRespond', 'runtime.privateConfigure', 'runtime.privateRecoverModel',
  'runtime.workcopyUse',
  'runtime.workcopyCleanup',
  'runtime.knowledge',
  'runtime.conversationAttachmentStage', 'runtime.conversationAttachmentRelease',
  'runtime.conversationCreate', 'runtime.conversationApply', 'runtime.new', 'runtime.handoffCreate', 'runtime.handoffCancel', 'runtime.prompt', 'runtime.cancel', 'runtime.end', 'runtime.resume', 'runtime.configure', 'runtime.recover', 'runtime.bind', 'runtime.permission',
  'runtime.profileSave', 'runtime.profileDelete', 'runtime.historyUpdate', 'runtime.historyRetry', 'runtime.historyDelete', 'runtime.historyRegenerateTitle', 'runtime.setup', 'runtime.probe',
  'runtime.workflow.preview', 'runtime.workflow.start', 'runtime.workflow.stop', 'runtime.workflow.previewRevision', 'runtime.workflow.acceptRevision', 'runtime.workflow.cancelRevision'
]
