import type { HifoxWorkApi } from '@shared/hifox-work'
import { api } from '../../api'

/** Browser adapters may be proxies; only an explicitly exposed native capability counts. */
export function nativeDevelopmentApi(): HifoxWorkApi | null {
  if (!api || !Object.hasOwn(api, 'hifoxWork')) return null
  const bridge = api.hifoxWork
  return bridge && ['status', 'prepare', 'development', 'change'].every((key) => Object.hasOwn(bridge, key) && typeof bridge[key as keyof HifoxWorkApi] === 'function') ? bridge : null
}
