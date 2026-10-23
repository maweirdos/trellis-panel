import { randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { z } from 'zod'
import { JIRA_DAEMON, jiraRequests, jiraResults, type JiraIntegrationApi, type JiraMethod, type JiraRequest, type JiraData, type JiraResult } from '../../../shared/jira-integration'
import { GITLAB_DAEMON, gitlabRequests, gitlabResults, type GitlabInput, type GitlabOutput } from '../../../shared/gitlab-integration'
import { DINGTALK_DAEMON, dingtalkRequests, dingtalkResults, type DingInput, type DingOutput } from '../../../shared/dingtalk-integration'
import type { ProviderDaemonMethod } from '../../../shared/daemon-domains'
import { ipcFail, IpcErrorCode } from '../../../shared/ipc-errors'
import type { GitlabWorkspaceActions } from '../integrations/gitlab-workspace'
import type { DingTalkActions } from '../integrations/dingtalk-workspace'
import { DaemonError } from '../../daemon/errors'
import { isProviderReadMethod } from '../../../shared/provider-cancellation'
import { nativeDomainCall, nativeProviderReadCall } from './runtime'

/** GUI state is supplied by native composition, never by the renderer. */
export interface ProviderWorkspaceSelection {
  root(): string | null
  generation(): number
}

type CapturedScope = { root: string; isCurrent(): boolean }
function physicalRoot(root: string): string {
  if (!isAbsolute(root)) throw new DaemonError('E_INVALID_ARG', '工作区必须是绝对路径。')
  try {
    const physical = realpathSync(root)
    if (!statSync(physical).isDirectory()) throw new Error('Not a directory')
    return physical
  } catch { throw new DaemonError('E_CONFLICT', '当前工作区目录已不可用，请重新选择项目。') }
}
function sameRoot(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}
function capture(selection: ProviderWorkspaceSelection, expectedRoot: string | null): CapturedScope {
  // A null DingTalk scope deliberately addresses profile application/account state.
  if (expectedRoot === null) return { root: '', isCurrent: () => true }
  const selected = selection.root(), generation = selection.generation()
  if (!selected) throw new DaemonError('E_DENIED', '请先打开所选项目，再操作集成工作区。')
  const root = physicalRoot(selected)
  if (!sameRoot(root, physicalRoot(expectedRoot))) throw new DaemonError('E_CONFLICT', '所选集成工作区与当前项目不同，请刷新。')
  const isCurrent = (): boolean => {
    const current = selection.root()
    if (!current || selection.generation() !== generation) return false
    try { return sameRoot(root, physicalRoot(current)) } catch { return false }
  }
  if (!isCurrent()) throw new DaemonError('E_CONFLICT', '项目已改变，尚未接纳集成操作。')
  return { root, isCurrent }
}

/** Typed feature adapters share the existing authenticated/bounded blob transport.
 * Check current GUI ownership before that transport can create a workspace grant.
 * Only static transient methods receive backend signal control. Durable job
 * cancellation always uses its explicit feature method. */
function workspaceForwarder(selection: ProviderWorkspaceSelection) {
  const namespaceId = randomUUID()
  return async <I extends { expectedRoot: string | null }, O>(method: ProviderDaemonMethod, request: z.ZodType<I>, response: z.ZodType<O>, raw: I, signal?: AbortSignal): Promise<O> => {
    const parsed = request.safeParse(raw)
    if (!parsed.success) throw new DaemonError('E_INVALID_ARG', '集成请求参数无效。')
    const scope = capture(selection, parsed.data.expectedRoot)
    signal?.throwIfAborted()
    const commandId = 'commandId' in parsed.data && typeof parsed.data.commandId === 'string' ? parsed.data.commandId
      : 'requestId' in parsed.data && typeof parsed.data.requestId === 'string' ? parsed.data.requestId : undefined
    const body = { ...parsed.data, expectedRoot: scope.root || null }
    const result = signal && isProviderReadMethod(method)
      ? await nativeProviderReadCall<unknown>(scope.root, method, body, namespaceId, signal, commandId, scope.isCurrent)
      : await nativeDomainCall<unknown>(scope.root, method, body, commandId, () => !signal?.aborted && scope.isCurrent())
    const data = response.safeParse(result)
    if (!data.success) throw new DaemonError('E_UNKNOWN', '后台结果未满足集成契约，请读取原配置、作业或回执核实结果。', 'unknown')
    return data.data
  }
}

/** One facade per native sender. Read IDs are remapped so another sender cannot
 * cancel the daemon's shared Jira reader by guessing/reusing a renderer UUID. */
export function createJiraWorkspaceClient(selection: ProviderWorkspaceSelection, clientSignal: AbortSignal): JiraIntegrationApi {
  const forward = workspaceForwarder(selection)
  const reads = new Map<string, { expectedRoot: string; workspaceId?: string; root: string; nativeId: string; abort: AbortController }>()
  async function call<M extends JiraMethod>(method: M, raw: JiraRequest<M>): Promise<JiraResult<JiraData<M>>> {
    const parsed = jiraRequests[method].safeParse(raw)
    if (!parsed.success) return ipcFail(IpcErrorCode.InvalidArg, 'Jira 工作区请求参数无效。')
    const input = parsed.data as JiraRequest<M>
    try {
      const data = await forward(JIRA_DAEMON[method], jiraRequests[method] as z.ZodType<JiraRequest<M>>, jiraResults[method] as z.ZodType<JiraData<M>>, input, clientSignal)
      return { ok: true, data }
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? Object.values(IpcErrorCode).find(value => value === error.code) : undefined
      return ipcFail(code ?? IpcErrorCode.Unknown, error instanceof DaemonError ? error.message : 'Jira 后台结果未确认，请读取原作业记录后再决定下一步。', error && typeof error === 'object' && 'commandId' in error ? { commandId: error.commandId } : undefined)
    }
  }
  async function read<M extends 'projects' | 'discover' | 'previewApi' | 'previewCsv'>(method: M, raw: JiraRequest<M>): Promise<JiraResult<JiraData<M>>> {
    const parsed = jiraRequests[method].safeParse(raw)
    if (!parsed.success) return ipcFail(IpcErrorCode.InvalidArg, 'Jira 读取参数无效。')
    const input = parsed.data as JiraRequest<M>
    if (reads.has(input.requestId)) return ipcFail(IpcErrorCode.Conflict, '此 Jira 读取标识仍在使用中。')
    if (reads.size >= 4) return ipcFail(IpcErrorCode.Busy, '最多同时读取四个 Jira 请求。')
    let root: string
    try { root = capture(selection, input.expectedRoot).root }
    catch (error) { return ipcFail(error instanceof DaemonError ? error.code : IpcErrorCode.Conflict, 'Jira 来源项目已改变或不可用。') }
    const retained = { expectedRoot: input.expectedRoot, workspaceId: input.workspaceId, root, nativeId: randomUUID(), abort: new AbortController() }
    reads.set(input.requestId, retained)
    const cancel = (): void => {
      retained.abort.abort()
      // Cleanup keeps the admitted owner even if the GUI has since switched roots.
      void nativeDomainCall(root, JIRA_DAEMON.cancelRead, { expectedRoot: root, workspaceId: retained.workspaceId, requestId: retained.nativeId }).catch(() => {
        process.emitWarning('The original Jira transient read cancellation was not confirmed.', { code: 'TRELLIS_JIRA_CANCEL' })
      })
    }
    clientSignal.addEventListener('abort', cancel, { once: true })
    try {
      const data = await forward(JIRA_DAEMON[method], jiraRequests[method] as z.ZodType<JiraRequest<M>>, jiraResults[method] as z.ZodType<JiraData<M>>, { ...input, requestId: retained.nativeId }, AbortSignal.any([clientSignal, retained.abort.signal]))
      return { ok: true, data }
    } catch (error) {
      return ipcFail(error instanceof DaemonError ? error.code : IpcErrorCode.Unavailable, error instanceof DaemonError ? error.message : 'Jira 读取未完成，请重新读取。')
    } finally { reads.delete(input.requestId); clientSignal.removeEventListener('abort', cancel) }
  }
  return {
    version: 1,
    context: i => call('context', i), projects: i => read('projects', i), selectProject: i => call('selectProject', i),
    snapshot: i => call('snapshot', i), discover: i => read('discover', i), bindAccount: i => call('bindAccount', i),
    savePlan: i => call('savePlan', i), planState: i => call('planState', i), catchUp: i => call('catchUp', i),
    previewApi: i => read('previewApi', i), previewCsv: i => read('previewCsv', i), startImport: i => call('startImport', i),
    history: i => call('history', i), jobDetail: i => call('jobDetail', i), cancel: i => call('cancel', i),
    resume: i => call('resume', i), rollback: i => call('rollback', i), resolveConflict: i => call('resolveConflict', i),
    reconcile: i => call('reconcile', i), receiver: i => call('receiver', i), localTasks: i => call('localTasks', i),
    async cancelRead(raw) {
      const parsed = jiraRequests.cancelRead.safeParse(raw)
      if (!parsed.success) return ipcFail(IpcErrorCode.InvalidArg, '取消 Jira 读取参数无效。')
      const retained = reads.get(parsed.data.requestId)
      if (!retained || retained.expectedRoot !== parsed.data.expectedRoot || parsed.data.workspaceId !== undefined && retained.workspaceId !== parsed.data.workspaceId) return { ok: true, data: { cancelled: false } }
      retained.abort.abort()
      try {
        const data = jiraResults.cancelRead.parse(await nativeDomainCall(retained.root, JIRA_DAEMON.cancelRead, { ...parsed.data, expectedRoot: retained.root, requestId: retained.nativeId }))
        return { ok: true, data }
      } catch { return ipcFail(IpcErrorCode.Unavailable, '原 Jira 读取的后台取消尚未确认。') }
    }
  }
}

export function createGitlabWorkspaceClient(selection: ProviderWorkspaceSelection): GitlabWorkspaceActions {
  const forward = workspaceForwarder(selection)
  const call = <M extends keyof typeof GITLAB_DAEMON>(method: M, input: GitlabInput<M>, signal?: AbortSignal): Promise<GitlabOutput<M>> =>
    forward(GITLAB_DAEMON[method], gitlabRequests[method] as z.ZodType<GitlabInput<M>>, gitlabResults[method] as z.ZodType<GitlabOutput<M>>, input, signal)
  return {
    snapshot: (i, s) => call('snapshot', i, s), projects: (i, s) => call('projects', i, s), members: (i, s) => call('members', i, s), inspect: (i, s) => call('inspect', i, s),
    linkAccount: (i, s) => call('linkAccount', i, s), unlinkAccount: (i, s) => call('unlinkAccount', i, s), savePlan: (i, s) => call('savePlan', i, s), setPlanState: (i, s) => call('setPlanState', i, s),
    previewImport: (i, s) => call('previewImport', i, s), startImport: (i, s) => call('startImport', i, s), catchUp: (i, s) => call('catchUp', i, s), jobs: (i, s) => call('jobs', i, s),
    cancelJob: (i, s) => call('cancelJob', i, s), reconcileJob: (i, s) => call('reconcileJob', i, s), resolveConflict: (i, s) => call('resolveConflict', i, s), authorizeWrites: (i, s) => call('authorizeWrites', i, s),
    recoverHook: (i, s) => call('recoverHook', i, s), createIssue: (i, s) => call('createIssue', i, s), addComment: (i, s) => call('addComment', i, s), issueDetail: (i, s) => call('issueDetail', i, s), localTasks: (i, s) => call('localTasks', i, s)
  }
}

export function createDingTalkWorkspaceClient(selection: ProviderWorkspaceSelection): DingTalkActions {
  const forward = workspaceForwarder(selection)
  const call = <M extends keyof typeof DINGTALK_DAEMON>(method: M, input: DingInput<M>, signal?: AbortSignal): Promise<DingOutput<M>> =>
    forward(DINGTALK_DAEMON[method], dingtalkRequests[method] as z.ZodType<DingInput<M>>, dingtalkResults[method] as z.ZodType<DingOutput<M>>, input, signal)
  return {
    snapshot: (i, s) => call('snapshot', i, s), saveApp: (i, s) => call('saveApp', i, s), verifyApp: (i, s) => call('verifyApp', i, s), revokeApp: (i, s) => call('revokeApp', i, s),
    authorizeAccount: (i, s) => call('authorizeAccount', i, s), claimAccount: (i, s) => call('claimAccount', i, s), unlinkAccount: (i, s) => call('unlinkAccount', i, s),
    saveAssistant: (i, s) => call('saveAssistant', i, s), setAssistant: (i, s) => call('setAssistant', i, s), retryAssistant: (i, s) => call('retryAssistant', i, s),
    setNotifications: (i, s) => call('setNotifications', i, s), previewNotification: (i, s) => call('previewNotification', i, s), sendNotification: (i, s) => call('sendNotification', i, s),
    deliveries: (i, s) => call('deliveries', i, s), reconcileDelivery: (i, s) => call('reconcileDelivery', i, s), inbox: (i, s) => call('inbox', i, s),
    execute: (i, s) => call('execute', i, s), queryExecution: (i, s) => call('queryExecution', i, s), cancelExecution: (i, s) => call('cancelExecution', i, s)
  }
}
