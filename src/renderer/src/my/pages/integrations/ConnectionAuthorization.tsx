import { useId, useState, type JSX, type ReactNode } from 'react'
import { Check, ChevronRight, Copy, ExternalLink, LoaderCircle } from 'lucide-react'
import { JIRA_OAUTH_REDIRECT_URI, connectionAuthentication, type AuthenticationMethod, type IntegrationConnection, type ProviderManifest } from '../../../../../shared/integrations'
import { api, hasIpc } from '../../../api'
import { Button, DisclosureGrid } from '../../ui'
import { useConnectionBinding } from './useConnectionBinding'

function IntegrationDisclosure({ label, className = '', children }: { label: string; className?: string; children: ReactNode }): JSX.Element {
  const [open, setOpen] = useState(false)
  return <div className={`integration-disclosure ${className}`.trim()}>
    <button type="button" className="inline-flex items-center gap-1 text-left transition-colors hover:text-my-primary" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
      <ChevronRight size={12} className={`shrink-0 transition-transform duration-150 ${open ? 'rotate-90' : ''}`} />
      <span>{label}</span>
    </button>
    <DisclosureGrid open={open}>{children}</DisclosureGrid>
  </div>
}

function supportsAuthorization(): boolean {
  return hasIpc && typeof api.integrations?.authorize === 'function' && typeof api.integrations?.cancelAuthorization === 'function'
}

export function OAuthSetup({ provider, method, baseUrl, redirectUri, onUseLocalCallback }: {
  provider: ProviderManifest; method: AuthenticationMethod; baseUrl: string; redirectUri?: string; onUseLocalCallback?: () => void
}): JSX.Element | null {
  const id = useId()
  const [copyStatus, setCopyStatus] = useState('')
  const [usingLocal, setUsingLocal] = useState(false)
  const oauth = method.oauth
  if (!oauth) return null
  const jira = provider.id === 'jira'
  let registrationUrl = ''
  let httpBase = false
  try {
    const base = new URL(baseUrl.trim())
    if (['http:', 'https:'].includes(base.protocol) && !base.username && !base.password && !base.search && !base.hash) {
      registrationUrl = base.href.replace(/\/+$/, '') + oauth.registrationPath
      httpBase = base.protocol === 'http:'
    }
  } catch { /* Instance address is validated by native save. */ }
  const callback = jira ? redirectUri?.trim() || JIRA_OAUTH_REDIRECT_URI : oauth.redirectUri
  const httpCallback = callback.startsWith('http:')
  const relay = jira && callback !== JIRA_OAUTH_REDIRECT_URI
  const copy = async (): Promise<void> => {
    try { await api.copyToClipboard(callback); setCopyStatus('回调地址已复制') }
    catch { setCopyStatus('未能复制，请选择回调地址后手动复制。') }
  }
  return <IntegrationDisclosure label={jira ? '应用登记' : 'OAuth 应用设置'} className="text-my-xs text-my-secondary"><div className="mt-3 space-y-3">
    {jira ? <p>在 Jira 创建传入链接，选择 OAuth 2.0 保密客户端。登记 Client ID、Client Secret 与权限：{oauth.scopes.join('、')}。</p> : <>
      <p>在 {provider.name} 注册 Crux，填写 Application ID。</p>
      <p>取消勾选 Confidential（保密），只勾选权限：{oauth.scopes.join('、')}。</p>
    </>}
    <div className="space-y-2"><label htmlFor={id + '-callback'} className="my-item-title block">回调地址</label><div className="flex items-center gap-2"><input id={id + '-callback'} className="my-input min-w-0 flex-1" readOnly value={callback} spellCheck={false} /><Button variant="ghost" size="sm" aria-label="复制回调地址" disabled={!hasIpc} onClick={() => void copy()}><Copy size={14} aria-hidden="true" /></Button></div><p>需与 {provider.name} 应用登记值完全一致。</p></div>
    {relay && onUseLocalCallback && <div className="space-y-2"><p>当前保留已有团队回调。切换后需更新 Jira 应用登记并重新授权。</p><Button size="sm" onClick={() => { onUseLocalCallback(); setUsingLocal(true); setCopyStatus('') }}>改用本机回调</Button></div>}
    {usingLocal && !relay && <p role="status">本机回调已写入草稿。请更新 Jira 应用登记后重新授权。</p>}
    {jira && (httpBase || httpCallback) && <div className="space-y-2"><p>Jira 管理员需按实际使用的地址设置以下系统属性：</p>{httpBase && <p>实例使用 HTTP：<code className="block select-text break-all">atlassian.oauth2.provider.skip.base.url.https.requirement=true</code></p>}{httpCallback && <p>回调使用 HTTP：<code className="block select-text break-all">atlassian.oauth2.provider.skip.redirect.url.https.requirement=true</code></p>}</div>}
    <Button size="sm" disabled={!hasIpc || !registrationUrl} onClick={() => void api.openExternal(registrationUrl)}>打开 {provider.name} 应用设置 <ExternalLink size={12} aria-hidden="true" /></Button>
    {copyStatus && <p role="status" aria-live="polite">{copyStatus}</p>}
  </div></IntegrationDisclosure>
}

export function ConnectionAuthorization({ provider, connection, connections, available, onSaved }: {
  provider: ProviderManifest; connection: IntegrationConnection; connections?: readonly IntegrationConnection[]; available: boolean; onSaved: () => Promise<void>
}): JSX.Element | null {
  const supported = available && supportsAuthorization()
  const binding = useConnectionBinding({ provider, connection, connections, authorizationAvailable: supported, followChanges: true })
  const method = connectionAuthentication(provider, connection.config)
  if (connection.legacy || !method?.oauth) return null
  const { state, busy } = binding
  const value = binding.saved ?? connection
  const granted = value.check === 'authenticated' && value.hasSecrets.includes('oauthTokens')
  const status = state.phase === 'cancelling' ? '正在取消授权…' : state.phase === 'authorizing' ? '请在浏览器完成授权，最多等待 5 分钟。' : state.phase === 'refreshing' ? '正在刷新连接…' : granted ? value.detail || '身份已验证并保存' : '尚未授权'
  const refreshFailed = state.phase === 'complete' && Boolean(state.error)
  return <section className="space-y-3 border-t border-my-line pt-3">
    {!supported && <p role="status" className="my-item-description">浏览器授权暂不可用，请完整退出并重新打开桌面应用。</p>}
    <p role="status" aria-live="polite" aria-atomic="true" className="flex items-start gap-2 break-words text-my-xs text-my-secondary">{busy ? <LoaderCircle size={14} className="mt-0.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : granted ? <Check size={14} className="mt-0.5 shrink-0" aria-hidden="true" /> : null}{status}</p>
    <div className="flex flex-wrap gap-2">{refreshFailed ? <Button size="sm" onClick={() => void binding.refresh(onSaved)}>刷新连接</Button> : state.phase === 'uncertain' ? <Button size="sm" onClick={() => void binding.reconcile(onSaved)}>读取连接并核实</Button> : <Button size="sm" variant="primary" disabled={!supported || !connection.enabled || busy || state.phase === 'stale'} onClick={() => void binding.run('authorize', undefined, onSaved)}>{busy ? '等待浏览器授权…' : state.error ? '重试浏览器授权' : granted ? '重新授权登录' : '浏览器授权登录'} <ExternalLink size={12} aria-hidden="true" /></Button>}{(state.phase === 'authorizing' || state.phase === 'cancelling') && <Button size="sm" disabled={state.phase === 'cancelling'} onClick={() => void binding.cancel()}>{state.phase === 'cancelling' ? '取消中…' : '取消授权'}</Button>}</div>
    {state.phase === 'uncertain' && state.candidates?.map((item) => <Button key={item.id} size="sm" onClick={() => binding.resume(item)}>继续使用 {item.name}</Button>)}
    {state.error && <div role="alert" className="break-words text-my-xs text-my-danger-text">{state.error.length > 180 || state.error.includes('\n') ? <><p>授权未完成，请查看详情后重试。</p><IntegrationDisclosure label="错误详情" className="mt-2"><p className="mt-2 whitespace-pre-wrap break-words">{state.error}</p></IntegrationDisclosure></> : <p>{state.error}</p>}</div>}
  </section>
}
