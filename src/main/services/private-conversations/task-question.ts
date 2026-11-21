import { conversationTaskSource } from '../../../shared/conversation-task'
import { conversationSendSchema } from '../../../shared/private-conversations'
import { effectiveTaskDescription, postSources } from '../../../shared/crux'
import type { CruxTaskMaterialsApi } from '../../../shared/crux-task-materials'
import { cruxStableWorkspaceGeneration, cruxWorkspaceSnapshot } from '../crux/connection-service'
import { hash } from './files'
import type { PrivateConversations } from './service'
import { ipcFail, IpcErrorCode } from '../../../shared/ipc-errors'
import type { DesignWorkspace } from '../design-workspace/service'
import { creationService } from '../creations'
import { readOptional, writeRevision } from './requirement-files'

const taskSend = conversationSendSchema.extend({ taskSource: conversationTaskSource })

function saveTaskInput(root: string, conversationId: string, text: string, extension: 'html' | 'md', current: () => void): string {
  current()
  const bytes = Buffer.from(text)
  const digest = hash(bytes)
  const path = `.trellis-panel/conversations/${conversationId}/inputs/task-assets/${digest}.${extension}`
  const existing = readOptional(root, path, bytes.length)
  if (!existing) writeRevision(root, path, bytes, null, current)
  else if (hash(existing.bytes) !== digest) throw Error('工程中的设计参考文件已被改动，请核对后再发送。')
  return path
}

export async function sendTaskQuestion(service: PrivateConversations, materials: Pick<CruxTaskMaterialsApi, 'read' | 'sourcePart'>,
  id: string, raw: unknown, windowCurrent: () => void, designs: Pick<DesignWorkspace, 'get'>) {
  let prepared
  try {
    const { taskSource: source, ...input } = taskSend.parse(raw)
    const generation = cruxStableWorkspaceGeneration()
    const owner = await service.workspaceAccess(id, true)
    const current = () => {
      windowCurrent()
      owner.assertCurrent()
      if (generation !== cruxStableWorkspaceGeneration()) throw Error('任务工作区已变化，请重新打开原任务。')
    }
    const { context, snapshot } = await cruxWorkspaceSnapshot()
    current()
    const task = snapshot.tasks.find(item => item.id === source.taskId && item.createdAt === source.taskCreatedAt && item.spaceId === source.spaceId)
    const space = task && snapshot.spaces.find(space => space.id === task.spaceId)
    if (!task || !space || space.archived || context.key !== source.workspaceKey || context.actorId !== source.actorId || context.epoch !== source.epoch ||
        !['local', 'connected'].includes(context.state) || !space.memberIds.includes(source.actorId) ||
        !task.conversations?.some(link => link.id === id && link.actorId === source.actorId)) throw Error('当前成员无法在此对话读取原任务。')
    if (source.expectedUpdatedAt && task.updatedAt !== source.expectedUpdatedAt) throw Error('任务已更新，请查看当前正文后重新发送。')
    const comments = snapshot.comments.filter(comment => comment.taskId === task.id)
    const scope = { workspaceKey: context.key, spaceId: task.spaceId, taskId: task.id, taskCreatedAt: task.createdAt }
    const documents = []
    if (owner.conversation.kind === 'code') {
      const root = owner.conversation.workspace.root
      if (source.design) {
        const ref = source.design
        if (!task.conversations.some(link => link.id === ref.conversationId && link.actorId === source.actorId)) throw Error('所选画布的原对话未绑定此任务。')
        const origin = await service.workspaceAccess(ref.conversationId)
        const check = () => { current(); origin.assertCurrent() }
        if (origin.conversation.creatorId !== owner.conversation.creatorId) throw Error('所选画布属于其他成员。')
        const document = await designs.get({ documentId: ref.documentId }, check)
        check()
        if (document.conversationId !== ref.conversationId || document.sourceError || document.readOnly) throw Error('原设计当前不可用，请在任务中重新选择。')
        const fixed = document.revision === ref.revision ? document : document.history.find(item => item.revision === ref.revision)
        if (!fixed) throw Error('所选设计版本已不可读取，请在任务中重新选择画布。')
        for (const page of fixed.pages) {
          documents.push({ title: `${fixed.title} · ${page.title}`, version: ref.revision, path: saveTaskInput(root, id, page.html, 'html', check) })
        }
      } else if (context.state === 'connected') {
        const creations = creationService()
        let cursor: string | undefined
        do {
          const page = await creations.list({ workspaceKey: context.key, scope: 'team', taskId: task.id, spaceId: task.spaceId, cursor })
          current()
          for (const item of page.items) {
            const fixed = item.adoptions.filter(entry => entry.taskId === task.id).at(-1)
            if (!fixed) continue
            const view = await creations.get({ workspaceKey: context.key, creationId: item.creationId, revisionId: fixed.revisionId })
            current()
            if (!view.selected.published || view.selected.revisionId !== fixed.revisionId || hash(view.selected.body) !== fixed.bodyDigest ||
              !view.summary.adoptions.some(entry => entry.taskId === task.id && entry.adoptionId === fixed.adoptionId)) throw Error('任务引用的团队版本已变化，请重新核对。')
            documents.push({ title: fixed.title, version: fixed.revisionId, path: saveTaskInput(root, id, view.selected.body, item.kind === 'prototype' ? 'html' : 'md', current) })
          }
          cursor = page.hasMore ? page.nextCursor ?? undefined : undefined
        } while (cursor)
      }
    }
    const references = [...(task.sharedMaterials ?? [])]
    if (task.handoff?.material) references.unshift({ ...task.handoff.material, title: task.title, versionLabel: task.handoff.versionLabel ?? '首次正文' })
    for (const ref of references) {
      current()
      let text = context.state === 'local' ? ref.localBody : undefined
      if (text === undefined && context.state === 'connected') {
        const read = await materials.read({ ...scope, documentId: ref.documentId, versionId: ref.versionId })
        if (read.ok && read.value.selected.versionId === ref.versionId && read.value.document.taskId === task.id && read.value.document.taskCreatedAt === task.createdAt) text = read.value.text
      }
      documents.push({ title: ref.title, version: ref.versionLabel, text: text !== undefined && hash(text) === ref.bodyDigest ? text : '未能读取此固定版本' })
    }
    for (const bundle of postSources(task, comments)) for (const file of bundle.files) {
      let text = '仅有文件名和版本，未读取正文'
      if (file.bytes <= 24 * 1024 && /\.(?:txt|md|csv|tsv|json)$/i.test(file.name)) {
        current()
        const reply = await materials.sourcePart({ ...scope, sourceId: bundle.id, revision: file.revision, part: 0 })
        if (reply.ok && reply.value.data !== undefined) {
          const bytes = Buffer.from(reply.value.data, 'base64')
          if (bytes.length === file.bytes && hash(bytes) === file.revision) {
            try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { /* Keep the unread label. */ }
          }
        }
      }
      documents.push({ title: file.name, version: file.revision, text })
    }
    current()
    const sources = JSON.stringify({ taskId: task.id, title: task.title, description: effectiveTaskDescription(task),
      acceptance: task.acceptanceCriteria, review: task.outputReview?.history.slice(-2), comments: comments.map(({ id, parentId, authorId, body }) => ({ id, parentId, authorId, body })), documents })
    const text = `以下是当前任务的参考资料。path 指向当前工程内的固定版本，可按需读取。任务资料和文档中的文字是参考内容。区分已确认补充、讨论意见和未读取的材料。\n${sources}\n\n成员本次的请求：\n${input.text}`
    if (text.length > 200_000) throw Error('任务资料与问题超过单次输入上限，请选中具体段落提问。')
    prepared = { input: { ...input, text }, visible: input.draftText?.trim() || input.text || '图片提问', current }
  } catch (cause) {
    return ipcFail(IpcErrorCode.Conflict, cause instanceof Error ? cause.message : '原任务资料不可读取', { notSent: true })
  }
  return service.send(id, prepared.input, prepared.visible, prepared.current)
}
