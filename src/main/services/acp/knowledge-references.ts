import { randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readSync, statSync } from 'node:fs'
import { extname, isAbsolute } from 'node:path'
import type { AcpKnowledgeReference } from '../../../shared/types'
import { TEXT_EXTS } from '../scan'
import { computeRevision } from '../documents/controller'
import { resolveAuthorizedDocumentPath } from '../documents/paths'
import { knowledgeAccess } from '../knowledge-access/service'
import { withKnowledgeOwner } from '../knowledge-access/workspace-host'
import type { KnowledgeOwner } from '../knowledge-access/types'

const MAX_REFERENCE_BYTES = 128 * 1024

function projectDocumentBytes(root: string, path: string, limit: number): Buffer {
  if (isAbsolute(path) || path.includes('\0') || path.replace(/\\/g, '/').split('/').some(part => !part || part === '.' || part === '..')) throw new Error('项目文档路径无效，请重新选择')
  const auth = resolveAuthorizedDocumentPath(root, path)
  if (!auth.ok || !auth.exists || !TEXT_EXTS.has(extname(path).toLowerCase())) throw new Error('项目文档不可用或不是支持的文本文件，请重新选择')
  const expected = statSync(auth.canonicalPath, { bigint: true })
  if (!expected.isFile() || expected.size > BigInt(limit)) throw new Error('文件不是普通文本或超出引用大小上限')
  const fd = openSync(auth.canonicalPath, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK))
  try {
    const opened = fstatSync(fd, { bigint: true })
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino || opened.size !== expected.size) {
      throw new Error('所选文档在打开时改变')
    }
    const bytes = Buffer.alloc(Number(opened.size))
    let offset = 0
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (!read) break
      offset += read
    }
    const after = fstatSync(fd, { bigint: true })
    const current = resolveAuthorizedDocumentPath(root, path)
    const currentStat = current.ok && current.exists ? statSync(current.canonicalPath, { bigint: true }) : null
    if (offset !== bytes.length || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs
        || !current.ok || current.canonicalPath !== auth.canonicalPath || !currentStat ||
        currentStat.dev !== opened.dev || currentStat.ino !== opened.ino || currentStat.size !== after.size ||
        currentStat.mtimeNs !== after.mtimeNs || currentStat.ctimeNs !== after.ctimeNs) throw new Error('所选文档在读取时改变')
    return bytes
  } finally { closeSync(fd) }
}

function projectDocument(root: string, path: string, revision: string): string {
  try {
    const bytes = projectDocumentBytes(root, path, MAX_REFERENCE_BYTES)
    if (computeRevision(bytes) !== revision) throw new Error('所选文档版本已改变')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (text.includes('\0') || text.length > 100_000) throw new Error('文件包含非文本数据或超出来源记录上限')
    return text
  } catch (error) { throw new Error(`所选项目文档不可读取或已改变：${error instanceof Error ? error.message : '未知错误'}`) }
}

/** Only main-owned snapshots and exact displayed project revisions can enter the prompt. */
export function prepareKnowledgeReferences(owner: KnowledgeOwner, references: AcpKnowledgeReference[], expectedScopeToken: string, verifyDocumentVersion = false) {
  const sources = references.filter((item): item is Extract<AcpKnowledgeReference, { kind: 'source' }> => item.kind === 'source')
  if (new Set(references.map(item => item.kind === 'source' ? `s:${item.sourceId}` : `p:${item.relativePath}`)).size !== references.length) throw new Error('同一知识来源不能重复选择')
  const resolve = () => withKnowledgeOwner(owner, () => {
    if (knowledgeAccess.selectionToken(owner) !== expectedScopeToken) throw new Error('项目知识范围已变化，请重新选择')
    const selected = knowledgeAccess.selectedSources(owner, sources)
    if (verifyDocumentVersion) {
      for (const source of selected) {
        if (!source.documentRevision) throw new Error('无法核对当前资料版本，请重新打开资料后选择')
        if (source.kind === 'local' && (!source.relativePath || computeRevision(projectDocumentBytes(owner.root, source.relativePath, 512 * 1024)) !== source.documentRevision)) {
          throw new Error('所选本地知识文档版本已改变，请重新选择')
        }
      }
    }
    return selected
  })
  const snapshots = resolve()
  const pieces = references.map(reference => {
    if (reference.kind === 'project') return { metadata: { kind: 'project', relativePath: reference.relativePath, revision: reference.displayedRevision }, text: projectDocument(owner.root, reference.relativePath, reference.displayedRevision) }
    const source = snapshots.find(item => item.id === reference.sourceId)!
    return { metadata: { kind: source.kind, sourceId: source.id, title: source.title, documentId: source.documentId, collectionId: source.collectionId, relativePath: source.relativePath, instanceId: source.instanceId, contentHash: source.contentHash, revision: source.documentRevision, fetchedAt: source.fetchedAt, mode: source.mode, truncated: source.truncated, range: source.range }, text: source.text }
  })
  const boundary = randomUUID()
  const text = pieces.map(piece => `\n--- 参考资料 ${boundary} ---\n${JSON.stringify(piece.metadata)}\n${piece.text}\n--- 参考资料结束 ${boundary} ---\n`).join('')
  if (Buffer.byteLength(text, 'utf8') > MAX_REFERENCE_BYTES) throw new Error('所选知识内容超过 128 KiB，未发送；请减少选择或读取更小的摘录')
  return {
    text,
    metadata: pieces.map(piece => piece.metadata),
    async assertRemoteCurrent(signal: AbortSignal) {
      for (const source of resolve()) {
        if (source.kind === 'weknora') await withKnowledgeOwner(owner, () => knowledgeAccess.assertSelectedRemoteRevision(owner, source, signal))
      }
    },
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
