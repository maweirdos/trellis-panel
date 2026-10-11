import { ipcInvoke } from '../../shared/ipc-channels'
import { noProject } from '../../shared/ipc-errors'
import { getProjectRoot } from '../state'
import { readDocument } from '../services/documents'
import { handle } from './registry'

/**
 * 文档域 IPC（S0 G2）：documentRead 全链注册。
 * 授权以已打开工作区（项目根）为准；scope.workspaceId/taskRef 此阶段仅作
 * 缓存命名空间与回显（绑定校验在 G3）。文档级事实走诊断，不当错误伪装。
 */
export function registerDocumentsIpc(): void {
  handle(ipcInvoke.document.read, (_e, scope: unknown, input: unknown) => {
    const root = getProjectRoot()
    if (!root) return noProject()
    return readDocument(root, scope, input)
  })
}
