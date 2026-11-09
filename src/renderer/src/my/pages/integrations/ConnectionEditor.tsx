import { useId, useState, type JSX } from 'react'
import { X } from 'lucide-react'
import { connectionAuthentication, connectionFields, type ConfigField, type IntegrationConnection, type ProviderManifest, type SaveConnectionInput } from '../../../../../shared/integrations'
import { api, hasIpc } from '../../../api'
import { useApp } from '../../../store'
import { Button, Checkbox, Modal } from '../../ui'
import { useIntegrationAction } from './hooks'
import { integrationBridgeMessage, integrationBridgeState } from './bridge'
import { OAuthSetup } from './ConnectionAuthorization'
import { ConnectionStatusMapping } from './ConnectionStatusMapping'
import { IntegrationProductIcon } from './IntegrationProductIcon'

export function ConnectionEditor({ provider, connection, authorizationAvailable = false, onClose, onSaved }: { provider: ProviderManifest; connection?: IntegrationConnection; authorizationAvailable?: boolean; onClose: () => void; onSaved: () => Promise<void> }): JSX.Element {
  const oauthAvailable = authorizationAvailable && hasIpc && typeof api.integrations?.authorize === 'function' && typeof api.integrations?.cancelAuthorization === 'function'
  const [name, setName] = useState(connection?.name || provider.name)
  const [enabled, setEnabled] = useState(connection?.enabled ?? true)
  const [config, setConfig] = useState<Record<string, string>>(() => connection ? { ...connection.config } : {
    ...Object.fromEntries(provider.fields.filter((field) => field.defaultValue !== undefined).map((field) => [field.key, field.defaultValue ?? ''])),
    ...(provider.authentication?.length ? { authMethod: (provider.authentication.find((method) => method.id === 'token') ?? provider.authentication.find((method) => !method.oauth || oauthAvailable) ?? provider.authentication[0]).id } : {})
  })
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [clear, setClear] = useState<string[]>([])
  const [mappingValid, setMappingValid] = useState(true)
  const [advanced, setAdvanced] = useState(false)
  const action = useIntegrationAction(JSON.stringify([provider.id, connection?.id, connection?.revision]))
  const fieldId = useId()
  const bridge = integrationBridgeState()
  const fields: ConfigField[] = connection?.legacy && provider.id === 'gitlab'
    ? [{ key: 'baseUrl', label: '实例地址', required: true }, { key: 'user', label: '用户名', required: true }, { key: 'password', label: '密码', secret: true, required: true }, { key: 'project', label: '原有项目路径' }]
    : connectionFields(provider, config)
  const method = connectionAuthentication(provider, config)
  const requiredFieldsComplete = fields.every((field) => !field.required || (field.secret
    ? Boolean(secrets[field.key]?.trim() || (connection && (connection.hasSecrets.includes(field.key) || clear.includes(field.key))))
    : Boolean(config[field.key]?.trim())))
  const advancedKeys = new Set(['jql', 'statusMap', 'project', 'signingSecret'])
  if (provider.id !== 'jira') advancedKeys.add('clientId')
  if (provider.id === 'github' && fields.some((field) => field.key === 'baseUrl' && !field.required && field.defaultValue !== undefined)) advancedKeys.add('baseUrl')
  const primaryFields = fields.filter((field) => !advancedKeys.has(field.key))
  if (provider.id === 'gitlab' && !connection?.legacy && method?.id === 'token') primaryFields.sort((left, right) => Number(right.key === 'token') - Number(left.key === 'token'))
  const save = async (): Promise<void> => {
    if (!mappingValid || !requiredFieldsComplete) return
    if (bridge !== 'ready') { action.setError(integrationBridgeMessage(bridge)); return }
    if (!connection?.legacy && method?.oauth && !oauthAvailable) { action.setError('浏览器授权暂不可用，请完整退出并重新打开应用。'); return }
    const input: SaveConnectionInput = { id: connection?.id, revision: connection?.revision, providerId: provider.id, name, enabled, config,
      secrets: Object.fromEntries(fields.filter((field) => field.secret).map((field) => [field.key, secrets[field.key] ? { op: 'replace' as const, value: secrets[field.key] } : clear.includes(field.key) ? { op: 'clear' as const } : { op: 'keep' as const }])) }
    const result = await action.run(() => api.integrations.saveConnection(input))
    if (result) {
      if (connection?.legacy) {
        const settings = await api.getSettings().catch(() => null)
        if (!action.current()) return
        if (settings) useApp.setState({ settings })
      }
      if (!action.current()) return
      onClose(); await onSaved()
    }
  }
  const renderField = (field: ConfigField): JSX.Element => <div key={field.key} className="space-y-2">
    {field.key !== 'statusMap' && <label className="my-item-title block" htmlFor={`${fieldId}-${field.key}`}>{field.label}{field.required && <span className="ml-1 text-my-tertiary">*</span>}</label>}
    {field.key === 'statusMap' ? <ConnectionStatusMapping value={config[field.key] || ''} disabled={action.busy} onChange={(value) => setConfig((previous) => ({ ...previous, [field.key]: value }))} onValidityChange={setMappingValid} /> : field.multiline ? <textarea id={`${fieldId}-${field.key}`} className="my-input min-h-20 w-full" value={config[field.key] || ''} onChange={(event) => setConfig((previous) => ({ ...previous, [field.key]: event.target.value }))} placeholder={field.placeholder} />
      : <input id={`${fieldId}-${field.key}`} className="my-input w-full" type={field.secret ? 'password' : 'text'} autoComplete="off" value={field.secret ? secrets[field.key] || '' : config[field.key] || ''} onChange={(event) => { const value = event.target.value; if (field.secret) setSecrets((previous) => ({ ...previous, [field.key]: value })); else setConfig((previous) => ({ ...previous, [field.key]: value })) }} placeholder={field.secret && connection?.hasSecrets.includes(field.key) ? '已保存，留空保留' : field.placeholder} />}
    {field.secret && connection?.hasSecrets.includes(field.key) && <label className="flex items-start gap-2 text-my-xs text-my-secondary"><Checkbox checked={clear.includes(field.key)} onChange={(checked) => setClear((previous) => checked ? [...previous, field.key] : previous.filter((key) => key !== field.key))} /><span>清除已保存的凭证（填写新值则替换）</span></label>}
  </div>
  const instance = provider.id === 'jira' || provider.id === 'gitlab'
  const subject = `${provider.name}${provider.category === 'messaging' ? '群机器人' : ''}`
  const connectLabel = instance ? `绑定 ${provider.name}` : provider.category === 'messaging' ? `连接${subject}` : `连接 ${subject}`
  const heading = connection ? `编辑 ${subject}${instance ? ' 实例' : provider.category === 'messaging' ? '' : ' 连接'}` : `${connectLabel}${instance ? ' 实例' : ''}`
  return <Modal open ariaLabel={heading} width={448} onClose={() => { if (!action.busy) onClose() }}>
    <div className="flex items-center gap-3 border-b border-my-line px-5 py-4"><IntegrationProductIcon provider={provider.id} /><h2 className="min-w-0 flex-1 text-my-lg font-semibold">{heading}</h2><Button size="sm" variant="ghost" aria-label={`关闭 ${subject} ${connection ? '编辑' : instance ? '绑定' : '连接'}`} disabled={action.busy} onClick={() => { if (!action.busy) onClose() }}><X size={16} /></Button></div>
    <div className="my-scrollbar max-h-[60vh] space-y-5 overflow-y-auto px-5 py-5">
      {bridge !== 'ready' && <p role="status" className="rounded-my-md border border-my-line p-3 text-my-sm text-my-secondary">{integrationBridgeMessage(bridge)}</p>}
      <fieldset disabled={action.busy} className="space-y-5">
        {provider.id === 'jira' && !connection?.legacy && provider.authentication && <div className="space-y-2">
          <p id={`${fieldId}-jira-authentication`} className="my-item-title">认证方式</p>
          <div className="my-segmented integration-auth-methods" role="group" aria-labelledby={`${fieldId}-jira-authentication`}>
            {[...provider.authentication].sort((left, right) => Number(left.id === 'basic') - Number(right.id === 'basic')).map((item) => <button key={item.id} type="button" className="my-segment" aria-pressed={method?.id === item.id} disabled={action.busy || Boolean(item.oauth && !oauthAvailable)} onClick={() => { setConfig((previous) => ({ ...previous, authMethod: item.id })); action.setError('') }}>{item.id === 'token' ? '访问令牌' : item.oauth ? '浏览器授权' : item.id === 'basic' ? '用户名密码' : item.name}</button>)}
          </div>
          {!oauthAvailable && provider.authentication.some((item) => item.oauth) && <p role="status" className="my-item-description">浏览器授权暂不可用，可使用访问令牌或用户名与密码。</p>}
        </div>}
        {primaryFields.map(renderField)}
        {provider.id === 'jira' && !connection?.legacy && method?.oauth && <OAuthSetup provider={provider} method={method} baseUrl={config.baseUrl || ''} redirectUri={config.redirectUri} />}
        {provider.id !== 'jira' && !connection?.legacy && method?.oauth && !oauthAvailable && <p role="status" className="text-my-xs text-my-secondary">浏览器授权暂不可用，请在高级设置中改用访问令牌，或完整退出并重新打开应用。</p>}
        <details className="integration-disclosure" open={advanced || !mappingValid} onToggle={(event) => setAdvanced(event.currentTarget.open)}><summary>高级设置</summary><div className="mt-4 space-y-4">
          {provider.id !== 'jira' && !connection?.legacy && provider.authentication && <div className="space-y-2"><p id={`${fieldId}-authentication`} className="my-item-title">登录方式</p><div className="my-segmented integration-auth-methods" role="group" aria-labelledby={`${fieldId}-authentication`}>{[...provider.authentication].sort((left, right) => Number(Boolean(left.oauth)) - Number(Boolean(right.oauth))).map((item) => <button key={item.id} type="button" className="my-segment flex-1" aria-pressed={method?.id === item.id} disabled={action.busy || Boolean(item.oauth && !oauthAvailable)} onClick={() => { setConfig((previous) => ({ ...previous, authMethod: item.id })); action.setError('') }}>{item.oauth ? 'OAuth 授权' : '访问令牌（PAT）'}</button>)}</div>{!oauthAvailable && provider.authentication.some((item) => item.oauth) && <p className="text-my-xs text-my-secondary">浏览器授权暂不可用，可使用访问令牌。</p>}</div>}
          <label className="block space-y-2"><span className="my-item-title">连接名称</span><input className="my-input w-full" value={name} disabled={connection?.legacy || action.busy} onChange={(event) => setName(event.target.value)} maxLength={100} /></label>
          {fields.filter((field) => advancedKeys.has(field.key)).map(renderField)}
          {provider.id !== 'jira' && !connection?.legacy && method?.oauth && <OAuthSetup provider={provider} method={method} baseUrl={config.baseUrl || ''} />}
          <label className="flex items-center gap-2"><Checkbox checked={enabled} onChange={setEnabled} /><span className="my-item-title">启用此连接</span></label>
          {connection?.legacy && <p className="my-item-description">原有设置兼容连接，名称不可修改。</p>}
        </div></details>
      </fieldset>
      {clear.some((key) => !secrets[key]) && <p role="status" className="text-my-sm text-my-warning-text">保存后将清除选中的凭证，相关连接可能无法继续使用。</p>}
      {action.error && <p role="alert" className="text-my-sm text-my-danger-text">{action.error}</p>}
    </div>
    <div className="flex justify-end gap-2 border-t border-my-line px-5 py-3"><Button onClick={onClose} disabled={action.busy}>取消</Button><Button variant="primary" disabled={action.busy || !mappingValid || !requiredFieldsComplete || !name.trim() || Boolean(!connection?.legacy && method?.oauth && !oauthAvailable)} onClick={() => void save()}>{action.busy ? '保存中…' : connection ? '保存' : connectLabel}</Button></div>
  </Modal>
}
