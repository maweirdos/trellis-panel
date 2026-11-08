import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { databaseDeliveryCaptureRequestSchema, readDatabaseDeliveryDescriptor, type DatabaseDeliveryCaptureRequest } from '../../../shared/database-delivery'
import type { NativeTaskBinding } from '../../../shared/native-task-preparation'
import { teamExecutionCommandSchema } from '../../../shared/team-task-execution'
import { taskInputCanonical } from '../../../shared/team-task-inputs'
import { captureDatabaseDeliveryEvidence } from '../../services/crux/task-outputs/database-delivery'
import type { TaskExecutionTransport } from '../../services/team-platform/task-execution-transport'
import { readBounded, writeExclusiveAtomic } from '../files'
import { DaemonError } from '../errors'

const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const equal = (a: unknown, b: unknown): boolean => taskInputCanonical(a) === taskInputCanonical(b)
const savedSchema = z.object({ request: databaseDeliveryCaptureRequestSchema, command: teamExecutionCommandSchema }).strict()
function conflict(message: string): never { throw new DaemonError('E_CONFLICT', 'DATABASE_DELIVERY_BLOCKED: submit_test: ' + message) }
function commandFile(directory: string, commandId: string): string {
  z.string().uuid().parse(commandId)
  const folder = join(directory, 'database-delivery-commands')
  if (!existsSync(folder)) mkdirSync(folder, { mode: 0o700 })
  if (!lstatSync(folder).isDirectory() || lstatSync(folder).isSymbolicLink() || realpathSync.native(folder) !== folder) conflict('Original command storage was redirected')
  const file = join(folder, commandId + '.json')
  if (existsSync(file) && (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink() || lstatSync(file).nlink !== 1)) conflict('Original command is not a single regular file')
  return file
}
/** The receipt lookup retains the original preparation owner instead of interpreting a command UUID as a preparation. */
export function readDatabaseDeliveryCommand(directory: string, commandId: string): z.infer<typeof savedSchema> | null {
  const file = commandFile(directory, commandId)
  if (!existsSync(file)) return null
  const saved = savedSchema.parse(JSON.parse(readBounded(file, 1024 * 1024)))
  if (saved.request.commandId !== commandId || saved.command.commandId !== commandId || saved.command.kind !== 'save-artifact'
    || saved.command.artifactKind !== 'check-report' || saved.command.artifactId !== saved.request.artifactId) conflict('Original capture command identity changed')
  return saved
}

/** Called by the existing authenticated native preparation facade for either product or editor ownership. */
export async function confirmDatabaseDelivery(input: {
  directory: string; binding: NativeTaskBinding; request: DatabaseDeliveryCaptureRequest; transport: TaskExecutionTransport
  assertPrepared(): void | Promise<void>
}): Promise<{ kind: 'database-delivery-capture'; ref: { kind: 'confirmed-artifact'; executionId: string; artifactId: string; versionId: string; bodyDigest: string } }> {
  const { binding, transport } = input, request = databaseDeliveryCaptureRequestSchema.parse(input.request), expected = binding.request.expected
  await input.assertPrepared()
  let saved = readDatabaseDeliveryCommand(input.directory, request.commandId)
  if (saved && (saved.command.kind !== 'save-artifact' || !equal(saved.request, request) || !equal(saved.command.task, binding.request.task)
    || saved.command.expectedExecutionId !== expected.executionId || saved.command.expectedGeneration !== expected.generation
    || saved.command.expectedNodeId !== expected.nodeId || saved.command.expectedAttempt !== expected.attempt)) conflict('Capture UUID belongs to a different original producer/selection')
  if (!saved) {
    const rule = binding.resources.find(item => item.resource.selection.source.kind === 'governance'
      && item.resource.selection.source.packageId === request.rule.packageId && item.resource.selection.source.versionId === request.rule.versionId
      && item.resource.bodyDigest === request.rule.bodyDigest)
    const material = binding.resources.find(item => item.resource.selection.id === request.implementationSelectionId)
    if (!rule?.path || !material || material.resource.selection.source.kind !== 'confirmed-document') conflict('Exact rule and implementation resource mappings are required')
    const descriptor = readDatabaseDeliveryDescriptor(readBounded(rule.path, 1024 * 1024))
    if (!descriptor) conflict('Selected fixed rule is not a supported database delivery descriptor')
    const captured = await captureDatabaseDeliveryEvidence({ binding, descriptor, rule: request.rule,
      implementation: { kind: 'confirmed-document', documentId: material.resource.selection.source.documentId,
        versionId: material.resource.selection.source.versionId, bodyDigest: material.resource.bodyDigest },
      implementationSelectionId: request.implementationSelectionId, files: request.files, ticket: request.ticket,
      source: request.files.length ? { kind: 'selected-files', files: request.files.map(item => item.ref) } : { kind: 'none' },
      assertPrepared: input.assertPrepared, readArtifact: async ref => { const value = await transport.artifact(ref); return { text: value.text, bodyDigest: value.artifact.bodyDigest } } })
    const text = taskInputCanonical(captured.evidence)
    saved = savedSchema.parse({ request, command: { contractVersion: 2, commandId: request.commandId, task: binding.request.task,
      expectedEpoch: binding.execution.epoch, expectedActorId: binding.request.pin.actorId, expectedDeviceId: binding.request.pin.deviceId,
      expectedExecutionId: expected.executionId, expectedGeneration: expected.generation, expectedNodeId: expected.nodeId, expectedAttempt: expected.attempt,
      kind: 'save-artifact', artifactId: request.artifactId, previousVersionId: null, artifactKind: 'check-report', title: 'Database delivery check',
      text, expectedDigest: hash(text), disposition: 'confirmed' } })
    await input.assertPrepared()
    const file = commandFile(input.directory, request.commandId)
    if (existsSync(file)) { if (!equal(readDatabaseDeliveryCommand(input.directory, request.commandId), saved)) conflict('Capture UUID was concurrently reused') }
    else writeExclusiveAtomic(file, JSON.stringify(saved))
  }
  const command = saved.command
  if (command.kind !== 'save-artifact') conflict('Original capture is not a check-report command')
  await input.assertPrepared()
  // Reconcile this exact persisted command before sending, including after acknowledgement loss.
  const receipt = await transport.reconcile(command) ?? (await transport.command(command)).result
  await input.assertPrepared()
  if (receipt.disposition !== 'confirmed' || !receipt.version || receipt.version.digest !== command.expectedDigest) conflict('Service did not confirm the original check-report bytes')
  const ref = { kind: 'confirmed-artifact' as const, executionId: expected.executionId, artifactId: request.artifactId,
    versionId: receipt.version.versionId, bodyDigest: command.expectedDigest }
  const artifact = await transport.artifact(ref)
  if (artifact.artifact.kind !== 'check-report' || artifact.text !== command.text) conflict('Confirmed check-report differs from the original evidence')
  return { kind: 'database-delivery-capture', ref }
}
