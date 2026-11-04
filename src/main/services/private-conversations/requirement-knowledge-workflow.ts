import { app } from 'electron'
import { join } from 'node:path'
import { z } from 'zod'
import { checkedDirectory, directoryIdentity, pathKey } from './files'
import { PrivateConversations } from './service'
import { ConversationStorage } from './storage'
import { RequirementKnowledgeService } from './requirement-knowledge'
import { IntegrationError } from '../integrations/types'
import { requirementKnowledgeSourceSnapshotSchema } from '../../../shared/conversation-requirement-knowledge'

const identitySchema = z.object({ conversationId: z.string().uuid(), creatorId: z.string().min(1).max(256) }).strict()

/**
 * Main-only check for already verified, explicitly handed-off snapshots.
 * The caller must prove task/manifest provenance and exact user selection;
 * snapshot hashes and this current-access check do not establish that grant.
 * Never pass renderer-supplied roots, identities or snapshots directly here.
 */
export async function authorizeRequirementKnowledgeForWorkflow(input: {
  conversationId: string
  creatorId: string
  snapshots: readonly unknown[]
  assertCurrent(): void
}): Promise<void> {
  const identity = identitySchema.parse({ conversationId: input.conversationId, creatorId: input.creatorId })
  const snapshots = z.array(requirementKnowledgeSourceSnapshotSchema).max(128).parse(input.snapshots)
  input.assertCurrent()
  const userData = checkedDirectory(app.getPath('userData'))
  // creatorIdentity uses the same owner derivation as the private conversation service.
  const privateService = new PrivateConversations({ directory: () => userData, native: async () => { throw new IntegrationError('只读授权不支持原生执行', 'denied') }, publish: () => {} })
  const creatorId = privateService.creatorIdentity()
  if (creatorId !== identity.creatorId) throw new IntegrationError('需求来源不属于当前本机创建者', 'denied')
  // read() never migrates old catalog records or writes to the conversation.
  const storage = new ConversationStorage(checkedDirectory(join(userData, 'private-conversations')), creatorId, userData)
  const original = storage.read(identity.conversationId)
  const root = original.conversation.workspace.root
  const ownerFingerprint = (row: typeof original): string => JSON.stringify([
    row.conversation.id, row.conversation.creatorId, row.nativeCreatorId, pathKey(row.conversation.workspace.root),
    row.conversation.workspace.kind, row.rootIdentity,
    'sourceGeneration' in row ? row.sourceGeneration : null, row.conversation.nativeRef ?? null
  ])
  const fingerprint = ownerFingerprint(original)
  const assertCurrent = (): void => {
    input.assertCurrent()
    if (pathKey(checkedDirectory(app.getPath('userData'))) !== pathKey(userData) || privateService.creatorIdentity() !== identity.creatorId
      || ownerFingerprint(storage.read(identity.conversationId)) !== fingerprint || directoryIdentity(root) !== original.rootIdentity) {
      throw new IntegrationError('原会话或创建者身份已变化', 'denied')
    }
  }
  const service = new RequirementKnowledgeService()
  try {
    assertCurrent()
    const owner = { conversationId: identity.conversationId, creatorId, root, assertCurrent }
    for (let offset = 0; offset < snapshots.length; offset += 8) {
      await service.authorizeSnapshots(owner, snapshots.slice(offset, offset + 8))
    }
    assertCurrent()
  } finally { service.dispose(); privateService.dispose() }
}
