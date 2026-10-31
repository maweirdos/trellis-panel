import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { canReadHifoxSpace } from '../../../src/shared/hifox-domain/commands'
import { hifoxSnapshotSchema } from '../../../src/shared/hifox-schema'
import type { HifoxSpace } from '../../../src/shared/hifox'
import {
  governanceCommandSchema, governanceListQuerySchema, governancePackageSchema, governanceReceiptSchema, governanceVersionSchema,
  type GovernanceCommand, type GovernancePackage, type GovernanceReceipt, type GovernanceVersion
} from '../../../src/shared/team-governance'
import { teamCommandIdSchema, teamIdSchema, type TeamCommandReply } from '../../../src/shared/team-platform'
import { teamTaskProgressResourceIdSchema } from '../../../src/shared/team-task-progress'
import { TeamServiceError } from './errors'
import type { TaskMaterialsHost } from './task-materials'
import type { StoreActor, StorePrincipal } from './store-types'

export type GovernanceHost = TaskMaterialsHost
export type GovernanceContext = { principal: StorePrincipal; projectId: string; space: HifoxSpace; workspaceRevision: number }
export const governanceHash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
export function governanceFail(code: string, message: string, status = 409): never { throw new TeamServiceError(code, message, status) }
export function governanceStored<T>(schema: z.ZodType<T>, raw: unknown): T {
  try { return schema.parse(typeof raw === 'string' ? JSON.parse(raw) : raw) }
  catch { return governanceFail('CORRUPT_STORE', 'Stored governance data is invalid', 503) }
}
export function governanceCas(actual: number, expected: number): void {
  if (actual !== expected) governanceFail('GOVERNANCE_REVISION_CONFLICT', 'The original revision changed; reload and compare before creating a new intent')
}
export function governanceNext(value: number): number {
  if (!Number.isSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER) governanceFail('CAPACITY_EXCEEDED', 'Governance revision exhausted', 503)
  return value + 1
}

export class TeamGovernance {
  constructor(private readonly host: GovernanceHost) {}

  context(principal: StorePrincipal, projectId: string, spaceId: string, writing = false): GovernanceContext {
    this.host.project(principal, teamIdSchema.parse(projectId))
    const row = this.host.get("SELECT w.revision,s.value AS body FROM hifox_workspaces w,json_each(w.snapshotJson,'$.spaces') s WHERE w.projectId=? AND json_extract(s.value,'$.id')=?", projectId, teamTaskProgressResourceIdSchema.parse(spaceId))
    if (!row) governanceFail('GOVERNANCE_UNAVAILABLE', 'Space governance is unavailable', 404)
    const space = governanceStored(hifoxSnapshotSchema.shape.spaces.element, row.body)
    if (!canReadHifoxSpace(space, principal.person.userId)) governanceFail('GOVERNANCE_UNAVAILABLE', 'Space governance is unavailable', 404)
    if (writing && (space.archived || !space.memberIds.includes(principal.person.userId))) governanceFail('GOVERNANCE_FORBIDDEN', 'An active space membership is required', 403)
    return { principal, projectId, space, workspaceRevision: governanceStored(z.number().int().nonnegative().safe(), row.revision) }
  }

  manager(ctx: GovernanceContext): boolean {
    if (!ctx.space.memberIds.includes(ctx.principal.person.userId)) return false
    if (ctx.space.ownerId === ctx.principal.person.userId) return true
    const row = this.host.get('SELECT pm.rolesJson,tm.rolesJson AS teamRoles FROM project_members pm JOIN projects p ON p.projectId=pm.projectId JOIN team_members tm ON tm.teamId=p.teamId AND tm.userId=pm.userId WHERE pm.projectId=? AND pm.userId=? AND pm.active=1 AND tm.active=1', ctx.projectId, ctx.principal.person.userId)
    return !!row && [row.rolesJson, row.teamRoles].some(raw => governanceStored(z.array(z.string()), raw).some(role => role === 'admin' || role === 'owner'))
  }

  private participants(ctx: GovernanceContext, ids: string[]): void {
    for (const id of new Set(ids)) {
      const active = this.host.get('SELECT p.userId FROM people p JOIN project_members pm ON pm.userId=p.userId JOIN projects pr ON pr.projectId=pm.projectId JOIN team_members tm ON tm.teamId=pr.teamId AND tm.userId=p.userId WHERE p.userId=? AND pm.projectId=? AND p.active=1 AND pm.active=1 AND tm.active=1', id, ctx.projectId)
      if (!active || !ctx.space.memberIds.includes(id)) governanceFail('GOVERNANCE_GRANT_CONFLICT', 'Maintainers and approvers must be active space members')
    }
  }

  package(ctx: GovernanceContext, packageId: string): GovernancePackage {
    const row = this.host.get('SELECT recordJson FROM governance_packages WHERE packageId=? AND projectId=? AND spaceId=?', teamIdSchema.parse(packageId), ctx.projectId, ctx.space.id)
    if (!row) governanceFail('GOVERNANCE_UNAVAILABLE', 'Package is unavailable in this space', 404)
    const pkg = governanceStored(governancePackageSchema, row.recordJson)
    if (pkg.packageId !== packageId || pkg.projectId !== ctx.projectId || pkg.spaceId !== ctx.space.id) governanceFail('CORRUPT_STORE', 'Package metadata changed its original space identity', 503)
    return pkg
  }

  version(ctx: GovernanceContext, packageId: string, versionId: string, published = false): GovernanceVersion {
    const pkg = this.package(ctx, packageId)
    const row = this.host.get('SELECT recordJson FROM governance_versions WHERE packageId=? AND versionId=?', pkg.packageId, teamIdSchema.parse(versionId))
    if (!row) governanceFail('GOVERNANCE_UNAVAILABLE', 'Fixed package version is unavailable', 404)
    const version = governanceStored(governanceVersionSchema, row.recordJson)
    if (version.settings.kind !== pkg.kind || version.packageId !== pkg.packageId || version.versionId !== versionId) governanceFail('CORRUPT_STORE', 'Governance version identity is invalid', 503)
    if (published && !this.host.get('SELECT versionId FROM governance_publications WHERE packageId=? AND versionId=?', packageId, versionId)) governanceFail('GOVERNANCE_NOT_PUBLISHED', 'Only a published fixed version can be adopted')
    return version
  }

  withdrawn(packageId: string, versionId: string): boolean {
    return !!this.host.get('SELECT versionId FROM governance_publications WHERE packageId=? AND versionId=? AND withdrawnAt IS NOT NULL', packageId, versionId)
  }

  text(version: GovernanceVersion): string {
    const bytes = this.host.body(version.bodyDigest)
    if (bytes.length !== version.byteLength || governanceHash(bytes) !== version.bodyDigest) governanceFail('CORRUPT_STORE', 'Fixed governance body failed verification', 503)
    return bytes.toString('utf8')
  }

  packages(ctx: GovernanceContext): GovernancePackage[] {
    const rows = this.host.all('SELECT recordJson FROM governance_packages WHERE projectId=? AND spaceId=? ORDER BY packageId LIMIT 129', ctx.projectId, ctx.space.id)
    if (rows.length > 128) governanceFail('CAPACITY_EXCEEDED', 'Space governance exceeds its bounded catalog', 413)
    return rows.map(row => governanceStored(governancePackageSchema, row.recordJson))
  }

  list(principal: StorePrincipal, raw: Record<string, unknown>): unknown {
    const query = governanceListQuerySchema.parse({ ...z.record(z.string(), z.unknown()).parse(raw.query ?? {}), spaceId: raw.spaceId })
    const ctx = this.context(principal, teamIdSchema.parse(raw.projectId), query.spaceId)
    const heads = this.host.all('SELECT packageId,revision FROM governance_packages WHERE projectId=? AND spaceId=? ORDER BY packageId LIMIT 129', ctx.projectId, ctx.space.id)
    const scope = JSON.stringify(['governance', ctx.projectId, ctx.space.id, ctx.workspaceRevision, governanceHash(JSON.stringify(heads))])
    const rows = this.host.all('SELECT packageId,recordJson FROM governance_packages WHERE projectId=? AND spaceId=? AND packageId>? ORDER BY packageId LIMIT 129', ctx.projectId, ctx.space.id, this.host.after(principal, scope, query.cursor))
    return { ...this.host.identity(), projectId: ctx.projectId, spaceId: ctx.space.id, page: this.host.page(principal, scope, rows, 'packageId', query.limit, () => true, row => governanceStored(governancePackageSchema, row.recordJson)) }
  }

  read(principal: StorePrincipal, raw: Record<string, unknown>): unknown {
    const query = z.object({ versionId: teamIdSchema.optional() }).strict().parse(raw.query ?? {})
    const ctx = this.context(principal, teamIdSchema.parse(raw.projectId), teamTaskProgressResourceIdSchema.parse(raw.spaceId))
    const pkg = this.package(ctx, teamIdSchema.parse(raw.packageId)), selected = this.version(ctx, pkg.packageId, query.versionId ?? pkg.draft.versionId)
    return { ...this.host.identity(), package: pkg, selected, text: this.text(selected) }
  }

  authorizeReceipt(principal: StorePrincipal, raw: unknown): GovernanceReceipt {
    const receipt = governanceStored(governanceReceiptSchema, raw)
    if (receipt.actorId !== principal.person.userId || receipt.deviceId !== principal.deviceId) governanceFail('GOVERNANCE_FORBIDDEN', 'Receipt belongs to its original account and device', 403)
    const ctx = this.context(principal, receipt.projectId, receipt.spaceId)
    this.package(ctx, receipt.packageId)
    return receipt
  }

  receipt(principal: StorePrincipal, raw: Record<string, unknown>): GovernanceReceipt | null {
    const ctx = this.context(principal, teamIdSchema.parse(raw.projectId), teamTaskProgressResourceIdSchema.parse(raw.spaceId))
    const row = this.host.get('SELECT kind,resultJson FROM commands WHERE userId=? AND commandId=?', principal.person.userId, teamCommandIdSchema.parse(raw.commandId))
    if (!row) return null
    if (row.kind !== 'governanceCommand') governanceFail('GOVERNANCE_UNAVAILABLE', 'Receipt unavailable in this scope', 404)
    const result = this.authorizeReceipt(principal, row.resultJson)
    if (result.projectId !== ctx.projectId || result.spaceId !== ctx.space.id) governanceFail('GOVERNANCE_UNAVAILABLE', 'Receipt unavailable in this scope', 404)
    return result
  }

  private authorize(ctx: GovernanceContext, input: GovernanceCommand): void {
    if (input.expectedEpoch !== this.host.identity().epoch) governanceFail('WORKSPACE_EPOCH_CHANGED', 'The original service epoch changed; do not retarget the command')
    const actor = ctx.principal.person.userId
    if (input.action === 'create') {
      if (!this.manager(ctx)) governanceFail('GOVERNANCE_FORBIDDEN', 'Only space administrators may create packages', 403)
    } else {
      const pkg = this.package(ctx, input.packageId)
      const permitted = input.action === 'publish' ? pkg.approverIds.includes(actor)
        : ['setAccess', 'withdrawVersion', 'disable'].includes(input.action) ? this.manager(ctx) || pkg.ownerId === actor
          : this.manager(ctx) || pkg.maintainerIds.includes(actor)
      if (!permitted) governanceFail('GOVERNANCE_FORBIDDEN', 'Current person has no grant for this package operation', 403)
    }
    if (input.action === 'create' || input.action === 'setAccess') this.participants(ctx, [...input.maintainerIds, ...input.approverIds])
  }

  command(actor: StoreActor, raw: Record<string, unknown>): TeamCommandReply<GovernanceReceipt> {
    const input = governanceCommandSchema.parse(raw.body), projectId = teamIdSchema.parse(raw.projectId), spaceId = teamTaskProgressResourceIdSchema.parse(raw.spaceId)
    if (spaceId !== input.spaceId) governanceFail('GOVERNANCE_SCOPE_CONFLICT', 'The command cannot change its original space')
    return this.host.mutation(actor, input.commandId, 'governanceCommand', { projectId, spaceId, input },
      principal => this.authorize(this.context(principal, projectId, spaceId, true), input),
      principal => this.apply(this.context(principal, projectId, spaceId, true), input),
      (principal, result) => { this.authorizeReceipt(principal, result) })
  }

  private saveVersion(ctx: GovernanceContext, packageId: string, number: number, input: Extract<GovernanceCommand, { action: 'create' | 'saveDraft' }>): GovernanceVersion {
    const count = this.host.get('SELECT COUNT(*) AS count FROM governance_versions WHERE packageId=?', packageId)
    if (!count || typeof count.count !== 'number' || count.count >= 1000) governanceFail('CAPACITY_EXCEEDED', 'Package version capacity reached', 413)
    const bytes = Buffer.from(input.text, 'utf8'), bodyDigest = governanceHash(bytes)
    if (!input.text.trim() || bytes.length > 1024 * 1024) governanceFail('INVALID_INPUT', 'A nonempty body within one MiB UTF-8 is required', 400)
    if (!this.host.get('SELECT bodyDigest FROM blobs WHERE bodyDigest=?', bodyDigest)) {
      const usage = this.host.get('SELECT COALESCE(SUM(byteLength),0) AS bytes FROM blobs')
      if (!usage || typeof usage.bytes !== 'number' || usage.bytes + bytes.length > 1024 * 1024 * 1024) governanceFail('CAPACITY_EXCEEDED', 'Team body capacity reached', 507)
    }
    this.host.persistBody(bytes, bodyDigest)
    this.host.run('INSERT INTO blobs(bodyDigest,byteLength,createdAt) VALUES(?,?,?) ON CONFLICT(bodyDigest) DO NOTHING', bodyDigest, bytes.length, Date.now())
    const version = governanceVersionSchema.parse({ packageId, versionId: randomUUID(), number, title: input.title, bodyDigest, byteLength: bytes.length, settings: input.settings, authorId: ctx.principal.person.userId, createdAt: Date.now() })
    this.host.run('INSERT INTO governance_versions(versionId,packageId,number,bodyDigest,recordJson) VALUES(?,?,?,?,?)', version.versionId, packageId, number, bodyDigest, JSON.stringify(version))
    return version
  }

  private apply(ctx: GovernanceContext, input: GovernanceCommand): GovernanceReceipt {
    let pkg: GovernancePackage
    let versionId: string | null = null
    if (input.action === 'create') {
      if (this.packages(ctx).length >= 128) governanceFail('CAPACITY_EXCEEDED', 'Space package capacity reached', 413)
      const packageId = randomUUID(), timestamp = Date.now()
      this.host.run('INSERT INTO governance_packages(packageId,projectId,spaceId,revision,recordJson) VALUES(?,?,?,?,?)', packageId, ctx.projectId, ctx.space.id, 1, '{}')
      const draft = this.saveVersion(ctx, packageId, 1, input)
      pkg = { packageId, projectId: ctx.projectId, spaceId: ctx.space.id, kind: input.settings.kind, ownerId: ctx.principal.person.userId, maintainerIds: input.maintainerIds, approverIds: input.approverIds, revision: 1, status: 'draft', publicationActive: false, draft, submittedVersionId: null, published: null, withdrawnVersionIds: [], publishedBy: null, publishedAt: null, createdAt: timestamp, updatedAt: timestamp }
      versionId = draft.versionId
    } else {
      pkg = this.package(ctx, input.packageId)
      governanceCas(pkg.revision, input.expectedRevision)
      if (input.action === 'saveDraft') {
        if (input.settings.kind !== pkg.kind) governanceFail('GOVERNANCE_KIND_CONFLICT', 'Package kind cannot change')
        pkg.draft = this.saveVersion(ctx, pkg.packageId, governanceNext(pkg.draft.number), input)
        pkg.submittedVersionId = null; pkg.status = 'draft'; versionId = pkg.draft.versionId
      } else if (input.action === 'setAccess') {
        pkg.maintainerIds = input.maintainerIds; pkg.approverIds = input.approverIds
      } else if (input.action === 'disable') { pkg.status = 'disabled'; pkg.publicationActive = false }
      else if (input.action === 'withdrawVersion') {
        this.version(ctx, pkg.packageId, input.versionId, true)
        if (this.withdrawn(pkg.packageId, input.versionId)) governanceFail('GOVERNANCE_WITHDRAWN', 'This fixed publication was already withdrawn')
        this.host.run('UPDATE governance_publications SET withdrawnBy=?,withdrawnAt=?,reason=? WHERE packageId=? AND versionId=?', ctx.principal.person.userId, Date.now(), input.reason, pkg.packageId, input.versionId)
        pkg.withdrawnVersionIds.push(input.versionId); versionId = input.versionId
        if (pkg.published?.versionId === input.versionId) { pkg.status = 'disabled'; pkg.publicationActive = false }
      } else {
        if (input.versionId !== pkg.draft.versionId) governanceFail('GOVERNANCE_VERSION_CONFLICT', 'Submit and publish must name the exact current fixed draft')
        this.text(pkg.draft)
        if (input.action === 'submit') { pkg.submittedVersionId = input.versionId; pkg.status = 'review' }
        else {
          if (pkg.status !== 'review' || pkg.submittedVersionId !== input.versionId) governanceFail('GOVERNANCE_REVIEW_REQUIRED', 'Publish the exact submitted version after review')
          if (this.host.get('SELECT versionId FROM governance_publications WHERE packageId=? AND versionId=?', pkg.packageId, input.versionId)) governanceFail('GOVERNANCE_ALREADY_PUBLISHED', 'Save a revised draft before publishing again')
          this.host.run('INSERT INTO governance_publications(packageId,versionId,publishedBy,publishedAt) VALUES(?,?,?,?)', pkg.packageId, input.versionId, ctx.principal.person.userId, Date.now())
          pkg.published = pkg.draft; pkg.publishedBy = ctx.principal.person.userId; pkg.publishedAt = Date.now(); pkg.status = 'published'; pkg.publicationActive = true
        }
        versionId = input.versionId
      }
      pkg.revision = governanceNext(pkg.revision); pkg.updatedAt = Date.now()
    }
    pkg = governancePackageSchema.parse(pkg)
    this.host.run('UPDATE governance_packages SET revision=?,recordJson=? WHERE packageId=?', pkg.revision, JSON.stringify(pkg), pkg.packageId)
    return governanceReceiptSchema.parse({ ...this.host.identity(), projectId: ctx.projectId, spaceId: ctx.space.id, commandId: input.commandId, action: input.action, packageId: pkg.packageId, revision: pkg.revision, versionId, actorId: ctx.principal.person.userId, deviceId: ctx.principal.deviceId, committedAt: Date.now() })
  }
}
