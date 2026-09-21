/**
 * 持久事件日志：接入协议的重连语义基石。
 *
 * - 每条事件带单调递增 seq；epoch 标识进程生命周期，跨重启必变，
 *   客户端凭 cursor={epoch,seq} 拉取，epoch 不匹配即全量重置——
 *   永远不用墙钟时间做续传依据。
 * - 内存环形上限，超出即丢最旧；客户端拉取范围越过丢失区间时同样触发 reset。
 */
export interface AccessEvent<T = unknown> {
  seq: number
  epoch: string
  ts: number
  type: string
  payload: T
}

export interface Cursor {
  epoch: string
  seq: number
}

export interface PullResult<T = unknown> {
  events: AccessEvent<T>[]
  nextCursor: Cursor
  /** true 表示客户端游标失效（epoch 变更或区间已丢弃），需全量重拉 session */
  reset: boolean
}

const MAX_EVENTS = 1000

function newEpoch(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

class EventLog {
  private events: AccessEvent[] = []
  private nextSeq = 1
  readonly epoch = newEpoch()

  append(type: string, payload?: unknown): AccessEvent {
    const event: AccessEvent = { seq: this.nextSeq++, epoch: this.epoch, ts: Date.now(), type, payload }
    this.events.push(event)
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS)
    }
    return event
  }

  latest(): Cursor {
    return { epoch: this.epoch, seq: this.nextSeq - 1 }
  }

  since(cursor: Cursor | null): PullResult {
    const latest = this.latest()
    if (!cursor || cursor.epoch !== this.epoch || cursor.seq < this.oldestSeq() - 1 || cursor.seq > latest.seq) {
      // 首连 / 跨重启 / 区间丢失：要求客户端全量重拉
      return { events: [], nextCursor: latest, reset: true }
    }
    const events = this.events.filter((e) => e.seq > cursor.seq)
    return { events, nextCursor: latest, reset: false }
  }

  private oldestSeq(): number {
    return this.events.length > 0 ? this.events[0].seq : this.nextSeq
  }
}

export const accessEventLog = new EventLog()
