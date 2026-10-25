import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep, isAbsolute } from 'node:path'
import { z } from 'zod'
import { TeamServiceError } from './errors'
import { TEAM_SCHEMA_VERSION } from './store-schema'
import { fileDigest } from './files'

const backupManifestSchema = z.object({ schemaVersion: z.literal(1), databaseSchemaVersion: z.number().int().min(1).max(TEAM_SCHEMA_VERSION).optional(), databaseDigest: z.string().regex(/^[a-f0-9]{64}$/), instanceId: z.string().uuid(), epoch: z.string().uuid(), blobs: z.array(z.object({ digest: z.string().regex(/^[a-f0-9]{64}$/), byteLength: z.number().int().min(1).max(1024 * 1024) }).strict()).max(20_000), createdAt: z.number().int().nonnegative() }).strict()
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
export function restoreTeamBackup(source: string, destination: string): { destination: string; blobCount: number; instanceId: string; epoch: string } {
  const from = realpathSync(resolve(source)); const requested = resolve(destination); const target = join(realpathSync(dirname(requested)), basename(requested))
  const rel = relative(from, target)
  if (rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))) throw new TeamServiceError('INVALID_BACKUP', 'Restore destination must be outside the backup')
  if (existsSync(target)) throw new TeamServiceError('INVALID_BACKUP', 'Restore target must be a new stopped directory; never overwrite an active store', 409)
  const manifestPath = join(from, 'backup.json')
  if (realpathSync(manifestPath) !== manifestPath || statSync(manifestPath).size > 4 * 1024 * 1024) throw new TeamServiceError('INVALID_BACKUP', 'Backup manifest path/size exceeds its bound')
  const manifest = backupManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')))
  const database = join(from, 'team.sqlite')
  if (realpathSync(database) !== database || fileDigest(database) !== manifest.databaseDigest) throw new TeamServiceError('CORRUPT_BACKUP', 'Backup database path/digest failed verification', 409)
  const temporary = join(dirname(target), `.team-restore-${randomUUID()}`)
  mkdirSync(temporary, { mode: 0o700 }); mkdirSync(join(temporary, 'blobs'), { mode: 0o700 })
  copyFileSync(database, join(temporary, 'team.sqlite'))
  if (fileDigest(join(temporary, 'team.sqlite')) !== manifest.databaseDigest) throw new TeamServiceError('CORRUPT_BACKUP', 'Backup database changed during copy', 409)
  const check = new DatabaseSync(join(temporary, 'team.sqlite'), { readOnly: true })
  let authorizationRevision = 0
  try {
    const version = check.prepare('PRAGMA user_version').get()?.user_version
    if (typeof version !== 'number' || version < 1 || version > TEAM_SCHEMA_VERSION || (manifest.databaseSchemaVersion !== undefined && version !== manifest.databaseSchemaVersion) || check.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw new TeamServiceError('CORRUPT_BACKUP', 'Backup database schema/integrity failed verification', 409)
    const meta = (key: string): unknown => check.prepare('SELECT value FROM team_meta WHERE key=?').get(key)?.value
    if (meta('instanceId') !== manifest.instanceId || meta('epoch') !== manifest.epoch) throw new TeamServiceError('CORRUPT_BACKUP', 'Backup cursor identity does not match its manifest', 409)
    const revision = meta('authorizationRevision'), secret = meta('cursorSecret')
    if (typeof revision !== 'string' || !/^[1-9][0-9]*$/.test(revision) || !Number.isSafeInteger(Number(revision)) || Number(revision) >= Number.MAX_SAFE_INTEGER || typeof secret !== 'string' || !/^[a-f0-9]{64}$/.test(secret)) throw new TeamServiceError('CORRUPT_BACKUP', 'Backup authorization identity failed verification or cannot advance safely', 409)
    authorizationRevision = Number(revision)
    const referenced = check.prepare('SELECT bodyDigest,byteLength FROM blobs ORDER BY bodyDigest').all()
    if (referenced.length !== manifest.blobs.length || referenced.some((row) => !manifest.blobs.some((blob) => blob.digest === row.bodyDigest && blob.byteLength === row.byteLength))) throw new TeamServiceError('CORRUPT_BACKUP', 'Backup body references are incomplete', 409)
    for (const blob of manifest.blobs) {
      const path = join(from, 'blobs', blob.digest)
      if (realpathSync(path) !== path || statSync(path).size !== blob.byteLength) throw new TeamServiceError('CORRUPT_BACKUP', 'Backup body path/length failed verification', 409)
      const body = readFileSync(path)
      if (digest(body) !== blob.digest) throw new TeamServiceError('CORRUPT_BACKUP', 'Backup body digest failed verification', 409)
      writeFileSync(join(temporary, 'blobs', blob.digest), body, { mode: 0o600, flag: 'wx' })
    }
  } finally { check.close() }
  // Rotate only the verified staged copy; the source backup retains its original identities and digest.
  const epoch = randomUUID(), cursorSecret = randomBytes(32).toString('hex')
  const restored = new DatabaseSync(join(temporary, 'team.sqlite'))
  try {
    restored.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;')
    try {
      const update = restored.prepare('UPDATE team_meta SET value=? WHERE key=?')
      update.run(epoch, 'epoch'); update.run(cursorSecret, 'cursorSecret'); update.run(String(authorizationRevision + 1), 'authorizationRevision')
      restored.exec('COMMIT')
    } catch (error) { restored.exec('ROLLBACK'); throw error }
  } finally { restored.close() }
  // Publish only a fully verified new directory; leave failed temporary data for inspection.
  renameSync(temporary, target)
  return { destination: target, blobCount: manifest.blobs.length, instanceId: manifest.instanceId, epoch }
}
