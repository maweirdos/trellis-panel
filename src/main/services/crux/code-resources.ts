import { createHash } from 'node:crypto'
import { z } from 'zod'
import { cruxResourceListSchema, cruxResourceTaskSchema, cruxResourceCommandSchema, cruxResourcePendingSchema, cruxResourceRecoverySchema,
  type CruxCodeResourceApi, type CruxResourceReply, type CruxResourcePending } from '../../../shared/crux-code-resources'
import { teamCodeResourceCommandSchema, teamCodeResourceCommandReplySchema, type TeamCodeResourceCommand, type TeamCodeResourceCommandReply, type TeamTaskCodeResourceDto } from '../../../shared/team-code-resources'
import { materialRead, materialWrite } from '../knowledge-access/materials'
import { withDesktopTeamService } from '../team-desktop'
import { DesktopTeamError } from '../team-platform/types'
import { cruxWorkspaceGeneration, cruxWorkspaceStatus } from './connection-service'

const pinSchema = z.object({ workspaceKey: z.string(), connectionId: z.string().uuid(), actorId: z.string().uuid(), projectId: z.string().uuid(),
  origin: z.string().url(), instanceId: z.string().uuid(), epoch: z.string().uuid(), deviceId: z.string().uuid(), pairingId: z.string().uuid() }).strict()
type Pin = z.infer<typeof pinSchema>
type Owner = { pin: Pin; generation: number; key: string }
const rowSchema = z.object({ command: teamCodeResourceCommandSchema, state: z.enum(['pending', 'unknown', 'rejected', 'committed']),
  createdAt: z.number().int().nonnegative(), error: z.string().max(2000).nullable(), receipt: teamCodeResourceCommandReplySchema.nullable() }).strict()
const journalSchema = z.object({ version: z.literal(1), pin: pinSchema, rows: z.array(rowSchema).max(96) }).strict()
type Journal = z.infer<typeof journalSchema>
const queues = new Map<string, Promise<void>>()
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const contextFields = (pin: Pin): unknown[] => [pin.workspaceKey, pin.connectionId, pin.actorId, pin.projectId, pin.origin, pin.instanceId, pin.epoch]

function fail(code: string, message: string, unknown = false): never { throw new DesktopTeamError(code, message, unknown) }

/** Shared code-resource mutations retain one protected source and original command across retries. */
export class CruxCodeResourceService implements CruxCodeResourceApi {
  constructor(private readonly dataDir: string) {}

  private async capture(workspaceKey: string): Promise<Owner> {
    const generation = cruxWorkspaceGeneration(), context = await cruxWorkspaceStatus()
    if (context.key !== workspaceKey || context.state !== 'connected' || !context.connectionId || !context.actorId || !context.projectId || !context.instanceId || !context.epoch || !context.origin) {
      fail('RESOURCE_SOURCE_UNAVAILABLE', context.state === 'local' ? '团队代码资源需要已连接的共享工作区；本机独立任务仍可使用原有工程。' : '请在原共享工作区重新核对连接与权限。')
    }
    const connection = await withDesktopTeamService(async (service) => (await service.connections()).find((item) => item.connectionId === context.connectionId))
    if (!connection || connection.state !== 'active' || connection.accessLocked || connection.ownerId !== context.actorId || connection.projectId !== context.projectId || connection.origin !== context.origin) fail('BINDING_CHANGED', '原团队设备或账号已变化。')
    const pin = pinSchema.parse({ workspaceKey, connectionId: context.connectionId, actorId: context.actorId, projectId: context.projectId,
      origin: context.origin, instanceId: context.instanceId, epoch: context.epoch, deviceId: connection.deviceId, pairingId: connection.pairingId })
    const owner = { pin, generation, key: digest(pin) }
    await this.current(owner)
    return owner
  }

  private async current(owner: Owner): Promise<void> {
    const context = await cruxWorkspaceStatus()
    const actual = [context.key, context.connectionId, context.actorId, context.projectId, context.origin, context.instanceId, context.epoch]
    if (cruxWorkspaceGeneration() !== owner.generation || context.state !== 'connected' || JSON.stringify(actual) !== JSON.stringify(contextFields(owner.pin))) {
      fail('BINDING_CHANGED', '原代码资源的工作区或身份已变化；请回原来源核对操作。')
    }
  }

  private async reply<T>(action: () => Promise<T>): Promise<CruxResourceReply<T>> {
    try { return { ok: true, value: await action() } }
    catch (error) {
      return { ok: false, code: error instanceof z.ZodError ? 'INVALID_INPUT' : error instanceof DesktopTeamError ? error.code : 'RESOURCE_OPERATION_FAILED',
        error: error instanceof z.ZodError ? '代码资源参数无效，请核对输入。' : error instanceof DesktopTeamError ? error.message : '代码资源操作未能确认，原内容和操作记录已保留。',
        outcomeUnknown: error instanceof DesktopTeamError && error.outcomeUnknown }
    }
  }

  private file(owner: Owner): string { return `crux-code-resources/${owner.key}.json` }
  private read(owner: Owner): { journal: Journal; revision: string | null } {
    const stored = materialRead(this.dataDir, this.file(owner))
    if (stored.revision === null) return { journal: { version: 1, pin: owner.pin, rows: [] }, revision: null }
    let journal: Journal
    try { journal = journalSchema.parse(JSON.parse(stored.body)) }
    catch { return fail('RESOURCE_JOURNAL_UNAVAILABLE', '原代码资源操作记录无法读取，未重置记录或重发命令。') }
    if (digest(journal.pin) !== owner.key) fail('BINDING_CHANGED', '操作记录不属于原代码资源身份。')
    return { journal, revision: stored.revision }
  }
  private save(owner: Owner, journal: Journal, revision: string | null): void {
    const active = journal.rows.filter((row) => row.state === 'unknown' || row.state === 'pending')
    const history = journal.rows.filter((row) => row.state !== 'unknown' && row.state !== 'pending').slice(-32)
    if (active.length > 64) fail('RESOURCE_JOURNAL_CAPACITY', '有过多未核对操作，请先核对原命令结果。')
    const bounded = journalSchema.parse({ ...journal, rows: [...history, ...active] })
    const body = JSON.stringify(bounded)
    if (Buffer.byteLength(body, 'utf8') > 800 * 1024) fail('RESOURCE_JOURNAL_CAPACITY', '原操作记录已达容量限制，请先处理待核对操作。')
    materialWrite(this.dataDir, this.file(owner), body, revision)
  }
  private async locked<T>(owner: Owner, action: () => Promise<T>): Promise<T> {
    const key = `${this.dataDir}:${owner.key}`, previous = queues.get(key)
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    queues.set(key, gate)
    try { if (previous) await previous; await this.current(owner); return await action() }
    finally { release?.(); if (queues.get(key) === gate) queues.delete(key) }
  }
  private settle(owner: Owner, commandId: string, receipt: TeamCodeResourceCommandReply): void {
    const stored = this.read(owner), row = stored.journal.rows.find((entry) => entry.command.commandId === commandId)
    if (!row) fail('RESOURCE_JOURNAL_UNAVAILABLE', '原代码资源操作记录缺失，不能接纳其他操作的结果。', true)
    const command = row.command
    const targetId = command.kind === 'create' || command.kind === 'update' ? command.resourceId : command.kind === 'setSpaceResources' ? command.spaceId : command.taskId
    const spaceId = command.kind === 'selectTaskResource' ? command.expectedSpaceId : command.kind === 'setSpaceResources' ? command.spaceId : null
    if (receipt.commandId !== commandId || receipt.result.kind !== command.kind || receipt.result.targetId !== targetId || receipt.result.spaceId !== spaceId
      || receipt.result.epoch !== command.expectedEpoch || command.kind === 'selectTaskResource' && receipt.result.taskCreatedAt !== command.expectedTaskCreatedAt) {
      fail('RECEIPT_MISMATCH', '代码资源回执与原操作目标不一致，原命令已保留。', true)
    }
    row.state = 'committed'; row.receipt = receipt; row.error = null
    this.save(owner, stored.journal, stored.revision)
  }

  list(raw: z.input<typeof cruxResourceListSchema>): ReturnType<CruxCodeResourceApi['list']> {
    return this.reply(async () => {
      const { workspaceKey, ...input } = cruxResourceListSchema.parse(raw), owner = await this.capture(workspaceKey)
      const value = await withDesktopTeamService((service) => service.codeResources(owner.pin.connectionId, input, owner.pin))
      await this.current(owner)
      return value
    })
  }
  task(raw: z.input<typeof cruxResourceTaskSchema>): ReturnType<CruxCodeResourceApi['task']> {
    return this.reply(async () => {
      const input = cruxResourceTaskSchema.parse(raw), owner = await this.capture(input.workspaceKey)
      const value = await withDesktopTeamService((service) => service.taskCodeResource(owner.pin.connectionId, input.taskId, owner.pin))
      await this.current(owner)
      return value
    })
  }
  /** Trusted prepare path shares the same identity fence as the renderer read. */
  async taskForPreparation(workspaceKey: string, taskId: string): Promise<TeamTaskCodeResourceDto | null> {
    const current = await cruxWorkspaceStatus()
    if (current.key === workspaceKey && current.state === 'local') return null
    const result = await this.task({ workspaceKey, taskId })
    if (result.ok === false) fail(result.code, result.error, result.outcomeUnknown)
    return result.value
  }
  command(raw: z.input<typeof cruxResourceCommandSchema>): ReturnType<CruxCodeResourceApi['command']> {
    return this.reply(async () => {
      const input = cruxResourceCommandSchema.parse(raw), owner = await this.capture(input.workspaceKey)
      return this.locked(owner, async () => {
        if (input.command.expectedEpoch !== owner.pin.epoch) fail('WORKSPACE_EPOCH_CHANGED', '命令属于旧服务世代，不能改投。')
        const stored = this.read(owner), previous = stored.journal.rows.find((row) => row.command.commandId === input.command.commandId)
        if (previous) {
          if (digest(previous.command) !== digest(input.command)) fail('COMMAND_CONFLICT', '同一操作编号不能换成不同内容。')
          const receipt = await this.receipt(owner, input.command.commandId)
          if (receipt) return receipt
          fail('ACKNOWLEDGEMENT_UNKNOWN', '原命令结果尚未确定，请核对或明确以原内容重试。', true)
        }
        stored.journal.rows.push({ command: input.command, createdAt: Date.now(), state: 'pending', error: null, receipt: null })
        this.save(owner, stored.journal, stored.revision)
        return this.dispatch(owner, input.command)
      })
    })
  }
  private async dispatch(owner: Owner, command: TeamCodeResourceCommand): Promise<TeamCodeResourceCommandReply> {
    await this.current(owner)
    const stored = this.read(owner), row = stored.journal.rows.find((entry) => entry.command.commandId === command.commandId)
    if (!row || digest(row.command) !== digest(command)) fail('RESOURCE_JOURNAL_UNAVAILABLE', '原代码资源命令尚未安全保存。')
    // Persist possible dispatch before HTTP; a crash cannot turn it into an automatic new write.
    row.state = 'unknown'; row.error = null
    this.save(owner, stored.journal, stored.revision)
    try {
      const result = await withDesktopTeamService((service) => service.codeResourceCommand(owner.pin.connectionId, command, owner.pin.instanceId))
      this.settle(owner, command.commandId, result)
      await this.current(owner)
      return result
    } catch (error) {
      const latest = this.read(owner), entry = latest.journal.rows.find((item) => item.command.commandId === command.commandId)
      if (entry && entry.state !== 'committed') {
        entry.state = error instanceof DesktopTeamError && !error.outcomeUnknown ? 'rejected' : 'unknown'
        entry.error = error instanceof DesktopTeamError ? error.message.slice(0, 2000) : '原操作结果未能确认，请核对。'
        this.save(owner, latest.journal, latest.revision)
      }
      if (!(error instanceof DesktopTeamError)) fail('ACKNOWLEDGEMENT_UNKNOWN', '操作已进入发送流程但结果未能完整保存，请核对原命令。', true)
      throw error
    }
  }
  private async receipt(owner: Owner, commandId: string): Promise<TeamCodeResourceCommandReply | null> {
    await this.current(owner)
    const result = await withDesktopTeamService((service) => service.codeResourceReceipt(owner.pin.connectionId, commandId, owner.pin))
    if (result) this.settle(owner, commandId, result)
    await this.current(owner)
    return result
  }
  pending(raw: z.input<typeof cruxResourcePendingSchema>): ReturnType<CruxCodeResourceApi['pending']> {
    return this.reply(async () => {
      const input = cruxResourcePendingSchema.parse(raw), owner = await this.capture(input.workspaceKey)
      const value: CruxResourcePending[] = this.read(owner).journal.rows.filter((row) => row.state !== 'committed').map((row) => ({
        commandId: row.command.commandId, kind: row.command.kind, state: row.state === 'committed' ? 'unknown' : row.state,
        createdAt: row.createdAt, error: row.error
      }))
      await this.current(owner)
      return value
    })
  }
  reconcile(raw: z.input<typeof cruxResourceRecoverySchema>): ReturnType<CruxCodeResourceApi['reconcile']> {
    return this.reply(async () => {
      const input = cruxResourceRecoverySchema.parse(raw), owner = await this.capture(input.workspaceKey)
      return this.locked(owner, async () => {
        if (!this.read(owner).journal.rows.some((row) => row.command.commandId === input.commandId)) fail('NOT_FOUND', '没有属于当前身份的原操作记录。')
        return this.receipt(owner, input.commandId)
      })
    })
  }
  retry(raw: z.input<typeof cruxResourceRecoverySchema>): ReturnType<CruxCodeResourceApi['retry']> {
    return this.reply(async () => {
      const input = cruxResourceRecoverySchema.parse(raw), owner = await this.capture(input.workspaceKey)
      return this.locked(owner, async () => {
        const row = this.read(owner).journal.rows.find((entry) => entry.command.commandId === input.commandId)
        if (!row) fail('NOT_FOUND', '原代码资源操作不存在。')
        const result = await this.receipt(owner, input.commandId)
        if (result) return result
        return this.dispatch(owner, row.command)
      })
    })
  }
}
