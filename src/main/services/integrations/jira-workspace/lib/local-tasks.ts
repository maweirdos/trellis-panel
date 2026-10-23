import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { WorkspaceGrant } from '../../../../../shared/daemon'
import { jiraFieldsSchema, type JiraFields, type JiraIssueRecord, type JiraMapping } from '../../../../../shared/jira-integration'
import { jiraSourceMatch } from '../../../../../shared/jira-source'
import { createOrOpenTaskFromJira, scanDiskForReconciliation, LocalControlStore, localRuntimeDirOf, workspaceIdForRoot } from '../../../local-task'
import { scanKnownTaskDirs, taskRefFor } from '../../../task-identity'
import { readBounded, writeAtomic } from '../../../../daemon/files'
import { recordOf, textOf } from '../../transport'
import { JiraWorkspaceError, localSnapshotSchema, type JiraLocalSnapshot, type JiraWorkspaceAuthority } from '../types'
import { digest } from '../repository'
import { STORE_DB_VERSION } from '../../../observability/store-core'

export interface JiraTaskPort {
  list(grant: WorkspaceGrant): JiraLocalSnapshot[]
  read(grant: WorkspaceGrant, taskRef: string): JiraLocalSnapshot
  find(grant: WorkspaceGrant, issue: JiraIssueRecord): JiraLocalSnapshot | null
  create(grant: WorkspaceGrant, issue: JiraIssueRecord, mapping: JiraMapping): Promise<{ snapshot: JiraLocalSnapshot; created: boolean; operationId: string }>
  patch(grant: WorkspaceGrant, before: JiraLocalSnapshot, fields: Partial<JiraFields>, issue: JiraIssueRecord | null): JiraLocalSnapshot
  rollback(grant: WorkspaceGrant, snapshot: JiraLocalSnapshot, jobId: string, receiptId: string): string
}
function contained(root: string, path: string): void {
  const rel = relative(realpathSync(root), realpathSync(path))
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(path) === resolve(root) || /^[A-Za-z]:/.test(rel)) throw new JiraWorkspaceError('E_DENIED', 'Jira task path escapes the authorized workspace.')
}
function safePath(root: string, dir: string): string {
  if (!/^\.trellis\/tasks\/(?:archive\/\d{4}-\d{2}\/)?[^/\\]+$/.test(dir) || dir.includes('..')) throw new JiraWorkspaceError('E_DENIED', 'Invalid retained task path.')
  let current = root
  for (const part of dir.split('/')) { current = join(current, part); if (lstatSync(current).isSymbolicLink()) throw new JiraWorkspaceError('E_DENIED', 'Jira task paths cannot contain symbolic links.') }
  contained(root, current)
  return current
}
function treeHash(path: string): string {
  const files: Array<[string, string]> = []; let bytes = 0
  function visit(directory: string, prefix: string, depth: number): void {
    if (depth > 8) throw new JiraWorkspaceError('E_CONFLICT', 'Task artifact tree exceeds the rollback inspection depth.')
    for (const name of readdirSync(directory).sort()) {
      if (files.length >= 200) throw new JiraWorkspaceError('E_CONFLICT', 'Task artifact tree exceeds the rollback inspection limit.')
      const file = join(directory, name); const info = lstatSync(file); const rel = `${prefix}${name}`
      if (info.isSymbolicLink()) throw new JiraWorkspaceError('E_DENIED', 'Linked task artifacts cannot be synchronized or rolled back.')
      if (info.isDirectory()) { files.push([`${rel}/`, 'directory']); visit(file, `${rel}/`, depth + 1) }
      else if (info.isFile()) {
        bytes += info.size
        if (bytes > 8 * 1024 * 1024) throw new JiraWorkspaceError('E_CONFLICT', 'Task artifacts exceed the rollback byte limit.')
        const content = readFileSync(file)
        if (content.byteLength !== info.size || lstatSync(file).isSymbolicLink()) throw new JiraWorkspaceError('E_CONFLICT', 'Task artifact changed while its exact rollback fingerprint was read.')
        files.push([rel, createHash('sha256').update(content).digest('hex')])
      } else throw new JiraWorkspaceError('E_DENIED', 'Unsupported task artifact type.')
    }
  }
  visit(path, '', 0); return digest(files)
}
function snapshot(root: string, dir: string): JiraLocalSnapshot {
  const path = safePath(root, dir); const text = readBounded(join(path, 'task.json'), 256 * 1024)
  const task = recordOf(JSON.parse(text)); const meta = recordOf(task.meta); const jira = recordOf(meta.jiraWorkspace)
  const fields = jiraFieldsSchema.parse({ title: textOf(task.title), description: typeof task.description === 'string' ? task.description : null, priority: textOf(task.priority), assignee: textOf(task.assignee), status: textOf(jira.status), type: textOf(jira.type), labels: jira.labels ?? [], comments: jira.comments ?? [] })
  return localSnapshotSchema.parse({ taskRef: taskRefFor(typeof task.id === 'string' ? task.id : null, dir), dir, operationId: typeof meta.panel_operation_id === 'string' ? meta.panel_operation_id : null, hash: createHash('sha256').update(text).digest('hex'), treeHash: treeHash(path), fields, sourceIssueId: typeof meta.panel_jira_issue_id === 'string' ? meta.panel_jira_issue_id : null, sourceInstanceId: typeof meta.panel_jira_instance_id === 'string' ? meta.panel_jira_instance_id : null })
}
function assertOriginalLinks(grant: WorkspaceGrant, task: JiraLocalSnapshot): void {
  const file = join(localRuntimeDirOf(grant.root), 'control.sqlite')
  if (!existsSync(file) || lstatSync(file).isSymbolicLink() || ['-wal', '-shm', '-journal'].some((suffix) => existsSync(file + suffix))) throw new JiraWorkspaceError('E_CONFLICT', 'Task control store is absent, linked or busy; rollback cannot verify later associations.')
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout=50; PRAGMA query_only=ON;')
    const version = db.prepare("SELECT value FROM control_schema_meta WHERE key='dbVersion'").get()
    if (Number(version?.value) !== STORE_DB_VERSION) throw new JiraWorkspaceError('E_CONFLICT', 'Task control schema is not the verified version; rollback is blocked.')
    const links = db.prepare('SELECT sourceKind, sourceKey, payloadJson FROM source_links WHERE workspaceId=? AND taskRef=? LIMIT 2').all(workspaceIdForRoot(grant.root), task.taskRef)
    if (links.length !== 1 || links[0].sourceKind !== 'jira' || links[0].sourceKey !== `${task.sourceInstanceId}#${task.sourceIssueId}`) throw new JiraWorkspaceError('E_CONFLICT', 'Task has additional, missing or changed source associations.')
    const payload = recordOf(JSON.parse(String(links[0].payloadJson)))
    if (payload.operationId !== task.operationId) throw new JiraWorkspaceError('E_CONFLICT', 'The original Jira creation operation no longer owns the source link.')
    const alias = db.prepare('SELECT currentDir, priorDirsJson FROM task_aliases WHERE taskRef=?').get(task.taskRef)
    if (!alias || alias.currentDir !== task.dir || String(alias.priorDirsJson) !== '[]') throw new JiraWorkspaceError('E_CONFLICT', 'Task aliases moved or changed after creation.')
  } finally { db.close() }
}
/** Active runtime/link authority is injected at composition; absence disables destructive rollback. */
export function createJiraTaskPort(authority: JiraWorkspaceAuthority, assertRemovable?: (grant: WorkspaceGrant, task: JiraLocalSnapshot) => void): JiraTaskPort {
  function read(grant: WorkspaceGrant, taskRef: string): JiraLocalSnapshot {
    authority.assertGrant(grant)
    const matches = scanKnownTaskDirs(grant.root).filter((item) => taskRefFor(item.trellisTaskId, item.dir) === taskRef)
    if (matches.length !== 1) throw new JiraWorkspaceError('E_CONFLICT', 'Retained local task identity is missing or ambiguous.')
    return snapshot(grant.root, matches[0].dir)
  }
  return {
    read,
    list(grant) {
      authority.assertGrant(grant)
      const dirs = scanKnownTaskDirs(grant.root).filter((item) => !item.dir.startsWith('.trellis/tasks/archive/'))
      return dirs.slice(0, 100).map((item) => snapshot(grant.root, item.dir))
    },
    find(grant, issue) {
      authority.assertGrant(grant)
      const disk = scanDiskForReconciliation(grant.root)
      const possible = disk.known.filter((item) => item.jiraIssueId === issue.issueId && item.jiraInstanceId === issue.instanceId || item.panelIssueKey?.toUpperCase() === issue.key.toUpperCase() || item.legacyJiraKey?.toUpperCase() === issue.key.toUpperCase())
      const matching = possible.filter((item) => (!item.jiraIssueId || item.jiraIssueId === issue.issueId) && jiraSourceMatch(item.jiraInstanceId, item.jiraUrl, issue.instanceId, issue.url) === 'same')
      if (matching.length > 1 || possible.some((item) => jiraSourceMatch(item.jiraInstanceId, item.jiraUrl, issue.instanceId, issue.url) === 'ambiguous')) throw new JiraWorkspaceError('E_CONFLICT', 'Jira source matches multiple tasks or a legacy key without instance identity.')
      return matching.length ? snapshot(grant.root, matching[0].dir) : null
    },
    async create(grant, issue, mapping) {
      authority.assertGrant(grant)
      const result = await createOrOpenTaskFromJira({ root: grant.root, instanceId: issue.instanceId, issueId: Number(issue.issueId), issueKey: issue.key, title: issue.fields.title, description: mapping.fields.includes('description') ? issue.fields.description : null, summaryDescription: '', url: issue.url, updatedAtMs: issue.updatedAt, priority: mapping.fields.includes('priority') ? mapping.priorities[issue.fields.priority] ?? 'P2' : 'P2', assignee: mapping.fields.includes('assignee') ? mapping.members[issue.fields.assignee] ?? '' : '', allowAdditional: false, fetchedAtMs: Date.now() })
      authority.assertGrant(grant)
      if (!result.ok) throw new JiraWorkspaceError(result.code === 'conflict' ? 'E_CONFLICT' : result.code === 'control_store' ? 'E_UNAVAILABLE' : result.code === 'invalid' ? 'E_INVALID_ARG' : 'E_UNKNOWN', 'Existing Jira task intake did not confirm a ready task. Reconcile the original operation before continuing.')
      const found = scanDiskForReconciliation(grant.root).known.filter((item) => item.panelOperationId === result.operationId || item.dir.split('/').at(-1) === result.dirName && item.jiraInstanceId === issue.instanceId && item.jiraIssueId === issue.issueId)
      if (found.length !== 1) throw new JiraWorkspaceError('E_CONFLICT', 'Created Jira task identity could not be uniquely verified.')
      return { snapshot: snapshot(grant.root, found[0].dir), created: result.created, operationId: result.operationId }
    },
    patch(grant, before, fields, issue) {
      const latest = read(grant, before.taskRef)
      if (latest.hash !== before.hash || latest.treeHash !== before.treeHash || latest.dir !== before.dir || latest.dir.includes('/archive/')) throw new JiraWorkspaceError('E_CONFLICT', 'Local task/artifacts changed or were archived before the mapped update.')
      const directory = safePath(grant.root, latest.dir); const file = join(directory, 'task.json')
      const task = recordOf(JSON.parse(readBounded(file, 256 * 1024))); const meta = recordOf(task.meta); const prior = recordOf(meta.jiraWorkspace)
      for (const field of ['title', 'description', 'priority', 'assignee'] as const) if (field in fields) task[field] = fields[field]
      const next = { ...prior }
      for (const field of ['status', 'type', 'labels', 'comments'] as const) if (field in fields) next[field] = fields[field]
      if (issue) {
        if (latest.sourceInstanceId && (latest.sourceInstanceId !== issue.instanceId || latest.sourceIssueId && latest.sourceIssueId !== issue.issueId)) throw new JiraWorkspaceError('E_CONFLICT', 'A task cannot be rebound to another Jira numeric identity by synchronization.')
        next.source = { instanceId: issue.instanceId, issueId: issue.issueId, key: issue.key, url: issue.url, updatedAt: issue.updatedAt, evidence: 'Full source fields/references/history are retained in the Jira job evidence repository.' }; next.lastSourceUpdatedAt = issue.updatedAt
        if (!latest.sourceIssueId) {
          meta.panel_jira_instance_id = issue.instanceId; meta.panel_jira_issue_id = issue.issueId; meta.panel_jira_issue_key = issue.key; meta.jiraUrl = issue.url
        }
        meta.panel_jira_issue_key = issue.key; meta.jiraUrl = issue.url
        if (typeof meta.jiraKey === 'string') meta.jiraKey = issue.key
      }
      task.meta = { ...meta, jiraWorkspace: next }
      authority.assertGrant(grant)
      if (createHash('sha256').update(readBounded(file, 256 * 1024)).digest('hex') !== before.hash) throw new JiraWorkspaceError('E_CONFLICT', 'Local task changed before atomic publication.')
      // PRD and Trellis lifecycle fields are intentionally outside this patch strategy.
      const serialized = JSON.stringify(task, null, 2) + '\n'
      if (Buffer.byteLength(serialized) > 256 * 1024) throw new JiraWorkspaceError('E_CONFLICT', 'Mapped task metadata exceeds the local task reader limit. Source/history evidence was preserved; the task was not overwritten.')
      writeAtomic(file, serialized)
      if (issue && !latest.sourceIssueId) {
        const store = new LocalControlStore(localRuntimeDirOf(grant.root))
        try {
          store.open()
          store.insertSourceLink({ workspaceId: workspaceIdForRoot(grant.root), sourceKind: 'jira', sourceKey: `${issue.instanceId}#${issue.issueId}`, taskRef: latest.taskRef, payload: { issueKey: issue.key, issueId: Number(issue.issueId), url: issue.url, updatedAtMs: issue.updatedAt, origin: 'jira-workspace' } })
          const taskId = latest.taskRef.startsWith('task:') ? latest.taskRef.slice(5) : null
          store.upsertAlias(latest.taskRef, taskId, latest.dir)
        } finally { store.close() }
      }
      return snapshot(grant.root, before.dir)
    },
    rollback(grant, before, jobId, receiptId) {
      if (!assertRemovable) throw new JiraWorkspaceError('E_UNAVAILABLE', 'Native task/runtime/link removal guard is not installed.')
      const current = read(grant, before.taskRef)
      if (current.treeHash !== before.treeHash || !before.operationId || current.operationId !== before.operationId || current.dir.includes('/archive/')) throw new JiraWorkspaceError('E_CONFLICT', 'Task has changed, moved, or lost its exact creation provenance; rollback is blocked.')
      assertOriginalLinks(grant, current)
      assertRemovable(grant, current)
      const source = safePath(grant.root, current.dir)
      const quarantineRoot = join(grant.root, '.trellis', '.panel', 'runtime', 'jira-rollback', jobId)
      mkdirSync(quarantineRoot, { recursive: true }); contained(grant.root, quarantineRoot)
      const destination = join(quarantineRoot, receiptId)
      if (existsSync(destination)) throw new JiraWorkspaceError('E_CONFLICT', 'Rollback destination already contains retained evidence.')
      authority.assertGrant(grant)
      if (treeHash(source) !== before.treeHash) throw new JiraWorkspaceError('E_CONFLICT', 'Task changed while rollback guards were evaluated.')
      // Remove from active tasks without deleting evidence or touching any remote issue.
      renameSync(source, destination)
      return relative(grant.root, destination).split(sep).join('/')
    }
  }
}
