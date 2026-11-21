import type { CruxTask, CruxTaskSharedMaterial } from '@shared/crux'
import type { CruxWorkspaceContext } from '@shared/crux-remote'
import { api } from '../../../api'
import { conversationClient, conversationValue } from '../../../conversations/client'
import { bodyDigest } from '../../intake/requirements'

const uuid = '[a-f\\d]{8}(?:-[a-f\\d]{4}){3}-[a-f\\d]{12}'
const draftPath = new RegExp(`(?<![\\w./:%\\\\-])(?:outputs/|\\.trellis-panel/conversations/${uuid}/)requirements/(${uuid})/draft\\.md(?![\\w/\\\\?#%-]|\\.[\\w])`, 'gi')

export function taskDraftReferences(text: string) {
  return Array.from(text.matchAll(draftPath), match => ({ path: match[0], draftId: match[1], offset: match.index! }))
}

type Material = Pick<CruxTaskSharedMaterial, 'documentId' | 'versionId' | 'bodyDigest' | 'localBody'>
export async function readTaskPostMaterial(task: CruxTask, context: CruxWorkspaceContext, material: Material): Promise<string> {
  if (context.state === 'local' && material.localBody !== undefined) {
    if (await bodyDigest(material.localBody) !== material.bodyDigest) throw Error('本机共享版本校验失败。')
    return material.localBody
  }
  if (!api.cruxMaterials) throw Error('当前客户端无法读取团队材料。')
  const result = await api.cruxMaterials.read({ workspaceKey: context.key, taskId: task.id, spaceId: task.spaceId,
    taskCreatedAt: task.createdAt, documentId: material.documentId, versionId: material.versionId })
  if (!result.ok) throw Error(result.error)
  const { document, selected, text } = result.value
  if (document.taskId !== task.id || document.spaceId !== task.spaceId || document.taskCreatedAt !== task.createdAt ||
    document.documentId !== material.documentId || selected.documentId !== material.documentId || selected.versionId !== material.versionId ||
    selected.bodyDigest !== material.bodyDigest || await bodyDigest(text) !== material.bodyDigest) {
    throw Error('共享文档与任务记录的版本不符。')
  }
  return text
}

export interface PostDocument {
  title: string
  source: string
  read(): Promise<string>
}

/** A path in prose is a lookup key, never permission to read a machine path. */
export async function resolvePostDocuments(paths: string[], task: CruxTask, context: CruxWorkspaceContext, ownConversationIds: string[], current: () => boolean) {
  const found = new Map<string, PostDocument>()
  for (const path of paths) {
    const id = taskDraftReferences(path)[0]?.draftId
    if (!id) continue
    const shared = task.sharedMaterials?.filter(item => item.sourceDraftId === id).at(-1)
    const handoff = task.handoff?.sourceDraftId === id ? task.handoff : undefined
    const material = shared ?? handoff?.material
    if (material) found.set(path, { title: shared?.title || '需求初稿', source: shared?.versionLabel ?? handoff?.versionLabel ?? '共享版本',
      read: () => readTaskPostMaterial(task, context, material) })
  }
  const privatePaths = paths.filter(path => !found.has(path))
  const client = conversationClient()
  if (!client || !privatePaths.length) return found
  const ambiguous = new Set<string>()
  for (const id of ownConversationIds) {
    if (!current()) break
    const drafts = await client.requirements?.list?.(id).then(conversationValue).catch(() => []) ?? []
    const byPath = new Map(drafts.filter(draft => draft.conversationId === id).map(draft => [draft.relativePath, draft]))
    if (!current()) break
    const files = privatePaths.some(path => !byPath.has(path))
      ? await client.files(id).then(conversationValue).catch(() => []) : []
    if (!current()) break
    for (const path of privatePaths) {
      const draft = byPath.get(path)
      const file = files.find(item => item.relativePath === path)
      if (!file && !draft || ambiguous.has(path)) continue
      if (found.has(path)) { found.delete(path); ambiguous.add(path); continue }
      found.set(path, {
        title: draft?.title || '需求初稿', source: '原会话文件',
        async read() {
          if (file) {
            const document = conversationValue(await client.readFile(id, { fileId: file.id, expectedSourceIdentity: file.sourceIdentity, expectedRevision: file.revision }))
            if (document.revision !== file.revision) throw Error('初稿已更改，请重新打开任务。')
            return document.body
          }
          if (!draft) throw Error('原会话文件不可用。')
          const view = conversationValue(await client.requirements.read(id, draft.id))
          if (view.draft.conversationId !== id || view.draft.id !== draft.id || view.draft.relativePath !== path ||
            view.fileState !== 'saved' || view.draft.bodyRevision !== draft.bodyRevision) throw Error('初稿已更改或不可用，请在原会话中核对。')
          return view.draft.body
        }
      })
    }
  }
  return found
}
