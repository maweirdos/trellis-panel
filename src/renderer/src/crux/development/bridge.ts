import type { CruxWorkApi } from '@shared/crux-work'
import { api } from '../../api'

/** Browser adapters may be proxies; only an explicitly exposed native capability counts. */
export function nativeDevelopmentApi(): CruxWorkApi | null {
  if (!api || !Object.hasOwn(api, 'cruxWork')) return null
  const bridge = api.cruxWork
  return bridge && ['status', 'prepare', 'development', 'change'].every((key) => Object.hasOwn(bridge, key) && typeof bridge[key as keyof CruxWorkApi] === 'function') ? bridge : null
}
