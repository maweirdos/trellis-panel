import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import type { ChatMessage, ChatSession, ChatSessionMeta, ThinkingLevel } from '../../shared/types'

/** 仅依赖 getPath 的应用注入面（ Electron App 与冒烟桩均可满足） */
export interface AppPathProvider {
  getPath: (name: 'userData' | 'home' | 'appData' | 'temp') => string
}

/**
 * 会话持久化：userData/chat-sessions/<id>.json，写入走 tmp+rename 原子替换。
 * 规模预期为个人量级（几十~几百会话），列表直接全量读元信息。
 */

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

function persist(app: AppPathProvider, session: ChatSession): void {
  const p = filePath(app, session.id)
  const tmp = `${p}.tmp`
  writeFileSync(tmp, JSON.stringify(session, null, 2), 'utf-8')
  renameSync(tmp, p)
}

export function newSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function createSession(
  app: AppPathProvider,
  binding?: { providerId?: string; modelId?: string; thinkingLevel?: ThinkingLevel }
): ChatSession {
  const now = Date.now()
  const session: ChatSession = {
    id: newSessionId(),
    title: '新对话',
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    providerId: binding?.providerId ?? null,
    modelId: binding?.modelId ?? null,
    thinkingLevel: binding?.thinkingLevel ?? 'off',
    messages: []
  }
  persist(app, session)
  return session
}

export function listSessions(app: AppPathProvider): ChatSessionMeta[] {
  const d = sessionsDir(app)
  const out: ChatSessionMeta[] = []
  try {
    for (const f of readdirSync(d)) {
      if (!f.endsWith('.json') || f.endsWith('.tmp.json')) continue
      try {
        const s = JSON.parse(readFileSync(join(d, f), 'utf-8')) as ChatSession
        if (!s?.id) continue
        out.push({
          id: s.id,
          title: s.title,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          messageCount: s.messageCount,
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

export function openSession(app: AppPathProvider, id: string): ChatSession | null {
  const p = filePath(app, id)
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, 'utf-8')) as ChatSession
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
  binding: { providerId?: string | null; modelId?: string | null; thinkingLevel?: ThinkingLevel }
): void {
  const s = openSession(app, id)
  if (!s) throw new Error('会话不存在')
  if ('providerId' in binding) s.providerId = binding.providerId ?? null
  if ('modelId' in binding) s.modelId = binding.modelId ?? null
  if ('thinkingLevel' in binding && binding.thinkingLevel) s.thinkingLevel = binding.thinkingLevel
  persist(app, s)
}

export function appendMessage(app: AppPathProvider, id: string, message: ChatMessage): void {
  const s = openSession(app, id)
  if (!s) throw new Error('会话不存在')
  s.messages.push(message)
  s.messageCount = s.messages.length
  s.updatedAt = Date.now()
  persist(app, s)
}

/** 重新生成用：移除末条 assistant 并落库；末条不是 assistant 时抛错 */
export function popLastAssistant(app: AppPathProvider, id: string): void {
  const s = openSession(app, id)
  if (!s) throw new Error('会话不存在')
  const last = s.messages[s.messages.length - 1]
  if (!last || last.role !== 'assistant') throw new Error('没有可重新生成的回答')
  s.messages.pop()
  s.messageCount = s.messages.length
  s.updatedAt = Date.now()
  persist(app, s)
}
