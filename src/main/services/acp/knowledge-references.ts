import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { extname, isAbsolute } from 'node:path'
import type { AcpKnowledgeReference } from '../../../shared/types'
import { TEXT_EXTS } from '../scan'
import { computeRevision } from '../documents/controller'
import { resolveAuthorizedDocumentPath } from '../documents/paths'
import { knowledgeAccess } from '../knowledge-access/service'
import { withKnowledgeOwner } from '../knowledge-access/workspace-host'
import type { KnowledgeOwner } from '../knowledge-access/types'

const MAX_REFERENCE_BYTES = 128 * 1024

function projectDocument(root: string, path: string, revision: string): string {
  if (isAbsolute(path) || path.includes('\0') || path.replace(/\\/g, '/').split('/').some(part => !part || part === '.' || part === '..')) throw new Error('项目文档路径无效，请重新选择')
  const auth = resolveAuthorizedDocumentPath(root, path)
  if (!auth.ok || !auth.exists || !TEXT_EXTS.has(extname(path).toLowerCase())) throw new Error('项目文档不可用或不是支持的文本文件，请重新选择')
  try {
    const stat = statSync(auth.canonicalPath)
    if (!stat.isFile() || stat.size > MAX_REFERENCE_BYTES) throw new Error('文件不是普通文本或超出引用大小上限')
    const bytes = readFileSync(auth.canonicalPath)
    if (bytes.length !== stat.size || computeRevision(bytes) !== revision) throw new Error('所选文档版本已改变')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (text.includes('\0') || text.length > 100_000) throw new Error('文件包含非文本数据或超出来源记录上限')
    return text
  } catch (error) { throw new Error(`所选项目文档不可读取或已改变：${error instanceof Error ? error.message : '未知错误'}`) }
}

/** Only main-owned snapshots and exact displayed project revisions can enter the prompt. */
export function prepareKnowledgeReferences(owner: KnowledgeOwner, references: AcpKnowledgeReference[], expectedScopeToken: string) {
  const sources = references.filter((item): item is Extract<AcpKnowledgeReference, { kind: 'source' }> => item.kind === 'source')
  if (new Set(references.map(item => item.kind === 'source' ? `s:${item.sourceId}` : `p:${item.relativePath}`)).size !== references.length) throw new Error('同一知识来源不能重复选择')
  const resolve = () => withKnowledgeOwner(owner, () => {
    if (knowledgeAccess.selectionToken(owner) !== expectedScopeToken) throw new Error('项目知识范围已变化，请重新选择')
    return knowledgeAccess.selectedSources(owner, sources)
  })
  const snapshots = resolve()
  const pieces = references.map(reference => {
    if (reference.kind === 'project') return { metadata: { kind: 'project', relativePath: reference.relativePath, revision: reference.displayedRevision }, text: projectDocument(owner.root, reference.relativePath, reference.displayedRevision) }
    const source = snapshots.find(item => item.id === reference.sourceId)!
    return { metadata: { kind: source.kind, sourceId: source.id, title: source.title, documentId: source.documentId, collectionId: source.collectionId, relativePath: source.relativePath, instanceId: source.instanceId, contentHash: source.contentHash, fetchedAt: source.fetchedAt, mode: source.mode, truncated: source.truncated, range: source.range }, text: source.text }
  })
  const boundary = randomUUID()
  const text = pieces.map(piece => `\n--- 参考资料 ${boundary} ---\n${JSON.stringify(piece.metadata)}\n${piece.text}\n--- 参考资料结束 ${boundary} ---\n`).join('')
  if (Buffer.byteLength(text, 'utf8') > MAX_REFERENCE_BYTES) throw new Error('所选知识内容超过 128 KiB，未发送；请减少选择或读取更小的摘录')
  return {
    text,
    metadata: pieces.map(piece => piece.metadata),
    assertCurrent() {
      resolve()
      for (const reference of references) if (reference.kind === 'project') projectDocument(owner.root, reference.relativePath, reference.displayedRevision)
    },
    markSupplied() {
      return withKnowledgeOwner(owner, () => {
        if (knowledgeAccess.selectionToken(owner) !== expectedScopeToken) throw new Error('知识范围已改变，无法记录交付')
        const local = references.flatMap((reference, index) => reference.kind === 'project' ? [{ relativePath: reference.relativePath, revision: reference.displayedRevision, text: pieces[index].text }] : [])
        return knowledgeAccess.recordSelectedDelivery(owner, sources, local)
      })
    }
  }
}
