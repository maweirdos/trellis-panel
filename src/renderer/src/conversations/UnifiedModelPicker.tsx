import { useMemo, useState, type JSX, type Ref, type RefObject } from 'react'
import { cleanModelDisplayName } from '@shared/model-selection'
import { ModelSelectionPanel, saveRecentModel, type ModelSelectionOption, type ModelSelectionTuning } from '../model-selection/ModelSelectionPanel'
import { setDraftSelection, useConversations, type WorkspaceEntry } from './workspace'
import { DefaultModelAction } from './DefaultModelAction'

const DRAFT_TUNING_STORAGE_KEY = 'my-draft-tuning-effort'

const DRAFT_TUNING_OPTIONS = [
  { value: 'off', label: '关' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'max', label: '超高' }
]

export function UnifiedModelPicker({
  current,
  disabled = false,
  triggerRef,
  positionAnchorRef,
  onOpenModelSettings,
  onOpenRuntimeSettings
}: {
  current: WorkspaceEntry
  disabled?: boolean
  triggerRef?: Ref<HTMLButtonElement>
  positionAnchorRef?: RefObject<HTMLElement | null>
  onOpenModelSettings?: () => void
  onOpenRuntimeSettings?: () => void
}): JSX.Element | null {
  const runtimes = useConversations((state) => state.runtimes)
  const piModels = useConversations((state) => state.piModels)
  const defaultPiModelId = useConversations((state) => state.defaultPiModelId)

  const [effort, setEffort] = useState<string>(() => {
    try {
      return localStorage.getItem(DRAFT_TUNING_STORAGE_KEY) || 'high'
    } catch {
      return 'high'
    }
  })

  const currentRuntime = runtimes.find((runtime) => runtime.id === current.runtimeId)
  const currentModelId = current.modelId ?? defaultPiModelId
  const selectedModel = piModels.find((model) => model.id === currentModelId)
  const rawCaption = current.modelTooLong ? '模型 ID 超长' : selectedModel?.label ?? (currentModelId ? '所选模型' : '选择模型')
  const modelCaption = selectedModel?.label ? cleanModelDisplayName(selectedModel.label, 'pi') : rawCaption
  const usingPi = current.runtimeId === 'pi'
  const nativeDefault = currentRuntime && !usingPi
  const triggerLabel = nativeDefault ? currentRuntime.name : usingPi ? modelCaption : '选择模型'

  const enabledRuntimes = useMemo(
    () => runtimes.filter((runtime) => runtime.enabled && runtime.available).map((runtime) => ({ id: runtime.id, name: runtime.name, brand: runtime.id === 'code' ? 'codex' : runtime.id })),
    [runtimes]
  )
  const options = useMemo(() => enabledRuntimes.flatMap<ModelSelectionOption>((runtime) => {
    if (runtime.id === 'pi' && piModels.length) {
      return piModels.map((model) => ({ runtimeId: runtime.id, modelId: model.id, name: model.label, disabled: !model.available, brand: runtime.brand }))
    }
    return [{ runtimeId: runtime.id, name: runtime.name, brand: runtime.brand }]
  }), [enabledRuntimes, piModels])

  const tuning = useMemo<ModelSelectionTuning>(() => ({
    label: '思考强度',
    value: effort,
    options: DRAFT_TUNING_OPTIONS,
    disabled: disabled || Boolean(current.action),
    onChange: (val) => {
      setEffort(val)
      try {
        localStorage.setItem(DRAFT_TUNING_STORAGE_KEY, val)
      } catch {
        // ignore
      }
    }
  }), [effort, disabled, current.action])

  return (
    <ModelSelectionPanel
      disabled={disabled || Boolean(current.action) || Boolean(current.conversation?.nativeRef)}
      triggerRef={triggerRef}
      positionAnchorRef={positionAnchorRef}
      triggerLabel={triggerLabel}
      triggerDescription={nativeDefault ? '使用该执行引擎的默认模型' : usingPi && selectedModel ? `当前模型：${modelCaption}` : '尚未选择可用模型'}
      triggerBrand={currentRuntime?.id === 'code' ? 'codex' : currentRuntime?.id}
      runtimes={enabledRuntimes}
      options={options}
      selectedRuntimeId={current.runtimeId}
      selectedModelId={usingPi && piModels.length ? currentModelId : undefined}
      selected={Boolean(currentRuntime?.enabled && currentRuntime.available && (!usingPi || !piModels.length || selectedModel?.available))}
      onSelect={(option, close) => {
        if (!setDraftSelection(current.key, option.runtimeId, option.modelId)) return
        if (option.modelId) saveRecentModel(option.modelId, option.runtimeId)
        close()
      }}
      defaultAction={usingPi && selectedModel?.available ? <DefaultModelAction modelId={currentModelId} /> : undefined}
      onOpenModelSettings={onOpenModelSettings}
      onOpenRuntimeSettings={onOpenRuntimeSettings}
      tuning={tuning}
    />
  )
}
