import { join } from 'node:path'
import type { WorkspaceGrant } from '../../../../shared/daemon'
import type { DaemonRepository } from '../../../daemon/repository'
import type { IntegrationScheduler } from '../../../daemon/scheduler'
import type { IntegrationRegistry } from '../registry'
import type { IntegrationAccountPort, IntegrationSyncPort, IntegrationWorkPort } from '../work-ports'
import { createJiraTaskPort } from './lib/local-tasks'
import { JiraWorkspaceRepository } from './repository'
import { JiraWorkspaceWorker } from './work'
import { JiraWorkspaceService } from './procedures/workspace'
import { createJiraIntegrationBridge } from './bridge'
import { JiraRemote } from './lib/remote'
import { JiraWorkspaceError, sameGrant, type JiraCallbackPort, type JiraLocalSnapshot, type JiraWorkspaceAuthority } from './types'
import type { JiraBusinessHookPort } from './business-hooks'

export interface JiraWorkspaceComposition {
  stateDirectory: string
  profileId: string
  assertOwner(): void
  authority: JiraWorkspaceAuthority
  ledger: DaemonRepository
  scheduler: IntegrationScheduler
  callbacks?: JiraCallbackPort
  /** Must reject any later source links, workflow/session ownership or task activation. */
  assertTaskRemovable?: (grant: WorkspaceGrant, task: JiraLocalSnapshot) => void
  businessHooks?: JiraBusinessHookPort
}
export function createJiraWorkspace(input: JiraWorkspaceComposition) {
  const repository = new JiraWorkspaceRepository(join(input.stateDirectory, 'jira-workspace'), input.assertOwner)
  const worker = new JiraWorkspaceWorker(repository, input.authority, createJiraTaskPort(input.authority, input.assertTaskRemovable), input.businessHooks)
  let installedRegistry: IntegrationRegistry | null = null
  const assertInstalled = (): void => { input.assertOwner(); if (!installedRegistry || installedRegistry.get('jira').work !== work) throw new JiraWorkspaceError('E_UNAVAILABLE', 'Jira native work/account/sync ports are not installed in the daemon registry.') }
  const service = new JiraWorkspaceService(repository, worker, input.authority, input.ledger, input.scheduler, input.profileId, assertInstalled, input.callbacks)
  const work: IntegrationWorkPort = {
    supports: (kind) => worker.supports(kind),
    dispatch: async (dispatch) => {
      // The common scheduler admitted/dispatched the job. Enter running in that same ledger.
      const job = input.ledger.transition(dispatch.job.id, dispatch.job.revision, dispatch.job.ownerEpoch, 'running', null)
      return worker.dispatch({ ...dispatch, job })
    },
    reconcile: (request) => worker.reconcile(request)
  }
  const accounts: IntegrationAccountPort = {
    async list(connection) {
      const entries = repository.read().accounts.filter((entry) => entry.account.connectionId === connection.public.id)
      return entries.map((entry) => ({ ...entry.account, state: entry.instanceId === connection.instanceId && entry.connectionRevision === connection.public.revision ? entry.account.state : 'unverified' as const }))
    }
  }
  const sync: IntegrationSyncPort = {
    async validate(plan, connection) {
      const retained = repository.read().plans.find((entry) => entry.value.plan.id === plan.id && entry.value.plan.revision === plan.revision)
      if (!retained || plan.target.profileId !== input.profileId || !sameGrant(retained.workspace, input.ledger.grant(plan.target.workspaceId) ?? { ...retained.workspace, grantId: '' }) || connection.public.id !== plan.source.connectionId || connection.instanceId !== plan.source.instanceId || connection.public.revision !== plan.source.connectionRevision) return { supported: false, reason: 'Native source/workspace or retained mapping revision is unavailable.' }
      const permissions = await new JiraRemote(connection).permissions(plan.source.remoteProjectId)
      return { supported: permissions.BROWSE_PROJECTS === true, reason: permissions.BROWSE_PROJECTS ? 'Jira REST v2 project access verified; individual write screens remain issue-scoped.' : 'Jira project browsing permission is denied.' }
    }
  }
  return { api: createJiraIntegrationBridge(service), createClientApi: (clientSignal: AbortSignal) => createJiraIntegrationBridge(service, clientSignal), installedIn: (registry: IntegrationRegistry) => { installedRegistry = registry }, service, work, accounts, sync, pollDue: (run: Parameters<JiraWorkspaceService['pollDue']>[0]) => service.pollDue(run), admitCallback: (event: Parameters<JiraWorkspaceService['admitCallback']>[0]) => service.admitCallback(event) }
}
export type JiraWorkspaceRuntime = ReturnType<typeof createJiraWorkspace>
/** Extend the already registered connector without replacing its legacy task-source port. */
export function installJiraWorkspacePorts(registry: IntegrationRegistry, runtime: JiraWorkspaceRuntime): void {
  const provider = registry.get('jira')
  if (provider.work && provider.work !== runtime.work) throw new Error('A Jira work owner is already installed')
  provider.accounts = runtime.accounts; provider.sync = runtime.sync; provider.work = runtime.work
  runtime.installedIn(registry)
}
export type { JiraWorkspaceAuthority, JiraCallbackPort, JiraLocalSnapshot } from './types'
export { JiraWorkspaceError } from './types'
