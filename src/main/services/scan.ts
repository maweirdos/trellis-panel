import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'fs'
import { join, basename, extname, resolve, sep } from 'path'
import yaml from 'js-yaml'
import type {
  DeveloperInfo,
  FileEntry,
  JournalFile,
  PlatformChip,
  ProjectMeta,
  ProjectSnapshot,
  SessionInfo,
  SpecNode,
  TaskInfo,
  TaskPhase,
  TaskRecord
} from '../../shared/types'

const PHASE_BY_STATUS: Record<string, TaskPhase> = {
  planning: 'plan',
  in_progress: 'implement',
  review: 'review',
  completed: 'completed',
  done: 'completed'
}

export function inferPhase(status: string | null | undefined): TaskPhase {
  if (!status) return 'unknown'
  return PHASE_BY_STATUS[status.toLowerCase()] ?? 'unknown'
}

/** Well-known AI platform markers trellis init writes at the project root. */
const PLATFORM_MARKERS: Array<{ id: string; name: string; marker: string }> = [
  { id: 'claude', name: 'Claude Code', marker: '.claude' },
  { id: 'cursor', name: 'Cursor', marker: '.cursor' },
  { id: 'opencode', name: 'OpenCode', marker: '.opencode' },
  { id: 'codex', name: 'Codex', marker: '.codex' },
  { id: 'gemini', name: 'Gemini CLI', marker: '.gemini' },
  { id: 'copilot', name: 'Copilot', marker: '.github/copilot-instructions.md' },
  { id: 'trae', name: 'Trae', marker: '.trae' },
  { id: 'qoder', name: 'Qoder', marker: '.qoder' },
  { id: 'codebuddy', name: 'CodeBuddy', marker: '.codebuddy' },
  { id: 'kiro', name: 'Kiro', marker: '.kiro' },
  { id: 'kilo', name: 'Kilo', marker: '.kilo' },
  { id: 'devin', name: 'Devin', marker: '.devin' },
  { id: 'droid', name: 'Factory Droid', marker: '.factory' },
  { id: 'zcode', name: 'ZCode', marker: '.zcode' },
  { id: 'grok', name: 'Grok', marker: '.grok' },
  { id: 'kimi', name: 'Kimi', marker: '.kimi' },
  { id: 'snow', name: 'Snow', marker: '.snow' },
  { id: 'reasonix', name: 'Reasonix', marker: '.reasonix' },
  { id: 'antigravity', name: 'Antigravity', marker: '.antigravity' },
  { id: 'pi', name: 'Pi', marker: '.pi' },
  { id: 'windsurf', name: 'Windsurf', marker: '.windsurf' }
]

const TEXT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.json', '.jsonl', '.yaml', '.yml', '.toml',
  '.py', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.sh', '.ps1', '.cmd', '.bat',
  '.cfg', '.ini', '.log', '.html', '.css', '.sql', '.env'
])

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function entryInfo(dir: string, name: string): FileEntry | null {
  const p = join(dir, name)
  try {
    const st = statSync(p)
    return {
      name,
      path: p,
      kind: st.isDirectory() ? 'dir' : 'file',
      size: st.size,
      mtime: st.mtimeMs,
      ext: st.isDirectory() ? '' : extname(name).toLowerCase()
    }
  } catch {
    return null
  }
}

function parseTaskRecord(taskJsonPath: string): {
  record: TaskRecord | null
  error?: string
  mtime?: number
} {
  try {
    const raw = readFileSync(taskJsonPath, 'utf-8')
    const mtime = statSync(taskJsonPath).mtimeMs
    const obj = JSON.parse(raw)
    if (obj && typeof obj === 'object') return { record: obj as TaskRecord, mtime }
    return { record: null, error: 'task.json 不是对象' }
  } catch (e: any) {
    return { record: null, error: e?.message ?? '读取 task.json 失败' }
  }
}

/** Flatten a task dir to at most two levels (dir + one nested level). */
function listArtifacts(taskDir: string): FileEntry[] {
  const out: FileEntry[] = []
  let names: string[] = []
  try {
    names = readdirSync(taskDir)
  } catch {
    return out
  }
  for (const name of names.sort()) {
    if (name === 'task.json') continue
    const e = entryInfo(taskDir, name)
    if (!e) continue
    out.push(e)
    if (e.kind === 'dir') {
      try {
        for (const child of readdirSync(e.path).sort()) {
          const ce = entryInfo(e.path, child)
          if (ce) out.push({ ...ce, name: `${name}/${child}` })
        }
      } catch {
        // unreadable subdir — skip quietly
      }
    }
  }
  return out
}

function scanTaskDir(taskDir: string, archived = false): TaskInfo {
  const dirName = basename(taskDir)
  const m = /^(\d{2})-(\d{2})-(.+)$/.exec(dirName)
  const system = /^00-/.test(dirName)
  const jsonPath = join(taskDir, 'task.json')
  const { record, error, mtime: jsonMtime } = parseTaskRecord(jsonPath)
  let updatedAt = 0
  try {
    updatedAt = statSync(taskDir).mtimeMs
  } catch {
    // keep 0
  }
  const jiraKey = typeof record?.meta?.jiraKey === 'string' ? (record.meta.jiraKey as string) : undefined
  return {
    dirName,
    path: taskDir,
    date: m && !system ? `${m[1]}-${m[2]}` : null,
    record,
    parseError: error,
    phase: inferPhase(record?.status),
    artifacts: listArtifacts(taskDir),
    updatedAt,
    archived,
    taskJsonMtime: jsonMtime ?? 0,
    jiraKey
  }
}

function scanTasks(tasksRoot: string, archived = false): TaskInfo[] {
  if (!isDir(tasksRoot)) return []
  const out: TaskInfo[] = []
  for (const name of readdirSync(tasksRoot).sort()) {
    if (name === 'archive' && !archived) continue
    const dir = join(tasksRoot, name)
    if (!isDir(dir) || name.startsWith('.')) continue
    out.push(scanTaskDir(dir, archived))
  }
  return out
}

/**
 * Collect archived task dirs. Trellis has used two layouts over time:
 *   new:  .trellis/archive/<task-dir>/
 *   old:  .trellis/tasks/archive/<YYYY-MM>/<task-dir>/
 * Walk each archive root to a bounded depth and treat any directory that
 * contains a task.json as one archived task.
 */
function scanArchiveRoots(roots: string[]): TaskInfo[] {
  const out: TaskInfo[] = []
  const seen = new Set<string>()
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    if (names.includes('task.json')) {
      if (!seen.has(dir)) {
        seen.add(dir)
        out.push(scanTaskDir(dir, true))
      }
      return
    }
    for (const name of names.sort()) {
      if (name.startsWith('.')) continue
      const child = join(dir, name)
      if (isDir(child)) walk(child, depth + 1)
    }
  }
  for (const root of roots) {
    if (isDir(root)) walk(root, 0)
  }
  return out.sort((a, b) => a.dirName.localeCompare(b.dirName))
}

function walkSpec(dir: string, root: string): SpecNode[] {
  const out: SpecNode[] = []
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    if (name.startsWith('.')) continue
    const p = join(dir, name)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      out.push({ name, path: p, type: 'dir', children: walkSpec(p, root) })
    } else {
      out.push({ name, path: p, type: 'file', size: st.size, mtime: st.mtimeMs })
    }
  }
  return out
}

function journalEntry(dir: string, name: string): JournalFile | null {
  const p = join(dir, name)
  try {
    const st = statSync(p)
    if (!st.isFile()) return null
    return { name, path: p, size: st.size, mtime: st.mtimeMs }
  } catch {
    return null
  }
}

function scanWorkspace(workspaceRoot: string): {
  developers: DeveloperInfo[]
  shared: JournalFile[]
} {
  const developers: DeveloperInfo[] = []
  const shared: JournalFile[] = []
  if (!isDir(workspaceRoot)) return { developers, shared }
  for (const name of readdirSync(workspaceRoot).sort()) {
    const p = join(workspaceRoot, name)
    if (isDir(p)) {
      const journals: JournalFile[] = []
      const otherFiles: JournalFile[] = []
      let lastActive = 0
      let names: string[] = []
      try {
        names = readdirSync(p)
      } catch {
        // skip
      }
      for (const f of names.sort()) {
        const e = journalEntry(p, f)
        if (!e) continue
        lastActive = Math.max(lastActive, e.mtime)
        if (/^journal-.*\.md$/i.test(f)) journals.push(e)
        else otherFiles.push(e)
      }
      developers.push({ name, path: p, journals, otherFiles, lastActive })
    } else {
      const e = journalEntry(workspaceRoot, name)
      if (e) shared.push(e)
    }
  }
  return { developers, shared }
}

function scanSessions(sessionsRoot: string): SessionInfo[] {
  if (!isDir(sessionsRoot)) return []
  const out: SessionInfo[] = []
  for (const name of readdirSync(sessionsRoot).sort()) {
    if (!name.endsWith('.json')) continue
    const p = join(sessionsRoot, name)
    try {
      const obj = JSON.parse(readFileSync(p, 'utf-8'))
      out.push({
        file: name,
        platform: String(obj.platform ?? 'unknown'),
        currentTask: obj.current_task ? basename(String(obj.current_task)) : null,
        lastSeen: obj.last_seen_at ?? null,
        run: obj.current_run ? String(obj.current_run) : null
      })
    } catch {
      // skip malformed session files
    }
  }
  out.sort((a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? ''))
  return out
}

function detectPlatforms(root: string): PlatformChip[] {
  return PLATFORM_MARKERS.map((p) => ({
    id: p.id,
    name: p.name,
    detected: existsSync(join(root, p.marker))
  }))
}

function readDeveloper(devPath: string): { developer: string | null; since: string | null } {
  try {
    const raw = readFileSync(devPath, 'utf-8')
    let developer: string | null = null
    let since: string | null = null
    for (const line of raw.split(/\r?\n/)) {
      const eq = line.indexOf('=')
      if (eq < 0) continue
      const k = line.slice(0, eq).trim()
      const v = line.slice(eq + 1).trim()
      if (k === 'name') developer = v
      else if (k === 'initialized_at') since = v
    }
    return { developer, since }
  } catch {
    return { developer: null, since: null }
  }
}

function parseConfig(configPath: string): { packages: string[] } {
  try {
    const obj = yaml.load(readFileSync(configPath, 'utf-8')) as any
    const packages = obj && typeof obj === 'object' && obj.packages && typeof obj.packages === 'object'
      ? Object.keys(obj.packages)
      : []
    return { packages }
  } catch {
    return { packages: [] }
  }
}

export function scanProject(root: string): ProjectSnapshot {
  const trellisDir = join(root, '.trellis')
  const trellisExists = isDir(trellisDir)

  let version: string | null = null
  try {
    version = readFileSync(join(trellisDir, '.version'), 'utf-8').trim() || null
  } catch {
    // no version file
  }
  const { developer, since } = readDeveloper(join(trellisDir, '.developer'))

  let currentTask: string | null = null
  try {
    const raw = readFileSync(join(trellisDir, '.current-task'), 'utf-8').trim()
    currentTask = raw ? basename(raw) : null
  } catch {
    // no current task
  }

  const hasWorkflow = existsSync(join(trellisDir, 'workflow.md'))
  const { packages } = parseConfig(join(trellisDir, 'config.yaml'))

  const meta: ProjectMeta = {
    root: resolve(root),
    name: basename(resolve(root)),
    trellisExists,
    version,
    developer,
    developerSince: since,
    currentTask,
    hasWorkflow,
    workflowTemplate: null,
    packages,
    platforms: detectPlatforms(root),
    configExists: existsSync(join(trellisDir, 'config.yaml'))
  }

  if (!trellisExists) {
    return {
      meta,
      tasks: [],
      archived: [],
      spec: [],
      developers: [],
      sharedWorkspaceFiles: [],
      sessions: [],
      scannedAt: Date.now()
    }
  }

  const ws = scanWorkspace(join(trellisDir, 'workspace'))
  return {
    meta,
    tasks: scanTasks(join(trellisDir, 'tasks')),
    archived: scanArchiveRoots([join(trellisDir, 'archive'), join(trellisDir, 'tasks', 'archive')]),
    spec: walkSpec(join(trellisDir, 'spec'), trellisDir),
    developers: ws.developers,
    sharedWorkspaceFiles: ws.shared,
    sessions: scanSessions(join(trellisDir, '.runtime', 'sessions')),
    scannedAt: Date.now()
  }
}

/** Update whitelisted editable fields of a task.json and write it back. */
export function updateTaskRecordAt(
  root: string,
  taskDir: string,
  patch: Record<string, unknown>,
  expectedMtime?: number
): { conflict: boolean } {
  const dir = resolve(taskDir)
  const trellisRoot = resolve(root, '.trellis') + sep
  // containment: the task dir must live inside <project>/.trellis
  if (!dir.startsWith(trellisRoot)) throw new Error('非法任务目录')
  const jsonPath = join(dir, 'task.json')
  const { record } = parseTaskRecord(jsonPath)
  if (!record) throw new Error('task.json 不存在或无法解析')

  // optimistic conflict detection: file changed since the caller last saw it
  if (expectedMtime !== undefined) {
    let curMtime = 0
    try {
      curMtime = statSync(jsonPath).mtimeMs
    } catch {
      // gone — fall through to parse error next
    }
    if (Math.abs(curMtime - expectedMtime) > 50) {
      const err = new Error('任务文件已被外部修改（可能是 AI 工具或其他成员），请刷新后重试') as Error & {
        conflict: boolean
      }
      err.conflict = true
      throw err
    }
  }

  const EDITABLE = new Set([
    'title', 'description', 'status', 'priority', 'assignee', 'notes', 'branch', 'pr_url', 'subtasks'
  ])
  const next: Record<string, unknown> = { ...record }
  for (const [k, v] of Object.entries(patch)) {
    if (!EDITABLE.has(k)) continue
    if ((next as any)[k] === v) continue
    ;(next as any)[k] = v
    if (k === 'status') {
      const completing = String(v).toLowerCase() === 'completed'
      if (completing && !next.completedAt) next.completedAt = new Date().toISOString().slice(0, 10)
      if (!completing) next.completedAt = null
    }
  }
  writeFileSync(jsonPath, JSON.stringify(next, null, 2) + '\n', 'utf-8')
  return { conflict: false }
}

/** Read a text file with metadata for optimistic editing. */
export function readTextWithMtime(absPath: string): {
  ok: boolean
  error?: string
  content?: string
  mtime?: number
} {
  try {
    const st = statSync(absPath)
    return { ok: true, content: readFileSync(absPath, 'utf-8'), mtime: st.mtimeMs }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? '读取失败' }
  }
}

/** Save a spec markdown file with optimistic conflict detection. */
export function writeSpecFile(
  root: string,
  absPath: string,
  content: string,
  expectedMtime?: number
): { conflict: boolean } {
  const specRoot = resolve(root, '.trellis', 'spec') + sep
  const p = resolve(absPath)
  if (!p.startsWith(specRoot)) throw new Error('只允许编辑 .trellis/spec/ 下的文件')
  if (!/\.(md|markdown|txt)$/i.test(p)) throw new Error('只允许编辑 Markdown / 文本文件')
  if (Buffer.byteLength(content, 'utf-8') > 1024 * 1024) throw new Error('内容超过 1MB')
  if (expectedMtime !== undefined) {
    let cur = 0
    try {
      cur = statSync(p).mtimeMs
    } catch {
      // new file — ok
    }
    if (cur && Math.abs(cur - expectedMtime) > 50) {
      const err = new Error('文件已被外部修改，请刷新后重试') as Error & { conflict: boolean }
      err.conflict = true
      throw err
    }
  }
  writeFileSync(p, content, 'utf-8')
  return { conflict: false }
}

/**
 * Count references to each spec file across the project (task artifacts,
 * other spec docs, workflow.md). Reference = relative path segment or the
 * bare file name appearing in any markdown/text content.
 */
export function computeSpecBacklinks(root: string): Record<string, number> {
  const trellisDir = join(root, '.trellis')
  const specDir = join(trellisDir, 'spec')
  if (!isDir(specDir)) return {}

  const specFiles: string[] = []
  const collect = (dir: string): void => {
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const n of names) {
      const p = join(dir, n)
      if (isDir(p)) collect(p)
      else if (/\.(md|markdown|txt)$/i.test(n)) specFiles.push(p)
    }
  }
  collect(specDir)

  const names = specFiles.map((p) => basename(p))
  const counts: Record<string, number> = {}
  for (const p of specFiles) counts[p] = 0

  // haystack: all spec docs (excluding self matches handled below) + task dirs
  const haystacks: Array<{ path: string; text: string }> = []
  for (const p of specFiles) {
    try {
      haystacks.push({ path: p, text: readFileSync(p, 'utf-8') })
    } catch {
      // skip
    }
  }
  for (const bucket of ['tasks', 'archive', 'workspace']) {
    const dir = join(trellisDir, bucket)
    if (!isDir(dir)) continue
    const walk = (d: string, depth: number): void => {
      if (depth > 4) return
      let names2: string[] = []
      try {
        names2 = readdirSync(d)
      } catch {
        return
      }
      for (const n of names2) {
        const p = join(d, n)
        if (isDir(p)) walk(p, depth + 1)
        else if (/\.(md|markdown|txt)$/i.test(n)) {
          try {
            haystacks.push({ path: p, text: readFileSync(p, 'utf-8') })
          } catch {
            // skip
          }
        }
      }
    }
    walk(dir, 0)
  }
  try {
    const wf = join(trellisDir, 'workflow.md')
    if (existsSync(wf)) haystacks.push({ path: wf, text: readFileSync(wf, 'utf-8') })
  } catch {
    // skip
  }

  for (const p of specFiles) {
    const rel = p.slice(specDir.length + 1).replace(/\\/g, '/')
    const base = basename(p)
    let count = 0
    for (const h of haystacks) {
      if (h.path === p) continue
      if (h.text.includes(rel) || h.text.includes(base)) count += 1
    }
    counts[p] = count
  }
  return counts
}

export { TEXT_EXTS }
