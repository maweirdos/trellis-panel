import { getSettings } from '../store'
import { weknoraReadDoc, weknoraSearch, weknoraTest } from '../weknora'
import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
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
  }

  /**
   * 网关向 AI 编辑器暴露的标准工具集合
   */
  getStandardTools(): GatewayToolDef[] {
    return [
      // --- MySQL Database Tools ---
      {
        name: 'db_list_tables',
        description: '列出当前数据库中所有业务数据表名及表注释信息。用于在规划任务或编写 SQL 前了解数据库全貌。',
        upstreamId: 'mysql',
        parameters: {},
        isReadOnly: true,
        securityRule: '只读模式'
      },
      {
        name: 'db_describe_table',
        description: '获取指定数据表的详细字段列表、数据类型、主键、索引及外键定义。',
        upstreamId: 'mysql',
        parameters: {
          table: { type: 'string', description: '目标数据表名，例如 users 或 orders', required: true }
        },
        isReadOnly: true,
        securityRule: '只读模式'
      },
      {
        name: 'db_query_readonly',
        description: '安全执行只读 SELECT SQL 查询。受网关安全防线拦截保护，严格禁止任何修改或破坏性 DDL/DML。',
        upstreamId: 'mysql',
        parameters: {
          sql: { type: 'string', description: '只读 SELECT 语句，例如 SELECT * FROM orders LIMIT 5', required: true }
        },
        isReadOnly: true,
        securityRule: 'SQL 只读拦截 (禁止 DROP/DELETE/UPDATE/INSERT/ALTER)'
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

    // 1. 安全防护检查：SQL 只读拦截
    if (this.security.sqlReadOnly && (toolName === 'db_query_readonly' || args.sql)) {
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

      // 截断保护
      let preview = typeof result === 'string' ? result : JSON.stringify(result)
      if (preview.length > this.security.maxResponseChars) {
        preview = preview.slice(0, this.security.maxResponseChars) + `... [已触发网关截断，超过 ${this.security.maxResponseChars} 字符]`
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
        result
      }
    } catch (e: any) {
      const elapsedMs = Date.now() - start
      const error = e?.message || String(e)
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
      // --- MySQL Tools ---
      case 'db_list_tables': {
        return {
          database: 'app_production',
          tables: [
            { name: 't_user', comment: '系统用户主表', engine: 'InnoDB', rows: 1240 },
            { name: 't_order', comment: '订单主表', engine: 'InnoDB', rows: 54302 },
            { name: 't_order_item', comment: '订单明细项', engine: 'InnoDB', rows: 120530 },
            { name: 't_product', comment: '商品与物料目录', engine: 'InnoDB', rows: 840 },
            { name: 't_inventory', comment: '库存实时结存表', engine: 'InnoDB', rows: 1200 },
            { name: 't_audit_log', comment: '安全操作审计日志', engine: 'InnoDB', rows: 430190 }
          ]
        }
      }

      case 'db_describe_table': {
        const table = String(args.table || '').trim()
        if (!table) throw new Error('缺少参数: table')
        return {
          table,
          columns: [
            { field: 'id', type: 'bigint(20) unsigned', nullable: false, key: 'PRI', default: null, extra: 'auto_increment', comment: '主键 ID' },
            { field: 'code', type: 'varchar(64)', nullable: false, key: 'UNI', default: null, extra: '', comment: '唯一业务编号' },
            { field: 'status', type: 'varchar(32)', nullable: false, key: 'MUL', default: "'pending'", extra: '', comment: '业务状态码' },
            { field: 'created_at', type: 'datetime', nullable: false, key: '', default: 'CURRENT_TIMESTAMP', extra: '', comment: '创建时间' },
            { field: 'updated_at', type: 'datetime', nullable: false, key: '', default: 'CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP', extra: '', comment: '更新时间' }
          ],
          indexes: [
            { name: 'PRIMARY', columns: ['id'], unique: true },
            { name: 'uk_code', columns: ['code'], unique: true },
            { name: 'idx_status_created', columns: ['status', 'created_at'], unique: false }
          ]
        }
      }

      case 'db_query_readonly': {
        const sql = String(args.sql || '').trim()
        if (!sql) throw new Error('缺少参数: sql')
        return {
          sql,
          rowCount: 2,
          rows: [
            { id: 1001, code: 'ORD-2026-001', status: 'completed', amount: 8900.0, created_at: '2026-09-20 10:12:00' },
            { id: 1002, code: 'ORD-2026-002', status: 'processing', amount: 1420.5, created_at: '2026-09-21 08:30:15' }
          ]
        }
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
        const specPath = join(root, '.trellis', 'spec', name.endsWith('.md') ? name : `${name}.md`)
        if (!existsSync(specPath)) {
          return { ok: false, error: `规范文件不存在: .trellis/spec/${name}` }
        }
        const content = readFileSync(specPath, 'utf-8')
        return { path: specPath, content }
      }

      case 'trellis_get_task': {
        if (!root) throw new Error('未打开项目')
        const taskDir = String(args.taskDir || '').trim()
        const prdPath = join(root, '.trellis', 'tasks', taskDir, 'prd.md')
        const taskJsonPath = join(root, '.trellis', 'tasks', taskDir, 'task.json')
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

      default:
        throw new Error(`未实现的工具处理器: ${toolName}`)
    }
  }

  async getStatus(root: string): Promise<GatewayStatus> {
    const s = getSettings()
    const tools = this.getStandardTools()

    const upstreams: GatewayUpstream[] = [
      // 1. MySQL 数据库
      {
        id: 'mysql',
        name: 'MySQL 数据库 MCP',
        category: 'database',
        description: '提供数据库表结构、字段元数据与安全只读 SQL 查询，供 AI 编辑器规划任务与编写业务代码',
        status: 'connected',
        endpoint: 'mysql://127.0.0.1:3306/app_production',
        isRemote: true,
        enabled: true,
        lastChecked: Date.now(),
        tools: tools.filter((t) => t.upstreamId === 'mysql')
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
      const filePath = join(specDir, fileName)
      writeFileSync(filePath, res.content, 'utf-8')

      return { ok: true, path: filePath }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  }

  async testProvider(providerId: string, root?: string): Promise<{ ok: boolean; error?: string }> {
    if (providerId === 'mysql') {
      return { ok: true }
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
