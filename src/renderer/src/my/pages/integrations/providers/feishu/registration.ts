import type { FeishuAttempt, FeishuResult } from '@shared/feishu-integration'

type AttemptAction = (id: string) => Promise<FeishuResult<FeishuAttempt>>

export interface RegistrationTarget {
  key: string
  begin: () => Promise<FeishuResult<FeishuAttempt>>
  isConnected: () => Promise<FeishuResult<boolean>>
  read: AttemptAction
  cancel: AttemptAction
  discard: AttemptAction
}

interface RegistrationEntry {
  target: RegistrationTarget
  attempt: FeishuAttempt | null
  starting: boolean
  reading: boolean
  cancelling: boolean
  unknownStart: boolean
  registered: boolean
  issue: string
  linkBlocked: boolean
  sequence: number
  started: Promise<void>
  cancellation: Promise<void> | null
}

export interface RegistrationState {
  targetKey: string | null
  attempt: FeishuAttempt | null
  starting: boolean
  reading: boolean
  cancelling: boolean
  unknownStart: boolean
  registered: boolean
  issue: string
  linkBlocked: boolean
}

const EMPTY_STATE: RegistrationState = {
  targetKey: null, attempt: null, starting: false, reading: false, cancelling: false,
  unknownStart: false, registered: false, issue: '', linkBlocked: false
}

function waiting(attempt: FeishuAttempt | null): boolean {
  return attempt?.status === 'starting' || attempt?.status === 'pending'
}

/** The workspace owns registration; closing its dialog does not cancel the daemon's attempt. */
export class FeishuRegistrationController {
  private desired: RegistrationTarget | null = null
  private ready = false
  private recoveryReady = false
  private beginAvailable = false
  private current: RegistrationEntry | null = null
  private readonly entries = new Map<string, RegistrationEntry>()
  private readonly listeners = new Set<() => void>()
  private reconciling = false
  private state: RegistrationState = EMPTY_STATE

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  readonly getSnapshot = (): RegistrationState => this.state

  private emit(): void {
    const entry = this.current?.target.key === this.desired?.key ? this.current : null
    this.state = this.desired ? {
      targetKey: this.desired.key,
      attempt: entry?.attempt ?? null,
      starting: entry?.starting ?? this.ready,
      reading: entry?.reading ?? false,
      cancelling: entry?.cancelling ?? false,
      unknownStart: entry?.unknownStart ?? false,
      registered: entry?.registered ?? false,
      issue: entry?.issue ?? '',
      linkBlocked: entry?.linkBlocked ?? false
    } : EMPTY_STATE
    for (const listener of this.listeners) listener()
  }

  select(target: RegistrationTarget | null, ready: boolean, recoveryReady = ready, beginAvailable = ready): void {
    const entry = this.current
    const reopening = ready && !this.ready && entry && entry.target.key === target?.key &&
      entry.target.key === this.desired?.key
    this.desired = target
    this.ready = ready
    this.recoveryReady = recoveryReady
    this.beginAvailable = beginAvailable
    if (reopening && (entry.attempt?.status === 'expired' || entry.attempt?.status === 'cancelled')) {
      this.retry()
      return
    }
    if (reopening && waiting(entry.attempt) && entry.attempt?.expiresAt && entry.attempt.expiresAt <= Date.now()) {
      void this.check().then(() => {
        if (this.current === entry && this.ready && entry.attempt?.status === 'expired') this.retry()
      })
    }
    this.emit()
    this.reconcile()
  }

  private create(target: RegistrationTarget): RegistrationEntry {
    const entry: RegistrationEntry = {
      target, attempt: null, starting: true, reading: false, cancelling: false,
      unknownStart: false, registered: false, issue: '', linkBlocked: false, sequence: 0,
      started: Promise.resolve(), cancellation: null
    }
    this.entries.set(target.key, entry)
    entry.started = (async () => {
      try {
        const result = await target.begin()
        if (result.ok) entry.attempt = result.data
        else {
          entry.unknownStart = result.code === 'E_UNKNOWN' || result.code === 'E_TIMEOUT'
          entry.issue = result.error
        }
      } catch {
        entry.unknownStart = true
        entry.issue = '未确认授权请求是否已创建。'
      } finally {
        entry.starting = false
        this.emit()
      }
    })()
    return entry
  }

  private reconcile(): void {
    if (this.reconciling) return
    this.reconciling = true
    void (async () => {
      while (true) {
        const entry = this.current
        if (entry && entry.target.key !== this.desired?.key) {
          await entry.started
          if (entry.target.key === this.desired?.key) continue
          await this.cancelEntry(entry)
          if (this.current === entry) this.current = null
          if (!entry.unknownStart && !waiting(entry.attempt) && entry.attempt?.status !== 'unknown') {
            this.entries.delete(entry.target.key)
          }
          continue
        }
        if (!entry && this.desired && this.ready) {
          const previous = this.entries.get(this.desired.key)
          const reusable = previous && (previous.registered || previous.unknownStart || waiting(previous.attempt) ||
            previous.attempt?.status === 'unknown' || previous.attempt?.status === 'connected')
          this.current = reusable ? previous : this.create(this.desired)
          this.emit()
        }
        break
      }
    })().finally(() => {
      this.reconciling = false
      if (this.current && this.current.target.key !== this.desired?.key) this.reconcile()
      else if (!this.current && this.desired && this.ready) this.reconcile()
    })
  }

  private cancelEntry(entry: RegistrationEntry, discard = false): Promise<void> {
    if (entry.cancellation) return entry.cancellation
    const original = entry.attempt
    if (!original || (!waiting(original) && !(discard && original.status === 'unknown'))) return Promise.resolve()
    entry.sequence++
    entry.cancelling = true
    entry.issue = ''
    this.emit()
    entry.cancellation = Promise.resolve().then(async () => {
      try {
        const result = await (discard ? entry.target.discard : entry.target.cancel)(original.id)
        if (result.ok && result.data.id === original.id) {
          entry.attempt = result.data
          entry.linkBlocked = false
        } else {
          entry.linkBlocked = true
          entry.issue = result.ok ? '返回的授权与原会话不一致。' : result.error
        }
      } catch {
        entry.linkBlocked = true
        entry.issue = '暂时无法确认授权已取消。'
      } finally {
        entry.cancelling = false
        entry.cancellation = null
        this.emit()
      }
    })
    return entry.cancellation
  }

  cancel(discard = false): void {
    const entry = this.current
    if (!entry || entry.target.key !== this.desired?.key || entry.cancelling) return
    if (entry.starting) {
      entry.cancelling = true
      this.emit()
    }
    void (async () => {
      if (entry.starting) await entry.started
      await this.cancelEntry(entry, discard)
      if (!entry.cancellation && entry.cancelling) {
        entry.cancelling = false
        this.emit()
      }
    })()
  }

  async check(): Promise<void> {
    const entry = this.current
    const original = entry?.attempt
    if (!entry || entry.target.key !== this.desired?.key || !original || entry.reading || entry.cancelling) return
    const sequence = entry.sequence
    entry.reading = true
    entry.issue = ''
    this.emit()
    try {
      const result = await entry.target.read(original.id)
      if (entry.sequence !== sequence) return
      if (result.ok && result.data.id === original.id) {
        entry.attempt = result.data
        entry.linkBlocked = false
      } else {
        if (result.ok || result.code === 'E_DENIED' || result.code === 'E_CONFLICT') entry.linkBlocked = true
        entry.issue = result.ok ? '返回的授权与原会话不一致。' : result.error
      }
    } catch {
      if (entry.sequence === sequence) entry.issue = '暂时无法读取原授权状态。'
    } finally {
      entry.reading = false
      this.emit()
    }
  }

  resume(): void {
    const entry = this.current
    if (!entry || entry.target.key !== this.desired?.key || !this.recoveryReady ||
      !entry.unknownStart || entry.starting || entry.reading || entry.cancelling) return
    entry.starting = true
    entry.issue = ''
    this.emit()
    entry.started = Promise.resolve().then(async () => {
      const inspect = async (): Promise<boolean | null> => {
        const result = await entry.target.isConnected()
        if (!result.ok) { entry.issue = result.error; return null }
        if (result.data) {
          if (this.current !== entry || this.desired?.key !== entry.target.key || !this.recoveryReady) return null
          entry.registered = true
          entry.unknownStart = false
          entry.issue = ''
          return true
        }
        return false
      }
      try {
        const connected = await inspect()
        if (connected !== false || this.current !== entry || this.desired?.key !== entry.target.key || !this.recoveryReady) return
        if (!this.beginAvailable) { entry.issue = '请刷新连接状态后重试。'; return }
        const result = await entry.target.begin()
        if (result.ok) {
          entry.attempt = result.data
          entry.unknownStart = false
          entry.linkBlocked = false
          entry.issue = ''
        } else if (result.code === 'E_CONFLICT') {
          const found = await inspect()
          if (found === false) entry.issue = result.error
        } else {
          entry.issue = result.error
        }
      } catch {
        entry.issue = '暂时无法恢复原授权，请重试。'
      } finally {
        entry.starting = false
        this.emit()
      }
    })
  }

  retry(): void {
    const entry = this.current
    if (!entry || entry.target.key !== this.desired?.key || !this.ready || entry.starting ||
      entry.cancelling || entry.unknownStart || waiting(entry.attempt) || entry.attempt?.status === 'unknown') return
    this.current = this.create(entry.target)
    this.emit()
  }
}
