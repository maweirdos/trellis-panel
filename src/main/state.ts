/**
 * 主进程共享状态与跨域助手（决策 TPD-004）。
 *
 * index.ts 只保留窗口/托盘/快捷键/更新器/生命周期；项目态、扫描、任务 CRUD 助手、
 * 周期任务等全部收敛在这里，供 src/main/ipc/<domain>.ts 引用。反向依赖（托盘重建、
 * 主窗口聚焦）通过 setUiHooks / setMainWindow 由 index.ts 启动时注入。
 */
import { app } from 'electron'
import { join, resolve, relative, sep, extname } from 'path'
import { readFileSync, writeFileSync, statSync, existsSync, mkdirSync, rmSync } from 'fs'
import { BrowserWindow } from 'electron'
import { scanProject, TEXT_EXTS } from './services/scan'
import { TrellisWatcher } from './services/watcher'
import { clearDocumentCache, clearReaderDocuments, routeReaderDocumentChange, resolveAuthorizedDocumentPath } from './services/documents'
import { getSettings, pushRecentProject } from './services/store'
import { clearGitCache } from './services/git'
import { recordActivity } from './services/activity'
import { broadcastToWindows } from './services/bridge'
import { deliverToast } from './services/notifications'
import { eventTaskMaterial, verifyMaterialChange } from './services/acp/materials'
import { selectRuntimeObservationRoot } from './services/daemon-client/runtime'
import { createTaskRecordAt } from './services/task-record'
import { closeObservationForProject, initObservationForRoot } from './services/observability'
import { startHttpApi, stopHttpApi } from './services/httpapi'
import { WeknoraSpecSyncer } from './services/weknora'
import { accessEventLog } from './services/access/event-log'
import { errorText, errorMessage } from '../shared/errors'
import { ipcEvent } from '../shared/ipc-channels'
import { formatMaterialToast } from '../shared/notifications'
import { IpcErrorCode, ipcFail, noProject, notFound, type IpcFail } from '../shared/ipc-errors'
import type { AcpMaterialChange, MaterialUpdatedEvent, ProjectSnapshot, SpecNode, ToastEvent } from '../shared/types'

export const MAX_TEXT_BYTES = 5 * 1024 * 1024

/* ---------------- core state ---------------- */

let projectRoot: string | null = null
let projectGeneration = 0
let latestSnapshot: ProjectSnapshot | null = null
/** task dirs seen in the current project — drives the Inbox "new task" diff */
let knownTaskDirs = new Set<string>()
export const watcher = new TrellisWatcher()

/* WeKnora spec 同步：变更进队列，静默期后批量推送公司库 */
const weknoraSpecSync = new WeknoraSpecSyncer({
  onReport: (r) => {
    if (r.pushed === 0 && r.duplicates === 0 && r.failed.length === 0) return
    toast({
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
const materialFiles = new Map<string, Map<string, { path: string; kind: AcpMaterialChange['kind'] }>>()
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

export function routeMaterialNotice(absPath: string, kind: AcpMaterialChange['kind'] = 'change'): void {
  if (!projectRoot) return
  const capturedRoot = projectRoot
  const capturedGeneration = projectGeneration
  const target = eventTaskMaterial(capturedRoot, absPath)
  if (!target) return
  const written = panelWrittenAt.get(resolve(absPath))
  if (written && Date.now() - written < PANEL_WRITE_GRACE_MS) return
  const dirName = target.taskDir
  let files = materialFiles.get(dirName)
  if (!files) { files = new Map(); materialFiles.set(dirName, files) }
  if (files.size < 128 || files.has(target.relativePath)) files.set(target.relativePath, { path: absPath, kind })
  const prev = materialTimers.get(dirName)
  if (prev) clearTimeout(prev)
  materialTimers.set(dirName, setTimeout(() => {
    void (async () => {
      if (projectRoot !== capturedRoot || projectGeneration !== capturedGeneration) return
      materialTimers.delete(dirName)
      const pending = materialFiles.get(dirName)
      materialFiles.delete(dirName)
      if (!pending?.size || projectRoot !== capturedRoot || projectGeneration !== capturedGeneration) return
      const task = latestSnapshot?.tasks.find((item) => item.dirName === dirName)
      if (!task) return
      const changes = (await Promise.all([...pending.values()].map((item) => verifyMaterialChange(capturedRoot, capturedGeneration, item.path, item.kind))))
        .filter((change): change is AcpMaterialChange => change !== null)
      if (changes.length === 0 || projectRoot !== capturedRoot || projectGeneration !== capturedGeneration) return
      const payload: MaterialUpdatedEvent = {
        projectRoot: capturedRoot, projectGeneration: capturedGeneration, changes, dirName,
        title: task.record?.title ?? dirName, count: changes.length,
        files: changes.slice(0, 5).map((change) => change.relativePath.slice(`.trellis/tasks/${dirName}/`.length)), at: Date.now()
      }
      broadcastToWindows(ipcEvent.materialUpdated, payload)
      toastFocusTask(dirName, formatMaterialToast(payload))
    })().catch((error: unknown) => {
      if (projectRoot === capturedRoot && projectGeneration === capturedGeneration) toast({ kind: 'warn', title: '任务材料校验失败', body: errorMessage(error) })
    })
  }, MATERIAL_SETTLE_MS))
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

export function getProjectGeneration(): number { return projectGeneration }

export function getSnapshot(): ProjectSnapshot | null {
  return latestSnapshot
}

/* ---------------- toast / snapshot ---------------- */

export function toast(t: ToastEvent): void {
  deliverToast(t, getMainWindow(), () => uiHooks?.showMain())
}

/** Task navigation uses the renderer action or the guarded native click path. */
function toastFocusTask(dirName: string, t: ToastEvent): void {
  const capturedRoot = projectRoot
  const capturedGeneration = projectGeneration
  const event: ToastEvent = capturedRoot ? { ...t, task: { projectRoot: capturedRoot, dirName } } : t
  deliverToast(event, getMainWindow(), () => {
    uiHooks?.showMain()
    if (capturedRoot !== projectRoot || capturedGeneration !== projectGeneration) return
    pushFocusTask(dirName)
  })
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
    toast({
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
    selectRuntimeObservationRoot(projectRoot)
    projectGeneration += 1
    clearMaterialTimers()
    const openedGeneration = projectGeneration
    pushRecentProject(projectRoot)
    // S0 G2：切换项目清空文档缓存（缓存键含 canonicalPath，但避免旧项目全文驻留）；
    // 同时清空变更信号桥的会话监听（渲染端同步清空全部阅读会话）
    clearDocumentCache()
    clearReaderDocuments()
    watcher.start(projectRoot, () => { if (projectRoot === snap.meta.root && projectGeneration === openedGeneration) sendSnapshot() }, (path, ev) => {
      if (projectRoot !== snap.meta.root || projectGeneration !== openedGeneration) return
      if (ev !== 'unlink') routeSpecFileSync(path)
      routeMaterialNotice(path, ev)
      // Native timeline/material observation is owned by the daemon's root watcher.
      // S0 G2 第三片：只对已注册阅读会话的文档定向通知（无关文档零开销）
      const readerPath = resolveAuthorizedDocumentPath(snap.meta.root, relative(snap.meta.root, path))
      if (readerPath.ok) routeReaderDocumentChange(readerPath.canonicalPath)
    })
    syncWeknoraSpecConfig()
    clearGitCache()
    latestSnapshot = snap
    knownTaskDirs = new Set(snap.tasks.map((t) => t.dirName))
    recordActivity(snap)
    // S0 G3：观测存储懒初始化（已有绑定才拉起 worker；无绑定不创建任何文件）。
    // 异步进行且失败不阻塞项目打开——读取失败按未初始化口径呈现，不算打开失败。
    void initObservationForRoot(projectRoot).catch(() => {
      /* 观测初始化失败不影响阅读；下次打开/显式绑定重试 */
    })
    return { ok: true, snapshot: snap }
  } catch (e) {
    return ipcFail(IpcErrorCode.Io, errorText(e, '打开项目失败'))
  }
}

export function closeProjectAt(): void {
  projectGeneration += 1
  watcher.stop()
  projectRoot = null
  selectRuntimeObservationRoot(null)
  knownTaskDirs = new Set()
  clearMaterialTimers()
  clearDocumentCache()
  clearReaderDocuments()
  syncWeknoraSpecConfig()
  // S0 G3：取消观测订阅并关闭库连接（design §5.2 关闭工作区后停止轮询；数据保留）
  closeObservationForProject()
}

/* ---------------- pending focus task（深链聚焦，窗口未就绪时暂存） ---------------- */

let pendingFocusTask: string | null = null
let pendingFocusRoot: string | null = null
let pendingFocusGeneration = 0

export function pushFocusTask(dirName: string): void {
  const capturedRoot = projectRoot
  const capturedGeneration = projectGeneration
  pendingFocusTask = dirName
  pendingFocusRoot = projectRoot
  pendingFocusGeneration = capturedGeneration
  const send = (): void => {
    if (pendingFocusTask !== dirName) return
    if (projectRoot !== capturedRoot || projectGeneration !== capturedGeneration) return
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
  const current = pendingFocusRoot === projectRoot && pendingFocusGeneration === projectGeneration
  const payload = current && pendingFocusTask ? { taskDir: pendingFocusTask, root: pendingFocusRoot } : null
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
  /** 创建合同（PF-04）：随任务落盘的 prd.md 草稿；目录内已有 prd.md 时不覆盖 */
  prdContent?: string
  /** Exact personal requirement handoff identity; never task activation. */
  conversationRequirement?: import('../shared/conversation-requirements').RequirementTaskOrigin
}

export interface CreateTaskResult {
  ok: true
  dirName: string
  /** 实际写入磁盘的文件（相对任务目录），供界面如实展示创建产物 */
  files: string[]
  /** 非致命写入问题（如 prd.md 写失败）；出现时界面不得宣称该产物已生成 */
  warnings: string[]
}

export function createTaskRecord(input: CreateTaskInput): CreateTaskResult | IpcFail {
  if (!projectRoot) return noProject()
  return createTaskRecordAt(projectRoot, input, { snapshot: latestSnapshot, markWritten: markPanelWrite, changed: sendSnapshot })
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
