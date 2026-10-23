import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, resolve } from 'path'

/**
 * LocalTaskService 纯函数层（design §7.2）：操作键/operationId 派生、磁盘对账扫描、
 * slug 派生与 CLI 默认 PRD 模板（用户改动判定基线）。只读探测，无写入副作用。
 *
 * 语义红线：
 * - 对账以 operationId（task.json meta.panel_operation_id）为准，不凭目录名猜归属。
 * - 同名不同 operationId → 冲突保持可见，不复用别人的目录。
 */

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** CLI generate_task_date_prefix 同款：本地时间 MM-DD（跨午夜判定依据）。 */
export function todayPrefix(now: Date = new Date()): string {
  const pad = (x: number): string => String(x).padStart(2, '0')
  return `${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** 数字 issueId 优先；缺失回退 key:<KEY>（大写，防大小写漂移重复）。 */
export function issueIdentifierOf(issueId: number | null | undefined, issueKey: string): string {
  return issueId !== null && issueId !== undefined ? `id:${issueId}` : `key:${issueKey.toUpperCase()}`
}

export function operationIdFor(key: {
  workspaceId: string
  instanceId: string
  issueIdentifier: string
  ordinal: number
}): string {
  return `op-${sha256Hex(`${key.workspaceId}\n${key.instanceId}\n${key.issueIdentifier}\n${key.ordinal}`).slice(0, 32)}`
}

/** slug 派生：issueKey+标题 → 安全目录名片段（CLI --slug 校验：无分隔符/无 ..）。 */
export function slugFor(issueKey: string, title: string, fallback = 'jira-task'): string {
  const raw = `${issueKey}-${title}`
    .replace(/\[[^\]]*\]/g, (m) => m.replace(/[[\]]/g, '')) // "[KEY] title" → "KEY title"
    .trim()
  const slug = raw
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/[^0-9A-Za-z\u4e00-\u9fa5._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/^-+|-+$/g, '')
  return slug || fallback
}

const TASK_JSON_READ_LIMIT_BYTES = 256 * 1024

export interface TaskMetaOnDisk {
  dir: string
  taskJsonId: string | null
  panelOperationId: string | null
  panelIssueKey: string | null
  legacyJiraKey: string | null
  jiraInstanceId: string | null
  jiraIssueId: string | null
  jiraUrl: string | null
  sourceProvider: string | null
  sourceInstanceId: string | null
  sourceId: string | null
  sourceKey: string | null
  sourceUrl: string | null
}

export function readTaskMeta(root: string, repoRelativeDir: string): TaskMetaOnDisk | null {
  const file = join(resolve(root), ...repoRelativeDir.split('/'), 'task.json')
  try {
    const st = statSync(file)
    if (!st.isFile() || st.size > TASK_JSON_READ_LIMIT_BYTES) return null
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as { id?: unknown; meta?: Record<string, unknown> }
    const meta = raw.meta ?? {}
    const id = typeof raw.id === 'string' ? raw.id : null
    return {
      dir: repoRelativeDir,
      taskJsonId: id,
      panelOperationId: typeof meta.panel_operation_id === 'string' ? meta.panel_operation_id : null,
      panelIssueKey: typeof meta.panel_jira_issue_key === 'string' ? meta.panel_jira_issue_key : null,
      legacyJiraKey: typeof meta.jiraKey === 'string' ? meta.jiraKey : null,
      jiraInstanceId: typeof meta.panel_jira_instance_id === 'string' ? meta.panel_jira_instance_id : null,
      jiraIssueId: /^(?:[1-9]\d*)$/.test(String(meta.panel_jira_issue_id ?? '')) ? String(meta.panel_jira_issue_id) : null,
      jiraUrl: typeof meta.jiraUrl === 'string' ? meta.jiraUrl : typeof meta.panel_jira_issue_url === 'string' ? meta.panel_jira_issue_url : null,
      sourceProvider: typeof meta.panel_source_provider === 'string' ? meta.panel_source_provider : null,
      sourceInstanceId: typeof meta.panel_source_instance_id === 'string' ? meta.panel_source_instance_id : null,
      sourceId: typeof meta.panel_source_id === 'string' ? meta.panel_source_id : null,
      sourceKey: typeof meta.panel_source_key === 'string' ? meta.panel_source_key : null,
      sourceUrl: typeof meta.panel_source_url === 'string' ? meta.panel_source_url : null
    }
  } catch {
    return null
  }
}

function listTaskDirsUnder(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
}

export interface DiskReconciliation {
  /** operationId → 实际目录（仓库相对，正斜杠；活跃+归档）。 */
  byOperationId: Map<string, string[]>
  /** Source display keys only form candidates; adapters verify provider/instance/stable ID. */
  byIssueKey: Map<string, string[]>
  /** 全部已知任务目录（含归档）。 */
  known: TaskMetaOnDisk[]
}

/**
 * 对账扫描（design §7.2：每次恢复先按 operationId/来源对账实际目录）。
 * 只读；task.json 缺失/损坏的目录不计入任何索引（不猜归属）。
 */
export function scanDiskForReconciliation(root: string): DiskReconciliation {
  const tasksRoot = join(resolve(root), '.trellis', 'tasks')
  const dirs: string[] = []
  for (const name of listTaskDirsUnder(tasksRoot)) {
    if (name === 'archive') continue
    dirs.push(`.trellis/tasks/${name}`)
  }
  const archiveRoot = join(tasksRoot, 'archive')
  for (const month of listTaskDirsUnder(archiveRoot)) {
    if (!/^\d{4}-\d{2}$/.test(month)) continue
    for (const name of listTaskDirsUnder(join(archiveRoot, month))) {
      dirs.push(`.trellis/tasks/archive/${month}/${name}`)
    }
  }
  const known: TaskMetaOnDisk[] = []
  for (const dir of dirs) {
    const meta = readTaskMeta(root, dir)
    if (meta !== null) known.push(meta)
  }
  const byOperationId = new Map<string, string[]>()
  const byIssueKey = new Map<string, string[]>()
  for (const meta of known) {
    if (meta.panelOperationId !== null) {
      const list = byOperationId.get(meta.panelOperationId) ?? []
      list.push(meta.dir)
      byOperationId.set(meta.panelOperationId, list)
    }
    for (const key of [meta.panelIssueKey, meta.legacyJiraKey, meta.sourceKey]) {
      if (key === null) continue
      const upper = key.toUpperCase()
      const list = byIssueKey.get(upper) ?? []
      if (!list.includes(meta.dir)) list.push(meta.dir)
      byIssueKey.set(upper, list)
    }
  }
  return { byOperationId, byIssueKey, known }
}

/** 目录是否在归档区。 */
export function isArchivedDir(repoRelativeDir: string): boolean {
  return repoRelativeDir.startsWith('.trellis/tasks/archive/')
}

/**
 * task.py create 的默认 PRD 模板（common/task_store._default_prd_content 的 TS 移植）。
 * 用途：中断恢复时判定 prd.md 是否仍是 CLI 原样（用户已改则不覆盖）。
 */
export function expectedDefaultPrd(title: string, description: string): string {
  const goal = description.trim() || 'TBD.'
  const heading = title.trim() || 'Untitled task'
  return `# ${heading}

## Goal

${goal}

## Requirements

- TBD

## Acceptance Criteria

- [ ] TBD

## Notes

- Keep \`prd.md\` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add \`design.md\` for technical design and \`implement.md\` for execution planning before \`task.py start\`.
`
}

/** 读取 task.json.id（readTrellisTaskId 同款上限/容错；本地版避免依赖 electron 边界模块）。 */
export function readTaskJsonId(root: string, repoRelativeDir: string): string | null {
  const meta = readTaskMeta(root, repoRelativeDir)
  return meta === null ? null : meta.taskJsonId
}

export function dirExists(absDir: string): boolean {
  try {
    return statSync(absDir).isDirectory()
  } catch {
    return false
  }
}
