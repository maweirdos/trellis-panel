import { z } from 'zod'
import { teamIdSchema, teamMaterialVersionSchema, teamPageSchema } from './team-platform'
import {
  teamContentConfigSchema, teamContentConfigureSchema, teamContentGenerateSchema, teamContentJobReplySchema,
  teamContentJobSchema, teamContentReadinessSchema, type TeamContentJob
} from './team-content'
import {
  teamContentAdminInputSchema, teamContentCancelInputSchema, teamContentConfigureInputSchema,
  teamContentGenerateInputSchema, teamContentJobInputSchema, teamContentProbeInputSchema,
  teamContentReceiptInputSchema, teamContentReferencesInputSchema, teamContentReferencesSchema, teamContentScopeSchema
} from './team-content-api'

export const teamContentPinSchema = z.object({ workspaceKey: z.string().min(1).max(2048), instanceId: teamIdSchema, epoch: teamIdSchema,
  teamId: teamIdSchema, projectId: teamIdSchema.nullable(), actorId: teamIdSchema, deviceId: teamIdSchema.nullable() }).strict()
export type TeamContentPin = z.infer<typeof teamContentPinSchema>
export const teamContentConfigReadSchema = z.object({ instanceId: teamIdSchema, epoch: teamIdSchema, config: teamContentConfigSchema.nullable() }).strict()
const configureReply = z.object({ status: z.enum(['committed', 'duplicate']), config: teamContentConfigSchema }).strict()
export type TeamContentRequest = <S extends z.ZodType>(path: string, schema: S, body?: Record<string, unknown>, validate?: (value: z.output<S>) => void) => Promise<z.output<S>>
export class TeamContentTransportError extends Error {
  constructor(readonly code: string, message: string, readonly outcomeUnknown = false) { super(message) }
}
const mismatch = (write = false): never => { throw new TeamContentTransportError('CONTENT_RESPONSE_MISMATCH', '内容回复与原工作区、账号或操作不一致，请核对原操作。', write) }

/** Fixed content routes and reply identities, shared by the authenticated Web and native clients. */
export class TeamContentTransport {
  constructor(readonly pin: TeamContentPin, private readonly request: TeamContentRequest) {}
  private scope(key: string): void { if (key !== this.pin.workspaceKey) throw new TeamContentTransportError('BINDING_CHANGED', '内容操作不属于原工作区。') }
  private project(): string { if (!this.pin.projectId) throw new TeamContentTransportError('CONTENT_PROJECT_REQUIRED', '请先选择已连接的项目。'); return this.pin.projectId }
  private admin(teamId: string): string { if (teamId !== this.pin.teamId) mismatch(); return `/api/teams/${teamId}/content` }
  private task(taskId: string): string { return `/api/projects/${this.project()}/hifox/tasks/${encodeURIComponent(taskId)}/content` }
  private identity(value: { instanceId: string; epoch: string }, write = false): void { if (value.instanceId !== this.pin.instanceId || value.epoch !== this.pin.epoch) mismatch(write) }
  private jobIdentity(job: TeamContentJob, target: { taskId?: string; jobId?: string; commandId?: string; spaceId?: string; taskCreatedAt?: string; kind?: TeamContentJob['kind'] }, write = false): void {
    this.identity(job, write)
    if (job.teamId !== this.pin.teamId || job.ownerId !== this.pin.actorId || job.deviceId !== this.pin.deviceId ||
      (target.kind === 'probe' ? job.projectId !== null || job.taskId !== null || job.spaceId !== null || job.taskCreatedAt !== null : job.projectId !== this.pin.projectId) ||
      target.taskId !== undefined && job.taskId !== target.taskId || target.jobId !== undefined && job.jobId !== target.jobId ||
      target.commandId !== undefined && job.commandId !== target.commandId || target.spaceId !== undefined && job.spaceId !== target.spaceId ||
      target.taskCreatedAt !== undefined && job.taskCreatedAt !== target.taskCreatedAt || target.kind !== undefined && job.kind !== target.kind) mismatch(write)
  }
  async readiness(raw: z.input<typeof teamContentScopeSchema>) {
    const input = teamContentScopeSchema.parse(raw); this.scope(input.workspaceKey)
    return this.request(`/api/projects/${this.project()}/content/capabilities`, teamContentReadinessSchema, undefined, value => {
      this.identity(value)
      if (value.teamId !== this.pin.teamId || value.projectId !== this.pin.projectId) mismatch()
    })
  }
  async generate(raw: z.input<typeof teamContentGenerateInputSchema>) {
    const input = teamContentGenerateInputSchema.parse(raw); this.scope(input.workspaceKey)
    const body = teamContentGenerateSchema.parse({ commandId: input.commandId, expectedEpoch: this.pin.epoch,
      expectedSpaceId: input.spaceId, expectedTaskCreatedAt: input.taskCreatedAt, expectedTaskUpdatedAt: input.expectedTaskUpdatedAt,
      kind: input.kind, text: input.text, ...(input.references ? { references: input.references } : {}) })
    return this.request(this.task(input.taskId) + '/jobs', teamContentJobReplySchema, body, value => this.jobIdentity(value.job, input, true))
  }
  async job(raw: z.input<typeof teamContentJobInputSchema>) {
    const input = teamContentJobInputSchema.parse(raw); this.scope(input.workspaceKey)
    return this.request(this.task(input.taskId) + '/jobs/' + input.jobId, teamContentJobSchema, undefined, value => this.jobIdentity(value, input))
  }
  async receipt(raw: z.input<typeof teamContentReceiptInputSchema>) {
    const input = teamContentReceiptInputSchema.parse(raw); this.scope(input.workspaceKey)
    return this.request(this.task(input.taskId) + '/commands/' + input.commandId, teamContentJobSchema, undefined, value => this.jobIdentity(value, input))
  }
  async cancel(raw: z.input<typeof teamContentCancelInputSchema>) {
    const input = teamContentCancelInputSchema.parse(raw); this.scope(input.workspaceKey)
    return this.request(this.task(input.taskId) + '/jobs/' + input.jobId + '/cancel', teamContentJobSchema,
      { commandId: input.commandId, expectedEpoch: this.pin.epoch }, value => this.jobIdentity(value, { taskId: input.taskId, jobId: input.jobId }, true))
  }
  async listReferences(raw: z.input<typeof teamContentReferencesInputSchema>) {
    const input = teamContentReferencesInputSchema.parse(raw); this.scope(input.workspaceKey)
    const query = new URLSearchParams({ projectId: this.project(), limit: '50' }); if (input.cursor) query.set('cursor', input.cursor)
    const page = await this.request('/api/materials?' + query, teamPageSchema(teamMaterialVersionSchema), undefined, value => {
      if (value.items.some(item => item.projectId !== this.pin.projectId || item.teamId !== this.pin.teamId)) mismatch()
      if (value.hasMore && !value.nextCursor) mismatch()
    })
    // The material page predates identity envelopes; verify the captured project epoch before exposing it.
    await this.readiness({ workspaceKey: input.workspaceKey })
    return teamContentReferencesSchema.parse({ items: page.items.filter(item => item.visibility !== 'personal').map(item => ({
      documentId: item.materialId, versionId: String(item.version), title: item.title, digest: item.bodyDigest, byteLength: item.byteLength
    })), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}), hasMore: page.hasMore })
  }
  async config(raw: z.input<typeof teamContentAdminInputSchema>) {
    const input = teamContentAdminInputSchema.parse(raw); this.scope(input.workspaceKey)
    return (await this.request(this.admin(input.teamId) + '/config', teamContentConfigReadSchema, undefined, value => {
      this.identity(value); if (value.config && value.config.teamId !== this.pin.teamId) mismatch()
    })).config
  }
  async configure(raw: z.input<typeof teamContentConfigureInputSchema>) {
    const input = teamContentConfigureInputSchema.parse(raw); this.scope(input.workspaceKey)
    const body = teamContentConfigureSchema.parse({ ...input.input, expectedEpoch: this.pin.epoch })
    return (await this.request(this.admin(input.teamId) + '/config', configureReply, body, value => {
      if (value.config.teamId !== this.pin.teamId || value.config.revision !== input.input.expectedRevision + 1 || value.config.provider !== body.provider ||
        value.config.endpoint !== new URL(body.endpoint).href || value.config.model !== body.model || value.config.enabled !== body.enabled ||
        JSON.stringify(value.config.capabilities) !== JSON.stringify(body.capabilities) || JSON.stringify(value.config.limits) !== JSON.stringify(body.limits)) mismatch(true)
    })).config
  }
  async probe(raw: z.input<typeof teamContentProbeInputSchema>) {
    const input = teamContentProbeInputSchema.parse(raw); this.scope(input.workspaceKey)
    return this.request(this.admin(input.teamId) + '/probe', teamContentJobReplySchema,
      { commandId: input.commandId, expectedEpoch: this.pin.epoch, expectedConfigRevision: input.expectedConfigRevision }, value => {
        this.jobIdentity(value.job, { commandId: input.commandId, kind: 'probe' }, true)
        if (value.job.configRevision !== input.expectedConfigRevision) mismatch(true)
      })
  }
}
