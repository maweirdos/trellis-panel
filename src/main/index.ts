import { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, globalShortcut, clipboard, safeStorage, Notification, nativeImage, screen } from 'electron'
import { join, resolve, sep, extname, basename, dirname } from 'path'
import { readFileSync, writeFileSync, statSync, existsSync, mkdirSync, rmSync, renameSync } from 'fs'
import { scanProject, updateTaskRecordAt, writeSpecFile, computeSpecBacklinks, readTextWithMtime, searchDocs, TEXT_EXTS } from './services/scan'
import { TrellisWatcher } from './services/watcher'
import { runCli, abortCli, abortAll } from './services/cli'
import { getSettings, setSettings, pushRecentProject } from './services/store'
import { jiraTest, jiraSearch, jiraTransitions, jiraTransition, jiraComment, mapJiraStatus, protectPassword } from './services/jira'
import {
  startInbox,
  stopInbox,
  parseDeepLink,
  handleDeepLink,
  installTpanel,
  installTrellisHooks,
  broadcastToWindows
} from './services/bridge'
import { startHttpApi, stopHttpApi, httpApiStatus } from './services/httpapi'
import { taskGitInfo, createBranch, clearGitCache, isGitRepo } from './services/git'
import { recordActivity, getAnalytics } from './services/activity'
import { generateWeeklyReport, generateStandup, saveReport } from './services/report'
import { listChannels, channelSend, channelAction } from './services/channels'
import { listTodos, saveTodo, deleteTodo } from './services/todo'
import {
  scanStudio,
  studioReadText,
  studioWriteText,
  studioDelete,
  setConfigKeys,
  setDeveloperFile,
  createWorkflow,
  createExtension,
  syncExtensionToPlatforms
} from './services/studio'
import { kbSearch } from './services/knowledge'
import { GatewayManager } from './services/gateway/manager'
import { aiChat, aiTest, aiTaskPrompt, protectAiKey, fetchModelsFromProvider, testSingleModel } from './services/ai'
import { kbMcpInstall, kbMcpStatus } from './services/kbmcp'
import { aiPlanTask, aiSplitEpic, aiCommitMsg, aiPrDesc, handoffTexts } from './services/plan'
import {
  gitlabTest,
  gitlabTaskStatus,
  gitlabCreateMr,
  protectGitlabPassword,
  clearGitlabTokenCache,
  clearGitlabStatusCache
} from './services/gitlab'
import {
  WeknoraSpecSyncer,
  buildArchiveDoc,
  protectWeknoraKey,
  protectWeknoraMcpToken,
  weknoraListDocs,
  weknoraMcpTokenOf,
  weknoraPushManual,
  weknoraReadDoc,
  weknoraSearch,
  weknoraTest,
  weknoraTestMcp
} from './services/weknora'
import type { AiConfig, ChatMessage, GatewaySecurityConfig, GitLabConfig, JiraConfig, ModelProvider, SpecNode, ToastEvent, WeknoraConfig } from '../shared/types'
import { errorText, errorMessage } from '../shared/errors'

let win: BrowserWindow | null = null
let capsule: BrowserWindow | null = null
let capsuleOnTop = true
let capsuleShape: 'pill' | 'card' = 'pill'
let tray: Tray | null = null
let projectRoot: string | null = null
const watcher = new TrellisWatcher()
let jiraSyncTimer: ReturnType<typeof setInterval> | null = null
let latestSnapshot: ReturnType<typeof scanProject> | null = null
/** task dirs seen in the current project — drives the Inbox "new task" diff */
let knownTaskDirs = new Set<string>()

/* WeKnora spec 同步：变更进队列，静默期后批量推送公司库 */
const weknoraSpecSync = new WeknoraSpecSyncer({
  onReport: (r) => {
    if (r.pushed === 0 && r.duplicates === 0 && r.failed.length === 0) return
    broadcastToWindows('bridge:toast', {
      kind: r.failed.length > 0 ? 'warn' : 'success',
      title: '公司库（WeKnora）spec 同步',
      body: [
        r.pushed > 0 ? `推送 ${r.pushed} 篇` : '',
        r.duplicates > 0 ? `无变化 ${r.duplicates} 篇` : '',
        r.failed.length > 0 ? `失败 ${r.failed.length} 篇：${r.failed.slice(0, 3).map((f) => `${f.file}（${f.error}）`).join('；')}` : ''
      ].filter(Boolean).join(' · ')
    })
  }
})

/** .trellis/spec 下的文本文件 → 同步队列（其余文件忽略） */
function routeSpecFileSync(absPath: string): void {
  if (!projectRoot) return
  const specRoot = resolve(projectRoot, '.trellis', 'spec') + sep
  const p = resolve(absPath)
  if (!p.startsWith(specRoot)) return
  if (!/\.(md|markdown|txt)$/i.test(extname(p))) return
  weknoraSpecSync.enqueue(p)
}

function syncWeknoraSpecConfig(): void {
  weknoraSpecSync.configure(getSettings().weknora, projectRoot)
}

const MAX_TEXT_BYTES = 5 * 1024 * 1024

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

  win.on('ready-to-show', () => win?.show())
  win.on('maximize', () => broadcastToWindows('window:maximized', true))
  win.on('unmaximize', () => broadcastToWindows('window:maximized', false))
  win.on('closed', () => {
    win = null
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

function applyAutoStart(): void {
  try {
    app.setLoginItemSettings({ openAtLogin: getSettings().desktop.autoStart })
  } catch {
    // best-effort
  }
}

function createTray(): void {
  if (tray) return
  const icon = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_BASE64}`)
  tray = new Tray(icon)
  tray.setToolTip('Trellis Panel')
  rebuildTrayMenu()
}

function rebuildTrayMenu(): void {
  if (!tray) return
  const snap = latestSnapshot
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
    broadcastToWindows('bridge:toast', { kind: 'info', title: '发现新版本', body: '可在设置中下载更新' })
  })
  autoUpdater.on('update-not-available', () => undefined)
  autoUpdater.on('error', () => undefined)
  if (getSettings().desktop.autoUpdate) {
    autoUpdater.checkForUpdates().catch(() => undefined)
  }
}

/* ---------------- snapshot / activity / toast ---------------- */

function toast(t: ToastEvent): void {
  try {
    if (Notification.isSupported()) {
      const n = new Notification({ title: t.title, body: t.body ?? '', silent: true })
      n.on('click', () => showMain())
      n.show()
    }
  } catch {
    // notifications are best-effort
  }
}

function sendSnapshot(): void {
  if (!projectRoot) return
  try {
    latestSnapshot = scanProject(projectRoot)
    recordActivity(latestSnapshot)
    detectNewTasks(latestSnapshot)
    broadcastToWindows('project:snapshot', latestSnapshot)
    rebuildTrayMenu()
  } catch (e) {
    console.error('rescan failed:', errorMessage(e))
  }
}

/**
 * Diff scanned task dirs against the known set — any task that appeared since
 * the last scan (e.g. created by an AI tool via trellis CLI) is pushed to the
 * renderer Inbox for visual triage.
 */
function detectNewTasks(snap: ReturnType<typeof scanProject>): void {
  const current = new Set(snap.tasks.map((t) => t.dirName))
  if (knownTaskDirs.size === 0) {
    // first scan after project open — baseline only, don't flood the inbox
    knownTaskDirs = current
    return
  }
  const fresh = [...current].filter((d) => !knownTaskDirs.has(d))
  knownTaskDirs = current
  if (fresh.length === 0) return
  const items = fresh
    .map((dir) => {
      const t = snap.tasks.find((x) => x.dirName === dir)
      return {
        dirName: dir,
        title: t?.record?.title ?? dir,
        creator: t?.record?.creator ?? '',
        ts: Date.now()
      }
    })
    .slice(0, 20)
  const first = items[0]
  toast({
    kind: 'info',
    title: items.length === 1 ? '新任务已进入看板' : `${items.length} 个新任务已进入看板`,
    body: items.length === 1 ? first.title : `${first.title} 等`
  })
}

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
  if (root && (!projectRoot || resolve(projectRoot) !== resolve(root))) {
    try {
      const snap = scanProject(root)
      if (snap.meta.trellisExists) {
        projectRoot = snap.meta.root
        pushRecentProject(projectRoot)
        watcher.start(projectRoot, sendSnapshot, routeSpecFileSync)
        syncWeknoraSpecConfig()
        clearGitCache()
        latestSnapshot = snap
        knownTaskDirs = new Set(snap.tasks.map((t) => t.dirName))
        recordActivity(snap)
      }
    } catch {
      // fall through — focus still works if the project was already open
    }
  }
  if (!projectRoot || !target.startsWith(resolve(projectRoot) + sep)) return
  // AI 工具常在事件后立刻拉起面板，先重扫一次确保新任务已在快照里
  if (!findTask(basename(target))) sendSnapshot()
  pushFocusTask(basename(target))
}

/** Focus task to deliver to the renderer — queued until the window can receive it. */
let pendingFocusTask: string | null = null
let pendingFocusRoot: string | null = null

function pushFocusTask(dirName: string): void {
  pendingFocusTask = dirName
  pendingFocusRoot = projectRoot
  const send = (): void => {
    if (pendingFocusTask !== dirName) return
    if (!win || win.isDestroyed()) return
    if (win.webContents.isLoading()) {
      setTimeout(send, 300)
      return
    }
    pendingFocusTask = null
    win.webContents.send('bridge:focus-task', dirName)
  }
  send()
}

function wireBridge(): void {
  startInbox({
    onTaskEvent: (taskDir, text, source) => {
      sendSnapshot()
      const label = taskDir ? basename(taskDir) : '任务'
      broadcastToWindows('bridge:toast', {
        kind: 'info',
        title: 'AI 工具更新了任务',
        body: text ?? `${source} → ${label}`
      })
    },
    onNotify: (text) => {
      focusAndShow()
      broadcastToWindows('bridge:toast', { kind: 'info', title: '桥接消息', body: text })
    },
    onOpenTask: (taskDir) => focusMainAndOpenTask(taskDir)
  })
}

function bridgeHandlers() {
  return {
    onTaskEvent: (taskDir: string | null, text: string | undefined, source: string) => {
      sendSnapshot()
      broadcastToWindows('bridge:toast', {
        kind: 'info',
        title: 'AI 工具更新了任务',
        body: text ?? `${source} → ${taskDir ? basename(taskDir) : ''}`
      })
    },
    onNotify: (text: string) => {
      focusAndShow()
      broadcastToWindows('bridge:toast', { kind: 'info', title: '桥接消息', body: text })
    },
    onOpenTask: (taskDir: string) => focusMainAndOpenTask(taskDir)
  }
}

function findTask(dir: string) {
  const snap = latestSnapshot
  if (!snap) return null
  return (
    snap.tasks.find((x) => x.dirName === dir || x.path.endsWith(dir)) ??
    snap.archived.find((x) => x.dirName === dir || x.path.endsWith(dir)) ??
    null
  )
}

/** Flatten spec tree to file paths (relative to spec root) for AI context hints. */
function flattenSpecNames(nodes: SpecNode[], depth = 0): string[] {
  const out: string[] = []
  for (const n of nodes ?? []) {
    if (n.type === 'file') out.push(n.name)
    else if (depth < 4 && n.children) out.push(...flattenSpecNames(n.children, depth + 1))
  }
  return out
}

/* ---------------- jira auto sync ---------------- */

async function autoSyncJira(): Promise<void> {
  if (!projectRoot || !latestSnapshot) return
  const cfg = getSettings().jira
  if (!cfg.enabled || !cfg.baseUrl) return
  const linked = latestSnapshot.tasks.filter((t) => t.jiraKey)
  if (linked.length === 0) return
  let changed = 0
  for (const t of linked) {
    try {
      const res = await jiraSearch(cfg, `issuekey = ${t.jiraKey}`)
      const issue = res.issues?.[0]
      if (!issue) continue
      const target = mapJiraStatus(cfg.statusMap ?? {}, issue.status, issue.statusCategory)
      if ((t.record?.status ?? '').toLowerCase() !== target) {
        updateTaskRecordAt(projectRoot, t.path, { status: target })
        changed += 1
      }
    } catch {
      // per-issue failures are non-fatal
    }
  }
  if (changed > 0) {
    broadcastToWindows('bridge:toast', {
      kind: 'info',
      title: 'Jira 自动同步',
      body: `${changed} 个关联任务状态已按 Jira 更新`
    })
  }
}

function restartJiraAutoSync(): void {
  if (jiraSyncTimer) {
    clearInterval(jiraSyncTimer)
    jiraSyncTimer = null
  }
  if (getSettings().jira.enabled && getSettings().jira.autoSync) {
    jiraSyncTimer = setInterval(() => void autoSyncJira(), 10 * 60 * 1000)
  }
}

/* ---------------- http api lifecycle ---------------- */

function restartHttpApi(): void {
  const s = getSettings()
  if (s.httpApi.enabled) {
    void startHttpApi(s.httpApi.port, s.httpApi.lanAccess, () => latestSnapshot)
  } else {
    stopHttpApi()
  }
}

/* ---------------- safe read ---------------- */

function safeReadText(absPath: string): { ok: boolean; error?: string; content?: string; mtime?: number } {
  if (!projectRoot) return { ok: false, error: '未打开项目' }
  const root = resolve(projectRoot)
  const p = resolve(root, absPath)
  if (!p.startsWith(root + sep)) return { ok: false, error: '路径超出项目范围' }
  const ext = extname(p).toLowerCase()
  if (!TEXT_EXTS.has(ext)) return { ok: false, error: `不支持的文件类型 ${ext || '(无扩展名)'}` }
  let st
  try {
    st = statSync(p)
  } catch {
    return { ok: false, error: '文件不存在' }
  }
  if (st.size > MAX_TEXT_BYTES) return { ok: false, error: '文件超过 5MB' }
  try {
    let content = readFileSync(p, 'utf-8')
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1)
    return { ok: true, content, mtime: st.mtimeMs }
  } catch (e) {
    return { ok: false, error: errorText(e, '读取失败') }
  }
}

/* ---------------- task create (jira import & intake wizard) ---------------- */

interface CreateTaskInput {
  dirName: string
  title: string
  description: string
  status: string
  priority: string
  assignee: string
  origin?: 'panel' | 'jira' | 'plan'
  jiraKey?: string
  jiraUrl?: string
  /** 计划工作台的扩展字段 */
  subtasks?: string[]
  workflow?: string | null
  devType?: string | null
  scope?: string | null
  branch?: string | null
}

function createTaskRecord(input: CreateTaskInput): { ok: boolean; error?: string; dirName?: string } {
  if (!projectRoot) return { ok: false, error: '未打开项目' }
  const tasksRoot = join(projectRoot, '.trellis', 'tasks')
  const today = new Date()
  const pad = (x: number): string => String(x).padStart(2, '0')
  const mm = pad(today.getMonth() + 1)
  const dd = pad(today.getDate())
  const finalDirName = `${mm}-${dd}-${input.dirName}`
  const finalDir = join(tasksRoot, finalDirName)
  if (existsSync(finalDir)) return { ok: false, error: `任务目录 ${finalDirName} 已存在` }
  const jiraKey = input.jiraKey
  if (jiraKey) {
    const existing = [...(latestSnapshot?.tasks ?? []), ...(latestSnapshot?.archived ?? [])]
      .find((t) => String(t.record?.meta?.jiraKey ?? '').toUpperCase() === jiraKey.toUpperCase())
    if (existing) return { ok: false, error: `Jira ${jiraKey} 已关联任务 ${existing.dirName}` }
  }
  try {
    mkdirSync(finalDir, { recursive: true })
    const meta: Record<string, unknown> = {}
    meta.origin = input.origin ?? (input.jiraKey ? 'jira' : 'panel')
    if (input.jiraKey) {
      meta.jiraKey = input.jiraKey
      meta.jiraUrl = input.jiraUrl ?? ''
    }
    const record: Record<string, unknown> = {
      id: input.dirName,
      name: input.dirName,
      title: input.title,
      description: input.description,
      status: input.status,
      dev_type: input.devType ?? null,
      scope: input.scope ?? null,
      package: null,
      priority: input.priority,
      creator: latestSnapshot?.meta.developer ?? getSettings().jira.user ?? 'panel',
      assignee: input.assignee,
      createdAt: `${today.getFullYear()}-${mm}-${dd}`,
      completedAt: null,
      branch: input.branch ?? null,
      base_branch: null,
      worktree_path: null,
      commit: null,
      pr_url: null,
      subtasks: input.subtasks ?? [],
      children: [],
      parent: null,
      relatedFiles: [],
      notes: input.jiraKey ? `从 Jira 导入：${input.jiraKey}\n${input.jiraUrl}` : '',
      meta
    }
    if (input.workflow) record.workflow = input.workflow
    writeFileSync(join(finalDir, 'task.json'), JSON.stringify(record, null, 2) + '\n', 'utf-8')
    sendSnapshot()
    return { ok: true, dirName: finalDirName }
  } catch (e) {
    return { ok: false, error: errorText(e, '创建任务失败') }
  }
}

function createTaskFromJira(input: {
  dirName: string
  title: string
  description: string
  status: string
  priority: string
  assignee: string
  jiraKey: string
  jiraUrl: string
}): { ok: boolean; error?: string; dirName?: string } {
  return createTaskRecord(input)
}

function deleteTaskRecord(taskDir: string, expectedMtime?: number): { ok: boolean; error?: string; conflict?: boolean } {
  if (!projectRoot || !latestSnapshot) return { ok: false, error: '未打开项目' }
  const task = latestSnapshot.tasks.find((t) => t.dirName === taskDir || t.path.endsWith(taskDir))
  if (!task?.record) return { ok: false, error: `任务不存在: ${taskDir}` }
  if (expectedMtime !== undefined && Math.abs(task.taskJsonMtime - expectedMtime) > 50) {
    return { ok: false, conflict: true, error: '待办已被外部修改，请刷新后重试' }
  }
  const tasksRoot = resolve(projectRoot, '.trellis', 'tasks') + sep
  const target = resolve(task.path)
  if (!target.startsWith(tasksRoot) || target === resolve(tasksRoot)) {
    return { ok: false, error: '非法任务目录' }
  }
  try {
    rmSync(target, { recursive: true, force: false })
    sendSnapshot()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: errorText(e, '删除待办失败') }
  }
}

/** Derive a filesystem-safe slug from a free-form requirement title. */
function slugifyTitle(title: string): string {
  const slug = title
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return slug || 'req'
}

/* ---------------- IPC ---------------- */

function registerIpc(): void {
  ipcMain.handle('project:pick', async () => {
    if (!win) return null
    const res = await dialog.showOpenDialog(win, {
      title: '选择 Trellis 项目文件夹',
      properties: ['openDirectory']
    })
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]
  })

  ipcMain.handle('project:open', (_e, root: string) => {
    try {
      const snap = scanProject(root)
      if (!snap.meta.trellisExists) {
        return { ok: false, error: '该目录下没有 .trellis/ —— 请先在项目中运行 trellis init' }
      }
      projectRoot = snap.meta.root
      pushRecentProject(projectRoot)
      watcher.start(projectRoot, sendSnapshot, routeSpecFileSync)
      syncWeknoraSpecConfig()
      clearGitCache()
      latestSnapshot = snap
      knownTaskDirs = new Set(snap.tasks.map((t) => t.dirName))
      recordActivity(snap)
      return { ok: true, snapshot: snap }
    } catch (e) {
      return { ok: false, error: errorText(e, '打开项目失败') }
    }
  })

  ipcMain.handle('project:snapshot', () => {
    if (!projectRoot) return null
    try {
      return scanProject(projectRoot)
    } catch {
      return null
    }
  })

  ipcMain.handle('project:close', () => {
    watcher.stop()
    projectRoot = null
    knownTaskDirs = new Set()
    syncWeknoraSpecConfig()
  })

  ipcMain.handle('task:update', (_e, taskDir: string, patch: Record<string, unknown>, expectedMtime?: number) => {
    try {
      if (!projectRoot) return { ok: false, error: '未打开项目' }
      updateTaskRecordAt(projectRoot, taskDir, patch, expectedMtime)
      sendSnapshot()
      return { ok: true }
    } catch (e) {
      const conflict = typeof e === 'object' && e !== null && 'conflict' in e && (e as { conflict?: unknown }).conflict
      const msg = errorMessage(e)
      if (conflict) return { ok: false, conflict: true, error: msg }
      return { ok: false, error: msg ?? '写入 task.json 失败' }
    }
  })

  ipcMain.handle('task:delete', (_e, taskDir: string, expectedMtime?: number) => deleteTaskRecord(taskDir, expectedMtime))

  ipcMain.handle('task:createFromJira', (_e, input) => createTaskFromJira(input))

  ipcMain.handle('task:create', (_e, input: { title: string; description: string; priority: string }) => {
    const dirName = slugifyTitle(input.title)
    return createTaskRecord({
      dirName,
      title: input.title,
      description: input.description,
      status: 'planning',
      priority: input.priority || 'P2',
      assignee: latestSnapshot?.meta.developer ?? ''
    })
  })

  ipcMain.handle('todo:list', () => {
    if (!projectRoot) return { ok: false, error: '未打开项目' }
    return { ok: true, todos: listTodos(projectRoot) }
  })

  ipcMain.handle('todo:save', (_e, input) => {
    if (!projectRoot) return { ok: false, error: '未打开项目' }
    try {
      const todo = saveTodo(projectRoot, input)
      return { ok: true, todo }
    } catch (e) {
      return { ok: false, error: errorText(e, '保存待办失败') }
    }
  })

  ipcMain.handle('todo:delete', (_e, id: string) => {
    if (!projectRoot) return { ok: false, error: '未打开项目' }
    try {
      deleteTodo(projectRoot, id)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: errorText(e, '删除待办失败') }
    }
  })

  ipcMain.handle('fs:readText', (_e, absPath: string) => {
    const base = safeReadText(absPath)
    if (base.ok) {
      const withM = readTextWithMtime(absPath)
      return { ...base, mtime: withM.mtime }
    }
    return base
  })

  ipcMain.handle('fs:writeSpec', (_e, absPath: string, content: string, expectedMtime?: number) => {
    try {
      if (!projectRoot) return { ok: false, error: '未打开项目' }
      writeSpecFile(projectRoot, absPath, content, expectedMtime)
      sendSnapshot()
      return { ok: true }
    } catch (e) {
      const conflict = typeof e === 'object' && e !== null && 'conflict' in e && (e as { conflict?: unknown }).conflict
      const msg = errorMessage(e)
      if (conflict) return { ok: false, conflict: true, error: msg }
      return { ok: false, error: msg ?? '写入失败' }
    }
  })

  ipcMain.handle('spec:backlinks', () => {
    if (!projectRoot) return { ok: false, error: '未打开项目' }
    try {
      return { ok: true, counts: computeSpecBacklinks(projectRoot) }
    } catch (e) {
      return { ok: false, error: errorText(e, '统计失败') }
    }
  })

  ipcMain.handle('docs:search', (_e, query: string, group: 'all' | 'spec' | 'workspace') => {
    if (!projectRoot) return { ok: false, error: '未打开项目', hits: [] }
    try {
      return searchDocs(projectRoot, String(query ?? ''), group === 'spec' || group === 'workspace' ? group : 'all')
    } catch (e) {
      return { ok: false, error: errorText(e, '检索失败'), hits: [] }
    }
  })

  ipcMain.handle('git:taskInfo', (_e, dirName: string) => {
    if (!projectRoot || !isGitRepo(projectRoot)) return { dirName, branchExists: false, currentBranch: null, ahead: 0, behind: 0, merged: false, commits: [], worktreeDirty: false, error: '项目不是 git 仓库' }
    const t = findTask(dirName)
    if (!t) return { dirName, branchExists: false, currentBranch: null, ahead: 0, behind: 0, merged: false, commits: [], worktreeDirty: false, error: '任务不存在' }
    return taskGitInfo(projectRoot, dirName, t.record?.branch ?? null, t.record?.base_branch ?? null)
  })

  ipcMain.handle('git:createBranch', (_e, name: string, fromBase: string) => {
    if (!projectRoot) return { ok: false, error: '未打开项目' }
    return createBranch(projectRoot, name, fromBase)
  })

  ipcMain.handle('analytics:get', () => {
    if (!latestSnapshot) return null
    return getAnalytics(latestSnapshot)
  })

  ipcMain.handle('report:generate', (_e, scope: 'personal' | 'team') => {
    if (!latestSnapshot) return { markdown: '', suggestedFileName: '' }
    return generateWeeklyReport(latestSnapshot, {
      scope,
      developer: latestSnapshot.meta.developer,
      projectName: latestSnapshot.meta.name
    })
  })

  ipcMain.handle('report:standup', () => {
    if (!latestSnapshot) return { markdown: '', suggestedFileName: '' }
    return generateStandup(latestSnapshot)
  })

  ipcMain.handle('channel:action', (_e, args: string[]) => {
    if (!projectRoot) return { ok: false, error: '未打开项目' }
    const safe = (Array.isArray(args) ? args : []).map((a) => String(a))
    return channelAction(projectRoot, getSettings().cliCommand, safe)
  })

  /* ---------------- Studio 定制中心 ---------------- */

  ipcMain.handle('studio:scan', () => {
    if (!projectRoot) return { ok: false, error: '未打开项目' }
    try {
      return { ok: true, scan: scanStudio(projectRoot) }
    } catch (e) {
      return { ok: false, error: errorText(e, '扫描失败') }
    }
  })

  ipcMain.handle('studio:read', (_e, absPath: string) => {
    if (!projectRoot) return { ok: false, error: '未打开项目' }
    return studioReadText(projectRoot, absPath)
  })

  ipcMain.handle('studio:write', (_e, absPath: string, content: string, expectedMtime?: number) => {
    if (!projectRoot) return { ok: false, error: '未打开项目' }
    return studioWriteText(projectRoot, absPath, content, expectedMtime)
  })

  ipcMain.handle('studio:delete', (_e, absPath: string) => {
    if (!projectRoot) return { ok: false, error: '未打开项目' }
    return studioDelete(projectRoot, absPath)
  })

  ipcMain.handle('studio:setConfig', (_e, patch: Record<string, unknown>) => {
    if (!projectRoot) return { ok: false, error: '未打开项目' }
    try {
      setConfigKeys(projectRoot, patch ?? {})
      return { ok: true }
    } catch (e) {
      return { ok: false, error: errorText(e, '写入 config.yaml 失败') }
    }
  })

  ipcMain.handle('studio:setDeveloper', (_e, content: string) => {
    if (!projectRoot) return { ok: false, error: '未打开项目' }
    try {
      setDeveloperFile(projectRoot, String(content ?? ''))
      return { ok: true }
    } catch (e) {
      return { ok: false, error: errorText(e, '写入 .developer 失败') }
    }
  })

  ipcMain.handle('studio:createWorkflow', (_e, id: string) => {
    if (!projectRoot) return { ok: false, error: '未打开项目' }
    return createWorkflow(projectRoot, String(id ?? ''))
  })

  ipcMain.handle('studio:createExtension', (_e, kind: string, platform: string, name: string) => {
    if (!projectRoot) return { ok: false, error: '未打开项目' }
    if (!['command', 'agent', 'skill'].includes(kind)) return { ok: false, error: '未知扩展类型' }
    return createExtension(projectRoot, kind as 'command' | 'agent' | 'skill', platform, String(name ?? ''))
  })

  /* ---------------- Knowledge 知识库 ---------------- */

  ipcMain.handle('kb:search', (_e, library: string, query: string) => {
    if (!projectRoot) {
      return { ok: false, error: '未打开项目', hits: [], docs: [], totalDocs: 0, elapsedMs: 0 }
    }
    try {
      const lib = ['requirements', 'spec', 'wiki', 'archive'].includes(library) ? library : 'all'
      return kbSearch(projectRoot, lib as 'all', String(query ?? ''))
    } catch (e) {
      return { ok: false, error: errorText(e, '检索失败'), hits: [], docs: [], totalDocs: 0, elapsedMs: 0 }
    }
  })

  /* ---------------- WeKnora 公司库（联邦检索 / 阅读） ---------------- */

  /** 渲染层传入草稿配置：密钥留空则回落到已保存值（加密保存后无需重输即可测试） */
  const mergeWeknoraDraft = (cfg: WeknoraConfig | undefined): WeknoraConfig => {
    const saved = getSettings().weknora
    if (!cfg || typeof cfg !== 'object') return saved
    return {
      ...saved,
      ...cfg,
      apiKey: typeof cfg.apiKey === 'string' && cfg.apiKey ? cfg.apiKey : saved.apiKey,
      apiKeyEncrypted: typeof cfg.apiKey === 'string' && cfg.apiKey ? false : saved.apiKeyEncrypted,
      mcpToken: typeof cfg.mcpToken === 'string' && cfg.mcpToken ? cfg.mcpToken : saved.mcpToken,
      mcpTokenEncrypted: typeof cfg.mcpToken === 'string' && cfg.mcpToken ? false : saved.mcpTokenEncrypted
    }
  }

  ipcMain.handle('weknora:test', (_e, cfg: WeknoraConfig) => weknoraTest(mergeWeknoraDraft(cfg)))

  ipcMain.handle('weknora:search', (_e, query: string, limit?: number) =>
    weknoraSearch(getSettings().weknora, String(query ?? ''), Math.min(Math.max(Number(limit) || 10, 1), 30))
  )

  ipcMain.handle('weknora:listDocs', (_e, kbId: string) => weknoraListDocs(getSettings().weknora, String(kbId ?? '')))

  ipcMain.handle('weknora:read', (_e, knowledgeId: string) => weknoraReadDoc(getSettings().weknora, String(knowledgeId ?? '')))

  ipcMain.handle('weknora:testMcp', (_e, url: string, token: string) => {
    const merged = mergeWeknoraDraft({ ...getSettings().weknora, mcpUrl: String(url ?? '') })
    const plainToken = typeof token === 'string' && token ? token : weknoraMcpTokenOf(merged)
    return weknoraTestMcp(merged.mcpUrl, plainToken)
  })

  /* ---------------- Gateway MCP 知识网关 ---------------- */

  ipcMain.handle('gateway:status', async () => {
    return GatewayManager.getStatus(projectRoot || '')
  })

  ipcMain.handle('gateway:search', async (_e, query: string, limit?: number) => {
    return GatewayManager.search(String(query ?? ''), {
      limit: typeof limit === 'number' ? limit : 10,
      root: projectRoot || ''
    })
  })

  ipcMain.handle('gateway:recentLogs', async () => {
    return GatewayManager.getLogs()
  })

  ipcMain.handle('gateway:syncSpec', async (_e, remoteDocId: string, targetFileName: string) => {
    return GatewayManager.syncSpecFromRemote(projectRoot || '', remoteDocId, targetFileName)
  })

  ipcMain.handle('gateway:testProvider', async (_e, providerId: string) => {
    return GatewayManager.testProvider(String(providerId), projectRoot || '')
  })

  ipcMain.handle('gateway:testTool', async (_e, toolName: string, args: Record<string, unknown>) => {
    return GatewayManager.executeTool(String(toolName), args || {}, projectRoot || '')
  })

  ipcMain.handle('gateway:updateSecurity', async (_e, security: GatewaySecurityConfig) => {
    GatewayManager.updateSecurity(security)
    return { ok: true }
  })

  /* ---------------- AI（baseUrl 自定义模型） ---------------- */

  ipcMain.handle('ai:chat', (_e, messages: ChatMessage[]) => {
    const cfg = getSettings().ai
    const safe = (Array.isArray(messages) ? messages : [])
      .filter((m) => m && typeof m.content === 'string' && ['system', 'user', 'assistant'].includes(m.role))
      .slice(0, 40)
      .map((m) => ({ role: m.role, content: String(m.content).slice(0, 32_000) }))
    return aiChat(cfg, safe)
  })

  ipcMain.handle('ai:test', (_e, cfg: AiConfig) => aiTest(cfg))
  ipcMain.handle('ai:fetch-models', (_e, provider: ModelProvider) => fetchModelsFromProvider(provider))
  ipcMain.handle('ai:test-model', (_e, provider: ModelProvider, modelId: string) => testSingleModel(provider, modelId))

  ipcMain.handle('ai:prdDraft', (_e, dirName: string) => {
    const t = findTask(String(dirName))
    if (!t?.record) return { ok: false, error: '任务不存在' }
    const specTitles = flattenSpecNames(latestSnapshot?.spec ?? []).slice(0, 40)
    return aiTaskPrompt(
      getSettings().ai,
      {
        title: t.record.title,
        description: t.record.description,
        notes: t.record.notes,
        subtasks: t.record.subtasks ?? [],
        specTitles,
        devType: t.record.dev_type,
        scope: t.record.scope
      },
      'prd'
    )
  })

  ipcMain.handle('ai:summary', (_e, dirName: string) => {
    const t = findTask(String(dirName))
    if (!t?.record) return { ok: false, error: '任务不存在' }
    return aiTaskPrompt(
      getSettings().ai,
      {
        title: t.record.title,
        description: t.record.description,
        notes: t.record.notes,
        subtasks: t.record.subtasks ?? [],
        specTitles: [],
        devType: t.record.dev_type,
        scope: t.record.scope
      },
      'summary'
    )
  })

  /* ---------------- 规划工作台（Jira/需求 → KB → AI 计划） ---------------- */

  ipcMain.handle('ai:plan', (_e, input: { title: string; description: string; jiraKey?: string; jiraUrl?: string }) => {
    if (!projectRoot) return { ok: false, error: '未打开项目', sources: [], contextChars: 0 }
    return aiPlanTask(projectRoot, getSettings().ai, {
      title: String(input?.title ?? ''),
      description: String(input?.description ?? ''),
      jiraKey: input?.jiraKey ? String(input.jiraKey) : undefined,
      jiraUrl: input?.jiraUrl ? String(input.jiraUrl) : undefined
    }, getSettings().weknora)
  })

  ipcMain.handle('task:createFromPlan', (_e, input) => {
    const dirName = slugifyTitle(String(input?.title ?? ''))
    return createTaskRecord({
      dirName,
      title: String(input?.title ?? ''),
      description: String(input?.description ?? ''),
      status: 'planning',
      priority: String(input?.priority ?? 'P2'),
      assignee: latestSnapshot?.meta.developer ?? '',
      origin: 'plan',
      jiraKey: input?.jiraKey ? String(input.jiraKey) : undefined,
      jiraUrl: input?.jiraUrl ? String(input.jiraUrl) : undefined,
      subtasks: Array.isArray(input?.subtasks) ? input.subtasks.map(String) : [],
      workflow: typeof input?.workflow === 'string' && input.workflow ? input.workflow : null,
      devType: typeof input?.devType === 'string' && input.devType ? input.devType : null,
      scope: typeof input?.scope === 'string' && input.scope ? input.scope : null,
      branch: typeof input?.branch === 'string' && input.branch ? input.branch : null
    })
  })

  ipcMain.handle('plan:handoff', (_e, dirName: string) => {
    if (!projectRoot) return []
    return handoffTexts(projectRoot, String(dirName))
  })

  ipcMain.handle('ai:splitEpic', async (_e, dirName: string) => {
    if (!projectRoot) return { ok: false, error: '未打开项目' }
    const t = findTask(String(dirName))
    if (!t?.record) return { ok: false, error: '任务不存在' }
    let prd: string | null = null
    try {
      prd = readFileSync(join(t.path, 'prd.md'), 'utf-8')
    } catch {
      // 无 PRD 也能按描述拆分
    }
    const res = await aiSplitEpic(getSettings().ai, { title: t.record.title, description: t.record.description, prd })
    if (!res.ok || !res.children) return res
    const created: string[] = []
    const errors: string[] = []
    for (const c of res.children) {
      const r = createTaskRecord({
        dirName: slugifyTitle(c.title),
        title: c.title,
        description: c.description,
        status: 'planning',
        priority: t.record.priority,
        assignee: latestSnapshot?.meta.developer ?? '',
        origin: 'panel',
        subtasks: c.subtasks
      })
      if (r.ok && r.dirName) {
        try {
          const jp = join(projectRoot, '.trellis', 'tasks', r.dirName, 'task.json')
          const rec = JSON.parse(readFileSync(jp, 'utf-8'))
          rec.parent = t.dirName
          writeFileSync(jp, JSON.stringify(rec, null, 2) + '\n', 'utf-8')
        } catch {
          // parent 引用写失败不影响目录创建
        }
        created.push(r.dirName)
      } else {
        errors.push(`${c.title}：${r.error}`)
      }
    }
    if (created.length > 0) sendSnapshot()
    return { ok: created.length > 0, error: errors.length ? errors.join('；') : undefined, created }
  })

  ipcMain.handle('ai:commitMsg', async (_e, dirName: string) => {
    const t = findTask(String(dirName))
    if (!t?.record) return { ok: false, error: '任务不存在' }
    let commits: string[] = []
    if (projectRoot && isGitRepo(projectRoot)) {
      const info = await taskGitInfo(projectRoot, t.dirName, t.record.branch ?? null, t.record.base_branch ?? null)
      commits = info.commits.map((c) => `${c.short} ${c.subject}`)
    }
    return aiCommitMsg(getSettings().ai, { title: t.record.title, description: t.record.description, recentCommits: commits })
  })

  ipcMain.handle('ai:prDesc', async (_e, dirName: string) => {
    const t = findTask(String(dirName))
    if (!t?.record) return { ok: false, error: '任务不存在' }
    return aiPrDesc(getSettings().ai, {
      title: t.record.title,
      description: t.record.description,
      subtasks: t.record.subtasks ?? []
    })
  })

  ipcMain.handle('task:archive', async (_e, dirName: string) => {
    if (!projectRoot || !latestSnapshot) return { ok: false, error: '未打开项目' }
    const t = findTask(String(dirName))
    if (!t) return { ok: false, error: '任务不存在' }
    if (t.archived) return { ok: false, error: '任务已在归档中' }
    const target = resolve(t.path)
    const tasksRoot = resolve(projectRoot, '.trellis', 'tasks') + sep
    if (!target.startsWith(tasksRoot)) return { ok: false, error: '非法任务目录' }
    try {
      const jsonPath = join(target, 'task.json')
      const rec = JSON.parse(readFileSync(jsonPath, 'utf-8'))
      if (!rec.completedAt) {
        const now = new Date()
        const pad = (x: number): string => String(x).padStart(2, '0')
        rec.completedAt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
        writeFileSync(jsonPath, JSON.stringify(rec, null, 2) + '\n', 'utf-8')
      }
    } catch {
      // task.json 缺失时仍允许归档
    }
    // WeKnora 沉淀素材必须在 rename 前读取（rename 后 t.path 失效）
    const wkCfg = getSettings().weknora
    let wkPayload: ReturnType<typeof buildArchiveDoc> | null = null
    if (wkCfg.enabled && wkCfg.autoPushArchive && wkCfg.archiveKbId) {
      const rec = t.record
      let prd: string | null = null
      try {
        prd = readFileSync(join(target, 'prd.md'), 'utf-8')
      } catch {
        // 无 PRD 时用描述字段
      }
      let commits: string[] = []
      if (rec?.branch && isGitRepo(projectRoot)) {
        try {
          const gi = await taskGitInfo(projectRoot, t.dirName, rec.branch, rec.base_branch ?? null)
          commits = gi.commits.map((c) => `\`${c.short}\` ${c.subject}`)
        } catch {
          // git 信息缺失不影响沉淀
        }
      }
      const meta = rec?.meta as Record<string, unknown> | undefined
      wkPayload = buildArchiveDoc({
        projectName: latestSnapshot.meta.name,
        dirName: t.dirName,
        title: rec?.title ?? t.dirName,
        completedAt: rec?.completedAt ?? null,
        jiraKey: (typeof meta?.jiraKey === 'string' && meta.jiraKey) || t.jiraKey || null,
        jiraUrl: typeof meta?.jiraUrl === 'string' ? meta.jiraUrl : null,
        branch: rec?.branch ?? null,
        prUrl: rec?.pr_url ?? null,
        notes: rec?.notes ?? '',
        description: rec?.description ?? '',
        subtasks: rec?.subtasks ?? [],
        prd,
        commits
      })
    }
    const archiveRoot = join(projectRoot, '.trellis', 'archive')
    mkdirSync(archiveRoot, { recursive: true })
    let destName = basename(target)
    let dest = join(archiveRoot, destName)
    let i = 2
    while (existsSync(dest)) {
      destName = `${basename(target)}-${i}`
      dest = join(archiveRoot, destName)
      i += 1
    }
    try {
      renameSync(target, dest)
      sendSnapshot()
      // 归档成功后异步沉淀公司库（不阻塞归档返回；结果走 toast）
      if (wkPayload) {
        const payload = wkPayload
        void weknoraPushManual(wkCfg, wkCfg.archiveKbId, payload).then((r) => {
          broadcastToWindows('bridge:toast', r.ok
            ? { kind: 'success', title: '已沉淀到公司库（WeKnora）', body: payload.title }
            : { kind: 'warn', title: '公司库沉淀失败', body: r.error })
        })
      }
      return { ok: true, dirName: destName }
    } catch (e) {
      return { ok: false, error: errorText(e, '归档失败') }
    }
  })

  /* ---------------- KB-MCP（AI 编码工具的持久记忆大脑） ---------------- */

  ipcMain.handle('kbmcp:install', () => {
    if (!projectRoot) return { ok: false, error: '未打开项目' }
    return kbMcpInstall(projectRoot)
  })

  ipcMain.handle('kbmcp:status', () => kbMcpStatus(projectRoot))

  ipcMain.handle('studio:syncExtension', (_e, sourcePath: string, targets: string[]) => {
    if (!projectRoot) return { ok: false, error: '未打开项目' }
    const list = Array.isArray(targets) ? targets.map(String) : []
    if (list.length === 0) return { ok: false, error: '未选择目标平台' }
    const res = syncExtensionToPlatforms(projectRoot, String(sourcePath), list)
    if (res.written.length > 0) sendSnapshot()
    return { ok: true, ...res }
  })

  ipcMain.handle('task:writeArtifact', (_e, dirName: string, fileName: string, content: string) => {
    if (!projectRoot) return { ok: false, error: '未打开项目' }
    const t = findTask(String(dirName))
    if (!t) return { ok: false, error: '任务不存在' }
    const name = String(fileName ?? '').trim()
    if (!/^[\w.-]+\.(md|markdown|txt|yaml|yml|json)$/i.test(name)) return { ok: false, error: '文件名不合法（仅允许 md/txt/yaml/json）' }
    try {
      const p = join(t.path, name)
      writeFileSync(p, String(content ?? ''), 'utf-8')
      sendSnapshot()
      return { ok: true, path: p }
    } catch (e) {
      return { ok: false, error: errorText(e, '写入失败') }
    }
  })

  ipcMain.handle('report:save', (_e, fileName: string, markdown: string) => {
    if (!projectRoot) return { ok: false, error: '未打开项目' }
    return saveReport(projectRoot, fileName, markdown)
  })

  ipcMain.handle('channel:list', () => {
    if (!projectRoot) return { ok: false, error: '未打开项目' }
    return listChannels(projectRoot)
  })

  ipcMain.handle('channel:send', (_e, name: string, text: string) => {
    if (!projectRoot) return { ok: false, error: '未打开项目' }
    return channelSend(projectRoot, getSettings().cliCommand, name, text)
  })

  ipcMain.handle('shell:reveal', (_e, p: string) => {
    shell.showItemInFolder(p)
  })
  ipcMain.handle('shell:openInEditor', (_e, p: string) => {
    if (process.env.VSCODE) shell.openExternal(`vscode://file/${p}`)
    else shell.openPath(p)
  })
  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
  })

  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:set', (_e, patch) => {
    const prevJira = getSettings().jira
    let jira = patch.jira
    if (jira && typeof jira.password === 'string' && jira.password && !jira.passwordEncrypted && jira.password !== prevJira.password) {
      jira = { ...jira, ...protectPassword(jira.password) }
    }
    const prevGitlab = getSettings().gitlab
    let gitlab = patch.gitlab as GitLabConfig | undefined
    if (gitlab && typeof gitlab.password === 'string' && gitlab.password && !gitlab.passwordEncrypted && gitlab.password !== prevGitlab.password) {
      gitlab = { ...gitlab, ...protectGitlabPassword(gitlab.password) }
    }
    const prevAi = getSettings().ai
    let ai = patch.ai as AiConfig | undefined
    if (ai) {
      if (typeof ai.apiKey === 'string' && ai.apiKey && !ai.apiKeyEncrypted && ai.apiKey !== prevAi.apiKey) {
        ai = { ...ai, ...protectAiKey(ai.apiKey) }
      }
      if (Array.isArray(ai.providers)) {
        ai.providers = ai.providers.map((p) => {
          const prevP = prevAi.providers?.find((x) => x.id === p.id)
          if (p.apiKey && !p.apiKeyEncrypted && p.apiKey !== prevP?.apiKey) {
            const enc = protectAiKey(p.apiKey)
            return { ...p, apiKey: enc.apiKey, apiKeyEncrypted: enc.apiKeyEncrypted }
          }
          return p
        })
      }
    }
    const prevWeknora = getSettings().weknora
    let weknora = patch.weknora as WeknoraConfig | undefined
    if (weknora) {
      if (typeof weknora.apiKey === 'string' && weknora.apiKey && !weknora.apiKeyEncrypted && weknora.apiKey !== prevWeknora.apiKey) {
        weknora = { ...weknora, ...protectWeknoraKey(weknora.apiKey) }
      }
      if (typeof weknora.mcpToken === 'string' && weknora.mcpToken && !weknora.mcpTokenEncrypted && weknora.mcpToken !== prevWeknora.mcpToken) {
        weknora = { ...weknora, ...protectWeknoraMcpToken(weknora.mcpToken) }
      }
      if (!Array.isArray(weknora.searchKbIds)) weknora = { ...weknora, searchKbIds: [] }
    }
    const next = setSettings({ ...patch, jira, gitlab, ai, weknora })
    if (gitlab) {
      clearGitlabTokenCache()
      clearGitlabStatusCache()
    }
    syncWeknoraSpecConfig()
    applyAutoStart()
    restartJiraAutoSync()
    return next
  })

  ipcMain.handle('cli:run', (_e, args: string[]) => {
    if (!win || !projectRoot) return -1
    const { cliCommand } = getSettings()
    return runCli(win, projectRoot, cliCommand, args)
  })
  ipcMain.handle('cli:abort', (_e, runId: number) => abortCli(runId))

  /* AI bridge */
  ipcMain.handle('bridge:installTpanel', () => installTpanel(getSettings().bridgeToken))
  ipcMain.handle('bridge:pullFocus', () => {
    const payload = pendingFocusTask ? { taskDir: pendingFocusTask, root: pendingFocusRoot } : null
    pendingFocusTask = null
    pendingFocusRoot = null
    return payload
  })
  ipcMain.handle('bridge:installHooks', () =>
    projectRoot ? installTrellisHooks(projectRoot) : { ok: false, error: '未打开项目' }
  )
  ipcMain.handle('util:clipboard', (_e, text: string) => {
    clipboard.writeText(text)
  })
  ipcMain.on('win:capsule', (_e, on: boolean) => {
    if (on) {
      if (capsule && !capsule.isDestroyed()) {
        capsule.show()
        capsule.focus()
        win?.hide()
      } else {
        createCapsule(capsuleShape)
      }
    } else {
      if (capsule && !capsule.isDestroyed()) capsule.hide()
      win?.show()
      win?.focus()
    }
  })
  ipcMain.handle('capsule:onTop', (_e, on: boolean) => {
    capsuleOnTop = on
    if (capsule && !capsule.isDestroyed()) capsule.setAlwaysOnTop(on, 'screen-saver')
  })
  ipcMain.handle('capsule:setShape', async (_e, shape: 'pill' | 'card') => {
    capsuleShape = shape
    if (!capsule || capsule.isDestroyed()) return
    const sz = getCapsuleBounds(shape)

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
  ipcMain.handle('capsule:resize', (_e, width: number, height: number) => {
    if (!capsule || capsule.isDestroyed()) return
    capsule.setSize(Math.round(width), Math.round(height), true)
  })
  ipcMain.handle('capsule:close', () => {
    if (capsule && !capsule.isDestroyed()) {
      capsule.hide()
    }
  })

  /* http api（只读 Web 看板） */
  ipcMain.handle('mcp:info', () => {
    const st = httpApiStatus()
    return {
      running: st.running,
      port: st.port,
      webBoardUrl: st.running && getSettings().httpApi.webBoard ? `http://127.0.0.1:${st.port}/` : null
    }
  })
  ipcMain.handle('mcp:toggle', (_e, on: boolean) => {
    const s = setSettings({ httpApi: { ...getSettings().httpApi, enabled: on } })
    restartHttpApi()
    return { ok: httpApiStatus().running === on, error: httpApiStatus().running === on ? undefined : '启动失败（端口占用？）' }
  })

  /* Jira */
  ipcMain.handle('jira:test', (_e, cfg: JiraConfig) => jiraTest(cfg))
  ipcMain.handle('jira:search', (_e, cfg: JiraConfig, jql: string) => jiraSearch(cfg, jql))
  ipcMain.handle('jira:transitions', (_e, cfg: JiraConfig, key: string) => jiraTransitions(cfg, key))
  ipcMain.handle('jira:transition', (_e, cfg: JiraConfig, key: string, tid: string) => jiraTransition(cfg, key, tid))
  ipcMain.handle('jira:comment', (_e, cfg: JiraConfig, key: string, body: string) => jiraComment(cfg, key, body))

  /* GitLab connector */
  ipcMain.handle('gitlab:test', (_e, cfg: GitLabConfig) => gitlabTest(cfg))
  ipcMain.handle('gitlab:taskStatus', (_e, dirName: string) => {
    const cfg = getSettings().gitlab
    const t = findTask(dirName)
    if (!t) return { ok: false, error: '任务不存在', mr: null, pipeline: null }
    return gitlabTaskStatus(cfg, dirName, t.record?.branch ?? null, t.record?.base_branch ?? null)
  })
  ipcMain.handle('gitlab:createMr', (_e, dirName: string) => {
    const cfg = getSettings().gitlab
    const t = findTask(dirName)
    if (!t?.record?.branch) return { ok: false, error: '任务没有关联分支——先在任务详情里创建分支' }
    return gitlabCreateMr(cfg, {
      branch: t.record.branch,
      baseBranch: t.record.base_branch,
      title: `${dirName} ${t.record.title}`,
      description: t.record.description ? `> ${t.record.description.slice(0, 500)}` : ''
    })
  })

  ipcMain.on('win:minimize', () => {
    const w = BrowserWindow.getFocusedWindow() ?? win
    w?.minimize()
  })
  ipcMain.on('win:maximize', () => {
    const w = BrowserWindow.getFocusedWindow() ?? win
    if (w?.isMaximized()) w.unmaximize()
    else w?.maximize()
  })
  ipcMain.on('win:close', () => {
    const w = BrowserWindow.getFocusedWindow()
    if (w && w !== win) w.close()
    else win?.hide() // close-to-tray
  })
}

/* ---------------- app lifecycle ---------------- */

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
    registerIpc()
    createWindow()
    wireBridge()
    createTray()
    applyAutoStart()
    registerGlobalShortcut()
    setupUpdater()
    restartHttpApi()
    restartJiraAutoSync()
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
    watcher.stop()
    stopInbox()
    abortAll()
    globalShortcut.unregisterAll()
    stopHttpApi()
    weknoraSpecSync.stop()
  })
}
