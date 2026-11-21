import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode, type Ref } from 'react'
import { Check, ChevronDown, Loader2, ShieldCheck, SlidersHorizontal, Plus, Lightbulb, Minimize2 } from 'lucide-react'
import { Dropdown, DropdownHeader, DropdownItem } from '../my/ui'
import { Select } from '../components/Select'
import { ConnectionNotice } from './ConnectionNotice'
import { getModelRecovery } from './model-recovery'
import { projectRootKey } from '../my/navigation'
import type { AcpConfigureInput, AcpSessionRecord } from '../../../shared/types'
import { modelIdWithinLimit, cleanModelDisplayName } from '@shared/model-selection'
import { ModelSelectionPanel, saveRecentModel, type ModelSelectionAction, type ModelSelectionOption, type ModelSelectionTuning } from '../model-selection/ModelSelectionPanel'
import { DefaultModelAction } from '../conversations/DefaultModelAction'

function choiceLabel(name: string): string {
  const labels: Record<string, string> = { low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高', minimal: '最低', none: '关闭', default: '默认', plan: '计划模式', 'auto review': '自动审核', 'read only': '只读', readonly: '只读', workspace: '工作区读写', 'workspace access': '工作区访问', 'workspace write': '工作区读写', 'full access': '完全访问' }
  const key = name.trim().toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ')
  return labels[key] ?? name
}

const piModeLabels: Record<string, { short: string; description: string }> = {
  'read-only': { short: '只读', description: '允许只读类工具，拒绝其他工具。' },
  workspace: { short: '请求批准', description: '只读类工具直接运行，其他工具须逐次批准。' },
  'full-access': { short: '自动批准', description: '工具自动批准，路径工具仍受目录校验。' }
}

/** All advertised current-session controls live inside the composer. */
export function ComposerModelPicker({ session, message, operationPending = false, requireModelConfirmation = false, isCurrent, acquireConfiguration, configureSession, onUpdated, onRecoverModel, onReconnect, onOpenModelSettings, onOpenRuntimeSettings, contextActions, usage, sendAction, triggerRef }: {
  session: AcpSessionRecord
  message?: string
  operationPending?: boolean
  requireModelConfirmation?: boolean
  isCurrent: () => boolean
  acquireConfiguration: () => (() => void) | undefined
  configureSession: (input: AcpConfigureInput) => Promise<{ ok: boolean; error?: string; session?: AcpSessionRecord }>
  onUpdated: (session: AcpSessionRecord) => void
  onRecoverModel?: (modelId: string) => Promise<boolean>
  onReconnect?: () => Promise<void>
  onOpenModelSettings?: () => void
  onOpenRuntimeSettings?: () => void
  contextActions?: (close: () => void) => ReactNode
  usage?: ReactNode
  sendAction?: ReactNode
  triggerRef?: Ref<HTMLButtonElement>
}): JSX.Element {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const lock = useRef(false)
  const mounted = useRef(true)
  const latestSession = useRef(session)
  latestSession.current = session
  const controlsRightRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const controls = session.capabilities?.controls ?? []
  const recovery = getModelRecovery(session, message)
  const recoveryMode = recovery.canRecoverModel
  const busy = pending || operationPending
  const configurationProgress = pending || session.status === 'starting'
  const options = session.configOptions ?? []
  const modelConfigs = options.filter((option) => option.category === 'model')
  const modeConfigs = options.filter((option) => option.category === 'mode')
  const canSetConfig = controls.includes('session/set_config_option')
  const modelConfig = modelConfigs.length === 1 && canSetConfig ? modelConfigs[0] : undefined
  const modeConfig = modeConfigs.length === 1 && canSetConfig ? modeConfigs[0] : undefined
  const reasoning = options.find((option) => /reasoning|effort|thinking/i.test(`${option.id} ${option.name} ${option.category ?? ''}`) && option.category !== 'model' && option.category !== 'mode')
  const collaboration = options.find((option) => option.options.length > 0 && /collaboration/i.test(`${option.id} ${option.name}`))
  const models = recoveryMode ? recovery.models : modelConfig ? modelConfig.options.map((option) => ({ modelId: option.value, name: option.name })) : session.models ?? []
  const modes = modeConfig ? modeConfig.options.map((option) => ({ id: option.value, name: option.name })) : session.modes ?? []
  const currentId = (recoveryMode && modelConfigs.length === 1 ? modelConfigs[0].currentValue : modelConfig?.currentValue) ?? session.currentModelId
  const currentMode = modeConfig?.currentValue ?? session.currentModeId
  const modeName = modes.find((mode) => mode.id === currentMode)?.name ?? currentMode ?? '未报告模式'
  const modeCaption = session.engine === 'pi' && currentMode ? piModeLabels[currentMode]?.short ?? modeName : choiceLabel(modeName)
  const currentName = models.find((model) => model.modelId === currentId)?.name ?? currentId
  const modelCaption = cleanModelDisplayName(currentName, session.engine)
  const runtimeName = session.runtimeSnapshot?.name
  const canConfigure = session.status === 'ready' && Boolean(session.connectionGeneration) && !session.restorePending && !session.archivedAt && !session.cleanupRequired && !busy
  const canSelectModel = recoveryMode ? !busy && Boolean(onRecoverModel) : canConfigure && Boolean(modelConfig || controls.includes('session/set_model'))
  const connectedModel = ['ready', 'busy', 'awaiting_permission', 'cancelling'].includes(session.status) && Boolean(session.connectionGeneration) && !session.restorePending && !session.archivedAt && !session.cleanupRequired
  const modelState = recoveryMode ? '上次记录' : requireModelConfirmation ? '待确认' : connectedModel ? '当前模型' : '已记录模型'
  const excluded = new Set([modelConfig?.id, modeConfig?.id, reasoning?.id, collaboration?.id])
  const extraOptions = options.filter((option) => option.options.length > 0 && !excluded.has(option.id) && !(option.category === 'model' && (recoveryMode || controls.includes('session/set_model'))) && !(option.category === 'mode' && controls.includes('session/set_mode')))
  const hasOverlongModelId = models.some((model) => !modelIdWithinLimit(model.modelId))
  const runtimeId = session.engine ?? 'unknown'
  const panelOptions = useMemo<ModelSelectionOption[]>(() => models.map((model) => ({
    runtimeId,
    modelId: model.modelId,
    name: model.name,
    brand: runtimeId,
    disabled: !modelIdWithinLimit(model.modelId) || !canSelectModel
  })), [canSelectModel, models, runtimeId])
  const configure = async (input: AcpConfigureInput, close?: () => void, expectedModelId?: string): Promise<boolean> => {
    if (lock.current || !isCurrent() || !canConfigure) return false
    const release = acquireConfiguration()
    if (!release) return false
    lock.current = true; setPending(true); setError('')
    try {
      const response = await configureSession(input)
      if (!isCurrent()) return false
      if (response.ok && response.session && response.session.sessionId === session.sessionId && projectRootKey(response.session.projectRoot) === projectRootKey(session.projectRoot) && response.session.connectionGeneration === session.connectionGeneration) {
        if ((response.session.stateRevision ?? 0) >= (latestSession.current.stateRevision ?? 0)) onUpdated(response.session)
        const confirmedModel = input.kind === 'config' ? response.session.configOptions?.find((option) => option.id === input.id)?.currentValue : response.session.currentModelId
        if (expectedModelId && confirmedModel !== expectedModelId) {
          setError('执行引擎尚未确认所选模型。')
          return false
        }
        close?.()
        return true
      }
      else setError(response.error ?? '执行引擎未确认修改，保留原配置。')
    } catch (cause) { if (isCurrent()) setError(cause instanceof Error ? cause.message : '配置修改失败') }
    finally { release(); lock.current = false; if (mounted.current) setPending(false) }
    return false
  }
  const recoverModel = async (modelId: string, close: () => void): Promise<void> => {
    if (!onRecoverModel || lock.current || !isCurrent() || busy || !recoveryMode || !recovery.models.some((model) => model.modelId === modelId)) return
    lock.current = true; setPending(true); setError('')
    try {
      if (await onRecoverModel(modelId)) {
        saveRecentModel(modelId, runtimeId)
        if (isCurrent()) close()
      }
    } catch (cause) { if (isCurrent()) setError(cause instanceof Error ? cause.message : '模型恢复失败') }
    finally { lock.current = false; if (mounted.current) setPending(false) }
  }
  const selectModel = (option: ModelSelectionOption, close: () => void): void => {
    const { modelId } = option
    if (!modelId) return
    if (recoveryMode) {
      void recoverModel(modelId, close)
      return
    }
    if (currentId === modelId && !requireModelConfirmation) {
      close()
      return
    }
    void configure(modelConfig ? { kind: 'config', id: modelConfig.id, value: modelId } : { kind: 'model', id: modelId }, close, modelId)
      .then((confirmed) => { if (confirmed) saveRecentModel(modelId, option.runtimeId) })
  }
  const planModes = modes.filter((mode) => /plan|计划/i.test(`${mode.id} ${mode.name}`))
  const regularModes = modes.filter((mode) => !planModes.some((plan) => plan.id === mode.id))
  const previousRegularMode = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (regularModes.some((mode) => mode.id === currentMode)) previousRegularMode.current = currentMode
  }, [currentMode, regularModes])
  const planChoice = collaboration?.options.find((option) => /plan|计划/i.test(`${option.value} ${option.name}`))
  const normalChoice = collaboration?.options.find((option) => /^(default|normal|默认|普通)$/i.test(option.value) || /^(default|normal|默认|普通)$/i.test(option.name))
    ?? (collaboration && collaboration.options.length === 2 ? collaboration.options.find((option) => option.value !== planChoice?.value) : undefined)
  const collaborationToggle = Boolean(planChoice && normalChoice && planChoice.value !== normalChoice.value)
  const nativePlanMode = planModes.some((mode) => mode.id === currentMode)
  const planActive = collaborationToggle ? collaboration?.currentValue === planChoice?.value : nativePlanMode
  const nativeNormal = regularModes.find((mode) => mode.id === previousRegularMode.current)
    ?? regularModes.find((mode) => /^(default|normal|默认|普通)$/i.test(`${mode.id}`) || /^(default|normal|默认|普通)$/i.test(mode.name))
    ?? (regularModes.length === 1 ? regularModes[0] : undefined)
  const showPlan = collaborationToggle || planModes.length === 1
  const canTogglePlan = canConfigure && (collaborationToggle ? canSetConfig : Boolean((modeConfig || controls.includes('session/set_mode')) && (!planActive || nativeNormal)))
  const advancedOptions = [...extraOptions, ...(collaboration && (!collaborationToggle || collaboration.options.length > 2) ? [collaboration] : [])]
  const panelRecoveryActions = useMemo<ModelSelectionAction[]>(() => {
    if (busy || !onReconnect || recovery.modelFailure || recovery.environmentRequired || session.canResume !== true || session.cleanupRequired || session.archivedAt !== undefined || !['closed', 'disconnected', 'error'].includes(session.status)) return []
    return [{ key: 'reconnect', label: '重试连接', onClick: () => void onReconnect() }]
  }, [busy, onReconnect, recovery.modelFailure, recovery.environmentRequired, session])
  const tuning = useMemo<ModelSelectionTuning | undefined>(() => {
    if (!reasoning?.options.length) return undefined
    return {
      label: '推理强度',
      value: reasoning.currentValue,
      options: reasoning.options.map((option) => ({ value: option.value, label: choiceLabel(option.name) })),
      disabled: !canConfigure || !canSetConfig,
      onChange: (value) => void configure({ kind: 'config', id: reasoning.id, value })
    }
  }, [canConfigure, canSetConfig, configure, reasoning])
  const selectMode = (id: string, close: () => void): void => {
    if (id === currentMode) close()
    else void configure(modeConfig ? { kind: 'config', id: modeConfig.id, value: id } : { kind: 'mode', id }, close)
  }
  return <div className="acp-composer-controls">
    <div className="acp-composer-controls-left">
      <Dropdown align="left" width={290} trigger={({ open, toggle }) => <button type="button" className="acp-composer-add my-composer-control" aria-label="添加与会话选项" aria-expanded={open} onClick={toggle}><Plus size={19} /></button>}>
        {(close) => <div className="acp-add-menu my-scrollbar">
          <DropdownHeader>添加</DropdownHeader>
          {contextActions?.(close)}
          {session.engine === 'pi' && <DropdownItem icon={<Minimize2 size={14} />} disabled={!canConfigure} onClick={() => void configure({ kind: 'config', id: 'compact', value: '' }, close)}>压缩上下文</DropdownItem>}
          {showPlan && <button type="button" className="acp-plan-toggle my-menu-item" aria-pressed={Boolean(planActive)} disabled={!canTogglePlan} onClick={() => {
            if (collaborationToggle && collaboration && planChoice && normalChoice) void configure({ kind: 'config', id: collaboration.id, value: planActive ? normalChoice.value : planChoice.value }, close)
            else { const next = planActive ? nativeNormal?.id : planModes[0]?.id; if (next) selectMode(next, close) }
          }}><Lightbulb size={14} /><span className="flex-1">计划模式</span>{planActive && <Check size={13} />}</button>}
          {advancedOptions.length > 0 && <details className="acp-add-advanced"><summary className="my-menu-item"><SlidersHorizontal size={14} />其他会话参数<ChevronDown size={12} /></summary><div className="acp-model-options">{advancedOptions.map((option) => <label key={option.id}>{option.name}<Select ariaLabel={option.name} className="w-full" value={option.currentValue} disabled={!canConfigure || !canSetConfig} onChange={(value) => void configure({ kind: 'config', id: option.id, value })} options={option.options.map((value) => ({ value: value.value, label: choiceLabel(value.name) }))} /></label>)}</div></details>}
          {configurationProgress && <div role="status" className="flex items-center gap-2 px-3 py-2 text-my-sm text-my-tertiary"><Loader2 size={12} className="acp-progress-spinner" aria-hidden="true" /><span>{recoveryMode || session.status === 'starting' ? '连接中…' : '更新中…'}</span></div>}
        </div>}
      </Dropdown>
      {regularModes.length > 0 && <Dropdown align="left" width={240} trigger={({ open, toggle }) => <button type="button" className="acp-composer-context acp-mode-trigger my-composer-control my-composer-control-label" aria-label={`选择会话模式，当前：${modeName}`} aria-expanded={open} title={`会话模式：${modeName}`} onClick={toggle}><ShieldCheck size={14} /><span>{modeCaption}</span><ChevronDown size={12} /></button>}>
        {(close) => <div className="acp-mode-menu"><DropdownHeader>会话模式</DropdownHeader>{session.engine !== 'pi' && <p className="acp-mode-menu-note">选项由执行引擎提供，具体权限以引擎设置为准。</p>}{regularModes.map((mode) => <DropdownItem key={mode.id} selected={mode.id === currentMode} disabled={!canConfigure || (!modeConfig && !controls.includes('session/set_mode'))} description={session.engine === 'pi' ? piModeLabels[mode.id]?.description : undefined} onClick={() => selectMode(mode.id, close)}>{session.engine === 'pi' ? piModeLabels[mode.id]?.short ?? choiceLabel(mode.name) : choiceLabel(mode.name)}</DropdownItem>)}</div>}
      </Dropdown>}
      {planActive && !(nativePlanMode && regularModes.length > 0) && <span className="acp-plan-active"><Lightbulb size={12} />计划</span>}
    </div>
    <div ref={controlsRightRef} className="acp-composer-controls-right">
      {usage}
      <ModelSelectionPanel
        triggerRef={triggerRef}
        positionAnchorRef={controlsRightRef}
        triggerLabel={modelCaption || (session.status === 'starting' ? '连接中…' : '选择模型')}
        triggerDescription={`${runtimeName ? `执行引擎：${runtimeName}，` : ''}${currentName ? `${modelState}：${currentName}` : '选择模型'}`}
        triggerBrand={runtimeId}
        triggerLoading={configurationProgress}
        runtimes={[{ id: runtimeId, name: runtimeName ?? runtimeId, brand: runtimeId }]}
        options={panelOptions}
        selectedRuntimeId={runtimeId}
        selectedModelId={currentId}
        selected={!requireModelConfirmation || recoveryMode}
        onSelect={selectModel}
        loading={session.status === 'starting' && models.length === 0}
        emptyText={recoveryMode ? '暂无可验证的历史模型' : hasOverlongModelId ? '模型 ID 超过 8192 UTF-8 字节时无法选择' : canSelectModel ? '暂无可用模型' : '恢复连接后可调整'}
        defaultAction={session.engine === 'pi' && connectedModel ? <DefaultModelAction modelId={currentId} /> : null}
        onOpenModelSettings={onOpenModelSettings}
        onOpenRuntimeSettings={onOpenRuntimeSettings}
        recoveryActions={panelRecoveryActions}
        tuning={tuning}
      />
      {sendAction}
    </div>
    {error && <div className="acp-composer-config-error"><ConnectionNotice message={error} /></div>}
  </div>
}
