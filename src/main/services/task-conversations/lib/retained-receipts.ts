import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { OBSERVABILITY_SCHEMA_VERSION, parseContextEvent } from '../../../../shared/observability/schema'
import { OBSERVATION_EVENT_ENCODE_LIMIT_BYTES, OBSERVATION_PHYSICAL_SOFT_LIMIT_BYTES } from '../../../../shared/observability/store'
import { installationDir, INSTALLATION_FILE_NAME, BINDING_FILE_NAME, sameRoot } from '../../observability/identity'
import { OBSERVATIONS_DB_FILE, STORE_DB_VERSION, stableStringify } from '../../observability/store-core'
import { runtimeDirOf } from '../../task-identity'
import type { NativeTaskEvidence } from '../types'
import { nativeTaskDir } from './identity'
import { canonicalRoot, nativeSessionId, ownedPath, readBounded } from './paths'

export const RETAINED_RECEIPT_LIMITS = { rows: 512, payloadBytes: 2 * 1024 * 1024, identityBytes: 16 * 1024, busyMs: 5 } as const
const id = z.string().min(1).max(256)
// Same fixed fields as observability readBinding/readInstallationIdentity, with bounded reads
// and an explicit binding version check (the older readBinding reader normalizes that field).
const bindingSchema = z.object({
  schemaVersion: z.literal(1), installationId: id, repositoryId: id, workspaceId: id,
  canonicalRoot: z.string().min(1).max(4096), boundAtMs: z.number().finite(), collectionEnabled: z.literal(true)
})
const installationSchema = z.object({ installationId: z.string().min(8).max(256), createdAtMs: z.number().finite() })
const rowSchema = z.object({
  seq: z.number().int().positive(),
  eventId: id, injectionId: id, payloadDigest: z.string().regex(/^[0-9a-f]{64}$/),
  kind: z.literal('context.emitted'), repositoryId: id, workspaceId: id,
  taskRef: z.string().max(256).nullable(), occurredAtMs: z.number().int().positive(),
  payloadBytes: z.number().int().positive().max(OBSERVATION_EVENT_ENCODE_LIMIT_BYTES)
})

function rollbackDatabase(file: string): boolean {
  if (!statSync(file).isFile() || statSync(file).size > OBSERVATION_PHYSICAL_SOFT_LIMIT_BYTES) return false
  // Refuse WAL/hot journal files before opening SQLite, which could otherwise create/recover
  // sidecars even through a read-only connection. The observation contract uses DELETE mode.
  if (['-journal', '-wal', '-shm'].some(suffix => existsSync(file + suffix))) return false
  const handle = openSync(file, 'r')
  try {
    const header = Buffer.alloc(100)
    return readSync(handle, header, 0, header.length, 0) === header.length
      && header.subarray(0, 16).toString('ascii') === 'SQLite format 3\0' && header[18] === 1 && header[19] === 1
  } finally { closeSync(handle) }
}

/** Optional read-only candidate feed. Does not create, enable, migrate, repair or clear observations.
 * Native session/project/role validation and durable identity decisions still belong to importHistory.
 */
export function readRetainedReceiptEvidence(root: string): NativeTaskEvidence[] {
  let db: DatabaseSync | undefined
  try {
    if (process.env.TRELLIS_RECEIPTS === 'off') return []
    const canonical = canonicalRoot(root), runtime = runtimeDirOf(canonical)
    const file = ownedPath(canonical, join(runtime, OBSERVATIONS_DB_FILE))
    const bindingFile = ownedPath(canonical, join(runtime, BINDING_FILE_NAME))
    const binding = bindingSchema.parse(JSON.parse(readBounded(bindingFile, RETAINED_RECEIPT_LIMITS.identityBytes)))
    const localInstallDir = installationDir()
    const installationFile = ownedPath(localInstallDir, join(localInstallDir, INSTALLATION_FILE_NAME))
    const installation = installationSchema.parse(JSON.parse(readBounded(installationFile, RETAINED_RECEIPT_LIMITS.identityBytes)))
    if (binding.installationId !== installation.installationId || !isAbsolute(binding.canonicalRoot)
      || !sameRoot(canonicalRoot(binding.canonicalRoot), canonical) || !rollbackDatabase(file)) return []
    db = new DatabaseSync(file, { readOnly: true })
    db.exec(`PRAGMA busy_timeout=${RETAINED_RECEIPT_LIMITS.busyMs}; PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN;`)
    const tables = db.prepare("SELECT name,substr(sql,1,128) AS sql FROM sqlite_master WHERE type='table' AND name IN ('schema_meta','events','store_usage') LIMIT 3").all()
    if (tables.length !== 3 || tables.some(table => typeof table.sql !== 'string' || !/^CREATE TABLE\b/i.test(table.sql))) return []
    const columns = db.prepare('PRAGMA table_info(events)').all()
    if (!columns.some(column => column.name === 'seq' && column.type === 'INTEGER' && column.pk === 1)) return []
    const metadata = new Map(db.prepare("SELECT key,substr(value,1,129) AS value FROM schema_meta WHERE key IN ('dbVersion','protocolMin','protocolMax','migrationState','storeEpoch') LIMIT 5")
      .all().map(row => [row.key, row.value]))
    const epoch = metadata.get('storeEpoch')
    if (metadata.get('dbVersion') !== String(STORE_DB_VERSION) || metadata.get('protocolMin') !== String(OBSERVABILITY_SCHEMA_VERSION)
      || metadata.get('protocolMax') !== String(OBSERVABILITY_SCHEMA_VERSION) || metadata.get('migrationState') !== 'applied'
      || typeof epoch !== 'string' || !epoch.length || epoch.length > 128) return []
    const usage = db.prepare('SELECT collectionMode,pauseReason FROM store_usage WHERE id=1').get()
    if (!usage || usage.pauseReason === 'collection_disabled' || !['active', 'paused'].includes(String(usage.collectionMode))) return []
    // First read bounded metadata, then fetch payloads by primary key within the shared byte
    // budget. Avoid a live SQLite iterator retaining a source-file handle across close on Windows.
    const rows = db.prepare(`SELECT seq,substr(eventId,1,257) AS eventId,substr(injectionId,1,257) AS injectionId,
      substr(payloadDigest,1,65) AS payloadDigest,substr(kind,1,64) AS kind,
      substr(repositoryId,1,257) AS repositoryId,substr(workspaceId,1,257) AS workspaceId,
      substr(taskRef,1,257) AS taskRef,occurredAtMs,payloadBytes
      FROM events ORDER BY seq DESC LIMIT ?`).all(RETAINED_RECEIPT_LIMITS.rows)
    const evidence = new Map<string, NativeTaskEvidence>(), injections = new Set<string>()
    let bytes = 0
    for (const rawRow of rows) {
      const parsed = rowSchema.safeParse(rawRow)
      if (!parsed.success) continue
      const row = parsed.data
      bytes += row.payloadBytes
      if (bytes > RETAINED_RECEIPT_LIMITS.payloadBytes) break
      if (row.repositoryId !== binding.repositoryId || row.workspaceId !== binding.workspaceId || injections.has(row.injectionId)) continue
      try {
        const payload = db.prepare(`SELECT CASE WHEN payloadBytes=? AND length(CAST(payload AS BLOB))=payloadBytes
          THEN payload ELSE NULL END AS payload FROM events WHERE seq=?`).get(row.payloadBytes, row.seq)?.payload
        if (typeof payload !== 'string' || Buffer.byteLength(payload, 'utf8') !== row.payloadBytes) continue
        const raw: unknown = JSON.parse(payload), parsedEvent = parseContextEvent(raw)
        if (!parsedEvent.success) continue
        const event = parsedEvent.event
        if (event.kind !== 'context.emitted' || event.producer.host !== 'codex' || event.scope.association !== 'resolved'
          || event.eventId !== row.eventId || event.injectionId !== row.injectionId || event.occurredAtMs !== row.occurredAtMs
          || event.scope.repositoryId !== binding.repositoryId || event.scope.workspaceId !== binding.workspaceId
          || event.scope.taskRef !== row.taskRef || !event.session.parentId || !nativeSessionId('codex', event.session.parentId)
          || !event.scope.trellisTaskId || event.scope.trellisTaskId.length > 256 || !event.scope.taskPath
          || !/^\.trellis[\\/]tasks[\\/]/.test(event.scope.taskPath)) continue
        if (createHash('sha256').update(stableStringify(raw), 'utf8').digest('hex') !== row.payloadDigest) continue
        const taskDir = nativeTaskDir(canonical, event.scope.taskPath)
        if (!taskDir) continue
        injections.add(event.injectionId)
        const hint: NativeTaskEvidence = { source: 'codex', sessionId: event.session.parentId,
          taskDir, trellisId: event.scope.trellisTaskId, occurredAt: event.occurredAtMs }
        evidence.set(JSON.stringify([hint.sessionId, hint.taskDir, hint.trellisId]), hint)
      } catch { /* A malformed payload never disables the other retained/native sources. */ }
    }
    return [...evidence.values()]
  } catch { return [] }
  finally { try { db?.close() } catch { /* Optional feed must not affect ordinary native history. */ } }
}
