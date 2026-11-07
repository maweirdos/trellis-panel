import { randomUUID } from 'node:crypto'
import type { SQLInputValue, SQLOutputValue } from 'node:sqlite'
import { z } from 'zod'
import { teamCommandIdSchema, teamIdSchema } from '../../../src/shared/team-platform'
import { cruxSnapshotSchema } from '../../../src/shared/crux-schema'
import { canReadCruxSpace } from '../../../src/shared/crux-domain/commands'
import {
  TEAM_CONTENT_MAX_TEXT_BYTES, TEAM_CONTENT_MAX_OUTPUT_BYTES, teamContentConfigSchema, teamContentConfigureSchema, teamContentGenerateSchema,
  teamContentProbeSchema, teamContentJobSchema, teamContentCancelSchema, teamContentReconcileSchema,
  teamContentReadinessSchema, teamContentBudgetSchema, teamContentBudgetScopeSchema, teamContentScopeIdSchema,
  type TeamContentConfig, type TeamContentJob, type TeamContentJobReply, type TeamContentReadiness, type TeamContentBudget
} from '../../../src/shared/team-content'
import { TeamServiceError } from './errors'
import type { StoreActor, StorePrincipal } from './store-types'
import { contentCredentialAvailable, decryptContentCredential, encryptContentCredential, validateContentEndpoint } from './content-credentials'
import { contentDigest, contentProviderEnvelopeSchema, contentProviderResultSchema, type ContentProviderEnvelope } from './content-provider'
import { contentMessages, type ContentMaterialEvidence } from './content-prompts'
import type { TaskContentRule } from './task-inputs'

type Row = Record<string, SQLOutputValue>
export type ContentHost = {
  identity(): { instanceId: string; epoch: string }
  get(sql: string, ...args: SQLInputValue[]): Row | undefined
  all(sql: string, ...args: SQLInputValue[]): Row[]
  run(sql: string, ...args: SQLInputValue[]): void
  transaction<T>(fn: () => T): T
  authenticate(actor: StoreActor): StorePrincipal
  project(principal: StorePrincipal, projectId: string): void
  teamAdmin(principal: StorePrincipal, teamId: string): void
  material(principal: StorePrincipal, projectId: string, documentId: string, version: number): ContentMaterialEvidence
  rules(principal: StorePrincipal, scope: { projectId: string; taskId: string; spaceId: string; taskCreatedAt: string }): TaskContentRule[]
  rule(principal: StorePrincipal, scope: { projectId: string; taskId: string; spaceId: string; taskCreatedAt: string }, packageId: string, versionId: string): TaskContentRule
}
const actorSchema = z.object({ kind: z.enum(['session', 'device']), credentialHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
const privateSchema = z.object({ actor: actorSchema, messages: contentProviderEnvelopeSchema.shape.messages,
  timeoutMs: contentProviderEnvelopeSchema.shape.timeoutMs }).strict()
type Task = z.infer<typeof cruxSnapshotSchema.shape.tasks.element>
function fail(code: string, message: string, status = 409): never { throw new TeamServiceError(code, message, status) }
function text(row: Row, key: string): string {
  if (typeof row[key] !== 'string') fail('CORRUPT_STORE', 'Content metadata is invalid', 503)
  return row[key] as string
}
function saved<T>(schema: z.ZodType<T>, raw: unknown): T {
  try { return schema.parse(typeof raw === 'string' ? JSON.parse(raw) : raw) }
  catch { return fail('CORRUPT_STORE', 'Stored content data failed validation', 503) }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}'
  return JSON.stringify(value)
}
function ownerKey(p: StorePrincipal): string { return p.deviceId ? `device:${p.deviceId}` : 'browser' }
function day(): string { return new Date().toISOString().slice(0, 10) }

/** Persistence/authorization only. No provider I/O is allowed on the owned SQLite writer. */
export class TeamContent {
  constructor(private readonly host: ContentHost) {}

  private epoch(expected: string): void {
    if (expected !== this.host.identity().epoch) fail('CONTENT_EPOCH_CHANGED', 'Retain this command under its original service epoch; reload current capabilities')
  }
  private admin(principal: StorePrincipal, teamId: string): void {
    this.host.teamAdmin(principal, teamId)
    if (!this.host.get('SELECT teamId FROM teams WHERE teamId=?', teamId)) fail('NOT_FOUND', 'Team is unavailable', 404)
  }
  private canManage(principal: StorePrincipal, teamId: string): boolean {
    try { this.admin(principal, teamId); return true } catch (error) {
      if (error instanceof TeamServiceError && error.statusCode === 403) return false
      throw error
    }
  }
  private projectTeam(principal: StorePrincipal, projectId: string): string {
    this.host.project(principal, projectId)
    const row = this.host.get('SELECT teamId FROM projects WHERE projectId=?', projectId)
    if (!row) fail('NOT_FOUND', 'Project is unavailable', 404)
    return text(row, 'teamId')
  }
  private task(principal: StorePrincipal, projectId: string, taskId: string, expected?: { spaceId: string | null; taskCreatedAt: string | null }, writing = false): Task {
    this.projectTeam(principal, projectId)
    const row = this.host.get("SELECT t.value AS body FROM crux_workspaces w,json_each(w.snapshotJson,'$.tasks') t WHERE w.projectId=? AND json_extract(t.value,'$.id')=? LIMIT 1", projectId, taskId)
    if (!row) fail('CONTENT_SCOPE_UNAVAILABLE', 'Task scope is unavailable', 404)
    const task = saved(cruxSnapshotSchema.shape.tasks.element, row.body)
    const spaceRow = this.host.get("SELECT s.value AS body FROM crux_workspaces w,json_each(w.snapshotJson,'$.spaces') s WHERE w.projectId=? AND json_extract(s.value,'$.id')=? LIMIT 1", projectId, task.spaceId)
    const space = spaceRow ? saved(cruxSnapshotSchema.shape.spaces.element, spaceRow.body) : null
    if (!space || !canReadCruxSpace(space, principal.person.userId) || !space.memberIds.includes(principal.person.userId)) fail('CONTENT_SCOPE_UNAVAILABLE', 'Current space membership is required', 403)
    if (expected && (expected.spaceId !== task.spaceId || expected.taskCreatedAt !== task.createdAt)) fail('CONTENT_TASK_CHANGED', 'Task identity or space changed; the original job cannot be retargeted')
    if (writing && space.archived) fail('CONTENT_SCOPE_ARCHIVED', 'Archived spaces cannot start new content jobs')
    return task
  }
  private configRow(teamId: string): Row | undefined { return this.host.get('SELECT publicJson,credentialJson FROM team_content_configs WHERE teamId=?', teamId) }
  private config(teamId: string): TeamContentConfig | null {
    const row = this.configRow(teamId)
    if (!row) return null
    return { ...saved(teamContentConfigSchema, row.publicJson), credentialProtectionAvailable: contentCredentialAvailable(teamId, text(row, 'credentialJson')) }
  }
  private writeConfig(config: TeamContentConfig, credential: string): void {
    this.host.run('INSERT INTO team_content_configs(teamId,revision,publicJson,credentialJson) VALUES(?,?,?,?) ON CONFLICT(teamId) DO UPDATE SET revision=excluded.revision,publicJson=excluded.publicJson,credentialJson=excluded.credentialJson', config.teamId, config.revision, JSON.stringify(teamContentConfigSchema.parse(config)), credential)
  }
  configRead(principal: StorePrincipal, raw: Record<string, unknown>): unknown {
    const teamId = teamIdSchema.parse(raw.teamId)
    this.admin(principal, teamId)
    return { ...this.host.identity(), config: this.config(teamId) }
  }
  private command<T>(p: StorePrincipal, teamId: string, commandId: string, epoch: string, kind: string, input: unknown, jobId: string | null, apply: () => T): { duplicate: boolean; result: T } {
    this.epoch(epoch)
    const hash = contentDigest(canonical({ kind, teamId, input }))
    const previous = this.host.get('SELECT * FROM team_content_commands WHERE userId=? AND commandId=?', p.person.userId, commandId)
    if (previous) {
      if (previous.ownerKey !== ownerKey(p) || previous.epoch !== epoch || previous.kind !== kind || previous.teamId !== teamId || previous.requestHash !== hash) fail('COMMAND_CONFLICT', 'Command UUID already belongs to another immutable content request')
      return { duplicate: true, result: JSON.parse(text(previous, 'resultJson')) as T }
    }
    // Content and existing domain commands share the UUID namespace for a person.
    if (this.host.get('SELECT commandId FROM commands WHERE userId=? AND commandId=?', p.person.userId, commandId)) fail('COMMAND_CONFLICT', 'Command UUID already belongs to another operation')
    const result = apply()
    this.host.run('INSERT INTO team_content_commands(userId,commandId,kind,requestHash,ownerKey,epoch,teamId,jobId,resultJson) VALUES(?,?,?,?,?,?,?,?,?)', p.person.userId, commandId, kind, hash, ownerKey(p), epoch, teamId, jobId, JSON.stringify(result))
    return { duplicate: false, result }
  }
  configure(actor: StoreActor, raw: Record<string, unknown>): unknown {
    const teamId = teamIdSchema.parse(raw.teamId), input = teamContentConfigureSchema.parse(raw.body)
    return this.host.transaction(() => {
      const p = this.host.authenticate(actor)
      this.admin(p, teamId)
      const reply = this.command(p, teamId, input.commandId, input.expectedEpoch, 'configure', input, null, () => {
        const previous = this.config(teamId)
        if ((previous?.revision ?? 0) !== input.expectedRevision) fail('CONTENT_CONFIG_CONFLICT', 'Model configuration changed; reload it before saving')
        const endpoint = validateContentEndpoint(input.endpoint)
        const previousRow = this.configRow(teamId)
        if (!input.apiKey && !previousRow) fail('CONTENT_KEY_REQUIRED', 'An administrator must configure the provider credential')
        const credential = input.apiKey ? encryptContentCredential(teamId, input.apiKey) : previousRow ? text(previousRow, 'credentialJson') : ''
        // A missing/wrong deployment key also prevents preserving or reconfiguring a stored secret.
        decryptContentCredential(teamId, credential)
        const config = teamContentConfigSchema.parse({ teamId, revision: input.expectedRevision + 1, provider: input.provider,
          endpoint, model: input.model, enabled: input.enabled, capabilities: input.capabilities, limits: input.limits,
          hasCredential: true, credentialProtectionAvailable: true, health: { state: 'unverified', checkedAt: null, code: null, consecutiveFailures: 0 }, updatedAt: Date.now() })
        this.writeConfig(config, credential)
        return config
      })
      return { status: reply.duplicate ? 'duplicate' : 'committed', config: reply.result }
    })
  }
  readiness(principal: StorePrincipal, raw: Record<string, unknown>): TeamContentReadiness {
    const projectId = teamIdSchema.parse(raw.projectId), teamId = this.projectTeam(principal, projectId), config = this.config(teamId)
    const status = !config ? 'unconfigured' : !config.enabled ? 'disabled' : !config.credentialProtectionAvailable ? 'protection-unavailable' : config.health.state
    return teamContentReadinessSchema.parse({ ...this.host.identity(), projectId, teamId, status, administratorActionRequired: status !== 'ready',
      canManage: this.canManage(principal, teamId), model: config?.model ?? null, capabilities: config?.enabled && config.credentialProtectionAvailable ? config.capabilities : [],
      templateVersion: 'team-content-v1', health: config?.health ?? null, manualWorkAvailable: true,
      evidenceCoverage: 'task-and-explicit-text-only', serverTime: Date.now() })
  }
  private usage(teamId: string, date: string, userId: string | null): z.infer<typeof teamContentBudgetScopeSchema> {
    const filter = userId ? ' AND userId=?' : '', args = userId ? [teamId, date, userId] : [teamId, date]
    const row = this.host.get(`SELECT COUNT(*) AS requests,COALESCE(SUM(CASE WHEN reservation='held' THEN reservedTokens ELSE 0 END),0) AS reservedTokens,COALESCE(SUM(inputTokens),0) AS measuredInputTokens,COALESCE(SUM(outputTokens),0) AS measuredOutputTokens,COALESCE(SUM(cachedInputTokens),0) AS measuredCachedInputTokens,COALESCE(SUM(CASE WHEN reservation='held' THEN 1 ELSE 0 END),0) AS unknownUsageJobs,COALESCE(SUM(CASE WHEN inputTokens IS NOT NULL AND cachedInputTokens IS NULL THEN 1 ELSE 0 END),0) AS unknownCacheUsageJobs FROM team_content_jobs WHERE teamId=? AND day=?${filter}`, ...args)
    const active = this.host.get('SELECT COUNT(*) AS count FROM team_content_jobs WHERE teamId=? AND slotHeld=1' + filter, teamId, ...(userId ? [userId] : []))
    return saved(teamContentBudgetScopeSchema, { ...row, activeSlots: active?.count ?? 0 })
  }
  budget(principal: StorePrincipal, raw: Record<string, unknown>): TeamContentBudget {
    const teamId = teamIdSchema.parse(raw.teamId)
    this.admin(principal, teamId)
    const query = z.object({ userId: teamIdSchema.optional() }).strict().parse(raw.query ?? {})
    const memberId = query.userId ?? principal.person.userId
    if (!this.host.get('SELECT userId FROM team_members WHERE teamId=? AND userId=?', teamId, memberId)) fail('NOT_FOUND', 'Team member accounting is unavailable', 404)
    const date = day()
    return teamContentBudgetSchema.parse({ teamId, day: date, memberId, team: this.usage(teamId, date, null), member: this.usage(teamId, date, memberId), limits: this.config(teamId)?.limits ?? null, cost: null, costStatus: 'unknown', serverTime: Date.now() })
  }
  private reserve(teamId: string, userId: string, config: TeamContentConfig, tokens: number): void {
    const team = this.usage(teamId, day(), null), member = this.usage(teamId, day(), userId), limits = config.limits
    const total = this.host.get('SELECT COUNT(*) AS count FROM team_content_jobs WHERE teamId=?', teamId)
    if (Number(total?.count ?? 0) >= 20_000) fail('CONTENT_STORAGE_FULL', 'Content history capacity reached; retain existing jobs', 413)
    const global = this.host.get('SELECT COUNT(*) AS count FROM team_content_jobs WHERE slotHeld=1')
    if (team.activeSlots >= limits.teamConcurrency || member.activeSlots >= limits.memberConcurrency || Number(global?.count ?? 0) >= 32) fail('CONTENT_CONCURRENCY_LIMIT', 'In-flight or unknown content jobs occupy the concurrency allowance', 429)
    if (team.requests >= limits.teamDailyRequests || member.requests >= limits.memberDailyRequests) fail('CONTENT_REQUEST_BUDGET', 'The UTC daily request allowance is exhausted', 429)
    // Unresolved older calls still reserve capacity after midnight; their possible usage cannot disappear at a date boundary.
    const old = (owner: string | null): number => Number(this.host.get("SELECT COALESCE(SUM(reservedTokens),0) AS tokens FROM team_content_jobs WHERE teamId=? AND day<>? AND reservation='held'" + (owner ? ' AND userId=?' : ''), teamId, day(), ...(owner ? [owner] : []))?.tokens ?? 0)
    if (team.reservedTokens + team.measuredInputTokens + team.measuredOutputTokens + old(null) + tokens > limits.teamDailyTokens ||
        member.reservedTokens + member.measuredInputTokens + member.measuredOutputTokens + old(userId) + tokens > limits.memberDailyTokens) fail('CONTENT_TOKEN_BUDGET', 'Declared tokens plus measured usage and unresolved reservations exceed the allowance', 429)
  }
  private load(jobId: string): { job: TeamContentJob; row: Row } {
    const row = this.host.get('SELECT * FROM team_content_jobs WHERE jobId=?', jobId)
    if (!row) fail('NOT_FOUND', 'Content job is unavailable', 404)
    const job = saved(teamContentJobSchema, row.recordJson)
    if (job.jobId !== jobId || job.ownerId !== row.userId || job.teamId !== row.teamId || job.projectId !== row.projectId ||
        job.taskId !== row.taskId || job.spaceId !== row.spaceId || job.taskCreatedAt !== row.taskCreatedAt || job.epoch !== row.epoch ||
        job.state !== row.state || Number(row.slotHeld) !== Number(job.slotHeld) || job.reservation !== row.reservation ||
        job.reservedTokens !== row.reservedTokens || (job.candidate && (contentDigest(job.candidate.body) !== job.candidate.digest || Buffer.byteLength(job.candidate.body) > TEAM_CONTENT_MAX_OUTPUT_BYTES))) {
      fail('CORRUPT_STORE', 'Content job identity or candidate integrity is invalid', 503)
    }
    return { row, job }
  }
  private persist(job: TeamContentJob): void {
    const parsed = teamContentJobSchema.parse(job)
    this.host.run('UPDATE team_content_jobs SET state=?,slotHeld=?,reservation=?,inputTokens=?,outputTokens=?,cachedInputTokens=?,recordJson=? WHERE jobId=?', parsed.state, parsed.slotHeld ? 1 : 0, parsed.reservation,
      parsed.usage?.inputTokens ?? null, parsed.usage?.outputTokens ?? null, parsed.usage?.cachedInputTokens ?? null, JSON.stringify(parsed), parsed.jobId)
  }
  private authorizeJob(p: StorePrincipal, job: TeamContentJob): void {
    this.epoch(job.epoch)
    if (job.instanceId !== this.host.identity().instanceId || job.ownerId !== p.person.userId || job.deviceId !== p.deviceId) fail('CONTENT_JOB_FORBIDDEN', 'The job belongs to another service, person or device', 403)
    if (job.kind === 'probe') this.admin(p, job.teamId)
    else {
      if (!job.projectId || !job.taskId) fail('CORRUPT_STORE', 'Content job scope is missing', 503)
      const task = this.task(p, job.projectId, job.taskId, job)
      for (const source of job.sources) {
        if (source.kind === 'governance-rule') {
          const [packageId, versionId, extra] = source.sourceId.split('@')
          if (extra !== undefined) fail('CORRUPT_STORE', 'Content rule reference is invalid', 503)
          const rule = this.host.rule(p, { projectId: job.projectId, taskId: task.id, spaceId: task.spaceId, taskCreatedAt: task.createdAt }, teamIdSchema.parse(packageId), teamIdSchema.parse(versionId))
          if (rule.version.bodyDigest !== source.digest || contentDigest(rule.text) !== source.digest || Buffer.byteLength(rule.text) !== source.byteLength) fail('CONTENT_SOURCE_CHANGED', 'Original rule bytes are no longer verifiable')
          continue
        }
        if (source.kind !== 'published-material') continue
        const [documentId, version, extra] = source.sourceId.split('@')
        if (!documentId || !version || extra !== undefined || !/^[1-9][0-9]{0,8}$/.test(version)) fail('CORRUPT_STORE', 'Content material reference is invalid', 503)
        const material = this.host.material(p, job.projectId, teamIdSchema.parse(documentId), Number(version))
        if (material.bodyDigest !== source.digest || contentDigest(material.text) !== source.digest || Buffer.byteLength(material.text) !== source.byteLength) fail('CONTENT_SOURCE_CHANGED', 'Original material bytes are no longer verifiable')
      }
    }
  }
  prepare(actor: StoreActor, raw: Record<string, unknown>, probe = false): { reply: TeamContentJobReply; dispatchToken: string | null } {
    const input = probe ? teamContentProbeSchema.parse(raw.body) : teamContentGenerateSchema.parse(raw.body)
    return this.host.transaction(() => {
      const p = this.host.authenticate(actor)
      const projectId = probe ? null : teamIdSchema.parse(raw.projectId), taskId = probe ? null : teamContentScopeIdSchema.parse(raw.taskId)
      const teamId = probe ? teamIdSchema.parse(raw.teamId) : this.projectTeam(p, projectId as string)
      if (probe) this.admin(p, teamId)
      // Current authority and immutable task identity are checked even for a duplicate UUID.
      const generated = teamContentGenerateSchema.safeParse(input)
      const task = !probe && generated.success && projectId && taskId ? this.task(p, projectId, taskId, { spaceId: generated.data.expectedSpaceId, taskCreatedAt: generated.data.expectedTaskCreatedAt }) : null
      const jobId = randomUUID(), token = randomUUID()
      const command = this.command(p, teamId, input.commandId, input.expectedEpoch, probe ? 'probe' : 'generate', { projectId, taskId, input }, jobId, () => {
        const config = this.config(teamId)
        if (!config || !config.enabled) fail('CONTENT_NOT_CONFIGURED', 'Team content is unavailable; a team administrator must configure it', 503)
        if (!config.credentialProtectionAvailable) fail('CONTENT_PROTECTION_UNAVAILABLE', 'The administrator must restore content credential protection', 503)
        if (probe) {
          const request = teamContentProbeSchema.parse(input)
          if (request.expectedConfigRevision !== config.revision) fail('CONTENT_CONFIG_CONFLICT', 'Reload current model configuration before probing')
        } else {
          if (!generated.success || !task || !projectId || !taskId) fail('INVALID_INPUT', 'A fixed task scope is required')
          this.task(p, projectId, taskId, { spaceId: generated.data.expectedSpaceId, taskCreatedAt: generated.data.expectedTaskCreatedAt }, true)
          if (task.updatedAt !== generated.data.expectedTaskUpdatedAt) fail('CONTENT_TASK_CHANGED', 'Task changed; reload before generating a candidate')
          if (!config.capabilities.includes(generated.data.kind)) fail('CONTENT_CAPABILITY_DISABLED', 'The administrator has not enabled this content capability', 403)
        }
        const kind = probe ? 'probe' : teamContentGenerateSchema.parse(input).kind
        const explicit = probe ? 'Reply OK.' : teamContentGenerateSchema.parse(input).text
        if (Buffer.byteLength(explicit) > TEAM_CONTENT_MAX_TEXT_BYTES) fail('CONTENT_INPUT_TOO_LARGE', 'Explicit text exceeds the UTF-8 byte limit', 413)
        const selected = !probe && generated.success ? generated.data.references ?? [] : []
        if (new Set(selected.map(reference => `${reference.documentId}@${reference.versionId}`)).size !== selected.length) fail('INVALID_INPUT', 'Duplicate published material reference')
        const materials = selected.map(reference => this.host.material(p, projectId as string, reference.documentId, Number(reference.versionId)))
        const rules = task && projectId ? this.host.rules(p, { projectId, taskId: task.id, spaceId: task.spaceId, taskCreatedAt: task.createdAt }) : []
        const at = Date.now(), prompt = contentMessages(kind, task, explicit, at, materials, rules)
        if (prompt.inputBytes > 128 * 1024) fail('CONTENT_INPUT_TOO_LARGE', 'Task, explicit text, materials and rules exceed the combined UTF-8 byte limit', 413)
        if (prompt.estimatedInputTokens > config.limits.inputTokenLimit) fail('CONTENT_INPUT_LIMIT', 'Input estimate exceeds the declared per-job input allowance; reduce the supplied text', 413)
        const outputLimit = probe ? Math.min(16, config.limits.outputTokenLimit) : config.limits.outputTokenLimit
        const tokens = config.limits.inputTokenLimit + outputLimit
        this.reserve(teamId, p.person.userId, config, tokens)
        const job = teamContentJobSchema.parse({ jobId, commandId: input.commandId, ...this.host.identity(), teamId, projectId, taskId,
          spaceId: task?.spaceId ?? null, taskCreatedAt: task?.createdAt ?? null, ownerId: p.person.userId, deviceId: p.deviceId, kind,
          state: 'pending', revision: 1, configRevision: config.revision, model: config.model, templateVersion: 'team-content-v1',
          sources: prompt.sources, evidenceCoverage: prompt.evidenceCoverage, missingEvidence: prompt.missingEvidence,
          estimatedInputTokens: prompt.estimatedInputTokens, declaredInputTokenLimit: config.limits.inputTokenLimit, declaredOutputTokenLimit: outputLimit,
          reservedTokens: tokens, reservation: 'held', slotHeld: true, usage: null, cost: null, costStatus: 'unknown', limitExceeded: false,
          candidate: null, errorCode: null, cancelRequested: false, reconciliation: null, createdAt: at, updatedAt: at, startedAt: null, finishedAt: null })
        const hidden = privateSchema.parse({ actor, messages: prompt.messages, timeoutMs: config.limits.timeoutMs })
        this.host.run('INSERT INTO team_content_jobs(jobId,userId,commandId,teamId,projectId,taskId,spaceId,taskCreatedAt,epoch,ownerKey,day,state,slotHeld,reservation,reservedTokens,recordJson,privateJson,dispatchHash,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          jobId, p.person.userId, input.commandId, teamId, projectId, taskId, job.spaceId, job.taskCreatedAt, job.epoch, ownerKey(p), day(), job.state, 1, 'held', tokens, JSON.stringify(job), JSON.stringify(hidden), contentDigest(token), at)
        return { jobId }
      })
      const job = this.load(command.result.jobId).job
      this.authorizeJob(p, job)
      return { reply: { status: command.duplicate ? 'duplicate' : 'accepted', job }, dispatchToken: command.duplicate ? null : token }
    })
  }
  read(principal: StorePrincipal, raw: Record<string, unknown>, byCommand = false): TeamContentJob {
    const projectId = teamIdSchema.parse(raw.projectId), taskId = teamContentScopeIdSchema.parse(raw.taskId)
    this.task(principal, projectId, taskId)
    let jobId: string
    if (byCommand) {
      const commandId = teamCommandIdSchema.parse(raw.commandId)
      const row = this.host.get('SELECT jobId FROM team_content_jobs WHERE userId=? AND commandId=?', principal.person.userId, commandId)
      if (!row) fail('NOT_FOUND', 'No content job is recorded; an in-flight prepare may still commit', 404)
      jobId = text(row, 'jobId')
    } else jobId = teamIdSchema.parse(raw.jobId)
    const job = this.load(jobId).job
    if (job.projectId !== projectId || job.taskId !== taskId) fail('CONTENT_SCOPE_UNAVAILABLE', 'Content job scope is unavailable', 404)
    this.authorizeJob(principal, job)
    return job
  }
  cancel(actor: StoreActor, raw: Record<string, unknown>): TeamContentJob {
    const input = teamContentCancelSchema.parse(raw.body)
    return this.host.transaction(() => {
      const p = this.host.authenticate(actor), job = this.read(p, raw)
      this.command(p, job.teamId, input.commandId, input.expectedEpoch, 'cancel', { jobId: job.jobId, input }, job.jobId, () => {
        if (job.state === 'pending' || job.state === 'running' || job.state === 'unknown') {
          const pending = job.state === 'pending'
          this.persist({ ...job, revision: job.revision + 1, state: pending ? 'cancelled' : 'unknown', cancelRequested: true,
            reservation: pending ? 'released' : job.reservation, slotHeld: pending ? false : job.slotHeld,
            errorCode: pending ? 'CONTENT_CANCELLED_BEFORE_DISPATCH' : 'CONTENT_CANCELLED_IN_FLIGHT', updatedAt: Date.now(), finishedAt: Date.now() })
        }
        return { jobId: job.jobId }
      })
      return this.load(job.jobId).job
    })
  }
  private accountingJob(p: StorePrincipal, raw: Record<string, unknown>): TeamContentJob {
    const teamId = teamIdSchema.parse(raw.teamId)
    this.admin(p, teamId)
    const job = this.load(teamIdSchema.parse(raw.jobId)).job
    if (job.teamId !== teamId || job.instanceId !== this.host.identity().instanceId) fail('NOT_FOUND', 'Content accounting scope is unavailable', 404)
    return job
  }
  accounting(principal: StorePrincipal, raw: Record<string, unknown>): unknown {
    const job = this.accountingJob(principal, raw)
    // Administrators can account for spend without gaining the member's private input/candidate.
    const { candidate: _candidate, sources: _sources, ...metadata } = job
    return metadata
  }
  reconcile(actor: StoreActor, raw: Record<string, unknown>): unknown {
    const input = teamContentReconcileSchema.parse(raw.body)
    return this.host.transaction(() => {
      const p = this.host.authenticate(actor), job = this.accountingJob(p, raw)
      this.command(p, job.teamId, input.commandId, input.expectedEpoch, 'reconcile', { jobId: job.jobId, input }, job.jobId, () => {
        if (job.revision !== input.expectedRevision) fail('CONTENT_JOB_CONFLICT', 'Job changed; reload its accounting before reconciliation')
        if (job.reservation !== 'held' || job.state === 'pending' || job.state === 'running') fail('CONTENT_RECONCILIATION_UNAVAILABLE', 'Only unresolved finished/unknown jobs can be reconciled')
        if (input.outcome === 'not-started' && (job.candidate !== null || job.state === 'succeeded')) fail('CONTENT_RECONCILIATION_CONFLICT', 'A completed candidate proves this request was dispatched')
        const usage = input.usage
        this.persist({ ...job, revision: job.revision + 1, state: job.state === 'unknown' ? 'failed' : job.state,
          reservation: usage ? 'settled' : 'released', slotHeld: false, usage,
          limitExceeded: usage ? usage.inputTokens > job.declaredInputTokenLimit || usage.outputTokens > job.declaredOutputTokenLimit : false,
          reconciliation: { actorId: p.person.userId, evidence: input.evidence, at: Date.now() }, updatedAt: Date.now(), finishedAt: job.finishedAt ?? Date.now() })
        // Invalidate a late callback after an explicit external accounting decision.
        this.host.run('UPDATE team_content_jobs SET dispatchHash=? WHERE jobId=?', contentDigest(randomUUID()), job.jobId)
        return { jobId: job.jobId }
      })
      return this.accounting(p, raw)
    })
  }
  /** Internal only. Mark dispatch durably before revealing credentials to the service process. */
  start(raw: unknown): ContentProviderEnvelope | null {
    const input = z.object({ jobId: teamIdSchema, dispatchToken: z.string().uuid() }).strict().parse(raw)
    return this.host.transaction(() => {
      const { job, row } = this.load(input.jobId)
      if (row.dispatchHash !== contentDigest(input.dispatchToken) || job.state !== 'pending') return null
      try {
        const hidden = saved(privateSchema, row.privateJson), p = this.host.authenticate(hidden.actor)
        this.authorizeJob(p, job)
        if (job.projectId && job.taskId) this.task(p, job.projectId, job.taskId, job, true)
        const config = this.config(job.teamId), configRow = this.configRow(job.teamId)
        if (!config || !configRow || !config.enabled || config.revision !== job.configRevision) fail('CONTENT_CONFIG_CHANGED', 'Model configuration changed before dispatch')
        const apiKey = decryptContentCredential(job.teamId, text(configRow, 'credentialJson'))
        const envelope = contentProviderEnvelopeSchema.parse({ endpoint: validateContentEndpoint(config.endpoint), model: config.model, apiKey,
          messages: hidden.messages, maxTokens: job.declaredOutputTokenLimit, timeoutMs: hidden.timeoutMs })
        this.persist({ ...job, state: 'running', revision: job.revision + 1, startedAt: Date.now(), updatedAt: Date.now() })
        return envelope
      } catch (error) {
        this.persist({ ...job, state: 'failed', revision: job.revision + 1, reservation: 'released', slotHeld: false,
          errorCode: error instanceof TeamServiceError ? error.code : 'CONTENT_PREPARE_FAILED', updatedAt: Date.now(), finishedAt: Date.now() })
        return null
      }
    })
  }
  settle(raw: unknown): void {
    const input = z.object({ jobId: teamIdSchema, dispatchToken: z.string().uuid(), result: contentProviderResultSchema }).strict().parse(raw)
    this.host.transaction(() => {
      const { job, row } = this.load(input.jobId)
      if (row.dispatchHash !== contentDigest(input.dispatchToken) || (job.state !== 'running' && job.state !== 'unknown') || job.epoch !== this.host.identity().epoch) return
      const result = input.result, at = Date.now(), usage = result.usage
      const cancelled = job.cancelRequested && result.state !== 'unknown'
      const next: TeamContentJob = { ...job, state: cancelled ? 'cancelled' : result.state, revision: job.revision + 1,
        candidate: !job.cancelRequested && result.body !== null ? { body: result.body, digest: contentDigest(result.body), published: false } : null,
        usage, reservation: usage ? 'settled' : 'held', slotHeld: result.state === 'unknown',
        limitExceeded: usage ? usage.inputTokens > job.declaredInputTokenLimit || usage.outputTokens > job.declaredOutputTokenLimit : false,
        errorCode: cancelled ? 'CONTENT_CANCELLED' : result.errorCode, updatedAt: at, finishedAt: at }
      this.persist(next)
      const config = this.config(job.teamId), configRow = this.configRow(job.teamId)
      if (config && configRow && config.revision === job.configRevision) {
        this.writeConfig({ ...config, health: { state: result.state === 'succeeded' ? 'ready' : 'degraded', checkedAt: at,
          code: result.errorCode, consecutiveFailures: result.state === 'succeeded' ? 0 : config.health.consecutiveFailures + 1 } }, text(configRow, 'credentialJson'))
      }
    })
  }
  /** Restart/expiry is reconciliation only; it never selects a row for provider redispatch. */
  recover(restart: boolean): void {
    this.host.transaction(() => {
      const rows = this.host.all("SELECT * FROM team_content_jobs WHERE state IN('pending','running') LIMIT 65")
      if (rows.length > 64) fail('CORRUPT_STORE', 'Content concurrency exceeds its bound', 503)
      for (const row of rows) {
        const job = saved(teamContentJobSchema, row.recordJson), hidden = saved(privateSchema, row.privateJson)
        const expired = job.state === 'pending' ? Date.now() - job.createdAt > 30_000 : Date.now() - (job.startedAt ?? job.createdAt) > hidden.timeoutMs + 10_000
        if (!restart && !expired) continue
        const pending = job.state === 'pending'
        this.persist({ ...job, state: pending ? 'cancelled' : 'unknown', revision: job.revision + 1,
          reservation: pending ? 'released' : job.reservation, slotHeld: !pending,
          errorCode: restart ? 'CONTENT_SERVICE_RESTARTED' : 'CONTENT_DISPATCH_ACK_UNKNOWN', updatedAt: Date.now(), finishedAt: Date.now() })
      }
    })
  }
}
