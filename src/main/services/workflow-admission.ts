/** Main-process admission arbitration; actual execution/leases remain in ACP/control. */
import { realpathSync, existsSync, statSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'

export class WorkflowAdmissionError extends Error {
  readonly code = 'E_CONFLICT'
}
export function canonicalWorkspaceRoot(root: string): string { return realpathSync.native(resolve(root)) }
const keyFor = (root: string): string => process.platform === 'win32' ? canonicalWorkspaceRoot(root).toLowerCase() : canonicalWorkspaceRoot(root)
function smallText(path: string): string { const size = statSync(path).size; if (size > 8192) throw new WorkflowAdmissionError('工作区标识文件超出读取限界'); return readFileSync(path, 'utf8').trim() }
function gitDirectory(marker: string, root: string): string {
  if (statSync(marker).isDirectory()) return canonicalWorkspaceRoot(marker)
  const text = smallText(marker)
  if (!/^gitdir:\s*\S/i.test(text)) throw new WorkflowAdmissionError('Git worktree 标识格式无效')
  return canonicalWorkspaceRoot(resolve(root, text.replace(/^gitdir:\s*/i, '')))
}
function gitBoundary(path: string): string | null {
  let candidate = path
  for (let depth = 0; depth < 64; depth++) {
    const marker = join(candidate, '.git')
    if (existsSync(marker)) {
      const directory = gitDirectory(marker, candidate)
      const common = existsSync(join(directory, 'commondir')) ? resolve(directory, smallText(join(directory, 'commondir'))) : directory
      if (!statSync(join(directory, 'HEAD')).isFile() || !statSync(join(common, 'objects')).isDirectory()) throw new WorkflowAdmissionError('Git worktree 标识无法核实，暂不接纳并发执行')
      return candidate
    }
    const parent = dirname(candidate)
    if (parent === candidate) return null
    candidate = parent
  }
  throw new WorkflowAdmissionError('无法在限界内核对 Git worktree')
}

/** Root/cwd come only from verified main project and native metadata. */
export function executionWorkspaceRoot(projectRoot: string, cwd?: string): string {
  const root = canonicalWorkspaceRoot(projectRoot)
  const current = cwd ? canonicalWorkspaceRoot(cwd) : root
  const repository = gitBoundary(current)
  if (repository) return canonicalWorkspaceRoot(repository)
  const rel = relative(root, current)
  if (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep)) return root
  // An explicit external native cwd may be nested in a distinct worktree.
  // Prefer its real repository boundary, falling back to its project boundary.
  let candidate = current; let project: string | null = null
  for (let depth = 0; depth < 64; depth++) {
    if (!project && existsSync(join(candidate, '.trellis')) && statSync(join(candidate, '.trellis')).isDirectory()) project = candidate
    const parent = dirname(candidate)
    if (parent === candidate) return canonicalWorkspaceRoot(project ?? current)
    candidate = parent
  }
  throw new WorkflowAdmissionError('无法在限界内核对执行工作区，请选择明确的项目或 worktree')
}

type Entry = { token: symbol; kind: 'ordinary' | 'managed'; settled: Promise<void>; settle: () => void; nativeBusy?: () => boolean }
const admissions = new Map<string, Entry>()
function prune(key: string): void {
  const old = admissions.get(key)
  if (!old?.nativeBusy) return
  try { if (!old.nativeBusy()) admissions.delete(key) } catch { /* Unknown native ownership remains fenced. */ }
}
export type WorkspaceAdmission = {
  isCurrent(): boolean
  release(): void
  /** After delivery, retain the admission until original native facts show idle/closed. */
  retainNative(busy: () => boolean): void
}
export function claimWorkspaceAdmission(root: string, kind: Entry['kind']): WorkspaceAdmission {
  const key = keyFor(root)
  prune(key)
  if (admissions.has(key)) throw new WorkflowAdmissionError('此工作区已有原生指令或工作流正在接纳或执行，请等待结束或停止后重试')
  if (admissions.size >= 128) throw new WorkflowAdmissionError('工作区接纳数量已达上限，请等待现有执行结束')
  let settle = (): void => {}
  const settled = new Promise<void>((done) => { settle = done })
  const entry: Entry = { token: Symbol(kind), kind, settled, settle }
  admissions.set(key, entry)
  return {
    isCurrent: () => admissions.get(key) === entry,
    release: () => { if (admissions.get(key) === entry) admissions.delete(key); entry.settle() },
    retainNative: (busy) => { if (admissions.get(key) === entry) entry.nativeBusy = busy; entry.settle() }
  }
}
/** Call after the host closes admission, before enumerating controllers at quit. */
export async function waitForWorkspaceAdmissions(): Promise<void> { await Promise.all([...admissions.values()].map((entry) => entry.settled)) }

function discoveryDirectory(workspace: string): string {
  const root = canonicalWorkspaceRoot(workspace)
  const marker = join(root, '.git')
  const directory = existsSync(marker) ? gitDirectory(marker, root) : join(root, '.trellis', '.panel', 'runtime')
  return join(directory, 'trellis-panel', 'workspace-discovery')
}
async function readDiscovery(workspace: string, allowMissing = false): Promise<string[]> {
  const directory = discoveryDirectory(workspace), path = join(directory, 'projects.json')
  let bytes: Buffer
  try {
    const info = await fs.lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new WorkflowAdmissionError('工作区项目发现记录无法核实，暂不接纳执行')
    bytes = await fs.readFile(path)
    if (bytes.length > 1024 * 1024) throw new WorkflowAdmissionError('工作区项目发现记录超过限界')
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      if (allowMissing || !existsSync(directory)) return []
      throw new WorkflowAdmissionError('已有工作区发现目录但项目引用记录缺失，请先核对，不能视为工作区空闲')
    }
    throw error
  }
  let value: { version?: unknown; workspaceRoot?: unknown; projects?: unknown }
  try { value = JSON.parse(bytes.toString('utf8')) } catch { throw new WorkflowAdmissionError('工作区项目发现记录已损坏，请先核对') }
  if (!value || value.version !== 1 || typeof value.workspaceRoot !== 'string' || keyFor(value.workspaceRoot) !== keyFor(workspace) || !Array.isArray(value.projects) || value.projects.length > 128
    || value.projects.some((entry) => typeof entry !== 'string' || !isAbsolute(entry) || entry.length > 8192) || new Set(value.projects).size !== value.projects.length) throw new WorkflowAdmissionError('工作区项目发现记录不属于当前物理工作区或格式无效')
  return value.projects as string[]
}
/** Discovery references only. Each referenced control DB remains the owner authority. */
export function workspaceProjects(workspace: string): Promise<string[]> { return readDiscovery(workspace) }
export async function registerWorkspaceProject(workspace: string, projectRoot: string): Promise<void> {
  const root = canonicalWorkspaceRoot(projectRoot)
  if (keyFor(executionWorkspaceRoot(root)) !== keyFor(workspace) || !statSync(join(root, '.trellis', 'tasks')).isDirectory()) throw new WorkflowAdmissionError('项目未核实为此工作区的 Trellis 项目')
  const directory = discoveryDirectory(workspace)
  await fs.mkdir(dirname(directory), { recursive: true })
  let created = false
  try { await fs.mkdir(directory); created = true } catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error }
  const lock = join(directory, 'projects.lock'), nonce = randomUUID()
  let handle: Awaited<ReturnType<typeof fs.open>>
  try { handle = await fs.open(lock, 'wx', 0o600) }
  catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error
    // Serialize dead-lock recovery too: two stale readers must never unlink
    // a newly acquired live writer after both checked the same old lock bytes.
    const recoveryPath = join(directory, 'projects.recovery.lock')
    let recovery: Awaited<ReturnType<typeof fs.open>>
    try { recovery = await fs.open(recoveryPath, 'wx', 0o600) }
    catch { throw new WorkflowAdmissionError('项目引用锁正在核对或上次核对未完成，请稍后重试或人工核对') }
    try {
      const info = await fs.lstat(lock)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) throw new WorkflowAdmissionError('项目引用登记锁无法核实')
      const bytes = await fs.readFile(lock, 'utf8')
      let previous: { pid?: unknown; nonce?: unknown }
      try { previous = JSON.parse(bytes) } catch { throw new WorkflowAdmissionError('项目引用登记锁损坏，请先核对') }
      if (!Number.isSafeInteger(previous.pid) || Number(previous.pid) <= 0 || typeof previous.nonce !== 'string') throw new WorkflowAdmissionError('项目引用登记锁缺少可核对的进程身份')
      let dead = false
      try { process.kill(Number(previous.pid), 0) } catch (cause) { if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ESRCH') dead = true; else throw cause }
      if (!dead) throw new WorkflowAdmissionError('项目引用正在由仍存活的进程登记，请稍后重试')
      // This is only metadata-lock recovery. Never infer execution stopped.
      await readDiscovery(workspace)
      if (await fs.readFile(lock, 'utf8') !== bytes) throw new WorkflowAdmissionError('项目引用登记锁已改变，请重新核对')
      await fs.unlink(lock)
      try { handle = await fs.open(lock, 'wx', 0o600) } catch { throw new WorkflowAdmissionError('项目引用登记锁已被其他进程接管，请重试') }
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') throw new WorkflowAdmissionError('项目引用登记锁在核对期间已改变，请重试')
      throw error
    } finally { await recovery.close(); await fs.unlink(recoveryPath) }
  }
  const temporary = join(directory, `projects-${nonce}.tmp`)
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, nonce }))
    const existing = await readDiscovery(workspace, created)
    const projects = existing.some((entry) => keyFor(entry) === keyFor(root)) ? existing : [...existing, root]
    if (projects.length > 128) throw new WorkflowAdmissionError('工作区项目发现数量达到限界，请先核对已有项目引用')
    const file = await fs.open(temporary, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify({ version: 1, workspaceRoot: canonicalWorkspaceRoot(workspace), projects }) + '\n'); await file.sync() }
    finally { await file.close() }
    await fs.rename(temporary, join(directory, 'projects.json'))
  } finally {
    await handle.close()
    await fs.unlink(temporary).catch(() => {})
    await fs.unlink(lock)
  }
}
