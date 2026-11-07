import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { governanceCommandSchema, governanceReceiptSchema, governanceRecoveryScopeSchema, type GovernanceCommand, type GovernanceRecoveryScope, type GovernanceReceipt } from '../../../../shared/team-governance'
import { taskInputCommandSchema, taskInputReceiptSchema, type TaskInputCommand, type TaskInputReceipt } from '../../../../shared/team-task-inputs'
import { teamCommandIdSchema } from '../../../../shared/team-platform'
import { readBoundedBytes, writeAtomic, writeExclusiveAtomic } from '../../../daemon/files'
import { resolveAuthorizedDocumentPath } from '../../documents/paths'
import { DesktopTeamError } from '../../team-platform/types'
import { governanceTextDigest, governanceTransportPinSchema, type GovernanceTransportPin } from '../../team-platform/governance-transport'

const rowSchema = z.object({ commandId: teamCommandIdSchema, scope: governanceRecoveryScopeSchema, digest: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().positive().max(2 * 1024 * 1024), createdAt: z.number().int().nonnegative(), state: z.enum(['pending', 'unknown', 'rejected', 'committed']), error: z.string().max(2000).nullable(), receipt: z.union([governanceReceiptSchema, taskInputReceiptSchema]).nullable() }).strict()
const indexSchema = z.object({ version: z.literal(1), pin: governanceTransportPinSchema, rows: z.array(rowSchema).max(512) }).strict()
const fileSchema = z.object({ pin: governanceTransportPinSchema, scope: governanceRecoveryScopeSchema, command: z.union([governanceCommandSchema, taskInputCommandSchema]), createdAt: z.number().int().nonnegative() }).strict()
export type GovernanceJournalRow = z.infer<typeof rowSchema>
export const governanceOwnerKey = (pin: GovernanceTransportPin): string => governanceTextDigest(JSON.stringify(pin))
const stable = (value: unknown): string => Array.isArray(value) ? '[' + value.map(stable).join(',') + ']' : value !== null && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable((value as Record<string, unknown>)[key])).join(',') + '}' : JSON.stringify(value)
const same = (a: unknown, b: unknown): boolean => stable(a) === stable(b)
const unavailable = (): never => { throw new DesktopTeamError('GOVERNANCE_JOURNAL_UNAVAILABLE', '规则原操作记录无法安全核对，原文件已保留，请恢复后核对。') }

export class GovernanceJournal {
  constructor(private readonly root: string, private readonly pin: GovernanceTransportPin) {}
  private path(name: string): string {
    const value = resolveAuthorizedDocumentPath(this.root, `crux-governance/${name}`)
    if (!value.ok) return unavailable()
    return value.absPath
  }
  private decode(path: string, limit: number): unknown {
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readBoundedBytes(path, limit))) }
    catch { return unavailable() }
  }
  read(): z.infer<typeof indexSchema> {
    const path = this.path(`${governanceOwnerKey(this.pin)}/journal.json`)
    if (!existsSync(path)) return { version: 1, pin: this.pin, rows: [] }
    const result = indexSchema.safeParse(this.decode(path, 4 * 1024 * 1024))
    if (!result.success || !same(result.data.pin, this.pin) || new Set(result.data.rows.map(row => row.commandId)).size !== result.data.rows.length) return unavailable()
    return result.data
  }
  private save(value: z.infer<typeof indexSchema>): void {
    const text = JSON.stringify(indexSchema.parse(value))
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) return unavailable()
    try { writeAtomic(this.path(`${governanceOwnerKey(this.pin)}/journal.json`), text) } catch { return unavailable() }
  }
  command(row: GovernanceJournalRow): GovernanceCommand | TaskInputCommand {
    const result = fileSchema.safeParse(this.decode(this.path(`commands/${teamCommandIdSchema.parse(row.commandId)}.json`), 2 * 1024 * 1024 + 16 * 1024))
    if (!result.success || !same(result.data.pin, this.pin) || !same(result.data.scope, row.scope) || result.data.command.commandId !== row.commandId || governanceTextDigest(JSON.stringify(result.data.command)) !== row.digest || Buffer.byteLength(JSON.stringify(result.data.command)) !== row.bytes) return unavailable()
    return row.scope.lane === 'inputs' ? taskInputCommandSchema.parse(result.data.command) : governanceCommandSchema.parse(result.data.command)
  }
  admit(scope: GovernanceRecoveryScope, command: GovernanceCommand | TaskInputCommand): { row: GovernanceJournalRow; existing: boolean } {
    const index = this.read(), digest = governanceTextDigest(JSON.stringify(command))
    const prior = index.rows.find(row => row.commandId === command.commandId)
    if (prior) {
      this.command(prior)
      if (prior.digest !== digest || !same(prior.scope, scope)) throw new DesktopTeamError('COMMAND_CONFLICT', '原操作编号不能换正文或任务。', prior.state === 'unknown')
      return { row: prior, existing: true }
    }
    const bytes = Buffer.byteLength(JSON.stringify(command))
    if (index.rows.length >= 512 || index.rows.filter(row => row.state !== 'committed').length >= 64 || index.rows.reduce((n, row) => n + row.bytes, bytes) > 64 * 1024 * 1024) throw new DesktopTeamError('CAPACITY_EXCEEDED', '本机原操作记录达到上限，请先核对未确认操作。')
    const path = this.path(`commands/${teamCommandIdSchema.parse(command.commandId)}.json`)
    const retained = existsSync(path)
    let createdAt = Date.now()
    if (retained) {
      const original = fileSchema.safeParse(this.decode(path, 2 * 1024 * 1024 + 16 * 1024))
      if (!original.success || !same(original.data.pin, this.pin) || !same(original.data.scope, scope) || governanceTextDigest(JSON.stringify(original.data.command)) !== digest) throw new DesktopTeamError('COMMAND_CONFLICT', '此编号已有固定原操作，请回原来源核对。', true)
      createdAt = original.data.createdAt
    } else {
      try { mkdirSync(dirname(path), { recursive: true }); writeExclusiveAtomic(path, JSON.stringify(fileSchema.parse({ pin: this.pin, scope, command, createdAt }))) } catch { return unavailable() }
    }
    const row: GovernanceJournalRow = { commandId: command.commandId, scope, digest, bytes, createdAt, state: retained ? 'unknown' : 'pending', error: null, receipt: null }
    index.rows.push(row); this.save(index)
    return { row, existing: retained }
  }
  find(scope: GovernanceRecoveryScope, commandId: string): GovernanceJournalRow {
    const row = this.read().rows.find(item => item.commandId === commandId && same(item.scope, scope))
    if (!row) throw new DesktopTeamError('NOT_FOUND', '原身份和任务下没有此操作。')
    this.command(row)
    return row
  }
  update(row: GovernanceJournalRow, change: Partial<Pick<GovernanceJournalRow, 'state' | 'error' | 'receipt'>>): void {
    const index = this.read(), found = index.rows.find(item => item.commandId === row.commandId)
    if (!found || found.digest !== row.digest || !same(found.scope, row.scope)) return unavailable()
    Object.assign(found, change)
    if ((found.state === 'committed') !== (found.receipt !== null)) return unavailable()
    this.save(index)
  }
  settle(row: GovernanceJournalRow, receipt: GovernanceReceipt | TaskInputReceipt): void { this.update(row, { state: 'committed', receipt, error: null }) }
}
