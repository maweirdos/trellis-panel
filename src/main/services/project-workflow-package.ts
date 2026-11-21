import { z } from 'zod'
import { executionInputDigestText, executionInputResourceSchema, executionInputSchema, type ExecutionInput } from '../../shared/team-execution-input'
import { teamCodeResourceSchema } from '../../shared/team-code-resources'
import { taskInputCanonical } from '../../shared/team-canonical'
import type { PortableWorkflowDefinition } from '../../shared/workflow/portable-definition'
import type { FixedExecutionRules } from './crux/task-input-rules'
import { fileDigest, validateRelativePath } from './workflow-cutover/files'
import { cutoverManifestDigest } from './workflow-cutover/installer'
import { CUTOVER_FILE_LIMITS, CutoverInstallerError, type CutoverFileChange } from './workflow-cutover/types'

/** Observe absence explicitly; the authenticated native owner reads these without changing them. */
export const ORDINARY_PACKAGE_ROOT_PATHS = Object.freeze([
  'AGENTS.md', 'CLAUDE.md', '.codex/config.toml', '.codex/hooks.json',
  '.claude/settings.json', '.claude/settings.local.json'
] as const)
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/)
const ruleStatusSchema = z.enum(['available', 'withdrawn', 'unavailable'])
export const ordinaryPackageRootObservationSchema = z.object({
  relativePath: z.enum(ORDINARY_PACKAGE_ROOT_PATHS), digest: digestSchema.nullable()
}).strict()
/** Resource identity excludes task selection, authorization, timestamps and local workcopy facts. */
export const ordinaryPackageCodeResourceSchema = teamCodeResourceSchema.pick({
  resourceId: true, projectId: true, revision: true, source: true
})
export type OrdinaryPackageRootObservation = z.infer<typeof ordinaryPackageRootObservationSchema>
export type OrdinaryPackageCodeResource = z.infer<typeof ordinaryPackageCodeResourceSchema>
export type BuildOrdinaryPackageInput = {
  input: ExecutionInput
  /** Exact governance selections across every node, not just one FixedExecutionRules.node. */
  rules: readonly FixedExecutionRules['rules'][number][]
  codeResource: OrdinaryPackageCodeResource | null
  rootObservations: readonly OrdinaryPackageRootObservation[]
}
export type OrdinaryPackage = {
  releaseDigest: string
  releaseDirectory: string
  /** WorkflowCutoverInstaller plan digest, including the manifest file and derived target paths. */
  manifestDigest: string
  /** SHA-256 of manifest.json bytes; distinct from the installer's plan digest. */
  manifestFileDigest: string
  files: CutoverFileChange[]
}

type PackageFile = { relativePath: string; bytes: Buffer }
type GovernanceResource = ExecutionInput['resources'][number] & {
  selection: ExecutionInput['resources'][number]['selection'] & { source: { kind: 'governance'; packageId: string; versionId: string } }
}
type RuleReference = Pick<GovernanceResource, 'bodyDigest' | 'byteLength'> & {
  source: GovernanceResource['selection']['source']
  nodeId: string; phaseId: string; stage: GovernanceResource['selection']['stage']
  order: number; required: boolean
  /** Captured delivery request; inclusion records actual package content separately. */
  delivery: GovernanceResource['selection']['delivery']
  status: z.infer<typeof ruleStatusSchema>; inclusion: 'full' | 'unavailable'; relativePath: string | null
}

function invalid(message: string): never { throw new CutoverInstallerError('CUTOVER_INVALID_PLAN', message) }
function limit(message: string): never { throw new CutoverInstallerError('CUTOVER_LIMIT', message) }
function jsonFile(relativePath: string, value: unknown): PackageFile {
  return { relativePath, bytes: Buffer.from(taskInputCanonical(value) + '\n', 'utf8') }
}
function comparePath(a: { relativePath: string }, b: { relativePath: string }): number {
  return a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0
}
function governance(resource: ExecutionInput['resources'][number]): resource is GovernanceResource {
  return resource.selection.source.kind === 'governance'
}
function rootObservations(raw: BuildOrdinaryPackageInput['rootObservations']): OrdinaryPackageRootObservation[] {
  if (!Array.isArray(raw) || raw.length !== ORDINARY_PACKAGE_ROOT_PATHS.length) invalid('Ordinary package requires an explicit digest or absence for every root instruction/configuration surface')
  const observations = raw.map(value => ordinaryPackageRootObservationSchema.parse(value)).sort(comparePath)
  if (new Set(observations.map(value => value.relativePath)).size !== ORDINARY_PACKAGE_ROOT_PATHS.length) invalid('Ordinary package root observations are duplicated or incomplete')
  return observations
}

function fixedRules(input: ExecutionInput, raw: BuildOrdinaryPackageInput['rules']): { references: RuleReference[]; files: PackageFile[] } {
  const expected = input.resources.filter(governance)
  if (!Array.isArray(raw) || raw.length !== expected.length) invalid('Ordinary package must include every captured governance selection across all nodes')
  const bodies = new Map<string, Buffer>(), selected = new Map<string, Pick<RuleReference, 'status' | 'inclusion'>>()
  for (const fixed of raw) {
    const resource = executionInputResourceSchema.parse(fixed.resource)
    if (!governance(resource) || selected.has(resource.selection.id)) invalid('Ordinary package accepts unique captured governance selections only')
    const captured = expected.find(item => item.selection.id === resource.selection.id)
    if (!captured || taskInputCanonical(resource) !== taskInputCanonical(captured)) invalid('Ordinary package rule differs from its captured execution resource')
    const status = ruleStatusSchema.parse(fixed.status)
    if (fixed.body !== null && typeof fixed.body !== 'string') invalid('Ordinary package rule body must be exact text or explicitly absent')
    if (resource.selection.required && (status !== 'available' || fixed.body === null)) invalid('Ordinary package cannot install a missing, unavailable or withdrawn required rule')
    if (fixed.body !== null) {
      const bytes = Buffer.from(fixed.body, 'utf8')
      if (bytes.length > CUTOVER_FILE_LIMITS.fileBytes) limit('Ordinary package rule exceeds the single-file budget')
      if (bytes.toString('utf8') !== fixed.body || bytes.length !== resource.byteLength || fileDigest(bytes) !== resource.bodyDigest) invalid('Ordinary package rule failed its exact UTF-8 body digest/length check')
      if (status === 'available') {
        const previous = bodies.get(resource.bodyDigest)
        if (previous && !previous.equals(bytes)) invalid('Ordinary package rule digest identifies conflicting bytes')
        bodies.set(resource.bodyDigest, bytes)
      }
    }
    selected.set(resource.selection.id, { status, inclusion: status === 'available' && fixed.body !== null ? 'full' : 'unavailable' })
  }
  const nodes = new Map(input.definition.nodes.map((node, index) => [node.id, index]))
  const references = expected.slice().sort((a, b) => (nodes.get(a.selection.nodeId) ?? -1) - (nodes.get(b.selection.nodeId) ?? -1) || a.selection.order - b.selection.order)
    .map((resource): RuleReference => {
      const { nodeId, phaseId, stage, order, required, delivery, source } = resource.selection
      const availability = selected.get(resource.selection.id)
      if (!availability) invalid('Ordinary package governance availability is incomplete')
      // Selection IDs and reasons belong to the execution; they cannot key a shared release.
      return { nodeId, phaseId, stage, order, required, delivery, source, bodyDigest: resource.bodyDigest,
        byteLength: resource.byteLength, ...availability,
        relativePath: availability.inclusion === 'full' ? `rules/${resource.bodyDigest}.md` : null }
    })
  const versions = new Map<string, string>()
  for (const ref of references) {
    const key = taskInputCanonical(ref.source), body = taskInputCanonical([ref.bodyDigest, ref.byteLength])
    if (versions.has(key) && versions.get(key) !== body) invalid('One adopted governance version identifies conflicting rule bodies')
    versions.set(key, body)
  }
  return { references, files: [...bodies].map(([digest, bytes]) => ({ relativePath: `rules/${digest}.md`, bytes })).sort(comparePath) }
}

function fenced(value: unknown): string {
  const text = taskInputCanonical(value)
  let longest = 0
  for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length)
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}json\n${text}\n${fence}`
}
/** Render the original ordered nodes, including their output/gate policies, without a second graph. */
function entry(definition: PortableWorkflowDefinition, references: RuleReference[]): PackageFile {
  const text = [
    '# Project workflow',
    'Use the fixed definition in `workflow.json` and the adopted rule references below for the selected node. The application verifies this release and the original fixed context through `fixed-context/v1` before task start.',
    'Native SessionStart, PreToolUse, child-session and editor-start events are unverified.',
    '## Roles', fenced(definition.roles),
    '## Ordered nodes',
    ...definition.nodes.map((node, index) => `### Node ${index + 1}\n\n${fenced(node)}`),
    '## Adopted rules', fenced(references)
  ].join('\n\n') + '\n'
  return { relativePath: 'ENTRY.md', bytes: Buffer.from(text, 'utf8') }
}

function assertFiles(files: PackageFile[], prefix = ''): void {
  if (!files.length || files.length > CUTOVER_FILE_LIMITS.files) limit('Ordinary package file count exceeds the installer budget')
  let total = 0
  const seen = new Set<string>()
  for (const file of files) {
    const path = prefix + file.relativePath
    validateRelativePath(path)
    if (!/^(?:manifest\.json|workflow\.json|ENTRY\.md|rules\/[a-f0-9]{64}\.md)$/.test(file.relativePath) || seen.has(path.toLowerCase())) invalid('Ordinary package contains an unsupported or duplicate path')
    seen.add(path.toLowerCase())
    if (file.bytes.length > CUTOVER_FILE_LIMITS.fileBytes) limit('Ordinary package file exceeds the single-file budget')
    total += file.bytes.length
    if (total > CUTOVER_FILE_LIMITS.totalBytes) limit('Ordinary package exceeds the total byte budget')
  }
}

/**
 * Pure file-plan construction from authenticated, already-read fixed sources; performs no I/O.
 * The native owner must recheck authority/root observations and retain a quiet-workcopy lease.
 * Existing releases require their original verified journal and bytes; never stage an empty plan.
 */
export function buildOrdinaryPackage(raw: BuildOrdinaryPackageInput): OrdinaryPackage {
  const input = executionInputSchema.parse(raw.input)
  if (fileDigest(executionInputDigestText(input)) !== input.digest
    || fileDigest(taskInputCanonical(input.definition)) !== input.workflow.digest) invalid('Ordinary package input or portable definition digest is invalid')
  const codeResource = raw.codeResource === null ? null : ordinaryPackageCodeResourceSchema.parse(raw.codeResource)
  if (codeResource && codeResource.projectId !== input.task.projectId) invalid('Ordinary package code resource belongs to another project')
  const observations = rootObservations(raw.rootObservations), rules = fixedRules(input, raw.rules)
  const payload = [jsonFile('workflow.json', input.definition), entry(input.definition, rules.references), ...rules.files].sort(comparePath)
  assertFiles(payload)
  const content = {
    formatVersion: 1, kind: 'ordinary-project',
    project: { instanceId: input.task.instanceId, projectId: input.task.projectId }, codeResource,
    workflow: input.workflow, rules: rules.references,
    outputs: input.definition.nodes.flatMap(node => node.kind === 'gate' ? [] : [{
      nodeId: node.id, phaseId: node.phaseId, stage: node.stage, outputs: node.outputs
    }]),
    rootObservations: observations, adapter: { owner: 'application', version: 'ordinary-package/v1' },
    hooks: [{ event: 'task-start', owner: 'application', handler: 'fixed-context/v1', required: true, nativeEvents: 'unverified' }],
    entrypoint: 'ENTRY.md',
    files: payload.map(file => ({ relativePath: file.relativePath, digest: fileDigest(file.bytes), byteLength: file.bytes.length }))
  }
  // Self-digest, manifest bytes and release-derived target paths are deliberately outside this preimage.
  const releaseDigest = fileDigest(taskInputCanonical(content)), releaseDirectory = `.crux/workflow/releases/${releaseDigest}`
  const manifest = jsonFile('manifest.json', { ...content, releaseDigest })
  const complete = [...payload, manifest].sort(comparePath)
  assertFiles(complete, releaseDirectory + '/')
  const files: CutoverFileChange[] = complete.map(file => ({
    relativePath: `${releaseDirectory}/${file.relativePath}`, expectedBeforeDigest: null,
    afterDigest: fileDigest(file.bytes), afterBytes: Buffer.from(file.bytes)
  }))
  return { files, releaseDigest, releaseDirectory, manifestDigest: cutoverManifestDigest(files), manifestFileDigest: fileDigest(manifest.bytes) }
}
