/** Application appearance, shared by Settings and every renderer window. */
export const UI_PREFERENCES_KEY = 'tpanel.my.ui'

export const DEFAULT_SIDEBAR_WIDTH = 260
export const MIN_SIDEBAR_WIDTH = 220
export const MAX_SIDEBAR_WIDTH = 400

export function normalizeSidebarWidth(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, value)))
    : DEFAULT_SIDEBAR_WIDTH
}

export type UiFontSize = 'small' | 'standard' | 'large'

export const UI_FONT_SIZE_OPTIONS: ReadonlyArray<{ value: UiFontSize; label: string; description: string }> = [
  { value: 'small', label: '小', description: '紧凑，默认字号' },
  { value: 'standard', label: '标准', description: '适中的文字与间距' },
  { value: 'large', label: '大', description: '更大的文字与阅读间距' }
]

export function normalizeUiFontSize(value: unknown): UiFontSize {
  return value === 'standard' || value === 'large' ? value : 'small'
}
