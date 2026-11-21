import { useMemo, type JSX, type Ref, type RefObject } from 'react'
import { cleanModelDisplayName } from '@shared/model-selection'
import { ModelSelectionPanel, saveRecentModel, type ModelSelectionOption } from '../model-selection/ModelSelectionPanel'
import { setDraftSelection, useConversations, type WorkspaceEntry } from './workspace'
import { DefaultModelAction } from './DefaultModelAction'

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
    />
  )
}
