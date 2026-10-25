import { join, relative, isAbsolute } from 'node:path'
import { z } from 'zod'
import { watch, type FSWatcher } from 'chokidar'
import { runtimeBodies, runtimeRequests, RUNTIME_MUTATING_METHODS, type RuntimeMethod, type RuntimeRequest, type RuntimeResult, type RuntimeCursor, type RuntimeBodyMethod, type RuntimeWire } from '../../../shared/daemon-runtime'
import type { WorkspaceGrant } from '../../../shared/daemon'
import * as acp from '../../services/acp'
import { bindTaskSchema, configureSchema, promptOptionsSchema } from '../../services/acp/types'
import { getWorkflowApplication, workflowDesktopTemplates, isManagedWorkflowOrigin, withOrdinaryConnectionAdmission, withOrdinaryWorkflowAdmission, withManagedWorkflowAdmission, hasWorkflowApplications, countOwnedWorkflowApplications, shutdownWorkflowApplications, setWorkflowAdmissionClosed } from '../../services/workflow-desktop'
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

export interface RuntimeDispatchContext { workspace?: WorkspaceGrant; commandId?: string }
export interface DaemonRuntimePorts {
  epoch: string
  directory: string
  assertOwner(): void
  /** Main asserts its real completed settings/runtime cutover, not a synthetic drain. */
  assertAuthority(): void
  /** Temporary application admission; independent from permanent authority. */
  assertAdmission?(): void
  assertWorkspaceAdmission?(root: string, method: RuntimeBodyMethod): void
}
export interface DaemonRuntime {
  dispatch<M extends RuntimeMethod>(method: M, payload: RuntimeRequest<M>, context: RuntimeDispatchContext): Promise<RuntimeResult<M>>
  status(): Promise<{ authority: 'legacy' | 'daemon'; admission: 'open' | 'closed'; sessions: number; workflows: number; operations: number; released: boolean; reason?: string }>
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
  const blobs = new RuntimeBlobs(join(ports.directory, 'runtime-blobs'))
  const commands = new RuntimeCommands(join(ports.directory, 'runtime-commands'), ports.epoch, ports.assertOwner)
  const events = new RuntimeEvents(ports.epoch)
  const disposeEvents = installHostEventSink((channel, value) => events.publish(channel, value))
  let closed = false, released = false, stopping: Promise<void> | undefined
  let operations = 0
  const knowledge = createRuntimeKnowledge(() => !closed && !released)
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
    ports.assertOwner()
    let authority: 'legacy' | 'daemon' = 'daemon', reason: string | undefined
    try { ports.assertAuthority() } catch { authority = 'legacy'; reason = 'Runtime/settings authority preparation has not completed.' }
    return { authority, admission: closed || authority !== 'daemon' ? 'closed' : 'open', sessions: acp.listOwnedAcpSessionFacts().length, workflows: await countOwnedWorkflowApplications(), operations: commands.count(), released, ...(reason ? { reason } : {}) }
  }
  const closeAdmission = (): void => { closed = true; setWorkflowAdmissionClosed(true); acp.closeAcpAdmission() }
  const shutdown = (): Promise<void> => {
    if (stopping) return stopping
    closeAdmission()
    knowledge.stopReads()
    stopping = (async () => {
      // Stop managed stages through their retained owners before canonical ACP cleanup.
      await shutdownWorkflowApplications()
      // Give ordinary turns their existing bounded cancellation first. Failure here
      // still requires canonical termination of these exact owned runtime handles.
      await Promise.allSettled(acp.listOwnedAcpSessionFacts().filter(session => session.turnActive || session.accepting || session.pendingPermission)
        .map(session => acp.cancelAcpSession(session.projectRoot, session.sessionId)))
      await acp.shutdownAcp()
      await commands.drain()
      for (const timer of materialTimers.values()) clearTimeout(timer)
      materialTimers.clear()
      await Promise.all([...watchers.values()].map(watcher => watcher.close())); watchers.clear()
      if (acp.listOwnedAcpSessionFacts().length || await hasWorkflowApplications()) throw new DaemonError('E_UNKNOWN', 'The original runtime still owns native work; release is refused.', 'unknown')
    })().catch(error => { stopping = undefined; throw error })
    return stopping
  }
  async function execute(method: RuntimeBodyMethod, raw: unknown, root: string): Promise<unknown> {
    ports.assertAdmission?.()
    ports.assertWorkspaceAdmission?.(root, method)
    const valid = (): boolean => { ports.assertOwner(); ports.assertAuthority(); ports.assertWorkspaceAdmission?.(root, method); return !closed }
    const connection = <T extends { ok: boolean }>(target: { sessionId?: string; profileId?: string }, action: () => Promise<T>) => withOrdinaryConnectionAdmission(root, target, action)
    switch (method) {
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
      case 'runtime.historyUpdate': { const p = runtimeBodies[method].parse(raw); return acp.updateAcpHistorySession(root, p.sessionId, p.input, valid) }
      case 'runtime.historyRetry': return acp.retryAcpHistorySession(root, runtimeBodies[method].parse(raw).sessionId)
      case 'runtime.new': {
        const p = runtimeBodies[method].parse(raw), input = z.object({ profileId: z.string().optional() }).passthrough().parse(p.input)
        return connection({ profileId: input.profileId }, () => acp.newAcpSession(root, p.input))
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
    status, closeAdmission, shutdown,
    async assertIdle() {
      ports.assertOwner(); ports.assertAuthority()
      if (closed || released || stopping) throw new DaemonError('E_BUSY', 'Native runtime admission is already closed or release remains in progress.')
      const workflows = await countOwnedWorkflowApplications()
      ports.assertOwner(); ports.assertAuthority()
      const sessions = acp.listOwnedAcpSessionFacts()
      if (closed || released || stopping || operations || commands.count() || workflows || sessions.some(session => !session.sessionId || !session.connectionGeneration || session.status !== 'ready'
        || session.accepting || session.closing || session.disconnected || session.leaseHeld || session.cleanupRequired || session.backgroundWork
        || session.unfinishedTools || session.turnActive || session.settling || session.pendingPermission)) throw new DaemonError('E_BUSY', 'Original native sessions, preparation, workflow or unfinished operations still own background work.')
    },
    pack(root, value) { ports.assertOwner(); ports.assertAuthority(); return blobs.pack(root, value) },
    unpack(root, wire) { ports.assertOwner(); ports.assertAuthority(); return blobs.unpack(root, wire) },
    // A pending cross-project session may select this physical cwd after awaits.
    // Conservatively hold destructive grant changes until all pending effects settle.
    async ownsWorkspace(root) {
      const target = canonicalDirectory(root)
      const within = (path: string): boolean => { const delta = relative(target, canonicalDirectory(path)); return delta === '' || !isAbsolute(delta) && delta !== '..' && !delta.startsWith('../') && !delta.startsWith('..\\') }
      return commands.count() > 0 || acp.listOwnedAcpSessionFacts().some(session => within(session.projectRoot) || session.cwd !== null && within(session.cwd)) || await countOwnedWorkflowApplications() > 0
    },
    async release() { await shutdown(); ports.assertOwner(); if ((await status()).sessions || (await status()).workflows) throw new DaemonError('E_UNKNOWN', 'Runtime release has not been verified.', 'unknown'); released = true; disposeEvents() },
    observe: listener => events.observe(listener), catchUp: (root, cursor, limit) => events.catchUp(root, cursor, limit),
    async dispatch<M extends RuntimeMethod>(method: M, payload: RuntimeRequest<M>, context: RuntimeDispatchContext): Promise<RuntimeResult<M>> {
      ports.assertOwner()
      ports.assertAdmission?.()
      operations++
      try {
        const parsed = runtimeRequests[method].parse(payload)
        if (method === 'runtime.status') return await status() as RuntimeResult<M>
        if (released) throw new DaemonError('E_UNAVAILABLE', 'Runtime authority was released.')
        ports.assertAuthority()
        const global = ['runtime.agents', 'runtime.setup', 'runtime.probe', 'runtime.blob.open', 'runtime.blob.append', 'runtime.blob.seal', 'runtime.blob.read', 'runtime.blob.release', 'runtime.command'].includes(method)
        const root = context.workspace?.root ?? (global ? '@profile' : '')
        if (!root) throw new DaemonError('E_DENIED', 'Runtime operations require an authenticated workspace grant.')
        if (context.workspace) observeWorkspace(root, context.workspace.revision)
        let value: unknown
        switch (method) {
          case 'runtime.command': value = commands.inspect(root, runtimeRequests['runtime.command'].parse(parsed).commandId); break
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
            const mutation = method === 'runtime.knowledge' ? KNOWLEDGE_MUTATIONS.includes(knowledgeRuntimeBody.parse(input).operation) : RUNTIME_MUTATING_METHODS.includes(method)
            if (closed && mutation && !['runtime.cancel', 'runtime.end', 'runtime.workflow.stop', 'runtime.workflow.cancelRevision'].includes(method)) throw new DaemonError('E_UNAVAILABLE', 'Runtime admission is closed; original owners remain inspectable.')
            const action = async () => {
              try { return blobs.pack(root, await execute(bodyMethod, input, root)) }
              catch (error) {
                if (error instanceof DaemonError) throw error
                if (error instanceof z.ZodError) throw new DaemonError('E_INVALID_ARG', 'Runtime input violates the original facade contract.')
                const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
                const conflict = ['E_CONFLICT', 'SCOPE_CHANGED', 'STALE_PREVIEW', 'REVISION_CONFLICT', 'COMMAND_PAYLOAD_CONFLICT', 'MATERIAL_CHANGED'].includes(code)
                throw new DaemonError(conflict ? 'E_CONFLICT' : code === 'INVALID_INPUT' ? 'E_INVALID_ARG' : code === 'CAPABILITY_UNAVAILABLE' ? 'E_UNAVAILABLE' : 'E_UNKNOWN', error instanceof Error ? error.message.slice(0, 400) : 'Runtime outcome requires inspection.', conflict || ['INVALID_INPUT', 'CAPABILITY_UNAVAILABLE'].includes(code) ? 'not-admitted' : 'unknown')
              }
            }
            if (mutation) {
              if (!context.commandId) throw new DaemonError('E_INVALID_ARG', 'Runtime mutations require a stable command ID.')
              value = await commands.run(root, context.commandId, method, input, action)
            } else value = await action()
          }
        }
        return value as RuntimeResult<M>
      } finally { operations-- }
    }
  }
}
