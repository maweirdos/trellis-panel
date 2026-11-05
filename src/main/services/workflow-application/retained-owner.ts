import { DatabaseSync } from 'node:sqlite'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { workflowRunSchema, workflowScopeSchema, workflowScopeIdentity } from '../../../shared/workflow'
import { DaemonError } from '../../daemon/errors'
import { readBounded } from '../../daemon/files'
import { workspaceProjects } from '../workflow-admission'
import { resolveWorkcopy } from '../workcopy-use/identity'
import { sameWorkcopy } from '../workcopy-use/registry'
import { resolveAuthorizedDocumentPath } from '../documents/paths'

const identitySchema = z.object({ schemaVersion: z.literal(1), canonicalRoot: z.string().min(1), projectId: z.string().min(1), repositoryId: z.string().min(1), workspaceId: z.string().min(1) }).strict()
const ownerSchema = z.object({ workspaceKey: z.string(), scopeKey: z.string(), scopeJson: z.string(), ownerId: z.string().min(1), pid: z.number().int().positive(), fencingToken: z.number().int().positive(), leaseUntil: z.number().int().nonnegative(), state: z.enum(['active', 'released', 'recovery-required']), updatedAt: z.number().int().nonnegative() }).strict()
const fold = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path
function reject(message: string): never { throw new DaemonError('E_CONFLICT', message) }

/** Read original legacy stores only. Never initialize an application, create a
 * marker/database, migrate its schema, rekey its identities or release its owner. */
export async function assertRetainedWorkflowAvailable(root: string, knownRoots: string[] = [], assertCurrent: () => void = () => {}): Promise<void> {
  const identity = resolveWorkcopy(root), candidates = new Map<string, { root: string; registered: boolean }>()
  const add = (path: string, registered: boolean): void => {
    const key = fold(path), prior = candidates.get(key)
    candidates.set(key, { root: path, registered: registered || Boolean(prior?.registered) })
  }
  add(realpathSync.native(root), false)
  for (const known of knownRoots) add(known, false)
  let current = realpathSync.native(root)
  for (let depth = 0; ; depth++) {
    if (depth >= 64) reject('Legacy workspace discovery exceeds the physical ancestor bound.')
    add(current, false)
    assertCurrent()
    const references = await workspaceProjects(current)
    assertCurrent()
    for (const reference of references) add(reference, true)
    if (dirname(current) === current) break
    current = dirname(current)
  }
  if (candidates.size > 512) reject('Retained workspace discovery exceeds its bounded root inventory.')
  for (const candidate of candidates.values()) {
    assertCurrent()
    let canonical: string
    try { canonical = realpathSync.native(candidate.root) }
    catch { if (candidate.registered) reject('A registered legacy workspace is unavailable; ownership is unknown.'); else continue }
    const observation = resolveWorkcopy(canonical)
    if (!sameWorkcopy(identity, observation)) {
      if (candidate.registered) reject('A registered legacy workspace changed its physical boundary.')
      continue
    }
    const relativeDir = '.trellis/.panel/runtime', directory = join(canonical, relativeDir)
    const marker = join(directory, 'workflow-local-identity.json'), database = join(directory, 'control.sqlite')
    if (!existsSync(marker) && !existsSync(database)) {
      if (candidate.registered) reject('A registered legacy store lost its original identity or database.')
      continue
    }
    if (!resolveAuthorizedDocumentPath(canonical, relativeDir + '/workflow-local-identity.json').ok
      || !resolveAuthorizedDocumentPath(canonical, relativeDir + '/control.sqlite').ok || !existsSync(marker) || !existsSync(database)) reject('Original legacy store identity cannot be verified.')
    const pinned = identitySchema.parse(JSON.parse(readBounded(marker, 16 * 1024)))
    if (fold(pinned.canonicalRoot) !== fold(canonical)) reject('Original legacy identity belongs to another physical project.')
    const before = lstatSync(database)
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 512 * 1024 * 1024) reject('Original legacy control database is not a bounded regular file.')
    const db = new DatabaseSync(database, { readOnly: true })
    try {
      db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN;')
      const version = db.prepare("SELECT value FROM workflow_meta WHERE key='schemaVersion'").get()
      if (version?.value !== '1') reject('Original legacy control schema requires its retained recovery owner.')
      const owners = db.prepare('SELECT * FROM workflow_owners LIMIT 257').all()
      if (owners.length > 256) reject('Original legacy owner inventory exceeds its bound.')
      for (const row of owners) {
        const owner = ownerSchema.parse(row), scope = workflowScopeSchema.parse(JSON.parse(owner.scopeJson))
        if (scope.projectId !== pinned.projectId || scope.repositoryId !== pinned.repositoryId || scope.workspaceId !== pinned.workspaceId
          || owner.scopeKey !== workflowScopeIdentity(scope) || owner.workspaceKey !== JSON.stringify([scope.repositoryId, scope.workspaceId])) reject('Original legacy owner differs from its retained physical identity.')
        // Lease age/controller death cannot establish native shutdown.
        if (owner.state !== 'released') reject('Original legacy workflow still owns this physical workspace or requires cleanup.')
      }
      const unknown = db.prepare("SELECT operationId FROM workflow_dispatch_outbox WHERE state IN ('dispatched','outcome-unknown') LIMIT 1").get()
      if (unknown) reject('Original legacy native effects remain unresolved.')
      const runs = db.prepare('SELECT runJson FROM workflow_runs LIMIT 2049').all()
      if (runs.length > 2048) reject('Original legacy run inventory exceeds its inspection bound.')
      for (const row of runs) {
        if (typeof row.runJson !== 'string' || row.runJson.length > 1024 * 1024) reject('Original legacy run is unavailable.')
        const run = workflowRunSchema.parse(JSON.parse(row.runJson))
        if (run.state === 'outcome-unknown' || !['verified', 'failed', 'stopped', 'cancelled'].includes(run.state)) reject('Original legacy run has no confirmed terminal native boundary.')
      }
    } finally { db.close() }
    const after = lstatSync(database)
    if (after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || !sameWorkcopy(identity, resolveWorkcopy(root))) reject('Original legacy control store changed during inspection.')
  }
  assertCurrent()
}
