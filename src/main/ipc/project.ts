import { dialog } from 'electron'
import { ipcInvoke } from '../../shared/ipc-channels'
import { openProjectAt, closeProjectAt, getProjectRoot } from '../state'
import { scanProject } from '../services/scan'
import { handle } from './registry'
import type { WindowDeps } from './deps'

export function registerProjectIpc(deps: WindowDeps): void {
  handle(ipcInvoke.project.pick, async () => {
    const win = deps.getMain()
    if (!win) return null
    const res = await dialog.showOpenDialog(win, {
      title: '选择 Trellis 项目文件夹',
      properties: ['openDirectory']
    })
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]
  })

  handle(ipcInvoke.project.open, (_e, root: string) => openProjectAt(String(root ?? '')))

  handle(ipcInvoke.project.snapshot, () => {
    const root = getProjectRoot()
    if (!root) return null
    try {
      return scanProject(root)
    } catch {
      return null
    }
  })

  handle(ipcInvoke.project.close, () => {
    closeProjectAt()
  })
}
