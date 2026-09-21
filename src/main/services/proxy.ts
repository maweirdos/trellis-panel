import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { session } from 'electron'
import { getSettings } from './store'

/**
 * 统一代理（TPD-015）：settings.proxy 一处配置，覆盖全部出网路径——
 * Node 侧 fetch（AI/模型目录）经 undici ProxyAgent dispatcher；
 * Chromium 网络栈（weknora net.fetch）经 session.setProxy。
 * 未启用时所有路径零行为变化。
 */

let cached: { url: string; agent: ProxyAgent } | null = null

export function proxyEnabled(): boolean {
  const p = getSettings().proxy
  return !!(p?.enabled && p.url)
}

/** Node fetch 的 dispatcher；未启用代理返回 undefined（保持直连） */
export function getDispatcher(): ProxyAgent | undefined {
  const p = getSettings().proxy
  if (!p?.enabled || !p.url) return undefined
  if (!cached || cached.url !== p.url) {
    cached = { url: p.url, agent: new ProxyAgent(p.url) }
  }
  return cached.agent
}

/** 同实例 fetch：启用代理时走 undici fetch + dispatcher（跨实例 Protocol 不兼容），否则全局 fetch 直连 */
export function proxiedFetch(url: string, init?: Record<string, unknown>): Promise<Response> {
  const dispatcher = getDispatcher()
  if (!dispatcher) return fetch(url, init as RequestInit)
  return undiciFetch(url, { ...(init ?? {}), dispatcher } as never) as unknown as Promise<Response>
}

/** undici url → Chromium proxyRules：http(s)://host:port → host:port；socks5://host:port → socks5:host:port */
export function chromiumProxyRules(url: string): string {
  const m = /^(https?|socks5):\/\/([^/]+)$/i.exec(url.trim())
  if (!m) return ''
  const scheme = m[1].toLowerCase()
  const host = m[2]
  return scheme === 'socks5' ? `socks5:${host}` : host
}

/** Chromium 网络栈（net.fetch 等）应用代理；boot 与 settings 变更后调用 */
export async function applyChromiumProxy(): Promise<void> {
  try {
    const p = getSettings().proxy
    if (!p?.enabled || !p.url) {
      await session.defaultSession.setProxy({ mode: 'direct' })
      return
    }
    const rules = chromiumProxyRules(p.url)
    if (!rules) return
    await session.defaultSession.setProxy({ mode: 'fixed_servers', proxyRules: rules })
  } catch {
    // 代理应用失败不影响主流程（直连回退）
  }
}
