import { z } from 'zod'
import { cutoverCommandSchema, cutoverCommandReplySchema, cutoverRecordSchema, canonicalCutoverJson, type CutoverCommand, type CutoverRecord, type CutoverReceipt, type CutoverScope } from '../../../shared/team-cutover'
import { importManifestSchema, importReceiptSchema, type ImportManifest, type ImportReceipt } from '../../../shared/team-import'
import { teamPageSchema } from '../../../shared/team-platform'
import { teamTaskIdentity, type TeamTaskRef } from '../../../shared/team-task-execution'
import type { TeamContentRequest } from '../../../shared/team-content-transport'
import { DesktopTeamError } from '../team-platform/types'
import { createHash } from 'node:crypto'

export const cutoverDigest = (value: unknown): string => createHash('sha256').update(canonicalCutoverJson(value)).digest('hex')
const same = (a: unknown, b: unknown): boolean => canonicalCutoverJson(a) === canonicalCutoverJson(b)
const mismatch = (): never => { throw new DesktopTeamError('CUTOVER_RECEIPT_MISMATCH', 'Cutover response differs from the original scope or command', true) }
export class CutoverTransport {
  constructor(private readonly request: TeamContentRequest) {}
  private base(projectId: string): string { return     '/api/projects/' + projectId + '/cutovers' }
  async read(scope: CutoverScope, operationId: string): Promise<CutoverRecord | null> {
    const query = new URLSearchParams({ instanceId: scope.instanceId, namespaceId: scope.namespaceId, operationId })
    const value = await this.request(this.base(scope.projectId) + '/workcopies/' + scope.workcopyDigest + '?' + query, cutoverRecordSchema.nullable())
    if (value && (!same(value.scope, scope) || value.operationId !== operationId)) mismatch()
    return value
  }
  async task(task: TeamTaskRef): Promise<CutoverRecord | null> {
    const query = new URLSearchParams({ instanceId: task.instanceId, spaceId: task.spaceId, taskCreatedAt: task.taskCreatedAt })
    const value = await this.request(this.base(task.projectId) + '/tasks/' + encodeURIComponent(task.taskId) + '?' + query, cutoverRecordSchema.nullable())
    if (value && (!value.manifest.tasks.some(t => teamTaskIdentity(t.task) === teamTaskIdentity(task)) || value.scope.instanceId !== task.instanceId || value.scope.projectId !== task.projectId)) mismatch()
    return value
  }
  private receipt(command: CutoverCommand, receipt: CutoverReceipt): void {
    const scope = { instanceId: command.instanceId, projectId: command.projectId, namespaceId: command.namespaceId, workcopyDigest: command.workcopyDigest }
    if (!same(receipt.scope, scope) || receipt.commandId !== command.commandId || receipt.operationId !== command.operationId || receipt.action !== command.action
      || receipt.epoch !== command.expectedEpoch || receipt.actorId !== command.expectedActorId || receipt.deviceId !== command.expectedDeviceId
      || receipt.requestDigest !== cutoverDigest(command) || receipt.revision !== command.expectedRevision + 1) mismatch()
  }
  async command(raw: CutoverCommand): Promise<CutoverReceipt> {
    const command = cutoverCommandSchema.parse(raw), reply = await this.request(this.base(command.projectId) + '/commands', cutoverCommandReplySchema, command)
    if (reply.commandId !== command.commandId) mismatch()
    this.receipt(command, reply.result); return reply.result
  }
  async reconcile(raw: CutoverCommand): Promise<CutoverReceipt | null> {
    const command = cutoverCommandSchema.parse(raw), reply = await this.request(this.base(command.projectId) + '/reconcile', cutoverCommandReplySchema.nullable(), command)
    if (!reply) return null
    if (reply.commandId !== command.commandId) mismatch()
    this.receipt(command, reply.result)
    return reply.result
  }
  async imported(command: Pick<Extract<CutoverCommand, { action: 'stage' }>, 'projectId' | 'namespaceId'> & { manifest: Pick<Extract<CutoverCommand, { action: 'stage' }>['manifest'], 'importId' | 'importManifestDigest'> }): Promise<{ manifest: ImportManifest; receipts: ImportReceipt[] }> {
    const schema = z.object({ manifest: importManifestSchema, manifestDigest: z.string(), receipts: teamPageSchema(importReceiptSchema) }).strict()
    const receipts: ImportReceipt[] = [], seen = new Set<string>(); let cursor: string | undefined
    for (;;) {
      const query = new URLSearchParams({ namespaceId: command.namespaceId, limit: '100', ...(cursor ? { cursor } : {}) })
      const batch = await this.request('/api/projects/' + command.projectId + '/imports/batches/' + command.manifest.importId + '?' + query, schema)
      if (batch.manifestDigest !== command.manifest.importManifestDigest || cutoverDigest(batch.manifest) !== batch.manifestDigest) mismatch()
      for (const receipt of batch.receipts.items) {
        if (receipt.projectId !== command.projectId || receipt.namespaceId !== command.namespaceId || receipt.importId !== command.manifest.importId) mismatch()
        receipts.push(receipt)
      }
      if (receipts.length > 4000) throw new DesktopTeamError('CUTOVER_LIMIT', 'Import receipt inventory exceeds the native cutover limit')
      if (!batch.receipts.nextCursor) return { manifest: batch.manifest, receipts }
      cursor = batch.receipts.nextCursor
      if (seen.has(cursor)) mismatch()
      seen.add(cursor)
    }
  }
}
