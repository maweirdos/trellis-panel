/**
 * Trellis Panel Access Protocol (TPAP) v1 —— 本地控制面。
 *
 * 设计要点（详见 docs/access-protocol.md）：
 * 1. 仅环回：listen('127.0.0.1') 硬编码，不提供任何局域网开关。
 * 2. Bearer token：全部路由先过鉴权，失败 401。
 * 3. confirm 门槛：变更类操作（mutating）请求体必须 confirm:true，否则 422。
 * 4. 幂等：变更操作支持 requestId，重复请求返回首次结果，不产生二次变更。
 * 5. 游标事件：events 路由凭 {epoch,seq} 游标增量拉取，跨重启/丢区间返回 reset。
 * 6. 复用同一实现：工具调用与面板内 gateway:testTool 走同一 GatewayManager.executeTool，
 *    不另建第二套权限/持久化逻辑。
 *
 * Clean-room 声明：本协议为独立设计，未复制任何第三方代码或文档原文。
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http'
import { app } from 'electron'
import { getSettings } from '../store'
import { listSessions, openSession } from '../chat-store'
import { getSnapshot } from '../../state'
import { GatewayManager } from '../gateway/manager'
import { accessEventLog, type Cursor } from './event-log'
import { IdempotencyCache } from './idempotency'
import { rotateAccessToken, verifyToken } from './token'

const PROTOCOL_VERSION = 'tpap/1'
const MAX_BODY_BYTES = 1024 * 1024

interface AccessMeta {
  running: boolean
  port: number | null
  enabled: boolean
}

class AccessServer {
  private server: Server | null = null
  private port: number | null = null
  private idempotency = new IdempotencyCache()

  status(): AccessMeta {
    return { running: this.server !== null, port: this.port, enabled: !!getSettings().access?.enabled }
  }

  /** 面板内 IPC 与启动流程统一入口：按 settings 同步启停 */
  syncFromSettings(): void {
    const cfg = getSettings().access
    if (cfg?.enabled) {
      if (this.server && this.port === cfg.port) return
      this.stop()
      this.start(cfg.port)
    } else {
      this.stop()
    }
  }

  private start(port: number): void {
    const server = createServer((req, res) => {
      void this.route(req, res)
    })
    server.once('error', () => {
      if (this.server === server) {
        this.server = null
        this.port = null
      }
    })
    // 安全底线：无条件环回绑定
    server.listen(port, '127.0.0.1', () => {
      this.server = server
      this.port = port
    })
  }

  stop(): void {
    if (this.server) {
      this.server.close()
      this.server = null
      this.port = null
    }
  }

  /* ---------------- routing ---------------- */

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (!this.authorize(req)) {
        return this.json(res, 401, { ok: false, error: { code: 'E_UNAUTHORIZED', message: '缺少或无效的 Bearer token' } })
      }
      const segments = url.pathname.split('/').filter(Boolean)
      if (segments[0] !== 'tpap' || segments[1] !== 'v1') {
        return this.json(res, 404, { ok: false, error: { code: 'E_NOT_FOUND', message: '未知路径' } })
      }
      const op = segments.slice(2).join('/')

      switch (`${req.method} /${op}`) {
        case 'GET /host':
          return this.json(res, 200, { ok: true, data: this.hostInfo(), cursor: accessEventLog.latest() })
        case 'GET /session':
          return this.json(res, 200, { ok: true, data: getSnapshot(), cursor: accessEventLog.latest() })
        case 'GET /events':
          return this.json(res, 200, { ok: true, ...accessEventLog.since(this.parseCursor(url.searchParams.get('cursor'))) })
        case 'GET /tools':
          return this.json(res, 200, { ok: true, data: GatewayManager.getStandardTools() })
        case 'GET /chat/sessions':
          // 对话只读面（roadmap #8）：复用 chat-store 单一实现，恒只读
          return this.json(res, 200, { ok: true, data: listSessions(app), cursor: accessEventLog.latest() })
        case 'GET /chat/session': {
          const id = url.searchParams.get('id') ?? ''
          const session = openSession(app, id)
          if (!session) {
            return this.json(res, 404, { ok: false, error: { code: 'E_NOT_FOUND', message: '会话不存在' } })
          }
          return this.json(res, 200, { ok: true, data: session, cursor: accessEventLog.latest() })
        }
        case 'POST /spec/read':
        case 'POST /task/read': {
          const body = await this.readBody(req)
          const tool = op === 'spec/read' ? 'trellis_get_spec' : 'trellis_get_task'
          const args = op === 'spec/read' ? { name: body.name } : { taskDir: body.taskDir }
          const result = await GatewayManager.executeTool(tool, args, getSnapshot()?.meta.root ?? '')
          return this.json(res, result.ok ? 200 : 502, { ...result })
        }
        case 'POST /tools/call': {
          const body = await this.readBody(req)
          if (!this.ensureConfirmed(res, body)) return
          const requestId = this.requestIdOf(body)
          if (this.idempotency.has(requestId)) {
            return this.json(res, 200, { ok: true, data: this.idempotency.peek(requestId), idempotentReplay: true })
          }
          const result = await GatewayManager.executeTool(String(body.toolName ?? ''), (body.args ?? {}) as Record<string, unknown>, getSnapshot()?.meta.root ?? '')
          this.idempotency.put(requestId, result)
          accessEventLog.append('access.mutated', { op: 'tools/call', toolName: String(body.toolName ?? ''), ok: result.ok })
          return this.json(res, result.ok ? 200 : 502, { ...result })
        }
        case 'POST /token/rotate': {
          const body = await this.readBody(req)
          if (!this.ensureConfirmed(res, body)) return
          const requestId = this.requestIdOf(body)
          if (this.idempotency.has(requestId)) {
            return this.json(res, 200, { ok: true, data: { rotated: true }, idempotentReplay: true })
          }
          rotateAccessToken()
          this.idempotency.put(requestId, { rotated: true })
          accessEventLog.append('access.mutated', { op: 'token/rotate' })
          return this.json(res, 200, { ok: true, data: { rotated: true } })
        }
        default:
          return this.json(res, 404, { ok: false, error: { code: 'E_NOT_FOUND', message: '未知操作' } })
      }
    } catch (e) {
      this.json(res, 500, { ok: false, error: { code: 'E_UNKNOWN', message: e instanceof Error ? e.message : String(e) } })
    }
  }

  private hostInfo() {
    const snap = getSnapshot()
    return {
      name: 'trellis-panel',
      protocol: PROTOCOL_VERSION,
      project: snap ? { name: snap.meta.name, root: snap.meta.root } : null,
      capabilities: ['session.read', 'events.pull', 'tools.list', 'tools.call', 'spec.read', 'task.read', 'token.rotate', 'chat.read']
    }
  }

  private authorize(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? ''
    const match = /^Bearer\s+(.+)$/i.exec(header)
    return verifyToken(match?.[1]?.trim())
  }

  /** confirm 门槛：变更操作缺 confirm:true 时直接 422 拒绝（未执行任何变更） */
  private ensureConfirmed(res: ServerResponse, body: Record<string, unknown>): boolean {
    if (body.confirm === true) return true
    this.json(res, 422, { ok: false, error: { code: 'E_DENIED', message: '变更操作必须显式携带 confirm: true' } })
    return false
  }

  private requestIdOf(body: Record<string, unknown>): string {
    const raw = typeof body.requestId === 'string' && body.requestId ? body.requestId : `auto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    return raw.slice(0, 64)
  }

  private async readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > MAX_BODY_BYTES) throw new Error('请求体超过 1MB')
      chunks.push(chunk as Buffer)
    }
    const raw = Buffer.concat(chunks).toString('utf-8').trim()
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  }

  private parseCursor(raw: string | null): Cursor | null {
    if (!raw) return null
    const [epoch, seqRaw] = raw.split(':')
    const seq = Number(seqRaw)
    if (!epoch || !Number.isFinite(seq)) return null
    return { epoch, seq }
  }

  private json(res: ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(payload))
  }
}

export const accessServer = new AccessServer()
