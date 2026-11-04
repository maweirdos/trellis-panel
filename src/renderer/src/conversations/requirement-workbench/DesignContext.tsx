import { useId, useState, type JSX } from 'react'
import { ChevronDown, Palette, X } from 'lucide-react'
import type { RequirementDesignContext, RequirementDesignStandard, RequirementDesignMaterial } from '@shared/requirement-design-context'
import { emptyRequirementDesignContext, requirementDesignSourceKey } from '@shared/requirement-design-context'
import { Button } from '../../my/ui'
import './design-context.css'

type OptionState = 'loading' | 'ready' | 'error' | 'unavailable'
export interface DesignContextProps {
  value: RequirementDesignContext
  // Only pass sources actually available in the current authorized scope.
  standards: RequirementDesignStandard[]
  materials: RequirementDesignMaterial[]
  standardsState: OptionState
  materialsState: OptionState
  disabled?: boolean
  onChange(value: RequirementDesignContext): void
}

const identity = requirementDesignSourceKey

function SourceList<T extends RequirementDesignMaterial>({ title, options, selected, state, disabled, onChange }: {
  title: string; options: T[]; selected: T[]; state: OptionState; disabled?: boolean; onChange(items: T[]): void
}): JSX.Element {
  const [limit, setLimit] = useState(false)
  const current = (item: T): T | undefined => options.find(option => identity(option) === identity(item))
  const missing = selected.filter(item => state !== 'ready' || !current(item) || current(item)?.revision !== item.revision)
  return <fieldset className="requirement-design-context-list" disabled={disabled}>
    <legend className="my-item-title">{title}</legend>
    {state === 'loading' && <p className="my-item-description" role="status">正在读取来源…</p>}
    {state === 'error' && <p className="my-item-description" role="status">来源读取失败，已选内容保留。</p>}
    {state === 'unavailable' && <p className="my-item-description">来源暂不可用，已选内容保留。</p>}
    {state === 'ready' && options.length === 0 && <p className="my-item-description">暂无可选来源。</p>}
    {missing.map(item => <div className="requirement-design-context-unavailable" key={`${identity(item)}:${item.revision}`}><span className="my-item-description">{item.name} · {state === 'ready' && current(item) ? '版本已变化' : '暂不可核实'} · {item.revision.slice(0, 12)}</span><Button size="sm" variant="ghost" disabled={disabled} aria-label={`移除${item.name}`} onClick={() => onChange(selected.filter(value => identity(value) !== identity(item)))}><X size={13} /></Button></div>)}
    {state === 'ready' && options.map(item => {
      const previous = selected.find(value => identity(value) === identity(item))
      const checked = previous?.revision === item.revision
      return <label className="requirement-design-context-option" key={identity(item)}><input type="checkbox" checked={checked} disabled={disabled} onChange={event => {
        const next = selected.filter(value => identity(value) !== identity(item))
        if (event.target.checked) next.push(item)
        if (next.length > 8) { setLimit(true); return }
        setLimit(false); onChange(next)
      }} /><span><span className="my-item-title">{item.name}</span><span className="my-item-description">{item.kind === 'design' ? '设计工作区' : item.kind === 'project-file' ? item.relativePath : '已添加文件'} · {item.revision.slice(0, 12)}{previous && !checked ? ' · 选择当前版本' : ''}</span></span></label>
    })}
    {limit && <p className="my-item-description" role="alert">最多选择 8 项，请先移除其他来源。</p>}
  </fieldset>
}

export function DesignContext({ value, standards, materials, standardsState, materialsState, disabled, onChange }: DesignContextProps): JSX.Element {
  const directionId = useId(), count = value.standards.length + value.materials.length
  return <details className="requirement-design-context">
    <summary className="requirement-workbench-disclosure"><Palette size={14} aria-hidden="true" /><span className="my-item-title">设计语境</span><span className="my-item-description">{count ? `已选 ${count} 项` : value.direction ? '已补充方向' : '可选'}</span><ChevronDown size={12} aria-hidden="true" /></summary>
    <div className="requirement-design-context-body">
      <SourceList title="项目设计规范" options={standards} selected={value.standards} state={standardsState} disabled={disabled} onChange={items => onChange({ ...value, standards: items })} />
      <SourceList title="参考素材" options={materials} selected={value.materials} state={materialsState} disabled={disabled} onChange={items => onChange({ ...value, materials: items })} />
      <label className="requirement-design-context-direction" htmlFor={directionId}><span className="my-item-title">补充方向</span><textarea id={directionId} className="my-input" rows={3} maxLength={4000} placeholder="例如：沿用现有设置页的层级和交互" value={value.direction} disabled={disabled} onChange={event => onChange({ ...value, direction: event.target.value })} /></label>
      {(count > 0 || value.direction) && <div><Button size="sm" variant="ghost" disabled={disabled} onClick={() => onChange(emptyRequirementDesignContext())}><X size={13} />清除设计语境</Button></div>}
    </div>
  </details>
}
