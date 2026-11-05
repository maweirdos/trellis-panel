import { createHash, randomUUID } from 'node:crypto'
import type { TeamTaskRef, TeamExecutionRecord, TeamExecutionCommand } from '../../../src/shared/team-task-execution'
import { teamTaskIdentity } from '../../../src/shared/team-task-execution'
import { executionArtifactDigestText, executionArtifactVersionSchema, executionDeliveryManifestSchema, executionHandoffCheckpointSchema,
  type ExecutionArtifactVersion, type ExecutionDeliveryManifest, type executionDeliveryEntrySchema } from '../../../src/shared/team-execution-artifacts'
import type { z } from 'zod'
import type { executionOutputRefSchema } from '../../../src/shared/team-execution-artifacts'
import { taskInputCanonical } from '../../../src/shared/team-task-inputs'
import type { StorePrincipal } from './store-types'
import { TeamServiceError } from './errors'
import type { GovernanceHost } from './governance'
import { executionInputSchema } from '../../../src/shared/team-execution-input'
import { TEAM_MAX_RESPONSE_BYTES } from '../../../src/shared/team-platform'

type Ref = z.infer<typeof executionOutputRefSchema>
type Host = Pick<GovernanceHost, 'get' | 'run' | 'body' | 'persistBody'> & {
  history(principal: StorePrincipal, task: TeamTaskRef, executionId: string): TeamExecutionRecord
  document(principal: StorePrincipal, task: TeamTaskRef, ref: Extract<Ref, { kind: 'confirmed-document' }>): { text: string; title: string; withdrawn: boolean }
  creation(principal: StorePrincipal, task: TeamTaskRef, ref: Extract<Ref, { kind: 'confirmed-creation' }>): { text: string; title: string }
}
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
function fail(message: string, code = 'EXECUTION_DEPENDENCY_CONFLICT'): never { throw new TeamServiceError(code, message, 409) }
const binding = (r: TeamExecutionRecord): Pick<ExecutionArtifactVersion, 'taskIdentity' | 'executionId' | 'generation' | 'nodeId' | 'attempt'> =>
  ({ taskIdentity: teamTaskIdentity(r.task), executionId: r.executionId, generation: r.generation, nodeId: r.nodeId, attempt: r.attempt })
const version = (v: { versionId: string; digest: string }): { versionId: string; digest: string } => ({ versionId: v.versionId, digest: v.digest })
function same(a: unknown, b: unknown): boolean { return taskInputCanonical(a) === taskInputCanonical(b) }

/** Relations live on the original execution; all text bytes remain in the existing blob owner. */
export class TeamExecutionArtifacts {
  constructor(private readonly host: Host) {}

  resolve(principal: StorePrincipal, task: TeamTaskRef, ref: Ref): { text: string; title: string; bodyDigest: string; byteLength: number; withdrawn: boolean; artifactKind?: ExecutionArtifactVersion['kind'] } {
    if (ref.kind !== 'confirmed-artifact') {
      const value = ref.kind === 'confirmed-document' ? this.host.document(principal, task, ref) : { ...this.host.creation(principal, task, ref), withdrawn: false }
      if (hash(value.text) !== ref.bodyDigest) fail('Fixed resource body differs from its original digest')
      return { ...value, bodyDigest: ref.bodyDigest, byteLength: Buffer.byteLength(value.text, 'utf8') }
    }
    const record = this.host.history(principal, task, ref.executionId), selected = record.artifacts?.find(item => item.versionId === ref.versionId)
    if (!selected || selected.artifactId !== ref.artifactId || selected.bodyDigest !== ref.bodyDigest || selected.disposition !== 'confirmed'
      || selected.taskIdentity !== teamTaskIdentity(task) || selected.executionId !== record.executionId || selected.generation !== record.generation) fail('Output is missing, a draft/conflict, or outside the original task')
    const bytes = this.host.body(selected.bodyDigest), text = bytes.toString('utf8')
    if (hash(bytes) !== selected.bodyDigest || bytes.length !== selected.byteLength || !Buffer.from(text, 'utf8').equals(bytes)) fail('Fixed artifact bytes failed verification', 'CORRUPT_STORE')
    return { text, title: selected.title, bodyDigest: selected.bodyDigest, byteLength: selected.byteLength, withdrawn: false, artifactKind: selected.kind }
  }

  save(record: TeamExecutionRecord, command: Extract<TeamExecutionCommand, { kind: 'save-artifact' }>): { record: TeamExecutionRecord; selected: ExecutionArtifactVersion } {
    if ((record.artifacts?.length ?? 0) >= 64) fail('Artifact history capacity reached; original versions retained', 'CAPACITY_EXCEEDED')
    const all = record.artifacts ?? [], previous = all.filter(item => item.artifactId === command.artifactId && item.disposition !== 'conflict').at(-1)
    if (command.previousVersionId && !all.some(item => item.artifactId === command.artifactId && item.versionId === command.previousVersionId && item.disposition !== 'conflict')) fail('Compared artifact predecessor does not exist')
    if (previous && previous.kind !== command.artifactKind) fail('Artifact kind is immutable across versions')
    const bytes = Buffer.from(command.text, 'utf8'), bodyDigest = hash(bytes)
    if (bytes.length > 1024 * 1024 || bytes.toString('utf8') !== command.text || bodyDigest !== command.expectedDigest) fail('Artifact must be exact bounded UTF-8 matching the selected digest')
    if (!this.host.get('SELECT bodyDigest FROM blobs WHERE bodyDigest=?', bodyDigest)) {
      const usage = this.host.get('SELECT COALESCE(SUM(byteLength),0) AS bytes FROM blobs')
      if (!usage || typeof usage.bytes !== 'number' || usage.bytes + bytes.length > 1024 * 1024 * 1024) fail('Existing blob capacity reached', 'CAPACITY_EXCEEDED')
    }
    const selected = executionArtifactVersionSchema.parse({ ...binding(record), artifactId: command.artifactId, versionId: randomUUID(), previousVersionId: command.previousVersionId,
      kind: command.artifactKind, title: command.title, bodyDigest, byteLength: bytes.length, format: 'utf8', disposition: (previous?.versionId ?? null) === command.previousVersionId ? command.disposition : 'conflict', commandId: command.commandId, createdAt: Date.now() })
    if (Buffer.byteLength(JSON.stringify({ contractVersion: 2, artifact: selected, text: command.text })) > TEAM_MAX_RESPONSE_BYTES - 64 * 1024) fail('Artifact exceeds its recoverable serialized read budget', 'CAPACITY_EXCEEDED')
    this.host.persistBody(bytes, bodyDigest)
    this.host.run('INSERT INTO blobs(bodyDigest,byteLength,createdAt) VALUES(?,?,?) ON CONFLICT(bodyDigest) DO NOTHING', bodyDigest, bytes.length, Date.now())
    return { record: { ...record, artifacts: [...all, selected] }, selected }
  }

  private compare(previous: { versionId: string; digest: string } | null, all: { versionId: string; digest: string }[]): void {
    if (!same(previous, all.length ? version(all[all.length - 1]) : null)) fail('Compared immutable predecessor changed; compare before a new command', 'EXECUTION_ARTIFACT_CAS_CONFLICT')
  }

  seal(principal: StorePrincipal, record: TeamExecutionRecord, command: Extract<TeamExecutionCommand, { kind: 'seal-delivery' }>): TeamExecutionRecord {
    const all = record.deliveries ?? []
    if (all.length >= 16) fail('Delivery version capacity reached', 'CAPACITY_EXCEEDED')
    this.compare(command.previous, all)
    for (const entry of command.entries) {
      const value = this.resolve(principal, record.task, entry.ref)
      if (value.withdrawn) fail('A delivery output was withdrawn')
      if (entry.carriedFrom) this.validateCarry(principal, record, entry)
      else if (entry.ref.kind === 'confirmed-artifact') {
        const ref = entry.ref, artifact = record.artifacts?.find(item => item.versionId === ref.versionId)
        if (entry.ref.executionId !== record.executionId || !artifact || artifact.nodeId !== record.nodeId || artifact.attempt !== record.attempt) fail('Delivery output belongs to another execution/node/attempt')
      }
    }
    const content = { contractVersion: 2 as const, ...binding(record), versionId: randomUUID(), previous: command.previous, entries: command.entries, createdAt: Date.now() }
    const selected = executionDeliveryManifestSchema.parse({ ...content, digest: hash(executionArtifactDigestText(content)) })
    this.validateRequired(principal, record, selected)
    return { ...record, deliveries: [...all, selected] }
  }

  manifest(record: TeamExecutionRecord, ref: { versionId: string; digest: string }, currentNode = true): ExecutionDeliveryManifest {
    const selected = record.deliveries?.find(item => item.versionId === ref.versionId && item.digest === ref.digest)
    if (!selected || selected.digest !== hash(executionArtifactDigestText(selected)) || selected.taskIdentity !== teamTaskIdentity(record.task)
      || selected.executionId !== record.executionId || selected.generation !== record.generation
      || currentNode && (selected.nodeId !== record.nodeId || selected.attempt !== record.attempt)) fail('Original delivery manifest is unavailable or differs')
    return selected
  }

  private validateCarry(principal: StorePrincipal, record: TeamExecutionRecord, entry: z.infer<typeof executionDeliveryEntrySchema>): void {
    const source = entry.carriedFrom
    if (!source) fail('Carried output requires its original fixed lineage')
    if (source.kind === 'node-delivery') {
      const original = this.manifest(record, source.manifest, false)
      if (!original.entries.some(item => same(item.ref, entry.ref))) fail('Carried output is outside the explicitly selected sealed node delivery')
    } else {
      if (source.executionId !== record.predecessorExecutionId) fail('Carried output must come through the declared immediate predecessor')
      const previous = this.host.history(principal, record.task, source.executionId)
      if (previous.finalization?.outcome !== 'completed' || !previous.finalization.outputs.some(ref => same(ref, entry.ref))) fail('Carried output is not in the predecessor completed fixed finalization')
    }
  }

  private validateRequired(principal: StorePrincipal, record: TeamExecutionRecord, manifest: ExecutionDeliveryManifest): void {
    for (const entry of manifest.entries) if (entry.carriedFrom) this.validateCarry(principal, record, entry)
    const row = this.host.get('SELECT recordJson FROM team_task_execution_inputs WHERE executionId=?', record.executionId)
    if (!row) return
    // The input owner validates the full captured snapshot at finalize/transition.
    const input: unknown = typeof row.recordJson === 'string' ? JSON.parse(row.recordJson) : null
    const parsed = executionInputSchema.parse(input), node = parsed.definition.nodes.find(item => item.id === manifest.nodeId)
    if (!node || node.kind === 'gate') fail('Delivery node is not a declared output producer')
    for (const policy of node.outputs) {
      const entry = manifest.entries.find(item => !item.carriedFrom && item.outputId === policy.id)
      if (!entry) { if (policy.required) fail('A required declared output is missing'); continue }
      const value = this.resolve(principal, record.task, entry.ref)
      if (['prd', 'design', 'implement', 'delivery-note'].includes(policy.kind)) {
        if (entry.ref.kind !== 'confirmed-document') fail('Formal document output requires its actual approved version')
        const doc = this.host.get('SELECT kind FROM task_material_documents WHERE documentId=?', entry.ref.documentId)
        if (doc?.kind !== policy.kind) fail('Approved document kind differs from the declared output')
      } else if (policy.kind === 'creation-html') {
        if (entry.ref.kind !== 'confirmed-creation') fail('Declared HTML output requires its exact published creation')
      } else if (value.artifactKind !== policy.kind) fail('Artifact kind differs from its declared output')
    }
    if (manifest.entries.some(entry => !entry.carriedFrom && !node.outputs.some(policy => policy.id === entry.outputId))) fail('Delivery names an undeclared produced output')
  }

  checkpoint(principal: StorePrincipal, record: TeamExecutionRecord, command: Extract<TeamExecutionCommand, { kind: 'checkpoint' }>): TeamExecutionRecord {
    const all = record.checkpoints ?? []
    if (all.length >= 16) fail('Checkpoint capacity reached', 'CAPACITY_EXCEEDED')
    this.compare(command.previous, all)
    this.manifest(record, command.manifest)
    if (command.source.kind === 'none') { if (command.observation !== null) fail('No-code handoff has no native observation') }
    else {
      if (principal.actor.kind !== 'device' || !principal.deviceId) fail('Native source observations require the original authenticated device', 'EXECUTION_FORBIDDEN')
      if (!command.observation || command.observation.sourceDigest !== hash(taskInputCanonical(command.source))) fail('Original source observation does not match selected code')
      if (command.source.kind === 'selected-files' || command.source.kind === 'git-patch') {
        const refs = command.source.kind === 'selected-files' ? command.source.files : [command.source.patch]
        for (const ref of refs) {
          const value = this.resolve(principal, record.task, ref)
          if (value.artifactKind !== (command.source.kind === 'selected-files' ? 'selected-file' : 'source-patch')) fail('Checkpoint code references have the wrong artifact kind')
          const manifest = this.manifest(record, command.manifest)
          if (!manifest.entries.some(entry => same(entry.ref, ref))) fail('Selected code bytes are outside the fixed delivery')
        }
      }
    }
    const content = { contractVersion: 2 as const, ...binding(record), versionId: randomUUID(), previous: command.previous, manifest: command.manifest,
      remainingWork: command.remainingWork, source: command.source, observation: command.observation, createdAt: Date.now() }
    const selected = executionHandoffCheckpointSchema.parse({ ...content, digest: hash(executionArtifactDigestText(content)) })
    return { ...record, checkpoints: [...all, selected] }
  }

  validateFinalization(principal: StorePrincipal, record: TeamExecutionRecord, fresh = false): void {
    const final = record.finalization
    if (!final) fail('Execution has no finalization')
    if (!final.manifest) {
      if (final.checkpoint || final.outcome === 'completed' && (final.outputs.some(ref => ref.kind !== 'confirmed-document') || fresh && this.host.get('SELECT executionId FROM team_task_execution_inputs WHERE executionId=?', record.executionId))) fail('New completed captured/general deliveries require an exact manifest')
      return
    }
    const manifest = this.manifest(record, final.manifest)
    if (!same(manifest.entries.map(entry => entry.ref), final.outputs)) fail('Finalization cannot substitute outputs from its delivery')
    this.validateRequired(principal, record, manifest)
    if (final.outcome === 'completed' && !final.checkpoint) fail('Completed managed delivery requires its fixed handoff checkpoint')
    if (final.checkpoint) {
      const checkpoint = record.checkpoints?.find(item => item.versionId === final.checkpoint?.versionId && item.digest === final.checkpoint.digest)
      if (!checkpoint || checkpoint.digest !== hash(executionArtifactDigestText(checkpoint)) || !same(checkpoint.manifest, final.manifest)) fail('Finalization checkpoint does not pin the original delivery')
    }
  }
}
