import { ipcEvent, ipcInvoke } from '../../shared/ipc-channels'
import { noProject } from '../../shared/ipc-errors'
import { getProjectRoot, getProjectGeneration } from '../state'
import {
  computeDocumentDiff,
  readDocument,
  onReaderDocumentChanged,
  unwatchReaderDocument,
  watchReaderDocument,
  clearReaderDocumentOwner
} from '../services/documents'
import { broadcastToWindows } from '../services/bridge'
import { handle } from './registry'

const watchedSenders = new Set<number>()

/**
 * 文档域 IPC（S0 G2）：documentRead / documentDiff / documentWatch 全链注册。
 * 授权以已打开工作区（项目根）为准；scope.workspaceId/taskRef 此阶段仅作
 * 缓存命名空间与回显（绑定校验在 G3）。文档级事实走诊断，不当错误伪装。
 *
 * 第三片：变更信号桥——change-bridge 的定向事件经此处统一转发广播
 * （backend/ipc-conventions：广播统一 broadcastToWindows，channel 取 ipcEvent）。
 */
export function registerDocumentsIpc(): void {
  handle(ipcInvoke.document.read, (_e, scope: unknown, input: unknown) => {
    const root = getProjectRoot()
    if (!root) return noProject()
    return readDocument(root, scope, input)
  })
  handle(ipcInvoke.document.diff, (_e, scope: unknown, input: unknown) => {
    const root = getProjectRoot()
    if (!root) return noProject()
    return computeDocumentDiff(root, scope, input)
  })
  handle(ipcInvoke.document.watch, (event, scope: unknown, input: unknown) => {
    const root = getProjectRoot()
    if (!root) return noProject()
    const ownerId = event.sender.id
    const result = watchReaderDocument(root, scope, input, { projectRoot: root, projectGeneration: getProjectGeneration(), ownerId })
    if (result.ok && !watchedSenders.has(ownerId)) {
      watchedSenders.add(ownerId)
      event.sender.once('destroyed', () => { watchedSenders.delete(ownerId); clearReaderDocumentOwner(ownerId) })
    }
    return result
  })
  handle(ipcInvoke.document.unwatch, (event, canonicalPath: unknown, watchId: unknown) => {
    if (typeof canonicalPath !== 'string' || canonicalPath.length === 0) return
    const root = getProjectRoot()
    if (!root || typeof watchId !== 'string' || watchId.length === 0) return
    unwatchReaderDocument(canonicalPath, watchId, { projectRoot: root, projectGeneration: getProjectGeneration(), ownerId: event.sender.id })
  })

  onReaderDocumentChanged((event) => broadcastToWindows(ipcEvent.documentChanged, event))
}
