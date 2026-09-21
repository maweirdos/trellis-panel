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
  showMain(): void
  createMain(): void
  capsule: CapsuleApi
}
