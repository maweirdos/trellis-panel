/**
 * 文档读取 IPC：peek/文档面板读取任务目录内的 markdown 文档。
 * 路径防逃逸：目标必须位于项目根内。
 */
import { resolve, sep } from 'path'
import { ipcInvoke } from '../../shared/ipc-channels'
import { readTextWithMtime } from '../services/scan'
import { getProjectRoot } from '../state'
import { handle } from './registry'

export function registerDocsIpc(): void {
  handle(ipcInvoke.doc.read, (_e, path: string) => {
    const root = getProjectRoot()
    if (!root) return { ok: false, error: '未打开项目' }
    const target = resolve(String(path))
    if (!target.startsWith(resolve(root) + sep)) return { ok: false, error: '路径超出项目范围' }
    return readTextWithMtime(target)
  })
}
