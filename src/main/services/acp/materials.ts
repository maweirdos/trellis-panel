import { extname, isAbsolute, relative, resolve } from 'path'
import { computeRevision, readDocument } from '../documents/controller'
import { resolveAuthorizedDocumentPath } from '../documents/paths'
import { TEXT_EXTS } from '../scan'
import type { AcpMaterialChange, AcpMaterialSource, AcpSourceChange, AcpSourceReference } from '../../../shared/types'
import { canonicalDirectory } from './metadata'
import { taskDirSchema } from './types'

const FILE_CHAR_LIMIT = 16000
const TOTAL_CHAR_LIMIT = FILE_CHAR_LIMIT * 3

/** Exact active-task namespace; both lexical and physical root fences are checked. */
export function taskMaterialPath(root: string, taskDir: string, relativePath: string): string | null {
  if (!taskDirSchema.safeParse(taskDir).success || isAbsolute(relativePath) || relativePath.includes('\0')) return null
  const normalized = relativePath.replace(/\\/g, '/')
  if (normalized.split('/').some((part) => part === '.' || part === '..' || part === '')) return null
  const prefix = `.trellis/tasks/${taskDir}/`
  if (!normalized.startsWith(prefix)) return null
  return resolveAuthorizedDocumentPath(root, normalized).ok ? normalized : null
}

export function isTaskDocumentMaterial(innerPath: string): boolean {
  // Retain existing task-document attention (task.json/manifests/notes included),
  // while giving all new verified facts the same modern reader type boundary.
  return TEXT_EXTS.has(extname(innerPath).toLowerCase())
}

export async function activeTaskExists(root: string, taskDir: string): Promise<boolean> {
  const path = taskMaterialPath(root, taskDir, `.trellis/tasks/${taskDir}/task.json`)
  if (!path) return false
  const result = await readDocument(root, { workspaceId: root, taskRef: taskDir }, { relativePath: path, requestId: 'acp-task-check' })
  if (!result.ok || result.rawText === null || result.source.sizeBytes === null || result.source.sizeBytes > 256 * 1024) return false
  try { const value: unknown = JSON.parse(result.rawText); return typeof value === 'object' && value !== null && !Array.isArray(value) }
  catch { return false }
}

export function eventTaskMaterial(root: string, absPath: string): { taskDir: string; relativePath: string } | null {
  const path = relative(resolve(root), resolve(absPath)).replace(/\\/g, '/')
  const match = /^\.trellis\/tasks\/([^/]+)\/(.+)$/.exec(path)
  if (!match || !isTaskDocumentMaterial(match[2])) return null
  const checked = taskMaterialPath(root, match[1], path)
  return checked ? { taskDir: match[1], relativePath: checked } : null
}

export async function verifyMaterialChange(root: string, generation: number, absPath: string, kind: AcpMaterialChange['kind']): Promise<AcpMaterialChange | null> {
  const target = eventTaskMaterial(root, absPath)
  if (!target || !await activeTaskExists(root, target.taskDir)) return null
  const result = await readDocument(root, { workspaceId: root, taskRef: target.taskDir }, { relativePath: target.relativePath, requestId: 'acp-material-fact' })
  if (!result.ok) return null
  const missing = result.diagnostics.some((diagnostic) => diagnostic.code === 'file_missing')
  return { projectRoot: root, projectGeneration: generation, ...target, kind, source: 'filesystem-event', observedAt: Date.now(),
    revision: result.revision, availability: result.rawText !== null && result.revision !== null ? 'readable' : missing ? 'missing' : 'unreadable' }
}

export interface PreparedMaterials {
  text: string
  files: string[]
  sources: AcpMaterialSource[]
  changed: AcpSourceChange[]
}

/** Hash checks and included text share the same modern, stable bounded read. */
export async function preparePromptMaterials(root: string, taskDir: string | undefined, references: AcpSourceReference[]): Promise<PreparedMaterials> {
  const paths = new Set<string>()
  if (taskDir) for (const name of ['prd.md', 'design.md', 'implement.md']) paths.add(`.trellis/tasks/${taskDir}/${name}`)
  for (const reference of references) paths.add(reference.relativePath.replace(/\\/g, '/'))
  const reads = await Promise.all([...paths].map(async (path) => ({ path, result: await readDocument(root,
    { workspaceId: root, taskRef: taskDir ?? null }, { relativePath: path, requestId: 'acp-prompt-material' }) })))
  const changed: AcpSourceChange[] = []
  for (const reference of references) {
    const item = reads.find(({ path }) => path === reference.relativePath.replace(/\\/g, '/'))
    const result = item?.result
    const actualRevision = result?.ok ? result.revision : null
    const available = result?.ok === true && result.rawText !== null && actualRevision !== null
    if (!available || actualRevision !== reference.displayedRevision) changed.push({ relativePath: reference.relativePath, expectedRevision: reference.displayedRevision, actualRevision, available })
  }
  if (changed.length > 0) return { text: '', files: [], sources: [], changed }
  let remaining = TOTAL_CHAR_LIMIT
  let text = ''
  const files: string[] = []
  const sources: AcpMaterialSource[] = []
  for (const { path, result } of reads) {
    const content = result.ok ? result.rawText : null
    let included = content?.slice(0, Math.min(FILE_CHAR_LIMIT, remaining)) ?? ''
    // Do not divide a surrogate pair at the material character boundary.
    if (included && /[\uD800-\uDBFF]$/.test(included)) included = included.slice(0, -1)
    const readable = result.ok && content !== null && result.revision !== null
    const hasRoom = remaining > 0
    const missing = result.ok && result.diagnostics.some((diagnostic) => diagnostic.code === 'file_missing')
    const source: AcpMaterialSource = { relativePath: path, sourceRevision: result.ok ? result.revision : null,
      includedRevision: readable && hasRoom ? computeRevision(Buffer.from(included, 'utf8')) : null,
      sourceBytes: result.ok ? result.source.sizeBytes : null, includedBytes: Buffer.byteLength(included, 'utf8'), includedChars: included.length,
      included: readable && hasRoom, truncated: readable && (included.length < content.length), extent: { start: 0, end: included.length, unit: 'utf16-code-units' },
      status: !readable ? missing ? 'missing' : 'unreadable' : hasRoom ? 'included' : 'omitted',
      diagnostics: result.ok ? result.diagnostics.map((diagnostic) => diagnostic.message) : [result.error] }
    sources.push(source)
    if (source.included) { files.push(path); text += `\n\n--- ${path} ---\n${included}`; remaining -= included.length }
  }
  return { text, files, sources, changed }
}

export function sourceBelongs(root: string, taskDir: string | undefined, reference: AcpSourceReference): boolean {
  return canonicalDirectory(root) === canonicalDirectory(reference.projectRoot) && taskDir === reference.taskDir && taskMaterialPath(root, reference.taskDir, reference.relativePath) !== null
}
