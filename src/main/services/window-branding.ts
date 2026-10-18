import { app, type BrowserWindow } from 'electron'

export const APPLICATION_ID = 'com.mindfold.trellispanel'
// Keep the generic development host out of the installed application's Shell group.
export const TASKBAR_APPLICATION_ID = app.isPackaged ? APPLICATION_ID : `${APPLICATION_ID}.dev`

/** Windows taskbar groups use Shell properties as well as the window's HICON. */
export function applyWindowsTaskbarBranding(window: BrowserWindow, developmentIcon: string): void {
  if (process.platform !== 'win32') return

  window.setAppDetails({
    appId: TASKBAR_APPLICATION_ID,
    // The Shell cannot read inside app.asar; the packaged EXE embeds the same icon.
    appIconPath: app.isPackaged ? process.execPath : developmentIcon,
    appIconIndex: 0,
    relaunchCommand: process.defaultApp
      ? `"${process.execPath}" "${app.getAppPath()}"`
      : `"${process.execPath}"`,
    relaunchDisplayName: 'Trellis Panel'
  })
}
