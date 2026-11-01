import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Eye, EyeOff, Loader2, X, Zap } from 'lucide-react'
import type { AiApiFormat, ModelItem, ModelProvider } from '../../../../shared/types'
import { errorMessage } from '../../../../shared/errors'
import { Select } from '../../components/Select'
import { CopyableError } from '../../components/CopyableError'
import { Button, Modal, Switch } from '../../my/ui'
import { modelErrorSummary } from './model-errors'

export type ModelSecretAction = 'keep' | 'replace' | 'clear'

export function ProviderIdentity({ name, local = false }: { name: string; local?: boolean }): JSX.Element {
  const initial = name.trim().match(/[\p{L}\p{N}]/u)?.[0]?.toLocaleUpperCase() || '+'
  return <span className="model-provider-identity" aria-hidden="true">{local ? <span className="text-my-xs">本地</span> : initial}</span>
}

export function ModelProviderEditor({ provider, isNew, onClose, onSave, onTest }: {
  provider: ModelProvider
  isNew: boolean
  onClose(): void
  onSave(draft: ModelProvider, secretAction: ModelSecretAction): Promise<void>
  onTest(draft: ModelProvider): Promise<{ ok: boolean; error?: string; latencyMs?: number }>
}): JSX.Element {
  const [draft, setDraft] = useState(provider)
  const [secret, setSecret] = useState(provider.apiKeyEncrypted ? '' : provider.apiKey)
  const [clearSecret, setClearSecret] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string; latencyMs?: number } | null>(null)
  const testVersion = useRef(0)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; testVersion.current += 1 }
  }, [])
  const invalidateTest = (): void => {
    testVersion.current += 1
    setTesting(false)
    setTestResult(null)
  }
  const patch = (next: Partial<ModelProvider>): void => {
    if (next.baseUrl !== undefined || next.apiFormat !== undefined) invalidateTest()
    setDraft((value) => ({ ...value, ...next }))
  }
  const connectionDraft = (): ModelProvider => ({
    ...draft,
    ...(clearSecret ? { apiKey: '', apiKeyEncrypted: false } : provider.apiKeyEncrypted && !secret ? { apiKey: provider.apiKey, apiKeyEncrypted: true } : { apiKey: secret, apiKeyEncrypted: false })
  })
  const close = (): void => { if (!saving) onClose() }
  const test = async (): Promise<void> => {
    if (saving || testing || !draft.baseUrl.trim()) return
    const version = ++testVersion.current
    setTesting(true)
    setTestResult(null)
    try {
      const result = await onTest(connectionDraft())
      if (mounted.current && testVersion.current === version) setTestResult({ ...result, error: result.ok ? undefined : result.error || '模型目录连接失败，请重试' })
    } catch (err) {
      if (mounted.current && testVersion.current === version) setTestResult({ ok: false, error: errorMessage(err) || '模型目录连接失败，请重试' })
    } finally {
      if (mounted.current && testVersion.current === version) setTesting(false)
    }
  }
  const save = async (): Promise<void> => {
    if (saving || !draft.name.trim() || !draft.baseUrl.trim()) return
    setSaving(true)
    setError('')
    try {
      const initialSecret = provider.apiKeyEncrypted ? '' : provider.apiKey
      const secretAction: ModelSecretAction = clearSecret ? 'clear' : secret === initialSecret ? 'keep' : secret ? 'replace' : 'clear'
      await onSave({
        ...connectionDraft(),
        name: draft.name.trim()
      }, secretAction)
      onClose()
    } catch (err) {
      setError(errorMessage(err) || '无法保存，请重试')
    } finally {
      setSaving(false)
    }
  }
  return <Modal open onClose={close} ariaLabel={isNew ? '添加供应商' : `编辑供应商 ${provider.name}`}>
    <form className="my-modal-content model-config-editor" onSubmit={(event) => { event.preventDefault(); void save() }}>
      <div className="mb-5 flex items-center gap-3">
        <ProviderIdentity name={draft.name} local={draft.apiFormat === 'ollama'} />
        <h2 className="min-w-0 flex-1 text-my-lg font-semibold text-my-primary">{isNew ? '添加供应商' : '编辑供应商'}</h2>
        <Button variant="ghost" onClick={close} disabled={saving} aria-label="关闭供应商配置"><X size={17} /></Button>
      </div>
      <fieldset disabled={saving} className="space-y-4">
        <div><label htmlFor="models-provider-name">名称</label><input id="models-provider-name" className="my-input" value={draft.name} onChange={(event) => patch({ name: event.target.value })} autoFocus required /></div>
        <div><label htmlFor="models-base-url">接口地址</label><input id="models-base-url" className="my-input" value={draft.baseUrl} onChange={(event) => patch({ baseUrl: event.target.value })} placeholder="https://api.openai.com/v1" spellCheck={false} required /></div>
        <div><span className="model-field-label" id="models-format-label">API 格式</span><Select className="w-full" ariaLabel="API 格式" value={draft.apiFormat} onChange={(apiFormat: AiApiFormat) => patch({ apiFormat })} disabled={saving} options={[
          { value: 'openai', label: 'OpenAI Chat Completions' },
          { value: 'response', label: 'OpenAI Responses' },
          { value: 'anthropic', label: 'Anthropic Messages' },
          { value: 'ollama', label: 'Ollama' }
        ]} /></div>
        <div>
          <div className="mb-1 flex items-center justify-between gap-2"><label htmlFor="models-api-key" className="mb-0">API 密钥</label>{provider.apiKeyEncrypted && !secret && !clearSecret && <span className="my-item-description">已加密保存 · 留空保留</span>}</div>
          <div className="relative"><input id="models-api-key" type={showKey ? 'text' : 'password'} className="my-input pr-10" value={secret} onChange={(event) => { invalidateTest(); setSecret(event.target.value); if (event.target.value) setClearSecret(false) }} placeholder={provider.apiKeyEncrypted ? '输入新密钥以替换' : draft.apiFormat === 'ollama' ? '可选' : '输入 API 密钥'} autoComplete="new-password" spellCheck={false} /><button type="button" onClick={() => setShowKey((value) => !value)} aria-label={showKey ? '隐藏 API 密钥' : '显示 API 密钥'} aria-pressed={showKey} className="absolute inset-y-0 right-0 flex items-center rounded-my-md px-3 text-my-tertiary hover:text-my-primary">{showKey ? <EyeOff size={15} /> : <Eye size={15} />}</button></div>
          {provider.apiKeyEncrypted && <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            {clearSecret && <span role="status" className="text-my-xs text-my-danger-text">保存后将清除已保存密钥</span>}
            <Button variant="ghost" size="sm" disabled={saving} onClick={() => { invalidateTest(); setClearSecret((value) => !value); setSecret('') }}>{clearSecret ? '保留已保存密钥' : '清除已保存密钥'}</Button>
          </div>}
        </div>
        <div className="flex items-center justify-between gap-3 pt-1"><span className="my-item-title">启用供应商</span><Switch checked={draft.enabled} onChange={(enabled) => patch({ enabled })} label={`启用供应商 ${draft.name}`} disabled={saving} /></div>
      </fieldset>
      {testResult?.ok && <p role="status" className="mt-4 flex items-center gap-2 text-my-sm text-my-success-text"><CheckCircle2 size={14} />模型目录可用{testResult.latencyMs === undefined ? '' : ` · ${testResult.latencyMs}ms`}</p>}
      {testResult?.ok === false && testResult.error && <div className="mt-4"><CopyableError message={testResult.error} summary={modelErrorSummary(testResult.error, '模型目录连接失败')} /></div>}
      {error && <div className="mt-4"><CopyableError message={error} summary="保存失败" /></div>}
      <div className="mt-6 flex flex-wrap items-center justify-end gap-2"><Button variant="neutral" disabled={saving || testing || !draft.baseUrl.trim()} onClick={() => void test()}>{testing ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}{testing ? '测试中…' : '测试连接'}</Button><Button variant="ghost" disabled={saving} onClick={close}>取消</Button><button type="submit" className="my-control my-button-primary" disabled={saving || !draft.name.trim() || !draft.baseUrl.trim()}>{saving && <Loader2 size={14} className="animate-spin" />}{saving ? '保存中…' : '保存'}</button></div>
    </form>
  </Modal>
}

export function ModelItemEditor({ model, isNew, providerName, onClose, onSave }: {
  model: ModelItem
  isNew: boolean
  providerName: string
  onClose(): void
  onSave(model: ModelItem): Promise<void>
}): JSX.Element {
  const [draft, setDraft] = useState(model)
  const [tags, setTags] = useState(model.tags?.join(', ') || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const close = (): void => { if (!saving) onClose() }
  const save = async (): Promise<void> => {
    if (saving || !draft.id.trim()) return
    setSaving(true)
    setError('')
    try {
      await onSave({ ...draft, id: draft.id.trim(), name: draft.name.trim() || draft.id.trim(), tags: tags.split(/[,，\s]+/).map((tag) => tag.trim()).filter(Boolean) })
      onClose()
    } catch (err) { setError(errorMessage(err) || '无法保存，请重试') } finally { setSaving(false) }
  }
  return <Modal open onClose={close} ariaLabel={isNew ? '添加模型' : `编辑模型 ${model.name || model.id}`}>
    <form className="my-modal-content model-config-editor" onSubmit={(event) => { event.preventDefault(); void save() }}>
      <div className="mb-5 flex items-start justify-between gap-3"><div><h2 className="text-my-lg font-semibold text-my-primary">{isNew ? '添加模型' : '编辑模型'}</h2><p className="my-item-description mt-1">{providerName}</p></div><Button variant="ghost" disabled={saving} onClick={close} aria-label="关闭模型配置"><X size={17} /></Button></div>
      <fieldset disabled={saving} className="space-y-4">
        <div><label htmlFor="model-item-id">模型 ID</label><input id="model-item-id" className="my-input" value={draft.id} disabled={!isNew} autoFocus={isNew} onChange={(event) => setDraft({ ...draft, id: event.target.value })} placeholder="如 gpt-4o" required /></div>
        <div><label htmlFor="model-item-name">显示名称</label><input id="model-item-name" className="my-input" value={draft.name} autoFocus={!isNew} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="留空则与 ID 相同" /></div>
        <div><label htmlFor="model-item-context">上下文窗口</label><input id="model-item-context" className="my-input" value={draft.contextWindow || ''} onChange={(event) => setDraft({ ...draft, contextWindow: event.target.value })} placeholder="如 128k、1M" /></div>
        <div><label htmlFor="model-item-tags">标签</label><input id="model-item-tags" className="my-input" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="逗号分隔，如 代码, 推理" /></div>
      </fieldset>
      {error && <div className="mt-4"><CopyableError message={error} summary="保存失败" /></div>}
      <div className="mt-6 flex justify-end gap-2"><Button variant="ghost" disabled={saving} onClick={close}>取消</Button><button type="submit" className="my-control my-button-primary" disabled={saving || !draft.id.trim()}>{saving && <Loader2 size={14} className="animate-spin" />}{saving ? '保存中…' : '保存'}</button></div>
    </form>
  </Modal>
}
