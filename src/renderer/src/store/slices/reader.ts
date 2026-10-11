import type { AppSlice, ReaderSlice } from '../types'
import {
  externalChangeDetected,
  readNewVersion,
  rebaseToCurrent,
  sessionOpened
} from '../../reader/reading-session'
import { parseReaderWidthPref, READER_WIDTH_STORAGE_KEY } from '../../reader/reader-prefs'

/**
 * 阅读会话切片（S0 G2）：状态迁移全部委托 reader/reading-session.ts 的纯函数，
 * 本切片不自行推导阶段真值；会话快照只在内存（不写 localStorage——store-conventions §5
 * 的容量边界），仅宽度偏好持久化（tpanel. 前缀，读取 try/catch 给默认）。
 */

function readStoredWidthPref(): ReturnType<typeof parseReaderWidthPref> {
  try {
    return parseReaderWidthPref(localStorage.getItem(READER_WIDTH_STORAGE_KEY))
  } catch {
    return parseReaderWidthPref(null)
  }
}

export const readerSlice: AppSlice<ReaderSlice> = (set) => ({
  readingSessions: {},
  readerWidthPref: readStoredWidthPref(),

  readerOpenSession: (key, firstLoad) => {
    set((s) => ({
      readingSessions: { ...s.readingSessions, [key]: sessionOpened(s.readingSessions[key], firstLoad) }
    }))
  },

  readerCloseSession: (key) => {
    set((s) => {
      if (!(key in s.readingSessions)) return s
      // 会话语义 = closeSession() 的空态；此处直接移除键，即「快照随文档关闭丢弃」
      const next = { ...s.readingSessions }
      delete next[key]
      return { readingSessions: next }
    })
  },

  readerExternalChange: (key, candidate) => {
    set((s) => {
      const cur = s.readingSessions[key]
      if (cur === undefined) return s
      return { readingSessions: { ...s.readingSessions, [key]: externalChangeDetected(cur, candidate) } }
    })
  },

  readerReadNewVersion: (key) => {
    set((s) => {
      const cur = s.readingSessions[key]
      if (cur === undefined) return s
      return { readingSessions: { ...s.readingSessions, [key]: readNewVersion(cur) } }
    })
  },

  readerRebaseToCurrent: (key) => {
    set((s) => {
      const cur = s.readingSessions[key]
      if (cur === undefined) return s
      return { readingSessions: { ...s.readingSessions, [key]: rebaseToCurrent(cur) } }
    })
  },

  setReaderWidthPref: (pref) => {
    try {
      localStorage.setItem(READER_WIDTH_STORAGE_KEY, String(pref))
    } catch {
      /* 存储不可用时仍生效于当前会话 */
    }
    set({ readerWidthPref: pref })
  }
})
