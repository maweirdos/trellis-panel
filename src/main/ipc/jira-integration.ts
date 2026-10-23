import { JIRA_INTEGRATION_CHANNELS as channels, type JiraIntegrationApi } from '../../shared/jira-integration'
import { handle } from './registry'
import { ipcFail } from '../../shared/ipc-errors'

export type JiraIpcClientFactory = (context: { senderId: number; signal: AbortSignal }) => JiraIntegrationApi
/** Main centrally declares channels and supplies a real sender-scoped daemon facade. */
export function registerJiraIntegrationIpc(createClient: JiraIpcClientFactory, isAllowed: (event: Electron.IpcMainInvokeEvent) => boolean): void {
  const clients = new Map<number, JiraIntegrationApi>()
  const client = (event: Electron.IpcMainInvokeEvent): JiraIntegrationApi => {
    const existing = clients.get(event.sender.id)
    if (existing) return existing
    const abort = new AbortController(); const api = createClient({ senderId: event.sender.id, signal: abort.signal })
    clients.set(event.sender.id, api)
    event.sender.once('destroyed', () => { abort.abort(); clients.delete(event.sender.id) })
    if (event.sender.isDestroyed()) abort.abort()
    return api
  }
  const run = async (event: Electron.IpcMainInvokeEvent, invoke: (api: JiraIntegrationApi) => Promise<unknown>): Promise<unknown> => {
    if (!isAllowed(event)) return ipcFail('E_DENIED', 'Jira 工作区仅允许原生主窗口访问。')
    try { return await invoke(client(event)) }
    catch { return ipcFail('E_UNAVAILABLE', 'Jira native client is unavailable. Reload retained job state before retrying a mutation.') }
  }
  handle(channels.context, (event, input) => run(event, (api) => api.context(input)))
  handle(channels.projects, (event, input) => run(event, (api) => api.projects(input)))
  handle(channels.selectProject, (event, input) => run(event, (api) => api.selectProject(input)))
  handle(channels.snapshot, (event, input) => run(event, (api) => api.snapshot(input)))
  handle(channels.discover, (event, input) => run(event, (api) => api.discover(input)))
  handle(channels.bindAccount, (event, input) => run(event, (api) => api.bindAccount(input)))
  handle(channels.savePlan, (event, input) => run(event, (api) => api.savePlan(input)))
  handle(channels.planState, (event, input) => run(event, (api) => api.planState(input)))
  handle(channels.catchUp, (event, input) => run(event, (api) => api.catchUp(input)))
  handle(channels.previewApi, (event, input) => run(event, (api) => api.previewApi(input)))
  handle(channels.previewCsv, (event, input) => run(event, (api) => api.previewCsv(input)))
  handle(channels.startImport, (event, input) => run(event, (api) => api.startImport(input)))
  handle(channels.history, (event, input) => run(event, (api) => api.history(input)))
  handle(channels.jobDetail, (event, input) => run(event, (api) => api.jobDetail(input)))
  handle(channels.cancel, (event, input) => run(event, (api) => api.cancel(input)))
  handle(channels.resume, (event, input) => run(event, (api) => api.resume(input)))
  handle(channels.rollback, (event, input) => run(event, (api) => api.rollback(input)))
  handle(channels.resolveConflict, (event, input) => run(event, (api) => api.resolveConflict(input)))
  handle(channels.reconcile, (event, input) => run(event, (api) => api.reconcile(input)))
  handle(channels.receiver, (event, input) => run(event, (api) => api.receiver(input)))
  handle(channels.localTasks, (event, input) => run(event, (api) => api.localTasks(input)))
  handle(channels.cancelRead, (event, input) => run(event, (api) => api.cancelRead(input)))
}
