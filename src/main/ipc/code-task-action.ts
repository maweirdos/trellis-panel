import { app, type BrowserWindow } from 'electron'
import { isAbsolute, resolve } from 'node:path'
import { codeTaskActionChannel, codeTaskActionSchema } from '../../shared/conversation/code-task-action'
import { ipcFail, IpcErrorCode } from '../../shared/ipc-errors'
import { CodeConversationTaskActions } from '../services/conversation/code-task-action'
import { checkedDirectory, directoryIdentity, pathKey } from '../services/private-conversations/files'
import { captureAppWindowDocument } from '../services/window-navigation'
import { getProjectGeneration, getProjectRoot } from '../state'
import { handle } from './registry'

export function registerCodeTaskActionIpc(getMain: () => BrowserWindow | null): void {
  const actions = new CodeConversationTaskActions(app.getPath('userData'))
  handle(codeTaskActionChannel, async (event, raw: unknown, ...extra: unknown[]) => {
    const input = codeTaskActionSchema.safeParse(raw)
    if (!input.success || extra.length) return ipcFail(IpcErrorCode.InvalidArg, '本地任务关联参数无效。')
    const main = getMain()
    const document = main && captureAppWindowDocument(main, event)
    const selected = getProjectRoot()
    if (!main || !document || !selected) return ipcFail(IpcErrorCode.Denied, '请在 Code 中选择原工程。')
    const dataDir = app.getPath('userData')
    const generation = getProjectGeneration()
    try {
      const root = checkedDirectory(selected)
      if (!isAbsolute(input.data.cwd) || pathKey(resolve(input.data.cwd)) !== pathKey(root)) {
        return ipcFail(IpcErrorCode.Denied, '只能查看原 Code 工程中的本地任务。')
      }
      const rootIdentity = directoryIdentity(root)
      const current = (): void => {
        if (getMain() !== main || !document() || app.getPath('userData') !== dataDir ||
          getProjectGeneration() !== generation || getProjectRoot() !== selected || directoryIdentity(root) !== rootIdentity) {
          throw Error('原 Code 工程已变化，请回原会话核对。')
        }
      }
      const value = await actions.execute(input.data, root, rootIdentity, current)
      current()
      return { ok: true as const, value }
    } catch (error) {
      return ipcFail(IpcErrorCode.Conflict, error instanceof Error ? error.message : '本地任务关联结果待核对。')
    }
  })
}
