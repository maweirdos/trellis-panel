import { join, relative, isAbsolute } from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, lstatSync, mkdirSync, realpathSync, readdirSync } from 'node:fs'
import { z } from 'zod'
import { watch, type FSWatcher } from 'chokidar'
import { runtimeBodies, runtimeRequests, RUNTIME_MUTATING_METHODS, type RuntimeMethod, type RuntimeRequest, type RuntimeResult, type RuntimeCursor, type RuntimeBodyMethod, type RuntimeWire } from '../../../shared/daemon-runtime'
import type { WorkspaceGrant } from '../../../shared/daemon'
import * as acp from '../../services/acp'
import { bindTaskSchema, configureSchema, newSessionSchema, promptOptionsSchema } from '../../services/acp/types'
import { checkRequirementPredecessor, getWorkflowApplication, workflowDesktopTemplates, isManagedWorkflowOrigin, withOrdinaryConnectionAdmission, withOrdinaryWorkflowAdmission, withManagedWorkflowAdmission, hasWorkflowApplications, countOwnedWorkflowApplications, shutdownWorkflowApplications, setWorkflowAdmissionClosed, assertNativePreparationAvailable } from '../../services/workflow-desktop'
import { installHostEventSink } from '../../services/bridge'
import { ipcFail, IpcErrorCode } from '../../../shared/ipc-errors'
import { DaemonError } from '../errors'
import { RuntimeBlobs } from './blobs'
import { RuntimeEvents, type RuntimeObservation } from './events'
import { RuntimeCommands } from './commands'
import { verifyMaterialChange } from '../../services/acp/materials'
import { canonicalDirectory } from '../../services/acp/metadata'
import { createRuntimeKnowledge } from './knowledge'
import { KNOWLEDGE_MUTATIONS, knowledgeRuntimeBody } from '../../../shared/daemon-runtime-knowledge'
import { CruxTaskProgressRuntime } from '../../services/crux/task-progress-runtime'
import { installWorkcopyUse, resolveWorkcopy } from '../../services/workcopy-use'
import { workcopyUseResultSchema, isBoundedWorkcopyCleanup } from '../../../shared/workcopy-use'
import type { WorkcopyOwner } from '../../../shared/workcopy-use'
import { requirementPredecessorSchema, requirementTaskOriginSchema } from '../../../shared/conversation-requirements'
import { runRefSchema } from '../../../shared/workflow'
import { readRegular } from '../../services/private-conversations/files'
import { utf8 } from '../../services/private-conversations/requirement-files'
import { prepareAcpRecovery } from '../../services/workcopy-use/acp-recovery'
import { recoverExactAcpWorkcopyUse, type WorkcopyRecoveryEvidence } from '../../services/workcopy-use/acp-recovery'
import { createHash } from 'node:crypto'
import { privateNativeRead, privateNativeSend, privateNativeControl, privateNativeSession } from '../../services/private-conversations/native'
import { withPrivateAcpOwner } from '../../services/acp/private-access'
import { configurePrivateNativeSession, recoverPrivateNativeModel } from '../../services/private-conversations/configuration'
import { processIdentity } from '../native'
import { WorkflowCutoverCoordinator } from '../../services/workflow-cutover/coordinator'
import { NativeTaskPreparation, type NativeTaskPreparationAuthority } from './task-preparation'
import { NativeTaskExecutions } from './task-execution'
import { BUILTINS } from '../../services/acp/runtime-definitions'
import { PI_VERSION } from '../../services/pi/protocol'
import { isBoundedNativeTaskControl } from '../../../shared/native-task-execution'
import { NativeTaskProgressSender, type TaskReadRecovery } from '../../services/crux/task-progress-sender'
import { DesktopTeamError, teamTransportFailureSchema } from '../../services/team-platform/types'
import { writeExclusiveAtomic } from '../files'
import { projectDaemonActivity, sessionActivity } from './activity'
import { LIFECYCLE_RUNTIME_CONTROLS, LIFECYCLE_SESSION_ADMISSIONS, type DaemonActivity } from '../../../shared/daemon/lifecycle'

export interface RuntimeDispatchContext { workspace?: WorkspaceGrant; commandId?: string; native?: Pick<NativeTaskPreparationAuthority, 'actor' | 'assertProduct'> }
export interface DaemonRuntimePorts {
  epoch: string
  directory: string
  userData?: string
  assertOwner(): void
  /** Main asserts its real completed settings/runtime cutover, not a synthetic drain. */
  assertAuthority(): void
  /** Temporary application admission; independent from permanent authority. */
  assertAdmission?(): void
  assertWorkspaceAdmission?(root: string, method: RuntimeBodyMethod): void
  assertWorkspaceGrant?(grant: WorkspaceGrant): void
}
export interface DaemonRuntime {
  activity(): DaemonActivity
  assertSessionsIdle(): void
  releaseWorkcopy(root: string, payload: RuntimeWire, commandId: string): Promise<RuntimeWire>
  dispatch<M extends RuntimeMethod>(method: M, payload: RuntimeRequest<M>, context: RuntimeDispatchContext): Promise<RuntimeResult<M>>
  status(): Promise<{ authority: 'legacy' | 'daemon'; admission: 'open' | 'closed'; sessions: number; workflows: number; operations: number; released: boolean; reason?: string }>
  blockers(): Promise<Array<{ domain: 'runtime' | 'workflow' | 'application' | 'work-copy'; state: 'active' | 'unknown'; label: string; rootId?: string; ownerGeneration?: string; acquiredAt?: number }>>
  recoverWorkcopy(input: { leaseId: string; owner: WorkcopyOwner; acceptedEvidence?: WorkcopyRecoveryEvidence }): Promise<{ released: boolean; evidence?: WorkcopyRecoveryEvidence; reason?: 'released' | 'already-released' | 'missing-evidence' }>
  assertIdle(): Promise<void>
  pack(root: string, value: unknown): RuntimeWire
  unpack(root: string, wire: RuntimeWire): unknown
  closeAdmission(): void
  ownsWorkspace(root: string): Promise<boolean>
  shutdown(): Promise<void>
  release(): Promise<void>
  observe(listener: (event: RuntimeObservation) => void): () => void
  catchUp(root: string, cursor: RuntimeCursor | null, limit: number): ReturnType<RuntimeEvents['catchUp']>
}

/** Reuses the actual ACP and workflow controllers. No GUI state or second native transport. */
export function createDaemonRuntime(ports: DaemonRuntimePorts): DaemonRuntime {
  const taskReads = new AsyncLocalStorage<TaskReadRecovery>()
  const recordTaskFailure = (method: string, commandId: string | undefined, error: unknown): void => {
    if (!commandId || !['runtime.taskPreparation', 'runtime.taskExecution'].includes(method)) return
    const transport = teamTransportFailureSchema.safeParse((error instanceof DesktopTeamError ? error.transport : undefined)
      ?? (error && typeof error === 'object' && 'taskTransport' in error ? error.taskTransport : undefined))
    if (!transport.success) return
    try {
      z.string().uuid().parse(commandId)
      const directory = join(realpathSync.native(ports.directory), 'runtime-task-failures')
      if (!existsSync(directory)) mkdirSync(directory)
      if (lstatSync(directory).isSymbolicLink() || realpathSync.native(directory) !== directory || readdirSync(directory).length >= 2000) return
      const file = join(directory, commandId + '.json')
      if (existsSync(file)) return
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'RUNTIME_FAILURE'
      writeExclusiveAtomic(file, JSON.stringify({ version: 1, epoch: ports.epoch, commandId, method, at: Date.now(),
        phase: error instanceof DesktopTeamError ? error.preparationPhase ?? 'task-read' : 'operation-guard',
        code: /^[A-Z0-9_:-]{1,100}$/.test(code) ? code : 'RUNTIME_FAILURE', transport: transport.data }))
    } catch { process.emitWarning('Task transport diagnostics could not be retained.', { code: 'TRELLIS_TASK_DIAGNOSTIC_UNAVAILABLE' }) }
  }
  const workcopies = installWorkcopyUse(ports.directory, ports.assertOwner)
  const processRecoveryReady = prepareAcpRecovery(ports.directory, workcopies).catch(() => {
    process.emitWarning('旧执行的 kernel 隔离见证暂不可用；原占用保留，未追认清理。', { code: 'TRELLIS_ACP_LEGACY_QUARANTINE' })
  })
  const blobs = new RuntimeBlobs(join(ports.directory, 'runtime-blobs'))
  const commands = new RuntimeCommands(join(ports.directory, 'runtime-commands'), ports.epoch, ports.assertOwner)
  const taskPreparation = new NativeTaskPreparation({ directory: ports.directory, teamDataDirectory: join(ports.userData ?? ports.directory, 'team-platform'), workcopies,
    assertOwner() { ports.assertOwner(); ports.assertAuthority(); ports.assertAdmission?.() },
    assertCurrent(grant) {
      if (!ports.assertWorkspaceGrant) throw new DaemonError('E_UNAVAILABLE', 'Native task preparation needs the retained workspace grant owner.')
      ports.assertWorkspaceGrant(grant)
      ports.assertWorkspaceAdmission?.(grant.root, 'runtime.taskPreparation')
      if (closed || released) throw new DaemonError('E_UNAVAILABLE', 'Native task preparation admission is closed.')
    },
    withTransport: async (pin, assertCurrent, action, task) => {
      const sender = new NativeTaskProgressSender(join(ports.userData ?? ports.directory, 'team-platform'), { workspaceKey: pin.workspaceKey,
        taskId: task.taskId, spaceId: task.spaceId, connectionId: pin.connectionId, origin: pin.origin, pairingId: pin.pairingId,
        ownerId: pin.actorId, deviceId: pin.deviceId, projectId: pin.projectId, epoch: pin.epoch, instanceId: pin.instanceId, handlerId: pin.actorId })
      return action(sender.executionRequest(task, assertCurrent, taskReads.getStore()))
    },
    assertLegacyAvailable: assertNativePreparationAvailable
  })
  const workflowCutover = new WorkflowCutoverCoordinator({ dataDir: join(ports.userData ?? ports.directory, 'team-platform'), accessDescriptorPath: join(ports.userData ?? ports.directory, 'access-endpoint.json'), workcopies, processIdentity,
    assertCurrent(authority) {
      ports.assertOwner(); ports.assertAuthority(); ports.assertWorkspaceGrant?.(authority.grant); authority.assertProduct()
      ports.assertWorkspaceAdmission?.(authority.grant.root, 'runtime.workflowCutover')
      if (released) throw new DaemonError('E_UNAVAILABLE', 'Native cutover authority is released')
    },
    assertLegacyAvailable: assertNativePreparationAvailable,
    withTransport: async (pin, assertCurrent, task, action) => {
      const sender = new NativeTaskProgressSender(join(ports.userData ?? ports.directory, 'team-platform'), { workspaceKey: pin.workspaceKey,
        taskId: task.taskId, spaceId: task.spaceId, connectionId: pin.connectionId, origin: pin.origin, pairingId: pin.pairingId,
        ownerId: pin.actorId, deviceId: pin.deviceId, projectId: pin.projectId, epoch: pin.epoch, instanceId: pin.instanceId, handlerId: pin.actorId })
      return action(sender.cutoverRequest(assertCurrent))
    }
  })
  const events = new RuntimeEvents(ports.epoch)
  const taskExecutions = new NativeTaskExecutions({ directory: ports.directory, workcopies, preparation: taskPreparation,
    assertOwner() { ports.assertOwner() },
    assertCurrent(grant) {
      if (closed || released) throw new DaemonError('E_UNAVAILABLE', 'Product execution admission is closed')
      ports.assertOwner(); ports.assertAuthority(); ports.assertWorkspaceGrant?.(grant)
      ports.assertWorkspaceAdmission?.(grant.root, 'runtime.taskExecution')
    } })
  const disposeEvents = installHostEventSink((channel, value) => events.publish(channel, value))
  let closed = false, released = false, stopping: Promise<void> | undefined
  taskExecutions.startBackground()
  let operations = 0, sessionAdmissions = 0
  const activity = (): DaemonActivity => {
    const snapshot = projectDaemonActivity(acp.listOwnedAcpSessionFacts(), operations + commands.count())
    return sessionAdmissions && snapshot.state === 'idle' ? { ...snapshot, state: 'interruptible' } : snapshot
  }
  const knowledge = createRuntimeKnowledge(() => !closed && !released)
  const taskProgress = new CruxTaskProgressRuntime(ports.directory, ports.userData ?? ports.directory, ports.assertOwner, () => { ports.assertOwner(); ports.assertAuthority() })
  const watchers = new Map<string, FSWatcher>()
  const materialTimers = new Map<string, ReturnType<typeof setTimeout>>()
  function observeWorkspace(root: string, generation: number): void {
    if (root === '@profile' || watchers.has(root) || closed) return
    if (watchers.size >= 100) throw new DaemonError('E_BUSY', 'Runtime workspace observer limit reached.')
    const watcher = watch(join(root, '.trellis'), { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 800 }, ignored: /[\\/]\.panel[\\/]|[\\/]\.runtime[\\/]/ })
    const changed = (path: string, event: 'add' | 'change' | 'unlink'): void => {
      if (closed) return
      try { ports.assertOwner(); ports.assertAuthority() }
      catch { closed = true; setWorkflowAdmissionClosed(true); return }
      acp.routeWatcherEvent(root, path, event)
      const key = `${root}:${path}`, previous = materialTimers.get(key)
      if (previous) clearTimeout(previous)
      if (!previous && materialTimers.size >= 1024) return
      materialTimers.set(key, setTimeout(() => {
        materialTimers.delete(key)
        void verifyMaterialChange(root, generation, path, event).then(material => { if (material && !closed) { ports.assertOwner(); acp.emitAcpMaterialChange(material) } }).catch(() => { /* The next source read still verifies actual bytes. */ })
      }, 800))
    }
    watcher.on('add', path => changed(path, 'add')).on('change', path => changed(path, 'change')).on('unlink', path => changed(path, 'unlink'))
    watcher.on('error', () => { /* An unavailable observer never claims verified filesystem events. */ })
    watchers.set(root, watcher)
  }
  const status: DaemonRuntime['status'] = async () => {
    await processRecoveryReady
    ports.assertOwner()
    let authority: 'legacy' | 'daemon' = 'daemon', reason: string | undefined
    try { ports.assertAuthority() } catch { authority = 'legacy'; reason = 'Runtime/settings authority preparation has not completed.' }
    return { authority, admission: closed || authority !== 'daemon' ? 'closed' : 'open', sessions: acp.listOwnedAcpSessionFacts().length, workflows: await countOwnedWorkflowApplications(), operations: commands.count(), released, ...(reason ? { reason } : {}) }
  }
  const blockers: DaemonRuntime['blockers'] = async () => {
    const owned = acp.listOwnedAcpSessionFacts().filter(session => sessionActivity(session) !== 'idle').map(session => ({
      domain: 'runtime' as const,
      state: sessionActivity(session) === 'uncertain'
        ? 'unknown' as const : 'active' as const,
      label: session.title?.trim().slice(0, 200) || '未命名会话',
      ownerGeneration: session.connectionGeneration ?? undefined
    }))
    const workflows = await countOwnedWorkflowApplications()
    return [
      ...owned,
      ...workflows > 0 ? [{ domain: 'workflow' as const, state: 'active' as const, label: `Owned workflows (${workflows})` }] : [],
      ...operations > 0 ? [{ domain: 'application' as const, state: 'active' as const, label: `Runtime operations (${operations})` }] : [],
      ...commands.count() > 0 ? [{ domain: 'application' as const, state: 'unknown' as const, label: 'Pending runtime command receipts' }] : [],
      ...taskProgress.busy() ? [{ domain: 'application' as const, state: 'active' as const, label: 'Task progress work' }] : [],
      ...taskExecutions.busy() ? [{ domain: 'application' as const, state: 'active' as const, label: 'Native task execution' }] : [],
      ...workcopies.agentLeases().map(({ token, ...use }) => ({
        domain: 'work-copy' as const,
        state: use.state === 'unknown' ? 'unknown' as const : 'active' as const,
        label: use.owner.label, rootId: use.identity.id, ownerGeneration: use.owner.generation, acquiredAt: use.acquiredAt,
        leaseId: createHash('sha256').update(token).digest('hex'), owner: structuredClone(use.owner)
      }))
    ].map(({ state, ...fact }) => ({ ...fact, state }))
  }
  const closeAdmission = (): void => { closed = true; setWorkflowAdmissionClosed(true); acp.closeAcpAdmission() }
  const shutdown = (): Promise<void> => {
    if (stopping) return stopping
    closeAdmission()
    knowledge.stopReads()
    stopping = (async () => {
      // Stop managed stages through their retained owners before canonical ACP cleanup.
      const results = await Promise.allSettled([
        taskExecutions.shutdown(), shutdownWorkflowApplications(),
      // Give ordinary turns their existing bounded cancellation first. Failure here
      // still requires canonical termination of these exact owned runtime handles.
        (async () => {
          await Promise.allSettled(acp.listOwnedAcpSessionFacts().filter(session => session.turnActive || session.accepting || session.pendingPermission)
            .map(session => acp.cancelAcpSession(session.projectRoot, session.sessionId)))
          await acp.shutdownAcp()
        })(),
        taskProgress.close(), commands.drain()
      ])
      for (const timer of materialTimers.values()) clearTimeout(timer)
      materialTimers.clear()
      await Promise.all([...watchers.values()].map(watcher => watcher.close())); watchers.clear()
      if (results.some(result => result.status === 'rejected')) throw new DaemonError('E_UNKNOWN', '部分执行清理未确认；所有清理领域均已尝试。', 'unknown')
      if (acp.listOwnedAcpSessionFacts().length || await hasWorkflowApplications() || workcopies.facts().length) throw new DaemonError('E_UNKNOWN', '原 Runtime 或本机应用仍有工作副本登记；实际清理未确认，后台所有权已保留。', 'unknown')
    })().catch(error => { stopping = undefined; throw error })
    return stopping
  }
  async function execute(method: RuntimeBodyMethod, raw: unknown, root: string, context: RuntimeDispatchContext): Promise<unknown> {
    if (method === 'runtime.taskExecution') {
      if (!context.native) throw new DaemonError('E_DENIED', 'Product execution needs authenticated native authority')
      const input = runtimeBodies[method].parse(raw)
      const grant = context.workspace ?? taskExecutions.retainedGrant(input.dispatchId)
      return taskExecutions.execute(root, input, { ...context.native, grant }, context.commandId)
    }
    if (!LIFECYCLE_RUNTIME_CONTROLS.includes(method)) {
      ports.assertAdmission?.()
      ports.assertWorkspaceAdmission?.(root, method)
    }
    const valid = (): boolean => { ports.assertOwner(); ports.assertAuthority(); ports.assertWorkspaceAdmission?.(root, method); return !closed }
    const connection = <T extends { ok: boolean }>(target: { sessionId?: string; profileId?: string }, action: () => Promise<T>) => withOrdinaryConnectionAdmission(root, target, action)
    switch (method) {
      case 'runtime.workflowCutover': {
        if (!context.native || !context.workspace) throw new DaemonError('E_DENIED', 'Workflow cutover requires a protected native process and authenticated directory grant')
        return workflowCutover.execute(root, runtimeBodies[method].parse(raw), { ...context.native, grant: context.workspace })
      }
      case 'runtime.taskExecutionPlan': {
        if (!context.native || !context.workspace) throw new DaemonError('E_DENIED', 'Product execution planning requires the native GUI and original workspace grant')
        context.native.assertProduct()
        const { engine } = runtimeBodies[method].parse(raw)
        const plan = await acp.preparePlatformAcpLaunch(root, engine)
        plan.assertCurrent()
        if (!plan.options.modelId) throw new DaemonError('E_UNAVAILABLE', 'Select an explicit model in the existing engine configuration before preparing')
        return { digest: plan.digest, adapterVersion: engine.agentId === 'pi' ? PI_VERSION : BUILTINS[engine.agentId].version,
          capabilities: [engine.agentId === 'pi' ? 'sdkContext' : 'embeddedContext'] }
      }
      case 'runtime.taskPreparation': {
        const input = runtimeBodies[method].parse(raw)
        if (!context.native || !context.workspace) throw new DaemonError('E_DENIED', 'Task preparation requires the authenticated native process and original workspace grant.')
        if (input.operation === 'prepare' && input.preparationId !== context.commandId) throw new DaemonError('E_CONFLICT', 'Preparation must retain its original runtime command UUID.')
        if (input.operation === 'database-delivery') return taskPreparation.captureDatabaseDelivery(root, input, { ...context.native, grant: context.workspace })
        return taskPreparation.execute(root, input, { ...context.native, grant: context.workspace })
      }
      case 'runtime.privateRead': {
        const input = runtimeBodies[method].parse(raw)
        return withPrivateAcpOwner(input, async () => {
        if (input.operation !== 'updates' && input.operation !== 'receipt') return privateNativeRead(input)
        const session = await privateNativeSession(input)
        if (!session.ok) return session
        if (input.operation === 'receipt') {
          if (!input.requestId) return ipcFail(IpcErrorCode.InvalidArg, '需要原消息身份')
          const receipt = commands.inspect('@profile', input.requestId)
          const request = session.session.privateConversation?.request
          return { ok: true, state: request?.id === input.requestId && request.sent ? 'sent' : receipt.state,
            ...(request?.id === input.requestId && request.sent ? { turnId: request.turnId } : {}), receipt, session: session.session }
        }
        const page = events.catchUp(input.root, input.after ?? null, 100)
        return { ok: true, ...page, events: page.events.filter(event => event.payload && typeof event.payload === 'object' && 'sessionId' in event.payload && event.payload.sessionId === input.sessionId), session: session.session }
        })
      }
      case 'runtime.privateSend': { const input = runtimeBodies[method].parse(raw); return withPrivateAcpOwner(input, () => privateNativeSend(input, valid)) }
      case 'runtime.privateConfigure': return configurePrivateNativeSession(raw, valid)
      case 'runtime.privateRecoverModel': return recoverPrivateNativeModel(raw, valid)
      case 'runtime.privateCancel': { const input = runtimeBodies[method].parse(raw); return withPrivateAcpOwner(input, () => privateNativeControl('cancel', input)) }
      case 'runtime.privateEnd': { const input = runtimeBodies[method].parse(raw); return withPrivateAcpOwner(input, () => privateNativeControl('end', input)) }
      case 'runtime.privateRespond': { const input = runtimeBodies[method].parse(raw); return withPrivateAcpOwner(input, () => privateNativeControl('respond', input)) }
      case 'runtime.workcopyUse': {
        if (root === '@profile') throw new DaemonError('E_DENIED', '工作副本登记需要原生工作区范围。')
        const input = runtimeBodies[method].parse(raw)
        if (input.operation === 'inspect') {
          const identity = resolveWorkcopy(root)
          return workcopyUseResultSchema.parse({ operation: 'inspect', identity, uses: workcopies.facts(identity) })
        }
        if (input.operation === 'assert') return workcopyUseResultSchema.parse({ operation: 'assert', identity: workcopies.assertHeld(root, input.token, input.owner) })
        if (input.operation === 'consumer-tasks') return workcopyUseResultSchema.parse({ operation: 'consumer-tasks', lease: workcopies.updateConsumerTasks(root, input.token, input.owner, input.expectedRevision, input.taskKeys) })
        if (input.owner.kind !== 'application' && input.owner.kind !== 'git') throw new DaemonError('E_DENIED', 'Agent 登记只能由原执行器生命周期持有。')
        if (input.operation === 'release') {
          const { operation: _operation, ...release } = input
          return workcopyUseResultSchema.parse({ operation: 'release', ...workcopies.release(release) })
        }
        if (!input.token) throw new DaemonError('E_DENIED', '准入需要原生所有者预先保留的私有登记凭据。')
        if (input.owner.kind === 'application' ? !['consumer', 'writer'].includes(input.kind) : !['tree-change', 'git-mutation', 'writer'].includes(input.kind)) throw new DaemonError('E_DENIED', '工作副本使用类别与原生调用者不一致。')
        return workcopyUseResultSchema.parse({ operation: 'acquire', lease: workcopies.acquire(root, { kind: input.kind, owner: input.owner, expected: input.expected, token: input.token }) })
      }
      case 'runtime.cruxProgress': {
        const input = runtimeBodies[method].parse(raw)
        if (closed && !['catalog', 'read', 'conversation', 'events', 'cancel', 'official'].includes(input.operation)) throw new DaemonError('E_UNAVAILABLE', 'Task execution admission is closed.')
        return taskProgress.execute(input)
      }
      case 'runtime.knowledge': return knowledge.execute(root, 0, raw)
      case 'runtime.sessions': {
        const result = acp.listAcpSessions(root, runtimeBodies[method].parse(raw).limit)
        // Session inventory is a projection. Full original bytes remain in historyEvents.
        return result.ok ? { ...result, sessions: result.sessions.map(session => ({ ...session, events: [] })) } : result
      }
      case 'runtime.agents': return acp.listAcpAgents(runtimeBodies[method].parse(raw).refresh)
      case 'runtime.setup': return acp.setupAcpRuntime(runtimeBodies[method].parse(raw).runtimeId)
      case 'runtime.probe': return acp.testAcpRuntimeConnection(runtimeBodies[method].parse(raw).runtimeId)
      case 'runtime.profiles': return acp.listAcpProfiles(root)
      case 'runtime.profileSave': return acp.saveAcpProfile(root, runtimeBodies[method].parse(raw).input)
      case 'runtime.profileDelete': return acp.deleteAcpProfile(root, runtimeBodies[method].parse(raw).profileId)
      case 'runtime.historyList': return acp.listAcpHistorySessions(root, runtimeBodies[method].parse(raw).input)
      case 'runtime.historySession': return acp.getAcpHistorySession(root, runtimeBodies[method].parse(raw).sessionId)
      case 'runtime.historyEvents': { const p = runtimeBodies[method].parse(raw); return acp.getAcpHistoryEvents(root, p.sessionId, p.input) }
      case 'runtime.piImage': { const p = runtimeBodies[method].parse(raw); return acp.getAcpPiImage(root, p.sessionId, p.imageId) }
      case 'runtime.historyUpdate': { const p = runtimeBodies[method].parse(raw); return acp.updateAcpHistorySession(root, p.sessionId, p.input, valid) }
      case 'runtime.historyDeletePreview': return acp.previewAcpHistoryDeletion(root, runtimeBodies[method].parse(raw).sessionId, valid)
      case 'runtime.historyDelete': { const p = runtimeBodies[method].parse(raw); return acp.deleteAcpHistorySession(root, p.sessionId, p.input.token, valid) }
      case 'runtime.historyRegenerateTitle': return acp.regenerateAcpHistoryTitle(root, runtimeBodies[method].parse(raw).sessionId, valid)
      case 'runtime.historyRetry': return acp.retryAcpHistorySession(root, runtimeBodies[method].parse(raw).sessionId)
      case 'runtime.handoffPreview': {
        const p = runtimeBodies[method].parse(raw)
        if (await isManagedWorkflowOrigin(root, p.sessionId, undefined, true)) return ipcFail(IpcErrorCode.Conflict, '请先停止托管工作流，再接续此会话')
        return acp.previewAcpSessionHandoff(root, p.sessionId, p.input, valid)
      }
      case 'runtime.handoffCreate': {
        const p = runtimeBodies[method].parse(raw)
        if (await isManagedWorkflowOrigin(root, p.sessionId, undefined, true)) return ipcFail(IpcErrorCode.Conflict, '请先停止托管工作流，再接续此会话')
        return connection({ sessionId: p.sessionId }, () => acp.createAcpSessionHandoff(root, p.sessionId, p.input, valid))
      }
      case 'runtime.handoffStatus': { const p = runtimeBodies[method].parse(raw); return acp.getAcpSessionHandoff(root, p.sessionId, p.operationId) }
      case 'runtime.handoffCancel': { const p = runtimeBodies[method].parse(raw); return acp.cancelAcpSessionHandoff(root, p.sessionId, p.input) }
      case 'runtime.new': {
        const p = runtimeBodies[method].parse(raw), input = z.object({ profileId: z.string().optional(), predecessor: requirementPredecessorSchema.optional(), predecessorRun: runRefSchema.optional() }).passthrough().parse(p.input)
        if (Boolean(input.predecessor) !== Boolean(input.predecessorRun)) throw new DaemonError('E_INVALID_ARG', '后继执行需要原任务与原运行的完整身份')
        return connection({ profileId: input.profileId }, async () => {
          const target = newSessionSchema.parse(p.input)
          if (target.taskDir) {
            const data = z.object({ meta: z.object({ conversationRequirement: z.unknown().optional() }).passthrough().nullish() }).passthrough().parse(JSON.parse(utf8(readRegular(root, `.trellis/tasks/${target.taskDir}/task.json`, 512 * 1024).bytes)))
            if (data.meta?.conversationRequirement !== undefined) {
              const original = requirementTaskOriginSchema.parse(data.meta.conversationRequirement)
              if (original.predecessor && (!input.predecessor || !input.predecessorRun || JSON.stringify(original.predecessor) !== JSON.stringify(input.predecessor))) throw new DaemonError('E_DENIED', '后继任务缺少经核验的原运行身份')
              if (!original.predecessor && input.predecessor) throw new DaemonError('E_DENIED', '原任务没有此后继身份')
            } else if (input.predecessor) throw new DaemonError('E_DENIED', '普通任务没有此后继身份')
          } else if (input.predecessor) throw new DaemonError('E_DENIED', '后继运行缺少目标任务')
          if (input.predecessor && input.predecessorRun) await checkRequirementPredecessor(root, input.predecessor, input.predecessorRun)
          return acp.newAcpSession(root, p.input)
        })
      }
      case 'runtime.prompt': {
        const p = runtimeBodies[method].parse(raw), options = p.options === undefined ? undefined : promptOptionsSchema.parse(p.options)
        return withOrdinaryWorkflowAdmission(root, p.sessionId, options?.expectedConnectionGeneration, admitted => acp.promptAcpSession(root, p.sessionId, p.text, options, () => valid() && admitted()))
      }
      case 'runtime.cancel': return acp.cancelAcpSession(root, runtimeBodies[method].parse(raw).sessionId)
      case 'runtime.end': {
        const p = runtimeBodies[method].parse(raw)
        if (await isManagedWorkflowOrigin(root, p.sessionId, undefined, true)) return ipcFail(IpcErrorCode.Conflict, '请先停止托管工作流，再结束关联会话')
        return acp.killAcpSession(root, p.sessionId)
      }
      case 'runtime.resume': { const p = runtimeBodies[method].parse(raw); return connection(p, () => acp.resumeAcpSession(root, p.sessionId)) }
      case 'runtime.configure': { const p = runtimeBodies[method].parse(raw); return connection(p, () => acp.configureAcpSession(root, p.sessionId, configureSchema.parse(p.input))) }
      case 'runtime.recover': { const p = runtimeBodies[method].parse(raw); return connection(p, () => acp.recoverAcpSessionModel(root, p.sessionId, p.input, valid)) }
      case 'runtime.bind': {
        const p = runtimeBodies[method].parse(raw)
        if (await isManagedWorkflowOrigin(root, p.sessionId, undefined, true)) return ipcFail(IpcErrorCode.Conflict, '请先停止托管工作流，再更改会话绑定')
        return acp.bindAcpSessionTask(root, p.sessionId, bindTaskSchema.parse(p.input), valid)
      }
      case 'runtime.permission': { const p = runtimeBodies[method].parse(raw); return acp.respondAcpPermission(root, p.requestId, p.optionId) }
      case 'runtime.watcher': { const p = runtimeBodies[method].parse(raw); acp.routeWatcherEvent(root, p.path, p.event); return null }
      case 'runtime.notify': acp.routeNotifyRail(root, runtimeBodies[method].parse(raw).text); return null
      case 'runtime.materialChange': {
        const p = z.object({ projectRoot: z.literal(root), relativePath: z.string().min(1).max(8192), kind: z.enum(['add', 'change', 'unlink']) }).passthrough().parse(runtimeBodies[method].parse(raw).material)
        acp.emitAcpMaterialChange(p as unknown as Parameters<typeof acp.emitAcpMaterialChange>[0]); return null
      }
      case 'runtime.timeline': {
        const p = z.object({ kind: z.enum(['session-status', 'diagnostic', 'material-change', 'jira-sync']), text: z.string().max(32000), payload: z.record(z.string(), z.unknown()).optional(), taskDir: z.string().max(200).optional() }).strict().parse(runtimeBodies[method].parse(raw).input)
        acp.emitTrellisTimeline(root, p.kind, p.text, p.payload, p.taskDir); return null
      }
      case 'runtime.workflow.templates': return workflowDesktopTemplates(root)
      case 'runtime.workflow.requirementPredecessor': { const p = runtimeBodies[method].parse(raw); return checkRequirementPredecessor(root, p.predecessor, p.expectedRun) }
      case 'runtime.workflow.isManagedOrigin': { const p = runtimeBodies[method].parse(raw); return isManagedWorkflowOrigin(root, p.sessionId, p.generation, p.associationOnly) }
      case 'runtime.events': {
        const p = runtimeBodies[method].parse(raw), page = events.catchUp(root, p.after, p.limit)
        if (!page.resetRequired) return { ...page, sessions: null }
        // Snapshot and tail capture are synchronous on this owner. A reset
        // snapshot supersedes ALL earlier deltas, including pages after an
        // oversized-event marker; never replay those older deltas over it.
        const result = acp.listAcpSessions(root, 100)
        return { cursor: events.cursor(), events: [], resetRequired: true, hasMore: false,
          sessions: result.ok ? { ...result, sessions: result.sessions.map(session => ({ ...session, events: [] })) } : result }
      }
    }
    // Explicit operations preserve the existing command/fence/material contracts.
    const application = await getWorkflowApplication(root)
    switch (method) {
      case 'runtime.workflow.preview': return application.preview(runtimeBodies[method].parse(raw))
      case 'runtime.workflow.start': { const p = runtimeBodies[method].parse(raw); return withManagedWorkflowAdmission(root, () => application.start(p), p) }
      case 'runtime.workflow.snapshot': return application.snapshot(runtimeBodies[method].parse(raw))
      case 'runtime.workflow.events': return application.events(runtimeBodies[method].parse(raw))
      case 'runtime.workflow.stop': return application.stop(runtimeBodies[method].parse(raw))
      case 'runtime.workflow.previewRevision': return application.previewRevision(runtimeBodies[method].parse(raw))
      case 'runtime.workflow.acceptRevision': return application.acceptRevision(runtimeBodies[method].parse(raw))
      case 'runtime.workflow.cancelRevision': return application.cancelRevision(runtimeBodies[method].parse(raw))
      case 'runtime.workflow.revisionStatus': return application.revisionStatus(runtimeBodies[method].parse(raw))
      case 'runtime.workflow.inspectWorkspaceRecovery': return application.inspectWorkspaceRecovery(runtimeBodies[method].parse(raw))
      case 'runtime.workflow.readArtifact': return application.readArtifact(runtimeBodies[method].parse(raw))
      case 'runtime.workflow.readRecoveryArtifact': return application.readRecoveryArtifact(runtimeBodies[method].parse(raw))
      case 'runtime.workflow.resolveMaterialOwner': return application.resolveMaterialOwner(runtimeBodies[method].parse(raw).relativePath)
      default: throw new DaemonError('E_INVALID_ARG', 'Unsupported runtime domain method.')
    }
  }
  return {
    status, blockers, closeAdmission, shutdown,
    activity,
    assertSessionsIdle() {
      ports.assertOwner()
      if (activity().state !== 'idle') {
        throw new DaemonError('E_BUSY', '会话已开始执行或状态不明，需要确认中断后重启。')
      }
    },
    recoverWorkcopy: input => recoverExactAcpWorkcopyUse(ports.directory, workcopies, input),
    async releaseWorkcopy(_root, payload, commandId) {
      ports.assertOwner()
      z.string().uuid().parse(commandId)
      if (!isBoundedWorkcopyCleanup('runtime.workcopyCleanup', payload) || !('inline' in payload)) throw new DaemonError('E_DENIED', '清理通道只接受有界原登记清理。')
      const input = runtimeBodies['runtime.workcopyCleanup'].parse(payload.inline)
      if (input.operation === 'consumer-read') return { inline: workcopyUseResultSchema.parse({ operation: 'consumer-read', lease: workcopies.readConsumerLease(input.root, input.token, input.owner, input.identityId) }) }
      if (input.operation === 'consumer-restrict') return { inline: workcopyUseResultSchema.parse({ operation: 'consumer-restrict', lease: workcopies.restrictConsumerTasks(input.root, input.token, input.owner, input.identityId, input.expectedRevision, input.taskKeys) }) }
      // The registry already publishes a synchronous durable transaction.
      // Cached command results must never resurrect a released/unknown lease.
      const { operation: _operation, ...release } = input
      return { inline: workcopyUseResultSchema.parse({ operation: 'release', ...workcopies.release(release) }) }
    },
    async assertIdle() {
      ports.assertOwner(); ports.assertAuthority()
      if (closed || released || stopping) throw new DaemonError('E_BUSY', 'Native runtime admission is already closed or release remains in progress.')
      const workflows = await countOwnedWorkflowApplications()
      ports.assertOwner(); ports.assertAuthority()
      const sessions = acp.listOwnedAcpSessionFacts()
      if (closed || released || stopping || operations || commands.count() || workflows || taskProgress.busy() || taskExecutions.busy() || workcopies.facts().length || sessions.some(session => sessionActivity(session) !== 'idle')) throw new DaemonError('E_BUSY', 'Original native sessions, preparation, workflow or unfinished operations still own background work.')
    },
    pack(root, value) { ports.assertOwner(); ports.assertAuthority(); return blobs.pack(root, value) },
    unpack(root, wire) { ports.assertOwner(); ports.assertAuthority(); return blobs.unpack(root, wire) },
    // A pending cross-project session may select this physical cwd after awaits.
    // Conservatively hold destructive grant changes until all pending effects settle.
    async ownsWorkspace(root) {
      const target = canonicalDirectory(root)
      const within = (path: string): boolean => { const delta = relative(target, canonicalDirectory(path)); return delta === '' || !isAbsolute(delta) && delta !== '..' && !delta.startsWith('../') && !delta.startsWith('..\\') }
      return taskExecutions.ownsWorkspace(root) || commands.count() > 0 || workcopies.facts(resolveWorkcopy(root)).length > 0 || acp.listOwnedAcpSessionFacts().some(session => within(session.projectRoot) || session.cwd !== null && within(session.cwd)) || await countOwnedWorkflowApplications() > 0
    },
    async release() { await shutdown(); ports.assertOwner(); if ((await status()).sessions || (await status()).workflows) throw new DaemonError('E_UNKNOWN', 'Runtime release has not been verified.', 'unknown'); released = true; disposeEvents() },
    observe: listener => events.observe(listener), catchUp: (root, cursor, limit) => events.catchUp(root, cursor, limit),
    async dispatch<M extends RuntimeMethod>(method: M, payload: RuntimeRequest<M>, context: RuntimeDispatchContext): Promise<RuntimeResult<M>> {
      if (['runtime.taskPreparation', 'runtime.taskExecution'].includes(method) && !taskReads.getStore())
        return taskReads.run({ retries: 0 }, () => this.dispatch(method, payload, context))
      ports.assertOwner()
      if (!isBoundedNativeTaskControl(method, payload) && !LIFECYCLE_RUNTIME_CONTROLS.includes(method)) ports.assertAdmission?.()
      operations++
      const sessionAdmission = LIFECYCLE_SESSION_ADMISSIONS.includes(method)
      if (sessionAdmission) sessionAdmissions++
      try {
        await processRecoveryReady
        if (!isBoundedNativeTaskControl(method, payload) && !LIFECYCLE_RUNTIME_CONTROLS.includes(method)) ports.assertAdmission?.()
        const parsed = runtimeRequests[method].parse(payload)
        if (method === 'runtime.status') return await status() as RuntimeResult<M>
        if (released) throw new DaemonError('E_UNAVAILABLE', 'Runtime authority was released.')
        ports.assertAuthority()
        const global = ['runtime.privateRead', 'runtime.privateSend', 'runtime.privateCancel', 'runtime.privateEnd', 'runtime.privateRespond', 'runtime.privateConfigure', 'runtime.privateRecoverModel', 'runtime.cruxProgress', 'runtime.agents', 'runtime.setup', 'runtime.probe', 'runtime.blob.open', 'runtime.blob.append', 'runtime.blob.seal', 'runtime.blob.read', 'runtime.blob.release', 'runtime.command'].includes(method)
        const taskControl = isBoundedNativeTaskControl(method, payload)
        const root = context.workspace?.root ?? (global || taskControl ? '@profile' : '')
        if (!root) throw new DaemonError('E_DENIED', 'Runtime operations require an authenticated workspace grant.')
        if (context.workspace && method !== 'runtime.workflowCutover' && method !== 'runtime.taskPreparation' && method !== 'runtime.taskExecution') observeWorkspace(root, context.workspace.revision)
        let value: unknown
        switch (method) {
          case 'runtime.command': {
            const commandId = runtimeRequests['runtime.command'].parse(parsed).commandId
            let productReceipt = false
            let preparationReceipt = false
            value = commands.inspect(root, commandId, originalMethod => {
              if (originalMethod === 'runtime.workflowCutover') workflowCutover.assertReceiptAuthority(root, commandId, context.native && context.workspace ? { ...context.native, grant: context.workspace } : undefined)
              if (originalMethod === 'runtime.taskPreparation') preparationReceipt = true
              if (originalMethod === 'runtime.taskExecution') {
                if (!context.native) throw new DaemonError('E_DENIED', 'Original product command requires native authority')
                productReceipt = true
              }
            })
            if (productReceipt && context.native) await taskExecutions.assertReceipt(root, commandId, context.native.assertProduct, context.native.actor)
            if (preparationReceipt) {
              const authority = context.native && context.workspace ? { ...context.native, grant: context.workspace } : undefined
              await taskPreparation.authorizeReceiptAuthority(root, commandId, authority)
              ports.assertOwner(); ports.assertAuthority()
              const current = commands.inspect(root, commandId, originalMethod => {
                if (originalMethod !== 'runtime.taskPreparation') throw new DaemonError('E_CONFLICT', 'Original preparation command method changed.')
                taskPreparation.assertReceiptAuthority(root, commandId, authority)
              })
              const completedDuringRead = value && typeof value === 'object' && 'state' in value
                && value.state === 'dispatching' && ['completed', 'unknown'].includes(current.state)
              if (!completedDuringRead && JSON.stringify(current) !== JSON.stringify(value)) throw new DaemonError('E_CONFLICT', 'Original preparation receipt changed during authorization.')
              value = current
            }
            break
          }
          case 'runtime.blob.open': value = blobs.open(root, runtimeRequests['runtime.blob.open'].parse(parsed)); break
          case 'runtime.blob.append': { const p = runtimeRequests['runtime.blob.append'].parse(parsed); value = blobs.append(root, p.id, p.offset, p.data); break }
          case 'runtime.blob.seal': value = blobs.seal(root, runtimeRequests['runtime.blob.seal'].parse(parsed).id); break
          case 'runtime.blob.read': { const p = runtimeRequests['runtime.blob.read'].parse(parsed); value = blobs.read(root, p.blob, p.offset); break }
          case 'runtime.blob.release': value = blobs.release(root, runtimeRequests['runtime.blob.release'].parse(parsed).id); break
          default: {
            const bodyMethod = method as RuntimeBodyMethod
            const raw = blobs.unpack(root, runtimeRequests[bodyMethod].parse(parsed))
            const validation = runtimeBodies[bodyMethod].safeParse(raw)
            if (!validation.success) throw new DaemonError('E_INVALID_ARG', 'Runtime method input is invalid; no operation was admitted.')
            const input = validation.data
            if (bodyMethod === 'runtime.taskExecution') {
              const native = context.native, request = runtimeBodies[bodyMethod].parse(input)
              if (!native) throw new DaemonError('E_DENIED', 'Product execution requires protected native authority')
              const grant = context.workspace ?? taskExecutions.retainedGrant(request.dispatchId)
              await taskExecutions.assertAuthority(root, request, { ...native, grant })
            }
            const cutover = bodyMethod === 'runtime.workflowCutover' ? runtimeBodies['runtime.workflowCutover'].parse(input) : undefined
            const cutoverAuthority = cutover && context.native && context.workspace ? { actor: structuredClone(context.native.actor), grant: structuredClone(context.workspace), assertProduct: context.native.assertProduct.bind(context.native) } : undefined
            if (cutover) {
              if (!cutoverAuthority || !context.commandId) throw new DaemonError('E_DENIED', 'Native workflow cutover requires protected process, grant and original command UUID')
              workflowCutover.authorizeCommand(root, context.commandId, cutover, cutoverAuthority)
            }
            const preparation = bodyMethod === 'runtime.taskPreparation' ? runtimeBodies['runtime.taskPreparation'].parse(input) : undefined
            const preparationAuthority = preparation && context.native && context.workspace ? {
              actor: structuredClone(context.native.actor), grant: structuredClone(context.workspace), assertProduct: context.native.assertProduct.bind(context.native)
            } : undefined
            if (preparation) {
              if (!preparationAuthority) throw new DaemonError('E_DENIED', 'Native preparation requires the authenticated process and workspace grant.')
              if (preparation.operation === 'database-delivery' && preparation.commandId !== context.commandId) throw new DaemonError('E_CONFLICT', 'Database capture must retain its original runtime command UUID.')
              if (preparation.operation === 'prepare' && preparation.preparationId !== context.commandId) throw new DaemonError('E_CONFLICT', 'Preparation must retain its original runtime command UUID.')
              await taskPreparation.authorizeAuthority(root, preparation, preparationAuthority)
            }
            const mutation = method === 'runtime.workflowCutover' ? cutover?.operation !== 'inspect' && cutover?.operation !== 'propose' : method === 'runtime.taskExecution' ? runtimeBodies['runtime.taskExecution'].parse(input).operation !== 'reconcile' : method === 'runtime.taskPreparation' ? ['prepare', 'database-delivery'].includes(runtimeBodies['runtime.taskPreparation'].parse(input).operation) : method === 'runtime.knowledge' ? KNOWLEDGE_MUTATIONS.includes(knowledgeRuntimeBody.parse(input).operation) : RUNTIME_MUTATING_METHODS.includes(method)
            if (closed && mutation && !taskControl && !['runtime.cancel', 'runtime.end', 'runtime.privateCancel', 'runtime.privateEnd', 'runtime.handoffCancel', 'runtime.workflow.stop', 'runtime.workflow.cancelRevision'].includes(method)) throw new DaemonError('E_UNAVAILABLE', 'Runtime admission is closed; original owners remain inspectable.')
            const action = async () => {
              try { return blobs.pack(root, await execute(bodyMethod, input, root, context)) }
              catch (error) {
                recordTaskFailure(bodyMethod, context.commandId, error)
                if (error instanceof DaemonError) throw error
                if (error instanceof z.ZodError) throw new DaemonError('E_INVALID_ARG', 'Runtime input violates the original facade contract.')
                const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
                const uncertain = !!error && typeof error === 'object' && 'outcomeUnknown' in error && error.outcomeUnknown === true
                const conflict = !uncertain && (code.startsWith('CUTOVER_') || ['E_CONFLICT', 'SCOPE_CHANGED', 'STALE_PREVIEW', 'REVISION_CONFLICT', 'COMMAND_PAYLOAD_CONFLICT', 'MATERIAL_CHANGED'].includes(code))
                throw new DaemonError(conflict ? 'E_CONFLICT' : code === 'INVALID_INPUT' ? 'E_INVALID_ARG' : code === 'CAPABILITY_UNAVAILABLE' ? 'E_UNAVAILABLE' : 'E_UNKNOWN', error instanceof Error ? error.message.slice(0, 400) : 'Runtime outcome requires inspection.', conflict || ['INVALID_INPUT', 'CAPABILITY_UNAVAILABLE'].includes(code) ? 'not-admitted' : 'unknown')
              }
            }
            if (mutation) {
              if (!context.commandId) throw new DaemonError('E_INVALID_ARG', 'Runtime mutations require a stable command ID.')
              value = method === 'runtime.workcopyUse' ? await action() : await commands.run(root, context.commandId, method, input, action,
                preparation?.operation === 'prepare' && preparationAuthority
                  ? () => taskPreparation.authorizeRecovery(root, preparation, preparationAuthority) : undefined)
            } else value = await action()
            // A concurrent duplicate may have joined the first process's pending
            // command before that process published its retained binding.
            if (cutover && cutoverAuthority && context.commandId) workflowCutover.assertReceiptAuthority(root, context.commandId, cutoverAuthority)
            if (preparation && preparationAuthority) {
              await taskPreparation.authorizeAuthority(root, preparation, preparationAuthority)
              if (preparation.operation === 'prepare') await taskPreparation.assertFreshCutover(root, preparation.preparationId, preparationAuthority)
            }
          }
        }
        return value as RuntimeResult<M>
      } catch (error) {
        recordTaskFailure(method, context.commandId, error)
        throw error
      } finally { operations--; if (sessionAdmission) sessionAdmissions-- }
    }
  }
}
