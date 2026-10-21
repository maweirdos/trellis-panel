import { net } from 'electron'
import { z } from 'zod'
import { IntegrationError, type KnowledgePort, type ResolvedConnection } from '../types'

const MAX_RESPONSE = 2 * 1024 * 1024
const id = z.string().min(1).max(256)
const collection = z.object({ id, name: z.string().max(1000), knowledge_count: z.number().nonnegative().optional() })
const document = z.object({ id, title: z.string().max(2000).optional(), file_name: z.string().max(2000).optional(), file_type: z.string().max(100).optional(), parse_status: z.string().max(100).optional(), knowledge_base_id: id.optional() })
const hit = z.object({ knowledge_id: id, knowledge_title: z.string().max(2000).optional(), title: z.string().max(2000).optional(), filename: z.string().max(2000).optional(), content: z.string().max(MAX_RESPONSE), knowledge_base_id: id.optional() })
const textTypes = new Set(['md', 'markdown', 'txt', 'json', 'yaml', 'yml', 'csv', 'log'])

function base(connection: ResolvedConnection): string {
  let url: URL
  try { url = new URL(connection.public.config.baseUrl) } catch { throw new IntegrationError('WeKnora 实例地址无效') }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new IntegrationError('WeKnora 实例地址无效')
  if (!connection.secrets.apiKey) throw new IntegrationError('WeKnora 凭证不可用，请重新保存 API Key', 'denied')
  return url.href.replace(/\/+$/, '').replace(/\/api\/v1$/i, '') + '/api/v1'
}

/** Keep Chromium's system proxy/enterprise CA behavior; never follow a credential-bearing redirect. */
async function request(connection: ResolvedConnection, path: string, signal?: AbortSignal, payload?: unknown, write = false): Promise<unknown> {
  const combined = AbortSignal.any([AbortSignal.timeout(write ? 30_000 : 15_000), ...(signal ? [signal] : [])])
  try {
    const response = await net.fetch(base(connection) + path, {
      method: payload === undefined ? 'GET' : 'POST', redirect: 'error', signal: combined,
      headers: { 'X-API-Key': connection.secrets.apiKey, ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
    })
    if (!response.ok) {
      await response.body?.cancel()
      if ([401, 403].includes(response.status)) throw new IntegrationError('WeKnora 拒绝访问，请检查凭证与知识库权限', 'denied')
      if (write && response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status)) throw new IntegrationError(`WeKnora 拒绝发布（HTTP ${response.status}）`, 'invalid')
      throw new IntegrationError(`WeKnora 请求未成功（HTTP ${response.status}）`, write ? 'uncertain' : 'upstream')
    }
    const reader = response.body?.getReader()
    if (!reader) throw new IntegrationError('WeKnora 响应为空', write ? 'uncertain' : 'upstream')
    const chunks: Uint8Array[] = []; let length = 0
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      length += chunk.value.length
      if (length > MAX_RESPONSE) { await reader.cancel(); throw new IntegrationError('WeKnora 响应超过 2 MiB 限额', write ? 'uncertain' : 'upstream') }
      chunks.push(chunk.value)
    }
    let raw: unknown
    try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new IntegrationError('WeKnora 返回无法识别的 JSON', write ? 'uncertain' : 'upstream') }
    const envelope = z.object({ success: z.boolean().optional(), data: z.unknown(), error: z.unknown().optional() }).safeParse(raw)
    if (!envelope.success || !raw || typeof raw !== 'object' || !('data' in raw)) throw new IntegrationError('WeKnora 响应结构不受支持', write ? 'uncertain' : 'upstream')
    if (envelope.data.success === false) throw new IntegrationError('WeKnora 明确拒绝此次操作', write ? 'invalid' : 'upstream')
    return envelope.data.data
  } catch (error) {
    if (error instanceof IntegrationError) throw error
    throw new IntegrationError(signal?.aborted ? '知识操作已取消' : 'WeKnora 网络、超时或响应异常', write ? 'uncertain' : 'upstream')
  }
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new IntegrationError('WeKnora 返回了不支持的数据结构，未将其伪装为空结果', 'upstream')
  return result.data
}

export const weknoraKnowledgePort: KnowledgePort = {
  async collections(connection, signal) {
    const rows = parse(z.array(collection).max(1000), await request(connection, '/knowledge-bases', signal))
    return { items: rows.slice(0, 100).map((row) => ({ id: row.id, name: row.name, knowledgeCount: row.knowledge_count ?? 0 })), hasMore: rows.length > 100 }
  },
  async documents(connection, collectionId, page, signal) {
    const rows = parse(z.array(document).max(100), await request(connection, `/knowledge-bases/${encodeURIComponent(collectionId)}/knowledge?page=${page}&page_size=30`, signal))
    if (rows.some((row) => row.knowledge_base_id && row.knowledge_base_id !== collectionId)) throw new IntegrationError('WeKnora 文档列表包含范围外的知识来源', 'upstream')
    return { items: rows.slice(0, 30).map((row) => ({ id: row.id, title: row.title || row.file_name || row.id, fileType: row.file_type || '', parseStatus: row.parse_status || '' })), page, hasMore: rows.length >= 30 }
  },
  async search(connection, collectionIds, query, limit, signal) {
    const items: Awaited<ReturnType<KnowledgePort['search']>>['items'] = []
    let failures = 0
    let denied = 0
    // Single-collection requests give provenance even when upstream omits per-hit collection IDs.
    for (let offset = 0; offset < collectionIds.length; offset += 2) {
      const page = await Promise.allSettled(collectionIds.slice(offset, offset + 2).map(async (collectionId) => {
        const rows = parse(z.array(hit).max(200), await request(connection, '/knowledge-search', signal, { query, knowledge_base_ids: [collectionId] }))
        return rows.slice(0, limit).map((row) => {
          if (row.knowledge_base_id && row.knowledge_base_id !== collectionId) throw new IntegrationError('WeKnora 返回了范围外的知识来源', 'upstream')
          return { documentId: row.knowledge_id, collectionId, title: row.knowledge_title || row.title || row.filename || row.knowledge_id, text: row.content.slice(0, 6000), truncated: row.content.length > 6000 }
        })
      }))
      for (const result of page) { if (result.status === 'fulfilled') items.push(...result.value); else { failures++; if (result.reason instanceof IntegrationError && result.reason.kind === 'denied') denied++ } }
      if (signal?.aborted) throw new IntegrationError('知识操作已取消', 'upstream')
    }
    if (failures === collectionIds.length) throw new IntegrationError(denied === failures ? 'WeKnora 拒绝项目范围的读取，请检查凭证和权限' : '项目范围内的 WeKnora 检索全部失败', denied === failures ? 'denied' : 'upstream')
    return { items: items.slice(0, limit), partial: failures > 0 }
  },
  async read(connection, documentId, collectionId, signal) {
    const path = `/knowledge/${encodeURIComponent(documentId)}`
    const row = parse(document, await request(connection, path, signal))
    if (row.id !== documentId) throw new IntegrationError('WeKnora 返回的文档身份与来源句柄不一致', 'upstream')
    if (row.knowledge_base_id && row.knowledge_base_id !== collectionId) throw new IntegrationError('远端文档已移出授权检索范围', 'denied')
    const title = row.title || row.file_name || row.id
    if (!row.file_type || !textTypes.has(row.file_type.toLowerCase())) return { title, text: '', mode: 'unsupported', truncated: false }
    const text = parse(z.string().max(MAX_RESPONSE), await request(connection, path + '/preview', signal))
    return { title, text: text.slice(0, 100_000), mode: 'full', truncated: text.length > 100_000 }
  },
  async publish(connection, collectionId, input, signal) {
    if (!input.title.trim() || input.title.length > 200 || input.content.length > 200_000) throw new IntegrationError('发布标题或正文超限，请先修改再预览')
    const data = await request(connection, `/knowledge-bases/${encodeURIComponent(collectionId)}/knowledge/manual`, signal, { title: input.title, content: input.content, status: 'published', channel: 'trellis-panel' }, true)
    const acknowledged = z.object({ id }).safeParse(data)
    if (!acknowledged.success) throw new IntegrationError('远端未返回可核实的文档 ID；请先在 WeKnora 核对，切勿直接重发', 'uncertain')
    return { documentId: acknowledged.data.id }
  }
}
