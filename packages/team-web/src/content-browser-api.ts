import { z } from 'zod'
import type { HifoxWorkspaceContext } from '../../../src/shared/hifox-remote'
import type { Result, TeamContentApi } from '../../../src/shared/team-content-api'
import { teamContentApiInputSchemas } from '../../../src/shared/team-content-api'
import {
  TeamContentTransport, TeamContentTransportError, teamContentConfigReadSchema,
  type TeamContentPin, type TeamContentRequest
} from '../../../src/shared/team-content-transport'
import { teamIdSchema, type TeamSession } from './contracts'
import {
  ApiError, digest, isClientSession, pendingCommands, prepareCommand, request,
  retainContentCommandUncertainty, settleCommandReference, type PendingCommand
} from './client'

type Options = { session: TeamSession; projectId: string; teamId: string; context(): HifoxWorkspaceContext; isCurrent(): boolean }
type AdminOptions = { session: TeamSession; teamId: string }
type Method = keyof TeamContentApi

/** An authenticated original owner; no provider key or content body is persisted in browser storage. */
export class BrowserTeamContent {
  private live = true
  private readonly lifetime = new AbortController()
  private readonly sending = new Set<string>()
  private pin: TeamContentPin | null = null
  readonly workspaceKey: string
  readonly api: TeamContentApi
  constructor(private readonly options: Options | AdminOptions) {
    this.workspaceKey = 'projectId' in options ? options.context().key : JSON.stringify(['team-content-admin', location.origin, options.session.person.userId, teamIdSchema.parse(options.teamId)])
    this.api = {
      readiness: input => this.run('readiness', input), generate: input => this.run('generate', input),
      job: input => this.run('job', input), receipt: input => this.run('receipt', input), cancel: input => this.run('cancel', input),
      listReferences: input => this.run('listReferences', input), config: input => this.run('config', input),
      configure: input => this.run('configure', input), probe: input => this.run('probe', input)
    }
  }
  dispose(): void { this.live = false; this.lifetime.abort() }
  private current = (): boolean => this.live && isClientSession(this.options.session) && (!('isCurrent' in this.options) || this.options.isCurrent())
  private assertCurrent(pin?: TeamContentPin): void {
    if (!this.current()) throw new ApiError('OWNER_CHANGED', '原内容工作区或登录身份已改变，请在原账号下核对操作。')
    if ('context' in this.options) {
      const context = this.options.context()
      if (context.key !== this.workspaceKey || context.origin !== location.origin || context.state !== 'connected' || !context.instanceId || !context.epoch ||
        pin && (context.instanceId !== pin.instanceId || context.epoch !== pin.epoch || context.actorId !== pin.actorId || context.projectId !== pin.projectId)) {
        throw new ApiError('BINDING_CHANGED', '请先连接原共享工作区，内容操作不会改用其他来源。')
      }
    }
  }
  private async capture(): Promise<TeamContentPin> {
    this.assertCurrent(this.pin ?? undefined)
    if (!this.pin) {
      if ('context' in this.options) {
        const context = this.options.context()
        if (!context.instanceId || !context.epoch || context.actorId !== this.options.session.person.userId || context.projectId !== this.options.projectId) throw new ApiError('BINDING_CHANGED', '原工作区账号或项目无法核对。')
        this.pin = { workspaceKey: this.workspaceKey, instanceId: context.instanceId, epoch: context.epoch, teamId: this.options.teamId,
          projectId: this.options.projectId, actorId: this.options.session.person.userId, deviceId: null }
      } else {
        const value = await request(`/api/teams/${encodeURIComponent(this.options.teamId)}/content/config`, teamContentConfigReadSchema, this.readOptions())
        this.assertCurrent()
        if (value.config && value.config.teamId !== this.options.teamId) throw new ApiError('CONTENT_RESPONSE_MISMATCH', '模型配置不属于原团队。')
        const candidate: TeamContentPin = { workspaceKey: this.workspaceKey, instanceId: value.instanceId, epoch: value.epoch, teamId: this.options.teamId,
          projectId: null, actorId: this.options.session.person.userId, deviceId: null }
        if (this.pin && JSON.stringify(this.pin) !== JSON.stringify(candidate)) throw new ApiError('WORKSPACE_EPOCH_CHANGED', '原服务世代已改变，请重新打开设置。')
        this.pin = candidate
      }
    }
    return this.pin
  }
  private readOptions() { return { signal: this.lifetime.signal, isCurrent: this.current, notifyDenied: false } }
  private async call<S extends z.ZodType>(pin: TeamContentPin, path: string, schema: S, body?: Record<string, unknown>, validate?: (value: z.output<S>) => void): Promise<z.output<S>> {
    const typedSchema = schema as z.ZodType<z.output<S>>
    this.assertCurrent(pin)
    if (body === undefined) {
      const value = await request(path, typedSchema, this.readOptions()); this.assertCurrent(pin); validate?.(value); return value
    }
    const commandId = teamIdSchema.parse(body.commandId)
    if (this.sending.has(commandId)) throw new ApiError('IN_FLIGHT', '原内容操作正在核对。')
    this.sending.add(commandId)
    let entry: PendingCommand | undefined, preparedBody: Record<string, unknown> | undefined, dispatched = false, previouslyUnknown = false
    try {
      entry = pendingCommands(pin.actorId).find(item => item.commandId === commandId)
      if (entry) {
        previouslyUnknown = true // A prior pending dispatch can still commit, including after a reload.
        if (entry.path !== path || entry.projectId !== pin.projectId || entry.workspace?.origin !== location.origin || entry.workspace.instanceId !== pin.instanceId || entry.workspace.epoch !== pin.epoch || entry.digest !== await digest(JSON.stringify(body))) {
          throw new ApiError('COMMAND_CONFLICT', '原操作的内容或服务身份已变化，请保留原标识核对。', 0, true)
        }
      } else {
        const prepared = await prepareCommand(path, body, schema, pin.projectId,
          { origin: location.origin, instanceId: pin.instanceId, epoch: pin.epoch, operation: 'content:' + (path.endsWith('/config') ? 'configure' : path.endsWith('/probe') ? 'probe' : path.endsWith('/cancel') ? 'cancel' : 'generate'), expectedRevision: typeof body.expectedRevision === 'number' ? body.expectedRevision : typeof body.expectedConfigRevision === 'number' ? body.expectedConfigRevision : 0 }, commandId)
        entry = prepared.entry; preparedBody = prepared.body
      }
      this.assertCurrent(pin)
      dispatched = true
      const value = await request(path, typedSchema, { ...this.readOptions(), body })
      try { this.assertCurrent(pin); validate?.(value); settleCommandReference(entry) }
      catch { throw new ApiError('CONTENT_RECEIPT_UNCONFIRMED', '服务端可能已有结果，原操作身份已保留，请继续核对。', 0, true) }
      return value
    } catch (error) {
      const unknown = previouslyUnknown || error instanceof ApiError && error.uncertain || error instanceof TeamContentTransportError && error.outcomeUnknown
      if (entry) {
        if (unknown) { try { retainContentCommandUncertainty(entry) } catch { /* The original metadata reference remains. */ } }
        else { try { settleCommandReference(entry) } catch { throw new ApiError('JOURNAL_UNAVAILABLE', '浏览器未能更新原操作引用，请继续保留并核对。', 0, dispatched) } }
      }
      if (unknown && !(error instanceof ApiError && error.uncertain)) throw new ApiError('CONTENT_OUTCOME_UNKNOWN', '原内容操作结果仍未确认，请保留原标识和输入核对。', 0, true)
      throw error
    } finally {
      // prepareCommand remembers the same body object. Keep its digest/reference, never the key.
      if (preparedBody) delete preparedBody.apiKey
      delete body.apiKey
      this.sending.delete(commandId)
    }
  }
  private async run<M extends Method>(method: M, input: Parameters<TeamContentApi[M]>[0]): Promise<Awaited<ReturnType<TeamContentApi[M]>>> {
    try {
      const key = teamContentApiInputSchemas[method].parse(input).workspaceKey
      if (key !== this.workspaceKey) throw new ApiError('BINDING_CHANGED', '内容请求不属于原工作区。')
      const pin = await this.capture()
      const send: TeamContentRequest = (path, schema, body, validate) => this.call(pin, path, schema, body, validate)
      const transport = new TeamContentTransport(pin, send)
      let data: unknown
      try { data = await Reflect.apply(transport[method], transport, [input]) }
      catch (error) {
        if (method !== 'receipt' || !(error instanceof ApiError) || error.status !== 404 || error.code !== 'NOT_FOUND') throw error
        data = null
      }
      if (method === 'receipt' && data !== null) {
        const commandId = z.object({ commandId: z.string().uuid() }).parse(input).commandId
        const entry = pendingCommands(pin.actorId).find(item => item.commandId === commandId)
        if (entry) {
          const taskId = z.object({ taskId: z.string() }).parse(input).taskId
          if (entry.workspace?.origin !== location.origin || entry.workspace.instanceId !== pin.instanceId || entry.workspace.epoch !== pin.epoch || entry.projectId !== pin.projectId || entry.path !== `/api/projects/${pin.projectId}/hifox/tasks/${encodeURIComponent(taskId)}/content/jobs`) throw new ApiError('CONTENT_RESPONSE_MISMATCH', '原回执不属于保留的生成操作。', 0, true)
          try { settleCommandReference(entry) }
          catch { throw new ApiError('CONTENT_RECEIPT_UNCONFIRMED', '服务端已有结果，但浏览器未能更新原引用，请继续核对。', 0, true) }
        }
      }
      return { ok: true, data } as Awaited<ReturnType<TeamContentApi[M]>>
    } catch (error) {
      const known = error instanceof ApiError || error instanceof TeamContentTransportError
      return { ok: false, code: error instanceof z.ZodError ? 'INVALID_INPUT' : known ? error.code : 'CONTENT_UNAVAILABLE',
        error: error instanceof z.ZodError ? '请核对内容参数、长度和配置范围。' : known ? error.message : '暂时无法核对内容服务，请保留原输入和操作标识。',
        outcomeUnknown: error instanceof ApiError ? error.uncertain : error instanceof TeamContentTransportError && error.outcomeUnknown } as Awaited<ReturnType<TeamContentApi[M]>>
    }
  }
}

export function createBrowserTeamContentAdmin(session: TeamSession, teamId: string): { api: TeamContentApi; workspaceKey: string; dispose(): void } {
  const lease = new BrowserTeamContent({ session, teamId })
  return { api: lease.api, workspaceKey: lease.workspaceKey, dispose: () => lease.dispose() }
}
