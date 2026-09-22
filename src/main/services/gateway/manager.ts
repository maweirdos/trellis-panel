import { getSettings } from '../store'
import { weknoraReadDoc, weknoraSearch, weknoraTest } from '../weknora'
import { kbDocById, kbSearch } from '../knowledge'
import { getSnapshot } from '../../state'
import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { errorMessage } from '../../../shared/errors'
import { accessEventLog } from '../access/event-log'
import { insideRoot } from '../fence'
import type {
  ContextHit,
  GatewayLogEntry,
  GatewaySecurityConfig,
  GatewayStatus,
  GatewayTestToolResult,
  GatewayToolDef,
  GatewayUpstream,
  McpContextProvider
} from './types'

const MAX_LOGS = 50
const DANGEROUS_SQL_REGEX = /\b(drop|delete|update|insert|alter|truncate|grant|revoke|replace|create)\b/i

class GatewayManagerClass {
  private providers = new Map<string, McpContextProvider>()
  private logs: GatewayLogEntry[] = []
  private queryCount = 0

  private security: GatewaySecurityConfig = {
    sqlReadOnly: true,
    timeoutMs: 2000,
    maxResponseChars: 12000
  }

  constructor() {
    // 初始化时可保留旧 provider 引用以防旧调用
  }

  register(provider: McpContextProvider): void {
    this.providers.set(provider.id, provider)
  }

  getProvider(id: string): McpContextProvider | undefined {
    return this.providers.get(id)
  }

  getAllProviders(): McpContextProvider[] {
    return Array.from(this.providers.values())
  }

  getLogs(): GatewayLogEntry[] {
    return [...this.logs]
  }

  updateSecurity(cfg: Partial<GatewaySecurityConfig>): void {
    this.security = { ...this.security, ...cfg }
  }

  getSecurity(): GatewaySecurityConfig {
    return { ...this.security }
  }

  private addLog(entry: GatewayLogEntry): void {
    this.logs.unshift(entry)
    if (this.logs.length > MAX_LOGS) {
      this.logs.length = MAX_LOGS
    }
    // 接入协议事件源：外部客户端凭游标感知网关调用（含 blocked 拦截）
    accessEventLog.append('gateway.tool_called', {
      toolName: entry.toolName,
      upstreamId: entry.upstreamId,
      status: entry.status,
      elapsedMs: entry.elapsedMs
    })
  }

  /**
   * ToolSearch 元工具定义（roadmap #6 / deferred 模式）：上下文经济性——
   * 客户端默认只拿 catalog + 检索工具，按名激活后再调用具体工具。
   */
  getToolSearchDef(): GatewayToolDef {
    return {
      name: 'tool_search',
      description:
        '按名称或能力关键词检索网关可用工具（如 db、sql、weknora、知识、trellis、spec）。返回匹配工具的定义；随后可直接调用对应工具名。',
      upstreamId: 'meta',
      parameters: {
        query: { type: 'string', description: '名称或能力关键词，例如 sql / 知识 / spec', required: true }
      },
      isReadOnly: true,
      securityRule: '只读检索'
    }
  }

  /** deferred 模式的上下文清单：仅元工具 */
  getDeferredCatalog(): GatewayToolDef[] {
    return [this.getToolSearchDef()]
  }

/** GatewayToolDef -> OpenAI function schema（agent 循环用，TPD-020） */
  toOpenAiTools(): Array<Record<string, unknown>> {
    return this.getStandardTools().map((t) => {
      const properties: Record<string, unknown> = {}
      const required: string[] = []
      for (const [name, def] of Object.entries(t.parameters ?? {})) {
        properties[name] = { type: def.type ?? 'string', description: def.description ?? '' }
        if (def.required) required.push(name)
      }
      return {
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: { type: 'object', properties, ...(required.length ? { required } : {}) }
        }
      }
    })
  }

  /** 按关键词检索工具（名称/描述/upstreamId），供 tool_search 执行 */
  searchTools(query: string): GatewayToolDef[] {
    const q = String(query ?? '').trim().toLowerCase()
    const all = this.getStandardTools()
    if (!q) return all
    return all.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.upstreamId.toLowerCase().includes(q) ||
        (t.securityRule ?? '').toLowerCase().includes(q)
    )
  }

  /**
   * 网关向 AI 编辑器暴露的标准工具集合
   */
  getStandardTools(): GatewayToolDef[] {
    return [
      // --- Local Knowledge Base Tools（本地四库：需求/规范/Wiki/归档） ---
      {
        name: 'kb_search',
        description: '检索当前项目的本地知识库（需求库、规范库、Wiki 文档库、归档库），返回命中片段与来源。回答项目相关问题前先用它查证。',
        upstreamId: 'local-kb',
        parameters: {
          query: { type: 'string', description: '检索关键词或问题', required: true },
          library: { type: 'string', description: '限定库：requirements（需求）/ spec（规范）/ wiki（项目文档）/ archive（归档）；不传则全库检索', required: false }
        },
        isReadOnly: true,
        securityRule: '只读检索'
      },
      {
        name: 'kb_read_doc',
        description: '读取知识库文档的完整正文（先用 kb_search 拿到 docId，再读全文）。',
        upstreamId: 'local-kb',
        parameters: {
          docId: { type: 'string', description: 'kb_search 返回的 docId（形如 "spec:D:\\...\\api.md"）', required: true }
        },
        isReadOnly: true,
        securityRule: '只读'
      },

      // --- WeKnora Enterprise Knowledge Tools ---
      {
        name: 'weknora_search',
        description: '企业知识库向量与语义混合检索。获取企业内部标准、业务规则文档及跨系统架构设计。',
        upstreamId: 'weknora',
        parameters: {
          query: { type: 'string', description: '搜索关键词或语义查询语句', required: true },
          limit: { type: 'number', description: '返回条数上限 (默认 10)', required: false, default: 10 }
        },
        isReadOnly: true,
        securityRule: '2.0s 熔断保护'
      },
      {
        name: 'weknora_read_doc',
        description: '按文档 ID 获取 WeKnora 远端企业知识文档的完整正文内容。',
        upstreamId: 'weknora',
        parameters: {
          knowledgeId: { type: 'string', description: 'WeKnora 知识文档 ID', required: true }
        },
        isReadOnly: true,
        securityRule: '2.0s 熔断保护'
      },

      // --- Trellis Project Context Tools ---
      {
        name: 'trellis_get_spec',
        description: '获取项目本地 .trellis/spec/ 下的架构或业务规范文档。保证代码实现符合既有规范。',
        upstreamId: 'trellis',
        parameters: {
          name: { type: 'string', description: '规范文档相对路径或名称，例如 workflow.md 或 conventions/api.md', required: true }
        },
        isReadOnly: true
      },
      {
        name: 'trellis_get_task',
        description: '获取指定任务目录的 PRD、设计文档与任务状态上下文。',
        upstreamId: 'trellis',
        parameters: {
          taskDir: { type: 'string', description: '任务目录名称，例如 001-init', required: true }
        },
        isReadOnly: true
      },
      {
        name: 'trellis_list_specs',
        description: '列出当前仓库所有生效的架构规范、设计准则与开发约定清单。',
        upstreamId: 'trellis',
        parameters: {},
        isReadOnly: true
      },
      {
        name: 'trellis_list_tasks',
        description: '列出当前项目的全部任务（标题、状态、负责人、更新时间），了解项目进展时使用。',
        upstreamId: 'trellis',
        parameters: {},
        isReadOnly: true
      }
    ]
  }

  /**
   * 执行工具调用（可供在线调试器直接调用，也是 stdio/SSE 调用的核心逻辑）
   */
  async executeTool(
    toolName: string,
    args: Record<string, unknown>,
    root: string
  ): Promise<GatewayTestToolResult> {
    const start = Date.now()
    this.queryCount += 1
    const tools = this.getStandardTools()
    const toolDef = tools.find((t) => t.name === toolName)

    if (!toolDef) {
      const err = `未找到工具: ${toolName}`
      this.addLog({
        id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp: Date.now(),
        toolName,
        upstreamId: 'unknown',
        input: args,
        status: 'error',
        elapsedMs: Date.now() - start,
        error: err
      })
      return { ok: false, elapsedMs: Date.now() - start, error: err }
    }

    // 1. 安全防护检查：SQL 只读拦截（防御未来接入的 sql 参数型工具）
    if (this.security.sqlReadOnly && args.sql) {
      const sql = String(args.sql || '').trim()
      if (DANGEROUS_SQL_REGEX.test(sql)) {
        const blockMsg = `操作被网关安全防护拦截：检测到修改或破坏性 DDL/DML 语句，只读模式下仅允许执行 SELECT 查询。拦截词: ${sql.match(DANGEROUS_SQL_REGEX)?.[0]}`
        const elapsedMs = Date.now() - start
        this.addLog({
          id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          timestamp: Date.now(),
          toolName,
          upstreamId: toolDef.upstreamId,
          input: args,
          status: 'blocked',
          elapsedMs,
          error: blockMsg
        })
        return {
          ok: false,
          elapsedMs,
          blockedBySecurity: true,
          error: blockMsg
        }
      }
    }

    // 2. 执行具体工具逻辑（包装超时熔断）
    try {
      const execPromise = this.dispatchTool(toolName, args, root)
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`上游调用超时 (触发网关 ${this.security.timeoutMs}ms 熔断保护)`)), this.security.timeoutMs)
      )

      const result = await Promise.race([execPromise, timeoutPromise])
      const elapsedMs = Date.now() - start

      // 截断保护（TPD-011）：截断必须在响应里显式置位并保留原始长度
      let preview = typeof result === 'string' ? result : JSON.stringify(result)
      const totalChars = preview.length
      let truncated = false
      if (preview.length > this.security.maxResponseChars) {
        preview = preview.slice(0, this.security.maxResponseChars) + `... [已触发网关截断，超过 ${this.security.maxResponseChars} 字符]`
        truncated = true
      }

      this.addLog({
        id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp: Date.now(),
        toolName,
        upstreamId: toolDef.upstreamId,
        input: args,
        status: 'success',
        elapsedMs,
        responsePreview: preview.slice(0, 300)
      })

      return {
        ok: true,
        elapsedMs,
        result,
        preview,
        ...(truncated ? { truncated: true, totalChars } : {})
      }
    } catch (e) {
      const elapsedMs = Date.now() - start
      const error = errorMessage(e) || String(e)
      this.addLog({
        id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp: Date.now(),
        toolName,
        upstreamId: toolDef.upstreamId,
        input: args,
        status: 'error',
        elapsedMs,
        error
      })
      return {
        ok: false,
        elapsedMs,
        error
      }
    }
  }

  private async dispatchTool(toolName: string, args: Record<string, unknown>, root: string): Promise<unknown> {
    const s = getSettings()

    switch (toolName) {
      // --- Local Knowledge Base Tools ---
      case 'kb_search': {
        const query = String(args.query || '').trim()
        if (!query) throw new Error('缺少参数: query')
        const libRaw = String(args.library || 'all').trim()
        const library = ['requirements', 'spec', 'wiki', 'archive'].includes(libRaw) ? libRaw : 'all'
        if (!root) return { ok: false, error: '未打开项目', hits: [] }
        const res = kbSearch(root, library as 'all', query)
        const hits = res.hits.slice(0, 8).map((h) => ({
          docId: h.doc.id,
          title: h.doc.title,
          library: h.doc.library,
          path: h.doc.path,
          snippet: h.snippet.replace(/\u0000/g, '**').replace(/\u0001/g, '**'),
          score: Math.round(h.score)
        }))
        return {
          ok: true,
          query,
          library,
          totalDocs: res.totalDocs,
          elapsedMs: res.elapsedMs,
          hits,
          hint: hits.length > 0 ? '用 kb_read_doc(docId) 可读全文' : '未命中，建议换关键词或减少限定库'
        }
      }

      case 'kb_read_doc': {
        const docId = String(args.docId || '').trim()
        if (!docId) throw new Error('缺少参数: docId')
        if (!root) throw new Error('未打开项目')
        const doc = kbDocById(root, docId)
        if (!doc) return { ok: false, error: `文档不存在或不在库内: ${docId.slice(0, 120)}` }
        const content = readFileSync(doc.path, 'utf-8').slice(0, this.security.maxResponseChars)
        return { ok: true, title: doc.title, library: doc.library, path: doc.path, content }
      }

      // --- WeKnora Tools ---
      case 'weknora_search': {
        const query = String(args.query || '').trim()
        const limit = typeof args.limit === 'number' ? args.limit : 10
        if (!s?.weknora?.enabled) {
          return { ok: false, error: 'WeKnora 企业知识库插件未启用（可在系统设置中开启）', hits: [] }
        }
        return await weknoraSearch(s.weknora, query, limit)
      }

      case 'weknora_read_doc': {
        const knowledgeId = String(args.knowledgeId || '').trim()
        if (!s?.weknora?.enabled) {
          return { ok: false, error: 'WeKnora 企业知识库插件未启用' }
        }
        return await weknoraReadDoc(s.weknora, knowledgeId)
      }

      // --- Trellis Tools ---
      case 'trellis_get_spec': {
        if (!root) throw new Error('未打开项目')
        const name = String(args.name || '').trim()
        // 路径围栏（TPD-010）：name 可能携带 ../ 穿越项目根
        const specRel = name.endsWith('.md') || name.endsWith('.txt') ? name : `${name}.md`
        const specPath = insideRoot(root, join('.trellis', 'spec', specRel))
        if (!specPath) {
          throw new Error(`规范路径越界: .trellis/spec/${name}`)
        }
        if (!existsSync(specPath)) {
          return { ok: false, error: `规范文件不存在: .trellis/spec/${name}` }
        }
        const content = readFileSync(specPath, 'utf-8')
        return { path: specPath, content }
      }

      case 'trellis_get_task': {
        if (!root) throw new Error('未打开项目')
        const taskDir = String(args.taskDir || '').trim()
        const taskBase = insideRoot(root, join('.trellis', 'tasks', taskDir))
        if (!taskBase) {
          throw new Error(`任务路径越界: ${taskDir}`)
        }
        const prdPath = join(taskBase, 'prd.md')
        const taskJsonPath = join(taskBase, 'task.json')
        const result: Record<string, unknown> = { taskDir }
        if (existsSync(taskJsonPath)) {
          try {
            result.taskRecord = JSON.parse(readFileSync(taskJsonPath, 'utf-8'))
          } catch {}
        }
        if (existsSync(prdPath)) {
          result.prdContent = readFileSync(prdPath, 'utf-8')
        }
        return result
      }

      case 'trellis_list_specs': {
        if (!root) return { specs: [] }
        const specDir = join(root, '.trellis', 'spec')
        if (!existsSync(specDir)) return { specs: [] }
        try {
          const files = readdirSync(specDir, { recursive: true }) as string[]
          return {
            specs: files
              .filter((f) => typeof f === 'string' && (f.endsWith('.md') || f.endsWith('.txt')))
              .map((f) => ({ path: f.replace(/\\/g, '/') }))
          }
        } catch {
          return { specs: [] }
        }
      }

      case 'trellis_list_tasks': {
        const snap = getSnapshot()
        if (!snap) return { ok: false, error: '未打开项目', tasks: [] }
        return {
          ok: true,
          total: snap.tasks.length,
          archived: snap.archived.length,
          tasks: snap.tasks.map((t) => ({
            dirName: t.dirName,
            title: String(t.record?.title ?? t.dirName),
            status: String(t.record?.status ?? ''),
            priority: t.record?.priority ?? null,
            assignee: t.record?.assignee ?? null,
            jiraKey: t.record?.meta?.jiraKey ?? null
          }))
        }
      }

      default:
        throw new Error(`未实现的工具处理器: ${toolName}`)
    }
  }

  async getStatus(root: string): Promise<GatewayStatus> {
    const s = getSettings()
    const tools = this.getStandardTools()

    const upstreams: GatewayUpstream[] = [
      // 1. 本地知识库（四库）
      {
        id: 'local-kb',
        name: '本地知识库（四库）',
        category: 'knowledge',
        description: '项目内需求库 / 规范库 / Wiki 库 / 归档库的毫秒级全文检索，供对话与 AI 规划查证项目事实',
        status: root ? 'connected' : 'disabled',
        endpoint: root ? `${root}/.trellis` : '未打开项目',
        isRemote: false,
        enabled: !!root,
        lastChecked: Date.now(),
        tools: tools.filter((t) => t.upstreamId === 'local-kb')
      },

      // 2. WeKnora 企业知识库
      {
        id: 'weknora',
        name: 'WeKnora 企业知识库',
        category: 'knowledge',
        description: '企业级 RAG 知识平台，提供业务规则文档、技术架构标准与跨团队规范向量检索',
        status: s?.weknora?.enabled ? 'connected' : 'disabled',
        endpoint: s?.weknora?.baseUrl || '未配置',
        isRemote: true,
        enabled: !!s?.weknora?.enabled,
        lastChecked: Date.now(),
        tools: tools.filter((t) => t.upstreamId === 'weknora'),
        config: {
          kbIds: s?.weknora?.searchKbIds || []
        }
      },

      // 3. Trellis 项目内核
      {
        id: 'trellis',
        name: 'Trellis 项目内核',
        category: 'project',
        description: '注入本地工程规范文档与开发任务上下文，确保 AI 遵循项目架构红线',
        status: root && existsSync(join(root, '.trellis')) ? 'connected' : 'disabled',
        endpoint: root ? `${root}/.trellis` : '未打开项目',
        isRemote: false,
        enabled: !!root,
        lastChecked: Date.now(),
        tools: tools.filter((t) => t.upstreamId === 'trellis')
      },

      // 4. 自定义扩展槽位
      {
        id: 'custom',
        name: '自定义 MCP 扩展',
        category: 'custom',
        description: '支持通过 stdio / SSE 挂载第三方 MCP 命令行服务（如 git-mcp, jira-mcp）',
        status: 'disconnected',
        endpoint: 'stdio / sse (待配置)',
        isRemote: true,
        enabled: false,
        tools: []
      }
    ]

    return {
      ok: true,
      running: true,
      transport: 'stdio',
      upstreams,
      tools,
      security: this.security,
      totalQueries: this.queryCount,
      recentLogs: this.getLogs()
    }
  }

  // 兼容旧接口
  async search(
    query: string,
    options: { limit?: number; root: string }
  ): Promise<{ hits: ContextHit[]; elapsedMs: number; sources: Array<{ source: string; label: string; count: number }> }> {
    const s = getSettings()
    const start = Date.now()
    if (s?.weknora?.enabled) {
      const res = await weknoraSearch(s.weknora, query, options.limit || 10)
      const hits = (res.hits || []).map((h, i) => ({
        id: `weknora:${h.knowledgeId || i}`,
        title: h.title || h.filename || '企业知识文档',
        source: 'weknora',
        sourceLabel: 'WeKnora 公司库',
        path: h.filename,
        snippet: h.content,
        score: h.score
      }))
      return {
        hits,
        elapsedMs: Date.now() - start,
        sources: [{ source: 'weknora', label: 'WeKnora 公司库', count: hits.length }]
      }
    }
    return { hits: [], elapsedMs: Date.now() - start, sources: [] }
  }

  async syncSpecFromRemote(root: string, remoteDocId: string, targetFileName: string): Promise<{ ok: boolean; error?: string; path?: string }> {
    if (!root) return { ok: false, error: '未打开项目' }
    const s = getSettings()
    if (!s?.weknora?.enabled) return { ok: false, error: 'WeKnora 插件未启用' }

    try {
      const res = await weknoraReadDoc(s.weknora, remoteDocId)
      if (!res.ok || !res.content) {
        return { ok: false, error: res.error || '无法读取远端文档内容' }
      }

      const specDir = join(root, '.trellis', 'spec')
      if (!existsSync(specDir)) {
        mkdirSync(specDir, { recursive: true })
      }

      const fileName = targetFileName.endsWith('.md') ? targetFileName : `${targetFileName}.md`
      // 路径围栏（TPD-010）：目标文件名不得越出 spec 根
      const filePath = insideRoot(root, join('.trellis', 'spec', fileName))
      if (!filePath) {
        return { ok: false, error: `目标文件名越界: ${targetFileName}` }
      }
      writeFileSync(filePath, res.content, 'utf-8')

      return { ok: true, path: filePath }
    } catch (e) {
      return { ok: false, error: errorMessage(e) || String(e) }
    }
  }

  async testProvider(providerId: string, root?: string): Promise<{ ok: boolean; error?: string }> {
    if (providerId === 'local-kb') {
      if (!root) return { ok: false, error: '未打开项目' }
      const res = kbSearch(root, 'all', '')
      return { ok: res.ok }
    }
    if (providerId === 'weknora') {
      const s = getSettings()
      if (!s?.weknora?.enabled) return { ok: false, error: 'WeKnora 未启用' }
      const res = await weknoraTest(s.weknora)
      return { ok: res.ok, error: res.error }
    }
    if (providerId === 'trellis') {
      if (!root || !existsSync(join(root, '.trellis'))) {
        return { ok: false, error: '未找到有效 .trellis 目录' }
      }
      return { ok: true }
    }
    return { ok: false, error: '未知 Provider' }
  }
}

export const GatewayManager = new GatewayManagerClass()
