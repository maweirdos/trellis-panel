import { useEffect, useId, useRef, useState, type JSX } from 'react'
import { Loader2, X } from 'lucide-react'
import type { AcpAgentStatus, AcpRuntimeDefaults } from '../../../shared/types'
import { hasIpc } from '../api'
import { Button, Modal } from '../my/ui'
import { useApp } from '../store'
import { useInteractionGuard, useInteractionSignal } from '../utils/interaction-scope'
import { RuntimeConfigFields, type RuntimeConfigSection } from './RuntimeConfigFields'
import { cleanRuntimeConfig, runtimeConfigError, type RuntimeConfigValue } from './runtime-config'

export function RuntimeDefaultsEditor({ runtimeId, launchKind, name, initial, targetAvailable = true, isCurrent, onClose, onSaved }: {
  runtimeId: string
  launchKind?: AcpAgentStatus['launchKind']
  name: string
  initial?: AcpRuntimeDefaults
  targetAvailable?: boolean
  isCurrent: () => boolean
  onClose: () => void
  onSaved: () => void
}): JSX.Element {
  const id = useId()
  const [draft, setDraft] = useState<RuntimeConfigValue>(() => ({ ...initial }))
  const [section, setSection] = useState<RuntimeConfigSection>('model')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const availableRef = useRef(targetAvailable)
  availableRef.current = targetAvailable
  const lock = useRef(false)
  const tabButtons = useRef<Partial<Record<RuntimeConfigSection, HTMLButtonElement>>>({})
  const mounted = useRef(false)
  const canInteract = useInteractionGuard()
  const signal = useInteractionSignal()
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const current = (): boolean => mounted.current && isCurrent() && canInteract() && !signal?.aborted
  const close = (): void => { if (!lock.current) onClose() }
  const save = async (): Promise<void> => {
    if (lock.current || !hasIpc || !current() || !availableRef.current) return
    const invalid = runtimeConfigError(draft, launchKind)
    if (invalid) { setError(invalid); setSection(invalid.includes('模型 ID') ? 'model' : invalid.includes('环境变量') ? 'env' : 'args'); return }
    lock.current = true; setPending(true); setError('')
    try {
      const cleaned = cleanRuntimeConfig(draft, { launchKind })
      const defaults: AcpRuntimeDefaults = {
        ...(cleaned.modelId ? { modelId: cleaned.modelId } : {}),
        ...(cleaned.env?.length ? { env: cleaned.env } : {}),
        ...(cleaned.args?.length ? { args: cleaned.args } : {})
      }
      await useApp.getState().saveSettings({ acp: { runtimeDefaults: { [runtimeId]: defaults } } })
      if (current()) {
        if (availableRef.current) onSaved()
        else setSaved(true)
      }
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : '保存失败，请重试。') }
    finally { lock.current = false; if (mounted.current) setPending(false) }
  }
  const tabs: Array<{ key: RuntimeConfigSection; label: string }> = [{ key: 'model', label: '模型' }, { key: 'env', label: '变量' }, { key: 'args', label: '参数' }]
  return <Modal open onClose={close} width={600} ariaLabel={`${name} 默认配置`} placement="center">
    <form className="runtime-defaults-editor" onSubmit={event => { event.preventDefault(); void save() }}>
      <header className="runtime-defaults-header"><div className="min-w-0 flex-1"><h2 className="text-my-lg font-medium text-my-primary">{name}</h2><p className="mt-1 text-my-xs text-my-tertiary">引擎默认配置 · 新会话生效</p></div><Button variant="ghost" disabled={pending} aria-label="关闭默认配置" onClick={close}><X size={16} /></Button></header>
      <div role="tablist" aria-label="默认配置分类" className="runtime-defaults-tabs" onKeyDown={event => {
        if (pending || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const index = tabs.findIndex(tab => tab.key === section)
        const next = tabs[event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]
        if (next) { setSection(next.key); tabButtons.current[next.key]?.focus() }
      }}>{tabs.map(tab => <button type="button" key={tab.key} ref={button => { tabButtons.current[tab.key] = button ?? undefined }} id={`${id}-${tab.key}`} role="tab" tabIndex={section === tab.key ? 0 : -1} aria-selected={section === tab.key} aria-controls={`${id}-panel`} disabled={pending} className={`my-control my-control-sm ${section === tab.key ? 'my-button-neutral' : 'my-button-ghost'}`} onClick={() => setSection(tab.key)}>{tab.label}</button>)}</div>
      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${section}`} className="runtime-defaults-body my-scrollbar"><RuntimeConfigFields value={draft} runtimeId={runtimeId} launchKind={launchKind} section={section} disabled={pending || !targetAvailable} onChange={patch => setDraft(previous => ({ ...previous, ...patch }))} /></div>
      {!targetAvailable && <p role="status" className="runtime-config-error text-my-sm text-my-secondary">{pending ? '引擎已移除；正在完成已提交的保存。' : '引擎已移除，无法再次保存。'}</p>}
      {saved && <p role="status" className="runtime-config-error text-my-sm text-my-secondary">默认配置已保存。</p>}
      {error && <p role="alert" className="runtime-config-error text-my-sm text-my-danger-text">{error}</p>}
      <footer className="runtime-defaults-footer"><Button variant="ghost" disabled={pending} onClick={close}>{saved ? '关闭' : '取消'}</Button><button type="submit" className="my-control my-button-primary" disabled={pending || !hasIpc || !targetAvailable}>{pending && <Loader2 size={13} className="animate-spin" />}{pending ? '保存中…' : '保存'}</button></footer>
    </form>
  </Modal>
}
