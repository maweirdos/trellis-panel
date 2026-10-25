import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { runtimeRequests, type RuntimeMethod } from '../../shared/daemon-runtime'
import { nativeStateRequests } from '../../shared/native-state'
import { providerWireContracts } from '../../shared/daemon-domains'
import { JIRA_DAEMON } from '../../shared/jira-integration'
import { runtimeWireSchema } from '../../shared/daemon-runtime'
import { legacyIntegrationRequestSchema, legacyIntegrationResultSchema, LEGACY_INTEGRATION_MUTATIONS } from '../../shared/integration-native'
import { createLegacyIntegrationActions } from './integration-legacy'
import { ProviderCancellation } from './provider-cancellation'
import type { DaemonRequest } from '../../shared/daemon'
import { integrationRegistry } from '../services/integrations/providers'
import type { IntegrationAdmissionPort } from '../services/integrations/work-ports'
import type { DaemonContext } from './context'
import { activeJob, type DaemonRepository } from './repository'
import { probeWorkspaceAdmissions } from '../services/workflow-admission'
import type { ProtectedSettingsOwner } from './settings-owner'
import type { IntegrationScheduler } from './scheduler'
import type { DaemonDomainPort } from './domain-port'
import { DaemonNativeState } from './native-state'
import { createNativeStateActions } from './native-state-actions'
import { nativeReleaseDrain } from './cutover'
import { createDaemonRuntime, type DaemonRuntime } from './runtime'
import { RuntimeCommands } from './runtime/commands'
import { ProviderDomain } from './provider-domain'
import { DaemonWorkspaceScope } from './workspace-scope'
import { installJiraDomain } from './jira'
import { installGitlabDomain } from './gitlab'
import { installDingTalkDomain } from './dingtalk-domain'
import { DaemonError } from './errors'

export interface DaemonApplicationInput {
  context: DaemonContext; repository: DaemonRepository; settings: ProtectedSettingsOwner
  assertOwner(): void
}
/** The composition root owns adapters; their services receive ports, not GUI globals. */
export function createDaemonApplication(input: DaemonApplicationInput) {
  const { context, repository, settings, assertOwner } = input
  const nativeState = new DaemonNativeState(context, settings)
  const cancellation = new ProviderCancellation()
  const stateActions = createNativeStateActions(context, settings, nativeState)
  let initialized = false, closed = false, compositionStarted = false, initializing: Promise<void> | undefined
  let runtime: DaemonRuntime | undefined, providers: ProviderDomain | undefined, scope: DaemonWorkspaceScope | undefined
  let jira: ReturnType<typeof installJiraDomain> | undefined, gitlab: ReturnType<typeof installGitlabDomain> | undefined
  let dingtalk: ReturnType<typeof installDingTalkDomain> | undefined
  let providerCommands: RuntimeCommands | undefined, scheduler: IntegrationScheduler | undefined
  let legacy: ReturnType<typeof createLegacyIntegrationActions> | undefined
  let polling: Promise<void> | undefined
  let idleProbe: symbol | undefined
  let operations = 0
  const runtimeObservers = new Set<(event: { root: string }) => void>()
  let disposeRuntimeObserver: (() => void) | undefined
  const rollbackRoots = new Set<string>()
  const changingRoots = new Set<string>()
  const assertAdmission = (): void => {
    assertOwner()
    if (closed) throw new DaemonError('E_UNAVAILABLE', 'Native application admission is closed.')
    if (idleProbe) throw new DaemonError('E_BUSY', 'Native application is checking idle shutdown; no new work was admitted.')
  }
  const assertReady = (): void => { assertOwner(); if (closed || !initialized || settings.authority() !== 'daemon') throw new DaemonError('E_UNAVAILABLE', 'Native settings/runtime cutover is not ready.') }
  const admission: IntegrationAdmissionPort = { async resolve(grant, source) {
    assertAdmission()
    assertReady(); scope?.assert(grant)
    if (rollbackRoots.has(grant.root) || changingRoots.has(grant.root)) throw new DaemonError('E_BUSY', 'Native workspace ownership change has closed job admission.')
    if (source.providerId === 'jira' && jira) return jira.authority.resolve(grant, source)
    if (source.providerId === 'gitlab' && gitlab) return gitlab.admission.resolve(grant, source)
    throw new DaemonError('E_UNAVAILABLE', 'The requested durable work provider is not installed.')
  } }
  async function initialize(): Promise<void> {
    assertAdmission()
    if (closed) throw new DaemonError('E_UNAVAILABLE', 'Native composition admission is closed.')
    if (initialized) return
    if (initializing) return initializing
    const pending = (async () => {
      assertOwner()
      if (!scheduler || settings.authority() !== 'daemon') throw new DaemonError('E_UNAVAILABLE', 'Complete native settings preparation before execution admission.')
      await nativeState.prepare()
      assertOwner()
      if (closed) throw new DaemonError('E_UNAVAILABLE', 'Native composition was closed during preparation.')
      nativeState.initialize()
      compositionStarted = true
      nativeState.install()
      scope = new DaemonWorkspaceScope(repository, assertOwner)
      legacy = createLegacyIntegrationActions(scope)
      // Authority becomes available only after all adapters are installed below.
      runtime = createDaemonRuntime({ epoch: repository.epoch, directory: context.directory, assertOwner, assertAuthority: assertReady, assertAdmission, assertWorkspaceAdmission(root, method) { assertAdmission(); const grant = scope?.current(); if (grant) scope?.assert(grant); if ((rollbackRoots.size || changingRoots.size) && !['runtime.cancel', 'runtime.end', 'runtime.workflow.stop'].includes(method)) throw new DaemonError('E_BUSY', 'Native workspace ownership change has closed execution admission.') } })
      disposeRuntimeObserver = runtime.observe(event => { for (const observer of runtimeObservers) { try { observer({ root: event.root }) } catch { /* An observer never owns execution. */ } } })
      providerCommands = new RuntimeCommands(join(context.directory, 'provider-commands'), repository.epoch, assertOwner)
      providers = new ProviderDomain(runtime, providerCommands, cancellation)
      const ports = { context, repository, scheduler, scope, domain: providers, assertOwner }
      jira = installJiraDomain({ ...ports, assertTaskRemovable(grant) { scope?.assert(grant); if (!rollbackRoots.has(grant.root)) throw new DaemonError('E_DENIED', 'Task removal requires exclusive native workspace admission and a verified idle RuntimeHost.') } }); gitlab = installGitlabDomain(ports)
      dingtalk = installDingTalkDomain({ context, assertOwner, scope, runtime, domain: providers, currentGrant: id => repository.grant(id), assertAdmission(grant) { assertAdmission(); if (rollbackRoots.has(grant.root) || changingRoots.has(grant.root)) throw new DaemonError('E_BUSY', 'Native task intake is closed for a protected workspace ownership change.') } })
      initialized = true
    })()
    initializing = pending
    try { await pending }
    catch (error) {
      // Key/CAS preparation before port installation may be retried under the
      // original owner. Partial composition must never install another runtime.
      if (!compositionStarted && initializing === pending) initializing = undefined
      throw error
    }
    finally { if (initializing === pending) initializing = undefined }
  }
  const domains: DaemonDomainPort = {
    observeRuntime(listener) { runtimeObservers.add(listener); return () => { runtimeObservers.delete(listener) } },
    async withWorkspaceChange(grant, change) {
      assertAdmission()
      if (rollbackRoots.has(grant.root) || changingRoots.has(grant.root)) throw new DaemonError('E_BUSY', 'Another native operation owns this workspace admission.')
      changingRoots.add(grant.root)
      try {
        if (dingtalk?.hasActiveWork() || providerCommands?.count(grant.root) || await runtime?.ownsWorkspace(grant.root)) throw new DaemonError('E_CONFLICT', 'Original runtime/provider operations still own this grant; replacement or revocation is blocked.')
        return change()
      } finally { changingRoots.delete(grant.root) }
    },
    ready: () => initialized && !closed,
    handles: method => method in nativeStateRequests || method in runtimeRequests || method in providerWireContracts || method === 'integration.execute' || method === 'provider.read.cancel',
    async dispatch(request, actor) {
      assertAdmission()
      operations++
      try { return await (async () => {
        assertOwner()
        if (request.method === 'native.state') return stateActions.snapshot()
        if (request.method === 'native.prepare') {
          const value = nativeStateRequests['native.prepare'].parse(request.payload)
          if (!request.commandId) throw new DaemonError('E_INVALID_ARG', 'Native preparation requires the original migration command ID.')
          const drain = nativeReleaseDrain(context, actor, request.commandId, value.releaseId)
          await settings.migrate({ commandId: request.commandId, legacyOwner: drain.original.owner }, drain)
          await initialize()
          return { phase: 'daemon' as const, revision: settings.read().revision }
        }
        await initialize(); assertReady()
        if (request.method === 'native.ready') { nativeStateRequests['native.ready'].parse(request.payload); return { ready: true as const } }
        if (request.method === 'provider.read.cancel') return cancellation.cancel(actor, request.workspace, request.payload)
        if (request.method === 'native.settings.write') return stateActions.write(nativeStateRequests['native.settings.write'].parse(request.payload), request.commandId)
        if (!runtime || !scope || !providers) throw new DaemonError('E_UNAVAILABLE', 'Native composition is incomplete.')
        if (request.method === 'native.provider.command') return providerCommands?.inspect(request.workspace?.root ?? '@profile', nativeStateRequests['native.provider.command'].parse(request.payload).commandId)
        if (request.workspace && (rollbackRoots.has(request.workspace.root) || changingRoots.has(request.workspace.root))) throw new DaemonError('E_BUSY', 'A native ownership operation owns this workspace admission; reload after it settles.')
        if (request.method === 'integration.execute') {
          if (closed || !legacy || !providerCommands) throw new DaemonError('E_UNAVAILABLE', 'Native integration admission is closed.')
          const root = request.workspace?.root ?? '@profile'
          const body = legacyIntegrationRequestSchema.parse(runtime.unpack(root, runtimeWireSchema.parse(request.payload)))
          const owner = legacy, nativeRuntime = runtime
          const action = async () => nativeRuntime.pack(root, legacyIntegrationResultSchema.parse(await scope?.run(request.workspace ?? null, () => owner.dispatch(body, AbortSignal.timeout(5 * 60_000), actor))))
          if (LEGACY_INTEGRATION_MUTATIONS.includes(body.operation)) {
            if (!request.commandId) throw new DaemonError('E_INVALID_ARG', 'Integration mutations require the original command ID.')
            return providerCommands.run(root, request.commandId, request.method, body, action)
          }
          return action()
        }
        if (request.method in runtimeRequests) {
          const method = request.method as RuntimeMethod
          return scope.run(request.workspace ?? null, () => runtime?.dispatch(method, runtimeRequests[method].parse(request.payload), request))
        }
        if (closed) throw new DaemonError('E_UNAVAILABLE', 'Provider admission is closed for native shutdown.')
        if (request.method === JIRA_DAEMON.rollback) {
          const grant = request.workspace
          if (!grant) throw new DaemonError('E_DENIED', 'Protected rollback requires its native workspace grant.')
          rollbackRoots.add(grant.root)
          try {
            if (dingtalk?.hasActiveWork() || providerCommands?.count(grant.root) || repository.jobs(grant.workspaceId).some(job => ['queued', 'dispatched', 'running', 'cancel-requested', 'unknown'].includes(job.state)) || await runtime.ownsWorkspace(grant.root)) throw new DaemonError('E_CONFLICT', 'Native sessions, workflows, provider jobs or pending operations still own this workspace; rollback is blocked.')
            return await scope.run(grant, () => providers?.dispatch(request, actor))
          } finally { rollbackRoots.delete(grant.root) }
        }
        return scope.run(request.workspace ?? null, () => providers?.dispatch(request, actor))
      })() } finally { operations-- }
    },
    async poll() {
      if (!initialized || closed || idleProbe || polling || !jira || !gitlab) return
      const currentJira = jira, currentGitlab = gitlab
      polling = (async () => {
        const results = await Promise.allSettled([
          dingtalk?.poll(),
          currentJira.jira.pollDue((grant, action) => scope ? scope.run(grant, action) : Promise.reject(new DaemonError('E_UNAVAILABLE', 'Native workspace scope is unavailable.'))),
          currentGitlab.poll(binding => repository.grant(binding.plan.target.workspaceId))
        ])
        if (results.some(result => result.status === 'rejected')) throw new DaemonError('E_UNAVAILABLE', 'An optional integration worker needs attention; other workers were still serviced.')
      })()
      try { await polling } finally { polling = undefined }
    },
    async shutdownIfIdle() {
      assertAdmission()
      // These fences are acquired synchronously before inspecting any owners or
      // yielding. Refusal removes only these tokens, never permanent admission.
      const probe = Symbol('idle-shutdown')
      idleProbe = probe
      const workflows = probeWorkspaceAdmissions()
      const ding = dingtalk?.probeIdle()
      let stopped = false
      try {
        const assertIdle = (): void => {
          assertOwner()
          if (closed || !initialized || !runtime || !scheduler || initializing || polling || operations || rollbackRoots.size || changingRoots.size
            || scheduler.hasRunning() || repository.allJobs().some(activeJob) || providerCommands?.count() || dingtalk?.hasActiveWork() || ding?.busy() || workflows.busy()) throw new DaemonError('E_BUSY', 'Original native application work, initialization, polling or admission is still active; idle-only shutdown was refused.')
        }
        assertIdle()
        // Healthy ready connections are allowed. The real RuntimeHost checks
        // active/preparing/cleanup/unfinished facts and pending operations.
        const nativeRuntime = runtime
        if (!nativeRuntime) throw new DaemonError('E_BUSY', 'Native runtime ownership has not been established.')
        await nativeRuntime.assertIdle()
        assertIdle()
        // No await between the final owner check and canonical admission close.
        // Once shutdown begins, failures retain its fences and original owner.
        try { await domains.shutdown() }
        catch { throw new DaemonError('E_UNKNOWN', 'Idle shutdown began, but canonical native release was not confirmed. Preserve the original stop command and owner.', 'unknown') }
        stopped = true
      } finally {
        if (!closed || stopped) {
          workflows.release(); ding?.release()
          if (idleProbe === probe) idleProbe = undefined
        }
      }
    },
    async shutdown() {
      closed = true; scheduler?.closeAdmission()
      cancellation.close()
      legacy?.shutdown()
      await dingtalk?.closeAdmission()
      runtime?.closeAdmission()
      // An optional polling failure is not evidence that native execution has
      // stopped, and must not prevent attempting its actual shutdown below.
      await polling?.catch(() => { process.emitWarning('An optional provider poll failed while shutdown was waiting.', { code: 'TRELLIS_PROVIDER_POLL_FAILED' }) })
      for (const job of repository.allJobs().filter(value => value.state === 'queued')) {
        const workspace = repository.admission(job.id)
        if (!workspace) throw new DaemonError('E_UNKNOWN', 'Queued provider work lost its original admission.', 'unknown')
        const request: DaemonRequest = { type: 'request', version: 1, requestId: randomUUID(), commandId: randomUUID(), expectedEpoch: repository.epoch, method: 'jobs.cancel', workspace, payload: { id: job.id, revision: job.revision } }
        repository.cancel(request, job.id, job.revision, workspace)
      }
      await runtime?.shutdown()
      disposeRuntimeObserver?.(); runtimeObservers.clear()
      await dingtalk?.shutdown()
      await providerCommands?.drain()
    }
  }
  return { registry: integrationRegistry, admission, domains, async start(value: IntegrationScheduler) { scheduler = value; if (settings.authority() === 'daemon') await initialize() } }
}
