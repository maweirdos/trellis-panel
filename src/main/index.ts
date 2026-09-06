import { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, globalShortcut, clipboard, safeStorage, Notification, nativeImage } from 'electron'
import { join, resolve, sep, extname, basename } from 'path'
import { readFileSync, writeFileSync, statSync, existsSync, mkdirSync } from 'fs'
import { scanProject, updateTaskRecordAt, writeSpecFile, computeSpecBacklinks, readTextWithMtime, TEXT_EXTS } from './services/scan'
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
import { startHttpApi, stopHttpApi, httpApiStatus, mcpClientConfigSnippet, setMcpDeps } from './services/httpapi'
import { taskGitInfo, createBranch, clearGitCache, isGitRepo } from './services/git'
import { recordActivity, getAnalytics } from './services/activity'
import { generateWeeklyReport, saveReport } from './services/report'
import { listChannels, channelSend } from './services/channels'
import {
  gitlabTest,
  gitlabTaskStatus,
  gitlabCreateMr,
  protectGitlabPassword,
  clearGitlabTokenCache,
  clearGitlabStatusCache
} from './services/gitlab'
import type { GitLabConfig, JiraConfig, ToastEvent } from '../shared/types'

let win: BrowserWindow | null = null
let capsule: BrowserWindow | null = null
let capsuleOnTop = true
let tray: Tray | null = null
let projectRoot: string | null = null
const watcher = new TrellisWatcher()
let jiraSyncTimer: ReturnType<typeof setInterval> | null = null
let latestSnapshot: ReturnType<typeof scanProject> | null = null
/** task dirs seen in the current project — drives the Inbox "new task" diff */
let knownTaskDirs = new Set<string>()

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

function createCapsule(): void {
  if (capsule && !capsule.isDestroyed()) {
    capsule.show()
    capsule.focus()
    return
  }
  capsule = new BrowserWindow({
    width: 400,
    height: 210,
    minWidth: 320,
    minHeight: 160,
    maxWidth: 560,
    frame: false,
    resizable: true,
    fullscreenable: false,
    alwaysOnTop: capsuleOnTop,
    skipTaskbar: false,
    backgroundColor: '#12151c',
    title: 'Trellis 胶囊',
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
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    capsule.loadURL(devUrl + '?mode=capsule')
  } else {
    capsule.loadFile(join(__dirname, '../renderer/index.html'), { query: { mode: 'capsule' } })
  }
  win?.hide()
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
        if (capsule && !capsule.isDestroyed()) capsule.close()
        else createCapsule()
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
  if (capsule && !capsule.isDestroyed()) capsule.close()
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
  } catch (e: any) {
    console.error('rescan failed:', e?.message)
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
  broadcastToWindows('inbox:new', { projectRoot, items })
  const first = items[0]
  toast({
    kind: 'info',
    title: items.length === 1 ? '新任务已创建' : `${items.length} 个新任务已创建`,
    body: items.length === 1 ? first.title : `${first.title} 等`
  })
}

function focusAndShow(): void {
  const target = capsule && !capsule.isDestroyed() ? capsule : win
  if (target && !target.isDestroyed()) {
    target.show()
    target.focus()
  }
}

function focusMainAndOpenTask(taskDir: string): void {
  if (capsule && !capsule.isDestroyed()) capsule.close()
  if (!win || win.isDestroyed()) {
    createWindow()
  }
  win!.show()
  win!.focus()
  const normalized = resolve(taskDir)
  if (projectRoot && normalized.startsWith(resolve(projectRoot) + sep)) {
    win!.webContents.send('bridge:focus-task', basename(normalized))
  }
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

/* ---------------- MCP helper exports (used by httpapi) ---------------- */

setMcpDeps({
  updateTaskStatus: async (dir, status) => {
    if (!projectRoot) return { text: '未打开项目', isError: true }
    const t = findTask(dir)
    if (!t) return { text: `任务不存在: ${dir}`, isError: true }
    try {
      updateTaskRecordAt(projectRoot, t.path, { status })
      sendSnapshot()
      return { text: `已更新 ${t.dirName} 状态为 ${status}` }
    } catch (e: any) {
      return { text: String(e?.message ?? e), isError: true }
    }
  },
  searchSpec: async (query) => {
    const snap0 = projectRoot ? latestSnapshot : null
    if (!snap0) return { text: '未打开项目', isError: true }
    const q = query.toLowerCase()
    const hits: Array<{ file: string; line: number; text: string }> = []
    const walk = (nodes: typeof snap0.spec): void => {
      for (const n of nodes) {
        if (n.type === 'dir' && n.children) walk(n.children)
        else if (n.type === 'file' && /\.(md|markdown|txt)$/i.test(n.name)) {
          try {
            const lines = readFileSync(n.path, 'utf-8').split(/\r?\n/)
            lines.forEach((l, i) => {
              if (l.toLowerCase().includes(q))
                hits.push({ file: n.path.split('spec').pop() ?? n.name, line: i + 1, text: l.trim().slice(0, 160) })
            })
          } catch {
            // skip
          }
        }
      }
    }
    walk(snap0.spec)
    if (hits.length === 0) return { text: `没有包含 “${query}” 的规范内容` }
    return { text: JSON.stringify({ total: hits.length, hits: hits.slice(0, 30) }, null, 2) }
  },
  readSpec: async (relPath) => {
    if (!projectRoot) return { text: '未打开项目', isError: true }
    const p = resolve(projectRoot, '.trellis', 'spec', relPath)
    if (!p.startsWith(resolve(projectRoot, '.trellis', 'spec') + sep)) return { text: '路径非法', isError: true }
    try {
      return { text: readFileSync(p, 'utf-8') }
    } catch (e: any) {
      return { text: String(e?.message ?? e), isError: true }
    }
  }
})

function findTask(dir: string) {
  const snap = latestSnapshot
  if (!snap) return null
  return (
    snap.tasks.find((x) => x.dirName === dir || x.path.endsWith(dir)) ??
    snap.archived.find((x) => x.dirName === dir || x.path.endsWith(dir)) ??
    null
  )
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
    void startHttpApi(s.httpApi.port, s.bridgeToken, s.httpApi.lanAccess, () => latestSnapshot)
  } else {
    stopHttpApi()
  }
}

/* ---------------- safe read ---------------- */

function safeReadText(absPath: string): { ok: boolean; error?: string; content?: string; mtime?: number } {
  if (!projectRoot) return { ok: false, error: '未打开项目' }
  const root = resolve(projectRoot)
  const p = resolve(absPath)
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
  } catch (e: any) {
    return { ok: false, error: e?.message ?? '读取失败' }
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
  jiraKey?: string
  jiraUrl?: string
}

function createTaskRecord(input: CreateTaskInput): { ok: boolean; error?: string; dirName?: string } {
  if (!projectRoot) return { ok: false, error: '未打开项目' }
  const tasksRoot = join(projectRoot, '.trellis', 'tasks')
  const today = new Date()
  const pad = (x: number): string => String(x + 1).padStart(2, '0')
  const mm = pad(today.getMonth())
  const dd = pad(today.getDate())
  const finalDirName = `${mm}-${dd}-${input.dirName}`
  const finalDir = join(tasksRoot, finalDirName)
  if (existsSync(finalDir)) return { ok: false, error: `任务目录 ${finalDirName} 已存在` }
  try {
    mkdirSync(finalDir, { recursive: true })
    const meta: Record<string, unknown> = {}
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
      dev_type: null,
      scope: null,
      package: null,
      priority: input.priority,
      creator: latestSnapshot?.meta.developer ?? getSettings().jira.user ?? 'panel',
      assignee: input.assignee,
      createdAt: `${today.getFullYear()}-${mm}-${dd}`,
      completedAt: null,
      branch: null,
      base_branch: null,
      worktree_path: null,
      commit: null,
      pr_url: null,
      subtasks: [],
      children: [],
      parent: null,
      relatedFiles: [],
      notes: input.jiraKey ? `从 Jira 导入：${input.jiraKey}\n${input.jiraUrl}` : '',
      meta
    }
    writeFileSync(join(finalDir, 'task.json'), JSON.stringify(record, null, 2) + '\n', 'utf-8')
    sendSnapshot()
    return { ok: true, dirName: finalDirName }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? '创建任务失败' }
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

/** Derive a filesystem-safe slug from a free-form requirement title. */
function slugifyTitle(title: string): string {
  const slug = title
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return slug || 'req'
}

/* ---------------- ai prompt ---------------- */

function buildAiPrompt(taskDir: string | null): string {
  if (!projectRoot) return ''
  let taskBlock = ''
  if (taskDir) {
    const jsonPath = join(projectRoot, '.trellis', 'tasks', taskDir, 'task.json')
    try {
      const rec = JSON.parse(readFileSync(jsonPath, 'utf-8'))
      taskBlock = [
        `任务目录：${taskDir}`,
        `标题：${rec.title ?? ''}`,
        rec.description ? `描述：${rec.description}` : '',
        `状态：${rec.status ?? ''} / 优先级：${rec.priority ?? ''}`,
        rec.notes ? `备注：${rec.notes}` : ''
      ]
        .filter(Boolean)
        .join('\n')
    } catch {
      // task.json unreadable — prompt without details
    }
  }
  return [
    '请按 .trellis/workflow.md 的流程继续当前 Trellis 任务。',
    taskBlock,
    '先读取 .trellis/spec/ 相关规范与任务目录下的 prd.md（如有），再开始实施。'
  ]
    .filter(Boolean)
    .join('\n\n')
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
      watcher.start(projectRoot, sendSnapshot)
      clearGitCache()
      latestSnapshot = snap
      knownTaskDirs = new Set(snap.tasks.map((t) => t.dirName))
      recordActivity(snap)
      return { ok: true, snapshot: snap }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? '打开项目失败' }
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
  })

  ipcMain.handle('task:update', (_e, taskDir: string, patch: Record<string, unknown>, expectedMtime?: number) => {
    try {
      if (!projectRoot) return { ok: false, error: '未打开项目' }
      updateTaskRecordAt(projectRoot, taskDir, patch, expectedMtime)
      sendSnapshot()
      return { ok: true }
    } catch (e: any & { conflict?: boolean }) {
      if (e?.conflict) return { ok: false, conflict: true, error: e.message }
      return { ok: false, error: e?.message ?? '写入 task.json 失败' }
    }
  })

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
    } catch (e: any & { conflict?: boolean }) {
      if (e?.conflict) return { ok: false, conflict: true, error: e.message }
      return { ok: false, error: e?.message ?? '写入失败' }
    }
  })

  ipcMain.handle('spec:backlinks', () => {
    if (!projectRoot) return { ok: false, error: '未打开项目' }
    try {
      return { ok: true, counts: computeSpecBacklinks(projectRoot) }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? '统计失败' }
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
    const next = setSettings({ ...patch, jira, gitlab })
    if (gitlab) {
      clearGitlabTokenCache()
      clearGitlabStatusCache()
    }
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
  ipcMain.handle('bridge:installHooks', () =>
    projectRoot ? installTrellisHooks(projectRoot) : { ok: false, error: '未打开项目' }
  )
  ipcMain.handle('util:clipboard', (_e, text: string) => {
    clipboard.writeText(text)
  })
  ipcMain.on('win:capsule', (_e, on: boolean) => {
    if (on) createCapsule()
    else {
      if (capsule && !capsule.isDestroyed()) capsule.close()
      win?.show()
      win?.focus()
    }
  })
  ipcMain.handle('capsule:onTop', (_e, on: boolean) => {
    capsuleOnTop = on
    if (capsule && !capsule.isDestroyed()) capsule.setAlwaysOnTop(on, 'screen-saver')
  })

  ipcMain.handle('ai:launch', (_e, appId: string, taskDir: string | null) => {
    const root = projectRoot
    if (!root) return { ok: false, error: '未打开项目' }
    const prompt = buildAiPrompt(taskDir)
    const cmd = appId === 'codex' ? 'codex' : appId === 'claude' ? 'claude' : 'zcode'
    try {
      const { spawn } = require('child_process') as typeof import('child_process')
      const child = spawn('wt.exe', ['-d', root, cmd, prompt], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false
      })
      child.on('error', () => {
        spawn(cmd, [prompt], { cwd: root, detached: true, stdio: 'ignore', shell: true })
      })
      child.unref()
      return { ok: true }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? '启动失败（未安装该 CLI？）' }
    }
  })

  /* http api / mcp */
  ipcMain.handle('mcp:info', () => {
    const st = httpApiStatus()
    const snippets = st.port ? mcpClientConfigSnippet(st.port, getSettings().bridgeToken) : { codex: '', claude: '' }
    return {
      running: st.running,
      port: st.port,
      webBoardUrl: st.running && getSettings().httpApi.webBoard ? `http://127.0.0.1:${st.port}/` : null,
      codexConfig: snippets.codex,
      claudeConfig: snippets.claude
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
  })
}
