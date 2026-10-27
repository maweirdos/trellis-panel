import { isConversationRuntimeEvent } from './runtime-events'
import type { TimelineEvent } from '../../../shared/types'
import { projectRootKey } from '../my/navigation'
import type { KnowledgeOperation } from '../../../shared/knowledge-conversation'

export type ConversationKnowledgeOperation = KnowledgeOperation

const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/** Only server-issued operation facts establish a result; model prose is never parsed. */
export function readKnowledgeOperation(event: TimelineEvent): ConversationKnowledgeOperation | undefined {
  if (!isConversationRuntimeEvent(event) || event.kind !== 'diagnostic' || !event.projectRoot || !event.sessionId || !event.turnId || !event.connectionGeneration || event.payload?.activityScope !== 'turn') return undefined
  const value = object(event.payload.knowledgeOperation)
  if (!value || typeof value.operationId !== 'string' || !value.operationId.trim() || typeof value.kind !== 'string' || !['context', 'search', 'read', 'save_document', 'publish_document', 'handoff'].includes(value.kind) || typeof value.phase !== 'string' || !['running', 'completed', 'failed', 'needs_clarification', 'uncertain', 'cancelled'].includes(value.phase) || typeof value.detail !== 'string') return undefined
  if (['query', 'artifactId', 'artifactRevision', 'relativePath', 'publicationId', 'taskDir', 'detail', 'code'].some((key) => value[key] !== undefined && typeof value[key] !== 'string')) return undefined
  if (value.status !== undefined && (typeof value.status !== 'string' || !['ok', 'empty', 'partial', 'not_configured', 'denied', 'unavailable', 'cancelled'].includes(value.status))) return undefined
  if (value.persistence !== undefined && value.persistence !== 'durable' && value.persistence !== 'degraded') return undefined
  if (value.sourceIds !== undefined && (!Array.isArray(value.sourceIds) || value.sourceIds.some((id) => typeof id !== 'string' || !id.trim()))) return undefined
  return value as unknown as ConversationKnowledgeOperation
}

export function knowledgeOperationIdentity(event: TimelineEvent, operationId: string): string {
  return JSON.stringify([projectRootKey(event.projectRoot), event.sessionId, event.connectionGeneration, event.turnId, operationId])
}

/** A native tool is replaced only when its structured result carries the issued marker. */
export function nativeKnowledgeOperationId(payload: Record<string, unknown>): string | undefined {
  const ids = new Set<string>()
  const inspect = (value: unknown): void => {
    const result = object(value)
    if (!result) return
    const marker = object(result.knowledgeOperation)
    const id = marker?.operationId ?? result.operationId
    if (typeof id === 'string' && id.trim() && (marker || ['ok', 'empty', 'partial', 'not_configured', 'denied', 'unavailable', 'completed', 'failed', 'needs_clarification', 'uncertain', 'cancelled'].includes(String(result.status)))) ids.add(id)
    const metadata = object(object(result._meta)?.trellisKnowledge)
    if (typeof metadata?.operationId === 'string' && metadata.operationId.trim() && metadata.operationId.length <= 256) ids.add(metadata.operationId)
  }
  const inspectContent = (value: unknown): void => {
    if (!Array.isArray(value)) return
    for (const entry of value) {
      const block = object(entry)
      const content = block?.type === 'content' ? object(block.content) : block
      if (content?.type !== 'text' || typeof content.text !== 'string' || content.text.length > 2 * 1024 * 1024) continue
      try { inspect(JSON.parse(content.text)) } catch { /* Non-JSON native tool output is unrelated. */ }
    }
  }
  const output = object(payload.rawOutput)
  // Codex ACP wraps MCP CallToolResult in {result,error}; Claude can return it directly.
  for (const result of [output, object(output?.result)]) {
    inspect(result); inspect(result?.structuredContent); inspectContent(result?.content)
  }
  inspectContent(payload.rawOutput)
  return ids.size === 1 ? [...ids][0] : undefined
}

export function knowledgeOperationLabel(operation: ConversationKnowledgeOperation, live: boolean): string {
  const noun = { context: '项目材料读取', search: '知识检索', read: '资料读取', save_document: '需求说明生成', publish_document: '知识发布', handoff: '开发交接' }[operation.kind]
  if (operation.phase === 'running') return live ? { context: '正在确认项目材料…', search: '正在检索知识库…', read: '正在阅读相关资料…', save_document: '正在整理需求说明…', publish_document: '正在发布到知识库…', handoff: '正在交接到开发任务…' }[operation.kind] : `${noun}未完成`
  if (operation.kind === 'search' && (operation.phase === 'completed' || operation.phase === 'failed' && operation.status && !['ok', 'empty', 'partial'].includes(operation.status))) return knowledgeSearchResultLabel(operation)
  if (operation.phase === 'failed') return `${noun}失败`
  if (operation.phase === 'cancelled') return `${noun}已取消`
  if (operation.phase === 'needs_clarification') return `${noun}需要你补充信息`
  if (operation.phase === 'uncertain') return `${noun}结果待核实`
  return { context: '已读取项目材料', search: `检索到 ${new Set(operation.sourceIds ?? []).size} 份资料`, read: '已读取相关资料', save_document: '已生成需求说明', publish_document: '已发布到知识库', handoff: '已交接到开发任务' }[operation.kind]
}

function knowledgeSearchResultLabel(operation: ConversationKnowledgeOperation): string {
  const count = new Set(operation.sourceIds ?? []).size
  const degraded = operation.persistence === 'degraded'
  const labels: Partial<Record<NonNullable<ConversationKnowledgeOperation['status']>, string>> = {
    empty: '未检索到相关资料', partial: degraded ? '知识检索不完整' : `知识检索不完整 · ${count} 份资料`,
    not_configured: '项目知识库未配置', denied: '知识库访问受限', unavailable: '知识库检索暂不可用', cancelled: '知识检索已取消'
  }
  const label = operation.status && labels[operation.status] || (degraded ? '已检索知识库' : `检索到 ${count} 份资料`)
  return degraded ? `${label} · 资料记录未完整保存` : label
}

export function knowledgeOperationDetail(operation: ConversationKnowledgeOperation): string {
  if (operation.kind === 'search' && operation.phase === 'completed' && (!operation.status || operation.status === 'ok') && operation.persistence !== 'degraded' && operation.detail === '已检索本地与项目远端范围') return ''
  const labels: Record<string, string> = {
    'Project workflow context; reference data is not action authorization': '已读取当前项目的知识范围、需求材料和开发任务。',
    'Current task PRD read for a revision-aware planning handoff': '已读取开发任务当前版本，后续交接会核对是否发生修改。',
    'Read the exact saved document version': '已读取此需求说明的保存版本。',
    'The project file changed externally. Use document.body and document.revision to preserve those edits in a subsequent update.': '项目文档有外部修改，后续更新会以当前正文和版本为依据，保留已有修改。',
    'Requirements document saved in the project': '需求说明已保存到当前项目，可直接阅读或继续在会话中修改。',
    'Requirements document written from this conversation; unresolved questions remain in the document. Formal business review is not asserted.': '已根据本次讨论保存需求说明，并保留未决问题；尚未记录正式业务评审。',
    'Developer planning handoff saved; implementation has not started': '已保存开发需求并交接到规划任务，可以继续开发规划。',
    'Developer PRD saved with the product document backlink. Implementation has not started.': '已保存开发需求和产品文档关联，可以继续开发规划。',
    'Publication was attempted; verify the remote outcome before any resend': '发布请求已经发出，远端结果待核实；请先确认此次结果再继续。',
    'Choose a known project document': '请在会话中说明要使用哪一份已保存的项目文档。'
  }
  return labels[operation.detail] ?? operation.detail
}
