import { BrowserWindow, screen } from 'electron'
import { ipcInvoke } from '../../shared/ipc-channels'
import { on, handle } from './registry'
import type { WindowDeps } from './deps'

export function registerWindowIpc(deps: WindowDeps): void {
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
    const sz = shape === 'pill' ? { width: 360, height: 44 } : { width: 380, height: 260 }

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

  on(ipcInvoke.win.minimize, () => {
    const w = BrowserWindow.getFocusedWindow() ?? deps.getMain()
    w?.minimize()
  })

  on(ipcInvoke.win.maximize, () => {
    const w = BrowserWindow.getFocusedWindow() ?? deps.getMain()
    if (w?.isMaximized()) w.unmaximize()
    else w?.maximize()
  })

  on(ipcInvoke.win.close, () => {
    const w = BrowserWindow.getFocusedWindow()
    const main = deps.getMain()
    if (w && w !== main) w.close()
    else main?.hide() // close-to-tray
  })
}
