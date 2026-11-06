import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { HifoxPendingCommand, HifoxSnapshot } from '../../../shared/hifox'
import type { HifoxMutationName } from '../../../shared/hifox-domain/commands'
import type { HifoxWorkspaceContext } from '../../../shared/hifox-remote'
import { ipcEvent } from '../../../shared/ipc-channels'
import type { DesktopTeamService } from '../team-platform/service'
import { HifoxRemoteClient, HifoxRemoteClientError, type HifoxRemoteView } from './remote'
import { loadSnapshot, mutate, onLocalHifoxAuthorityChanged, resetDemoSnapshot } from './store'
import { executeHifoxDomain } from '../../../shared/hifox-domain/commands'
import type { TeamGitlabOwnerBinding, TeamGitlabConnectionStatus } from '../integrations/team-gitlab'
import type { VerifiedGitlabIdentity } from '../integrations/types'

export type HifoxConnectionServiceDependencies = {
  withService: <T>(work: (service: DesktopTeamService) => Promise<T>) => Promise<T>
  notify: (channel: typeof ipcEvent.hifoxWorkspaceChanged | typeof ipcEvent.integrationsChanged, payload: HifoxWorkspaceContext | undefined) => void
  ensureGitlab?: (identity: VerifiedGitlabIdentity, owner: TeamGitlabOwnerBinding, signal: AbortSignal) => Promise<TeamGitlabConnectionStatus>
}
let dependencies: HifoxConnectionServiceDependencies | null = null
export function configureHifoxConnectionService(value: HifoxConnectionServiceDependencies): void {
  if (dependencies || client || stopped) throw new Error('团队协作运行时只能在初始化前配置一次')
  dependencies = Object.freeze({ ...value })
}
function withService<T>(work: (service: DesktopTeamService) => Promise<T>): Promise<T> {
  if (!dependencies) throw new HifoxRemoteClientError('SERVICE_UNCONFIGURED', '团队协作远端服务尚未配置')
  return dependencies.withService(work)
}

let client: Promise<HifoxRemoteClient> | null = null
let stopped = false
let selectionError: HifoxRemoteClientError | null = null
let workspaceGeneration = 0
/** Monotonic native source and local-authority fence, including A → B → A. */
export function hifoxWorkspaceGeneration(): number { return workspaceGeneration }
let workspaceSelection: number | null = null
let localSourceSelected = false
/** An in-flight selection is not a stable source for new whiteboard operations. */
export function hifoxStableWorkspaceGeneration(): number { return workspaceSelection === null ? workspaceGeneration : NaN }
let lastContext = ''
let gitlabGeneration = 0
let gitlabAuthorization: AbortController | null = null
type WorkspaceView = { snapshot: HifoxSnapshot; context: HifoxWorkspaceContext; taskId?: string }
const directory = (): string => join(app.getPath('userData'), 'hifox-remote')
const selectionFile = (): string => join(directory(), 'selection.json')
const localContext = (): HifoxWorkspaceContext => ({ key: 'local', connectionId: null, projectId: null, projectName: null, actorId: loadSnapshot().members.find((member) => member.role === 'owner')?.id ?? null, canManage: true, revision: 0, state: 'local', pendingCount: 0, authorizationRevision: workspaceGeneration })
onLocalHifoxAuthorityChanged(() => {
  workspaceGeneration++
  if (!stopped && (localSourceSelected || (!client && !existsSync(selectionFile())))) dependencies?.notify(ipcEvent.hifoxWorkspaceChanged, localContext())
})

async function instance(restoreSelection = true): Promise<HifoxRemoteClient> {
  if (stopped) throw new HifoxRemoteClientError('SERVICE_CLOSED', '团队协作服务正在退出')
  if (!client) {
    client = (async () => {
      const value = new HifoxRemoteClient({ dataDir: app.getPath('userData'), withService: (work) => withService((service) => work(service)), onChanged: (context, viewFingerprint) => {
        localSourceSelected = context.state === 'local'
        const fingerprint = JSON.stringify([context, viewFingerprint ?? null])
        if (fingerprint === lastContext) return
        lastContext = fingerprint
        dependencies?.notify(ipcEvent.hifoxWorkspaceChanged, context.state === 'local' ? localContext() : context)
      } })
      const file = selectionFile()
      if (existsSync(file)) {
        try {
          const selection = z.object({ connectionId: z.string().uuid().nullable() }).strict().parse(JSON.parse(readFileSync(file, 'utf8')))
          if (selection.connectionId) await value.select(selection.connectionId)
        } catch {
          selectionError = new HifoxRemoteClientError('SELECTION_UNAVAILABLE', '团队协作选源记录无法恢复，原文件已保留，请明确选择工作区。')
        }
      }
      return value
    })()
  }
  const value = await client
  if (stopped) throw new HifoxRemoteClientError('SERVICE_CLOSED', '团队协作服务正在退出')
  if (restoreSelection && selectionError) throw selectionError
  return value
}

function materialize(view: HifoxRemoteView): WorkspaceView {
  if (view.context.state === 'local') return { snapshot: loadSnapshot(), context: localContext() }
  if (!view.snapshot) throw new HifoxRemoteClientError(view.context.state === 'access-revoked' ? 'ACCESS_LOCKED' : 'NETWORK_UNAVAILABLE', view.context.state === 'access-revoked' ? '共享空间访问已失效，请重新登录核对，或返回本机工作区。' : '共享空间尚未取得可用数据，请检查团队服务连接，或返回本机工作区。', false, false, view.context)
  return { snapshot: view.snapshot, context: view.context }
}

export async function hifoxWorkspaceStatus(): Promise<HifoxWorkspaceContext> {
  if (stopped) throw new HifoxRemoteClientError('SERVICE_CLOSED', '团队协作服务正在退出')
  const context = client || existsSync(selectionFile()) ? (await instance()).status() : localContext()
  localSourceSelected = context.state === 'local'
  return context.state === 'local' ? localContext() : context
}
export async function hifoxWorkspaceSnapshot(): Promise<WorkspaceView> {
  if (stopped) throw new HifoxRemoteClientError('SERVICE_CLOSED', '团队协作服务正在退出')
  if (!client && !existsSync(selectionFile())) return { snapshot: loadSnapshot(), context: localContext() }
  const value = await instance()
  return materialize(await value.refresh())
}

/** Current source projection; background consumers do not trigger remote refreshes. */
export async function hifoxWorkspaceCurrentView(): Promise<WorkspaceView> {
  if (stopped) throw new HifoxRemoteClientError('SERVICE_CLOSED', '团队协作服务正在退出')
  if (!client && !existsSync(selectionFile())) {
    if (!existsSync(join(app.getPath('userData'), 'hifox', 'store.json'))) throw new HifoxRemoteClientError('SOURCE_UNAVAILABLE', '本机尚无协作数据')
    return { snapshot: loadSnapshot(), context: localContext() }
  }
  return materialize((await instance()).snapshot())
}
export async function selectHifoxWorkspace(connectionId: string | null): Promise<WorkspaceView> {
  const parsed = z.string().uuid().nullable().parse(connectionId)
  const generation = ++workspaceGeneration
  workspaceSelection = generation
  gitlabAuthorization?.abort(); gitlabAuthorization = null; gitlabGeneration++
  try {
    const value = await instance(false)
    if (generation !== workspaceGeneration) throw new HifoxRemoteClientError('SCOPE_CHANGED', '协作空间选择已改变')
    const previous = value.status().connectionId
    let result: WorkspaceView
    try {
      result = materialize(await value.select(parsed))
      if (generation !== workspaceGeneration || stopped) throw new HifoxRemoteClientError('SCOPE_CHANGED', '协作空间选择已改变')
      mkdirSync(directory(), { recursive: true })
      const file = selectionFile(), temporary = `${file}.tmp`
      writeFileSync(temporary, JSON.stringify({ connectionId: parsed }), { encoding: 'utf8', mode: 0o600 })
      renameSync(temporary, file)
    } catch (error) {
      if (!stopped && generation === workspaceGeneration && value.status().connectionId !== previous) await value.select(previous)
      if (error instanceof HifoxRemoteClientError) {
        const context = value.status()
        throw new HifoxRemoteClientError(error.code, error.message, error.outcomeUnknown, error.pending, context.state === 'local' ? localContext() : context)
      }
      throw error
    }
    selectionError = null
    if (result.context.state === 'connected') void connectOptionalGitlab(result.context)
    return result
  } finally { if (workspaceSelection === generation) workspaceSelection = null }
}

/** Only a verified optional GitLab identity can initiate its separate native grant. */
async function connectOptionalGitlab(context: HifoxWorkspaceContext): Promise<void> {
  const ensureGitlab = dependencies?.ensureGitlab
  if (!context.connectionId || stopped || !ensureGitlab) return
  const controller = new AbortController(), generation = ++gitlabGeneration
  gitlabAuthorization = controller
  try {
    const connectionId = context.connectionId
    const identity = await withService((service) => service.gitlabIdentity(connectionId))
    const connection = (await withService((service) => service.connections())).find((entry) => entry.connectionId === connectionId)
    if (controller.signal.aborted || !connection?.ownerId || !connection.projectId || connection.ownerId !== context.actorId || connection.projectId !== context.projectId || connection.origin !== context.origin) return
    const assertCurrent = async (): Promise<void> => {
      const selected = await instance()
      if (controller.signal.aborted || stopped || generation !== gitlabGeneration || selected.status().key !== context.key) throw new Error('团队登录绑定已改变')
      const current = await withService((service) => service.connectionContext(connectionId))
      const verified = await withService((service) => service.gitlabIdentity(connectionId))
      const latest = (await withService((service) => service.connections())).find((entry) => entry.connectionId === connectionId)
      const currentSelection = await instance()
      if (controller.signal.aborted || stopped || generation !== gitlabGeneration || currentSelection.status().key !== context.key || latest?.state !== 'active' || latest.accessLocked || latest.origin !== connection.origin || latest.deviceId !== connection.deviceId || latest.pairingId !== connection.pairingId || latest.ownerId !== connection.ownerId || latest.projectId !== connection.projectId || current.person.userId !== connection.ownerId || current.project.projectId !== connection.projectId || verified.issuer !== identity.issuer || verified.subject !== identity.subject || verified.baseUrl !== identity.baseUrl || verified.clientId !== identity.clientId) throw new Error('GitLab 与当前团队登录身份不一致')
    }
    const result = await ensureGitlab(identity, { connectionId, origin: connection.origin, ownerId: connection.ownerId, deviceId: connection.deviceId, projectId: connection.projectId, clientRevision: generation, assertCurrent }, controller.signal)
    if (!controller.signal.aborted && result.state === 'connected') dependencies?.notify(ipcEvent.integrationsChanged, undefined)
  } catch {
    // Ordinary local accounts and missing optional GitLab setup never block collaboration.
  } finally { if (gitlabAuthorization === controller) gitlabAuthorization = null }
}
export async function executeHifoxWorkspace(operation: HifoxMutationName, input: unknown, expectedScopeKey = 'local'): Promise<WorkspaceView> {
  const generation = workspaceGeneration
  const context = await hifoxWorkspaceStatus()
  if (stopped || workspaceSelection !== null || generation !== workspaceGeneration || context.key !== expectedScopeKey) throw new HifoxRemoteClientError('SCOPE_CHANGED', '协作空间已切换，请在原空间核对这项操作。', false, false, context)
  if (context.state === 'local') {
    const committed = mutate((draft) => {
      const result = executeHifoxDomain(draft, operation, input, context.actorId ?? undefined)
      Object.assign(draft, result.snapshot)
      return result.taskId
    })
    return { snapshot: committed.snapshot, context: localContext(), ...(committed.result ? { taskId: committed.result } : {}) }
  }
  const value = await instance()
  if (generation !== workspaceGeneration) throw new HifoxRemoteClientError('SCOPE_CHANGED', '协作空间已切换，请在原空间核对这项操作。', false, false, value.status())
  return value.execute(operation, input, expectedScopeKey)
}
export async function resetHifoxWorkspace(expectedScopeKey: string): Promise<WorkspaceView> {
  const generation = workspaceGeneration, context = await hifoxWorkspaceStatus()
  if (stopped || workspaceSelection !== null || generation !== workspaceGeneration || context.state !== 'local' || expectedScopeKey !== 'local') throw new HifoxRemoteClientError('SCOPE_CHANGED', '共享空间不能重置为示例数据。', false, false, context)
  return { snapshot: resetDemoSnapshot(), context: localContext() }
}
export async function pendingHifoxWorkspace(expectedScopeKey = 'local'): Promise<HifoxPendingCommand[]> {
  const generation = workspaceGeneration
  const context = await hifoxWorkspaceStatus()
  if (generation !== workspaceGeneration || context.key !== expectedScopeKey) throw new HifoxRemoteClientError('SCOPE_CHANGED', '协作空间已切换，请核对原操作。', false, false, context)
  if (!client) return []
  // No asynchronous boundary may separate this final scope check from reading the pending row.
  const value = await instance()
  if (generation !== workspaceGeneration || value.status().key !== expectedScopeKey) throw new HifoxRemoteClientError('SCOPE_CHANGED', '协作空间已切换，请核对原操作。', false, false, value.status())
  return value.pending().map((entry) => ({ commandId: entry.commandId, operation: entry.command.operation, state: entry.state, outcomeUnknown: entry.outcomeUnknown, errorCode: entry.errorCode, createdAt: entry.createdAt }))
}
export async function retryHifoxWorkspace(commandId: string, scopeKey: string): Promise<WorkspaceView> {
  const generation = workspaceGeneration, value = await instance()
  if (generation !== workspaceGeneration) throw new HifoxRemoteClientError('SCOPE_CHANGED', '协作空间已切换，请核对原命令。', false, false, value.status())
  return value.retry(z.string().uuid().parse(commandId), scopeKey)
}
export async function discardHifoxWorkspace(commandId: string, scopeKey: string): Promise<HifoxWorkspaceContext> {
  const generation = workspaceGeneration, value = await instance()
  if (generation !== workspaceGeneration) throw new HifoxRemoteClientError('SCOPE_CHANGED', '协作空间已切换，请核对原命令。', false, false, value.status())
  if (!value.pending().some((entry) => entry.commandId === commandId && entry.scopeKey === scopeKey)) throw new Error('待处理操作不属于当前共享空间。')
  return value.discardPending(scopeKey)
}
export function resumeHifoxWorkspace(): void { if (existsSync(selectionFile())) void instance().then((value) => { if (value.status().state === 'connected') void connectOptionalGitlab(value.status()) }).catch((error: unknown) => console.warn('团队协作连接恢复失败', error instanceof Error ? error.message : '恢复失败')) }
export async function closeHifoxWorkspace(): Promise<void> { stopped = true; gitlabAuthorization?.abort(); gitlabGeneration++; if (client) await (await client).close() }
