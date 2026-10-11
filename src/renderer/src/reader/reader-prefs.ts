/**
 * 阅读宽度偏好（S0 G2，design §6.3）：680/760/880 max-width 三档，
 * 持久化到本地设置（localStorage，tpanel. 前缀，读取 try/catch 给默认——store-conventions §5）。
 * 阅读会话快照本身只在内存（reading-session.ts），本文件只承载 UI 偏好。
 */

export const READER_WIDTH_PREFS = [680, 760, 880] as const

export type ReaderWidthPref = (typeof READER_WIDTH_PREFS)[number]

export const DEFAULT_READER_WIDTH_PREF: ReaderWidthPref = 760

export const READER_WIDTH_STORAGE_KEY = 'tpanel.reader-width'

export function isReaderWidthPref(v: unknown): v is ReaderWidthPref {
  return typeof v === 'number' && (READER_WIDTH_PREFS as readonly number[]).includes(v)
}

/** 解析 localStorage 值；非法/缺失回默认档。 */
export function parseReaderWidthPref(stored: string | null): ReaderWidthPref {
  if (stored === null) return DEFAULT_READER_WIDTH_PREF
  const n = Number.parseInt(stored, 10)
  return isReaderWidthPref(n) ? n : DEFAULT_READER_WIDTH_PREF
}
