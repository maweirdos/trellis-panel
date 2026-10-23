import { JIRA_DAEMON, jiraRequests, jiraResults } from '../../shared/jira-integration'
import type { IntegrationSource } from '../../shared/integration-work'
import { createJiraWorkspace, installJiraWorkspacePorts, type JiraLocalSnapshot } from '../services/integrations/jira-workspace'
import { integrationRegistry } from '../services/integrations/providers'
import { resolveBinding, resolveConnection } from '../services/integrations/service'
import type { ResolvedConnection } from '../services/integrations/types'
import type { DaemonContext } from './context'
import type { DaemonRepository } from './repository'
import type { IntegrationScheduler } from './scheduler'
import type { DaemonWorkspaceScope } from './workspace-scope'
import type { ProviderDomain } from './provider-domain'
import { DaemonError } from './errors'

export function installJiraDomain(input: { context: DaemonContext; repository: DaemonRepository; scheduler: IntegrationScheduler; scope: DaemonWorkspaceScope; domain: ProviderDomain; assertOwner(): void; assertTaskRemovable(grant: Parameters<DaemonWorkspaceScope['assert']>[0], task: JiraLocalSnapshot): void }) {
  const { context, repository, scheduler, scope, domain, assertOwner } = input
  function binding(grant: Parameters<typeof scope.assert>[0], source: { connectionId: string; connectionRevision: number; bindingId: string; bindingRevision: number }): ResolvedConnection {
    return scope.run(grant, () => {
      const value = resolveBinding({ expectedRoot: grant.root, ...source })
      if (value.connection.public.providerId !== 'jira' || value.connection.public.id !== source.connectionId) throw new DaemonError('E_CONFLICT', 'The retained Jira binding points to another native connection.')
      return value.connection
    })
  }
  const authority = {
    context: async (root: string) => scope.capture(root),
    capture: async (value: { expectedRoot: string; workspaceId?: string }) => { const grant = scope.capture(value.expectedRoot); if (value.workspaceId && value.workspaceId !== grant.workspaceId) throw new DaemonError('E_DENIED', 'Jira workspace identity mismatch.'); return grant },
    assertGrant: scope.assert.bind(scope),
    resolve: async (grant: Parameters<typeof scope.assert>[0], source: IntegrationSource) => { const c = binding(grant, source); if (source.providerId !== 'jira' || c.instanceId !== source.instanceId) throw new DaemonError('E_CONFLICT', 'The retained Jira instance changed.'); return c },
    resolveBindingConnection: async (grant: Parameters<typeof scope.assert>[0], source: { connectionId: string; connectionRevision: number; bindingId: string; bindingRevision: number }) => binding(grant, source),
    resolvePersonalConnection: async (grant: Parameters<typeof scope.assert>[0], source: { connectionId: string; connectionRevision: number }) => { scope.assert(grant); const c = resolveConnection(source); if (c.public.providerId !== 'jira') throw new DaemonError('E_DENIED', 'Personal account must use a protected Jira connection.'); return c }
  }
  const jira = createJiraWorkspace({ stateDirectory: context.directory, profileId: context.identity.profileId, assertOwner, authority, ledger: repository, scheduler, assertTaskRemovable: input.assertTaskRemovable })
  installJiraWorkspacePorts(integrationRegistry, jira)
  const unwrap = <T>(result: { ok: true; data: T } | { ok: false; code: string; error: string }): T => {
    if (result.ok) return result.data
    throw new DaemonError(result.code === 'E_CONFLICT' ? 'E_CONFLICT' : result.code === 'E_DENIED' ? 'E_DENIED' : result.code === 'E_INVALID_ARG' ? 'E_INVALID_ARG' : result.code === 'E_UNAVAILABLE' ? 'E_UNAVAILABLE' : result.code === 'E_UNKNOWN' ? 'E_UNKNOWN' : 'E_IO', result.error, result.code === 'E_UNKNOWN' ? 'unknown' : 'not-admitted')
  }
  // The following entries are deliberately literal and schema paired.
  domain.add(JIRA_DAEMON.context, jiraRequests.context, jiraResults.context, async i => unwrap(await jira.api.context(i)))
  domain.add(JIRA_DAEMON.projects, jiraRequests.projects, jiraResults.projects, async i => unwrap(await jira.api.projects(i)))
  domain.add(JIRA_DAEMON.selectProject, jiraRequests.selectProject, jiraResults.selectProject, async i => unwrap(await jira.api.selectProject(i)))
  domain.add(JIRA_DAEMON.snapshot, jiraRequests.snapshot, jiraResults.snapshot, async i => unwrap(await jira.api.snapshot(i)))
  domain.add(JIRA_DAEMON.discover, jiraRequests.discover, jiraResults.discover, async i => unwrap(await jira.api.discover(i)))
  domain.add(JIRA_DAEMON.bindAccount, jiraRequests.bindAccount, jiraResults.bindAccount, async i => unwrap(await jira.api.bindAccount(i)))
  domain.add(JIRA_DAEMON.savePlan, jiraRequests.savePlan, jiraResults.savePlan, async i => unwrap(await jira.api.savePlan(i)))
  domain.add(JIRA_DAEMON.planState, jiraRequests.planState, jiraResults.planState, async i => unwrap(await jira.api.planState(i)))
  domain.add(JIRA_DAEMON.catchUp, jiraRequests.catchUp, jiraResults.catchUp, async i => unwrap(await jira.api.catchUp(i)))
  domain.add(JIRA_DAEMON.previewApi, jiraRequests.previewApi, jiraResults.previewApi, async i => unwrap(await jira.api.previewApi(i)))
  domain.add(JIRA_DAEMON.previewCsv, jiraRequests.previewCsv, jiraResults.previewCsv, async i => unwrap(await jira.api.previewCsv(i)))
  domain.add(JIRA_DAEMON.startImport, jiraRequests.startImport, jiraResults.startImport, async i => unwrap(await jira.api.startImport(i)))
  domain.add(JIRA_DAEMON.history, jiraRequests.history, jiraResults.history, async i => unwrap(await jira.api.history(i)))
  domain.add(JIRA_DAEMON.jobDetail, jiraRequests.jobDetail, jiraResults.jobDetail, async i => unwrap(await jira.api.jobDetail(i)))
  domain.add(JIRA_DAEMON.cancel, jiraRequests.cancel, jiraResults.cancel, async i => unwrap(await jira.api.cancel(i)))
  domain.add(JIRA_DAEMON.resume, jiraRequests.resume, jiraResults.resume, async i => unwrap(await jira.api.resume(i)))
  domain.add(JIRA_DAEMON.rollback, jiraRequests.rollback, jiraResults.rollback, async i => unwrap(await jira.api.rollback(i)))
  domain.add(JIRA_DAEMON.resolveConflict, jiraRequests.resolveConflict, jiraResults.resolveConflict, async i => unwrap(await jira.api.resolveConflict(i)))
  domain.add(JIRA_DAEMON.reconcile, jiraRequests.reconcile, jiraResults.reconcile, async i => unwrap(await jira.api.reconcile(i)))
  domain.add(JIRA_DAEMON.localTasks, jiraRequests.localTasks, jiraResults.localTasks, async i => unwrap(await jira.api.localTasks(i)))
  domain.add(JIRA_DAEMON.receiver, jiraRequests.receiver, jiraResults.receiver, async i => unwrap(await jira.api.receiver(i)))
  domain.add(JIRA_DAEMON.cancelRead, jiraRequests.cancelRead, jiraResults.cancelRead, async i => unwrap(await jira.api.cancelRead(i)))
  return { jira, authority }
}
