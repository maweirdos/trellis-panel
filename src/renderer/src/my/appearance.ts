/** Application appearance, shared by Settings and every renderer window. */
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
