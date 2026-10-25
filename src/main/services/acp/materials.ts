import { extname, isAbsolute, relative, resolve } from 'path'
import { computeRevision, readDocument } from '../documents/controller'
import { resolveAuthorizedDocumentPath } from '../documents/paths'
import { TEXT_EXTS } from '../scan'
import type { AcpMaterialChange, AcpMaterialSource, AcpSourceChange, AcpSourceReference } from '../../../shared/types'
import { clipUtf8, EXPLICIT_MATERIAL_BUDGET_BYTES, IMPLICIT_MATERIAL_BUDGET_BYTES, utf8ByteLength } from '../../../shared/material-budget'
import { canonicalDirectory } from './metadata'
import { taskDirSchema } from './types'

// Leave room for promptAcpSession's enclosing reference label, outside this module.
const MATERIAL_ENVELOPE_RESERVE_BYTES = 256

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

/** Path-only defaults and bounded explicit prefixes share the same stable read/hash checks. */
export async function preparePromptMaterials(root: string, taskDir: string | undefined, references: AcpSourceReference[]): Promise<PreparedMaterials> {
  const explicitPaths = new Set(references.map((reference) => reference.relativePath.replace(/\\/g, '/')))
  const paths = new Set<string>()
  if (taskDir) for (const name of ['prd.md', 'design.md', 'implement.md']) paths.add(`.trellis/tasks/${taskDir}/${name}`)
  for (const path of explicitPaths) paths.add(path)
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
  let text = ''
  const files: string[] = []
  const sources: AcpMaterialSource[] = []
  const groups = [
    { items: reads.filter(({ path }) => !explicitPaths.has(path)), budget: IMPLICIT_MATERIAL_BUDGET_BYTES, explicit: false },
    { items: reads.filter(({ path }) => explicitPaths.has(path)), budget: EXPLICIT_MATERIAL_BUDGET_BYTES, explicit: true }
  ]
  for (const group of groups) {
    const items = group.items.map((item) => {
      const missing = item.result.ok && item.result.diagnostics.some((diagnostic) => diagnostic.code === 'file_missing')
      // Implicit materials are a path-only index, never generated bodies/replays.
      const notice = item.result.ok && !missing ? `\n[Read on demand: ${item.path}]\n` : ''
      return { ...item, missing, notice }
    })
    // Reserve every exact path before spending bytes on any referenced body.
    let remaining = group.budget - MATERIAL_ENVELOPE_RESERVE_BYTES - items.reduce((bytes, item) => bytes + utf8ByteLength(item.notice), 0)
    if (remaining < 0) throw new Error('材料路径提示超过输入预算，请减少引用数量或缩短路径后再发送')
    for (const { path, result, missing, notice } of items) {
      const content = result.ok ? result.rawText : null
      const readable = result.ok && content !== null && result.revision !== null
      let included = ''
      let isIncluded = false
      let block = notice
      if (group.explicit && readable) {
        const available = remaining + utf8ByteLength(notice)
        const header = `\n\n--- ${path} ---\n`
        const readMore = `\n[Truncated; read: ${path}]\n`
        if (utf8ByteLength(header) + utf8ByteLength(content) <= available) {
          included = content
          isIncluded = true
          block = header + included
        } else {
          included = clipUtf8(content, available - utf8ByteLength(header) - utf8ByteLength(readMore))
          if (included.length > 0) {
            isIncluded = true
            block = header + included + readMore
          }
        }
        remaining = available - utf8ByteLength(block)
      }
      const source: AcpMaterialSource = { relativePath: path, sourceRevision: result.ok ? result.revision : null,
        includedRevision: isIncluded ? computeRevision(Buffer.from(included, 'utf8')) : null,
        sourceBytes: result.ok ? result.source.sizeBytes : null, includedBytes: utf8ByteLength(included), includedChars: included.length,
        included: isIncluded, truncated: readable && (included.length < content.length), extent: { start: 0, end: included.length, unit: 'utf16-code-units' },
        status: !readable ? missing ? 'missing' : 'unreadable' : isIncluded ? 'included' : 'omitted',
        diagnostics: result.ok ? result.diagnostics.map((diagnostic) => diagnostic.message) : [result.error] }
      sources.push(source)
      if (source.included) files.push(path)
      text += block
    }
  }
  return { text, files, sources, changed }
}

export function sourceBelongs(root: string, taskDir: string | undefined, reference: AcpSourceReference): boolean {
  return canonicalDirectory(root) === canonicalDirectory(reference.projectRoot) && taskDir === reference.taskDir && taskMaterialPath(root, reference.taskDir, reference.relativePath) !== null
}
