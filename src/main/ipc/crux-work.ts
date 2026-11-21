import { app, dialog, type BrowserWindow } from 'electron'
import { AsyncLocalStorage } from 'node:async_hooks'
import { ipcInvoke } from '../../shared/ipc-channels'
import { IpcErrorCode, ipcFail } from '../../shared/ipc-errors'
import { CruxTaskWorkspaceService, type CruxTaskWorkspaceDependencies } from '../services/crux/task-workspace'
import { handle } from './registry'
import { createTaskMaterialInputs } from '../services/crux/task-material-inputs'
import { readTaskExecutionSource } from '../services/crux/task-execution-source'
import { createCruxTaskMaterialsService } from '../services/crux/task-materials'
import { readAgentAttachments } from '../services/crux/post-attachments'

export type CruxWorkIpcDependencies = Pick<CruxTaskWorkspaceDependencies, 'getProjectRoot' | 'getProjectGeneration' | 'creationReferences' | 'creationFiles' | 'taskCodeResource'> & { getMain(): BrowserWindow | null }

/** Register only in the native host. Supplemental browser hosting has no local-work bridge. */
export function registerCruxWorkIpc(deps: CruxWorkIpcDependencies): CruxTaskWorkspaceService {
  const teamInputs = createTaskMaterialInputs(app.getPath('userData'))
  const invocations = new AsyncLocalStorage<{ current(): boolean }>()
  const service = new CruxTaskWorkspaceService({
    ...deps, dataDir: app.getPath('userData'),
    readExecutionSource: (query, expected) => readTaskExecutionSource(query, expected, (scope, actorId, sources) =>
      readAgentAttachments(app.getPath('userData'), scope, actorId, sources, createCruxTaskMaterialsService(app.getPath('userData')).sourcePart,
        () => { if (!invocations.getStore()?.current()) throw Error('原任务窗口已变化') })),
    teamInputs: (query) => teamInputs.inputs(query),
    teamMaterialFiles: (query, references) => teamInputs.files(query, references),
    governanceFiles: (query, input) => teamInputs.governanceFiles(query, input),
    chooseProjectRoot: async ({ taskId }) => {
      const window = deps.getMain()
      if (!window || window.isDestroyed() || !invocations.getStore()?.current()) return null
      const result = await dialog.showOpenDialog(window, { title: `为 ${taskId} 选择本机开发工程`, properties: ['openDirectory'] })
      return result.canceled || !invocations.getStore()?.current() ? null : result.filePaths[0] ?? null
    },
    confirmProjectRoot: async (preview) => {
      const window = deps.getMain()
      if (!window || window.isDestroyed() || !invocations.getStore()?.current()) return false
      const response = await dialog.showMessageBox(window, {
        type: 'question', title: '确认任务的本机开发环境',
        message: `${preview.taskId} · ${preview.taskTitle}`,
        detail: [
          ...(preview.resource ? [`代码资源：${preview.resource.name}`, `仓库来源：${preview.resource.repositoryUrl}`] : []),
          `工程目录：${preview.root}`,
          ...(preview.git ? [
            `Git 仓库：${preview.git.repoRoot}`,
            `分支：${preview.git.branch ?? (preview.git.detached ? '分离 HEAD' : '尚无分支提交')}`,
            `代码状态：${preview.git.clean ? '无未提交更改' : '有未提交更改，将保留现有文件'}`
          ] : [`Git 状态未能核对：${preview.gitError ?? '不可用'}`]),
          '确认后仅准备本任务的开发材料，不启动 Agent、应用或切换分支。'
        ].join('\n'),
        buttons: ['取消', '确认绑定并准备'], defaultId: 0, cancelId: 0, noLink: true
      })
      return response.response === 1 && !window.isDestroyed() && Boolean(invocations.getStore()?.current())
    }
  })
  const register = (channel: string, mutation: boolean, operation: (input: unknown) => Promise<unknown>): void => {
    handle(channel, async (event, input: unknown) => {
      const window = deps.getMain(), frame = event.senderFrame
      if (!window || window.isDestroyed() || window.webContents !== event.sender || frame !== event.sender.mainFrame) return ipcFail(IpcErrorCode.Denied, '本机开发环境仅允许主窗口访问', { reason: 'access_locked' })
      let navigated = false
      const onNavigate = (_event: Electron.Event, _url: string, _inPlace: boolean, mainFrame: boolean): void => { if (mainFrame) navigated = true }
      const current = (): boolean => !navigated && !window.isDestroyed() && !event.sender.isDestroyed() && deps.getMain() === window && event.sender.mainFrame === frame
      event.sender.on('did-start-navigation', onNavigate)
      try {
        const result = await invocations.run({ current }, () => operation(input))
        return current() ? result : ipcFail(IpcErrorCode.Conflict, '原窗口已变化，请返回原任务核对操作结果', { reason: mutation ? 'outcome_unknown' : 'scope_changed', ...(mutation ? { outcomeUnknown: true } : {}) })
      } finally { if (!event.sender.isDestroyed()) event.sender.removeListener('did-start-navigation', onNavigate) }
    })
  }
  register(ipcInvoke.cruxWork.status, false, input => service.status(input))
  register(ipcInvoke.cruxWork.prepare, true, input => service.prepare(input))
  register(ipcInvoke.cruxWork.development, false, input => service.development(input))
  register(ipcInvoke.cruxWork.change, true, input => service.change(input))
  return service
}
