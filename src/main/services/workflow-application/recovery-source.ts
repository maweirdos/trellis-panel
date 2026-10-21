/** Best-effort source-location display; never updates aliases or grants access. */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { WorkflowScope } from '../../../shared/workflow'
import type { WorkflowRecoverySource } from '../../../shared/workflow-recovery'
import type { WorkflowControlService } from '../workflow-control'
import { resolveAuthorizedDocumentPath } from '../documents/paths'
import { taskRefFor } from '../task-identity'

export async function inspectRecoverySource(root: string, scope: WorkflowScope, control: WorkflowControlService): Promise<WorkflowRecoverySource> {
  const result: WorkflowRecoverySource = { state: 'unknown', alias: null, candidates: [], reason: null }
  let visited = 0; let bytesRead = 0
  const directories: string[] = []
  const scan = async (path: string, months = false): Promise<void> => {
    const allowed = resolveAuthorizedDocumentPath(root, path)
    if (!allowed.ok) throw Error('Source directory is outside the authorized project')
    if (!allowed.exists) return
    const directory = await fs.opendir(join(root, path))
    for await (const entry of directory) {
      if (++visited > 5000) throw Error('Source directory display scan exceeds its budget')
      if (!entry.isDirectory() || entry.name === 'archive') continue
      if (months) { if (/^\d{4}-\d{2}$/.test(entry.name)) await scan(`${path}/${entry.name}`); continue }
      directories.push(`${path}/${entry.name}`)
    }
  }
  try {
    const stored = await control.getAlias(scope.taskRef)
    result.alias = stored ? { currentDir: stored.currentDir, trellisTaskId: stored.trellisTaskId, status: stored.status } : null
    await scan('.trellis/tasks')
    await scan('.trellis/tasks/archive', true)
    for (const dir of directories) {
      const path = resolveAuthorizedDocumentPath(root, `${dir}/task.json`)
      if (!path.ok || !path.exists) continue
      const stat = await fs.stat(path.canonicalPath)
      if (!stat.isFile()) continue
      if (stat.size > 256 * 1024 || bytesRead + stat.size > 4 * 1024 * 1024) throw Error('Task metadata display scan exceeds its byte budget')
      const bytes = await fs.readFile(path.canonicalPath)
      bytesRead += bytes.length
      if (bytes.length > 256 * 1024 || bytesRead > 4 * 1024 * 1024) throw Error('Task metadata grew beyond its display budget')
      let id: string | null
      try { id = z.object({ id: z.string().min(1).max(256).optional() }).passthrough().parse(JSON.parse(bytes.toString('utf8'))).id ?? null }
      catch { continue }
      if (taskRefFor(id, dir) === scope.taskRef) {
        if (result.candidates.length >= 20) throw Error('Too many matching source locations to display safely')
        result.candidates.push(dir)
      }
    }
    result.state = result.candidates.length > 1 ? 'ambiguous' : result.candidates.length === 1 ? 'available' : 'missing'
    if (result.state !== 'available') result.reason = result.state === 'ambiguous' ? 'Several current metadata records share the retained task identity; no path was selected' : 'The retained task identity has no verified current source location'
  } catch (error) {
    result.state = 'unavailable'; result.reason = error instanceof Error ? error.message : 'Source location could not be inspected'
  }
  return result
}
