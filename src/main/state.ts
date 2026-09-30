/**
 * 主进程共享状态与跨域助手（决策 TPD-004）。
 *
 * index.ts 只保留窗口/托盘/快捷键/更新器/生命周期；项目态、扫描、任务 CRUD 助手、
 * 周期任务等全部收敛在这里，供 src/main/ipc/<domain>.ts 引用。反向依赖（托盘重建、
 * 主窗口聚焦）通过 setUiHooks / setMainWindow 由 index.ts 启动时注入。
 */
import { app, Notification } from 'electron'
import { join, resolve, sep, extname } from 'path'
import { readFileSync, writeFileSync, statSync, existsSync, mkdirSync, rmSync } from 'fs'
import { BrowserWindow } from 'electron'
import { scanProject, TEXT_EXTS } from './services/scan'
import { TrellisWatcher } from './services/watcher'
import { getSettings, pushRecentProject } from './services/store'
import { clearGitCache } from './services/git'
import { recordActivity } from './services/activity'
import { broadcastToWindows } from './services/bridge'
import { startHttpApi, stopHttpApi } from './services/httpapi'
import { WeknoraSpecSyncer } from './services/weknora'
import { accessEventLog } from './services/access/event-log'
import { errorText, errorMessage } from '../shared/errors'
import { ipcEvent } from '../shared/ipc-channels'
import { IpcErrorCode, ipcFail, noProject, notFound, type IpcFail } from '../shared/ipc-errors'
import type { ProjectSnapshot, SpecNode, ToastEvent } from '../shared/types'

export const MAX_TEXT_BYTES = 5 * 1024 * 1024

/* ---------------- core state ---------------- */

let projectRoot: string | null = null
let latestSnapshot: ProjectSnapshot | null = null
/** task dirs seen in the current project — drives the Inbox "new task" diff */
let knownTaskDirs = new Set<string>()
export const watcher = new TrellisWatcher()

/* WeKnora spec 同步：变更进队列，静默期后批量推送公司库 */
const weknoraSpecSync = new WeknoraSpecSyncer({
  onReport: (r) => {
    if (r.pushed === 0 && r.duplicates === 0 && r.failed.length === 0) return
    broadcastToWindows(ipcEvent.toast, {
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
export function routeSpecFileSync(absPath: string): void {
  if (!projectRoot) return
  const specRoot = resolve(projectRoot, '.trellis', 'spec') + sep
  const p = resolve(absPath)
  if (!p.startsWith(specRoot)) return
  if (!/\.(md|markdown|txt)$/i.test(extname(p))) return
  weknoraSpecSync.enqueue(p)
}

/* ---------------- FR：任务材料更新提醒（按任务防抖合并） ----------------
 * 合同（06 v2 §2 支柱一）：等文件稳定后按任务合并通知；首扫不通知（chokidar
 * ignoreInitial 天然满足）；面板自身写入不通知；只报文件事实，不推断代理状态。 */

const MATERIAL_SETTLE_MS = 8000
const PANEL_WRITE_GRACE_MS = 5000
const materialTimers = new Map<string, ReturnType<typeof setTimeout>>()
const materialFiles = new Map<string, Set<string>>()
/** 面板自己刚写过的文件（绝对路径 → 时间戳），提醒管道据此过滤自嗨通知 */
const panelWrittenAt = new Map<string, number>()

export function markPanelWrite(absPath: string): void {
  panelWrittenAt.set(resolve(absPath), Date.now())
  if (panelWrittenAt.size > 200) {
    const now = Date.now()
    for (const [k, t] of panelWrittenAt) {
      if (now - t > PANEL_WRITE_GRACE_MS * 2) panelWrittenAt.delete(k)
    }
  }
}

export function routeMaterialNotice(absPath: string): void {
  if (!projectRoot) return
  const tasksRoot = resolve(projectRoot, '.trellis', 'tasks') + sep
  const p = resolve(absPath)
  if (!p.startsWith(tasksRoot)) return
  const written = panelWrittenAt.get(p)
  if (written && Date.now() - written < PANEL_WRITE_GRACE_MS) return
  const rel = p.slice(tasksRoot.length)
  const parts = rel.split(/[\\/]/).filter(Boolean)
  if (parts.length < 2) return
  // 只提醒活跃任务（tasks/<dir>/…）；归档目录的变化不打扰
  if (parts[0] === 'archive') return
  const dirName = parts[0]
  let files = materialFiles.get(dirName)
  if (!files) {
    files = new Set()
    materialFiles.set(dirName, files)
  }
  files.add(parts.slice(1).join('/'))
  const prev = materialTimers.get(dirName)
  if (prev) clearTimeout(prev)
  materialTimers.set(
    dirName,
    setTimeout(() => {
      materialTimers.delete(dirName)
      const fs = materialFiles.get(dirName) ?? new Set<string>()
      materialFiles.delete(dirName)
      if (fs.size === 0) return
      const t = latestSnapshot?.tasks.find((x) => x.dirName === dirName)
      broadcastToWindows(ipcEvent.materialUpdated, {
        dirName,
        title: t?.record?.title ?? dirName,
        count: fs.size,
        files: [...fs].slice(0, 5),
        at: Date.now()
      })
    }, MATERIAL_SETTLE_MS)
  )
}

function clearMaterialTimers(): void {
  for (const t of materialTimers.values()) clearTimeout(t)
  materialTimers.clear()
  materialFiles.clear()
}

export function syncWeknoraSpecConfig(): void {
  weknoraSpecSync.configure(getSettings().weknora, projectRoot)
}

/* ---------------- ui hooks (injected by index.ts) ---------------- */

let uiHooks: { showMain(): void; rebuildTray(): void } | null = null

export function setUiHooks(hooks: { showMain(): void; rebuildTray(): void }): void {
  uiHooks = hooks
}

let mainWindow: BrowserWindow | null = null

export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
}

/* ---------------- getters ---------------- */

export function getProjectRoot(): string | null {
  return projectRoot
}

export function getSnapshot(): ProjectSnapshot | null {
  return latestSnapshot
}

/* ---------------- toast / snapshot ---------------- */

export function toast(t: ToastEvent): void {
  try {
    if (Notification.isSupported()) {
      const n = new Notification({ title: t.title, body: t.body ?? '', silent: true })
      n.on('click', () => uiHooks?.showMain())
      n.show()
    }
  } catch {
    // notifications are best-effort
  }
}

export function sendSnapshot(): void {
  if (!projectRoot) return
  try {
    latestSnapshot = scanProject(projectRoot)
    recordActivity(latestSnapshot)
    detectNewTasks(latestSnapshot)
    broadcastToWindows(ipcEvent.snapshotUpdated, latestSnapshot)
    uiHooks?.rebuildTray()
    // 接入协议事件源：只发摘要，外部客户端凭游标增量拉取，需要全量时再取 /session
    accessEventLog.append('snapshot.updated', {
      project: latestSnapshot.meta.name,
      taskCount: latestSnapshot.tasks.length,
      archivedCount: latestSnapshot.archived.length
    })
  } catch (e) {
    // R0：重扫失败保留上一份快照（latestSnapshot 未被替换），并显式告知而非静默
    console.error('rescan failed:', errorMessage(e))
    broadcastToWindows(ipcEvent.toast, {
      kind: 'warn',
      title: '重新扫描失败',
      body: `已保留上次结果（${errorText(e, '未知错误')}）`
    })
  }
}

/**
 * Diff scanned task dirs against the known set — any task that appeared since
 * the last scan (e.g. created by an AI tool via trellis CLI) is surfaced as a
 * system notification.
 */
function detectNewTasks(snap: ProjectSnapshot): void {
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

export function findTask(dir: string) {
  const snap = latestSnapshot
  if (!snap) return null
  return (
    snap.tasks.find((x) => x.dirName === dir || x.path.endsWith(dir)) ??
    snap.archived.find((x) => x.dirName === dir || x.path.endsWith(dir)) ??
    null
  )
}

/** Flatten spec tree to file paths (relative to spec root) for AI context hints. */
export function flattenSpecNames(nodes: SpecNode[], depth = 0): string[] {
  const out: string[] = []
  for (const n of nodes ?? []) {
    if (n.type === 'file') out.push(n.name)
    else if (depth < 4 && n.children) out.push(...flattenSpecNames(n.children, depth + 1))
  }
  return out
}

/* ---------------- project open/close（合并 panel 与深链两条切换路径） ---------------- */

export function openProjectAt(root: string): { ok: true; snapshot: ProjectSnapshot } | IpcFail {
  try {
    const snap = scanProject(root)
    if (!snap.meta.trellisExists) {
      return ipcFail(IpcErrorCode.InvalidArg, '该目录下没有 .trellis/ —— 请先在项目中运行 trellis init')
    }
    projectRoot = snap.meta.root
    pushRecentProject(projectRoot)
    watcher.start(projectRoot, sendSnapshot, (path) => {
      routeSpecFileSync(path)
      routeMaterialNotice(path)
    })
    syncWeknoraSpecConfig()
    clearGitCache()
    latestSnapshot = snap
    knownTaskDirs = new Set(snap.tasks.map((t) => t.dirName))
    recordActivity(snap)
    return { ok: true, snapshot: snap }
  } catch (e) {
    return ipcFail(IpcErrorCode.Io, errorText(e, '打开项目失败'))
  }
}

export function closeProjectAt(): void {
  watcher.stop()
  projectRoot = null
  knownTaskDirs = new Set()
  clearMaterialTimers()
  syncWeknoraSpecConfig()
}

/* ---------------- pending focus task（深链聚焦，窗口未就绪时暂存） ---------------- */

let pendingFocusTask: string | null = null
let pendingFocusRoot: string | null = null

export function pushFocusTask(dirName: string): void {
  pendingFocusTask = dirName
  pendingFocusRoot = projectRoot
  const send = (): void => {
    if (pendingFocusTask !== dirName) return
    const win = getMainWindow()
    if (!win) return
    if (win.webContents.isLoading()) {
      setTimeout(send, 300)
      return
    }
    pendingFocusTask = null
    win.webContents.send(ipcEvent.bridgeTaskFocus, dirName)
  }
  send()
}

export function pullPendingFocus(): { taskDir: string; root: string | null } | null {
  const payload = pendingFocusTask ? { taskDir: pendingFocusTask, root: pendingFocusRoot } : null
  pendingFocusTask = null
  pendingFocusRoot = null
  return payload
}

/* ---------------- safe read ---------------- */

export function safeReadText(absPath: string): { ok: true; content: string; mtime: number } | IpcFail {
  if (!projectRoot) return noProject()
  const root = resolve(projectRoot)
  const p = resolve(root, absPath)
  if (!p.startsWith(root + sep)) return ipcFail(IpcErrorCode.InvalidArg, '路径超出项目范围')
  const ext = extname(p).toLowerCase()
  if (!TEXT_EXTS.has(ext)) return ipcFail(IpcErrorCode.InvalidArg, `不支持的文件类型 ${ext || '(无扩展名)'}`)
  let st
  try {
    st = statSync(p)
  } catch {
    return ipcFail(IpcErrorCode.NotFound, '文件不存在')
  }
  if (st.size > MAX_TEXT_BYTES) return ipcFail(IpcErrorCode.InvalidArg, '文件超过 5MB')
  try {
    let content = readFileSync(p, 'utf-8')
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1)
    return { ok: true, content, mtime: st.mtimeMs }
  } catch (e) {
    return ipcFail(IpcErrorCode.Io, errorText(e, '读取失败'))
  }
}

/* ---------------- task create/delete ---------------- */

export interface CreateTaskInput {
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

export function createTaskRecord(input: CreateTaskInput): { ok: true; dirName: string } | IpcFail {
  if (!projectRoot) return noProject()
  const tasksRoot = join(projectRoot, '.trellis', 'tasks')
  const today = new Date()
  const pad = (x: number): string => String(x).padStart(2, '0')
  const mm = pad(today.getMonth() + 1)
  const dd = pad(today.getDate())
  const finalDirName = `${mm}-${dd}-${input.dirName}`
  const finalDir = join(tasksRoot, finalDirName)
  if (existsSync(finalDir)) return ipcFail(IpcErrorCode.Conflict, `任务目录 ${finalDirName} 已存在`)
  const jiraKey = input.jiraKey
  if (jiraKey) {
    const existing = [...(latestSnapshot?.tasks ?? []), ...(latestSnapshot?.archived ?? [])]
      .find((t) => String(t.record?.meta?.jiraKey ?? '').toUpperCase() === jiraKey.toUpperCase())
    if (existing) return ipcFail(IpcErrorCode.Conflict, `Jira ${jiraKey} 已关联任务 ${existing.dirName}`)
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
    markPanelWrite(join(finalDir, 'task.json'))
    sendSnapshot()
    return { ok: true, dirName: finalDirName }
  } catch (e) {
    return ipcFail(IpcErrorCode.Io, errorText(e, '创建任务失败'))
  }
}

export function deleteTaskRecord(taskDir: string, expectedMtime?: number): { ok: true } | (IpcFail & { conflict?: true }) {
  if (!projectRoot || !latestSnapshot) return noProject()
  const task = latestSnapshot.tasks.find((t) => t.dirName === taskDir || t.path.endsWith(taskDir))
  if (!task?.record) return notFound(taskDir)
  if (expectedMtime !== undefined && Math.abs(task.taskJsonMtime - expectedMtime) > 50) {
    return { ...ipcFail(IpcErrorCode.Conflict, '待办已被外部修改，请刷新后重试'), conflict: true }
  }
  const tasksRoot = resolve(projectRoot, '.trellis', 'tasks') + sep
  const target = resolve(task.path)
  if (!target.startsWith(tasksRoot) || target === resolve(tasksRoot)) {
    return ipcFail(IpcErrorCode.InvalidArg, '非法任务目录')
  }
  try {
    rmSync(target, { recursive: true, force: false })
    sendSnapshot()
    return { ok: true }
  } catch (e) {
    return ipcFail(IpcErrorCode.Io, errorText(e, '删除待办失败'))
  }
}

/** Derive a filesystem-safe slug from a free-form requirement title. */
export function slugifyTitle(title: string): string {
  const slug = title
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return slug || 'req'
}

/* R0（09-30-r0-trusted-boundary）：Jira 后台自动回写 task.json.status 已停用。
 * 任务生命周期写入收归外部 Trellis 工作流；面板对 task.json 保持只读，
 * 元数据编辑走 task.update 白名单（见 scan.ts EDITABLE）。 */

/* ---------------- http api lifecycle ---------------- */

export function restartHttpApi(): void {
  const s = getSettings()
  if (s.httpApi.enabled) {
    void startHttpApi(s.httpApi.port, s.httpApi.lanAccess, () => latestSnapshot)
  } else {
    stopHttpApi()
  }
}

/* ---------------- desktop helpers ---------------- */

export function applyAutoStart(): void {
  try {
    app.setLoginItemSettings({ openAtLogin: getSettings().desktop.autoStart })
  } catch {
    // best-effort
  }
}

export function stopTimers(): void {
  watcher.stop()
  weknoraSpecSync.stop()
  clearMaterialTimers()
  stopHttpApi()
}
