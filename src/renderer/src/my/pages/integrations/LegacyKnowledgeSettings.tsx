import { useId, useState, type JSX } from 'react'
import { ipcFail, IpcErrorCode } from '../../../../../shared/ipc-errors'
import { WEKNORA_DEFAULTS, type WeknoraConfig, type WeknoraKbSummary } from '../../../../../shared/types'
import { api, hasIpc } from '../../../api'
import { Select } from '../../../components/Select'
import { PreferenceRow, PreferenceSection } from '../../../pages/settings/PreferenceSection'
import { useApp } from '../../../store'
import { Button, Switch } from '../../ui'
import { useIntegrationAction } from './hooks'

type LegacyDraft = Pick<WeknoraConfig, 'enabled' | 'baseUrl' | 'apiKey' | 'syncSpec' | 'specKbId' | 'mcpUrl' | 'mcpToken'>
type LegacyAction = 'save' | 'test' | 'mcp' | 'claude' | 'codex' | 'zcode'
interface ActionResult { message: string; saved?: boolean; kbs?: WeknoraKbSummary[] }

function editableConfig(saved: WeknoraConfig): LegacyDraft {
  return {
    enabled: saved.enabled,
    baseUrl: saved.baseUrl,
    apiKey: saved.apiKeyEncrypted ? '' : saved.apiKey,
    syncSpec: saved.syncSpec,
    specKbId: saved.specKbId,
    mcpUrl: saved.mcpUrl,
    mcpToken: saved.mcpTokenEncrypted ? '' : saved.mcpToken
  }
}

function remoteSnippet(kind: 'claude' | 'codex' | 'zcode', draft: LegacyDraft): string {
  const url = draft.mcpUrl || '<MCP_URL>'
  const authorization = `Bearer ${draft.mcpToken || '<TOKEN>'}`
  if (kind === 'claude') return JSON.stringify({ mcpServers: { weknora: { type: 'http', url, headers: { Authorization: authorization } } } }, null, 2)
  if (kind === 'codex') return `# ~/.codex/config.toml\n[mcp_servers.weknora]\nurl = ${JSON.stringify(url)}\nhttp_headers = { "Authorization" = ${JSON.stringify(authorization)} }`
  const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`
  return `zcode mcp add weknora --url ${quote(url)} --header ${quote(`Authorization: ${authorization}`)}`
}

export function LegacyKnowledgeSettings(): JSX.Element {
  const id = useId()
  const settings = useApp((state) => state.settings)
  const saved = { ...WEKNORA_DEFAULTS, ...settings?.weknora }
  const autoSync = saved.enabled && saved.syncSpec
  const syncStatus = autoSync
    ? saved.specKbId ? '规范自动同步已开启' : '规范自动同步已开启，待选目标库'
    : '旧连接已停用'

  return <PreferenceSection id={id} title="兼容设置">
    <details className="preference-disclosure">
      <summary>
        规范同步与旧 MCP
        {settings && saved.syncSpec && <span className={`ml-2 text-my-xs ${autoSync ? 'text-my-warning-text' : 'text-my-tertiary'}`}>{syncStatus}</span>}
      </summary>
      {settings ? <LegacyKnowledgeSettingsForm id={id} saved={saved} />
        : <p role="status" className="text-my-sm text-my-secondary">设置尚未加载。</p>}
    </details>
  </PreferenceSection>
}

function LegacyKnowledgeSettingsForm({ id, saved }: { id: string; saved: WeknoraConfig }): JSX.Element {
  const action = useIntegrationAction('legacy-weknora-settings')
  const [changes, setChanges] = useState<Partial<LegacyDraft>>({})
  const draft = { ...editableConfig(saved), ...changes }
  const [libraries, setLibraries] = useState<{ owner: () => boolean; items: WeknoraKbSummary[] } | null>(null)
  const [feedback, setFeedback] = useState<{ owner: () => boolean; text: string } | null>(null)
  const kbs = libraries?.owner === action.current ? libraries.items : null
  const message = feedback?.owner === action.current ? feedback.text : null
  const disabled = !hasIpc || action.busy

  const updateDraft = (patch: Partial<LegacyDraft>): void => {
    if (disabled || !action.current()) return
    setChanges((previous) => ({ ...previous, ...patch }))
    setFeedback(null)
    action.setError('')
    if ('baseUrl' in patch || 'apiKey' in patch) setLibraries(null)
  }

  const perform = async (kind: LegacyAction): Promise<void> => {
    if (disabled || !action.current()) return
    setFeedback(null)
    if (kind === 'test') setLibraries(null)
    const result = await action.run<ActionResult>(async () => {
      const settings = useApp.getState().settings
      if (!settings) return ipcFail(IpcErrorCode.Unavailable, '设置尚未加载，请稍后重试。')
      const latest = { ...WEKNORA_DEFAULTS, ...settings.weknora }
      if (kind === 'save') {
        const config: WeknoraConfig = {
          ...latest,
          ...changes,
          apiKey: changes.apiKey || latest.apiKey,
          apiKeyEncrypted: changes.apiKey ? false : latest.apiKeyEncrypted,
          mcpToken: changes.mcpToken || latest.mcpToken,
          mcpTokenEncrypted: changes.mcpToken ? false : latest.mcpTokenEncrypted
        }
        await useApp.getState().saveSettings({ weknora: config })
        return { ok: true, data: { message: '兼容设置已保存。', saved: true } }
      }
      if (kind === 'test') {
        const response = await api.weknoraTest({ ...latest, ...draft })
        if (!response.ok) return ipcFail(IpcErrorCode.Upstream, response.error ?? '旧连接测试失败，请重试。')
        return { ok: true, data: { message: `连接成功：${response.kbs?.length ?? 0} 个知识库。`, kbs: response.kbs ?? [] } }
      }
      if (kind === 'mcp') {
        const response = await api.weknoraTestMcp(draft.mcpUrl, draft.mcpToken)
        if (!response.ok) return ipcFail(IpcErrorCode.Upstream, response.error ?? 'MCP 端点测试失败，请重试。')
        return { ok: true, data: { message: 'MCP 端点握手成功。' } }
      }
      await api.copyToClipboard(remoteSnippet(kind, draft))
      const label = { claude: 'Claude JSON', codex: 'Codex TOML', zcode: 'ZCode 命令' }[kind]
      const placeholders = [!draft.mcpUrl && '端点地址', !draft.mcpToken && '令牌'].filter(Boolean)
      return { ok: true, data: { message: `${label} 已复制。${placeholders.length ? `请替换${placeholders.join('与')}占位符。` : ''}` } }
    })
    if (!result || !action.current()) return
    if (result.saved) setChanges({})
    if (result.kbs) setLibraries({ owner: action.current, items: result.kbs })
    setFeedback({ owner: action.current, text: result.message })
  }

  return <>
    <fieldset disabled={disabled} className="m-0 min-w-0 border-0 p-0">
      <PreferenceRow label="旧连接" hint="用于原有规范同步。开关修改后需保存。">
        <Switch checked={draft.enabled} disabled={disabled} label="启用旧 WeKnora 连接" onChange={(enabled) => updateDraft({ enabled })} />
      </PreferenceRow>
      <PreferenceRow label="服务器地址" htmlFor={`${id}-url`} hint="支持部署根地址或 /api/v1 地址。">
        <input id={`${id}-url`} className="my-input" value={draft.baseUrl} onChange={(event) => updateDraft({ baseUrl: event.target.value })} />
      </PreferenceRow>
      <PreferenceRow label="API Key" htmlFor={`${id}-key`} hint={saved.apiKeyEncrypted ? '已加密保存；留空保留，输入新值覆盖。' : '留空保留已保存密钥。'}>
        <input id={`${id}-key`} type="password" autoComplete="new-password" className="my-input" value={draft.apiKey} onChange={(event) => updateDraft({ apiKey: event.target.value })} />
      </PreferenceRow>
      <PreferenceRow label="连接测试">
        <Button size="sm" variant="outline" disabled={disabled || !draft.baseUrl.trim()} onClick={() => void perform('test')}>测试并加载知识库</Button>
      </PreferenceRow>
      <PreferenceRow label="规范同步目标库" htmlFor={kbs?.length ? undefined : `${id}-spec`}>
        {kbs?.length ? <Select ariaLabel="规范同步目标库" className="w-full" disabled={disabled} value={draft.specKbId} onChange={(specKbId) => updateDraft({ specKbId })} options={[
          { value: '', label: '未选择' },
          ...(!kbs.some((kb) => kb.id === draft.specKbId) && draft.specKbId ? [{ value: draft.specKbId, label: `当前目标（${draft.specKbId}）` }] : []),
          ...kbs.filter((kb) => kb.id).map((kb) => ({ value: kb.id, label: kb.name }))
        ]} /> : <input id={`${id}-spec`} className="my-input font-mono" value={draft.specKbId} onChange={(event) => updateDraft({ specKbId: event.target.value })} placeholder="知识库 ID" />}
      </PreferenceRow>
      <PreferenceRow label="规范自动同步" hint="开启并保存后，.trellis/spec 变更静默 10 分钟后自动上传到目标库，按内容去重。">
        <Switch checked={draft.syncSpec} disabled={disabled} label="自动上传规范变更" onChange={(syncSpec) => updateDraft({ syncSpec })} />
      </PreferenceRow>
      <PreferenceRow label="远程 MCP 端点" htmlFor={`${id}-mcp-url`} hint="供外部工具独立直连；片段放在工具的用户级配置中。">
        <input id={`${id}-mcp-url`} className="my-input" value={draft.mcpUrl} onChange={(event) => updateDraft({ mcpUrl: event.target.value })} />
      </PreferenceRow>
      <PreferenceRow label="MCP 端点令牌" htmlFor={`${id}-mcp-token`} hint={saved.mcpTokenEncrypted ? '已加密保存；留空保留，复制时使用 <TOKEN> 占位符。' : '留空保留已保存令牌；复制时使用 <TOKEN> 占位符。'}>
        <input id={`${id}-mcp-token`} type="password" autoComplete="new-password" className="my-input" value={draft.mcpToken} onChange={(event) => updateDraft({ mcpToken: event.target.value })} />
      </PreferenceRow>
      <PreferenceRow label="端点测试">
        <Button size="sm" variant="outline" disabled={disabled || !draft.mcpUrl.trim()} onClick={() => void perform('mcp')}>测试端点</Button>
      </PreferenceRow>
      <PreferenceRow label="工具配置片段" hint="ZCode 命令适用于 PowerShell。">
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void perform('claude')}>复制 Claude JSON</Button>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void perform('codex')}>复制 Codex TOML</Button>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void perform('zcode')}>复制 ZCode 命令</Button>
      </PreferenceRow>
      <div className="preference-actions">
        <Button variant="primary" size="sm" disabled={disabled} onClick={() => void perform('save')}>保存设置</Button>
      </div>
    </fieldset>
    {!hasIpc && <p role="status" className="mt-2 text-my-sm text-my-secondary">请在桌面应用中管理兼容设置。</p>}
    {action.busy && <p role="status" className="mt-2 text-my-sm text-my-tertiary">正在处理…</p>}
    {action.error && <p role="alert" className="mt-2 break-words text-my-sm text-my-danger-text">{action.error}</p>}
    {message && <p role="status" className="mt-2 break-words text-my-sm text-my-secondary">{message}</p>}
  </>
}
