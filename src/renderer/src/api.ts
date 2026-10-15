import type { TrellisApi } from '../../shared/types'

declare global {
  interface Window {
    trellis: TrellisApi
  }
}

export const api: TrellisApi = window.trellis

/** 是否存在 IPC 桥:浏览器 ?my=1 预览下为 false,页面据此降级为无桥空态（不发起调用） */
export const hasIpc = Boolean(window.trellis)
