import type { z } from 'zod'
import {
  legacyIntegrationRequestSchema, legacyIntegrationResults, legacyIntegrationResultSchema,
  type LegacyIntegrationRequest
} from '../../shared/integration-native'
import { ipcFail, IpcErrorCode } from '../../shared/ipc-errors'
import { integrationRegistry } from '../services/integrations/providers'
import * as service from '../services/integrations/service'
import { IntegrationError } from '../services/integrations/types'
import type { DaemonWorkspaceScope } from './workspace-scope'
import type { ProcessOwner } from '../../shared/daemon'
import { createTeamGitlabAuthorizations } from './team-gitlab'

type Result = z.infer<typeof legacyIntegrationResultSchema>

/** Uses the application's existing protected settings/integration repositories.
 * Main composition must invoke dispatch inside its authenticated scope.run(...).
 * This adapter cannot grant a workspace or install another persistence owner. */
export function createLegacyIntegrationActions(scope: DaemonWorkspaceScope): {
  dispatch(raw: unknown, signal?: AbortSignal, actor?: ProcessOwner): Promise<Result>
  shutdown(): void
} {
  const reads = new Map<string, AbortController>()
  const authorizations = new Map<string, AbortController>()
  const teamGitlab = createTeamGitlabAuthorizations()
  // Cancellation can arrive on a separate pipe while the original bulk upload
  // is still pending. Retain that fact so late admission cannot revive it.
  const cancelled = new Map<string, number>()
  let closed = false
  const keyFor = (ownerId: string, kind: 'read' | 'auth', requestId: string): string => `${ownerId}:${kind}:${requestId}`
  const prune = (): void => { for (const [key, until] of cancelled) if (until <= Date.now()) cancelled.delete(key) }
  function cancel(key: string, active: Map<string, AbortController>): null {
    const controller = active.get(key)
    if (controller) controller.abort()
    prune()
    if (!cancelled.has(key) && cancelled.size >= 256) throw new IntegrationError('取消记录已达容量上限，请等待在途请求结束', 'denied')
    cancelled.set(key, Date.now() + 5 * 60_000)
    return null
  }
  async function cancellable<T>(request: LegacyIntegrationRequest, kind: 'read' | 'auth', requestId: string, signal: AbortSignal | undefined, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    prune()
    const active = kind === 'read' ? reads : authorizations
    const key = keyFor(request.ownerId, kind, requestId)
    if (cancelled.has(key)) throw new IntegrationError('请求已取消，请使用新的请求标识重新操作', 'denied')
    if (active.has(key)) throw new IntegrationError('查询或授权标识已在使用', 'conflict')
    if (kind === 'auth' && authorizations.size) throw new IntegrationError('已有浏览器授权进行中，请完成或取消后重试', 'conflict')
    if (kind === 'read' && ([...reads.keys()].filter(value => value.startsWith(`${request.ownerId}:read:`)).length >= 4 || reads.size >= 64)) throw new IntegrationError('查询数量已达上限，请先等待或取消前一查询', 'denied')
    const controller = new AbortController()
    const signals = [controller.signal, ...(signal ? [signal] : []), ...(kind === 'auth' ? [AbortSignal.timeout(5 * 60_000)] : [])]
    const current = AbortSignal.any(signals)
    active.set(key, controller)
    try {
      if (current.aborted) throw new IntegrationError('请求已取消或超时', 'denied')
      return await action(current)
    } finally { if (active.get(key) === controller) active.delete(key) }
  }
  async function execute(request: LegacyIntegrationRequest, signal?: AbortSignal, actor?: ProcessOwner): Promise<unknown> {
    if (request.operation === 'teamGitlabConnect' || request.operation === 'teamGitlabCheck' || request.operation === 'teamGitlabConfirm') {
      if (!actor) throw new IntegrationError('团队 GitLab 授权缺少已认证的原生进程', 'denied')
      if (request.operation === 'teamGitlabConnect') return cancellable(request, 'auth', request.input.requestId, signal, current => teamGitlab.connect(actor, request.ownerId, request.input, current))
      if (request.operation === 'teamGitlabCheck') return teamGitlab.check(actor, request.ownerId, request.input.requestId)
      return teamGitlab.confirm(actor, request.ownerId, request.input.requestId, request.input.challengeId)
    }
    switch (request.operation) {
      case 'cancelAuthorization': return cancel(keyFor(request.ownerId, 'auth', request.input.requestId), authorizations)
      case 'cancelRead': return cancel(keyFor(request.ownerId, 'read', request.input.requestId), reads)
      case 'authorize': return cancellable(request, 'auth', request.input.requestId, signal, current => service.authorizeConnection(request.input, current))
      case 'jiraSearch': {
        const result = await cancellable(request, 'read', request.input.requestId, signal, current => service.searchJira({ ...request.input, signal: current }))
        service.resolveBinding(request.input)
        return result
      }
      case 'list': return service.integrationSnapshot()
      case 'saveConnection': return service.saveConnection(request.input)
      case 'removeConnection': return service.removeConnection(request.input)
      case 'inspect': return service.inspectConnection(request.input)
      case 'saveBinding': return service.saveBinding(request.input)
      case 'removeBinding': return service.removeBinding(request.input)
      case 'repositories': {
        service.requireProject(request.input.expectedRoot)
        const connection = service.resolveConnection(request.input)
        const port = integrationRegistry.get(connection.public.providerId).repository
        if (!port) throw new IntegrationError('此连接不支持仓库读取')
        const result = await port.repositories(connection, request.input.page, request.input.query)
        service.resolveConnection(request.input)
        service.requireProject(request.input.expectedRoot)
        return result
      }
      case 'pullRequests': {
        const { binding, connection } = service.resolveBinding(request.input)
        const port = integrationRegistry.get(connection.public.providerId).repository
        if (!port) throw new IntegrationError('此连接不支持仓库读取')
        const result = await port.pullRequests(connection, binding.scope, request.input.page)
        service.resolveBinding(request.input)
        service.requireProject(request.input.expectedRoot)
        return result
      }
      case 'links': return service.listLinks(request.input.expectedRoot, request.input.taskDir)
      case 'attach': return service.attachLink(request.input)
      case 'unlink': return service.unlink(request.input.expectedRoot, request.input.taskDir, request.input.linkId)
      case 'previewNotification': return service.previewNotification(request.input)
      case 'sendNotification': return service.sendNotification(request.input)
      case 'jiraContext': return service.currentJiraContext(request.input.expectedRoot)
      case 'jiraTransitions': return service.getJiraTransitions(request.input)
      case 'jiraTransition': return service.transitionJira(request.input)
      case 'jiraComment': return service.commentJira(request.input)
    }
  }
  return {
    async dispatch(raw, signal, actor) {
      const parsed = legacyIntegrationRequestSchema.safeParse(raw)
      if (!parsed.success) return ipcFail(IpcErrorCode.InvalidArg, '集成参数无效')
      const request = parsed.data
      if (closed) return ipcFail(IpcErrorCode.Unavailable, '后台集成正在关闭，请检查原请求的结果')
      // A root in a business payload is an expectation, never an authorization.
      const grant = 'expectedRoot' in request.input ? scope.capture(request.input.expectedRoot) : scope.current()
      if (grant) scope.assert(grant)
      // capture has verified the physical identity. Services must use that same
      // canonical root, including when the GUI opened it through an alias.
      if (grant && 'expectedRoot' in request.input) request.input.expectedRoot = grant.root
      if (signal?.aborted) return ipcFail(IpcErrorCode.Denied, '请求已取消或超时')
      try {
        const result = await execute(request, signal, actor)
        if (grant) scope.assert(grant)
        const data = legacyIntegrationResults[request.operation].safeParse(result)
        if (!data.success) return ipcFail(IpcErrorCode.Upstream, '集成返回数据无效，请检查原操作结果后重试')
        return { ok: true as const, data: data.data }
      } catch (error) {
        if (!(error instanceof IntegrationError)) throw error
        const code = error.kind === 'conflict' ? IpcErrorCode.Conflict : error.kind === 'denied' ? IpcErrorCode.Denied : error.kind === 'io' ? IpcErrorCode.Io : error.kind === 'upstream' || error.kind === 'uncertain' ? IpcErrorCode.Upstream : IpcErrorCode.InvalidArg
        return ipcFail(code, error.message)
      }
    },
    shutdown() {
      closed = true
      for (const controller of [...reads.values(), ...authorizations.values()]) controller.abort()
    }
  }
}
