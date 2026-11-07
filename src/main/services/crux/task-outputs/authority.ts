import { z } from 'zod'
import type { CruxDevelopmentRef, CruxWorkQuery } from '../../../../shared/crux-work'
import type { TaskProgressPin } from '../../../../shared/crux-task-progress-native'
import type { NativeTaskProgressSender } from '../task-progress-sender'
import { CruxWorkBindings, nativeRootKey, validateCruxProject, type CruxWorkRecord } from '../task-workspace-records'
import { readCruxWorkSource } from '../task-workspace-source'
import { cruxWorkProjectIdentity, inspectCruxWorkExecutionProject } from '../work-project'
import { outputHash, readOutputFile } from './files'
import { TaskOutputError } from './types'

export function privateOutputRecord(userData: string, pin: TaskProgressPin, expected: CruxDevelopmentRef, taskCreatedAt: string): CruxWorkRecord {
  const identity = outputHash(JSON.stringify([pin.workspaceKey, pin.connectionId, pin.projectId, pin.ownerId, pin.origin, pin.instanceId]))
  const stored = new CruxWorkBindings(userData).read({ workspaceKey: pin.workspaceKey, spaceId: pin.spaceId, taskId: pin.taskId, identity, taskCreatedAt })
  const record = stored?.value
  if (!record || record.identityVersion !== 2 || record.commandId !== expected.contextId || record.generation !== expected.generation || record.taskCreatedAt !== taskCreatedAt
    || !record.relativeDir || !record.localTaskId || record.stage !== 'ready' || !record.projectIdentity || !record.codeResource) throw new TaskOutputError('OUTPUT_CONTEXT_CHANGED', '原开发尝试、任务创建身份或私有绑定已变化，产物未改投新上下文')
  const root = validateCruxProject(record.projectRoot, true)
  if (cruxWorkProjectIdentity(root) !== record.projectIdentity || !/^\.trellis\/tasks\/[^/\\:]+$/.test(record.relativeDir)) throw new TaskOutputError('OUTPUT_CONTEXT_CHANGED', '原任务物理目录或工作副本身份已变化')
  const task = z.object({ id: z.string(), status: z.string(), meta: z.record(z.string(), z.unknown()) }).passthrough().parse(JSON.parse(readOutputFile(root, `${record.relativeDir}/task.json`).text))
  const meta = task.meta
  if (task.id !== record.localTaskId || ['completed', 'done', 'cancelled'].includes(task.status) || meta.panel_operation_id !== record.commandId || meta.panel_trellis_flow_workspace_key !== pin.workspaceKey
    || meta.panel_trellis_flow_space_id !== pin.spaceId || meta.panel_trellis_flow_task_id !== pin.taskId || meta.panel_trellis_flow_identity !== identity || meta.panel_trellis_flow_task_created_at !== taskCreatedAt
    || meta.panel_trellis_flow_source_revision !== record.sourceRevision || meta.panel_trellis_flow_generation !== String(expected.generation) || meta.panel_task_authority !== 'team') throw new TaskOutputError('OUTPUT_TASK_CHANGED', '本机任务的原来源或创建身份无法核对')
  if (readOutputFile(root, `${record.relativeDir}/references/source-materials.json`, 256 * 1024).digest !== record.sourceRevision
    || outputHash(JSON.stringify(record.material)) !== record.sourceRevision) throw new TaskOutputError('OUTPUT_INPUT_CHANGED', '原固定输入文件已变化，未把它作为产物回写')
  if (!record.referenceFiles?.some(file => file.relativePath === 'references/source-materials.json' && file.bodyDigest === record.sourceRevision)) throw new TaskOutputError('OUTPUT_INPUT_CHANGED', '原固定输入文件登记不完整，未推断可上传权限')
  let referenceBytes = 0
  for (const file of record.referenceFiles) {
    const actual = readOutputFile(root, `${record.relativeDir}/${file.relativePath}`)
    referenceBytes += actual.byteLength
    if (actual.digest !== file.bodyDigest || referenceBytes > 8 * 1024 * 1024) throw new TaskOutputError('OUTPUT_INPUT_CHANGED', '原冻结引用正文已变化或超出 8 MiB 上限，未继续产物同步')
  }
  return record
}

export async function authorizeOutput(userData: string, pin: TaskProgressPin, query: CruxWorkQuery, expected: CruxDevelopmentRef, sender: NativeTaskProgressSender): Promise<{ record: CruxWorkRecord; taskCreatedAt: string; inputOutdated: boolean; authority: string }> {
  if (pin.workspaceKey !== query.workspaceKey || pin.taskId !== query.taskId || pin.handlerId !== pin.ownerId) throw new TaskOutputError('OUTPUT_SCOPE_CHANGED', '产物不属于原任务执行身份')
  const remote = await sender.snapshot()
  const context = { key: pin.workspaceKey, connectionId: pin.connectionId, origin: pin.origin, actorId: pin.ownerId, projectId: pin.projectId,
    instanceId: remote.instanceId, epoch: remote.epoch, authorizationRevision: remote.authorizationRevision, revision: remote.revision, state: 'connected' as const, projectName: null, canManage: remote.canManage, pendingCount: 0 }
  const source = await readCruxWorkSource({ workspaceStatus: async () => context, workspaceSnapshot: async () => ({ context, snapshot: remote.snapshot }) }, query)
  if (source.spaceId !== pin.spaceId || source.closed || !source.canCreate || source.material.workKind !== 'code') throw new TaskOutputError('OUTPUT_TASK_CLOSED', '任务已结束、转交或当前阶段不再允许原代码产物回传')
  const record = privateOutputRecord(userData, pin, expected, source.taskCreatedAt)
  const resource = await sender.codeResource(), bound = record.codeResource
  if (!bound || resource.availability !== 'available' || resource.taskCreatedAt !== source.taskCreatedAt || resource.resource?.resourceId !== bound.resourceId
    || resource.selection?.revision !== bound.selectionRevision || outputHash(JSON.stringify(resource.resource.source)) !== bound.sourceDigest) throw new TaskOutputError('OUTPUT_RESOURCE_CHANGED', '原代码资源或任务副本绑定已变化')
  const inputs = await sender.inputs(source.taskCreatedAt)
  const preview = await inspectCruxWorkExecutionProject(record.projectRoot, resource.resource)
  const git = record.git
  if (!preview.resourceMatched || git === undefined || git && (!preview.git || nativeRootKey(preview.git.repoRoot) !== nativeRootKey(git.repoRoot) || preview.git.branch !== git.branch || preview.git.detached !== git.detached || git.detached && preview.git.head !== git.head)) throw new TaskOutputError('OUTPUT_BRANCH_CHANGED', '原工作副本的仓库或分支已变化')
  const after = privateOutputRecord(userData, pin, expected, source.taskCreatedAt)
  if (JSON.stringify(after) !== JSON.stringify(record)) throw new TaskOutputError('OUTPUT_CONTEXT_CHANGED', '核对期间原私有绑定已变化')
  return { record, taskCreatedAt: source.taskCreatedAt, inputOutdated: (inputs.current?.digest ?? null) !== (record.material.governance?.digest ?? null), authority: source.authority }
}
