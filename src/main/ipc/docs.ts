/**
 * 文档小窗 IPC：置顶只读文档窗的打开/读取/置顶切换。
 * 窗口创建与生命周期归 index.ts（经 WindowDeps 注入），本模块只做校验与转发。
 */
import { BrowserWindow } from 'electron'
import { resolve, sep } from 'path'
import { ipcInvoke } from '../../shared/ipc-channels'
import { readTextWithMtime } from '../services/scan'
import { getProjectRoot } from '../state'
import { handle } from './registry'
import type { WindowDeps } from './deps'

export function registerDocsIpc(deps: WindowDeps): void {
  handle(ipcInvoke.doc.open, (_e, opts: { key?: string; title?: string; file?: string }) => {
    const key = String(opts?.key ?? '')
    const file = String(opts?.file ?? '')
    if (!key || !file) return { ok: false, error: '参数缺失' }
    return deps.openDocWindow({ key, title: String(opts?.title ?? '文档'), file })
  })

  handle(ipcInvoke.doc.read, (_e, path: string) => {
    const root = getProjectRoot()
    if (!root) return { ok: false, error: '未打开项目' }
    const target = resolve(String(path))
    // 防逃逸：文档必须位于项目根内
    if (!target.startsWith(resolve(root) + sep)) return { ok: false, error: '路径超出项目范围' }
    return readTextWithMtime(target)
  })

  handle(ipcInvoke.doc.setPin, (e, on: boolean) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (win && !win.isDestroyed()) win.setAlwaysOnTop(Boolean(on), 'screen-saver')
    return { ok: true }
  })
}
