import { z } from 'zod'
import type { CruxSnapshot } from '../../../shared/crux'
import { cruxWorkMaterialSchema, type CruxWorkMaterial, type CruxTeamInputSelection } from '../../../shared/crux-work'
export { cruxWorkMaterialSchema, type CruxWorkMaterial } from '../../../shared/crux-work'
import type { CruxWorkspaceContext } from '../../../shared/crux-remote'
import type { CruxWorkFailureReason, CruxWorkQuery } from '../../../shared/crux-work'
import { IpcErrorCode } from '../../../shared/ipc-errors'
import { sha256Hex } from '../local-task/operations'
import { creationMaterialReferenceSchema, creationReferencePath, type CreationMaterialReference } from '../../../shared/creation-materials'
import { clipUtf8, utf8ByteLength } from '../../../shared/material-budget'
import { taskMaterialInputPath, taskMaterialInputReferenceSchema, type TaskMaterialInputReference } from '../../../shared/task-material-inputs'

export class CruxWorkError extends Error {
  constructor(readonly reason: CruxWorkFailureReason, message: string, readonly code: IpcErrorCode = IpcErrorCode.Conflict) { super(message) }
}
export type CruxWorkWorkspaceView = { snapshot: CruxSnapshot; context: CruxWorkspaceContext }
export type CruxWorkSourceDependencies = {
  workspaceStatus(): Promise<CruxWorkspaceContext>
  workspaceSnapshot(): Promise<CruxWorkWorkspaceView>
  workspaceGeneration?(): number
  creationReferences?(query: CruxWorkQuery): Promise<CreationMaterialReference[]>
  teamMaterialReferences?(query: CruxWorkQuery & { spaceId: string; taskCreatedAt: string }): Promise<TaskMaterialInputReference[]>
  teamInputs?(query: CruxWorkQuery & { spaceId: string; taskCreatedAt: string }): Promise<CruxTeamInputSelection>
}
export type CruxWorkSource = {
  workspaceKey: string; spaceId: string; taskId: string; taskCreatedAt: string; actorId: string; actorName: string
  identity: string; authority: string; material: CruxWorkMaterial; revision: string; priority: 'P0' | 'P1' | 'P2' | 'P3'
  canCreate: boolean; closed: boolean
  selectionGeneration?: number
  instanceId?: string; epoch?: string
}

function assertContext(context: CruxWorkspaceContext, query: CruxWorkQuery): void {
  if (context.key !== query.workspaceKey) throw new CruxWorkError('scope_changed', '协作空间已切换，请在原空间重新打开任务。')
  if (!['local', 'connected'].includes(context.state) || !context.actorId) throw new CruxWorkError('access_locked', '当前空间访问或登录身份无法核实，本机任务绑定已锁定。', IpcErrorCode.Denied)
}
function identity(context: CruxWorkspaceContext): string {
  return sha256Hex(JSON.stringify([context.key, context.connectionId, context.projectId, context.actorId, context.origin ?? null, context.instanceId ?? null]))
}
function authority(context: CruxWorkspaceContext): string { return JSON.stringify([identity(context), context.epoch ?? null, context.authorizationRevision ?? null]) }

/** Every source read is fenced on both sides; a refresh cannot adopt the newly selected account. */
export async function readCruxWorkSource(deps: CruxWorkSourceDependencies, query: CruxWorkQuery, expected?: CruxWorkSource): Promise<CruxWorkSource> {
  query = { workspaceKey: query.workspaceKey, taskId: query.taskId }
  const selectionGeneration = deps.workspaceGeneration?.()
  const assertGeneration = (): void => {
    if (deps.workspaceGeneration?.() !== selectionGeneration || expected?.selectionGeneration !== undefined && expected.selectionGeneration !== selectionGeneration) throw new CruxWorkError('scope_changed', '原任务来源已切换，请重新打开；返回原空间不能恢复旧操作权限。')
  }
  assertGeneration()
  const before = await deps.workspaceStatus()
  assertContext(before, query)
  if (expected && authority(before) !== expected.authority) throw new CruxWorkError('scope_changed', '原协作身份或服务世代已变化，请重新核对任务。')
  const view = await deps.workspaceSnapshot()
  assertContext(view.context, query)
  if (authority(view.context) !== authority(before)) throw new CruxWorkError('scope_changed', '读取任务期间协作身份已变化。')
  const after = await deps.workspaceStatus()
  assertContext(after, query)
  if (authority(after) !== authority(view.context)) throw new CruxWorkError('scope_changed', '读取任务后协作身份已变化。')
  assertGeneration()
  const actor = view.snapshot.members.find((member) => member.id === after.actorId)
  const task = view.snapshot.tasks.find((item) => item.id === query.taskId)
  const space = task && view.snapshot.spaces.find((item) => item.id === task.spaceId)
  if (!actor || !task || !space || space.archived || !space.memberIds.includes(actor.id)) throw new CruxWorkError('access_locked', '任务不可见、空间已归档或当前人员已失去空间成员权限。', IpcErrorCode.Denied)
  if (expected && (expected.taskCreatedAt !== task.createdAt || expected.spaceId !== space.id || expected.actorId !== actor.id || expected.identity !== identity(after))) throw new CruxWorkError('scope_changed', '原任务或人员身份已改变，请重新打开并核对。')
  const handlerId = task.workflow?.handlerId ?? task.assigneeIds[0]
  if (handlerId !== actor.id) throw new CruxWorkError('not_handler', '只有任务当前处理人可以准备或打开本机开发任务。', IpcErrorCode.Denied)
  const creationReferences = await deps.creationReferences?.(query) ?? []
  if (creationReferences.some((reference) => reference.taskId !== task.id)) throw new CruxWorkError('scope_changed', '原型引用不属于当前业务任务。')
  if (authority(await deps.workspaceStatus()) !== authority(after)) throw new CruxWorkError('scope_changed', '读取创作材料期间原协作身份已变化。')
  const teamScope = { ...query, spaceId: task.spaceId, taskCreatedAt: task.createdAt }
  const selectedInputs = await deps.teamInputs?.(teamScope)
  const teamMaterialReferences = z.array(taskMaterialInputReferenceSchema).max(4).parse(selectedInputs?.references ?? await deps.teamMaterialReferences?.(teamScope) ?? [])
  if (teamMaterialReferences.some((reference) => reference.spaceId !== task.spaceId || reference.taskCreatedAt !== task.createdAt)) throw new CruxWorkError('scope_changed', '团队文档不属于原任务的空间或创建身份。')
  if (authority(await deps.workspaceStatus()) !== authority(after)) throw new CruxWorkError('scope_changed', '读取团队文档期间原协作身份已变化。')
  assertGeneration()
  const material = cruxWorkMaterialSchema.parse({
    title: task.title, description: task.description ?? '',
    workKind: task.workKind ?? 'code', acceptanceCriteria: task.acceptanceCriteria ?? [],
    artifacts: (task.workflow?.artifacts ?? []).filter((artifact) => ['requirements', 'design', 'acceptance'].includes(artifact.kind))
      .map(({ id, kind, body, actorId, at }) => ({ id, kind, body, actorId, at })),
    ...(creationReferences.length ? { creationReferences } : {}),
    ...(teamMaterialReferences.length ? { teamMaterialReferences } : {}), ...(selectedInputs?.governance ? { governance: selectedInputs.governance } : {})
  })
  if (Buffer.byteLength(JSON.stringify(material), 'utf8') > 256 * 1024) throw new CruxWorkError('invalid_input', '任务需求材料超过 256 KiB，请先整理原任务内容。', IpcErrorCode.InvalidArg)
  const closed = task.workflow?.stage === 'done' || ['done', 'cancelled'].includes(view.snapshot.taskStatuses?.find(status => status.id === task.statusId)?.category ?? '')
  return {
    workspaceKey: query.workspaceKey, spaceId: space.id, taskId: task.id, taskCreatedAt: task.createdAt, actorId: actor.id, actorName: actor.name,
    identity: identity(after), authority: authority(after), instanceId: after.instanceId, epoch: after.epoch, material, revision: sha256Hex(JSON.stringify(material)), selectionGeneration,
    priority: task.priority === 'urgent' ? 'P0' : task.priority === 'high' ? 'P1' : task.priority === 'low' ? 'P3' : 'P2',
    closed, canCreate: material.workKind === 'code' && !closed && !task.triagePending && (!task.workflow || ['dev_ready', 'planning', 'developing'].includes(task.workflow.stage))
  }
}
export function renderCruxWorkPrd(source: Pick<CruxWorkSource, 'workspaceKey' | 'spaceId' | 'taskId' | 'material' | 'revision'>): string {
  const material = source.material
  const lines = [
    `# ${material.title}`, '', `> Crux task: ${source.taskId}`,
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
    ]),
    ...(material.teamMaterialReferences ?? []).map((reference) => `- Approved ${reference.kind}: ${clipUtf8(reference.title, 180)}: \`${taskMaterialInputPath(reference)}\` (SHA-256 ${reference.bodyDigest}).`),
    ...(material.governance ? [`- Adopted team inputs: bundle ${material.governance.bundleId}, revision ${material.governance.revision}, SHA-256 ${material.governance.digest}.`,
      `- ${material.governance.rules.length} fixed team rules are indexed in \`references/source-materials.json\`; bodies: \`references/rules/<packageId>/<versionId>.md\`.`,
      ...(material.governance.template ? ['- Fixed workflow template body: `references/templates/<packageId>/<versionId>.md`; template metadata is in `references/source-materials.json`.'] : [])] : []),
    ''].join('\n')
  const body = lines.join('\n') + '\n'
  const budget = 6144 - utf8ByteLength(footer)
  if (budget < 128) throw new CruxWorkError('invalid_input', '开发引用索引超过 6 KiB，请拆分任务材料。')
  const compact = clipUtf8(body, budget)
  return compact + footer
}
