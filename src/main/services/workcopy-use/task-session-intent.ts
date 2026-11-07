import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { processOwnerSchema } from '../../../shared/daemon'
import { teamTaskRulesContextSchema } from '../../../shared/agent-rules'
import { cruxProgressSessionSchema, type CruxProgressSession } from '../../../shared/crux-task-progress'
import { DaemonError } from '../../daemon/errors'
import { processIdentity } from '../../daemon/native'
import { readBounded, writeAtomic } from '../../daemon/files'
import { resolveWorkcopy } from './identity'

export const taskSessionExpectedSchema = z.object({ engine: z.enum(['pi', 'acp']), taskDir: z.string().min(1).max(200).optional(), task: teamTaskRulesContextSchema.optional() }).strict()
export type TaskSessionExpected = z.infer<typeof taskSessionExpectedSchema>
const intentSchema = z.object({ version: z.literal(1), scheme: z.literal('native-jobs-v1'), root: z.string().min(1).max(4096),
  alias: z.string().min(1).max(200), nonce: z.string().uuid(), generation: z.string().uuid(), identityId: z.string().length(64),
  host: processOwnerSchema, expected: taskSessionExpectedSchema, phase: z.enum(['reserved', 'creating', 'created', 'cleaned']),
  nativeBoundary: z.enum(['not-entered', 'entered']), settledOutcome: z.enum(['not-created', 'cleaned']).optional(),
  prompt: z.enum(['not-sent', 'dispatching', 'sent']), session: cruxProgressSessionSchema.optional() }).strict()
export type TaskSessionIntent = z.infer<typeof intentSchema>
const rootKey = (root: string): string => resolve(root).toLowerCase()
function file(directory: string, root: string, alias: string): string {
  z.string().min(1).max(200).regex(/^[\w.-]+$/).parse(alias)
  return join(directory, 'acp-task-intents', `${createHash('sha256').update(JSON.stringify([rootKey(root), alias])).digest('hex')}.json`)
}
export function readTaskSessionIntent(directory: string, root: string, alias: string, expected?: TaskSessionExpected): TaskSessionIntent | undefined {
  const path = file(directory, root, alias)
  if (!existsSync(path)) return undefined
  const value = intentSchema.parse(JSON.parse(readBounded(path, 64 * 1024)))
  if (rootKey(value.root) !== rootKey(root) || value.alias !== alias || expected && JSON.stringify(value.expected) !== JSON.stringify(taskSessionExpectedSchema.parse(expected))) throw new DaemonError('E_DENIED', '原任务创建意图与固定任务元数据不匹配。')
  return value
}
export function saveTaskSessionIntent(directory: string, value: TaskSessionIntent): void {
  writeAtomic(file(directory, value.root, value.alias), JSON.stringify(intentSchema.parse(value)))
}
/** Fresh native aliases only. This must precede any call that can create an engine. */
export async function reserveTaskSessionIntent(directory: string, root: string, alias: string, expected: TaskSessionExpected): Promise<TaskSessionIntent> {
  const previous = readTaskSessionIntent(directory, root, alias, expected)
  if (previous) return previous
  const host = await processIdentity(process.pid)
  if (!host) throw new DaemonError('E_UNAVAILABLE', '原任务创建所有者无法核对。')
  const raced = readTaskSessionIntent(directory, root, alias, expected)
  if (raced) return raced
  const value: TaskSessionIntent = { version: 1, scheme: 'native-jobs-v1', root, alias, nonce: randomUUID(), generation: randomUUID(),
    identityId: resolveWorkcopy(root).id, host, expected: taskSessionExpectedSchema.parse(expected), phase: 'reserved', nativeBoundary: 'not-entered', prompt: 'not-sent' }
  saveTaskSessionIntent(directory, value)
  return value
}
export function claimTaskSessionIntent(directory: string, root: string, alias: string, expected: TaskSessionExpected): TaskSessionIntent {
  const value = readTaskSessionIntent(directory, root, alias, expected)
  if (!value || value.phase !== 'reserved' || value.identityId !== resolveWorkcopy(root).id) throw new DaemonError('E_CONFLICT', '原任务创建意图已执行、被收束或副本已变化；请核对原 alias，不能重复创建。')
  const next = { ...value, phase: 'creating' as const }; saveTaskSessionIntent(directory, next); return next
}
export function completeTaskSessionIntent(directory: string, root: string, alias: string, session: CruxProgressSession): void {
  const value = readTaskSessionIntent(directory, root, alias)
  if (!value || value.phase !== 'creating' || session.connectionGeneration !== value.generation) throw new DaemonError('E_CONFLICT', '原任务创建回执与意图代次不匹配。')
  saveTaskSessionIntent(directory, { ...value, phase: 'created', session })
}
export function enterTaskSessionNativeBoundary(directory: string, root: string, alias: string): void {
  const value = readTaskSessionIntent(directory, root, alias)
  if (!value || value.phase !== 'creating') throw new DaemonError('E_CONFLICT', '原任务创建意图已被收束，未进入外部执行。')
  saveTaskSessionIntent(directory, { ...value, nativeBoundary: 'entered' })
}
export function markTaskSessionPrompt(directory: string, root: string, alias: string, sent: boolean): void {
  const value = readTaskSessionIntent(directory, root, alias)
  if (!value) return // Old ordinary/legacy readers never acquire a new intent here.
  if (value.phase === 'cleaned' || value.phase === 'reserved') throw new DaemonError('E_CONFLICT', '原任务创建意图未完成或已被收束，未发送新内容。')
  saveTaskSessionIntent(directory, { ...value, prompt: value.prompt === 'sent' || sent ? 'sent' : 'dispatching' })
}
