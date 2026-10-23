import { open, stat as pathStat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { TaskConversationPreview } from '../../../../shared/task-conversations'
import type { NativeHistoryFile } from '../types'
import { ownedPath, pathKey } from './paths'
import { object } from './history-parser'

const HEAD_BYTES = 128 * 1024, TAIL_BYTES = 512 * 1024, SNAPSHOT_BYTES = 2 * 1024 * 1024
const visibleChannels = new Set([undefined, null, 'final', 'commentary'])
function textContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.slice(0, 256).flatMap(raw => {
    const item = object(raw)
    return item && ['text', 'input_text', 'output_text'].includes(String(item.type)) && visibleChannels.has(item.channel as string | undefined)
      && typeof item.text === 'string' ? [item.text] : []
  }).join('\n')
}
function metadataMatches(item: NativeHistoryFile, id: unknown, cwd: unknown): boolean {
  return id === item.conversation.sessionId && typeof cwd === 'string' && pathKey(cwd) === pathKey(item.conversation.cwd)
}
export async function nativePreview(root: string, conversationId: string, descriptor?: NativeHistoryFile): Promise<TaskConversationPreview> {
  const result: TaskConversationPreview = { projectRoot: root, conversationId, messages: [], truncated: false }
  const unavailable = (reason: string): TaskConversationPreview => ({ ...result, messages: [], unavailableReason: reason })
  if (!descriptor) return unavailable('该来源没有可验证的本机会话片段')
  let handle: Awaited<ReturnType<typeof open>> | undefined
  const append = (role: unknown, text: string): void => {
    if ((role !== 'user' && role !== 'assistant') || !text.trim()) return
    if (text.length > 4096) result.truncated = true
    result.messages.push({ role, text: text.slice(0, 4096) })
    if (result.messages.length > 12) { result.messages.shift(); result.truncated = true }
  }
  try {
    const file = ownedPath(descriptor.sourceRoot, isAbsolute(descriptor.file) ? descriptor.file : resolve(descriptor.sourceRoot, descriptor.file))
    handle = await open(file, 'r')
    const stat = await handle.stat({ bigint: true }), size = Number(stat.size)
    if (!stat.isFile() || !Number.isSafeInteger(size)) return unavailable('本机会话文件不可读取')
    const read = async (at: number, length: number): Promise<Buffer> => {
      const buffer = Buffer.alloc(length), count = await handle?.read(buffer, 0, length, at)
      return buffer.subarray(0, count?.bytesRead || 0)
    }
    if (descriptor.conversation.source === 'zcode') {
      if (size > SNAPSHOT_BYTES) return unavailable('ZCode 会话快照超过 2 MiB 预览上限，可直接打开核对')
      const snapshot = object(JSON.parse((await read(0, size)).toString('utf8'))), meta = object(snapshot?.meta)
      if (!meta || !metadataMatches(descriptor, meta.taskId, meta.workspacePath)
        || (descriptor.providerId || null) !== (typeof meta.acpSessionId === 'string' ? meta.acpSessionId : null)) return unavailable('会话身份或项目归属核验失败')
      if (!Array.isArray(snapshot?.messages)) return unavailable('ZCode 会话格式暂不支持片段预览')
      for (const raw of snapshot.messages) {
        const item = object(raw)
        if (!item || !visibleChannels.has(item.channel as string | undefined) || ['analysis', 'reasoning', 'thinking', 'tool'].includes(String(item.type))) continue
        if (item.role === 'user' || item.role === 'assistant') append(item.role, textContent(item.content))
      }
    } else {
      const source = descriptor.conversation.source
      const head = (await read(0, Math.min(size, HEAD_BYTES))).toString('utf8')
      let verified = false
      const parse = (line: string): Record<string, unknown> | null => { try { return object(JSON.parse(line)) } catch { return null } }
      const check = (entry: Record<string, unknown>): boolean => {
        if (entry.isSidechain === true) return false
        const payload = object(entry.payload)
        if (source === 'codex' && entry.type === 'session_meta') {
          if (!payload || !metadataMatches(descriptor, payload.id, payload.cwd)) return false
          const origin = object(payload.source), subagent = object(origin?.subagent), spawn = object(subagent?.thread_spawn)
          // Match the native history parser's explicit child rule; unknown index roles
          // cannot override stronger role evidence in the actual file being previewed.
          if (payload.thread_source === 'subagent' || typeof spawn?.parent_thread_id === 'string') return false
          verified = true
        }
        for (const record of [entry, payload]) if (record) {
          for (const key of ['sessionId', 'session_id']) if (record[key] !== undefined && record[key] !== descriptor.conversation.sessionId) return false
          if (record.cwd !== undefined && (typeof record.cwd !== 'string' || pathKey(record.cwd) !== pathKey(descriptor.conversation.cwd))) return false
        }
        if (source === 'claude-code' && entry.sessionId !== undefined && entry.cwd !== undefined) verified = metadataMatches(descriptor, entry.sessionId, entry.cwd)
        return true
      }
      for (const line of head.split('\n')) { const entry = parse(line); if (entry && !check(entry)) return unavailable('会话身份或项目归属核验失败') }
      if (!verified) return unavailable('无法在有界元信息内核验会话身份')
      const start = Math.max(0, size - TAIL_BYTES)
      let tail = await read(Math.max(0, start - 1), Math.min(size, TAIL_BYTES + (start ? 1 : 0)))
      if (start) {
        result.truncated = true
        tail = tail[0] === 10 ? tail.subarray(1) : tail.subarray(tail.indexOf(10) >= 0 ? tail.indexOf(10) + 1 : tail.length)
      }
      for (const line of tail.toString('utf8').split('\n')) {
        const entry = parse(line)
        if (!entry) { if (line.trim()) result.truncated = true; continue }
        if (!check(entry)) return unavailable('会话片段包含不同身份或项目，已停止预览')
        if (source === 'codex') {
          const payload = object(entry.payload)
          if (entry.type !== 'response_item' || !payload || payload.type !== 'message' || !visibleChannels.has(entry.channel as string | undefined) || !visibleChannels.has(payload.channel as string | undefined)) continue
          if (payload.role === 'user' || payload.role === 'assistant') append(payload.role, textContent(payload.content))
        } else {
          const message = object(entry.message)
          if ((entry.type !== 'user' && entry.type !== 'assistant') || !message || entry.sessionId !== descriptor.conversation.sessionId
            || typeof entry.cwd !== 'string' || pathKey(entry.cwd) !== pathKey(descriptor.conversation.cwd)
            || message.role !== undefined && message.role !== entry.type || !visibleChannels.has(message.channel as string | undefined)) continue
          append(entry.type, textContent(message.content))
        }
      }
    }
    // Head verification and tail extraction must belong to one stable snapshot.
    // Compare both the open inode and path: in-place writes and atomic replacement
    // must fail closed rather than project another session's body under old metadata.
    for (const current of [await handle.stat({ bigint: true }), await pathStat(file, { bigint: true })]) {
      if (current.dev !== stat.dev || current.ino !== stat.ino || current.size !== stat.size
        || current.mtimeNs !== stat.mtimeNs || current.ctimeNs !== stat.ctimeNs) return unavailable('原生会话在读取期间已改变，请重新读取片段')
    }
    return result.messages.length ? result : unavailable('未发现可预览的用户或助手文本，可直接打开核对')
  } catch { return unavailable('原生片段不可读取、已删除或格式暂不支持') }
  finally { await handle?.close() }
}
