import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import type { ChatMessage, ChatSessionMeta, ThinkingLevel } from '../../shared/types'

/**
 * 会话存储 v2（TPD-016）：树结构。
 *   nodes: { id → { id, role, content, reasoning?, parent } }，activeLeaf 指向当前叶；
 *   活跃对话 = activeLeaf 向上回溯到根的路径。
 * 分支：同 parent 的兄弟节点即备选回答/编辑重发分支；旧分支永不丢弃，可随时切回。
 * v1（线性 messages 数组）打开时自动迁移为链。写入走 tmp+rename 原子替换。
 */

/** 仅依赖 getPath 的应用注入面（Electron App 与冒烟桩均可满足） */
export interface AppPathProvider {
  getPath: (name: 'userData' | 'home' | 'appData' | 'temp') => string
}

export interface ChatNode extends ChatMessage {
  id: string
  parent: string | null
}

export interface ChatSessionTree {
  version: 2
  id: string
  title: string
  createdAt: number
  updatedAt: number
  providerId: string | null
  modelId: string | null
  thinkingLevel: ThinkingLevel
  /** agent 工具循环开关（TPD-020） */
  agent?: boolean
  /** allow-session 的工具白名单（随会话持久化） */
  allowedTools?: string[]
  nodes: Record<string, ChatNode>
  activeLeaf: string | null
}

let dir: string | null = null

function sessionsDir(app: AppPathProvider): string {
  if (!dir) {
    dir = join(app.getPath('userData'), 'chat-sessions')
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

function filePath(app: AppPathProvider, id: string): string {
  if (!/^[a-z0-9-]+$/i.test(id)) throw new Error('非法会话 ID')
  return join(sessionsDir(app), `${id}.json`)
}

function persist(app: AppPathProvider, session: ChatSessionTree): void {
  const p = filePath(app, session.id)
  const tmp = `${p}.tmp`
  writeFileSync(tmp, JSON.stringify(session, null, 2), 'utf-8')
  renameSync(tmp, p)
}

export function newSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function newNodeId(): string {
  return `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export function createSession(
  app: AppPathProvider,
  binding?: { providerId?: string; modelId?: string; thinkingLevel?: ThinkingLevel }
): ChatSessionTree {
  const now = Date.now()
  const session: ChatSessionTree = {
    version: 2,
    id: newSessionId(),
    title: '新对话',
    createdAt: now,
    updatedAt: now,
    providerId: binding?.providerId ?? null,
    modelId: binding?.modelId ?? null,
    thinkingLevel: binding?.thinkingLevel ?? 'off',
    nodes: {},
    activeLeaf: null
  }
  persist(app, session)
  return session
}

/** v1（线性 messages）→ v2 树迁移 */
function migrateV1(raw: Record<string, unknown>): ChatSessionTree {
  const messages = Array.isArray(raw.messages) ? (raw.messages as ChatMessage[]) : []
  const nodes: Record<string, ChatNode> = {}
  let parent: string | null = null
  let leaf: string | null = null
  for (const m of messages) {
    const id = newNodeId()
    nodes[id] = { id, parent, role: m.role, content: m.content, ...(m.reasoning ? { reasoning: m.reasoning } : {}) }
    parent = id
    leaf = id
  }
  return {
    version: 2,
    id: String(raw.id ?? newSessionId()),
    title: String(raw.title ?? '新对话'),
    createdAt: Number(raw.createdAt ?? Date.now()),
    updatedAt: Number(raw.updatedAt ?? Date.now()),
    providerId: (raw.providerId as string | null) ?? null,
    modelId: (raw.modelId as string | null) ?? null,
    thinkingLevel: (raw.thinkingLevel as ThinkingLevel) ?? 'off',
    nodes,
    activeLeaf: leaf
  }
}

function parseSession(rawText: string): ChatSessionTree {
  const raw = JSON.parse(rawText) as Record<string, unknown>
  if (Array.isArray(raw.messages)) return migrateV1(raw)
  return raw as unknown as ChatSessionTree
}

/** 活跃路径：activeLeaf 回溯到根后正序 */
export function activePath(session: ChatSessionTree): ChatNode[] {
  const path: ChatNode[] = []
  let cur = session.activeLeaf ? session.nodes[session.activeLeaf] : undefined
  while (cur) {
    path.unshift(cur)
    cur = cur.parent ? session.nodes[cur.parent] : undefined
  }
  return path
}

export function listSessions(app: AppPathProvider): ChatSessionMeta[] {
  const d = sessionsDir(app)
  const out: ChatSessionMeta[] = []
  try {
    for (const f of readdirSync(d)) {
      if (!f.endsWith('.json') || f.endsWith('.tmp.json')) continue
      try {
        const s = parseSession(readFileSync(join(d, f), 'utf-8'))
        if (!s?.id) continue
        out.push({
          id: s.id,
          title: s.title,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          messageCount: activePath(s).length,
          providerId: s.providerId,
          modelId: s.modelId,
          thinkingLevel: s.thinkingLevel ?? 'off'
        })
      } catch {
        // 单个损坏文件不影响列表
      }
    }
  } catch {
    // 目录不存在 → 空列表
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function openSession(app: AppPathProvider, id: string): ChatSessionTree | null {
  const p = filePath(app, id)
  if (!existsSync(p)) return null
  return parseSession(readFileSync(p, 'utf-8'))
}

export function deleteSession(app: AppPathProvider, id: string): void {
  const p = filePath(app, id)
  if (existsSync(p)) rmSync(p)
}

export function renameSession(app: AppPathProvider, id: string, title: string): void {
  const s = openSession(app, id)
  if (!s) throw new Error('会话不存在')
  s.title = String(title ?? '').slice(0, 80) || s.title
  persist(app, s)
}

export function updateBinding(
  app: AppPathProvider,
  id: string,
  binding: {
    providerId?: string | null
    modelId?: string | null
    thinkingLevel?: ThinkingLevel
    agent?: boolean
  }
): void {
  const s = openSession(app, id)
  if (!s) throw new Error('会话不存在')
  if ('providerId' in binding) s.providerId = binding.providerId ?? null
  if ('modelId' in binding) s.modelId = binding.modelId ?? null
  if ('thinkingLevel' in binding && binding.thinkingLevel) s.thinkingLevel = binding.thinkingLevel
  if (binding.agent !== undefined) s.agent = binding.agent
  persist(app, s)
}

/** allow-session：加入会话工具白名单 */
export function addAllowedTool(app: AppPathProvider, id: string, toolName: string): void {
  const s = openSession(app, id)
  if (!s) throw new Error('会话不存在')
  s.allowedTools = s.allowedTools ?? []
  if (!s.allowedTools.includes(toolName)) s.allowedTools.push(toolName)
  persist(app, s)
}

/** 活跃叶追加消息节点并置为 activeLeaf */
export function appendNode(app: AppPathProvider, id: string, message: ChatMessage): ChatNode {
  const s = openSession(app, id)
  if (!s) throw new Error('会话不存在')
  return addChildNode(app, id, s.activeLeaf, message)
}

/** 在指定父节点下创建兄弟节点（编辑重发/分支/regenerate 用） */
export function addChildNode(
  app: AppPathProvider,
  id: string,
  parentId: string | null,
  message: ChatMessage
): ChatNode {
  const s = openSession(app, id)
  if (!s) throw new Error('会话不存在')
  const node: ChatNode = {
    id: newNodeId(),
    parent: parentId,
    role: message.role,
    content: message.content,
    ...(message.reasoning ? { reasoning: message.reasoning } : {}),
    ...(message.images?.length ? { images: message.images } : {}),
    ...(message.toolOps?.length ? { toolOps: message.toolOps } : {})
  }
  s.nodes[node.id] = node
  s.activeLeaf = node.id
  s.updatedAt = Date.now()
  persist(app, s)
  return node
}

/** 分支切换：activeLeaf 置为指定节点 */
export function setLeaf(app: AppPathProvider, id: string, leafId: string): void {
  const s = openSession(app, id)
  if (!s) throw new Error('会话不存在')
  if (!s.nodes[leafId]) throw new Error('分支节点不存在')
  s.activeLeaf = leafId
  s.updatedAt = Date.now()
  persist(app, s)
}

/** 同 parent 兄弟节点（含自身），按 nodes 插入顺序 */
export function siblingsOf(session: ChatSessionTree, nodeId: string): ChatNode[] {
  const node = session.nodes[nodeId]
  if (!node) return []
  return Object.values(session.nodes).filter((n) => n.parent === node.parent)
}
