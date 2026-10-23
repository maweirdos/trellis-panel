import { z } from 'zod'
import { jiraRequests, jiraResults, type JiraIntegrationApi, type JiraResult } from '../../../../shared/jira-integration'
import { ipcFail } from '../../../../shared/ipc-errors'
import { JiraV2Error } from '../../jira'
import { JiraWorkspaceError, sameRoot } from './types'
import { JiraWorkspaceService } from './procedures/workspace'

function endpoint<I, O>(request: z.ZodType<I>, response: z.ZodType<O>, run: (input: I) => Promise<O>): (input: I) => Promise<JiraResult<O>> {
  return async (raw) => {
    const parsed = request.safeParse(raw)
    if (!parsed.success) return ipcFail('E_INVALID_ARG', parsed.error.issues[0]?.message ?? 'Invalid Jira workspace request.')
    try { return { ok: true, data: response.parse(await run(parsed.data)) } }
    catch (error) {
      if (error instanceof JiraWorkspaceError) return ipcFail(error.code, error.message)
      if (error instanceof JiraV2Error) return ipcFail(error.uncertain ? 'E_UNKNOWN' : error.status === 401 || error.status === 403 ? 'E_DENIED' : 'E_UPSTREAM', error.uncertain ? 'Jira write outcome is unknown. Reconcile the original operation before retrying.' : 'Jira REST v2 request failed. Check credentials, project permissions and instance compatibility.')
      if (error instanceof z.ZodError) return ipcFail('E_UPSTREAM', 'Jira/native data did not satisfy the expected bounded schema. No empty success was fabricated.')
      return ipcFail('E_IO', 'Jira operation did not confirm its outcome. Reload the retained job/receipt before another submission.')
    }
  }
}
/** Explicit native allowlist. The daemon host must expose these schemas/methods centrally. */
export function createJiraIntegrationBridge(service: JiraWorkspaceService, clientSignal?: AbortSignal): JiraIntegrationApi {
  // One bridge per authenticated native client/sender; request IDs cannot cancel another client.
  const reads = new Map<string, { expectedRoot: string; workspaceId?: string; abort: AbortController }>()
  async function read<I extends { requestId: string; expectedRoot: string; workspaceId?: string }, O>(input: I, run: (signal: AbortSignal) => Promise<O>): Promise<O> {
    if (reads.has(input.requestId)) throw new JiraWorkspaceError('E_CONFLICT', 'This client already owns the requested Jira read ID.')
    if (reads.size >= 4) throw new JiraWorkspaceError('E_BUSY', 'At most four transient Jira reads may run per native client.')
    const abort = new AbortController(); reads.set(input.requestId, { expectedRoot: input.expectedRoot, workspaceId: input.workspaceId, abort })
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(5 * 60_000), ...(clientSignal ? [clientSignal] : [])])
    try {
      const grant = await service.capture(input)
      signal.throwIfAborted(); reads.set(input.requestId, { expectedRoot: grant.root, workspaceId: grant.workspaceId, abort })
      return await run(signal)
    }
    finally { reads.delete(input.requestId) }
  }
  return {
    version: 1,
    context: endpoint(jiraRequests.context, jiraResults.context, (input) => service.context(input)),
    projects: endpoint(jiraRequests.projects, jiraResults.projects, (input) => read(input, (signal) => service.projects(input, signal))),
    selectProject: endpoint(jiraRequests.selectProject, jiraResults.selectProject, (input) => service.selectProject(input)),
    snapshot: endpoint(jiraRequests.snapshot, jiraResults.snapshot, (input) => service.snapshot(input)),
    discover: endpoint(jiraRequests.discover, jiraResults.discover, (input) => read(input, (signal) => service.discover(input, signal))),
    bindAccount: endpoint(jiraRequests.bindAccount, jiraResults.bindAccount, (input) => service.bindAccount(input)),
    savePlan: endpoint(jiraRequests.savePlan, jiraResults.savePlan, (input) => service.savePlan(input)),
    planState: endpoint(jiraRequests.planState, jiraResults.planState, (input) => service.planState(input)),
    catchUp: endpoint(jiraRequests.catchUp, jiraResults.catchUp, (input) => service.catchUp(input)),
    previewApi: endpoint(jiraRequests.previewApi, jiraResults.previewApi, (input) => read(input, (signal) => service.previewApi(input, signal))),
    previewCsv: endpoint(jiraRequests.previewCsv, jiraResults.previewCsv, (input) => read(input, (signal) => service.previewCsv(input, signal))),
    startImport: endpoint(jiraRequests.startImport, jiraResults.startImport, (input) => service.startImport(input)),
    history: endpoint(jiraRequests.history, jiraResults.history, (input) => service.history(input)),
    jobDetail: endpoint(jiraRequests.jobDetail, jiraResults.jobDetail, (input) => service.jobDetail(input)),
    cancel: endpoint(jiraRequests.cancel, jiraResults.cancel, (input) => service.cancel(input)),
    resume: endpoint(jiraRequests.resume, jiraResults.resume, (input) => service.resume(input)),
    rollback: endpoint(jiraRequests.rollback, jiraResults.rollback, (input) => service.rollback(input)),
    resolveConflict: endpoint(jiraRequests.resolveConflict, jiraResults.resolveConflict, (input) => service.resolveConflict(input)),
    reconcile: endpoint(jiraRequests.reconcile, jiraResults.reconcile, (input) => service.reconcile(input)),
    receiver: endpoint(jiraRequests.receiver, jiraResults.receiver, (input) => service.receiver(input)),
    localTasks: endpoint(jiraRequests.localTasks, jiraResults.localTasks, (input) => service.localTasks(input)),
    cancelRead: endpoint(jiraRequests.cancelRead, jiraResults.cancelRead, async (input) => {
      // Cleanup uses the original client/read owner, even after the GUI selected another project.
      const retained = reads.get(input.requestId)
      if (!retained || !sameRoot(retained.expectedRoot, input.expectedRoot) || input.workspaceId !== undefined && retained.workspaceId !== input.workspaceId) return { cancelled: false }
      retained.abort.abort(); return { cancelled: true }
    })
  }
}
