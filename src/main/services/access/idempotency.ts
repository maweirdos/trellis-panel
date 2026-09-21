/**
 * 变更操作幂等保护：外部客户端请求丢失响应后重试，凭相同 requestId
 * 命中缓存返回首次结果，杜绝二次变更。LRU + TTL 双淘汰。
 * 存储包一层 box，使"首次结果为 null/undefined"与"未命中"可区分。
 */
interface Entry {
  box: { value: unknown }
  expiresAt: number
}

const MAX_ENTRIES = 256
const TTL_MS = 10 * 60 * 1000

export class IdempotencyCache {
  private map = new Map<string, Entry>()

  has(requestId: string): boolean {
    const hit = this.map.get(requestId)
    if (!hit) return false
    if (hit.expiresAt <= Date.now()) {
      this.map.delete(requestId)
      return false
    }
    // LRU touch
    this.map.delete(requestId)
    this.map.set(requestId, hit)
    return true
  }

  peek<T>(requestId: string): T | undefined {
    return this.map.get(requestId)?.box.value as T | undefined
  }

  put(requestId: string, value: unknown): void {
    this.map.set(requestId, { box: { value }, expiresAt: Date.now() + TTL_MS })
    if (this.map.size > MAX_ENTRIES) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
  }
}
