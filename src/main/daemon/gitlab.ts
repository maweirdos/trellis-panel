import { randomUUID } from 'node:crypto'
import { GITLAB_DAEMON, gitlabRequests, gitlabResults } from '../../shared/gitlab-integration'
import type { DaemonRequest, WorkspaceGrant } from '../../shared/daemon'
import { installGitlabWorkspace, GitlabWorkspaceRepository, createGitlabTaskAdapter, authorizeGitlabWritesThroughOwner } from '../services/integrations/gitlab-workspace'
import { integrationRegistry } from '../services/integrations/providers'
import { resolveConnection } from '../services/integrations/service'
import { protectSecret } from '../services/integrations/credentials'
import { updateIntegrationState } from '../services/integrations/repository'
import { gitlabOAuthAccessToken } from '../services/integrations/providers/gitlab-authorization'
import { getGitlabAccessToken } from '../services/gitlab'
import { getSettings } from '../services/store'
import { scanProject } from '../services/scan'
import type { DaemonContext } from './context'
import type { DaemonRepository } from './repository'
import type { IntegrationScheduler } from './scheduler'
import type { DaemonWorkspaceScope } from './workspace-scope'
import type { ProviderDomain } from './provider-domain'
import { DaemonError } from './errors'

export function installGitlabDomain(input: { context: DaemonContext; repository: DaemonRepository; scheduler: IntegrationScheduler; scope: DaemonWorkspaceScope; domain: ProviderDomain; assertOwner(): void }) {
  const { context, repository, scheduler, scope, domain, assertOwner } = input
  const assertCurrent = async (connection: ReturnType<typeof resolveConnection>) => {
    assertOwner()
    const current = resolveConnection({ connectionId: connection.public.id, connectionRevision: connection.public.revision })
    if (current.public.providerId !== 'gitlab' || current.instanceId !== connection.instanceId) throw new DaemonError('E_CONFLICT', 'GitLab native credential authority changed.')
  }
  function request(method: 'jobs.enqueue' | 'jobs.cancel', workspace: WorkspaceGrant, payload: unknown, commandId: string): DaemonRequest {
    return { type: 'request', version: 1, requestId: randomUUID(), commandId, expectedEpoch: repository.epoch, method, workspace, payload }
  }
  const gitlab = installGitlabWorkspace(integrationRegistry, {
    repository: new GitlabWorkspaceRepository(context.directory, assertOwner),
    profileId: context.identity.profileId,
    workspace: async root => scope.capture(root), assertWorkspace: scope.assert.bind(scope),
    connection: async value => { assertOwner(); const c = resolveConnection(value); if (c.public.providerId !== 'gitlab') throw new DaemonError('E_DENIED', 'The connection is not a GitLab source.'); return c },
    credentials: { assertCurrent, async accessToken(connection) {
      await assertCurrent(connection)
      const oauth = connection.public.legacy || connection.public.config.authMethod === 'oauth2'
      const token = connection.public.legacy ? await getGitlabAccessToken(getSettings().gitlab) : oauth ? await gitlabOAuthAccessToken(connection) : connection.secrets.token
      if (!token) throw new DaemonError('E_DENIED', 'The protected GitLab credential is unavailable.')
      await assertCurrent(connection); return { token, oauth }
    } },
    tasks: createGitlabTaskAdapter(scope.assert.bind(scope), workspace => {
      scope.assert(workspace)
      const snapshot = scanProject(workspace.root)
      return { members: snapshot.developers.map(member => ({ id: member.name, name: member.name })), statuses: [...new Set(['planning', 'in_progress', 'review', 'completed', ...snapshot.tasks.map(task => task.record?.status).filter((value): value is string => Boolean(value))])].map(id => ({ id, name: id })) }
    }),
    async enqueue(workspace, source, work, commandId) {
      scope.assert(workspace); await scheduler.authorize(workspace, source, work); scope.assert(workspace)
      return repository.enqueue(request('jobs.enqueue', workspace, { source, input: work }, commandId), { source, input: work }, workspace)
    },
    async jobs(workspace, after) {
      scope.assert(workspace)
      const all = repository.jobs(workspace.workspaceId), offset = after ? all.findIndex(job => job.id === after) + 1 : 0
      if (after && offset === 0) throw new DaemonError('E_RESET_REQUIRED', 'Reload the original GitLab job page.')
      const items = all.slice(offset, offset + 30)
      return { items, next: offset + items.length < all.length ? items.at(-1)?.id ?? null : null }
    },
    async job(workspace, id) { scope.assert(workspace); return repository.job(id, workspace.workspaceId) },
    async cancel(workspace, job, commandId) { scope.assert(workspace); const current = repository.cancel(request('jobs.cancel', workspace, { id: job.id, revision: job.revision }, commandId), job.id, job.revision, workspace); scheduler.cancel(job.id); return current },
    async reconciled(workspace, job, evidenceRef) { scope.assert(workspace); repository.transition(job.id, job.revision, job.ownerEpoch, job.counts.failed ? 'partially-failed' : 'paused', evidenceRef) },
    authorizeWrites: (connection, signal) => authorizeGitlabWritesThroughOwner(connection, signal, { assertCurrent, async commit(c, secrets, detail) {
      await assertCurrent(c)
      return updateIntegrationState(state => {
        const stored = state.connections.find(item => item.id === c.public.id && !item.deleted && item.revision === c.public.revision)
        if (!stored) throw new DaemonError('E_CONFLICT', 'GitLab connection changed before protected authorization publication.')
        for (const [key, value] of Object.entries(secrets)) stored.secrets[key] = protectSecret(value)
        stored.revision++; stored.checkedAt = null; stored.check = 'unverified'; stored.detail = detail
        return stored.revision
      })
    } })
  })
  domain.add(GITLAB_DAEMON.snapshot, gitlabRequests.snapshot, gitlabResults.snapshot, (i, signal) => gitlab.actions.snapshot(i))
  domain.add(GITLAB_DAEMON.authorizeWrites, gitlabRequests.authorizeWrites, gitlabResults.authorizeWrites, (i, signal) => gitlab.actions.authorizeWrites(i, signal ?? AbortSignal.timeout(5 * 60_000)))
  domain.add(GITLAB_DAEMON.projects, gitlabRequests.projects, gitlabResults.projects, (i, signal) => gitlab.actions.projects(i, signal ?? AbortSignal.timeout(5 * 60_000)))
  domain.add(GITLAB_DAEMON.members, gitlabRequests.members, gitlabResults.members, (i, signal) => gitlab.actions.members(i, signal ?? AbortSignal.timeout(5 * 60_000)))
  domain.add(GITLAB_DAEMON.inspect, gitlabRequests.inspect, gitlabResults.inspect, (i, signal) => gitlab.actions.inspect(i, signal ?? AbortSignal.timeout(5 * 60_000)))
  domain.add(GITLAB_DAEMON.linkAccount, gitlabRequests.linkAccount, gitlabResults.linkAccount, (i, signal) => gitlab.actions.linkAccount(i, signal ?? AbortSignal.timeout(5 * 60_000)))
  domain.add(GITLAB_DAEMON.unlinkAccount, gitlabRequests.unlinkAccount, gitlabResults.unlinkAccount, (i, signal) => gitlab.actions.unlinkAccount(i, signal ?? AbortSignal.timeout(5 * 60_000)))
  domain.add(GITLAB_DAEMON.savePlan, gitlabRequests.savePlan, gitlabResults.savePlan, (i, signal) => gitlab.actions.savePlan(i, signal ?? AbortSignal.timeout(5 * 60_000)))
  domain.add(GITLAB_DAEMON.setPlanState, gitlabRequests.setPlanState, gitlabResults.setPlanState, (i, signal) => gitlab.actions.setPlanState(i, signal ?? AbortSignal.timeout(5 * 60_000)))
  domain.add(GITLAB_DAEMON.previewImport, gitlabRequests.previewImport, gitlabResults.previewImport, (i, signal) => gitlab.actions.previewImport(i, signal ?? AbortSignal.timeout(5 * 60_000)))
  domain.add(GITLAB_DAEMON.startImport, gitlabRequests.startImport, gitlabResults.startImport, (i, signal) => gitlab.actions.startImport(i, signal ?? AbortSignal.timeout(5 * 60_000)))
  domain.add(GITLAB_DAEMON.catchUp, gitlabRequests.catchUp, gitlabResults.catchUp, (i, signal) => gitlab.actions.catchUp(i, signal ?? AbortSignal.timeout(5 * 60_000)))
  domain.add(GITLAB_DAEMON.jobs, gitlabRequests.jobs, gitlabResults.jobs, (i, signal) => gitlab.actions.jobs(i, signal ?? AbortSignal.timeout(5 * 60_000)))
  domain.add(GITLAB_DAEMON.cancelJob, gitlabRequests.cancelJob, gitlabResults.cancelJob, (i, signal) => gitlab.actions.cancelJob(i, signal ?? AbortSignal.timeout(5 * 60_000)))
  domain.add(GITLAB_DAEMON.reconcileJob, gitlabRequests.reconcileJob, gitlabResults.reconcileJob, (i, signal) => gitlab.actions.reconcileJob(i, signal ?? AbortSignal.timeout(5 * 60_000)))
  domain.add(GITLAB_DAEMON.resolveConflict, gitlabRequests.resolveConflict, gitlabResults.resolveConflict, (i, signal) => gitlab.actions.resolveConflict(i, signal ?? AbortSignal.timeout(5 * 60_000)))
  domain.add(GITLAB_DAEMON.recoverHook, gitlabRequests.recoverHook, gitlabResults.recoverHook, (i, signal) => gitlab.actions.recoverHook(i, signal ?? AbortSignal.timeout(5 * 60_000)))
  domain.add(GITLAB_DAEMON.createIssue, gitlabRequests.createIssue, gitlabResults.createIssue, (i, signal) => gitlab.actions.createIssue(i, signal ?? AbortSignal.timeout(5 * 60_000)))
  domain.add(GITLAB_DAEMON.addComment, gitlabRequests.addComment, gitlabResults.addComment, (i, signal) => gitlab.actions.addComment(i, signal ?? AbortSignal.timeout(5 * 60_000)))
  domain.add(GITLAB_DAEMON.issueDetail, gitlabRequests.issueDetail, gitlabResults.issueDetail, (i, signal) => gitlab.actions.issueDetail(i, signal ?? AbortSignal.timeout(5 * 60_000)))
  domain.add(GITLAB_DAEMON.localTasks, gitlabRequests.localTasks, gitlabResults.localTasks, (i, signal) => gitlab.actions.localTasks(i, signal ?? AbortSignal.timeout(5 * 60_000)))
  return gitlab
}
