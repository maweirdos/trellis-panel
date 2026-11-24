import { createHash } from 'node:crypto'
import type { ConversationAttachmentDraftTarget, ConversationAttachmentReferences } from '../../../../shared/conversation/attachments'
import type { ChatAttachment } from '../../../../shared/conversation/chatAttachment'
import type { ConversationAuthority } from '../../../../shared/conversation/desktop'
import { DaemonError } from '../../../daemon/errors'
import type { ConversationAttachmentStore, ConversationAttachmentDraftScope } from '.'

export function conversationAttachmentDraftScope(authority: ConversationAuthority, target: ConversationAttachmentDraftTarget): ConversationAttachmentDraftScope {
  const { ownerId, spaceId, cwd: root, projectId, binding } = authority
  const identity = binding.kind === 'personal'
    ? [binding.kind]
    : [binding.kind, binding.mode ?? 'execution', binding.taskId, binding.executionId, binding.nodeId, binding.assigneeGeneration, binding.materialRevision, binding.codeRevision]
  const draftId = createHash('sha256').update(JSON.stringify(target.requestId
    ? [projectId, identity, target.threadId, target.draftId, target.requestId, target.generation]
    : [projectId, identity, target.threadId ?? null, target.draftId])).digest('hex')
  return { ownerId, spaceId, root, draftId }
}

export function prepareConversationAttachmentClaim(
  store: ConversationAttachmentStore | undefined,
  authority: ConversationAuthority | undefined,
  input: ConversationAttachmentReferences & { readonly commandId: string; readonly requestId?: string; readonly generation?: number },
  threadId: string,
  newThread = false,
): { readonly attachments: readonly ChatAttachment[]; commit(): void } | undefined {
  if (!input.attachmentIds?.length) return undefined
  if (!input.draftId) throw new DaemonError('E_INVALID_ARG', '发送附件需要原草稿。')
  if (!store || !authority) throw new DaemonError('E_DENIED', '附件缺少原会话授权。')
  if (input.requestId && input.attachmentIds.some(id => !id.startsWith('pending_'))) {
    throw new DaemonError('E_INVALID_ARG', '提问只接收该次请求草稿中的临时附件。')
  }
  const scope = conversationAttachmentDraftScope(authority, {
    draftId: input.draftId, threadId: newThread ? undefined : threadId, requestId: input.requestId, generation: input.generation,
  })
  const claim = { threadId, claimId: input.commandId, attachmentIds: input.attachmentIds }
  const attachments = store.previewClaim(scope, claim)
  return { attachments, commit: () => { store.claim(scope, claim) } }
}
