/** Clean-room source/view ownership. Immutable bytes belong to WorkflowMaterialStore. */
import { createHash, randomUUID } from 'crypto'
import { constants, realpathSync } from 'fs'
import { promises as fs } from 'fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'path'
import { z } from 'zod'
import { fixedDocumentTokenSchema, type FixedDocumentVersion, type ReaderOrigin, type DocumentVersionCatalog, type DocumentWindowBootstrap, type FixedDocumentComparison } from '../../shared/document-windows'
import { IpcErrorCode, ipcFail, type IpcFail } from '../../shared/ipc-errors'
import type { DocumentReadSuccess, DocumentReadScope, DocumentParsed } from '../../shared/documents'
import { WorkflowMaterialStore } from './workflow-runtime/materials'
import { materialOwnerSchema, type MaterialOwner, type StoredWorkflowMaterial } from './workflow-runtime/types'
import { readDocument, computeRevision } from './documents/controller'
import { parseContextManifest, parseTaskJsonText } from './documents/parse'
import { computeDocumentDiff as compareDocuments } from './documents/diff-service'
import { realRootOf as canonicalRoot } from './documents/paths'
import { readBinding, readInstallationIdentity, sameRoot } from './observability/identity'
import { parseTrellisTaskPath, readTrellisTaskId, taskRefFor } from './task-identity'

const MAX_VERSIONS = 500
const MAX_RECORD_BYTES = 768 * 1024
const MAX_VIEWS = 32
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
const rootKey = (root: string): string => process.platform === 'win32' ? canonicalRoot(root).toLowerCase() : canonicalRoot(root)
/** Physical affinity is distinct from the historical token namespace. Never
 * rewrite an existing rd token/owner just because a caller uses another alias. */
const samePhysicalRoot = (left: string, right: string): boolean => {
  try {
    const a = realpathSync.native(resolve(left)), b = realpathSync.native(resolve(right))
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  } catch { return false }
}
const recordSchema = z.object({
  schemaVersion: z.literal(1), projectRoot: z.string().min(1), owner: materialOwnerSchema,
  materialRef: z.string().regex(/^wm-[0-9a-f]{64}$/),
  version: z.object({ token: fixedDocumentTokenSchema, title: z.string(), relativePath: z.string(), revision: z.string(), digest: z.string().regex(/^[0-9a-f]{64}$/), kind: z.enum(['product-requirement', 'trellis-prd', 'design', 'spec', 'code', 'feedback', 'other']), capturedAt: z.number().int().nonnegative() }).strict(),
  source: z.object({ relativePath: z.string(), canonicalPath: z.string(), sizeBytes: z.number().nullable(), mtimeMs: z.number().nullable() }).strict(),
  diagnostics: z.array(z.unknown()), parsed: z.unknown().nullable()
}).strict()
type VersionRecord = z.infer<typeof recordSchema>
type ViewRecord = { id: string; root: string; generation: number; token: string; origin: ReaderOrigin | null; originTaskRef: string | null; senderId: number | null }
export type ReaderViewAuthority = { projectRoot: string | null; generation: number }
export interface DocumentViewAdapters {
  /** Resolve from trusted main application bindings; never renderer cache namespaces. */
  resolveOwner?: (root: string, relativePath: string) => MaterialOwner | Promise<MaterialOwner>
  storeForRoot?: (root: string) => WorkflowMaterialStore
}

/** Private reader identity is derived from actual root/source, never client cache names. */
export function readerMaterialOwner(root: string, relativePath: string): MaterialOwner {
  const real = canonicalRoot(root)
  const binding = readBinding(join(real, '.trellis', '.panel', 'runtime'))
  const installation = readInstallationIdentity()
  const verified = binding && installation && binding.installationId === installation.installationId && sameRoot(binding.canonicalRoot, real) ? binding : null
  const local = hash(rootKey(real))
  const parsed = parseTrellisTaskPath(real, resolve(real, relativePath))
  const taskRef = parsed ? taskRefFor(readTrellisTaskId(real, parsed.repoRelativeDir), parsed.repoRelativeDir) : null
  return { projectId: `reader-local-${local}`, repositoryId: verified?.repositoryId ?? `reader-repo-${local}`, workspaceId: verified?.workspaceId ?? `reader-ws-${local}`, taskRef }
}

function materialKind(path: string): FixedDocumentVersion['kind'] {
  const normal = path.replace(/\\/g, '/')
  if (normal.startsWith('.trellis/spec/')) return 'spec'
  if (/^\.trellis\/tasks\/(?:archive\/\d{4}-\d{2}\/)?[^/]+\/prd\.md$/.test(normal)) return 'trellis-prd'
  if (/^\.trellis\/tasks\/(?:archive\/\d{4}-\d{2}\/)?[^/]+\/design\.md$/.test(normal)) return 'design'
  return 'other'
}

export class DocumentViewService {
  private readonly stores = new Map<string, WorkflowMaterialStore>()
  private readonly records = new Map<string, VersionRecord>()
  private readonly views = new Map<string, ViewRecord>()
  constructor(private readonly authority: () => ReaderViewAuthority, private readonly adapters: DocumentViewAdapters = {}) {}

  setAdapters(adapters: DocumentViewAdapters): void {
    this.adapters.resolveOwner = adapters.resolveOwner
    this.adapters.storeForRoot = adapters.storeForRoot
    this.stores.clear()
  }

  private async metadataPath(root: string, token: string | null, create: boolean): Promise<string> {
    let current = canonicalRoot(root)
    for (const part of ['.trellis', '.panel', 'runtime', 'reader-versions']) {
      current = join(current, part)
      if (create) await fs.mkdir(current).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
      const stat = await fs.lstat(current)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('固定版本目录包含重定向或无效目录')
    }
    return token === null ? current : join(current, `${fixedDocumentTokenSchema.parse(token)}.json`)
  }
  private store(root: string): WorkflowMaterialStore {
    const key = rootKey(root)
    let store = this.stores.get(key)
    if (!store) { store = this.adapters.storeForRoot?.(root) ?? new WorkflowMaterialStore({ directory: join(canonicalRoot(root), '.trellis', '.panel', 'runtime', 'workflow-materials') }); this.stores.set(key, store) }
    return store
  }
  isActive(root: string, generation?: number): boolean {
    const now = this.authority()
    return now.projectRoot !== null && samePhysicalRoot(now.projectRoot, root) && (generation === undefined || now.generation === generation)
  }
  private async record(root: string, token: string): Promise<VersionRecord> {
    fixedDocumentTokenSchema.parse(token)
    const cached = this.records.get(token)
    if (cached && samePhysicalRoot(cached.projectRoot, root)) return cached
    const file = await this.metadataPath(root, token, false)
    const link = await fs.lstat(file)
    if (!link.isFile() || link.isSymbolicLink()) throw new Error('固定版本记录不是普通文件')
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    let value: VersionRecord
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) throw new Error('固定版本记录不可读或超限')
      const bytes = Buffer.alloc(MAX_RECORD_BYTES + 1)
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
      if (bytesRead > MAX_RECORD_BYTES) throw new Error('固定版本记录超过读取上限')
      value = recordSchema.parse(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')))
    } finally { await handle.close() }
    if (!samePhysicalRoot(value.projectRoot, root) || value.version.token !== token || token !== `rd-${hash(JSON.stringify([rootKey(value.projectRoot), value.materialRef]))}` || value.version.relativePath !== value.source.relativePath) throw new Error('固定版本来源不匹配')
    const sourcePath = resolve(value.projectRoot, value.source.relativePath)
    const inside = (path: string): boolean => { const rel = relative(canonicalRoot(value.projectRoot), resolve(path)); return rel !== '..' && !rel.startsWith('..' + sep) && !/^[a-zA-Z]:|^[\\/]/.test(rel) }
    if (!inside(sourcePath) || !inside(value.source.canonicalPath) || isAbsolute(value.source.relativePath) || /^[a-zA-Z]:/.test(value.source.relativePath) || !value.source.relativePath || value.source.relativePath.split(/[\\/]/).some((part) => !part || part === '..' || part === '.')) throw new Error('固定版本路径不匹配')
    this.records.set(token, value)
    if (this.records.size > MAX_VERSIONS) this.records.delete(this.records.keys().next().value as string)
    return value
  }

  private async persistRecord(root: string, input: VersionRecord): Promise<VersionRecord> {
    const target = await this.metadataPath(root, input.version.token, true)
    let record = input
    try {
      const handle = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
      try { await handle.writeFile(JSON.stringify(record)) } finally { await handle.close() }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      record = await this.record(root, input.version.token)
      if (record.materialRef !== input.materialRef || record.version.digest !== input.version.digest) throw new Error('固定版本记录发生冲突，已保留原记录')
    }
    this.records.set(record.version.token, record)
    if (this.records.size > MAX_VERSIONS) this.records.delete(this.records.keys().next().value as string)
    return record
  }

  /** Main-only adapter: caller first verifies run membership; store rechecks owner/ref.
   * Does not reread a newer file and does not accept renderer-provided historical text. */
  async registerMaterial(root: string, stored: StoredWorkflowMaterial): Promise<FixedDocumentVersion> {
    const material = await this.store(root).readVersion(stored.owner, stored.ref)
    if (material.bodyDigest !== stored.bodyDigest) throw new Error('工作流材料版本不匹配')
    const source = material.material.source
    if (source.kind !== 'trellis-file') throw new Error('此材料来源尚未接入独立文档阅读器')
    const path = source.relativePath.replace(/\\/g, '/')
    const canonicalPath = resolve(canonicalRoot(root), path)
    const rel = relative(canonicalRoot(root), canonicalPath)
    if (isAbsolute(path) || /^[a-zA-Z]:/.test(path) || !path || path.split('/').some((part) => !part || part === '.' || part === '..') || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('工作流材料来源超出项目范围')
    const version: FixedDocumentVersion = { token: `rd-${hash(JSON.stringify([rootKey(root), material.ref]))}`, title: basename(path), relativePath: path, revision: computeRevision(Buffer.from(material.text, 'utf8')), digest: material.bodyDigest, kind: material.material.kind, capturedAt: material.capturedAt }
    const record = await this.persistRecord(root, { schemaVersion: 1, projectRoot: canonicalRoot(root), owner: material.owner, materialRef: material.ref, version, source: { relativePath: path, canonicalPath, sizeBytes: material.byteLength, mtimeMs: null }, diagnostics: [], parsed: null })
    return record.version
  }

  async captureRead(root: string, read: DocumentReadSuccess): Promise<DocumentReadSuccess> {
    if (read.rawText === null || read.revision === null) return read
    try {
      const owner = materialOwnerSchema.parse(await (this.adapters.resolveOwner?.(root, read.source.relativePath) ?? readerMaterialOwner(root, read.source.relativePath)))
      const material = await this.store(root).captureDocumentRead({ projectRoot: root, owner, kind: materialKind(read.source.relativePath), read: { ...read, source: { ...read.source, workspaceId: owner.workspaceId, taskRef: owner.taskRef } } })
      const token = `rd-${hash(JSON.stringify([rootKey(root), material.ref]))}`
      const version: FixedDocumentVersion = { token, title: basename(read.source.relativePath), relativePath: read.source.relativePath, revision: read.revision, digest: material.bodyDigest, kind: material.material.kind, capturedAt: material.capturedAt }
      const { workspaceId: _namespace, taskRef: _taskNamespace, ...source } = read.source
      const record = await this.persistRecord(root, { schemaVersion: 1, projectRoot: canonicalRoot(root), owner, materialRef: material.ref, version, source, diagnostics: [], parsed: null })
      return { ...read, fixedVersion: record.version }
    } catch (error) { return { ...read, fixedVersionError: error instanceof Error ? error.message : '固定版本暂不可用' } }
  }

  async capturePath(root: string, relativePath: string): Promise<{ ok: true; version: FixedDocumentVersion } | IpcFail> {
    if (!this.isActive(root)) return ipcFail(IpcErrorCode.Conflict, '项目已切换，请回到来源项目后读取')
    const generation = this.authority().generation
    const read = await readDocument(root, { workspaceId: rootKey(root) }, { relativePath, requestId: randomUUID() })
    if (!read.ok) return read
    const captured = await this.captureRead(root, read)
    if (!this.isActive(root, generation)) return ipcFail(IpcErrorCode.Conflict, '项目已切换，未采用这次读取')
    return captured.fixedVersion ? { ok: true, version: captured.fixedVersion } : ipcFail(IpcErrorCode.Io, captured.fixedVersionError ?? captured.diagnostics[0]?.message ?? '未能读取此版本')
  }

  rootForSender(senderId: number): string | null { return [...this.views.values()].find((view) => view.senderId === senderId)?.root ?? this.authority().projectRoot }
  /** Main-only origin lookup; never substitute presentation namespaces for task identity. */
  async taskRefForVersion(root: string, token: string): Promise<string | null> { return (await this.record(root, token)).owner.taskRef }
  ownedView(senderId: number): ViewRecord | null { return [...this.views.values()].find((view) => view.senderId === senderId) ?? null }
  createView(root: string, token: string, origin: ReaderOrigin | null): ViewRecord {
    if (this.views.size >= MAX_VIEWS) throw new Error('文档窗口已达到上限，请先关闭暂时不用的窗口')
    const task = origin?.taskDir ? parseTrellisTaskPath(root, resolve(root, origin.taskDir, 'task.json')) : null
    const originTaskRef = task ? taskRefFor(readTrellisTaskId(root, task.repoRelativeDir), task.repoRelativeDir) : null
    const view: ViewRecord = { id: randomUUID(), root: canonicalRoot(root), generation: this.authority().generation, token, origin, originTaskRef, senderId: null }
    this.views.set(view.id, view); return view
  }
  attachView(viewId: string, senderId: number): void { const view = this.views.get(viewId); if (!view || view.senderId !== null) throw new Error('文档窗口归属无效'); view.senderId = senderId }
  closeView(viewId: string): void { this.views.delete(viewId) }

  async readFixed(root: string, token: string, namespace: DocumentReadScope): Promise<DocumentReadSuccess> {
    const record = await this.record(root, token)
    const material = await this.materialForRecord(root, record)
    // The shared store retains original BOM bytes; reader presentation follows
    // readDocument's one-BOM stripping contract without changing digest/revision.
    const text = material.text.charCodeAt(0) === 0xfeff ? material.text.slice(1) : material.text
    let parsed: DocumentParsed | null = null
    let diagnostics: DocumentReadSuccess['diagnostics'] = []
    if (basename(record.source.relativePath).toLowerCase() === 'task.json') {
      const result = parseTaskJsonText(text); parsed = result.parsed
      if (result.diagnostic) diagnostics = [result.diagnostic]
    } else if (record.source.relativePath.endsWith('.jsonl') && this.isActive(root)) parsed = parseContextManifest(root, text).parsed
    return { ok: true, requestId: randomUUID(), revision: record.version.revision, rawText: text, parsed, diagnostics, source: { ...record.source, workspaceId: namespace.workspaceId, taskRef: namespace.taskRef ?? null }, fixedVersion: record.version }
  }
  /** Main only: resolves a registered selection, not current disk or task ownership.
   * Publication callers must separately fence current root/generation and grants. */
  async selectedMaterial(root: string, token: string): Promise<StoredWorkflowMaterial> {
    return this.materialForRecord(root, await this.record(root, token))
  }
  private async materialForRecord(root: string, record: VersionRecord): Promise<StoredWorkflowMaterial> {
    const material = await this.store(root).readVersion(record.owner, record.materialRef)
    if (material.bodyDigest !== record.version.digest || material.material.source.kind !== 'trellis-file' || material.material.source.relativePath !== record.source.relativePath || material.material.kind !== record.version.kind || computeRevision(Buffer.from(material.text, 'utf8')) !== record.version.revision || material.byteLength !== record.source.sizeBytes) throw new Error('固定版本摘要或来源不匹配')
    return material
  }
  async bootstrap(senderId: number, pinned: boolean): Promise<DocumentWindowBootstrap | IpcFail> {
    const view = this.ownedView(senderId)
    if (!view) return ipcFail(IpcErrorCode.Denied, '此窗口没有已登记的文档来源')
    try {
      const document = await this.readFixed(view.root, view.token, { workspaceId: `reader-view:${view.id}` })
      if (!document.fixedVersion) return ipcFail(IpcErrorCode.Io, '固定版本不可用')
      return { ok: true, viewId: view.id, projectRoot: view.root, version: document.fixedVersion, document, origin: view.origin, sourceActive: this.isActive(view.root, view.generation), pinned }
    } catch (error) { return ipcFail(IpcErrorCode.Io, error instanceof Error ? error.message : '文档版本不可用') }
  }
  async catalog(root: string, anchorToken?: string, cursor?: string): Promise<DocumentVersionCatalog> {
    const directory = await this.metadataPath(root, null, false).catch(() => null)
    const names = directory === null ? [] : await fs.readdir(directory).catch(() => [])
    const versions: FixedDocumentVersion[] = []
    if (cursor !== undefined) fixedDocumentTokenSchema.parse(cursor)
    const sorted = names.filter((name) => /^rd-[0-9a-f]{64}\.json$/.test(name)).sort().filter((name) => cursor === undefined || name > `${cursor}.json`)
    const page = sorted.slice(0, MAX_VERSIONS)
    for (const name of page) {
      try { versions.push((await this.record(root, name.slice(0, -5))).version) } catch { /* Invalid stale metadata does not authorize content. */ }
    }
    const candidates: DocumentVersionCatalog['candidates'] = []
    if (anchorToken) {
      const record = await this.record(root, anchorToken)
      const task = parseTrellisTaskPath(root, record.source.canonicalPath)
      if (task) for (const [file, title] of [['prd.md', '开发需求（PRD）'], ['design.md', '技术设计（design）'], ['implement.md', '实施计划']] as const) candidates.push({ relativePath: `${task.repoRelativeDir}/${file}`, title })
    }
    return { ok: true, versions: versions.sort((a, b) => b.capturedAt - a.capturedAt), candidates, hasMore: sorted.length > page.length, nextCursor: sorted.length > page.length ? page.at(-1)?.slice(0, -5) ?? null : null }
  }
  async compare(root: string, input: { left: string; right: string; requestId: string }): Promise<FixedDocumentComparison> {
    const [left, right] = await Promise.all([this.readFixed(root, input.left, { workspaceId: rootKey(root) }), this.readFixed(root, input.right, { workspaceId: rootKey(root) })])
    if (!left.fixedVersion || !right.fixedVersion || left.rawText === null || right.rawText === null) throw new Error('对照版本不可用')
    const outcome = await compareDocuments(root, { workspaceId: rootKey(root) }, { requestId: input.requestId, relativePath: left.source.relativePath, baseline: { kind: 'text', side: { text: left.rawText, revision: left.revision } }, current: { text: right.rawText, revision: right.revision } })
    return { ok: true, left: left.fixedVersion, right: right.fixedVersion, outcome }
  }
}

let documentViews: DocumentViewService | null = null
export function configureDocumentViews(authority: () => ReaderViewAuthority, adapters?: DocumentViewAdapters): DocumentViewService { documentViews ??= new DocumentViewService(authority, adapters); if (adapters) documentViews.setAdapters(adapters); return documentViews }
export function getDocumentViews(): DocumentViewService | null { return documentViews }
