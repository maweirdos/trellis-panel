import { Notification, type BrowserWindow } from 'electron'
import { join } from 'path'
import { ipcEvent } from '../../shared/ipc-channels'
import type { ToastEvent } from '../../shared/types'

/** Same committed application tile for windows and native notifications. */
export const APPLICATION_ICON = join(__dirname, '../../resources/brand/icon-256.png')

// Keep native instances alive until the OS closes or rejects them.
const activeNotifications = new Set<Notification>()

export function deliverToast(
  toast: ToastEvent,
  mainWindow: BrowserWindow | null,
  onClick: () => void
): void {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isMinimized() && mainWindow.isVisible() && mainWindow.isFocused()) {
    try {
      mainWindow.webContents.send(ipcEvent.toast, toast)
      return
    } catch (error) {
      console.warn('[notifications] Could not deliver the foreground toast', error)
    }
  }

  try {
    if (!Notification.isSupported()) return
    const notification = new Notification({
      title: toast.title,
      body: toast.body ?? '',
      icon: APPLICATION_ICON,
      silent: true,
      urgency: toast.kind === 'error' ? 'critical' : toast.kind === 'warn' ? 'normal' : 'low'
    })
    activeNotifications.add(notification)
    notification.once('close', () => activeNotifications.delete(notification))
    notification.once('failed', (_event, error) => {
      activeNotifications.delete(notification)
      console.warn('[notifications] Native notification failed', error)
    })
    notification.once('click', () => {
      activeNotifications.delete(notification)
      try {
        onClick()
      } catch (error) {
        console.warn('[notifications] Could not open the notification destination', error)
      }
    })
    try {
      notification.show()
    } catch (error) {
      activeNotifications.delete(notification)
      throw error
    }
  } catch (error) {
    console.warn('[notifications] Could not show a native notification', error)
  }
}
