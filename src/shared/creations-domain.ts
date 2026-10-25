import {
  CREATION_MAX_RECORD_BYTES, CREATION_MAX_REPLIES, CREATION_MAX_RESPONSE_BYTES, creationCommandSchema, creationRecordSchema, creationSummarySchema, creationViewInputSchema, creationViewSchema,
  type CreationActorContext, type CreationCommand, type CreationComment, type CreationRecord, type CreationSummary, type CreationView
} from './creations'

export class CreationError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 400) { super(message); this.name = 'CreationError' }
}
function fail(code: string, message: string, status = 409): never { throw new CreationError(code, message, status) }
function forbidden(): never { return fail('CREATION_FORBIDDEN', 'Current person cannot access this creation operation', 403) }
const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length
const member = (ctx: CreationActorContext): void => { if (!ctx.activeMemberIds.includes(ctx.actorId)) forbidden() }
const space = (ctx: CreationActorContext, spaceId: string, write: boolean): CreationActorContext['spaces'][number] => {
  const grant = ctx.spaces.find((entry) => entry.id === spaceId)
  if (!grant?.canRead || (write && !grant.canWrite)) forbidden()
  if (write && grant.archived) fail('SPACE_ARCHIVED', 'Archived spaces retain history and reject new changes')
  return grant
}
const owner = (record: CreationRecord, ctx: CreationActorContext): boolean => record.ownerId === ctx.actorId
const editor = (record: CreationRecord, ctx: CreationActorContext): boolean => owner(record, ctx) || record.editorIds.includes(ctx.actorId)
const draftEditor = (record: CreationRecord, ctx: CreationActorContext): boolean => owner(record, ctx) || (record.home === 'team' && editor(record, ctx))
const published = (record: CreationRecord, revisionId: string): CreationRecord['revisions'][number] => {
  const revision = record.revisions.find((entry) => entry.revisionId === revisionId)
  if (!revision) fail('REVISION_NOT_FOUND', 'Published creation revision is unavailable', 404)
  return revision
}
const comment = (record: CreationRecord, commentId: string): CreationComment => {
  const entry = record.comments.find((item) => item.commentId === commentId)
  if (!entry) fail('COMMENT_NOT_FOUND', 'Creation opinion is unavailable', 404)
  return entry
}
const review = (record: CreationRecord, revisionId: string, ctx: CreationActorContext): void => {
  const revision = published(record, revisionId)
  if (!editor(record, ctx) && !revision.reviewerIds.includes(ctx.actorId)) forbidden()
}
const participants = (ids: string[], ctx: CreationActorContext, spaceId: string): void => {
  const grant = space(ctx, spaceId, true)
  if (ids.some((id) => !ctx.activeMemberIds.includes(id) || !grant.memberIds.includes(id))) fail('REVIEWER_SCOPE_CONFLICT', 'Reviewers and editors must be active people in the selected space')
}
const hash = (body: string, ctx: CreationActorContext): string => {
  const value = ctx.digestBody(body)
  if (!/^[a-f0-9]{64}$/.test(value)) fail('DIGEST_UNAVAILABLE', 'Adapter must compute SHA-256 of the exact UTF-8 body', 503)
  return value
}

export function canReadCreation(record: CreationRecord, ctx: CreationActorContext): boolean {
  if (record.projectId !== ctx.projectId || !ctx.activeMemberIds.includes(ctx.actorId)) return false
  if (record.spaceId && !ctx.spaces.some((entry) => entry.id === record.spaceId && entry.canRead)) return false
  return draftEditor(record, ctx) || record.revisions.length > 0
}

/** Authorization also runs before receipt replay; CAS belongs only to initial application. */
export function authorizeCreationCommand(record: CreationRecord | null, command: CreationCommand, ctx: CreationActorContext): void {
  member(ctx)
  if (command.expectedEpoch !== undefined && command.expectedEpoch !== ctx.epoch) fail('EPOCH_CONFLICT', 'Creation service generation changed; reconcile the original intent before retrying')
  if (command.action === 'create') {
    if (record && (record.ownerId !== ctx.actorId || record.projectId !== ctx.projectId)) forbidden()
    if (command.home === 'team') {
      if (!command.spaceId) fail('SPACE_REQUIRED', 'Team creations require a space', 400)
      space(ctx, command.spaceId, true)
      participants(command.editorIds ?? [], ctx, command.spaceId)
    } else if (command.spaceId !== null) fail('INVALID_INPUT', 'New personal creations do not select a team space', 400)
    if (command.home === 'personal' && command.editorIds?.length) fail('INVALID_INPUT', 'Personal drafts do not grant editors access', 400)
    // A personal creation may have subsequently been published; current scope still applies to its receipt.
    if (record?.spaceId) space(ctx, record.spaceId, true)
    return
  }
  if (!record || record.creationId !== command.creationId || !canReadCreation(record, ctx)) forbidden()
  if (record.spaceId) space(ctx, record.spaceId, true)
  switch (command.action) {
    case 'saveDraft': case 'candidateSave': case 'candidateAdopt': case 'candidateDiscard':
      if (!draftEditor(record, ctx)) forbidden()
      if (command.action === 'saveDraft' && command.privateNotes !== undefined && !owner(record, ctx)) forbidden()
      if (command.action === 'candidateSave') for (const id of command.selectedCommentIds) {
        const entry = comment(record, id)
        if (!entry.private) published(record, entry.revisionId)
      }
      break
    case 'publish':
      if (!draftEditor(record, ctx)) forbidden()
      if (command.editorIds !== undefined && !owner(record, ctx)) forbidden()
      space(ctx, command.spaceId, true)
      if (record.spaceId && record.spaceId !== command.spaceId) fail('SPACE_CONFLICT', 'A creation cannot move its published history between spaces')
      participants(command.reviewerIds, ctx, command.spaceId)
      participants(command.editorIds ?? record.editorIds, ctx, command.spaceId)
      break
    case 'annotate':
      if (command.revisionId === record.draft.revisionId && draftEditor(record, ctx)) break
      if (draftEditor(record, ctx) && record.comments.some((entry) => entry.commentId === command.commandId && entry.private && entry.revisionId === command.revisionId)) break
      review(record, command.revisionId, ctx)
      break
    case 'reply': case 'disposition': {
      const entry = comment(record, command.commentId)
      if (entry.private) { if (!draftEditor(record, ctx)) forbidden() }
      else if (command.action === 'reply') review(record, entry.revisionId, ctx)
      if (command.action === 'disposition' && command.reviewRevisionId !== undefined) {
        if (entry.private) fail('REVIEW_CONTEXT_CONFLICT', 'Private draft notes cannot be confirmed as a published review', 400)
        if (published(record, command.reviewRevisionId).number < published(record, entry.revisionId).number) fail('REVIEW_CONTEXT_CONFLICT', 'Review context cannot precede the opinion origin')
      }
      if (command.action === 'disposition' && !editor(record, ctx)) {
        if (entry.private || entry.authorId !== ctx.actorId) forbidden()
        review(record, command.reviewRevisionId ?? entry.revisionId, ctx)
      }
      break
    }
    case 'adoptForTask': {
      if (!editor(record, ctx) || !record.spaceId) forbidden()
      published(record, command.revisionId)
      const task = ctx.tasks.find((entry) => entry.id === command.taskId)
      if (!task || task.spaceId !== record.spaceId) fail('TASK_SCOPE_CONFLICT', 'Task adoption requires an existing task in the creation space')
      space(ctx, task.spaceId, true)
      break
    }
  }
}

export function createInitialCreationRecord(input: Extract<CreationCommand, { action: 'create' }>, ctx: CreationActorContext): CreationRecord {
  const command = creationCommandSchema.parse(input)
  if (command.action !== 'create') fail('INVALID_INPUT', 'Expected creation command', 400)
  authorizeCreationCommand(null, command, ctx)
  if (command.expectedRevision !== null) fail('REVISION_CONFLICT', 'Creation requires a null expected revision')
  return checked(creationRecordSchema.parse({ creationId: command.creationId, projectId: ctx.projectId, ownerId: ctx.actorId, title: command.title, kind: command.kind, home: command.home, spaceId: command.spaceId,
    revision: 1, editorIds: command.editorIds ?? [], draft: { revisionId: command.commandId, serial: 1, body: command.body, bodyDigest: hash(command.body, ctx), scenarios: command.scenarios ?? [], updatedAt: ctx.now },
    privateNotes: command.privateNotes ?? '', candidate: null, revisions: [], comments: [], adoptions: [], reviewSerial: 0, createdAt: ctx.now, updatedAt: ctx.now }))
}

export function executeCreationCommand(source: CreationRecord | null, input: CreationCommand, ctx: CreationActorContext): CreationRecord {
  const command = creationCommandSchema.parse(input)
  authorizeCreationCommand(source, command, ctx)
  if (command.action === 'create') {
    if (source) fail('REVISION_CONFLICT', 'Creation identity already exists')
    return createInitialCreationRecord(command, ctx)
  }
  if (!source) fail('CREATION_NOT_FOUND', 'Creation is unavailable', 404)
  if (source.revision !== command.expectedRevision) fail('REVISION_CONFLICT', 'Creation changed; reload before submitting another intent')
  if (source.revision >= Number.MAX_SAFE_INTEGER || source.reviewSerial >= Number.MAX_SAFE_INTEGER || source.draft.serial >= Number.MAX_SAFE_INTEGER) fail('CAPACITY_EXCEEDED', 'Creation revision bound exceeded', 413)
  const record = structuredClone(source)
  record.revision++
  record.updatedAt = ctx.now
  switch (command.action) {
    case 'saveDraft':
      record.title = command.title ?? record.title
      record.privateNotes = command.privateNotes ?? record.privateNotes
      record.draft = { revisionId: command.commandId, serial: record.draft.serial + 1, body: command.body, bodyDigest: hash(command.body, ctx), scenarios: command.scenarios ?? record.draft.scenarios, updatedAt: ctx.now }
      // Retain a stale candidate for explicit discard; adopting it checks the original serial.
      break
    case 'publish':
      record.spaceId = command.spaceId
      record.editorIds = command.editorIds ?? record.editorIds
      record.revisions.push({ revisionId: command.commandId, number: record.revisions.length + 1, title: record.title, body: record.draft.body, bodyDigest: hash(record.draft.body, ctx), scenarios: structuredClone(record.draft.scenarios), authorId: ctx.actorId, createdAt: ctx.now, reviewerIds: command.reviewerIds })
      break
    case 'annotate': {
      const isPrivate = command.revisionId === record.draft.revisionId
      const selected = isPrivate ? record.draft : published(record, command.revisionId)
      if (command.target.kind === 'text' && selected.body.slice(command.target.start, command.target.end) !== command.target.quote) fail('ANCHOR_CONFLICT', 'Text anchor does not match the selected immutable content')
      const target = command.target
      if (target.kind === 'scenario' && !selected.scenarios.some((entry) => entry.id === target.scenarioId)) fail('ANCHOR_CONFLICT', 'Scenario does not belong to the selected content')
      if (command.target.kind === 'web' && record.kind !== 'prototype') fail('ANCHOR_CONFLICT', 'Web targets require a prototype', 400)
      record.reviewSerial++
      record.comments.push({ commentId: command.commandId, revisionId: command.revisionId, authorId: ctx.actorId, private: isPrivate, target: command.target, body: command.body, severity: command.severity, status: 'open', finalRule: null, reviewedRevisionId: null, dispositionBy: null, dispositionAt: null, reviewSerial: record.reviewSerial, replies: [], createdAt: ctx.now })
      break
    }
    case 'reply': {
      const entry = comment(record, command.commentId)
      entry.replies.push({ replyId: command.commandId, authorId: ctx.actorId, body: command.body, createdAt: ctx.now })
      entry.reviewSerial = ++record.reviewSerial
      break
    }
    case 'disposition': {
      if (command.status === 'confirmed' && !command.finalRule) fail('FINAL_RULE_REQUIRED', 'Human confirmation requires an explicit final rule', 400)
      if (command.status !== 'confirmed' && command.finalRule !== undefined) fail('INVALID_INPUT', 'Only a confirmed opinion records a final rule', 400)
      const entry = comment(record, command.commentId)
      entry.status = command.status
      entry.finalRule = command.status === 'confirmed' ? command.finalRule ?? null : null
      entry.reviewedRevisionId = command.status === 'confirmed' && !entry.private ? command.reviewRevisionId ?? entry.revisionId : null
      entry.dispositionBy = ctx.actorId
      entry.dispositionAt = ctx.now
      entry.reviewSerial = ++record.reviewSerial
      break
    }
    case 'candidateSave':
      if (record.draft.serial !== command.baseDraftRevision) fail('DRAFT_CONFLICT', 'Candidate was generated from a different draft')
      record.candidate = { candidateId: command.commandId, baseDraftRevision: command.baseDraftRevision, selectedCommentIds: command.selectedCommentIds, body: command.body, bodyDigest: hash(command.body, ctx), scenarios: command.scenarios ?? structuredClone(record.draft.scenarios), createdAt: ctx.now }
      break
    case 'candidateAdopt': {
      const candidate = record.candidate
      if (!candidate || candidate.candidateId !== command.candidateId) fail('CANDIDATE_CONFLICT', 'Candidate is no longer selected')
      if (record.draft.serial !== candidate.baseDraftRevision) fail('DRAFT_CONFLICT', 'Draft changed after candidate generation')
      record.draft = { revisionId: command.commandId, serial: record.draft.serial + 1, body: candidate.body, bodyDigest: hash(candidate.body, ctx), scenarios: structuredClone(candidate.scenarios), updatedAt: ctx.now }
      record.candidate = null
      break
    }
    case 'candidateDiscard':
      if (!record.candidate || record.candidate.candidateId !== command.candidateId) fail('CANDIDATE_CONFLICT', 'Candidate is no longer selected')
      record.candidate = null
      break
    case 'adoptForTask': {
      const revision = published(record, command.revisionId)
      const opinions = record.comments.filter((entry) => !entry.private && published(record, entry.revisionId).number <= revision.number)
      if (opinions.some((entry) => entry.severity === 'required' && (entry.status === 'open' || (entry.status === 'confirmed' && (!entry.reviewedRevisionId || published(record, entry.reviewedRevisionId).number > revision.number))))) fail('REQUIRED_OPINIONS_OPEN', 'Resolve inherited required opinions in the selected review context before task adoption')
      const confirmedRules = command.confirmedCommentIds.map((id) => {
        const entry = opinions.find((item) => item.commentId === id)
        if (!entry || entry.status !== 'confirmed' || !entry.finalRule || entry.reviewedRevisionId !== revision.revisionId) fail('RULE_CONFLICT', 'Selected rules require human confirmation while reviewing the adopted revision')
        return { commentId: entry.commentId, finalRule: entry.finalRule, originRevisionId: entry.revisionId, sourceRevisionId: entry.revisionId, reviewedRevisionId: entry.reviewedRevisionId, target: structuredClone(entry.target), originalBody: entry.body }
      })
      record.adoptions.push({ adoptionId: command.commandId, taskId: command.taskId, revisionId: revision.revisionId, revisionNumber: revision.number, bodyDigest: revision.bodyDigest, title: revision.title, reviewWatermark: record.reviewSerial, confirmedRules, adoptedBy: ctx.actorId, adoptedAt: ctx.now })
      break
    }
  }
  return checked(record)
}

function checked(record: CreationRecord): CreationRecord {
  if (record.comments.reduce((sum, entry) => sum + entry.replies.length, 0) > CREATION_MAX_REPLIES || bytes(record.adoptions) > 128 * 1024 || bytes(record) > CREATION_MAX_RECORD_BYTES) fail('CAPACITY_EXCEEDED', 'Creation history exceeds its bounded capacity', 413)
  const parsed = creationRecordSchema.safeParse(record)
  if (!parsed.success) fail('CAPACITY_EXCEEDED', 'Creation history or input exceeds its bounded capacity', 413)
  return parsed.data
}

/** taskId selects immutable pins and their bounded confirmed rules for native task material lookup. Ordinary lists omit rule text. */
export function summarizeCreation(record: CreationRecord, ctx: CreationActorContext, input: { taskId?: string; includeRules?: boolean } = {}): CreationSummary {
  if (!canReadCreation(record, ctx)) forbidden()
  const latest = record.revisions.at(-1)
  const writable = !record.spaceId || ctx.spaces.some((entry) => entry.id === record.spaceId && entry.canWrite && !entry.archived)
  return creationSummarySchema.parse({ creationId: record.creationId, projectId: record.projectId, ownerId: record.ownerId, title: draftEditor(record, ctx) ? record.title : latest?.title ?? record.title,
    kind: record.kind, home: record.home, spaceId: record.spaceId, revision: record.revision, latestPublished: latest ? metadata(latest) : null,
    adoptions: record.adoptions.filter((entry) => !input.taskId || entry.taskId === input.taskId).map((entry) => ({ ...structuredClone(entry), confirmedRules: input.taskId || input.includeRules ? structuredClone(entry.confirmedRules) : [] })),
    canEdit: draftEditor(record, ctx) && writable, canReview: writable && (editor(record, ctx) || latest?.reviewerIds.includes(ctx.actorId) === true), canManageReview: editor(record, ctx) && writable,
    createdAt: record.createdAt, updatedAt: record.updatedAt })
}

function metadata(revision: CreationRecord['revisions'][number]): NonNullable<CreationSummary['latestPublished']> {
  const { body: _body, scenarios: _scenarios, ...value } = revision
  return value
}

export function viewCreation(record: CreationRecord, ctx: CreationActorContext, raw: { revisionId?: string; commentOffset?: number; commentLimit?: number } = {}): CreationView {
  if (!canReadCreation(record, ctx)) forbidden()
  const input = creationViewInputSchema.parse(raw)
  const revisionId = input.revisionId ?? (draftEditor(record, ctx) ? record.draft.revisionId : record.revisions.at(-1)?.revisionId)
  const selectedDraft = draftEditor(record, ctx) && revisionId === record.draft.revisionId
  const selectedCandidate = draftEditor(record, ctx) && revisionId === record.candidate?.candidateId
  const selected = selectedDraft ? record.draft : selectedCandidate && record.candidate ? record.candidate : published(record, revisionId ?? '')
  const selectedPublication = record.revisions.find((entry) => entry.revisionId === revisionId)
  const visibleComments = record.comments.filter((entry) => selectedPublication
    ? !entry.private && published(record, entry.revisionId).number <= selectedPublication.number && (entry.revisionId === revisionId || entry.status !== 'dismissed')
    : entry.revisionId === revisionId && (!entry.private || draftEditor(record, ctx)))
    .sort((a, b) => Number(b.severity === 'required' && b.status === 'open') - Number(a.severity === 'required' && a.status === 'open'))
  const comments = visibleComments.slice(input.commentOffset, input.commentOffset + input.commentLimit)
  const value = creationViewSchema.parse({ summary: summarizeCreation(record, ctx, { includeRules: true }), selected: { revisionId, number: selectedPublication?.number ?? null, title: selectedPublication?.title ?? record.title, body: selected.body, bodyDigest: selected.bodyDigest, scenarios: selected.scenarios, published: Boolean(selectedPublication) },
    revisions: record.revisions.map(metadata), comments, commentOffset: input.commentOffset, nextCommentOffset: input.commentOffset + comments.length < visibleComments.length ? input.commentOffset + comments.length : null,
    ...(owner(record, ctx) ? { privateNotes: record.privateNotes } : {}),
    ...(draftEditor(record, ctx) ? { draft: { revisionId: record.draft.revisionId, serial: record.draft.serial, bodyDigest: record.draft.bodyDigest, updatedAt: record.draft.updatedAt },
      ...(record.candidate ? { candidate: { candidateId: record.candidate.candidateId, baseDraftRevision: record.candidate.baseDraftRevision, selectedCommentIds: record.candidate.selectedCommentIds, bodyDigest: record.candidate.bodyDigest, createdAt: record.candidate.createdAt } } : {}) } : {}) })
  if (bytes(value) > CREATION_MAX_RESPONSE_BYTES - 16 * 1024) fail('CAPACITY_EXCEEDED', 'Selected view exceeds its response budget; request fewer comments', 413)
  return value
}
