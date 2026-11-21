import type { CruxSnapshot, CruxTask } from '@shared/crux'
import type { RequirementView } from '@shared/conversation-requirements'
import { api } from '../../api'
import { bodyDigest } from '../../crux/intake/requirements'
import { useCrux } from '../../crux/store'
import { stableCommandId } from '../../utils/stable-command-id'
import type { WorkspaceEntry } from '../workspace'

export interface TeamTaskSharingTarget {
  task: CruxTask
  conversationId: string
  creatorId: string
}

export type TeamRequirementShareResult =
  | { state: 'created'; taskId: string; spaceId: string; materialDocumentId?: string; materialVersionId?: string }
  | { state: 'working'; message: string }
  | { state: 'failed'; message: string }

interface SharingContext {
  workspaceKey: string
  actorId: string
  epoch: string
  instanceId: string
  projectId: string
  local: boolean
}

const acceptSnapshotForState = (snapshot: CruxSnapshot, currentSpaceId: string | null): { snapshot: CruxSnapshot; currentSpaceId: string | null } =>
  ({ snapshot, currentSpaceId: snapshot.spaces.some(space => space.id === currentSpaceId) ? currentSpaceId : snapshot.spaces[0]?.id ?? null })

const sharingIdentity = (conversationId: string, creatorId: string, draftId: string, revision: string): string =>
  JSON.stringify(['requirement-team-sharing-v1', creatorId, conversationId, draftId, revision])

const fail = (message: string): { state: 'failed'; message: string } => ({ state: 'failed', message })

const working = (message = '正在共享需求版本…'): { state: 'working'; message: string } => ({ state: 'working', message })

async function sharingContext(target: TeamTaskSharingTarget, entry: WorkspaceEntry, requirement: RequirementView): Promise<SharingContext | string> {
  const conversation = entry.conversation
  const draft = requirement.draft
  if (!conversation) return '请先保存原对话。'
  if (draft.conversationId !== conversation.id || draft.creatorId !== conversation.creatorId || requirement.fileState !== 'saved') return '需求版本不属于当前可读取的原会话。'
  if (conversation.id !== target.conversationId || conversation.creatorId !== target.creatorId) return '需求版本与已绑定任务的原会话不一致。'
  await useCrux.getState().bootstrap()
  const store = useCrux.getState(), context = store.workspaceContext, snapshot = store.snapshot
  if (!snapshot) return store.loadError ?? '团队工作区尚未连接。'
  const actorId = context.actorId
  const epoch = context.epoch ?? '', instanceId = context.instanceId ?? '', projectId = context.projectId ?? ''
  if (!actorId || context.state !== 'local' && (!epoch || !instanceId || !projectId) || context.state !== 'local' && context.state !== 'connected') return '请连接原任务工作区后共享。'
  const task = snapshot.tasks.find(item => item.id === target.task.id && item.createdAt === target.task.createdAt && item.spaceId === target.task.spaceId)
  if (!task) return '原任务已变化，请重新打开任务后共享。'
  if (!task.conversations?.some(link => link.id === conversation.id && link.actorId === actorId)) return '原任务与当前会话的绑定已变化。'
  if (!snapshot.spaces.some(space => space.id === task.spaceId && !space.archived && space.memberIds.includes(actorId))) return '当前身份已无原任务空间的共享权限。'
  return { workspaceKey: context.key, actorId, epoch, instanceId, projectId, local: context.state === 'local' }
}

export async function shareRequirementVersion(entry: WorkspaceEntry, requirement: RequirementView, target: TeamTaskSharingTarget): Promise<TeamRequirementShareResult> {
  const context = await sharingContext(target, entry, requirement)
  if (typeof context === 'string') return fail(context)
  const draft = requirement.draft
  const id = await stableCommandId(sharingIdentity(target.conversationId, target.creatorId, draft.id, draft.revision))
  const current = (): boolean => {
    const latest = useCrux.getState().workspaceContext
    return latest.key === context.workspaceKey && latest.actorId === context.actorId &&
      (context.local || latest.instanceId === context.instanceId && latest.epoch === context.epoch)
  }
  const scopeBase = { workspaceKey: context.workspaceKey, taskId: target.task.id, spaceId: target.task.spaceId, taskCreatedAt: target.task.createdAt }
  const digest = await bodyDigest(draft.body)
  const versionLabel = `需求版本 ${draft.revision.slice(0, 8)}`
  if (!current()) return fail('工作区已变化，请重新打开原任务。')
  if (target.task.handoff?.materialDigest === digest && target.task.handoff.versionLabel === versionLabel &&
      (context.local || target.task.handoff.material?.bodyDigest === digest)) {
    return { state: 'created', taskId: target.task.id, spaceId: target.task.spaceId }
  }
  const namedReference = {
      sourceDraftId: draft.id,
      documentId: id,
      versionId: id,
      title: draft.title,
      versionLabel,
      bodyDigest: digest,
      ...(context.local ? { localBody: draft.body } : {})
    }
  const materials = api.cruxMaterials
  if (!materials && !context.local) return fail('当前客户端无法保存团队材料。')
  try {
    let materialDocumentId: string | undefined, materialVersionId: string | undefined
    if (materials && !context.local) {
      const reconciled = await materials.reconcile({ ...scopeBase, commandId: id })
      if (!current()) return working('原会话已离开，共享结果待核对。')
      if (!reconciled.ok && reconciled.code !== 'NOT_FOUND') return fail(reconciled.error)
      let saved = reconciled.ok ? reconciled.value : null
      if (reconciled.ok && !saved) {
        const retried = await materials.retry({ ...scopeBase, commandId: id })
        if (!current()) return working('原会话已离开，共享结果待核对。')
        if (!retried.ok) return fail(retried.error)
        saved = retried.value.result
      }
      if (!reconciled.ok) {
        const command = await materials.command({ ...scopeBase, command: {
          action: 'create', kind: 'prd', commandId: id, expectedEpoch: context.epoch,
          spaceId: target.task.spaceId, taskCreatedAt: target.task.createdAt,
          title: draft.title, text: draft.body, expectedDigest: digest,
          references: [], editorIds: [context.actorId], approverIds: [context.actorId]
        } })
        if (!current()) return working('原会话已离开，共享结果待核对。')
        if (!command.ok) return fail(command.error)
        saved = command.value.result
      }
      if (!saved || saved.action !== 'create' || saved.outcome !== 'applied' || saved.commandId !== id ||
          saved.taskId !== target.task.id || saved.taskCreatedAt !== target.task.createdAt || saved.spaceId !== target.task.spaceId ||
          saved.projectId !== context.projectId || saved.actorId !== context.actorId || saved.epoch !== context.epoch ||
          saved.instanceId !== context.instanceId || !saved.versionId) return fail('共享版本回执与原任务不匹配。')
      const fixed = await materials.read({ ...scopeBase, documentId: saved.documentId, versionId: saved.versionId })
      if (!current()) return working('原会话已离开，共享结果待核对。')
      if (!fixed.ok) return fail(fixed.error)
      if (fixed.value.document.taskId !== target.task.id || fixed.value.document.taskCreatedAt !== target.task.createdAt ||
          fixed.value.selected.versionId !== saved.versionId || fixed.value.selected.bodyDigest !== digest ||
          await bodyDigest(fixed.value.text) !== digest) return fail('共享固定版本核对失败。')
      materialDocumentId = saved.documentId
      materialVersionId = saved.versionId
      namedReference.documentId = saved.documentId
      namedReference.versionId = saved.versionId
    }
    const published = await useCrux.getState().run('发布共享需求版本', () => api.crux.updateTask({ id: target.task.id, patch: { sharedMaterial: { ...namedReference } } }))
    if (!current()) return working('原会话已离开，共享结果待核对。')
    if (!published || !published.ok) return fail(context.local ? '命名版本未能写入本机任务。' : '命名版本未能写入原任务。')
    const publishedTask = published.data.tasks.find(item => item.id === target.task.id && item.createdAt === target.task.createdAt)
    if (!publishedTask?.sharedMaterials?.some(item => item.documentId === namedReference.documentId && item.versionId === namedReference.versionId && item.bodyDigest === digest)) {
      return fail('命名版本回执核对失败。')
    }
    const refreshed = await api.crux.snapshot()
    if (!current()) return working('原会话已离开，共享结果待核对。')
    if (!refreshed.ok) return fail(refreshed.error)
    useCrux.setState(state => ({ ...acceptSnapshotForState(refreshed.data, state.currentSpaceId) }))
    return { state: 'created', taskId: target.task.id, spaceId: target.task.spaceId, materialDocumentId, materialVersionId }
  } catch (cause) {
    return fail(cause instanceof Error ? cause.message : String(cause))
  }
}
