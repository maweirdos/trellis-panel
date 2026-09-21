/**
 * 应用壳（薄编排层，决策 TPD-004）：窗口、托盘、全局快捷键、更新器、生命周期、深链。
 * IPC 注册全部在 src/main/ipc/；项目状态与跨域助手在 src/main/state.ts。
 */
import { app, BrowserWindow, Menu, Tray, globalShortcut, nativeImage, shell } from 'electron'
import { join, resolve, basename, dirname, sep } from 'path'
import { existsSync } from 'fs'
import { abortAll } from './services/cli'
import { getSettings } from './services/store'
import { startInbox, stopInbox, parseDeepLink, handleDeepLink, broadcastToWindows } from './services/bridge'
import { httpApiStatus } from './services/httpapi'
import { accessServer } from './services/access/server'
import { applyChromiumProxy } from './services/proxy'
import { ipcEvent } from '../shared/ipc-channels'
import {
  setUiHooks,
  setMainWindow,
  sendSnapshot,
  toast,
  restartHttpApi,
  restartJiraAutoSync,
  applyAutoStart,
  stopTimers,
  openProjectAt,
  findTask,
  pushFocusTask,
  getSnapshot
} from './state'
import { registerIpc } from './ipc'
import type { CapsuleApi } from './ipc/deps'

let win: BrowserWindow | null = null
let capsule: BrowserWindow | null = null
let capsuleOnTop = true
let capsuleShape: 'pill' | 'card' = 'pill'
let tray: Tray | null = null

/* eslint-disable @typescript-eslint/no-var-requires */
const { autoUpdater } = (() => {
  try {
    return { autoUpdater: require('electron-updater').autoUpdater }
  } catch {
    return { autoUpdater: null }
  }
})()

/* ---------------- windows ---------------- */

const TRAY_ICON_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAXUlEQVR4nGNgrQj/TwlmABEml2fCscDORrwYWS1WA/AZgq4OpwHYDMGmBm4ALgX4NIPEUQzApRCfwRgGEGMIslqsBuAzBF0dbQygyAsUBSJF0UhxQqJqUiYrM1GCAVVSVG+cKoQ/AAAAAElFTkSuQmCC'

function createWindow(): void {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    show: false,
    frame: false,
    backgroundColor: '#0f1115',
    title: 'Trellis Panel',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })

  // state 里的主窗口引用必须随创建/销毁同步，深链聚焦依赖它（getMainWindow 判活）
  setMainWindow(win)
  win.on('ready-to-show', () => win?.show())
  win.on('maximize', () => broadcastToWindows(ipcEvent.windowMaximized, true))
  win.on('unmaximize', () => broadcastToWindows(ipcEvent.windowMaximized, false))
  win.on('closed', () => {
    win = null
    setMainWindow(null)
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    win.loadURL(devUrl)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function getCapsuleBounds(shape: 'pill' | 'card'): { width: number; height: number } {
  if (shape === 'pill') {
    return { width: 360, height: 44 }
  }
  return { width: 380, height: 260 }
}

function createCapsule(initialShape?: 'pill' | 'card'): void {
  if (initialShape) capsuleShape = initialShape
  if (capsule && !capsule.isDestroyed()) {
    capsule.show()
    capsule.focus()
    win?.hide()
    return
  }
  const sz = getCapsuleBounds(capsuleShape)
  capsule = new BrowserWindow({
    width: sz.width,
    height: sz.height,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    fullscreenable: false,
    alwaysOnTop: capsuleOnTop,
    skipTaskbar: false,
    backgroundColor: '#00000000',
    title: 'Trellis 胶囊',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  capsule.setAlwaysOnTop(capsuleOnTop, 'screen-saver')
  capsule.on('closed', () => {
    capsule = null
  })
  capsule.once('ready-to-show', () => {
    if (capsule && !capsule.isDestroyed()) {
      capsule.show()
      capsule.focus()
      win?.hide()
    }
  })
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    capsule.loadURL(devUrl + `?mode=capsule&shape=${capsuleShape}`)
  } else {
    capsule.loadFile(join(__dirname, '../renderer/index.html'), { query: { mode: 'capsule', shape: capsuleShape } })
  }
}

/* ---------------- tray / shortcuts / autostart / updater ---------------- */

function createTray(): void {
  if (tray) return
  const icon = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_BASE64}`)
  tray = new Tray(icon)
  tray.setToolTip('Trellis Panel')
  rebuildTrayMenu()
}

function rebuildTrayMenu(): void {
  if (!tray) return
  const snap = getSnapshot()
  const menu = Menu.buildFromTemplate([
    { label: '打开面板', click: () => showMain() },
    {
      label: '胶囊模式',
      click: () => {
        if (capsule && !capsule.isDestroyed() && capsule.isVisible()) {
          capsule.hide()
          win?.show()
          win?.focus()
        } else {
          createCapsule(capsuleShape)
        }
      }
    },
    { type: 'separator' },
    {
      label: snap ? `${snap.meta.name} — ${snap.tasks.length} 个任务` : '未打开项目',
      enabled: false
    },
    {
      label: '打开只读 Web 看板',
      enabled: httpApiStatus().running,
      click: () => {
        const port = httpApiStatus().port
        if (port) shell.openExternal(`http://127.0.0.1:${port}/`)
      }
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ])
  tray.setContextMenu(menu)
  tray.on('double-click', () => showMain())
}

function showMain(): void {
  if (capsule && !capsule.isDestroyed()) capsule.hide()
  if (!win || win.isDestroyed()) {
    createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function registerGlobalShortcut(): void {
  globalShortcut.unregisterAll()
  const accel = getSettings().desktop.globalShortcut || 'Alt+Shift+T'
  try {
    globalShortcut.register(accel, () => {
      if (win && win.isVisible() && win.isFocused()) win.hide()
      else showMain()
    })
  } catch {
    // invalid accelerator — ignore
  }
}

function setupUpdater(): void {
  if (!autoUpdater || !app.isPackaged) return
  autoUpdater.autoDownload = false
  autoUpdater.on('update-available', () => {
    toast({ kind: 'info', title: '发现新版本', body: '到「设置 → 关于」下载更新' })
    broadcastToWindows(ipcEvent.toast, { kind: 'info', title: '发现新版本', body: '可在设置中下载更新' })
  })
  autoUpdater.on('update-not-available', () => undefined)
  autoUpdater.on('error', () => undefined)
  if (getSettings().desktop.autoUpdate) {
    autoUpdater.checkForUpdates().catch(() => undefined)
  }
}

/* ---------------- deep link ---------------- */

function focusAndShow(): void {
  const target = capsule && !capsule.isDestroyed() && capsule.isVisible() ? capsule : win
  if (target && !target.isDestroyed()) {
    target.show()
    target.focus()
  }
}

function focusMainAndOpenTask(taskDir: string): void {
  if (capsule && !capsule.isDestroyed()) capsule.hide()
  if (!win || win.isDestroyed()) {
    createWindow()
  }
  if (!win || win.isDestroyed()) return
  win.show()
  win.focus()

  const target = resolve(taskDir)
  // 深链任务可能来自另一个项目：向上找到最近的 .trellis 祖先作为项目根，
  // 与当前打开项目不一致时自动切换，避免停留在历史项目上。
  let root: string | null = null
  let cur = target
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(cur, '.trellis'))) {
      root = cur
      break
    }
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  if (root && (!getSnapshot() || resolve(getSnapshot()?.meta.root ?? '') !== resolve(root))) {
    // openProjectAt 内部完成 pushRecentProject / watcher 重挂 / git 缓存清理
    openProjectAt(root)
    // fall through — focus still works if the project was already open
  }
  const snap = getSnapshot()
  if (!snap || !target.startsWith(resolve(snap.meta.root) + sep)) return
  // AI 工具常在事件后立刻拉起面板，先重扫一次确保新任务已在快照里
  if (!findTask(basename(target))) sendSnapshot()
  pushFocusTask(basename(target))
}

function bridgeHandlers() {
  return {
    onTaskEvent: (taskDir: string | null, text: string | undefined, source: string) => {
      sendSnapshot()
      broadcastToWindows(ipcEvent.toast, {
        kind: 'info',
        title: 'AI 工具更新了任务',
        body: text ?? `${source} → ${taskDir ? basename(taskDir) : ''}`
      })
    },
    onNotify: (text: string) => {
      focusAndShow()
      broadcastToWindows(ipcEvent.toast, { kind: 'info', title: '桥接消息', body: text })
    },
    onOpenTask: (taskDir: string) => focusMainAndOpenTask(taskDir)
  }
}

/* ---------------- boot ---------------- */

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  // 调试端口（CDP 截图/自动化验收用）：TPANEL_DEBUG_PORT=9333 npm run dev
  if (process.env.TPANEL_DEBUG_PORT) {
    app.commandLine.appendSwitch('remote-debugging-port', process.env.TPANEL_DEBUG_PORT)
  }
  app.on('second-instance', (_e, argv) => {
    const link = parseDeepLink(argv)
    if (link) handleDeepLink(link, bridgeHandlers(), getSettings().bridgeToken)
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    if (process.defaultApp) {
      app.setAsDefaultProtocolClient('trellis-panel', process.execPath, [resolve(process.argv[1] ?? '.')])
    } else {
      app.setAsDefaultProtocolClient('trellis-panel')
    }
    setUiHooks({ showMain, rebuildTray: rebuildTrayMenu })
    const capsuleApi: CapsuleApi = {
      onTop: () => capsuleOnTop,
      setOnTop: (on) => {
        capsuleOnTop = on
        if (capsule && !capsule.isDestroyed()) capsule.setAlwaysOnTop(on, 'screen-saver')
      },
      shape: () => capsuleShape,
      setShape: (shape) => {
        capsuleShape = shape
      },
      create: createCapsule
    }
    registerIpc({
      getMain: () => (win && !win.isDestroyed() ? win : null),
      getCapsule: () => (capsule && !capsule.isDestroyed() ? capsule : null),
      showMain,
      createMain: createWindow,
      capsule: capsuleApi
    })
    createWindow()
    startInbox({
      onTaskEvent: (taskDir, text, source) => {
        sendSnapshot()
        broadcastToWindows(ipcEvent.toast, {
          kind: 'info',
          title: 'AI 工具更新了任务',
          body: text ?? `${source} → ${taskDir ? basename(taskDir) : '任务'}`
        })
      },
      onNotify: (text) => {
        focusAndShow()
        broadcastToWindows(ipcEvent.toast, { kind: 'info', title: '桥接消息', body: text })
      },
      onOpenTask: (taskDir) => focusMainAndOpenTask(taskDir)
    })
    createTray()
    applyAutoStart()
    registerGlobalShortcut()
    setupUpdater()
    restartHttpApi()
    restartJiraAutoSync()
    void accessServer.syncFromSettings()
    void applyChromiumProxy()
    // 冷启动深链：进程首次以 trellis-panel:// 协议拉起时 argv 里带着 URL，
    // 不经过 second-instance，需要在这里处理（项目切换由 focusMainAndOpenTask 完成）
    const coldLink = parseDeepLink(process.argv)
    if (coldLink) handleDeepLink(coldLink, bridgeHandlers(), getSettings().bridgeToken)
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    // keep running in tray — quit only via tray menu
  })

  app.on('before-quit', () => {
    stopTimers()
    stopInbox()
    abortAll()
    globalShortcut.unregisterAll()
    accessServer.stop()
  })
}
