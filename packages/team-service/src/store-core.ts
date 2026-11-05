import { DatabaseSync, backup as sqliteBackup, type SQLInputValue, type SQLOutputValue } from 'node:sqlite'
import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import {
  createTeamSchema, createTeamProjectSchema, teamMemberInputSchema, projectMemberInputSchema, teamPersonStatusInputSchema,
  publicationInputSchema, teamFeedbackInputSchema, deviceEnrollmentInputSchema, deviceApproveInputSchema,
  deviceRevokeInputSchema, deviceHeartbeatInputSchema, teamEventsInputSchema, teamListInputSchema, teamPageInputSchema,
  teamSourceSchema, teamIdSchema, teamCommandIdSchema, type TeamPerson, type TeamProject, type TeamMaterialVersion,
  type TeamPublishedDocument, type TeamFeedback, type TeamDevice, type TeamEvent, type TeamEventPage,
  type TeamCommandReply, type TeamVisibility, type TeamPage, TEAM_MAX_PAGE_ITEM_BYTES
} from '../../../src/shared/team-platform'
import { TeamServiceError, requireValue } from './errors'
import { fileDigest } from './files'
import { TEAM_SCHEMA_VERSION, TEAM_SCHEMA_SQL, TEAM_DEVICES_SQL, TEAM_INVITATION_SPACES_SQL, TEAM_INVITATION_SPACE_IDENTITY_SQL } from './store-schema'
import type { StoreActor, StoreOptions, StorePrincipal, StoreOperation } from './store-types'
import { TEAM_COLLABORATION_SQL } from './collaboration-schema'
import { TeamCollaboration } from './collaboration'
import { TEAM_INVITATIONS_SQL } from './invitations-schema'
import { TeamInvitations } from './invitations'
import { TeamHifoxWorkspace } from './hifox-workspace'
import { TEAM_HIFOX_WORKSPACE_SQL, TEAM_HIFOX_WORKSPACE_TRIGGERS_SQL } from './hifox-workspace-schema'
import { TeamCreations } from './creations'
import { TEAM_CREATIONS_SQL } from './creations-schema'
import { TEAM_LOCAL_AUTH_SQL } from './local-auth-schema'
import { TEAM_LOCAL_ISSUER, teamLocalUsernameSchema } from '../../../src/shared/team-auth'
import { TeamTaskProgress } from './task-progress'
import { TEAM_TASK_PROGRESS_SQL, TEAM_TASK_PROGRESS_IDENTITIES_SQL } from './task-progress-schema'
import { TeamCodeResources } from './code-resources'
import { TEAM_CODE_RESOURCES_SQL } from './code-resources-schema'
import { TeamTaskMaterials, type TaskMaterialsHost } from './task-materials'
import { TEAM_TASK_MATERIALS_SQL } from './task-materials-schema'
import { TeamContent } from './content'
import { TEAM_CONTENT_SQL } from './content-schema'
import { TeamGovernance, type GovernanceHost } from './governance'
import { TeamTaskInputs } from './task-inputs'
import { TEAM_GOVERNANCE_SQL } from './governance-schema'
import { teamTaskDevelopmentContextSchema, type TeamTaskDevelopmentContext } from '../../../src/shared/team-task-development'
import { teamTaskProgressResourceIdSchema } from '../../../src/shared/team-task-progress'
import { TeamTaskExecutions } from './task-executions'
import { TEAM_TASK_EXECUTIONS_SQL, TEAM_TASK_EXECUTION_BOUNDARY_SQL } from './task-executions-schema'
import { teamTaskRefSchema } from '../../../src/shared/team-task-execution'

type Row = Record<string, SQLOutputValue>
const actorSchema = z.object({ kind: z.enum(['session', 'device']), credentialHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
const actorInputSchema = z.object({ actor: actorSchema }).passthrough()
const rolesSchema = z.array(z.string().min(1).max(50)).min(1).max(10)
const now = (): number => Date.now()
const digest = (input: string | Buffer): string => createHash('sha256').update(input).digest('hex')
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}'
  if (value === undefined) throw new TeamServiceError('INVALID_INPUT', 'Undefined JSON value')
  return JSON.stringify(value)
}
const text = (row: Row, key: string): string => { const value = row[key]; if (typeof value !== 'string') throw new TeamServiceError('CORRUPT_STORE', 'Stored text is invalid', 503); return value }
const integer = (row: Row, key: string): number => { const value = row[key]; if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new TeamServiceError('CORRUPT_STORE', 'Stored number is invalid', 503); return value }
const json = (row: Row, key: string): unknown => JSON.parse(text(row, key))
const uniqueRoles = (value: string[]): string[] => { if (new Set(value).size !== value.length) throw new TeamServiceError('INVALID_INPUT', 'Duplicate role or capability'); return [...value].sort() }
const id = (value: unknown): string => teamIdSchema.parse(value)
const forbidden = (): never => { throw new TeamServiceError('FORBIDDEN', 'Current account or device is not authorized', 403) }
const safeEqual = (left: string, right: string): boolean => { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b) }
const MAX_DOCUMENT_BYTES = 1024 * 1024
const MAX_BLOB_BYTES = 1024 * 1024 * 1024
const MAX_DIRECTORY_ENTRIES = 20_000

export class TeamStoreCore {
  private readonly validateTaskOutputOrigin: TaskMaterialsHost['validateOriginBundle'] = (principal, scope, inputBundle) => {
    const bundle = this.taskInputs.revision(principal, { projectId: scope.projectId, taskId: scope.taskId, revision: inputBundle.revision,
      query: { spaceId: scope.spaceId, taskCreatedAt: scope.taskCreatedAt } })
    if (bundle.projectId !== scope.projectId || bundle.taskId !== scope.taskId || bundle.spaceId !== scope.spaceId || bundle.taskCreatedAt !== scope.taskCreatedAt
      || bundle.bundleId !== inputBundle.bundleId || bundle.revision !== inputBundle.revision || bundle.digest !== inputBundle.digest) {
      throw new TeamServiceError('TASK_MATERIAL_ORIGIN_CONFLICT', 'Native output origin does not match the original task input bundle', 409)
    }
  }
  private readonly governanceHost: GovernanceHost = {
    identity: () => ({ instanceId: this.meta('instanceId'), epoch: this.meta('epoch'), authorizationRevision: Number(this.meta('authorizationRevision')) }),
    get: (...args) => this.get(...args), all: (...args) => this.all(...args), run: (...args) => this.run(...args),
    authenticate: actor => this.authenticate(actor), project: (p, projectId) => { this.project(p, projectId) },
    mutation: (...args) => this.mutation(...args), after: (...args) => this.listAfter(...args), page: (...args) => this.page(...args),
    material: (principal, materialId, version) => { const row = this.versionRow(materialId, version); if (!this.canRead(principal, row)) forbidden(); return this.material(row) },
    body: bodyDigest => this.blob(bodyDigest), persistBody: (bytes, bodyDigest) => this.persistBlob(bytes, bodyDigest),
    validateOriginBundle: this.validateTaskOutputOrigin
  }
  private readonly governance = new TeamGovernance(this.governanceHost)
  private readonly taskInputs = new TeamTaskInputs(this.governanceHost, this.governance)
  private readonly db: DatabaseSync
  private readonly directory: string
  private readonly lockId = randomUUID()
  private readonly lockPath: string
  private isClosed = false
  private readonly content = new TeamContent({
    identity: () => ({ instanceId: this.meta('instanceId'), epoch: this.meta('epoch') }),
    get: (...args) => this.get(...args), all: (...args) => this.all(...args), run: (...args) => this.run(...args),
    transaction: (fn) => this.transaction(fn), authenticate: (actor) => this.authenticate(actor),
    project: (p, projectId) => { this.project(p, projectId) }, teamAdmin: (p, teamId) => this.teamAdmin(p, teamId),
    rules: (p, { projectId, taskId, spaceId, taskCreatedAt }) => this.taskInputs.contentRules(p, { projectId, taskId, query: { spaceId, taskCreatedAt } }),
    rule: (p, { projectId, taskId, spaceId, taskCreatedAt }, packageId, versionId) => this.taskInputs.readContentRule(p, { projectId, taskId, query: { spaceId, taskCreatedAt }, packageId, versionId }),
    material: (p, projectId, documentId, version) => {
      this.project(p, projectId)
      const row = this.versionRow(documentId, version)
      if (text(row, 'projectId') !== projectId || text(row, 'visibility') === 'personal' || !this.canRead(p, row)) forbidden()
      const material = this.material(row)
      const body = this.blob(material.bodyDigest), content = body.toString('utf8')
      if (body.length !== material.byteLength || !Buffer.from(content, 'utf8').equals(body)) throw new TeamServiceError('CORRUPT_STORE', 'Content material bytes are not valid original UTF-8 text', 503)
      return { documentId, version, title: material.title, bodyDigest: material.bodyDigest, text: content }
    }
  })
  private readonly taskMaterials = new TeamTaskMaterials({
    identity: () => ({ instanceId: this.meta('instanceId'), epoch: this.meta('epoch'), authorizationRevision: Number(this.meta('authorizationRevision')) }),
    get: (...args) => this.get(...args), all: (...args) => this.all(...args), run: (...args) => this.run(...args),
    authenticate: (actor) => this.authenticate(actor), project: (p, projectId) => { this.project(p, projectId) },
    mutation: (...args) => this.mutation(...args), after: (...args) => this.listAfter(...args), page: (...args) => this.page(...args),
    material: (principal, materialId, version) => {
      const row = this.versionRow(materialId, version)
      if (!this.canRead(principal, row)) forbidden()
      return this.material(row)
    },
    body: (bodyDigest) => this.blob(bodyDigest), persistBody: (bytes, bodyDigest) => this.persistBlob(bytes, bodyDigest),
    validateOriginBundle: this.validateTaskOutputOrigin,
    workspaceChanged: (projectId) => this.hifox.materialsChanged(projectId)
  })
  private readonly codeResources = new TeamCodeResources({
    identity: () => ({ instanceId: this.meta('instanceId'), epoch: this.meta('epoch'), authorizationRevision: Number(this.meta('authorizationRevision')) }),
    get: (...args) => this.get(...args), all: (...args) => this.all(...args), run: (...args) => this.run(...args),
    authenticate: (actor) => this.authenticate(actor), project: (p, projectId) => { this.project(p, projectId) },
    mutation: (...args) => this.mutation(...args), after: (...args) => this.listAfter(...args), page: (...args) => this.page(...args),
    invalidateExecution: (...args) => this.executions.invalidateResource(...args)
  })
  private readonly taskProgress = new TeamTaskProgress({
    identity: () => ({ instanceId: this.meta('instanceId'), epoch: this.meta('epoch'), authorizationRevision: Number(this.meta('authorizationRevision')) }),
    get: (...args) => this.get(...args), all: (...args) => this.all(...args), run: (...args) => this.run(...args),
    authenticate: (actor) => this.authenticate(actor), project: (p, projectId) => { this.project(p, projectId) },
    transaction: (fn) => this.transaction(fn),
    assertNoExecutionWriter: (...args) => this.executions.assertNoWriter(...args)
  })
  private readonly executions = new TeamTaskExecutions({
    identity: () => ({ instanceId: this.meta('instanceId'), epoch: this.meta('epoch'), authorizationRevision: Number(this.meta('authorizationRevision')) }),
    get: (...args) => this.get(...args), all: (...args) => this.all(...args), run: (...args) => this.run(...args),
    authenticate: actor => this.authenticate(actor), project: (p, projectId) => { this.project(p, projectId) },
    mutation: (...args) => this.mutation(...args),
    inputs: (p, task) => this.taskInputs.read(p, { projectId: task.projectId, taskId: task.taskId, query: { spaceId: task.spaceId, taskCreatedAt: task.taskCreatedAt } }),
    dependency: (p, task, ref) => this.taskInputs.validateExecutionDependency(p, task, ref),
    transition: (...args) => this.hifox.executionTransition(...args),
    event: (actorId, task, executionId, commandId, kind) => this.event('task.execution-changed', 'personal', actorId, task.projectId, { taskId: task.taskId, spaceId: task.spaceId, executionId, commandId, kind })
  })
  private readonly creations = new TeamCreations({
    identity: () => ({ epoch: this.meta('epoch'), authorizationRevision: Number(this.meta('authorizationRevision')) }),
    get: (...args) => this.get(...args), all: (...args) => this.all(...args), run: (...args) => this.run(...args),
    authenticate: (actor) => this.authenticate(actor), project: (p, projectId) => { this.project(p, projectId) },
    mutation: (...args) => this.mutation(...args), after: (...args) => this.listAfter(...args), page: (...args) => this.page(...args)
  })
  private readonly hifox = new TeamHifoxWorkspace({
    identity: () => ({ instanceId: this.meta('instanceId'), epoch: this.meta('epoch'), authorizationRevision: Number(this.meta('authorizationRevision')) }),
    get: (...args) => this.get(...args), all: (...args) => this.all(...args), run: (...args) => this.run(...args),
    authenticate: (actor) => this.authenticate(actor), project: (p, projectId) => { this.project(p, projectId) },
    mutation: (...args) => this.mutation(...args), transaction: (fn) => this.transaction(fn),
    invalidateProgress: (...args) => { this.taskProgress.reconcileWorkspace(...args); this.executions.reconcileWorkspace(...args) },
    validateTaskTransitionInputs: (...args) => { this.taskInputs.validateTaskTransitionInputs(...args); this.executions.validateTransition(args[0], args[1], args[2], args[4]) }
  })
  private readonly invitations = new TeamInvitations({
    issuer: () => this.options.issuer,
    epoch: () => this.meta('epoch'),
    get: (...args) => this.get(...args), all: (...args) => this.all(...args), run: (...args) => this.run(...args),
    admin: (...args) => this.teamAdmin(...args), project: (p, projectId) => { this.project(p, projectId) },
    principalFor: (userId) => ({ person: this.person(requireValue(this.get('SELECT * FROM people WHERE userId=? AND active=1', userId), 'FORBIDDEN', 'Invitation creator is unavailable', 403)), actor: { kind: 'session', credentialHash: '' }, deviceId: null, projectId: null, csrfToken: null }),
    mutation: (...args) => this.mutation(...args), event: (...args) => this.event(...args),
    bumpAuthorization: () => this.bumpAuthorization(), after: (...args) => this.listAfter(...args), page: (...args) => this.page(...args)
  })
  private readonly collaboration = new TeamCollaboration({
    get: (sql, ...params) => this.get(sql, ...params), all: (sql, ...params) => this.all(sql, ...params), run: (sql, ...params) => this.run(sql, ...params),
    version: (p, materialId, version) => {
      const row = this.versionRow(materialId, version); if (!this.canRead(p, row)) forbidden()
      return { materialId, version, bodyDigest: text(row, 'bodyDigest'), projectId: text(row, 'projectId'), teamId: text(row, 'teamId'), ownerId: text(row, 'ownerId'), visibility: text(row, 'visibility') as TeamVisibility }
    },
    body: (bodyDigest) => this.blob(bodyDigest).toString('utf8'), project: (p, projectId) => { this.project(p, projectId) },
    member: (userId, projectId) => {
      const person = this.get('SELECT active FROM people WHERE userId=?', userId); if (!person || person.active !== 1) return null
      const row = this.projectMembership(userId, projectId); return row ? rolesSchema.parse(json(row, 'rolesJson')) : null
    },
    principalFor: (userId) => ({ person: this.person(requireValue(this.get('SELECT * FROM people WHERE userId=? AND active=1', userId), 'NOT_FOUND', 'Active person unavailable')), actor: { kind: 'session', credentialHash: '' }, deviceId: null, projectId: null, csrfToken: null }),
    mutation: (...args) => this.mutation(...args), event: (...args) => this.event(...args),
    after: (...args) => this.listAfter(...args), page: (...args) => this.page(...args)
  })
  constructor(private readonly options: StoreOptions) {
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 })
    this.directory = realpathSync(resolve(options.dataDir))
    this.lockPath = join(this.directory, 'service.lock')
    this.acquireLock()
    let database: DatabaseSync | undefined
    try {
      database = new DatabaseSync(join(this.directory, 'team.sqlite'))
      this.db = database
      this.db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;')
      const version = this.get('PRAGMA user_version')
      const current = version ? integer(version, 'user_version') : 0
      if (current > TEAM_SCHEMA_VERSION) throw new TeamServiceError('FUTURE_SCHEMA', 'The team database requires a newer service version', 503)
      if (current === 0) {
        if (this.get("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1")) throw new TeamServiceError('FOREIGN_STORE', 'Existing database has no supported team schema; inspect it before setup', 503)
        this.transaction(() => {
          this.db.exec(TEAM_SCHEMA_SQL)
          this.setMeta('instanceId', randomUUID()); this.setMeta('epoch', randomUUID())
          this.setMeta('cursorSecret', randomBytes(32).toString('hex')); this.setMeta('authorizationRevision', '1')
          this.db.exec(`PRAGMA user_version=${TEAM_SCHEMA_VERSION}`)
        })
      }
      if (current === 1) this.transaction(() => {
        this.db.exec('ALTER TABLE devices RENAME TO devices_v1;')
        this.db.exec(TEAM_DEVICES_SQL)
        this.db.exec('INSERT INTO devices SELECT deviceId,pairingId,credentialHash,projectId,ownerId,deviceName,capabilityClaimsJson,status,userCode,expiresAt,lastSeenAt,sequence,createdAt FROM devices_v1; DROP TABLE devices_v1;')
        this.db.exec('PRAGMA user_version=2')
      })
      if (current === 1 || current === 2) this.transaction(() => {
        this.db.exec('ALTER TABLE people ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;')
        this.db.exec('PRAGMA user_version=3')
      })
      if (current >= 1 && current <= 3) this.transaction(() => { this.db.exec(TEAM_COLLABORATION_SQL); this.db.exec('PRAGMA user_version=4') })
      if (current >= 1 && current <= 4) this.transaction(() => { this.db.exec(TEAM_INVITATIONS_SQL); this.db.exec('PRAGMA user_version=5') })
      if (current >= 1 && current <= 5) this.transaction(() => { this.db.exec(TEAM_HIFOX_WORKSPACE_SQL); this.db.exec('PRAGMA user_version=6') })
      if (current >= 1 && current <= 6) this.transaction(() => { this.db.exec(TEAM_LOCAL_AUTH_SQL); this.db.exec('PRAGMA user_version=7') })
      if (current >= 1 && current <= 7) this.transaction(() => { this.db.exec(TEAM_HIFOX_WORKSPACE_TRIGGERS_SQL); this.db.exec('PRAGMA user_version=8') })
      if (current >= 1 && current <= 8) this.transaction(() => { this.db.exec(TEAM_CREATIONS_SQL); this.db.exec('PRAGMA user_version=9') })
      if (current >= 1 && current <= 9) this.transaction(() => { this.db.exec(TEAM_TASK_PROGRESS_SQL); this.db.exec('PRAGMA user_version=10') })
      if (current >= 1 && current <= 10) this.transaction(() => {
        this.db.exec(TEAM_TASK_PROGRESS_IDENTITIES_SQL)
        this.db.exec('INSERT OR IGNORE INTO hifox_task_progress_commands(projectId,taskId,commandId,userId,ownerKey,requestHash) SELECT projectId,taskId,commandId,userId,ownerKey,requestHash FROM hifox_task_progress_receipts')
        this.db.exec('PRAGMA user_version=11')
      })
      if (current >= 1 && current <= 11) this.transaction(() => { this.db.exec(TEAM_CODE_RESOURCES_SQL); this.db.exec('PRAGMA user_version=12') })
      if (current >= 1 && current <= 12) this.transaction(() => { this.db.exec(TEAM_TASK_MATERIALS_SQL); this.db.exec('PRAGMA user_version=13') })
      if (current >= 1 && current <= 13) this.transaction(() => { this.db.exec(TEAM_CONTENT_SQL); this.db.exec('PRAGMA user_version=14') })
      if (current >= 1 && current <= 14) this.transaction(() => { this.db.exec(TEAM_GOVERNANCE_SQL); this.db.exec('PRAGMA user_version=15') })
      if (current >= 1 && current <= 15) this.transaction(() => { this.db.exec(TEAM_INVITATION_SPACES_SQL); this.db.exec('PRAGMA user_version=16') })
      if (current >= 1 && current <= 16) this.transaction(() => { this.db.exec(TEAM_INVITATION_SPACE_IDENTITY_SQL); this.db.exec('PRAGMA user_version=17') })
      if (current >= 1 && current <= 17) this.transaction(() => { this.db.exec(TEAM_TASK_EXECUTIONS_SQL); this.db.exec('PRAGMA user_version=18') })
      if (current >= 1 && current <= 18) this.transaction(() => { this.db.exec(TEAM_TASK_EXECUTION_BOUNDARY_SQL); this.db.exec('PRAGMA user_version=19') })
      this.meta('instanceId'); this.meta('epoch'); this.meta('cursorSecret'); this.meta('authorizationRevision')
      const blobPath = join(this.directory, 'blobs')
      mkdirSync(blobPath, { mode: 0o700, recursive: true })
      if (realpathSync(blobPath) !== blobPath) throw new TeamServiceError('STORE_UNAVAILABLE', 'Blob directory cannot be a redirected filesystem path', 503)
    } catch (error) {
      database?.close()
      this.releaseLock()
      throw error
    }
  }
  private acquireLock(): void {
    if (existsSync(this.lockPath)) {
      let stale = false
      try {
        const value = z.object({ pid: z.number().int().positive(), lockId: z.string().uuid() }).passthrough().parse(JSON.parse(readFileSync(this.lockPath, 'utf8')))
        try { process.kill(value.pid, 0) } catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') stale = true; else throw error }
      } catch (error) { if (!stale) throw new TeamServiceError('STORE_LOCKED', 'Existing service lock must be inspected before restart', 503) }
      if (!stale) throw new TeamServiceError('STORE_LOCKED', 'Another service instance owns this data directory', 503)
      renameSync(this.lockPath, join(this.directory, `service.stale-${randomUUID()}.lock`))
    }
    writeFileSync(this.lockPath, JSON.stringify({ pid: process.pid, lockId: this.lockId, createdAt: now() }), { flag: 'wx', mode: 0o600 })
  }
  private releaseLock(): void {
    if (!existsSync(this.lockPath)) return
    const value = JSON.parse(readFileSync(this.lockPath, 'utf8')) as { lockId?: unknown }
    if (value.lockId === this.lockId) unlinkSync(this.lockPath)
  }
  private get(sql: string, ...values: SQLInputValue[]): Row | undefined { return this.db.prepare(sql).get(...values) }
  private all(sql: string, ...values: SQLInputValue[]): Row[] { return this.db.prepare(sql).all(...values) }
  private run(sql: string, ...values: SQLInputValue[]): void { this.db.prepare(sql).run(...values) }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = fn(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  private meta(key: string): string { return text(requireValue(this.get('SELECT value FROM team_meta WHERE key=?', key), 'CORRUPT_STORE', 'Required team database identity is missing', 503), 'value') }
  private setMeta(key: string, value: string): void { this.run('INSERT INTO team_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, value) }
  private bumpAuthorization(): void { this.setMeta('authorizationRevision', String(Number(this.meta('authorizationRevision')) + 1)); this.executions.reconcileAuthorities() }
  private revokePersonInvitations(userId: string, teamId?: string, projectId?: string): void {
    const person = requireValue(this.get('SELECT issuer,subject FROM people WHERE userId=?', userId), 'NOT_FOUND', 'Account unavailable')
    this.run("UPDATE invitations SET status='revoked' WHERE status='pending' AND (createdBy=? OR (recipientIssuer=? AND ((json_extract(recipientJson,'$.kind')='person' AND json_extract(recipientJson,'$.userId')=?) OR (json_extract(recipientJson,'$.kind')='oidc-subject' AND json_extract(recipientJson,'$.subject')=?) OR (json_extract(recipientJson,'$.kind')='local' AND json_extract(recipientJson,'$.username')=?))))" + (teamId ? ' AND teamId=?' : '') + (projectId ? ' AND projectId=?' : ''), userId, text(person, 'issuer'), userId, text(person, 'subject'), text(person, 'subject'), ...(teamId ? [teamId] : []), ...(projectId ? [projectId] : []))
  }
  private person(row: Row): TeamPerson {
    return { userId: text(row, 'userId'), displayName: text(row, 'displayName'), active: integer(row, 'active') === 1, isPlatformAdmin: text(row, 'issuer') !== TEAM_LOCAL_ISSUER && text(row, 'issuer') === this.options.issuer && text(row, 'subject') === this.options.bootstrapSubject, revision: integer(row, 'revision'), provider: text(row, 'issuer') === TEAM_LOCAL_ISSUER ? 'local' : this.options.identityProvider ?? 'oidc' }
  }
  private addSession(userId: string, input: { sessionHash: string; csrfToken: string; previousSessionHash?: string }): void {
    this.run('DELETE FROM sessions WHERE expiresAt<?', now())
    if (input.previousSessionHash) this.run('DELETE FROM sessions WHERE sessionHash=?', input.previousSessionHash)
    this.run('INSERT INTO sessions(sessionHash,userId,csrfToken,expiresAt,createdAt) VALUES(?,?,?,?,?)', input.sessionHash, userId, input.csrfToken, now() + this.options.sessionTtlMs, now())
  }
  private teamMembership(userId: string, teamId: string): Row | undefined { return this.get('SELECT * FROM team_members WHERE userId=? AND teamId=? AND active=1', userId, teamId) }
  private projectMembership(userId: string, projectId: string): Row | undefined {
    const member = this.get('SELECT pm.* FROM project_members pm JOIN projects p ON p.projectId=pm.projectId JOIN team_members tm ON tm.teamId=p.teamId AND tm.userId=pm.userId WHERE pm.userId=? AND pm.projectId=? AND pm.active=1 AND tm.active=1', userId, projectId)
    return member
  }
  private teamAdmin(principal: StorePrincipal, teamId: string): void {
    if (principal.actor.kind === 'device') forbidden()
    if (principal.person.isPlatformAdmin) return
    const membership = this.teamMembership(principal.person.userId, teamId)
    if (!membership || !rolesSchema.parse(json(membership, 'rolesJson')).some((role) => ['owner', 'admin'].includes(role))) forbidden()
  }
  private project(principal: StorePrincipal, projectId: string, admin = false): Row {
    const project = requireValue(this.get('SELECT * FROM projects WHERE projectId=?', projectId), 'NOT_FOUND', 'Project is unavailable')
    if (principal.actor.kind === 'device' && (admin || principal.projectId !== projectId)) forbidden()
    const membership = this.projectMembership(principal.person.userId, projectId)
    if (admin && principal.actor.kind === 'session') {
      if (principal.person.isPlatformAdmin) return project
      const teamMember = this.teamMembership(principal.person.userId, text(project, 'teamId'))
      if (teamMember && rolesSchema.parse(json(teamMember, 'rolesJson')).some((role) => ['owner', 'admin'].includes(role))) return project
    }
    if (!membership || (admin && !rolesSchema.parse(json(membership, 'rolesJson')).includes('admin'))) forbidden()
    return project
  }
  private authenticate(actor: StoreActor): StorePrincipal {
    if (actor.kind === 'session') {
      const row = this.get('SELECT p.*,s.csrfToken FROM sessions s JOIN people p ON p.userId=s.userId WHERE s.sessionHash=? AND s.expiresAt>? AND p.active=1', actor.credentialHash, now())
      if (!row) throw new TeamServiceError('UNAUTHORIZED', 'Authentication is required', 401)
      return { person: this.person(row), actor, deviceId: null, projectId: null, csrfToken: text(row, 'csrfToken') }
    }
    const row = this.get('SELECT p.*,d.deviceId,d.projectId FROM devices d JOIN people p ON p.userId=d.ownerId WHERE d.credentialHash=? AND d.status=? AND p.active=1', actor.credentialHash, 'active')
    if (!row || !this.projectMembership(text(row, 'userId'), text(row, 'projectId'))) throw new TeamServiceError('UNAUTHORIZED', 'Authentication is required', 401)
    return { person: this.person(row), actor, deviceId: text(row, 'deviceId'), projectId: text(row, 'projectId'), csrfToken: null }
  }
  private mutation<T>(actor: StoreActor, commandId: string, kind: string, input: unknown, authorize: (principal: StorePrincipal) => void, apply: (principal: StorePrincipal) => T, authorizeReplay?: (principal: StorePrincipal, result: T) => void): TeamCommandReply<T> {
    const requestHash = digest(canonical({ kind, input }))
    return this.transaction(() => {
      const principal = this.authenticate(actor); authorize(principal)
      if (kind === 'taskExecutionCommand' && this.get('SELECT commandId FROM hifox_task_progress_commands WHERE userId=? AND commandId=?', principal.person.userId, commandId)) throw new TeamServiceError('COMMAND_CONFLICT', 'Command UUID already belongs to a v1 progress operation', 409)
      if (this.get('SELECT commandId FROM team_content_commands WHERE userId=? AND commandId=?', principal.person.userId, commandId)) throw new TeamServiceError('COMMAND_CONFLICT', 'Command UUID already belongs to a content operation', 409)
      const previous = this.get('SELECT kind,requestHash,resultJson FROM commands WHERE userId=? AND commandId=?', principal.person.userId, commandId)
      if (previous) {
        if (text(previous, 'kind') !== kind || text(previous, 'requestHash') !== requestHash) throw new TeamServiceError('COMMAND_CONFLICT', 'Command identity already describes a different request', 409)
        const result = json(previous, 'resultJson') as T
        // A newly generated resource has no scope to check before its creation;
        // replay must check the generated scope rather than return a stale grant.
        authorizeReplay?.(principal, result)
        return { status: 'duplicate', commandId, result }
      }
      const result = apply(principal)
      if (['hifoxCommand', 'taskInputCommand', 'governanceCommand', 'taskMaterialCommand'].includes(kind)) this.executions.reconcileAuthorities()
      this.run('INSERT INTO commands(userId,commandId,kind,requestHash,resultJson,createdAt) VALUES(?,?,?,?,?,?)', principal.person.userId, commandId, kind, requestHash, JSON.stringify(result), now())
      return { status: 'committed', commandId, result }
    })
  }
  private event(type: string, kind: TeamVisibility, audienceId: string, projectId: string | null, payload: Record<string, unknown>): void {
    const data = JSON.stringify(payload)
    if (Buffer.byteLength(data) > 16 * 1024) throw new TeamServiceError('CAPACITY_EXCEEDED', 'Event summary exceeds its bounded budget', 413)
    this.run('INSERT INTO events(eventId,type,audienceKind,audienceId,projectId,occurredAt,payloadJson) VALUES(?,?,?,?,?,?,?)', randomUUID(), type, kind, audienceId, projectId, now(), data)
  }
  private canRead(principal: StorePrincipal, version: Row): boolean {
    const projectId = text(version, 'projectId')
    if (principal.actor.kind === 'device' && (principal.projectId !== projectId || !this.projectMembership(principal.person.userId, projectId))) return false
    const visibility = text(version, 'visibility')
    if (visibility === 'personal') return text(version, 'ownerId') === principal.person.userId
    if (visibility === 'project') return !!this.projectMembership(principal.person.userId, projectId)
    if (visibility === 'team') return !!this.teamMembership(principal.person.userId, text(version, 'teamId'))
    throw new TeamServiceError('CORRUPT_STORE', 'Invalid material visibility', 503)
  }
  private versionRow(materialId: string, version: number): Row {
    return requireValue(this.get('SELECT m.*,v.* FROM materials m JOIN material_versions v ON v.materialId=m.materialId WHERE m.materialId=? AND v.version=?', materialId, version), 'NOT_FOUND', 'Material version is unavailable')
  }
  private material(row: Row): TeamMaterialVersion {
    const blob = requireValue(this.get('SELECT byteLength FROM blobs WHERE bodyDigest=?', text(row, 'bodyDigest')), 'CORRUPT_STORE', 'Material body reference is missing', 503)
    return { materialId: text(row, 'materialId'), version: integer(row, 'version'), projectId: text(row, 'projectId'), teamId: text(row, 'teamId'), ownerId: text(row, 'ownerId'), title: text(row, 'title'), kind: publicationInputSchema.shape.kind.parse(text(row, 'kind')), visibility: publicationInputSchema.shape.visibility.parse(text(row, 'visibility')), bodyDigest: text(row, 'bodyDigest'), byteLength: integer(blob, 'byteLength'), source: teamSourceSchema.parse(json(row, 'sourceJson')), createdAt: integer(row, 'createdAt'), authorId: text(row, 'authorId') }
  }
  private blobPath(hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new TeamServiceError('CORRUPT_STORE', 'Invalid blob digest', 503)
    return join(this.directory, 'blobs', hash)
  }
  private blob(hash: string): Buffer {
    const path = this.blobPath(hash)
    if (realpathSync(path) !== path) throw new TeamServiceError('CORRUPT_STORE', 'Blob path was redirected', 503)
    const stat = statSync(path)
    if (!stat.isFile() || stat.size > MAX_DOCUMENT_BYTES) throw new TeamServiceError('CORRUPT_STORE', 'Stored body exceeds document bounds', 503)
    const body = readFileSync(path)
    if (digest(body) !== hash) throw new TeamServiceError('CORRUPT_STORE', 'Stored body digest failed verification', 503)
    return body
  }
  private persistBlob(bytes: Buffer, hash: string): void {
    const path = this.blobPath(hash)
    if (existsSync(path)) { this.blob(hash); return }
    const temporary = join(this.directory, 'blobs', `.pending-${randomUUID()}`)
    const descriptor = openSync(temporary, 'wx', 0o600)
    try { writeFileSync(descriptor, bytes); fsyncSync(descriptor) } finally { closeSync(descriptor) }
    try { linkSync(temporary, path) } catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error; this.blob(hash) }
    finally { unlinkSync(temporary) }
  }
  private feedbackRow(row: Row): TeamFeedback {
    return { feedbackId: text(row, 'feedbackId'), materialId: text(row, 'materialId'), version: integer(row, 'version'), authorId: text(row, 'authorId'), body: text(row, 'body'), quote: row.quote === null ? null : text(row, 'quote'), anchor: row.anchorJson === null ? null : teamFeedbackInputSchema.shape.anchor.parse(json(row, 'anchorJson')) ?? null, createdAt: integer(row, 'createdAt'), state: 'recorded', applied: false }
  }
  private device(row: Row): TeamDevice {
    const state = text(row, 'status'); const expiry = integer(row, 'expiresAt')
    const ownerId = row.ownerId === null ? null : text(row, 'ownerId')
    const projectId = row.projectId === null ? null : text(row, 'projectId')
    const active = state === 'active' && !!ownerId && !!projectId && !!this.projectMembership(ownerId, projectId)
    const lastSeenAt = row.lastSeenAt === null ? null : integer(row, 'lastSeenAt')
    const age = lastSeenAt === null ? null : now() - lastSeenAt
    const base = { deviceId: text(row, 'deviceId'), deviceName: text(row, 'deviceName'), lastSeenAt, online: active && age !== null && age >= 0 && age <= this.options.onlineTtlMs, capabilityClaims: z.array(z.string()).parse(json(row, 'capabilityClaimsJson')), capabilityEvidence: 'device-declared' as const, sequence: integer(row, 'sequence') }
    if (state === 'active') { if (!projectId || !ownerId) throw new TeamServiceError('CORRUPT_STORE', 'An active device must have a project and account', 503); return { ...base, status: 'active', projectId, ownerId } }
    if (state === 'pending' || state === 'expired') { if (ownerId) throw new TeamServiceError('CORRUPT_STORE', 'Pending device cannot have an account grant', 503); return { ...base, online: false, status: expiry <= now() ? 'expired' : 'pending', projectId, ownerId: null } }
    if (state === 'revoked') return { ...base, online: false, status: 'revoked', projectId, ownerId }
    throw new TeamServiceError('CORRUPT_STORE', 'Unknown device state', 503)
  }
  private cursor(actor: StorePrincipal, projectId: string | undefined, after: number): string {
    const payload = Buffer.from(JSON.stringify({ instance: this.meta('instanceId'), epoch: this.meta('epoch'), actor: `${actor.person.userId}:${actor.deviceId ?? 'browser'}`, projectId: projectId ?? null, authorization: this.meta('authorizationRevision'), after })).toString('base64url')
    return payload + '.' + createHmac('sha256', this.meta('cursorSecret')).update(payload).digest('base64url')
  }
  private listCursor(principal: StorePrincipal, scope: string, after: string): string {
    const payload = Buffer.from(JSON.stringify({ instance: this.meta('instanceId'), epoch: this.meta('epoch'), actor: `${principal.person.userId}:${principal.deviceId ?? 'browser'}`, scope, authorization: this.meta('authorizationRevision'), after })).toString('base64url')
    return payload + '.' + createHmac('sha256', this.meta('cursorSecret')).update(payload).digest('base64url')
  }
  private listAfter(principal: StorePrincipal, scope: string, cursor: string | undefined, initial = ''): string {
    if (!cursor) return initial
    try {
      const [payload, mac, extra] = cursor.split('.')
      if (!payload || !mac || extra || !safeEqual(mac, createHmac('sha256', this.meta('cursorSecret')).update(payload).digest('base64url'))) throw Error('Invalid cursor')
      const value = z.object({ instance: z.string(), epoch: z.string(), actor: z.string(), scope: z.string(), authorization: z.string(), after: z.string().max(512) }).strict().parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')))
      if (value.instance !== this.meta('instanceId') || value.epoch !== this.meta('epoch') || value.actor !== `${principal.person.userId}:${principal.deviceId ?? 'browser'}` || value.scope !== scope || value.authorization !== this.meta('authorizationRevision')) throw Error('Stale cursor')
      return value.after
    } catch { throw new TeamServiceError('CURSOR_CONFLICT', 'List cursor is stale or belongs to another scope; reload the first page', 409) }
  }
  private page<T>(principal: StorePrincipal, scope: string, rows: Row[], key: string, limit: number, allowed: (row: Row) => boolean, map: (row: Row) => T): TeamPage<T> {
    const items: T[] = []; let scanned = ''; let count = 0; let bytes = 0
    for (const row of rows.slice(0, 500)) {
      if (allowed(row)) {
        const item = map(row); const size = Buffer.byteLength(JSON.stringify(item))
        if (size > TEAM_MAX_PAGE_ITEM_BYTES) throw new TeamServiceError('CAPACITY_EXCEEDED', 'One list item exceeds its response budget', 413)
        if (items.length && bytes + size > TEAM_MAX_PAGE_ITEM_BYTES) break
        items.push(item); bytes += size
      }
      count++; const value = row[key]
      if (typeof value !== 'string' && typeof value !== 'number') throw new TeamServiceError('CORRUPT_STORE', 'List identity is invalid', 503)
      scanned = String(value)
      if (items.length >= limit) break
    }
    const hasMore = count < rows.length
    return { items, nextCursor: hasMore ? this.listCursor(principal, scope, scanned) : null, hasMore }
  }
  private eventPage(actor: StoreActor, raw: unknown): TeamEventPage {
    const input = teamEventsInputSchema.parse(raw); const principal = this.authenticate(actor)
    if (input.projectId) this.project(principal, input.projectId)
    const max = integer(requireValue(this.get('SELECT COALESCE(MAX(sequence),0) AS maximum FROM events'), 'CORRUPT_STORE', 'Event cursor is unavailable', 503), 'maximum')
    let after = 0; let resetRequired = false
    if (input.cursor) {
      try {
        const [payload, mac, extra] = input.cursor.split('.')
        if (!payload || !mac || extra || !safeEqual(mac, createHmac('sha256', this.meta('cursorSecret')).update(payload).digest('base64url'))) throw Error('Invalid cursor')
        const data = z.object({ instance: z.string(), epoch: z.string(), actor: z.string(), projectId: z.string().nullable(), authorization: z.string(), after: z.number().int().min(0).safe() }).strict().parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')))
        if (data.instance !== this.meta('instanceId') || data.epoch !== this.meta('epoch') || data.actor !== `${principal.person.userId}:${principal.deviceId ?? 'browser'}` || data.projectId !== (input.projectId ?? null) || data.authorization !== this.meta('authorizationRevision') || data.after > max) throw Error('Stale cursor')
        after = data.after
      } catch { resetRequired = true }
    }
    const rows = this.all('SELECT * FROM events WHERE sequence>? ORDER BY sequence LIMIT 500', after)
    const items: TeamEvent[] = []; let scanned = after
    for (const row of rows) {
      scanned = integer(row, 'sequence')
      const projectId = row.projectId === null ? null : text(row, 'projectId')
      if (input.projectId && projectId !== input.projectId) continue
      if (principal.actor.kind === 'device' && projectId !== principal.projectId) continue
      const kind = text(row, 'audienceKind'); const audience = text(row, 'audienceId')
      const allowed = kind === 'personal' ? audience === principal.person.userId : kind === 'project' ? !!this.projectMembership(principal.person.userId, audience) : kind === 'team' ? !!this.teamMembership(principal.person.userId, audience) : false
      if (!allowed) continue
      if (text(row, 'type').startsWith('collaboration.')) {
        const payload = z.object({ entityId: teamIdSchema }).passthrough().parse(json(row, 'payloadJson'))
        if (!this.collaboration.canRead(principal, payload.entityId)) continue
      }
      items.push({ eventId: text(row, 'eventId'), sequence: scanned, type: text(row, 'type'), projectId, occurredAt: integer(row, 'occurredAt'), payload: z.record(z.string(), z.unknown()).parse(json(row, 'payloadJson')) })
      if (items.length >= input.limit) break
    }
    return { contractVersion: 1, items, cursor: this.cursor(principal, input.projectId, scanned), resetRequired, hasMore: scanned < max, serverTime: now() }
  }

  async dispatch(operation: StoreOperation, raw: unknown): Promise<unknown> {
    if (this.isClosed) throw new TeamServiceError('STORE_UNAVAILABLE', 'Team store is closed', 503)
    if (operation === 'health') return { schemaVersion: TEAM_SCHEMA_VERSION, instanceId: this.meta('instanceId'), epoch: this.meta('epoch') }
    if (operation === 'hifoxTick') return this.hifox.tick()
    if (operation === 'contentRecover') { this.content.recover(z.object({ restart: z.boolean() }).strict().parse(raw).restart); return null }
    if (operation === 'contentStart') return this.content.start(raw)
    if (operation === 'contentSettle') { this.content.settle(raw); return null }
    if (operation === 'localCredential') {
      const input = z.object({ username: teamLocalUsernameSchema }).strict().parse(raw)
      const credential = this.get('SELECT userId,salt,passwordHash,algorithm FROM local_credentials WHERE username=?', input.username)
      return credential ?? null
    }
    if (operation === 'registerLocal' || operation === 'completeLocalLogin') {
      const sessionFields = { sessionHash: z.string().regex(/^[a-f0-9]{64}$/), csrfToken: z.string().min(20).max(200), previousSessionHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }
      if (operation === 'registerLocal') {
        const input = z.object({ ...sessionFields, username: teamLocalUsernameSchema, displayName: z.string().trim().min(1).max(200), salt: z.string().regex(/^[a-f0-9]{64}$/), passwordHash: z.string().regex(/^[a-f0-9]{128}$/) }).strict().parse(raw)
        return this.transaction(() => {
          if (this.get('SELECT userId FROM local_credentials WHERE username=?', input.username)) throw new TeamServiceError('REGISTRATION_UNAVAILABLE', 'Unable to register this account; choose another username or contact your administrator', 409)
          const userId = randomUUID()
          this.run('INSERT INTO people(userId,issuer,subject,displayName,active,isPlatformAdmin,createdAt) VALUES(?,?,?,?,1,0,?)', userId, TEAM_LOCAL_ISSUER, input.username, input.displayName, now())
          this.run("INSERT INTO local_credentials(userId,username,salt,passwordHash,algorithm,createdAt) VALUES(?,?,?,?,'scrypt-N32768-r8-p1',?)", userId, input.username, input.salt, input.passwordHash, now())
          this.addSession(userId, input)
          return { userId }
        })
      }
      const input = z.object({ ...sessionFields, userId: teamIdSchema, passwordHash: z.string().regex(/^[a-f0-9]{128}$/) }).strict().parse(raw)
      return this.transaction(() => {
        const person = this.get('SELECT p.userId,p.active,c.passwordHash FROM people p JOIN local_credentials c ON c.userId=p.userId WHERE p.userId=?', input.userId)
        if (!person || person.active !== 1 || !safeEqual(text(person, 'passwordHash'), input.passwordHash)) throw new TeamServiceError('INVALID_CREDENTIALS', 'Username or password is incorrect', 401)
        this.addSession(input.userId, input)
        return { userId: input.userId }
      })
    }
    if (operation === 'createLogin') {
      const input = z.object({ attemptHash: z.string().length(64), state: z.string().min(20), nonce: z.string().min(20), verifier: z.string().min(20), returnTo: z.string().max(2048) }).strict().parse(raw)
      this.run('DELETE FROM login_attempts WHERE expiresAt<?', now())
      const total = integer(requireValue(this.get('SELECT COUNT(*) AS total FROM login_attempts'), 'STORE_UNAVAILABLE', 'Login store unavailable', 503), 'total')
      if (total >= 1000) throw new TeamServiceError('CAPACITY_EXCEEDED', 'Too many pending logins', 429)
      this.run('INSERT INTO login_attempts(attemptHash,state,nonce,verifier,returnTo,expiresAt) VALUES(?,?,?,?,?,?)', input.attemptHash, input.state, input.nonce, input.verifier, input.returnTo, now() + 5 * 60_000)
      return { stored: true }
    }
    if (operation === 'consumeLogin') {
      const input = z.object({ attemptHash: z.string().length(64), state: z.string().max(512) }).strict().parse(raw)
      return this.transaction(() => {
        const row = this.get('SELECT * FROM login_attempts WHERE attemptHash=? AND expiresAt>?', input.attemptHash, now())
        if (!row || !safeEqual(text(row, 'state'), input.state)) throw new TeamServiceError('INVALID_LOGIN', 'Login attempt is invalid or expired', 401)
        this.run('DELETE FROM login_attempts WHERE attemptHash=?', input.attemptHash)
        return { state: text(row, 'state'), nonce: text(row, 'nonce'), verifier: text(row, 'verifier'), returnTo: text(row, 'returnTo') }
      })
    }
    if (operation === 'completeLogin') {
      const input = z.object({ issuer: z.string().url(), subject: z.string().min(1).max(512), displayName: z.string().min(1).max(200), sessionHash: z.string().length(64), csrfToken: z.string().min(20).max(200), previousSessionHash: z.string().length(64).optional() }).strict().parse(raw)
      if (input.issuer !== this.options.issuer) throw new TeamServiceError('INVALID_LOGIN', 'Identity issuer does not match configured issuer', 401)
      return this.transaction(() => {
        let person = this.get('SELECT * FROM people WHERE issuer=? AND subject=?', input.issuer, input.subject)
        if (person && integer(person, 'active') !== 1) forbidden()
        if (!person) {
          this.run('INSERT INTO people(userId,issuer,subject,displayName,active,isPlatformAdmin,createdAt) VALUES(?,?,?,?,1,?,?)', randomUUID(), input.issuer, input.subject, input.displayName, input.subject === this.options.bootstrapSubject ? 1 : 0, now())
          person = requireValue(this.get('SELECT * FROM people WHERE issuer=? AND subject=?', input.issuer, input.subject), 'STORE_UNAVAILABLE', 'Identity was not persisted', 503)
        } else this.run('UPDATE people SET displayName=? WHERE userId=?', input.displayName, text(person, 'userId'))
        this.addSession(text(person, 'userId'), input)
        return { userId: text(person, 'userId') }
      })
    }
    if (operation === 'enrollDevice') {
      const input = deviceEnrollmentInputSchema.parse(raw)
      if (input.projectId) requireValue(this.get('SELECT projectId FROM projects WHERE projectId=?', input.projectId), 'NOT_FOUND', 'Requested project is unavailable')
      // Expired, never-approved credentials are disposable setup attempts, not business/control records.
      this.run("DELETE FROM devices WHERE status='pending' AND ownerId IS NULL AND expiresAt<?", now())
      const pending = integer(requireValue(this.get("SELECT COUNT(*) AS total FROM devices WHERE status='pending' AND expiresAt>?", now()), 'STORE_UNAVAILABLE', 'Device store unavailable', 503), 'total')
      if (pending >= 500) throw new TeamServiceError('CAPACITY_EXCEEDED', 'Too many pending device enrollments', 429)
      const deviceId = randomUUID(); const pairingId = randomUUID(); const deviceToken = 'td_' + randomBytes(32).toString('base64url')
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const userCode = Array.from({ length: 10 }, () => alphabet[randomInt(alphabet.length)]).join('')
      const expiresAt = now() + this.options.pairingTtlMs
      this.run('INSERT INTO devices(deviceId,pairingId,credentialHash,projectId,ownerId,deviceName,capabilityClaimsJson,status,userCode,expiresAt,lastSeenAt,sequence,createdAt) VALUES(?,?,?,?,NULL,?,?,?, ?,?,NULL,-1,?)', deviceId, pairingId, digest(deviceToken), input.projectId ?? null, input.deviceName, JSON.stringify(uniqueRoles(input.capabilityClaims)), 'pending', userCode, expiresAt, now())
      return { pairingId, deviceId, deviceToken, userCode, expiresAt, pollAfterMs: 3000 }
    }
    if (operation === 'pairingStatus') {
      const input = z.object({ pairingId: teamIdSchema, credentialHash: z.string().length(64) }).strict().parse(raw)
      const row = this.get('SELECT * FROM devices WHERE pairingId=? AND credentialHash=?', input.pairingId, input.credentialHash)
      if (!row) throw new TeamServiceError('UNAUTHORIZED', 'Authentication is required', 401)
      return this.device(row)
    }
    if (operation === 'backup') return this.backup(z.object({ destination: z.string().min(1) }).strict().parse(raw).destination)
    if (operation === 'close') { this.isClosed = true; this.db.close(); this.releaseLock(); return { closed: true } }
    const input = actorInputSchema.parse(raw); const actor = input.actor
    if (operation === 'authenticate') return this.authenticate(actor)
    if (operation === 'logout') {
      if (actor.kind !== 'session') forbidden()
      this.authenticate(actor); this.run('DELETE FROM sessions WHERE sessionHash=?', actor.credentialHash); return { loggedOut: true }
    }
    if (operation === 'events') return this.eventPage(actor, input.query)
    return this.domain(operation, actor, input)
  }

  private taskDevelopmentContext(principal: StorePrincipal, raw: Record<string, unknown>): TeamTaskDevelopmentContext {
    const { projectId, taskId } = z.object({ actor: actorSchema, projectId: teamIdSchema, taskId: teamTaskProgressResourceIdSchema,
      query: z.object({}).strict().optional() }).strict().parse(raw)
    // The owned worker serializes this synchronous read with all mutations; no getter yields.
    const snapshot = this.hifox.read(principal, { projectId })
    const task = snapshot.snapshot.tasks.find(item => item.id === taskId)
    const space = task && snapshot.snapshot.spaces.find(item => item.id === task.spaceId)
    if (!task || !space) throw new TeamServiceError('TASK_DEVELOPMENT_UNAVAILABLE', 'Original task is unavailable', 404)
    if (!space.memberIds.includes(principal.person.userId) || (task.workflow?.handlerId ?? task.assigneeIds[0]) !== principal.person.userId) {
      throw new TeamServiceError('TASK_DEVELOPMENT_FORBIDDEN', 'Development context requires the current task handler and space member', 403)
    }
    const inputs = this.taskInputs.read(principal, { projectId, taskId, query: { spaceId: task.spaceId, taskCreatedAt: task.createdAt } })
    const codeResource = this.codeResources.readTask(principal, { projectId, taskId })
    const creations = this.creations.list(principal, { projectId, query: { scope: 'team', spaceId: task.spaceId, taskId, limit: 20 } })
    return teamTaskDevelopmentContextSchema.parse({ version: 1, snapshot, inputs, codeResource, creations })
  }

  private domain(operation: StoreOperation, actor: StoreActor, raw: Record<string, unknown>): unknown {
    const principal = this.authenticate(actor)
    if (operation === 'taskDevelopmentContext') return this.taskDevelopmentContext(principal, raw)
    if (operation === 'contentConfigRead') return this.content.configRead(principal, raw)
    if (operation === 'contentConfigure') return this.content.configure(actor, raw)
    if (operation === 'contentCapabilities') return this.content.readiness(principal, raw)
    if (operation === 'contentPrepare') return this.content.prepare(actor, raw)
    if (operation === 'contentProbe') return this.content.prepare(actor, raw, true)
    if (operation === 'contentJob') return this.content.read(principal, raw)
    if (operation === 'contentReceipt') return this.content.read(principal, raw, true)
    if (operation === 'contentCancel') return this.content.cancel(actor, raw)
    if (operation === 'contentBudget') return this.content.budget(principal, raw)
    if (operation === 'contentAccounting') return this.content.accounting(principal, raw)
    if (operation === 'contentReconcile') return this.content.reconcile(actor, raw)
    if (operation === 'hifoxSnapshot') return this.hifox.read(principal, raw)
    if (operation === 'hifoxHead') return this.hifox.head(actor, raw)
    if (operation === 'hifoxCommand') return this.hifox.command(actor, raw)
    if (operation === 'taskProgressRead') return this.taskProgress.read(actor, raw)
    if (operation === 'taskProgressCommand') return this.taskProgress.command(actor, raw)
    if (operation === 'taskProgressReceipt') return this.taskProgress.receipt(actor, raw)
    if (operation === 'taskExecutionRead') return this.executions.read(actor, teamTaskRefSchema.parse(raw.task))
    if (operation === 'taskExecutionHistory') return this.executions.history(actor, teamTaskRefSchema.parse(raw.task), teamIdSchema.parse(raw.executionId))
    if (operation === 'taskExecutionCommand') return this.executions.command(actor, raw.body)
    if (operation === 'taskExecutionReconcile') return this.executions.reconcile(actor, raw.body)
    if (operation === 'taskMaterialList') return this.taskMaterials.list(principal, raw)
    if (operation === 'taskMaterialRead') return this.taskMaterials.read(principal, raw)
    if (operation === 'taskMaterialVersions') return this.taskMaterials.versions(principal, raw)
    if (operation === 'taskMaterialSubmissions') return this.taskMaterials.submissions(principal, raw)
    if (operation === 'taskMaterialCommand') return this.taskMaterials.command(actor, raw)
    if (operation === 'taskMaterialReceipt') return this.taskMaterials.receipt(principal, raw)
    if (operation === 'governanceList') return this.governance.list(principal, raw)
    if (operation === 'governanceRead') return this.governance.read(principal, raw)
    if (operation === 'governanceCommand') return this.governance.command(actor, raw)
    if (operation === 'governanceReceipt') return this.governance.receipt(principal, raw)
    if (operation === 'taskInputRead') return this.taskInputs.read(principal, raw)
    if (operation === 'taskInputCandidates') return this.taskInputs.candidates(principal, raw)
    if (operation === 'taskInputRevision') return this.taskInputs.revision(principal, raw)
    if (operation === 'taskInputReadDocument') return this.taskInputs.readDocument(principal, raw)
    if (operation === 'taskInputCommand') return this.taskInputs.command(actor, raw)
    if (operation === 'taskInputReceipt') return this.taskInputs.receipt(principal, raw)
    if (operation === 'codeResourceList') return this.codeResources.list(principal, raw)
    if (operation === 'codeResourceCommand') return this.codeResources.command(actor, raw)
    if (operation === 'taskCodeResourceRead') return this.codeResources.readTask(principal, raw)
    if (operation === 'creationList') return this.creations.list(principal, raw)
    if (operation === 'creationHead') return this.creations.head(principal, raw)
    if (operation === 'creationView') return this.creations.get(principal, raw)
    if (operation === 'creationCommand') return this.creations.command(actor, raw)
    if (operation === 'identity') {
      const person = requireValue(this.get('SELECT issuer,subject FROM people WHERE userId=? AND active=1', principal.person.userId), 'UNAUTHORIZED', 'Authentication is required', 401)
      if (text(person, 'issuer') !== TEAM_LOCAL_ISSUER && text(person, 'issuer') !== this.options.issuer) forbidden()
      return { issuer: text(person, 'issuer'), subject: text(person, 'subject') }
    }
    if (['createInvitation', 'invitations', 'inspectInvitation', 'acceptInvitation', 'revokeInvitation'].includes(operation)) return this.invitations.dispatch(operation, actor, principal, raw)
    if (operation === 'collaborationCommand') return this.collaboration.command(actor, raw.body)
    if (operation.startsWith('collaboration')) return this.collaboration.read(operation, principal, raw)
    if (operation === 'command') {
      const commandId = teamCommandIdSchema.parse(raw.commandId)
      const command = requireValue(this.get('SELECT * FROM commands WHERE userId=? AND commandId=?', principal.person.userId, commandId), 'NOT_FOUND', 'Command has no committed record')
      const kind = text(command, 'kind'); const result = z.record(z.string(), z.unknown()).parse(json(command, 'resultJson'))
      const resultId = (key: string): string => { const parsed = teamIdSchema.safeParse(result[key]); if (!parsed.success) throw new TeamServiceError('LEGACY_COMMAND_SCOPE_UNKNOWN', 'Stored receipt lacks scope metadata; reconcile using the original request', 409); return parsed.data }
      if (['createInvitation', 'acceptInvitation', 'revokeInvitation'].includes(kind)) this.invitations.authorizeReceipt(principal, kind, resultId('invitationId'))
      else if (kind === 'hifoxCommand') {
        this.hifox.authorize(principal, resultId('projectId'))
        const scoped = this.hifox.projectReceipt(principal, result)
        return { commandId, kind, status: 'committed', recordedAt: integer(command, 'createdAt'), result: scoped }
      }
      else if (kind === 'creationCommand') this.creations.authorizeReceipt(principal, result)
      else if (kind === 'codeResourceCommand') this.codeResources.authorizeReceipt(principal, result)
      else if (kind === 'taskMaterialCommand') this.taskMaterials.authorizeReceipt(principal, result)
      else if (kind === 'governanceCommand') this.governance.authorizeReceipt(principal, result)
      else if (kind === 'taskInputCommand') this.taskInputs.authorizeReceipt(principal, result)
      else if (kind === 'collaborationCommand') this.collaboration.authorize(principal, resultId('entityId'))
      else if (kind === 'publish') this.project(principal, id(result.projectId))
      else if (kind === 'recordFeedback') { if (!this.canRead(principal, this.versionRow(id(result.materialId), z.number().int().positive().parse(result.version)))) forbidden() }
      else if (kind === 'setProjectMember') this.project(principal, resultId('projectId'), true)
      else if (kind === 'createProject' || kind === 'setTeamMember') this.teamAdmin(principal, resultId('teamId'))
      else if (kind === 'approveDevice') { if (actor.kind !== 'session') forbidden(); this.project(principal, id(result.projectId)) }
      else if (kind === 'revokeDevice') { const device = requireValue(this.get('SELECT ownerId FROM devices WHERE deviceId=?', id(result.deviceId)), 'NOT_FOUND', 'Device unavailable'); if (actor.kind !== 'session' || text(device, 'ownerId') !== principal.person.userId) forbidden() }
      else if (kind === 'createTeam') { if (actor.kind !== 'session' || !this.teamMembership(principal.person.userId, resultId('teamId'))) forbidden() }
      else if (kind === 'setPersonActive') { if (actor.kind !== 'session' || !principal.person.isPlatformAdmin) forbidden() }
      else forbidden()
      return { commandId, kind, status: 'committed', recordedAt: integer(command, 'createdAt'), result }
    }
    if (operation === 'people') {
      if (actor.kind !== 'session') forbidden()
      const input = teamPageInputSchema.parse(raw.query ?? {}); const scope = 'people'; const after = this.listAfter(principal, scope, input.cursor)
      if (principal.person.isPlatformAdmin) return this.page(principal, scope, this.all('SELECT * FROM people WHERE userId>? ORDER BY userId LIMIT 501', after), 'userId', input.limit, () => true, (row) => this.person(row))
      const administeredTeams = this.all('SELECT teamId,rolesJson FROM team_members WHERE userId=? AND active=1', principal.person.userId).filter((row) => {
        if (rolesSchema.parse(json(row, 'rolesJson')).some((role) => ['owner', 'admin'].includes(role))) return true
        return this.all('SELECT m.rolesJson FROM project_members m JOIN projects p ON p.projectId=m.projectId WHERE m.userId=? AND p.teamId=? AND m.active=1', principal.person.userId, text(row, 'teamId')).some((membership) => rolesSchema.parse(json(membership, 'rolesJson')).includes('admin'))
      }).map((row) => text(row, 'teamId'))
      if (!administeredTeams.length) forbidden()
      return this.page(principal, scope, this.all('SELECT * FROM people WHERE userId>? ORDER BY userId LIMIT 501', after), 'userId', input.limit, (row) => administeredTeams.some((teamId) => !!this.teamMembership(text(row, 'userId'), teamId)), (row) => this.person(row))
    }
    if (operation === 'setPersonActive') {
      const userId = id(raw.userId); const input = teamPersonStatusInputSchema.parse(raw.body)
      return this.mutation(actor, input.commandId, operation, { userId, ...input }, (p) => { if (p.actor.kind !== 'session' || !p.person.isPlatformAdmin) forbidden() }, (p) => {
        const person = requireValue(this.get('SELECT * FROM people WHERE userId=?', userId), 'NOT_FOUND', 'Account is unavailable')
        if (integer(person, 'revision') !== input.expectedRevision) throw new TeamServiceError('REVISION_CONFLICT', 'Account status changed; reload before updating', 409)
        if (userId === p.person.userId && !input.active) throw new TeamServiceError('BOOTSTRAP_ACCOUNT_REQUIRED', 'Configure and sign in as a replacement bootstrap administrator before disabling this account', 409)
        this.run('UPDATE people SET active=?,revision=revision+1 WHERE userId=?', input.active ? 1 : 0, userId)
        if (!input.active) { this.run('DELETE FROM sessions WHERE userId=?', userId); this.run("UPDATE devices SET status='revoked' WHERE ownerId=? AND status='active'", userId) }
        if (!input.active) this.revokePersonInvitations(userId)
        this.bumpAuthorization(); this.event('account.status-changed', 'personal', p.person.userId, null, { userId, active: input.active, revision: input.expectedRevision + 1 })
        return this.person(requireValue(this.get('SELECT * FROM people WHERE userId=?', userId), 'STORE_UNAVAILABLE', 'Account status was not persisted', 503))
      })
    }
    if (operation === 'teams') {
      const input = teamPageInputSchema.parse(raw.query ?? {}); const scope = 'teams'; const after = this.listAfter(principal, scope, input.cursor)
      return this.page(principal, scope, this.all('SELECT t.* FROM teams t JOIN team_members m ON m.teamId=t.teamId WHERE m.userId=? AND m.active=1 AND t.teamId>? ORDER BY t.teamId LIMIT 501', principal.person.userId, after), 'teamId', input.limit, (row) => actor.kind !== 'device' || !!this.get('SELECT projectId FROM projects WHERE projectId=? AND teamId=?', principal.projectId, text(row, 'teamId')), (row) => ({ teamId: text(row, 'teamId'), name: text(row, 'name'), createdAt: integer(row, 'createdAt') }))
    }
    if (operation === 'createTeam') {
      const input = createTeamSchema.parse(raw.body)
      return this.mutation(actor, input.commandId, operation, input, (p) => { if (p.actor.kind !== 'session') forbidden() }, (p) => {
        const teamId = randomUUID()
        this.run('INSERT INTO teams(teamId,name,createdAt) VALUES(?,?,?)', teamId, input.name, now())
        this.run('INSERT INTO team_members(teamId,userId,rolesJson,active,revision) VALUES(?,?,?,1,1)', teamId, p.person.userId, JSON.stringify(['owner']))
        this.bumpAuthorization(); this.event('team.created', 'team', teamId, null, { teamId, name: input.name })
        return { teamId, name: input.name }
      }, (p, result) => { if (!this.teamMembership(p.person.userId, result.teamId)) forbidden() })
    }
    if (operation === 'teamMembers') {
      const teamId = id(raw.teamId); this.teamAdmin(principal, teamId)
      const input = teamPageInputSchema.parse(raw.query ?? {}); const scope = `team-members:${teamId}`; const after = this.listAfter(principal, scope, input.cursor)
      return this.page(principal, scope, this.all('SELECT m.*,p.displayName FROM team_members m JOIN people p ON p.userId=m.userId WHERE m.teamId=? AND m.userId>? ORDER BY m.userId LIMIT 501', teamId, after), 'userId', input.limit, () => true, (row) => ({ userId: text(row, 'userId'), displayName: text(row, 'displayName'), roles: rolesSchema.parse(json(row, 'rolesJson')), active: integer(row, 'active') === 1, revision: integer(row, 'revision') }))
    }
    if (operation === 'setTeamMember') {
      const teamId = id(raw.teamId); const parsed = teamMemberInputSchema.parse(raw.body); const input = { ...parsed, roles: uniqueRoles(parsed.roles) }
      return this.mutation(actor, input.commandId, operation, { teamId, ...input }, (p) => this.teamAdmin(p, teamId), () => {
        requireValue(this.get('SELECT userId FROM people WHERE userId=? AND active=1', input.userId), 'NOT_FOUND', 'Account must sign in before membership is assigned')
        const previous = this.get('SELECT * FROM team_members WHERE teamId=? AND userId=?', teamId, input.userId)
        if ((previous ? integer(previous, 'revision') : null) !== input.expectedRevision) throw new TeamServiceError('REVISION_CONFLICT', 'Team membership changed; reload before updating', 409)
        if (previous && rolesSchema.parse(json(previous, 'rolesJson')).includes('owner') && integer(previous, 'active') === 1 && (!input.active || !input.roles.includes('owner'))) {
          const others = this.all('SELECT rolesJson FROM team_members WHERE teamId=? AND userId<>? AND active=1', teamId, input.userId)
          if (!others.some((row) => rolesSchema.parse(json(row, 'rolesJson')).includes('owner'))) throw new TeamServiceError('LAST_OWNER', 'Assign another active owner before removing the last owner', 409)
        }
        const revision = (previous ? integer(previous, 'revision') : 0) + 1
        this.run('INSERT INTO team_members(teamId,userId,rolesJson,active,revision) VALUES(?,?,?,?,?) ON CONFLICT(teamId,userId) DO UPDATE SET rolesJson=excluded.rolesJson,active=excluded.active,revision=excluded.revision', teamId, input.userId, JSON.stringify(input.roles), input.active ? 1 : 0, revision)
        if (!input.active) this.run("UPDATE devices SET status='revoked' WHERE ownerId=? AND projectId IN(SELECT projectId FROM projects WHERE teamId=?) AND status='active'", input.userId, teamId)
        this.revokePersonInvitations(input.userId, teamId)
        this.bumpAuthorization(); this.event('team.membership-changed', 'team', teamId, null, { teamId, userId: input.userId, active: input.active, revision })
        return { teamId, userId: input.userId, roles: input.roles, active: input.active, revision }
      })
    }
    if (operation === 'projects') {
      const input = teamPageInputSchema.parse(raw.query ?? {}); const scope = 'projects'; const after = this.listAfter(principal, scope, input.cursor)
      return this.page(principal, scope, this.all('SELECT p.*,m.rolesJson FROM projects p JOIN project_members m ON m.projectId=p.projectId JOIN team_members t ON t.teamId=p.teamId AND t.userId=m.userId WHERE m.userId=? AND m.active=1 AND t.active=1 AND p.projectId>? ORDER BY p.projectId LIMIT 501', principal.person.userId, after), 'projectId', input.limit, (row) => actor.kind !== 'device' || text(row, 'projectId') === principal.projectId, (row): TeamProject => ({ projectId: text(row, 'projectId'), teamId: text(row, 'teamId'), name: text(row, 'name'), createdAt: integer(row, 'createdAt'), roles: projectMemberInputSchema.shape.roles.parse(json(row, 'rolesJson')) }))
    }
    if (operation === 'createProject') {
      const input = createTeamProjectSchema.parse(raw.body)
      return this.mutation(actor, input.commandId, operation, input, (p) => this.teamAdmin(p, input.teamId), (p) => {
        requireValue(this.get('SELECT teamId FROM teams WHERE teamId=?', input.teamId), 'NOT_FOUND', 'Team is unavailable')
        const projectId = randomUUID()
        this.run('INSERT INTO projects(projectId,teamId,name,createdAt) VALUES(?,?,?,?)', projectId, input.teamId, input.name, now())
        this.run('INSERT INTO project_members(projectId,userId,rolesJson,active,revision) VALUES(?,?,?,1,1)', projectId, p.person.userId, JSON.stringify(['admin']))
        this.bumpAuthorization(); this.event('project.created', 'project', projectId, projectId, { projectId, teamId: input.teamId, name: input.name })
        return { projectId, teamId: input.teamId, name: input.name }
      })
    }
    if (operation === 'projectMembers') {
      const projectId = id(raw.projectId); this.project(principal, projectId, true)
      const input = teamPageInputSchema.parse(raw.query ?? {}); const scope = `project-members:${projectId}`; const after = this.listAfter(principal, scope, input.cursor)
      return this.page(principal, scope, this.all('SELECT m.*,p.displayName FROM project_members m JOIN people p ON p.userId=m.userId WHERE m.projectId=? AND m.userId>? ORDER BY m.userId LIMIT 501', projectId, after), 'userId', input.limit, () => true, (row) => ({ userId: text(row, 'userId'), displayName: text(row, 'displayName'), roles: rolesSchema.parse(json(row, 'rolesJson')), active: integer(row, 'active') === 1, revision: integer(row, 'revision') }))
    }
    if (operation === 'setProjectMember') {
      const projectId = id(raw.projectId); const parsed = projectMemberInputSchema.parse(raw.body); const input = { ...parsed, roles: uniqueRoles(parsed.roles) }
      return this.mutation(actor, input.commandId, operation, { projectId, ...input }, (p) => { this.project(p, projectId, true) }, () => {
        const project = requireValue(this.get('SELECT teamId FROM projects WHERE projectId=?', projectId), 'NOT_FOUND', 'Project unavailable')
        if (input.active && !this.teamMembership(input.userId, text(project, 'teamId'))) throw new TeamServiceError('TEAM_MEMBERSHIP_REQUIRED', 'Add the account to the team before the project', 409)
        const previous = this.get('SELECT * FROM project_members WHERE projectId=? AND userId=?', projectId, input.userId)
        if ((previous ? integer(previous, 'revision') : null) !== input.expectedRevision) throw new TeamServiceError('REVISION_CONFLICT', 'Project membership changed; reload before updating', 409)
        const revision = (previous ? integer(previous, 'revision') : 0) + 1
        this.run('INSERT INTO project_members(projectId,userId,rolesJson,active,revision) VALUES(?,?,?,?,?) ON CONFLICT(projectId,userId) DO UPDATE SET rolesJson=excluded.rolesJson,active=excluded.active,revision=excluded.revision', projectId, input.userId, JSON.stringify(input.roles), input.active ? 1 : 0, revision)
        if (!input.active) this.run("UPDATE devices SET status='revoked' WHERE ownerId=? AND projectId=? AND status='active'", input.userId, projectId)
        this.revokePersonInvitations(input.userId, undefined, projectId)
        this.bumpAuthorization(); this.event('project.membership-changed', 'project', projectId, projectId, { projectId, userId: input.userId, active: input.active, revision })
        return { projectId, userId: input.userId, roles: input.roles, active: input.active, revision }
      })
    }
    if (operation === 'publish') return this.publish(actor, raw.body)
    if (operation === 'materials') {
      const input = teamListInputSchema.parse(raw.query ?? {}); if (input.projectId) this.project(principal, input.projectId)
      const scope = `materials:${input.projectId ?? '*'}`; const after = this.listAfter(principal, scope, input.cursor)
      return this.page(principal, scope, this.all('SELECT m.*,v.* FROM materials m JOIN material_versions v ON v.materialId=m.materialId AND v.version=m.latestVersion WHERE m.materialId>? ORDER BY m.materialId LIMIT 501', after), 'materialId', input.limit, (row) => (!input.projectId || text(row, 'projectId') === input.projectId) && this.canRead(principal, row), (row) => this.material(row))
    }
    if (operation === 'versions') {
      const materialId = id(raw.materialId); const input = teamPageInputSchema.parse(raw.query ?? {}); const scope = `versions:${materialId}`
      const after = z.coerce.number().int().positive().parse(this.listAfter(principal, scope, input.cursor, String(Number.MAX_SAFE_INTEGER)))
      const rows = this.all('SELECT m.*,v.* FROM materials m JOIN material_versions v ON v.materialId=m.materialId WHERE m.materialId=? AND v.version<? ORDER BY v.version DESC LIMIT 501', materialId, after)
      // An exhausted authorized page is empty; inaccessible material identity is not a successful empty list.
      const material = requireValue(this.get('SELECT * FROM materials WHERE materialId=?', materialId), 'NOT_FOUND', 'Material unavailable')
      if (actor.kind === 'device' && text(material, 'projectId') !== principal.projectId) forbidden()
      const owner = text(material, 'ownerId') === principal.person.userId
      if (!owner && !this.projectMembership(principal.person.userId, text(material, 'projectId')) && !this.teamMembership(principal.person.userId, text(material, 'teamId'))) forbidden()
      return this.page(principal, scope, rows, 'version', input.limit, (row) => this.canRead(principal, row), (row) => this.material(row))
    }
    if (operation === 'document') {
      const row = this.versionRow(id(raw.materialId), z.coerce.number().int().positive().parse(raw.version))
      if (!this.canRead(principal, row)) forbidden()
      const material = this.material(row); const body = this.blob(material.bodyDigest)
      if (body.length !== material.byteLength) throw new TeamServiceError('CORRUPT_STORE', 'Stored body length disagrees with its version', 503)
      return { material, text: body.toString('utf8') } satisfies TeamPublishedDocument
    }
    if (operation === 'recordFeedback') {
      const input = teamFeedbackInputSchema.parse(raw.body)
      return this.mutation(actor, input.commandId, operation, input, (p) => { const version = this.versionRow(input.materialId, input.version); if (!this.canRead(p, version)) forbidden() }, (p) => {
        if (this.get('SELECT feedbackId FROM feedback WHERE feedbackId=?', input.feedbackId)) throw new TeamServiceError('REVISION_CONFLICT', 'Feedback identity already exists', 409)
        const version = this.versionRow(input.materialId, input.version)
        if (input.anchor || input.quote) {
          const content = this.blob(text(version, 'bodyDigest')).toString('utf8')
          if (input.anchor && (input.anchor.end > content.length || (input.quote !== undefined && content.slice(input.anchor.start, input.anchor.end) !== input.quote))) throw new TeamServiceError('ANCHOR_CONFLICT', 'Feedback anchor does not match the selected immutable version', 409)
          if (input.quote && !content.includes(input.quote)) throw new TeamServiceError('ANCHOR_CONFLICT', 'Quoted text does not exist in the selected immutable version', 409)
        }
        this.run('INSERT INTO feedback(feedbackId,materialId,version,authorId,body,quote,anchorJson,createdAt) VALUES(?,?,?,?,?,?,?,?)', input.feedbackId, input.materialId, input.version, p.person.userId, input.body, input.quote ?? null, input.anchor ? JSON.stringify(input.anchor) : null, now())
        this.event('feedback.recorded', text(version, 'visibility') as TeamVisibility, text(version, 'visibility') === 'personal' ? text(version, 'ownerId') : text(version, 'visibility') === 'project' ? text(version, 'projectId') : text(version, 'teamId'), text(version, 'projectId'), { feedbackId: input.feedbackId, materialId: input.materialId, version: input.version, state: 'recorded', applied: false })
        return this.feedbackRow(requireValue(this.get('SELECT * FROM feedback WHERE feedbackId=?', input.feedbackId), 'STORE_UNAVAILABLE', 'Feedback was not persisted', 503))
      })
    }
    if (operation === 'feedback') {
      const materialId = id(raw.materialId); const version = z.coerce.number().int().positive().parse(raw.version)
      if (!this.canRead(principal, this.versionRow(materialId, version))) forbidden()
      const input = teamPageInputSchema.parse(raw.query ?? {}); const scope = `feedback:${materialId}:${version}`; const after = this.listAfter(principal, scope, input.cursor)
      return this.page(principal, scope, this.all('SELECT * FROM feedback WHERE materialId=? AND version=? AND feedbackId>? ORDER BY feedbackId LIMIT ?', materialId, version, after, input.limit + 1), 'feedbackId', input.limit, () => true, (row) => this.feedbackRow(row))
    }
    if (operation === 'pairing') {
      if (actor.kind !== 'session') forbidden()
      const row = requireValue(this.get('SELECT * FROM devices WHERE pairingId=?', id(raw.pairingId)), 'NOT_FOUND', 'Device pairing unavailable')
      if (row.projectId !== null) this.project(principal, text(row, 'projectId'))
      return { ...this.device(row), pairingId: text(row, 'pairingId'), expiresAt: integer(row, 'expiresAt') }
    }
    if (operation === 'approveDevice') {
      const pairingId = id(raw.pairingId); const input = deviceApproveInputSchema.parse(raw.body)
      return this.mutation(actor, input.commandId, operation, { pairingId, ...input }, (p) => { if (p.actor.kind !== 'session') forbidden(); this.project(p, input.expectedProjectId) }, (p) => {
        const row = requireValue(this.get('SELECT * FROM devices WHERE pairingId=?', pairingId), 'NOT_FOUND', 'Device pairing unavailable')
        if ((row.projectId !== null && text(row, 'projectId') !== input.expectedProjectId) || text(row, 'status') !== 'pending' || integer(row, 'expiresAt') <= now() || !safeEqual(text(row, 'userCode'), input.userCode)) throw new TeamServiceError('PAIRING_CONFLICT', 'Device pairing is expired, already used or does not match the selected project/code', 409)
        const count = integer(requireValue(this.get("SELECT COUNT(*) AS total FROM devices WHERE ownerId=? AND status='active'", p.person.userId), 'STORE_UNAVAILABLE', 'Device store unavailable', 503), 'total')
        if (count >= 100) throw new TeamServiceError('CAPACITY_EXCEEDED', 'Revoke an old device before adding more', 409)
        this.run("UPDATE devices SET status='active',ownerId=?,projectId=? WHERE pairingId=?", p.person.userId, input.expectedProjectId, pairingId)
        this.bumpAuthorization(); this.event('device.approved', 'personal', p.person.userId, input.expectedProjectId, { deviceId: text(row, 'deviceId'), projectId: input.expectedProjectId })
        return { deviceId: text(row, 'deviceId'), projectId: input.expectedProjectId, ownerId: p.person.userId, decision: 'approved', approvedAt: now() }
      })
    }
    if (operation === 'devices') {
      if (actor.kind !== 'session') forbidden()
      const input = teamPageInputSchema.parse(raw.query ?? {}); const scope = 'devices'; const after = this.listAfter(principal, scope, input.cursor)
      return this.page(principal, scope, this.all('SELECT * FROM devices WHERE ownerId=? AND deviceId>? ORDER BY deviceId LIMIT 501', principal.person.userId, after), 'deviceId', input.limit, () => true, (row) => this.device(row))
    }
    if (operation === 'revokeDevice') {
      const deviceId = id(raw.deviceId); const input = deviceRevokeInputSchema.parse(raw.body)
      return this.mutation(actor, input.commandId, operation, { deviceId, ...input }, (p) => { const device = requireValue(this.get('SELECT * FROM devices WHERE deviceId=?', deviceId), 'NOT_FOUND', 'Device unavailable'); if (p.actor.kind !== 'session' || text(device, 'ownerId') !== p.person.userId) forbidden() }, (p) => {
        this.run("UPDATE devices SET status='revoked' WHERE deviceId=?", deviceId)
        this.bumpAuthorization(); this.event('device.revoked', 'personal', p.person.userId, null, { deviceId })
        return { deviceId, status: 'revoked' }
      })
    }
    if (operation === 'heartbeat') {
      if (actor.kind !== 'device' || !principal.deviceId) forbidden()
      const parsed = deviceHeartbeatInputSchema.parse(raw.body); const input = { ...parsed, capabilityClaims: uniqueRoles(parsed.capabilityClaims) }
      const row = requireValue(this.get('SELECT * FROM devices WHERE deviceId=?', principal.deviceId), 'UNAUTHORIZED', 'Authentication is required', 401)
      if (input.sequence < integer(row, 'sequence') || (input.sequence === integer(row, 'sequence') && JSON.stringify(input.capabilityClaims) !== text(row, 'capabilityClaimsJson'))) throw new TeamServiceError('SEQUENCE_CONFLICT', 'Heartbeat sequence is stale or inconsistent', 409)
      if (input.sequence > integer(row, 'sequence')) this.run('UPDATE devices SET sequence=?,capabilityClaimsJson=?,lastSeenAt=? WHERE deviceId=?', input.sequence, JSON.stringify(input.capabilityClaims), now(), principal.deviceId)
      return this.device(requireValue(this.get('SELECT * FROM devices WHERE deviceId=?', principal.deviceId), 'STORE_UNAVAILABLE', 'Device state unavailable', 503))
    }
    throw new TeamServiceError('UNSUPPORTED_OPERATION', 'Unknown team operation', 404)
  }

  private publish(actor: StoreActor, raw: unknown): TeamCommandReply<TeamMaterialVersion> {
    const input = publicationInputSchema.parse(raw); const principal = this.authenticate(actor)
    const authorize = (p: StorePrincipal): void => {
      const project = this.project(p, input.projectId)
      if (input.visibility === 'team' && !this.teamMembership(p.person.userId, text(project, 'teamId'))) forbidden()
      const material = this.get('SELECT * FROM materials WHERE materialId=?', input.materialId)
      if (material && (text(material, 'ownerId') !== p.person.userId || text(material, 'projectId') !== input.projectId)) forbidden()
    }
    authorize(principal)
    const requestHash = digest(canonical({ kind: 'publish', input }))
    const previous = this.get('SELECT kind,requestHash,resultJson FROM commands WHERE userId=? AND commandId=?', principal.person.userId, input.commandId)
    if (previous) {
      if (text(previous, 'kind') !== 'publish' || text(previous, 'requestHash') !== requestHash) throw new TeamServiceError('COMMAND_CONFLICT', 'Command identity already describes a different request', 409)
      return { status: 'duplicate', commandId: input.commandId, result: json(previous, 'resultJson') as TeamMaterialVersion }
    }
    const existing = this.get('SELECT latestVersion FROM materials WHERE materialId=?', input.materialId)
    if ((existing ? integer(existing, 'latestVersion') : null) !== input.expectedVersion) throw new TeamServiceError('REVISION_CONFLICT', 'Published material version changed; reload before publishing', 409)
    const bytes = Buffer.from(input.text, 'utf8'); const bodyDigest = digest(bytes)
    if (bytes.length > MAX_DOCUMENT_BYTES) throw new TeamServiceError('CAPACITY_EXCEEDED', 'Material exceeds the one MiB UTF-8 body limit', 413)
    if (input.expectedDigest && input.expectedDigest !== bodyDigest) throw new TeamServiceError('DIGEST_CONFLICT', 'Published content digest does not match the selected bytes', 409)
    const total = integer(requireValue(this.get('SELECT COALESCE(SUM(byteLength),0) AS total FROM blobs'), 'STORE_UNAVAILABLE', 'Blob quota unavailable', 503), 'total')
    if (!this.get('SELECT bodyDigest FROM blobs WHERE bodyDigest=?', bodyDigest) && total + bytes.length > MAX_BLOB_BYTES) throw new TeamServiceError('CAPACITY_EXCEEDED', 'Team blob quota is full; existing versions were preserved', 507)
    // Blob persistence is outside the metadata transaction. Orphans are not visible documents.
    this.persistBlob(bytes, bodyDigest)
    return this.mutation(actor, input.commandId, 'publish', input, authorize, (p) => {
      const project = this.project(p, input.projectId)
      const latest = this.get('SELECT latestVersion FROM materials WHERE materialId=?', input.materialId)
      if ((latest ? integer(latest, 'latestVersion') : null) !== input.expectedVersion) throw new TeamServiceError('REVISION_CONFLICT', 'Published material changed before admission', 409)
      const version = (input.expectedVersion ?? 0) + 1; const timestamp = now()
      if (!latest) this.run('INSERT INTO materials(materialId,projectId,teamId,ownerId,latestVersion,createdAt) VALUES(?,?,?,?,?,?)', input.materialId, input.projectId, text(project, 'teamId'), p.person.userId, version, timestamp)
      else this.run('UPDATE materials SET latestVersion=? WHERE materialId=?', version, input.materialId)
      if (!this.get('SELECT bodyDigest FROM blobs WHERE bodyDigest=?', bodyDigest)) this.run('INSERT INTO blobs(bodyDigest,byteLength,createdAt) VALUES(?,?,?)', bodyDigest, bytes.length, timestamp)
      this.run('INSERT INTO material_versions(materialId,version,title,kind,visibility,bodyDigest,sourceJson,authorId,createdAt) VALUES(?,?,?,?,?,?,?,?,?)', input.materialId, version, input.title, input.kind, input.visibility, bodyDigest, JSON.stringify(input.source), p.person.userId, timestamp)
      this.event('material.published', input.visibility, input.visibility === 'personal' ? p.person.userId : input.visibility === 'project' ? input.projectId : text(project, 'teamId'), input.projectId, { materialId: input.materialId, version, bodyDigest, title: input.title, kind: input.kind })
      return this.material(this.versionRow(input.materialId, version))
    })
  }

  private async backup(destination: string): Promise<{ destination: string; blobCount: number; instanceId: string; epoch: string }> {
    const requested = resolve(destination); const target = join(realpathSync(dirname(requested)), basename(requested)); const rel = relative(this.directory, target)
    if (!isAbsolute(target) || rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))) throw new TeamServiceError('INVALID_BACKUP', 'Backup target must be a new directory outside the active store')
    if (existsSync(target)) throw new TeamServiceError('INVALID_BACKUP', 'Backup target already exists; existing backups are never overwritten', 409)
    mkdirSync(target, { mode: 0o700 }); mkdirSync(join(target, 'blobs'), { mode: 0o700 })
    await sqliteBackup(this.db, join(target, 'team.sqlite'))
    const files = this.all('SELECT bodyDigest,byteLength FROM blobs ORDER BY bodyDigest')
    if (files.length > MAX_DIRECTORY_ENTRIES) throw new TeamServiceError('CAPACITY_EXCEEDED', 'Backup blob count exceeds its bound', 503)
    const hashes: Array<{ digest: string; byteLength: number }> = []
    for (const file of files) { const hash = text(file, 'bodyDigest'); const body = this.blob(hash); if (body.length !== integer(file, 'byteLength')) throw new TeamServiceError('CORRUPT_STORE', 'Backup source body length is inconsistent', 503); writeFileSync(join(target, 'blobs', hash), body, { flag: 'wx', mode: 0o600 }); hashes.push({ digest: hash, byteLength: body.length }) }
    const manifest = { schemaVersion: 1, databaseSchemaVersion: TEAM_SCHEMA_VERSION, databaseDigest: fileDigest(join(target, 'team.sqlite')), instanceId: this.meta('instanceId'), epoch: this.meta('epoch'), blobs: hashes, createdAt: now() }
    writeFileSync(join(target, 'backup.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    return { destination: target, blobCount: hashes.length, instanceId: manifest.instanceId, epoch: manifest.epoch }
  }
}
