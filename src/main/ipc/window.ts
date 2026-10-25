import { BrowserWindow, screen } from 'electron'
import { resolve } from 'path'
import { ipcInvoke } from '../../shared/ipc-channels'
import { IpcErrorCode, ipcFail, noProject } from '../../shared/ipc-errors'
import { errorText } from '../../shared/errors'
import { getProjectGeneration, getProjectRoot, getSnapshot, pushFocusTask } from '../state'
import { on, handle } from './registry'
import type { WindowDeps } from './deps'
import { FLOATING_TASK_WINDOWS } from '../../shared/floating-window'

export function registerWindowIpc(deps: WindowDeps): void {
  handle(ipcInvoke.win.quit, event => {
    const main = deps.getMain()
    if (!main || main.isDestroyed() || main.webContents.isDestroyed() || event.sender !== main.webContents ||
      !event.senderFrame || event.senderFrame !== main.webContents.mainFrame) {
      return ipcFail(IpcErrorCode.Denied, '退出应用仅可由主窗口请求')
    }
    // Normal app.quit enters DaemonQuitGate. No bootstrap exit or daemon control.
    deps.quitApp()
    return { ok: true }
  })

  handle(ipcInvoke.win.openTask, (_e, expectedRoot: unknown, taskDir: unknown) => {
    const root = getProjectRoot()
    if (!root) return noProject()
    if (typeof expectedRoot !== 'string' || !expectedRoot.trim() || typeof taskDir !== 'string' ||
      !taskDir.trim() || taskDir === '.' || taskDir === '..' || /[\\/]/.test(taskDir)) {
      return ipcFail(IpcErrorCode.InvalidArg, '任务入口无效，请重新选择任务')
    }
    try {
      const requested = resolve(expectedRoot)
      const current = resolve(root)
      if (process.platform === 'win32' ? requested.toLowerCase() !== current.toLowerCase() : requested !== current) {
        return ipcFail(IpcErrorCode.Conflict, '项目已切换，请重新选择任务')
      }
      const snapshot = getSnapshot()
      if (snapshot?.meta.root !== root) return ipcFail(IpcErrorCode.Conflict, '项目正在切换，请稍后重试')
      const task = snapshot.tasks.find((item) => item.dirName === taskDir)
      if (!task) return ipcFail(IpcErrorCode.NotFound, '任务已移除或归档，请刷新后重试')
      const generation = getProjectGeneration()
      deps.showMain()
      if (root !== getProjectRoot() || generation !== getProjectGeneration()) {
        return ipcFail(IpcErrorCode.Conflict, '项目已切换，请重新选择任务')
      }
      pushFocusTask(task.dirName)
      return { ok: true }
    } catch (cause) {
      return ipcFail(IpcErrorCode.Unknown, errorText(cause, '打开任务失败'))
    }
  })

  on(ipcInvoke.win.capsule, (_e, onOff: boolean) => {
    if (onOff) {
      const cap = deps.getCapsule()
      if (cap) {
        cap.show()
        cap.focus()
        deps.getMain()?.hide()
      } else {
        deps.capsule.create()
      }
    } else {
      const cap = deps.getCapsule()
      if (cap) cap.hide()
      deps.showMain()
    }
  })

  handle(ipcInvoke.capsule.onTop, (_e, onOff: boolean) => {
    deps.capsule.setOnTop(onOff)
  })

  handle(ipcInvoke.capsule.setShape, async (_e, shape: 'pill' | 'card') => {
    deps.capsule.setShape(shape)
    const capsule = deps.getCapsule()
    if (!capsule) return
    const sz = FLOATING_TASK_WINDOWS[shape]

    const start = capsule.getBounds()
    const currentDisplay = screen.getDisplayMatching(start)
    const workArea = currentDisplay.workArea

    let targetX = start.x - Math.round((sz.width - start.width) / 2)
    let targetY = start.y

    const willOverflowBottom = start.y + sz.height > workArea.y + workArea.height - 8
    const isLowerHalf = (start.y + start.height / 2) > (workArea.y + workArea.height / 2)

    if (shape === 'card') {
      if (willOverflowBottom || isLowerHalf) {
        targetY = start.y - (sz.height - start.height)
      }
    } else {
      if (isLowerHalf) {
        targetY = start.y + (start.height - sz.height)
      }
    }

    targetX = Math.max(workArea.x + 8, Math.min(workArea.x + workArea.width - sz.width - 8, targetX))
    targetY = Math.max(workArea.y + 8, Math.min(workArea.y + workArea.height - sz.height - 8, targetY))

    capsule.setMinimumSize(0, 0)
    capsule.setMaximumSize(10000, 10000)
    capsule.setBounds({ x: targetX, y: targetY, width: sz.width, height: sz.height })
    capsule.setMinimumSize(sz.minWidth, sz.minHeight)
    capsule.setTitle(sz.title)
  })

  handle(ipcInvoke.capsule.resize, (_e, width: number, height: number) => {
    const capsule = deps.getCapsule()
    if (!capsule) return
    capsule.setSize(Math.round(width), Math.round(height), true)
  })

  handle(ipcInvoke.capsule.close, () => {
    const capsule = deps.getCapsule()
    if (capsule) capsule.hide()
  })

  handle(ipcInvoke.quicktodo.show, () => deps.showQuickTodo())

  handle(ipcInvoke.quicktodo.close, () => {
    const w = deps.getQuickTodo()
    if (w) w.hide()
  })

  on(ipcInvoke.win.minimize, (event) => {
    const w = BrowserWindow.fromWebContents(event.sender)
    w?.minimize()
  })

  on(ipcInvoke.win.maximize, (event) => {
    const w = BrowserWindow.fromWebContents(event.sender)
    if (w?.isMaximized()) w.unmaximize()
    else w?.maximize()
  })

  on(ipcInvoke.win.close, (event) => {
    const w = BrowserWindow.fromWebContents(event.sender)
    const main = deps.getMain()
    if (w && w !== main) w.close()
    else if (w === main) main?.hide() // close-to-tray
  })
}
