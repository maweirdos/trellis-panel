// 全局交互动效原语：进退场生命周期、路由空间方向与窗口过渡编排。
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Page } from '../store'
import { activeModule, type ModuleId } from './navigation'

export const MOTION_EXIT_MS = 115
export const MOTION_PAGE_CROSSFADE_MS = 135
export const MOTION_POP_EXIT_MS = 110
export const MOTION_TOOLTIP_EXIT_MS = 95
export const MOTION_TOAST_EXIT_MS = 180
export const MOTION_WINDOW_LEAVE_MS = 110
export const MOTION_WINDOW_SETTLE_MS = 175

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export type PresenceState = 'open' | 'closing'

/**
 * 轻量双态进退场钩子：打开立即挂载，关闭时保持可见极短退场时长后再卸载；
 * 退场期间若再次打开立即中断退场并接续，减少动态效果模式下零延迟直接卸载。
 */
export function usePresence(open: boolean, exitDurationMs = MOTION_EXIT_MS): {
  mounted: boolean
  state: PresenceState
} {
  const [mounted, setMounted] = useState(open)
  const [state, setState] = useState<PresenceState>('open')
  const timerRef = useRef<number | null>(null)

  useLayoutEffect(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (open) {
      setMounted(true)
      setState('open')
      return
    }
    if (!mounted) return
    if (exitDurationMs <= 0 || prefersReducedMotion()) {
      setMounted(false)
      setState('open')
      return
    }
    setState('closing')
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      setMounted(false)
      setState('open')
    }, exitDurationMs)
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [open, mounted, exitDurationMs])

  return { mounted, state }
}

/** 左侧模块栏从上到下的视觉顺序，用于为一级切换提供空间方向感知。 */
const RAIL_ORDER: ReadonlyArray<ModuleId> = [
  'team',
  'agents',
  'knowledge',
  'machines',
  'integrations',
  'settings'
]

export function railModuleForPage(page: Page): ModuleId {
  const domain = activeModule(page)
  if (page === 'creations') return 'knowledge'
  if (domain === 'home') return 'team'
  if (domain === 'automations') return 'team'
  return domain
}

export type PageTransitionDirection = 'down' | 'up' | 'crossfade' | 'none'

export function getPageTransitionDirection(fromPage: Page | null, toPage: Page): PageTransitionDirection {
  if (!fromPage || fromPage === toPage) return 'none'
  const fromRail = railModuleForPage(fromPage)
  const toRail = railModuleForPage(toPage)
  if (fromRail === toRail) return 'crossfade'
  const fromIndex = RAIL_ORDER.indexOf(fromRail)
  const toIndex = RAIL_ORDER.indexOf(toRail)
  if (fromIndex === -1 || toIndex === -1) return 'crossfade'
  return toIndex > fromIndex ? 'down' : 'up'
}

/* ---------------- 窗口级动效编排（最小化 / 最大化 / 还原 / 聚焦） ---------------- */

export type WindowMotionPhase = 'idle' | 'minimizing' | 'closing' | 'maximizing' | 'unmaximizing'

interface WindowMotionSnapshot {
  maximized: boolean
  focused: boolean
  phase: WindowMotionPhase
}

let windowMotion: WindowMotionSnapshot = {
  maximized: false,
  focused: typeof document === 'undefined' ? true : document.hasFocus(),
  phase: 'idle'
}
const windowMotionListeners = new Set<() => void>()
let phaseResetTimer: number | null = null
let leaveActionTimer: number | null = null

function emitWindowMotion(): void {
  for (const listener of windowMotionListeners) listener()
}

function setWindowMotion(patch: Partial<WindowMotionSnapshot>): void {
  windowMotion = { ...windowMotion, ...patch }
  emitWindowMotion()
}

function schedulePhaseReset(ms: number): void {
  if (phaseResetTimer !== null) window.clearTimeout(phaseResetTimer)
  phaseResetTimer = window.setTimeout(() => {
    phaseResetTimer = null
    if (windowMotion.phase !== 'idle') setWindowMotion({ phase: 'idle' })
  }, ms)
}

export function setWindowMaximizedState(maximized: boolean, animate = true): void {
  const changed = windowMotion.maximized !== maximized
  if (!changed) return
  if (!animate || prefersReducedMotion()) {
    setWindowMotion({ maximized, phase: 'idle' })
    return
  }
  setWindowMotion({ maximized, phase: maximized ? 'maximizing' : 'unmaximizing' })
  schedulePhaseReset(MOTION_WINDOW_SETTLE_MS)
}

export function setWindowFocusedState(focused: boolean): void {
  if (windowMotion.focused === focused && windowMotion.phase === 'idle') return
  if (focused && (windowMotion.phase === 'minimizing' || windowMotion.phase === 'closing')) {
    if (leaveActionTimer !== null) {
      window.clearTimeout(leaveActionTimer)
      leaveActionTimer = null
    }
    setWindowMotion({ focused: true, phase: 'idle' })
    return
  }
  setWindowMotion({ focused })
}

/**
 * 在调用原生最小化/关闭（隐藏到托盘）前，播放短促收束动效（110ms），
 * 并带自动超时兜底复位，确保绝不阻断或让窗口停在不可见状态。
 */
export function runWindowLeaveMotion(kind: 'minimize' | 'close', action: () => void): void {
  if (leaveActionTimer !== null) {
    window.clearTimeout(leaveActionTimer)
    leaveActionTimer = null
  }
  if (prefersReducedMotion()) {
    action()
    return
  }
  setWindowMotion({ phase: kind === 'minimize' ? 'minimizing' : 'closing' })
  leaveActionTimer = window.setTimeout(() => {
    leaveActionTimer = null
    action()
    // 若系统阻止关闭或仍留在前台，在短暂缓冲后自动复位，防止画面停在隐藏态
    schedulePhaseReset(260)
  }, MOTION_WINDOW_LEAVE_MS)
}

export function useWindowMotionState(): WindowMotionSnapshot {
  const [snapshot, setSnapshot] = useState<WindowMotionSnapshot>(windowMotion)
  useEffect(() => {
    const sync = (): void => setSnapshot(windowMotion)
    windowMotionListeners.add(sync)
    sync()
    return () => { windowMotionListeners.delete(sync) }
  }, [])
  return snapshot
}
