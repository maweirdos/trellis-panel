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
import { routeNotifyRail } from './services/daemon-client/acp'
import { detachRuntimeObservers, setRuntimeClientAdmissionClosed } from './services/daemon-client/runtime'
import { configureDaemonQuitDialog } from './services/daemon-quit-dialog'
import { startInbox, stopInbox, parseDeepLink, handleDeepLink, broadcastToWindows } from './services/bridge'
import { httpApiStatus } from './services/httpapi'
import { accessServer } from './services/access/server'
import { applyChromiumProxy } from './services/proxy'
import { mainWindowAppearance } from './services/window-appearance'
import { installWindowNavigation, openExternalHttpUrl } from './services/window-navigation'
import { TASKBAR_APPLICATION_ID, applyWindowsTaskbarBranding, prepareWindowsTaskbarShortcut } from './services/window-branding'
import { APPLICATION_ICON } from './services/notifications'
import { appRuntime } from './services/app-runtime'
import { createDaemonQuitGate } from './services/daemon-quit-gate'
import { createDaemonTray } from './services/daemon-tray'
import { DaemonError } from './daemon/errors'
import { createGuiBootstrap, type GuiBootstrap } from './services/bootstrap'
import { registerBootstrapIpc } from './ipc/bootstrap'
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
import type { CapsuleApi, WindowDeps } from './ipc/deps'
import { readerWindowBounds } from './services/document-window-placement'
import { setWorkflowAdmissionClosed } from './services/workflow-desktop'
import { stopWorkflowSubscriptions } from './ipc/workflow'
import { closeTaskConversations } from './ipc/task-conversations'
import { resumeDesktopTeamBackground, setDesktopTeamAdmissionClosed, closeDesktopTeamService } from './services/team-desktop'

let win: BrowserWindow | null = null
let capsule: BrowserWindow | null = null
let capsuleOnTop = true
let capsuleShape: 'pill' | 'card' = 'card'
let quickTodo: BrowserWindow | null = null
let tray: Tray | null = null
let daemonTray: ReturnType<typeof createDaemonTray> | undefined
let daemonTrayTimer: ReturnType<typeof setInterval> | undefined
let daemonTrayExitPending = false
let pendingDaemonSettings = false
let guiNativeStateReady = false
let bootstrap: GuiBootstrap | undefined
const pendingSecondInstances: string[][] = []
const pendingTaskFocus: string[] = []
let fullRendererAttached = false
let fullRendererEverAttached = false
let desktopCompositionStarted = false
let guiApplicationsStarted = false
let guiClosing = false
let requestBootstrapExit = (): void => { app.exit(0) }

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
const docPlacements = new Map<string, Electron.Rectangle>()

/**
 * 置顶文档小窗：可拖出主窗口的 OS 级窗口，样式与 peek 同源（my 令牌）。
 * 位置锚定主窗口右缘级联排布，不落到屏幕角落。
 */
function openDocWindow(opts: Parameters<WindowDeps['openDocWindow']>[0]): {
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
  const mainBounds = opts.anchorBounds ?? (win && !win.isDestroyed() ? win.getBounds() : screen.getPrimaryDisplay().workArea)
  const retained = docPlacements.get(opts.placementKey ?? opts.key)
  const workArea = screen.getDisplayMatching(retained ?? mainBounds).workArea
  const bounds = readerWindowBounds(workArea, mainBounds, retained, (docWindows.size % 5) * 36)
  const w = new BrowserWindow({
    icon: APPLICATION_ICON,
    ...bounds,
    minWidth: Math.min(480, bounds.width),
    minHeight: Math.min(420, bounds.height),
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
  opts.onCreated?.(w.webContents.id)
  const remember = (): void => {
    if (w.isDestroyed() || w.isMaximized() || w.isMinimized()) return
    docPlacements.set(opts.placementKey ?? opts.key, w.getBounds())
    if (docPlacements.size > 100) docPlacements.delete(docPlacements.keys().next().value as string)
  }
  w.on('move', remember)
  w.on('resize', remember)
  w.on('closed', () => { docWindows.delete(opts.key); opts.onClosed?.() })
  // 最大化状态广播给本窗（标题栏还原图标随动；双击拖动区原生切换也走这里）
  w.on('maximize', () => w.webContents.send(ipcEvent.windowMaximized, true))
  w.on('unmaximize', () => w.webContents.send(ipcEvent.windowMaximized, false))
  loadAppWindow(w, opts.readerViewId ? { mode: 'doc', viewId: opts.readerViewId, theme: getSettings().theme } : { mode: 'doc', path: opts.file, title: opts.title, theme: opts.theme })
  w.once('ready-to-show', () => w.show())
  return { ok: true }
}

function createWindow(): void {
  // Window creation has no dependency on protected settings/native context.
  const theme = guiNativeStateReady ? getSettings().theme : bootstrap?.state().ui.theme ?? 'dark'
  win = new BrowserWindow({
    icon: APPLICATION_ICON,
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    show: false,
    frame: false,
    ...mainWindowAppearance(theme),
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
  const window = win
  fullRendererAttached = false
  window.webContents.on('did-start-loading', () => { fullRendererAttached = false })
  window.on('close', event => {
    if (!guiNativeStateReady || !fullRendererEverAttached) { event.preventDefault(); requestBootstrapExit() }
  })
  window.once('show', () => bootstrap?.firstVisible())
  window.once('ready-to-show', () => {
    if (window.isDestroyed()) return
    window.show()
    // The restricted renderer has painted before native preparation starts.
    // Yield once after showing so native work cannot hold the first show event.
    setImmediate(() => { void bootstrap?.start() })
  })
  win.on('maximize', () => win?.webContents.send(ipcEvent.windowMaximized, true))
  win.on('unmaximize', () => win?.webContents.send(ipcEvent.windowMaximized, false))
  win.on('closed', () => {
    fullRendererAttached = false
    win = null
    setMainWindow(null)
  })

  loadAppWindow(win, { theme })
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

function showQuickTodo(): void {
  const w = ensureQuickTodo()
  w.show()
  w.focus()
  // 渲染层收到后把焦点放回编辑区（窗口复用，autoFocus 只在首挂载生效）
  w.webContents.send(ipcEvent.quickTodoShown)
}

function toggleQuickTodo(): void {
  const w = getQuickTodo()
  if (w?.isVisible() && w.isFocused()) w.hide()
  else showQuickTodo()
}

/* ---------------- tray / shortcuts / autostart / updater ---------------- */

function createTray(): void {
  if (tray) return
  const icon = nativeImage.createFromPath(join(BRAND_RESOURCES, 'icon-32.png'))
  tray = new Tray(icon)
  tray.setToolTip('Trellis Panel')
  daemonTray = createDaemonTray({
    getMain: () => win && !win.isDestroyed() ? win : null,
    changed: rebuildTrayMenu,
    isClosing: () => guiClosing || daemonTrayExitPending,
    openSettings: () => {
      pendingDaemonSettings = true
      showMain()
      flushDaemonSettings()
    }
  })
  // Register once per tray, never once per project/menu refresh.
  tray.on('double-click', () => showMain())
  tray.on('right-click', () => { void daemonTray?.refresh() })
  daemonTrayTimer = setInterval(() => { void daemonTray?.refresh() }, 15_000)
  daemonTrayTimer.unref()
  rebuildTrayMenu()
  void daemonTray.refresh()
}

function flushDaemonSettings(): void {
  if (!pendingDaemonSettings || !fullRendererAttached || !win || win.isDestroyed()) return
  pendingDaemonSettings = false
  win.webContents.send(ipcEvent.daemonOpenSettings)
}

function disposeDaemonTray(): void {
  if (daemonTrayTimer) clearInterval(daemonTrayTimer)
  daemonTrayTimer = undefined
  daemonTray?.dispose()
  daemonTray = undefined
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
    ...(daemonTray?.menu() ?? []),
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ])
  tray.setContextMenu(menu)
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
  })
  autoUpdater.on('update-not-available', () => undefined)
  autoUpdater.on('error', () => undefined)
  if (getSettings().desktop.autoUpdate) {
    autoUpdater.checkForUpdates().catch(() => undefined)
  }
}

/* ---------------- deep link ---------------- */

function focusMainAndOpenTask(taskDir: string): void {
  if (capsule && !capsule.isDestroyed()) capsule.hide()
  if (!win || win.isDestroyed()) {
    createWindow()
  }
  if (!win || win.isDestroyed()) return
  win.show()
  win.focus()
  if (!fullRendererAttached) {
    if (pendingTaskFocus.length < 8 && taskDir.length <= 32_768) pendingTaskFocus.push(taskDir)
    return
  }

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
    const opened = openProjectAt(root)
    if (!opened.ok) return
    // App has already bootstrapped when deferred focus is delivered. Publish
    // the new project before its focus event so it cannot use the old snapshot.
    sendSnapshot()
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
      toast({
        kind: 'info',
        title: 'AI 工具更新了任务',
        body: text ?? `${source} → ${taskDir ? basename(taskDir) : ''}`
      })
    },
    onNotify: (text: string) => {
      toast({ kind: 'info', title: '桥接消息', body: text })
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
  console.info('[Trellis Panel] 已有桌面实例正在运行，启动请求已转交该实例；本次新进程正常退出。')
  if (process.env['ELECTRON_RENDERER_URL']) {
    console.info('[Trellis Panel] 如需启动开发版，请先通过已有桌面的托盘菜单「退出」，在退出对话框中保留后台守护进程，再重新运行 npm run dev。')
  }
  app.quit()
} else {
  // 调试端口（CDP 截图/自动化验收用）：TPANEL_DEBUG_PORT=9333 npm run dev
  if (process.env.TPANEL_DEBUG_PORT) {
    app.commandLine.appendSwitch('remote-debugging-port', process.env.TPANEL_DEBUG_PORT)
  }
  let guiCleanupWork: Promise<void> | undefined
  let guiExitWork: Promise<void> | undefined
  const cleanupGui = (): Promise<void> => {
    if (guiCleanupWork) return guiCleanupWork
    guiClosing = true
    const work = (async () => {
      const errors: unknown[] = []
      // GUI-owned work only. No daemon stop, restart, preference or quit dialog.
      const closeSources = [
        () => appRuntime.setAdmissionClosed(true),
        () => setWorkflowAdmissionClosed(true),
        () => setDesktopTeamAdmissionClosed(true),
        () => setRuntimeClientAdmissionClosed(true),
        stopTimers, stopInbox, abortAll, stopDiffWorker, stopWorkflowSubscriptions,
        closeTaskConversations, stopObservationWorker, detachRuntimeObservers,
        () => globalShortcut.unregisterAll(), () => accessServer.stop(),
        () => { disposeDaemonTray(); tray?.destroy(); tray = null }
      ]
      for (const close of closeSources) { try { close() } catch (error) { errors.push(error) } }
      const results = await Promise.allSettled([
        closeDesktopTeamService(),
        ...(guiApplicationsStarted ? [appRuntime.shutdown()] : [])
      ])
      if (errors.length || results.some(result => result.status === 'rejected')) {
        throw new DaemonError('E_UNKNOWN', 'GUI cleanup has not completed. Preserve this window and retry desktop exit after checking the original local operations.', 'unknown')
      }
    })()
    guiCleanupWork = work
    // A timeout keeps joining this original cleanup. Only a settled failure may
    // be retried, using the services' own retained cleanup state.
    void work.catch(() => { if (guiCleanupWork === work) guiCleanupWork = undefined })
    return work
  }
  const waitForGuiCleanup = (): Promise<void> => new Promise((resolveCleanup, rejectCleanup) => {
    const timer = setTimeout(() => rejectCleanup(new DaemonError('E_UNKNOWN', 'GUI cleanup is still pending. The retained daemon was not stopped; retry desktop exit to rejoin the original cleanup.', 'unknown')), 15_000)
    cleanupGui().then(() => { clearTimeout(timer); resolveCleanup() }, error => { clearTimeout(timer); rejectCleanup(error) })
  })
  const reportGuiCleanupFailure = (error: unknown): void => {
    guiNativeStateReady = false
    try {
      bootstrap?.fail(error)
      // Keep an actionable shell even if OS close removed the last main window.
      if (!win || win.isDestroyed()) showMain()
    } catch { console.error('GUI cleanup remains incomplete; its recovery window could not be displayed.') }
  }
  const exitBootstrapGui = (): Promise<void> => {
    if (guiExitWork) return guiExitWork
    const work = (async () => {
      guiClosing = true; fullRendererAttached = false; guiNativeStateReady = false
      if (desktopCompositionStarted) {
        try { await waitForGuiCleanup() }
        catch (error) { reportGuiCleanupFailure(error); throw error }
      }
      app.exit(0)
    })()
    guiExitWork = work
    void work.catch(() => { if (guiExitWork === work) guiExitWork = undefined })
    return work
  }
  requestBootstrapExit = () => { void exitBootstrapGui().catch(reportGuiCleanupFailure) }
  const dispatchSecondInstance = (argv: string[]): void => {
    const link = parseDeepLink(argv)
    if (link) handleDeepLink(link, bridgeHandlers(), getSettings().bridgeToken)
    showMain()
  }
  app.on('second-instance', (_e, argv) => {
    if (!guiNativeStateReady || !fullRendererAttached) {
      if (pendingSecondInstances.length < 8) pendingSecondInstances.push(argv.slice(0, 128).map(argument => argument.slice(0, 32_768)))
      if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus() }
      return
    }
    dispatchSecondInstance(argv)
  })

  const composeDesktop = async (): Promise<void> => {
    // One-shot full composition, reached only after native authority is ready.
    const { registerIpc } = await import('./ipc')
    if (guiClosing) throw new DaemonError('E_UNAVAILABLE', 'Desktop exit has closed GUI initialization.')
    configureDaemonQuitDialog({ load: window => loadAppWindow(window, { mode: 'daemon-quit' }), getMain: () => win && !win.isDestroyed() ? win : null })
    // Notifications may otherwise register the generic Electron host as our app.
    prepareWindowsTaskbarShortcut(join(BRAND_RESOURCES, 'icon.ico'))
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
      showQuickTodo,
      showMain,
      createMain: createWindow,
      quitApp: () => app.quit(),
      captureMain: async () => {
        const target = win && !win.isDestroyed() ? win : null
        if (!target) return null
        const image = await target.webContents.capturePage()
        return image.isEmpty() ? null : `data:image/png;base64,${image.toPNG().toString('base64')}`
      },
      capsule: capsuleApi,
      openDocWindow,
      isDocWindowSender: (senderId) => [...docWindows.values()].some((w) => !w.isDestroyed() && w.webContents.id === senderId)
    })
    guiApplicationsStarted = true
    void appRuntime.initialize().catch(() => {
      toast({ kind: 'warn', title: '应用运行记录未能恢复', body: '请在应用面板检查本地配置与遗留运行状态' })
    })
    // 速记窗启动即预创建（隐藏），热键首次按下瞬时显示
    ensureQuickTodo()
    createTray()
    applyAutoStart()
    registerGlobalShortcut()
    setupUpdater()
    restartHttpApi()
    accessServer.syncFromSettings()
    void applyChromiumProxy().catch(() => toast({ kind: 'warn', title: '代理配置未能应用', body: '请在设置中检查代理配置' }))
    guiNativeStateReady = true
  }
  const installDesktop = async (): Promise<void> => {
    desktopCompositionStarted = true
    try { await composeDesktop() }
    catch (error) {
      // Stop new GUI side effects immediately on partial composition failure;
      // do not leave team/observation work running behind the error shell.
      void waitForGuiCleanup().catch(reportGuiCleanupFailure)
      throw error
    }
  }
  let desktopIngressStarted = false
  const attachFullRenderer = (): void => {
    if (guiClosing || !guiNativeStateReady) throw new DaemonError('E_UNAVAILABLE', 'GUI admission is closed; reload cannot restart partial initialization.')
    fullRendererAttached = true; fullRendererEverAttached = true
    if (!desktopIngressStarted) {
      desktopIngressStarted = true
      resumeDesktopTeamBackground()
      const coldLink = parseDeepLink(process.argv)
      if (coldLink) handleDeepLink(coldLink, bridgeHandlers(), getSettings().bridgeToken)
      startInbox({
        ...bridgeHandlers(),
        onTaskEvent: (taskDir, text, source) => {
          sendSnapshot()
          toast({ kind: 'info', title: 'AI 工具更新了任务', body: text ?? `${source} → ${taskDir ? basename(taskDir) : '任务'}` })
        }
      })
    }
    for (const argv of pendingSecondInstances.splice(0)) dispatchSecondInstance(argv)
    for (const taskDir of pendingTaskFocus.splice(0)) focusMainAndOpenTask(taskDir)
    flushDaemonSettings()
  }

  void app.whenReady().then(() => {
    let nativeState: typeof import('./services/daemon-client/native-state') | undefined
    bootstrap = createGuiBootstrap({
      prepare: async (onPreparing, onAuthenticated) => {
        nativeState = await import('./services/daemon-client/native-state')
        await nativeState.prepareGuiNativeState(onPreparing, onAuthenticated)
      },
      migration: () => nativeState?.guiNativePreparationIdentity(),
      installDesktop,
      publish: state => {
        const target = win && !win.isDestroyed() ? win : null
        try {
          if (target && !target.webContents.isDestroyed()) target.webContents.send(ipcEvent.bootstrapChanged, state)
        } catch { /* A closing renderer does not change native preparation ownership. */ }
      }
    })
    registerBootstrapIpc({
      getMain: () => win && !win.isDestroyed() ? win : null,
      bootstrap,
      exit: exitBootstrapGui,
      attached: attachFullRenderer,
      detached: () => { fullRendererAttached = false },
      legacyInspect: async () => (await import('./services/daemon-client/legacy-upgrade')).inspectLegacyDaemon(),
      legacyStop: async input => (await import('./services/daemon-client/legacy-upgrade')).stopLegacyDaemon(input),
      legacyReconcile: async input => (await import('./services/daemon-client/legacy-upgrade')).reconcileLegacyDaemonStop(input)
    })
    // Native window identity/navigation are local shell concerns; no settings,
    // OS preference changes, feature IPC or observers are installed here.
    app.on('browser-window-created', (_event, window) => applyWindowsTaskbarBranding(window, join(BRAND_RESOURCES, 'icon.ico')))
    Menu.setApplicationMenu(null)
    createWindow()
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
  }).catch((error: unknown) => {
    // Also catch native whenReady/window-setup failures. If a shell exists keep
    // it available; backend failures are handled by the retryable coordinator.
    guiNativeStateReady = false
    try {
      if (bootstrap && win && !win.isDestroyed()) bootstrap.fail(error)
      else dialog.showErrorBox('Trellis Panel 桌面窗口未能打开', '请退出并重新打开桌面。原有后台与本机配置已保留。')
    } catch { console.error('Trellis Panel could not display its desktop startup failure.') }
  })

  app.on('window-all-closed', () => {
    if (!guiNativeStateReady || !fullRendererEverAttached) { requestBootstrapExit(); return }
    // keep running in tray — quit only via tray menu
  })

  const quitGate = createDaemonQuitGate({
    closeGuiAdmission: (closed) => { appRuntime.setAdmissionClosed(closed); setWorkflowAdmissionClosed(closed); setDesktopTeamAdmissionClosed(closed) },
    stopGuiWork: async () => { await appRuntime.shutdown(); await closeDesktopTeamService() },
    detach: async () => { detachRuntimeObservers() },
    finalize: () => {
      disposeDaemonTray()
      stopTimers()
      stopInbox()
      abortAll()
      stopDiffWorker()
      stopWorkflowSubscriptions()
      closeTaskConversations()
      stopObservationWorker()
      globalShortcut.unregisterAll()
      accessServer.stop()
    },
    quit: () => app.quit(),
    reportError: (error) => {
      dialog.showErrorBox('退出收尾未完成', `应用清理或会话保存尚未完成，请处理后重试退出。\n${error instanceof Error ? error.message : '请检查应用与会话状态'}`)
    }
  })
  app.on('before-quit', event => {
    // A bootstrap exit never queries/stops a retained daemon, changes its
    // preference, or enters the full GUI's cleanup/dialog path.
    if (!guiNativeStateReady || !fullRendererEverAttached) { event.preventDefault(); requestBootstrapExit(); return }
    daemonTrayExitPending = true
    rebuildTrayMenu()
    quitGate.beforeQuit(event)
    void quitGate.whenIdle().finally(() => { daemonTrayExitPending = false; rebuildTrayMenu() })
  })
}
