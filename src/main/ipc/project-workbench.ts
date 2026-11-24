import { app, dialog, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { ipcInvoke } from '../../shared/ipc-channels'
import { ipcFail, IpcErrorCode, type IpcFail } from '../../shared/ipc-errors'
import { projectWorkbenchInputSchema } from '../../shared/conversation/project-workbench'
import type { NativeConversationTask } from '../../shared/conversation/task-native'
import { getProjectGeneration, getProjectRoot } from '../state'
import { readConversationThread } from '../services/daemon-client/conversation'
import { checkedDirectory, pathKey } from '../services/private-conversations/files'
import { projectWorkbench, projectWorkbenchFailure } from '../services/project-workbench'
import { handle } from './registry'

interface WorkbenchScope {
  root: string
  matchesRoot(value: unknown): boolean
  isCurrent(): boolean
  task?: NativeConversationTask
}
type CaptureScope = (event: IpcMainInvokeEvent, cwd: string, task?: unknown) => WorkbenchScope | IpcFail | Promise<WorkbenchScope | IpcFail>

export function registerProjectWorkbenchIpc(getMain: () => BrowserWindow | null, captureScope: CaptureScope): void {
  handle(ipcInvoke.conversation.projectWorkbench, async (event, raw: unknown, ...extra: unknown[]) => {
    const parsed = projectWorkbenchInputSchema.safeParse(raw)
    if (!parsed.success || extra.length) return ipcFail(IpcErrorCode.InvalidArg, '项目工作台参数无效。')
    const input = parsed.data
    try {
      const selectedRoot = getProjectRoot()
      const generation = getProjectGeneration()
      const scope = await captureScope(event, input.cwd, input.task)
      if (!('root' in scope)) return scope
      const window = getMain()
      const isCurrent = () => Boolean(window && !window.isDestroyed() && scope.isCurrent())
      const canWrite = (): boolean => {
        if (!isCurrent() || scope.task || !selectedRoot || getProjectRoot() !== selectedRoot || getProjectGeneration() !== generation ||
          pathKey(scope.root) === pathKey(join(app.getPath('userData'), 'conversation-v2-workspace'))) return false
        try { return pathKey(checkedDirectory(selectedRoot)) === pathKey(scope.root) } catch { return false }
      }
      if (!scope.matchesRoot(input.cwd) || !isCurrent()) return ipcFail(IpcErrorCode.Conflict, '原项目页面已变化。')
      return await projectWorkbench(input, {
        root: scope.root, task: Boolean(scope.task), isCurrent, canWrite,
        readThread: () => readConversationThread(scope.root, input.threadId, isCurrent, scope.task),
        confirm: async (title, message, detail, button) => {
          if (!window || !isCurrent()) return false
          const response = await dialog.showMessageBox(window, {
            type: 'question', title, message, detail, buttons: ['取消', button], defaultId: 0, cancelId: 0, noLink: true,
          })
          return response.response === 1 && isCurrent()
        },
        openPath: path => shell.openPath(path),
        openExternal: url => shell.openExternal(url),
      })
    } catch (error) { return projectWorkbenchFailure(error) }
  })
}
