import { join } from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, realpathSync, readdirSync } from 'node:fs'
import { z } from 'zod'
import { watch, type FSWatcher } from 'chokidar'
import { CONVERSATION_RUNTIME_METHODS, runtimeBodies, runtimeRequests, type RuntimeMethod, type RuntimeRequest, type RuntimeResult, type RuntimeCursor, type RuntimeBodyMethod, type RuntimeWire } from '../../../shared/daemon-runtime'
import type { WorkspaceGrant } from '../../../shared/daemon'
import * as acp from '../../services/acp'
import { installHostEventSink } from '../../services/bridge'
import { ipcFail, IpcErrorCode } from '../../../shared/ipc-errors'
import { DaemonError } from '../errors'
import { RuntimeBlobs } from './blobs'
import { RuntimeEvents, type RuntimeObservation } from './events'
import { RuntimeCommands } from './commands'
import { verifyMaterialChange } from '../../services/acp/materials'
import { canonicalDirectory } from '../../services/acp/metadata'
import { createRuntimeKnowledge } from './knowledge'
import { CruxTaskProgressRuntime } from '../../services/crux/task-progress-runtime'
import { installWorkcopyUse, resolveWorkcopy } from '../../services/workcopy-use'
import { workcopyUseResultSchema, isBoundedWorkcopyCleanup } from '../../../shared/workcopy-use'
import type { WorkcopyOwner } from '../../../shared/workcopy-use'
import { prepareAcpRecovery } from '../../services/workcopy-use/acp-recovery'
import { recoverExactAcpWorkcopyUse, type WorkcopyRecoveryEvidence } from '../../services/workcopy-use/acp-recovery'
import { privateNativeRead, privateNativeSend, privateNativeControl, privateNativeSession } from '../../services/private-conversations/native'
import { withPrivateAcpOwner } from '../../services/acp/private-access'
import { configurePrivateNativeSession, recoverPrivateNativeModel } from '../../services/private-conversations/configuration'
import { processIdentity } from '../native'
import { WorkflowCutoverCoordinator } from '../../services/workflow-cutover/coordinator'
import { NativeTaskPreparation } from './task-preparation'
import { NativeTaskExecutions } from './task-execution'
import { BUILTINS } from '../../services/acp/runtime-definitions'
import { isBoundedNativeTaskControl } from '../../../shared/native-task-execution'
import { NativeTaskProgressSender, type TaskReadRecovery } from '../../services/crux/task-progress-sender'
import { DesktopTeamError, teamTransportFailureSchema } from '../../services/team-platform/types'
import { writeExclusiveAtomic } from '../files'
import type { DaemonActivity } from '../../../shared/daemon/lifecycle'
import { assertNativePreparationAvailable, countOwnedWorkflowApplications, hasWorkflowApplications, setWorkflowAdmissionClosed, shutdownWorkflowApplications } from '../../services/workflow-desktop'
import { PI_VERSION } from '../../services/pi/protocol'
import { AcpConversationProjectionService } from '../../services/acp/control-plane-service'
import { AdmissionService, isGlobalRuntimeMethod, type RuntimeDispatchContext } from './admission'
import { ConversationReadService } from './conversation-read'
import { RuntimeSessionService } from './session-runtime'
import { LifecycleService, type RuntimeBlocker, type RuntimeStatus } from './lifecycle'
import { ConversationRuntime } from './conversation'
import { createNativeConversationDriverRegistry } from '../../services/conversation/providers/registry'
import { createPiDriverRegistration } from '../../services/conversation/providers/pi/driver'
import type { ConversationAuthority } from '../../../shared/conversation/desktop'
import { directoryIdentity, pathKey } from '../../services/private-conversations/files'

export type { RuntimeDispatchContext } from './admission'

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
  status(): Promise<RuntimeStatus>
  blockers(): Promise<RuntimeBlocker[]>
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
  const knowledge = createRuntimeKnowledge(() => !closed && !released)
  const taskProgress = new CruxTaskProgressRuntime(ports.directory, ports.userData ?? ports.directory, ports.assertOwner, () => { ports.assertOwner(); ports.assertAuthority() })
  const conversationProjections = new AcpConversationProjectionService(ports.userData ?? ports.directory)
  const conversationDrivers = createNativeConversationDriverRegistry(ports.userData ?? ports.directory, [createPiDriverRegistration()])
  const conversation = new ConversationRuntime({
    directory: ports.directory,
    assertOwner: () => ports.assertOwner(),
    driverRegistry: conversationDrivers,
  })
  const watchers = new Map<string, FSWatcher>()
  const materialTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const admission = new AdmissionService(ports)
  const conversationReads = new ConversationReadService({ acp, projections: conversationProjections })
  const sessionRuntime = new RuntimeSessionService({ admission, events, isClosed: () => closed })
  const lifecycle = new LifecycleService({
    acp,
    commands,
    events,
    taskProgress,
    taskExecutions,
    workcopies,
    materialTimers,
    watchers,
    conversationProjections,
    conversation,
    stopKnowledgeReads: () => knowledge.stopReads(),
    workflow: {
      countOwned: countOwnedWorkflowApplications,
      hasAny: hasWorkflowApplications,
      shutdownAll: shutdownWorkflowApplications,
    },
    setWorkflowAdmissionClosed,
    canonicalDirectory,
    workcopyFacts: root => workcopies.facts(resolveWorkcopy(root)),
    processRecoveryReady,
    disposeEvents,
  }, {
    closed: () => closed,
    released: () => released,
    stopping: () => stopping,
    setStopping(value) { stopping = value },
    setClosed() { closed = true },
    setReleased() { released = true },
    operations: () => operations,
    setOperations(value) { operations = value },
    sessionAdmissions: () => sessionAdmissions,
    setSessionAdmissions(value) { sessionAdmissions = value },
  }, admission)

  function conversationAuthority(context: RuntimeDispatchContext): ConversationAuthority & { assertCurrent(): void } {
    const { workspace, native } = context
    if (!workspace || !native) throw new DaemonError('E_DENIED', 'Conversation access requires a protected desktop workspace.')
    native.assertProduct()
    const identity = directoryIdentity(workspace.root)
    const assertCurrent = (): void => {
      ports.assertOwner()
      ports.assertAuthority()
      ports.assertWorkspaceGrant?.(workspace)
      native.assertProduct()
      if (directoryIdentity(workspace.root) !== identity) throw new DaemonError('E_CONFLICT', 'The conversation workspace directory changed.')
    }
    assertCurrent()
    const projectId = createHash('sha256').update(JSON.stringify([pathKey(workspace.root), identity])).digest('hex')
    return { ownerId: native.actor.userId, spaceId: 'personal', projectId, cwd: workspace.root, binding: { kind: 'personal' }, assertCurrent }
  }
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
  async function execute(method: RuntimeBodyMethod, raw: unknown, root: string, context: RuntimeDispatchContext): Promise<unknown> {
    if (method === 'runtime.workflowCutover') {
      if (!context.native || !context.workspace) throw new DaemonError('E_DENIED', 'Workflow cutover requires a protected native process and authenticated directory grant')
      return workflowCutover.execute(root, runtimeBodies[method].parse(raw), { ...context.native, grant: context.workspace })
    }
    if (method === 'runtime.taskExecutionPlan') {
      if (!context.native || !context.workspace) throw new DaemonError('E_DENIED', 'Product execution planning requires the native GUI and original workspace grant')
      context.native.assertProduct()
      const { engine } = runtimeBodies[method].parse(raw)
      const plan = await acp.preparePlatformAcpLaunch(root, engine)
      plan.assertCurrent()
      if (!plan.options.modelId) throw new DaemonError('E_UNAVAILABLE', 'Select an explicit model in the existing engine configuration before preparing')
      return { digest: plan.digest, adapterVersion: engine.agentId === 'pi' ? PI_VERSION : BUILTINS[engine.agentId].version,
        capabilities: [engine.agentId === 'pi' ? 'sdkContext' : 'embeddedContext'] }
    }
    if (method === 'runtime.taskPreparation') {
      const input = runtimeBodies[method].parse(raw)
      if (!context.native || !context.workspace) throw new DaemonError('E_DENIED', 'Task preparation requires the authenticated native process and original workspace grant.')
      if (input.operation === 'prepare' && input.preparationId !== context.commandId) throw new DaemonError('E_CONFLICT', 'Preparation must retain its original runtime command UUID.')
      if (input.operation === 'database-delivery') return taskPreparation.captureDatabaseDelivery(root, input, { ...context.native, grant: context.workspace })
      return taskPreparation.execute(root, input, { ...context.native, grant: context.workspace })
    }
    if (method === 'runtime.privateRead') {
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
    if (method === 'runtime.privateSend') {
      const input = runtimeBodies[method].parse(raw)
      return withPrivateAcpOwner(input, () => privateNativeSend(input, () => admission.assertValid(root, method) && !closed))
    }
    if (method === 'runtime.privateConfigure') return configurePrivateNativeSession(raw, () => admission.assertValid(root, method) && !closed)
    if (method === 'runtime.privateRecoverModel') return recoverPrivateNativeModel(raw, () => admission.assertValid(root, method) && !closed)
    if (method === 'runtime.privateCancel') {
      const input = runtimeBodies[method].parse(raw)
      return withPrivateAcpOwner(input, () => privateNativeControl('cancel', input))
    }
    if (method === 'runtime.privateEnd') {
      const input = runtimeBodies[method].parse(raw)
      return withPrivateAcpOwner(input, () => privateNativeControl('end', input))
    }
    if (method === 'runtime.privateRespond') {
      const input = runtimeBodies[method].parse(raw)
      return withPrivateAcpOwner(input, () => privateNativeControl('respond', input))
    }
    if (method === 'runtime.workcopyUse') {
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
    if (method === 'runtime.cruxProgress') {
      const input = runtimeBodies[method].parse(raw)
      if (closed && !['catalog', 'read', 'conversation', 'events', 'cancel', 'official'].includes(input.operation)) throw new DaemonError('E_UNAVAILABLE', 'Task execution admission is closed.')
      return taskProgress.execute(input)
    }
    if (method === 'runtime.knowledge') return knowledge.execute(root, 0, raw)
    if (method === 'runtime.agents') return acp.listAcpAgents(runtimeBodies[method].parse(raw).refresh)
    if (method === 'runtime.setup') return acp.setupAcpRuntime(runtimeBodies[method].parse(raw).runtimeId)
    if (method === 'runtime.probe') return acp.testAcpRuntimeConnection(runtimeBodies[method].parse(raw).runtimeId)
    if (method === 'runtime.profiles') return acp.listAcpProfiles(root)
    if (method === 'runtime.taskExecution') {
      if (!context.native) throw new DaemonError('E_DENIED', 'Product execution needs authenticated native authority')
      const input = runtimeBodies[method].parse(raw)
      const grant = context.workspace ?? taskExecutions.retainedGrant(input.dispatchId)
      return taskExecutions.execute(root, input, { ...context.native, grant }, context.commandId)
    }
    if (method === 'runtime.conversationModels') {
      const { instanceId } = runtimeBodies[method].parse(raw)
      const { projectId, assertCurrent } = conversationAuthority(context)
      return conversation.listModels(root, projectId, instanceId, assertCurrent)
    }
    if (method === 'runtime.conversationDrivers') {
      runtimeBodies[method].parse(raw)
      conversationAuthority(context)
      return conversationDrivers.list().map(({ instanceId, driverKind }) => ({ instanceId, driverKind }))
    }
    if (method === 'runtime.conversationDescribeDriver') {
      const { instanceId } = runtimeBodies[method].parse(raw)
      const { projectId, assertCurrent } = conversationAuthority(context)
      return conversation.describeDriver(root, projectId, instanceId, assertCurrent)
    }
    if (method === 'runtime.conversationCreate') {
      const input = runtimeBodies[method].parse(raw)
      if (context.commandId !== input.commandId) throw new DaemonError('E_DENIED', 'The conversation command ID does not match its admitted dispatch.')
      const authority = conversationAuthority(context)
      return conversation.createThread({ ...input, ...authority, cwd: root, assertCurrent: () => {
        if (closed || released) throw new DaemonError('E_UNAVAILABLE', 'Conversation admission is closed.')
        authority.assertCurrent()
        ports.assertWorkspaceAdmission?.(root, method)
      } })
    }
    if (method === 'runtime.conversationList') {
      runtimeBodies[method].parse(raw)
      const { ownerId, spaceId, projectId } = conversationAuthority(context)
      return conversation.listThreads(ownerId, spaceId, projectId)
    }
    if (method === 'runtime.conversationRead') {
      const input = runtimeBodies[method].parse(raw)
      const { ownerId, spaceId, projectId } = conversationAuthority(context)
      return conversation.readThread(input.threadId, ownerId, spaceId, projectId)
    }
    if (method === 'runtime.conversationCommand') {
      const input = runtimeBodies[method].parse(raw)
      const { ownerId, spaceId, projectId } = conversationAuthority(context)
      return conversation.readCommand(input.commandId, ownerId, spaceId, projectId)
    }
    if (method === 'runtime.conversationEvents') {
      const input = runtimeBodies[method].parse(raw)
      return conversation.readEvents(input, conversationAuthority(context))
    }
    if (method === 'runtime.conversationApply') {
      const { command } = runtimeBodies[method].parse(raw)
      if (context.commandId !== command.commandId) throw new DaemonError('E_DENIED', 'The conversation command ID does not match its admitted dispatch.', 'not-admitted')
      const authority = conversationAuthority(context)
      return conversation.command(command, { ...authority, cwd: root, assertCurrent: () => {
        if (closed || released) throw new DaemonError('E_UNAVAILABLE', 'Conversation admission is closed.', 'not-admitted')
        authority.assertCurrent()
        ports.assertWorkspaceAdmission?.(root, method)
      } })
    }
    if (method === 'runtime.conversationThreadCommand') {
      return conversation.readThreadCommand(runtimeBodies[method].parse(raw), conversationAuthority(context))
    }
    if (method === 'runtime.conversationEventDelta') {
      return conversation.readEventDelta(runtimeBodies[method].parse(raw), conversationAuthority(context))
    }
    if (method === 'runtime.conversationHistory') {
      return conversation.readHistory(runtimeBodies[method].parse(raw), conversationAuthority(context))
    }
    if (conversationReads.handles(method)) return conversationReads.execute(method, raw, root)
    return sessionRuntime.execute(method, raw, root, context)
  }
  return {
    status: () => lifecycle.status(),
    blockers: () => lifecycle.blockers(),
    closeAdmission: () => lifecycle.closeAdmission(),
    shutdown: () => lifecycle.shutdown(),
    activity: () => lifecycle.activity(),
    assertSessionsIdle: () => lifecycle.assertSessionsIdle(),
    recoverWorkcopy: input => recoverExactAcpWorkcopyUse(ports.directory, workcopies, input),
    async releaseWorkcopy(_root, payload, commandId) {
      ports.assertOwner()
      z.string().uuid().parse(commandId)
      if (!isBoundedWorkcopyCleanup('runtime.workcopyCleanup', payload) || !('inline' in payload)) throw new DaemonError('E_DENIED', '清理通道只接受有界原登记清理。')
      const input = runtimeBodies['runtime.workcopyCleanup'].parse(payload.inline)
      if (input.operation === 'consumer-read') return { inline: workcopyUseResultSchema.parse({ operation: 'consumer-read', lease: workcopies.readConsumerLease(input.root, input.token, input.owner, input.identityId) }) }
      if (input.operation === 'consumer-restrict') return { inline: workcopyUseResultSchema.parse({ operation: 'consumer-restrict', lease: workcopies.restrictConsumerTasks(input.root, input.token, input.owner, input.identityId, input.expectedRevision, input.taskKeys) }) }
      const { operation: _operation, ...release } = input
      return { inline: workcopyUseResultSchema.parse({ operation: 'release', ...workcopies.release(release) }) }
    },
    assertIdle: () => lifecycle.assertIdle(),
    pack(root, value) { ports.assertOwner(); ports.assertAuthority(); return blobs.pack(root, value) },
    unpack(root, wire) { ports.assertOwner(); ports.assertAuthority(); return blobs.unpack(root, wire) },
    ownsWorkspace: root => lifecycle.ownsWorkspace(root),
    release: () => lifecycle.release(),
    observe: listener => events.observe(listener), catchUp: (root, cursor, limit) => events.catchUp(root, cursor, limit),
    async dispatch<M extends RuntimeMethod>(method: M, payload: RuntimeRequest<M>, context: RuntimeDispatchContext): Promise<RuntimeResult<M>> {
      if (['runtime.taskPreparation', 'runtime.taskExecution'].includes(method) && !taskReads.getStore())
        return taskReads.run({ retries: 0 }, () => this.dispatch(method, payload, context))
      ports.assertOwner()
      admission.assertIntakeAdmitted(method, payload)
      operations++
      const sessionAdmission = admission.assertSessionAdmissionMethod(method)
      if (sessionAdmission) sessionAdmissions++
      try {
        await processRecoveryReady
        admission.assertIntakeAdmitted(method, payload)
        const parsed = runtimeRequests[method].parse(payload)
        if (method === 'runtime.status') return await lifecycle.status() as RuntimeResult<M>
        if (released) throw new DaemonError('E_UNAVAILABLE', 'Runtime authority was released.')
        ports.assertAuthority()
        const taskControl = admission.isNativeTaskControl(method, payload)
        const root = context.workspace?.root ?? (isGlobalRuntimeMethod(method) || taskControl ? '@profile' : '')
        if (!root) throw new DaemonError('E_DENIED', 'Runtime operations require an authenticated workspace grant.')
        if (CONVERSATION_RUNTIME_METHODS.has(method)) {
          if (!context.workspace || !context.native) throw new DaemonError('E_DENIED', 'Conversation access requires a protected desktop workspace.')
          context.native.assertProduct()
        }
        const bodyMethod = method as RuntimeBodyMethod
        if (context.workspace && method !== 'runtime.workflowCutover' && method !== 'runtime.taskPreparation' && method !== 'runtime.taskExecution') observeWorkspace(root, context.workspace.revision)
        let value: unknown
        switch (method) {
      case 'runtime.status':
      case 'runtime.command': {
        if (method === 'runtime.command') {
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
        }
        break
      }
          case 'runtime.blob.open': value = blobs.open(root, runtimeRequests['runtime.blob.open'].parse(parsed)); break
          case 'runtime.blob.append': { const p = runtimeRequests['runtime.blob.append'].parse(parsed); value = blobs.append(root, p.id, p.offset, p.data); break }
          case 'runtime.blob.seal': value = blobs.seal(root, runtimeRequests['runtime.blob.seal'].parse(parsed).id); break
          case 'runtime.blob.read': { const p = runtimeRequests['runtime.blob.read'].parse(parsed); value = blobs.read(root, p.blob, p.offset); break }
          case 'runtime.blob.release': value = blobs.release(root, runtimeRequests['runtime.blob.release'].parse(parsed).id); break
          default: {
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
            const mutation = admission.isMutation(bodyMethod, input)
            if (closed && mutation && !admission.closedMutationAllowed(bodyMethod, input)) throw new DaemonError('E_UNAVAILABLE', 'Runtime admission is closed; original owners remain inspectable.')
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
            admission.assertCommand(bodyMethod, context.commandId, input)
            if (mutation) {
              value = method === 'runtime.workcopyUse' || method === 'runtime.conversationCreate' || method === 'runtime.conversationApply' ? await action() : await commands.run(root, context.commandId as string, method, input, action,
                preparation?.operation === 'prepare' && preparationAuthority
                  ? () => taskPreparation.authorizeRecovery(root, preparation, preparationAuthority) : undefined)
            } else value = await action()
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
