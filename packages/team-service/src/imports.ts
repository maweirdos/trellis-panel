import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { hifoxSnapshotSchema } from '../../../src/shared/hifox-schema'
import type { HifoxSpace, HifoxTask } from '../../../src/shared/hifox'
import { canReadHifoxSpace } from '../../../src/shared/hifox-domain/commands'
import { teamIdSchema, teamRelativePathSchema, type TeamCommandReply, type TeamPage } from '../../../src/shared/team-platform'
import type { TeamTaskRef } from '../../../src/shared/team-task-execution'
import {
  assertImportShareableText, canonicalImportJson, importCandidateSchema, importCommandSchema, importListQuerySchema, importManifestSchema,
  importNamespaceSchema, importReceiptSchema, importTaskMappingSchema, importTaskSummary,
  type ImportCandidate, type ImportCommand, type ImportManifest, type ImportNamespace, type ImportReceipt, type ImportTaskMapping
} from '../../../src/shared/team-import'
import type { CreationsHost } from './creations'
import type { HifoxWorkspaceHost } from './hifox-workspace'
import type { StoreActor, StorePrincipal } from './store-types'
import { TeamServiceError } from './errors'

export type ImportsHost = Omit<CreationsHost, 'identity'> & Pick<HifoxWorkspaceHost, 'identity'> & {
  body(digest: string): Buffer
  persistBody(bytes: Buffer, digest: string): void
  createTask(principal: StorePrincipal, projectId: string, spaceId: string, title: string, expectedRevision: number): TeamTaskRef
  event(actorId: string, projectId: string, namespaceId: string, importId: string | null, commandId: string): void
}
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
function fail(code: string, message: string, status = 409): never { throw new TeamServiceError(code, message, status) }
function unavailable(): never { return fail('IMPORT_UNAVAILABLE', 'Import source is unavailable in the current scope', 404) }
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  try { return schema.parse(typeof raw === 'string' ? JSON.parse(raw) : raw) }
  catch { return fail('CORRUPT_STORE', 'Stored import record is invalid', 503) }
}
function shareable(text: string): void { try { assertImportShareableText(text) } catch { fail('IMPORT_PRIVATE_CONTENT', 'Select reviewed portable source bytes without credentials or private paths', 422) } }

/** Staging only. No execution, approval, adopted input or team material head is changed. */
export class TeamImports {
  constructor(private readonly host: ImportsHost) {}

  private space(principal: StorePrincipal, projectId: string, spaceId: string, createdAt?: string, writing = false): HifoxSpace {
    this.host.project(principal, projectId)
    const row = this.host.get("SELECT s.value AS body FROM hifox_workspaces w,json_each(w.snapshotJson,'$.spaces') s WHERE w.projectId=? AND json_extract(s.value,'$.id')=?", projectId, spaceId)
    if (!row) unavailable()
    const space = parse(hifoxSnapshotSchema.shape.spaces.element, row.body)
    if ((createdAt && space.createdAt !== createdAt) || !canReadHifoxSpace(space, principal.person.userId)) unavailable()
    if (writing && (space.archived || !space.memberIds.includes(principal.person.userId))) fail('IMPORT_FORBIDDEN', 'Import requires current membership of an active space', 403)
    return space
  }
  private namespace(principal: StorePrincipal, projectId: string, id: string, writing = false): ImportNamespace {
    const row = this.host.get('SELECT recordJson FROM import_namespaces WHERE namespaceId=? AND projectId=?', id, projectId)
    if (!row) unavailable()
    const source = parse(importNamespaceSchema, row.recordJson)
    this.space(principal, projectId, source.spaceId, source.spaceCreatedAt, writing)
    return source
  }
  private task(principal: StorePrincipal, source: ImportNamespace, ref: TeamTaskRef): HifoxTask {
    if (ref.instanceId !== this.host.identity().instanceId || ref.projectId !== source.projectId || ref.spaceId !== source.spaceId) unavailable()
    this.space(principal, ref.projectId, ref.spaceId, source.spaceCreatedAt)
    const row = this.host.get("SELECT t.value AS body FROM hifox_workspaces w,json_each(w.snapshotJson,'$.tasks') t WHERE w.projectId=? AND json_extract(t.value,'$.id')=?", source.projectId, ref.taskId)
    if (!row) unavailable()
    const task = parse(hifoxSnapshotSchema.shape.tasks.element, row.body)
    if (task.createdAt !== ref.taskCreatedAt || task.spaceId !== source.spaceId) unavailable()
    return task
  }
  private mapping(source: ImportNamespace, key: string): ImportTaskMapping | null {
    const row = this.host.get('SELECT recordJson FROM import_task_mappings WHERE namespaceId=? AND sourceTaskKey=?', source.namespaceId, key)
    return row ? parse(importTaskMappingSchema, row.recordJson) : null
  }
  private batch(source: ImportNamespace, importId: string): { manifest: ImportManifest; manifestDigest: string } {
    const row = this.host.get('SELECT manifestJson,manifestDigest FROM import_batches WHERE importId=? AND namespaceId=?', importId, source.namespaceId)
    if (!row) unavailable()
    const manifest = parse(importManifestSchema, row.manifestJson)
    if (typeof row.manifestDigest !== 'string' || hash(canonicalImportJson(manifest)) !== row.manifestDigest) fail('CORRUPT_STORE', 'Stored import manifest digest differs', 503)
    return { manifest, manifestDigest: row.manifestDigest }
  }
  private authors(principal: StorePrincipal, source: ImportNamespace, manifest: ImportManifest): void {
    const space = this.space(principal, source.projectId, source.spaceId, source.spaceCreatedAt)
    for (const author of manifest.authors) if (author.accountId) {
      const active = this.host.get('SELECT p.userId FROM people p JOIN project_members pm ON pm.userId=p.userId JOIN projects pr ON pr.projectId=pm.projectId JOIN team_members tm ON tm.teamId=pr.teamId AND tm.userId=p.userId WHERE p.userId=? AND pm.projectId=? AND p.active=1 AND pm.active=1 AND tm.active=1', author.accountId, source.projectId)
      if (!active || !space.memberIds.includes(author.accountId)) fail('IMPORT_AUTHOR_UNAVAILABLE', 'Mapped author must be an active account in this project and space')
    }
  }
  private principal(principal: StorePrincipal, command: ImportCommand): void {
    if (principal.person.userId !== command.expectedActorId || principal.deviceId !== command.expectedDeviceId) fail('IMPORT_FORBIDDEN', 'Original import account/device differs from the authenticated principal', 403)
    this.host.project(principal, command.projectId)
    if (command.instanceId !== this.host.identity().instanceId || command.expectedEpoch !== this.host.identity().epoch) fail('IMPORT_SCOPE_CONFLICT', 'Original service instance/epoch changed; preserve and reconcile the original intent')
  }
  authorizeReceipt(principal: StorePrincipal, raw: unknown): ImportReceipt {
    const receipt = parse(importReceiptSchema, raw)
    const source = this.namespace(principal, receipt.projectId, receipt.namespaceId)
    if (receipt.actorId !== principal.person.userId || receipt.deviceId !== principal.deviceId) fail('IMPORT_FORBIDDEN', 'Receipt belongs to another original importer', 403)
    if (receipt.mapping) this.task(principal, source, receipt.mapping.task)
    if (receipt.candidate?.task) this.task(principal, source, receipt.candidate.task)
    return receipt
  }
  private receipt(principal: StorePrincipal, command: ImportCommand, source: ImportNamespace): ImportReceipt {
    return { contractVersion: 1, commandId: command.commandId, projectId: command.projectId, actorId: principal.person.userId, deviceId: principal.deviceId,
      namespaceId: source.namespaceId, importId: 'importId' in command ? command.importId : null, itemKey: null, namespace: null, mapping: null, candidate: null, comparison: null, conflicts: [], reused: false, authority: 'unactivated' }
  }

  command(actor: StoreActor, raw: unknown): TeamCommandReply<ImportReceipt> {
    const command = importCommandSchema.parse(raw)
    return this.host.mutation(actor, command.commandId, 'importCommand', command, p => {
      this.principal(p, command)
      if (command.action === 'enroll') this.space(p, command.projectId, command.spaceId, command.spaceCreatedAt)
      else this.namespace(p, command.projectId, command.namespaceId)
    }, p => {
      let source: ImportNamespace
      if (command.action === 'enroll') {
        this.space(p, command.projectId, command.spaceId, command.spaceCreatedAt, true)
        const existing = this.host.get('SELECT recordJson FROM import_namespaces WHERE projectId=? AND enrollmentKey=?', command.projectId, command.enrollmentKey)
        source = existing ? parse(importNamespaceSchema, existing.recordJson) : importNamespaceSchema.parse({ namespaceId: randomUUID(), projectId: command.projectId, enrollmentKey: command.enrollmentKey, spaceId: command.spaceId, spaceCreatedAt: command.spaceCreatedAt, label: command.label, createdBy: p.person.userId, createdAt: Date.now(), authority: 'unactivated' })
        if (source.spaceId !== command.spaceId || source.spaceCreatedAt !== command.spaceCreatedAt || source.label !== command.label) fail('IMPORT_NAMESPACE_CONFLICT', 'Enrollment key already describes another source mapping')
        if (!existing) {
          const count = this.host.get('SELECT COUNT(*) AS n FROM import_namespaces WHERE projectId=?', command.projectId)
          if (typeof count?.n !== 'number' || count.n >= 1000) fail('CAPACITY_EXCEEDED', 'Project namespace limit reached', 413)
          shareable(canonicalImportJson(source))
          this.host.run('INSERT INTO import_namespaces(namespaceId,projectId,enrollmentKey,spaceId,recordJson) VALUES(?,?,?,?,?)', source.namespaceId, source.projectId, source.enrollmentKey, source.spaceId, JSON.stringify(source))
        }
        this.host.event(p.person.userId, source.projectId, source.namespaceId, null, command.commandId)
        return importReceiptSchema.parse({ ...this.receipt(p, command, source), namespace: source, reused: !!existing })
      }
      source = this.namespace(p, command.projectId, command.namespaceId, true)
      const receipt = this.receipt(p, command, source)
      if (command.action === 'begin') {
        const serialized = canonicalImportJson(command.manifest)
        shareable(serialized)
        if (hash(serialized) !== command.manifestDigest) fail('IMPORT_DIGEST_CONFLICT', 'Import manifest differs from its selected digest')
        this.authors(p, source, command.manifest)
        const previous = this.host.get('SELECT namespaceId,manifestDigest FROM import_batches WHERE importId=?', command.importId)
        if (previous && (previous.namespaceId !== source.namespaceId || previous.manifestDigest !== command.manifestDigest)) fail('IMPORT_IDENTITY_CONFLICT', 'Import identity already describes different fixed source bytes')
        if (!previous) {
          const count = this.host.get('SELECT COUNT(*) AS n FROM import_batches WHERE namespaceId=?', source.namespaceId)
          if (typeof count?.n !== 'number' || count.n >= 2000) fail('CAPACITY_EXCEEDED', 'Source batch limit reached', 413)
          this.host.run('INSERT INTO import_batches(importId,namespaceId,manifestDigest,manifestJson,createdBy,createdAt) VALUES(?,?,?,?,?,?)', command.importId, source.namespaceId, command.manifestDigest, JSON.stringify(command.manifest), p.person.userId, Date.now())
        }
        receipt.reused = !!previous
      } else if (command.action === 'map-task') {
        const { manifest } = this.batch(source, command.importId), local = manifest.tasks.find(t => t.sourceTaskKey === command.sourceTaskKey)
        if (!local) fail('IMPORT_SELECTION_CONFLICT', 'Task identity is not in the original selected manifest')
        this.authors(p, source, manifest)
        let mapping = this.mapping(source, command.sourceTaskKey)
        if (mapping) {
          this.task(p, source, mapping.task)
          if (mapping.originalId !== local.originalId || (command.decision.kind === 'link' && canonicalImportJson(command.decision.task) !== canonicalImportJson(mapping.task))) fail('IMPORT_IDENTITY_CONFLICT', 'Source task already has another original mapping')
          if (!mapping.locations.includes(local.location)) {
            if (!command.aliasFrom || !mapping.locations.includes(command.aliasFrom)) fail('IMPORT_ALIAS_REVIEW_REQUIRED', 'Compare the original location and explicitly confirm its new alias before linking')
            if (mapping.locations.length >= 100) fail('CAPACITY_EXCEEDED', 'Task location alias bound reached', 413)
            mapping = { ...mapping, locations: [...mapping.locations, local.location] }
            this.host.run('UPDATE import_task_mappings SET recordJson=? WHERE namespaceId=? AND sourceTaskKey=?', JSON.stringify(mapping), source.namespaceId, command.sourceTaskKey)
          }
          receipt.reused = true
        } else {
          const collision = this.host.get("SELECT json_extract(t.value,'$.id') AS taskId FROM hifox_workspaces w,json_each(w.snapshotJson,'$.tasks') t WHERE w.projectId=? AND json_extract(t.value,'$.spaceId')=? AND json_extract(t.value,'$.title')=? LIMIT 1", source.projectId, source.spaceId, local.title)
          if (collision) receipt.conflicts.push('NAME_COLLISION')
          let task: TeamTaskRef
          if (command.decision.kind === 'link') {
            this.task(p, source, command.decision.task)
            const workspace = this.host.get('SELECT revision FROM hifox_workspaces WHERE projectId=?', source.projectId)
            if (workspace?.revision !== command.expectedWorkspaceRevision) fail('REVISION_CONFLICT', 'Workspace changed before the explicit task link')
            task = command.decision.task
          } else task = this.host.createTask(p, source.projectId, source.spaceId, local.title, command.expectedWorkspaceRevision)
          mapping = { namespaceId: source.namespaceId, sourceTaskKey: local.sourceTaskKey, originalId: local.originalId, locations: [local.location], task, createdAt: Date.now() }
          this.host.run('INSERT INTO import_task_mappings(namespaceId,sourceTaskKey,recordJson) VALUES(?,?,?)', source.namespaceId, local.sourceTaskKey, JSON.stringify(mapping))
        }
        receipt.mapping = mapping; receipt.itemKey = `task:${hash(command.sourceTaskKey)}`
        if (local.authors.some(a => !manifest.authors.find(m => m.sourceAuthor === a)?.accountId)) receipt.conflicts.push('AUTHOR_UNMAPPED')
      } else {
        const { manifest } = this.batch(source, command.importId), asset = manifest.assets.find(a => a.itemKey === command.itemKey)
        if (!asset) fail('IMPORT_SELECTION_CONFLICT', 'Snapshot is not in the original selected manifest')
        this.authors(p, source, manifest)
        shareable(command.text)
        const bytes = Buffer.from(command.text, 'utf8')
        if (!bytes.length || bytes.length > 1024 * 1024 || bytes.toString('utf8') !== command.text || hash(bytes) !== asset.bodyDigest || bytes.length !== asset.bodyByteLength) fail('IMPORT_DIGEST_CONFLICT', 'Snapshot does not match the original fixed UTF-8 digest and length')
        if (asset.representation === 'source' && (asset.bodyDigest !== asset.sourceDigest || asset.byteLength !== asset.bodyByteLength)) fail('IMPORT_DIGEST_CONFLICT', 'Original source snapshots must retain the exact source bytes')
        if (asset.kind === 'task' && asset.representation === 'source' && !asset.includeOpaqueTaskFields) fail('IMPORT_PRIVATE_CONTENT', 'Original opaque task metadata requires explicit reviewed selection', 422)
        const mapping = asset.sourceTaskKey ? this.mapping(source, asset.sourceTaskKey) : null
        if (asset.sourceTaskKey && !mapping) fail('IMPORT_TASK_MAPPING_REQUIRED', 'Map the original task before staging its selected documents')
        if (mapping) this.task(p, source, mapping.task)
        if (asset.kind === 'context') {
          for (const line of command.text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim())) {
            let entry: unknown
            try { entry = JSON.parse(line) } catch { fail('IMPORT_CONTEXT_INVALID', 'Selected context must be portable JSONL', 422) }
            if (!z.object({ file: teamRelativePathSchema }).passthrough().safeParse(entry).success) fail('IMPORT_CONTEXT_RESOLUTION_REQUIRED', 'Absolute/private context references cannot be uploaded', 422)
          }
        }
        const local = manifest.tasks.find(t => t.sourceTaskKey === asset.sourceTaskKey), sourceAuthors = manifest.authors.filter(a => local?.authors.includes(a.sourceAuthor)).sort((a, b) => a.sourceAuthor < b.sourceAuthor ? -1 : a.sourceAuthor > b.sourceAuthor ? 1 : 0)
        if (asset.representation === 'task-summary' && (!local || command.text !== importTaskSummary(local))) fail('IMPORT_PRIVATE_CONTENT', 'Safe task summaries may contain only the explicitly projected source fields', 422)
        const versionKey = hash(canonicalImportJson({ sourceDigest: asset.sourceDigest, bodyDigest: asset.bodyDigest, purpose: asset.purpose, representation: asset.representation, sourceAuthors }))
        const existing = this.host.get('SELECT recordJson FROM import_candidates WHERE namespaceId=? AND itemKey=? AND versionKey=?', source.namespaceId, asset.itemKey, versionKey)
        const previousRow = this.host.get('SELECT recordJson FROM import_candidates WHERE namespaceId=? AND itemKey=? ORDER BY rowid DESC LIMIT 1', source.namespaceId, asset.itemKey)
        const previous = previousRow ? parse(importCandidateSchema, previousRow.recordJson) : null
        const baseRow = this.host.get('SELECT recordJson FROM import_candidates WHERE namespaceId=? AND itemKey=? ORDER BY rowid LIMIT 1', source.namespaceId, asset.itemKey)
        const base = baseRow ? parse(importCandidateSchema, baseRow.recordJson) : null
        const heads = mapping ? this.host.all('SELECT recordJson FROM task_material_documents WHERE projectId=? AND taskId=? AND spaceId=? AND taskCreatedAt=? ORDER BY documentId LIMIT 501', source.projectId, mapping.task.taskId, mapping.task.spaceId, mapping.task.taskCreatedAt) : []
        if (heads.length > 500) fail('CAPACITY_EXCEEDED', 'Task document comparison exceeds its bound', 413)
        const task = mapping ? this.task(p, source, mapping.task) : null
        const targetFingerprint = task ? hash(canonicalImportJson({ task, heads })) : null
        const comparison = { sourceChanged: !!previous && (previous.asset.sourceDigest !== asset.sourceDigest || previous.asset.bodyDigest !== asset.bodyDigest), teamHeadPresent: heads.length > 0,
          teamHeadChanged: !!base && base.comparison.targetFingerprint !== targetFingerprint, purposeConflict: asset.purpose === 'unresolved' || (asset.purpose === 'developer-prd' && heads.some(h => parse(z.object({ kind: z.string() }).passthrough(), h.recordJson).kind === 'prd')), targetFingerprint }
        const conflicts = [...(comparison.sourceChanged ? ['SOURCE_CHANGED'] : []), ...(comparison.teamHeadPresent ? ['TEAM_HEAD_PRESENT'] : []), ...(comparison.teamHeadChanged ? ['TEAM_HEAD_CHANGED'] : []), ...(comparison.purposeConflict ? ['DOCUMENT_PURPOSE_CONFLICT'] : []), ...(sourceAuthors.some(a => !a.accountId) ? ['AUTHOR_UNMAPPED'] : [])]
        if (existing) { receipt.candidate = parse(importCandidateSchema, existing.recordJson); receipt.reused = true }
        else {
          const candidate: ImportCandidate = importCandidateSchema.parse({ candidateId: randomUUID(), namespaceId: source.namespaceId, importId: command.importId, itemKey: asset.itemKey, asset, baseCandidateId: base?.candidateId ?? null, previousCandidateId: previous?.candidateId ?? null, task: mapping?.task ?? null, sourceAuthors, comparison, conflicts, createdBy: p.person.userId, createdAt: Date.now(), state: 'candidate', approved: false, writerGranted: false })
          const quota = this.host.get('SELECT COALESCE(SUM(byteLength),0) AS total,COUNT(*) AS n FROM blobs')
          if (!this.host.get('SELECT bodyDigest FROM blobs WHERE bodyDigest=?', asset.bodyDigest) && (typeof quota?.total !== 'number' || typeof quota.n !== 'number' || quota.total + bytes.length > 1024 * 1024 * 1024 || quota.n >= 20000)) fail('CAPACITY_EXCEEDED', 'Immutable blob quota reached; existing sources were retained', 507)
          this.host.persistBody(bytes, asset.bodyDigest)
          this.host.run('INSERT OR IGNORE INTO blobs(bodyDigest,byteLength,createdAt) VALUES(?,?,?)', asset.bodyDigest, bytes.length, Date.now())
          this.host.run('INSERT INTO import_candidates(candidateId,namespaceId,importId,itemKey,versionKey,bodyDigest,recordJson) VALUES(?,?,?,?,?,?,?)', candidate.candidateId, source.namespaceId, command.importId, asset.itemKey, versionKey, asset.bodyDigest, JSON.stringify(candidate))
          receipt.candidate = candidate
        }
        receipt.itemKey = asset.itemKey; receipt.comparison = comparison; receipt.conflicts = conflicts
      }
      const parsed = importReceiptSchema.parse(receipt)
      if (parsed.itemKey) this.host.run('INSERT OR IGNORE INTO import_item_receipts(importId,itemKey,recordJson) VALUES(?,?,?)', command.importId, parsed.itemKey, JSON.stringify(parsed))
      this.host.event(p.person.userId, source.projectId, source.namespaceId, command.importId, command.commandId)
      return parsed
    }, (p, receipt) => { this.authorizeReceipt(p, receipt) })
  }

  reconcile(actor: StoreActor, raw: unknown): TeamCommandReply<ImportReceipt> | null {
    const command = importCommandSchema.parse(raw), p = this.host.authenticate(actor)
    this.principal(p, command)
    if (command.action === 'enroll') this.space(p, command.projectId, command.spaceId, command.spaceCreatedAt)
    else this.namespace(p, command.projectId, command.namespaceId)
    const row = this.host.get('SELECT kind,requestHash,resultJson FROM commands WHERE userId=? AND commandId=?', p.person.userId, command.commandId)
    if (!row) return null
    if (row.kind !== 'importCommand' || row.requestHash !== hash(canonicalImportJson({ kind: 'importCommand', input: command }))) fail('COMMAND_CONFLICT', 'Command identity already describes another original intent')
    return { status: 'duplicate', commandId: command.commandId, result: this.authorizeReceipt(p, row.resultJson) }
  }
  namespaces(principal: StorePrincipal, raw: Record<string, unknown>): TeamPage<ImportNamespace> {
    const projectId = teamIdSchema.parse(raw.projectId), query = importListQuerySchema.parse(raw.query ?? {})
    this.host.project(principal, projectId)
    const scope = `import-namespaces:${projectId}`, after = this.host.after(principal, scope, query.cursor)
    const rows = this.host.all('SELECT namespaceId,recordJson FROM import_namespaces WHERE projectId=? AND namespaceId>? ORDER BY namespaceId LIMIT 501', projectId, after)
    return this.host.page(principal, scope, rows, 'namespaceId', query.limit, row => this.readable(() => this.namespace(principal, projectId, String(row.namespaceId))), row => parse(importNamespaceSchema, row.recordJson))
  }
  private readable(action: () => unknown): boolean {
    try { action(); return true } catch (error) { if (error instanceof TeamServiceError && [403, 404].includes(error.statusCode)) return false; throw error }
  }
  items(principal: StorePrincipal, raw: Record<string, unknown>): TeamPage<ImportCandidate> {
    const projectId = teamIdSchema.parse(raw.projectId), query = importListQuerySchema.parse(raw.query ?? {})
    const source = this.namespace(principal, projectId, teamIdSchema.parse(query.namespaceId))
    if (query.importId) this.batch(source, query.importId)
    const scope = `import-items:${source.namespaceId}:${query.importId ?? '*'}`, after = this.host.after(principal, scope, query.cursor)
    const rows = query.importId ? this.host.all('SELECT c.candidateId,c.recordJson FROM import_item_receipts r JOIN import_candidates c ON c.candidateId=json_extract(r.recordJson,\'$.candidate.candidateId\') WHERE r.importId=? AND c.candidateId>? ORDER BY c.candidateId LIMIT 501', query.importId, after)
      : this.host.all('SELECT candidateId,recordJson FROM import_candidates WHERE namespaceId=? AND candidateId>? ORDER BY candidateId LIMIT 501', source.namespaceId, after)
    return this.host.page(principal, scope, rows, 'candidateId', query.limit, row => this.readable(() => { const candidate = parse(importCandidateSchema, row.recordJson); if (candidate.task) this.task(principal, source, candidate.task) }), row => parse(importCandidateSchema, row.recordJson))
  }
  read(principal: StorePrincipal, raw: Record<string, unknown>): { candidate: ImportCandidate; text: string } {
    const projectId = teamIdSchema.parse(raw.projectId), candidateId = teamIdSchema.parse(raw.candidateId)
    this.host.project(principal, projectId)
    const row = this.host.get('SELECT recordJson FROM import_candidates WHERE candidateId=?', candidateId)
    if (!row) unavailable()
    const candidate = parse(importCandidateSchema, row.recordJson), source = this.namespace(principal, projectId, candidate.namespaceId)
    if (candidate.task) this.task(principal, source, candidate.task)
    const bytes = this.host.body(candidate.asset.bodyDigest), text = bytes.toString('utf8')
    if (bytes.length !== candidate.asset.bodyByteLength || hash(bytes) !== candidate.asset.bodyDigest || !Buffer.from(text).equals(bytes)) fail('CORRUPT_STORE', 'Immutable candidate bytes failed verification', 503)
    return { candidate, text }
  }
  batchRead(principal: StorePrincipal, raw: Record<string, unknown>): { manifest: ImportManifest; manifestDigest: string; receipts: TeamPage<ImportReceipt> } {
    const projectId = teamIdSchema.parse(raw.projectId), query = importListQuerySchema.parse(raw.query ?? {}), importId = teamIdSchema.parse(raw.importId)
    const source = this.namespace(principal, projectId, teamIdSchema.parse(query.namespaceId)), batch = this.batch(source, importId)
    const scope = `import-receipts:${source.namespaceId}:${importId}`, after = this.host.after(principal, scope, query.cursor)
    const rows = this.host.all('SELECT itemKey,recordJson FROM import_item_receipts WHERE importId=? AND itemKey>? ORDER BY itemKey LIMIT 501', importId, after)
    return { ...batch, receipts: this.host.page(principal, scope, rows, 'itemKey', query.limit, row => this.readable(() => {
      const receipt = parse(importReceiptSchema, row.recordJson)
      if (receipt.mapping) this.task(principal, source, receipt.mapping.task)
      if (receipt.candidate?.task) this.task(principal, source, receipt.candidate.task)
    }), row => parse(importReceiptSchema, row.recordJson)) }
  }
}
