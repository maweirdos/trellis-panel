import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, opendirSync } from 'node:fs'
import { basename } from 'node:path'
import { z } from 'zod'
import { setImmediate as yieldIO } from 'node:timers/promises'
import { teamOpaqueIdSchema, teamRelativePathSchema } from '../../../../shared/team-platform'
import {
  IMPORT_LIMITS, assertImportShareableText, canonicalImportJson, importCaptureSchema, importManifestSchema, importOwnerEvidenceSchema, importPreviewSchema, importSelectionSchema, importTaskSummary,
  type ImportAsset, type ImportCapture, type ImportManifest, type ImportPreview, type ImportSelection, type ImportTaskSource
} from '../../../../shared/team-import'
import { taskRefFor } from '../../task-identity'
import { assertComponents, assertRoot, captureRoot, checkedPath, readSource } from '../lib/files'
import { TrellisImportError, type ImportDiscoveryOptions, type NativeImportIdentity } from '../types'

const hash = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex')
const privateRoot = /^(?:\.trellis\/(?:workspace|\.runtime|\.panel)|\.(?:codex|claude)\/(?:sessions|archived_sessions|projects|transcripts|history(?:\.jsonl)?|logs?|auth\.json|credentials(?:\.json)?))(?:\/|$)/i
function privatePath(path: string): boolean {
  return privateRoot.test(path) || path.split('/').some(part => ['node_modules', '__pycache__'].includes(part))
}
const taskDocs = /^(?:prd|design|implement|check|research|plan|delivery-note|implementation-report|check-report)\.md$|^[\w.-]+\.jsonl$/i
const kinds = (kind: ImportAsset['kind'], purpose: ImportAsset['purpose'], scope: ImportAsset['scope'] = 'asset', sharing: ImportAsset['sharing'] = 'review-required'): Pick<ImportAsset, 'kind' | 'purpose' | 'scope' | 'sharing'> => ({ kind, purpose, scope, sharing })
function utf8(bytes: Buffer): string {
  const text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes) || text.includes('\u0000')) throw new TrellisImportError('IMPORT_TEXT_UNAVAILABLE', 'Only original UTF-8 text is eligible for sharing')
  return text
}
function optionalText(raw: unknown, max: number): string | null { return typeof raw === 'string' && raw.trim().length > 0 && raw.length <= max ? raw : null }

/** Main-only facade: opens no database, runs no command and writes no source files. */
export class TrellisImportDiscovery {
  private current: ImportPreview | null = null
  private constructor(private readonly identity: NativeImportIdentity, private readonly options: ImportDiscoveryOptions) {}
  static async open(root: string, options: ImportDiscoveryOptions = {}): Promise<TrellisImportDiscovery> {
    const identity = captureRoot(root), trellis = checkedPath(identity, '.trellis')
    if (!lstatSync(trellis.path).isDirectory()) throw new TrellisImportError('IMPORT_NOT_TRELLIS', 'Selected root has no real Trellis directory')
    return new TrellisImportDiscovery(identity, options)
  }

  async preview(): Promise<ImportPreview> {
    assertRoot(this.identity)
    const result: ImportPreview = { contractVersion: 1, previewId: randomUUID(), createdAt: Date.now(), assets: [], tasks: [], context: [], owners: [], blockers: [], truncated: false, scanned: { entries: 0, files: 0, bytes: 0 }, limits: { ...IMPORT_LIMITS }, executionAuthority: 'local-unmodified', activationReady: false }
    const bodies = new Map<string, Buffer>()
    const blocker = (code: string, path: string | null, detail: string, scope: 'asset' | 'task' | 'root' | 'workcopy' = 'asset'): void => {
      if (result.blockers.length < IMPORT_LIMITS.entries) result.blockers.push({ code, relativePath: path && teamRelativePathSchema.safeParse(path).success ? path : null, scope, detail })
      else result.truncated = true
    }
    const limit = (path: string, detail: string): void => { result.truncated = true; blocker('INVENTORY_LIMIT', path, detail, 'root') }
    const add = async (path: string, classification: ReturnType<typeof kinds>, taskKey: string | null = null): Promise<void> => {
      if (result.assets.length >= IMPORT_LIMITS.files) { limit(path, 'File count limit reached; remaining assets were not inventoried'); return }
      await yieldIO()
      try {
        const stat = checkedPath(this.identity, path).components.at(-1)?.stat
        if (stat && result.scanned.bytes + stat.size > IMPORT_LIMITS.totalBytes) { limit(path, 'Total byte limit reached; source was not read'); return }
        const bytes = readSource(this.identity, path)
        if (result.scanned.bytes + bytes.length > IMPORT_LIMITS.totalBytes) { limit(path, 'Total byte limit reached; source was not included'); return }
        result.scanned.files++; result.scanned.bytes += bytes.length
        const local = taskKey ? result.tasks.find(t => t.sourceTaskKey === taskKey && path.startsWith(t.location + '/')) : null
        const asset: ImportAsset = { itemKey: local ? hash(canonicalImportJson([taskKey, path.slice(local.location.length + 1)])) : hash(path), relativePath: path, ...classification, sourceTaskKey: taskKey, sourceDigest: hash(bytes), byteLength: bytes.length, representation: classification.kind === 'task' ? 'task-summary' : 'source', unknownFieldCount: 0, templateDigest: null }
        result.assets.push(asset); bodies.set(path, bytes)
        if (['hook', 'script', 'root-instruction', 'agent', 'skill', 'command', 'workflow', 'configuration'].includes(classification.kind)) blocker('BEHAVIOR_CONVERSION_REQUIRED', path, 'Retained source is not an executable platform conversion or current instruction grant', classification.scope)
      } catch (error) {
        const absent = error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
        if (!absent) { if (error instanceof TrellisImportError && error.code === 'IMPORT_FILE_LIMIT') result.truncated = true; blocker(error instanceof TrellisImportError ? error.code : 'SOURCE_UNREADABLE', path, 'Source unavailable, linked, changed, or beyond a visible limit') }
      }
    }
    const list = async (path: string, visit: (name: string, directory: boolean) => void | Promise<void>, mode: 'assets' | 'retained-sessions' = 'assets'): Promise<void> => {
      if (result.scanned.entries >= IMPORT_LIMITS.entries) { limit(path, 'Directory-entry limit reached'); return }
      try {
        const checked = checkedPath(this.identity, path), dir = opendirSync(checked.path)
        try {
          for (;;) {
            if (result.scanned.entries >= IMPORT_LIMITS.entries) { limit(path, 'Directory-entry limit reached; remaining entries were not scanned'); break }
            const entry = dir.readSync(); if (!entry) break
            result.scanned.entries++
            if (result.scanned.entries % 16 === 0) await yieldIO()
            if (entry.isSymbolicLink()) { blocker('LINK_EXCLUDED', `${path}/${entry.name}`, 'Linked entries are not followed'); continue }
            const retainedSession = mode === 'retained-sessions' && path === '.trellis/.runtime/sessions'
            if (entry.name.startsWith('.') || (!retainedSession && privatePath(`${path}/${entry.name}`))) continue
            await visit(entry.name, entry.isDirectory())
          }
        } finally { dir.closeSync() }
        assertComponents(this.identity, checked.components)
      } catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) blocker('DIRECTORY_UNAVAILABLE', path, 'Directory could not be read without following links') }
    }
    const walk = async (path: string, classification: ReturnType<typeof kinds>, extension: RegExp, depth = 0, taskKey: string | null = null): Promise<void> => {
      if (depth >= IMPORT_LIMITS.depth) { limit(path, 'Directory depth limit reached'); return }
      await list(path, async (name, directory) => { const next = `${path}/${name}`; if (directory) await walk(next, classification, extension, depth + 1, taskKey); else if (extension.test(name)) await add(next, classification, taskKey) })
    }
    const task = async (location: string, archived: boolean): Promise<void> => {
      if (result.tasks.length >= IMPORT_LIMITS.tasks) { limit(location, 'Task count limit reached'); return }
      const path = `${location}/task.json`
      await add(path, kinds('task', 'task-metadata', 'task'))
      const bytes = bodies.get(path), asset = result.assets.find(a => a.relativePath === path)
      if (!bytes || !asset) return
      let raw: Record<string, unknown>
      try { raw = z.record(z.string(), z.unknown()).parse(JSON.parse(utf8(bytes).replace(/^\uFEFF/, ''))) }
      catch { blocker('TASK_METADATA_INVALID', path, 'Task metadata cannot identify a source task', 'task'); return }
      const originalId = teamOpaqueIdSchema.max(256).safeParse(raw.id), sourceTaskKey = taskRefFor(originalId.success ? originalId.data : null, location)
      // Directory fallback keys are hashed because wire identities may not carry paths.
      const key = originalId.success ? sourceTaskKey : `directory:${hash(location)}`
      const authors = [...new Set([raw.creator, raw.assignee, raw.developer].flatMap(value => typeof value === 'string' && teamOpaqueIdSchema.safeParse(value).success ? [value] : []))]
      const source: ImportTaskSource = { sourceTaskKey: key, originalId: originalId.success ? originalId.data : null, location, title: optionalText(raw.title, 300) ?? optionalText(raw.name, 300) ?? basename(location), localStatus: optionalText(raw.status, 100), archived, authors }
      asset.sourceTaskKey = key
      asset.itemKey = hash(canonicalImportJson([key, 'task.json']))
      asset.unknownFieldCount = Object.keys(raw).filter(field => !['id', 'name', 'title', 'status', 'creator', 'assignee', 'developer'].includes(field)).length
      result.tasks.push(source)
      await list(location, async (name, directory) => {
        if (directory) { if (['research', 'materials'].includes(name)) await walk(`${location}/${name}`, kinds('material', 'other', 'task'), /\.md$/i, 0, key); return }
        if (!taskDocs.test(name)) return
        const purpose = name === 'prd.md' ? 'unresolved' : name === 'design.md' ? 'design' : name === 'implement.md' ? 'implementation' : name.endsWith('.jsonl') ? 'context' : 'other'
        await add(`${location}/${name}`, kinds(name.endsWith('.jsonl') ? 'context' : 'material', purpose, 'task'), key)
        if (name === 'prd.md') blocker('DOCUMENT_PURPOSE_REQUIRED', `${location}/${name}`, 'Choose product requirements or developer PRD explicitly; filenames do not establish purpose', 'task')
      })
    }
    await list('.trellis/tasks', async (name, directory) => {
      if (!directory) return
      if (name === 'archive') await list('.trellis/tasks/archive', async (month, monthDir) => { if (monthDir && /^\d{4}-\d{2}$/.test(month)) await list(`.trellis/tasks/archive/${month}`, async (name, directory) => { if (directory) await task(`.trellis/tasks/archive/${month}/${name}`, true) }) })
      else await task(`.trellis/tasks/${name}`, false)
    })
    await walk('.trellis/spec', kinds('spec', 'spec', 'root'), /\.md$/i)
    await walk('.trellis/flows', kinds('workflow', 'workflow', 'root'), /\.json$/i)
    await walk('.trellis/agents', kinds('agent', 'agent', 'root'), /\.(?:md|json|yaml|yml|toml)$/i)
    await walk('.trellis/scripts', kinds('script', 'hook', 'root'), /\.(?:py|mjs|js|ts|sh|ps1)$/i)
    for (const path of ['.trellis/workflow.md', '.trellis/workflow.yaml']) await add(path, kinds('workflow', 'workflow', 'root'))
    for (const path of ['.trellis/config.yaml', '.trellis/config.yml', '.trellis/.version', '.trellis/.template-hashes.json', '.codex/config.toml']) await add(path, kinds('configuration', 'other', 'root', 'metadata-only'))
    for (const path of ['AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md']) await add(path, kinds('root-instruction', 'root-instruction', 'root'))
    for (const path of ['.codex/hooks.json', '.claude/settings.json']) await add(path, kinds('hook', 'hook', 'root'))
    for (const base of ['.codex', '.claude', '.agents']) {
      await walk(`${base}/agents`, kinds('agent', 'agent', 'root'), /\.(?:md|toml|json|ya?ml)$/i)
      // Only definition directories; never recurse through the platform root/history.
      await walk(`${base}/skills`, kinds('skill', 'skill', 'root'), /\.(?:md|py|mjs|js|ts|sh|ps1|toml|json|ya?ml)$/i)
      await walk(`${base}/commands`, kinds('command', 'skill', 'root'), /\.md$/i)
      await walk(`${base}/hooks`, kinds('hook', 'hook', 'root'), /\.(?:md|py|mjs|js|ts|sh|ps1|json)$/i)
    }
    for (const source of result.tasks) {
      if (result.tasks.filter(other => other.sourceTaskKey === source.sourceTaskKey).length > 1) blocker('TASK_IDENTITY_AMBIGUOUS', source.location, 'Multiple task locations contain the same original task identity; compare before selecting', 'task')
    }
    const templateBytes = bodies.get('.trellis/.template-hashes.json')
    if (templateBytes) {
      try {
        const baseline = z.object({ hashes: z.record(z.string(), z.string()) }).passthrough().parse(JSON.parse(utf8(templateBytes)))
        for (const asset of result.assets) {
          const original = baseline.hashes[asset.relativePath]
          if (original && /^[a-f0-9]{64}$/.test(original)) {
            asset.templateDigest = original
            if (original !== asset.sourceDigest) blocker('TEMPLATE_CONTENT_CHANGED', asset.relativePath, 'Current bytes differ from the retained template digest; preserve and review local behavior', asset.scope)
          }
        }
      } catch { blocker('TEMPLATE_BASELINE_UNAVAILABLE', '.trellis/.template-hashes.json', 'Template metadata is unsupported or invalid; no baseline version was inferred', 'root') }
    }
    for (const asset of result.assets.filter(a => a.kind === 'context')) {
      const bytes = bodies.get(asset.relativePath); if (!bytes) continue
      try {
        const lines = utf8(bytes).split(/\r?\n/)
        for (let order = 0; order < lines.length; order++) {
          if (!lines[order].trim()) continue
          if (result.context.length >= IMPORT_LIMITS.entries) { limit(asset.relativePath, 'Context entry limit reached'); break }
          const raw = z.object({ file: z.string(), reason: z.string().max(2000).optional() }).passthrough().parse(JSON.parse(lines[order]))
          const external = /^(?:[A-Za-z]:|\/|\\|[a-z]+:\/\/)/i.test(raw.file)
          const path = raw.file.replace(/\\/g, '/')
          const valid = !external && !path.split('/').some(part => !part || part === '.' || part === '..') && !privatePath(path)
          const available = valid && result.assets.some(a => a.relativePath === path)
          result.context.push({ assetKey: asset.itemKey, stage: basename(asset.relativePath, '.jsonl'), order, relativePath: valid ? path : null, reason: raw.reason ?? '', availability: external ? 'external' : !valid ? 'invalid' : available ? 'available' : 'missing' })
          if (!available) blocker('CONTEXT_RESOLUTION_REQUIRED', asset.relativePath, 'Context has a missing, private, invalid or external reference; select a fixed authorized source explicitly', 'task')
        }
      } catch { blocker('CONTEXT_INVALID', asset.relativePath, 'Context JSONL has an invalid or oversized entry', 'task') }
    }
    if (this.options.owners) {
      const owners = await this.options.owners(this.identity.root)
      if (owners.length > IMPORT_LIMITS.owners) limit('.trellis', 'Native owner evidence limit reached')
      result.owners = owners.slice(0, IMPORT_LIMITS.owners).map(owner => importOwnerEvidenceSchema.parse(owner))
    } else {
      const evidenceBytes = (path: string): Buffer => {
        const stat = checkedPath(this.identity, path).components.at(-1)?.stat
        if (result.scanned.files >= IMPORT_LIMITS.files || (stat && result.scanned.bytes + stat.size > IMPORT_LIMITS.totalBytes)) {
          limit(path, 'Retained owner metadata exceeds the remaining inventory budget')
          throw new TrellisImportError('IMPORT_INVENTORY_LIMIT', 'Owner metadata was not read beyond the inventory budget')
        }
        const bytes = readSource(this.identity, path)
        result.scanned.files++; result.scanned.bytes += bytes.length
        return bytes
      }
      const taskKey = (raw: unknown): string | null => {
        if (typeof raw !== 'string') return null
        const path = raw.trim().replace(/\\/g, '/')
        return result.tasks.find(t => t.location === path || t.sourceTaskKey === path || t.originalId === path)?.sourceTaskKey ?? null
      }
      await list('.trellis/.runtime/sessions', async (name, directory) => {
        if (directory || !name.endsWith('.json')) return
        if (result.owners.length >= IMPORT_LIMITS.owners) { limit('.trellis/.runtime/sessions', 'Retained owner metadata limit reached'); return }
        await yieldIO()
        try {
          const raw = z.record(z.string(), z.unknown()).parse(JSON.parse(utf8(evidenceBytes(`.trellis/.runtime/sessions/${name}`))))
          const id = `retained:${hash(name)}`
          result.owners.push({ ownerId: id, sessionId: id, taskKey: taskKey(raw.current_task), state: 'unknown', evidence: 'retained-metadata', observedAt: Date.now() })
        } catch { blocker('NATIVE_METADATA_UNAVAILABLE', '.trellis/.runtime/sessions', 'Retained session metadata is linked, invalid or beyond its byte limit', 'workcopy') }
      }, 'retained-sessions')
      try {
        const pointer = utf8(evidenceBytes('.trellis/.current-task'))
        if (result.owners.length < IMPORT_LIMITS.owners) result.owners.push({ ownerId: 'retained-current-task', sessionId: null, taskKey: taskKey(pointer), state: 'unknown', evidence: 'retained-metadata', observedAt: Date.now() })
        else limit('.trellis/.current-task', 'Retained owner metadata limit reached')
      } catch { /* A legacy pointer is optional and never establishes liveness. */ }
      try {
        evidenceBytes('.trellis/.panel/runtime/binding.json')
        if (result.owners.length < IMPORT_LIMITS.owners) result.owners.push({ ownerId: 'retained-runtime', sessionId: null, taskKey: null, state: 'unknown', evidence: 'retained-metadata', observedAt: Date.now() })
        else limit('.trellis/.panel/runtime/binding.json', 'Retained owner metadata limit reached')
      } catch { /* Missing metadata is not evidence that no native owner exists. */ }
      blocker('NATIVE_OWNER_UNVERIFIED', null, 'Native owner/working-copy handoff must be verified by its original runtime owner', 'workcopy')
    }
    blocker('ACTIVATION_NOT_IMPLEMENTED', null, 'Read-only import cannot install connectors, convert behavior, transfer live sessions or grant execution authority', 'root')
    assertRoot(this.identity)
    result.assets.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    this.current = importPreviewSchema.parse(result)
    return structuredClone(this.current)
  }

  async capture(previewId: string, rawSelections: ImportSelection[], authors: ImportManifest['authors']): Promise<ImportCapture> {
    const preview = this.current
    if (!preview || preview.previewId !== previewId) throw new TrellisImportError('IMPORT_PREVIEW_EXPIRED', 'Read the original source preview again before selecting bytes')
    const selections = z.array(importSelectionSchema).max(IMPORT_LIMITS.selections).parse(rawSelections)
    if (new Set(selections.map(s => s.itemKey)).size !== selections.length) throw new TrellisImportError('IMPORT_SELECTION_CONFLICT', 'Duplicate selections are not permitted')
    const selectedTasks = new Set<string>(), bodies: ImportCapture['bodies'] = [], assets: ImportManifest['assets'] = []
    let total = 0
    for (const selection of selections) {
      await yieldIO()
      const asset = preview.assets.find(a => a.itemKey === selection.itemKey)
      if (!asset || asset.sourceDigest !== selection.expectedSourceDigest || asset.sharing === 'metadata-only') throw new TrellisImportError('IMPORT_SELECTION_CONFLICT', 'Selection does not identify an eligible original preview asset')
      const bytes = readSource(this.identity, asset.relativePath)
      if (hash(bytes) !== asset.sourceDigest || bytes.length !== asset.byteLength) throw new TrellisImportError('IMPORT_SOURCE_CHANGED', 'Selected source bytes changed; compare a fresh preview')
      let text = utf8(bytes), representation = asset.representation
      if (asset.kind === 'context' && (preview.context.some(ref => ref.assetKey === asset.itemKey && ['external', 'invalid'].includes(ref.availability)) || preview.blockers.some(blocker => blocker.code === 'CONTEXT_INVALID' && blocker.relativePath === asset.relativePath))) throw new TrellisImportError('IMPORT_CONTEXT_RESOLUTION_REQUIRED', 'Resolve invalid or external/private context paths into portable selected resources before sharing the source JSONL')
      if (asset.kind === 'task' && !selection.includeOpaqueTaskFields) {
        const source = preview.tasks.find(t => t.sourceTaskKey === asset.sourceTaskKey && `${t.location}/task.json` === asset.relativePath)
        if (!source) throw new TrellisImportError('IMPORT_TASK_IDENTITY_CONFLICT', 'Original task metadata cannot be selected')
        text = importTaskSummary(source); representation = 'task-summary'
      } else representation = 'source'
      assertImportShareableText(text)
      const bodyBytes = Buffer.byteLength(text)
      if ((total += bodyBytes) > IMPORT_LIMITS.totalBytes) throw new TrellisImportError('IMPORT_CAPTURE_LIMIT', 'Selected snapshot total exceeds its byte budget')
      const { sharing: _sharing, templateDigest: _template, ...selected } = asset
      assets.push({ ...selected, representation, purpose: selection.purpose, reviewedForSharing: true, includeOpaqueTaskFields: selection.includeOpaqueTaskFields, bodyDigest: hash(text), bodyByteLength: bodyBytes })
      bodies.push({ itemKey: asset.itemKey, text })
      if (asset.sourceTaskKey) selectedTasks.add(asset.sourceTaskKey)
    }
    const tasks = preview.tasks.filter(t => selectedTasks.has(t.sourceTaskKey))
    // Revalidate task identity even when only a document within that task was selected.
    for (const task of tasks) {
      await yieldIO()
      const metadata = preview.assets.find(a => a.relativePath === `${task.location}/task.json`)
      if (!metadata || hash(readSource(this.identity, metadata.relativePath)) !== metadata.sourceDigest) throw new TrellisImportError('IMPORT_SOURCE_CHANGED', 'Owning task metadata changed after preview')
    }
    assertRoot(this.identity)
    const paths = new Set(assets.map(asset => asset.relativePath))
    const blockerIdentities = new Set<string>()
    const blockers = preview.blockers.flatMap(blocker => {
      const selected = blocker.relativePath !== null && (paths.has(blocker.relativePath) || tasks.some(task => blocker.relativePath === task.location || blocker.relativePath?.startsWith(task.location + '/')))
      if (['root', 'workcopy'].includes(blocker.scope)) return [{ ...blocker, relativePath: selected ? blocker.relativePath : null }]
      return selected ? [blocker] : []
    }).filter(blocker => { const id = canonicalImportJson(blocker); if (blockerIdentities.has(id)) return false; blockerIdentities.add(id); return true })
    const selectedAuthors = authors.filter(author => tasks.some(task => task.authors.includes(author.sourceAuthor)))
    const manifest = importManifestSchema.parse({ contractVersion: 1, assets, tasks, authors: selectedAuthors, blockers, truncated: preview.truncated })
    assertImportShareableText(canonicalImportJson(manifest))
    return importCaptureSchema.parse({ manifest, manifestDigest: hash(canonicalImportJson(manifest)), bodies })
  }
}
