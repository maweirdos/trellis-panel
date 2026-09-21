import { net, safeStorage } from 'electron'
import { randomBytes } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { basename, join, relative, sep } from 'path'
import type {
  WeknoraConfig,
  WeknoraDocSummary,
  WeknoraHit,
  WeknoraKbSummary,
  WeknoraPushResult,
  WeknoraReadResult
} from '../../shared/types'

/**
 * WeKnora REST 客户端（公司级知识库联动）。
 *
 * 面向 WeKnora /api/v1 开放接口：X-API-Key 鉴权、`{ data, success }` 信封。
 * 本地四库索引（knowledge.ts）保持不动——本服务只提供"远程公司库"这一路来源，
 * 所有调用失败均以 ok:false 返回，绝不阻塞本地检索体验。
 * 文档：https://github.com/Tencent/WeKnora/tree/main/docs/api
 *
 * 网络层用 Electron net.fetch（Chromium 网络栈）而非 Node fetch：
 * 内网 HTTPS 的企业 CA / 自签证书走 Windows 系统证书库自动信任，且遵循系统代理——
 * Node fetch 自带 CA 信任库会在这些部署下直接连接失败。
 */

const TIMEOUT_MS = 8_000
const PUSH_TIMEOUT_MS = 30_000
/** 面板推送的知识统一打这个渠道标记，WeKnora 后台可按渠道过滤面板来源 */
export const WEKNORA_CHANNEL = 'trellis-panel'

export class WeknoraError extends Error {}

/* ---------------- 密钥保护（与 ai.ts / jira.ts 同一 DPAPI 模式） ---------------- */

function protect(plain: string): { secret: string; encrypted: boolean } {
  try {
    if (plain && safeStorage.isEncryptionAvailable()) {
      return { secret: safeStorage.encryptString(plain).toString('base64'), encrypted: true }
    }
  } catch {
    // fall through to plaintext
  }
  return { secret: plain, encrypted: false }
}

function reveal(secret: string, encrypted?: boolean): string {
  if (!secret || !encrypted) return secret
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(secret, 'base64'))
    }
  } catch {
    return ''
  }
  return ''
}

export function protectWeknoraKey(plain: string): { apiKey: string; apiKeyEncrypted: boolean } {
  const p = protect(plain)
  return { apiKey: p.secret, apiKeyEncrypted: p.encrypted }
}

export function protectWeknoraMcpToken(plain: string): { mcpToken: string; mcpTokenEncrypted: boolean } {
  const p = protect(plain)
  return { mcpToken: p.secret, mcpTokenEncrypted: p.encrypted }
}

/** 明文读取端点令牌（内部解密；渲染层永远拿不到密文对应的明文） */
export function weknoraMcpTokenOf(cfg: WeknoraConfig): string {
  return reveal(cfg.mcpToken, cfg.mcpTokenEncrypted)
}

function apiKeyOf(cfg: WeknoraConfig): string {
  return reveal(cfg.apiKey, cfg.apiKeyEncrypted)
}

/* ---------------- 端点规范化 ---------------- */

/** 归一化 baseUrl → `http://host[:port]/api/v1`（允许带 /api/v1 或尾斜杠） */
export function resolveWeknoraApiBase(baseUrl: string): string {
  let u = baseUrl.trim().replace(/\s+/g, '')
  if (!u) return ''
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`
  u = u.replace(/\/+$/, '')
  u = u.replace(/\/api\/v1$/i, '')
  return `${u}/api/v1`
}

/* ---------------- 请求核心 ---------------- */

interface WkInit {
  method?: 'GET' | 'POST' | 'DELETE'
  json?: unknown
  /** 手工构造的 multipart 体（net.fetch 对 FormData 的序列化无保证，文件上传统一走这里） */
  rawBody?: Buffer
  contentType?: string
  timeoutMs?: number
  /** 允许的失败状态码（如 409 = 文件重复），命中时不抛错 */
  acceptStatus?: number[]
}

/** 手工构造 multipart/form-data（单文件 + 若干字符串字段），返回 Buffer 体与 Content-Type */
function buildMultipart(fileBuf: Buffer, fileName: string, fields: Record<string, string>): { body: Buffer; contentType: string } {
  const boundary = `----tpanel-${randomBytes(16).toString('hex')}`
  const parts: Buffer[] = []
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf-8'))
  }
  const safeName = fileName.replace(/["\\\r\n]/g, '_')
  parts.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\nContent-Type: application/octet-stream\r\n\r\n`, 'utf-8'),
    fileBuf,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8')
  )
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` }
}

/** 官方错误信封 {success:false, error:{code,message,details}} → 可读文本 */
function extractEnvelopeError(env: Record<string, unknown>): string {
  const err = env.error
  if (err && typeof err === 'object') {
    const o = err as { message?: string; code?: string; details?: string }
    return [o.code, o.message, o.details].filter((x) => typeof x === 'string' && x).join('：')
  }
  if (typeof err === 'string' && err) return err
  if (typeof env.message === 'string' && env.message) return env.message
  return ''
}

async function wkFetch<T>(cfg: WeknoraConfig, path: string, init: WkInit = {}): Promise<{ status: number; data: T | null }> {
  const base = resolveWeknoraApiBase(cfg.baseUrl)
  if (!base) throw new WeknoraError('未配置 WeKnora 地址')
  const key = apiKeyOf(cfg)
  if (!key) throw new WeknoraError('未配置 WeKnora API Key（在 WeKnora 网页「账户信息」页获取）')

  const method = init.method ?? 'GET'
  const url = base + path
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? TIMEOUT_MS)
  try {
    const headers: Record<string, string> = { 'X-API-Key': key }
    let body: Buffer | string | undefined
    if (init.json !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(init.json)
    } else if (init.rawBody) {
      headers['Content-Type'] = init.contentType ?? 'application/octet-stream'
      body = init.rawBody
    }
    const res = await net.fetch(url, {
      method,
      signal: controller.signal,
      headers,
      ...(body !== undefined ? { body } : {})
    })
    if (!res.ok && !(init.acceptStatus ?? []).includes(res.status)) {
      const text = (await res.text().catch(() => '')).slice(0, 300)
      const hint = res.status === 401 || res.status === 403 ? '（API Key 无效或权限不足）' : ''
      throw new WeknoraError(`HTTP ${res.status}${hint} · ${method} ${url}${text ? ` · ${text}` : ''}`.trim())
    }
    const raw = (await res.text().catch(() => ''))
    if (!raw) return { status: res.status, data: null }
    let env: { data?: T; success?: boolean; message?: string; error?: unknown }
    try {
      env = JSON.parse(raw) as { data?: T; success?: boolean; message?: string; error?: unknown }
    } catch {
      throw new WeknoraError(`响应不是 JSON（可能地址不对或被网关拦截）· ${method} ${url} · ${raw.slice(0, 200)}`)
    }
    if (env.success === false) {
      const msg = extractEnvelopeError(env as Record<string, unknown>)
      throw new WeknoraError(`${msg || '服务端返回 success:false'} · ${method} ${url}`)
    }
    return { status: res.status, data: (env.data ?? null) as T | null }
  } catch (e) {
    const err = e as Error
    if (err instanceof WeknoraError) throw err
    if (err.name === 'AbortError') {
      throw new WeknoraError(`请求超时（${(init.timeoutMs ?? TIMEOUT_MS) / 1000}s，服务器无响应）· ${method} ${url}`)
    }
    // Chromium 网络错误（net::ERR_CONNECTION_REFUSED / ERR_CERT_AUTHORITY_INVALID / ERR_NAME_NOT_RESOLVED…）原样透出
    throw new WeknoraError(err.message || String(err))
  } finally {
    clearTimeout(timer)
  }
}

/* ---------------- 开放能力 ---------------- */

export async function weknoraTest(cfg: WeknoraConfig): Promise<{ ok: boolean; error?: string; kbs?: WeknoraKbSummary[] }> {
  try {
    const { data } = await wkFetch<Array<Record<string, unknown>>>(cfg, '/knowledge-bases')
    const kbs: WeknoraKbSummary[] = (Array.isArray(data) ? data : []).map((k) => ({
      id: String(k.id ?? ''),
      name: String(k.name ?? k.id ?? ''),
      knowledgeCount: Number(k.knowledge_count ?? 0)
    }))
    return { ok: true, kbs }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export async function weknoraSearch(
  cfg: WeknoraConfig,
  query: string,
  limit = 10
): Promise<{ ok: boolean; error?: string; hits: WeknoraHit[]; elapsedMs: number }> {
  const t0 = Date.now()
  const kbIds = (cfg.searchKbIds ?? []).map((s) => String(s).trim()).filter(Boolean)
  if (!cfg.enabled || !kbIds.length) {
    return { ok: false, error: cfg.enabled ? '未配置公司库检索范围' : 'WeKnora 未启用', hits: [], elapsedMs: 0 }
  }
  try {
    const { data } = await wkFetch<Array<Record<string, unknown>>>(cfg, '/knowledge-search', {
      method: 'POST',
      json: { query: String(query ?? ''), knowledge_base_ids: kbIds }
    })
    const hits: WeknoraHit[] = (Array.isArray(data) ? data : []).slice(0, Math.max(1, Math.min(limit, 30))).map((h) => ({
      knowledgeId: String(h.knowledge_id ?? h.id ?? ''),
      title: String(h.knowledge_title ?? ''),
      filename: String(h.knowledge_filename ?? ''),
      sourceType: String(h.knowledge_source ?? ''),
      score: Number(h.score ?? 0),
      content: String(h.content ?? '').slice(0, 800)
    }))
    return { ok: true, hits, elapsedMs: Date.now() - t0 }
  } catch (e) {
    return { ok: false, error: (e as Error).message, hits: [], elapsedMs: Date.now() - t0 }
  }
}

export async function weknoraListDocs(
  cfg: WeknoraConfig,
  kbId: string
): Promise<{ ok: boolean; error?: string; docs?: WeknoraDocSummary[] }> {
  try {
    const id = encodeURIComponent(String(kbId ?? '').trim())
    if (!id) return { ok: false, error: '未指定知识库 ID' }
    const { data } = await wkFetch<Array<Record<string, unknown>>>(cfg, `/knowledge-bases/${id}/knowledge?page=1&page_size=100`)
    const docs: WeknoraDocSummary[] = (Array.isArray(data) ? data : []).map((d) => ({
      id: String(d.id ?? ''),
      title: String(d.title ?? ''),
      fileName: String(d.file_name ?? ''),
      fileType: String(d.file_type ?? ''),
      parseStatus: String(d.parse_status ?? ''),
      createdAt: String(d.created_at ?? ''),
      channel: String(d.channel ?? '')
    }))
    return { ok: true, docs }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

const TEXTY_FILE_TYPES = new Set(['md', 'markdown', 'txt', 'json', 'yaml', 'yml', 'csv', 'log'])

export async function weknoraReadDoc(cfg: WeknoraConfig, knowledgeId: string): Promise<WeknoraReadResult> {
  const id = String(knowledgeId ?? '').trim()
  if (!id) return { ok: false, error: '未指定知识 ID' }
  try {
    const { data } = await wkFetch<Record<string, unknown>>(cfg, `/knowledge/${encodeURIComponent(id)}`)
    const title = String(data?.title ?? '')
    const fileName = String(data?.file_name ?? '')
    const fileType = String(data?.file_type ?? '').toLowerCase()
    if (fileType && !TEXTY_FILE_TYPES.has(fileType)) {
      return { ok: true, title, fileName, content: undefined }
    }
    const preview = await wkFetch<string>(cfg, `/knowledge/${encodeURIComponent(id)}/preview`, { timeoutMs: 15_000 })
    return { ok: true, title, fileName, content: typeof preview.data === 'string' ? preview.data : String(preview.data ?? '') }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export async function weknoraPushManual(
  cfg: WeknoraConfig,
  kbId: string,
  input: { title: string; content: string; knowledgeBaseId?: string }
): Promise<WeknoraPushResult> {
  try {
    const target = String(kbId ?? '').trim()
    if (!target) return { ok: false, error: '未配置归档沉淀目标库' }
    const { data } = await wkFetch<Record<string, unknown>>(cfg, `/knowledge-bases/${encodeURIComponent(target)}/knowledge/manual`, {
      method: 'POST',
      json: {
        title: input.title.slice(0, 200),
        content: input.content.slice(0, 200_000),
        status: 'published',
        channel: WEKNORA_CHANNEL
      },
      timeoutMs: PUSH_TIMEOUT_MS
    })
    return { ok: true, knowledgeId: String(data?.id ?? '') }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export async function weknoraPushFile(
  cfg: WeknoraConfig,
  kbId: string,
  absPath: string,
  relName: string
): Promise<WeknoraPushResult> {
  try {
    const target = String(kbId ?? '').trim()
    if (!target) return { ok: false, error: '未配置同步目标库' }
    if (!existsSync(absPath)) return { ok: false, error: `文件不存在：${absPath}` }
    const buf = readFileSync(absPath)
    if (buf.length > 20 * 1024 * 1024) return { ok: false, error: '文件超过 20MB，跳过同步' }
    const posixRel = relName.split(sep).join('/')
    const { body, contentType } = buildMultipart(buf, basename(absPath), {
      fileName: posixRel,
      channel: WEKNORA_CHANNEL,
      metadata: JSON.stringify({ pushed_by: WEKNORA_CHANNEL, trellis_path: posixRel })
    })
    const { status, data } = await wkFetch<Record<string, unknown>>(
      cfg,
      `/knowledge-bases/${encodeURIComponent(target)}/knowledge/file`,
      { method: 'POST', rawBody: body, contentType, timeoutMs: PUSH_TIMEOUT_MS, acceptStatus: [409] }
    )
    if (status === 409) return { ok: true, duplicate: true }
    return { ok: true, knowledgeId: String(data?.id ?? '') }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** 文件型知识没有内容更新接口——"更新" = 删除旧条目（按 fileName / metadata 匹配）后重推 */
async function upsertSpecFile(cfg: WeknoraConfig, kbId: string, absPath: string, relName: string): Promise<WeknoraPushResult> {
  const posixRel = relName.split(sep).join('/')
  const list = await weknoraListDocs(cfg, kbId)
  if (list.ok && list.docs) {
    for (const d of list.docs) {
      if (d.fileName !== posixRel) continue
      if (!d.id) continue
      try {
        await wkFetch(cfg, `/knowledge/${encodeURIComponent(d.id)}`, { method: 'DELETE' })
      } catch {
        // 单条删除失败不阻塞重推
      }
    }
  }
  return weknoraPushFile(cfg, kbId, absPath, relName)
}

/** 探测 WeKnora 内置 MCP Server 端点（Streamable HTTP）连通性：发一帧 initialize 握手 */
export async function weknoraTestMcp(url: string, token: string): Promise<{ ok: boolean; error?: string }> {
  const u = url.trim()
  if (!/^https?:\/\//i.test(u)) return { ok: false, error: '端点 URL 需以 http(s):// 开头' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await net.fetch(u, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'trellis-panel', version: '1.0.0' } }
      })
    })
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 200)
      const hint = res.status === 401 || res.status === 403 ? '（令牌无效或已过期）' : ''
      return { ok: false, error: `HTTP ${res.status}${hint} · POST ${u}${text ? ` · ${text}` : ''}`.trim() }
    }
    const body = (await res.text().catch(() => '')).slice(0, 4_000)
    if (/"serverInfo"|jsonrpc/i.test(body)) return { ok: true }
    return { ok: false, error: `端点响应不像 MCP initialize · POST ${u} · ${body.slice(0, 120) || '空响应'}` }
  } catch (e) {
    const err = e as Error
    if (err.name === 'AbortError') return { ok: false, error: `请求超时（10s）· POST ${u}` }
    return { ok: false, error: err.message }
  } finally {
    clearTimeout(timer)
  }
}

/* ---------------- 归档沉淀文档 ---------------- */

export interface ArchiveDocInput {
  projectName: string
  dirName: string
  title: string
  completedAt: string | null
  jiraKey?: string | null
  jiraUrl?: string | null
  branch?: string | null
  prUrl?: string | null
  notes?: string
  description?: string
  subtasks?: string[]
  prd?: string | null
  commits?: string[]
}

/** 把已归档任务组织成一篇可检索的公司知识（Markdown） */
export function buildArchiveDoc(input: ArchiveDocInput): { title: string; content: string } {
  const today = new Date()
  const pad = (x: number): string => String(x).padStart(2, '0')
  const doneAt = input.completedAt ?? `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`

  const head = [
    `# ${input.title}`,
    '',
    `> 项目：${input.projectName} · Trellis 任务 \`${input.dirName}\` · 完成于 ${doneAt}`
  ]
  if (input.jiraKey) head.push('', `> 关联 Jira：${input.jiraKey}${input.jiraUrl ? `（${input.jiraUrl}）` : ''}`)

  const sections: string[] = [head.join('\n')]

  const prd = (input.prd ?? '').trim()
  const desc = (input.description ?? '').trim()
  if (prd || desc) {
    sections.push(`## 需求\n\n${prd || desc}`)
  }

  const deliver: string[] = []
  if (input.branch) deliver.push(`- 分支：\`${input.branch}\``)
  if (input.prUrl) deliver.push(`- PR：${input.prUrl}`)
  if (input.subtasks?.length) {
    deliver.push('- 子任务：')
    for (const s of input.subtasks) deliver.push(`  - ${s}`)
  }
  if (input.commits?.length) {
    deliver.push('- 交付提交：')
    for (const c of input.commits.slice(0, 10)) deliver.push(`  - ${c}`)
  }
  if (deliver.length) sections.push(`## 交付信息\n\n${deliver.join('\n')}`)

  if ((input.notes ?? '').trim()) sections.push(`## 备注\n\n${input.notes!.trim()}`)

  return {
    title: `[${input.projectName}] ${input.title}`.slice(0, 200),
    content: sections.join('\n\n')
  }
}

/* ---------------- spec 目录单向同步（repo → WeKnora） ---------------- */

export interface SpecSyncReport {
  pushed: number
  duplicates: number
  failed: Array<{ file: string; error: string }>
}

/**
 * 变更静默期收集器：.trellis/spec 下文件变更先进队列，
 * 静默 quietMs 无新变更后批量推送（避免编辑过程频繁触发）。
 */
export class WeknoraSpecSyncer {
  private pending = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private cfg: WeknoraConfig | null = null
  private root: string | null = null
  private readonly quietMs: number
  private readonly onReport: ((r: SpecSyncReport) => void) | null
  private flushing = false

  constructor(opts?: { quietMs?: number; onReport?: (r: SpecSyncReport) => void }) {
    this.quietMs = opts?.quietMs ?? 10 * 60 * 1000
    this.onReport = opts?.onReport ?? null
  }

  configure(cfg: WeknoraConfig, root: string | null): void {
    this.cfg = cfg
    this.root = root
    if (!this.active) this.stop()
  }

  get active(): boolean {
    return !!(this.cfg?.enabled && this.cfg.syncSpec && this.cfg.specKbId && this.root)
  }

  enqueue(absPath: string): void {
    if (!this.active) return
    this.pending.add(absPath)
    this.schedule()
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    if (this.pending.size === 0) return
    this.timer = setTimeout(() => {
      void this.flush()
    }, this.quietMs)
  }

  async flush(): Promise<SpecSyncReport> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const report: SpecSyncReport = { pushed: 0, duplicates: 0, failed: [] }
    if (this.flushing) return report
    const cfg = this.cfg
    const root = this.root
    if (!cfg || !root || !this.active) {
      this.pending.clear()
      return report
    }
    this.flushing = true
    const batch = [...this.pending]
    this.pending.clear()
    try {
      const specRoot = join(root, '.trellis', 'spec')
      const projectName = basename(root)
      for (const file of batch) {
        const relName = `${projectName}/spec/${relative(specRoot, file).split(sep).join('/')}`
        const res = await upsertSpecFile(cfg, cfg.specKbId, file, relName)
        if (res.ok) {
          if (res.duplicate) report.duplicates += 1
          else report.pushed += 1
        } else {
          report.failed.push({ file: basename(file), error: res.error ?? '未知错误' })
        }
      }
    } finally {
      this.flushing = false
    }
    this.onReport?.(report)
    return report
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.pending.clear()
  }
}
