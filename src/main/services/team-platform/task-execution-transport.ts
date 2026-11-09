import { CutoverTransport } from '../workflow-cutover/transport'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { taskInputCanonical } from '../../../shared/team-task-inputs'
import { teamExecutionCommandSchema, teamExecutionCommandReplySchema, teamExecutionRecordSchema, teamExecutionReceiptSchema,
  teamExecutionViewSchema, teamTaskIdentity, type TeamTaskRef, type TeamExecutionCommand, type TeamExecutionReceipt } from '../../../shared/team-task-execution'
import { ExecutionInputTransport } from './execution-input-transport'
import type { ExecutionInputCommand } from '../../../shared/team-execution-input'
import { DesktopTeamError } from './types'
import { executionArtifactRefSchema, executionArtifactViewSchema, type ExecutionArtifactRef } from '../../../shared/team-execution-artifacts'

type Request = <S extends z.ZodType>(path: string, schema: S, body?: unknown) => Promise<z.output<S>>
/** Fixed HTTP routes and original semantic payload; this adapter never starts native work. */
export class TaskExecutionTransport {
  private readonly base: string
  private readonly query: string
  constructor(private readonly task: TeamTaskRef, private readonly actorId: string, private readonly deviceId: string, private readonly request: Request) {
    this.base = `/api/projects/${task.projectId}/crux/tasks/${encodeURIComponent(task.taskId)}/executions`
    this.query = new URLSearchParams({ contractVersion: '2', instanceId: task.instanceId, spaceId: task.spaceId, taskCreatedAt: task.taskCreatedAt }).toString()
  }
  private scope(task: TeamTaskRef, write = false): void {
    if (teamTaskIdentity(task) !== teamTaskIdentity(this.task)) throw new DesktopTeamError('EXECUTION_SCOPE_CONFLICT', '执行回复不属于原任务', write)
  }
  private commandInput(raw: TeamExecutionCommand): TeamExecutionCommand {
    const command = teamExecutionCommandSchema.parse(raw); this.scope(command.task)
    if (command.expectedActorId !== this.actorId || command.expectedDeviceId !== this.deviceId) throw new DesktopTeamError('BINDING_CHANGED', '原执行账号或设备已变化')
    return command
  }
  private receipt(command: TeamExecutionCommand, receipt: TeamExecutionReceipt): void {
    this.scope(receipt.task, true)
    const digest = createHash('sha256').update(taskInputCanonical(command)).digest('hex')
    if (receipt.commandId !== command.commandId || receipt.requestDigest !== digest || receipt.epoch !== command.expectedEpoch || receipt.kind !== command.kind
      || receipt.actorId !== this.actorId || receipt.deviceId !== this.deviceId
      || receipt.generation !== command.expectedGeneration + (command.kind === 'claim' ? 1 : 0)
      || command.kind !== 'claim' && receipt.executionId !== command.expectedExecutionId) throw new DesktopTeamError('RECEIPT_MISMATCH', '执行回执与原命令不一致', true)
  }
  async read(): Promise<z.infer<typeof teamExecutionViewSchema>> {
    const value = await this.request(`${this.base}?${this.query}`, teamExecutionViewSchema).catch(error => {
      if (error instanceof DesktopTeamError && error.code === 'NOT_FOUND') throw new DesktopTeamError('UNSUPPORTED_EXECUTION_VERSION', '原团队服务尚不支持执行契约 v2')
      throw error
    }); this.scope(value.task)
    if (value.active) { this.scope(value.active.task); if (value.active.epoch !== value.epoch || value.active.generation !== value.generation || value.active.authority !== 'active') throw new DesktopTeamError('RECEIPT_MISMATCH', '执行投影身份不一致') }
    return value
  }
  async captureInput(command: ExecutionInputCommand): ReturnType<ExecutionInputTransport['command']> {
    const transport = new ExecutionInputTransport(this.task, command.expectedExecutionId, this.actorId, this.deviceId, this.request)
    const receipt = await transport.reconcile(command)
    return receipt ? { status: 'duplicate', commandId: command.commandId, result: receipt } : transport.command(command)
  }
  inputSource(executionId: string): ReturnType<ExecutionInputTransport['source']> {
    return new ExecutionInputTransport(this.task, executionId, this.actorId, this.deviceId, this.request).source('use')
  }
  async history(id: string): Promise<z.infer<typeof teamExecutionRecordSchema>> {
    const value = await this.request(`${this.base}/${id}?${this.query}`, teamExecutionRecordSchema); this.scope(value.task)
    if (value.executionId !== id) throw new DesktopTeamError('RECEIPT_MISMATCH', '执行历史身份不一致')
    return value
  }
  async artifact(raw: ExecutionArtifactRef): Promise<z.infer<typeof executionArtifactViewSchema>> {
    const ref = executionArtifactRefSchema.parse(raw)
    const value = await this.request(`${this.base}/${ref.executionId}/artifacts/${ref.versionId}?${this.query}`, executionArtifactViewSchema)
    const selected = value.artifact, digest = createHash('sha256').update(value.text, 'utf8').digest('hex')
    if (selected.taskIdentity !== teamTaskIdentity(this.task) || selected.executionId !== ref.executionId || selected.artifactId !== ref.artifactId || selected.versionId !== ref.versionId
      || selected.disposition !== 'confirmed' || selected.bodyDigest !== ref.bodyDigest || digest !== ref.bodyDigest || Buffer.byteLength(value.text, 'utf8') !== selected.byteLength) throw new DesktopTeamError('RECEIPT_MISMATCH', 'Fixed artifact response differs from its original confirmed reference')
    return value
  }
  cutover(): CutoverTransport { return new CutoverTransport((path, schema, body) => this.request(path, schema, body)) }
  async command(raw: TeamExecutionCommand): Promise<z.infer<typeof teamExecutionCommandReplySchema>> {
    const command = this.commandInput(raw)
    if (command.kind === 'claim') {
      const cutover = await this.cutover().task(command.task)
      if (cutover && (cutover.state !== 'active' || command.cutoverAdmission?.operationId !== cutover.operationId || command.cutoverAdmission.manifestDigest !== cutover.manifestDigest)) throw new DesktopTeamError('CUTOVER_NOT_ACTIVE', 'Original imported task requires verified local activation before claiming')
      if (!cutover && command.cutoverAdmission) throw new DesktopTeamError('CUTOVER_CHANGED', 'Original activation no longer belongs to this task')
    }
    const reply = await this.request(`${this.base}/commands`, teamExecutionCommandReplySchema, command)
    if (reply.commandId !== command.commandId) throw new DesktopTeamError('RECEIPT_MISMATCH', '执行命令身份不一致', true)
    this.receipt(command, reply.result); return reply
  }
  async reconcile(raw: TeamExecutionCommand): Promise<TeamExecutionReceipt | null> {
    const command = this.commandInput(raw), value = await this.request(`${this.base}/reconcile`, teamExecutionReceiptSchema.nullable(), command)
    if (value) this.receipt(command, value)
    return value
  }
}
