import { create } from 'zustand'
import type { AppState } from './types'
import { sessionSlice } from './slices/session'
import { uiSlice } from './slices/ui'
import { toastSlice } from './slices/toast'
import { viewerSlice } from './slices/viewer'
import { todosSlice } from './slices/todos'
import { inboxSlice } from './slices/inbox'
import { chatSlice } from './slices/chat'

/**
 * 组合根（TPD-006）：六个域切片按 zustand slice 模式组装。
 * 对外导出 useApp 与全部公共类型/助手 —— 页面 import 路径保持 '../store' 不变。
 */
export const useApp = create<AppState>()((set, get, store) => ({
  ...sessionSlice(set, get, store),
  ...uiSlice(set, get, store),
  ...toastSlice(set, get, store),
  ...viewerSlice(set, get, store),
  ...todosSlice(set, get, store),
  ...inboxSlice(set, get, store),
  ...chatSlice(set, get, store)
}))

export { reconcileInbox, loadInbox, saveInbox } from './inbox-storage'
export { normalizeSettings } from './slices/session'
export type { Page, ToastItem, ViewerTab, InboxState, InboxEntry, AppState } from './types'
