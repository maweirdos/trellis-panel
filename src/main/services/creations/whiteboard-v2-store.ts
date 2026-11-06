import { createHash } from 'node:crypto'
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { assertCreationMember, assertCreationRevision, authorizeWhiteboardCommand, canReadWhiteboard, executeWhiteboardCommand, summarizeWhiteboard, visibleCreationComments, CreationError } from '../../../shared/creations-domain'
import { CREATION_MAX_RESPONSE_BYTES, creationBodySchema, creationCommandReplySchema, creationCommandResultSchema, type CreationActorContext, type CreationCommandReply, type CreationCommandResult } from '../../../shared/creations'
import { whiteboardV2CommandSchema, whiteboardV2RecordSchema, whiteboardV2ReadMetadataSchema, whiteboardV2SummaryBasisSchema, whiteboardV2ListInputSchema, whiteboardV2ListSchema, whiteboardV2ViewInputSchema, whiteboardV2ViewSchema, type WhiteboardV2Command, type WhiteboardV2Record, type WhiteboardV2ReadMetadata, type WhiteboardV2List, type WhiteboardV2View } from '../../../shared/creation-whiteboard-v2'
import { whiteboardDocumentSchema } from '../../../shared/creation-whiteboard'

const digest = (body: string): string => createHash('sha256').update(body, 'utf8').digest('hex')
const sourceSchema = z.object({ workspaceKey: z.string().min(1), actorId: z.string().min(1), projectId: z.literal('local'), epoch: z.string().uuid().optional(), sourceIdentity: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict()
const pendingSchema = z.object({ source: sourceSchema, command: whiteboardV2CommandSchema, recordedAt: z.number().int().nonnegative() }).strict()
export type PendingWhiteboardV2 = z.infer<typeof pendingSchema>
const receiptSchema = z.object({ commandId: z.string().uuid(), payloadDigest: z.string().regex(/^[a-f0-9]{64}$/), reply: creationCommandReplySchema, source: sourceSchema.optional(), originalCommand: whiteboardV2CommandSchema.optional() }).strict()
const envelopeSchema = z.object({ record: whiteboardV2RecordSchema, receipts: z.array(receiptSchema).max(64) }).strict()
type Envelope = z.infer<typeof envelopeSchema>
type Source = PendingWhiteboardV2['source']
const itemLimit = 17 * 1024 * 1024
const totalLimit = 64 * 1024 * 1024
const recordLimit = 256
const applicationId = 0x57425632
const schemaVersion = 2
function fail(code: string, message: string, status = 409): never { throw new CreationError(code, message, status) }

/** Internal storage only. No IPC or capability currently exposes whiteboard operations. */
export class WhiteboardV2LocalStore {
  private readonly directory: string
  constructor(root: string) { this.directory = resolve(root, 'creations', 'v2', 'whiteboards') }

  private transaction<T>(work: (db: DatabaseSync) => T): T {
    if (existsSync(this.directory) && lstatSync(this.directory).isSymbolicLink()) fail('STORE_PATH', 'Whiteboard storage directory cannot be a symbolic link')
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const directory = realpathSync.native(this.directory)
    // Earlier experimental JSON data needs explicit migration; never leave it invisible.
    for (const name of ['local', 'pending']) {
      const old = join(directory, name)
      if (existsSync(old) && (!lstatSync(old).isDirectory() || readdirSync(old).length > 0)) fail('STORE_MIGRATION_REQUIRED', 'Earlier whiteboard files require explicit reconciliation; originals are preserved')
    }
    const path = join(directory, 'whiteboards.sqlite')
    for (const file of [path, `${path}-journal`, `${path}-wal`, `${path}-shm`]) {
      if (existsSync(file) && (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile())) fail('STORE_PATH', 'Whiteboard database file cannot be verified')
    }
    try { closeSync(openSync(path, 'wx', 0o600)) }
    catch (error) { if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'EEXIST') throw error }
    if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) fail('STORE_PATH', 'Whiteboard database file cannot be verified')
    const db = new DatabaseSync(path)
    try {
      db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;')
      db.exec('BEGIN IMMEDIATE')
      try {
        const id = Number(db.prepare('PRAGMA application_id').get()?.application_id)
        const version = Number(db.prepare('PRAGMA user_version').get()?.user_version)
        let migrate = false
        if (id === 0 && version === 0) {
          if (db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()) fail('STORE_VERSION', 'Unknown whiteboard database; original is preserved')
          db.exec(`CREATE TABLE whiteboards (id TEXT PRIMARY KEY COLLATE NOCASE, data TEXT NOT NULL) STRICT;
            CREATE TABLE pending (creation_id TEXT PRIMARY KEY COLLATE NOCASE, data TEXT NOT NULL) STRICT;
            PRAGMA application_id=${applicationId};`)
          migrate = true
        } else if (id === applicationId && version === 1) migrate = true
        else if (id !== applicationId || version !== schemaVersion) fail('STORE_VERSION', 'Unknown whiteboard database version; original is preserved')
        if (migrate) {
          db.exec(`CREATE TABLE whiteboard_read_index (id TEXT PRIMARY KEY COLLATE NOCASE, owner_id TEXT NOT NULL, summary TEXT NOT NULL, detail TEXT NOT NULL, FOREIGN KEY(id) REFERENCES whiteboards(id) ON DELETE CASCADE) STRICT;
            CREATE INDEX whiteboard_read_owner ON whiteboard_read_index(owner_id);
            CREATE TABLE whiteboard_revision_bodies (creation_id TEXT NOT NULL COLLATE NOCASE, revision_id TEXT NOT NULL, slot TEXT NOT NULL CHECK(slot IN ('draft','published')), body TEXT NOT NULL, body_digest TEXT NOT NULL, PRIMARY KEY(creation_id,revision_id,slot), FOREIGN KEY(creation_id) REFERENCES whiteboards(id) ON DELETE CASCADE) STRICT;`)
          const records = db.prepare('SELECT id FROM whiteboards LIMIT ?').all(recordLimit + 1)
          if (records.length > recordLimit) fail('CAPACITY_EXCEEDED', 'Whiteboard storage exceeds its migration limit', 413)
          for (const row of records) {
            if (typeof row.id !== 'string') fail('INVALID_INPUT', 'Whiteboard identity is invalid', 400)
            const envelope = this.envelope(db, row.id)
            if (!envelope) fail('INVALID_INPUT', 'Whiteboard record disappeared during migration', 400)
            this.indexRecord(db, envelope.record)
          }
          db.exec(`PRAGMA user_version=${schemaVersion}`)
        }
        if (String(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toLowerCase() !== 'delete') fail('STORE_VERSION', 'Unsupported whiteboard database journal mode')
        const result = work(db)
        db.exec('COMMIT')
        return result
      } catch (error) { db.exec('ROLLBACK'); throw error }
    } finally { db.close() }
  }
  private envelope(db: DatabaseSync, id: string): Envelope | null {
    z.string().uuid().parse(id)
    const row = db.prepare('SELECT id, data FROM whiteboards WHERE id=?').get(id)
    if (!row) return null
    if (row.id !== id || typeof row.data !== 'string' || Buffer.byteLength(row.data) > itemLimit) fail('INVALID_INPUT', 'Whiteboard record identity or size is invalid', 400)
    const value = envelopeSchema.parse(JSON.parse(row.data)), record = value.record
    if (record.creationId !== id || record.projectId !== 'local' || record.home !== 'personal' || record.editorIds.length || record.adoptions.length || record.candidate ||
      (record.revisions.length === 0) !== (record.spaceId === null) || record.draft.bodyDigest !== digest(record.draft.body) ||
      record.revisions.some((revision, index) => revision.number !== index + 1 || revision.bodyDigest !== digest(revision.body) || revision.reviewerIds.some((person) => person !== record.ownerId)) ||
      new Set(record.revisions.map((revision) => revision.revisionId)).size !== record.revisions.length ||
      new Set(record.comments.map((entry) => entry.commentId)).size !== record.comments.length || record.comments.some((entry) => {
        const origin = record.revisions.findIndex((revision) => revision.revisionId === entry.revisionId)
        const reviewed = entry.reviewedRevisionId === null ? -1 : record.revisions.findIndex((revision) => revision.revisionId === entry.reviewedRevisionId)
        return (!entry.private && origin < 0) || (entry.private && entry.reviewedRevisionId !== null) ||
          (entry.reviewedRevisionId !== null && (reviewed < 0 || reviewed < origin)) ||
          (entry.status === 'confirmed' ? !entry.finalRule || (!entry.private && reviewed < 0) : entry.finalRule !== null || entry.reviewedRevisionId !== null)
      })) {
      fail('INVALID_INPUT', 'Whiteboard record has unsupported state or invalid identity or digest', 400)
    }
    return value
  }
  private indexRecord(db: DatabaseSync, record: WhiteboardV2Record): void {
    const { body: _draftBody, scenarios: _draftScenarios, ...draft } = record.draft
    const revisions = record.revisions.map(({ body: _body, scenarios: _scenarios, ...revision }) => revision)
    const detail = whiteboardV2ReadMetadataSchema.parse({ creationId: record.creationId, projectId: record.projectId, ownerId: record.ownerId,
      title: record.title, kind: record.kind, home: record.home, spaceId: record.spaceId, editorIds: record.editorIds, revision: record.revision,
      draft, revisions, comments: record.comments, adoptions: record.adoptions, createdAt: record.createdAt, updatedAt: record.updatedAt })
    const { draft: _draft, comments: _comments, ...summary } = detail
    db.prepare('INSERT INTO whiteboard_read_index(id,owner_id,summary,detail) VALUES(?,?,?,?)').run(record.creationId, record.ownerId, JSON.stringify(whiteboardV2SummaryBasisSchema.parse(summary)), JSON.stringify(detail))
    const insert = db.prepare('INSERT INTO whiteboard_revision_bodies(creation_id,revision_id,slot,body,body_digest) VALUES(?,?,?,?,?)')
    insert.run(record.creationId, record.draft.revisionId, 'draft', record.draft.body, record.draft.bodyDigest)
    for (const revision of record.revisions) insert.run(record.creationId, revision.revisionId, 'published', revision.body, revision.bodyDigest)
  }
  private readMetadata(db: DatabaseSync, id: string): WhiteboardV2ReadMetadata | null {
    z.string().uuid().parse(id)
    const row = db.prepare('SELECT id,owner_id,summary,detail FROM whiteboard_read_index WHERE id=?').get(id)
    if (!row) {
      if (db.prepare('SELECT id FROM whiteboards WHERE id=?').get(id)) fail('INVALID_INPUT', 'Whiteboard read index is unavailable', 400)
      return null
    }
    if (row.id !== id || typeof row.owner_id !== 'string' || typeof row.summary !== 'string' || typeof row.detail !== 'string' || Buffer.byteLength(row.detail) > itemLimit) fail('INVALID_INPUT', 'Whiteboard read index is invalid', 400)
    const detail = whiteboardV2ReadMetadataSchema.parse(JSON.parse(row.detail)), { draft: _draft, comments: _comments, ...summary } = detail
    if (detail.creationId !== id || detail.ownerId !== row.owner_id || JSON.stringify(whiteboardV2SummaryBasisSchema.parse(summary)) !== JSON.stringify(whiteboardV2SummaryBasisSchema.parse(JSON.parse(row.summary)))) fail('INVALID_INPUT', 'Whiteboard read identity is invalid', 400)
    return detail
  }
  private pendingRecord(db: DatabaseSync, id: string): PendingWhiteboardV2 | null {
    z.string().uuid().parse(id)
    const row = db.prepare('SELECT creation_id, data FROM pending WHERE creation_id=?').get(id)
    if (!row) return null
    if (row.creation_id !== id || typeof row.data !== 'string' || Buffer.byteLength(row.data) > itemLimit) fail('INVALID_INPUT', 'Pending whiteboard identity or size is invalid', 400)
    const value = pendingSchema.parse(JSON.parse(row.data))
    if (value.command.creationId !== id) fail('INVALID_INPUT', 'Pending whiteboard identity does not match', 400)
    return value
  }
  private authorize(record: WhiteboardV2Record | null, ctx: CreationActorContext, command?: WhiteboardV2Command): void {
    assertCreationMember(ctx)
    if (ctx.projectId !== 'local' || (record && !canReadWhiteboard(record, ctx))) fail('CREATION_FORBIDDEN', 'Current person cannot access this whiteboard', 403)
    if (command) authorizeWhiteboardCommand(record, command, ctx)
  }
  private authorizeSource(source: Source, ctx: CreationActorContext): void {
    assertCreationMember(ctx)
    if (source.actorId !== ctx.actorId || source.projectId !== ctx.projectId || source.epoch !== ctx.epoch) fail('SOURCE_CHANGED', 'Whiteboard command source changed')
  }
  private assertPendingOwner(value: PendingWhiteboardV2, source: Source): void {
    if (value.source.actorId !== source.actorId) fail('CREATION_FORBIDDEN', 'Current person cannot access this pending whiteboard', 403)
    if (JSON.stringify(value.source) !== JSON.stringify(source)) fail('SOURCE_CHANGED', 'Pending whiteboard belongs to a different source')
  }
  private capacity(db: DatabaseSync, table: 'whiteboards' | 'pending', data: string, replacing: boolean): void {
    const bytes = Buffer.byteLength(data)
    if (bytes > itemLimit) fail('CAPACITY_EXCEEDED', 'Whiteboard storage item exceeds its limit', 413)
    const usage = db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(data AS BLOB))), 0) AS bytes FROM ${table}`).get()
    if (!usage || Number(usage.count) + (replacing ? 0 : 1) > recordLimit || Number(usage.bytes) + bytes > totalLimit) fail('CAPACITY_EXCEEDED', 'Whiteboard storage exceeds its limit', 413)
  }
  async list(input: z.input<typeof whiteboardV2ListInputSchema>, ctx: CreationActorContext, sourceInput: Source): Promise<WhiteboardV2List> {
    const query = whiteboardV2ListInputSchema.parse(input), source = sourceSchema.parse(sourceInput)
    return this.transaction((db) => {
      this.authorizeSource(source, ctx)
      const counts = db.prepare('SELECT (SELECT COUNT(*) FROM whiteboards) AS records, (SELECT COUNT(*) FROM whiteboard_read_index) AS indexed').get()
      if (!counts || counts.records !== counts.indexed) fail('INVALID_INPUT', 'Whiteboard read index is incomplete', 400)
      const rows = db.prepare(`SELECT i.id, i.owner_id, i.summary,
        json_extract(i.detail, '$.creationId') AS detail_id,
        json_extract(i.detail, '$.projectId') AS detail_project,
        json_extract(i.detail, '$.ownerId') AS detail_owner,
        json_extract(i.detail, '$.kind') AS detail_kind,
        json_extract(i.detail, '$.home') AS detail_home,
        json_extract(i.detail, '$.spaceId') AS detail_space,
        json_extract(i.detail, '$.revision') AS detail_revision,
        json_extract(i.detail, '$.draft.revisionId') AS draft_revision_id,
        json_extract(i.detail, '$.draft.bodyDigest') AS draft_digest,
        b.body_digest AS indexed_draft_digest
        FROM whiteboard_read_index i
        LEFT JOIN whiteboard_revision_bodies b ON b.creation_id=i.id AND b.slot='draft'
          AND b.revision_id=json_extract(i.detail, '$.draft.revisionId')
        WHERE i.owner_id=? LIMIT ?`).all(ctx.actorId, recordLimit + 1)
      if (rows.length > recordLimit) fail('CAPACITY_EXCEEDED', 'Whiteboard list exceeds its limit', 413)
      const items = rows.map((row) => {
        if (typeof row.id !== 'string' || typeof row.summary !== 'string' || row.owner_id !== ctx.actorId || Buffer.byteLength(row.summary) > itemLimit) fail('INVALID_INPUT', 'Whiteboard list index is invalid', 400)
        const basis = whiteboardV2SummaryBasisSchema.parse(JSON.parse(row.summary))
        if (basis.creationId !== row.id || basis.ownerId !== row.owner_id) fail('INVALID_INPUT', 'Whiteboard list identity is invalid', 400)
        return { basis, row }
      }).filter(({ basis }) => canReadWhiteboard(basis, ctx)).map(({ basis, row }) => {
        const draftRevisionId = z.string().uuid().safeParse(row.draft_revision_id)
        if (row.detail_id !== basis.creationId || row.detail_project !== basis.projectId || row.detail_owner !== basis.ownerId ||
          row.detail_kind !== basis.kind || row.detail_home !== basis.home || row.detail_space !== basis.spaceId || row.detail_revision !== basis.revision ||
          !draftRevisionId.success || typeof row.draft_digest !== 'string' || !/^[a-f0-9]{64}$/.test(row.draft_digest) || row.draft_digest !== row.indexed_draft_digest) {
          fail('INVALID_INPUT', 'Whiteboard draft index is invalid', 400)
        }
        if (basis.revisions.some((revision) => revision.revisionId === draftRevisionId.data)) fail('REVISION_CONFLICT', 'Whiteboard draft revision identity is ambiguous')
        return { ...summarizeWhiteboard(basis, ctx), draftRevisionId: draftRevisionId.data }
      })
      const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0
      // Updated is descending; name is code-unit ascending; ties always use identity ascending.
      items.sort((left, right) => (query.sort === 'updated' ? right.updatedAt - left.updatedAt : compareText(left.title, right.title)) || compareText(left.creationId, right.creationId))
      const scope = digest(JSON.stringify([source, query.sort, items]))
      let after = ''
      if (query.cursor) {
        try {
          const cursor = z.object({ version: z.literal(1), sort: z.enum(['updated', 'name']), scope: z.string().regex(/^[a-f0-9]{64}$/), after: z.string().uuid() }).strict().parse(JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')))
          if (cursor.sort !== query.sort || cursor.scope !== scope) fail('CURSOR_CONFLICT', 'Whiteboard list changed; restart from the first page')
          after = cursor.after
        } catch { fail('CURSOR_CONFLICT', 'Whiteboard list changed; restart from the first page') }
      }
      const index = after ? items.findIndex((item) => item.creationId === after) : -1
      if (after && index < 0) fail('CURSOR_CONFLICT', 'Whiteboard list changed; restart from the first page')
      const selected = items.slice(index + 1, index + 1 + query.limit), hasMore = index + 1 + selected.length < items.length
      const nextCursor = hasMore ? Buffer.from(JSON.stringify({ version: 1, sort: query.sort, scope, after: selected.at(-1)?.creationId })).toString('base64url') : null
      const result = whiteboardV2ListSchema.parse({ items: selected, hasMore, nextCursor })
      if (Buffer.byteLength(JSON.stringify(result)) > CREATION_MAX_RESPONSE_BYTES - 16 * 1024) fail('CAPACITY_EXCEEDED', 'Whiteboard list exceeds its response limit', 413)
      return result
    })
  }
  async view(id: string, input: z.input<typeof whiteboardV2ViewInputSchema>, ctx: CreationActorContext): Promise<WhiteboardV2View | null> {
    const selection = whiteboardV2ViewInputSchema.parse(input)
    return this.transaction((db) => {
      assertCreationMember(ctx)
      if (ctx.projectId !== 'local') fail('CREATION_FORBIDDEN', 'Current person cannot access this whiteboard', 403)
      const detail = this.readMetadata(db, id)
      if (!detail) return null
      if (!canReadWhiteboard(detail, ctx)) fail('CREATION_FORBIDDEN', 'Current person cannot access this whiteboard', 403)
      const { draft, comments: opinions, ...basis } = detail
      const publication = detail.revisions.find((entry) => entry.revisionId === selection.revisionId)
      const isDraft = detail.draft.revisionId === selection.revisionId
      if (isDraft && publication) fail('REVISION_CONFLICT', 'Selected whiteboard revision identity is ambiguous')
      const selected = isDraft ? detail.draft : publication
      if (!selected) fail('REVISION_NOT_FOUND', 'Selected whiteboard revision is unavailable', 404)
      const row = db.prepare('SELECT body,body_digest FROM whiteboard_revision_bodies WHERE creation_id=? AND revision_id=? AND slot=?').get(id, selection.revisionId, isDraft ? 'draft' : 'published')
      if (!row || typeof row.body !== 'string' || row.body_digest !== selected.bodyDigest || digest(row.body) !== selected.bodyDigest || !creationBodySchema.safeParse(row.body).success) fail('INVALID_INPUT', 'Selected whiteboard body or digest is invalid', 400)
      try { whiteboardDocumentSchema.parse(JSON.parse(row.body)) } catch { fail('INVALID_INPUT', 'Selected whiteboard body is invalid', 400) }
      const visible = visibleCreationComments(detail.revisions, opinions, selection.revisionId, isDraft ? undefined : publication, isDraft)
      const comments = visible.slice(selection.commentOffset, selection.commentOffset + selection.commentLimit)
      const result = whiteboardV2ViewSchema.parse({ summary: summarizeWhiteboard(basis, ctx), selected: { revisionId: selection.revisionId,
        number: isDraft ? null : publication?.number ?? null, title: isDraft ? detail.title : publication?.title ?? detail.title,
        body: row.body, bodyDigest: selected.bodyDigest, scenarios: [], published: !isDraft }, revisions: detail.revisions, comments,
        commentOffset: selection.commentOffset, nextCommentOffset: selection.commentOffset + comments.length < visible.length ? selection.commentOffset + comments.length : null })
      if (Buffer.byteLength(JSON.stringify(result)) > CREATION_MAX_RESPONSE_BYTES - 16 * 1024) fail('CAPACITY_EXCEEDED', 'Whiteboard view exceeds its response limit', 413)
      return result
    })
  }
  async receipt(input: WhiteboardV2Command, ctx: CreationActorContext, sourceInput: Source): Promise<CreationCommandReply | null> {
    const command = whiteboardV2CommandSchema.parse(input), source = sourceSchema.parse(sourceInput)
    return this.transaction((db) => {
      this.authorizeSource(source, ctx)
      const envelope = this.envelope(db, command.creationId)
      this.authorize(envelope?.record ?? null, ctx, command)
      const pending = this.pendingRecord(db, command.creationId)
      if (pending) {
        this.assertPendingOwner(pending, source)
        if (JSON.stringify(pending.command) !== JSON.stringify(command)) fail('PENDING_OPERATION', 'Preserve and reconcile the original pending whiteboard operation')
      }
      const receipt = envelope?.receipts.find((entry) => entry.commandId === command.commandId)
      if (!receipt) return null
      if (receipt.payloadDigest !== digest(JSON.stringify(command))) fail('COMMAND_CONFLICT', 'Command identity belongs to different content')
      if (!receipt.source || JSON.stringify(receipt.source) !== JSON.stringify(source) || !receipt.originalCommand || JSON.stringify(receipt.originalCommand) !== JSON.stringify(command)) fail('SOURCE_CHANGED', 'Original whiteboard receipt source or operation cannot be verified')
      if (!envelope || receipt.reply.status !== 'committed' || receipt.reply.commandId !== command.commandId || JSON.stringify(receipt.reply.result) !== JSON.stringify(this.result(envelope.record, command, ctx))) fail('RECEIPT_MISMATCH', 'Original whiteboard receipt does not match its operation')
      return structuredClone(receipt.reply)
    })
  }
  private result(record: WhiteboardV2Record, command: WhiteboardV2Command, ctx: CreationActorContext): CreationCommandResult {
    const opinion = command.action === 'annotate' ? record.comments.find((entry) => entry.commentId === command.commandId)
      : command.action === 'reply' || command.action === 'disposition' ? record.comments.find((entry) => entry.commentId === command.commentId) : undefined
    if (['annotate', 'reply', 'disposition'].includes(command.action) && !opinion) fail('RECEIPT_MISMATCH', 'Original whiteboard opinion is unavailable')
    return creationCommandResultSchema.parse({ projectId: record.projectId, creationId: record.creationId, ...(ctx.epoch ? { epoch: ctx.epoch } : {}),
      revision: (command.expectedRevision ?? 0) + 1, action: command.action, scopeSpaceIds: [], scopeTaskIds: [], scopePersonIds: [ctx.actorId], private: true,
      ...(command.action === 'create' || command.action === 'saveDraft' || command.action === 'publish' ? { revisionId: command.commandId }
        : opinion ? { revisionId: opinion.revisionId, commentId: opinion.commentId } : {}),
      ...(command.action === 'disposition' && opinion && !opinion.private ? { reviewRevisionId: command.reviewRevisionId ?? opinion.revisionId } : {}) })
  }
  async receiptById(creationId: string, commandId: string, ctx: CreationActorContext, sourceInput: Source): Promise<CreationCommandReply | null> {
    const id = z.string().uuid().parse(creationId), operationId = z.string().uuid().parse(commandId), source = sourceSchema.parse(sourceInput)
    return this.transaction((db) => {
      this.authorizeSource(source, ctx)
      const envelope = this.envelope(db, id)
      this.authorize(envelope?.record ?? null, ctx)
      const pending = this.pendingRecord(db, id)
      if (pending) {
        this.assertPendingOwner(pending, source)
        fail('PENDING_OPERATION', 'Recheck the original pending whiteboard operation')
      }
      const receipt = envelope?.receipts.find((entry) => entry.commandId === operationId)
      if (!receipt) return null
      const command = receipt.originalCommand, reply = receipt.reply
      if (!envelope || !receipt.source || !receipt.source.sourceIdentity || JSON.stringify(receipt.source) !== JSON.stringify(source) || !command ||
        command.commandId !== operationId || command.creationId !== id || command.expectedEpoch !== source.epoch ||
        receipt.payloadDigest !== digest(JSON.stringify(command)) || reply.status !== 'committed' || reply.commandId !== operationId) {
        fail('RECEIPT_MISMATCH', 'Original whiteboard receipt or source cannot be verified')
      }
      this.authorize(envelope.record, ctx, command)
      if (JSON.stringify(reply.result) !== JSON.stringify(this.result(envelope.record, command, ctx))) fail('RECEIPT_MISMATCH', 'Original whiteboard receipt does not match its operation')
      return structuredClone(reply)
    })
  }
  async command(input: WhiteboardV2Command, ctx: CreationActorContext, sourceInput: Source): Promise<CreationCommandReply> {
    const command = whiteboardV2CommandSchema.parse(input), source = sourceSchema.parse(sourceInput)
    return this.transaction((db) => {
      this.authorizeSource(source, ctx)
      const previous = this.envelope(db, command.creationId)
      this.authorize(previous?.record ?? null, ctx, command)
      const pending = this.pendingRecord(db, command.creationId)
      if (pending) {
        this.assertPendingOwner(pending, source)
        if (JSON.stringify(pending.command) !== JSON.stringify(command)) fail('PENDING_OPERATION', 'Preserve and reconcile the original pending whiteboard operation')
      }
      const oldReceipt = previous?.receipts.find((entry) => entry.commandId === command.commandId)
      if (oldReceipt) {
        if (oldReceipt.payloadDigest !== digest(JSON.stringify(command))) fail('COMMAND_CONFLICT', 'Command identity belongs to different content')
        if (!oldReceipt.source || JSON.stringify(oldReceipt.source) !== JSON.stringify(source) || !oldReceipt.originalCommand || JSON.stringify(oldReceipt.originalCommand) !== JSON.stringify(command)) fail('SOURCE_CHANGED', 'Original whiteboard receipt source or operation cannot be verified')
        if (!previous || oldReceipt.reply.status !== 'committed' || oldReceipt.reply.commandId !== command.commandId || JSON.stringify(oldReceipt.reply.result) !== JSON.stringify(this.result(previous.record, command, ctx))) fail('RECEIPT_MISMATCH', 'Original whiteboard receipt does not match its operation')
        return { ...structuredClone(oldReceipt.reply), status: 'duplicate' }
      }
      assertCreationRevision(previous?.record.revision ?? null, command.expectedRevision)
      if ((command.action === 'create') !== (previous === null)) fail('REVISION_CONFLICT', 'Whiteboard identity already exists or is unavailable')
      const record = executeWhiteboardCommand(previous?.record ?? null, command, ctx)
      const reply = creationCommandReplySchema.parse({ status: 'committed', commandId: command.commandId, result: this.result(record, command, ctx) })
      const receipts = [...(previous?.receipts ?? []), { commandId: command.commandId, payloadDigest: digest(JSON.stringify(command)), reply, source, originalCommand: command }].slice(-64)
      const data = JSON.stringify(envelopeSchema.parse({ record, receipts }))
      if (previous) db.prepare('DELETE FROM whiteboards WHERE id=?').run(command.creationId)
      this.capacity(db, 'whiteboards', data, false)
      db.prepare('INSERT INTO whiteboards(id,data) VALUES(?,?)').run(command.creationId, data)
      this.indexRecord(db, record)
      const indexBytes = Number(db.prepare('SELECT COALESCE((SELECT SUM(length(CAST(summary AS BLOB)) + length(CAST(detail AS BLOB))) FROM whiteboard_read_index),0) + COALESCE((SELECT SUM(length(CAST(body AS BLOB))) FROM whiteboard_revision_bodies),0) AS bytes').get()?.bytes ?? 0)
      if (indexBytes > totalLimit) fail('CAPACITY_EXCEEDED', 'Whiteboard read index exceeds its limit', 413)
      return reply
    })
  }
  async pending(sourceInput: Source, creationId: string, ctx: CreationActorContext): Promise<PendingWhiteboardV2 | null> {
    const source = sourceSchema.parse(sourceInput), id = z.string().uuid().parse(creationId)
    return this.transaction((db) => {
      this.authorizeSource(source, ctx)
      this.authorize(this.envelope(db, id)?.record ?? null, ctx)
      const value = this.pendingRecord(db, id)
      if (value) this.assertPendingOwner(value, source)
      return value ? structuredClone(value) : null
    })
  }
  async reserve(input: PendingWhiteboardV2, ctx: CreationActorContext): Promise<void> {
    const value = pendingSchema.parse(input)
    this.transaction((db) => {
      this.authorizeSource(value.source, ctx)
      const envelope = this.envelope(db, value.command.creationId)
      this.authorize(envelope?.record ?? null, ctx, value.command)
      const previous = this.pendingRecord(db, value.command.creationId)
      if (previous) {
        this.assertPendingOwner(previous, value.source)
        if (JSON.stringify(previous) !== JSON.stringify(value)) fail('PENDING_OPERATION', 'Preserve the original pending whiteboard operation')
        return
      }
      const receipt = envelope?.receipts.find((entry) => entry.commandId === value.command.commandId)
      if (receipt) {
        if (receipt.payloadDigest !== digest(JSON.stringify(value.command))) fail('COMMAND_CONFLICT', 'Command identity belongs to different content')
        if (!receipt.source || JSON.stringify(receipt.source) !== JSON.stringify(value.source) || !receipt.originalCommand || JSON.stringify(receipt.originalCommand) !== JSON.stringify(value.command)) fail('SOURCE_CHANGED', 'Original whiteboard receipt source or operation cannot be verified')
        if (!envelope || receipt.reply.status !== 'committed' || receipt.reply.commandId !== value.command.commandId || JSON.stringify(receipt.reply.result) !== JSON.stringify(this.result(envelope.record, value.command, ctx))) fail('RECEIPT_MISMATCH', 'Original whiteboard receipt does not match its operation')
      } else {
        assertCreationRevision(envelope?.record.revision ?? null, value.command.expectedRevision)
        if ((value.command.action === 'create') !== (envelope === null)) fail('REVISION_CONFLICT', 'Whiteboard identity already exists or is unavailable')
      }
      const data = JSON.stringify(value)
      this.capacity(db, 'pending', data, false)
      db.prepare('INSERT INTO pending(creation_id,data) VALUES(?,?)').run(value.command.creationId, data)
    })
  }
  async settle(input: PendingWhiteboardV2, ctx: CreationActorContext): Promise<void> {
    const value = pendingSchema.parse(input)
    this.transaction((db) => {
      this.authorizeSource(value.source, ctx)
      const envelope = this.envelope(db, value.command.creationId)
      this.authorize(envelope?.record ?? null, ctx, value.command)
      const pending = this.pendingRecord(db, value.command.creationId)
      if (pending) this.assertPendingOwner(pending, value.source)
      if (!pending || JSON.stringify(pending) !== JSON.stringify(value)) fail('PENDING_OPERATION', 'Pending whiteboard operation does not match')
      const receipt = envelope?.receipts.find((entry) => entry.commandId === value.command.commandId)
      if (!envelope || envelope.record.ownerId !== value.source.actorId || !receipt || receipt.payloadDigest !== digest(JSON.stringify(value.command)) ||
        receipt.reply.commandId !== value.command.commandId || receipt.reply.result.creationId !== value.command.creationId || receipt.reply.result.action !== value.command.action ||
        receipt.reply.result.projectId !== value.source.projectId || receipt.reply.result.epoch !== value.source.epoch || !receipt.source || JSON.stringify(receipt.source) !== JSON.stringify(value.source) || !receipt.originalCommand || JSON.stringify(receipt.originalCommand) !== JSON.stringify(value.command) ||
        receipt.reply.status !== 'committed' || JSON.stringify(receipt.reply.result) !== JSON.stringify(this.result(envelope.record, value.command, ctx))) {
        fail('PENDING_OPERATION', 'The original whiteboard receipt is unavailable or does not match')
      }
      db.prepare('DELETE FROM pending WHERE creation_id=?').run(value.command.creationId)
    })
  }
}
