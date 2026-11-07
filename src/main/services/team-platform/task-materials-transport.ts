import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  teamTaskMaterialListInputSchema, teamTaskMaterialReadInputSchema, teamTaskMaterialCommandSchema,
  teamTaskMaterialListSchema, teamTaskMaterialViewSchema, teamTaskMaterialHistorySchema,
  teamTaskMaterialSubmissionsSchema, teamTaskMaterialReceiptSchema, teamTaskMaterialCommandReplySchema,
  type TeamTaskMaterialCommand, type TeamTaskMaterialMetadata, type TeamTaskMaterialReceipt
} from '../../../shared/team-task-materials'
import { TEAM_MAX_DOCUMENT_BYTES, TEAM_MAX_REQUEST_BYTES, teamIdSchema } from '../../../shared/team-platform'
import { cruxMaterialScopeSchema } from '../../../shared/crux-task-materials'
import { DesktopTeamError } from './types'

export const taskMaterialTransportPinSchema = cruxMaterialScopeSchema.extend({
  connectionId: teamIdSchema, actorId: teamIdSchema, projectId: teamIdSchema, deviceId: teamIdSchema,
  pairingId: teamIdSchema, origin: z.string().url().max(2048), instanceId: teamIdSchema, epoch: teamIdSchema
}).strict()
export type TaskMaterialTransportPin = z.infer<typeof taskMaterialTransportPinSchema>
export type TaskMaterialRequest = <S extends z.ZodType>(path: string, schema: S, body?: unknown) => Promise<z.output<S>>
export const taskMaterialTextDigest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const invalid = (write = false): never => { throw new DesktopTeamError('MATERIAL_RESPONSE_MISMATCH', '材料回复与原服务、任务或固定版本不一致，请重新核对。', write) }

export function validateTaskMaterialCommand(pin: TaskMaterialTransportPin, raw: TeamTaskMaterialCommand): TeamTaskMaterialCommand {
  const command = teamTaskMaterialCommandSchema.parse(raw)
  if (command.expectedEpoch !== pin.epoch || command.spaceId !== pin.spaceId || command.taskCreatedAt !== pin.taskCreatedAt) {
    throw new DesktopTeamError('BINDING_CHANGED', '材料命令的原服务世代或任务身份已变化，不能改投。')
  }
  if ('text' in command && (taskMaterialTextDigest(command.text) !== command.expectedDigest || Buffer.byteLength(command.text, 'utf8') > TEAM_MAX_DOCUMENT_BYTES)) {
    throw new DesktopTeamError('BODY_MISMATCH', '材料完整正文的 UTF-8 长度或 SHA-256 与所选版本不一致。')
  }
  if (Buffer.byteLength(JSON.stringify(command), 'utf8') > TEAM_MAX_REQUEST_BYTES) throw new DesktopTeamError('CAPACITY_EXCEEDED', '材料命令的 JSON 封装超过 2 MiB，尚未发送。')
  return command
}

function identity(pin: TaskMaterialTransportPin, value: { instanceId: string; epoch: string }, write = false): void {
  if (value.instanceId !== pin.instanceId || value.epoch !== pin.epoch) invalid(write)
}
function scope(pin: TaskMaterialTransportPin, value: { projectId: string; taskId: string; spaceId: string; taskCreatedAt: string }, write = false): void {
  if (value.projectId !== pin.projectId || value.taskId !== pin.taskId || value.spaceId !== pin.spaceId || value.taskCreatedAt !== pin.taskCreatedAt) invalid(write)
}
function metadata(pin: TaskMaterialTransportPin, value: TeamTaskMaterialMetadata, documentId?: string): void {
  scope(pin, value)
  if (documentId !== undefined && value.documentId !== documentId || value.draft.documentId !== value.documentId || value.draft.disposition !== 'draft'
    || value.template.templateId !== value.kind || value.approved && value.approved.status !== 'approved') invalid()
  for (const submission of [value.latestSubmission, value.approved]) {
    if (!submission) continue
    if (submission.documentId !== value.documentId) invalid()
    if (submission.versionId === value.draft.versionId && submission.bodyDigest !== value.draft.bodyDigest) invalid()
  }
}

/** Also applied when loading a retained receipt: cached success is never authority to read text. */
export function validateTaskMaterialReceipt(pin: TaskMaterialTransportPin, command: TeamTaskMaterialCommand, receipt: TeamTaskMaterialReceipt): void {
  identity(pin, receipt, true); scope(pin, receipt, true)
  if (receipt.commandId !== command.commandId || receipt.action !== command.action || receipt.actorId !== pin.actorId || receipt.deviceId !== pin.deviceId
    || 'documentId' in command && receipt.documentId !== command.documentId) invalid(true)
  if (receipt.outcome === 'conflict-preserved' && (command.action !== 'saveDraft' || !receipt.versionId)) invalid(true)
  if ((command.action === 'create' || command.action === 'saveDraft') && (!receipt.versionId || receipt.submissionId !== null)) invalid(true)
  if (command.action === 'create' && (receipt.revision !== 1 || receipt.draftRevision !== 1 || receipt.outcome !== 'applied')) invalid(true)
  if (command.action === 'saveDraft' && receipt.outcome === 'applied' && receipt.draftRevision !== command.expectedDraftRevision + 1) invalid(true)
  if (command.action === 'saveDraft' && receipt.outcome === 'conflict-preserved' && receipt.draftRevision <= command.expectedDraftRevision) invalid(true)
  if ('expectedRevision' in command && receipt.revision !== command.expectedRevision + 1) invalid(true)
  if (command.action === 'setAccess' && (receipt.versionId !== null || receipt.submissionId !== null)) invalid(true)
  if (command.action === 'submit' && (receipt.versionId !== command.versionId || !receipt.submissionId || receipt.draftRevision !== command.expectedDraftRevision)) invalid(true)
  if ((command.action === 'approve' || command.action === 'reject') && (receipt.submissionId !== command.submissionId || !receipt.versionId)) invalid(true)
}

/** Fixed routes only. The injected request retains the original credential and checks native selection before each HTTP call. */
export class TaskMaterialsTransport {
  private readonly base: string
  constructor(private readonly pin: TaskMaterialTransportPin, private readonly request: TaskMaterialRequest) {
    this.base = `/api/projects/${pin.projectId}/crux/tasks/${encodeURIComponent(pin.taskId)}/materials`
  }
  private query(fields: { cursor?: string; limit?: number; versionId?: string } = {}): string {
    const query = new URLSearchParams({ spaceId: this.pin.spaceId, taskCreatedAt: this.pin.taskCreatedAt })
    if (fields.cursor !== undefined) query.set('cursor', fields.cursor)
    if (fields.limit !== undefined) query.set('limit', String(fields.limit))
    if (fields.versionId !== undefined) query.set('versionId', fields.versionId)
    return query.toString()
  }
  async list(raw: z.input<typeof teamTaskMaterialListInputSchema>): Promise<z.infer<typeof teamTaskMaterialListSchema>> {
    const input = teamTaskMaterialListInputSchema.parse(raw)
    const value = await this.request(`${this.base}?${this.query(input)}`, teamTaskMaterialListSchema)
    identity(this.pin, value); scope(this.pin, value)
    for (const item of value.page.items) metadata(this.pin, item)
    return value
  }
  async read(documentId: string, raw: z.input<typeof teamTaskMaterialReadInputSchema>): Promise<z.infer<typeof teamTaskMaterialViewSchema>> {
    const id = teamIdSchema.parse(documentId), input = teamTaskMaterialReadInputSchema.parse(raw)
    const value = await this.request(`${this.base}/${id}?${this.query(input)}`, teamTaskMaterialViewSchema)
    identity(this.pin, value); metadata(this.pin, value.document, id)
    const selected = value.selected
    if (selected.documentId !== id || selected.versionId !== (input.versionId ?? value.document.draft.versionId)
      || selected.bodyDigest !== taskMaterialTextDigest(value.text) || selected.byteLength !== Buffer.byteLength(value.text, 'utf8')
      || selected.versionId === value.document.draft.versionId && JSON.stringify(selected) !== JSON.stringify(value.document.draft)) invalid()
    for (const submission of [value.document.approved, value.document.latestSubmission]) {
      if (submission?.versionId === selected.versionId && submission.bodyDigest !== selected.bodyDigest) invalid()
    }
    return value
  }
  async versions(documentId: string, raw: z.input<typeof teamTaskMaterialListInputSchema>): Promise<z.infer<typeof teamTaskMaterialHistorySchema>> {
    const id = teamIdSchema.parse(documentId), input = teamTaskMaterialListInputSchema.parse(raw)
    const value = await this.request(`${this.base}/${id}/versions?${this.query(input)}`, teamTaskMaterialHistorySchema)
    identity(this.pin, value)
    if (value.page.items.some(item => item.documentId !== id)) invalid()
    return value
  }
  async submissions(documentId: string, raw: z.input<typeof teamTaskMaterialListInputSchema>): Promise<z.infer<typeof teamTaskMaterialSubmissionsSchema>> {
    const id = teamIdSchema.parse(documentId), input = teamTaskMaterialListInputSchema.parse(raw)
    const value = await this.request(`${this.base}/${id}/submissions?${this.query(input)}`, teamTaskMaterialSubmissionsSchema)
    identity(this.pin, value)
    if (value.page.items.some(item => item.documentId !== id)) invalid()
    return value
  }
  async command(raw: TeamTaskMaterialCommand): Promise<z.infer<typeof teamTaskMaterialCommandReplySchema>> {
    const command = validateTaskMaterialCommand(this.pin, raw)
    const value = await this.request(`${this.base}/commands`, teamTaskMaterialCommandReplySchema, command)
    if (value.commandId !== command.commandId) invalid(true)
    validateTaskMaterialReceipt(this.pin, command, value.result)
    return value
  }
  async receipt(command: TeamTaskMaterialCommand): Promise<TeamTaskMaterialReceipt | null> {
    validateTaskMaterialCommand(this.pin, command)
    const value = await this.request(`${this.base}/commands/${command.commandId}?${this.query()}`, teamTaskMaterialReceiptSchema.nullable())
    if (value) validateTaskMaterialReceipt(this.pin, command, value)
    return value
  }
}
