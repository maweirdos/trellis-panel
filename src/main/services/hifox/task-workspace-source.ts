import { z } from 'zod'
import type { HifoxSnapshot } from '../../../shared/hifox'
import { hifoxWorkMaterialSchema, type HifoxWorkMaterial } from '../../../shared/hifox-work'
export { hifoxWorkMaterialSchema, type HifoxWorkMaterial } from '../../../shared/hifox-work'
import type { HifoxWorkspaceContext } from '../../../shared/hifox-remote'
import type { HifoxWorkFailureReason, HifoxWorkQuery } from '../../../shared/hifox-work'
import { IpcErrorCode } from '../../../shared/ipc-errors'
import { sha256Hex } from '../local-task/operations'
import { creationMaterialReferenceSchema, creationReferencePath, type CreationMaterialReference } from '../../../shared/creation-materials'
import { clipUtf8, utf8ByteLength } from '../../../shared/material-budget'

export class HifoxWorkError extends Error {
  constructor(readonly reason: HifoxWorkFailureReason, message: string, readonly code: IpcErrorCode = IpcErrorCode.Conflict) { super(message) }
}
export type HifoxWorkWorkspaceView = { snapshot: HifoxSnapshot; context: HifoxWorkspaceContext }
export type HifoxWorkSourceDependencies = {
  workspaceStatus(): Promise<HifoxWorkspaceContext>
  workspaceSnapshot(): Promise<HifoxWorkWorkspaceView>
  creationReferences?(query: HifoxWorkQuery): Promise<CreationMaterialReference[]>
}
export type HifoxWorkSource = {
  workspaceKey: string; spaceId: string; taskId: string; actorId: string; actorName: string
  identity: string; authority: string; material: HifoxWorkMaterial; revision: string; priority: 'P0' | 'P1' | 'P2' | 'P3'
  canCreate: boolean
}

function assertContext(context: HifoxWorkspaceContext, query: HifoxWorkQuery): void {
  if (context.key !== query.workspaceKey) throw new HifoxWorkError('scope_changed', '协作空间已切换，请在原空间重新打开任务。')
  if (!['local', 'connected'].includes(context.state) || !context.actorId) throw new HifoxWorkError('access_locked', '当前空间访问或登录身份无法核实，本机任务绑定已锁定。', IpcErrorCode.Denied)
}
function identity(context: HifoxWorkspaceContext): string {
  return sha256Hex(JSON.stringify([context.key, context.connectionId, context.projectId, context.actorId, context.origin ?? null, context.instanceId ?? null]))
}
function authority(context: HifoxWorkspaceContext): string { return JSON.stringify([identity(context), context.epoch ?? null, context.authorizationRevision ?? null]) }

/** Every source read is fenced on both sides; a refresh cannot adopt the newly selected account. */
export async function readHifoxWorkSource(deps: HifoxWorkSourceDependencies, query: HifoxWorkQuery, expected?: HifoxWorkSource): Promise<HifoxWorkSource> {
  const before = await deps.workspaceStatus()
  assertContext(before, query)
  if (expected && authority(before) !== expected.authority) throw new HifoxWorkError('scope_changed', '原协作身份或服务世代已变化，请重新核对任务。')
  const view = await deps.workspaceSnapshot()
  assertContext(view.context, query)
  if (authority(view.context) !== authority(before)) throw new HifoxWorkError('scope_changed', '读取任务期间协作身份已变化。')
  const after = await deps.workspaceStatus()
  assertContext(after, query)
  if (authority(after) !== authority(view.context)) throw new HifoxWorkError('scope_changed', '读取任务后协作身份已变化。')
  const actor = view.snapshot.members.find((member) => member.id === after.actorId)
  const task = view.snapshot.tasks.find((item) => item.id === query.taskId)
  const space = task && view.snapshot.spaces.find((item) => item.id === task.spaceId)
  if (!actor || !task || !space || space.archived || !space.memberIds.includes(actor.id)) throw new HifoxWorkError('access_locked', '任务不可见、空间已归档或当前人员已失去空间成员权限。', IpcErrorCode.Denied)
  const handlerId = task.workflow?.handlerId ?? task.assigneeIds[0]
  if (handlerId !== actor.id) throw new HifoxWorkError('not_handler', '只有任务当前处理人可以准备或打开本机开发任务。', IpcErrorCode.Denied)
  const creationReferences = await deps.creationReferences?.(query) ?? []
  if (creationReferences.some((reference) => reference.taskId !== task.id)) throw new HifoxWorkError('scope_changed', '原型引用不属于当前业务任务。')
  if (authority(await deps.workspaceStatus()) !== authority(after)) throw new HifoxWorkError('scope_changed', '读取创作材料期间原协作身份已变化。')
  const material = hifoxWorkMaterialSchema.parse({
    title: task.title, description: task.description ?? '',
    workKind: task.workKind ?? 'code', acceptanceCriteria: task.acceptanceCriteria ?? [],
    artifacts: (task.workflow?.artifacts ?? []).filter((artifact) => ['requirements', 'design', 'acceptance'].includes(artifact.kind))
      .map(({ id, kind, body, actorId, at }) => ({ id, kind, body, actorId, at })),
    ...(creationReferences.length ? { creationReferences } : {})
  })
  if (Buffer.byteLength(JSON.stringify(material), 'utf8') > 256 * 1024) throw new HifoxWorkError('invalid_input', '任务需求材料超过 256 KiB，请先整理原任务内容。', IpcErrorCode.InvalidArg)
  return {
    workspaceKey: query.workspaceKey, spaceId: space.id, taskId: task.id, actorId: actor.id, actorName: actor.name,
    identity: identity(after), authority: authority(after), material, revision: sha256Hex(JSON.stringify(material)),
    priority: task.priority === 'urgent' ? 'P0' : task.priority === 'high' ? 'P1' : task.priority === 'low' ? 'P3' : 'P2',
    canCreate: material.workKind === 'code' && !task.triagePending && (!task.workflow || ['dev_ready', 'planning'].includes(task.workflow.stage))
  }
}
export function renderHifoxWorkPrd(source: Pick<HifoxWorkSource, 'workspaceKey' | 'spaceId' | 'taskId' | 'material' | 'revision'>): string {
  const material = source.material
  const lines = [
    `# ${material.title}`, '', `> HiFox task: ${source.taskId}`,
    `> Workspace: ${source.workspaceKey}`, `> Space: ${source.spaceId}`, `> Source revision (sha256): ${source.revision}`,
    '', '## Requirements', '', material.description || '（任务尚未填写需求描述。）'
  ]
  for (const artifact of material.artifacts.filter((item) => item.kind === 'requirements')) lines.push('', `### Requirements ${artifact.id}`, '', `> ${artifact.actorId} · ${artifact.at}`, '', artifact.body)
  if (material.acceptanceCriteria.length) lines.push('', '## Acceptance Criteria', '', ...material.acceptanceCriteria.map((item) => `- [ ] ${item}`))
  for (const artifact of material.artifacts.filter((item) => item.kind === 'design')) lines.push('', `## Design ${artifact.id}`, '', `> ${artifact.actorId} · ${artifact.at}`, '', artifact.body)
  for (const artifact of material.artifacts.filter((item) => item.kind === 'acceptance')) lines.push('', `## Acceptance Review ${artifact.id}`, '', `> ${artifact.actorId} · ${artifact.at}`, '', artifact.body)
  const references = material.creationReferences ?? []
  const footer = ['','## Read on demand', '',
    'Full requirements, original design text and acceptance records: `references/source-materials.json`.',
    'Do not load every reference into the conversation. Read only the file or confirmed opinion needed for the current step.',
    ...references.flatMap((reference) => [
      `- ${reference.title} R${reference.revisionNumber}: \`${creationReferencePath(reference)}\``,
      `  Confirmed rules and interaction scenarios: \`references/${reference.creationId}/${reference.revisionId}.review.json\``
    ]), ''].join('\n')
  const body = lines.join('\n') + '\n'
  const budget = 6144 - utf8ByteLength(footer)
  if (budget < 128) throw new HifoxWorkError('invalid_input', '开发引用索引超过 6 KiB，请拆分任务材料。')
  const compact = clipUtf8(body, budget)
  return compact + footer
}
