/** Clean-room immutable material snapshots. This is not a transcript store. */
import { constants } from 'fs'
import { promises as fs } from 'fs'
import { createHash, randomUUID } from 'crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { TextDecoder } from 'util'
import { canonicalWorkflowJson, materialSourceSchema, materialVersionSchema, type MaterialVersion } from '../../../shared/workflow'
import type { DocumentReadSuccess } from '../../../shared/documents'
import { readDocument, computeRevision } from '../documents/controller'
import { resolveAuthorizedDocumentPath } from '../documents/paths'
import {
  materialOwnerSchema, storedMaterialMetadataSchema, workflowMaterialRefSchema,
  WorkflowRuntimeError, type MaterialOwner, type StoredMaterialMetadata, type StoredWorkflowMaterial
} from './types'

const DEFAULT_SOURCE_BYTES = 5 * 1024 * 1024
const DEFAULT_STORE_BYTES = 128 * 1024 * 1024
const DEFAULT_REFERENCE_LIMIT = 5_000
const digestOf = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')
const ownerIdentity = (owner: MaterialOwner): string => canonicalWorkflowJson(owner)
const isInside = (root: string, path: string): boolean => path === root || path.startsWith(root + sep)

export type CaptureFileInput = {
  projectRoot: string; owner: MaterialOwner; relativePath: string;
  kind: MaterialVersion['kind']; expectedRevision?: string
}
export type CaptureTextInput = {
  owner: MaterialOwner; source: MaterialVersion['source']; kind: MaterialVersion['kind'];
  text: string; version?: string
}
export type CaptureDocumentInput = {
  projectRoot: string; owner: MaterialOwner; read: DocumentReadSuccess; kind: MaterialVersion['kind']
}

function safeRelativePath(path: string): string {
  if (typeof path !== 'string' || isAbsolute(path) || /^[a-zA-Z]:/.test(path) || path.includes('\0')) throw new WorkflowRuntimeError('INVALID_INPUT', 'A workspace-relative material source is required')
  const normalized = path.replace(/\\/g, '/')
  if (normalized.split('/').some((part) => !part || part === '.' || part === '..')) throw new WorkflowRuntimeError('INVALID_INPUT', 'Material source contains an invalid path component')
  return normalized
}

/** One main-owned instance per repository; immutable writes are safe across readers. */
export class WorkflowMaterialStore {
  private readonly directory: string
  private readonly maxSourceBytes: number
  private readonly maxStoreBytes: number
  private readonly maxReferences: number
  private writes: Promise<void> = Promise.resolve()

  constructor(options: { directory: string; maxSourceBytes?: number; maxStoreBytes?: number; maxReferences?: number }) {
    if (!isAbsolute(options.directory)) throw new WorkflowRuntimeError('INVALID_INPUT', 'Material cache must have a main-owned absolute directory')
    this.directory = resolve(options.directory)
    this.maxSourceBytes = options.maxSourceBytes ?? DEFAULT_SOURCE_BYTES
    this.maxStoreBytes = options.maxStoreBytes ?? DEFAULT_STORE_BYTES
    this.maxReferences = options.maxReferences ?? DEFAULT_REFERENCE_LIMIT
    if (![this.maxSourceBytes, this.maxStoreBytes, this.maxReferences].every((n) => Number.isSafeInteger(n) && n > 0)) throw new WorkflowRuntimeError('INVALID_INPUT', 'Material storage limits must be positive safe integers')
  }

  async captureFile(input: CaptureFileInput): Promise<StoredWorkflowMaterial> {
    const owner = materialOwnerSchema.parse(input.owner)
    const relativePath = safeRelativePath(input.relativePath)
    const read = await readDocument(input.projectRoot, { workspaceId: owner.workspaceId, ...(owner.taskRef === null ? {} : { taskRef: owner.taskRef }) }, { relativePath, requestId: `workflow-capture-${randomUUID()}` })
    if (!read.ok || read.rawText === null || read.revision === null) throw new WorkflowRuntimeError('MATERIAL_UNAVAILABLE', 'The selected source has no stable readable material version')
    if (input.expectedRevision !== undefined && input.expectedRevision !== read.revision) throw new WorkflowRuntimeError('MATERIAL_CHANGED', 'The source changed since the selected version was read')
    return this.captureDocumentRead({ projectRoot: input.projectRoot, owner, read, kind: input.kind })
  }

  /** Main-only: use the actual successful reader result, never a renderer body. */
  async captureDocumentRead(input: CaptureDocumentInput): Promise<StoredWorkflowMaterial> {
    const owner = materialOwnerSchema.parse(input.owner)
    const result = input.read
    if (!result.ok || result.rawText === null || result.revision === null || result.source.workspaceId !== owner.workspaceId || result.source.taskRef !== owner.taskRef) throw new WorkflowRuntimeError('SCOPE_CHANGED', 'Reader result and trusted material owner do not match')
    const relativePath = safeRelativePath(result.source.relativePath)
    // This checks the captured source namespace, not current disk bytes. File A may
    // already have changed to B: registering displayed A must never capture B.
    const sourcePath = resolve(input.projectRoot, relativePath)
    if (!isInside(resolve(input.projectRoot), sourcePath) || resolve(result.source.canonicalPath) !== sourcePath) {
      const current = resolveAuthorizedDocumentPath(input.projectRoot, relativePath)
      if (!current.ok || resolve(current.canonicalPath) !== resolve(result.source.canonicalPath)) throw new WorkflowRuntimeError('SCOPE_CHANGED', 'Reader source is outside the trusted workspace')
    }
    const body = Buffer.from(result.rawText, 'utf8')
    const candidates = [body, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body])]
    const bytes = candidates.find((candidate) => candidate.length === result.source.sizeBytes && computeRevision(candidate) === result.revision)
    if (!bytes) throw new WorkflowRuntimeError('MATERIAL_CHANGED', 'Reader text cannot reproduce the captured original-byte revision')
    return this.captureBytes(owner, { kind: 'trellis-file', relativePath }, input.kind, bytes)
  }

  /** Trusted source adapter, e.g. an already authorized immutable KnowledgeArtifact. */
  async captureText(input: CaptureTextInput): Promise<StoredWorkflowMaterial> {
    if (typeof input.text !== 'string') throw new WorkflowRuntimeError('INVALID_INPUT', 'Exact source text is required')
    const bytes = Buffer.from(input.text, 'utf8')
    if (bytes.toString('utf8') !== input.text) throw new WorkflowRuntimeError('INVALID_INPUT', 'Source text contains an unpaired Unicode surrogate')
    return this.captureBytes(materialOwnerSchema.parse(input.owner), materialSourceSchema.parse(input.source), input.kind, bytes, input.version)
  }

  async readVersion(rawOwner: MaterialOwner, rawRef: string): Promise<StoredWorkflowMaterial> {
    const owner = materialOwnerSchema.parse(rawOwner)
    const ref = workflowMaterialRefSchema.parse(rawRef)
    const metadataPath = this.ownedPath('refs', `${ref}.json`)
    const metadataBytes = await this.readBounded(metadataPath, 64 * 1024)
    let value: unknown
    try { value = JSON.parse(metadataBytes.toString('utf8')) }
    catch { throw new WorkflowRuntimeError('STORE_CORRUPTED', 'Pinned material metadata is not valid JSON; original bytes were preserved') }
    const parsed = storedMaterialMetadataSchema.safeParse(value)
    if (!parsed.success) throw new WorkflowRuntimeError('STORE_CORRUPTED', 'Pinned material metadata has an unsupported or damaged schema')
    const record = parsed.data
    if (ownerIdentity(record.owner) !== ownerIdentity(owner)) throw new WorkflowRuntimeError('SCOPE_CHANGED', 'Pinned material belongs to a different project, workspace or task')
    if (record.ref !== ref || this.referenceFor(record.owner, record.material) !== ref || record.material.sourceDigest !== record.bodyDigest) throw new WorkflowRuntimeError('STORE_CORRUPTED', 'Pinned material identity and digest disagree')
    const bytes = await this.readBounded(this.ownedPath('blobs', `${record.bodyDigest}.blob`), this.maxSourceBytes)
    if (bytes.length !== record.byteLength || digestOf(bytes) !== record.bodyDigest) throw new WorkflowRuntimeError('STORE_CORRUPTED', 'Pinned material bytes do not match the stored full digest')
    return { ...record, text: this.decode(bytes) }
  }

  private captureBytes(owner: MaterialOwner, source: MaterialVersion['source'], kind: MaterialVersion['kind'], bytes: Buffer, version?: string): Promise<StoredWorkflowMaterial> {
    if (bytes.length > this.maxSourceBytes) return Promise.reject(new WorkflowRuntimeError('CAPACITY_EXCEEDED', 'Material exceeds the configured source-byte limit'))
    const text = this.decode(bytes)
    const fullDigest = digestOf(bytes)
    const material = materialVersionSchema.parse({
      materialId: `material-${digestOf(canonicalWorkflowJson({ owner, source, kind })).slice(0, 40)}`,
      version: version ?? fullDigest, kind, source, sourceDigest: fullDigest
    })
    const ref = this.referenceFor(owner, material)
    const record: StoredMaterialMetadata = { schemaVersion: 1, ref, owner, material, byteLength: bytes.length, bodyDigest: fullDigest, capturedAt: Date.now() }
    const operation = this.writes.then(async () => {
      await this.ensureDirectory()
      try {
        const existing = await this.readVersion(owner, ref)
        if (existing.bodyDigest !== fullDigest) throw new WorkflowRuntimeError('MATERIAL_CHANGED', 'The same immutable material source/version has different content; original snapshot was retained')
        return existing
      }
      catch (error) { if (!(error instanceof WorkflowRuntimeError) || error.code !== 'MATERIAL_UNAVAILABLE') throw error }
      const blobExists = await fs.stat(this.ownedPath('blobs', `${fullDigest}.blob`)).then(() => true, () => false)
      await this.assertCapacity(blobExists ? 0 : bytes.length)
      await this.writeImmutable(this.ownedPath('blobs', `${fullDigest}.blob`), bytes)
      await this.writeImmutable(this.ownedPath('refs', `${ref}.json`), Buffer.from(JSON.stringify(record), 'utf8'))
      const saved = await this.readVersion(owner, ref)
      if (saved.text !== text || saved.bodyDigest !== fullDigest) throw new WorkflowRuntimeError('MATERIAL_CHANGED', 'An immutable material version already records different source bytes')
      return saved
    })
    this.writes = operation.then(() => {}, () => {})
    return operation
  }

  private referenceFor(owner: MaterialOwner, material: MaterialVersion): string {
    const { sourceDigest: _digest, ...identity } = material
    return `wm-${digestOf(canonicalWorkflowJson({ owner, material: identity }))}`
  }
  private ownedPath(kind: 'refs' | 'blobs', file: string): string {
    const path = resolve(this.directory, kind, file)
    if (!isInside(this.directory, path)) throw new WorkflowRuntimeError('INVALID_INPUT', 'Invalid material cache identity')
    return path
  }
  private async ensureDirectory(): Promise<void> {
    await fs.mkdir(join(this.directory, 'refs'), { recursive: true })
    await fs.mkdir(join(this.directory, 'blobs'), { recursive: true })
    const canonical = await fs.realpath(this.directory)
    for (const kind of ['refs', 'blobs']) if (!isInside(canonical, await fs.realpath(join(this.directory, kind)))) throw new WorkflowRuntimeError('STORE_UNAVAILABLE', 'Material cache directory escaped its main-owned root')
  }
  private async assertCapacity(additionalBytes: number): Promise<void> {
    if (additionalBytes > this.maxStoreBytes) throw new WorkflowRuntimeError('CAPACITY_EXCEEDED', 'Material exceeds the configured total store budget')
    const refs = await fs.readdir(join(this.directory, 'refs'))
    const blobs = await fs.readdir(join(this.directory, 'blobs'))
    if (refs.length >= this.maxReferences || blobs.length > this.maxReferences) throw new WorkflowRuntimeError('CAPACITY_EXCEEDED', 'Pinned material reference capacity reached; no version was discarded')
    let total = 0
    for (const file of blobs) {
      if (!/^[0-9a-f]{64}\.blob$/.test(file)) continue
      total += (await fs.stat(join(this.directory, 'blobs', file))).size
      if (total + additionalBytes > this.maxStoreBytes) throw new WorkflowRuntimeError('CAPACITY_EXCEEDED', 'Pinned material byte capacity reached; no version was discarded')
    }
  }
  private async writeImmutable(target: string, bytes: Buffer): Promise<void> {
    const temporary = join(dirname(target), `.material-${randomUUID()}.tmp`)
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined
    try {
      handle = await fs.open(temporary, 'wx', 0o600)
      await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = undefined
      try { await fs.link(temporary, target) }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error }
    } finally {
      await handle?.close()
      // Exact own temporary path; no recursive cleanup or source-file mutation.
      await fs.unlink(temporary).catch((error: unknown) => { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error })
    }
  }
  private async readBounded(path: string, limit: number): Promise<Buffer> {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined
    try {
      const canonicalRoot = await fs.realpath(this.directory)
      const canonical = await fs.realpath(path)
      if (!isInside(canonicalRoot, canonical)) throw new WorkflowRuntimeError('STORE_CORRUPTED', 'Pinned material path escaped the cache root')
      handle = await fs.open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const info = await handle.stat()
      if (!info.isFile() || info.size > limit) throw new WorkflowRuntimeError('STORE_CORRUPTED', 'Pinned material exceeds its declared storage bound')
      const bytes = Buffer.alloc(Math.min(info.size + 1, limit + 1))
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
      const after = await handle.stat()
      if (bytesRead !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new WorkflowRuntimeError('STORE_CORRUPTED', 'Pinned material changed while being read')
      return bytes.subarray(0, bytesRead)
    } catch (error) {
      if (error instanceof WorkflowRuntimeError) throw error
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new WorkflowRuntimeError('MATERIAL_UNAVAILABLE', 'Pinned material version is unavailable')
      throw new WorkflowRuntimeError('STORE_UNAVAILABLE', 'Pinned material store could not read the requested version')
    } finally { await handle?.close() }
  }
  private decode(bytes: Buffer): string {
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
    catch { throw new WorkflowRuntimeError('MATERIAL_UNAVAILABLE', 'Material is not exact UTF-8 text; no replacement text was archived') }
  }
}
