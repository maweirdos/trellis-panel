import { createHash } from 'node:crypto'
import type { CruxTask, CruxTransitionTaskInput } from '../../../src/shared/crux'
import { databaseDeliveryEvidenceSchema, inspectDatabaseDeliveryRegistrations, readDatabaseDeliveryDescriptor,
  type DatabaseDeliveryDescriptor, type DatabaseDeliveryEvidence, type DatabaseDeliveryReport } from '../../../src/shared/database-delivery'
import { executionArtifactDigestText, type ExecutionArtifactRef } from '../../../src/shared/team-execution-artifacts'
import { executionInputSchema, executionInputDigestText } from '../../../src/shared/team-execution-input'
import { importCandidateSchema, importNamespaceSchema } from '../../../src/shared/team-import'
import { jiraBusinessTaskMappingSchema } from '../../../src/shared/jira-business-hooks'
import { taskInputCanonical, type TaskInputBundle } from '../../../src/shared/team-task-inputs'
import { teamTaskIdentity, type TeamExecutionRecord, type TeamTaskRef } from '../../../src/shared/team-task-execution'
import { governanceFail, governanceStored, type GovernanceHost } from './governance'
import type { StorePrincipal } from './store-types'
import type { TeamExecutionArtifacts } from './task-execution-artifacts'

export type TaskDatabaseDeliveryValidator = (principal: StorePrincipal, task: TeamTaskRef, bundle: TaskInputBundle, input: CruxTransitionTaskInput, before: CruxTask, after: CruxTask) => void
export type DatabaseDeliveryHost = Pick<GovernanceHost, 'identity' | 'get' | 'all' | 'body'> & {
  history(principal: StorePrincipal, task: TeamTaskRef, executionId: string): TeamExecutionRecord
  resolveOutput: TeamExecutionArtifacts['resolve']
}
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const same = (a: unknown, b: unknown): boolean => taskInputCanonical(a) === taskInputCanonical(b)
function block(detail: string): never { return governanceFail('DATABASE_DELIVERY_BLOCKED', `submit_test: ${detail}`) }

/** Synchronous consumer inside the original business-command transaction, shared by product and editor. */
export class TeamDatabaseDelivery {
  constructor(private readonly host: DatabaseDeliveryHost) {}

  readonly validate: TaskDatabaseDeliveryValidator = (principal, task, bundle, input, before, after): void => {
    if (input.action !== 'submit_test') return
    for (const rule of bundle.rules) {
      if (rule.settings.kind !== 'rule' || rule.settings.obligation !== 'required') continue
      const bytes = this.host.body(rule.bodyDigest)
      if (bytes.length !== rule.byteLength || hash(bytes) !== rule.bodyDigest || !Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) block('Fixed rule bytes failed verification')
      let descriptor: DatabaseDeliveryDescriptor | null
      try { descriptor = readDatabaseDeliveryDescriptor(bytes.toString('utf8')) } catch { block('Unsupported database delivery descriptor') }
      if (!descriptor) continue
      if (before.workflow?.stage !== descriptor.gate.from || after.workflow?.stage !== descriptor.gate.to
        || input.taskId !== task.taskId || before.id !== task.taskId || after.id !== task.taskId || before.spaceId !== task.spaceId
        || after.spaceId !== task.spaceId || before.createdAt !== task.taskCreatedAt || after.createdAt !== task.taskCreatedAt) block('The configured development delivery boundary does not match the original task')
      this.source(task, descriptor)
      const ticket = this.ticket(task, descriptor)
      const record = this.execution(principal, task, bundle, before)
      const final = record.finalization
      if (!final?.manifest || !final.checkpoint) block('A completed fixed delivery manifest and checkpoint are required')
      const manifest = record.deliveries?.find(item => same({ versionId: item.versionId, digest: item.digest }, final.manifest))
      const checkpoint = record.checkpoints?.find(item => same({ versionId: item.versionId, digest: item.digest }, final.checkpoint))
      if (!manifest || !checkpoint || manifest.digest !== hash(executionArtifactDigestText(manifest)) || checkpoint.digest !== hash(executionArtifactDigestText(checkpoint))
        || !same(checkpoint.manifest, final.manifest) || !same(manifest.entries.map(item => item.ref), final.outputs)
        || [manifest, checkpoint].some(item => item.taskIdentity !== teamTaskIdentity(task) || item.executionId !== record.executionId || item.generation !== record.generation)) block('Original manifest/checkpoint provenance changed')
      const reports: DatabaseDeliveryEvidence[] = []
      for (const entry of manifest.entries) {
        if (entry.ref.kind !== 'confirmed-artifact') continue
        const value = this.host.resolveOutput(principal, task, entry.ref)
        if (value.artifactKind !== 'check-report') continue
        let content: unknown
        try { content = JSON.parse(value.text) } catch { continue }
        if (!content || typeof content !== 'object' || !('kind' in content) || content.kind !== 'database-delivery-evidence') continue
        const parsed = databaseDeliveryEvidenceSchema.safeParse(content)
        if (!parsed.success) block('Database check report is malformed or unsupported')
        if (!same(parsed.data.rule, { packageId: rule.packageId, versionId: rule.versionId, bodyDigest: rule.bodyDigest })) continue
        this.producer(record, entry.ref, 'check-report', manifest.nodeId, manifest.attempt)
        reports.push(parsed.data)
      }
      if (reports.length !== 1) block('Exactly one original database check report is required for the selected rule')
      const evidence = reports[0]
      if (teamTaskIdentity(evidence.task) !== teamTaskIdentity(task) || evidence.executionId !== record.executionId || evidence.generation !== record.generation
        || evidence.nodeId !== manifest.nodeId || evidence.attempt !== manifest.attempt || evidence.nodeId !== checkpoint.nodeId || evidence.attempt !== checkpoint.attempt
        || !same(evidence.inputBundle, record.inputBundle) || !same(evidence.source, checkpoint.source)) block('Database evidence belongs to another task, input, producer or code checkpoint')
      const capture = this.host.get('SELECT recordJson FROM team_task_execution_inputs WHERE executionId=?', record.executionId)
      if (!capture) block('Original captured execution inputs are unavailable')
      const captured = governanceStored(executionInputSchema, capture.recordJson)
      if (captured.digest !== hash(executionInputDigestText(captured)) || captured.executionId !== record.executionId
        || captured.epoch !== record.epoch || captured.generation !== record.generation || captured.deviceId !== record.deviceId
        || teamTaskIdentity(captured.task) !== teamTaskIdentity(task) || !same(captured.inputBundle, record.inputBundle)
        || evidence.native.inputDigest !== captured.digest || evidence.native.deviceId !== record.deviceId
        || evidence.native.sourceDigest !== hash(taskInputCanonical(evidence.source))
        || (evidence.source.kind === 'none' ? checkpoint.observation !== null : !checkpoint.observation
          || checkpoint.observation.sourceDigest !== evidence.native.sourceDigest)) block('Native observation differs from the original device/input/code selection')
      const implementation = bundle.documents.find(item => item.kind === 'implement')
      if (!implementation || !same(evidence.implementation, { kind: 'confirmed-document', documentId: implementation.documentId, versionId: implementation.versionId, bodyDigest: implementation.bodyDigest })
        || !final.outputs.some(ref => same(ref, evidence.implementation))) block('Explicitly deliver the exact adopted implement.md version')
      const document = this.host.resolveOutput(principal, task, evidence.implementation)
      if (document.withdrawn) block('The original implementation approval was withdrawn')
      const report = inspectDatabaseDeliveryRegistrations(document.text, ticket)
      if (report.status === 'failed') this.failed(report)
      if (!same([...report.registrations.map(item => item.path)].sort(), evidence.files.map(item => item.path).sort())) block('SQL file evidence does not exactly match implement.md registrations')
      if (evidence.source.kind === 'none') {
        if (evidence.files.length) block('Registered SQL requires actual fixed selected-file code')
      } else if (evidence.source.kind !== 'selected-files' || !same(evidence.source.files.map(ref => taskInputCanonical(ref)).sort(), evidence.files.map(item => taskInputCanonical(item.ref)).sort())) block('SQL evidence does not match the fixed code source')
      for (const file of evidence.files) {
        if (!final.outputs.some(ref => same(ref, file.ref))) block(`SQL ${file.path} is outside the exact delivery`)
        this.producer(record, file.ref, 'selected-file', manifest.nodeId, manifest.attempt)
        const sql = this.host.resolveOutput(principal, task, file.ref)
        if (sql.withdrawn || sql.artifactKind !== 'selected-file' || sql.bodyDigest !== file.ref.bodyDigest || hash(sql.text) !== file.ref.bodyDigest
          || Buffer.byteLength(sql.text, 'utf8') !== sql.byteLength || sql.byteLength > 1024 * 1024) block(`Fixed SQL bytes are unavailable or changed: ${file.path}`)
      }
    }
  }

  private source(task: TeamTaskRef, descriptor: DatabaseDeliveryDescriptor): void {
    const source = descriptor.source
    const row = this.host.get('SELECT recordJson FROM import_candidates WHERE candidateId=? AND namespaceId=? AND importId=? AND itemKey=?', source.candidateId, source.namespaceId, source.importId, source.itemKey)
    const ns = this.host.get('SELECT recordJson FROM import_namespaces WHERE namespaceId=? AND projectId=?', source.namespaceId, task.projectId)
    if (!row || !ns) block('The selected T02 source inventory candidate is unavailable')
    const candidate = governanceStored(importCandidateSchema, row.recordJson), namespace = governanceStored(importNamespaceSchema, ns.recordJson), asset = candidate.asset
    if (namespace.spaceId !== task.spaceId || candidate.conflicts.length || candidate.task && teamTaskIdentity(candidate.task) !== teamTaskIdentity(task)
      || asset.sourceDigest !== source.sourceDigest || asset.itemKey !== source.itemKey || candidate.namespaceId !== source.namespaceId || candidate.importId !== source.importId
      || !['script', 'hook'].includes(asset.kind) || !/(?:^|\/)database_delivery_gate\.py$/.test(asset.relativePath)
      || asset.bodyDigest !== asset.sourceDigest) block('The selected source is not the original supported database delivery script')
    const bytes = this.host.body(asset.bodyDigest)
    if (hash(bytes) !== source.sourceDigest || bytes.length !== asset.bodyByteLength) block('Source inventory bytes changed')
  }

  private ticket(task: TeamTaskRef, descriptor: DatabaseDeliveryDescriptor): string {
    const rows = this.host.all("SELECT recordJson FROM jira_business_task_mappings WHERE projectId=? AND json_extract(recordJson,'$.task.taskId')=? AND json_extract(recordJson,'$.task.spaceId')=? AND json_extract(recordJson,'$.task.taskCreatedAt')=?", task.projectId, task.taskId, task.spaceId, task.taskCreatedAt)
    if (!rows.length && descriptor.unlinkedTicket === 'HONSKY-1111') return descriptor.unlinkedTicket
    if (rows.length !== 1) block('One canonical Jira issue is required; missing/ambiguous mappings cannot select a ticket')
    const mapping = governanceStored(jiraBusinessTaskMappingSchema, rows[0].recordJson)
    const owners = this.host.all('SELECT recordJson FROM jira_business_task_mappings WHERE instanceId=? AND issueId=?', mapping.issue.instanceId, mapping.issue.issueId)
    if (owners.length !== 1 || teamTaskIdentity(mapping.task) !== teamTaskIdentity(task) || !mapping.issue.issueKey || !/^HONSKY-\d+$/.test(mapping.issue.issueKey)) block('The Jira issue has no unique canonical original task/ticket')
    return mapping.issue.issueKey
  }

  private execution(principal: StorePrincipal, task: TeamTaskRef, bundle: TaskInputBundle, before: CruxTask): TeamExecutionRecord {
    const row = this.host.get("SELECT executionId,businessBoundaryJson FROM team_task_executions WHERE projectId=? AND taskId=? AND json_extract(recordJson,'$.task.spaceId')=? AND json_extract(recordJson,'$.task.taskCreatedAt')=? ORDER BY rowid DESC LIMIT 1", task.projectId, task.taskId, task.spaceId, task.taskCreatedAt)
    if (!row) block('No original fixed execution delivery is available')
    const record = this.host.history(principal, task, String(row.executionId))
    if (record.epoch !== this.host.identity().epoch || record.finalization?.outcome !== 'completed' || !record.deviceId
      || !same(record.inputBundle, { bundleId: bundle.bundleId, revision: bundle.revision, digest: bundle.digest })) block('The completed delivery does not use the original adopted inputs and device')
    let boundary: unknown
    try { boundary = JSON.parse(String(row.businessBoundaryJson)) } catch { block('Original execution business boundary is unavailable') }
    const original = boundary && typeof boundary === 'object' && 'original' in boundary ? boundary.original : null
    if (!original || typeof original !== 'object' || !('kind' in original) || original.kind !== 'formal'
      || !('stage' in original) || original.stage !== before.workflow?.stage || !('historyLength' in original) || original.historyLength !== before.workflow?.history.length
      || !('historyHeadId' in original) || original.historyHeadId !== (before.workflow?.history.at(-1)?.id ?? null)
      || !('handlerId' in original) || original.handlerId !== (before.workflow?.handlerId ?? null)
      || boundary && typeof boundary === 'object' && 'successor' in boundary && boundary.successor !== null) block('The original development delivery boundary was already consumed or changed')
    return record
  }

  private producer(record: TeamExecutionRecord, ref: ExecutionArtifactRef, kind: 'check-report' | 'selected-file', nodeId: string, attempt: number): void {
    const artifact = record.artifacts?.find(item => item.versionId === ref.versionId && item.artifactId === ref.artifactId)
    if (!artifact || ref.executionId !== record.executionId || artifact.kind !== kind || artifact.disposition !== 'confirmed'
      || artifact.generation !== record.generation || artifact.taskIdentity !== teamTaskIdentity(record.task)
      || artifact.bodyDigest !== ref.bodyDigest || artifact.nodeId !== nodeId || artifact.attempt !== attempt) block('Fixed SQL/check artifact is outside its original producer')
  }

  private failed(report: DatabaseDeliveryReport): never {
    return block(report.problems.slice(0, 12).map(item => `${item.path ?? 'implement.md'}: ${item.detail}`).join('; '))
  }
}
