import { createServer, type Server, type IncomingMessage } from 'http'
import { join } from 'path'
import type { ProjectSnapshot, JiraConfig } from '../../shared/types'
import { statusLabelShared as statusLabel } from '../../shared/labels-shared'
import { getSettings } from './store'

/**
 * Local HTTP surface for the panel:
 *   GET  /            read-only web board (auto-refresh, shareable on LAN)
 *   POST /mcp         Model Context Protocol (streamable HTTP, JSON-RPC)
 * All API-ish routes require the bridge token (Bearer); the web board is
 * token-free read-only by design.
 */

let server: Server | null = null
let actualPort: number | null = null

type SnapshotGetter = () => ProjectSnapshot | null
let getSnap: SnapshotGetter = () => null

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/* ---------------- MCP ---------------- */

interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  run: (args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }>
}

function jsonText(data: unknown): { text: string; isError?: boolean } {
  return { text: JSON.stringify(data, null, 2) }
}

/** Tool implementations injected by the main process (avoids circular imports). */
export interface McpDeps {
  updateTaskStatus: (dir: string, status: string) => Promise<{ text: string; isError?: boolean }>
  searchSpec: (query: string) => Promise<{ text: string; isError?: boolean }>
  readSpec: (relPath: string) => Promise<{ text: string; isError?: boolean }>
}

let mcpDeps: McpDeps = {
  updateTaskStatus: async () => ({ text: '服务初始化中', isError: true }),
  searchSpec: async () => ({ text: '服务初始化中', isError: true }),
  readSpec: async () => ({ text: '服务初始化中', isError: true })
}

export function setMcpDeps(deps: McpDeps): void {
  mcpDeps = deps
}

function taskBrief(t: ProjectSnapshot['tasks'][number]): Record<string, unknown> {
  return {
    dir: t.dirName,
    title: t.record?.title,
    status: t.record?.status,
    statusLabel: statusLabel(t.record?.status),
    priority: t.record?.priority,
    assignee: t.record?.assignee,
    branch: t.record?.branch,
    createdAt: t.record?.createdAt,
    completedAt: t.record?.completedAt,
    jiraKey: t.jiraKey,
    subtasks: t.record?.subtasks?.length ?? 0,
    artifacts: t.artifacts.map((a) => a.name)
  }
}

function buildTools(): McpTool[] {
  return [
    {
      name: 'get_tasks',
      description: '获取当前 Trellis 项目的任务列表（可按状态/负责人/关键词过滤）',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['planning', 'in_progress', 'review', 'completed'] },
          assignee: { type: 'string' },
          query: { type: 'string' }
        }
      },
      run: async (args) => {
        const snap = getSnap()
        if (!snap) return { text: '未打开项目', isError: true }
        let list = snap.tasks
        if (args.status) list = list.filter((t) => t.record?.status === args.status)
        if (args.assignee) list = list.filter((t) => t.record?.assignee === args.assignee)
        if (args.query) {
          const q = String(args.query).toLowerCase()
          list = list.filter((t) => `${t.dirName} ${t.record?.title ?? ''}`.toLowerCase().includes(q))
        }
        return jsonText({ total: list.length, tasks: list.map(taskBrief) })
      }
    },
    {
      name: 'get_task',
      description: '获取单个任务的完整信息（24 字段 + 产物列表）',
      inputSchema: { type: 'object', properties: { dir: { type: 'string' } }, required: ['dir'] },
      run: async (args) => {
        const snap = getSnap()
        const dir = String(args.dir ?? '')
        const t = snap?.tasks.find((x) => x.dirName === dir || x.path.endsWith(dir))
        if (!t) return { text: `任务不存在: ${dir}`, isError: true }
        return jsonText({ ...taskBrief(t), description: t.record?.description, notes: t.record?.notes, subtasks: t.record?.subtasks, meta: t.record?.meta })
      }
    },
    {
      name: 'update_task_status',
      description: '更新任务状态（planning/in_progress/review/completed）',
      inputSchema: {
        type: 'object',
        properties: { dir: { type: 'string' }, status: { type: 'string', enum: ['planning', 'in_progress', 'review', 'completed'] } },
        required: ['dir', 'status']
      },
      run: async (args) => mcpDeps.updateTaskStatus(String(args.dir), String(args.status))
    },
    {
      name: 'search_spec',
      description: '在 .trellis/spec 规范文档中全文搜索',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      run: async (args) => mcpDeps.searchSpec(String(args.query ?? ''))
    },
    {
      name: 'read_spec',
      description: '读取一个规范文档的内容（相对 .trellis/spec 的路径）',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      run: async (args) => mcpDeps.readSpec(String(args.path ?? ''))
    },
    {
      name: 'get_overview',
      description: '项目概览：版本/开发者/平台/任务统计/活跃会话',
      inputSchema: { type: 'object', properties: {} },
      run: async () => {
        const snap = getSnap()
        if (!snap) return { text: '未打开项目', isError: true }
        const by = (s: string): number => snap.tasks.filter((t) => t.record?.status === s).length
        return jsonText({
          project: snap.meta.name,
          trellisVersion: snap.meta.version,
          developer: snap.meta.developer,
          currentTask: snap.meta.currentTask,
          platforms: snap.meta.platforms.filter((p) => p.detected).map((p) => p.name),
          tasks: {
            total: snap.tasks.length,
            planning: by('planning'),
            in_progress: by('in_progress'),
            review: by('review'),
            completed: snap.tasks.filter((t) => ['completed', 'done'].includes(t.record?.status ?? '')).length
          },
          sessions: snap.sessions.length,
          developers: snap.developers.map((d) => d.name)
        })
      }
    }
  ]
}

async function handleMcp(body: unknown): Promise<unknown> {
  const req = body as { id?: unknown; method?: string; params?: Record<string, unknown> }
  const id = req.id ?? null
  const method = req.method ?? ''
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'trellis-panel', version: '0.3.0' }
      }
    }
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return undefined // notification — no response body
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: buildTools().map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) } }
  }
  if (method === 'tools/call') {
    const name = String(req.params?.name ?? '')
    const tool = buildTools().find((t) => t.name === name)
    if (!tool) return { jsonrpc: '2.0', id, error: { code: -32602, message: `未知工具: ${name}` } }
    try {
      const result = await tool.run((req.params?.arguments ?? {}) as Record<string, unknown>)
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: result.text }], isError: result.isError ?? false } }
    } catch (e: any) {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(e?.message ?? e) }], isError: true } }
    }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `未知方法: ${method}` } }
}

/* ---------------- Web board ---------------- */

function renderBoard(snap: ProjectSnapshot): string {
  const cols: Array<{ key: string; label: string; color: string }> = [
    { key: 'planning', label: '规划中', color: '#38bdf8' },
    { key: 'in_progress', label: '进行中', color: '#fbbf24' },
    { key: 'review', label: '评审中', color: '#a78bfa' },
    { key: 'completed', label: '已完成', color: '#34d399' }
  ]
  const match = (t: ProjectSnapshot['tasks'][number], key: string): boolean =>
    t.record?.status === key || (key === 'completed' && t.record?.status === 'done')

  const colsHtml = cols
    .map((c) => {
      const items = snap.tasks.filter((t) => match(t, c.key))
      const cards = items
        .map(
          (t) => `<div class="card">
            <div class="row"><span class="pri">${esc(t.record?.priority ?? '')}</span><span class="date">${esc(t.dirName.slice(0, 5))}</span>${t.jiraKey ? `<span class="jira">${esc(t.jiraKey)}</span>` : ''}</div>
            <div class="title">${esc(t.record?.title ?? t.dirName)}</div>
            <div class="row"><span class="assignee">${esc(t.record?.assignee || '未分配')}</span><span class="branch">${esc(t.record?.branch ?? '')}</span></div>
          </div>`
        )
        .join('')
      return `<div class="col"><div class="col-head"><span class="dot" style="background:${c.color}"></span>${c.label}<span class="count">${items.length}</span></div>${cards || '<div class="empty">—</div>'}</div>`
    })
    .join('')

  const platforms = snap.meta.platforms.filter((p) => p.detected).map((p) => p.name).join(' · ')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="refresh" content="30">
<title>Trellis Panel — ${esc(snap.meta.name)}（只读看板）</title>
<style>
  body{margin:0;background:#0f1115;color:#e6eaf2;font-family:"Segoe UI","Microsoft YaHei UI",sans-serif;font-size:13px}
  header{display:flex;align-items:center;gap:10px;padding:12px 20px;border-bottom:1px solid #202633;background:#12151c}
  h1{font-size:15px;margin:0} .meta{color:#6b7691;font-size:11px}
  .board{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;padding:16px 20px}
  .col{background:#12151c;border:1px solid #202633;border-radius:12px;min-height:60vh}
  .col-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #202633;font-weight:600}
  .dot{width:8px;height:8px;border-radius:50%}
  .count{margin-left:auto;background:#1a1f2a;border-radius:6px;padding:0 7px;font-family:Consolas,monospace;font-size:11px;color:#9aa5bd}
  .card{margin:8px;padding:10px;border:1px solid #202633;border-radius:8px;background:#161a22}
  .title{margin:6px 0;line-height:1.5}
  .row{display:flex;gap:8px;align-items:center;color:#6b7691;font-size:11px}
  .pri{border:1px solid #2a3242;border-radius:5px;padding:0 5px;font-family:Consolas,monospace;color:#c9d1e0}
  .jira{border:1px solid #3b82f655;background:#3b82f622;color:#93c5fd;border-radius:5px;padding:0 5px;font-family:Consolas,monospace}
  .empty{text-align:center;color:#3a4356;padding:30px 0}
  .assignee{margin-right:auto}
  .branch{font-family:Consolas,monospace}
</style></head><body>
<header><h1>🍃 Trellis Panel — ${esc(snap.meta.name)} <span class="meta">只读看板 · 每 30 秒刷新</span></h1>
<span class="meta">Trellis ${esc(snap.meta.version ?? '')} · 开发者 ${esc(snap.meta.developer ?? '—')}${platforms ? ` · ${esc(platforms)}` : ''}</span></header>
<div class="board">${colsHtml}</div></body></html>`
}

/* ---------------- server lifecycle ---------------- */

function readBody(req: IncomingMessage, limit = 2_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (d) => {
      size += d.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(d)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

export function startHttpApi(
  port: number,
  token: string,
  lanAccess: boolean,
  snapshotGetter: SnapshotGetter
): Promise<{ ok: boolean; error?: string; port?: number }> {
  return new Promise((resolve) => {
    stopHttpApi()
    getSnap = snapshotGetter
    server = createServer(async (req, res) => {
      const url = (req.url ?? '/').split('?')[0]
      try {
        if (req.method === 'GET' && (url === '/' || url === '/board')) {
          const snap = getSnap()
          if (!snap) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end('<html><body style="background:#0f1115;color:#6b7691;font-family:sans-serif"><p>面板未打开项目。</p></body></html>')
            return
          }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(renderBoard(snap))
          return
        }

        // everything else requires the bridge token
        const auth = req.headers.authorization ?? ''
        if (auth !== `Bearer ${token}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'unauthorized' }))
          return
        }

        if (req.method === 'POST' && url === '/mcp') {
          const raw = await readBody(req)
          const body = raw ? JSON.parse(raw) : null
          const result = await handleMcp(body)
          if (result === undefined) {
            res.writeHead(202)
            res.end()
            return
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
          return
        }

        if (req.method === 'GET' && url === '/api/snapshot') {
          const snap = getSnap()
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(snap))
          return
        }

        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'not found' }))
      } catch (e: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: String(e?.message ?? e) }))
      }
    })
    server.once('error', (e: NodeJS.ErrnoException) => {
      server = null
      actualPort = null
      resolve({ ok: false, error: e.code === 'EADDRINUSE' ? `端口 ${port} 被占用` : e.message })
    })
    server.listen(port, lanAccess ? undefined : '127.0.0.1', () => {
      actualPort = port
      resolve({ ok: true, port })
    })
  })
}

export function stopHttpApi(): void {
  if (server) {
    server.close()
    server = null
    actualPort = null
  }
}

export function httpApiStatus(): { running: boolean; port: number | null } {
  return { running: server !== null, port: actualPort }
}

export function mcpClientConfigSnippet(port: number, token: string): { codex: string; claude: string } {
  const url = `http://127.0.0.1:${port}/mcp`
  return {
    codex: JSON.stringify(
      { mcpServers: { 'trellis-panel': { url, headers: { Authorization: `Bearer ${token}` } } } },
      null,
      2
    ),
    claude: JSON.stringify(
      { mcpServers: { 'trellis-panel': { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } },
      null,
      2
    )
  }
}
