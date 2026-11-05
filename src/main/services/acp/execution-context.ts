import { createHash } from 'node:crypto'
import { executionContextPacketSchema, executionContextManifestSchema, type ExecutionContextManifest } from '../../../shared/team-execution-input'
import type { PreparedExecutionAgentRules } from '../agent-rules'
import { taskInputCanonical } from '../../../shared/team-task-inputs'
import { executionContextEnvelopeBytes } from '../execution-context-budget'

const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
export type ExecutionContextResource = { uri: string; mimeType: 'application/json'; text: string }
export function validateExecutionContextResource(resource: { uri: string; mimeType?: string; text: string }): ReturnType<typeof executionContextPacketSchema.parse> {
  const packet = validateExecutionContextPacket(resource.text)
  if (resource.mimeType !== 'application/json' || resource.uri !== `trellis://execution-input/${packet.executionId}/${encodeURIComponent(packet.node.id)}/${hash(resource.text)}`) throw new Error('Fixed context resource identity does not match its packet')
  const bytes = executionContextEnvelopeBytes(resource)
  if (bytes.acp > 8192 || bytes.pi > 8192) throw new Error('Serialized fixed-context resource envelope exceeds 8 KiB')
  return packet
}
/** Validates exactly the serialized packet that the native composers will receive. */
export function validateExecutionContextPacket(text: string): ReturnType<typeof executionContextPacketSchema.parse> {
  if (Buffer.byteLength(text, 'utf8') > 8192) throw new Error('Serialized fixed execution context exceeds 8 KiB')
  const packet = executionContextPacketSchema.parse(JSON.parse(text))
  if (JSON.stringify(packet) !== text) throw new Error('Fixed execution packet is not in its admitted serialized form')
  const ids = new Set<string>(), orders = new Set<number>()
  let previousOrder = -1
  for (const entry of packet.sources) {
    if (ids.has(entry.selection.id) || orders.has(entry.selection.order) || entry.selection.nodeId !== packet.node.id || entry.selection.phaseId !== packet.node.phaseId || entry.selection.stage !== packet.node.stage) throw new Error('Fixed source selection is duplicated or belongs to another node')
    ids.add(entry.selection.id); orders.add(entry.selection.order)
    if (entry.selection.order <= previousOrder) throw new Error('Fixed source receipt order differs from the selected order')
    previousOrder = entry.selection.order
    const included = entry.status === 'full' || entry.status === 'partial'
    if (entry.selection.required && entry.status !== 'full') throw new Error('Required fixed input was not delivered in full')
    if (included ? entry.text === null || hash(entry.text) !== entry.deliveredDigest || Buffer.byteLength(entry.text, 'utf8') !== entry.deliveredBytes || entry.text.length !== entry.deliveredChars
      : entry.text !== null || entry.deliveredDigest !== null || entry.deliveredBytes !== 0 || entry.deliveredChars !== 0) throw new Error('Fixed source delivery receipt does not match its actual bytes')
    if (entry.status === 'full' && (entry.sourceDigest !== entry.deliveredDigest || entry.sourceBytes !== entry.deliveredBytes)
      || entry.status === 'partial' && (entry.deliveredBytes === 0 || entry.deliveredBytes >= entry.sourceBytes)) throw new Error('Fixed source inclusion status is inaccurate')
  }
  return packet
}
export function composeExecutionContextResource(prepared: PreparedExecutionAgentRules): { resource: ExecutionContextResource; manifest: ExecutionContextManifest } {
  const packet = validateExecutionContextPacket(prepared.instructions), manifest = executionContextManifestSchema.parse(prepared.manifest)
  const instruction = JSON.stringify({ roleInstructions: packet.roleInstructions, node: packet.node })
  const resource = { uri: `trellis://execution-input/${packet.executionId}/${encodeURIComponent(packet.node.id)}/${manifest.packetDigest}`, mimeType: 'application/json' as const, text: prepared.instructions }
  validateExecutionContextResource(resource)
  if (manifest.packetDigest !== hash(prepared.instructions) || manifest.serializedBytes !== Buffer.byteLength(prepared.instructions, 'utf8') || manifest.inputDigest !== packet.inputDigest
    || manifest.nodeId !== packet.node.id || manifest.phaseId !== packet.node.phaseId || manifest.stage !== packet.node.stage
    || manifest.instructionDigest !== hash(instruction) || manifest.instructionBytes !== Buffer.byteLength(instruction, 'utf8')
    || taskInputCanonical(manifest.entries) !== taskInputCanonical(packet.sources.map(({ text: _text, ...entry }) => entry))
    || taskInputCanonical(manifest.envelopeBytes) !== taskInputCanonical(executionContextEnvelopeBytes(resource))) throw new Error('Prepared fixed context manifest does not match the native packet')
  return { resource, manifest }
}
/** Standard ACP embedded resource; negotiated support is mandatory before dispatch. */
export function composeAcpExecutionContext(prepared: PreparedExecutionAgentRules, embeddedContext: boolean): ReturnType<typeof composeExecutionContextResource> {
  if (embeddedContext !== true) throw new Error('Required embedded execution context capability is unavailable')
  return composeExecutionContextResource(prepared)
}
