import type { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { GITLAB_IPC, gitlabRequests, gitlabResults, type GitlabInput, type GitlabMethod, type GitlabOutput } from '../../shared/gitlab-integration'
import { ipcFail, IpcErrorCode } from '../../shared/ipc-errors'
import { IntegrationError } from '../services/integrations/types'
import { DaemonError } from '../daemon/errors'
import type { GitlabWorkspaceActions } from '../services/integrations/gitlab-workspace'
import { handle } from './registry'

/** The action facade must forward to the authenticated daemon owner. Central main
 * declares GITLAB_IPC constants first; this module never bypasses the registry. */
export function registerGitlabIntegrationIpc(actions: GitlabWorkspaceActions, isAllowed: (event: Electron.IpcMainInvokeEvent) => boolean): void {
  const active = new Map<string, AbortController>()
  function register<M extends Exclude<GitlabMethod, 'cancelAuthorization' | 'cancelRead'>>(method: M, action: (input: GitlabInput<M>, signal?: AbortSignal) => Promise<GitlabOutput<M>>) {
    handle(GITLAB_IPC[method], async (event, raw: unknown) => {
      if (!isAllowed(event)) return ipcFail(IpcErrorCode.Denied, 'GitLab 工作区仅允许原生主窗口访问。')
      const parsed = (gitlabRequests[method] as z.ZodType<GitlabInput<M>>).safeParse(raw)
      if (!parsed.success) return ipcFail(IpcErrorCode.InvalidArg, parsed.error.issues[0]?.message ?? 'GitLab 参数无效')
      const authorization = method === 'authorizeWrites', requestId = authorization ? (parsed.data as GitlabInput<'authorizeWrites'>).requestId : undefined
      const groupId = (parsed.data as GitlabInput<'snapshot'>).requestId
      const key = `${event.sender.id}:read:${groupId ?? randomUUID()}:${randomUUID()}`
      if (authorization && [...active.keys()].some((k) => k.includes(':auth:'))) return ipcFail(IpcErrorCode.Busy, '已有 GitLab 授权进行中')
      const controller = new AbortController(), storedKey = authorization ? `${event.sender.id}:auth:${requestId}` : key
      if ([...active.keys()].filter((k) => k.startsWith(`${event.sender.id}:`)).length >= 4) return ipcFail(IpcErrorCode.Busy, 'GitLab 请求过多，请等待当前请求完成')
      active.set(storedKey, controller)
      const destroyed = () => controller.abort()
      event.sender.once('destroyed', destroyed)
      try {
        const data = await action(parsed.data, AbortSignal.any([controller.signal, AbortSignal.timeout(authorization ? 300000 : 120000)]))
        const validated = gitlabResults[method].parse(data)
        if (Buffer.byteLength(JSON.stringify(validated)) > 220000) return ipcFail(IpcErrorCode.Unavailable, 'GitLab 返回的数据超过单页容量，请缩小范围')
        return { ok: true as const, data: validated }
      } catch (error) {
        const kind = error instanceof IntegrationError ? error.kind : null
        const nativeCode = error && typeof error === 'object' && 'code' in error ? Object.values(IpcErrorCode).find((code) => code === error.code) : undefined
        return ipcFail(nativeCode ?? (kind === 'conflict' ? IpcErrorCode.Conflict : kind === 'denied' ? IpcErrorCode.Denied : kind === 'invalid' ? IpcErrorCode.InvalidArg : kind === 'io' ? IpcErrorCode.Io : kind === 'uncertain' ? IpcErrorCode.Unknown : IpcErrorCode.Upstream), error instanceof IntegrationError || error instanceof DaemonError ? error.message : 'GitLab 后台操作不可用，请检查后台服务、连接及原作业记录')
      } finally { active.delete(storedKey); if (!event.sender.isDestroyed()) event.sender.removeListener('destroyed', destroyed) }
    })
  }
  register('snapshot', actions.snapshot); register('projects', actions.projects); register('members', actions.members); register('inspect', actions.inspect)
  register('linkAccount', actions.linkAccount); register('unlinkAccount', actions.unlinkAccount); register('savePlan', actions.savePlan); register('setPlanState', actions.setPlanState)
  register('previewImport', actions.previewImport); register('startImport', actions.startImport); register('catchUp', actions.catchUp); register('jobs', actions.jobs)
  register('cancelJob', actions.cancelJob); register('reconcileJob', actions.reconcileJob); register('resolveConflict', actions.resolveConflict); register('authorizeWrites', actions.authorizeWrites)
  register('recoverHook', actions.recoverHook); register('createIssue', actions.createIssue); register('addComment', actions.addComment); register('issueDetail', actions.issueDetail); register('localTasks', actions.localTasks)
  handle(GITLAB_IPC.cancelAuthorization, (event, raw: unknown) => { if (!isAllowed(event)) return ipcFail(IpcErrorCode.Denied, 'GitLab 工作区仅允许原生主窗口访问。'); const parsed = gitlabRequests.cancelAuthorization.safeParse(raw); if (!parsed.success) return ipcFail(IpcErrorCode.InvalidArg, '取消授权参数无效'); active.get(`${event.sender.id}:auth:${parsed.data.requestId}`)?.abort(); return { ok: true as const, data: null } })
  handle(GITLAB_IPC.cancelRead, (event, raw: unknown) => { if (!isAllowed(event)) return ipcFail(IpcErrorCode.Denied, 'GitLab 工作区仅允许原生主窗口访问。'); const parsed = gitlabRequests.cancelRead.safeParse(raw); if (!parsed.success) return ipcFail(IpcErrorCode.InvalidArg, '取消读取参数无效'); for (const [key, controller] of active) if (key.startsWith(`${event.sender.id}:read:${parsed.data.requestId}:`)) controller.abort(); return { ok: true as const, data: null } })
}
