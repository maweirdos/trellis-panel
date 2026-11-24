import { join } from 'node:path'
import { z } from 'zod'
import { taskProgressPinSchema } from '../../../shared/crux-task-progress-native'
import type { TaskPlanningRuntimeIdentity } from '../../../shared/conversation/task-planning-runtime'
import { taskPlanningRuntimeSelection } from '../../../shared/conversation/task-planning-runtime'
import { taskInputCanonical } from '../../../shared/team-task-inputs'
import { teamTaskMaterialCommandSchema, teamTaskMaterialReceiptSchema } from '../../../shared/team-task-materials'
import { DaemonError } from '../../daemon/errors'
import { NativeTaskProgressSender } from '../crux/task-progress-sender'
import { cruxWorkProjectIdentity, inspectCruxWorkExecutionProject } from '../crux/work-project'
import { checkedDirectory, hash, pathKey, readRegular } from '../private-conversations/files'
import { assertTaskPlanningSource, taskPlanningSourceSchema } from './source'

export const planningIntentDirectory = 'task-planning-v2'
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const selectionSchema = z.object({ connectionId: z.string().uuid() }).strict()
export const planningIntentSchema = z.object({
  version: z.literal(2),
  planningId: z.string().uuid(),
  commandId: z.string().uuid(),
  selection: taskPlanningRuntimeSelection,
  teamSelection: digest,
  prepareDigest: digest,
  source: taskPlanningSourceSchema,
  assignmentGeneration: z.number().int().positive().safe(),
  authorizationRevision: z.number().int().nonnegative().safe(),
  started: z.boolean(),
  stopCommandId: z.string().uuid().nullable(),
  cleanupConfirmed: z.boolean(),
  candidate: z.object({ revision: digest, title: z.string(), markdown: z.string() }).strict().nullable(),
  save: z.object({ candidateRevision: digest, command: teamTaskMaterialCommandSchema,
    receipt: teamTaskMaterialReceiptSchema.nullable(), error: z.string().nullable() }).strict().nullable(),
  createdAt: z.number().int().nonnegative(),
}).strict()

export type PlanningIntent = z.infer<typeof planningIntentSchema>

export function planningTeamSelection(profile: string, connectionId: string): string {
  const file = readRegular(profile, 'crux-remote/selection.json', 4096)
  if (selectionSchema.parse(JSON.parse(file.bytes.toString('utf8'))).connectionId !== connectionId) {
    throw new DaemonError('E_DENIED', '原规划的团队连接已切换。')
  }
  return hash(JSON.stringify([file.fileIdentity, hash(file.bytes)]))
}

export function readPlanningIntent(profile: string, planningId: string): { record: PlanningIntent; revision: string } {
  const id = z.string().uuid().parse(planningId)
  const bytes = readRegular(checkedDirectory(profile), `${planningIntentDirectory}/${id}.json`, 3 * 1024 * 1024).bytes
  const record = planningIntentSchema.parse(JSON.parse(bytes.toString('utf8')))
  if (record.planningId !== id) throw new DaemonError('E_CONFLICT', '原规划记录身份不一致。')
  return { record, revision: hash(bytes) }
}

export function taskPlanningLaunchText(record: PlanningIntent): string {
  const { source, commandId } = record
  const text = [
    '仅就固定资料进行只读技术规划。禁止修改文件、启动实施、请求扩大权限或替用户确认业务动作。',
    '输出一份可审阅的完整 Markdown 技术方案，包含范围、步骤、交付物、依赖、风险和验证方式。对缺失资料明确列出待确认问题。',
    '只依据下方已提供的固定材料，不访问工程目录或外部来源。证据不足时说明缺少哪些资料以及会影响哪些判断。方案由用户另行采用并批准。',
    taskInputCanonical({ commandId, task: source.task, title: source.title, description: source.description,
      acceptanceCriteria: source.acceptanceCriteria, adoptedInput: source.inputBundle, documents: source.documents,
      engineeringSources: source.observations, ...(source.attachments ? { attachments: source.attachments } : {}) }),
  ].join('\n\n')
  if (text.length > 120_000) throw new DaemonError('E_INVALID_ARG', '完整规划输入超过消息上限，请缩小资料范围。')
  return text
}

function planningSender(profile: string, source: PlanningIntent['source']): NativeTaskProgressSender {
  const { pin, task } = source
  return new NativeTaskProgressSender(join(profile, 'team-platform'), taskProgressPinSchema.parse({
    workspaceKey: pin.workspaceKey, taskId: task.taskId, spaceId: task.spaceId, handlerId: pin.actorId,
    connectionId: pin.connectionId, origin: pin.origin, pairingId: pin.pairingId, ownerId: pin.actorId,
    deviceId: pin.deviceId, projectId: pin.projectId, epoch: pin.epoch, instanceId: pin.instanceId,
  }))
}

export async function assertPlanningCleanupAccess(profile: string, record: PlanningIntent, guard: () => void): Promise<void> {
  guard()
  await planningSender(profile, record.source).snapshot()
  guard()
}

export async function assertPlanningReadAccess(profile: string, record: PlanningIntent, guard: () => void) {
  const { source } = record
  const { pin, task } = source
  const assertSelection = (): void => {
    guard()
    if (planningTeamSelection(profile, pin.connectionId) !== record.teamSelection) {
      throw new DaemonError('E_DENIED', '原规划的团队会话代次已变化。')
    }
  }
  assertSelection()
  const { context, assertCredential } = await planningSender(profile, source).taskConversationContext()
  const assertReadCurrent = (): void => {
    assertSelection()
    assertCredential()
    if (cruxWorkProjectIdentity(source.root) !== source.directoryIdentity) {
      throw new DaemonError('E_CONFLICT', '原规划工程的物理目录已变化。')
    }
  }
  assertReadCurrent()
  const packet = context.snapshot
  const current = packet.snapshot.tasks.find(item => item.id === task.taskId && item.createdAt === task.taskCreatedAt && item.spaceId === task.spaceId)
  const space = packet.snapshot.spaces.find(item => item.id === task.spaceId)
  if (!current || current.workKind !== 'code' || (current.workflow?.handlerId ?? current.assigneeIds[0]) !== pin.actorId
    || current.assigneeGeneration !== record.assignmentGeneration || context.inputs.taskCreatedAt !== task.taskCreatedAt
    || !space || space.archived || !space.memberIds.includes(pin.actorId)) {
    throw new DaemonError('E_DENIED', '当前成员无法读取原代次的任务规划。')
  }
  return { context, current, assertReadCurrent }
}

export async function resolveTaskPlanningLaunch(
  profile: string, input: TaskPlanningRuntimeIdentity & { stopCommandId?: string }, nativeOwnerId: string, guard: () => void, mode: 'launch' | 'observe' | 'stop',
) {
  guard()
  const { record } = readPlanningIntent(profile, input.planningId)
  const { source, selection, planningId, commandId } = record
  const { pin, task } = source
  if (!record.started || commandId !== input.commandId || source.digest !== input.sourceDigest
    || mode === 'stop' && (!record.stopCommandId || record.stopCommandId !== input.stopCommandId)) {
    throw new DaemonError('E_DENIED', '操作不属于原规划及命令。')
  }
  const cwd = source.root
  let assertPreviouslyRead = guard
  function assertSpawnCurrent(): void {
    assertPreviouslyRead()
    const latest = readPlanningIntent(profile, planningId).record
    if (latest.commandId !== commandId || latest.stopCommandId || latest.cleanupConfirmed || latest.source.digest !== input.sourceDigest) {
      throw new DaemonError('E_DENIED', '原规划已经停止或固定来源发生变化。')
    }
    assertTaskPlanningSource(source)
  }
  async function assertCurrent(): Promise<void> {
    assertSpawnCurrent()
    const { context, current, assertReadCurrent } = await assertPlanningReadAccess(profile, record, guard)
    if (current.workflow?.stage !== 'planning' || current.updatedAt !== source.taskUpdatedAt
      || context.snapshot.authorizationRevision !== record.authorizationRevision
      || context.inputs.admission.status !== 'ready' || taskInputCanonical(context.inputs.current) !== taskInputCanonical(source.inputBundle)
      || taskInputCanonical(context.codeResource.selection) !== source.resourceSelection
      || taskInputCanonical(context.codeResource.resource) !== taskInputCanonical(source.resource)) {
      throw new DaemonError('E_DENIED', '原规划任务、处理人或固定材料已变化。')
    }
    const project = await inspectCruxWorkExecutionProject(cwd, source.resource ?? undefined)
    if (!project.resourceMatched || taskInputCanonical(project.git) !== source.repository) {
      throw new DaemonError('E_CONFLICT', '原规划工程的仓库或修订已变化。')
    }
    assertPreviouslyRead = assertReadCurrent
    assertSpawnCurrent()
  }
  if (mode === 'launch') await assertCurrent()
  if (mode === 'observe') {
    const { assertReadCurrent } = await assertPlanningReadAccess(profile, record, guard)
    assertPreviouslyRead = assertReadCurrent
  }
  assertPreviouslyRead()
  const authority = {
    cwd, ownerId: nativeOwnerId, spaceId: pin.projectId,
    projectId: hash(taskInputCanonical(['task-planning-v2', nativeOwnerId, planningId, pin, task, record.assignmentGeneration, source.digest, pathKey(cwd), source.directoryIdentity])),
    binding: { kind: 'planning' as const, planningId, taskId: task.taskId, taskCreatedAt: task.taskCreatedAt,
      assigneeGeneration: record.assignmentGeneration, materialRevision: source.digest },
    assertCurrent, assertSpawnCurrent,
  }
  return { authority, selection, title: `${source.title.slice(0, 210)} · 技术规划`,
    text: mode === 'launch' ? taskPlanningLaunchText(record) : '', commandId, planningId, assertReadCurrent: assertPreviouslyRead }
}
