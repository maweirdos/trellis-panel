import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import { databaseDeliveryDescriptorSchema, databaseDeliveryEvidenceSchema, databaseDeliveryFileSchema, databaseDeliveryRuleRefSchema,
  inspectDatabaseDeliveryRegistrations, type DatabaseDeliveryDescriptor, type DatabaseDeliveryEvidence, type DatabaseDeliveryFile,
  type DatabaseDeliveryReport, type DatabaseDeliveryRuleRef } from '../../../../shared/database-delivery'
import { nativeTaskBindingSchema, type NativeTaskBinding } from '../../../../shared/native-task-preparation'
import { executionArtifactRefSchema, executionCodeSourceSchema, executionDocumentRefSchema, type ExecutionArtifactRef, type ExecutionCodeSource } from '../../../../shared/team-execution-artifacts'
import { executionInputDigestText } from '../../../../shared/team-execution-input'
import { taskInputCanonical } from '../../../../shared/team-task-inputs'
import { teamTaskIdentity } from '../../../../shared/team-task-execution'
import { captureSelectedFile, verifyHandoffSource } from './handoff-source'

const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')
const same = (a: unknown, b: unknown): boolean => taskInputCanonical(a) === taskInputCanonical(b)
function reject(message: string): never { throw new Error(`DATABASE_DELIVERY_BLOCKED: submit_test: ${message}`) }
export interface NativeDatabaseDeliveryInput {
  binding: NativeTaskBinding
  descriptor: DatabaseDeliveryDescriptor
  rule: DatabaseDeliveryRuleRef
  implementation: DatabaseDeliveryEvidence['implementation']
  implementationSelectionId: string
  source: ExecutionCodeSource
  files: DatabaseDeliveryFile[]
  /** Current canonical issue supplied by the authenticated service owner, never inferred from file names. */
  ticket: string | null
  /** Reuse T05's original resource, workcopy, grant and process-owner checks around every await. */
  assertPrepared(): void | Promise<void>
  readArtifact(ref: ExecutionArtifactRef): Promise<{ text: string; bodyDigest: string }>
}

/** Main-only T05/T04 adapter. It reads exact mapped materials and selected SQL, and never runs imported code. */
export async function captureDatabaseDeliveryEvidence(raw: NativeDatabaseDeliveryInput): Promise<{ evidence: DatabaseDeliveryEvidence; report: DatabaseDeliveryReport }> {
  const binding = nativeTaskBindingSchema.parse(raw.binding), descriptor = databaseDeliveryDescriptorSchema.parse(raw.descriptor)
  const rule = databaseDeliveryRuleRefSchema.parse(raw.rule), implementation = executionDocumentRefSchema.parse(raw.implementation)
  const source = executionCodeSourceSchema.parse(raw.source), files = raw.files.map(file => databaseDeliveryFileSchema.parse(file))
  const assertPrepared = raw.assertPrepared.bind(raw), readArtifact = raw.readArtifact.bind(raw)
  const original = taskInputCanonical({ binding, descriptor, rule, implementation, source, files, selectionId: raw.implementationSelectionId, ticket: raw.ticket })
  const guard = async (): Promise<void> => {
    await assertPrepared()
    if (original !== taskInputCanonical({ binding: raw.binding, descriptor: raw.descriptor, rule: raw.rule, implementation: raw.implementation,
      source: raw.source, files: raw.files, selectionId: raw.implementationSelectionId, ticket: raw.ticket })) reject('The original selection changed during capture')
  }
  await guard()
  const request = binding.request, expected = request.expected
  if (binding.state !== 'ready' || binding.input.digest !== expected.inputDigest || hash(executionInputDigestText(binding.input)) !== binding.input.digest
    || !same(binding.input.inputBundle, binding.execution.inputBundle) || binding.input.executionId !== expected.executionId
    || binding.input.generation !== expected.generation || binding.input.deviceId !== request.pin.deviceId || binding.execution.executionId !== expected.executionId
    || binding.execution.generation !== expected.generation || binding.execution.nodeId !== expected.nodeId || binding.execution.attempt !== expected.attempt
    || binding.execution.deviceId !== request.pin.deviceId || !binding.execution.inputBundle
    || teamTaskIdentity(binding.input.task) !== teamTaskIdentity(request.task)) reject('The original fixed native preparation is unavailable')
  const adoptedRule = binding.input.resources.find(item => item.selection.source.kind === 'governance' && item.selection.source.packageId === rule.packageId && item.selection.source.versionId === rule.versionId && item.bodyDigest === rule.bodyDigest)
  if (!adoptedRule || !binding.input.resources.some(item => item.selection.id === raw.implementationSelectionId)) reject('Rule and implementation must be original captured inputs')
  const ruleResource = binding.resources.find(item => item.resource.selection.source.kind === 'governance'
    && item.resource.selection.source.packageId === rule.packageId && item.resource.selection.source.versionId === rule.versionId && item.resource.bodyDigest === rule.bodyDigest)
  const material = binding.resources.find(item => item.resource.selection.id === raw.implementationSelectionId)
  if (!ruleResource?.path || ruleResource.status !== 'available' || !ruleResource.resource.selection.required || ruleResource.resource.selection.delivery !== 'full') reject('The exact database rule must be captured as a required full T05 resource')
  if (!material?.path || material.status !== 'available' || material.resource.selection.source.kind !== 'confirmed-document'
    || material.resource.selection.source.documentId !== implementation.documentId || material.resource.selection.source.versionId !== implementation.versionId
    || material.resource.bodyDigest !== implementation.bodyDigest || material.resource.selection.delivery !== 'full') reject('Select the original fixed implement.md material mapping')
  const materialPath = (path: string): string => relative(binding.directory, path).replaceAll('\\', '/')
  const fixedRule = await captureSelectedFile({ root: binding.directory, relativePath: materialPath(ruleResource.path), expectedDigest: rule.bodyDigest, assertOwned: guard })
  if (!same(JSON.parse(fixedRule.text), descriptor)) reject('Descriptor differs from the original required fixed rule bytes')
  const document = await captureSelectedFile({ root: binding.directory, relativePath: materialPath(material.path), expectedDigest: implementation.bodyDigest, assertOwned: guard })
  const ticket = raw.ticket ?? (descriptor.unlinkedTicket === 'HONSKY-1111' ? descriptor.unlinkedTicket : null)
  if (!ticket) reject('The canonical Jira ticket is missing and no original fallback was selected')
  const report = inspectDatabaseDeliveryRegistrations(document.text, ticket)
  if (report.status === 'failed') reject(report.problems.slice(0, 12).map(item => `${item.path ?? 'implement.md'}: ${item.detail}`).join('; '))
  if (!same(report.registrations.map(item => item.path).sort(), files.map(item => item.path).sort())) reject('Select exactly the SQL paths registered in the fixed implement.md')
  if (source.kind === 'none' ? files.length !== 0 : source.kind !== 'selected-files'
    || !same(source.files.map(ref => taskInputCanonical(ref)).sort(), files.map(item => taskInputCanonical(item.ref)).sort())) reject('Selected SQL references differ from the original fixed code source')
  const targetPaths: Record<string, string> = Object.create(null)
  for (const file of files) {
    executionArtifactRefSchema.parse(file.ref)
    if (file.ref.executionId !== expected.executionId) reject('SQL was not captured by this original execution')
    targetPaths[file.ref.versionId] = file.path
  }
  const observed = await verifyHandoffSource({ root: binding.root, source, role: 'source', requiredCode: files.length > 0,
    expectedWorkcopy: { id: binding.workcopy.id, revision: binding.workcopy.revision }, targetPaths, assertOwned: guard, readArtifact })
  if (!observed.ready) reject('Actual selected SQL is unavailable or not applied in the authorized workcopy')
  // Recheck implement.md after reading every SQL to prevent mixed output/code snapshots.
  await captureSelectedFile({ root: binding.directory, relativePath: materialPath(material.path), expectedDigest: implementation.bodyDigest, assertOwned: guard })
  await guard()
  return { report, evidence: databaseDeliveryEvidenceSchema.parse({ kind: 'database-delivery-evidence', version: 1, task: request.task, rule,
    inputBundle: binding.execution.inputBundle, executionId: expected.executionId, generation: expected.generation, nodeId: expected.nodeId, attempt: expected.attempt,
    implementation, source, files, native: { verification: 'device-reported', deviceId: request.pin.deviceId, preparationId: binding.preparationId,
      inputDigest: binding.input.digest, sourceDigest: hash(taskInputCanonical(source)) } }) }
}
