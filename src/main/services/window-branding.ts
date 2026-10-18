import { app, shell, type BrowserWindow, type ShortcutDetails } from 'electron'
import { existsSync, mkdirSync, renameSync } from 'fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import identity from '../../../resources/brand/identity.json'

export const APPLICATION_ID = 'com.mindfold.trellispanel'
// Keep the generic development host out of the installed application's Shell group.
export const TASKBAR_APPLICATION_ID = app.isPackaged ? APPLICATION_ID : `${APPLICATION_ID}.dev`

/**
 * Electron 44's notification activator registers a link from the host EXE's
 * ProductName, not app.getName(). An incomplete link can replace the taskbar
 * group's icon after the first notification, even with correct window properties.
 * Seed the exact link its native validation expects before creating any windows.
 */
export function prepareWindowsTaskbarShortcut(developmentIcon: string): void {
  if (process.platform !== 'win32' || app.isPackaged || !process.defaultApp) return

  const brandedHost = process.env.TPANEL_BRANDED_DEV_HOST === '1'
  const productName = brandedHost ? identity.developmentProductName : 'Electron'
  const programs = join(app.getPath('appData'), 'Microsoft/Windows/Start Menu/Programs')
  const shortcutPath = join(programs, `${productName}.lnk`)
  try {
    const legacyPath = join(programs, 'Electron.lnk')
    if (brandedHost && !existsSync(shortcutPath) && existsSync(legacyPath)) {
      const legacy = shell.readShortcutLink(legacyPath)
      const ownTarget = resolve(legacy.target).toLowerCase() === join(app.getAppPath(), 'node_modules/electron/dist/electron.exe').toLowerCase()
      const ownArguments = legacy.args === `"${app.getAppPath()}"`
      const ownIdentity = legacy.appUserModelId === TASKBAR_APPLICATION_ID || legacy.appUserModelId === APPLICATION_ID
      // Migrate only this repository's previous generic link, preserving its CLSID.
      if (ownTarget && ownArguments && ownIdentity) renameSync(legacyPath, shortcutPath)
    }
    const exists = existsSync(shortcutPath)
    let previous: ShortcutDetails | undefined
    if (exists) {
      previous = shell.readShortcutLink(shortcutPath)
      const sameHost = resolve(previous.target).toLowerCase() === resolve(process.execPath).toLowerCase()
      const cachedHost = relative(join(app.getAppPath(), 'node_modules/.cache/trellis-panel/electron-host'), previous.target)
      const managedHost = brandedHost && previous.args === `"${app.getAppPath()}"` && cachedHost !== '' && !isAbsolute(cachedHost) && cachedHost !== '..' && !cachedHost.startsWith(`..${sep}`)
      const ownIdentity = previous.appUserModelId === TASKBAR_APPLICATION_ID || previous.appUserModelId === APPLICATION_ID
      // Do not take over another application's Electron shortcut.
      const previousSdk = brandedHost && previous.args === `"${app.getAppPath()}"` && resolve(previous.target).toLowerCase() === join(app.getAppPath(), 'node_modules/electron/dist/electron.exe').toLowerCase()
      if ((!sameHost && !managedHost && !previousSdk) || !ownIdentity) {
        console.warn('[window-branding] Development shortcut belongs to another application; left unchanged')
        return
      }
    }

    mkdirSync(dirname(shortcutPath), { recursive: true })
    const shortcut: ShortcutDetails = {
      target: process.execPath,
      args: `"${app.getAppPath()}"`,
      // Match Electron's native notification validation, or it rewrites the link.
      cwd: dirname(process.execPath),
      description: identity.developmentProductName,
      icon: developmentIcon,
      iconIndex: 0,
      appUserModelId: TASKBAR_APPLICATION_ID,
      // The native activator adopts the existing link's CLSID. Preserve it.
      toastActivatorClsid: previous?.toastActivatorClsid || app.toastActivatorCLSID
    }
    if (!shell.writeShortcutLink(shortcutPath, exists ? 'update' : 'create', shortcut)) {
      console.warn('[window-branding] Could not update the development taskbar shortcut')
    }
  } catch (error) {
    // Shell integration is best-effort; never prevent opening the workspace.
    console.warn('[window-branding] Could not prepare the development taskbar shortcut', error)
  }
}

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
    relaunchDisplayName: identity.name
  })
}
