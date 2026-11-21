import { join, relative } from 'node:path'
import { z } from 'zod'
import type { CruxTaskMaterialsApi, CruxMaterialScope } from '../../../shared/crux-task-materials'
import type { currentPostInput } from '../../../shared/crux'
import { sourceDigest, SOURCE_FILE_BYTES, SOURCE_PART_BYTES } from '../../../shared/task-source-files'
import { checkedDirectory, hash, readRegular } from '../private-conversations/files'
import { readOptional, writeRevision } from '../private-conversations/requirement-files'

export const agentAttachment = z.object({ name: z.string(), revision: sourceDigest, path: z.string(), text: z.string().optional() }).strict()
export type AgentAttachment = z.infer<typeof agentAttachment>

export function verifyAgentAttachments(dataDir: string, attachments: AgentAttachment[] = []): void {
  for (const file of attachments) {
    const name = relative(dataDir, file.path).replaceAll('\\', '/')
    if (!/^task-attachments\/[a-f0-9]{64}\/[a-f0-9]{64}\.bin$/.test(name) ||
      hash(readRegular(dataDir, name, SOURCE_FILE_BYTES).bytes) !== file.revision) throw Error(`任务附件已变化：${file.name}`)
  }
}

/** Authorize even a cache hit against the original task and source. Local names never come from the sender. */
export async function readAgentAttachments(dataDir: string, scope: CruxMaterialScope, actorId: string,
  sources: ReturnType<typeof currentPostInput>['sources'], read: CruxTaskMaterialsApi['sourcePart'], current: () => void): Promise<AgentAttachment[]> {
  const result: AgentAttachment[] = []
  let inlineBudget = 8192
  for (const source of sources) for (const file of source.files) {
    const root = checkedDirectory(dataDir)
    const relative = `task-attachments/${hash(JSON.stringify([scope.workspaceKey, scope.spaceId, scope.taskId, scope.taskCreatedAt, actorId, source.id]))}/${file.revision}.bin`
    const chunks: Buffer[] = []
    let bytes: Buffer | undefined
    for (const [part, expected] of file.parts.entries()) {
      current()
      const reply = await read({ ...scope, sourceId: source.id, revision: file.revision, part })
      current()
      if (!reply.ok) throw Error(`${file.name}：${reply.error}`)
      const item = reply.value
      if (item.taskId !== scope.taskId || item.spaceId !== scope.spaceId || item.taskCreatedAt !== scope.taskCreatedAt ||
        item.sourceId !== source.id || item.revision !== file.revision || item.part !== part || item.digest !== expected || item.data === undefined) throw Error(`附件来源不符：${file.name}`)
      const chunk = Buffer.from(item.data, 'base64')
      if (hash(chunk) !== expected || chunk.length !== Math.min(SOURCE_PART_BYTES, file.bytes - part * SOURCE_PART_BYTES)) throw Error(`附件分片不完整：${file.name}`)
      if (part === 0) {
        bytes = readOptional(root, relative, file.bytes)?.bytes
        if (bytes) break
      }
      chunks.push(chunk)
    }
    const body = bytes ?? Buffer.concat(chunks)
    if (body.length !== file.bytes || hash(body) !== file.revision) throw Error(`附件版本不符：${file.name}`)
    if (!bytes) writeRevision(root, relative, body, null, current)
    const entry: AgentAttachment = { name: file.name, revision: file.revision, path: join(root, relative) }
    if (body.length <= inlineBudget && /\.(?:md|txt|csv|tsv|json)$/i.test(file.name)) {
      try { entry.text = new TextDecoder('utf-8', { fatal: true }).decode(body); inlineBudget -= body.length } catch { /* original bytes remain available */ }
    }
    result.push(entry)
  }
  return result
}
