/**
 * 流式高频事件 50ms 合并器与命令输出旁路缓冲中心（对齐 t3code ThreadLiveEventCoalescer + CommandOutputHub）：
 * 1. 将高频 `text-delta` 在 50ms 窗口内聚合后批量提交给 SQLite 投影与事件流，减少 10-30x 写放大；
 * 2. 对运行中的命令标准输出（`command_execution`）维护有界内存尾部缓冲，节流落盘频率（250ms），
 *    在终态/请求/关闭前强制全量刷盘，保证零数据丢失与低卡顿。
 */

const DELTA_COALESCE_WINDOW_MS = 50
const DELTA_FLUSH_CHAR_THRESHOLD = 2_048
const COMMAND_OUTPUT_PERSIST_INTERVAL_MS = 250
const COMMAND_OUTPUT_MAX_LIVE_ITEMS = 64
const COMMAND_OUTPUT_MAX_TAIL_CHARS = 12_000

export interface PendingAssistantDelta {
  readonly threadId: string
  readonly runId: string
  readonly itemId: string
  text: string
  timer: ReturnType<typeof setTimeout> | null
  flush: (threadId: string, runId: string, itemId: string, text: string) => void
}

export class AssistantDeltaCoalescer {
  private readonly pending = new Map<string, PendingAssistantDelta>()

  constructor(private readonly windowMs = DELTA_COALESCE_WINDOW_MS) {}

  private key(threadId: string, runId: string, itemId: string): string {
    return `${threadId}\u0000${runId}\u0000${itemId}`
  }

  enqueue(
    threadId: string,
    runId: string,
    itemId: string,
    delta: string,
    onFlush: (threadId: string, runId: string, itemId: string, combinedText: string) => void,
  ): void {
    if (!delta) return
    const key = this.key(threadId, runId, itemId)
    const existing = this.pending.get(key)
    if (existing) {
      existing.text += delta
      existing.flush = onFlush
      if (existing.text.length >= DELTA_FLUSH_CHAR_THRESHOLD) {
        this.flushKey(key)
      }
      return
    }
    const entry: PendingAssistantDelta = {
      threadId,
      runId,
      itemId,
      text: delta,
      timer: null,
      flush: onFlush,
    }
    this.pending.set(key, entry)
    if (delta.length >= DELTA_FLUSH_CHAR_THRESHOLD || this.windowMs <= 0) {
      this.flushKey(key)
      return
    }
    entry.timer = setTimeout(() => {
      this.flushKey(key)
    }, this.windowMs)
  }

  flushItem(threadId: string, runId: string, itemId: string): void {
    this.flushKey(this.key(threadId, runId, itemId))
  }

  flushThread(threadId: string): void {
    const prefix = `${threadId}\u0000`
    for (const key of [...this.pending.keys()]) {
      if (key.startsWith(prefix)) this.flushKey(key)
    }
  }

  flushAll(): void {
    for (const key of [...this.pending.keys()]) {
      this.flushKey(key)
    }
  }

  hasPending(threadId?: string): boolean {
    if (!threadId) return this.pending.size > 0
    const prefix = `${threadId}\u0000`
    for (const key of this.pending.keys()) {
      if (key.startsWith(prefix)) return true
    }
    return false
  }

  private flushKey(key: string): void {
    const entry = this.pending.get(key)
    if (!entry) return
    this.pending.delete(key)
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
    if (entry.text) {
      entry.flush(entry.threadId, entry.runId, entry.itemId, entry.text)
    }
  }
}

interface CommandBufferState {
  readonly threadId: string
  readonly itemId: string
  tail: string
  lastPersistedAt: number
  timer: ReturnType<typeof setTimeout> | null
  persist: (tail: string) => void
}

export class CommandOutputHub {
  private readonly buffers = new Map<string, CommandBufferState>()

  constructor(private readonly persistIntervalMs = COMMAND_OUTPUT_PERSIST_INTERVAL_MS) {}

  private key(threadId: string, itemId: string): string {
    return `${threadId}\u0000${itemId}`
  }

  private trimTail(text: string): string {
    const cleaned = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    if (cleaned.length <= COMMAND_OUTPUT_MAX_TAIL_CHARS) return cleaned
    return `…${cleaned.slice(-(COMMAND_OUTPUT_MAX_TAIL_CHARS - 1))}`
  }

  recordOutput(
    threadId: string,
    itemId: string,
    output: string,
    status: 'running' | 'completed' | 'failed' | 'cancelled',
    onPersist: (tail: string) => void,
  ): void {
    const key = this.key(threadId, itemId)
    const tail = this.trimTail(output)
    const now = Date.now()
    const existing = this.buffers.get(key)

    if (status !== 'running') {
      if (existing?.timer) clearTimeout(existing.timer)
      this.buffers.delete(key)
      onPersist(tail)
      return
    }

    if (existing) {
      existing.tail = tail
      existing.persist = onPersist
      if (now - existing.lastPersistedAt >= this.persistIntervalMs || this.persistIntervalMs <= 0) {
        this.flushKey(key)
      } else if (!existing.timer) {
        const delay = Math.max(10, this.persistIntervalMs - (now - existing.lastPersistedAt))
        existing.timer = setTimeout(() => {
          this.flushKey(key)
        }, delay)
      }
      return
    }

    if (this.buffers.size >= COMMAND_OUTPUT_MAX_LIVE_ITEMS) {
      const oldestKey = this.buffers.keys().next().value
      if (oldestKey) this.flushKey(oldestKey, true)
    }

    const entry: CommandBufferState = {
      threadId,
      itemId,
      tail,
      lastPersistedAt: now,
      timer: null,
      persist: onPersist,
    }
    this.buffers.set(key, entry)
    onPersist(tail)
  }

  readLiveOutput(threadId: string, itemId: string): string | undefined {
    return this.buffers.get(this.key(threadId, itemId))?.tail
  }

  flushThread(threadId: string): void {
    const prefix = `${threadId}\u0000`
    for (const key of [...this.buffers.keys()]) {
      if (key.startsWith(prefix)) this.flushKey(key, true)
    }
  }

  flushAll(): void {
    for (const key of [...this.buffers.keys()]) {
      this.flushKey(key, true)
    }
  }

  private flushKey(key: string, dropAfterFlush = false): void {
    const entry = this.buffers.get(key)
    if (!entry) return
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
    entry.lastPersistedAt = Date.now()
    const { tail, persist } = entry
    if (dropAfterFlush) this.buffers.delete(key)
    persist(tail)
  }
}
