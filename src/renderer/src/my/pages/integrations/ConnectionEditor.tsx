import { useState, type JSX } from 'react'
import { connectionAuthentication, connectionFields, type ConfigField, type IntegrationConnection, type ProviderManifest, type SaveConnectionInput } from '../../../../../shared/integrations'
import { api } from '../../../api'
import { useApp } from '../../../store'
import { Button, Checkbox, Modal } from '../../ui'
import { Select } from '../../../components/Select'
import { useIntegrationAction } from './hooks'
import { integrationBridgeMessage, integrationBridgeState } from './bridge'
import { OAuthSetup } from './ConnectionAuthorization'

export function ConnectionEditor({ provider, connection, authorizationAvailable = false, onClose, onSaved }: { provider: ProviderManifest; connection?: IntegrationConnection; authorizationAvailable?: boolean; onClose: () => void; onSaved: () => Promise<void> }): JSX.Element {
  const [name, setName] = useState(connection?.name || provider.name)
  const [enabled, setEnabled] = useState(connection?.enabled ?? true)
  const [config, setConfig] = useState<Record<string, string>>(() => ({ ...connection?.config, ...(!connection && provider.authentication?.length ? { authMethod: provider.authentication[0].id } : {}) }))
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [clear, setClear] = useState<string[]>([])
  const action = useIntegrationAction()
  const bridge = integrationBridgeState()
  const fields: ConfigField[] = connection?.legacy && provider.id === 'gitlab'
    ? [{ key: 'baseUrl', label: '实例地址', required: true }, { key: 'user', label: '用户名', required: true }, { key: 'password', label: '密码', secret: true, required: true }, { key: 'project', label: '原有项目路径' }]
    : connectionFields(provider, config)
  const method = connectionAuthentication(provider, config)
  const save = async (): Promise<void> => {
    if (bridge !== 'ready') { action.setError(integrationBridgeMessage(bridge)); return }
    if (!connection?.legacy && method?.oauth && !authorizationAvailable) { action.setError('当前主进程尚未加载 OAuth 服务，请完整退出应用并重新启动开发入口后保存。'); return }
    const input: SaveConnectionInput = { id: connection?.id, revision: connection?.revision, providerId: provider.id, name, enabled, config,
      secrets: Object.fromEntries(fields.filter((f) => f.secret).map((f) => [f.key, secrets[f.key] ? { op: 'replace' as const, value: secrets[f.key] } : clear.includes(f.key) ? { op: 'clear' as const } : { op: 'keep' as const }])) }
    const result = await action.run(() => api.integrations.saveConnection(input))
    if (result) {
      if (connection?.legacy) {
        const settings = await api.getSettings().catch(() => null)
        if (settings) useApp.setState({ settings })
      }
      await onSaved(); onClose()
    }
  }
  return <Modal open onClose={() => { if (!action.busy) onClose() }}>
    <div className="border-b border-my-line px-5 py-4"><h2 className="text-my-lg font-semibold">{connection ? '编辑' : '添加'} {provider.name} 连接</h2><p className="mt-1 text-my-xs text-my-tertiary">凭证在本机主进程加密保存。留空保留已存凭证。</p></div>
    <div className="my-scrollbar max-h-[52vh] space-y-4 overflow-y-auto px-5 py-4">
      {bridge !== 'ready' && <p role="status" className="rounded-my-md border border-my-line p-3 text-my-sm text-my-secondary">{integrationBridgeMessage(bridge)}</p>}
      <label className="block space-y-1 text-my-sm"><span>连接名称{connection?.legacy ? '（兼容入口名称固定）' : ''}</span><input className="my-input w-full" value={name} disabled={connection?.legacy} onChange={(e) => setName(e.target.value)} maxLength={100} /></label>
      {!connection?.legacy && provider.authentication && <label className="block space-y-1 text-my-sm"><span>登录方式</span><Select ariaLabel="登录方式" className="w-full" value={method?.id || 'token'} disabled={action.busy} onChange={(value) => { setConfig({ ...config, authMethod: value }); action.setError('') }} options={provider.authentication.map((item) => ({ value: item.id, label: item.name }))} /></label>}
      {fields.map((field) => <div key={field.key} className="space-y-1">
        <label className="block text-my-sm" htmlFor={`integration-${field.key}`}>{field.label}{field.required ? ' *' : ''}</label>
        {field.multiline ? <textarea id={`integration-${field.key}`} className="my-input min-h-20 w-full" value={config[field.key] || ''} onChange={(e) => setConfig({ ...config, [field.key]: e.target.value })} placeholder={field.placeholder} />
          : <input id={`integration-${field.key}`} className="my-input w-full" type={field.secret ? 'password' : 'text'} autoComplete="off" value={field.secret ? secrets[field.key] || '' : config[field.key] || ''} onChange={(e) => field.secret ? setSecrets({ ...secrets, [field.key]: e.target.value }) : setConfig({ ...config, [field.key]: e.target.value })} placeholder={field.secret && connection?.hasSecrets.includes(field.key) ? '已保存，输入新值替换' : field.placeholder} />}
        {field.secret && connection?.hasSecrets.includes(field.key) && <label className="flex items-center gap-2 text-my-xs text-my-tertiary"><Checkbox checked={clear.includes(field.key)} onChange={(checked) => setClear(checked ? [...clear, field.key] : clear.filter((key) => key !== field.key))} />明确清除此凭证（填写新值将替换）</label>}
      </div>)}
      {!connection?.legacy && method?.oauth && <><OAuthSetup provider={provider} method={method} baseUrl={config.baseUrl || ''} />{!authorizationAvailable && <p role="status" className="text-my-xs text-my-secondary">当前主进程尚未加载 OAuth 服务，需完整退出并重新启动开发入口后保存此认证方式。</p>}</>}
      <label className="flex items-center gap-2 text-my-sm"><Checkbox checked={enabled} onChange={setEnabled} />启用此连接</label>
      {action.error && <p role="alert" className="text-my-sm text-my-danger-text">{action.error}</p>}
    </div>
    <div className="flex justify-end gap-2 border-t border-my-line px-5 py-3"><Button onClick={onClose} disabled={action.busy}>取消</Button><Button variant="primary" disabled={action.busy} onClick={() => void save()}>{action.busy ? '保存中…' : '保存连接'}</Button></div>
  </Modal>
}
