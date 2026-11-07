import { resolve } from 'node:path'
import { z } from 'zod'
import { cruxSnapshotSchema } from '../../../shared/crux-schema'
import { IntegrationError } from '../integrations/types'
import { materialRead, materialWrite } from '../knowledge-access/materials'
import { resolveAuthorizedDocumentPath } from '../documents/paths'
import { sha256Hex } from '../local-task/operations'
import { scanKnownTaskDirs } from '../task-identity'
import { cruxWorkRecordSchema, nativeRootKey, validateCruxProject } from './task-workspace-records'
import { CruxWorkError, type CruxWorkWorkspaceView } from './task-workspace-source'

const id = z.string().min(1).max(256)
const counter = z.number().int().nonnegative().safe()
const contextSchema = z.object({
  key: id, connectionId: z.string().uuid(), projectId: z.string().uuid(), actorId: id,
  origin: z.string().url(), instanceId: z.string().uuid(), epoch: z.string().uuid(),
  revision: counter, authorizationRevision: counter, state: z.literal('connected')
}).passthrough()
const inputSchema = z.object({
  record: cruxWorkRecordSchema,
  view: z.object({ context: contextSchema, snapshot: cruxSnapshotSchema }),
  enableTeamAuthority: z.boolean(), expectedEpoch: z.string().uuid(), expectedInstanceId: z.string().uuid()
})
// Native callers supply their existing workspace view; runtime validation also rejects offline caches.
export type TeamTaskProjectionInput = {
  record: z.infer<typeof cruxWorkRecordSchema>
  view: CruxWorkWorkspaceView
  enableTeamAuthority: boolean
  expectedEpoch: string
  expectedInstanceId: string
}
const statusSchema = z.enum(['planning', 'in_progress', 'review', 'completed', 'blocked', 'cancelled'])
const headSchema = z.object({
  version: z.literal(1), instanceId: z.string().uuid(), epoch: z.string().uuid(), revision: counter,
  authorizationRevision: counter, category: cruxSnapshotSchema.shape.taskStatuses.element.shape.category,
  stage: z.string().nullable(), updatedAt: z.string()
}).strict()
type ProjectionHead = z.infer<typeof headSchema>
type ProjectionStatus = z.infer<typeof statusSchema>
type FailureReason = 'invalid_input' | 'not_managed' | 'scope_changed' | 'access_locked' | 'task_conflict'
  | 'source_changed' | 'epoch_changed' | 'stale_revision' | 'unmapped_status' | 'store_unavailable'
export type TeamTaskProjectionResult =
  | { ok: true; status: ProjectionStatus; revision: number; changed: boolean }
  | { ok: false; reason: FailureReason; error: string }

class ProjectionError extends Error {
  constructor(readonly reason: FailureReason, message: string) { super(message) }
}
function fail(reason: FailureReason, message: string): never { throw new ProjectionError(reason, message) }

function localStatus(category: ProjectionHead['category'], stage: string | null): ProjectionStatus {
  if (category === 'cancelled') return 'cancelled'
  if (category === 'blocked') return 'blocked'
  if (stage !== null) {
    if (stage === 'done') {
      if (category !== 'done') fail('unmapped_status', '中心任务阶段与完成状态不一致，未投影完成。')
      return 'completed'
    }
    if (category === 'done') fail('unmapped_status', '中心任务尚未最终验收，未投影完成。')
    if (stage === 'developing') return 'in_progress'
    if (stage === 'testing' || stage === 'acceptance') return 'review'
    if (['accepted', 'needs_info', 'design_ready', 'designing', 'design_review', 'dev_ready', 'planning'].includes(stage)) return 'planning'
    return fail('unmapped_status', '中心任务阶段无法识别，保留原本机状态。')
  }
  switch (category) {
    case 'backlog': case 'todo': return 'planning'
    case 'in_progress': return 'in_progress'
    case 'in_review': return 'review'
    case 'done': return 'completed'
    default: return fail('unmapped_status', '中心任务状态无法识别，保留原本机状态。')
  }
}

function assertLocalPath(root: string, relativePath: string): void {
  const path = resolveAuthorizedDocumentPath(root, relativePath)
  if (!path.ok || !path.exists || nativeRootKey(path.canonicalPath) !== nativeRootKey(resolve(root, relativePath))) fail('task_conflict', '原任务路径已重定向、移动或不存在，未同步本机状态。')
}

/**
 * Call only after an authenticated, current service snapshot read, fenced by the
 * caller's original account/epoch/instance. A historical receipt, runtime progress,
 * Agent output or filesystem event is never a view admission source. This adapter
 * performs no service writes and only replaces task.json using its exact file revision.
 */
export function projectTeamTaskToLocal(input: TeamTaskProjectionInput): TeamTaskProjectionResult {
  try {
    const { record, view, enableTeamAuthority, expectedEpoch, expectedInstanceId } = inputSchema.parse(input)
    if (sha256Hex(JSON.stringify(record.material)) !== record.sourceRevision) fail('source_changed', '原本机任务绑定的需求材料摘要不匹配，未同步本机状态。')
    const context = view.context
    if (context.key !== record.workspaceKey || context.epoch !== expectedEpoch || context.instanceId !== expectedInstanceId) fail('scope_changed', '原团队空间或服务世代已变化，未同步本机任务。')
    const ownerIdentity = sha256Hex(JSON.stringify([context.key, context.connectionId, context.projectId, context.actorId, context.origin, context.instanceId]))
    if (ownerIdentity !== record.ownerIdentity) fail('scope_changed', '原团队任务的账号或服务身份不匹配，未同步本机任务。')
    const tasks = view.snapshot.tasks.filter((task) => task.id === record.sourceTaskId)
    if (tasks.length !== 1 || tasks[0].spaceId !== record.spaceId) fail('access_locked', '当前中心快照无法确认原团队任务，未同步本机状态。')
    const task = tasks[0]
    const space = view.snapshot.spaces.find((item) => item.id === task.spaceId)
    if (!view.snapshot.members.some((member) => member.id === context.actorId) || !space || !space.memberIds.includes(context.actorId)) fail('access_locked', '当前中心快照无法确认原空间访问权限，未同步本机状态。')
    const statuses = view.snapshot.taskStatuses.filter((item) => item.id === task.statusId && item.spaceId === task.spaceId)
    if (statuses.length !== 1) fail('unmapped_status', '当前中心快照没有唯一的任务状态，保留原本机状态。')
    const head: ProjectionHead = {
      version: 1, instanceId: context.instanceId, epoch: context.epoch, revision: context.revision,
      authorizationRevision: context.authorizationRevision, category: statuses[0].category,
      stage: task.workflow?.stage ?? null, updatedAt: task.updatedAt
    }
    const status = localStatus(head.category, head.stage)
    const root = validateCruxProject(record.projectRoot, true)
    const dir = record.relativeDir
    if (!dir || !record.localTaskId || !/^\.trellis\/tasks\/(?!archive(?:\/|$))[^/\\:]+$/.test(dir)) fail('task_conflict', '缺少原活动任务的已知相对目录或本机身份，未同步本机状态。')
    const known = scanKnownTaskDirs(root)
    const matches = known.filter((item) => item.trellisTaskId === record.localTaskId)
    if (known.length > 5000 || matches.length !== 1 || matches[0].dir !== dir) fail('task_conflict', '原本机任务目录缺失、身份重复或发生移动，未同步本机状态。')
    assertLocalPath(root, dir)
    const path = `${dir}/task.json`
    assertLocalPath(root, path)
    const previous = materialRead(root, path)
    const local = z.object({ id, status: z.string(), meta: z.record(z.string(), z.unknown()) }).passthrough().parse(JSON.parse(previous.body))
    const meta = local.meta
    if (local.id !== record.localTaskId || meta.panel_operation_id !== record.commandId
      || meta.panel_trellis_flow_workspace_key !== record.workspaceKey || meta.panel_trellis_flow_space_id !== record.spaceId
      || meta.panel_trellis_flow_task_id !== record.sourceTaskId || meta.panel_trellis_flow_identity !== record.ownerIdentity) fail('task_conflict', '原本机任务来源身份不匹配，未同步本机状态。')
    if (meta.panel_trellis_flow_source_revision !== record.sourceRevision) fail('source_changed', '原本机任务的需求材料版本不匹配，保留 PRD 和全部原文件。')
    if (meta.panel_task_authority !== 'team' && !enableTeamAuthority) fail('not_managed', '此任务尚未明确启用团队模式，保留原本机任务语义。')
    if (meta.panel_task_authority !== undefined && meta.panel_task_authority !== 'team') fail('task_conflict', '此任务已声明其它状态权威，不能自动替换。')
    if (meta.panel_team_projection !== undefined) {
      const saved = headSchema.parse(meta.panel_team_projection)
      // Epochs are unordered UUIDs. Never reinterpret an old epoch as a new head.
      if (saved.epoch !== head.epoch || saved.instanceId !== head.instanceId) fail('epoch_changed', '中心服务世代已变化，请在团队任务页重新核对原绑定；未用缓存覆盖本机状态。')
      if (head.revision < saved.revision || head.authorizationRevision < saved.authorizationRevision) fail('stale_revision', '中心确认版本早于已投影版本，已拒绝旧状态倒灌。')
      if (head.revision === saved.revision && (head.category !== saved.category || head.stage !== saved.stage || head.updatedAt !== saved.updatedAt)) fail('stale_revision', '同一中心版本的任务状态不一致，未同步本机状态。')
    }
    const changed = local.status !== status || meta.panel_task_authority !== 'team' || JSON.stringify(meta.panel_team_projection) !== JSON.stringify(head)
    if (!changed) return { ok: true, status, revision: head.revision, changed: false }
    local.status = status
    local.meta = { ...meta, panel_task_authority: 'team', panel_team_projection: head }
    // PRD, design, references, branch, identity metadata and all other fields survive.
    assertLocalPath(root, path)
    materialWrite(root, path, JSON.stringify(local, null, 2) + '\n', previous.revision)
    return { ok: true, status, revision: head.revision, changed: true }
  } catch (error) {
    if (error instanceof ProjectionError) return { ok: false, reason: error.reason, error: error.message }
    if (error instanceof IntegrationError) return { ok: false, reason: error.kind === 'conflict' ? 'task_conflict' : 'store_unavailable', error: `团队状态本机同步失败：${error.message}` }
    if (error instanceof CruxWorkError) return { ok: false, reason: 'task_conflict', error: error.message }
    if (error instanceof z.ZodError || error instanceof SyntaxError) return { ok: false, reason: 'invalid_input', error: '中心确认或原本机任务记录无效，未同步状态，原文件已保留。' }
    return { ok: false, reason: 'store_unavailable', error: '团队状态本机同步失败，未确认保存成功；请保留原文件并重试核对。' }
  }
}
