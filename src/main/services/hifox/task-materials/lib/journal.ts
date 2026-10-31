import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { readBoundedBytes, writeAtomic, writeExclusiveAtomic } from '../../../../daemon/files'
import { resolveAuthorizedDocumentPath } from '../../../documents/paths'
import { DesktopTeamError } from '../../../team-platform/types'
import { taskMaterialTextDigest, validateTaskMaterialCommand, validateTaskMaterialReceipt } from '../../../team-platform/task-materials-transport'
import { materialCommandFileSchema, materialJournalSchema, type MaterialJournal, type MaterialJournalRow, type MaterialOwner } from '../types'
import type { TeamTaskMaterialCommand, TeamTaskMaterialReceipt } from '../../../../../shared/team-task-materials'
import { teamCommandIdSchema, TEAM_MAX_REQUEST_BYTES } from '../../../../../shared/team-platform'

const MAX_INDEX_BYTES = 4 * 1024 * 1024
const MAX_COMMAND_BYTES = TEAM_MAX_REQUEST_BYTES + 16 * 1024
const MAX_BODY_BYTES = 64 * 1024 * 1024
const unavailable = (): never => { throw new DesktopTeamError('MATERIAL_JOURNAL_UNAVAILABLE', '材料原命令记录无法安全读取或保存，请保留文件后核对；未重置记录。') }
export const materialOwnerKey = (owner: MaterialOwner): string => taskMaterialTextDigest(JSON.stringify(owner.pin))
export const materialCommandDigest = (command: TeamTaskMaterialCommand): string => taskMaterialTextDigest(JSON.stringify(command))

/** One immutable full command file plus bounded metadata. No body in the 1-MiB material reader or renderer storage. */
export class MaterialJournalStore {
  constructor(private readonly root: string, private readonly owner: MaterialOwner) {}
  private path(name: string): string {
    const value = resolveAuthorizedDocumentPath(this.root, `hifox-task-materials/${materialOwnerKey(this.owner)}/${name}`)
    if (!value.ok) return unavailable()
    return value.absPath
  }
  private commandPath(commandId: string): string {
    const value = resolveAuthorizedDocumentPath(this.root, `hifox-task-materials/commands/${teamCommandIdSchema.parse(commandId)}.json`)
    if (!value.ok) return unavailable()
    return value.absPath
  }
  private decode(path: string, limit: number): unknown {
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readBoundedBytes(path, limit))) }
    catch { return unavailable() }
  }
  read(): MaterialJournal {
    const path = this.path('journal.json')
    if (!existsSync(path)) return { version: 1, pin: this.owner.pin, rows: [] }
    const parsed = materialJournalSchema.safeParse(this.decode(path, MAX_INDEX_BYTES))
    if (!parsed.success || JSON.stringify(parsed.data.pin) !== JSON.stringify(this.owner.pin)) return unavailable()
    if (new Set(parsed.data.rows.map(row => row.commandId)).size !== parsed.data.rows.length) return unavailable()
    return parsed.data
  }
  private save(journal: MaterialJournal): void {
    const value = materialJournalSchema.safeParse(journal)
    if (!value.success) return unavailable()
    const text = JSON.stringify(value.data)
    if (Buffer.byteLength(text, 'utf8') > MAX_INDEX_BYTES) return unavailable()
    try { writeAtomic(this.path('journal.json'), text) } catch { return unavailable() }
  }
  command(row: MaterialJournalRow): TeamTaskMaterialCommand {
    const id = teamCommandIdSchema.parse(row.commandId)
    const result = materialCommandFileSchema.safeParse(this.decode(this.commandPath(id), MAX_COMMAND_BYTES))
    if (!result.success || JSON.stringify(result.data.pin) !== JSON.stringify(this.owner.pin)
      || result.data.command.commandId !== id || materialCommandDigest(result.data.command) !== row.commandDigest
      || Buffer.byteLength(JSON.stringify(result.data.command), 'utf8') !== row.commandBytes) return unavailable()
    const command = validateTaskMaterialCommand(this.owner.pin, result.data.command)
    if (row.action !== command.action || row.documentId !== ('documentId' in command ? command.documentId : null)) return unavailable()
    if (row.receipt) validateTaskMaterialReceipt(this.owner.pin, command, row.receipt)
    if ((row.state === 'committed') !== (row.receipt !== null)) return unavailable()
    return command
  }
  admit(raw: TeamTaskMaterialCommand): { row: MaterialJournalRow; existing: boolean } {
    const command = validateTaskMaterialCommand(this.owner.pin, raw)
    const journal = this.read(), commandDigest = materialCommandDigest(command)
    const previous = journal.rows.find(row => row.commandId === command.commandId)
    if (previous) {
      this.command(previous)
      if (previous.commandDigest !== commandDigest) throw new DesktopTeamError('COMMAND_CONFLICT', '相同命令编号不能换正文或目标，请核对原操作。', previous.outcomeUnknown)
      return { row: previous, existing: true }
    }
    const commandBytes = Buffer.byteLength(JSON.stringify(command), 'utf8')
    if (journal.rows.length >= 512 || journal.rows.filter(row => row.state === 'pending' || row.state === 'unknown').length >= 64
      || journal.rows.reduce((bytes, row) => bytes + row.commandBytes, commandBytes) > MAX_BODY_BYTES) {
      throw new DesktopTeamError('MATERIAL_JOURNAL_CAPACITY', '此任务的本机材料记录已达容量限制；原命令均保留，当前未发送新操作。')
    }
    const commandPath = this.commandPath(command.commandId)
    let createdAt = Date.now()
    const retained = existsSync(commandPath)
    if (retained) {
      // Missing metadata cannot prove that the immutable command was never sent.
      const orphan = materialCommandFileSchema.safeParse(this.decode(commandPath, MAX_COMMAND_BYTES))
      if (!orphan.success) return unavailable()
      if (JSON.stringify(orphan.data.pin) !== JSON.stringify(this.owner.pin)) throw new DesktopTeamError('BINDING_CHANGED', '该命令编号已固定到原账号、设备及任务，不能改投。')
      if (materialCommandDigest(orphan.data.command) !== commandDigest) throw new DesktopTeamError('COMMAND_CONFLICT', '原命令正文已经保留，不能用相同编号替换。')
      createdAt = orphan.data.createdAt
    } else {
      const body = JSON.stringify(materialCommandFileSchema.parse({ version: 1, pin: this.owner.pin, generation: this.owner.generation, createdAt, command }))
      if (Buffer.byteLength(body, 'utf8') > MAX_COMMAND_BYTES) return unavailable()
      try { mkdirSync(dirname(commandPath), { recursive: true }); writeExclusiveAtomic(this.commandPath(command.commandId), body) } catch { return unavailable() }
    }
    const row: MaterialJournalRow = { commandId: command.commandId, action: command.action, documentId: 'documentId' in command ? command.documentId : null,
      commandDigest, commandBytes, state: retained ? 'unknown' : 'pending', createdAt, errorCode: null, error: null, outcomeUnknown: retained, receipt: null }
    journal.rows.push(row)
    this.save(journal)
    this.command(row)
    return { row, existing: retained }
  }
  find(commandId: string): MaterialJournalRow {
    const row = this.read().rows.find(item => item.commandId === commandId)
    if (!row) throw new DesktopTeamError('NOT_FOUND', '当前原身份与任务下没有这条材料命令。')
    this.command(row)
    return row
  }
  update(commandId: string, change: Partial<Pick<MaterialJournalRow, 'state' | 'errorCode' | 'error' | 'outcomeUnknown' | 'receipt'>>): MaterialJournalRow {
    const journal = this.read(), row = journal.rows.find(item => item.commandId === commandId)
    if (!row) return unavailable()
    Object.assign(row, change)
    this.command(row)
    this.save(journal)
    return row
  }
  settle(commandId: string, receipt: TeamTaskMaterialReceipt): void {
    const row = this.find(commandId)
    validateTaskMaterialReceipt(this.owner.pin, this.command(row), receipt)
    this.update(commandId, { state: 'committed', receipt, outcomeUnknown: false, errorCode: null, error: null })
  }
}
