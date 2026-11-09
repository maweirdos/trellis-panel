import { useEffect, useRef, useState, type JSX } from 'react'
import { Check, ExternalLink, LoaderCircle } from 'lucide-react'
import { connectionAuthentication, type AuthenticationMethod, type IntegrationConnection, type ProviderManifest } from '../../../../../shared/integrations'
import { api, hasIpc } from '../../../api'
import { useInteractionSignal } from '../../../utils/interaction-scope'
import { Button } from '../../ui'
import { useIntegrationOwner } from './hooks'

function supportsAuthorization(): boolean {
  return hasIpc && typeof api.integrations?.authorize === 'function' && typeof api.integrations?.cancelAuthorization === 'function'
}

export function OAuthSetup({ provider, method, baseUrl, redirectUri }: { provider: ProviderManifest; method: AuthenticationMethod; baseUrl: string; redirectUri?: string }): JSX.Element | null {
  const oauth = method.oauth
  if (!oauth) return null
  const jira = provider.id === 'jira'
  let registrationUrl = ''
  try {
    const base = new URL(baseUrl)
    if ((jira ? base.protocol === 'https:' : ['http:', 'https:'].includes(base.protocol)) && !base.username && !base.password && !base.search && !base.hash) registrationUrl = `${base.href.replace(/\/+$/, '')}${oauth.registrationPath}`
  } catch { /* Instance address is validated on save. */ }
  const callback = jira ? redirectUri?.trim() : oauth.redirectUri
  return <details className="integration-disclosure text-my-xs text-my-secondary"><summary>OAuth 应用设置</summary><div className="mt-3 space-y-2">
    {jira ? <>
      <p>在 Jira 创建传入链接，使用 OAuth 2.0 保密客户端，填写 Client ID 和 Client Secret。权限：{oauth.scopes.join('、')}。</p>
      <p>Jira 实例与回调均须使用 HTTPS。先配对团队服务，再将其地址加上 <code>/auth/jira/callback</code>，填写为回调地址，并在 Jira 中登记相同值。</p>
    </> : <>
      <p>在 {provider.name} 注册 Trellis Panel，填写 Application ID。</p>
      <p>取消勾选 Confidential（保密），只勾选权限：{oauth.scopes.join('、')}。</p>
    </>}
    {callback && <><p>Redirect URI（需与应用中登记值完全一致）：</p><code className="block select-text break-all">{callback}</code></>}
    <Button size="sm" disabled={!hasIpc || !registrationUrl} onClick={() => void api.openExternal(registrationUrl)}>打开 {provider.name} 应用设置 <ExternalLink size={12} aria-hidden="true" /></Button>
    <p>保存后可通过浏览器登录并授权。</p>
  </div></details>
}

interface AuthorizationAttempt { id: string; owner: () => boolean }
interface AuthorizationState { owner: () => boolean; phase: 'idle' | 'pending' | 'cancelling' | 'authorized'; error: string }

export function ConnectionAuthorization({ provider, connection, available, onSaved }: { provider: ProviderManifest; connection: IntegrationConnection; available: boolean; onSaved: () => Promise<void> }): JSX.Element | null {
  const { current } = useIntegrationOwner(JSON.stringify([provider.id, connection.id, connection.revision]))
  const request = useRef<AuthorizationAttempt | null>(null)
  const [state, setState] = useState<AuthorizationState>({ owner: current, phase: 'idle', error: '' })
  const signal = useInteractionSignal()
  const method = connectionAuthentication(provider, connection.config)
  const supported = available && supportsAuthorization()
  const active = state.owner === current && current() ? state : { phase: 'idle' as const, error: '' }
  const busy = active.phase === 'pending' || active.phase === 'cancelling'
  const granted = connection.hasSecrets.includes('oauthTokens') || active.phase === 'authorized'
  useEffect(() => {
    const abandon = (): void => {
      const attempt = request.current
      if (!attempt || attempt.owner !== current) return
      request.current = null
      if (supportsAuthorization()) void api.integrations.cancelAuthorization(attempt.id).catch(() => undefined)
    }
    if (signal?.aborted || !supported) {
      abandon()
      setState({ owner: current, phase: 'idle', error: '' })
    }
    signal?.addEventListener('abort', abandon, { once: true })
    return () => { signal?.removeEventListener('abort', abandon); abandon() }
  }, [current, signal, supported])
  if (connection.legacy || !method?.oauth) return null
  const owns = (attempt: AuthorizationAttempt): boolean => request.current === attempt && attempt.owner === current && current()
  const authorize = async (): Promise<void> => {
    if (!supported || !current() || request.current) return
    const attempt: AuthorizationAttempt = { id: crypto.randomUUID(), owner: current }
    request.current = attempt
    setState({ owner: current, phase: 'pending', error: '' })
    try {
      const result = await api.integrations.authorize({ connectionId: connection.id, connectionRevision: connection.revision, requestId: attempt.id })
      if (!owns(attempt)) return
      if (!result.ok) { setState({ owner: current, phase: 'idle', error: result.error }); return }
      if (result.data.id !== connection.id || result.data.providerId !== provider.id || result.data.revision <= connection.revision) {
        setState({ owner: current, phase: 'idle', error: '授权返回的连接已变化，请刷新后核实结果。' }); return
      }
      setState({ owner: current, phase: 'authorized', error: '' })
      try { await onSaved() } catch { if (owns(attempt)) setState({ owner: current, phase: 'authorized', error: '授权已保存，连接状态刷新失败，请重新打开此页面。' }) }
    } catch {
      if (owns(attempt)) setState({ owner: current, phase: 'idle', error: '未能确认授权结果，请刷新连接后重试。' })
    } finally { if (request.current === attempt) request.current = null }
  }
  const cancel = async (): Promise<void> => {
    const attempt = request.current
    if (!attempt || !owns(attempt) || active.phase === 'cancelling') return
    setState({ owner: current, phase: 'cancelling', error: '' })
    try {
      const result = await api.integrations.cancelAuthorization(attempt.id)
      if (owns(attempt) && !result.ok) setState({ owner: current, phase: 'pending', error: result.error })
    } catch {
      if (owns(attempt)) setState({ owner: current, phase: 'pending', error: '未能确认取消，请重试取消或等待授权结果。' })
    }
  }
  const status = active.phase === 'cancelling' ? '正在取消授权…' : busy ? '请在浏览器完成授权，最多等待 5 分钟。' : granted ? '已保存浏览器授权' : '尚未授权'
  return <section className="space-y-3 border-t border-my-line pt-3">
    {!supported && <p role="status" className="my-item-description">浏览器授权暂不可用，请完整退出并重新打开桌面应用。</p>}
    <p role="status" className="flex items-center gap-2 text-my-xs text-my-secondary">{busy ? <LoaderCircle size={14} className="shrink-0 animate-spin" aria-hidden="true" /> : granted ? <Check size={14} className="shrink-0" aria-hidden="true" /> : null}{status}</p>
    {!granted && <p className="my-item-description">{provider.id === 'jira' ? '授权后可查询、评论及流转 Jira 工单。' : `授权将允许读取 ${provider.name} 用户信息与 API 数据。`}</p>}
    <div className="flex flex-wrap gap-2"><Button size="sm" variant="primary" disabled={!supported || !connection.enabled || busy} onClick={() => void authorize()}>{busy ? '等待浏览器授权…' : active.error ? '重试浏览器授权' : granted ? '重新授权登录' : '浏览器授权登录'} <ExternalLink size={12} aria-hidden="true" /></Button>{busy && <Button size="sm" disabled={active.phase === 'cancelling'} onClick={() => void cancel()}>{active.phase === 'cancelling' ? '取消中…' : '取消授权'}</Button>}</div>
    {active.error && <p role="alert" className="break-words text-my-xs text-my-danger-text">{active.error}</p>}
  </section>
}
