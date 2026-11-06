import { createHash } from 'node:crypto'
import type { SQLInputValue, SQLOutputValue } from 'node:sqlite'
import { z } from 'zod'
import {
  CREATION_MAX_RECORD_BYTES, CREATION_MAX_RESPONSE_BYTES, creationCommandSchema, creationCommandResultSchema, creationCommandReplySchema, creationListInputSchema, creationListSchema,
  creationRecordSchema, creationSummarySchema, creationViewInputSchema, creationHeadSchema,
  type CreationActorContext, type CreationCommand, type CreationCommandReply, type CreationCommandResult, type CreationRecord, type CreationSummary, type CreationView, type CreationHead
} from '../../../src/shared/creations'
import { authorizeCreationCommand, canReadCreation, CreationError, executeCreationCommand, summarizeCreation, viewCreation } from '../../../src/shared/creations-domain'
import { creationSearchScope, filterCreationSummaries, usesCreationSearch } from '../../../src/shared/creation-list-query'
import { hifoxSnapshotSchema } from '../../../src/shared/hifox-schema'
import { canReadHifoxSpace } from '../../../src/shared/hifox-domain/commands'
import { teamIdSchema, type TeamCommandReply, type TeamPage } from '../../../src/shared/team-platform'
import type { StoreActor, StorePrincipal } from './store-types'
import { TeamServiceError, requireValue } from './errors'

type Row = Record<string, SQLOutputValue>
export interface CreationsHost {
  identity(): { epoch: string; authorizationRevision: number }
  get(sql: string, ...params: SQLInputValue[]): Row | undefined
  all(sql: string, ...params: SQLInputValue[]): Row[]
  run(sql: string, ...params: SQLInputValue[]): unknown
  authenticate(actor: StoreActor): StorePrincipal
  project(principal: StorePrincipal, projectId: string): void
  mutation<T>(actor: StoreActor, commandId: string, kind: string, input: unknown, authorize: (principal: StorePrincipal) => void, apply: (principal: StorePrincipal) => T, replay?: (principal: StorePrincipal, result: T) => void): TeamCommandReply<T>
  after(principal: StorePrincipal, scope: string, cursor: string | undefined): string
  page<T>(principal: StorePrincipal, scope: string, rows: Row[], key: string, limit: number, allowed: (row: Row) => boolean, map: (row: Row) => T): TeamPage<T>
}
const text = (row: Row, key: string): string => { const value = row[key]; if (typeof value !== 'string') throw new TeamServiceError('CORRUPT_STORE', 'Invalid creation metadata', 503); return value }
const number = (row: Row, key: string): number => { const value = row[key]; if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new TeamServiceError('CORRUPT_STORE', 'Invalid creation revision', 503); return value }
const digest = (body: string): string => createHash('sha256').update(body, 'utf8').digest('hex')
function deny(): never { throw new TeamServiceError('CREATION_FORBIDDEN', 'Current person cannot access this creation scope', 403) }
const boundary = <T>(action: () => T): T => {
  try { return action() }
  catch (error) { if (error instanceof CreationError) throw new TeamServiceError(error.code, error.message, error.statusCode); throw error }
}
type Context = { actor: CreationActorContext; workspaceRevision: number }
const MAX_PROJECT_BYTES = 128 * 1024 * 1024
const MAX_PROJECT_CREATIONS = 2000

export class TeamCreations {
  constructor(private readonly host: CreationsHost) {}

  private context(principal: StorePrincipal, projectId: string): Context {
    this.host.project(principal, projectId)
    const members = this.host.all('SELECT p.userId FROM project_members pm JOIN people p ON p.userId=pm.userId JOIN projects pr ON pr.projectId=pm.projectId JOIN team_members tm ON tm.teamId=pr.teamId AND tm.userId=pm.userId WHERE pm.projectId=? AND pm.active=1 AND tm.active=1 AND p.active=1 ORDER BY p.userId LIMIT 501', projectId)
    if (members.length > 500) throw new TeamServiceError('CAPACITY_EXCEEDED', 'Creation project roster exceeds its bound', 413)
    const activeMemberIds = members.map((row) => text(row, 'userId'))
    if (!activeMemberIds.includes(principal.person.userId)) deny()
    const row = this.host.get('SELECT revision,snapshotJson FROM hifox_workspaces WHERE projectId=?', projectId)
    let snapshot: z.infer<typeof hifoxSnapshotSchema> | null = null
    try { snapshot = row ? hifoxSnapshotSchema.parse(JSON.parse(text(row, 'snapshotJson'))) : null }
    catch { throw new TeamServiceError('CORRUPT_STORE', 'Creation space authority cannot be read', 503) }
    const actorId = principal.person.userId
    return { workspaceRevision: row ? number(row, 'revision') : 0, actor: { projectId, actorId, epoch: this.host.identity().epoch, now: Date.now(), activeMemberIds,
      spaces: (snapshot?.spaces ?? []).map((entry) => ({ id: entry.id, archived: entry.archived === true, canRead: canReadHifoxSpace(entry, actorId), canWrite: canReadHifoxSpace(entry, actorId) && entry.memberIds.includes(actorId), memberIds: entry.memberIds.filter((id) => activeMemberIds.includes(id)) })),
      tasks: (snapshot?.tasks ?? []).map((entry) => ({ id: entry.id, spaceId: entry.spaceId })), digestBody: digest } }
  }

  private load(projectId: string, creationId: string): CreationRecord | null {
    const row = this.host.get('SELECT projectId,ownerId,revision,recordJson,byteLength FROM creations WHERE creationId=?', creationId)
    if (!row) return null
    if (text(row, 'projectId') !== projectId) deny()
    try {
      const json = text(row, 'recordJson')
      if (Buffer.byteLength(json) > CREATION_MAX_RECORD_BYTES || Buffer.byteLength(json) !== number(row, 'byteLength')) throw Error('Invalid record bound')
      const record = creationRecordSchema.parse(JSON.parse(json))
      if (record.creationId !== creationId || record.projectId !== projectId || record.ownerId !== text(row, 'ownerId') || record.revision !== number(row, 'revision')) throw Error('Invalid record identity')
      const bodies = [record.draft, ...record.revisions, ...(record.candidate ? [record.candidate] : [])]
      if (bodies.some((entry) => digest(entry.body) !== entry.bodyDigest)) throw Error('Invalid body digest')
      return record
    } catch { throw new TeamServiceError('CORRUPT_STORE', 'Stored creation failed validation or body digest verification', 503) }
  }

  private persist(record: CreationRecord, ctx: CreationActorContext): void {
    const json = JSON.stringify(record), byteLength = Buffer.byteLength(json)
    const current = this.host.get('SELECT byteLength FROM creations WHERE creationId=?', record.creationId)
    const usage = requireValue(this.host.get('SELECT COUNT(*) AS count,COALESCE(SUM(byteLength),0) AS bytes FROM creations WHERE projectId=?', record.projectId), 'CORRUPT_STORE', 'Creation quota unavailable', 503)
    if (byteLength > CREATION_MAX_RECORD_BYTES || number(usage, 'bytes') - (current ? number(current, 'byteLength') : 0) + byteLength > MAX_PROJECT_BYTES || (!current && number(usage, 'count') >= MAX_PROJECT_CREATIONS)) throw new TeamServiceError('CAPACITY_EXCEEDED', 'Creation storage quota is full; existing history was retained', 413)
    const summary = summarizeCreation(record, ctx, { includeRules: true })
    // Cached list data contains no bodies, comments, private notes or draft/candidate metadata.
    const publicSummary = { ...summary, title: summary.latestPublished?.title ?? record.title, canEdit: false, canReview: false, canManageReview: false }
    const summaryJson = JSON.stringify(publicSummary)
    if (Buffer.byteLength(summaryJson) > 192 * 1024) throw new TeamServiceError('CAPACITY_EXCEEDED', 'Creation adoption summary exceeds its bounded budget', 413)
    this.host.run('INSERT INTO creations(creationId,projectId,ownerId,home,spaceId,title,editorIdsJson,revision,published,summaryJson,recordJson,byteLength,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(creationId) DO UPDATE SET spaceId=excluded.spaceId,title=excluded.title,editorIdsJson=excluded.editorIdsJson,revision=excluded.revision,published=excluded.published,summaryJson=excluded.summaryJson,recordJson=excluded.recordJson,byteLength=excluded.byteLength,updatedAt=excluded.updatedAt',
      record.creationId, record.projectId, record.ownerId, record.home, record.spaceId, record.title, JSON.stringify(record.editorIds), record.revision, record.revisions.length ? 1 : 0, summaryJson, json, byteLength, record.createdAt, record.updatedAt)
    for (const taskId of new Set(record.adoptions.map((entry) => entry.taskId))) this.host.run('INSERT INTO creation_task_references(creationId,projectId,taskId) VALUES(?,?,?) ON CONFLICT(creationId,taskId) DO NOTHING', record.creationId, record.projectId, taskId)
  }

  private access(metadata: { ownerId: string; home: CreationRecord['home']; spaceId: string | null; editors: string[]; published: boolean }, ctx: CreationActorContext): { visible: boolean; isOwner: boolean; canDraft: boolean; writable: boolean; isEditor: boolean } {
    const isOwner = metadata.ownerId === ctx.actorId, isEditor = isOwner || metadata.editors.includes(ctx.actorId)
    const canDraft = isOwner || (metadata.home === 'team' && isEditor)
    const grant = metadata.spaceId ? ctx.spaces.find((entry) => entry.id === metadata.spaceId && entry.canRead) : null
    return { visible: (!metadata.spaceId || Boolean(grant)) && (canDraft || metadata.published), isOwner, isEditor, canDraft, writable: !metadata.spaceId || (grant?.canWrite === true && !grant.archived) }
  }

  private listing(row: Row, ctx: CreationActorContext, taskId?: string): CreationSummary | null {
    let result: CreationSummary, editors: string[]
    try { result = creationSummarySchema.parse(JSON.parse(text(row, 'summaryJson'))); editors = z.array(z.string()).max(32).parse(JSON.parse(text(row, 'editorIdsJson'))) }
    catch { throw new TeamServiceError('CORRUPT_STORE', 'Stored creation list metadata is invalid', 503) }
    const { visible, canDraft, writable, isEditor } = this.access({ ...result, editors, published: Boolean(result.latestPublished) }, ctx)
    if (!visible) return null
    return { ...result, adoptions: result.adoptions.filter((entry) => !taskId || entry.taskId === taskId).map((entry) => taskId ? entry : { ...entry, confirmedRules: [] }), title: canDraft ? text(row, 'title') : result.title, canEdit: canDraft && writable, canManageReview: isEditor && writable,
      canReview: writable && (isEditor || result.latestPublished?.reviewerIds.includes(ctx.actorId) === true) }
  }

  /** Change detection reads only ACL/index metadata; neither recordJson nor summary rule bodies are selected. */
  head(principal: StorePrincipal, raw: Record<string, unknown>): CreationHead {
    const projectId = teamIdSchema.parse(raw.projectId), { actor: ctx } = this.context(principal, projectId)
    const identity = this.host.identity()
    const rows = this.host.all('SELECT creationId,revision,ownerId,home,spaceId,editorIdsJson,published FROM creations WHERE projectId=? ORDER BY creationId LIMIT ?', projectId, MAX_PROJECT_CREATIONS + 1)
    if (rows.length > MAX_PROJECT_CREATIONS) throw new TeamServiceError('CAPACITY_EXCEEDED', 'Creation head exceeds its bounded project capacity', 413)
    const revisions: Array<[string, number]> = []
    for (const row of rows) {
      let home: CreationRecord['home'], editors: string[]
      try { home = z.enum(['personal', 'team']).parse(row.home); editors = z.array(z.string()).max(32).parse(JSON.parse(text(row, 'editorIdsJson'))) }
      catch { throw new TeamServiceError('CORRUPT_STORE', 'Stored creation head metadata is invalid', 503) }
      if (this.access({ ownerId: text(row, 'ownerId'), home, spaceId: row.spaceId === null ? null : text(row, 'spaceId'), editors, published: number(row, 'published') === 1 }, ctx).visible) revisions.push([text(row, 'creationId'), number(row, 'revision')])
    }
    return creationHeadSchema.parse({ projectId, epoch: identity.epoch, fingerprint: digest(JSON.stringify({ projectId, actorId: ctx.actorId, epoch: identity.epoch, authorizationRevision: identity.authorizationRevision, revisions })) })
  }

  list(principal: StorePrincipal, raw: Record<string, unknown>): z.infer<typeof creationListSchema> {
    const projectId = teamIdSchema.parse(raw.projectId), query = creationListInputSchema.parse(raw.query ?? {})
    const { actor: ctx, workspaceRevision } = this.context(principal, projectId)
    if (query.spaceId && !ctx.spaces.some((entry) => entry.id === query.spaceId && entry.canRead)) deny()
    if (query.taskId) {
      const task = ctx.tasks.find((entry) => entry.id === query.taskId)
      if (!task || !ctx.spaces.some((entry) => entry.id === task.spaceId && entry.canRead) || (query.spaceId && task.spaceId !== query.spaceId)) deny()
    }
    if (usesCreationSearch(query)) {
      const conditions = ['c.projectId=?'], params: SQLInputValue[] = [projectId]
      if (query.scope === 'personal') { conditions.push("c.home='personal' AND c.ownerId=?"); params.push(ctx.actorId) }
      else conditions.push('c.spaceId IS NOT NULL')
      if (query.spaceId) { conditions.push('c.spaceId=?'); params.push(query.spaceId) }
      if (query.taskId) { conditions.push('EXISTS(SELECT 1 FROM creation_task_references r WHERE r.creationId=c.creationId AND r.projectId=c.projectId AND r.taskId=?)'); params.push(query.taskId) }
      const rows = this.host.all(`SELECT c.creationId,c.summaryJson,c.title,c.editorIdsJson FROM creations c WHERE ${conditions.join(' AND ')} ORDER BY c.creationId LIMIT ?`, ...params, MAX_PROJECT_CREATIONS + 1)
      if (rows.length > MAX_PROJECT_CREATIONS) throw new TeamServiceError('CAPACITY_EXCEEDED', 'Creation search exceeds its bounded project capacity', 413)
      const visible = rows.map((row) => this.listing(row, ctx, query.taskId)).filter((item): item is CreationSummary => item !== null)
      const items = filterCreationSummaries(visible, query)
      const scope = JSON.stringify(['creation-search-v1', projectId, workspaceRevision, digest(creationSearchScope(query, items))])
      const after = this.host.after(principal, scope, query.cursor)
      const index = after ? items.findIndex((item) => item.creationId === after) : -1
      if (after && index < 0) throw new TeamServiceError('CURSOR_CONFLICT', 'Creation list changed; reload the first page', 409)
      const remaining = items.slice(index + 1)
      const byId = new Map(remaining.map((item) => [item.creationId, item]))
      const pageRows: Row[] = remaining.map((item) => ({ creationId: item.creationId }))
      const value = creationListSchema.parse(this.host.page(principal, scope, pageRows, 'creationId', query.limit, () => true,
        (row) => requireValue(byId.get(text(row, 'creationId')), 'CORRUPT_STORE', 'Creation projection missing', 503)))
      if (Buffer.byteLength(JSON.stringify(value)) > CREATION_MAX_RESPONSE_BYTES - 16384) throw new TeamServiceError('CAPACITY_EXCEEDED', 'Creation list exceeds its bounded response; request a smaller page', 413)
      return value
    }
    const scope = JSON.stringify(['creations', projectId, query.scope, query.spaceId ?? null, query.taskId ?? null, workspaceRevision])
    const after = this.host.after(principal, scope, query.cursor)
    const conditions = ['c.projectId=?', 'c.creationId>?'], params: SQLInputValue[] = [projectId, after]
    if (query.scope === 'personal') { conditions.push("c.home='personal' AND c.ownerId=?"); params.push(ctx.actorId) }
    else conditions.push('c.spaceId IS NOT NULL')
    if (query.spaceId) { conditions.push('c.spaceId=?'); params.push(query.spaceId) }
    if (query.taskId) { conditions.push('EXISTS(SELECT 1 FROM creation_task_references r WHERE r.creationId=c.creationId AND r.projectId=c.projectId AND r.taskId=?)'); params.push(query.taskId) }
    const rows = this.host.all(`SELECT c.creationId,c.summaryJson,c.title,c.editorIdsJson FROM creations c WHERE ${conditions.join(' AND ')} ORDER BY c.creationId LIMIT 501`, ...params)
    const projected = new Map<Row, CreationSummary | null>(rows.map((row) => [row, this.listing(row, ctx, query.taskId)]))
    const value = creationListSchema.parse(this.host.page(principal, scope, rows, 'creationId', query.limit, (row) => Boolean(projected.get(row)), (row) => requireValue(projected.get(row), 'CORRUPT_STORE', 'Creation projection missing', 503)))
    if (Buffer.byteLength(JSON.stringify(value)) > CREATION_MAX_RESPONSE_BYTES - 16384) throw new TeamServiceError('CAPACITY_EXCEEDED', 'Creation list exceeds its bounded response; request a smaller page', 413)
    return value
  }

  get(principal: StorePrincipal, raw: Record<string, unknown>): CreationView {
    return boundary(() => {
      const projectId = teamIdSchema.parse(raw.projectId), creationId = teamIdSchema.parse(raw.creationId)
      const { actor: ctx } = this.context(principal, projectId)
      const record = requireValue(this.load(projectId, creationId), 'CREATION_NOT_FOUND', 'Creation is unavailable')
      return viewCreation(record, ctx, creationViewInputSchema.parse(raw.query ?? {}))
    })
  }

  /** GET /api/commands reauthorizes every original space, task and participant before returning metadata. */
  authorizeReceipt(principal: StorePrincipal, raw: unknown): CreationCommandResult {
    const result = creationCommandResultSchema.parse(raw), { actor: ctx } = this.context(principal, result.projectId)
    if (result.epoch !== undefined && result.epoch !== ctx.epoch) throw new TeamServiceError('EPOCH_CONFLICT', 'Creation receipt belongs to another service generation', 409)
    const record = requireValue(this.load(result.projectId, result.creationId), 'CREATION_NOT_FOUND', 'Creation is unavailable')
    if (!canReadCreation(record, ctx)) deny()
    const isOwner = record.ownerId === ctx.actorId, isEditor = isOwner || record.editorIds.includes(ctx.actorId), canDraft = isOwner || (record.home === 'team' && isEditor)
    for (const spaceId of new Set([...result.scopeSpaceIds, ...(record.spaceId ? [record.spaceId] : [])])) {
      const grant = ctx.spaces.find((entry) => entry.id === spaceId)
      if (!grant?.canRead || !grant.canWrite || grant.archived) deny()
      if (result.scopePersonIds.some((id) => !ctx.activeMemberIds.includes(id) || !grant.memberIds.includes(id))) deny()
    }
    for (const taskId of result.scopeTaskIds) {
      const task = ctx.tasks.find((entry) => entry.id === taskId)
      if (!task || task.spaceId !== record.spaceId || !result.scopeSpaceIds.includes(task.spaceId)) deny()
    }
    if (result.private && !canDraft) deny()
    if (result.action === 'create' && !isOwner) deny()
    if (['saveDraft', 'candidateSave', 'candidateAdopt', 'candidateDiscard', 'publish'].includes(result.action) && !canDraft) deny()
    if (result.action === 'adoptForTask' && !isEditor) deny()
    if (result.action === 'disposition' && !isEditor) {
      const opinion = record.comments.find((entry) => entry.commentId === result.commentId)
      const revision = record.revisions.find((entry) => entry.revisionId === (result.reviewRevisionId ?? result.revisionId))
      if (!opinion || opinion.private || opinion.authorId !== ctx.actorId || !revision?.reviewerIds.includes(ctx.actorId)) deny()
    }
    if (['annotate', 'reply'].includes(result.action) && !result.private) {
      const revision = record.revisions.find((entry) => entry.revisionId === result.revisionId)
      if (!revision || (!isEditor && !revision.reviewerIds.includes(ctx.actorId))) deny()
    }
    return result
  }

  command(actor: StoreActor, raw: Record<string, unknown>): CreationCommandReply {
    return boundary(() => {
      const projectId = teamIdSchema.parse(raw.projectId), command = creationCommandSchema.parse(raw.body)
      const reply = this.host.mutation(actor, command.commandId, 'creationCommand', { projectId, ...command },
        (principal) => { const { actor: ctx } = this.context(principal, projectId); authorizeCreationCommand(this.load(projectId, command.creationId), command, ctx) },
        (principal) => {
          const { actor: ctx } = this.context(principal, projectId)
          const record = executeCreationCommand(this.load(projectId, command.creationId), command, ctx)
          this.persist(record, ctx)
          return this.receipt(record, command)
        }, (principal, result) => { this.authorizeReceipt(principal, result) })
      if (Buffer.byteLength(JSON.stringify(reply)) > CREATION_MAX_RESPONSE_BYTES - 16384) throw new TeamServiceError('CAPACITY_EXCEEDED', 'Creation receipt exceeds its bounded response', 413)
      return creationCommandReplySchema.parse(reply)
    })
  }

  private receipt(record: CreationRecord, command: CreationCommand): CreationCommandResult {
    const opinion = command.action === 'annotate' ? record.comments.find((entry) => entry.commentId === command.commandId)
      : command.action === 'reply' || command.action === 'disposition' ? record.comments.find((entry) => entry.commentId === command.commentId) : undefined
    return creationCommandResultSchema.parse({ projectId: record.projectId, creationId: record.creationId, epoch: this.host.identity().epoch, revision: record.revision, action: command.action,
      scopeSpaceIds: record.spaceId ? [record.spaceId] : [], scopeTaskIds: command.action === 'adoptForTask' ? [command.taskId] : [],
      scopePersonIds: command.action === 'publish' ? [...new Set([...command.reviewerIds, ...record.editorIds])] : command.action === 'create' ? record.editorIds : [],
      private: ['create', 'saveDraft', 'candidateSave', 'candidateAdopt', 'candidateDiscard'].includes(command.action) || opinion?.private === true,
      ...(command.action === 'publish' || command.action === 'adoptForTask' ? { revisionId: command.action === 'publish' ? command.commandId : command.revisionId } : opinion ? { revisionId: opinion.revisionId, commentId: opinion.commentId } : {}),
      ...(command.action === 'disposition' && opinion && !opinion.private ? { reviewRevisionId: command.reviewRevisionId ?? opinion.revisionId } : {}),
      ...(command.action === 'candidateSave' ? { candidateId: command.commandId } : {}), ...(command.action === 'adoptForTask' ? { adoptionId: command.commandId } : {}) })
  }
}
