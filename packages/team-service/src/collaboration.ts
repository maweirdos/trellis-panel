import { createHash } from 'node:crypto'
import type { SQLInputValue, SQLOutputValue } from 'node:sqlite'
import { z } from 'zod'
import {
  collaborationCommandSchema, collaborationRecordSchema, collaborationDataSchema, collaborationListInputSchema,
  collaborationActorSchema, collaborationHistorySchema, collaborationReplySchema, collaborationExecutionReportSchema,
  collaborationReanchorSchema, collaborationDispositionSchema, type CollaborationRecord, type CollaborationActor, type CollaborationVersionRef,
  type CollaborationCommand, type CollaborationView
} from '../../../src/shared/team-collaboration'
import { teamIdSchema, teamPageInputSchema, type TeamCommandReply, type TeamPage, type TeamVisibility } from '../../../src/shared/team-platform'
import type { StoreActor, StorePrincipal } from './store-types'
import { TeamServiceError, requireValue } from './errors'

type Row = Record<string, SQLOutputValue>
type Version = { materialId: string; version: number; bodyDigest: string; projectId: string; teamId: string; ownerId: string; visibility: TeamVisibility }
/** All capabilities are bound to the existing writer; this module owns no identity or transaction. */
export interface CollaborationHost {
  get(sql: string, ...params: SQLInputValue[]): Row | undefined
  all(sql: string, ...params: SQLInputValue[]): Row[]
  run(sql: string, ...params: SQLInputValue[]): unknown
  version(principal: StorePrincipal, materialId: string, version: number): Version
  body(digest: string): string
  project(principal: StorePrincipal, projectId: string): void
  member(userId: string, projectId: string): string[] | null
  principalFor(userId: string): StorePrincipal
  mutation(actor: StoreActor, commandId: string, kind: string, input: unknown, authorize: (p: StorePrincipal) => void, apply: (p: StorePrincipal) => CollaborationRecord, replay: (p: StorePrincipal, record: CollaborationRecord) => void): TeamCommandReply<CollaborationRecord>
  event(type: string, visibility: TeamVisibility, audienceId: string, projectId: string, payload: Record<string, unknown>): void
  after(principal: StorePrincipal, scope: string, cursor?: string, initial?: string): string
  page<T>(principal: StorePrincipal, scope: string, rows: Row[], key: string, limit: number, allowed: (row: Row) => boolean, map: (row: Row) => T): TeamPage<T>
}
const denied = (): never => { throw new TeamServiceError('FORBIDDEN', 'Current account or device is not authorized for this collaboration record', 403) }
const conflict = (message: string): never => { throw new TeamServiceError('REVISION_CONFLICT', message, 409) }
const text = (row: Row, key: string): string => { const v = row[key]; if (typeof v !== 'string') throw new TeamServiceError('CORRUPT_STORE', 'Invalid collaboration text', 503); return v }
const number = (row: Row, key: string): number => { const v = row[key]; if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new TeamServiceError('CORRUPT_STORE', 'Invalid collaboration integer', 503); return v }
const parseJson = (row: Row, key: string): unknown => JSON.parse(text(row, key))
/** Canonical manifest binds the selected versions, timing, assignee and aggregate identity. */
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}'
  return JSON.stringify(value)
}

export class TeamCollaboration {
  constructor(private readonly host: CollaborationHost) {}
  private row(entityId: string): Row { return requireValue(this.host.get('SELECT * FROM collaboration WHERE entityId=?', entityId), 'NOT_FOUND', 'Collaboration record unavailable') }
  private record(row: Row): CollaborationRecord {
    return collaborationRecordSchema.parse({ entityId: text(row, 'entityId'), materialId: text(row, 'materialId'), version: number(row, 'version'), projectId: text(row, 'projectId'), creatorId: text(row, 'creatorId'), revision: number(row, 'revision'), createdAt: number(row, 'createdAt'), updatedAt: number(row, 'updatedAt'), data: parseJson(row, 'dataJson') })
  }
  /** Intersection includes historical/result versions. It never falls back to project/admin access. */
  authorize(principal: StorePrincipal, entityId: string): void {
    const row = this.row(entityId); this.host.project(principal, text(row, 'projectId'))
    const scope = this.host.all('SELECT materialId,version FROM collaboration_scope WHERE entityId=?', entityId)
    if (!scope.length) throw new TeamServiceError('CORRUPT_STORE', 'Collaboration scope is missing', 503)
    for (const item of scope) this.host.version(principal, text(item, 'materialId'), number(item, 'version'))
  }
  canRead(principal: StorePrincipal, entityId: string): boolean {
    try { this.authorize(principal, entityId); return true }
    catch (error) { if (error instanceof TeamServiceError && ['FORBIDDEN', 'NOT_FOUND'].includes(error.code)) return false; throw error }
  }
  private actor(p: StorePrincipal, projectId: string): CollaborationActor {
    return collaborationActorSchema.parse({ userId: p.person.userId, displayName: p.person.displayName, roles: this.host.member(p.person.userId, projectId) ?? [], authentication: p.actor.kind, deviceId: p.deviceId, recordedAt: Date.now() })
  }
  private version(p: StorePrincipal, projectId: string, ref: CollaborationVersionRef): Version {
    const v = this.host.version(p, ref.materialId, ref.version)
    if (v.projectId !== projectId || v.bodyDigest !== ref.bodyDigest) throw new TeamServiceError('VERSION_CONFLICT', 'Selected version/digest/project does not match the immutable source', 409)
    return v
  }
  private member(userId: string, projectId: string, roles?: string[]): void {
    const actual = this.host.member(userId, projectId)
    if (!actual || (roles && !actual.some((role) => roles.includes(role)))) denied()
  }
  private reader(userId: string, materialId: string, version: number, projectId: string): void {
    this.member(userId, projectId); this.host.version(this.host.principalFor(userId), materialId, version)
  }
  private owner(p: StorePrincipal, record: CollaborationRecord, extra?: string[]): void {
    if (p.person.userId !== record.creatorId && !extra?.includes(p.person.userId)) denied()
  }
  private human(p: StorePrincipal): void { if (p.actor.kind !== 'session') throw new TeamServiceError('HUMAN_SESSION_REQUIRED', 'Confirm this business fact through the authenticated browser', 403) }
  private view(record: CollaborationRecord): CollaborationView {
    const serverTime = Date.now()
    return { ...record, serverTime, overdue: record.data.kind === 'decision' && record.data.state === 'open' && record.data.dueAt < serverTime, blocksDevelopment: false, nativeVerification: 'not-verified' }
  }
  read(operation: string, p: StorePrincipal, raw: Record<string, unknown>): unknown {
    if (operation === 'collaborationList') {
      const input = collaborationListInputSchema.parse(raw.query); this.host.project(p, input.projectId)
      const scope = `collaboration:${input.projectId}:${input.kind ?? '*'}`; const after = this.host.after(p, scope, input.cursor)
      return this.host.page(p, scope, this.host.all('SELECT * FROM collaboration WHERE projectId=? AND entityId>? ORDER BY entityId LIMIT 501', input.projectId, after), 'entityId', input.limit, (row) => (!input.kind || row.kind === input.kind) && this.canRead(p, text(row, 'entityId')), (row) => this.view(this.record(row)))
    }
    if (operation === 'collaborationReanchor') return this.reanchor(p, raw)
    const entityId = teamIdSchema.parse(raw.entityId); this.authorize(p, entityId)
    if (operation === 'collaborationGet') return this.view(this.record(this.row(entityId)))
    const input = teamPageInputSchema.parse(raw.query ?? {}); const scope = `${operation}:${entityId}`
    if (operation === 'collaborationHistory') {
      const after = z.coerce.number().int().nonnegative().parse(this.host.after(p, scope, input.cursor, '0'))
      return this.host.page(p, scope, this.host.all('SELECT * FROM collaboration_history WHERE entityId=? AND revision>? ORDER BY revision LIMIT 501', entityId, after), 'revision', input.limit, () => true, (row) => collaborationHistorySchema.parse({ revision: number(row, 'revision'), action: text(row, 'action'), actor: parseJson(row, 'actorJson'), record: parseJson(row, 'recordJson') }))
    }
    const after = this.host.after(p, scope, input.cursor)
    if (operation === 'collaborationReplies') return this.host.page(p, scope, this.host.all('SELECT * FROM collaboration_replies WHERE entityId=? AND replyId>? ORDER BY replyId LIMIT 501', entityId, after), 'replyId', input.limit, () => true, (row) => collaborationReplySchema.parse({ replyId: text(row, 'replyId'), entityId, parentReplyId: row.parentReplyId, body: text(row, 'body'), actor: parseJson(row, 'actorJson'), createdAt: number(row, 'createdAt') }))
    if (operation === 'collaborationReports') return this.host.page(p, scope, this.host.all('SELECT * FROM collaboration_reports WHERE entityId=? AND reportId>? ORDER BY reportId LIMIT 501', entityId, after), 'reportId', input.limit, () => true, (row) => collaborationExecutionReportSchema.parse(parseJson(row, 'reportJson')))
    if (operation === 'collaborationDispositions') return this.host.page(p, scope, this.host.all('SELECT * FROM collaboration_dispositions WHERE entityId=? AND dispositionId>? ORDER BY dispositionId LIMIT 501', entityId, after), 'dispositionId', input.limit, () => true, (row) => collaborationDispositionSchema.parse(parseJson(row, 'dispositionJson')))
    throw new TeamServiceError('INVALID_INPUT', 'Unsupported collaboration read')
  }
  private reanchor(p: StorePrincipal, raw: Record<string, unknown>): unknown {
    const feedbackId = teamIdSchema.parse(raw.feedbackId); const input = z.object({ version: z.coerce.number().int().positive() }).strict().parse(raw.query)
    const f = requireValue(this.host.get('SELECT * FROM feedback WHERE feedbackId=?', feedbackId), 'NOT_FOUND', 'Feedback unavailable')
    const original = this.host.version(p, text(f, 'materialId'), number(f, 'version')); const target = this.host.version(p, original.materialId, input.version)
    const quote = f.quote === null ? null : text(f, 'quote'); const candidates: { start: number; end: number }[] = []; let truncated = false
    if (quote) {
      const body = this.host.body(target.bodyDigest); let from = 0
      while (from <= body.length) { const at = body.indexOf(quote, from); if (at < 0) break; if (candidates.length === 20) { truncated = true; break }; candidates.push({ start: at, end: at + quote.length }); from = at + 1 }
    }
    return collaborationReanchorSchema.parse({ feedbackId, original: { materialId: original.materialId, version: original.version, bodyDigest: original.bodyDigest }, target: { materialId: target.materialId, version: target.version, bodyDigest: target.bodyDigest }, quote, state: !quote ? 'unquoted' : !candidates.length ? 'missing' : candidates.length === 1 && !truncated ? 'unique' : 'ambiguous', candidates, truncated, automaticallyApplied: false })
  }
  command(actor: StoreActor, raw: unknown): TeamCommandReply<CollaborationRecord> {
    const input = collaborationCommandSchema.parse(raw)
    return this.host.mutation(actor, input.commandId, 'collaborationCommand', input, (p) => {
      if (input.expectedRevision === null) { const v = this.host.version(p, input.materialId, input.version); this.host.project(p, v.projectId) }
      else this.authorize(p, input.entityId)
    }, (p) => this.apply(p, input), (p, record) => this.authorize(p, record.entityId))
  }
  private apply(p: StorePrincipal, input: CollaborationCommand): CollaborationRecord {
    const created = input.expectedRevision === null; const at = Date.now()
    let record: CollaborationRecord; const refs: CollaborationVersionRef[] = []
    if (created) {
      if (this.host.get('SELECT entityId FROM collaboration WHERE entityId=?', input.entityId)) conflict('Collaboration identity already exists')
      const v = this.host.version(p, input.materialId, input.version); refs.push({ materialId: v.materialId, version: v.version, bodyDigest: v.bodyDigest })
      const base = { entityId: input.entityId, materialId: input.materialId, version: input.version, projectId: v.projectId, creatorId: p.person.userId, revision: 1, createdAt: at, updatedAt: at }
      if (input.action === 'discussion.create') {
        const f = requireValue(this.host.get('SELECT * FROM feedback WHERE feedbackId=?', input.feedbackId), 'NOT_FOUND', 'Feedback unavailable')
        if (f.materialId !== v.materialId || f.version !== v.version) conflict('Discussion must retain the original feedback version')
        record = { ...base, data: { kind: 'discussion', feedbackId: input.feedbackId, replyCount: 0, relocations: [] } }
      } else if (input.action === 'notice.create') {
        for (const user of input.recipientIds) this.reader(user, v.materialId, v.version, v.projectId)
        record = { ...base, data: { kind: 'notice', recipientIds: input.recipientIds, message: input.message, acknowledgements: [], cancelled: false, cancellationReason: null } }
      } else if (input.action === 'decision.create') {
        this.reader(input.ownerId, v.materialId, v.version, v.projectId)
        for (const user of input.coordinatorIds) { this.reader(user, v.materialId, v.version, v.projectId); this.member(user, v.projectId, ['pm', 'admin']) }
        if (new Set(input.options.map((o) => o.optionId)).size !== input.options.length || (input.recommendation !== null && !input.options.some((o) => o.optionId === input.recommendation))) conflict('Decision options/recommendation are inconsistent')
        record = { ...base, data: { kind: 'decision', question: input.question, options: input.options, recommendation: input.recommendation, ownerId: input.ownerId, coordinatorIds: input.coordinatorIds, impact: input.impact, dueAt: input.dueAt, state: 'open', answer: null, coordinationNote: null } }
      } else {
        this.reader(input.assigneeId, v.materialId, v.version, v.projectId); this.member(input.assigneeId, v.projectId, ['developer', 'admin'])
        if (new Set(input.selections.map((s) => s.feedbackId)).size !== input.selections.length) conflict('Batch repeats a feedback identity')
        if (!input.selections.some((s) => s.materialId === v.materialId && s.version === v.version)) conflict('Batch primary version must be one of its selected feedback versions')
        for (const selection of input.selections) {
          const f = requireValue(this.host.get('SELECT * FROM feedback WHERE feedbackId=?', selection.feedbackId), 'NOT_FOUND', 'Selected feedback unavailable')
          if (f.materialId !== selection.materialId || f.version !== selection.version) conflict('Feedback version changed in the selected manifest')
        }
        refs.push(...input.selections, ...input.baselines)
        for (const ref of refs) { this.version(p, v.projectId, ref); this.reader(input.assigneeId, ref.materialId, ref.version, v.projectId) }
        const manifestDigest = createHash('sha256').update(canonical({ entityId: input.entityId, materialId: input.materialId, version: input.version, assigneeId: input.assigneeId, timing: input.timing, selections: input.selections, baselines: input.baselines })).digest('hex')
        record = { ...base, data: { kind: 'batch', selections: input.selections, baselines: input.baselines, assigneeId: input.assigneeId, timing: input.timing, rationale: input.rationale, manifestDigest, state: 'planned', reportCount: 0, resolution: null, lastReason: null } }
      }
    } else {
      record = this.record(this.row(input.entityId)); if (record.revision !== input.expectedRevision) conflict('Collaboration changed; reload before updating')
      const data = record.data; const actorSnapshot = this.actor(p, record.projectId)
      if (input.action === 'discussion.reply' && data.kind === 'discussion') {
        if (input.parentReplyId && !this.host.get('SELECT replyId FROM collaboration_replies WHERE replyId=? AND entityId=?', input.parentReplyId, record.entityId)) conflict('Reply parent belongs to another discussion or is unavailable')
        if (this.host.get('SELECT replyId FROM collaboration_replies WHERE replyId=?', input.replyId)) conflict('Reply identity already exists')
        this.host.run('INSERT INTO collaboration_replies(replyId,entityId,parentReplyId,body,actorJson,createdAt) VALUES(?,?,?,?,?,?)', input.replyId, record.entityId, input.parentReplyId, input.body, JSON.stringify(actorSnapshot), at); data.replyCount++
      } else if (input.action === 'discussion.relocate' && data.kind === 'discussion') {
        const f = requireValue(this.host.get('SELECT authorId FROM feedback WHERE feedbackId=?', data.feedbackId), 'NOT_FOUND', 'Feedback unavailable'); this.owner(p, record, [text(f, 'authorId')])
        if (input.target.materialId !== record.materialId || data.relocations.length >= 50) conflict('Relocation must retain the same material and bounded history')
        this.version(p, record.projectId, input.target); const body = this.host.body(input.target.bodyDigest)
        if (input.anchor.end > body.length || body.slice(input.anchor.start, input.anchor.end) !== input.quote) throw new TeamServiceError('ANCHOR_CONFLICT', 'Explicit relocation does not match raw-source UTF16 range', 409)
        refs.push(input.target); data.relocations.push({ target: input.target, quote: input.quote, anchor: input.anchor, reason: input.reason, actor: actorSnapshot })
      } else if (input.action === 'notice.acknowledge' && data.kind === 'notice') {
        if (!data.recipientIds.includes(p.person.userId) || data.cancelled) denied()
        if (data.acknowledgements.some((a) => a.userId === p.person.userId)) conflict('Recipient already acknowledged this notice')
        data.acknowledgements.push({ userId: p.person.userId, at })
      } else if (input.action === 'notice.cancel' && data.kind === 'notice') {
        this.owner(p, record); if (data.cancelled) conflict('Notice already cancelled'); data.cancelled = true; data.cancellationReason = input.reason
      } else if (input.action === 'decision.answer' && data.kind === 'decision') {
        this.human(p); if (data.ownerId !== p.person.userId) denied(); if (data.state !== 'open' || !data.options.some((o) => o.optionId === input.optionId)) conflict('Decision is answered or option does not exist')
        data.answer = { optionId: input.optionId, rationale: input.rationale, actor: actorSnapshot }; data.state = 'answered'
      } else if (input.action === 'decision.coordinate' && data.kind === 'decision') {
        this.human(p); if (p.person.userId !== data.ownerId && !data.coordinatorIds.includes(p.person.userId)) denied()
        if (p.person.userId !== data.ownerId) this.member(p.person.userId, record.projectId, ['pm', 'admin'])
        this.reader(input.ownerId, record.materialId, record.version, record.projectId)
        for (const user of input.coordinatorIds) { this.reader(user, record.materialId, record.version, record.projectId); this.member(user, record.projectId, ['pm', 'admin']) }
        data.ownerId = input.ownerId; data.coordinatorIds = input.coordinatorIds; data.dueAt = input.dueAt; data.coordinationNote = input.note
        if (input.reopen) { data.state = 'open'; data.answer = null }
      } else if (input.action === 'batch.report' && data.kind === 'batch') {
        this.owner(p, record, [data.assigneeId]); if (p.actor.kind === 'device' && p.person.userId !== data.assigneeId) denied()
        if (data.state === 'resolved' || data.state === 'cancelled') conflict('Reopen the batch before adding reports')
        if (input.report.manifestDigest !== data.manifestDigest) conflict('Execution report refers to another manifest')
        if (this.host.get('SELECT reportId FROM collaboration_reports WHERE reportId=?', input.report.reportId)) conflict('Report identity already exists')
        for (const output of input.report.outputs) { this.version(p, record.projectId, output); refs.push(output) }
        const report = collaborationExecutionReportSchema.parse({ ...input.report, entityId: record.entityId, actor: actorSnapshot, createdAt: at, trust: p.actor.kind === 'device' ? 'device-reported' : 'browser-reported', nativeVerification: 'not-verified' })
        this.host.run('INSERT INTO collaboration_reports(reportId,entityId,reportJson,createdAt) VALUES(?,?,?,?)', report.reportId, record.entityId, JSON.stringify(report), at)
        data.reportCount++; if (report.phase === 'verification') data.state = 'awaiting-confirmation'
      } else if (input.action === 'batch.resolve' && data.kind === 'batch') {
        this.human(p); this.owner(p, record, [data.assigneeId]); if (data.state !== 'awaiting-confirmation') conflict('A verification report must precede responsible confirmation')
        const reportRow = requireValue(this.host.get('SELECT reportJson FROM collaboration_reports WHERE entityId=? AND reportId=?', record.entityId, input.verificationReportId), 'NOT_FOUND', 'Verification report unavailable')
        const report = collaborationExecutionReportSchema.parse(parseJson(reportRow, 'reportJson'))
        if (report.phase !== 'verification' || !report.outputs.length || !report.checks.length || report.checks.some((c) => c.result !== 'passed')) conflict('Resolution needs exact published outputs and passed checks; failed/not-run reports are not sufficient')
        data.state = 'resolved'; data.resolution = { verificationReportId: report.reportId, rationale: input.rationale, actor: actorSnapshot, evidenceClassification: 'human-confirmed' }
      } else if (input.action === 'batch.reopen' && data.kind === 'batch') {
        this.human(p); this.owner(p, record, [data.assigneeId]); if (data.state !== 'resolved') conflict('Only a resolved batch can be reopened'); data.state = 'planned'; data.resolution = null; data.lastReason = input.reason
      } else if (input.action === 'batch.cancel' && data.kind === 'batch') {
        this.owner(p, record, [data.assigneeId]); if (data.state !== 'planned' || data.reportCount !== 0) conflict('Only a batch with no dispatched report can be cancelled'); data.state = 'cancelled'; data.lastReason = input.reason
      } else if (input.action === 'batch.disposition' && data.kind === 'batch') {
        this.human(p)
        const selection = requireValue(data.selections.find((s) => s.feedbackId === input.feedbackId), 'REVISION_CONFLICT', 'Disposition must refer to an original selected feedback', 409)
        const f = requireValue(this.host.get('SELECT authorId FROM feedback WHERE feedbackId=?', input.feedbackId), 'NOT_FOUND', 'Feedback unavailable')
        if (input.outcome === 'withdrawn') { if (text(f, 'authorId') !== p.person.userId) denied() }
        else this.owner(p, record, [data.assigneeId])
        this.authorize(this.host.principalFor(input.ownerId), record.entityId)
        if (input.outcome === 'deferred' && input.dueAt === null) conflict('Deferred feedback needs an accountable expected time')
        if (this.host.get('SELECT dispositionId FROM collaboration_dispositions WHERE dispositionId=?', input.dispositionId)) conflict('Disposition identity already exists')
        const disposition = collaborationDispositionSchema.parse({ dispositionId: input.dispositionId, entityId: record.entityId, feedbackId: input.feedbackId, outcome: input.outcome, ownerId: input.ownerId, dueAt: input.dueAt, reason: input.reason, materialId: selection.materialId, version: selection.version, actor: actorSnapshot, createdAt: at, applied: false })
        this.host.run('INSERT INTO collaboration_dispositions(dispositionId,entityId,feedbackId,dispositionJson,createdAt) VALUES(?,?,?,?,?)', input.dispositionId, record.entityId, input.feedbackId, JSON.stringify(disposition), at)
      } else conflict('Action does not match this collaboration kind')
      record = { ...record, revision: record.revision + 1, updatedAt: at, data: collaborationDataSchema.parse(data) }
    }
    const saved = collaborationRecordSchema.parse(record)
    if (Buffer.byteLength(JSON.stringify(saved)) > 256 * 1024) throw new TeamServiceError('CAPACITY_EXCEEDED', 'Collaboration record exceeds its bounded response size', 413)
    this.host.run('INSERT INTO collaboration(entityId,kind,materialId,version,projectId,creatorId,revision,createdAt,updatedAt,dataJson) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(entityId) DO UPDATE SET revision=excluded.revision,updatedAt=excluded.updatedAt,dataJson=excluded.dataJson', saved.entityId, saved.data.kind, saved.materialId, saved.version, saved.projectId, saved.creatorId, saved.revision, saved.createdAt, saved.updatedAt, JSON.stringify(saved.data))
    for (const ref of refs) this.host.run('INSERT OR IGNORE INTO collaboration_scope(entityId,materialId,version) VALUES(?,?,?)', saved.entityId, ref.materialId, ref.version)
    this.host.run('INSERT INTO collaboration_history(entityId,revision,action,actorJson,recordJson) VALUES(?,?,?,?,?)', saved.entityId, saved.revision, input.action, JSON.stringify(this.actor(p, saved.projectId)), JSON.stringify(saved))
    const primary = this.host.version(p, saved.materialId, saved.version)
    this.host.event(`collaboration.${input.action}`, primary.visibility, primary.visibility === 'personal' ? primary.ownerId : primary.visibility === 'project' ? primary.projectId : primary.teamId, primary.projectId, { entityId: saved.entityId, materialId: saved.materialId, version: saved.version, revision: saved.revision, kind: saved.data.kind })
    return saved
  }
}
