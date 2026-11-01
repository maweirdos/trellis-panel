import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { readBounded } from '../daemon/files'
import type { ChatSessionMeta, ChatSessionView } from '../../shared/types'

/** Read historical files in full or fail; never truncate or rewrite an archive. */
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
const MAX_ARCHIVE_NODES = 50_000
const sessionIdSchema = z.string().min(1).max(128).regex(/^[a-z0-9-]+$/i)
const nodeIdSchema = z.string().min(1).max(256)
export const archiveQuerySchema = z.object({ id: sessionIdSchema, branchId: nodeIdSchema.optional() })
const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
  reasoning: z.string().optional(),
  images: z.array(z.object({ mediaType: z.string(), dataBase64: z.string() }).passthrough()).optional(),
  toolOps: z.array(z.object({
    toolName: z.string(), argsSummary: z.string(), status: z.enum(['success', 'error', 'denied']), elapsedMs: z.number().finite(),
    sources: z.array(z.object({ title: z.string(), path: z.string(), library: z.string().optional() }).passthrough()).optional()
  }).passthrough()).optional()
}).passthrough()
const nodeSchema = messageSchema.extend({ id: nodeIdSchema, parent: nodeIdSchema.nullable() })
const metadataSchema = z.object({
  id: sessionIdSchema, title: z.string(), createdAt: z.number().finite(), updatedAt: z.number().finite(),
  providerId: z.string().nullable().default(null), modelId: z.string().nullable().default(null),
  thinkingLevel: z.enum(['off', 'low', 'medium', 'high']).default('off'),
  agent: z.boolean().optional(), taskDir: z.string().nullable().optional()
}).passthrough()
const treeSchema = metadataSchema.extend({
  version: z.literal(2), nodes: z.record(nodeIdSchema, nodeSchema).refine((nodes) => Object.keys(nodes).length <= MAX_ARCHIVE_NODES),
  activeLeaf: nodeIdSchema.nullable()
})
const linearSchema = metadataSchema.extend({ version: z.literal(1).optional(), messages: z.array(messageSchema).max(MAX_ARCHIVE_NODES) })

export interface AppPathProvider {
  getPath: (name: 'userData' | 'home' | 'appData' | 'temp') => string
}
export type ChatNode = z.infer<typeof nodeSchema>
export type ChatSessionTree = z.infer<typeof treeSchema>

function sessionsDir(app: AppPathProvider): string {
  return join(app.getPath('userData'), 'chat-sessions')
}

function parseSession(text: string, expectedId: string): ChatSessionTree {
  const raw: unknown = JSON.parse(text)
  let session: ChatSessionTree
  if (raw && typeof raw === 'object' && 'messages' in raw && (!('version' in raw) || raw.version === 1)) {
    const linear = linearSchema.safeParse(raw)
    if (!linear.success) throw new Error('历史会话格式损坏')
    const { messages, ...metadata } = linear.data
    const nodes: Record<string, ChatNode> = {}
    let activeLeaf: string | null = null
    for (const [index, message] of messages.entries()) {
      const id = 'legacy-' + index
      nodes[id] = { ...message, id, parent: activeLeaf }
      activeLeaf = id
    }
    // Stable, read-only projection of original linear records; no disk migration.
    session = { ...metadata, version: 2, nodes, activeLeaf }
  } else {
    const tree = treeSchema.safeParse(raw)
    if (!tree.success) throw new Error('历史会话格式损坏')
    session = tree.data
  }
  if (session.id !== expectedId) throw new Error('历史会话 ID 与文件不匹配')
  const checked = new Set<string>()
  for (const [id, node] of Object.entries(session.nodes)) {
    if (node.id !== id) throw new Error('历史消息 ID 与节点不匹配')
    const path = new Set<string>()
    let cursor: string | null = id
    while (cursor !== null && !checked.has(cursor)) {
      if (path.has(cursor)) throw new Error('历史会话存在循环分支')
      if (!Object.hasOwn(session.nodes, cursor)) throw new Error('历史会话存在缺失的父节点')
      path.add(cursor)
      cursor = session.nodes[cursor].parent
    }
    for (const visited of path) checked.add(visited)
  }
  if (session.activeLeaf !== null && !Object.hasOwn(session.nodes, session.activeLeaf)) throw new Error('历史会话的当前分支不存在')
  return session
}

export function openSession(app: AppPathProvider, id: string): ChatSessionTree | null {
  if (!sessionIdSchema.safeParse(id).success) throw new Error('非法会话 ID')
  const file = join(sessionsDir(app), id + '.json')
  try {
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('历史会话必须是普通文件')
    if (stat.size > MAX_ARCHIVE_BYTES) throw new Error('历史会话超过 64 MiB 读取上限，原文件保持不变')
    return parseSession(readBounded(file, Math.min(stat.size + 1, MAX_ARCHIVE_BYTES)), id)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
}

/** The saved current branch is the default; a selected archive branch stays local to the read. */
export function activePath(session: ChatSessionTree, leafId: string | null = session.activeLeaf): ChatNode[] {
  const path: ChatNode[] = [], seen = new Set<string>()
  let cursor = leafId
  while (cursor !== null) {
    if (seen.has(cursor)) throw new Error('历史会话存在循环分支')
    if (!Object.hasOwn(session.nodes, cursor)) throw new Error('历史分支节点不存在')
    seen.add(cursor)
    const node = session.nodes[cursor]
    path.push(node)
    cursor = node.parent
  }
  return path.reverse()
}

/** Follow the last stored child, without changing activeLeaf or timestamps. */
export function deepestLeaf(session: ChatSessionTree, nodeId: string): string {
  if (!Object.hasOwn(session.nodes, nodeId)) throw new Error('历史分支节点不存在')
  const lastChild = new Map<string, string>()
  for (const node of Object.values(session.nodes)) if (node.parent !== null) lastChild.set(node.parent, node.id)
  const seen = new Set<string>()
  let cursor = nodeId
  for (;;) {
    if (seen.has(cursor)) throw new Error('历史会话存在循环分支')
    if (!Object.hasOwn(session.nodes, cursor)) throw new Error('历史分支节点不存在')
    seen.add(cursor)
    const child = lastChild.get(cursor)
    if (!child) return cursor
    cursor = child
  }
}

function sessionMeta(session: ChatSessionTree, messageCount: number): ChatSessionMeta {
  return {
    id: session.id, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt, messageCount,
    providerId: session.providerId, modelId: session.modelId, thinkingLevel: session.thinkingLevel,
    agent: session.agent ?? false, taskDir: session.taskDir ?? null
  }
}

export function sessionView(session: ChatSessionTree, branchId?: string): ChatSessionView {
  const leaf = branchId === undefined ? session.activeLeaf : deepestLeaf(session, branchId)
  const siblings = new Map<string | null, string[]>()
  for (const node of Object.values(session.nodes)) {
    const group = siblings.get(node.parent) ?? []
    group.push(node.id)
    siblings.set(node.parent, group)
  }
  const messages = activePath(session, leaf).map((node) => {
    const ids = siblings.get(node.parent) ?? [node.id]
    return {
      id: node.id, role: node.role, content: node.content,
      ...(node.reasoning !== undefined ? { reasoning: node.reasoning } : {}),
      ...(node.images ? { images: node.images } : {}), ...(node.toolOps ? { toolOps: node.toolOps } : {}),
      siblingCount: ids.length, siblingIndex: ids.indexOf(node.id), siblingIds: ids
    }
  })
  return { ...sessionMeta(session, messages.length), messages }
}

export function listSessions(app: AppPathProvider): ChatSessionMeta[] {
  let entries: string[]
  try { entries = readdirSync(sessionsDir(app)) }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
  const sessions: ChatSessionMeta[] = []
  for (const file of entries) {
    if (!file.endsWith('.json')) continue
    try {
      const session = openSession(app, file.slice(0, -5))
      if (session) sessions.push(sessionMeta(session, activePath(session).length))
    } catch { /* One unreadable archive does not hide intact records. */ }
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt)
}
