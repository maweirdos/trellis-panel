import type { RequirementView } from '@shared/conversation-requirements'
import type { NewTaskModalProps } from '../crux/pages/TaskCreateModal'
import type { WorkspaceEntry } from './workspace'

/** Stable source identity lets the existing task form reconcile an interrupted creation. */
export async function conversationTeamHandoff(entry: WorkspaceEntry, requirement: RequirementView): Promise<NonNullable<NewTaskModalProps['handoff']>> {
  const conversation = entry.conversation
  if (!conversation) throw new Error('请先保存原对话。')
  const draft = requirement.draft
  if (draft.conversationId !== conversation.id || draft.creatorId !== conversation.creatorId || requirement.fileState !== 'saved') throw new Error('需求版本不属于当前可读取的原会话。')
  const identity = JSON.stringify(['conversation-team-handoff-v1', conversation.creatorId, conversation.id, [draft.id, draft.revision]])
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity))).slice(0, 16)
  bytes[6] = bytes[6] & 0x0f | 0x40; bytes[8] = bytes[8] & 0x3f | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  const pinned = draft?.references ?? []
  const fileChoices = [
    ...pinned.map(file => ({ fileId: file.fileId, name: file.name, bytes: file.bytes, revision: file.revision, selected: false, pinned: true })),
    ...entry.files.filter(file => !pinned.some(ref => ref.fileId === file.id)).map(file => ({
      fileId: file.id, name: file.name, bytes: file.bytes, revision: file.revision, sourceIdentity: file.sourceIdentity,
      selected: false
    }))
  ]
  return {
    ...(fileChoices.length ? { fileChoices } : {}),
    id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    title: (draft?.title ?? conversation.title).slice(0, 200),
    description: draft.body,
    conversationId: conversation.id,
    creatorId: conversation.creatorId,
    ...(draft ? { draftId: draft.id } : {}),
    ...(draft ? { attachByDefault: true, material: { title: draft.title, body: draft.body, versionLabel: `需求版本 ${draft.revision.slice(0, 8)}` } } : {})
  }
}
