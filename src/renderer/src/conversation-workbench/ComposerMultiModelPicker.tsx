import type { JSX } from 'react'
import { Check, Columns2, X } from 'lucide-react'
import { Dropdown, DropdownDivider, DropdownHeader } from '../my/ui'
import type { ComposerModel } from './useComposerSend'
import { fanoutModelKey, MAX_FANOUT_MODELS } from './useMultipleModelSend'
import './conversation-enhancements.css'

export interface ComposerMultiModelPickerProps {
  readonly models: readonly ComposerModel[]
  readonly selectedModels: readonly ComposerModel[]
  readonly disabled: boolean
  readonly onToggleModel: (model: ComposerModel) => void
  readonly onClear: () => void
}

export function ComposerMultiModelPicker({
  models,
  selectedModels,
  disabled,
  onToggleModel,
  onClear,
}: ComposerMultiModelPickerProps): JSX.Element | null {
  if (models.length < 2) return null
  const selectedKeys = new Set(selectedModels.map((model) => fanoutModelKey(model)))
  const count = selectedModels.length

  return (
    <Dropdown
      disabled={disabled}
      placement="top"
      align="right"
      width={280}
      trigger={({ open, toggle }) => (
        <button
          type="button"
          className="my-composer-control conversation-fanout-trigger inline-flex shrink-0 items-center gap-1 px-1.5 text-my-xs"
          data-active={count >= 2 ? 'true' : undefined}
          title={count >= 2 ? `已选 ${count} 个模型并行对比发送` : '多模型并行对比（最多选 4 个模型）'}
          aria-label={count >= 2 ? `多模型并行发送，已选 ${count} 个模型` : '多模型并行发送'}
          aria-expanded={open}
          disabled={disabled}
          onClick={toggle}
        >
          <Columns2 size={14} aria-hidden="true" />
          {count > 0 && <span className="tabular-nums">{count}</span>}
        </button>
      )}
    >
      {(close) => (
        <div className="flex flex-col gap-0.5 p-1">
          <div className="flex items-center justify-between px-2 py-1">
            <DropdownHeader>多模型并行对比（2-{MAX_FANOUT_MODELS} 个）</DropdownHeader>
            {count > 0 && (
              <button
                type="button"
                className="my-icon-control"
                title="清空多选"
                aria-label="清空多模型选择"
                onClick={() => { onClear(); close() }}
              >
                <X size={12} aria-hidden="true" />
              </button>
            )}
          </div>
          <p className="px-2 pb-1 text-my-2xs text-my-tertiary">
            勾选 2 个及以上模型后，发送将同时创建各自独立的对比会话。
          </p>
          <DropdownDivider />
          <div className="conversation-stash-list my-scrollbar">
            {models.map((model) => {
              const key = fanoutModelKey(model)
              const checked = selectedKeys.has(key)
              const limitReached = !checked && count >= MAX_FANOUT_MODELS
              return (
                <button
                  key={key}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={checked}
                  disabled={limitReached}
                  className="conversation-fanout-option"
                  onClick={() => onToggleModel(model)}
                >
                  <span className="conversation-fanout-check" data-checked={checked ? 'true' : undefined}>
                    {checked && <Check size={11} aria-hidden="true" />}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-my-xs text-my-primary">{model.displayName}</span>
                  <span className="shrink-0 text-my-2xs text-my-tertiary">{model.instanceId}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </Dropdown>
  )
}
