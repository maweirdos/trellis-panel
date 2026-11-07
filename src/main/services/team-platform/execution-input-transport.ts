import { createHash } from 'node:crypto'
import { z } from 'zod'
import { executionInputCommandSchema, executionInputCommandReplySchema, executionInputReceiptSchema, executionInputViewSchema, executionInputResourceViewSchema, executionInputSelectionIdSchema,
  type ExecutionInputCommand, type ExecutionInputReceipt, type ExecutionInputSource } from '../../../shared/team-execution-input'
import { teamTaskIdentity, type TeamTaskRef } from '../../../shared/team-task-execution'
import { taskInputCanonical } from '../../../shared/team-task-inputs'
import { DesktopTeamError } from './types'

type Request = <S extends z.ZodType>(path: string, schema: S, body?: unknown) => Promise<z.output<S>>
/** Request is supplied by the existing authenticated team owner; no cache grants execution. */
export class ExecutionInputTransport {
  private readonly base: string
  private readonly query: Record<string, string>
  constructor(private readonly task: TeamTaskRef, private readonly executionId: string, private readonly actorId: string,
    private readonly deviceId: string | null, private readonly request: Request) {
    this.base = `/api/projects/${task.projectId}/crux/tasks/${encodeURIComponent(task.taskId)}/executions/${executionId}/inputs`
    this.query = { contractVersion: '2', instanceId: task.instanceId, spaceId: task.spaceId, taskCreatedAt: task.taskCreatedAt }
  }
  private commandInput(raw: ExecutionInputCommand): ExecutionInputCommand {
    const command = executionInputCommandSchema.parse(raw)
    if (teamTaskIdentity(command.task) !== teamTaskIdentity(this.task) || command.expectedExecutionId !== this.executionId || command.expectedActorId !== this.actorId || command.expectedDeviceId !== this.deviceId) throw new DesktopTeamError('EXECUTION_SCOPE_CONFLICT', 'Fixed input command belongs to another original execution')
    return command
  }
  private receipt(command: ExecutionInputCommand, receipt: ExecutionInputReceipt): void {
    if (teamTaskIdentity(receipt.task) !== teamTaskIdentity(this.task) || receipt.executionId !== this.executionId || receipt.generation !== command.expectedGeneration
      || receipt.epoch !== command.expectedEpoch || receipt.actorId !== this.actorId || receipt.deviceId !== this.deviceId || receipt.commandId !== command.commandId
      || receipt.requestDigest !== createHash('sha256').update(taskInputCanonical(command)).digest('hex')) throw new DesktopTeamError('RECEIPT_MISMATCH', 'Fixed input receipt does not match its original intent', true)
  }
  async command(raw: ExecutionInputCommand): Promise<z.infer<typeof executionInputCommandReplySchema>> {
    const command = this.commandInput(raw), reply = await this.request(this.base + '/commands', executionInputCommandReplySchema, command)
    if (reply.commandId !== command.commandId) throw new DesktopTeamError('RECEIPT_MISMATCH', 'Fixed input command UUID changed', true)
    this.receipt(command, reply.result); return reply
  }
  async reconcile(raw: ExecutionInputCommand): Promise<ExecutionInputReceipt | null> {
    const command = this.commandInput(raw), receipt = await this.request(this.base + '/reconcile', executionInputReceiptSchema.nullable(), command)
    if (receipt) this.receipt(command, receipt)
    return receipt
  }
  source(purpose: 'history' | 'use' = 'use'): ExecutionInputSource {
    const query = new URLSearchParams({ ...this.query, purpose }).toString()
    let pinned: z.infer<typeof executionInputViewSchema> | undefined
    return {
      read: async () => {
        const view = await this.request(`${this.base}?${query}`, executionInputViewSchema)
        if (view.purpose !== purpose || teamTaskIdentity(view.input.task) !== teamTaskIdentity(this.task) || view.input.executionId !== this.executionId
          || pinned && pinned.input.digest !== view.input.digest) throw new DesktopTeamError('EXECUTION_SCOPE_CONFLICT', 'Fixed input response changed its original execution')
        pinned = view; return view
      },
      readResource: async selectionId => {
        executionInputSelectionIdSchema.parse(selectionId)
        if (!pinned) throw new DesktopTeamError('EXECUTION_INPUT_UNAVAILABLE', 'Read the original input manifest before its resources')
        const expected = pinned.input.resources.find(item => item.selection.id === selectionId)
        if (!expected) throw new DesktopTeamError('EXECUTION_SCOPE_CONFLICT', 'Resource is not in the original input')
        const view = await this.request(`${this.base}/resources/${encodeURIComponent(selectionId)}?${query}`, executionInputResourceViewSchema)
        if (view.inputDigest !== pinned.input.digest || taskInputCanonical(view.resource) !== taskInputCanonical(expected)) throw new DesktopTeamError('EXECUTION_SCOPE_CONFLICT', 'Fixed resource response changed its original input')
        return view
      }
    }
  }
}
