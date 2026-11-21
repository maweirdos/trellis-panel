import { useId, useState, type JSX } from 'react'
import { Check, LoaderCircle, X } from 'lucide-react'
import { JIRA_OAUTH_REDIRECT_URI, connectionAuthentication, connectionFields, type ConfigField, type IntegrationConnection, type ProviderManifest, type SaveConnectionInput } from '../../../../../shared/integrations'
import { api, hasIpc } from '../../../api'
import { useApp } from '../../../store'
import { Button, Checkbox, Modal } from '../../ui'
import { useIntegrationAction } from './hooks'
import { integrationBridgeMessage, integrationBridgeState } from './bridge'
import { OAuthSetup } from './ConnectionAuthorization'
import { IntegrationProductIcon } from './IntegrationProductIcon'
import { useConnectionBinding } from './useConnectionBinding'

export function jiraConnectionName(baseUrl: string): string {
  try {
    const url = new URL(baseUrl.trim())
    const label = url.host + url.pathname.replace(/\/+$/, '')
    if (label.length <= 100) return label
    let hash = 2166136261
    for (const character of label) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619)
    return label.slice(0, 90) + '…' + (hash >>> 0).toString(16).padStart(8, '0')
  } catch { return 'Jira' }
}

function authConfiguration(config: Record<string, string>): string {
  let base = config.baseUrl?.trim() ?? ''
  try { base = new URL(base).href.replace(/\/+$/, '') } catch { /* Native save validates the instance. */ }
  const method = config.authMethod || 'basic'
  return JSON.stringify([base, method, method === 'basic' ? config.user?.trim() ?? '' : method === 'oauth2' ? [config.clientId?.trim() ?? '', config.redirectUri ?? JIRA_OAUTH_REDIRECT_URI] : null])
}

export interface ConnectionEditorProps {
  provider: ProviderManifest
  connection?: IntegrationConnection
  connections?: readonly IntegrationConnection[]
  authorizationAvailable?: boolean
  onClose: () => void
  onSaved: (connection?: IntegrationConnection) => Promise<void>
}

export function ConnectionEditor({ provider, connection, connections, authorizationAvailable = false, onClose, onSaved }: ConnectionEditorProps): JSX.Element {
  const jira = provider.id === 'jira'
  const oauthAvailable = authorizationAvailable && hasIpc && typeof api.integrations?.authorize === 'function' && typeof api.integrations?.cancelAuthorization === 'function'
  const [name, setName] = useState(connection?.name || provider.name)
  const [enabled, setEnabled] = useState(connection?.enabled ?? true)
  const [config, setConfig] = useState<Record<string, string>>(() => connection ? { ...connection.config } : {
    ...Object.fromEntries(provider.fields.filter((field) => field.defaultValue !== undefined).map((field) => [field.key, field.defaultValue ?? ''])),
    ...(provider.authentication?.length ? { authMethod: (provider.authentication.find((method) => method.id === 'token') ?? provider.authentication.find((method) => !method.oauth || oauthAvailable) ?? provider.authentication[0]).id } : {})
  })
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [clear, setClear] = useState<string[]>([])
  const action = useIntegrationAction(JSON.stringify([provider.id, connection?.id, jira ? undefined : connection?.revision]))
  const binding = useConnectionBinding({ provider, connection, connections, authorizationAvailable: oauthAvailable })
  const stored = jira ? binding.saved ?? connection : connection
  const fieldId = useId()
  const bridge = integrationBridgeState()
  const fields: ConfigField[] = (connection?.legacy && provider.id === 'gitlab'
    ? [{ key: 'baseUrl', label: '实例地址', required: true }, { key: 'user', label: '用户名', required: true }, { key: 'password', label: '密码', secret: true, required: true }, { key: 'project', label: '原有项目路径' }]
    : connectionFields(provider, config)).filter((field) => !(jira && ['statusMap', 'redirectUri'].includes(field.key)))
  const method = connectionAuthentication(provider, config)
  const requiredFieldsComplete = fields.every((field) => !field.required || (field.secret
    ? !enabled || Boolean(secrets[field.key]?.trim() || stored?.hasSecrets.includes(field.key))
    : Boolean(config[field.key]?.trim())))
  const busy = jira ? binding.busy : action.busy
  const phase = binding.state.phase
  const locked = busy || (jira && ['uncertain', 'stale', 'complete'].includes(phase))
  const needsBinding = jira && enabled && (!stored || stored.check !== 'authenticated' || !stored.enabled
    || authConfiguration(config) !== authConfiguration(stored.config)
    || fields.some((field) => field.secret && Boolean(secrets[field.key] || clear.includes(field.key))))
  const advancedKeys = new Set(['jql', 'project', 'signingSecret'])
  if (!jira) advancedKeys.add('clientId')
  if (provider.id === 'github' && fields.some((field) => field.key === 'baseUrl' && !field.required && field.defaultValue !== undefined)) advancedKeys.add('baseUrl')
  const primaryFields = fields.filter((field) => !advancedKeys.has(field.key))
  if (provider.id === 'gitlab' && !connection?.legacy && method?.id === 'token') primaryFields.sort((left, right) => Number(right.key === 'token') - Number(left.key === 'token'))
  const clearError = (): void => { action.setError(''); binding.clearError() }
  const finish = async (value?: IntegrationConnection): Promise<void> => {
    if (value?.legacy) {
      const settings = await api.getSettings()
      if (!(jira ? binding.current() : action.current())) return
      useApp.setState({ settings })
    }
    await onSaved(value)
  }
  const save = async (): Promise<void> => {
    if (locked || !requiredFieldsComplete || ((connection || !jira) && !name.trim())) return
    if (bridge !== 'ready') { action.setError(integrationBridgeMessage(bridge)); return }
    if (method?.oauth && !oauthAvailable && (needsBinding || !jira)) { action.setError('浏览器授权暂不可用，请完整退出并重新打开应用。'); return }
    const input: SaveConnectionInput = { id: stored?.id, revision: stored?.revision, providerId: provider.id,
      name: jira && !connection ? stored?.name ?? jiraConnectionName(config.baseUrl || '') : name,
      enabled, config, secrets: Object.fromEntries(fields.filter((field) => field.secret).map((field) => [field.key, secrets[field.key] ? { op: 'replace' as const, value: secrets[field.key] } : clear.includes(field.key) ? { op: 'clear' as const } : { op: 'keep' as const }])) }
    if (jira) {
      if (await binding.run(needsBinding ? method?.oauth ? 'authorize' : 'verify' : 'save', input, finish)) onClose()
      return
    }
    const result = await action.run(() => api.integrations.saveConnection(input))
    if (result && action.current()) {
      if (connection?.legacy) {
        const settings = await api.getSettings().catch(() => null)
        if (!action.current()) return
        if (settings) useApp.setState({ settings })
      }
      if (!action.current()) return
      onClose(); await onSaved(result)
    }
  }
  const renderField = (field: ConfigField): JSX.Element => <div key={field.key} className="space-y-2">
    <label className="my-item-title block" htmlFor={fieldId + '-' + field.key}>{field.label}{field.required && <span className="ml-1 text-my-tertiary" aria-hidden="true">*</span>}</label>
    {field.multiline ? <textarea id={fieldId + '-' + field.key} className="my-input min-h-20 w-full" value={config[field.key] || ''} onChange={(event) => { setConfig((previous) => ({ ...previous, [field.key]: event.target.value })); clearError() }} placeholder={field.placeholder} />
      : <input id={fieldId + '-' + field.key} className="my-input w-full" type={field.secret ? 'password' : 'text'} aria-required={field.required} autoComplete="off" value={field.secret ? secrets[field.key] || '' : config[field.key] || ''} onChange={(event) => { const value = event.target.value; if (field.secret) setSecrets((previous) => ({ ...previous, [field.key]: value })); else setConfig((previous) => ({ ...previous, [field.key]: value })); clearError() }} placeholder={field.secret && stored?.hasSecrets.includes(field.key) ? '已保存，留空保留' : jira && field.key === 'baseUrl' ? 'http://jira.example.com:8080/jira' : field.placeholder} />}
    {field.secret && stored?.hasSecrets.includes(field.key) && <label className="flex items-start gap-2 text-my-xs text-my-secondary"><Checkbox checked={clear.includes(field.key)} onChange={(checked) => { setClear((previous) => checked ? [...previous, field.key] : previous.filter((key) => key !== field.key)); clearError() }} /><span>清除已保存的凭证（填写新值则替换）</span></label>}
  </div>
  const managementFields = <><label className="block space-y-2"><span className="my-item-title">连接名称</span><input className="my-input w-full" value={name} disabled={connection?.legacy || locked} onChange={(event) => { setName(event.target.value); clearError() }} maxLength={100} /></label><label className="flex items-center gap-2"><Checkbox checked={enabled} onChange={(value) => { setEnabled(value); clearError() }} /><span className="my-item-title">启用此连接</span></label></>
  const instance = jira || provider.id === 'gitlab'
  const subject = provider.name + (provider.id === 'feishu' ? '群通知' : provider.category === 'messaging' ? '群机器人' : '')
  const connectLabel = instance ? '绑定 ' + provider.name : provider.category === 'messaging' ? '连接' + subject : '连接 ' + subject
  const heading = connection ? '编辑 ' + subject + (instance ? ' 实例' : provider.category === 'messaging' ? '' : ' 连接') : connectLabel + (instance ? ' 实例' : '')
  const close = (): void => { if (!jira && busy) return; if (jira) binding.abandon(); onClose() }
  const submitLabel = !jira ? action.busy ? '保存中…' : connection ? '保存' : connectLabel
    : ({ saving: '保存中…', verifying: '正在验证身份…', authorizing: '等待浏览器授权…', cancelling: '正在取消授权…', refreshing: '刷新连接中…' } as Partial<Record<typeof phase, string>>)[phase]
      ?? (needsBinding ? method?.oauth ? '绑定并授权' : '绑定并验证' : '保存')
  const error = jira ? binding.state.error || action.error : action.error
  const refreshOnly = async (): Promise<void> => { if (await binding.refresh(finish)) onClose() }
  return <Modal open ariaLabel={heading} width={448} onClose={close}>
    <div className="flex max-h-[calc(var(--my-modal-max-height)-var(--my-space-2))] flex-col">
    <div className="flex shrink-0 items-center gap-3 border-b border-my-line px-5 py-4"><IntegrationProductIcon provider={provider.id} /><h2 className="min-w-0 flex-1 text-my-lg font-semibold">{heading}</h2><Button size="sm" variant="ghost" aria-label={'关闭 ' + subject + (connection ? ' 编辑' : ' 绑定')} disabled={!jira && busy} onClick={close}><X size={16} /></Button></div>
    <form className="flex min-h-0 flex-col" onSubmit={(event) => { event.preventDefault(); void save() }}>
      <div className="my-scrollbar min-h-0 max-h-[60vh] space-y-5 overflow-y-auto px-5 py-5">
        {bridge !== 'ready' && <p role="status" className="rounded-my-md border border-my-line p-3 text-my-sm text-my-secondary">{integrationBridgeMessage(bridge)}</p>}
        <fieldset disabled={locked} className="space-y-5" aria-busy={busy}>
          {jira && primaryFields.filter((field) => field.key === 'baseUrl').map(renderField)}
          {jira && !connection?.legacy && provider.authentication && <div className="space-y-2">
            <p id={fieldId + '-jira-authentication'} className="my-item-title">认证方式</p>
            <div className="my-segmented integration-auth-methods" role="group" aria-labelledby={fieldId + '-jira-authentication'}>
              {[...provider.authentication].sort((left, right) => Number(left.id === 'basic') - Number(right.id === 'basic')).map((item) => <button key={item.id} type="button" className="my-segment" aria-pressed={method?.id === item.id} disabled={locked || Boolean(item.oauth && !oauthAvailable)} onClick={() => { setConfig((previous) => ({ ...previous, authMethod: item.id })); clearError() }}>{item.id === 'token' ? '访问令牌' : item.oauth ? '浏览器授权' : item.id === 'basic' ? '用户名密码' : item.name}</button>)}
            </div>
            {!oauthAvailable && provider.authentication.some((item) => item.oauth) && <p role="status" className="my-item-description">浏览器授权暂不可用，可使用访问令牌或用户名与密码。</p>}
          </div>}
          {primaryFields.filter((field) => !jira || field.key !== 'baseUrl').map(renderField)}
          {jira && !connection?.legacy && method?.oauth && <OAuthSetup provider={provider} method={method} baseUrl={config.baseUrl || ''} redirectUri={config.redirectUri ?? JIRA_OAUTH_REDIRECT_URI} onUseLocalCallback={() => { setConfig((previous) => ({ ...previous, redirectUri: JIRA_OAUTH_REDIRECT_URI })); clearError() }} />}
          {jira ? connection && <>
            <div className="space-y-4 border-t border-my-line pt-4">{managementFields}</div>
            <details className="integration-disclosure"><summary>查询设置</summary><div className="mt-4 space-y-4">{fields.filter((field) => field.key === 'jql').map(renderField)}</div></details>
          </> : <details className="integration-disclosure"><summary>高级设置</summary><div className="mt-4 space-y-4">
            {!connection?.legacy && provider.authentication && <div className="space-y-2"><p id={fieldId + '-authentication'} className="my-item-title">登录方式</p><div className="my-segmented integration-auth-methods" role="group" aria-labelledby={fieldId + '-authentication'}>{[...provider.authentication].sort((left, right) => Number(Boolean(left.oauth)) - Number(Boolean(right.oauth))).map((item) => <button key={item.id} type="button" className="my-segment flex-1" aria-pressed={method?.id === item.id} disabled={locked || Boolean(item.oauth && !oauthAvailable)} onClick={() => { setConfig((previous) => ({ ...previous, authMethod: item.id })); clearError() }}>{item.oauth ? 'OAuth 授权' : '访问令牌（PAT）'}</button>)}</div>{!oauthAvailable && provider.authentication.some((item) => item.oauth) && <p className="text-my-xs text-my-secondary">浏览器授权暂不可用，可使用访问令牌。</p>}</div>}
            {managementFields}
            {fields.filter((field) => advancedKeys.has(field.key)).map(renderField)}
            {!connection?.legacy && method?.oauth && <OAuthSetup provider={provider} method={method} baseUrl={config.baseUrl || ''} />}
          </div></details>}
          {connection?.legacy && <p className="my-item-description">原有设置兼容连接，名称不可修改。</p>}
        </fieldset>
        {clear.some((key) => !secrets[key]) && <p role="status" className="text-my-sm text-my-warning-text">保存后将清除选中的凭证，相关连接可能无法继续使用。</p>}
        {jira && <div role="status" aria-live="polite" aria-atomic="true" className="space-y-2 text-my-sm text-my-secondary">
          {busy && <p className="flex items-center gap-2"><LoaderCircle size={14} className="shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />{phase === 'authorizing' ? '请在浏览器完成授权，最多等待 5 分钟。' : submitLabel}</p>}
          {(phase === 'complete' || (phase === 'refreshing' && binding.state.outcome)) && <p className="flex items-start gap-2"><Check size={14} className="mt-0.5 shrink-0" aria-hidden="true" /><span className="break-words">{binding.state.outcome === 'bound' ? binding.saved?.detail || '身份已验证并保存' : '配置已保存'}</span></p>}
        </div>}
        {error && <div role="alert" className="break-words text-my-sm text-my-danger-text">{error.length > 180 || error.includes('\n') ? <><p>操作未完成，请查看详情后重试。</p><details className="integration-disclosure mt-2"><summary>错误详情</summary><p className="mt-2 whitespace-pre-wrap break-words">{error}</p></details></> : <p>{error}</p>}</div>}
        {jira && phase === 'uncertain' && <div className="space-y-2"><Button size="sm" onClick={() => void binding.reconcile(finish).then((done) => { if (done) onClose() })}>读取连接并核实</Button>{binding.state.candidates?.map((item) => <Button key={item.id} className="max-w-full" size="sm" onClick={() => binding.resume(item)}><span className="min-w-0 break-all">继续使用 {item.name} · {item.config.baseUrl}</span></Button>)}{binding.state.candidates?.length === 0 && <p className="my-item-description">未找到已保存连接。请关闭后重新读取列表，确认结果再创建。</p>}</div>}
      </div>
      <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-my-line px-5 py-3">
        <Button type="button" onClick={close} disabled={!jira && busy}>{jira && busy ? '关闭' : '取消'}</Button>
        {jira && (phase === 'authorizing' || phase === 'cancelling') ? <Button type="button" disabled={phase === 'cancelling'} onClick={() => void binding.cancel()}>{phase === 'cancelling' ? '取消中…' : '取消授权'}</Button>
          : jira && phase === 'complete' ? <Button type="button" variant="primary" onClick={() => void refreshOnly()}>刷新连接</Button>
            : <Button type="submit" variant="primary" disabled={locked || !requiredFieldsComplete || ((connection || !jira) && !name.trim()) || Boolean(method?.oauth && !oauthAvailable && (needsBinding || !jira))}>{submitLabel}</Button>}
      </div>
    </form>
    </div>
  </Modal>
}
