import { realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { daemonPayloads, DAEMON_LIMITS, MUTATING_DAEMON_METHODS, type DaemonRequest, type DaemonStatus, type WorkspaceGrant } from '../../shared/daemon'
import type { DaemonContext } from './context'
import type { DaemonLease } from './lease'
import { assertLease } from './lease'
import { sameOwner } from './native'
import { DaemonError } from './errors'
import { DaemonRepository, activeJob } from './repository'
import type { ProtectedSettingsOwner } from './settings-owner'
import type { IntegrationScheduler } from './scheduler'
import type { DaemonLog } from './log'
import { WindowsDaemonStartup } from './startup'
import type { DaemonDomainPort } from './domain-port'
import type { ProcessOwner } from '../../shared/daemon'
import { canonicalDirectory } from '../services/acp/metadata'

export class DaemonDispatcher {
  private stopping = false
  constructor(private readonly context: DaemonContext, private readonly lease: DaemonLease, private readonly repository: DaemonRepository, private readonly settings: ProtectedSettingsOwner, private readonly scheduler: IntegrationScheduler, private readonly log: DaemonLog, private readonly requestStop: () => void, private readonly domains?: DaemonDomainPort) {}
  observeInvalidations(listener: (event: { source: 'runtime' | 'integration'; root?: string; workspaceId?: string | null }) => void): () => void {
    const jobs = this.repository.observe(event => listener({ source: 'integration', workspaceId: event.workspaceId }))
    const runtime = this.domains?.observeRuntime(event => listener({ source: 'runtime', root: canonicalDirectory(event.root) }))
    return () => { jobs(); runtime?.() }
  }
  authorizedWorkspace(request: DaemonRequest): WorkspaceGrant { return this.workspace(request) }
  currentWorkspace(grant: WorkspaceGrant): boolean {
    try { const current = this.repository.grant(grant.workspaceId); return Boolean(current && JSON.stringify(current) === JSON.stringify(grant) && realpathSync(grant.root) === grant.root) } catch { return false }
  }
  status(): DaemonStatus {
    const jobs = this.repository.allJobs()
    const intent = this.repository.startupIntent()
    let startupRegistration: 'confirmed' | 'unknown' | 'unavailable' = intent ? 'unknown' : 'confirmed'
    if (!intent && this.context.identity.mode === 'production') {
      try { if (!new WindowsDaemonStartup(this.context).verify(this.repository.preferences().startup === 'login')) startupRegistration = 'unknown' }
      catch { startupRegistration = 'unavailable' }
    }
    return { protocol: 1, epoch: this.lease.epoch, identity: this.context.identity, owner: this.context.owner,
      state: this.stopping ? 'stopping' : 'running', runtimeAuthority: this.domains?.ready() ? 'daemon' : 'legacy', settingsAuthority: this.settings.authority(),
      preferences: this.repository.preferences(), eventCursor: this.repository.cursor(), activeJobs: jobs.filter(activeJob).length,
      unknownJobs: jobs.filter((job) => job.state === 'unknown').length, capabilities: this.domains?.ready() ? ['foundation', 'integration-jobs', 'runtime-control', 'native-protection', 'push-events'] : ['foundation', 'native-protection', 'push-events'],
      startupRegistration, ...(intent ? { startupCommandId: intent.commandId } : {}) }
  }
  private workspace(request: DaemonRequest): WorkspaceGrant {
    const supplied = request.workspace
    const actual = supplied ? this.repository.grant(supplied.workspaceId) : null
    if (!supplied || !actual || supplied.grantId !== actual.grantId || supplied.revision !== actual.revision || supplied.root !== actual.root) throw new DaemonError('E_DENIED', 'The workspace grant is missing, stale or root-mismatched.')
    if (realpathSync(actual.root) !== actual.root) throw new DaemonError('E_CONFLICT', 'The authorized workspace root was redirected. Reauthorize its original identity.')
    return actual
  }
  async dispatch(request: DaemonRequest, actor: ProcessOwner): Promise<unknown> {
    assertLease(this.context, this.lease)
    if (request.expectedEpoch !== this.lease.epoch) throw new DaemonError('E_CONFLICT', 'Daemon epoch changed. Reconnect and inspect the original command receipt.')
    const mutating = MUTATING_DAEMON_METHODS.includes(request.method)
    if (mutating && !request.commandId) throw new DaemonError('E_INVALID_ARG', 'Mutations require a stable commandId.')
    if (this.stopping && mutating && request.method !== 'daemon.stop') throw new DaemonError('E_UNAVAILABLE', 'Daemon is stopping. Inspect the retained command receipt.')
    if (request.workspace) this.workspace(request)
    if (this.domains?.handles(request.method)) return this.domains.dispatch(request, actor)
    if (mutating && request.method !== 'daemon.stop') {
      const committed = this.repository.committedResult(request)
      if (committed.found) return committed.data
    }
    switch (request.method) {
      case 'daemon.status': daemonPayloads[request.method].parse(request.payload); return this.status()
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
      case 'daemon.stop': {
        const input = daemonPayloads[request.method].parse(request.payload)
        if (!sameOwner(input.expectedOwner, this.context.owner)) throw new DaemonError('E_CONFLICT', 'The daemon owner changed before stop.')
        this.stopping = true
        this.scheduler.closeAdmission()
        await this.domains?.shutdown()
        await this.scheduler.shutdown()
        const result = this.repository.stopping(request)
        this.stopping = true; this.scheduler.closeAdmission()
        try { this.log.append('DAEMON_STOPPING') }
        catch { process.emitWarning('Daemon stop was accepted, but its diagnostic log could not be saved.', { code: 'TRELLIS_DAEMON_LOG_UNAVAILABLE' }) }
        this.requestStop()
        return result
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
        return { status: this.status(), workspace, jobs: workspace ? this.repository.jobs(workspace.workspaceId).filter(activeJob) : [], cursor: this.repository.cursor() }
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
