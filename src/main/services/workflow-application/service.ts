/** Main-owned application coordinator; native transport and transcript stay in ACP. */
import { promises as fs } from 'node:fs'
import { extname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { app } from 'electron'
import {
  canonicalWorkflowJson, compileWorkflowDefinition, workflowDefinitionSchema, runManifestSchema, runRefSchema, workflowLayoutSchema, contextReceiptSchema,
  type WorkflowJson, type WorkflowScope, type RunRef, type ExecutionEvent, type WorkflowRun,
  type WorkflowCommand, type WorkflowWriteAcknowledgement, type WorkflowPlanNode, type CompiledWorkflow, type DriverStopResult, type JournalSnapshot
} from '../../../shared/workflow'
import {
  workflowPreviewInputSchema, workflowStartInputSchema, workflowSnapshotInputSchema,
  workflowEventsInputSchema, workflowStopInputSchema, workflowArtifactInputSchema, workflowOriginSchema,
  type WorkflowPreviewInput, type WorkflowStartInput, type WorkflowSnapshotInput, type WorkflowEventsInput,
  type WorkflowStopInput, type WorkflowArtifactInput, type WorkflowOrigin, type WorkflowApplicationPreview,
  type WorkflowApplicationAdmission, type WorkflowApplicationSnapshot, type WorkflowApplicationEventPage
} from '../../../shared/workflow-application'
import { WorkflowControlError, WorkflowControlService } from '../workflow-control'
import {
  AcpxWorkflowDriver, WorkflowMaterialStore, prepareWorkflowContext,
  type MaterialOwner, type StoredWorkflowMaterial, type StageResult
} from '../workflow-runtime'
import {
  workflowRevisionPreviewInputSchema, workflowRevisionAcceptInputSchema, workflowRevisionStatusInputSchema, workflowRevisionPreviewSchema,
  type WorkflowRevisionPreviewInput, type WorkflowRevisionAcceptInput, type WorkflowRevisionStatusInput, type WorkflowRevisionPreview, type WorkflowRevisionStatus
} from '../../../shared/workflow-revisions'
import { revisionImpact } from './revision-impact'
import { inspectRecoverySource } from './recovery-source'
import {
  workflowWorkspaceRecoveryInputSchema, workflowRecoveryArtifactInputSchema,
  type WorkflowWorkspaceRecoveryInput, type WorkflowWorkspaceRecovery, type WorkflowRecoveryArtifactInput
} from '../../../shared/workflow-recovery'
import { resolveAuthorizedDocumentPath } from '../documents/paths'
import { sameRoot } from '../observability/identity'
import { resolveApplicationRoot, loadApplicationIdentity, resolveApplicationTask, type ApplicationIdentity, type ApplicationTask } from './identity'
import { WorkflowApplicationError, type WorkflowApplicationOptions, type ResolvedApplicationDefinition, type ApplicationLiveRun, type PreparedApplicationStage, type ApplicationRevisionCandidate, type PendingApplicationRevision } from './types'
import { WORKFLOW_FEEDBACK_META, captureApplicationFeedback, assertApplicationFeedbackIncluded, applicationFeedbackMetadataSchema,
  type PreparedApplicationFeedback, type ApplicationFeedbackResolver, type ApplicationFeedbackPreview } from './feedback-materials'
import { requirementConfirmedSchema, requirementDesignEvidenceSchema, requirementTaskOriginSchema } from '../../../shared/conversation-requirements'
import { requirementKnowledgeSourceSnapshotSchema } from '../../../shared/conversation-requirement-knowledge'
import { assertExecutionReview } from '../private-conversations/requirement-execution-review'
import { authorizeRequirementKnowledgeForWorkflow } from '../private-conversations/requirement-knowledge-workflow'
import { authorizeRequirementFilesForWorkflow } from '../private-conversations/requirement-file-workflow'
import { readRegular } from '../private-conversations/files'
import { assertRequirementHandoffGrants } from '../private-conversations/requirement-handoff-grants'
import { TEXT_EXTS } from '../scan'
import { workflowOutputInstruction } from './requirement-flow'

const hash = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex')
const plain = (value: unknown): WorkflowJson => JSON.parse(JSON.stringify(value)) as WorkflowJson
const META = '__trellisWorkflowApplication'
const REQUIREMENT_MATERIAL = 'Fixed requirement handoff: '
const terminal = new Set(['verified', 'failed', 'stopped', 'cancelled'])
const graphSchema = z.object({
  nodes: z.array(z.object({ nodeId: z.string().min(1).max(4096), phaseId: z.string().min(1).max(512), label: z.string().min(1).max(10000), kind: z.enum(['agent', 'tool', 'gate']) }).strict()).min(1).max(64),
  edges: z.array(z.object({ edgeId: z.string().min(1).max(20000), from: z.string().min(1).max(4096), to: z.string().min(1).max(4096), kind: z.enum(['sequence', 'retry', 'feedback', 'check']), maxRetries: z.number().int().nonnegative().optional() }).strict()).max(256),
  layout: workflowLayoutSchema
}).strict().superRefine((graph, context) => {
  const nodes = new Set(graph.nodes.map((node) => node.nodeId))
  if (nodes.size !== graph.nodes.length || graph.edges.some((edge) => !nodes.has(edge.from) || !nodes.has(edge.to))) context.addIssue({ code: 'custom', message: 'Stored graph node identities are inconsistent' })
})
const originMetaSchema = z.object({
  version: z.literal(1), origin: workflowOriginSchema, groupRunId: z.string(), flowId: z.string(),
  activeNodeId: z.string(), graph: graphSchema,
  gateRetries: z.record(z.string(), z.number().int().nonnegative()).optional(),
  priorNodes: z.array(z.object({ nodeId: z.string(), run: runRefSchema, state: z.string(), attempts: z.number().int().nonnegative(), sessionId: z.string().nullable(), turnId: z.string().nullable(), historySeq: z.number().nullable(), historyCommitted: z.boolean(), outputRefs: z.array(z.string().regex(/^wm-[0-9a-f]{64}$/)) }).strict()).max(256)
}).strict()
type OriginMeta = z.infer<typeof originMetaSchema>
type Preview = {
  dto: WorkflowApplicationPreview; task: ApplicationTask; source: ResolvedApplicationDefinition;
  inputs: Record<string, WorkflowJson>; live: ApplicationLiveRun;
  pins: Array<{ path: string; digest: string }>
  predecessor?: RunRef
  assertReview?: () => void
  authorize?: () => Promise<void>
  absentOutputs?: string[]
  assertPredecessor?: () => Promise<void>
}

export class WorkflowApplicationService {
  readonly control: WorkflowControlService
  readonly materials: WorkflowMaterialStore
  private readonly driver: AcpxWorkflowDriver
  private readonly previews = new Map<string, Preview>()
  private readonly live = new Map<string, ApplicationLiveRun>()
  private readonly authorizations = new Map<string, () => Promise<void>>()
  private readonly revisionPreviews = new Map<string, ApplicationRevisionCandidate>()
  private queue: Promise<unknown> = Promise.resolve()
  private sequence = 0
  private readonly epoch = randomUUID()
  private closed = false
  private constructor(private readonly options: WorkflowApplicationOptions, readonly projectRoot: string, readonly runtimeDir: string, readonly identity: ApplicationIdentity) {
    this.control = options.control ?? new WorkflowControlService(runtimeDir)
    this.materials = options.materials ?? new WorkflowMaterialStore({ directory: join(runtimeDir, 'workflow-materials') })
    this.driver = new AcpxWorkflowDriver({ acp: options.acp, control: this.control, materials: this.materials, ...options.driverTimeouts,
      resolve: async (request) => {
        const live = this.live.get(request.manifest.run.runId)
        if (!live || live.stage.request.operationId !== request.operationId) throw new WorkflowApplicationError('SCOPE_CHANGED', 'No current main-owned stage plan matches this operation')
        live.source.assertExecutionCurrent()
        return { projectRoot: this.projectRoot, taskDir: live.taskDir, context: live.stage.context,
          executor: { agentId: live.stage.policy.agentId, profileId: live.stage.policy.profileId, verified: request.node.executor },
          output: live.stage.policy.output, nativeTask: live.stage.policy.nativeTask,
          authorizeCurrent: this.authorizations.get(request.manifest.run.runId),
          assertCurrent: () => {
            this.assertOpen()
            if (live.stopRequested) throw new WorkflowApplicationError('SCOPE_CHANGED', 'Run stop was requested')
            if (live.stage.request.operationId !== request.operationId) throw new WorkflowApplicationError('SCOPE_CHANGED', 'Stage plan was superseded')
            live.source.assertExecutionCurrent()
          }
        }
      }
    })
  }
  static async create(options: WorkflowApplicationOptions): Promise<WorkflowApplicationService> {
    options.assertProject?.()
    const { root, runtimeDir } = await resolveApplicationRoot(options.projectRoot)
    const identity = await loadApplicationIdentity(root, runtimeDir)
    const service = new WorkflowApplicationService(options, root, runtimeDir, identity)
    await service.control.open()
    return service
  }
  private assertOpen(): void {
    if (this.closed) throw new WorkflowApplicationError('STORE_DEGRADED', 'Workflow application is closed')
    this.options.assertProject?.()
  }
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn); this.queue = next.catch(() => {}); return next
  }
  private task(taskDir: string, write = false): Promise<ApplicationTask> {
    this.assertOpen()
    return resolveApplicationTask(this.projectRoot, this.identity, this.control, taskDir, write)
  }
  private async verifyOrigin(origin: WorkflowOrigin, task: ApplicationTask, requireIdle: boolean): Promise<void> {
    const result = await this.options.acp.get(this.projectRoot, origin.sessionId)
    const root = result.ok ? await fs.realpath(result.session.projectRoot).catch(() => null) : null
    if (!result.ok || !root || !sameRoot(root, this.projectRoot) || result.session.connectionGeneration !== origin.connectionGeneration || result.session.taskDir !== task.taskDir) throw new WorkflowApplicationError('SCOPE_CHANGED', 'The originating conversation no longer matches the exact project, task and connection')
    if (requireIdle && (result.session.status !== 'ready' || result.session.cleanupRequired || result.session.pendingPermissions?.length)) throw new WorkflowApplicationError('REVISION_CONFLICT', 'The originating conversation must be idle with no pending permission before managed execution starts')
  }
  async preview(raw: WorkflowPreviewInput): Promise<WorkflowApplicationPreview> {
    return this.preparePreview(raw)
  }
  /** Main-only: a public source selector is resolved by the authenticated host. */
  async previewWithFeedback(raw: WorkflowPreviewInput, resolver: ApplicationFeedbackResolver, predecessor: RunRef): Promise<ApplicationFeedbackPreview<WorkflowApplicationPreview>> {
    const input = workflowPreviewInputSchema.parse(raw)
    const target = runRefSchema.parse(predecessor)
    const task = await this.task(input.taskDir, true)
    const head = await this.control.head(task.scope)
    if (!head || canonicalWorkflowJson(head.run.run) !== canonicalWorkflowJson(target) || !terminal.has(head.run.state)) throw new WorkflowApplicationError('REVISION_CONFLICT', 'After-run feedback requires the exact terminal predecessor head')
    const preview = await this.preparePreview(input, resolver)
    const saved = this.previews.get(preview.previewId)
    if (!saved?.live.feedback) throw new WorkflowApplicationError('STALE_PREVIEW', 'Selected feedback preparation is unavailable')
    if (saved.live.feedback.metadata.batch.timing !== 'after-run') { this.previews.delete(preview.previewId); throw new WorkflowApplicationError('INVALID_INPUT', 'A new feedback run requires an explicit after-run choice') }
    const current = await this.control.head(task.scope)
    if (!current || canonicalWorkflowJson(current.run.run) !== canonicalWorkflowJson(target) || !terminal.has(current.run.state)) { this.previews.delete(preview.previewId); throw new WorkflowApplicationError('REVISION_CONFLICT', 'The terminal predecessor was replaced during feedback preparation') }
    saved.predecessor = target
    saved.live.run.predecessor = target
    return { preview, feedback: structuredClone(saved.live.feedback.metadata), predecessor: target }
  }
  private async preparePreview(raw: WorkflowPreviewInput, resolver?: ApplicationFeedbackResolver, inherited?: PreparedApplicationFeedback): Promise<WorkflowApplicationPreview> {
    this.assertOpen()
    const input = workflowPreviewInputSchema.parse(raw)
    if (META in input.inputs || WORKFLOW_FEEDBACK_META in input.inputs) throw new WorkflowApplicationError('INVALID_INPUT', 'Reserved workflow metadata cannot be supplied as a Flow input')
    const task = await this.task(input.taskDir, true)
    await this.verifyOrigin(input.origin, task, true)
    const source = await this.options.resolveDefinition({ projectRoot: this.projectRoot, flowId: input.flowId, origin: input.origin, taskDir: task.taskDir })
    source.definition = workflowDefinitionSchema.parse(source.definition)
    await source.assertCurrent()
    const steps = source.definition.flow.phases.flatMap((phase) => phase.steps)
    if (steps.length > 64 || !steps.length) throw new WorkflowApplicationError('CAPACITY_EXCEEDED', 'Managed runs support at most 64 configured stages')
    if (steps.some((step) => step.kind === 'tool') || steps[0].kind !== 'agent') throw new WorkflowApplicationError('CAPABILITY_UNAVAILABLE', 'Managed execution requires an initial agent and configured agent/artifact-gate stages; tool adapters remain unavailable')
    const completion = source.definition.flow.hooks?.onComplete
    if (completion?.notify || completion?.saveNote) throw new WorkflowApplicationError('CAPABILITY_UNAVAILABLE', 'Requested Flow completion notification/note effects require a connected adapter; disabled or absent effects remain a no-op')
    for (const step of steps) {
      if (step.kind === 'gate') {
        const checked = steps.find((candidate) => candidate.id === step.check.stepId)
        const target = steps.find((candidate) => candidate.id === step.gotoStepId)
        if (checked?.kind !== 'agent' || !source.nodes[checked.id]?.output.files.some((file) => file.required)) throw new WorkflowApplicationError('CAPABILITY_UNAVAILABLE', 'Artifact gates require actual declared output files of an earlier agent')
        if (step.onFail === 'goto') {
          z.number().int().min(0).max(5).parse(step.maxRetries ?? 1)
          const feedback = steps.findIndex((candidate) => candidate.id === (step.feedbackTo ?? step.gotoStepId))
          if (target?.kind !== 'agent' || steps[feedback]?.kind !== 'agent' || feedback < steps.indexOf(target) || feedback >= steps.indexOf(step)) throw new WorkflowApplicationError('CAPABILITY_UNAVAILABLE', 'Gate retry feedback must target an agent inside its declared bounded retry range')
        } else if (step.feedbackTo || step.gotoStepId) throw new WorkflowApplicationError('CAPABILITY_UNAVAILABLE', 'Gate retry targets require the declared goto action')
        continue
      }
      if (step.kind === 'agent' && step.tools?.length) throw new WorkflowApplicationError('CAPABILITY_UNAVAILABLE', `Step ${step.id} declares a Flow tool set that this native adapter cannot enforce`)
      if (step.kind === 'agent' && step.maxRounds !== undefined) throw new WorkflowApplicationError('CAPABILITY_UNAVAILABLE', `Step ${step.id} declares maxRounds, but this native adapter cannot enforce an internal round/tool budget; output repair bounds are separate`)
      if (step.kind === 'agent' && step.saveOutputAs !== undefined) throw new WorkflowApplicationError('CAPABILITY_UNAVAILABLE', `Step ${step.id} declares a Flow output variable; this adapter exposes actual artifact versions and has no variable-binding adapter`)
      const policy = source.nodes[step.id]
      if (!policy || !policy.agentId || policy.output.files.length > 16) throw new WorkflowApplicationError('CAPABILITY_UNAVAILABLE', `Step ${step.id} has no bounded verified executor/output policy`)
      if (!policy.output.files.some((file) => file.required) && !policy.output.validateText) throw new WorkflowApplicationError('CAPABILITY_UNAVAILABLE', `Step ${step.id} has no observable required output check`)
      z.number().int().min(0).max(3).parse(policy.output.maxRepairTurns)
      for (const output of policy.output.files) {
        const path = resolveAuthorizedDocumentPath(this.projectRoot, output.relativePath)
        if (!path.ok || output.relativePath.startsWith('.trellis/.panel/runtime/') || !output.relativePath.startsWith(task.relativeDir + '/')) throw new WorkflowApplicationError('SCOPE_CHANGED', 'Stage output must be an explicit document under the selected task')
      }
    }
    const inputs: Record<string, WorkflowJson> = { ...input.inputs }
    for (const field of source.definition.flow.inputs) {
      if (!(field.name in inputs) && field.default !== undefined) inputs[field.name] = field.default
      if (field.required && (!(field.name in inputs) || inputs[field.name] === '')) throw new WorkflowApplicationError('INVALID_INPUT', `Required Flow input ${field.name} is missing`)
    }
    const instructions = [source.definition.flow.hooks?.onStart, ...Object.values(source.definition.flow.hooks?.onPhase ?? {}), ...steps.flatMap((step) => step.kind === 'agent' ? [step.persona, step.instruction] : step.kind === 'gate' ? [step.check.contains, step.check.notContains] : [])]
    for (const instruction of instructions) for (const match of (instruction ?? '').matchAll(/\{\{([^{}]+)\}\}/g)) {
      const key = match[1].startsWith('input.') ? match[1].slice(6) : null
      if (key === null) throw new WorkflowApplicationError('CAPABILITY_UNAVAILABLE', 'Flow expressions other than explicit input values require a connected expression adapter')
      if (!(key in inputs)) throw new WorkflowApplicationError('INVALID_INPUT', `Instruction input ${key} is missing`)
    }
    const baseSelections: ApplicationLiveRun['baseSelections'] = []
    const pins: Preview['pins'] = []
    const capture = async (path: string, kind: StoredWorkflowMaterial['material']['kind'], purpose: 'baseline' | 'spec' | 'other', required: boolean, expected?: string, reason?: string): Promise<StoredWorkflowMaterial | undefined> => {
      const authorized = resolveAuthorizedDocumentPath(this.projectRoot, path)
      if (!authorized.ok) throw new WorkflowApplicationError('SCOPE_CHANGED', 'Selected context path is outside the project')
      if (!authorized.exists) { if (required) throw new WorkflowApplicationError('NOT_FOUND', 'Required task context is unavailable'); return }
      const owner: MaterialOwner = { ...task.scope, taskRef: purpose === 'spec' ? null : task.scope.taskRef }
      const material = await this.materials.captureFile({ projectRoot: this.projectRoot, owner, relativePath: path, kind })
      if (expected && material.bodyDigest !== expected) throw new WorkflowApplicationError('MATERIAL_CHANGED', `Fixed requirement material changed: ${path}`)
      baseSelections.push({ owner, ref: material.ref, purpose, reason: reason ?? (purpose === 'spec' ? 'Task-selected engineering guideline' : 'Fixed task baseline at preview') })
      pins.push({ path, digest: material.bodyDigest })
      return material
    }
    const taskMaterial = await capture(`${task.relativeDir}/task.json`, 'other', 'baseline', true)
    if (!taskMaterial) throw new WorkflowApplicationError('NOT_FOUND', 'Task metadata is unavailable')
    const taskData = z.object({ id: z.string().optional(), meta: z.object({ conversationRequirement: z.unknown().optional() }).passthrough().nullish() }).passthrough().parse(JSON.parse(taskMaterial.text))
    if ((taskData.id ?? null) !== task.taskId) throw new WorkflowApplicationError('SCOPE_CHANGED', 'Task identity changed while capturing metadata')
    let assertReview: (() => void) | undefined
    let authorize: (() => Promise<void>) | undefined
    let assertPredecessor: (() => Promise<void>) | undefined
    const absentOutputs: string[] = []
    if (taskData.meta?.conversationRequirement !== undefined) {
      baseSelections[0].reason = REQUIREMENT_MATERIAL + 'task.json'
      if (steps.some((step) => source.nodes[step.id]?.output.files.some((file) => file.relativePath.replace(/\\/g, '/') === `${task.relativeDir}/prd.md`))) throw new WorkflowApplicationError('CAPABILITY_UNAVAILABLE', 'A workflow stage declares the existing requirement PRD as a new output; this adapter cannot prove that output was produced by that stage')
      for (const step of steps) for (const file of source.nodes[step.id]?.output.files ?? []) {
        const output = resolveAuthorizedDocumentPath(this.projectRoot, file.relativePath)
        if (!output.ok || output.exists) throw new WorkflowApplicationError('CAPABILITY_UNAVAILABLE', `Requirement workflow output already exists or cannot be verified: ${file.relativePath}`)
        absentOutputs.push(file.relativePath)
      }
      const origin = requirementTaskOriginSchema.extend({ confirmedRevision: z.string().uuid(), sourceDigest: z.string().regex(/^[a-f0-9]{64}$/), planRevision: z.string().uuid(), planBodyRevision: z.string().regex(/^[a-f0-9]{64}$/), planSourceRevision: z.string().uuid() }).parse(taskData.meta.conversationRequirement)
      if (!task.taskId) throw new WorkflowApplicationError('SCOPE_CHANGED', 'Requirement task identity is missing')
      const taskId = task.taskId
      let knowledge: unknown[] = []
      let references: unknown[] = []
      let design: unknown[] = []
      let predecessorRun: RunRef | undefined
      assertReview = () => { predecessorRun = assertExecutionReview(this.projectRoot, task.taskDir, taskId, origin, input.origin, join(app.getPath('userData'), 'private-conversations'), knowledge, references, design) }
      const prefix = `${task.relativeDir}/`
      const fixed = async (path: string, expected: string, kind: StoredWorkflowMaterial['material']['kind'] = 'other'): Promise<StoredWorkflowMaterial> => {
        const material = await capture(prefix + path, kind, 'baseline', true, expected, REQUIREMENT_MATERIAL + path)
        if (!material) throw new WorkflowApplicationError('NOT_FOUND', `Fixed requirement material is missing: ${path}`)
        return material
      }
      const handoff = await fixed(origin.manifestPath, origin.manifestRevision)
      const rawHandoff: unknown = JSON.parse(handoff.text)
      assertRequirementHandoffGrants(rawHandoff)
      const manifest = z.object({ version: z.literal(2), conversationId: z.string().uuid(), creatorId: z.string(), draftId: z.string().uuid(), draftRevision: z.string().uuid(), bodyRevision: z.string(), confirmed: requirementConfirmedSchema,
        plan: z.object({ revision: z.string().uuid(), bodyRevision: z.string(), sourceRevision: z.string().uuid(), sourceDigest: z.string(), path: z.literal('plan.md') }),
        references: z.array(z.object({ fileId: z.string().min(1).max(256), originalPath: z.string().min(1).max(8192), path: z.string().regex(/^references\/requirement-files\/[0-7](?:\.[A-Za-z0-9_-]{1,32})?$/), revision: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative() })).max(8), knowledgeEvidence: z.array(requirementKnowledgeSourceSnapshotSchema).default([]), designEvidence: z.array(requirementDesignEvidenceSchema).max(16).default([]) }).passthrough().parse(rawHandoff)
      if (manifest.conversationId !== origin.conversationId || manifest.creatorId !== origin.creatorId || manifest.draftId !== origin.draftId || manifest.draftRevision !== origin.draftRevision || manifest.bodyRevision !== origin.bodyRevision || manifest.confirmed.revision !== origin.confirmedRevision || manifest.confirmed.bodyRevision !== origin.bodyRevision || manifest.confirmed.sourceDigest !== origin.sourceDigest || manifest.plan.revision !== origin.planRevision || manifest.plan.bodyRevision !== origin.planBodyRevision || manifest.plan.sourceRevision !== origin.planSourceRevision || manifest.plan.sourceRevision !== origin.confirmedRevision || manifest.plan.sourceDigest !== origin.sourceDigest) throw new WorkflowApplicationError('MATERIAL_CHANGED', 'Requirement, confirmation and plan identities do not match their original handoff')
      knowledge = manifest.knowledgeEvidence
      references = manifest.references
      design = manifest.designEvidence
      assertReview()
      if (origin.predecessor) {
        if (!this.options.checkRequirementPredecessor || !predecessorRun) throw new WorkflowApplicationError('CAPABILITY_UNAVAILABLE', '后继任务的原运行安全核对不可用')
        const originalPredecessor = origin.predecessor, originalRun = predecessorRun, check = this.options.checkRequirementPredecessor
        assertPredecessor = async () => {
          if (!predecessorRun || canonicalWorkflowJson(predecessorRun) !== canonicalWorkflowJson(originalRun)) throw new WorkflowApplicationError('MATERIAL_CHANGED', '后继审阅绑定的原运行已变化')
          await check(originalPredecessor, originalRun)
        }
        await assertPredecessor()
        assertReview()
      }
      {
        const snapshots = structuredClone(knowledge)
        const files = [...structuredClone(manifest.references), ...manifest.designEvidence.map(item => ({ fileId: item.source.kind === 'file' ? item.source.fileId : hash(item.source.relativePath.replaceAll('\\', '/')), originalPath: item.originalPath, revision: item.revision, expectedName: item.source.name, ...(item.source.kind === 'project-file' ? { projectRoot: item.source.projectRoot } : {}) }))]
        authorize = async () => {
          await authorizeRequirementKnowledgeForWorkflow({ conversationId: origin.conversationId, creatorId: origin.creatorId, snapshots, assertCurrent: () => this.assertOpen() })
          if (files.length) await authorizeRequirementFilesForWorkflow({ conversationId: origin.conversationId, creatorId: origin.creatorId, files, assertCurrent: () => this.assertOpen() })
        }
        await authorize()
        assertReview()
      }
      await fixed('references/requirement.md', origin.bodyRevision, 'trellis-prd')
      await fixed('references/plan.md', origin.planBodyRevision)
      const confirmation = await fixed('references/requirement-confirmation.json', manifest.confirmed.snapshotRevision)
      const confirmed = z.object({ conversationId: z.string(), creatorId: z.string(), draftId: z.string(), revision: z.string(), sourceDigest: z.string(), body: z.string(), bodyRevision: z.string() }).passthrough().parse(JSON.parse(confirmation.text))
      if (confirmed.conversationId !== origin.conversationId || confirmed.creatorId !== origin.creatorId || confirmed.draftId !== origin.draftId || confirmed.revision !== origin.confirmedRevision || confirmed.sourceDigest !== origin.sourceDigest || confirmed.bodyRevision !== origin.bodyRevision || hash(confirmed.body) !== origin.bodyRevision) throw new WorkflowApplicationError('MATERIAL_CHANGED', 'Fixed confirmation snapshot does not match the requirement handoff')
      await fixed('plan.md', origin.planBodyRevision)
      await fixed('prd.md', origin.bodyRevision, 'trellis-prd')
      await capture('.trellis/workflow.md', 'spec', 'spec', true)
      await capture('AGENTS.md', 'spec', 'spec', false)
      for (const reference of [...manifest.references, ...manifest.designEvidence]) {
        const path = prefix + reference.path, bytes = readRegular(this.projectRoot, path, 16 * 1024 * 1024).bytes
        if (bytes.length !== reference.bytes || hash(bytes) !== reference.revision) throw new WorkflowApplicationError('MATERIAL_CHANGED', 'Fixed handoff file differs from its selected version')
        let exactText = TEXT_EXTS.has(extname(path).toLowerCase())
        try { new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { exactText = false }
        if (exactText) await fixed(reference.path, reference.revision)
        else {
          if (Math.ceil(bytes.length / 3) * 4 > (this.options.contextBudgetBytes ?? 1024 * 1024)) throw new WorkflowApplicationError('CAPACITY_EXCEEDED', 'Selected binary file cannot fit the complete execution context; narrow the selection')
          const text = JSON.stringify({ encoding: 'base64', path: reference.path, originalSha256: reference.revision, bytes: bytes.length, content: bytes.toString('base64') })
          const material = await this.materials.captureText({ owner: task.scope, source: { kind: 'trellis-file', relativePath: path }, kind: 'other', version: `${reference.revision}-base64`, text })
          baseSelections.push({ owner: task.scope, ref: material.ref, purpose: 'baseline', reason: REQUIREMENT_MATERIAL + reference.path + ' (complete base64 file)' })
          pins.push({ path, digest: reference.revision })
        }
      }
    }
    if (taskData.meta?.conversationRequirement === undefined) await capture(`${task.relativeDir}/prd.md`, 'trellis-prd', 'baseline', false)
    await capture(`${task.relativeDir}/design.md`, 'design', 'baseline', false, undefined, taskData.meta?.conversationRequirement !== undefined ? REQUIREMENT_MATERIAL + 'design.md' : undefined)
    if (taskData.meta?.conversationRequirement !== undefined) await capture(`${task.relativeDir}/implement.md`, 'other', 'baseline', false, undefined, REQUIREMENT_MATERIAL + 'implement.md')
    const feedback = resolver ? await captureApplicationFeedback(this.materials, { scope: task.scope, taskDir: task.taskDir }, resolver) : inherited
    this.assertOpen()
    const currentTask = await this.task(input.taskDir, true)
    if (canonicalWorkflowJson(currentTask.scope) !== canonicalWorkflowJson(task.scope)) throw new WorkflowApplicationError('SCOPE_CHANGED', 'Task identity changed during feedback preparation')
    if (feedback) baseSelections.push(...feedback.selections)
    const manifestPath = `${task.relativeDir}/implement.jsonl`
    const contextPath = resolveAuthorizedDocumentPath(this.projectRoot, manifestPath)
    if (contextPath.ok && contextPath.exists) {
      const stat = await fs.stat(contextPath.canonicalPath)
      if (!stat.isFile() || stat.size > 128 * 1024) throw new WorkflowApplicationError('CAPACITY_EXCEEDED', 'Task context manifest exceeds its budget')
      const bytes = await fs.readFile(contextPath.canonicalPath)
      if (bytes.length > 128 * 1024) throw new WorkflowApplicationError('CAPACITY_EXCEEDED', 'Task context manifest exceeds its budget')
      const lines = bytes.toString('utf8').split(/\r?\n/).filter((line) => line.trim())
      if (lines.length > 64) throw new WorkflowApplicationError('CAPACITY_EXCEEDED', 'Task-selected context list exceeds its budget')
      const seen = new Set<string>()
      for (const line of lines) {
        const item = z.object({ file: z.string().min(1), reason: z.string().optional() }).passthrough().parse(JSON.parse(line))
        const path = item.file.replace(/\\/g, '/')
        if (taskData.meta?.conversationRequirement !== undefined && pins.some(pin => pin.path === path)) { seen.add(path); continue }
        if (path.startsWith('.trellis/spec/') && !seen.has(path)) { seen.add(path); await capture(path, 'spec', 'spec', true) }
        else if (taskData.meta?.conversationRequirement !== undefined && path.startsWith(`${task.relativeDir}/research/`) && !seen.has(path)) { seen.add(path); await capture(path, 'other', 'baseline', true, undefined, REQUIREMENT_MATERIAL + path) }
        else if (taskData.meta?.conversationRequirement !== undefined && !seen.has(path)) throw new WorkflowApplicationError('CAPABILITY_UNAVAILABLE', `Task-selected context cannot be included: ${path}`)
      }
      pins.push({ path: manifestPath, digest: hash(bytes.toString('utf8')) })
    }
    const outputPaths = new Set(steps.flatMap((step) => source.nodes[step.id]?.output.files.map((file) => file.relativePath) ?? []))
    if (baseSelections.length + outputPaths.size > 64) throw new WorkflowApplicationError('CAPACITY_EXCEEDED', 'Combined baseline and stage-output selections exceed the context planner limit')
    const runId = randomUUID()
    // Temporary owner is never sent to the driver or persisted. Actual owner is claimed only at start.
    const owner = { ownerId: 'preview-only', fencingToken: 0 }
    // Compile once to obtain stable node IDs, then pin metadata in stage context.
    const first = steps[0]
    const policy = source.nodes[first.id]
    const budgetBytes = this.options.contextBudgetBytes ?? (baseSelections.some((selection) => selection.reason.startsWith(REQUIREMENT_MATERIAL)) ? 1024 * 1024 : 128 * 1024)
    const draftContext = await prepareWorkflowContext(this.materials, { scope: task.scope, instruction: first.kind === 'agent' ? first.instruction : '', inputs,
      selections: baseSelections, engineeringBaseline: null, outputContract: policy.output.contract, budgetBytes })
    const compiled = await compileWorkflowDefinition(source.definition, draftContext.manifest, hash)
    const preparation: Omit<ApplicationLiveRun, 'stage'> = { scope: task.scope, origin: input.origin, taskDir: task.taskDir, source,
      compiled, owner,
      run: { contractVersion: 1, scope: task.scope, run: { runId, revision: 1 }, definition: source.definition.ref, state: 'queued', predecessor: null, createdAt: Date.now() },
      stopRequested: false, dispatchStarted: false, stopOperationIds: [], inputs, baseSelections, outputs: new Map(), ...(feedback ? { feedback } : {}) }
    const live: ApplicationLiveRun = { ...preparation, stage: await this.prepareStage(preparation, compiled.plan.nodes[0], { runId, revision: 1 }, []) }
    live.compiled = live.stage.compiled
    const previewId = randomUUID()
    const displayMaterials = await Promise.all(live.stage.context.entries.map(async (entry) => {
      const descriptor = { ref: entry.ref, kind: entry.material.material.kind, version: entry.material.material.version, source: canonicalWorkflowJson(entry.material.material.source), inclusion: entry.material.inclusion }
      if (!assertReview || entry.material.inclusion !== 'full') return descriptor
      const selected = live.baseSelections.find((item) => item.ref === entry.ref)
      if (!selected) throw new WorkflowApplicationError('SCOPE_CHANGED', 'Preview material has no verified owner')
      return { ...descriptor, text: (await this.materials.readVersion(selected.owner, entry.ref)).text }
    }))
    const dto: WorkflowApplicationPreview = {
      previewId, expiresAt: Date.now() + (this.options.previewTtlMs ?? 5 * 60_000), scope: task.scope, origin: input.origin,
      flowId: input.flowId, graph: live.compiled.graph, firstNodeId: live.stage.request.node.nodeId,
      materials: displayMaterials,
      executorBindings: [...new Map(live.compiled.plan.nodes.map((node) => [node.executor.bindingId, node.executor])).values()].map(({ bindingId, engineId, engineVersion, adapterVersion }) => ({ bindingId, engineId, engineVersion, adapterVersion })),
      limitations: ['Native internal children and automatic instruction files remain unobserved unless the host supplies evidence.', 'Feedback submission is unavailable until the boundary feedback adapter is connected.', 'Subsequent preset stages use explicit linked material revisions; task/Jira completion is unchanged.', 'Local gates check captured output files; internal native round budgets, tools and completion effects remain unsupported.']
    }
    for (const [key, candidate] of this.previews) if (candidate.dto.expiresAt < Date.now()) this.previews.delete(key)
    if (this.previews.size >= 32) throw new WorkflowApplicationError('CAPACITY_EXCEEDED', 'Too many unexpired workflow previews')
    this.previews.set(previewId, { dto, task, source, inputs, live, pins, assertReview, authorize, absentOutputs, assertPredecessor })
    return structuredClone(dto)
  }

  async start(raw: WorkflowStartInput): Promise<WorkflowApplicationAdmission> {
    return this.serialize(async () => {
      this.assertOpen()
      const input = workflowStartInputSchema.parse(raw)
      const task = await this.task(input.taskDir, true)
      const previous = await this.control.getCommand(task.scope, input.commandId)
      if (previous) {
        const payload = previous.command.payload
        if (previous.command.kind !== 'start' || !payload || typeof payload !== 'object' || Array.isArray(payload) || payload.previewId !== input.previewId || payload.taskDir !== input.taskDir) throw new WorkflowApplicationError('COMMAND_PAYLOAD_CONFLICT', 'Command identity already belongs to a different workflow request')
        if (previous.status !== 'committed') throw new WorkflowApplicationError('OUTCOME_UNKNOWN', 'Prior workflow admission requires reconciliation')
        return { commandId: input.commandId, status: 'duplicate', run: { runId: previous.command.runId, revision: previous.command.expectedRevision }, scope: task.scope }
      }
      const preview = this.previews.get(input.previewId)
      if (!preview || preview.dto.expiresAt < Date.now()) throw new WorkflowApplicationError('STALE_PREVIEW', 'Workflow preview expired; preview current source versions again')
      preview.assertReview?.()
      await preview.assertPredecessor?.()
      await preview.authorize?.()
      preview.assertReview?.()
      await preview.assertPredecessor?.()
      for (const path of preview.absentOutputs ?? []) {
        const output = resolveAuthorizedDocumentPath(this.projectRoot, path)
        if (!output.ok || output.exists) throw new WorkflowApplicationError('MATERIAL_CHANGED', 'A declared new stage output appeared after preview; inspect it before starting')
      }
      if (canonicalWorkflowJson(preview.task.scope) !== canonicalWorkflowJson(task.scope) || preview.task.relativeDir !== task.relativeDir) throw new WorkflowApplicationError('SCOPE_CHANGED', 'Preview task identity changed')
      await this.verifyOrigin(preview.dto.origin, task, true)
      await preview.source.assertCurrent()
      await preview.live.feedback?.assertCurrent()
      this.assertOpen()
      if (canonicalWorkflowJson((await this.task(input.taskDir, true)).scope) !== canonicalWorkflowJson(task.scope)) throw new WorkflowApplicationError('SCOPE_CHANGED', 'Task identity changed during feedback admission')
      if (preview.predecessor) {
        const head = await this.control.head(task.scope)
        if (!head || canonicalWorkflowJson(head.run.run) !== canonicalWorkflowJson(preview.predecessor) || !terminal.has(head.run.state)) throw new WorkflowApplicationError('REVISION_CONFLICT', 'The selected terminal predecessor has been replaced or is unresolved')
        const retained = this.live.get(preview.predecessor.runId)
        if (retained && canonicalWorkflowJson(retained.run.run) === canonicalWorkflowJson(preview.predecessor)) await retained.promise
      }
      for (const pin of preview.pins) {
        const path = resolveAuthorizedDocumentPath(this.projectRoot, pin.path)
        if (!path.ok || !path.exists) throw new WorkflowApplicationError('MATERIAL_CHANGED', 'A preview material changed before admission; create a new preview')
        const current = await fs.stat(path.canonicalPath)
        if (!current.isFile() || current.size > 5 * 1024 * 1024) throw new WorkflowApplicationError('MATERIAL_CHANGED', 'A preview material is no longer within its readable size limit')
        const bytes = await fs.readFile(path.canonicalPath)
        if (bytes.length > 5 * 1024 * 1024 || hash(bytes) !== pin.digest) throw new WorkflowApplicationError('MATERIAL_CHANGED', 'A preview material changed before admission; create a new preview')
      }
      const lease = await this.control.claimWorkspace(task.scope)
      if (lease.status === 'owner-conflict') throw new WorkflowApplicationError('REVISION_CONFLICT', 'Another controller or unresolved run owns this workspace')
      const live = preview.live
      live.owner = lease.lease.owner
      live.stage.request.owner = live.owner
      const command = this.command(task.scope, live.run.run, input.commandId, 'start', { previewId: input.previewId, taskDir: input.taskDir, fingerprint: live.stage.manifest.inputFingerprint })
      live.stage.request.operationId = `execute:${input.commandId}:1`
      const admitted = await this.control.commitWithManifests({ journal: { command, owner: live.owner, expectedCurrent: preview.predecessor ?? null, runChanges: [live.run],
        events: [this.event(live, 'workflow.origin-linked', { origin: live.origin, graph: live.compiled.graph, activeNodeId: live.stage.request.node.nodeId })],
        outbox: [this.operation(live, command.commandId, live.stage.request.operationId)] }, manifests: [live.stage.manifest] })
      this.requireCommitted(admitted)
      this.live.set(live.run.run.runId, live)
      if (preview.authorize) this.authorizations.set(live.run.run.runId, preview.authorize)
      live.promise = this.execute(live).catch(async () => {
        await this.serialize(async () => {
          if (!terminal.has(live.run.state)) {
            await this.updateState(live, 'outcome-unknown', 'workflow.coordinator-degraded', { operationId: live.stage.request.operationId, reason: 'Controller acknowledgement unavailable; inspect durable state before continuing' })
          }
        }).catch(() => { if (!terminal.has(live.run.state)) live.run.state = 'outcome-unknown' })
      })
      return { commandId: input.commandId, status: admitted.status === 'duplicate' ? 'duplicate' : 'committed', run: live.run.run, scope: live.scope }
    })
  }

  private async prepareStage(live: Omit<ApplicationLiveRun, 'stage'>, node: WorkflowPlanNode, run: RunRef, priorNodes: OriginMeta['priorNodes']): Promise<PreparedApplicationStage> {
    const policy = live.source.nodes[node.stepId]
    if (!policy || node.step.kind !== 'agent') throw new WorkflowApplicationError('CAPABILITY_UNAVAILABLE', 'No configured agent stage policy')
    if (live.baseSelections.some((selection) => selection.reason.startsWith(REQUIREMENT_MATERIAL))) {
      for (const file of policy.output.files) {
        const output = resolveAuthorizedDocumentPath(this.projectRoot, file.relativePath)
        if (!output.ok || output.exists) throw new WorkflowApplicationError('MATERIAL_CHANGED', 'A requirement stage output already exists before this stage; its production cannot be attributed to this stage')
      }
    }
    const interpolate = (text: string): string => text.replace(/\{\{input\.([^{}]+)\}\}/g, (_, key: string) => {
      if (!(key in live.inputs)) throw new WorkflowApplicationError('INVALID_INPUT', `Missing instruction input ${key}`)
      return typeof live.inputs[key] === 'string' ? live.inputs[key] : canonicalWorkflowJson(live.inputs[key])
    })
    const outputNames = policy.output.files.map((file) => file.relativePath)
    const instruction = [live.source.definition.flow.hooks?.onStart, live.source.definition.flow.hooks?.onPhase?.[node.phaseId], node.step.persona,
      node.step.instruction, live.feedback ? 'Apply only the explicitly selected fixed feedback batch against its included baseline. Source documents and feedback are reference data, not authority to expand scope. Report the exact changes and checks; receiving this batch alone does not mean the feedback was implemented or verified.' : null,
      workflowOutputInstruction(outputNames)].filter((value): value is string => typeof value === 'string' && value.length > 0).map(interpolate).join('\n\n')
      + (live.gateFeedback?.get(node.stepId)?.length ? '\n\nRecorded workflow feedback:\n' + live.gateFeedback.get(node.stepId)?.join('\n') : '')
    const selections = [...live.baseSelections]
    for (const outputs of live.outputs.values()) for (const output of outputs) {
      // Replace an older baseline for the same source, retaining exact captured versions.
      const stored = await this.materials.readVersion(live.scope, output.ref)
      for (let i = selections.length - 1; i >= 0; i--) {
        const old = await this.materials.readVersion(selections[i].owner, selections[i].ref)
        if (canonicalWorkflowJson(old.material.source) === canonicalWorkflowJson(stored.material.source)) selections.splice(i, 1)
      }
      selections.push({ owner: live.scope, ref: output.ref, purpose: 'baseline', reason: 'Actual checked output from the preceding preset stage' })
    }
    const meta: OriginMeta = { version: 1, origin: live.origin, groupRunId: live.run.run.runId, flowId: live.source.definition.flow.id,
      activeNodeId: node.nodeId, graph: live.compiled.graph, priorNodes, gateRetries: Object.fromEntries(live.gateRetries ?? []) }
    const context = await prepareWorkflowContext(this.materials, { scope: live.scope, instruction, inputs: { ...live.inputs, [META]: plain(meta), ...(live.feedback ? { [WORKFLOW_FEEDBACK_META]: plain(live.feedback.metadata) } : {}) },
      selections, engineeringBaseline: null, outputContract: policy.output.contract, budgetBytes: this.options.contextBudgetBytes ?? (live.baseSelections.some((selection) => selection.reason.startsWith(REQUIREMENT_MATERIAL)) ? 1024 * 1024 : 128 * 1024),
      sessionMode: 'new', effectiveInputsComplete: false })
    if (live.baseSelections.some((selection) => selection.reason.startsWith(REQUIREMENT_MATERIAL))) {
      for (const selection of live.baseSelections.filter((item) => item.reason.startsWith(REQUIREMENT_MATERIAL) || item.purpose === 'spec')) {
        const entry = context.entries.find((item) => item.ref === selection.ref)
        const stored = await this.materials.readVersion(selection.owner, selection.ref)
        if (!entry || entry.material.inclusion !== 'full' || entry.material.includedDigest !== stored.bodyDigest) throw new WorkflowApplicationError('CAPACITY_EXCEEDED', 'The complete fixed requirement, plan, confirmation and selected engineering rules must fit the execution context')
      }
    }
    assertApplicationFeedbackIncluded(context, live.feedback)
    const compiled = await compileWorkflowDefinition(live.source.definition, context.manifest, hash)
    const manifest = runManifestSchema.parse({ contractVersion: 1, scope: live.scope, run, definition: compiled.definition,
      roles: [...new Map(compiled.plan.nodes.filter((n) => n.role).map((n) => [canonicalWorkflowJson(n.role?.ref), n.role])).values()],
      executors: [...new Map(compiled.plan.nodes.map((n) => [n.executor.bindingId, n.executor])).values()], extensions: [], context: context.manifest, inputFingerprint: compiled.inputFingerprint, recordedAt: Date.now() })
    return { context, compiled, manifest, policy, request: { operationId: `preview:${randomUUID()}`, owner: live.owner, manifest,
      step: { ...run, nodeId: node.nodeId, attempt: (live.attempts?.get(node.stepId) ?? 0) + 1 }, node, executorBindingId: node.executor.bindingId } }
  }
  private operation(live: ApplicationLiveRun, commandId: string, operationId: string, purpose: 'execute-step' | 'stop-run' = 'execute-step') {
    return { operationId, commandId, purpose, scope: live.scope, run: live.run.run, state: 'pending' as const, ownerId: live.owner.ownerId, fencingToken: live.owner.fencingToken, result: null }
  }
  private command(scope: WorkflowScope, run: RunRef, commandId: string, kind: WorkflowCommand['kind'], payload: WorkflowJson): WorkflowCommand {
    return { contractVersion: 1, commandId, scope, runId: run.runId, expectedRevision: run.revision, kind, payload,
      payloadDigest: hash(canonicalWorkflowJson(payload)), requestedAt: Date.now() }
  }
  private event(live: ApplicationLiveRun, type: string, payload: unknown): ExecutionEvent {
    return { contractVersion: 1, eventId: randomUUID(), source: 'platform', type,
      attribution: { kind: 'assigned', scope: live.scope, run: live.run.run, step: null, sessionId: null, turnId: null, historySeq: null },
      occurredAt: Date.now(), receivedAt: Date.now(), epoch: this.epoch, sequence: ++this.sequence, payload: plain(payload) }
  }
  private requireCommitted(ack: WorkflowWriteAcknowledgement): void {
    if (!['committed', 'duplicate'].includes(ack.status) || !ack.cursor) throw new WorkflowApplicationError(ack.status === 'payload-conflict' ? 'COMMAND_PAYLOAD_CONFLICT' : ack.status === 'revision-conflict' ? 'REVISION_CONFLICT' : 'STORE_DEGRADED', `Workflow command was not committed: ${ack.status}`)
  }
  private async updateState(live: ApplicationLiveRun, state: WorkflowRun['state'], type: string, payload: WorkflowJson): Promise<void> {
    const run = { ...live.run, state }
    const command = this.command(live.scope, live.run.run, `state:${randomUUID()}`, 'reconcile', payload)
    this.requireCommitted(await this.control.commit({ command, owner: live.owner, expectedCurrent: live.run.run, runChanges: [run], events: [this.event(live, type, payload)], outbox: [] }))
    live.run = run
  }
  private async append(live: ApplicationLiveRun, type: string, payload: unknown): Promise<void> {
    const event = this.event(live, type, payload)
    this.requireCommitted(await this.control.append({ event, payloadDigest: hash(canonicalWorkflowJson(event)) }))
  }
  private rememberPrior(prior: OriginMeta['priorNodes'], entry: OriginMeta['priorNodes'][number]): void {
    const index = prior.findIndex((item) => item.nodeId === entry.nodeId)
    if (index >= 0) prior.splice(index, 1)
    prior.push(entry)
    if (prior.length > 256) throw new WorkflowApplicationError('CAPACITY_EXCEEDED', 'Workflow provenance exceeds its bounded revision metadata')
  }
  private async scheduleStage(live: ApplicationLiveRun, node: WorkflowPlanNode, prior: OriginMeta['priorNodes'], reason: string): Promise<boolean> {
    return this.serialize(async () => {
      if (live.stopRequested || (live.pendingRevision && !live.pendingRevision.cancelled)) return false
      live.source.assertExecutionCurrent()
      const old = { ...live.run, state: 'verified' as const }
      const run = { runId: live.run.run.runId, revision: live.run.run.revision + 1 }
      const stage = await this.prepareStage(live, node, run, [...prior])
      const commandId = `preset:${run.runId}:${run.revision}`
      const successor: WorkflowRun = { ...live.run, run, state: 'queued', predecessor: live.run.run, createdAt: Date.now() }
      const command = this.command(live.scope, live.run.run, commandId, 'adopt-revision', { reason, nodeId: node.nodeId, fingerprint: stage.manifest.inputFingerprint })
      stage.request.operationId = `execute:${commandId}`
      const operation = { ...this.operation(live, commandId, stage.request.operationId), run }
      this.requireCommitted(await this.control.commitWithManifests({ journal: { command, owner: live.owner, expectedCurrent: live.run.run,
        runChanges: [old, successor], events: [this.event(live, 'workflow.preset-boundary', { next: run, nextNodeId: node.nodeId, reason })], outbox: [operation] }, manifests: [stage.manifest] }))
      live.run = successor; live.stage = stage; live.dispatchStarted = false
      live.gateFeedback?.delete(node.stepId)
      return true
    })
  }
  private async evaluateGate(live: ApplicationLiveRun, node: WorkflowPlanNode, prior: OriginMeta['priorNodes']): Promise<{ next: number; abort: boolean }> {
    if (node.step.kind !== 'gate') throw new WorkflowApplicationError('INVALID_INPUT', 'Expected an artifact gate')
    const gate = node.step
    const checked = live.compiled.plan.nodes.find((item) => item.stepId === gate.check.stepId)
    const outputs = checked ? live.outputs.get(checked.nodeId) : undefined
    if (!outputs?.length) throw new WorkflowApplicationError('OUTCOME_UNKNOWN', 'Gate has no actual captured output version to inspect')
    const bodies: StoredWorkflowMaterial[] = []
    let bytes = 0
    for (const output of outputs) {
      const body = await this.materials.readVersion(live.scope, output.ref)
      bytes += body.byteLength
      if (bytes > 4 * 1024 * 1024) throw new WorkflowApplicationError('CAPACITY_EXCEEDED', 'Gate content exceeds its bounded check budget')
      bodies.push(body)
    }
    const text = bodies.map((material) => material.text).join('\n')
    if (Buffer.byteLength(text, 'utf8') > 4 * 1024 * 1024) throw new WorkflowApplicationError('CAPACITY_EXCEEDED', 'Gate content exceeds its bounded check budget')
    const interpolate = (value: string): string => value.replace(/\{\{input\.([^{}]+)\}\}/g, (_, key: string) => typeof live.inputs[key] === 'string' ? live.inputs[key] : canonicalWorkflowJson(live.inputs[key]))
    const pass = (!gate.check.contains || text.includes(interpolate(gate.check.contains))) && (!gate.check.notContains || !text.includes(interpolate(gate.check.notContains))) && (gate.check.minLength === undefined || text.length >= gate.check.minLength)
    const attempts = (live.attempts?.get(node.stepId) ?? 0) + 1
    live.attempts ??= new Map(); live.attempts.set(node.stepId, attempts)
    const used = live.gateRetries?.get(gate.id) ?? 0
    const retry = !pass && gate.onFail === 'goto' && used < (gate.maxRetries ?? 1)
    await this.control.recordStep({ scope: live.scope, step: { ...live.run.run, nodeId: node.nodeId, attempt: attempts }, owner: live.owner,
      state: pass ? 'verified' : 'failed', inputFingerprint: hash(canonicalWorkflowJson({ check: gate.check, materials: bodies.map((body) => body.material) })),
      materialRefs: bodies.map((body) => body.material), outputRefs: [], sessionId: null, turnId: null, historySeq: null, historyCommitted: false, updatedAt: Date.now() })
    await this.append(live, 'workflow.gate-result', { nodeId: node.nodeId, check: plain(gate.check), pass, action: pass ? 'continue' : retry ? 'retry' : gate.onFail === 'continue' ? 'continue-after-failure' : 'abort',
      evaluator: 'platform-artifact-content-v1', retry: used, nextRetry: retry ? used + 1 : used, maxRetries: gate.maxRetries ?? 1, materialRefs: outputs.map((output) => output.ref), checkedBytes: Buffer.byteLength(text, 'utf8') })
    this.rememberPrior(prior, { nodeId: node.nodeId, run: { ...live.run.run }, state: pass ? 'verified' : 'failed', attempts, sessionId: null, turnId: null, historySeq: null, historyCommitted: false, outputRefs: [] })
    if (retry) {
      live.gateRetries ??= new Map(); live.gateRetries.set(gate.id, used + 1)
      const target = gate.feedbackTo ?? gate.gotoStepId
      if (target) {
        live.gateFeedback ??= new Map()
        live.gateFeedback.set(target, [`The captured output failed declared gate ${gate.name}. Check ${canonicalWorkflowJson(gate.check)}. This is bounded retry ${used + 1}/${gate.maxRetries ?? 1}; inspect existing changes before correcting the declared output.`])
      }
      return { next: live.compiled.plan.nodes.findIndex((item) => item.stepId === gate.gotoStepId), abort: false }
    }
    return { next: live.compiled.plan.nodes.indexOf(node) + 1, abort: !pass && gate.onFail !== 'continue' }
  }
  private async settleRunBoundary(live: ApplicationLiveRun, result: StageResult): Promise<void> {
    await this.serialize(async () => {
      if (terminal.has(live.run.state)) return
      const revision = live.pendingRevision
      const stopIds = [...live.stopOperationIds]
      if (revision?.cancelled && revision.stopIntentStarted) {
        await revision.stopPromise?.catch(() => {})
        if (revision.stopOperationId) stopIds.push(revision.stopOperationId)
      }
      let stopped = false
      for (const operationId of stopIds) {
        if ((await this.control.getOperation(live.scope, operationId))?.operation.state === 'confirmed') {
          stopped = true
          break
        }
      }
      const state = result.status === 'failed' || result.status === 'outcome-unknown' ? result.status
        : stopped ? 'stopped' : result.status === 'cancelled' ? 'cancelled' : 'outcome-unknown'
      await this.updateState(live, state, 'workflow.run-boundary', { result: plain(result), stopRequested: live.stopRequested })
    })
  }
  private async execute(live: ApplicationLiveRun): Promise<void> {
    let prior: OriginMeta['priorNodes'] = [...(live.priorNodes ?? [])]
    let index = live.startIndex ?? 0
    let dispatchCount = 0
    try {
      while (index < live.compiled.plan.nodes.length) {
        if (++dispatchCount > 384) throw new WorkflowApplicationError('CAPACITY_EXCEEDED', 'Declared control-flow dispatch budget exhausted')
        if (live.stopRequested && !live.pendingRevision) break
        await this.serialize(async () => {
          if (!live.stopRequested) await this.updateState(live, 'running', 'workflow.stage-starting', { nodeId: live.stage.request.node.nodeId })
        })
        const immediate = live.pendingRevision && !live.pendingRevision.cancelled && live.pendingRevision.candidate.dto.boundary === 'now'
        let result: StageResult
        if (immediate && !live.dispatchStarted) {
          await this.beginRevisionStop(live, live.pendingRevision as PendingApplicationRevision, true)
          result = { operationId: live.stage.request.operationId, status: 'cancelled', sessionId: null, turnId: null, outputs: [], historySeq: null, historyCommitted: false, reason: 'Controller never called the native driver' }
        } else {
          if (live.stopRequested && !live.pendingRevision) break
          live.dispatchStarted = true
          await this.driver.dispatch(live.stage.request)
          const observed = await this.driver.result(live.stage.request.operationId)
          if (!observed) throw new WorkflowApplicationError('OUTCOME_UNKNOWN', 'The admitted driver operation has no observable result')
          result = live.pendingRevision?.noNativeAdmissionConfirmed && observed.sessionId === null
            ? { ...observed, status: 'cancelled', reason: 'Pending execution intent was atomically claimed/cancelled before the native driver could claim it' }
            : observed
        }
        await this.serialize(async () => {
          const node = live.stage.request.node
          this.rememberPrior(prior, { nodeId: node.nodeId, run: { ...live.run.run }, state: result.status === 'passed' ? 'verified' : result.status === 'cancelled' ? 'cancelled' : result.status === 'failed' ? 'failed' : 'outcome-unknown',
            attempts: live.stage.request.step.attempt, sessionId: result.sessionId, turnId: result.turnId, historySeq: result.historySeq, historyCommitted: result.historyCommitted, outputRefs: result.outputs.map((output) => output.ref) })
          live.attempts ??= new Map(); live.attempts.set(node.stepId, live.stage.request.step.attempt)
          if (result.status === 'passed') live.outputs.set(node.nodeId, result.outputs)
        })
        if (live.pendingRevision && !live.pendingRevision.cancelled) {
          const changed = await this.applyRevision(live, live.pendingRevision, result)
          if (changed) { index = live.startIndex ?? 0; prior = [...(live.priorNodes ?? [])]; continue }
          if (live.run.state === 'outcome-unknown') break
        }
        if (result.status !== 'passed') {
          await this.settleRunBoundary(live, result)
          break
        }
        let next = index + 1
        let gateAborted = false
        while (next < live.compiled.plan.nodes.length && live.compiled.plan.nodes[next].step.kind === 'gate') {
          const gate = await this.serialize(async () => {
            if (live.stopRequested || (live.pendingRevision && !live.pendingRevision.cancelled)) return null
            return this.evaluateGate(live, live.compiled.plan.nodes[next], prior)
          })
          if (!gate) break
          next = gate.next
          if (gate.abort) { gateAborted = true; break }
        }
        if (live.pendingRevision && !live.pendingRevision.cancelled) {
          if (await this.applyRevision(live, live.pendingRevision, result)) { index = live.startIndex ?? 0; prior = [...(live.priorNodes ?? [])]; continue }
          if (live.run.state === 'outcome-unknown') break
        }
        if (gateAborted) { await this.serialize(() => this.updateState(live, 'failed', 'workflow.gate-aborted', { nodeId: live.compiled.plan.nodes[next - 1]?.nodeId ?? live.stage.request.node.nodeId })); break }
        if (next >= live.compiled.plan.nodes.length) {
          const finished = await this.serialize(async () => {
            if (live.pendingRevision && !live.pendingRevision.cancelled) return false
            await this.updateState(live, 'verified', 'workflow.run-verified', { meaning: 'Declared artifacts checked under explicit gate policies; Jira/task completion is separate' }); return true
          })
          if (finished) break
          continue
        }
        if (live.stopRequested) { await this.settleRunBoundary(live, result); break }
        if (await this.scheduleStage(live, live.compiled.plan.nodes[next], prior, next <= index ? 'declared-gate-retry' : 'preset-stage-boundary')) index = next
        else if (live.pendingRevision && !live.pendingRevision.cancelled) {
          if (await this.applyRevision(live, live.pendingRevision, result)) { index = live.startIndex ?? 0; prior = [...(live.priorNodes ?? [])] }
          else if (live.run.state === 'outcome-unknown') break
          else if (live.stopRequested) { await this.settleRunBoundary(live, result); break }
        } else {
          if (live.stopRequested) await this.settleRunBoundary(live, result)
          break
        }
      }
    } finally {
      if (terminal.has(live.run.state)) {
        try {
          await this.control.releaseWorkspace(live.scope, live.owner)
        } catch (error) {
          if (!(error instanceof WorkflowControlError) || error.code !== 'OUTCOME_UNKNOWN') throw error
        }
      }
    }
  }

  async previewRevision(raw: WorkflowRevisionPreviewInput): Promise<WorkflowRevisionPreview> {
    const input = workflowRevisionPreviewInputSchema.parse(raw)
    const task = await this.task(input.taskDir, true)
    const live = this.live.get(input.run.runId)
    if (!live || canonicalWorkflowJson(live.scope) !== canonicalWorkflowJson(task.scope) || canonicalWorkflowJson(live.run.run) !== canonicalWorkflowJson(input.run) || terminal.has(live.run.state) || live.run.state === 'outcome-unknown' || live.stopRequested) throw new WorkflowApplicationError('REVISION_CONFLICT', 'Revision preview needs the exact healthy active task controller')
    const base = await this.preview({ taskDir: input.taskDir, flowId: input.flowId, origin: live.origin, inputs: { ...live.inputs, ...input.inputs } })
    const prepared = this.previews.get(base.previewId)
    if (!prepared) throw new WorkflowApplicationError('STALE_PREVIEW', 'Revision preparation is no longer available')
    this.previews.delete(base.previewId)
    if (canonicalWorkflowJson(live.run.run) !== canonicalWorkflowJson(input.run)) throw new WorkflowApplicationError('REVISION_CONFLICT', 'The old run advanced during preview; inspect its current revision')
    const start = input.startStepId ?? prepared.live.compiled.plan.nodes.find((node) => node.step.kind === 'agent')?.stepId
    const startIndex = prepared.live.compiled.plan.nodes.findIndex((node) => node.stepId === start && node.step.kind === 'agent')
    if (startIndex < 0) throw new WorkflowApplicationError('INVALID_INPUT', 'Successor start must select an actual configured agent stage')
    for (const node of prepared.live.compiled.plan.nodes.slice(startIndex)) {
      if (node.step.kind !== 'gate') continue
      const gate = node.step
      if (prepared.live.compiled.plan.nodes.findIndex((target) => target.stepId === gate.check.stepId) < startIndex || (gate.onFail === 'goto' && prepared.live.compiled.plan.nodes.findIndex((target) => target.stepId === gate.gotoStepId) < startIndex)) throw new WorkflowApplicationError('CAPABILITY_UNAVAILABLE', 'Chosen start excludes a declared gate input or retry target')
    }
    prepared.live.startIndex = startIndex
    prepared.live.gateFeedback = new Map([[start as string, [`Adopted workflow revision reason: ${input.reason}`]]])
    prepared.live.stage = await this.prepareStage(prepared.live, prepared.live.compiled.plan.nodes[startIndex], prepared.live.run.run, [])
    const known = await this.snapshot({ taskDir: input.taskDir, run: input.run })
    const impact = revisionImpact(live.compiled, prepared.live.compiled, known.nodes, live.stage.request.node.nodeId, start as string, live.source.nodes, prepared.live.source.nodes)
    const semantic = { scope: task.scope, target: input.run, definition: prepared.live.compiled.definition, reason: input.reason, boundary: input.boundary, startStepId: start,
      impact, inputFingerprint: prepared.live.stage.manifest.inputFingerprint }
    const dto = workflowRevisionPreviewSchema.parse({ schemaVersion: 1, state: 'saved', previewId: randomUUID(), scope: task.scope, taskDir: input.taskDir, target: input.run,
      definition: prepared.live.compiled.definition, flowId: input.flowId, reason: input.reason, boundary: input.boundary, startStepId: start,
      before: live.compiled.graph, after: prepared.live.compiled.graph, impact, fingerprint: hash(canonicalWorkflowJson(semantic)), createdAt: Date.now(), expiresAt: Date.now() + (this.options.previewTtlMs ?? 5 * 60_000),
      limitations: ['No automatic execution result reuse: native extra inputs remain unobserved.', 'Only verified boundary output can join successor inputs; its final version is captured at the chosen boundary.', 'Only the currently supported sequential agent/artifact-gate topology executes; no parallel branch drain is fabricated.'] })
    const stored = await this.materials.captureText({ owner: task.scope, source: { kind: 'external', instanceId: 'platform-workflow-revision', objectId: dto.previewId }, kind: 'other', version: dto.fingerprint, text: canonicalWorkflowJson(dto) })
    dto.metadataRef = stored.ref
    for (const [id, candidate] of this.revisionPreviews) if (candidate.dto.expiresAt < Date.now()) this.revisionPreviews.delete(id)
    if (this.revisionPreviews.size >= 32) throw new WorkflowApplicationError('CAPACITY_EXCEEDED', 'Too many unexpired revision previews')
    this.revisionPreviews.set(dto.previewId, { dto, live: prepared.live })
    return structuredClone(dto)
  }
  async acceptRevision(raw: WorkflowRevisionAcceptInput): Promise<WorkflowRevisionStatus> {
    const input = workflowRevisionAcceptInputSchema.parse(raw)
    await this.serialize(async () => {
      const task = await this.task(input.taskDir, true)
      const existing = await this.control.getCommand(task.scope, input.commandId)
      if (existing) {
        const value = this.revisionPayload(existing.command.payload)
        if (!value || value.preview.previewId !== input.previewId || canonicalWorkflowJson(value.preview.target) !== canonicalWorkflowJson(input.run)) throw new WorkflowApplicationError('COMMAND_PAYLOAD_CONFLICT', 'Revision command has different accepted meaning')
        return
      }
      const candidate = this.revisionPreviews.get(input.previewId)
      const live = this.live.get(input.run.runId)
      if (!candidate || candidate.dto.expiresAt < Date.now()) throw new WorkflowApplicationError('STALE_PREVIEW', 'Revision preview expired; preview the current source again')
      if (!live || terminal.has(live.run.state) || live.stopRequested || live.run.state === 'outcome-unknown' || canonicalWorkflowJson(live.run.run) !== canonicalWorkflowJson(input.run) || canonicalWorkflowJson(live.scope) !== canonicalWorkflowJson(task.scope) || canonicalWorkflowJson(candidate.dto.scope) !== canonicalWorkflowJson(task.scope) || canonicalWorkflowJson(candidate.dto.target) !== canonicalWorkflowJson(input.run)) throw new WorkflowApplicationError('REVISION_CONFLICT', 'Revision target is no longer the exact active head')
      if (live.pendingRevision && !live.pendingRevision.cancelled) throw new WorkflowApplicationError('REVISION_CONFLICT', 'Another structural adoption is already waiting for this revision')
      await candidate.live.source.assertCurrent()
      // Immutable preview bodies remain authoritative; old native output changes
      // are expected while coding and can only join by the displayed boundary policy.
      for (const entry of candidate.live.stage.context.entries) await this.materials.readVersion(candidate.live.baseSelections.find((selection) => selection.ref === entry.ref)?.owner ?? task.scope, entry.ref)
      const command = this.command(task.scope, input.run, input.commandId, 'adopt-revision', { action: 'structural-revision', taskDir: input.taskDir, preview: plain(candidate.dto), boundaryOutputPolicy: 'verified-input-only' })
      this.requireCommitted(await this.control.reserveCommand(command, live.owner))
      const pending: PendingApplicationRevision = { candidate, command, state: 'waiting-boundary', cancelled: false, stopIntentStarted: false, evidenceRefs: ['durable-adoption-reservation'], reason: null }
      live.pendingRevision = pending
      await this.append(live, 'workflow.revision-waiting', { commandId: input.commandId, previewId: input.previewId, boundary: candidate.dto.boundary, fingerprint: candidate.dto.fingerprint }).catch(() => { pending.reason = 'Reservation is durable; progress-event acknowledgement requires reconciliation' })
      if (candidate.dto.boundary === 'now') void this.beginRevisionStop(live, pending, true).catch(() => { pending.state = 'stop-unconfirmed'; pending.reason = 'Stop acknowledgement unavailable; no successor may dispatch' })
    })
    return this.revisionStatus({ taskDir: input.taskDir, commandId: input.commandId })
  }
  private revisionPayload(payload: WorkflowJson): { action: 'structural-revision'; taskDir: string; preview: WorkflowRevisionPreview } | null {
    const parsed = z.object({ action: z.literal('structural-revision'), taskDir: z.string(), preview: workflowRevisionPreviewSchema }).passthrough().safeParse(payload)
    return parsed.success ? parsed.data : null
  }
  private async revisionCommandScope(taskDir: string, commandId: string): Promise<WorkflowScope> {
    this.assertOpen()
    // A retained controller is an execution fact. Re-resolving its mutable path
    // can confuse cleanup with a replacement task or trap an existing writer.
    const matches: WorkflowScope[] = []
    for (const live of this.live.values()) {
      if (live.taskDir !== taskDir) continue
      const record = await this.control.getCommand(live.scope, commandId)
      const payload = record ? this.revisionPayload(record.command.payload) : null
      if (record?.command.kind === 'adopt-revision' && payload?.taskDir === taskDir && payload.preview.target.runId === live.run.run.runId && canonicalWorkflowJson(payload.preview.scope) === canonicalWorkflowJson(live.scope)) matches.push(live.scope)
    }
    const scopes = [...new Map(matches.map((scope) => [canonicalWorkflowJson(scope), scope])).values()]
    if (scopes.length > 1) throw new WorkflowApplicationError('REVISION_CONFLICT', 'More than one retained task owns this command; exact recovery identity is required')
    return scopes[0] ?? (await this.task(taskDir)).scope
  }
  async revisionStatus(raw: WorkflowRevisionStatusInput): Promise<WorkflowRevisionStatus> {
    const input = workflowRevisionStatusInputSchema.parse(raw)
    const task = { scope: await this.revisionCommandScope(input.taskDir, input.commandId) }
    const record = await this.control.getCommand(task.scope, input.commandId)
    const payload = record ? this.revisionPayload(record.command.payload) : null
    if (!record || record.command.kind !== 'adopt-revision' || !payload || canonicalWorkflowJson(payload.preview.scope) !== canonicalWorkflowJson(task.scope)) throw new WorkflowApplicationError('NOT_FOUND', 'No accepted structural revision belongs to this task and command')
    const preview = payload.preview
    const live = this.live.get(preview.target.runId)
    const pending = live?.pendingRevision?.command.commandId === input.commandId ? live.pendingRevision : null
    const result: WorkflowRevisionStatus = { commandId: input.commandId, previewId: preview.previewId, target: preview.target, successor: null, state: 'recovery-required', preview, evidenceRefs: [], recoveryRequired: false, reason: null }
    if (record.status === 'cancelled') {
      const failure = (await this.eventsForCurrent(task.scope, preview.target)).reverse().find(({ event }) => event.type === 'workflow.revision-failed' && event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload) && event.payload.commandId === input.commandId)
      const data = failure?.event.payload
      const [stop, predecessor] = await Promise.all([
        this.control.getOperation(task.scope, `stop:revision-stop:${input.commandId}`),
        this.control.load(task.scope, preview.target)
      ])
      const stoppingStarted = !!pending?.stopIntentStarted || !!stop
      const recoveryRequired = stoppingStarted && !terminal.has(predecessor?.run.state ?? '')
      return { ...result, state: failure ? 'failed' : 'cancelled', recoveryRequired, reason: data && typeof data === 'object' && !Array.isArray(data) && typeof data.reason === 'string' ? data.reason : stoppingStarted ? 'Cancellation suppresses successor; it does not resume stopped predecessor writes' : null }
    }
    if (record.status === 'reserved') return { ...result, state: pending?.state ?? 'recovery-required', evidenceRefs: pending?.evidenceRefs ?? ['durable-reservation-without-live-controller'], recoveryRequired: !pending || pending.state === 'stop-unconfirmed' || pending.state === 'recovery-required', reason: pending?.reason ?? (!pending ? 'Recover and reconcile the retained owner before adopting; no native replay was performed' : null) }
    const successor = { runId: preview.target.runId, revision: preview.target.revision + 1 }
    const saved = await this.control.load(task.scope, successor)
    if (!saved) return { ...result, reason: 'Adoption acknowledgement exists but successor identity requires reconciliation', recoveryRequired: true }
    result.successor = successor
    const events = await this.eventsForCurrent(task.scope, successor)
    const written = events.some(({ event }) => event.type === 'workflow.context-emitted-to-host')
    const head = await this.control.head(task.scope)
    const current = head && head.run.run.runId === successor.runId && canonicalWorkflowJson(head.run.definition) === canonicalWorkflowJson(saved.run.definition) ? head.run : saved.run
    result.state = current.state === 'outcome-unknown' ? 'recovery-required' : current.state === 'failed' || current.state === 'cancelled' || current.state === 'stopped' ? 'failed' : current.state === 'verified' ? 'adopted' : written ? 'running' : 'successor-starting'
    result.recoveryRequired = current.state === 'outcome-unknown' || (!terminal.has(current.state) && (!live || canonicalWorkflowJson(live.run.run) !== canonicalWorkflowJson(current.run)))
    if (result.recoveryRequired) result.state = 'recovery-required'
    result.evidenceRefs = [written ? 'actual-native-prompt-write-receipt' : 'durable-successor-startup-intent']
    return result
  }
  async cancelRevision(raw: WorkflowRevisionStatusInput): Promise<WorkflowRevisionStatus> {
    const input = workflowRevisionStatusInputSchema.parse(raw)
    await this.serialize(async () => {
      // Cancelling control intent is not a write to the archived Trellis task.
      const task = { scope: await this.revisionCommandScope(input.taskDir, input.commandId) }
      const record = await this.control.getCommand(task.scope, input.commandId)
      const payload = record ? this.revisionPayload(record.command.payload) : null
      if (!record || record.command.kind !== 'adopt-revision' || !payload) throw new WorkflowApplicationError('NOT_FOUND', 'Revision command is unavailable')
      if (record.status === 'cancelled') return
      if (record.status === 'committed') throw new WorkflowApplicationError('REVISION_CONFLICT', 'An adopted successor cannot be erased by cancelling its old request')
      const live = this.live.get(payload.preview.target.runId)
      const pending = live?.pendingRevision
      if (!live || pending?.command.commandId !== input.commandId) throw new WorkflowApplicationError('OUTCOME_UNKNOWN', 'No live owner can cancel this reservation; reconcile retained ownership first')
      this.requireCommitted(await this.control.cancelReservedCommand(task.scope, input.commandId, live.owner, ['explicit-user-cancel-revision']))
      pending.cancelled = true; pending.state = 'cancelled'
      if (pending.stopIntentStarted) live.stopRequested = true
      else live.pendingRevision = undefined
      await this.append(live, 'workflow.revision-cancelled', { commandId: input.commandId, stoppedAlready: pending.stopIntentStarted, automaticResume: false })
    })
    return this.revisionStatus(input)
  }
  private beginRevisionStop(live: ApplicationLiveRun, pending: PendingApplicationRevision, interrupt: boolean, result?: StageResult): Promise<DriverStopResult> {
    if (pending.stopPromise) return pending.stopPromise
    pending.stopPromise = (async () => {
      const beforeDispatch = await this.serialize(async () => {
        if (pending.cancelled) return null
        pending.stopIntentStarted = true; pending.state = 'stopping'
        let before = !live.dispatchStarted
        const execution = await this.control.getOperation(live.scope, live.stage.request.operationId)
        if (execution?.operation.state === 'pending') {
          try {
            await this.control.claimOperation({ scope: live.scope, owner: live.owner, operationId: live.stage.request.operationId })
            await this.control.settleOperation({ scope: live.scope, owner: live.owner, operationId: live.stage.request.operationId, state: 'failed', result: { status: 'cancelled-before-native-dispatch' }, evidenceRefs: ['pending-intent-cancelled-before-native-driver-claim'] })
            before = true; pending.noNativeAdmissionConfirmed = true
          } catch (error) {
            if (!(error && typeof error === 'object' && 'code' in error && error.code === 'OPERATION_NOT_PENDING')) throw error
            // The driver won the same atomic claim. Its possible side effects
            // require canonical stop; a prior pending read is not no-dispatch proof.
            before = false
          }
        }
        if (before) {
          await this.control.recordStep({ scope: live.scope, step: live.stage.request.step, owner: live.owner, state: 'cancelled', inputFingerprint: live.stage.manifest.inputFingerprint,
            materialRefs: live.stage.manifest.context.materials.map((entry) => entry.material), outputRefs: [], sessionId: null, turnId: null, historySeq: null, historyCommitted: false, updatedAt: Date.now() })
        }
        const commandId = `revision-stop:${pending.command.commandId}`
        pending.stopOperationId = `stop:${commandId}`
        const command = this.command(live.scope, live.run.run, commandId, 'request-stop', { action: 'revision-drain', adoptionCommandId: pending.command.commandId })
        const stopping = { ...live.run, state: 'stopping' as const }
        this.requireCommitted(await this.control.commit({ command, owner: live.owner, expectedCurrent: live.run.run, runChanges: [stopping], events: [this.event(live, 'workflow.revision-stopping', { commandId: pending.command.commandId, operationId: pending.stopOperationId })], outbox: [this.operation(live, commandId, pending.stopOperationId, 'stop-run')] }))
        live.run = stopping
        if (interrupt) live.stopRequested = true
        await this.control.claimOperation({ scope: live.scope, owner: live.owner, operationId: pending.stopOperationId })
        return before
      })
      if (beforeDispatch === null) return { operationId: live.stage.request.operationId, status: 'rejected' as const, evidenceRefs: ['revision-cancelled-before-stop'] }
      const stop: DriverStopResult = beforeDispatch ? { operationId: live.stage.request.operationId, status: 'stopped', evidenceRefs: [pending.noNativeAdmissionConfirmed ? 'pending-intent-cancelled-before-native-driver-claim' : 'main-controller-never-called-driver'] }
        : interrupt ? await this.driver.requestStop({ operationId: live.stage.request.operationId, scope: live.scope, run: live.run.run, owner: live.owner })
          : await this.closeRevisionSession(live, result)
      await this.recordRevisionStop(live, pending, stop)
      return stop
    })()
    return pending.stopPromise
  }
  private async closeRevisionSession(live: ApplicationLiveRun, result?: StageResult): Promise<DriverStopResult> {
    const { operationId } = live.stage.request
    const unconfirmed: DriverStopResult = { operationId, status: 'unconfirmed', evidenceRefs: ['native-session-identity-unavailable'] }
    if (result?.operationId !== operationId || !result.sessionId || !result.turnId || !result.historyCommitted || result.historySeq === null) return unconfirmed
    const { sessionId, turnId, historySeq } = result
    const page = await this.options.acp.historyEvents(this.projectRoot, sessionId, { limit: 500 }).catch(() => null)
    if (!page?.ok || page.historyPersistence.state !== 'saved') return unconfirmed
    const original = page.events.find(event => event.kind === 'turn-done' && event.sessionId === sessionId && event.turnId === turnId
      && event.historySeq === historySeq && sameRoot(event.projectRoot, this.projectRoot))
    if (!original?.connectionGeneration) return unconfirmed
    const ended = await this.options.acp.stop(this.projectRoot, sessionId, original.connectionGeneration).catch(() => ({ stopped: false }))
    return { operationId, status: ended.stopped ? 'stopped' : 'unconfirmed', evidenceRefs: [ended.stopped ? 'facade-canonical-shutdown' : 'facade-shutdown-unconfirmed'] }
  }
  private async recordRevisionStop(live: ApplicationLiveRun, pending: PendingApplicationRevision, stop: DriverStopResult): Promise<void> {
    const operationId = pending.stopOperationId
    if (!operationId) throw new WorkflowApplicationError('OUTCOME_UNKNOWN', 'Revision stop intent was not acknowledged')
    const old = await this.control.getOperation(live.scope, operationId)
    const confirmed = stop.status === 'stopped'
    if (old?.operation.state === 'outcome-unknown') await this.control.reconcileOperation({ scope: live.scope, owner: live.owner, operationId, status: confirmed ? 'confirmed' : 'unresolved', result: plain(stop), evidenceRefs: stop.evidenceRefs })
    else if (old?.operation.state !== 'confirmed') await this.control.settleOperation({ scope: live.scope, owner: live.owner, operationId, state: confirmed ? 'confirmed' : 'outcome-unknown', result: plain(stop), evidenceRefs: stop.evidenceRefs })
    pending.state = confirmed ? 'stopped' : 'stop-unconfirmed'; pending.evidenceRefs = stop.evidenceRefs
    await this.append(live, confirmed ? 'workflow.revision-stopped' : 'workflow.revision-stop-unconfirmed', { commandId: pending.command.commandId, evidenceRefs: stop.evidenceRefs })
  }
  private async applyRevision(live: ApplicationLiveRun, pending: PendingApplicationRevision, result: StageResult): Promise<boolean> {
    if (pending.cancelled) return false
    try {
      if (result.status === 'outcome-unknown' || result.status === 'failed') {
        pending.state = 'recovery-required'; pending.reason = 'Original native outcome is unresolved or failed; inspect actual changes before a new side effect'
        await this.serialize(() => this.updateState(live, 'outcome-unknown', 'workflow.revision-recovery-required', { commandId: pending.command.commandId, originalStatus: result.status }))
        return false
      }
      const candidate = pending.candidate.live
      candidate.source.assertExecutionCurrent()
      candidate.owner = live.owner; candidate.origin = live.origin; candidate.run.run = { runId: live.run.run.runId, revision: live.run.run.revision + 1 }
      candidate.outputs = new Map(live.outputs)
      candidate.gateRetries = new Map(); candidate.attempts = new Map()
      const node = candidate.compiled.plan.nodes[candidate.startIndex ?? 0]
      const prior: OriginMeta['priorNodes'] = candidate.compiled.plan.nodes.slice(0, candidate.startIndex ?? 0).map((skipped) => ({ nodeId: skipped.nodeId, run: { ...candidate.run.run }, state: 'not-selected', attempts: 0, sessionId: null, turnId: null, historySeq: null, historyCommitted: false, outputRefs: [] }))
      const stage = await this.prepareStage(candidate, node, candidate.run.run, prior)
      // No native stop occurs until the concrete final effective input fits and validates.
      let stop = await this.beginRevisionStop(live, pending, false, result)
      if (stop.status === 'rejected' && stop.evidenceRefs.includes('already-settling') && result.status === 'passed') {
        stop = await this.closeRevisionSession(live, result)
        await this.recordRevisionStop(live, pending, stop)
      }
      if (pending.cancelled) return false
      if (stop.status !== 'stopped') {
        await this.serialize(() => this.updateState(live, 'outcome-unknown', 'workflow.revision-recovery-required', { commandId: pending.command.commandId, reason: 'Native stop remains unconfirmed; successor was not admitted' }))
        return false
      }
      await this.serialize(async () => {
        if (pending.cancelled) return
        candidate.source.assertExecutionCurrent()
        await this.control.renewWorkspace(live.scope, live.owner)
        const old: WorkflowRun = { ...live.run, state: 'stopped' }
        const successor: WorkflowRun = { ...candidate.run, scope: live.scope, run: candidate.run.run, definition: candidate.compiled.definition, state: 'queued', predecessor: live.run.run, createdAt: Date.now() }
        stage.request.operationId = `execute:${pending.command.commandId}:successor`
        stage.request.owner = live.owner
        const operation = { ...this.operation(live, pending.command.commandId, stage.request.operationId), run: successor.run }
        this.requireCommitted(await this.control.commitWithManifests({ journal: { command: pending.command, owner: live.owner, expectedCurrent: pending.candidate.dto.target,
          runChanges: [old, successor], events: [this.event(live, 'workflow.revision-successor-admitted', { commandId: pending.command.commandId, previewId: pending.candidate.dto.previewId, successor: successor.run, definition: successor.definition, fingerprint: stage.manifest.inputFingerprint })], outbox: [operation] }, manifests: [stage.manifest] }))
        Object.assign(live, { source: candidate.source, compiled: stage.compiled, inputs: candidate.inputs, baseSelections: candidate.baseSelections, outputs: candidate.outputs,
          run: successor, stage, stopRequested: false, dispatchStarted: false, stopOperationIds: [], pendingRevision: undefined, priorNodes: prior,
          startIndex: candidate.startIndex ?? 0, gateRetries: new Map(), gateFeedback: candidate.gateFeedback, attempts: new Map() })
        pending.state = 'successor-starting'
      })
      return !pending.cancelled && live.run.run.revision > pending.candidate.dto.target.revision
    } catch (error) {
      pending.reason = error instanceof Error ? error.message : 'Revision adoption failed'
      if (pending.stopIntentStarted) {
        const command = await this.control.getCommand(live.scope, pending.command.commandId).catch(() => null)
        const operation = pending.stopOperationId ? await this.control.getOperation(live.scope, pending.stopOperationId).catch(() => null) : null
        if (command?.status === 'reserved' && operation?.operation.state === 'confirmed') {
          pending.state = 'failed'; pending.cancelled = true; live.stopRequested = true
          await this.control.cancelReservedCommand(live.scope, pending.command.commandId, live.owner, ['successor-validation-failed-after-confirmed-native-stop'])
          await this.serialize(() => this.updateState(live, 'stopped', 'workflow.revision-failed', { commandId: pending.command.commandId, reason: pending.reason, nativeStopConfirmed: true, automaticResume: false }))
        } else {
          pending.state = command?.status === 'committed' ? 'recovery-required' : 'stop-unconfirmed'
          await this.serialize(() => this.updateState(live, 'outcome-unknown', 'workflow.revision-recovery-required', { commandId: pending.command.commandId, reason: pending.reason })).catch(() => { live.run.state = 'outcome-unknown' })
        }
      } else {
        pending.state = 'failed'; pending.cancelled = true
        await this.control.cancelReservedCommand(live.scope, pending.command.commandId, live.owner, ['revision-final-input-validation-failed-before-stop'])
        live.pendingRevision = undefined
        await this.append(live, 'workflow.revision-failed', { commandId: pending.command.commandId, reason: pending.reason, predecessorContinues: true })
      }
      return false
    }
  }

  async snapshot(raw: WorkflowSnapshotInput): Promise<WorkflowApplicationSnapshot> {
    const input = workflowSnapshotInputSchema.parse(raw)
    const task = await this.task(input.taskDir)
    const snapshot = input.run ? await this.control.load(task.scope, input.run) : await this.control.head(task.scope)
    return this.projectSnapshot(task.scope, snapshot, task.taskDir)
  }
  private async projectSnapshot(scope: WorkflowScope, snapshot: JournalSnapshot | null, taskDir?: string): Promise<WorkflowApplicationSnapshot> {
    const result: WorkflowApplicationSnapshot = { scope, snapshot, origin: null, graph: null, nodes: [], stageSessions: [], cursor: snapshot?.cursor ?? null,
      recoveryRequired: false, composer: { target: 'ordinary', feedback: 'unavailable', reason: null } }
    if (!snapshot) return result
    if (canonicalWorkflowJson(snapshot.run.scope) !== canonicalWorkflowJson(scope) || (snapshot.manifest && canonicalWorkflowJson(snapshot.manifest.scope) !== canonicalWorkflowJson(scope))) throw new WorkflowApplicationError('SCOPE_CHANGED', 'Stored recovery run belongs to a different scope')
    const meta = originMetaSchema.safeParse(snapshot.manifest?.context.inputs[META])
    if (!meta.success) { result.recoveryRequired = true; return result }
    result.origin = meta.data.origin; result.graph = meta.data.graph
    const records = await this.control.steps(scope, snapshot.run.run)
    const page = await this.eventsForCurrent(scope, snapshot.run.run)
    const actual = new Map(meta.data.priorNodes.map((node) => [node.nodeId, node]))
    for (const record of records) {
      const outputs = this.outputRefsFromEvents(page, record.step.nodeId)
      actual.set(record.step.nodeId, { nodeId: record.step.nodeId, run: { ...snapshot.run.run }, state: record.state, attempts: record.step.attempt, sessionId: record.sessionId, turnId: record.turnId,
        historySeq: record.historySeq, historyCommitted: record.historyCommitted, outputRefs: outputs })
    }
    for (const item of page) {
      const attribution = item.event.attribution
      if (attribution.kind !== 'assigned' || !attribution.step || !attribution.sessionId) continue
      const nodeId = attribution.step.nodeId
      if (records.some((record) => record.step.nodeId === nodeId)) continue
      actual.set(nodeId, { nodeId, run: { ...snapshot.run.run }, state: snapshot.run.state, attempts: attribution.step.attempt, sessionId: attribution.sessionId,
        turnId: attribution.turnId, historySeq: attribution.historySeq, historyCommitted: false, outputRefs: [] })
    }
    result.nodes = meta.data.graph.nodes.map((node) => actual.get(node.nodeId) ?? { nodeId: node.nodeId, run: node.nodeId === meta.data.activeNodeId ? { ...snapshot.run.run } : null, state: node.nodeId === meta.data.activeNodeId ? snapshot.run.state : 'planned', attempts: 0, sessionId: null, turnId: null, historySeq: null, historyCommitted: false, outputRefs: [] })
    const sessionIds = new Set(result.nodes.map((node) => node.sessionId).filter((id): id is string => !!id))
    // Include currently admitted session even before the final step record exists.
    for (const item of page) if (item.event.attribution.kind === 'assigned' && item.event.attribution.sessionId) sessionIds.add(item.event.attribution.sessionId)
    for (const sessionId of taskDir ? sessionIds : []) {
      const value = await this.options.acp.get(this.projectRoot, sessionId)
      const root = value.ok ? await fs.realpath(value.session.projectRoot).catch(() => null) : null
      if (value.ok && root && sameRoot(root, this.projectRoot) && value.session.taskDir === taskDir) result.stageSessions.push({ sessionId, connectionGeneration: value.session.connectionGeneration, status: value.session.status, pendingPermissions: value.session.pendingPermissions })
    }
    const live = this.live.get(snapshot.run.run.runId)
    result.recoveryRequired = snapshot.run.state === 'outcome-unknown' || live?.run.state === 'outcome-unknown' || (!terminal.has(snapshot.run.state) && (!live || canonicalWorkflowJson(live.run.run) !== canonicalWorkflowJson(snapshot.run.run)))
    result.composer = { target: terminal.has(snapshot.run.state) ? 'ordinary' : 'managed', feedback: 'unavailable',
      reason: terminal.has(snapshot.run.state) ? null : 'Managed stage owns task execution. Boundary feedback is not connected; stop or wait before sending an ordinary mutable turn.' }
    return result
  }
  async inspectWorkspaceRecovery(raw: WorkflowWorkspaceRecoveryInput = {}): Promise<WorkflowWorkspaceRecovery> {
    this.assertOpen()
    const input = workflowWorkspaceRecoveryInputSchema.parse(raw)
    const lease = await this.control.workspaceOwner({ projectId: this.identity.projectId, repositoryId: this.identity.repositoryId, workspaceId: this.identity.workspaceId })
    this.assertOpen()
    if (!lease) {
      if (input.run) throw new WorkflowApplicationError('NOT_FOUND', 'No retained workspace owner can resolve this exact run')
      return { scope: null, ownership: null, projection: null, source: { state: 'unknown', alias: null, candidates: [], reason: 'No retained workspace owner' } }
    }
    const scope = lease.scope
    if (scope.projectId !== this.identity.projectId || scope.repositoryId !== this.identity.repositoryId || scope.workspaceId !== this.identity.workspaceId) throw new WorkflowApplicationError('SCOPE_CHANGED', 'Retained owner differs from the actual application workspace')
    const snapshot = input.run ? await this.control.load(scope, input.run) : await this.control.head(scope)
    if (input.run && (!snapshot || canonicalWorkflowJson(snapshot.run.run) !== canonicalWorkflowJson(input.run))) throw new WorkflowApplicationError('NOT_FOUND', 'The exact requested run is absent from the retained owner scope')
    const [projection, source] = await Promise.all([this.projectSnapshot(scope, snapshot), inspectRecoverySource(this.projectRoot, scope, this.control)])
    this.assertOpen()
    const run = snapshot?.run.run
    const live = run && this.live.get(run.runId)
    const stopTarget = live && canonicalWorkflowJson(live.scope) === canonicalWorkflowJson(scope) &&
      canonicalWorkflowJson(live.run.run) === canonicalWorkflowJson(run) && !terminal.has(live.run.state)
      ? { taskDir: live.taskDir, run: live.run.run } : undefined
    return { scope, ownership: { state: lease.state, leaseUntil: lease.leaseUntil, recoveryRequired: lease.recoveryRequired }, projection, source, stopTarget }
  }
  private async eventsForCurrent(scope: WorkflowScope, run: RunRef): Promise<WorkflowApplicationEventPage['items']> {
    let cursor: WorkflowApplicationEventPage['cursor'] | null = null
    const items: WorkflowApplicationEventPage['items'] = []
    for (let pageIndex = 0; pageIndex < 50; pageIndex++) {
      const page = await this.control.events({ scope, cursor, limit: 200 })
      for (const item of page.items) if (item.event.attribution.kind === 'assigned' && canonicalWorkflowJson(item.event.attribution.run) === canonicalWorkflowJson(run)) items.push(item)
      cursor = page.cursor
      if (!page.hasMore) return items
    }
    throw new WorkflowApplicationError('CAPACITY_EXCEEDED', 'Run projection exceeded its bounded scan; consume event pages instead of a complete snapshot')
  }
  private outputRefsFromEvents(events: WorkflowApplicationEventPage['items'], nodeId: string): string[] {
    const refs = new Set<string>()
    for (const item of events) {
      if (item.event.type !== 'workflow.driver-result' || item.event.attribution.kind !== 'assigned' || item.event.attribution.step?.nodeId !== nodeId) continue
      const data = z.object({ outputs: z.array(z.object({ ref: z.string().regex(/^wm-[0-9a-f]{64}$/) }).passthrough()) }).passthrough().safeParse(item.event.payload)
      if (data.success) data.data.outputs.forEach((output) => refs.add(output.ref))
    }
    return [...refs]
  }
  async events(raw: WorkflowEventsInput): Promise<WorkflowApplicationEventPage> {
    const input = workflowEventsInputSchema.parse(raw)
    const task = await this.task(input.taskDir)
    const page = await this.control.events({ scope: task.scope, cursor: input.cursor, limit: input.limit })
    return { ...page, items: input.run ? page.items.filter(({ event }) => event.attribution.kind === 'assigned' && canonicalWorkflowJson(event.attribution.run) === canonicalWorkflowJson(input.run)) : page.items }
  }
  async stop(raw: WorkflowStopInput): Promise<{ commandId: string; status: 'requested' | 'stopped' | 'unconfirmed' | 'duplicate'; run: RunRef }> {
    return this.serialize(async () => {
      const input = workflowStopInputSchema.parse(raw)
      this.assertOpen()
      const live = this.live.get(input.run.runId)
      // Exact retained main ownership authorizes cleanup even if the task was
      // deleted, archived, or its basename now names an unrelated replacement.
      if (!live || live.taskDir !== input.taskDir || canonicalWorkflowJson(live.run.run) !== canonicalWorkflowJson(input.run)) throw new WorkflowApplicationError('OUTCOME_UNKNOWN', 'No matching live controller can confirm this stop; retained run requires reconciliation')
      const task = { scope: live.scope }
      const payload = { target: input.run, taskDir: input.taskDir, action: 'request-stop' }
      const existing = await this.control.getCommand(task.scope, input.commandId)
      if (existing) {
        if (existing.command.kind !== 'request-stop' || existing.command.payloadDigest !== hash(canonicalWorkflowJson(payload))) throw new WorkflowApplicationError('COMMAND_PAYLOAD_CONFLICT', 'Stop command identity already has different meaning')
        const operation = await this.control.getOperation(task.scope, `stop:${input.commandId}`)
        return { commandId: input.commandId, status: operation?.operation.state === 'confirmed' ? 'stopped' : operation?.operation.state === 'pending' ? 'requested' : 'unconfirmed', run: input.run }
      }
      if (terminal.has(live.run.state)) throw new WorkflowApplicationError('REVISION_CONFLICT', 'The managed run is already terminal')
      const revision = live.pendingRevision
      if (revision && !revision.cancelled) {
        this.requireCommitted(await this.control.cancelReservedCommand(task.scope, revision.command.commandId, live.owner, ['ordinary-task-stop-suppresses-structural-successor']))
        revision.cancelled = true; revision.state = 'cancelled'
        if (!revision.stopIntentStarted) live.pendingRevision = undefined
      }
      // A stop may arrive between admission and the first driver call. Consume
      // the pending intent under the still-active head, then record deliberate
      // no-dispatch cancellation. Do not strand an executable pending action.
      const beforeDispatch = !live.dispatchStarted
      if (beforeDispatch) {
        const operation = await this.control.getOperation(task.scope, live.stage.request.operationId)
        if (operation?.operation.state === 'pending') {
          await this.control.claimOperation({ scope: task.scope, owner: live.owner, operationId: live.stage.request.operationId })
          await this.control.settleOperation({ scope: task.scope, owner: live.owner, operationId: live.stage.request.operationId, state: 'failed',
            result: { status: 'cancelled-before-native-dispatch' }, evidenceRefs: ['main-controller-never-called-driver'] })
        }
      }
      const command = this.command(task.scope, input.run, input.commandId, 'request-stop', payload)
      const stopOperationId = `stop:${input.commandId}`
      const nextRun: WorkflowRun = { ...live.run, state: 'stopping' }
      this.requireCommitted(await this.control.commit({ command, owner: live.owner, expectedCurrent: input.run, runChanges: [nextRun],
        events: [this.event(live, 'workflow.stop-requested', { operationId: live.stage.request.operationId })], outbox: [this.operation(live, input.commandId, stopOperationId, 'stop-run')] }))
      live.stopRequested = true; live.run = nextRun; live.stopOperationIds.push(stopOperationId)
      await this.control.claimOperation({ scope: task.scope, owner: live.owner, operationId: stopOperationId })
      const result = beforeDispatch ? { status: 'stopped' as const, evidenceRefs: ['main-controller-never-called-driver'] }
        : await this.driver.requestStop({ operationId: live.stage.request.operationId, scope: task.scope, run: input.run, owner: live.owner })
      await this.control.settleOperation({ scope: task.scope, owner: live.owner, operationId: stopOperationId, state: result.status === 'stopped' ? 'confirmed' : 'outcome-unknown',
        result: plain(result), evidenceRefs: result.evidenceRefs.length ? result.evidenceRefs : ['stop-outcome-not-confirmed'] })
      if (beforeDispatch) {
        await this.control.recordStep({ scope: task.scope, step: live.stage.request.step, owner: live.owner, state: 'cancelled', inputFingerprint: live.stage.manifest.inputFingerprint,
          materialRefs: live.stage.manifest.context.materials.map((entry) => entry.material), outputRefs: [], sessionId: null, turnId: null, historySeq: null, historyCommitted: false, updatedAt: Date.now() })
        await this.updateState(live, 'stopped', 'workflow.stopped-before-dispatch', { operationId: live.stage.request.operationId })
        await this.control.releaseWorkspace(live.scope, live.owner)
      }
      return { commandId: input.commandId, status: result.status === 'stopped' ? 'stopped' : result.status === 'requested' ? 'requested' : 'unconfirmed', run: input.run }
    })
  }
  async readArtifact(raw: WorkflowArtifactInput): Promise<StoredWorkflowMaterial> {
    const input = workflowArtifactInputSchema.parse(raw)
    const task = await this.task(input.taskDir)
    const snapshot = await this.snapshot({ taskDir: input.taskDir, ...(input.run ? { run: input.run } : {}) })
    return this.readSnapshotArtifact(task.scope, snapshot, input.ref)
  }
  async readRecoveryArtifact(raw: WorkflowRecoveryArtifactInput): Promise<StoredWorkflowMaterial> {
    const input = workflowRecoveryArtifactInputSchema.parse(raw)
    const recovery = await this.inspectWorkspaceRecovery({ run: input.run })
    if (!recovery.scope || !recovery.projection) throw new WorkflowApplicationError('NOT_FOUND', 'No retained run exists for this artifact')
    const material = await this.readSnapshotArtifact(recovery.scope, recovery.projection, input.ref)
    this.assertOpen()
    return material
  }
  private async readSnapshotArtifact(scope: WorkflowScope, snapshot: WorkflowApplicationSnapshot, ref: string): Promise<StoredWorkflowMaterial> {
    if (!snapshot.snapshot) throw new WorkflowApplicationError('NOT_FOUND', 'No matching run exists for this artifact')
    const candidateOwners: MaterialOwner[] = [scope, { ...scope, taskRef: null }]
    const metadataRefs = new Set(snapshot.nodes.flatMap((node) => node.outputRefs))
    const contextMaterials = snapshot.snapshot.manifest?.context.materials ?? []
    for (const owner of candidateOwners) {
      let material: StoredWorkflowMaterial
      try { material = await this.materials.readVersion(owner, ref) }
      catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
        if (code === 'SCOPE_CHANGED' || (code === 'MATERIAL_UNAVAILABLE' && !metadataRefs.has(ref))) continue
        throw error
      }
      if (metadataRefs.has(ref) || contextMaterials.some((entry) => canonicalWorkflowJson(entry.material) === canonicalWorkflowJson(material.material))) return material
    }
    throw new WorkflowApplicationError('SCOPE_CHANGED', 'Artifact version is not an admitted input or observed output of this run')
  }
  async isOriginManaged(input: { taskDir: string; sessionId: string; connectionGeneration: string }): Promise<boolean> {
    const snapshot = await this.snapshot({ taskDir: input.taskDir })
    return snapshot.composer.target === 'managed' && snapshot.origin?.sessionId === input.sessionId && snapshot.origin.connectionGeneration === input.connectionGeneration
  }
  /** Injectable reader owner resolution; presentation cache IDs are never grants. */
  async resolveMaterialOwner(relativePath: string): Promise<MaterialOwner> {
    this.assertOpen()
    const normalized = relativePath.replace(/\\/g, '/')
    const authorized = resolveAuthorizedDocumentPath(this.projectRoot, normalized)
    if (!authorized.ok || normalized.startsWith('.trellis/.panel/runtime/')) throw new WorkflowApplicationError('SCOPE_CHANGED', 'Reader source is outside the authorized project surface')
    const match = normalized.match(/^\.trellis\/tasks\/(?:archive\/\d{4}-\d{2}\/)?([^/]+)\//)
    if (match) {
      const task = await this.task(match[1])
      if (!normalized.startsWith(task.relativeDir + '/')) throw new WorkflowApplicationError('SCOPE_CHANGED', 'Reader source and verified task directory differ')
      return task.scope
    }
    return { projectId: this.identity.projectId, repositoryId: this.identity.repositoryId, workspaceId: this.identity.workspaceId, taskRef: null }
  }
  activeRuns(): Array<{ taskDir: string; run: RunRef; state: WorkflowRun['state']; origin: WorkflowOrigin }> {
    return [...this.live.values()].filter((run) => !terminal.has(run.run.state)).map((run) => ({ taskDir: run.taskDir, run: { ...run.run.run }, state: run.run.state, origin: { ...run.origin } }))
  }
  /** Quit callers must inspect unconfirmed outcomes; this never kills foreign processes. */
  async requestShutdown(): Promise<Array<{ taskDir: string; run: RunRef; status: string }>> {
    const results: Array<{ taskDir: string; run: RunRef; status: string }> = []
    for (const run of this.activeRuns()) {
      try { const result = await this.stop({ taskDir: run.taskDir, run: run.run, commandId: `shutdown:${randomUUID()}` }); results.push({ ...run, status: result.status }) }
      catch { results.push({ ...run, status: 'unconfirmed' }) }
    }
    return results
  }
  async close(): Promise<void> {
    if ([...this.live.values()].some((run) => !terminal.has(run.run.state))) throw new WorkflowApplicationError('OUTCOME_UNKNOWN', 'Managed execution is active or uncertain; stop and reconcile before disposing its controller')
    // The terminal head commits before the execute promise releases its owner.
    // Drain that promise before closing the worker it still needs.
    await Promise.all([...this.live.values()].map((run) => run.promise))
    if ([...this.live.values()].some((run) => !terminal.has(run.run.state))) throw new WorkflowApplicationError('OUTCOME_UNKNOWN', 'Controller finalization or concurrent execution still requires reconciliation')
    this.closed = true
    this.previews.clear()
    this.revisionPreviews.clear()
    if (!this.options.control) await this.control.close()
  }
}
