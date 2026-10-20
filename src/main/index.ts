/**
 * 应用壳（薄编排层，决策 TPD-004）：窗口、托盘、全局快捷键、更新器、生命周期、深链。
 * IPC 注册全部在 src/main/ipc/；项目状态与跨域助手在 src/main/state.ts。
 */
import { app, BrowserWindow, Menu, Tray, globalShortcut, nativeImage, screen, dialog } from 'electron'
import { join, resolve, basename, dirname, sep } from 'path'
import { pathToFileURL } from 'url'
import { existsSync } from 'fs'
import { abortAll } from './services/cli'
import { getSettings } from './services/store'
import { stopDiffWorker } from './services/documents'
import { stopObservationWorker } from './services/observability'
import { routeNotifyRail, shutdownAcp } from './services/acp'
import { startInbox, stopInbox, parseDeepLink, handleDeepLink, broadcastToWindows } from './services/bridge'
import { httpApiStatus } from './services/httpapi'
import { accessServer } from './services/access/server'
import { applyChromiumProxy } from './services/proxy'
import { mainWindowAppearance } from './services/window-appearance'
import { installWindowNavigation, openExternalHttpUrl } from './services/window-navigation'
import { TASKBAR_APPLICATION_ID, applyWindowsTaskbarBranding, prepareWindowsTaskbarShortcut } from './services/window-branding'
import { appRuntime } from './services/app-runtime'
import { createQuitGate } from './services/quit-gate'
import { ipcEvent } from '../shared/ipc-channels'
import { FLOATING_TASK_WINDOWS } from '../shared/floating-window'
import {
  setUiHooks,
  setMainWindow,
  sendSnapshot,
  toast,
  restartHttpApi,
  applyAutoStart,
  stopTimers,
  openProjectAt,
  findTask,
  pushFocusTask,
  getSnapshot,
  getProjectRoot
} from './state'
import { registerIpc } from './ipc'
import type { CapsuleApi } from './ipc/deps'

let win: BrowserWindow | null = null
let capsule: BrowserWindow | null = null
let capsuleOnTop = true
let capsuleShape: 'pill' | 'card' = 'card'
let quickTodo: BrowserWindow | null = null
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

const BRAND_RESOURCES = join(__dirname, '../../resources/brand')
const APPLICATION_ICON = join(BRAND_RESOURCES, 'icon-256.png')

function loadAppWindow(window: BrowserWindow, query?: Record<string, string>): void {
  const file = join(__dirname, '../renderer/index.html')
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  const url = new URL(devUrl || pathToFileURL(file).href)
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value)
  installWindowNavigation(window, url.href)
  const loading = devUrl ? window.loadURL(url.href) : window.loadFile(file, { query })
  void loading.catch((error: unknown) => console.warn('Unable to load app window', error))
}

/** 文档小窗登记表：key（文件绝对路径）→ 窗口；重复打开即聚焦 */
const docWindows = new Map<string, BrowserWindow>()

/**
 * 置顶文档小窗：可拖出主窗口的 OS 级窗口，样式与 peek 同源（my 令牌）。
 * 位置锚定主窗口右缘级联排布，不落到屏幕角落。
 */
function openDocWindow(opts: { key: string; title: string; file: string; theme: string }): {
  ok: boolean
  focused?: boolean
  error?: string
} {
  const existing = docWindows.get(opts.key)
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    return { ok: true, focused: true }
  }
  const mainBounds = win && !win.isDestroyed() ? win.getBounds() : screen.getPrimaryDisplay().workArea
  const workArea = screen.getPrimaryDisplay().workArea
  // 宽度按物理像素理解（高分屏下 BrowserWindow 用 DIP，需除以缩放倍率，否则 1400 会被放大到 2000+）；
  // 高度沿用 DIP 并被工作区收敛。DOC_WIN_MARGIN 是弹窗距工作区四周的留白。
  const DOC_WIN_MARGIN = 24
  const scale = screen.getPrimaryDisplay().scaleFactor || 1
  const width = Math.min(1400 / scale, workArea.width - DOC_WIN_MARGIN * 2)
  const height = Math.min(1300, workArea.height - DOC_WIN_MARGIN * 2)
  const cascade = (docWindows.size % 5) * 36
  // 居中于主窗口弹出；多开时级联偏移避免完全重叠
  const x = Math.min(
    mainBounds.x + Math.round((mainBounds.width - width) / 2) + cascade,
    workArea.x + workArea.width - width - DOC_WIN_MARGIN
  )
  const y = Math.min(
    mainBounds.y + Math.round((mainBounds.height - height) / 2) + cascade,
    workArea.y + workArea.height - height - DOC_WIN_MARGIN
  )
  const w = new BrowserWindow({
    icon: APPLICATION_ICON,
    width,
    height,
    minWidth: 480,
    minHeight: 420,
    x: Math.max(workArea.x + 8, x),
    y: Math.max(workArea.y + 8, y),
    frame: false,
    resizable: true,
    show: false,
    alwaysOnTop: true,
    backgroundColor: mainWindowAppearance(opts.theme === 'light' ? 'light' : 'dark').backgroundColor,
    title: opts.title,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })
  w.setAlwaysOnTop(true, 'screen-saver')
  docWindows.set(opts.key, w)
  w.on('closed', () => docWindows.delete(opts.key))
  // 最大化状态广播给本窗（标题栏还原图标随动；双击拖动区原生切换也走这里）
  w.on('maximize', () => w.webContents.send(ipcEvent.windowMaximized, true))
  w.on('unmaximize', () => w.webContents.send(ipcEvent.windowMaximized, false))
  loadAppWindow(w, { mode: 'doc', path: opts.file, title: opts.title, theme: opts.theme })
  w.once('ready-to-show', () => w.show())
  return { ok: true }
}

function createWindow(): void {
  win = new BrowserWindow({
    icon: APPLICATION_ICON,
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    show: false,
    frame: false,
    ...mainWindowAppearance(getSettings().theme),
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

  loadAppWindow(win)
}

function createCapsule(initialShape?: 'pill' | 'card'): void {
  if (initialShape) capsuleShape = initialShape
  if (capsule && !capsule.isDestroyed()) {
    capsule.show()
    capsule.focus()
    win?.hide()
    return
  }
  const sz = FLOATING_TASK_WINDOWS[capsuleShape]
  capsule = new BrowserWindow({
    icon: APPLICATION_ICON,
    width: sz.width,
    height: sz.height,
    minWidth: sz.minWidth,
    minHeight: sz.minHeight,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    fullscreenable: false,
    alwaysOnTop: capsuleOnTop,
    skipTaskbar: false,
    backgroundColor: '#00000000',
    title: sz.title,
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
  loadAppWindow(capsule, { mode: 'capsule', shape: capsuleShape, pinned: String(capsuleOnTop), theme: getSettings().theme })
}

function getQuickTodo(): BrowserWindow | null {
  return quickTodo && !quickTodo.isDestroyed() ? quickTodo : null
}

/**
 * 速记窗：全局热键随时呼出的迷你待办编辑窗（应用在后台也可用）。
 * 启动时预创建并隐藏，首次按下热键即可瞬时显示；失焦即隐藏，不触碰主面板当前页面。
 */
function ensureQuickTodo(): BrowserWindow {
  if (quickTodo && !quickTodo.isDestroyed()) return quickTodo
  const width = 540
  const height = 420
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  quickTodo = new BrowserWindow({
    icon: APPLICATION_ICON,
    width,
    height,
    minWidth: 420,
    minHeight: 360,
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    title: 'Trellis 速记',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })
  quickTodo.setAlwaysOnTop(true, 'screen-saver')
  quickTodo.on('closed', () => {
    quickTodo = null
  })
  quickTodo.on('blur', () => {
    const w = getQuickTodo()
    if (w && w.isVisible()) w.hide()
  })
  loadAppWindow(quickTodo, { mode: 'quicktodo', theme: getSettings().theme })
  return quickTodo
}

function toggleQuickTodo(): void {
  const w = ensureQuickTodo()
  if (w.isVisible() && w.isFocused()) {
    w.hide()
    return
  }
  w.show()
  w.focus()
  // 渲染层收到后把焦点放回编辑区（窗口复用，autoFocus 只在首挂载生效）
  w.webContents.send(ipcEvent.quickTodoShown)
}

/* ---------------- tray / shortcuts / autostart / updater ---------------- */

function createTray(): void {
  if (tray) return
  const icon = nativeImage.createFromPath(join(BRAND_RESOURCES, 'icon-32.png'))
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
      // T1：与全局热键同路径——回到上次阅读的任务与位置
      label: '回到上次阅读',
      click: () => {
        showMain()
        broadcastToWindows(ipcEvent.focusLastReading, { at: Date.now() })
      }
    },
    {
      label: '任务悬浮窗',
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
        if (port) void openExternalHttpUrl(`http://127.0.0.1:${port}/`)
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
      else {
        showMain()
        // FR：热键唤起 = 回到上次阅读位置（不新开窗口、不跳最新文件）
        broadcastToWindows(ipcEvent.focusLastReading, { at: Date.now() })
      }
    })
  } catch {
    // invalid accelerator — ignore
  }
  const quickAccel = getSettings().desktop.quickTodoShortcut || 'Alt+N'
  try {
    globalShortcut.register(quickAccel, () => toggleQuickTodo())
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
      // ACP 轨道：`acp:<kind>:` 前缀的钩子上报进会话时间线（spec 注入等），普通文本不受影响
      const railRoot = getProjectRoot()
      if (railRoot) routeNotifyRail(railRoot, text)
    },
    onOpenTask: (taskDir: string) => focusMainAndOpenTask(taskDir)
  }
}

/* ---------------- boot ---------------- */

// Establish Shell identity before readiness and before any window can join a group.
if (process.platform === 'win32') app.setAppUserModelId(TASKBAR_APPLICATION_ID)

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
    // Notifications may otherwise register the generic Electron host as our app.
    prepareWindowsTaskbarShortcut(join(BRAND_RESOURCES, 'icon.ico'))
    app.on('browser-window-created', (_event, window) => {
      applyWindowsTaskbarBranding(window, join(BRAND_RESOURCES, 'icon.ico'))
    })
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
      getQuickTodo: () => (quickTodo && !quickTodo.isDestroyed() ? quickTodo : null),
      showMain,
      createMain: createWindow,
      captureMain: async () => {
        const target = win && !win.isDestroyed() ? win : null
        if (!target) return null
        const image = await target.webContents.capturePage()
        return image.isEmpty() ? null : `data:image/png;base64,${image.toPNG().toString('base64')}`
      },
      capsule: capsuleApi,
      openDocWindow
    })
    createWindow()
    void appRuntime.initialize().catch(() => {
      toast({ kind: 'warn', title: '应用运行记录未能恢复', body: '请在应用面板检查本地配置与遗留运行状态' })
    })
    // 速记窗启动即预创建（隐藏），热键首次按下瞬时显示
    ensureQuickTodo()
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
        const railRoot = getProjectRoot()
        if (railRoot) routeNotifyRail(railRoot, text)
      },
      onOpenTask: (taskDir) => focusMainAndOpenTask(taskDir)
    })
    createTray()
    applyAutoStart()
    registerGlobalShortcut()
    setupUpdater()
    restartHttpApi()
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

  const quitGate = createQuitGate({
    hasApplications: () => appRuntime.hasOwnedApplications(),
    confirmApplications: async () => {
      const result = await dialog.showMessageBox({
        type: 'question',
        title: '退出 Trellis Panel',
        message: '停止运行中的应用并退出？',
        detail: '退出前会停止面板管理的应用。关闭窗口到托盘可继续运行。',
        buttons: ['取消', '停止应用并退出'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      return result.response === 1
    },
    setAdmissionClosed: (closed) => appRuntime.setAdmissionClosed(closed),
    stopApplications: () => appRuntime.shutdown(),
    stopSessions: shutdownAcp,
    finalize: () => {
      stopTimers()
      stopInbox()
      abortAll()
      stopDiffWorker()
      stopObservationWorker()
      globalShortcut.unregisterAll()
      accessServer.stop()
    },
    quit: () => app.quit(),
    reportError: (error) => {
      dialog.showErrorBox('退出收尾未完成', `应用清理或会话保存尚未完成，请处理后重试退出。\n${error instanceof Error ? error.message : '请检查应用与会话状态'}`)
    }
  })
  app.on('before-quit', quitGate.beforeQuit)
}
