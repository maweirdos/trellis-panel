import { z } from 'zod'
import { ipcInvoke, ipcEvent } from '../../shared/ipc-channels'
import { IpcErrorCode, ipcFail } from '../../shared/ipc-errors'
import { authorizationRequestSchema, bindingRequestSchema, connectionRequestSchema, externalObjectSchema, pageRequestSchema, projectContextSchema, saveBindingSchema, saveConnectionSchema } from '../../shared/integrations'
import { handle } from './registry'
import { integrationRegistry } from '../services/integrations/providers'
import { IntegrationError } from '../services/integrations/types'
import * as service from '../services/integrations/service'
import { broadcastToWindows } from '../services/bridge'

function register<T>(channel: string, schema: z.ZodType<T>, action: (input: T, event: Electron.IpcMainInvokeEvent) => unknown): void {
  handle(channel, async (event, raw: unknown) => {
    const parsed = schema.safeParse(raw)
    if (!parsed.success) return ipcFail(IpcErrorCode.InvalidArg, parsed.error.issues[0]?.message || '集成参数无效')
    try {
      const data = await action(parsed.data, event)
      const mutations: readonly string[] = [ipcInvoke.integration.authorize, ipcInvoke.integration.saveConnection, ipcInvoke.integration.removeConnection, ipcInvoke.integration.inspect, ipcInvoke.integration.saveBinding, ipcInvoke.integration.removeBinding, ipcInvoke.integration.attach, ipcInvoke.integration.unlink, ipcInvoke.integration.sendNotification]
      if (mutations.includes(channel)) broadcastToWindows(ipcEvent.integrationsChanged, {})
      return { ok: true as const, data }
    }
    catch (error) {
      if (channel === ipcInvoke.integration.inspect) broadcastToWindows(ipcEvent.integrationsChanged, {})
      const code = error instanceof IntegrationError
        ? error.kind === 'conflict' ? IpcErrorCode.Conflict : error.kind === 'denied' ? IpcErrorCode.Denied : error.kind === 'io' ? IpcErrorCode.Io : error.kind === 'upstream' || error.kind === 'uncertain' ? IpcErrorCode.Upstream : IpcErrorCode.InvalidArg
        : IpcErrorCode.Upstream
      return ipcFail(code, error instanceof IntegrationError ? error.message : '集成操作失败，请检查连接、网络或本地存储后重试')
    }
  })
}
const taskRequest = projectContextSchema.extend({ taskDir: z.string().min(1).max(4096) })
const boundTaskRequest = bindingRequestSchema.extend({ taskDir: z.string().min(1).max(4096) })
const issueRequest = bindingRequestSchema.extend({ key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*-\d+$/) })
const previewSchema = z.object({ title: z.string().max(200), body: z.string().max(2000), taskRef: z.string().max(1000), destination: z.string().max(100) })
export function registerIntegrationsIpc(): void {
  const channels = ipcInvoke.integration
  const reads = new Map<string, AbortController>()
  const authorizations = new Map<string, AbortController>()
  register(channels.cancelAuthorization, z.object({ requestId: z.string().uuid() }), (input, event) => {
    authorizations.get(`${event.sender.id}:${input.requestId}`)?.abort()
    return null
  })
  register(channels.authorize, authorizationRequestSchema, async (input, event) => {
    const key = `${event.sender.id}:${input.requestId}`
    if (authorizations.size || authorizations.has(key)) throw new IntegrationError('已有浏览器授权进行中，请完成或取消后重试', 'conflict')
    const controller = new AbortController()
    authorizations.set(key, controller)
    const onDestroyed = (): void => controller.abort()
    event.sender.once('destroyed', onDestroyed)
    try { return await service.authorizeConnection(input, AbortSignal.any([controller.signal, AbortSignal.timeout(5 * 60 * 1000)])) }
    finally { authorizations.delete(key); if (!event.sender.isDestroyed()) event.sender.removeListener('destroyed', onDestroyed) }
  })
  register(channels.cancelRead, z.object({ requestId: z.string().uuid() }), (input, event) => {
    const key = `${event.sender.id}:${input.requestId}`
    reads.get(key)?.abort(); reads.delete(key)
    return null
  })
  register(channels.list, z.unknown(), () => service.integrationSnapshot())
  register(channels.saveConnection, saveConnectionSchema, service.saveConnection)
  register(channels.removeConnection, connectionRequestSchema, service.removeConnection)
  register(channels.inspect, connectionRequestSchema, service.inspectConnection)
  register(channels.saveBinding, saveBindingSchema, service.saveBinding)
  register(channels.removeBinding, bindingRequestSchema, service.removeBinding)
  register(channels.repositories, pageRequestSchema, async (input) => {
    service.requireProject(input.expectedRoot)
    const connection = service.resolveConnection(input)
    const port = integrationRegistry.get(connection.public.providerId).repository
    if (!port) throw new IntegrationError('此连接不支持仓库读取')
    const result = await port.repositories(connection, input.page, input.query)
    service.resolveConnection(input)
    service.requireProject(input.expectedRoot)
    return result
  })
  register(channels.pullRequests, bindingRequestSchema.extend({ page: z.number().int().min(1).max(200).default(1) }), async (input) => {
    const { binding, connection } = service.resolveBinding(input)
    const port = integrationRegistry.get(connection.public.providerId).repository
    if (!port) throw new IntegrationError('此连接不支持仓库读取')
    const result = await port.pullRequests(connection, binding.scope, input.page)
    service.resolveBinding(input)
    service.requireProject(input.expectedRoot)
    return result
  })
  register(channels.links, taskRequest, (input) => service.listLinks(input.expectedRoot, input.taskDir))
  register(channels.attach, boundTaskRequest.extend({ object: externalObjectSchema }), service.attachLink)
  register(channels.unlink, taskRequest.extend({ linkId: z.number().int().positive() }), (input) => service.unlink(input.expectedRoot, input.taskDir, input.linkId))
  register(channels.previewNotification, boundTaskRequest, service.previewNotification)
  register(channels.sendNotification, boundTaskRequest.extend({ requestId: z.string().uuid(), preview: previewSchema }), service.sendNotification)
  register(channels.jiraContext, projectContextSchema, (input) => service.currentJiraContext(input.expectedRoot))
  register(channels.jiraSearch, bindingRequestSchema.extend({ jql: z.string().max(4000), requestId: z.string().uuid() }), async (input, event) => {
    const key = `${event.sender.id}:${input.requestId}`
    if (reads.has(key)) throw new IntegrationError('查询标识已在使用', 'conflict')
    if ([...reads.keys()].filter((id) => id.startsWith(`${event.sender.id}:`)).length >= 4) throw new IntegrationError('查询数量已达上限，请先等待或取消前一查询', 'denied')
    const controller = new AbortController()
    reads.set(key, controller)
    const onDestroyed = (): void => { controller.abort() }
    event.sender.once('destroyed', onDestroyed)
    try { return await service.searchJira({ ...input, signal: controller.signal }) }
    finally { reads.delete(key); if (!event.sender.isDestroyed()) event.sender.removeListener('destroyed', onDestroyed) }
  })
  register(channels.jiraTransitions, issueRequest, service.getJiraTransitions)
  register(channels.jiraTransition, issueRequest.extend({ transitionId: z.string().min(1).max(100), expectedToStatus: z.string().min(1).max(200) }), service.transitionJira)
  register(channels.jiraComment, issueRequest.extend({ body: z.string().trim().min(1).max(10000) }), service.commentJira)
}
