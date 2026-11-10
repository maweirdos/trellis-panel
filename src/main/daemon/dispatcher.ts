import { realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { daemonPayloads, DAEMON_LIMITS, MUTATING_DAEMON_METHODS, type DaemonRequest, type DaemonStatus, type WorkspaceGrant } from '../../shared/daemon'
import type { DaemonContext } from './context'
import type { DaemonLease } from './lease'
import { assertLease } from './lease'
import { processIdentity, sameOwner } from './native'
import { DaemonError } from './errors'
import { DaemonRepository, activeJob } from './repository'
import type { ProtectedSettingsOwner } from './settings-owner'
import type { IntegrationScheduler } from './scheduler'
import type { DaemonLog } from './log'
import { WindowsDaemonStartup } from './startup'
import type { DaemonDomainPort } from './domain-port'
import type { ProcessOwner } from '../../shared/daemon'
import { canonicalDirectory } from '../services/acp/metadata'
import { assertNativeGuiGrant, type NativeGuiAuthority } from './native-gui-grant'
import { isBoundedWorkcopyCleanup } from '../../shared/workcopy-use'
import { isBoundedNativeTaskControl } from '../../shared/native-task-execution'
import { LIFECYCLE_RUNTIME_CONTROLS } from '../../shared/daemon/lifecycle'

export class DaemonDispatcher {
  private stopping = false
  private checkingIdle = false
  private operations = 0
  private stopAttempt?: { commandId: string; intent: string; result: Promise<unknown> }
  private lifecycleAdmission?: string
  private lifecycleAdmissionCommand?: string
  private readonly retiredLifecycleAdmissions = new Map<string, string>()
  constructor(private readonly context: DaemonContext, private readonly lease: DaemonLease, private readonly repository: DaemonRepository, private readonly settings: ProtectedSettingsOwner, private readonly scheduler: IntegrationScheduler, private readonly log: DaemonLog, private readonly requestStop: () => void, private readonly domains?: DaemonDomainPort, private readonly ownerBuildSha256?: string) {}
  retainedStopCommandId(): string | undefined {
    return this.stopAttempt?.commandId
  }
  /** Include timer-driven admission in the same server-side idle fence as RPC. */
  async backgroundPoll(action: () => Promise<void>): Promise<void> {
    if (this.stopping || this.checkingIdle) return
    this.operations++
    try { await action() } finally { this.operations-- }
  }
  observeInvalidations(listener: (event: { source: 'runtime' | 'integration'; root?: string; workspaceId?: string | null }) => void): () => void {
    const jobs = this.repository.observe(event => listener({ source: 'integration', workspaceId: event.workspaceId }))
    const runtime = this.domains?.observeRuntime(event => listener({ source: 'runtime', root: canonicalDirectory(event.root) }))
    return () => { jobs(); runtime?.() }
  }
  authorizedWorkspace(request: DaemonRequest): WorkspaceGrant { return this.workspace(request) }
  currentWorkspace(grant: WorkspaceGrant): boolean {
    try { const current = this.repository.grant(grant.workspaceId); return Boolean(current && JSON.stringify(current) === JSON.stringify(grant) && realpathSync(grant.root) === grant.root) } catch { return false }
  }
  async status(): Promise<DaemonStatus> {
    const jobs = this.repository.allJobs()
    const intent = this.repository.startupIntent()
    const retainedStopCommandId = this.retainedStopCommandId()
    const domains = await this.domains?.blockers() ?? []
    const blockerList: NonNullable<DaemonStatus['blockers']> = [
      ...jobs.filter(job => activeJob(job) || job.state === 'unknown').map(job => ({
        domain: 'scheduler' as const,
        state: (job.state === 'unknown' ? 'unknown' : 'active') as 'active' | 'unknown',
        label: `Integration job ${job.id}`, evidence: 'none' as const, requiredEvidence: [] as []
      })),
      ...domains.map(({ domain, state, label, rootId, ownerGeneration, acquiredAt }) => ({
        domain, state, label, ...(rootId ? { rootId } : {}), ...(ownerGeneration ? { ownerGeneration } : {}),
        ...(acquiredAt !== undefined ? { acquiredAt } : {}),
        evidence: 'none' as const,
        requiredEvidence: domain === 'work-copy'
          ? ['job-witness', 'kernel-transition', 'cleanup-receipt'] as Array<'job-witness' | 'kernel-transition' | 'cleanup-receipt'>
          : [] as []
      }))
    ].slice(0, 32)
    let startupRegistration: 'confirmed' | 'unknown' | 'unavailable' = intent ? 'unknown' : 'confirmed'
    if (!intent && this.context.identity.mode === 'production') {
      try { if (!new WindowsDaemonStartup(this.context).verify(this.repository.preferences().startup === 'login')) startupRegistration = 'unknown' }
      catch { startupRegistration = 'unavailable' }
    }
    return { protocol: 1, epoch: this.lease.epoch, identity: this.context.identity, owner: this.context.owner,
      state: this.stopping ? 'stopping' : 'running', runtimeAuthority: this.domains?.ready() ? 'daemon' : 'legacy', settingsAuthority: this.settings.authority(),
      preferences: this.repository.preferences(), eventCursor: this.repository.cursor(), activeJobs: jobs.filter(activeJob).length,
      unknownJobs: jobs.filter((job) => job.state === 'unknown').length, capabilities: this.domains?.ready() ? ['foundation', 'integration-jobs', 'runtime-control', 'native-protection', 'push-events'] : ['foundation', 'native-protection', 'push-events'],
      startupRegistration, ...(intent ? { startupCommandId: intent.commandId } : {}), ...(this.ownerBuildSha256 ? { buildSha256: this.ownerBuildSha256 } : {}),
      lifecycleVersion: 1, activity: this.domains?.activity() ?? { state: 'idle', sessions: [], otherWork: jobs.filter(activeJob).length },
      ...(this.lifecycleAdmission ? { lifecycleAttemptId: this.lifecycleAdmission } : {}),
      ...(retainedStopCommandId ? { stopCommandId: retainedStopCommandId } : {}), ...(blockerList.length ? { blockers: blockerList } : {}) }
  }
  private workspace(request: DaemonRequest): WorkspaceGrant {
    const supplied = request.workspace
    const actual = supplied ? this.repository.grant(supplied.workspaceId) : null
    if (!supplied || !actual || supplied.grantId !== actual.grantId || supplied.revision !== actual.revision || supplied.root !== actual.root) throw new DaemonError('E_DENIED', 'The workspace grant is missing, stale or root-mismatched.')
    if (realpathSync(actual.root) !== actual.root) throw new DaemonError('E_CONFLICT', 'The authorized workspace root was redirected. Reauthorize its original identity.')
    return actual
  }
  async dispatch(request: DaemonRequest, actor: ProcessOwner, nativeGui?: NativeGuiAuthority): Promise<unknown> {
    if (request.method.startsWith('runtime.private') || request.method === 'runtime.workflowCutover' || request.method === 'runtime.taskExecution' || request.method === 'runtime.cruxProgress' || request.method === 'runtime.workcopyUse' || request.method === 'runtime.workcopyCleanup') assertNativeGuiGrant(this.context, this.lease.epoch, actor, nativeGui)
    const management = ['daemon.status', 'daemon.stop', 'daemon.lifecycle.admit', 'daemon.lifecycle.resolve', 'daemon.workcopyRecovery', 'daemon.logs', 'commands.get'].includes(request.method)
      || LIFECYCLE_RUNTIME_CONTROLS.includes(request.method)
      || isBoundedWorkcopyCleanup(request.method, request.payload)
      || isBoundedNativeTaskControl(request.method, request.payload)
    if ((this.checkingIdle || this.stopping) && !management) throw new DaemonError(this.stopping ? 'E_UNAVAILABLE' : 'E_BUSY', 'Native admission is closed while the original daemon owner is checking shutdown.')
    if (!management) this.operations++
    try { return await this.dispatchRequest(request, actor, nativeGui) }
    finally { if (!management) this.operations-- }
  }
  private async stop(request: DaemonRequest): Promise<unknown> {
    const input = daemonPayloads['daemon.stop'].parse(request.payload)
    if (!sameOwner(input.expectedOwner, this.context.owner)) throw new DaemonError('E_CONFLICT', 'The daemon owner changed before stop.')
    if (input.lifecycle && (input.idleOnly || input.lifecycle.nonce !== this.lease.nonce)) throw new DaemonError('E_CONFLICT', '生命周期确认不属于当前后台代次。')
    const committed = this.repository.committedResult(request)
    if (committed.found) return committed.data
    const intent = JSON.stringify(input)
    if (this.stopAttempt) {
      if (this.stopAttempt.commandId === request.commandId) {
        if (this.stopAttempt.intent !== intent) throw new DaemonError('E_CONFLICT', 'The original stop command has a different payload.')
        return this.stopAttempt.result
      }
      throw new DaemonError('E_BUSY', 'The original daemon stop command is still retained. Inspect it before another stop.')
    }
    if (!request.commandId) throw new DaemonError('E_INVALID_ARG', 'Stop requires its original command ID.')
    const perform = async (): Promise<unknown> => {
      if (input.lifecycle) {
        this.checkingIdle = true
        // The domain checks the actual session facts synchronously and closes
        // intake before returning the shutdown promise. Other jobs are cleaned.
        const domainStop = this.domains?.shutdownForLifecycle(input.lifecycle.interrupt)
        this.stopping = true
        this.scheduler.closeAdmission()
        const cleanup = await Promise.allSettled([domainStop, this.scheduler.shutdown()])
        if (cleanup.some(result => result.status === 'rejected')) throw new DaemonError('E_UNKNOWN', '后台清理未确认，请核对原退出命令。', 'unknown')
      } else if (input.idleOnly) {
        // Close all dispatcher/poll admission BEFORE any await or idle check.
        // The native domain must also atomically fence its independent owners.
        this.checkingIdle = true
        const assertIdle = (): void => {
          assertLease(this.context, this.lease)
          if (this.operations || this.scheduler.hasRunning() || this.repository.allJobs().some(job => activeJob(job) || job.state === 'unknown')) throw new DaemonError('E_BUSY', 'The original daemon owns active or uncertain background work; idle-only stop was refused.')
        }
        assertIdle()
        const actual = await processIdentity(this.lease.owner.pid)
        if (!actual || !sameOwner(actual, this.lease.owner)) throw new DaemonError('E_CONFLICT', 'The original native daemon process changed during idle-only stop.')
        assertIdle()
        if (this.domains) {
          if (!this.domains.shutdownIfIdle) throw new DaemonError('E_BUSY', 'The native domain cannot prove an idle shutdown. Preserve background work and use explicit native recovery after inspecting its owner.')
          await this.domains.shutdownIfIdle()
        }
        assertLease(this.context, this.lease)
      } else {
        this.stopping = true
        this.scheduler.closeAdmission()
        const cleanup = await Promise.allSettled([this.domains?.shutdown(), this.scheduler.shutdown()])
        if (cleanup.some(result => result.status === 'rejected')) throw new DaemonError('E_UNKNOWN', '后台清理未确认，请核对原退出命令。', 'unknown')
      }
      this.stopping = true
      this.scheduler.closeAdmission()
      await this.scheduler.shutdown()
      const result = this.repository.stopping(request)
      try { this.log.append('DAEMON_STOPPING') }
      catch { process.emitWarning('Daemon stop was accepted, but its diagnostic log could not be saved.', { code: 'TRELLIS_DAEMON_LOG_UNAVAILABLE' }) }
      this.requestStop()
      return result
    }
    // Defer execution until the shared promise is installed so synchronous
    // rejections and duplicate frames retain the same exact stop identity.
    const result = Promise.resolve().then(perform).catch((error: unknown) => {
      if (!this.stopping && error instanceof DaemonError && error.outcome === 'not-admitted') {
        this.checkingIdle = false
        this.stopAttempt = undefined
      }
      throw error
    })
    this.stopAttempt = { commandId: request.commandId, intent, result }
    return result
  }
  private async dispatchRequest(request: DaemonRequest, actor: ProcessOwner, nativeGui?: NativeGuiAuthority): Promise<unknown> {
    assertLease(this.context, this.lease)
    if (request.expectedEpoch !== this.lease.epoch) throw new DaemonError('E_CONFLICT', 'Daemon epoch changed. Reconnect and inspect the original command receipt.')
    const mutating = MUTATING_DAEMON_METHODS.includes(request.method)
    if (mutating && !request.commandId) throw new DaemonError('E_INVALID_ARG', 'Mutations require a stable commandId.')
    if (this.stopping && mutating && request.method !== 'daemon.stop' && request.method !== 'daemon.workcopyRecovery' && !LIFECYCLE_RUNTIME_CONTROLS.includes(request.method) && !isBoundedWorkcopyCleanup(request.method, request.payload) && !isBoundedNativeTaskControl(request.method, request.payload)) throw new DaemonError('E_UNAVAILABLE', 'Daemon is stopping. Inspect the retained command receipt.')
    // The private original lease remains cleanable after grant revocation.
    if (request.workspace && !isBoundedWorkcopyCleanup(request.method, request.payload) && !isBoundedNativeTaskControl(request.method, request.payload)) this.workspace(request)
    if (this.domains?.handles(request.method)) return this.domains.dispatch(request, actor, nativeGui)
    if (mutating && request.method !== 'daemon.stop') {
      const committed = this.repository.committedResult(request)
      if (committed.found) return committed.data
    }
    switch (request.method) {
      case 'daemon.lifecycle.resolve': {
        const input = daemonPayloads[request.method].parse(request.payload)
        if (!sameOwner(input.expectedOwner, this.context.owner) || input.nonce !== this.lease.nonce) throw new DaemonError('E_CONFLICT', '退出准入核验目标已变化。')
        if (this.lifecycleAdmission) {
          if (this.lifecycleAdmission !== input.attemptId || this.lifecycleAdmissionCommand !== input.admissionId) throw new DaemonError('E_CONFLICT', '后台已由另一个退出请求关闭接纳。')
          return { state: 'admitted', attemptId: input.attemptId, admissionId: input.admissionId }
        }
        const retired = this.retiredLifecycleAdmissions.get(input.attemptId)
        if (retired && retired !== input.admissionId) throw new DaemonError('E_CONFLICT', '原退出准入命令身份已变化。')
        if (!retired && this.retiredLifecycleAdmissions.size >= 256) throw new DaemonError('E_BUSY', '退出准入核验容量已满；原请求保持未知。')
        // Synchronous epoch-local negative receipt: a delayed frame for this
        // exact admission is now fenced before reporting that it was absent.
        this.retiredLifecycleAdmissions.set(input.attemptId, input.admissionId)
        return { state: 'not-admitted', attemptId: input.attemptId, admissionId: input.admissionId }
      }
      case 'daemon.lifecycle.admit': {
        const input = daemonPayloads[request.method].parse(request.payload)
        if (!sameOwner(input.expectedOwner, this.context.owner) || input.lifecycle.nonce !== this.lease.nonce) throw new DaemonError('E_CONFLICT', '退出准入目标已变化。')
        if (this.retiredLifecycleAdmissions.has(input.lifecycle.attemptId)) throw new DaemonError('E_CONFLICT', '原退出准入已核验为未接纳，延迟请求不能再次关闭接纳。')
        if (this.lifecycleAdmission && this.lifecycleAdmission !== input.lifecycle.attemptId) throw new DaemonError('E_BUSY', '原退出请求已关闭接纳。')
        if (this.lifecycleAdmissionCommand && this.lifecycleAdmissionCommand !== request.commandId) throw new DaemonError('E_CONFLICT', '必须保留原退出准入命令身份。')
        if (!this.lifecycleAdmission) {
          this.domains?.admitLifecycle(input.lifecycle.interrupt)
          this.checkingIdle = true
          this.scheduler.closeAdmission()
          this.lifecycleAdmission = input.lifecycle.attemptId
          this.lifecycleAdmissionCommand = request.commandId
        }
        return this.repository.command(request, () => ({ admitted: true as const }))
      }
      case 'daemon.status': daemonPayloads[request.method].parse(request.payload); return await this.status()
      case 'daemon.preferences.get':
        daemonPayloads[request.method].parse(request.payload)
        if (this.repository.startupIntent()) throw new DaemonError('E_UNKNOWN', 'Startup registration needs native reconciliation. Inspect daemon status and its original command ID.', 'unknown')
        return this.repository.preferences()
      case 'daemon.preferences.set': {
        const input = daemonPayloads[request.method].parse(request.payload)
        if (input.startup === 'login' || this.repository.preferences().startup === 'login') {
          const startup = new WindowsDaemonStartup(this.context)
          startup.assertAvailable()
          return this.repository.registerStartup(request, input, startup.descriptor(), () => startup.apply(input.startup === 'login'))
        }
        return this.repository.setPreferences(request, input)
      }
      case 'daemon.logs': { const input = daemonPayloads[request.method].parse(request.payload); return this.log.page(input.after, input.limit) }
      case 'daemon.startup.reconcile': {
        const input = daemonPayloads[request.method].parse(request.payload)
        const startup = new WindowsDaemonStartup(this.context)
        startup.assertAvailable()
        return this.repository.reconcileStartup(input.originalCommandId, (preferences, registration) => startup.verifyOriginal(registration, preferences.startup === 'login'))
      }
      case 'daemon.stop': return this.stop(request)
      case 'daemon.workcopyRecovery': {
        if (!this.domains?.recoverWorkcopy) throw new DaemonError('E_UNAVAILABLE', '当前后台没有证据式工作副本恢复能力。')
        const input = daemonPayloads[request.method].parse(request.payload)
        if (input.commandId !== request.commandId) throw new DaemonError('E_CONFLICT', '恢复确认的 command ID 与请求不一致。')
        const { commandId: _commandId, ...recovery } = input
        return await this.domains.recoverWorkcopy(recovery)
      }
      case 'workspace.grant': {
        const input = daemonPayloads[request.method].parse(request.payload)
        if (!isAbsolute(input.root) || !statSync(input.root).isDirectory()) throw new DaemonError('E_INVALID_ARG', 'Authorize an existing absolute workspace directory from native code.')
        const change = () => this.repository.grantWorkspace(request, { ...input, root: realpathSync(input.root) })
        const previous = this.repository.grant(input.workspaceId)
        return previous && this.domains ? this.domains.withWorkspaceChange(previous, change) : change()
      }
      case 'workspace.revoke': {
        daemonPayloads[request.method].parse(request.payload)
        const grant = this.workspace(request), change = () => this.repository.revoke(request, grant)
        return this.domains ? this.domains.withWorkspaceChange(grant, change) : change()
      }
      case 'workspace.get': return this.repository.grant(daemonPayloads[request.method].parse(request.payload).workspaceId)
      case 'events.snapshot': {
        daemonPayloads[request.method].parse(request.payload)
        const workspace = request.workspace ? this.workspace(request) : null
        return { status: await this.status(), workspace, jobs: workspace ? this.repository.jobs(workspace.workspaceId).filter(activeJob) : [], cursor: this.repository.cursor() }
      }
      case 'events.replay': {
        const input = daemonPayloads[request.method].parse(request.payload)
        return this.repository.replay(input.after, request.workspace ? this.workspace(request).workspaceId : null, input.limit)
      }
      case 'events.subscribe': daemonPayloads[request.method].parse(request.payload); this.workspace(request); return { subscribed: true }
      case 'events.unsubscribe': daemonPayloads[request.method].parse(request.payload); this.workspace(request); return null
      case 'jobs.list': {
        const input = daemonPayloads[request.method].parse(request.payload)
        const jobs = this.repository.jobs(this.workspace(request).workspaceId)
        const offset = input.after ? jobs.findIndex((job) => job.id === input.after) : -1
        if (input.after && offset < 0) throw new DaemonError('E_RESET_REQUIRED', 'The job page cursor is unknown. Reload the workspace snapshot.')
        const items: typeof jobs = []
        let bytes = 0
        for (const candidate of jobs.slice(offset + 1, offset + 1 + input.limit)) {
          const size = Buffer.byteLength(JSON.stringify(candidate)) + 1
          if (bytes + size > DAEMON_LIMITS.frameBytes - 16 * 1024) break
          items.push(candidate); bytes += size
        }
        if (!items.length && jobs.length > offset + 1) throw new DaemonError('E_BUSY', 'The retained job exceeds the control-page budget; inspect its bounded detail.')
        return { items, next: jobs.length > offset + 1 + items.length ? items.at(-1)?.id ?? null : null }
      }
      case 'jobs.get': { const input = daemonPayloads[request.method].parse(request.payload); return this.repository.job(input.id, this.workspace(request).workspaceId) }
      case 'jobs.enqueue': {
        const input = daemonPayloads[request.method].parse(request.payload)
        const workspace = this.workspace(request)
        await this.scheduler.authorize(workspace, input.source, input.input)
        assertLease(this.context, this.lease); this.workspace(request)
        if (this.stopping) throw new DaemonError('E_UNAVAILABLE', 'Daemon admission closed while resolving the original provider grant.')
        return this.repository.enqueue(request, input, workspace)
      }
      case 'jobs.cancel': {
        const input = daemonPayloads[request.method].parse(request.payload)
        const job = this.repository.cancel(request, input.id, input.revision, this.workspace(request))
        this.scheduler.cancel(job.id); return job
      }
      case 'commands.get': { const input = daemonPayloads[request.method].parse(request.payload); return this.repository.receipt(input.commandId, request.workspace ? this.workspace(request).workspaceId : null) }
    }
    throw new DaemonError('E_UNAVAILABLE', 'The declared native method has no installed application owner.')
  }
}
