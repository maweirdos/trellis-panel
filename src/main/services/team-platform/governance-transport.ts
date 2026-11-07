import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  governanceCommandReplySchema, governanceCommandSchema, governanceListSchema, governanceReceiptSchema,
  governanceScopeSchema, governanceViewSchema, type GovernanceCommand, type GovernanceReceipt
} from '../../../shared/team-governance'
import {
  taskInputBundleSchema, taskInputCandidatesSchema, taskInputCommandReplySchema, taskInputCommandSchema, taskInputReadSchema,
  taskInputReceiptSchema, taskInputScopeSchema, taskInputBundleDigestText, taskInputCanonical, taskInputDocumentViewSchema, type TaskInputCommand, type TaskInputReceipt, type TaskInputScope
} from '../../../shared/team-task-inputs'
import { TEAM_MAX_REQUEST_BYTES, teamCommandIdSchema, teamIdSchema } from '../../../shared/team-platform'
import { DesktopTeamError } from './types'
import type { TaskMaterialInputReference } from '../../../shared/task-material-inputs'

export const governanceTransportPinSchema = governanceScopeSchema.extend({ connectionId: teamIdSchema, actorId: teamIdSchema, projectId: teamIdSchema, deviceId: teamIdSchema, pairingId: teamIdSchema, origin: z.string().url().max(2048), instanceId: teamIdSchema, epoch: teamIdSchema }).strict()
export type GovernanceTransportPin = z.infer<typeof governanceTransportPinSchema>
export type GovernanceRequest = <S extends z.ZodType>(path: string, schema: S, body?: unknown) => Promise<z.output<S>>
export const governanceTextDigest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const mismatch = (write = false): never => { throw new DesktopTeamError('GOVERNANCE_RESPONSE_MISMATCH', '规则或任务输入的回复与原身份及版本不一致，请核对原操作。', write) }
export function validateGovernanceCommand(pin: GovernanceTransportPin, raw: GovernanceCommand | TaskInputCommand, task?: TaskInputScope): GovernanceCommand | TaskInputCommand {
  const command = task ? taskInputCommandSchema.parse(raw) : governanceCommandSchema.parse(raw)
  if (command.expectedEpoch !== pin.epoch || command.spaceId !== pin.spaceId || task && 'taskCreatedAt' in command && command.taskCreatedAt !== task.taskCreatedAt) throw new DesktopTeamError('BINDING_CHANGED', '原命令的服务世代或空间、任务身份已变化。')
  if (Buffer.byteLength(JSON.stringify(command), 'utf8') > TEAM_MAX_REQUEST_BYTES || 'text' in command && Buffer.byteLength(command.text, 'utf8') > 1024 * 1024) throw new DesktopTeamError('CAPACITY_EXCEEDED', '规则或输入命令超过传输限额。')
  return command
}
export function validateGovernanceReceipt(pin: GovernanceTransportPin, command: GovernanceCommand | TaskInputCommand, receipt: GovernanceReceipt | TaskInputReceipt, task?: TaskInputScope): void {
  if (receipt.instanceId !== pin.instanceId || receipt.epoch !== pin.epoch || receipt.projectId !== pin.projectId || receipt.spaceId !== pin.spaceId || receipt.commandId !== command.commandId || receipt.action !== command.action || receipt.actorId !== pin.actorId || receipt.deviceId !== pin.deviceId) mismatch(true)
  if (task) {
    const value = taskInputReceiptSchema.parse(receipt)
    if (value.taskId !== task.taskId || value.taskCreatedAt !== task.taskCreatedAt || !('expectedRevision' in command) || value.revision !== command.expectedRevision + 1) mismatch(true)
    if (command.action === 'adopt' && (!value.bundleId || !value.digest) || command.action === 'withdrawDocument' && (value.bundleId !== null || value.digest !== null)) mismatch(true)
  } else {
    const value = governanceReceiptSchema.parse(receipt)
    if ('packageId' in command && value.packageId !== command.packageId) mismatch(true)
    if (command.action === 'create' ? value.revision !== 1 : 'expectedRevision' in command && value.revision !== command.expectedRevision + 1) mismatch(true)
    if ('versionId' in command && value.versionId !== command.versionId) mismatch(true)
  }
}

export class GovernanceTransport {
  private readonly base: string
  constructor(private readonly pin: GovernanceTransportPin, private readonly request: GovernanceRequest) { this.base = `/api/projects/${pin.projectId}/crux/spaces/${encodeURIComponent(pin.spaceId)}/governance` }
  private identity(value: { instanceId: string; epoch: string }): void { if (value.instanceId !== this.pin.instanceId || value.epoch !== this.pin.epoch) mismatch() }
  private task(raw: TaskInputScope): TaskInputScope {
    const task = taskInputScopeSchema.parse(raw)
    if (task.workspaceKey !== this.pin.workspaceKey || task.spaceId !== this.pin.spaceId) throw new DesktopTeamError('BINDING_CHANGED', '任务输入与原工作区不一致。')
    return task
  }
  private taskBase(task: TaskInputScope): string { return `/api/projects/${this.pin.projectId}/crux/tasks/${encodeURIComponent(task.taskId)}/inputs` }
  private query(task: TaskInputScope): string { return new URLSearchParams({ spaceId: task.spaceId, taskCreatedAt: task.taskCreatedAt }).toString() }
  private taskResult(task: TaskInputScope, value: { projectId: string; taskId: string; spaceId: string; taskCreatedAt: string }): void { if (value.projectId !== this.pin.projectId || value.taskId !== task.taskId || value.spaceId !== task.spaceId || value.taskCreatedAt !== task.taskCreatedAt) mismatch() }
  async list(input: { cursor?: string; limit?: number } = {}): Promise<z.infer<typeof governanceListSchema>> {
    const query = new URLSearchParams()
    if (input.cursor) query.set('cursor', input.cursor)
    if (input.limit !== undefined) query.set('limit', String(input.limit))
    const value = await this.request(`${this.base}?${query}`, governanceListSchema)
    this.identity(value)
    if (value.projectId !== this.pin.projectId || value.spaceId !== this.pin.spaceId || value.page.items.some(pkg => pkg.projectId !== this.pin.projectId || pkg.spaceId !== this.pin.spaceId)) mismatch()
    return value
  }
  async read(packageId: string, versionId?: string): Promise<z.infer<typeof governanceViewSchema>> {
    const id = teamIdSchema.parse(packageId), version = versionId === undefined ? undefined : teamIdSchema.parse(versionId)
    const value = await this.request(`${this.base}/${id}${version ? '?versionId=' + version : ''}`, governanceViewSchema)
    this.identity(value)
    if (value.package.projectId !== this.pin.projectId || value.package.spaceId !== this.pin.spaceId || value.package.packageId !== id || value.selected.packageId !== id || value.selected.versionId !== (version ?? value.package.draft.versionId) || value.selected.settings.kind !== value.package.kind || governanceTextDigest(value.text) !== value.selected.bodyDigest || Buffer.byteLength(value.text, 'utf8') !== value.selected.byteLength) mismatch()
    return value
  }
  async command(raw: GovernanceCommand): Promise<z.infer<typeof governanceCommandReplySchema>> {
    const command = governanceCommandSchema.parse(validateGovernanceCommand(this.pin, raw))
    const value = await this.request(this.base + '/commands', governanceCommandReplySchema, command)
    if (value.commandId !== command.commandId) mismatch(true)
    validateGovernanceReceipt(this.pin, command, value.result)
    return value
  }
  async receipt(commandId: string): Promise<GovernanceReceipt | null> {
    const value = await this.request(`${this.base}/commands/${teamCommandIdSchema.parse(commandId)}`, governanceReceiptSchema.nullable())
    if (value) { this.identity(value); if (value.commandId !== commandId || value.projectId !== this.pin.projectId || value.spaceId !== this.pin.spaceId || value.actorId !== this.pin.actorId || value.deviceId !== this.pin.deviceId) mismatch() }
    return value
  }
  async inputs(raw: TaskInputScope): Promise<z.infer<typeof taskInputReadSchema>> {
    const task = this.task(raw), value = await this.request(`${this.taskBase(task)}?${this.query(task)}`, taskInputReadSchema)
    this.identity(value); this.taskResult(task, value)
    if (value.current) { this.taskResult(task, value.current); if (governanceTextDigest(taskInputBundleDigestText(value.current)) !== value.current.digest) mismatch() }
    return value
  }
  async candidates(raw: TaskInputScope): Promise<z.infer<typeof taskInputCandidatesSchema>> {
    const task = this.task(raw), value = await this.request(`${this.taskBase(task)}/candidates?${this.query(task)}`, taskInputCandidatesSchema)
    this.identity(value); this.taskResult(task, value)
    if (value.documents.some(doc => doc.spaceId !== task.spaceId || doc.taskCreatedAt !== task.taskCreatedAt)) mismatch()
    return value
  }
  async inputRevision(raw: TaskInputScope, revision: number): Promise<z.infer<typeof taskInputBundleSchema>> {
    const task = this.task(raw), number = z.number().int().positive().safe().parse(revision)
    const value = await this.request(`${this.taskBase(task)}/revisions/${number}?${this.query(task)}`, taskInputBundleSchema)
    this.taskResult(task, value)
    if (value.revision !== number || governanceTextDigest(taskInputBundleDigestText(value)) !== value.digest) mismatch()
    return value
  }
  async readDocument(raw: TaskInputScope, reference: TaskMaterialInputReference): Promise<z.infer<typeof taskInputDocumentViewSchema>> {
    const task = this.task(raw), documentId = teamIdSchema.parse(reference.documentId), versionId = teamIdSchema.parse(reference.versionId)
    const value = await this.request(`${this.taskBase(task)}/documents/${documentId}/versions/${versionId}?${this.query(task)}`, taskInputDocumentViewSchema)
    this.identity(value); this.taskResult(task, value)
    if (taskInputCanonical(value.reference) !== taskInputCanonical(reference) || governanceTextDigest(value.text) !== reference.bodyDigest || Buffer.byteLength(value.text, 'utf8') !== reference.byteLength) mismatch()
    return value
  }
  async adopt(raw: TaskInputScope, rawCommand: TaskInputCommand): Promise<z.infer<typeof taskInputCommandReplySchema>> {
    const task = this.task(raw), command = taskInputCommandSchema.parse(validateGovernanceCommand(this.pin, rawCommand, task))
    const value = await this.request(this.taskBase(task) + '/commands', taskInputCommandReplySchema, command)
    if (value.commandId !== command.commandId) mismatch(true)
    validateGovernanceReceipt(this.pin, command, value.result, task)
    return value
  }
  async inputReceipt(raw: TaskInputScope, commandId: string): Promise<TaskInputReceipt | null> {
    const task = this.task(raw), value = await this.request(`${this.taskBase(task)}/commands/${teamCommandIdSchema.parse(commandId)}?${this.query(task)}`, taskInputReceiptSchema.nullable())
    if (value) { this.identity(value); this.taskResult(task, value); if (value.commandId !== commandId || value.actorId !== this.pin.actorId || value.deviceId !== this.pin.deviceId) mismatch() }
    return value
  }
}
