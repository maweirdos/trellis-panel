import { randomUUID } from 'node:crypto'
import { readDatabaseDeliveryDescriptor } from '../../../src/shared/database-delivery'
import type { TaskDatabaseDeliveryValidator } from './database-delivery'
import { z } from 'zod'
import type { CruxTask, CruxTransitionTaskInput } from '../../../src/shared/crux'
import { cruxSnapshotSchema, cruxTransitionTaskInputSchema } from '../../../src/shared/crux-schema'
import type { GovernanceVersion } from '../../../src/shared/team-governance'
import type { TaskMaterialInputReference } from '../../../src/shared/task-material-inputs'
import { teamCommandIdSchema, teamIdSchema, type TeamCommandReply } from '../../../src/shared/team-platform'
import { teamTaskMaterialMetadataSchema, teamTaskMaterialScopeSchema, teamTaskMaterialSubmissionSchema, teamTaskMaterialVersionSchema, type TeamTaskMaterialMetadata, type TeamTaskMaterialVersion } from '../../../src/shared/team-task-materials'
import { teamTaskProgressResourceIdSchema } from '../../../src/shared/team-task-progress'
import {
  taskInputBundleSchema, taskInputCandidatesSchema, taskInputCommandSchema, taskInputReadSchema, taskInputReceiptSchema, taskInputDocumentViewSchema,
  type TaskInputBundle, type TaskInputCandidates, type TaskInputCommand, type TaskInputRead, type TaskInputReceipt
} from '../../../src/shared/team-task-inputs'
import { TeamGovernance, governanceCas, governanceFail, governanceHash, governanceNext, governanceStored, type GovernanceContext, type GovernanceHost } from './governance'
import type { StoreActor, StorePrincipal } from './store-types'

type Context = GovernanceContext & { task: CruxTask }
export type TaskContentRule = { version: GovernanceVersion; text: string }
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}'
  return JSON.stringify(value)
}
function conflicts(rule: GovernanceVersion, other: GovernanceVersion): boolean {
  const a = rule.settings, b = other.settings
  return a.kind === 'rule' && b.kind === 'rule' && a.obligation === 'required' && b.obligation === 'required' && !!a.conflictKey && a.conflictKey === b.conflictKey && a.priority === b.priority && rule.packageId !== other.packageId && rule.bodyDigest !== other.bodyDigest
}

export class TeamTaskInputs {
  constructor(private readonly host: GovernanceHost, private readonly governance: TeamGovernance, private readonly validateDatabaseDelivery?: TaskDatabaseDeliveryValidator) {}

  /** Initial execution dependency port uses the same fixed approval, ACL and byte validators. */
  validateExecutionDependency(principal: StorePrincipal, scope: { projectId: string; taskId: string; spaceId: string; taskCreatedAt: string }, ref: { documentId: string; versionId: string; bodyDigest: string }): void {
    const ctx = this.context(principal, scope, { spaceId: scope.spaceId, taskCreatedAt: scope.taskCreatedAt })
    const document = this.document(ctx, ref.documentId, ref.versionId)
    if (document.bodyDigest !== ref.bodyDigest || this.withdrawnDocument(ref.documentId, ref.versionId)) governanceFail('EXECUTION_DEPENDENCY_CONFLICT', 'Original confirmed document has changed or was withdrawn')
  }

  private context(principal: StorePrincipal, raw: Record<string, unknown>, scope: z.infer<typeof teamTaskMaterialScopeSchema>, writing = false): Context {
    const base = this.governance.context(principal, teamIdSchema.parse(raw.projectId), scope.spaceId, writing)
    const row = this.host.get("SELECT t.value AS body FROM crux_workspaces w,json_each(w.snapshotJson,'$.tasks') t WHERE w.projectId=? AND json_extract(t.value,'$.id')=?", base.projectId, teamTaskProgressResourceIdSchema.parse(raw.taskId))
    if (!row) governanceFail('TASK_INPUT_UNAVAILABLE', 'Original task is unavailable', 404)
    const task = governanceStored(cruxSnapshotSchema.shape.tasks.element, row.body)
    if (task.spaceId !== scope.spaceId || task.createdAt !== scope.taskCreatedAt) governanceFail('TASK_INPUT_SCOPE_CONFLICT', 'Task identity changed; do not retarget the original input')
    return { ...base, task }
  }

  private query(raw: Record<string, unknown>): z.infer<typeof teamTaskMaterialScopeSchema> { return teamTaskMaterialScopeSchema.parse(raw.query ?? {}) }
  private scope(ctx: Context): { projectId: string; taskId: string; spaceId: string; taskCreatedAt: string } {
    return { projectId: ctx.projectId, taskId: ctx.task.id, spaceId: ctx.space.id, taskCreatedAt: ctx.task.createdAt }
  }
  private head(ctx: Context): { revision: number; currentBundleId: string | null } {
    const row = this.host.get('SELECT revision,currentBundleId FROM task_input_heads WHERE projectId=? AND taskId=? AND spaceId=? AND taskCreatedAt=?', ctx.projectId, ctx.task.id, ctx.space.id, ctx.task.createdAt)
    return row ? governanceStored(z.object({ revision: z.number().int().nonnegative().safe(), currentBundleId: teamIdSchema.nullable() }).strict(), row) : { revision: 0, currentBundleId: null }
  }
  private setHead(ctx: Context, revision: number, bundleId: string | null): void {
    this.host.run('INSERT INTO task_input_heads(projectId,taskId,spaceId,taskCreatedAt,revision,currentBundleId) VALUES(?,?,?,?,?,?) ON CONFLICT(projectId,taskId,spaceId,taskCreatedAt) DO UPDATE SET revision=excluded.revision,currentBundleId=excluded.currentBundleId', ctx.projectId, ctx.task.id, ctx.space.id, ctx.task.createdAt, revision, bundleId)
  }

  private document(ctx: Context, documentId: string, versionId: string): TaskMaterialInputReference {
    const view = this.fixedDocument(ctx, documentId, versionId)
    const row = this.host.get('SELECT metadataJson FROM task_material_submissions WHERE documentId=? AND versionId=?', documentId, versionId)
    const approval = row ? governanceStored(teamTaskMaterialSubmissionSchema, row.metadataJson) : null
    if (!approval || approval.status !== 'approved' || !approval.decidedBy || approval.decidedAt === null) governanceFail('TASK_INPUT_APPROVAL_REQUIRED', 'A selected document version has no fixed approval')
    if (approval.documentId !== documentId || approval.versionId !== versionId || approval.bodyDigest !== view.selected.bodyDigest) governanceFail('CORRUPT_STORE', 'Fixed approval does not match its original document bytes', 503)
    const selected = view.selected
    return { documentId, versionId, kind: view.document.kind, spaceId: ctx.space.id, taskCreatedAt: ctx.task.createdAt, title: selected.title, bodyDigest: selected.bodyDigest, byteLength: selected.byteLength }
  }
  private fixedDocument(ctx: Context, documentId: string, versionId: string): { document: TeamTaskMaterialMetadata; selected: TeamTaskMaterialVersion; text: string } {
    const docRow = this.host.get('SELECT recordJson FROM task_material_documents WHERE documentId=? AND projectId=? AND taskId=? AND spaceId=? AND taskCreatedAt=?', teamIdSchema.parse(documentId), ctx.projectId, ctx.task.id, ctx.space.id, ctx.task.createdAt)
    const row = this.host.get('SELECT metadataJson FROM task_material_versions WHERE documentId=? AND versionId=?', documentId, teamIdSchema.parse(versionId))
    if (!docRow || !row) governanceFail('TASK_INPUT_UNAVAILABLE', 'Original fixed document is unavailable', 404)
    const document = governanceStored(teamTaskMaterialMetadataSchema, docRow.recordJson), selected = governanceStored(teamTaskMaterialVersionSchema, row.metadataJson)
    if (document.projectId !== ctx.projectId || document.taskId !== ctx.task.id || document.spaceId !== ctx.space.id || document.taskCreatedAt !== ctx.task.createdAt || document.documentId !== documentId || selected.documentId !== documentId || selected.versionId !== versionId) governanceFail('CORRUPT_STORE', 'Fixed document metadata changed its original identity', 503)
    // Only the exact pinned version's upstream ACL participates. An unrelated newer
    // private draft cannot hide or retarget a previously adopted authorized version.
    for (const ref of selected.references) {
      if (ref.kind === 'material') {
        const material = this.host.material(ctx.principal, ref.materialId, ref.version)
        if (material.projectId !== ctx.projectId || material.bodyDigest !== ref.bodyDigest) governanceFail('TASK_INPUT_REFERENCE_CONFLICT', 'Fixed document source identity changed')
      } else {
        const creation = this.host.get("SELECT c.spaceId,c.published,json_extract(v.value,'$.bodyDigest') AS bodyDigest FROM creations c,json_each(c.recordJson,'$.revisions') v WHERE c.projectId=? AND c.creationId=? AND json_extract(v.value,'$.revisionId')=?", ctx.projectId, ref.creationId, ref.revisionId)
        if (!creation || creation.published !== 1) governanceFail('TASK_INPUT_UNAVAILABLE', 'Fixed creation source is unavailable', 404)
        if (creation.spaceId !== null) this.governance.context(ctx.principal, ctx.projectId, teamTaskProgressResourceIdSchema.parse(creation.spaceId))
        if (creation.bodyDigest !== ref.bodyDigest) governanceFail('TASK_INPUT_REFERENCE_CONFLICT', 'Fixed creation digest changed')
      }
    }
    const bytes = this.host.body(selected.bodyDigest)
    if (bytes.length !== selected.byteLength || governanceHash(bytes) !== selected.bodyDigest) governanceFail('CORRUPT_STORE', 'Fixed document body failed verification', 503)
    return { document, selected, text: bytes.toString('utf8') }
  }
  readDocument(principal: StorePrincipal, raw: Record<string, unknown>): z.infer<typeof taskInputDocumentViewSchema> {
    const ctx = this.context(principal, raw, this.query(raw)), documentId = teamIdSchema.parse(raw.documentId), versionId = teamIdSchema.parse(raw.versionId)
    const reference = this.document(ctx, documentId, versionId), view = this.fixedDocument(ctx, documentId, versionId)
    return taskInputDocumentViewSchema.parse({ ...this.host.identity(), ...this.scope(ctx), reference, text: view.text, canWithdraw: view.document.approverIds.includes(principal.person.userId) })
  }
  private withdrawnDocument(documentId: string, versionId: string): boolean { return !!this.host.get('SELECT versionId FROM task_input_withdrawals WHERE documentId=? AND versionId=?', documentId, versionId) }
  private applicable(version: GovernanceVersion, task: CruxTask): boolean {
    // A future file/module selection must not omit a required rule before its scope is known.
    // Paths and modules remain explicit selection evidence; task-type mismatch is authoritative here.
    return version.settings.kind !== 'rule' || version.settings.applicability.taskTypeIds.length === 0 || version.settings.applicability.taskTypeIds.includes(task.typeId ?? '')
  }

  private publishedCandidates(ctx: Context, includeTemplates = true): { rules: GovernanceVersion[]; templates: GovernanceVersion[] } {
    const rules: GovernanceVersion[] = [], templates: GovernanceVersion[] = []
    for (const pkg of this.governance.packages(ctx)) {
      if (!pkg.publicationActive || !pkg.published || this.governance.withdrawn(pkg.packageId, pkg.published.versionId) || !includeTemplates && pkg.kind !== 'rule') continue
      const version = this.governance.version(ctx, pkg.packageId, pkg.published.versionId, true)
      if (!this.applicable(version, ctx.task)) continue
      if (version.settings.kind === 'rule') rules.push(version)
      else templates.push(version)
    }
    if (rules.length > 64 || templates.length > 64) governanceFail('CAPACITY_EXCEEDED', 'Task input candidates exceed the fixed catalog budget', 413)
    return { rules, templates }
  }

  private contentRule(ctx: Context, packageId: string, versionId: string): TaskContentRule {
    const version = this.governance.version(ctx, packageId, versionId, true)
    if (version.settings.kind !== 'rule' || !this.applicable(version, ctx.task)) governanceFail('TASK_INPUT_RULE_CONFLICT', 'Original rule no longer applies to this task')
    if (this.governance.withdrawn(packageId, versionId)) governanceFail('GOVERNANCE_WITHDRAWN', 'Original rule publication was formally withdrawn')
    if (version.byteLength > 128 * 1024) governanceFail('CONTENT_INPUT_TOO_LARGE', 'Published rule exceeds the content UTF-8 input budget', 413)
    const text = this.governance.text(version)
    if (Buffer.byteLength(text) !== version.byteLength || governanceHash(text) !== version.bodyDigest) governanceFail('CORRUPT_STORE', 'Published rule is not original UTF-8 text', 503)
    return { version, text }
  }

  /** Draft generation reads published rules independently of document approval/adoption gates. */
  contentRules(principal: StorePrincipal, raw: Record<string, unknown>): TaskContentRule[] {
    const ctx = this.context(principal, raw, this.query(raw)), { rules } = this.publishedCandidates(ctx, false)
    if (rules.some(rule => rules.some(other => conflicts(rule, other)))) governanceFail('TASK_INPUT_RULE_CONFLICT', 'Applicable required rules conflict at the same priority')
    if (rules.reduce((size, rule) => size + rule.byteLength, 0) > 128 * 1024) governanceFail('CONTENT_INPUT_TOO_LARGE', 'Published rules exceed the combined UTF-8 input budget', 413)
    return rules.map(rule => this.contentRule(ctx, rule.packageId, rule.versionId))
  }

  readContentRule(principal: StorePrincipal, raw: Record<string, unknown>): TaskContentRule {
    const ctx = this.context(principal, raw, this.query(raw))
    return this.contentRule(ctx, teamIdSchema.parse(raw.packageId), teamIdSchema.parse(raw.versionId))
  }

  private candidatesFor(ctx: Context): TaskInputCandidates {
    const documents: TaskMaterialInputReference[] = [], blockers: string[] = []
    const rows = this.host.all('SELECT recordJson FROM task_material_documents WHERE projectId=? AND taskId=? AND spaceId=? AND taskCreatedAt=? ORDER BY documentId LIMIT 5', ctx.projectId, ctx.task.id, ctx.space.id, ctx.task.createdAt)
    if (rows.length > 4) governanceFail('CAPACITY_EXCEEDED', 'Task document catalog exceeds its bounded kinds', 413)
    for (const row of rows) {
      const doc = governanceStored(teamTaskMaterialMetadataSchema, row.recordJson)
      if (doc.approved) {
        if (this.withdrawnDocument(doc.documentId, doc.approved.versionId)) { if (doc.kind === 'prd') blockers.push('PRD 的批准已正式撤回，请取得新的固定批准版本。'); continue }
        try { documents.push(this.document(ctx, doc.documentId, doc.approved.versionId)) }
        catch (error) { if (error && typeof error === 'object' && 'statusCode' in error && (error.statusCode === 403 || error.statusCode === 404)) { if (doc.kind === 'prd') blockers.push('任务有当前无权读取的必需资料，请由负责人核对访问范围。') } else throw error }
      } else if (doc.kind === 'prd') blockers.push('PRD 尚未批准，不能以任务摘要或空输入替代。')
    }
    const { rules, templates } = this.publishedCandidates(ctx)
    for (const rule of rules) {
      if (rule.settings.kind !== 'rule' || rule.settings.obligation !== 'required') continue
      this.governance.text(rule)
      if (rules.some(other => conflicts(rule, other))) blockers.push(`必需规则「${rule.title}」存在同优先级冲突，请规则负责人处理。`)
    }
    return taskInputCandidatesSchema.parse({ ...this.host.identity(), ...this.scope(ctx), documents, rules, templates, blockers: [...new Set(blockers)] })
  }

  candidates(principal: StorePrincipal, raw: Record<string, unknown>): TaskInputCandidates { return this.candidatesFor(this.context(principal, raw, this.query(raw))) }

  /** Exact original bundle, independent of the task's latest adoption. */
  fixedExecutionBundle(principal: StorePrincipal, task: import('../../../src/shared/team-task-execution').TeamTaskRef, ref: import('../../../src/shared/team-task-execution').TeamExecutionRecord['inputBundle']): TaskInputBundle {
    if (!ref || task.instanceId !== this.host.identity().instanceId) governanceFail('EXECUTION_INPUT_CONFLICT', 'A fixed adopted bundle from this service is required')
    const ctx = this.context(principal, task, task)
    const bundle = this.bundle(ctx, ref.bundleId)
    if (bundle.revision !== ref.revision || bundle.digest !== ref.digest) governanceFail('EXECUTION_INPUT_CONFLICT', 'Original adopted bundle changed')
    return bundle
  }

  fixedExecutionResource(principal: StorePrincipal, task: import('../../../src/shared/team-task-execution').TeamTaskRef,
    source: Extract<import('../../../src/shared/team-execution-input').ExecutionInputResource['selection']['source'], { kind: 'governance' | 'confirmed-document' }>): { title: string; bodyDigest: string; byteLength: number; text: string; withdrawn: boolean } {
    const ctx = this.context(principal, task, task)
    if (source.kind === 'governance') {
      const version = this.governance.version(ctx, source.packageId, source.versionId, true), text = this.governance.text(version)
      if (Buffer.byteLength(text, 'utf8') !== version.byteLength || governanceHash(text) !== version.bodyDigest) governanceFail('CORRUPT_STORE', 'Fixed rule is not original UTF-8 text', 503)
      return { title: version.title, bodyDigest: version.bodyDigest, byteLength: version.byteLength, text, withdrawn: this.governance.withdrawn(source.packageId, source.versionId) }
    }
    const ref = this.document(ctx, source.documentId, source.versionId), view = this.fixedDocument(ctx, source.documentId, source.versionId)
    if (Buffer.byteLength(view.text, 'utf8') !== ref.byteLength || governanceHash(view.text) !== ref.bodyDigest) governanceFail('CORRUPT_STORE', 'Fixed document is not original UTF-8 text', 503)
    return { title: ref.title, bodyDigest: ref.bodyDigest, byteLength: ref.byteLength, text: view.text, withdrawn: this.withdrawnDocument(source.documentId, source.versionId) }
  }

  private bundle(ctx: Context, bundleId: string): TaskInputBundle {
    const row = this.host.get('SELECT recordJson FROM task_input_bundles WHERE bundleId=? AND projectId=? AND taskId=? AND spaceId=? AND taskCreatedAt=?', bundleId, ctx.projectId, ctx.task.id, ctx.space.id, ctx.task.createdAt)
    if (!row) governanceFail('TASK_INPUT_UNAVAILABLE', 'Original input revision is unavailable', 404)
    const bundle = governanceStored(taskInputBundleSchema, row.recordJson)
    const { digest, ...content } = bundle
    if (governanceHash(canonical(content)) !== digest) governanceFail('CORRUPT_STORE', 'Input bundle digest failed verification', 503)
    for (const ref of bundle.documents) {
      if (canonical(this.document(ctx, ref.documentId, ref.versionId)) !== canonical(ref)) governanceFail('CORRUPT_STORE', 'Fixed document reference changed', 503)
    }
    for (const ref of [...bundle.rules, ...(bundle.template ? [bundle.template] : [])]) {
      const version = this.governance.version(ctx, ref.packageId, ref.versionId, true)
      if (canonical(version) !== canonical(ref)) governanceFail('CORRUPT_STORE', 'Fixed governance reference changed', 503)
      this.governance.text(version)
    }
    return bundle
  }

  read(principal: StorePrincipal, raw: Record<string, unknown>): TaskInputRead {
    const ctx = this.context(principal, raw, this.query(raw)), head = this.head(ctx)
    const current = head.currentBundleId ? this.bundle(ctx, head.currentBundleId) : null
    const blockers: string[] = []
    let status: TaskInputRead['admission']['status'] = 'ready'
    let legacySummary: TaskInputRead['legacySummary'] = null
    if (current) {
      if (current.epoch !== this.host.identity().epoch || current.instanceId !== this.host.identity().instanceId) blockers.push('原输入属于先前服务代次，请明确核对后重新采纳。')
      for (const ref of current.documents) if (this.withdrawnDocument(ref.documentId, ref.versionId)) blockers.push(`「${ref.title}」的原批准已正式撤回，需要重新审阅。`)
      for (const ref of [...current.rules, ...(current.template ? [current.template] : [])]) if (this.governance.withdrawn(ref.packageId, ref.versionId)) blockers.push(`「${ref.title}」的固定版本已正式撤回，需要重新审阅。`)
      if (blockers.length) status = 'review-required'
    } else {
      const candidates = this.candidatesFor(ctx)
      blockers.push(...candidates.blockers)
      if (blockers.length) status = 'blocked'
      else if (candidates.documents.some(doc => doc.kind === 'prd') || candidates.rules.some(rule => rule.settings.kind === 'rule' && rule.settings.obligation === 'required')) {
        status = 'requires-adoption'; blockers.push('任务尚未明确采纳必需资料，请比较并确认固定输入。')
      } else {
        const summary = { title: ctx.task.title, description: ctx.task.description ?? '' }, bytes = Buffer.from(canonical(summary), 'utf8')
        legacySummary = { ...summary, bodyDigest: governanceHash(bytes), byteLength: bytes.length, workspaceRevision: ctx.workspaceRevision }
      }
    }
    return taskInputReadSchema.parse({ ...this.host.identity(), ...this.scope(ctx), revision: head.revision, current, admission: { status, blockers }, legacySummary })
  }

  revision(principal: StorePrincipal, raw: Record<string, unknown>): TaskInputBundle {
    const ctx = this.context(principal, raw, this.query(raw)), revision = z.coerce.number().int().positive().safe().parse(raw.revision)
    const row = this.host.get('SELECT bundleId FROM task_input_bundles WHERE projectId=? AND taskId=? AND spaceId=? AND taskCreatedAt=? AND revision=?', ctx.projectId, ctx.task.id, ctx.space.id, ctx.task.createdAt, revision)
    if (!row) governanceFail('TASK_INPUT_UNAVAILABLE', 'Input revision is unavailable', 404)
    return this.bundle(ctx, teamIdSchema.parse(row.bundleId))
  }

  /** Read-only server hook. Call inside the existing workspace command transaction,
   * after the native domain produces its next snapshot and before persisting it.
   * Inputs and required outputs must already be explicitly adopted fixed approvals.
   * Recovery/backward actions remain available while a baseline needs review.
   */
  validateTaskTransitionInputs(principal: StorePrincipal, projectId: string, beforeTask: CruxTask, afterTask: CruxTask, raw: CruxTransitionTaskInput): void {
    const input = cruxTransitionTaskInputSchema.parse(raw)
    if (input.taskId !== beforeTask.id || afterTask.id !== beforeTask.id || afterTask.spaceId !== beforeTask.spaceId || afterTask.createdAt !== beforeTask.createdAt) governanceFail('TASK_INPUT_SCOPE_CONFLICT', 'A transition cannot change its original task identity')
    if (['request_info', 'supplement', 'decline', 'reassign', 'return_design', 'return_development', 'return_delivery'].includes(input.action)) return
    const scope = { spaceId: beforeTask.spaceId, taskCreatedAt: beforeTask.createdAt }
    const ctx = this.context(principal, { projectId, taskId: beforeTask.id }, scope, true)
    if (ctx.task.updatedAt !== beforeTask.updatedAt || ctx.task.workflow?.stage !== beforeTask.workflow?.stage) governanceFail('TASK_INPUT_SCOPE_CONFLICT', 'Transition source no longer matches the persisted task')
    const read = this.read(principal, { projectId, taskId: beforeTask.id, query: scope })
    if (read.admission.status !== 'ready') governanceFail('TASK_INPUT_TRANSITION_BLOCKED', read.admission.blockers.join(' ') || 'Required fixed inputs have not been adopted')
    const bundle = read.current, settings = bundle?.template?.settings
    if (bundle && input.action === 'submit_test') {
      if (this.validateDatabaseDelivery) this.validateDatabaseDelivery(principal, { instanceId: this.host.identity().instanceId, projectId,
        spaceId: beforeTask.spaceId, taskId: beforeTask.id, taskCreatedAt: beforeTask.createdAt }, bundle, input, beforeTask, afterTask)
      else for (const rule of bundle.rules) {
        if (rule.settings.kind !== 'rule' || rule.settings.obligation !== 'required') continue
        let configured: boolean
        try { configured = readDatabaseDeliveryDescriptor(this.governance.text(rule)) !== null }
        catch { governanceFail('DATABASE_DELIVERY_BLOCKED', 'submit_test: unsupported database delivery descriptor') }
        if (configured) governanceFail('DATABASE_DELIVERY_BLOCKED', 'submit_test: database delivery authority is unavailable')
      }
    }
    if (!bundle || !settings || settings.kind !== 'workflow-template') return
    const from = beforeTask.workflow?.stage ?? 'accepted', to = afterTask.workflow?.stage
    if (!to || from === to) return
    const source = settings.nodes.find(node => node.stage === from), target = settings.nodes.find(node => node.stage === to)
    const requireDocument = (kind: TaskMaterialInputReference['kind'], purpose: string): TaskMaterialInputReference => {
      const ref = bundle.documents.find(doc => doc.kind === kind)
      if (!ref) governanceFail('TASK_INPUT_TEMPLATE_DOCUMENT_REQUIRED', `${purpose}: explicitly adopt the approved fixed ${kind} version before advancing`)
      // bundle() already verified body integrity, current references, original task ACL and formal withdrawals.
      return ref
    }
    for (const kind of target?.inputs ?? []) requireDocument(kind, `Entering ${target?.label ?? to}`)
    const outputs = (source?.outputs ?? []).map(kind => requireDocument(kind, `Completing ${source?.label ?? from}`))
    if (!source || source.approvalRole === 'none') return
    const role = source.approvalRole
    const roleDocuments = outputs.length ? outputs : bundle.documents.filter(doc => role === 'design' ? doc.kind === 'design' : role === 'development' ? doc.kind === 'implement' : role === 'product' ? doc.kind === 'prd' : doc.kind === 'delivery-note')
    const allowed = (personId: string): boolean => {
      if (!ctx.space.memberIds.includes(personId)) return false
      const member = this.host.get('SELECT pm.rolesJson FROM project_members pm JOIN people p ON p.userId=pm.userId JOIN projects pr ON pr.projectId=pm.projectId JOIN team_members tm ON tm.teamId=pr.teamId AND tm.userId=p.userId WHERE pm.projectId=? AND pm.userId=? AND pm.active=1 AND p.active=1 AND tm.active=1', projectId, personId)
      if (!member) return false
      if (role === 'space-owner') return ctx.space.ownerId === personId
      // The existing project catalog has no separate designer role. Design authority
      // is the explicit approver grant on the exact adopted design document.
      if (role === 'design') return roleDocuments.some(ref => {
        const view = this.fixedDocument(ctx, ref.documentId, ref.versionId)
        return ref.kind === 'design' && view.document.approverIds.includes(personId)
      })
      const roles = governanceStored(z.array(z.string()), member.rolesJson), assignments = beforeTask.workflow?.deliveryState?.roles
      if (role === 'product') return roles.includes('product') || assignments?.productOwnerId === personId || beforeTask.workKind === 'general' && assignments?.acceptanceOwnerId === personId
      if (role === 'development') return roles.includes('developer')
      return roles.includes('tester') || assignments?.testOwnerId === personId
    }
    for (const ref of outputs) {
      const row = this.host.get('SELECT metadataJson FROM task_material_submissions WHERE documentId=? AND versionId=?', ref.documentId, ref.versionId)
      const approval = row ? governanceStored(teamTaskMaterialSubmissionSchema, row.metadataJson) : null
      if (!approval?.decidedBy || approval.status !== 'approved' || !allowed(approval.decidedBy)) governanceFail('TASK_INPUT_TEMPLATE_APPROVAL_REQUIRED', `${source.label}: the fixed output requires an active ${role} approver`)
    }
    if (['approve_design', 'approve_plan', 'pass_test', 'accept_delivery'].includes(input.action) || outputs.length === 0) {
      if (!allowed(principal.person.userId)) governanceFail('TASK_INPUT_TEMPLATE_ROLE_REQUIRED', `${source.label}: the current person lacks the configured ${role} approval authority`, 403)
    }
  }

  authorizeReceipt(principal: StorePrincipal, raw: unknown): TaskInputReceipt {
    const receipt = governanceStored(taskInputReceiptSchema, raw)
    if (receipt.actorId !== principal.person.userId || receipt.deviceId !== principal.deviceId) governanceFail('TASK_INPUT_FORBIDDEN', 'Receipt belongs to its original actor and device', 403)
    const ctx = this.context(principal, receipt, receipt)
    if (receipt.bundleId) this.bundle(ctx, receipt.bundleId)
    return receipt
  }

  receipt(principal: StorePrincipal, raw: Record<string, unknown>): TaskInputReceipt | null {
    const ctx = this.context(principal, raw, this.query(raw))
    const row = this.host.get('SELECT kind,resultJson FROM commands WHERE userId=? AND commandId=?', principal.person.userId, teamCommandIdSchema.parse(raw.commandId))
    if (!row) return null
    if (row.kind !== 'taskInputCommand') governanceFail('TASK_INPUT_UNAVAILABLE', 'Receipt is unavailable in this scope', 404)
    const receipt = this.authorizeReceipt(principal, row.resultJson)
    if (receipt.projectId !== ctx.projectId || receipt.taskId !== ctx.task.id || receipt.spaceId !== ctx.space.id || receipt.taskCreatedAt !== ctx.task.createdAt) governanceFail('TASK_INPUT_UNAVAILABLE', 'Receipt is unavailable in this scope', 404)
    return receipt
  }

  private authorize(ctx: Context, command: TaskInputCommand): void {
    if (command.expectedEpoch !== this.host.identity().epoch) governanceFail('WORKSPACE_EPOCH_CHANGED', 'The original command belongs to a different service epoch')
    const actor = ctx.principal.person.userId
    if (command.action === 'withdrawDocument') {
      const doc = this.fixedDocument(ctx, command.documentId, command.versionId).document
      if (!doc.approverIds.includes(actor)) governanceFail('TASK_INPUT_FORBIDDEN', 'Only a document approver may formally withdraw its approval', 403)
    } else if (!this.governance.manager(ctx) && ctx.task.creatorId !== actor && (ctx.task.workflow ? ctx.task.workflow.handlerId !== actor : !ctx.task.assigneeIds.includes(actor))) governanceFail('TASK_INPUT_FORBIDDEN', 'Only the original task handler or space manager may adopt inputs', 403)
  }

  command(actor: StoreActor, raw: Record<string, unknown>): TeamCommandReply<TaskInputReceipt> {
    const command = taskInputCommandSchema.parse(raw.body), projectId = teamIdSchema.parse(raw.projectId), taskId = teamTaskProgressResourceIdSchema.parse(raw.taskId)
    return this.host.mutation(actor, command.commandId, 'taskInputCommand', { projectId, taskId, command },
      principal => this.authorize(this.context(principal, raw, command, true), command),
      principal => this.apply(this.context(principal, raw, command, true), command),
      (principal, result) => { this.authorizeReceipt(principal, result) })
  }

  private apply(ctx: Context, command: TaskInputCommand): TaskInputReceipt {
    const head = this.head(ctx)
    governanceCas(head.revision, command.expectedRevision)
    const revision = governanceNext(head.revision)
    let bundleId: string | null = null, digest: string | null = null
    if (command.action === 'withdrawDocument') {
      this.document(ctx, command.documentId, command.versionId)
      if (this.withdrawnDocument(command.documentId, command.versionId)) governanceFail('TASK_INPUT_WITHDRAWN', 'This document approval has already been withdrawn')
      this.host.run('INSERT INTO task_input_withdrawals(documentId,versionId,withdrawnBy,withdrawnAt,reason) VALUES(?,?,?,?,?)', command.documentId, command.versionId, ctx.principal.person.userId, Date.now(), command.reason)
      this.setHead(ctx, revision, head.currentBundleId)
    } else {
      const candidates = this.candidatesFor(ctx)
      if (candidates.blockers.length) governanceFail('TASK_INPUT_BLOCKED', candidates.blockers.join(' '))
      if (new Set(command.documents.map(doc => doc.documentId)).size !== command.documents.length || new Set(command.rules.map(rule => rule.packageId)).size !== command.rules.length) governanceFail('INVALID_INPUT', 'Duplicate fixed input selection', 400)
      const documents = command.documents.map(ref => {
        const doc = this.document(ctx, ref.documentId, ref.versionId)
        if (this.withdrawnDocument(ref.documentId, ref.versionId)) governanceFail('TASK_INPUT_WITHDRAWN', 'A selected approval was formally withdrawn')
        return doc
      }).sort((a, b) => a.documentId.localeCompare(b.documentId))
      if (candidates.documents.some(doc => doc.kind === 'prd') && !documents.some(doc => doc.kind === 'prd')) governanceFail('TASK_INPUT_PRD_REQUIRED', 'The approved PRD must be explicitly selected')
      const rules = command.rules.map(ref => this.governance.version(ctx, ref.packageId, ref.versionId, true)).sort((a, b) => a.packageId.localeCompare(b.packageId))
      for (const rule of rules) {
        if (rule.settings.kind !== 'rule' || !this.applicable(rule, ctx.task)) governanceFail('TASK_INPUT_RULE_CONFLICT', 'Selected rule does not apply to this task')
      }
      // Required obligations use a package identity, allowing an explicitly selected older published version.
      for (const required of candidates.rules) if (required.settings.kind === 'rule' && required.settings.obligation === 'required' && !rules.some(rule => rule.packageId === required.packageId && rule.settings.kind === 'rule' && rule.settings.obligation === 'required')) governanceFail('TASK_INPUT_RULE_REQUIRED', 'All applicable required rules must be explicitly selected')
      const template = command.template ? this.governance.version(ctx, command.template.packageId, command.template.versionId, true) : null
      if (template && template.settings.kind !== 'workflow-template') governanceFail('TASK_INPUT_TEMPLATE_CONFLICT', 'Workflow input must refer to a published workflow template')
      for (const ref of [...rules, ...(template ? [template] : [])]) {
        const pkg = this.governance.package(ctx, ref.packageId)
        if (!pkg.publicationActive || this.governance.withdrawn(ref.packageId, ref.versionId)) governanceFail('TASK_INPUT_WITHDRAWN', 'Disabled or withdrawn packages cannot be newly adopted')
        this.governance.text(ref)
      }
      for (const rule of rules) if (rules.some(other => conflicts(rule, other))) governanceFail('TASK_INPUT_RULE_CONFLICT', 'Selected required rules conflict at the same priority')
      if (!documents.length && !rules.length && !template) governanceFail('TASK_INPUT_SELECTION_EMPTY', 'Select a fixed input before adopting; a task with no required materials may use its formal task summary')
      const content = { ...this.host.identity(), ...this.scope(ctx), bundleId: randomUUID(), revision, documents, rules, template, adoptedBy: ctx.principal.person.userId, deviceId: ctx.principal.deviceId, adoptedAt: Date.now() }
      digest = governanceHash(canonical(content)); bundleId = content.bundleId
      const bundle = taskInputBundleSchema.parse({ ...content, digest })
      this.host.run('INSERT INTO task_input_bundles(bundleId,projectId,taskId,spaceId,taskCreatedAt,revision,recordJson) VALUES(?,?,?,?,?,?,?)', bundleId, ctx.projectId, ctx.task.id, ctx.space.id, ctx.task.createdAt, revision, JSON.stringify(bundle))
      this.setHead(ctx, revision, bundleId)
    }
    return taskInputReceiptSchema.parse({ ...this.host.identity(), ...this.scope(ctx), commandId: command.commandId, action: command.action, revision, bundleId, digest, actorId: ctx.principal.person.userId, deviceId: ctx.principal.deviceId, committedAt: Date.now() })
  }
}

/** Adapter for a native workspace host callback; it creates no second workflow state. */
export function validateTaskTransitionInputs(inputs: TeamTaskInputs, principal: StorePrincipal, projectId: string, beforeTask: CruxTask, afterTask: CruxTask, transition: CruxTransitionTaskInput): void {
  inputs.validateTaskTransitionInputs(principal, projectId, beforeTask, afterTask, transition)
}
