import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readSync, realpathSync, writeFileSync, type Stats
} from 'node:fs'
import { isAbsolute, join, parse, relative, sep } from 'node:path'
import { Type } from '@earendil-works/pi-ai'
import { defineTool, type ExtensionFactory } from '@earendil-works/pi-coding-agent'
import {
  DESIGN_GENERATION_DIRECTORY, DESIGN_GENERATION_INPUT_DIRECTORY, DESIGN_GENERATION_DIMENSION_MIN, DESIGN_GENERATION_DIMENSION_MAX,
  DESIGN_GENERATION_MANIFEST_MAX_BYTES, DESIGN_GENERATION_MAX_PAGES, DESIGN_GENERATION_PAGE_ID_MAX_LENGTH,
  DESIGN_GENERATION_PAGE_MAX_BYTES, DESIGN_GENERATION_TOTAL_MAX_BYTES, DESIGN_GENERATION_VERSION,
  DESIGN_PLACEHOLDER_DOCUMENT_ID, DESIGN_PLACEHOLDER_BASE_REVISION,
  designGenerationInputSchema, designGenerationSourcePathSchema, designGenerationManifestSchema, designGenerationOutputSchema,
  type DesignGenerationManifestPage
} from '../../../../shared/design-generation'
import { assertDesignHtmlSelfContained } from '../../../../shared/design-html-policy'

type Directory = { path: string; stat: Stats }

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

/** Walk from the volume root before resolving anything; junctions must not redirect a revision. */
function inspectDirectory(path: string): Directory {
  if (!isAbsolute(path) || /^[/\\]{2}/.test(path)) throw new Error('design_open requires a local absolute session root')
  let current = parse(path).root
  for (const part of relative(current, path).split(sep).filter(Boolean)) {
    current = join(current, part)
    const info = lstatSync(current)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('design_open refuses linked or non-directory paths')
  }
  if (relative(path, realpathSync(path)) !== '') throw new Error('design_open directory identity changed')
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('design_open session root is not an ordinary directory')
  return { path, stat }
}

function assertDirectory(directory: Directory): void {
  const current = inspectDirectory(directory.path)
  if (!sameIdentity(directory.stat, current.stat)) throw new Error('design_open directory was replaced')
}

function createDirectory(parent: Directory, name: string, exclusive: boolean): Directory {
  assertDirectory(parent)
  const path = join(parent.path, name)
  try { mkdirSync(path, { mode: 0o700 }) } catch (error) {
    if (exclusive || !(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
  }
  const directory = inspectDirectory(path)
  assertDirectory(parent)
  return directory
}

function unchangedFile(before: Stats, after: Stats): boolean {
  return after.isFile() && after.nlink === 1 && sameIdentity(before, after) && before.size === after.size &&
    before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs
}

/** Bounded, identity-checked disk read. Hashes are derived from these bytes, never just from tool arguments. */
function readWrittenFile(directories: Directory[], file: string, maxBytes: number, expected?: Buffer): Buffer {
  for (const directory of directories) assertDirectory(directory)
  const initial = lstatSync(file)
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1 || initial.size < 1 || initial.size > maxBytes) {
    throw new Error('design_open output is not a bounded regular file')
  }
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = fstatSync(fd)
    if (!unchangedFile(initial, before)) throw new Error('design_open output changed before reading')
    const buffer = Buffer.alloc(before.size + 1)
    let length = 0
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, length)
      if (!count) break
      length += count
    }
    const after = fstatSync(fd)
    const current = lstatSync(file)
    for (const directory of directories) assertDirectory(directory)
    if (current.isSymbolicLink() || length !== before.size || !unchangedFile(before, after) || !unchangedFile(after, current)) {
      throw new Error('design_open output changed while reading')
    }
    const bytes = buffer.subarray(0, length)
    if (expected && !bytes.equals(expected)) throw new Error('design_open saved bytes differ from the requested content')
    return bytes
  } finally { closeSync(fd) }
}

function writeExclusiveFile(directories: Directory[], file: string, bytes: Buffer, maxBytes: number, signal?: AbortSignal): Buffer {
  signal?.throwIfAborted()
  for (const directory of directories) assertDirectory(directory)
  // Exclusive create refuses an old revision, a symlink or a hardlink even on platforms without O_NOFOLLOW.
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
  try {
    const before = fstatSync(fd)
    const current = lstatSync(file)
    if (!before.isFile() || before.nlink !== 1 || current.isSymbolicLink() || !sameIdentity(before, current)) {
      throw new Error('design_open output identity changed before writing')
    }
    for (const directory of directories) assertDirectory(directory)
    writeFileSync(fd, bytes)
    fsyncSync(fd)
  } finally { closeSync(fd) }
  signal?.throwIfAborted()
  return readWrittenFile(directories, file, maxBytes, bytes)
}

function htmlBytes(html: string): Buffer {
  const bytes = Buffer.from(html, 'utf8')
  if (bytes.length > DESIGN_GENERATION_PAGE_MAX_BYTES) throw new Error('design_open page exceeds 128 KiB of UTF-8 HTML')
  if (/^\s*```/.test(html) || html.includes('\0') || !/<html(?:\s|>)/i.test(html) || !/<head(?:\s|>)/i.test(html) ||
    !/<body(?:\s|>)/i.test(html) || !/<\/head\s*>/i.test(html) || !/<\/body\s*>/i.test(html) || !/<\/html\s*>\s*$/i.test(html)) {
    throw new Error('design_open requires complete standalone HTML with head and body, without Markdown fences')
  }
  assertDesignHtmlSelfContained(html)
  return bytes
}

/** The existing global tool_call permission extension authorizes this mutation before execute(). */
export function designGenerationExtension(root: string): ExtensionFactory {
  const owner = inspectDirectory(root)
  return pi => pi.registerTool(defineTool({
    name: 'design_open', label: 'Design canvas',
    description: 'Save complete self-contained HTML pages to a new immutable design revision beside this conversation. Writes at most 8 pages, 128 KiB UTF-8 each and 512 KiB combined. Inline CSS, scripts and assets; no external resources. No iframe, object or embed elements, including data sources and srcdoc; compose their content directly into the page. Assign stable safe page IDs for linked pages. For updates reuse the application-provided documentId, baseRevision and page IDs; send changed pages only. Cross-page controls use data-design-page="page-id-or-unique-title" or relative <page-id>.html links. Returns details.designOutput only after real saved files and a manifest are read and checked. Does not verify browser rendering or adopt an edit candidate.',
    parameters: Type.Object({
      title: Type.String({ minLength: 1, maxLength: 200 }),
      operation: Type.Optional(Type.Union([Type.Literal('create'), Type.Literal('edit')], { description: 'Use create for a new design and edit only with the exact application-provided identities.' })),
      pages: Type.Array(Type.Object({
        id: Type.Optional(Type.String({ minLength: 1, maxLength: DESIGN_GENERATION_PAGE_ID_MAX_LENGTH, pattern: '^[A-Za-z0-9][A-Za-z0-9_-]*$', description: 'Stable safe page ID; preserve existing IDs on updates. Omit to create a UUID.' })),
        title: Type.String({ minLength: 1, maxLength: 200 }),
        html: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: DESIGN_GENERATION_PAGE_MAX_BYTES }), Type.Null()], { description: 'Complete standalone HTML, or null when using sourcePath.' })),
        sourcePath: Type.Optional(Type.Union([Type.String({ maxLength: 256 }), Type.Null()], { description: 'Preferred: .tpanel-design-input/<page-id>.html previously saved with file tools. Use null for inline HTML.' })),
        width: Type.Integer({ minimum: DESIGN_GENERATION_DIMENSION_MIN, maximum: DESIGN_GENERATION_DIMENSION_MAX }),
        height: Type.Integer({ minimum: DESIGN_GENERATION_DIMENSION_MIN, maximum: DESIGN_GENERATION_DIMENSION_MAX })
      }, { additionalProperties: false }), { minItems: 1, maxItems: DESIGN_GENERATION_MAX_PAGES }),
      documentId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()], { description: 'Null for create; exact application-provided document ID for edit.' })),
      baseRevision: Type.Optional(Type.Union([Type.String({ pattern: '^[a-f0-9]{64}$' }), Type.Null()], { description: 'Null for create; exact application-provided current revision for edit.' }))
    }, { additionalProperties: false }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async execute(toolCallId, params, signal) {
      signal?.throwIfAborted()
      const creating = params.operation === 'create'
      if (creating && params.documentId && params.documentId !== DESIGN_PLACEHOLDER_DOCUMENT_ID) throw new Error('Creating a design cannot reuse an existing document identity')
      const placeholderDocument = params.documentId === DESIGN_PLACEHOLDER_DOCUMENT_ID
      const placeholderRevision = params.baseRevision === DESIGN_PLACEHOLDER_BASE_REVISION
      if (params.operation === 'edit' && (!params.documentId || !params.baseRevision || placeholderDocument || placeholderRevision)) throw new Error('Editing requires the exact application-provided document identity and revision')
      if (!creating && placeholderDocument !== placeholderRevision) {
        throw new Error('design_open received an incomplete placeholder identity. Omit both identity fields for a new design, or provide the exact application-supplied identity for an edit.')
      }
      const placeholderIdentity = placeholderDocument && placeholderRevision
      const resolvedPages = params.pages.map(page => {
        const hasHtml = typeof page.html === 'string' && Boolean(page.html.trim())
        const hasPath = typeof page.sourcePath === 'string' && Boolean(page.sourcePath.trim())
        if (hasHtml === hasPath) throw new Error('Supply exactly one of html or sourcePath per design page')
        const { sourcePath, ...inline } = page
        if (!hasPath) return inline
        const path = designGenerationSourcePathSchema.parse(sourcePath)
        assertDirectory(owner)
        const prepared = inspectDirectory(join(root, DESIGN_GENERATION_INPUT_DIRECTORY))
        const bytes = readWrittenFile([owner, prepared], join(root, path), DESIGN_GENERATION_PAGE_MAX_BYTES)
        return { ...inline, html: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
      })
      const { operation: _operation, ...identity } = params
      const input = designGenerationInputSchema.parse({ ...identity, pages: resolvedPages,
        documentId: creating || placeholderIdentity ? undefined : params.documentId ?? undefined,
        baseRevision: creating || placeholderIdentity ? undefined : params.baseRevision ?? undefined })
      const pages = input.pages.map(page => ({ ...page, id: page.id ?? randomUUID(), bytes: htmlBytes(page.html) }))
      if (pages.reduce((total, page) => total + page.bytes.length, 0) > DESIGN_GENERATION_TOTAL_MAX_BYTES) {
        throw new Error('design_open combined HTML exceeds 512 KiB')
      }
      if (new Set(pages.map(page => page.id.toLowerCase())).size !== pages.length) throw new Error('design_open page IDs must be unique, including letter case')
      if (!toolCallId || toolCallId.length > 512) throw new Error('design_open tool call identity is invalid')
      assertDirectory(owner)
      const documentId = input.documentId ?? randomUUID()
      const revisionId = randomUUID()
      const store = createDirectory(owner, DESIGN_GENERATION_DIRECTORY, false)
      // Never reuse or remove an existing revision, including partial output from a failed call.
      const revision = createDirectory(store, revisionId, true)
      const directories = [owner, store, revision]
      const written: DesignGenerationManifestPage[] = []
      for (const page of pages) {
        const path = `${DESIGN_GENERATION_DIRECTORY}/${revisionId}/${page.id}.html`
        const actual = writeExclusiveFile(directories, join(revision.path, `${page.id}.html`), page.bytes, DESIGN_GENERATION_PAGE_MAX_BYTES, signal)
        written.push({ id: page.id, title: page.title, path, width: page.width, height: page.height,
          revision: createHash('sha256').update(actual).digest('hex') })
      }
      const manifest = designGenerationManifestSchema.parse({
        version: DESIGN_GENERATION_VERSION, documentId, revisionId, title: input.title, toolCallId,
        ...(input.baseRevision ? { baseRevision: input.baseRevision } : {}), pages: written
      })
      const manifestPath = `${DESIGN_GENERATION_DIRECTORY}/${revisionId}/manifest.json`
      const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      if (manifestBytes.length > DESIGN_GENERATION_MANIFEST_MAX_BYTES) throw new Error('design_open manifest exceeds its size limit')
      // A complete manifest is written last; partial files never establish a successful tool result.
      const saved = writeExclusiveFile(directories, join(revision.path, 'manifest.json'), manifestBytes, DESIGN_GENERATION_MANIFEST_MAX_BYTES, signal)
      designGenerationManifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(saved)))
      // Recheck all pages after the manifest so changes during publication cannot yield a ready receipt.
      for (const page of pages) readWrittenFile(directories, join(revision.path, `${page.id}.html`), DESIGN_GENERATION_PAGE_MAX_BYTES, page.bytes)
      signal?.throwIfAborted()
      const output = designGenerationOutputSchema.parse({ version: DESIGN_GENERATION_VERSION, documentId, revisionId, manifestPath, title: input.title })
      return {
        content: [{ type: 'text', text: `Saved ${written.length} design page(s) to ${manifestPath}. ${input.baseRevision ? 'This is an edit candidate; the current design is unchanged until adoption.' : 'The application can register this new design.'} Saved bytes and basic HTML format were checked. Browser rendering and interactions have not been verified.` }],
        details: { designOutput: output, ...(placeholderIdentity ? { placeholderIdentity: true } : {}) }
      }
    }
  }))
}
