import { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard } from 'electron'
import { join, resolve, sep, extname, basename } from 'path'
import { readFileSync, writeFileSync, statSync, existsSync, mkdirSync } from 'fs'
import { scanProject, updateTaskRecordAt, TEXT_EXTS } from './services/scan'
import { TrellisWatcher } from './services/watcher'
import { runCli, abortCli, abortAll } from './services/cli'
import { getSettings, setSettings, pushRecentProject } from './services/store'
import { jiraTest, jiraSearch, jiraTransitions, jiraTransition, jiraComment } from './services/jira'
import {
  startInbox,
  stopInbox,
  parseDeepLink,
  handleDeepLink,
  installTpanel,
  installTrellisHooks,
  broadcastToWindows
} from './services/bridge'
import type { JiraConfig } from '../shared/types'

let win: BrowserWindow | null = null
let capsule: BrowserWindow | null = null
let capsuleOnTop = true
let projectRoot: string | null = null
const watcher = new TrellisWatcher()

const MAX_TEXT_BYTES = 5 * 1024 * 1024

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

function toggleCapsule(): void {
  if (capsule && !capsule.isDestroyed()) {
    capsule.close()
    win?.show()
    win?.focus()
  } else {
    createCapsule()
  }
}

function sendSnapshot(): void {
  if (!projectRoot) return
  try {
    broadcastToWindows('project:snapshot', scanProject(projectRoot))
  } catch (e: any) {
    console.error('rescan failed:', e?.message)
  }
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
  if (!win || win.isDestroyed()) return
  win.show()
  win.focus()
  const normalized = resolve(taskDir)
  if (projectRoot && normalized.startsWith(resolve(projectRoot) + sep)) {
    win.webContents.send('bridge:focus-task', basename(normalized))
  }
}

function wireBridge(): void {
  startInbox({
    onTaskEvent: (taskDir, text, source) => {
      sendSnapshot()
      const label = taskDir ? basename(taskDir) : '任务'
      broadcastToWindows('bridge:toast', {
        kind: 'info',
        title: `AI 工具更新了任务`,
        body: text ?? `${source} → ${label}`
      })
    },
    onNotify: (text) => {
      focusAndShow()
      broadcastToWindows('bridge:toast', { kind: 'info', title: '桥接消息', body: text })
    },
    onOpenTask: (taskDir) => {
      focusMainAndOpenTask(taskDir)
    }
  })
}

function safeReadText(absPath: string): { ok: boolean; error?: string; content?: string } {
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
    return { ok: true, content }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? '读取失败' }
  }
}

/** Create a Trellis task dir from a Jira issue (import). */
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
  if (!projectRoot) return { ok: false, error: '未打开项目' }
  const tasksRoot = join(projectRoot, '.trellis', 'tasks')
  const dir = join(tasksRoot, input.dirName)
  if (existsSync(dir)) return { ok: false, error: `任务目录 ${input.dirName} 已存在` }
  const today = new Date()
  const pad = (x: number): string => String(x + 1).padStart(2, '0')
  const mm = pad(today.getMonth())
  const dd = pad(today.getDate())
  const finalDirName = `${mm}-${dd}-${input.dirName}`
  const finalDir = join(tasksRoot, finalDirName)
  try {
    mkdirSync(finalDir, { recursive: true })
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
      creator: getSettings().jira.user,
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
      notes: `从 Jira 导入：${input.jiraKey}\n${input.jiraUrl}`,
      meta: { jiraKey: input.jiraKey, jiraUrl: input.jiraUrl }
    }
    writeFileSync(join(finalDir, 'task.json'), JSON.stringify(record, null, 2) + '\n', 'utf-8')
    sendSnapshot()
    return { ok: true, dirName: finalDirName }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? '创建任务失败' }
  }
}

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
  })

  ipcMain.handle(
    'task:update',
    (_e, taskDir: string, patch: Record<string, unknown>) => {
      try {
        if (!projectRoot) return { ok: false, error: '未打开项目' }
        updateTaskRecordAt(projectRoot, taskDir, patch)
        sendSnapshot()
        return { ok: true }
      } catch (e: any) {
        return { ok: false, error: e?.message ?? '写入 task.json 失败' }
      }
    }
  )

  ipcMain.handle('task:createFromJira', (_e, input) => createTaskFromJira(input))

  ipcMain.handle('fs:readText', (_e, absPath: string) => safeReadText(absPath))

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
  ipcMain.handle('settings:set', (_e, patch) => setSettings(patch))

  ipcMain.handle('cli:run', (_e, args: string[]) => {
    if (!win || !projectRoot) return -1
    const { cliCommand } = getSettings()
    return runCli(win, projectRoot, cliCommand, args)
  })
  ipcMain.handle('cli:abort', (_e, runId: number) => abortCli(runId))

  /* AI bridge */
  ipcMain.handle('bridge:installTpanel', () => installTpanel())
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
      // Launch inside Windows Terminal if available, fall back to a bare console.
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

  /* Jira */
  ipcMain.handle('jira:test', (_e, cfg: JiraConfig) => jiraTest(cfg))
  ipcMain.handle('jira:search', (_e, cfg: JiraConfig, jql: string) => jiraSearch(cfg, jql))
  ipcMain.handle('jira:transitions', (_e, cfg: JiraConfig, key: string) => jiraTransitions(cfg, key))
  ipcMain.handle('jira:transition', (_e, cfg: JiraConfig, key: string, tid: string) =>
    jiraTransition(cfg, key, tid)
  )
  ipcMain.handle('jira:comment', (_e, cfg: JiraConfig, key: string, body: string) =>
    jiraComment(cfg, key, body)
  )

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
    else win?.close()
  })
}

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

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    const link = parseDeepLink(argv)
    if (link) {
      handleDeepLink(link, {
        onTaskEvent: (taskDir, text, source) => {
          sendSnapshot()
          broadcastToWindows('bridge:toast', {
            kind: 'info',
            title: 'AI 工具更新了任务',
            body: text ?? `${source} → ${taskDir ? basename(taskDir) : ''}`
          })
        },
        onNotify: (text) => {
          focusAndShow()
          broadcastToWindows('bridge:toast', { kind: 'info', title: '桥接消息', body: text })
        },
        onOpenTask: (taskDir) => focusMainAndOpenTask(taskDir)
      })
    }
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    if (process.defaultApp) {
      // dev mode: explicit registration with args
      app.setAsDefaultProtocolClient('trellis-panel', process.execPath, [
        resolve(process.argv[1] ?? '.')
      ])
    } else {
      app.setAsDefaultProtocolClient('trellis-panel')
    }
    registerIpc()
    createWindow()
    wireBridge()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    watcher.stop()
    stopInbox()
    abortAll()
    app.quit()
  })
}
