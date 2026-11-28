import { useEffect, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { ArrowRight, Loader2, Plus, RefreshCw, Zap } from 'lucide-react'
import type { AiConfig, ModelItem, ModelProvider } from '../../../shared/types'
import { api, hasIpc } from '../api'
import { Button } from '../my/ui'
import { Select } from '../components/Select'
import { OFFICIAL_TEMPLATES, type ProviderTemplate } from '../pages/Models'
import { ModelProviderEditor, ProviderIdentity, type ModelSecretAction } from '../pages/settings/ModelEditors'
import { useApp } from '../store'

export interface ModelSetupStepProps {
  onContinue: () => void
  onSkip: () => void
  onBusyChange?: (busy: boolean) => void
  footerSlot?: HTMLElement | null
}

function providersFrom(ai: AiConfig): ModelProvider[] {
  if (ai.providers?.length) return ai.providers
  if (ai.baseUrl.trim() && ai.baseUrl.trim() !== 'http://localhost:11434/v1' || ai.enabled || ai.model.trim() || ai.apiKey.trim() || ai.apiKeyEncrypted) {
    return [{ id: ai.activeProviderId || 'default', name: '现有配置', group: '自定义供应商', enabled: ai.enabled,
      baseUrl: ai.baseUrl, apiFormat: ai.apiFormat ?? 'openai', apiKey: ai.apiKey, apiKeyEncrypted: ai.apiKeyEncrypted,
      models: ai.model.trim() ? [{ id: ai.model, name: ai.model, enabled: true }] : [], status: 'untested' }]
  }
  return []
}

// Used only for ownership checks; never rendered or logged.
function source(provider: ModelProvider): string {
  return JSON.stringify([provider.id, provider.baseUrl, provider.apiFormat, provider.apiKey, provider.apiKeyEncrypted])
}

function safeFailure(message: string | undefined, fallback: string): string {
  const status = message?.match(/\bHTTP\s+(\d{3})\b/i)?.[1]
  if (status === '401' || status === '403') return '认证失败，请检查密钥和访问权限。'
  if (status === '404') return '接口或模型不存在，请检查配置。'
  if (status === '429') return '请求受限，请检查额度或稍后重试。'
  if (status && Number(status) >= 500) return '供应商服务暂不可用，请稍后重试。'
  return fallback
}

/** The host owns navigation and onboarding completion state. */
export function ModelSetupStep({ onContinue, onSkip, onBusyChange, footerSlot }: ModelSetupStepProps): JSX.Element {
  const ai = useApp((state) => state.settings?.ai)
  const saveSettings = useApp((state) => state.saveSettings)
  const providers = ai ? providersFrom(ai) : []
  const [providerId, setProviderId] = useState('')
  const [modelId, setModelId] = useState('')
  const [manualId, setManualId] = useState('')
  const [catalog, setCatalog] = useState<ModelItem[]>([])
  const [editor, setEditor] = useState<{ provider: ModelProvider; original: string | null } | null>(null)
  const [busy, setBusy] = useState<'fetch' | 'test' | 'save' | null>(null)
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null)
  const version = useRef(0)
  const mounted = useRef(true)
  const lock = useRef(false)
  const initialized = useRef(false)
  const selected = providers.find((provider) => provider.id === providerId)
  const selectedSource = selected ? source(selected) : ''
  const updateBusy = (next: 'fetch' | 'test' | 'save' | null): void => { onBusyChange?.(next !== null); setBusy(next) }

  useEffect(() => {
    if (!ai || initialized.current) return
    initialized.current = true
    const available = providersFrom(ai)
    const initial = available.find((provider) => provider.id === ai.activeProviderId) ?? available.find((provider) => provider.enabled)
    setProviderId(initial?.id ?? '')
    setModelId(initial?.models.some((model) => model.id === ai.model) ? ai.model : '')
  }, [ai])
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; version.current += 1; onBusyChange?.(false) }
  }, [onBusyChange])
  useEffect(() => {
    setCatalog([])
    setFeedback(null)
  }, [selectedSource, selected?.enabled])

  function chooseProvider(id: string): void {
    version.current += 1
    setProviderId(id)
    setModelId('')
    setManualId('')
    setCatalog([])
    setFeedback(null)
  }

  function openNew(template: ProviderTemplate | 'custom'): void {
    const custom = template === 'custom'
    const base = custom ? 'custom' : template.id
    const id = custom || providers.some((provider) => provider.id === base) ? `${base}-${crypto.randomUUID()}` : base
    setEditor({ original: null, provider: { id, name: custom ? '自定义供应商' : template.name,
      group: custom ? '自定义供应商' : template.group, baseUrl: custom ? '' : template.baseUrl,
      apiFormat: custom ? 'openai' : template.apiFormat, apiKey: '', enabled: true, models: [], status: 'untested' } })
  }

  async function saveProvider(draft: ModelProvider, secretAction: ModelSecretAction): Promise<void> {
    if (!editor || !hasIpc || lock.current) throw new Error('设置服务暂不可用，请重试。')
    lock.current = true
    updateBusy('save')
    try {
      const current = useApp.getState().settings?.ai
      if (!current) throw new Error('设置尚未加载，请重试。')
      const existing = providersFrom(current)
      const previous = existing.find((provider) => provider.id === draft.id)
      if (editor.original === null && previous || editor.original !== null && (!previous || source(previous) !== editor.original)) {
        throw new Error('供应商配置已更改，请关闭后重新打开。')
      }
      const updated = previous ? { ...previous, name: draft.name, baseUrl: draft.baseUrl, apiFormat: draft.apiFormat, enabled: draft.enabled,
        ...(secretAction === 'keep' ? {} : { apiKey: draft.apiKey, apiKeyEncrypted: draft.apiKeyEncrypted }),
        status: 'untested' as const, latencyMs: undefined, lastTestedAt: undefined } : draft
      const next = previous ? existing.map((provider) => provider.id === draft.id ? updated : provider) : [...existing, updated]
      // Keep the active legacy fields in sync when editing the active provider.
      const active = current.activeProviderId === updated.id || !current.activeProviderId && previous?.id === updated.id
      await saveSettings({ ai: { ...current, providers: next, ...(active ? { enabled: updated.enabled, baseUrl: updated.baseUrl,
        apiFormat: updated.apiFormat, apiKey: updated.apiKey, apiKeyEncrypted: updated.apiKeyEncrypted } : {}) } })
      chooseProvider(updated.id)
    } catch (reason) {
      if (reason instanceof Error && (reason.message === '设置尚未加载，请重试。' || reason.message === '供应商配置已更改，请关闭后重新打开。')) throw reason
      throw new Error('保存供应商失败，请检查设置服务后重试。')
    } finally { lock.current = false; if (mounted.current) updateBusy(null) }
  }

  async function runRequest(kind: 'fetch' | 'test'): Promise<void> {
    if (!selected || !hasIpc || lock.current || kind === 'test' && !modelId.trim()) return
    lock.current = true
    const request = ++version.current
    const owner = source(selected)
    const requestedModel = modelId
    updateBusy(kind)
    setFeedback(null)
    const owns = (): boolean => {
      const current = useApp.getState().settings?.ai
      return request === version.current && Boolean(current && providersFrom(current).some((provider) => source(provider) === owner))
    }
    try {
      if (kind === 'fetch') {
        const result = await api.aiFetchModels(selected)
        if (!owns()) {
          if (request === version.current) setFeedback({ ok: false, text: '供应商配置已更改，请重新获取模型。' })
          return
        }
        if (!result.ok) setFeedback({ ok: false, text: safeFailure(result.error, '获取模型目录失败，请检查接口地址和密钥后重试。') })
        else {
          setCatalog(result.models ?? [])
          setFeedback({ ok: true, text: result.models?.length ? '模型目录已获取，模型推理尚未验证。' : '目录可用，但没有返回模型；可手动输入模型 ID。' })
        }
      } else {
        const result = await api.aiTestModel(selected, requestedModel)
        if (!owns()) {
          if (request === version.current) setFeedback({ ok: false, text: '供应商配置已更改，请重新测试。' })
          return
        }
        setFeedback(result.ok ? { ok: true, text: '模型请求已成功响应。' } : { ok: false, text: safeFailure(result.error, '模型请求失败，请检查配置后重试。') })
      }
    } catch {
      if (owns()) setFeedback({ ok: false, text: kind === 'fetch' ? '获取模型目录失败，请重试。' : '模型推理测试失败，请重试。' })
    } finally {
      lock.current = false
      if (request === version.current) updateBusy(null)
    }
  }

  async function continueWithModel(): Promise<void> {
    if (!selected || !modelId.trim() || !hasIpc || lock.current) return
    lock.current = true
    updateBusy('save')
    setFeedback(null)
    try {
      const current = useApp.getState().settings?.ai
      if (!current) throw new Error()
      const existing = providersFrom(current)
      const provider = existing.find((item) => item.id === selected.id)
      if (!provider || source(provider) !== source(selected) || !provider.enabled) {
        setFeedback({ ok: false, text: '供应商配置已更改或停用，请重新选择。' })
        return
      }
      const id = modelId.trim()
      const found = [...provider.models, ...catalog].find((model) => model.id === id)
      const model = { ...(found ?? { id, name: id }), enabled: true }
      const models = provider.models.some((item) => item.id === id) ? provider.models.map((item) => item.id === id ? model : item) : [...provider.models, model]
      const updated = { ...provider, models }
      await saveSettings({ ai: { ...current, enabled: true, activeProviderId: updated.id, baseUrl: updated.baseUrl,
        apiFormat: updated.apiFormat, apiKey: updated.apiKey, apiKeyEncrypted: updated.apiKeyEncrypted, model: id,
        providers: existing.map((item) => item.id === updated.id ? updated : item) } })
      if (mounted.current) onContinue()
    } catch {
      if (mounted.current) setFeedback({ ok: false, text: '保存模型配置失败，请重试；当前选择仍保留。' })
    } finally { lock.current = false; if (mounted.current) updateBusy(null) }
  }

  const models = Array.from(new Map([...(selected?.models ?? []), ...catalog].map((model) => [model.id, model])).values())
  const actions = <div className="flex flex-wrap items-center gap-3"><Button variant="ghost" disabled={busy !== null} onClick={onSkip}>暂不配置</Button><Button variant="primary" disabled={!selected?.enabled || !modelId.trim() || busy !== null || !hasIpc} onClick={() => void continueWithModel()}>{busy === 'save' && <Loader2 size={14} className="motion-safe:animate-spin" />}保存并继续<ArrowRight size={15} aria-hidden="true" /></Button></div>
  return <section aria-label="模型连接" className="space-y-5">
    {!hasIpc && <p role="alert" className="text-my-sm text-my-danger-text">模型设置服务不可用，请在桌面应用中重试。</p>}
    {!ai && hasIpc && <p role="status" className="text-my-sm text-my-secondary">正在加载模型设置…</p>}
    <div className="space-y-2">
      {providers.length > 0 && <><label htmlFor="onboarding-provider" className="my-item-title block">已配置的供应商</label>
      <div className="flex flex-wrap gap-2">
        <Select
          id="onboarding-provider"
          className="min-w-0 flex-1"
          value={providerId}
          disabled={!ai || !hasIpc || busy !== null}
          onChange={chooseProvider}
          options={[
            { value: '', label: '选择供应商' },
            ...providers.map((provider) => ({
              value: provider.id,
              label: `${provider.name}${provider.enabled ? '' : '（已停用）'}`
            }))
          ]}
        />
        {selected && <Button variant="outline" disabled={busy !== null} onClick={() => setEditor({ provider: { ...selected }, original: source(selected) })}>编辑</Button>}
      </div></>}
      <p className="onboarding-section-label">{providers.length ? '添加供应商' : '选择模型服务'}</p>
      <div className="onboarding-model-templates" aria-label="添加供应商">
        {OFFICIAL_TEMPLATES.map((template) => <button type="button" className="onboarding-model-template" key={template.id} disabled={!ai || !hasIpc || busy !== null} onClick={() => openNew(template)}><ProviderIdentity name={template.name} local={template.apiFormat === 'ollama'} /><span><strong>{template.name}</strong><small>{template.apiFormat === 'ollama' ? '本机模型服务' : '使用 API 密钥'}</small></span><Plus size={14} aria-hidden="true" /></button>)}
        <button type="button" className="onboarding-model-template" disabled={!ai || !hasIpc || busy !== null} onClick={() => openNew('custom')}><ProviderIdentity name="+" /><span><strong>自定义服务</strong><small>配置兼容的 API 地址</small></span><Plus size={14} aria-hidden="true" /></button>
      </div>
      <p className="text-my-xs text-my-secondary">密钥使用系统保护；系统加密不可用时可能以明文保存在本机。</p>
    </div>
    {selected && <div className="rounded-my-base border border-my-line bg-my-layer-2 p-4 space-y-4">
      <div className="flex items-center gap-3"><ProviderIdentity name={selected.name} local={selected.apiFormat === 'ollama'} /><div className="min-w-0"><p className="my-item-title">{selected.name}</p><p className="text-my-xs text-my-secondary">{selected.enabled ? selected.apiKeyEncrypted ? '密钥已保存' : selected.apiKey ? '密钥已保存（未加密）' : selected.apiFormat === 'ollama' ? '本地服务' : '尚未配置密钥' : '供应商已停用，请编辑后启用'}</p></div></div>
      <div className="space-y-2"><label htmlFor="onboarding-model" className="my-item-title block">模型</label>
        <div className="flex flex-wrap gap-2">
          <Select
            id="onboarding-model"
            className="min-w-0 flex-1"
            value={modelId}
            disabled={busy !== null || !selected.enabled}
            onChange={(val) => { setModelId(val); setFeedback(null) }}
            options={[
              { value: '', label: '选择模型' },
              ...(modelId && !models.some((model) => model.id === modelId) ? [{ value: modelId, label: modelId }] : []),
              ...models.map((model) => ({ value: model.id, label: model.name || model.id }))
            ]}
          />
          <Button variant="outline" disabled={busy !== null || !selected.enabled} onClick={() => void runRequest('fetch')}>{busy === 'fetch' ? <Loader2 size={14} className="motion-safe:animate-spin" /> : <RefreshCw size={14} />}获取模型</Button></div>
        <div className="flex flex-wrap gap-2"><input className="my-input min-w-0 flex-1" aria-label="手动输入模型 ID" placeholder="或手动输入模型 ID" value={manualId} disabled={busy !== null || !selected.enabled} onChange={(event) => setManualId(event.target.value)} /><Button variant="ghost" disabled={!manualId.trim() || busy !== null || !selected.enabled} onClick={() => { setModelId(manualId.trim()); setFeedback(null) }}>使用此 ID</Button></div>
      </div>
      <Button variant="outline" disabled={!modelId.trim() || busy !== null || !selected.enabled} onClick={() => void runRequest('test')}>{busy === 'test' ? <Loader2 size={14} className="motion-safe:animate-spin" /> : <Zap size={14} />}测试模型推理</Button>
      <p className="text-my-xs text-my-secondary">推理测试会调用供应商 API，可能产生费用。</p>
    </div>}
    {feedback && <p role={feedback.ok ? 'status' : 'alert'} className={`text-my-sm ${feedback.ok ? 'text-my-success-text' : 'text-my-danger-text'}`}>{feedback.text}</p>}
    {footerSlot ? createPortal(actions, footerSlot) : actions}
    {editor && <ModelProviderEditor key={editor.provider.id} provider={editor.provider} isNew={editor.original === null} onClose={() => setEditor(null)} onSave={saveProvider} />}
  </section>
}
