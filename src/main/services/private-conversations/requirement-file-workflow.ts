import { app } from 'electron'
import { z } from 'zod'
import { checkedDirectory, hash, pathKey } from './files'
import { PrivateConversations } from './service'

const fileSchema = z.object({ fileId: z.string().min(1).max(256), originalPath: z.string().min(1).max(8192), revision: z.string().regex(/^[a-f0-9]{64}$/), projectRoot: z.string().min(1).max(8192).optional(), expectedName: z.string().min(1).max(500).optional() }).passthrough()

/** Reopen the original creator's current conversation and verify every selected original file. */
export async function authorizeRequirementFilesForWorkflow(input: { conversationId: string; creatorId: string; files: unknown[]; assertCurrent(): void }): Promise<void> {
  const files = z.array(fileSchema).max(24).parse(input.files)
  const userData = checkedDirectory(app.getPath('userData'))
  const service = new PrivateConversations({ directory: () => userData, native: async () => { throw new Error('只读授权不支持原生执行') }, publish: () => {} })
  try {
    input.assertCurrent()
    if (service.creatorIdentity() !== input.creatorId) throw new Error('原文件不属于当前创建者')
    const owner = await service.workspaceAccess(input.conversationId, true)
    if (owner.conversation.creatorId !== input.creatorId) throw new Error('原会话创建者已变化')
    for (const file of files) {
      input.assertCurrent(); owner.assertCurrent()
      if (file.projectRoot && (owner.conversation.kind !== 'code' || owner.conversation.workspace.kind !== 'directory' || pathKey(checkedDirectory(file.projectRoot)) !== pathKey(checkedDirectory(owner.conversation.workspace.root)))) throw new Error('设计文件工程不属于原授权会话')
      const actual = await service.file(input.conversationId, file.fileId, file.revision)
      if (actual.file.id !== file.fileId || actual.file.relativePath !== file.originalPath || actual.file.revision !== file.revision || file.expectedName && actual.file.name !== file.expectedName || hash(Buffer.from(actual.bytes)) !== file.revision) throw new Error('原文件权限或版本已变化')
    }
    owner.assertCurrent(); input.assertCurrent()
  } finally { service.dispose() }
}
