/** 域模块的窗口能力注入：窗口创建/托盘仍归 index.ts，域模块只经此接口触碰窗口 */
import type { BrowserWindow } from 'electron'

export interface CapsuleApi {
  onTop(): boolean
  setOnTop(on: boolean): void
  shape(): 'pill' | 'card'
  setShape(shape: 'pill' | 'card'): void
  create(initialShape?: 'pill' | 'card'): void
}

export interface WindowDeps {
  getMain(): BrowserWindow | null
  getCapsule(): BrowserWindow | null
  /** 全局热键呼出的速记窗（只隐藏不销毁，创建归 index.ts 的 toggleQuickTodo） */
  getQuickTodo(): BrowserWindow | null
  showMain(): void
  createMain(): void
  /** 截取主窗口当前画面为 PNG dataURL（截图问 AI，TPD-022） */
  captureMain(): Promise<string | null>
  capsule: CapsuleApi
}
