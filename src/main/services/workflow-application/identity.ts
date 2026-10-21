/** Local identities are private mappings, not team identity or observation grants. */
import { promises as fs } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join, resolve, relative, sep, isAbsolute } from 'node:path'
import { z } from 'zod'
import { workflowScopeSchema, type WorkflowScope } from '../../../shared/workflow'
import { managedTaskDirSchema } from '../../../shared/workflow-application'
import { readBinding, readInstallationIdentity, sameRoot } from '../observability/identity'
import { taskRefFor } from '../task-identity'
import type { WorkflowControlService } from '../workflow-control'
import { resolveAuthorizedDocumentPath } from '../documents/paths'
import { WorkflowApplicationError } from './types'

const identitySchema = z.object({
  schemaVersion: z.literal(1), canonicalRoot: z.string().min(1),
  projectId: z.string().min(1).max(512), repositoryId: z.string().min(1).max(512), workspaceId: z.string().min(1).max(512)
}).strict()
export type ApplicationIdentity = z.infer<typeof identitySchema>
const digest = (s: string): string => createHash('sha256').update(s).digest('hex')
const rootKey = (s: string): string => process.platform === 'win32' ? s.toLowerCase() : s

export async function resolveApplicationRoot(projectRoot: string): Promise<{ root: string; runtimeDir: string }> {
  const root = await fs.realpath(resolve(projectRoot))
  const dir = join(root, '.trellis', '.panel', 'runtime')
  if (!resolveAuthorizedDocumentPath(root, '.trellis/.panel/runtime').ok) throw new WorkflowApplicationError('SCOPE_CHANGED', 'Workflow runtime ancestor escapes the trusted project')
  await fs.mkdir(dir, { recursive: true })
  const runtimeDir = await fs.realpath(dir)
  if (relative(root, runtimeDir).split(sep).includes('..') || isAbsolute(relative(root, runtimeDir))) throw new WorkflowApplicationError('SCOPE_CHANGED', 'Workflow runtime is outside the trusted project')
  return { root, runtimeDir }
}

export async function loadApplicationIdentity(root: string, runtimeDir: string): Promise<ApplicationIdentity> {
  const path = join(runtimeDir, 'workflow-local-identity.json')
  const read = async (): Promise<ApplicationIdentity | null> => {
    try {
      const st = await fs.lstat(path)
      if (!st.isFile() || st.isSymbolicLink() || st.size > 16_384) throw new Error('Invalid identity file')
      const bytes = await fs.readFile(path)
      if (bytes.length > 16_384) throw new Error('oversize identity')
      const value = identitySchema.parse(JSON.parse(bytes.toString('utf8')))
      if (!sameRoot(value.canonicalRoot, root)) throw new WorkflowApplicationError('SCOPE_CHANGED', 'The pinned workflow mapping belongs to a different project root')
      return value
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
      if (error instanceof WorkflowApplicationError) throw error
      throw new WorkflowApplicationError('STORE_DEGRADED', 'The workflow identity mapping cannot be read; existing records were retained')
    }
  }
  const existing = await read()
  if (existing) return existing
  const binding = readBinding(runtimeDir)
  if (!binding) {
    const exists = await fs.lstat(join(runtimeDir, 'binding.json')).then(() => true, (e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return false; throw e })
    if (exists) throw new WorkflowApplicationError('STORE_DEGRADED', 'The existing observation binding is malformed; no replacement workflow identity was created')
  }
  if (binding && (!sameRoot(binding.canonicalRoot, root) || readInstallationIdentity()?.installationId !== binding.installationId)) throw new WorkflowApplicationError('SCOPE_CHANGED', 'The existing observation binding requires verification before reusing its identities')
  const key = digest(rootKey(root))
  const fresh: ApplicationIdentity = {
    schemaVersion: 1, canonicalRoot: root, projectId: `local-project-${key.slice(0, 32)}`,
    repositoryId: binding?.repositoryId ?? `local-repository-${key.slice(0, 32)}`,
    workspaceId: binding?.workspaceId ?? `root-${digest(root).slice(0, 16)}`
  }
  // Exclusive publication: a concurrent first opener cannot replace a mapping.
  const temporary = join(runtimeDir, `.workflow-local-identity-${randomUUID()}.tmp`)
  await fs.writeFile(temporary, JSON.stringify(fresh) + '\n', { flag: 'wx', mode: 0o600 })
  try { await fs.link(temporary, path) }
  catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error }
  finally { await fs.unlink(temporary).catch(() => {}) }
  const published = await read()
  if (!published) throw new WorkflowApplicationError('STORE_DEGRADED', 'Workflow identity publication was not confirmed')
  return published
}

export type ApplicationTask = { taskDir: string; relativeDir: string; canonicalDir: string; archived: boolean; taskId: string | null; scope: WorkflowScope }
export async function resolveApplicationTask(root: string, identity: ApplicationIdentity, control: WorkflowControlService, rawTaskDir: string, write = false): Promise<ApplicationTask> {
  const taskDir = managedTaskDirSchema.parse(rawTaskDir)
  const base = join(root, '.trellis', 'tasks')
  const dirs: string[] = []
  const active = await fs.readdir(base, { withFileTypes: true })
  for (const item of active) if (item.isDirectory() && item.name !== 'archive') dirs.push(`.trellis/tasks/${item.name}`)
  const archive = join(base, 'archive')
  const months = await fs.readdir(archive, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return []; throw e })
  for (const month of months) {
    if (!month.isDirectory() || !/^\d{4}-\d{2}$/.test(month.name)) continue
    for (const entry of await fs.readdir(join(archive, month.name), { withFileTypes: true })) if (entry.isDirectory()) dirs.push(`.trellis/tasks/archive/${month.name}/${entry.name}`)
    if (dirs.length > 5000) throw new WorkflowApplicationError('CAPACITY_EXCEEDED', 'Task identity scan exceeds its bounded directory budget')
  }
  const candidates = dirs.filter((dir) => dir.split('/').at(-1) === taskDir)
  if (candidates.length !== 1) throw new WorkflowApplicationError(candidates.length ? 'REVISION_CONFLICT' : 'NOT_FOUND', 'Task path is missing or ambiguous; select an exact verified local task')
  const relativeDir = candidates[0]
  const archived = relativeDir.startsWith('.trellis/tasks/archive/')
  if (write && archived) throw new WorkflowApplicationError('SCOPE_CHANGED', 'An archived task is read-only in the workflow application')
  const canonicalDir = await fs.realpath(join(root, relativeDir))
  if (relative(root, canonicalDir).split(sep).includes('..') || isAbsolute(relative(root, canonicalDir))) throw new WorkflowApplicationError('SCOPE_CHANGED', 'Task directory escapes the trusted root')
  const readId = async (dir: string): Promise<string | null> => {
    const allowed = resolveAuthorizedDocumentPath(root, `${dir}/task.json`)
    if (!allowed.ok || !allowed.exists) throw new WorkflowApplicationError('SCOPE_CHANGED', 'Task metadata is outside the trusted root or missing')
    const path = allowed.canonicalPath
    try {
      const st = await fs.stat(path)
      if (!st.isFile() || st.size > 256 * 1024) throw new Error('Invalid task metadata')
      const bytes = await fs.readFile(path)
      if (bytes.length > 256 * 1024) throw new Error('Task metadata grew beyond its budget')
      const body: unknown = JSON.parse(bytes.toString('utf8'))
      if (!body || typeof body !== 'object') throw new Error('Invalid task metadata')
      const parsed = z.object({ id: z.string().min(1).max(256).optional() }).passthrough().parse(body)
      return parsed.id ?? null
    } catch { throw new WorkflowApplicationError('INVALID_INPUT', 'Task metadata is unavailable or invalid') }
  }
  const taskId = await readId(relativeDir)
  if (taskId) {
    for (const dir of dirs) {
      if (dir === relativeDir) continue
      let other: string | null = null
      try { other = await readId(dir) } catch { /* Other invalid tasks cannot claim this ID. */ }
      if (other === taskId) throw new WorkflowApplicationError('REVISION_CONFLICT', 'The same Trellis task ID exists in multiple directories; explicit alias resolution is required')
    }
  }
  const taskRef = taskRefFor(taskId, relativeDir)
  const alias = await control.getAlias(taskRef)
  if (alias && alias.currentDir !== relativeDir) {
    let originalExists = true
    try { await fs.stat(join(root, alias.currentDir)) } catch (e) { if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') originalExists = false; else throw e }
    if (originalExists || !taskId || alias.trellisTaskId !== taskId) throw new WorkflowApplicationError('REVISION_CONFLICT', 'Existing task alias requires explicit verification before retargeting')
  }
  if (alias && alias.status !== 'verified') throw new WorkflowApplicationError('REVISION_CONFLICT', 'Task alias is not verified')
  await control.upsertAlias(taskRef, taskId, relativeDir)
  return { taskDir, relativeDir, canonicalDir, archived, taskId, scope: workflowScopeSchema.parse({ projectId: identity.projectId, repositoryId: identity.repositoryId, workspaceId: identity.workspaceId, taskRef }) }
}
