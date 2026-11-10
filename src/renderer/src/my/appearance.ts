/** Application appearance, shared by Settings and every renderer window. */
import type { BootstrapApi } from '@shared/bootstrap'

export const UI_PREFERENCES_KEY = 'tpanel.my.ui'

export const DEFAULT_SIDEBAR_WIDTH = 240
export const MIN_SIDEBAR_WIDTH = 220
export const MAX_SIDEBAR_WIDTH = 400

export function normalizeSidebarWidth(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, value)))
    : DEFAULT_SIDEBAR_WIDTH
}

export type UiFontSize = 'small' | 'standard' | 'large'
export type UiFontFamily = 'default' | 'system'
export type CodeFontFamily = 'default' | 'cascadia' | 'consolas'
export type CodeFontSize = 'small' | 'standard' | 'large'

export function normalizeUiFontFamily(value: unknown): UiFontFamily {
  return value === 'system' ? 'system' : 'default'
}

export function normalizeCodeFontFamily(value: unknown): CodeFontFamily {
  return value === 'cascadia' || value === 'consolas' ? value : 'default'
}

export function normalizeCodeFontSize(value: unknown): CodeFontSize {
  return value === 'small' || value === 'large' ? value : 'standard'
}

export const UI_DENSITY_OPTIONS: ReadonlyArray<{ value: UiFontSize; label: string; description: string; sidebarWidth: number }> = [
  { value: 'small', label: '紧凑', description: '较小的字号、间距和控件', sidebarWidth: 224 },
  { value: 'standard', label: '标准', description: '适中的字号、间距和控件', sidebarWidth: DEFAULT_SIDEBAR_WIDTH },
  { value: 'large', label: '舒适', description: '比标准稍宽松的字号、间距和控件', sidebarWidth: 256 }
]

export function normalizeUiFontSize(value: unknown): UiFontSize {
  return value === 'small' || value === 'large' ? value : 'standard'
}

/** Missing/unreadable legacy storage cannot overwrite an existing native snapshot
 * with a guessed default. Only an observed value or an explicit choice is sent. */
export function syncNativeUiFontSize(bridge: Pick<BootstrapApi, 'appearance'> | undefined, selected?: UiFontSize): void {
  if (!bridge?.appearance) return
  let fontSize = selected
  if (fontSize === undefined) {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(UI_PREFERENCES_KEY) ?? '{}')
      const value = stored && typeof stored === 'object' && 'fontSize' in stored ? stored.fontSize : undefined
      if (value !== 'small' && value !== 'standard' && value !== 'large') return
      fontSize = value
    } catch { return }
  }
  void bridge.appearance({ fontSize }).then(result => {
    if (!result.ok) console.warn('维护窗口的界面密度快照未能保存。')
  }).catch(() => { console.warn('维护窗口的界面密度快照暂不可用。') })
}
