import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { SOURCE_PART_BYTES, sourcePartQuery, sourcePartData, taskSourceFiles } from '../../../src/shared/task-source-files'
import type { CruxSpace, CruxTask } from '../../../src/shared/crux'
import { cruxSnapshotSchema } from '../../../src/shared/crux-schema'
import { canReadCruxSpace } from '../../../src/shared/crux-domain/commands'
import { teamCommandIdSchema, teamIdSchema, type TeamMaterialVersion, type TeamPage } from '../../../src/shared/team-platform'
import { teamTaskProgressResourceIdSchema } from '../../../src/shared/team-task-progress'
import {
  teamTaskMaterialCommandSchema, teamTaskMaterialListInputSchema, teamTaskMaterialMetadataSchema,
  teamTaskMaterialReadInputSchema, teamTaskMaterialReceiptSchema, teamTaskMaterialScopeSchema,
  teamTaskMaterialSubmissionSchema, teamTaskMaterialVersionSchema,
  type TeamTaskMaterialCommand, type TeamTaskMaterialCommandReply, type TeamTaskMaterialList,
  type TeamTaskMaterialMetadata, type TeamTaskMaterialReceipt, type TeamTaskMaterialReference,
  type TeamTaskMaterialScope, type TeamTaskMaterialSubmission, type TeamTaskMaterialVersion, type TeamTaskMaterialView
} from '../../../src/shared/team-task-materials'
import type { CreationsHost } from './creations'
import type { CruxWorkspaceHost } from './crux-workspace'
import type { StoreActor, StorePrincipal } from './store-types'
import { TeamServiceError } from './errors'
import { TASK_OUTPUT_KINDS, type TaskOutputOriginBundle, type TaskOutputVersionOrigin } from '../../../src/shared/task-output-origin'

export type TaskMaterialsHost = Omit<CreationsHost, 'identity'> & Pick<CruxWorkspaceHost, 'identity'> & {
  material(principal: StorePrincipal, materialId: string, version: number): TeamMaterialVersion
  body(bodyDigest: string): Buffer
  persistBody(bytes: Buffer, bodyDigest: string): void
  validateOriginBundle(principal: StorePrincipal, scope: TeamTaskMaterialScope & { projectId: string; taskId: string }, bundle: TaskOutputOriginBundle): void
}
type Context = { principal: StorePrincipal; projectId: string; task: CruxTask; space: CruxSpace; workspaceRevision: number }
const MAX_VERSIONS = 1000
const MAX_BLOB_BYTES = 1024 * 1024 * 1024
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
function fail(code: string, message: string, status = 409): never { throw new TeamServiceError(code, message, status) }
function unavailable(): never { return fail('TASK_MATERIAL_UNAVAILABLE', 'Task material is unavailable in this scope', 404) }
function forbidden(): never { return fail('TASK_MATERIAL_FORBIDDEN', 'Current person has no explicit grant for this task document', 403) }
function stored<T>(schema: z.ZodType<T>, value: unknown): T {
  try { return schema.parse(typeof value === 'string' ? JSON.parse(value) : value) }
  catch { return fail('CORRUPT_STORE', 'Stored task material or authority is invalid', 503) }
}
function next(value: number): number {
  if (value >= Number.MAX_SAFE_INTEGER) fail('CAPACITY_EXCEEDED', 'Task material revision exhausted', 503)
  return value + 1
}
function cas(actual: number, expected: number): void {
  if (actual !== expected) fail('TASK_MATERIAL_REVISION_CONFLICT', 'Task material changed; reload and compare before issuing a new command')
}

export class TeamTaskMaterials {
  constructor(private readonly host: TaskMaterialsHost & { workspaceChanged(projectId: string): void }) {}

  sourcePart(principal: StorePrincipal, raw: Record<string, unknown>, writing: boolean) {
    const location = teamTaskMaterialScopeSchema.parse(raw.query)
    const ctx = this.context(principal, raw, location, writing)
    const part = sourcePartQuery.parse({ sourceId: raw.sourceId, revision: raw.revision, part: raw.part })
    const comment = ctx.task.handoff?.id === part.sourceId ? null : this.host.get(
      "SELECT c.value AS body FROM crux_workspaces w,json_each(w.snapshotJson,'$.comments') c WHERE w.projectId=? AND json_extract(c.value,'$.taskId')=? AND json_extract(c.value,'$.sourceId')=?",
      ctx.projectId, ctx.task.id, part.sourceId)
    const contribution = comment ? stored(cruxSnapshotSchema.shape.comments.element, comment.body) : null
    const handoff = ctx.task.handoff?.id === part.sourceId ? ctx.task.handoff : null
    const files = taskSourceFiles.parse(handoff?.files ?? contribution?.sourceFiles ?? [])
    const file = files.find(file => file.revision === part.revision) ?? unavailable()
    const digest = file.parts[part.part] ?? unavailable()
    const length = Math.min(SOURCE_PART_BYTES, file.bytes - part.part * SOURCE_PART_BYTES)
    const identity = this.host.identity()
    const receipt = { authorizationRevision: identity.authorizationRevision, instanceId: identity.instanceId, epoch: identity.epoch, projectId: ctx.projectId,
      taskId: ctx.task.id, ...location, ...part, digest }
    const key = [ctx.projectId, ctx.task.id, ctx.space.id, ctx.task.createdAt, part.sourceId, part.revision, part.part]
    const grant = this.host.get('SELECT bodyDigest FROM task_source_parts WHERE projectId=? AND taskId=? AND spaceId=? AND taskCreatedAt=? AND sourceId=? AND revision=? AND part=?', ...key)
    if (writing) {
      if ((handoff ? ctx.task.creatorId : contribution?.authorId) !== principal.person.userId) forbidden()
      const input = z.object({ epoch: z.string().uuid(), data: sourcePartData }).strict().parse(raw.body)
      if (input.epoch !== identity.epoch) fail('WORKSPACE_EPOCH_CHANGED', 'Original workspace has changed')
      const bytes = Buffer.from(input.data, 'base64')
      if (bytes.length !== length || hash(bytes) !== digest || bytes.toString('base64') !== input.data) fail('SOURCE_CHANGED', 'Selected attachment bytes do not match this task')
      if (grant) { if (grant.bodyDigest !== digest) unavailable(); return receipt }
      if (length) {
        const used = this.host.get('SELECT COALESCE(SUM(byteLength),0) AS bytes FROM blobs')
        if (!this.host.get('SELECT 1 FROM blobs WHERE bodyDigest=?', digest) && Number(used?.bytes ?? MAX_BLOB_BYTES) + length > MAX_BLOB_BYTES) fail('CAPACITY_EXCEEDED', 'Team file storage is full', 507)
        this.host.persistBody(bytes, digest)
        this.host.run('INSERT INTO blobs(bodyDigest,byteLength,createdAt) VALUES(?,?,?) ON CONFLICT(bodyDigest) DO NOTHING', digest, length, Date.now())
      }
      this.host.run('INSERT INTO task_source_parts(projectId,taskId,spaceId,taskCreatedAt,sourceId,revision,part,bodyDigest) VALUES(?,?,?,?,?,?,?,?)', ...key, digest)
      return receipt
    }
    if (!grant || grant.bodyDigest !== digest) fail('SOURCE_PENDING', '附件尚未传完，请稍后再打开', 409)
    const bytes = length ? this.host.body(digest) : Buffer.alloc(0)
    if (bytes.length !== length || hash(bytes) !== digest) fail('CORRUPT_STORE', 'Attachment part failed verification', 503)
    return { ...receipt, data: bytes.toString('base64') }
  }

  private context(principal: StorePrincipal, raw: Record<string, unknown>, scope: TeamTaskMaterialScope, writing = false): Context {
    const projectId = teamIdSchema.parse(raw.projectId), taskId = teamTaskProgressResourceIdSchema.parse(raw.taskId)
    this.host.project(principal, projectId)
    const row = this.host.get("SELECT w.revision,t.value AS body FROM crux_workspaces w,json_each(w.snapshotJson,'$.tasks') t WHERE w.projectId=? AND json_extract(t.value,'$.id')=?", projectId, taskId)
    if (!row) unavailable()
    const task = stored(cruxSnapshotSchema.shape.tasks.element, row.body)
    const spaceRow = this.host.get("SELECT s.value AS body FROM crux_workspaces w,json_each(w.snapshotJson,'$.spaces') s WHERE w.projectId=? AND json_extract(s.value,'$.id')=?", projectId, task.spaceId)
    if (!spaceRow) unavailable()
    const space = stored(cruxSnapshotSchema.shape.spaces.element, spaceRow.body)
    if (!canReadCruxSpace(space, principal.person.userId)) unavailable()
    if (task.spaceId !== scope.spaceId || task.createdAt !== scope.taskCreatedAt) fail('TASK_MATERIAL_SCOPE_CONFLICT', 'Task identity or space changed; the original document cannot be retargeted')
    if (writing && (space.archived || !space.memberIds.includes(principal.person.userId))) forbidden()
    return { principal, projectId, task, space, workspaceRevision: stored(z.number().int().nonnegative().safe(), row.revision) }
  }

  private manager(ctx: Context): boolean {
    const id = ctx.principal.person.userId
    return ctx.space.memberIds.includes(id) && (ctx.space.ownerId === id || ctx.task.creatorId === id ||
      (ctx.task.workflow ? ctx.task.workflow.handlerId === id : ctx.task.assigneeIds.includes(id)))
  }

  private participants(ctx: Context, ids: string[]): void {
    for (const id of new Set(ids)) {
      const active = this.host.get('SELECT p.userId FROM people p JOIN project_members pm ON pm.userId=p.userId JOIN projects pr ON pr.projectId=pm.projectId JOIN team_members tm ON tm.teamId=pr.teamId AND tm.userId=p.userId WHERE p.userId=? AND pm.projectId=? AND p.active=1 AND pm.active=1 AND tm.active=1', id, ctx.projectId)
      if (!active || !ctx.space.memberIds.includes(id)) fail('TASK_MATERIAL_GRANT_CONFLICT', 'Editors and approvers must be active people in the task space')
    }
  }

  private document(ctx: Context, documentId: string): TeamTaskMaterialMetadata {
    const row = this.host.get('SELECT recordJson FROM task_material_documents WHERE documentId=? AND projectId=? AND taskId=? AND spaceId=? AND taskCreatedAt=?', documentId, ctx.projectId, ctx.task.id, ctx.space.id, ctx.task.createdAt)
    if (!row) unavailable()
    return stored(teamTaskMaterialMetadataSchema, row.recordJson)
  }

  private version(documentId: string, versionId: string): TeamTaskMaterialVersion {
    const row = this.host.get('SELECT metadataJson FROM task_material_versions WHERE documentId=? AND versionId=?', documentId, versionId)
    if (!row) unavailable()
    return stored(teamTaskMaterialVersionSchema, row.metadataJson)
  }

  /** Fixed references retain their original ACL, including personal material ownership. No body is selected. */
  private references(ctx: Context, refs: TeamTaskMaterialReference[]): void {
    for (const ref of refs) {
      if (ref.kind === 'material') {
        const source = this.host.material(ctx.principal, ref.materialId, ref.version)
        if (source.projectId !== ctx.projectId || source.bodyDigest !== ref.bodyDigest) fail('TASK_MATERIAL_REFERENCE_CONFLICT', 'Referenced material scope or digest changed')
      } else {
        const row = this.host.get("SELECT c.spaceId,c.published,json_extract(v.value,'$.bodyDigest') AS bodyDigest FROM creations c,json_each(c.recordJson,'$.revisions') v WHERE c.projectId=? AND c.creationId=? AND json_extract(v.value,'$.revisionId')=?", ctx.projectId, ref.creationId, ref.revisionId)
        if (!row || row.published !== 1) unavailable()
        if (row.spaceId !== null) {
          const spaceRow = this.host.get("SELECT s.value AS body FROM crux_workspaces w,json_each(w.snapshotJson,'$.spaces') s WHERE w.projectId=? AND json_extract(s.value,'$.id')=?", ctx.projectId, row.spaceId)
          if (!spaceRow || !canReadCruxSpace(stored(cruxSnapshotSchema.shape.spaces.element, spaceRow.body), ctx.principal.person.userId)) forbidden()
        }
        if (row.bodyDigest !== ref.bodyDigest) fail('TASK_MATERIAL_REFERENCE_CONFLICT', 'Referenced creation digest does not match its fixed publication')
      }
    }
  }

  private versionReferences(ctx: Context, version: TeamTaskMaterialVersion): void {
    this.references(ctx, version.references)
    if (version.origin?.inputBundle) this.host.validateOriginBundle(ctx.principal,
      { projectId: ctx.projectId, taskId: ctx.task.id, spaceId: ctx.space.id, taskCreatedAt: ctx.task.createdAt }, version.origin.inputBundle)
  }

  private visible(ctx: Context, doc: TeamTaskMaterialMetadata): void {
    this.versionReferences(ctx, doc.draft)
    for (const submission of [doc.approved, doc.latestSubmission]) if (submission) this.versionReferences(ctx, this.version(doc.documentId, submission.versionId))
  }

  private allowed(action: () => void): boolean {
    try { action(); return true }
    catch (error) { if (error instanceof TeamServiceError && [403, 404].includes(error.statusCode)) return false; throw error }
  }

  list(principal: StorePrincipal, raw: Record<string, unknown>): TeamTaskMaterialList {
    const query = teamTaskMaterialListInputSchema.parse(raw.query ?? {}), ctx = this.context(principal, raw, query)
    // Fence continuation against document/ACL/reference changes as well as workspace changes.
    const heads = this.host.all('SELECT documentId,revision FROM task_material_documents WHERE projectId=? AND taskId=? AND spaceId=? AND taskCreatedAt=? ORDER BY documentId LIMIT 501', ctx.projectId, ctx.task.id, ctx.space.id, ctx.task.createdAt)
    const materialRevision = hash(Buffer.from(JSON.stringify(heads)))
    const scope = JSON.stringify(['task-materials', ctx.projectId, ctx.task.id, query.spaceId, query.taskCreatedAt, ctx.workspaceRevision, materialRevision])
    const after = this.host.after(principal, scope, query.cursor)
    const rows = this.host.all('SELECT documentId,recordJson FROM task_material_documents WHERE projectId=? AND taskId=? AND spaceId=? AND taskCreatedAt=? AND documentId>? ORDER BY documentId LIMIT 501', ctx.projectId, ctx.task.id, ctx.space.id, ctx.task.createdAt, after)
    const docs = new Map(rows.map((row) => [row, stored(teamTaskMaterialMetadataSchema, row.recordJson)]))
    const page = this.host.page(principal, scope, rows, 'documentId', query.limit,
      (row) => this.allowed(() => this.visible(ctx, stored(teamTaskMaterialMetadataSchema, docs.get(row)))),
      (row) => stored(teamTaskMaterialMetadataSchema, docs.get(row)))
    return { ...this.host.identity(), projectId: ctx.projectId, taskId: ctx.task.id, spaceId: ctx.space.id, taskCreatedAt: ctx.task.createdAt, page }
  }

  read(principal: StorePrincipal, raw: Record<string, unknown>): TeamTaskMaterialView {
    const query = teamTaskMaterialReadInputSchema.parse(raw.query ?? {}), ctx = this.context(principal, raw, query)
    const doc = this.document(ctx, teamIdSchema.parse(raw.documentId))
    this.visible(ctx, doc)
    const selected = query.versionId ? this.version(doc.documentId, query.versionId) : doc.draft
    this.versionReferences(ctx, selected)
    const bytes = this.host.body(selected.bodyDigest)
    if (bytes.length !== selected.byteLength) fail('CORRUPT_STORE', 'Task material body length failed verification', 503)
    return { ...this.host.identity(), document: doc, selected, text: bytes.toString('utf8') }
  }

  versions(principal: StorePrincipal, raw: Record<string, unknown>): ReturnType<TaskMaterialsHost['identity']> & { page: TeamPage<TeamTaskMaterialVersion> } {
    const query = teamTaskMaterialListInputSchema.parse(raw.query ?? {}), ctx = this.context(principal, raw, query)
    const doc = this.document(ctx, teamIdSchema.parse(raw.documentId))
    this.visible(ctx, doc)
    const scope = JSON.stringify(['task-material-versions', doc.documentId, doc.revision, ctx.workspaceRevision])
    const rows = this.host.all('SELECT versionId,metadataJson FROM task_material_versions WHERE documentId=? AND versionId>? ORDER BY versionId LIMIT 501', doc.documentId, this.host.after(principal, scope, query.cursor))
    return { ...this.host.identity(), page: this.host.page(principal, scope, rows, 'versionId', query.limit,
      (row) => this.allowed(() => this.versionReferences(ctx, stored(teamTaskMaterialVersionSchema, row.metadataJson))),
      (row) => stored(teamTaskMaterialVersionSchema, row.metadataJson)) }
  }

  submissions(principal: StorePrincipal, raw: Record<string, unknown>): ReturnType<TaskMaterialsHost['identity']> & { page: TeamPage<TeamTaskMaterialSubmission> } {
    const query = teamTaskMaterialListInputSchema.parse(raw.query ?? {}), ctx = this.context(principal, raw, query)
    const doc = this.document(ctx, teamIdSchema.parse(raw.documentId))
    this.visible(ctx, doc)
    const scope = JSON.stringify(['task-material-submissions', doc.documentId, doc.revision, ctx.workspaceRevision])
    const rows = this.host.all('SELECT submissionId,metadataJson FROM task_material_submissions WHERE documentId=? AND submissionId>? ORDER BY submissionId LIMIT 501', doc.documentId, this.host.after(principal, scope, query.cursor))
    return { ...this.host.identity(), page: this.host.page(principal, scope, rows, 'submissionId', query.limit,
      (row) => this.allowed(() => this.versionReferences(ctx, this.version(doc.documentId, stored(teamTaskMaterialSubmissionSchema, row.metadataJson).versionId))),
      (row) => stored(teamTaskMaterialSubmissionSchema, row.metadataJson)) }
  }

  authorizeReceipt(principal: StorePrincipal, raw: unknown): TeamTaskMaterialReceipt {
    const receipt = stored(teamTaskMaterialReceiptSchema, raw)
    const ctx = this.context(principal, receipt, receipt)
    if (receipt.actorId !== principal.person.userId || receipt.deviceId !== principal.deviceId) forbidden()
    const doc = this.document(ctx, receipt.documentId)
    this.visible(ctx, doc)
    if (receipt.versionId) this.versionReferences(ctx, this.version(doc.documentId, receipt.versionId))
    return receipt
  }

  receipt(principal: StorePrincipal, raw: Record<string, unknown>): TeamTaskMaterialReceipt | null {
    const query = teamTaskMaterialScopeSchema.parse(raw.query ?? {}), ctx = this.context(principal, raw, query)
    const row = this.host.get('SELECT kind,resultJson FROM commands WHERE userId=? AND commandId=?', principal.person.userId, teamCommandIdSchema.parse(raw.commandId))
    if (!row) return null
    if (row.kind !== 'taskMaterialCommand') unavailable()
    const receipt = this.authorizeReceipt(principal, typeof row.resultJson === 'string' ? JSON.parse(row.resultJson) : row.resultJson)
    if (receipt.projectId !== ctx.projectId || receipt.taskId !== ctx.task.id || receipt.spaceId !== ctx.space.id || receipt.taskCreatedAt !== ctx.task.createdAt) unavailable()
    return receipt
  }

  private authorizeCommand(ctx: Context, input: TeamTaskMaterialCommand): void {
    if (input.expectedEpoch !== this.host.identity().epoch) fail('WORKSPACE_EPOCH_CHANGED', 'Service epoch changed; reconcile the original command without retargeting it')
    if (input.action === 'create') {
      if (!this.manager(ctx)) forbidden()
    } else {
      const doc = this.document(ctx, input.documentId)
      // Saving a new draft may intentionally remove a now-inaccessible source. Reading old content still checks its ACL.
      const actorId = ctx.principal.person.userId
      if (input.action === 'setAccess') { if (!this.manager(ctx) && doc.ownerId !== actorId) forbidden() }
      else if (input.action === 'approve' || input.action === 'reject') { if (!doc.approverIds.includes(actorId)) forbidden() }
      else if (!doc.editorIds.includes(actorId)) forbidden()
      if (input.action !== 'saveDraft' && input.action !== 'setAccess') this.visible(ctx, doc)
    }
    if (input.action === 'create' || input.action === 'setAccess') this.participants(ctx, [...input.editorIds, ...input.approverIds])
    if (input.action === 'create' || input.action === 'saveDraft') {
      this.references(ctx, input.references)
      if (input.origin) {
        if (ctx.principal.actor.kind !== 'device' || !ctx.principal.deviceId) fail('TASK_MATERIAL_ORIGIN_FORBIDDEN', 'Only an authenticated device may report native task output origin', 403)
        const kind = input.action === 'create' ? input.kind : this.document(ctx, input.documentId).kind
        if (TASK_OUTPUT_KINDS[input.origin.file] !== kind) fail('TASK_MATERIAL_ORIGIN_CONFLICT', 'Native output file does not match the task document kind')
        if (input.origin.inputBundle) this.host.validateOriginBundle(ctx.principal,
          { projectId: ctx.projectId, taskId: ctx.task.id, spaceId: ctx.space.id, taskCreatedAt: ctx.task.createdAt }, input.origin.inputBundle)
      }
    }
  }

  private persist(doc: TeamTaskMaterialMetadata): void {
    const value = teamTaskMaterialMetadataSchema.parse(doc)
    this.host.run('UPDATE task_material_documents SET revision=?,recordJson=? WHERE documentId=?', value.revision, JSON.stringify(value), value.documentId)
  }

  private saveVersion(ctx: Context, documentId: string, number: number, baseDraftRevision: number, disposition: 'draft' | 'conflict', input: Extract<TeamTaskMaterialCommand, { action: 'create' | 'saveDraft' }>): TeamTaskMaterialVersion {
    const origin: TaskOutputVersionOrigin | undefined = input.origin && ctx.principal.actor.kind === 'device' && ctx.principal.deviceId
      ? { ...input.origin, verification: 'device-reported', deviceId: ctx.principal.deviceId } : undefined
    const count = this.host.get('SELECT COUNT(*) AS count FROM task_material_versions WHERE documentId=?', documentId)
    if (!count || typeof count.count !== 'number' || count.count >= MAX_VERSIONS) fail('CAPACITY_EXCEEDED', 'Document version capacity reached; existing drafts and approvals were preserved', 413)
    const bytes = Buffer.from(input.text, 'utf8'), bodyDigest = hash(bytes)
    if (bytes.length > 1024 * 1024) fail('CAPACITY_EXCEEDED', 'Document exceeds one MiB UTF-8', 413)
    if (bodyDigest !== input.expectedDigest) fail('DIGEST_CONFLICT', 'Document digest does not match its exact UTF-8 bytes')
    if (!this.host.get('SELECT bodyDigest FROM blobs WHERE bodyDigest=?', bodyDigest)) {
      const usage = this.host.get('SELECT COALESCE(SUM(byteLength),0) AS bytes FROM blobs')
      if (!usage || typeof usage.bytes !== 'number') fail('CORRUPT_STORE', 'Blob quota is unavailable', 503)
      if (usage.bytes + bytes.length > MAX_BLOB_BYTES) fail('CAPACITY_EXCEEDED', 'Team blob quota reached; existing documents were preserved', 507)
    }
    // The owned writer fsyncs immutable bytes before committing the referencing metadata/receipt.
    // A transaction failure can leave an unreachable blob, never a visible partial document.
    this.host.persistBody(bytes, bodyDigest)
    this.host.run('INSERT INTO blobs(bodyDigest,byteLength,createdAt) VALUES(?,?,?) ON CONFLICT(bodyDigest) DO NOTHING', bodyDigest, bytes.length, Date.now())
    const version: TeamTaskMaterialVersion = { versionId: randomUUID(), documentId, number, title: input.title, bodyDigest, byteLength: bytes.length,
      references: input.references, disposition, baseDraftRevision, authorId: ctx.principal.person.userId, createdAt: Date.now(), ...(origin ? { origin } : {}) }
    this.host.run('INSERT INTO task_material_versions(versionId,documentId,number,bodyDigest,metadataJson) VALUES(?,?,?,?,?)', version.versionId, documentId, number, bodyDigest, JSON.stringify(version))
    return version
  }

  command(actor: StoreActor, raw: Record<string, unknown>): TeamTaskMaterialCommandReply {
    const input = teamTaskMaterialCommandSchema.parse(raw.body)
    const projectId = teamIdSchema.parse(raw.projectId), taskId = teamTaskProgressResourceIdSchema.parse(raw.taskId)
    return this.host.mutation(actor, input.commandId, 'taskMaterialCommand', { projectId, taskId, input },
      (principal) => this.authorizeCommand(this.context(principal, raw, input, true), input),
      (principal) => this.apply(this.context(principal, raw, input, true), input),
      (principal, result) => { this.authorizeReceipt(principal, result) })
  }

  private apply(ctx: Context, input: TeamTaskMaterialCommand): TeamTaskMaterialReceipt {
    let doc: TeamTaskMaterialMetadata
    let versionId: string | null = null, submissionId: string | null = null
    let outcome: TeamTaskMaterialReceipt['outcome'] = 'applied'
    if (input.action === 'create') {
      if (this.host.get('SELECT documentId FROM task_material_documents WHERE projectId=? AND taskId=? AND spaceId=? AND taskCreatedAt=? AND kind=?', ctx.projectId, ctx.task.id, ctx.space.id, ctx.task.createdAt, input.kind)) fail('TASK_MATERIAL_EXISTS', 'This task already has a document of that kind; load its shared draft')
      const documentId = randomUUID(), timestamp = Date.now()
      // Placeholder remains inside the transaction until its validated first version is installed.
      this.host.run('INSERT INTO task_material_documents(documentId,projectId,taskId,spaceId,taskCreatedAt,kind,revision,recordJson) VALUES(?,?,?,?,?,?,1,?)', documentId, ctx.projectId, ctx.task.id, ctx.space.id, ctx.task.createdAt, input.kind, '{}')
      const draft = this.saveVersion(ctx, documentId, 1, 0, 'draft', input)
      doc = { documentId, projectId: ctx.projectId, taskId: ctx.task.id, spaceId: ctx.space.id, taskCreatedAt: ctx.task.createdAt, kind: input.kind,
        template: { templateId: input.kind, version: 1 }, ownerId: ctx.principal.person.userId, editorIds: input.editorIds, approverIds: input.approverIds,
        revision: 1, draftRevision: 1, draft, approved: null, latestSubmission: null, createdAt: timestamp, updatedAt: timestamp }
      versionId = draft.versionId
      if (ctx.task.handoff?.id === input.commandId) {
        if (input.kind !== 'prd' || ctx.task.creatorId !== ctx.principal.person.userId ||
            !ctx.task.handoff.versionLabel || ctx.task.handoff.materialDigest !== draft.bodyDigest) {
          fail('TASK_HANDOFF_MATERIAL_CONFLICT', 'Handoff material must match the fixed selected requirement')
        }
        const row = this.host.get('SELECT snapshotJson FROM crux_workspaces WHERE projectId=?', ctx.projectId)
        if (!row) unavailable()
        const snapshot = stored(cruxSnapshotSchema, row.snapshotJson)
        const task = snapshot.tasks.find(task => task.id === ctx.task.id && task.createdAt === ctx.task.createdAt)
        if (!task?.handoff) unavailable()
        task.handoff.material = { documentId, versionId: draft.versionId, bodyDigest: draft.bodyDigest }
        this.host.run('UPDATE crux_workspaces SET snapshotJson=? WHERE projectId=?', JSON.stringify(snapshot), ctx.projectId)
      }
    } else {
      doc = this.document(ctx, input.documentId)
      if (input.action === 'saveDraft') {
        if (input.expectedDraftRevision > doc.draftRevision) fail('TASK_MATERIAL_REVISION_CONFLICT', 'Draft revision is ahead of the current service state')
        const conflict = doc.draftRevision !== input.expectedDraftRevision
        const version = this.saveVersion(ctx, doc.documentId, next(doc.revision), input.expectedDraftRevision, conflict ? 'conflict' : 'draft', input)
        versionId = version.versionId
        if (conflict) outcome = 'conflict-preserved'
        else { doc.draft = version; doc.draftRevision = next(doc.draftRevision) }
      } else {
        cas(doc.revision, input.expectedRevision)
        if (input.action === 'setAccess') { doc.editorIds = input.editorIds; doc.approverIds = input.approverIds }
        else if (input.action === 'submit') {
          cas(doc.draftRevision, input.expectedDraftRevision)
          if (input.versionId !== doc.draft.versionId || input.bodyDigest !== doc.draft.bodyDigest) fail('TASK_MATERIAL_VERSION_CONFLICT', 'Submission must pin the current draft version and digest')
          if (doc.latestSubmission?.status === 'pending') fail('TASK_MATERIAL_REVIEW_PENDING', 'Resolve the current submission before submitting another version')
          if (this.host.get('SELECT submissionId FROM task_material_submissions WHERE documentId=? AND versionId=?', doc.documentId, input.versionId)) fail('TASK_MATERIAL_VERSION_CONFLICT', 'This fixed version was already submitted; save a revised draft')
          const submission: TeamTaskMaterialSubmission = { submissionId: randomUUID(), documentId: doc.documentId, versionId: input.versionId, bodyDigest: input.bodyDigest,
            submittedBy: ctx.principal.person.userId, submittedAt: Date.now(), status: 'pending', decidedBy: null, decidedAt: null, reason: null }
          this.host.run('INSERT INTO task_material_submissions(submissionId,documentId,versionId,metadataJson) VALUES(?,?,?,?)', submission.submissionId, doc.documentId, submission.versionId, JSON.stringify(submission))
          doc.latestSubmission = submission; versionId = submission.versionId; submissionId = submission.submissionId
        } else {
          const pending = doc.latestSubmission
          if (!pending || pending.submissionId !== input.submissionId || pending.bodyDigest !== input.bodyDigest || pending.status !== 'pending') fail('TASK_MATERIAL_REVIEW_CONFLICT', 'Review must target the current pending fixed submission')
          this.references(ctx, this.version(doc.documentId, pending.versionId).references)
          const submission: TeamTaskMaterialSubmission = { ...pending, status: input.action === 'approve' ? 'approved' : 'rejected', decidedBy: ctx.principal.person.userId, decidedAt: Date.now(), reason: input.action === 'reject' ? input.reason : null }
          this.host.run('UPDATE task_material_submissions SET metadataJson=? WHERE submissionId=?', JSON.stringify(submission), submission.submissionId)
          doc.latestSubmission = submission
          if (input.action === 'approve') doc.approved = submission
          versionId = submission.versionId; submissionId = submission.submissionId
        }
      }
      doc.revision = next(doc.revision); doc.updatedAt = Date.now()
    }
    this.persist(doc)
    // The existing workspace subscription also owns material review inbox updates.
    // This runs inside the material command transaction, including its original receipt.
    this.host.workspaceChanged(ctx.projectId)
    return teamTaskMaterialReceiptSchema.parse({ ...this.host.identity(), projectId: ctx.projectId, taskId: ctx.task.id, spaceId: ctx.space.id, taskCreatedAt: ctx.task.createdAt,
      commandId: input.commandId, action: input.action, documentId: doc.documentId, revision: doc.revision, draftRevision: doc.draftRevision,
      versionId, submissionId, outcome, actorId: ctx.principal.person.userId, deviceId: ctx.principal.deviceId, committedAt: Date.now() })
  }
}
