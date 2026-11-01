import { useId, type JSX } from 'react'
import { Plus, X } from 'lucide-react'
import type { AcpAgentStatus } from '../../../shared/types'
import { Select } from '../components/Select'
import { Button } from '../my/ui'
import { useApp } from '../store'
import { runtimeModelOptions, type RuntimeConfigValue } from './runtime-config'
import './runtime-panel.css'

export type RuntimeConfigSection = 'model' | 'env' | 'args'

/** Engine defaults and role overrides share the same editable fields. */
export function RuntimeConfigFields({ value, runtimeId, launchKind, onChange, disabled = false, role = false, section }: {
  value: RuntimeConfigValue
  runtimeId: string
  launchKind?: AcpAgentStatus['launchKind']
  onChange: (patch: RuntimeConfigValue) => void
  disabled?: boolean
  role?: boolean
  section?: RuntimeConfigSection
}): JSX.Element {
  const id = useId()
  const ai = useApp(state => state.settings?.ai)
  const defaults = useApp(state => state.settings?.acp?.runtimeDefaults?.[runtimeId])
  const sdk = launchKind === 'sdk'
  const modelOptions = runtimeModelOptions(ai, launchKind)
  const mode = value.modelId === undefined ? role ? 'inherit' : 'automatic' : value.modelId === null ? 'automatic' : 'custom'
  const inheritedModel = defaults?.modelId ? modelOptions.find(option => option.value === defaults.modelId)?.label ?? defaults.modelId : '引擎自动'
  const visible = (key: RuntimeConfigSection): boolean => !section || section === key
  return <div className="runtime-config-fields">
    {visible('model') && <section className="runtime-config-field" aria-labelledby={`${id}-model`}>
      <label id={`${id}-model`} className="my-item-title">{role ? '角色模型' : '默认模型'}</label>
      <Select className="mt-1 w-full" ariaLabel={role ? '角色模型策略' : '引擎默认模型策略'} disabled={disabled} value={mode}
        options={[...(role ? [{ value: 'inherit', label: `继承引擎默认 · ${inheritedModel}` }] : []), { value: 'automatic', label: '引擎自动' }, { value: 'custom', label: '指定模型' }]}
        onChange={next => onChange({ modelId: next === 'inherit' ? undefined : next === 'automatic' ? role ? null : undefined : '' })} />
      {mode === 'custom' && <div className="mt-2 space-y-2">
        {modelOptions.length > 0 && <Select ariaLabel="已配置的 Pi 模型" className="w-full" disabled={disabled} value={value.modelId ?? ''} placeholder="选择已启用的供应商模型"
          options={[...(!modelOptions.some(option => option.value === value.modelId) && value.modelId ? [{ value: value.modelId, label: value.modelId }] : []), ...modelOptions]}
          onChange={modelId => onChange({ modelId })} />}
        <label className="block text-my-xs text-my-tertiary" htmlFor={`${id}-model-id`}>模型 ID</label>
        <input id={`${id}-model-id`} className="my-input w-full font-mono" disabled={disabled} value={value.modelId ?? ''} maxLength={512} spellCheck={false} autoComplete="off"
          placeholder={sdk ? 'provider:model' : '执行引擎的准确模型 ID'} onChange={event => onChange({ modelId: event.target.value })} />
      </div>}
    </section>}
    {visible('env') && <section className="runtime-config-field" aria-labelledby={`${id}-env`}>
      <h3 id={`${id}-env`} className="my-item-title">环境变量{role && <span className="runtime-config-inherited">继承 {defaults?.env?.length ?? 0} 项 · 同名覆盖</span>}</h3>
      <p className="mt-1 text-my-xs text-my-tertiary">明文保存在本机；新会话生效。</p>
      <RuntimeKeyValues rows={value.env ?? []} disabled={disabled} kind="env" onChange={env => onChange({ env })} />
    </section>}
    {visible('args') && <section className="runtime-config-field" aria-labelledby={`${id}-args`}>
      <h3 id={`${id}-args`} className="my-item-title">启动参数{role && !sdk && <span className="runtime-config-inherited">继承 {defaults?.args?.length ?? 0} 项 · 同名覆盖</span>}</h3>
      {sdk ? <p className="my-item-description mt-1">内置 SDK 不支持启动参数。</p> : <RuntimeKeyValues rows={(value.args ?? []).map(({ name, value: text }) => ({ key: name, value: text }))} disabled={disabled} kind="args"
        onChange={rows => onChange({ args: rows.map(({ key, value: text }) => ({ name: key, value: text })) })} />}
    </section>}
  </div>
}

function RuntimeKeyValues({ rows, disabled, kind, onChange }: {
  rows: Array<{ key: string; value: string }>
  disabled: boolean
  kind: 'env' | 'args'
  onChange: (rows: Array<{ key: string; value: string }>) => void
}): JSX.Element {
  const keyLabel = kind === 'env' ? '变量名' : '参数名'
  return <div className="runtime-config-rows">
    {rows.map((row, index) => <div key={index} className="runtime-config-row">
      <input aria-label={`${keyLabel} ${index + 1}`} className="my-input min-w-0 font-mono" value={row.key} disabled={disabled} maxLength={200} spellCheck={false} placeholder={kind === 'env' ? '变量名' : '--flag'}
        onChange={event => onChange(rows.map((item, at) => at === index ? { ...item, key: event.target.value } : item))} />
      <input aria-label={`${kind === 'env' ? '变量值' : '参数值'} ${index + 1}`} className="my-input min-w-0" value={row.value} disabled={disabled} maxLength={4000} placeholder="值（可留空）" autoComplete="off"
        onChange={event => onChange(rows.map((item, at) => at === index ? { ...item, value: event.target.value } : item))} />
      <Button size="sm" variant="ghost" aria-label={`移除${keyLabel} ${index + 1}`} disabled={disabled} onClick={() => onChange(rows.filter((_, at) => at !== index))}><X size={13} /></Button>
    </div>)}
    <Button size="sm" variant="outline" disabled={disabled || rows.length >= 50} onClick={() => onChange([...rows, { key: '', value: '' }])}><Plus size={13} />添加{kind === 'env' ? '变量' : '参数'}</Button>
  </div>
}
