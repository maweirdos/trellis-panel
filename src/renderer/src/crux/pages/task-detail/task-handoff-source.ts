import type { CruxTask, CruxTaskInput } from '@shared/crux'
import type { CruxWorkspaceContext } from '@shared/crux-remote'
import { z } from 'zod'
import { cruxMutationInputSchemas } from '@shared/crux-domain/commands'

const materialSchema = z.object({ title: z.string().max(300), body: z.string().max(1024 * 1024), versionLabel: z.string().max(300) })
const intentSchema = z.object({
  input: cruxMutationInputSchemas.createTask,
  material: materialSchema.optional()
})
export const taskHandoffSourceSchema = z.object({
  fileChoices: z.array(z.object({ fileId: z.string().max(256), name: z.string().min(1).max(500),
    bytes: z.number().int().nonnegative(), revision: z.string().regex(/^[a-f0-9]{64}$/),
    sourceIdentity: z.string().regex(/^[a-f0-9]{64}$/).optional(), selected: z.boolean(), pinned: z.boolean().optional() })).optional(),
  id: z.string().uuid(), title: z.string().max(300), description: z.string().max(1024 * 1024),
  conversationId: z.string().max(256).optional(), creatorId: z.string().max(256).optional(), draftId: z.string().max(256).optional(),
  attachByDefault: z.boolean().optional(), material: materialSchema.optional()
}).strict()
export type TaskHandoffSource = z.infer<typeof taskHandoffSourceSchema>
const createFields = cruxMutationInputSchemas.createTask.shape
const fieldsSchema = z.object({
  selectedFileIds: z.array(z.string().max(256)).max(8).optional(),
  title: z.string().max(1024 * 1024), description: z.string().max(1024 * 1024), shareMaterial: z.boolean(), criteria: z.string().max(1024 * 1024),
  workKind: createFields.workKind.unwrap(), staged: z.boolean().optional(), typeId: z.string(), priority: createFields.priority.unwrap(),
  allocation: z.object({ assigneeIds: z.array(z.string()).max(2000), executor: createFields.executor.unwrap() }),
  labelIds: z.array(z.string()).max(2000), projectId: z.string(), iterationId: z.string(), parentTaskId: z.string(), creationIntent: z.enum(['triage', 'schedule'])
}).strict()
export type TaskHandoffFields = z.infer<typeof fieldsSchema>
const recoverySchema = z.object({
  version: z.literal(1), authority: z.string().max(2048), authorityIdentity: z.string().max(256), source: taskHandoffSourceSchema, spaceId: z.string().min(1),
  fields: z.record(z.string(), fieldsSchema), intent: intentSchema.optional()
}).strict()
export type TaskHandoffRecovery = z.infer<typeof recoverySchema>
const RECOVERY_PREFIX = 'tpanel.taskHandoffRecovery:'
const MAX_RECOVERIES = 32
const MAX_RECOVERY_BYTES = 4 * 1024 * 1024
const recoveryKey = (source: TaskHandoffSource): string => RECOVERY_PREFIX + JSON.stringify(source.conversationId && source.creatorId
  ? [source.creatorId, source.conversationId, source.draftId ?? null] : [source.id])

/** Recovery data selects an original intent; it never grants current team access. */
export function readTaskHandoffRecovery(source: TaskHandoffSource): TaskHandoffRecovery | null {
  try {
    const raw = localStorage.getItem(recoveryKey(source))
    if (!raw) return null
    if (new TextEncoder().encode(raw).byteLength > MAX_RECOVERY_BYTES) throw Error('恢复记录超过容量限制。')
    const value = recoverySchema.parse(JSON.parse(raw))
    if (recoveryKey(value.source) !== recoveryKey(source) || value.intent && (value.intent.input.handoff?.id !== value.source.id || value.intent.input.spaceId !== value.spaceId || value.intent.input.creatorId !== value.authorityIdentity)) throw Error('恢复记录与原交接不匹配。')
    if (!value.intent && value.source.id !== source.id) return null
    return value
  } catch { throw Error('无法读取原交接恢复记录，请保留原稿并检查本机存储；尚未创建新任务。') }
}

function writeRecovery(value: TaskHandoffRecovery): void {
  const parsed = recoverySchema.parse(value), key = recoveryKey(parsed.source), body = JSON.stringify(parsed)
  let count = 1, bytes = new TextEncoder().encode(body).byteLength
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const candidate = localStorage.key(index)
      if (!candidate?.startsWith(RECOVERY_PREFIX) || candidate === key) continue
      count++; bytes += new TextEncoder().encode(localStorage.getItem(candidate) ?? '').byteLength
    }
    if (count > MAX_RECOVERIES || bytes > MAX_RECOVERY_BYTES) throw Error('CAPACITY')
    localStorage.setItem(key, body)
    if (localStorage.getItem(key) !== body) throw Error('VERIFY')
  } catch { throw Error('交接草稿未能保存：存储不可用或容量已满。请保留当前内容并重试，旧交接不会被自动删除。') }
}

export function saveTaskHandoffRecovery(source: TaskHandoffSource, authority: string, actorId: string, spaceId: string, fields?: TaskHandoffFields): TaskHandoffRecovery {
  const original = readTaskHandoffRecovery(source)
  if (original && original.authority !== authority) throw Error('请恢复原账号和工作区后继续原交接。')
  if (original && original.authorityIdentity !== actorId) throw Error('请恢复原创建者后继续原交接。')
  if (original?.intent && original.spaceId !== spaceId) throw Error('已提交的交接不能更换目标空间。')
  const value: TaskHandoffRecovery = original ?? { version: 1, authority, authorityIdentity: actorId, source: taskHandoffSourceSchema.parse(source), spaceId, fields: {} }
  value.spaceId = spaceId
  if (fields) value.fields[spaceId] = fieldsSchema.parse(fields)
  writeRecovery(value)
  return value
}

export function clearTaskHandoffFields(context: CruxWorkspaceContext, source: TaskHandoffSource, authority: string, actorId: string): void {
  const original = readTaskHandoffRecovery(source)
  if (!original) return
  if (original.authority !== authority) throw Error('不能清除其他账号或工作区的交接。')
  if (original.authorityIdentity !== actorId || context.actorId !== actorId) throw Error('不能清除其他账号或工作区的交接。')
  if (original.intent || readTaskHandoffIntent(context, original.source.id)) throw Error('原交接已提交，请继续核对创建结果。')
  localStorage.removeItem(intentKey(context, original.source.id))
  localStorage.removeItem(recoveryKey(source))
}
/** A fully acknowledged task and material receipt is no longer an unsent handoff. */
export function clearTaskHandoffRecovery(context: CruxWorkspaceContext, source: TaskHandoffSource, authority: string, actorId: string): void {
  const original = readTaskHandoffRecovery(source)
  if (!original) return
  if (original.authority !== authority) throw Error('不能清除其他账号或工作区的交接。')
  if (original.authorityIdentity !== actorId) throw Error('不能清除其他账号或工作区的交接。')
  localStorage.removeItem(recoveryKey(source))
  localStorage.removeItem(intentKey(context, source.id))
}
export type TaskHandoffIntent = { input: CruxTaskInput; material?: { title: string; body: string; versionLabel: string } }
const intentKey = (context: CruxWorkspaceContext, id: string): string =>
  'crux.taskHandoffIntent:' + JSON.stringify([context.instanceId, context.projectId, context.epoch, context.actorId, id])

export function readTaskHandoffIntent(context: CruxWorkspaceContext, id: string): TaskHandoffIntent | null {
  try {
    const raw = localStorage.getItem(intentKey(context, id))
    return raw ? intentSchema.parse(JSON.parse(raw)) : null
  } catch {
    throw Error('原创建记录不可读取，请保留原稿并检查本机存储。')
  }
}

export function saveTaskHandoffIntent(context: CruxWorkspaceContext, id: string, intent: TaskHandoffIntent, source?: TaskHandoffSource): void {
  const parsed = intentSchema.parse(intent)
  if (!source) throw Error('原交接恢复记录尚未保存，不能提交。')
  const recovery = readTaskHandoffRecovery(source)
  if (!recovery || recovery.source.id !== id || recovery.spaceId !== parsed.input.spaceId || parsed.input.creatorId !== context.actorId || recovery.authorityIdentity !== context.actorId) throw Error('原交接恢复记录尚未保存，不能提交。')
  writeRecovery({ ...recovery, intent: parsed })
}

function sourceKey(context: CruxWorkspaceContext, task: CruxTask): string | undefined {
  if (context.state === 'access-revoked' || context.actorId !== task.creatorId || !task.handoff) return
  return 'crux.taskHandoffSource:' + JSON.stringify([context.instanceId, context.projectId, context.epoch, context.actorId, task.id, task.createdAt, task.handoff.id])
}

export function rememberTaskHandoffSource(context: CruxWorkspaceContext, task: CruxTask, conversationId: string, creatorId?: string): void {
  const key = sourceKey(context, task)
  if (key) localStorage.setItem(key, JSON.stringify({ conversationId, creatorId }))
}

export function readTaskHandoffSource(context: CruxWorkspaceContext, task: CruxTask): { conversationId: string; creatorId?: string } | null {
  const key = sourceKey(context, task)
  try {
    const raw = key ? localStorage.getItem(key) : null
    return raw ? z.object({ conversationId: z.string(), creatorId: z.string().optional() }).parse(JSON.parse(raw)) : null
  } catch { return null }
}
