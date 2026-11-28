export const DEFAULT_IDLE_COMPACTION_DELAY_MS = 120_000

export interface IdleCompactionEligibility {
  readonly runId: string
}

export interface IdleCompactionServiceOptions<TAuthority> {
  readonly delayMs?: number
  readonly isEligible: (threadId: string, authority: TAuthority) => IdleCompactionEligibility | null
  readonly onTrigger: (threadId: string, runId: string, authority: TAuthority) => Promise<void> | void
}

/**
 * 集中管理会话空闲自动压缩定时器：
 * 在会话归于空闲且上下文占用达到阈值后延迟触发压缩；一旦用户发送新消息、停止、回滚或切换引擎即刻取消。
 */
export class IdleCompactionService<TAuthority> {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly delayMs: number

  constructor(private readonly options: IdleCompactionServiceOptions<TAuthority>) {
    this.delayMs = options.delayMs ?? DEFAULT_IDLE_COMPACTION_DELAY_MS
  }

  schedule(threadId: string, authority: TAuthority): void {
    if (this.timers.has(threadId)) return
    const candidate = this.options.isEligible(threadId, authority)
    if (!candidate) return
    const timer = setTimeout(() => {
      this.timers.delete(threadId)
      void Promise.resolve(this.options.onTrigger(threadId, candidate.runId, authority)).catch(() => {})
    }, this.delayMs)
    timer.unref()
    this.timers.set(threadId, timer)
  }

  cancel(threadId: string): void {
    const timer = this.timers.get(threadId)
    if (!timer) return
    clearTimeout(timer)
    this.timers.delete(threadId)
  }

  hasScheduled(threadId: string): boolean {
    return this.timers.has(threadId)
  }

  shutdown(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }
}
