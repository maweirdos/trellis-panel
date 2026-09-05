import type { TrellisApi } from '../../shared/types'

declare global {
  interface Window {
    trellis: TrellisApi
  }
}

export const api: TrellisApi = window.trellis
