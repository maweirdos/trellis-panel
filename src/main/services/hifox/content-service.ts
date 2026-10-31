import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { TeamContentApi } from '../../../shared/team-content-api'
import { teamContentApiInputSchemas } from '../../../shared/team-content-api'
import { ipcFail } from '../../../shared/ipc-errors'
import { TeamContentTransport, TeamContentTransportError, type TeamContentRequest } from '../../../shared/team-content-transport'
import { materialRead, materialWrite } from '../knowledge-access/materials'
import { withDesktopTeamService } from '../team-desktop'
import { nativeContentPinSchema, type NativeContentPin } from '../team-platform/content-transport'
import { DesktopTeamError } from '../team-platform/types'
import { hifoxWorkspaceGeneration, hifoxWorkspaceStatus } from './connection-service'

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
type Owner = { pin: NativeContentPin; generation: number; file: string }
const rowSchema = z.object({ commandId: z.string().uuid(), instanceId: z.string().uuid(), epoch: z.string().uuid(), path: z.string().max(500),
  digest: z.string().regex(/^[a-f0-9]{64}$/), state: z.enum(['pending', 'unknown', 'committed', 'rejected']), createdAt: z.number().int().nonnegative() }).strict()
const journalSchema = z.object({ version: z.literal(1), rows: z.array(rowSchema).max(128) }).strict()
const queues = new Map<string, Promise<void>>()
type Method = keyof TeamContentApi
function fail(code: string, message: string, unknown = false): never { throw new DesktopTeamError(code, message, unknown) }

/** Content operations retain metadata-only original command references, never provider credentials. */
export class HifoxContentService implements TeamContentApi {
  constructor(private readonly dataDir: string) {}
  readiness: TeamContentApi['readiness'] = input => this.run('readiness', input)
  generate: TeamContentApi['generate'] = input => this.run('generate', input)
  job: TeamContentApi['job'] = input => this.run('job', input)
  receipt: TeamContentApi['receipt'] = input => this.run('receipt', input)
  cancel: TeamContentApi['cancel'] = input => this.run('cancel', input)
  listReferences: TeamContentApi['listReferences'] = input => this.run('listReferences', input)
  config: TeamContentApi['config'] = input => this.run('config', input)
  configure: TeamContentApi['configure'] = input => this.run('configure', input)
  probe: TeamContentApi['probe'] = input => this.run('probe', input)

  private async capture(workspaceKey: string): Promise<Owner> {
    const generation = hifoxWorkspaceGeneration(), context = await hifoxWorkspaceStatus()
    if (context.key !== workspaceKey || context.state !== 'connected' || !context.connectionId || !context.actorId || !context.projectId || !context.origin || !context.instanceId || !context.epoch) fail('CONTENT_SOURCE_UNAVAILABLE', '团队内容服务需要已连接的共享工作区。')
    const connectionId = context.connectionId
    const connection = await withDesktopTeamService(async service => (await service.connections()).find(item => item.connectionId === connectionId))
    if (!connection || connection.state !== 'active' || connection.accessLocked || connection.ownerId !== context.actorId || connection.projectId !== context.projectId || connection.origin !== context.origin) fail('BINDING_CHANGED', '原内容连接或设备身份已变化。')
    const authorized = await withDesktopTeamService(service => service.connectionContext(connectionId))
    if (authorized.person.userId !== connection.ownerId || authorized.project.projectId !== connection.projectId) fail('BINDING_CHANGED', '原账号或项目授权无法核对。')
    const pin = nativeContentPinSchema.parse({ workspaceKey, connectionId, origin: context.origin, instanceId: context.instanceId, epoch: context.epoch,
      actorId: context.actorId, deviceId: connection.deviceId, pairingId: connection.pairingId, projectId: context.projectId, teamId: authorized.project.teamId })
    const owner = { pin, generation, file: `hifox-content-commands/${digest([pin.workspaceKey, pin.connectionId, pin.origin, pin.actorId, pin.deviceId, pin.pairingId, pin.projectId])}.json` }
    await this.current(owner)
    return owner
  }
  private async current(owner: Owner): Promise<void> {
    const context = await hifoxWorkspaceStatus(), pin = owner.pin
    if (hifoxWorkspaceGeneration() !== owner.generation || context.state !== 'connected' || context.key !== pin.workspaceKey || context.connectionId !== pin.connectionId ||
      context.actorId !== pin.actorId || context.projectId !== pin.projectId || context.origin !== pin.origin || context.instanceId !== pin.instanceId || context.epoch !== pin.epoch) fail('BINDING_CHANGED', '原内容工作区已改变，请回原来源核对操作。')
  }
  private read(owner: Owner) {
    try {
      const stored = materialRead(this.dataDir, owner.file)
      return { revision: stored.revision, journal: stored.revision === null ? { version: 1 as const, rows: [] as z.infer<typeof rowSchema>[] } : journalSchema.parse(JSON.parse(stored.body)) }
    }
    catch { return fail('CONTENT_JOURNAL_UNAVAILABLE', '原内容操作记录无法读取，请保留记录核对。') }
  }
  private save(owner: Owner, stored: ReturnType<HifoxContentService['read']>): void {
    const active = stored.journal.rows.filter(row => row.state === 'pending' || row.state === 'unknown')
    const history = stored.journal.rows.filter(row => row.state !== 'pending' && row.state !== 'unknown').slice(-32)
    if (active.length > 96) fail('CONTENT_JOURNAL_CAPACITY', '待核对内容操作已达上限，请先核对原操作。')
    materialWrite(this.dataDir, owner.file, JSON.stringify(journalSchema.parse({ version: 1, rows: [...history, ...active] })), stored.revision)
  }
  private async locked<T>(owner: Owner, action: () => Promise<T>): Promise<T> {
    const key = this.dataDir + ':' + owner.file, previous = queues.get(key)
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve }); queues.set(key, gate)
    try { if (previous) await previous; await this.current(owner); return await action() }
    finally { release?.(); if (queues.get(key) === gate) queues.delete(key) }
  }
  private async dispatch<S extends z.ZodType>(owner: Owner, request: TeamContentRequest, path: string, schema: S, body?: Record<string, unknown>, validate?: (value: z.output<S>) => void): Promise<z.output<S>> {
    if (body === undefined) return request(path, schema, undefined, validate)
    return this.locked(owner, async () => {
      const commandId = z.string().uuid().parse(body.commandId), bodyDigest = digest(body)
      const stored = this.read(owner), previous = stored.journal.rows.find(row => row.commandId === commandId)
      if (previous && (previous.digest !== bodyDigest || previous.path !== path || previous.instanceId !== owner.pin.instanceId || previous.epoch !== owner.pin.epoch)) fail('COMMAND_CONFLICT', '同一内容操作不能更换原输入、路径或服务世代。', previous.state === 'unknown' || previous.state === 'pending')
      if (!previous) stored.journal.rows.push({ commandId, path, digest: bodyDigest, instanceId: owner.pin.instanceId, epoch: owner.pin.epoch, state: 'pending', createdAt: Date.now() })
      this.save(owner, stored)
      const previouslyUnknown = previous?.state === 'pending' || previous?.state === 'unknown'
      try {
        const value = await request(path, schema, body, validate)
        try { await this.current(owner) }
        catch { fail('BINDING_CHANGED', '原内容身份在请求结束时已变化，请核对原操作。', true) }
        try { const latest = this.read(owner), row = latest.journal.rows.find(item => item.commandId === commandId); if (!row) fail('CONTENT_JOURNAL_UNAVAILABLE', '原操作引用缺失。', true); row.state = 'committed'; this.save(owner, latest) }
        catch { fail('CONTENT_RECEIPT_UNCONFIRMED', '服务端可能已有结果，但本机无法保存核对记录，请保留原操作。', true) }
        return value
      } catch (error) {
        const unknown = previouslyUnknown || error instanceof DesktopTeamError && error.outcomeUnknown || error instanceof TeamContentTransportError && error.outcomeUnknown
        try { const latest = this.read(owner), row = latest.journal.rows.find(item => item.commandId === commandId); if (row) { row.state = unknown ? 'unknown' : 'rejected'; this.save(owner, latest) } }
        catch { fail('CONTENT_JOURNAL_UNAVAILABLE', '原操作结果和本机记录未能核对，请保留原标识。', true) }
        if (unknown && !(error instanceof DesktopTeamError && error.outcomeUnknown)) fail('CONTENT_OUTCOME_UNKNOWN', '原内容操作的结果仍未确认，请保留原输入和标识。', true)
        throw error
      } finally { delete body.apiKey }
    })
  }
  private async run<M extends Method>(method: M, input: Parameters<TeamContentApi[M]>[0]): Promise<Awaited<ReturnType<TeamContentApi[M]>>> {
    try {
      const workspaceKey = teamContentApiInputSchemas[method].parse(input).workspaceKey, owner = await this.capture(workspaceKey)
      let data: unknown
      try {
        data = await withDesktopTeamService(service => service.withContentTransport(owner.pin, () => this.current(owner), async request => {
          const send: TeamContentRequest = (path, schema, body, validate) => this.dispatch(owner, request, path, schema, body, validate)
          const transport = new TeamContentTransport(owner.pin, send)
          return Reflect.apply(transport[method], transport, [input]) as Promise<unknown>
        }))
      } catch (error) {
        if (method !== 'receipt' || !(error instanceof DesktopTeamError) || error.code !== 'NOT_FOUND') throw error
        data = null
      }
      try { await this.current(owner) }
      catch { fail('BINDING_CHANGED', '原内容身份在请求结束时已变化，请核对原操作。', ['generate', 'cancel', 'configure', 'probe'].includes(method)) }
      if (method === 'receipt' && data !== null) {
        const commandId = z.object({ commandId: z.string().uuid() }).parse(input).commandId
        const taskId = z.object({ taskId: z.string() }).parse(input).taskId
        await this.locked(owner, async () => {
          const stored = this.read(owner), row = stored.journal.rows.find(item => item.commandId === commandId)
          if (!row) return
          if (row.instanceId !== owner.pin.instanceId || row.epoch !== owner.pin.epoch || row.path !== `/api/projects/${owner.pin.projectId}/hifox/tasks/${encodeURIComponent(taskId)}/content/jobs`) fail('CONTENT_RESPONSE_MISMATCH', '原回执不属于保留的生成操作。', true)
          try { row.state = 'committed'; this.save(owner, stored) }
          catch { fail('CONTENT_RECEIPT_UNCONFIRMED', '服务端已有结果，但本机无法保存核对记录，请保留原操作。', true) }
        })
      }
      return { ok: true, data } as Awaited<ReturnType<TeamContentApi[M]>>
    } catch (error) {
      const known = error instanceof DesktopTeamError || error instanceof TeamContentTransportError
      return ipcFail('E_UNKNOWN',
        error instanceof z.ZodError ? '请核对内容参数、长度和配置范围。' : known ? error.message : '暂时无法核对内容服务，请保留原输入和操作标识。',
        { code: error instanceof z.ZodError ? 'INVALID_INPUT' : known ? error.code : 'CONTENT_UNAVAILABLE', outcomeUnknown: known && error.outcomeUnknown }) as Awaited<ReturnType<TeamContentApi[M]>>
    }
  }
}
