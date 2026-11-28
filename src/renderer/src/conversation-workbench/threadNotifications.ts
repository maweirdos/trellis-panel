import { useSyncExternalStore } from 'react'

export const NOTIFICATION_SETTINGS_KEY = 'crux.conversation.notifications.v1'

export interface ThreadNotificationSettings {
  readonly soundEnabled: boolean
  readonly desktopEnabled: boolean
}

const DEFAULT_SETTINGS: ThreadNotificationSettings = {
  soundEnabled: true,
  desktopEnabled: true,
}

let cachedSettings: ThreadNotificationSettings | null = null
const listeners = new Set<() => void>()
const notifiedKeys = new Map<string, number>()
let sharedAudioContext: AudioContext | null = null

function readSettings(): ThreadNotificationSettings {
  if (cachedSettings) return cachedSettings
  if (typeof window === 'undefined') return DEFAULT_SETTINGS
  try {
    const raw = window.localStorage.getItem(NOTIFICATION_SETTINGS_KEY)
    if (!raw) {
      cachedSettings = DEFAULT_SETTINGS
      return cachedSettings
    }
    const parsed = JSON.parse(raw) as Partial<ThreadNotificationSettings> | null
    cachedSettings = {
      soundEnabled: typeof parsed?.soundEnabled === 'boolean' ? parsed.soundEnabled : true,
      desktopEnabled: typeof parsed?.desktopEnabled === 'boolean' ? parsed.desktopEnabled : true,
    }
    return cachedSettings
  } catch {
    cachedSettings = DEFAULT_SETTINGS
    return cachedSettings
  }
}

export function getThreadNotificationSettings(): ThreadNotificationSettings {
  return readSettings()
}

export function updateThreadNotificationSettings(patch: Partial<ThreadNotificationSettings>): ThreadNotificationSettings {
  const next: ThreadNotificationSettings = { ...readSettings(), ...patch }
  cachedSettings = next
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(NOTIFICATION_SETTINGS_KEY, JSON.stringify(next))
    } catch { /* ignore quota */ }
    if (patch.desktopEnabled && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      void Notification.requestPermission().catch(() => undefined)
    }
  }
  for (const listener of listeners) listener()
  return next
}

function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useThreadNotificationSettings(): ThreadNotificationSettings {
  return useSyncExternalStore(subscribeSettings, getThreadNotificationSettings, () => DEFAULT_SETTINGS)
}

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  try {
    if (!sharedAudioContext || sharedAudioContext.state === 'closed') {
      sharedAudioContext = new Ctor()
    }
    if (sharedAudioContext.state === 'suspended') {
      void sharedAudioContext.resume().catch(() => undefined)
    }
    return sharedAudioContext
  } catch {
    return null
  }
}

function scheduleSoftTone(
  ctx: AudioContext,
  frequency: number,
  startOffsetSec: number,
  durationSec: number,
  peakGain: number,
): void {
  const now = ctx.currentTime + startOffsetSec
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(frequency, now)
  gain.gain.setValueAtTime(0.0001, now)
  gain.gain.exponentialRampToValueAtTime(peakGain, now + 0.018)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + durationSec)
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start(now)
  osc.stop(now + durationSec + 0.02)
}

/** 柔和双音完成提示（C5 -> G5），不刺耳、无外部音频文件依赖。 */
export function playCompletionChime(): boolean {
  const ctx = getAudioContext()
  if (!ctx) return false
  try {
    scheduleSoftTone(ctx, 523.25, 0, 0.16, 0.06)
    scheduleSoftTone(ctx, 783.99, 0.09, 0.24, 0.055)
    return true
  } catch {
    return false
  }
}

/** 清晰双脉冲待确认提示（E5 -> E5），用于审批拦截、提问或出错需要人工介入。 */
export function playAttentionChime(): boolean {
  const ctx = getAudioContext()
  if (!ctx) return false
  try {
    scheduleSoftTone(ctx, 659.25, 0, 0.14, 0.07)
    scheduleSoftTone(ctx, 659.25, 0.16, 0.18, 0.065)
    return true
  } catch {
    return false
  }
}

export type ThreadNotificationKind = 'completed' | 'failed' | 'approval' | 'user-input'

export function shouldTriggerBackgroundNotice(input?: {
  readonly documentHidden?: boolean
  readonly windowFocused?: boolean
}): boolean {
  const hidden = input?.documentHidden ?? (typeof document !== 'undefined' ? document.hidden : false)
  const focused = input?.windowFocused ?? (typeof document !== 'undefined' && typeof document.hasFocus === 'function' ? document.hasFocus() : true)
  return hidden || !focused
}

export function notifyThreadEvent(input: {
  readonly eventKey: string
  readonly kind: ThreadNotificationKind
  readonly threadTitle: string
  readonly body?: string
  readonly force?: boolean
}): boolean {
  const settings = readSettings()
  if (!settings.soundEnabled && !settings.desktopEnabled) return false
  if (!input.force && !shouldTriggerBackgroundNotice()) return false

  const now = Date.now()
  const prev = notifiedKeys.get(input.eventKey)
  if (prev !== undefined && now - prev < 30_000) return false
  notifiedKeys.set(input.eventKey, now)
  if (notifiedKeys.size > 128) {
    for (const [k, ts] of notifiedKeys) {
      if (now - ts > 60_000) notifiedKeys.delete(k)
    }
  }

  let delivered = false
  if (settings.soundEnabled) {
    const played = input.kind === 'completed' ? playCompletionChime() : playAttentionChime()
    delivered = delivered || played
  }

  if (settings.desktopEnabled && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    const titlePrefix = input.kind === 'completed'
      ? '对话已完成'
      : input.kind === 'approval'
        ? '等待操作审批'
        : input.kind === 'user-input'
          ? '模型需要你的答复'
          : '对话执行异常'
    try {
      const notice = new Notification(`${titlePrefix} · ${input.threadTitle}`, {
        body: input.body ?? '点击回到 Crux 查看进展。',
        silent: settings.soundEnabled,
      })
      notice.onclick = () => {
        try { window.focus() } catch { /* ignore */ }
      }
      delivered = true
    } catch {
      // 某些受限系统环境不支持桌面 Notification，静默降级
    }
  }

  return delivered
}
