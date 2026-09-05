import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from 'electron'
import { join, resolve, sep, extname } from 'path'
import { readFileSync, statSync } from 'fs'
import { scanProject, updateTaskRecordAt, TEXT_EXTS } from './services/scan'
import { TrellisWatcher } from './services/watcher'
import { runCli, abortCli, abortAll } from './services/cli'
import { getSettings, setSettings, pushRecentProject } from './services/store'

let win: BrowserWindow | null = null
let projectRoot: string | null = null
const watcher = new TrellisWatcher()

const MAX_TEXT_BYTES = 5 * 1024 * 1024

function createWindow(): void {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 640,
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
  win.on('maximize', () => win?.webContents.send('window:maximized', true))
  win.on('unmaximize', () => win?.webContents.send('window:maximized', false))
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

function sendSnapshot(): void {
  if (!win || win.isDestroyed() || !projectRoot) return
  try {
    win.webContents.send('project:snapshot', scanProject(projectRoot))
  } catch (e: any) {
    console.error('rescan failed:', e?.message)
  }
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

  ipcMain.on('win:minimize', () => win?.minimize())
  ipcMain.on('win:maximize', () => {
    if (win?.isMaximized()) win.unmaximize()
    else win?.maximize()
  })
  ipcMain.on('win:close', () => win?.close())
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    registerIpc()
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    watcher.stop()
    abortAll()
    app.quit()
  })
}
