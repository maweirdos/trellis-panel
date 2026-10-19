import { useCallback, useEffect, useRef, type JSX } from 'react'
import { ExternalLink } from 'lucide-react'
import { connectionAuthentication, type AuthenticationMethod, type IntegrationConnection, type ProviderManifest } from '../../../../../shared/integrations'
import { api, hasIpc } from '../../../api'
import { useInteractionGuard, useInteractionSignal } from '../../../utils/interaction-scope'
import { Button } from '../../ui'
import { useIntegrationAction } from './hooks'

function supportsAuthorization(): boolean {
  return hasIpc && typeof api.integrations?.authorize === 'function' && typeof api.integrations?.cancelAuthorization === 'function'
}

export function OAuthSetup({ provider, method, baseUrl }: { provider: ProviderManifest; method: AuthenticationMethod; baseUrl: string }): JSX.Element | null {
  const oauth = method.oauth
  if (!oauth) return null
  let registrationUrl = ''
  try {
    const base = new URL(baseUrl)
    if (['http:', 'https:'].includes(base.protocol) && !base.username && !base.password && !base.search && !base.hash) registrationUrl = `${base.href.replace(/\/+$/, '')}${oauth.registrationPath}`
  } catch { /* Instance address is validated on save. */ }
  return <div className="space-y-2 rounded-my-md border border-my-line p-3 text-my-xs text-my-secondary">
    <p>首次接入此实例：在 {provider.name} 应用设置中注册一次 Trellis Panel，填写生成的 Application ID。</p>
    <p>取消勾选 Confidential（保密），只勾选权限：{oauth.scopes.join('、')}。</p>
    <p>Redirect URI（回调地址，需完全一致）：</p><code className="block select-text break-all">{oauth.redirectUri}</code>
    <Button size="sm" disabled={!hasIpc || !registrationUrl} onClick={() => void api.openExternal(registrationUrl)}>打开 {provider.name} 应用设置 <ExternalLink size={12} /></Button>
    <p>保存连接后，点击「浏览器授权登录」。账号登录和授权在浏览器完成，应用不读取你的账号密码。</p>
  </div>
}

export function ConnectionAuthorization({ provider, connection, available, onSaved }: { provider: ProviderManifest; connection: IntegrationConnection; available: boolean; onSaved: () => Promise<void> }): JSX.Element | null {
  const action = useIntegrationAction()
  const requestId = useRef<string | null>(null)
  const signal = useInteractionSignal()
  const canInteract = useInteractionGuard()
  const method = connectionAuthentication(provider, connection.config)
  const supported = available && supportsAuthorization()
  const cancel = useCallback((): void => {
    if (requestId.current && supportsAuthorization()) void api.integrations.cancelAuthorization(requestId.current).catch(() => undefined)
  }, [])
  useEffect(() => {
    if (signal?.aborted) cancel()
    signal?.addEventListener('abort', cancel, { once: true })
    return () => { signal?.removeEventListener('abort', cancel); cancel() }
  }, [signal, cancel])
  if (connection.legacy || !method?.oauth) return null
  const authorize = async (): Promise<void> => {
    if (!supported || !canInteract() || requestId.current) return
    const id = crypto.randomUUID()
    requestId.current = id
    try {
      const result = await action.run(() => api.integrations.authorize({ connectionId: connection.id, connectionRevision: connection.revision, requestId: id }))
      if (result && canInteract()) await onSaved()
    } finally { if (requestId.current === id) requestId.current = null }
  }
  return <section className="space-y-2 rounded-my-md border border-my-line p-3">
    <p className="text-my-sm font-medium">浏览器授权</p>
    {!supported && <p role="status" className="text-my-xs text-my-secondary">当前主进程 / preload 尚未加载浏览器授权接口。请完整退出应用后重新运行开发入口；仅页面热更新无法加载新接口。</p>}
    <p role="status" className="text-my-xs text-my-tertiary">{action.busy ? '请在打开的浏览器中完成登录并授权；最长等待 5 分钟。' : connection.hasSecrets.includes('oauthTokens') ? '授权凭证在本机加密保存，过期时自动刷新。需要切换账号时重新授权。' : '连接配置已保存，尚未授权。点击下方按钮在浏览器登录。'}</p>
    <div className="flex flex-wrap gap-2"><Button size="sm" variant="primary" disabled={!supported || !connection.enabled || action.busy} onClick={() => void authorize()}>{connection.hasSecrets.includes('oauthTokens') ? '重新授权登录' : '浏览器授权登录'} <ExternalLink size={12} /></Button>{action.busy && <Button size="sm" onClick={cancel}>取消授权</Button>}</div>
    {action.error && <p role="alert" className="text-my-xs text-my-danger-text">{action.error}</p>}
  </section>
}
