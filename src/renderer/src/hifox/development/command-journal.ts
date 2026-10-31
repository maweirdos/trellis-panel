import { z } from 'zod'
import { hifoxWorkChangeSchema, type HifoxWorkChangeInput } from '@shared/hifox-work'

const storageKey = 'tpanel.development.commands.v1'
const entrySchema = z.object({ sourceKey: z.string(), taskCreatedAt: z.string(), input: hifoxWorkChangeSchema,
  state: z.enum(['pending', 'unknown', 'settled']), at: z.number() }).strict()
export type DevelopmentCommand = z.infer<typeof entrySchema>
const running = new Set<string>()
let entries: DevelopmentCommand[] = []
try { entries = z.array(entrySchema).max(32).parse(JSON.parse(localStorage.getItem(storageKey) ?? '[]')) } catch { /* Unreadable metadata never supplies a replacement command. */ }

function save(): void {
  // This journal contains command identities and hashes only, never task/material bodies.
  localStorage.setItem(storageKey, JSON.stringify(entries))
}
export function retainedDevelopmentCommand(sourceKey: string, taskCreatedAt: string, taskId: string, commandId?: string | null): DevelopmentCommand | undefined {
  return [...entries].reverse().find((entry) => entry.sourceKey === sourceKey && entry.taskCreatedAt === taskCreatedAt && entry.input.taskId === taskId &&
    (commandId ? entry.input.commandId === commandId : entry.state !== 'settled'))
}
export function rememberDevelopmentCommand(sourceKey: string, taskCreatedAt: string, input: HifoxWorkChangeInput): DevelopmentCommand {
  const entry: DevelopmentCommand = { sourceKey, taskCreatedAt, input: hifoxWorkChangeSchema.parse(input), state: 'pending', at: Date.now() }
  const settled = entries.filter((item) => item.state === 'settled')
  while (entries.length >= 32 && settled.length) { const oldest = settled.shift(); entries = entries.filter((item) => item !== oldest) }
  if (entries.length >= 32) throw Error('仍有开发环境操作需要核对，请先处理原操作。')
  entries.push(entry)
  try { save() } catch { entries = entries.filter((item) => item !== entry); throw Error('无法保留原操作身份，尚未更换开发环境。请检查本机存储后重试。') }
  return entry
}
export function finishDevelopmentCommand(entry: DevelopmentCommand, unknown: boolean): void {
  entry.state = unknown ? 'unknown' : 'settled'
  try { save() } catch { /* The already-persisted pending entry remains recoverable. */ }
}
export function claimDevelopmentCommand(entry: DevelopmentCommand): boolean {
  if (running.has(entry.input.commandId)) return false
  running.add(entry.input.commandId)
  return true
}
export function releaseDevelopmentCommand(entry: DevelopmentCommand): void { running.delete(entry.input.commandId) }
