const MAX_ENTRIES = 256
const TTL_MS = 10 * 60 * 1000

interface MutationEntry {
  fingerprint: string
  promise: Promise<unknown>
  settled: boolean
  expiresAt: number
}

export class MutationRequestError extends Error {
  constructor(readonly code: 'E_CONFLICT' | 'E_DENIED', message: string) {
    super(message)
  }
}

/** Reserve before invoking: simultaneous retries share the same in-flight operation. */
export class MutationCache {
  private entries = new Map<string, MutationEntry>()

  async execute<T>(requestId: string, fingerprint: string, operation: () => Promise<T>): Promise<{ value: T; replay: boolean }> {
    this.prune()
    const existing = this.entries.get(requestId)
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new MutationRequestError('E_CONFLICT', 'requestId 已用于不同的操作，请使用新的 requestId')
      this.entries.delete(requestId)
      this.entries.set(requestId, existing)
      return { value: await existing.promise as T, replay: true }
    }
    if (this.entries.size >= MAX_ENTRIES) {
      const disposable = [...this.entries].find(([, entry]) => entry.settled)
      if (disposable) this.entries.delete(disposable[0])
      else throw new MutationRequestError('E_DENIED', '正在处理的请求过多，请稍后重试')
    }
    const entry: MutationEntry = {
      fingerprint,
      promise: Promise.resolve().then(operation),
      settled: false,
      expiresAt: Number.POSITIVE_INFINITY
    }
    this.entries.set(requestId, entry)
    try {
      const value = await entry.promise as T
      entry.settled = true
      entry.expiresAt = Date.now() + TTL_MS
      return { value, replay: false }
    } catch (error) {
      if (this.entries.get(requestId) === entry) this.entries.delete(requestId)
      throw error
    }
  }

  private prune(): void {
    const now = Date.now()
    for (const [key, entry] of this.entries) {
      if (entry.settled && entry.expiresAt <= now) this.entries.delete(key)
    }
  }
}
