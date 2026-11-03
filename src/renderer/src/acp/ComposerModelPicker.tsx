import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { Check, ChevronDown, Loader2, ShieldCheck, SlidersHorizontal, Plus, Lightbulb, ChevronRight, ArrowLeft, Info, Minimize2 } from 'lucide-react'
import { Dropdown, DropdownHeader, DropdownItem, Tooltip } from '../my/ui'
import { Select } from '../components/Select'
import { ConnectionNotice } from './ConnectionNotice'
import { getModelRecovery } from './model-recovery'
import { projectRootKey } from '../my/navigation'
import type { AcpConfigureInput, AcpSessionRecord } from '../../../shared/types'

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
export function ComposerModelPicker({ session, message, operationPending = false, isCurrent, acquireConfiguration, configureSession, onUpdated, onRecoverModel, contextActions, usage, sendAction }: {
  session: AcpSessionRecord
  message?: string
  operationPending?: boolean
  isCurrent: () => boolean
  acquireConfiguration: () => (() => void) | undefined
  configureSession: (input: AcpConfigureInput) => Promise<{ ok: boolean; error?: string; session?: AcpSessionRecord }>
  onUpdated: (session: AcpSessionRecord) => void
  onRecoverModel: (modelId: string) => Promise<void>
  contextActions?: (close: () => void) => ReactNode
  usage?: ReactNode
  sendAction?: ReactNode
}): JSX.Element {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [modelView, setModelView] = useState<'settings' | 'models'>('settings')
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
  const options = session.configOptions ?? []
  const modelConfigs = options.filter((option) => option.category === 'model')
  const modeConfigs = options.filter((option) => option.category === 'mode')
  const canSetConfig = controls.includes('session/set_config_option')
  const modelConfig = modelConfigs.length === 1 && canSetConfig ? modelConfigs[0] : undefined
  const modeConfig = modeConfigs.length === 1 && canSetConfig ? modeConfigs[0] : undefined
  const reasoning = options.find((option) => /reasoning|effort|thinking/i.test(`${option.id} ${option.name} ${option.category ?? ''}`) && option.category !== 'model' && option.category !== 'mode')
  const hasReasoning = Boolean(reasoning?.options.length)
  const showModels = recoveryMode || !hasReasoning || modelView === 'models'
  const collaboration = options.find((option) => option.options.length > 0 && /collaboration/i.test(`${option.id} ${option.name}`))
  const models = recoveryMode ? recovery.models : modelConfig ? modelConfig.options.map((option) => ({ modelId: option.value, name: option.name })) : session.models ?? []
  const modes = modeConfig ? modeConfig.options.map((option) => ({ id: option.value, name: option.name })) : session.modes ?? []
  const currentId = (recoveryMode && modelConfigs.length === 1 ? modelConfigs[0].currentValue : modelConfig?.currentValue) ?? session.currentModelId
  const currentMode = modeConfig?.currentValue ?? session.currentModeId
  const modeName = modes.find((mode) => mode.id === currentMode)?.name ?? currentMode ?? '未报告模式'
  const modeCaption = session.engine === 'pi' && currentMode ? piModeLabels[currentMode]?.short ?? modeName : choiceLabel(modeName)
  const currentName = models.find((model) => model.modelId === currentId)?.name ?? currentId
  const modelCaption = session.engine === 'pi' ? currentName : currentName?.split(' · ')[0]
  const excluded = new Set([modelConfig?.id, modeConfig?.id, reasoning?.id, collaboration?.id])
  const extraOptions = options.filter((option) => option.options.length > 0 && !excluded.has(option.id) && !(option.category === 'model' && (recoveryMode || controls.includes('session/set_model'))) && !(option.category === 'mode' && controls.includes('session/set_mode')))
  const canConfigure = session.status === 'ready' && Boolean(session.connectionGeneration) && !session.restorePending && !session.archivedAt && !session.cleanupRequired && !busy
  const configure = async (input: AcpConfigureInput, close?: () => void): Promise<void> => {
    if (lock.current || !isCurrent() || !canConfigure) return
    const release = acquireConfiguration()
    if (!release) return
    lock.current = true; setPending(true); setError('')
    try {
      const response = await configureSession(input)
      if (!isCurrent()) return
      if (response.ok && response.session && response.session.sessionId === session.sessionId && projectRootKey(response.session.projectRoot) === projectRootKey(session.projectRoot) && response.session.connectionGeneration === session.connectionGeneration) {
        if ((response.session.stateRevision ?? 0) >= (latestSession.current.stateRevision ?? 0)) onUpdated(response.session)
        close?.()
      }
      else setError(response.error ?? '执行引擎未确认修改，保留原配置。')
    } catch (cause) { if (isCurrent()) setError(cause instanceof Error ? cause.message : '配置修改失败') }
    finally { release(); lock.current = false; if (mounted.current) setPending(false) }
  }
  const recoverModel = async (modelId: string, close: () => void): Promise<void> => {
    if (lock.current || !isCurrent() || busy || !recoveryMode || !recovery.models.some((model) => model.modelId === modelId)) return
    lock.current = true; setPending(true); setError('')
    try {
      await onRecoverModel(modelId)
      if (isCurrent()) close()
    } catch (cause) { if (isCurrent()) setError(cause instanceof Error ? cause.message : '模型恢复失败') }
    finally { lock.current = false; if (mounted.current) setPending(false) }
  }
  const selectedEffort = reasoning?.options.findIndex((option) => option.value === reasoning.currentValue) ?? -1
  const effortName = reasoning?.options.find((option) => option.value === reasoning.currentValue)?.name ?? reasoning?.currentValue
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
  const effortFraction = selectedEffort < 0 ? 0 : selectedEffort / Math.max(1, (reasoning?.options.length ?? 1) - 1)
  const effortInset = 12 - 24 * effortFraction
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
          {busy && <div role="status" className="flex items-center gap-2 px-3 py-2 text-my-sm text-my-tertiary"><Loader2 size={12} className="acp-progress-spinner" aria-hidden="true" /><span>{recoveryMode || session.status === 'starting' ? '连接中…' : '更新中…'}</span></div>}
        </div>}
      </Dropdown>
      {regularModes.length > 0 && <Dropdown align="left" width={240} trigger={({ open, toggle }) => <button type="button" className="acp-composer-context acp-mode-trigger my-composer-control my-composer-control-label" aria-label={`选择会话模式，当前：${modeName}`} aria-expanded={open} title={`会话模式：${modeName}`} onClick={toggle}><ShieldCheck size={14} /><span>{modeCaption}</span><ChevronDown size={12} /></button>}>
        {(close) => <div className="acp-mode-menu"><DropdownHeader>会话模式</DropdownHeader>{session.engine !== 'pi' && <p className="acp-mode-menu-note">选项由执行引擎提供，具体权限以引擎设置为准。</p>}{regularModes.map((mode) => <DropdownItem key={mode.id} selected={mode.id === currentMode} disabled={!canConfigure || (!modeConfig && !controls.includes('session/set_mode'))} onClick={() => selectMode(mode.id, close)}>{choiceLabel(mode.name)}{session.engine === 'pi' && piModeLabels[mode.id] && <small className="acp-mode-description">{piModeLabels[mode.id].description}</small>}</DropdownItem>)}</div>}
      </Dropdown>}
      {planActive && !(nativePlanMode && regularModes.length > 0) && <span className="acp-plan-active"><Lightbulb size={12} />计划</span>}
    </div>
    <div ref={controlsRightRef} className="acp-composer-controls-right">
      {usage}
      <Dropdown align="right" width={256} positionAnchorRef={controlsRightRef} placement="top" gap={8} layoutKey={recoveryMode ? 'recovery' : showModels ? 'models' : 'settings'} trigger={({ open, toggle }) => <button type="button" className="acp-composer-context acp-model-trigger my-composer-control my-composer-control-label" aria-label={hasReasoning && !recoveryMode ? '选择模型与推理强度' : '选择模型'} aria-expanded={open} aria-haspopup="true" title={currentName} onClick={() => { if (!open) setModelView(recoveryMode ? 'models' : 'settings'); toggle() }}>{busy && <Loader2 size={12} className="acp-progress-spinner" />}<span>{modelCaption ?? (session.status === 'starting' ? '连接中…' : '选择模型')}</span>{!recoveryMode && reasoning && reasoning.options.length > 0 && effortName && <small className="acp-model-effort">{choiceLabel(effortName)}</small>}<ChevronDown size={12} /></button>}>
        {(close) => <div className={showModels ? 'acp-model-menu my-scrollbar acp-model-choices' : 'acp-model-menu'}>
          {showModels ? <><div className="acp-model-view-header my-menu-header">{!recoveryMode && hasReasoning && <button type="button" className="my-composer-control" aria-label="返回推理强度" onClick={() => setModelView('settings')}><ArrowLeft size={14} /></button>}<span className="flex-1">选择模型</span>{recoveryMode && <Tooltip label="历史候选；选择后重连，由执行引擎验证可用性。" side="bottom" align="right" wrap><button type="button" className="my-icon-control my-composer-control" aria-label="模型恢复说明"><Info size={14} aria-hidden="true" /></button></Tooltip>}</div><div className="acp-model-list">{models.length > 0 ? models.map((model) => <DropdownItem key={model.modelId} selected={currentId === model.modelId} disabled={recoveryMode ? busy : !canConfigure || (!modelConfig && !controls.includes('session/set_model'))} onClick={() => { if (recoveryMode) void recoverModel(model.modelId, close); else if (currentId === model.modelId) setModelView('settings'); else void configure(modelConfig ? { kind: 'config', id: modelConfig.id, value: model.modelId } : { kind: 'model', id: model.modelId }, () => setModelView('settings')) }}>{model.name}</DropdownItem>) : <div role="status" className="flex items-center gap-2 px-3 py-2 text-my-sm text-my-secondary">{session.status === 'starting' ? <Loader2 size={12} className="acp-progress-spinner" aria-hidden="true" /> : <Info size={14} aria-hidden="true" />}<span>{session.status === 'starting' ? '加载中…' : '暂无可用模型'}</span></div>}</div></> : <section className="acp-reasoning-menu acp-model-settings">
            {reasoning && <strong>{choiceLabel(effortName ?? reasoning.currentValue)}</strong>}
            <button type="button" className="acp-model-caption my-composer-control" aria-label="进入模型选择" title={currentName} onClick={() => setModelView('models')}><span>{modelCaption ?? '选择模型'}</span><ChevronRight size={12} /></button>
            {reasoning && reasoning.options.length > 0 && <div className="acp-effort-track" role="radiogroup" aria-label="推理强度"><span className="acp-effort-fill" style={{ width: selectedEffort < 0 ? '0px' : `calc(${effortFraction * 100}% ${effortInset < 0 ? '-' : '+'} ${Math.abs(effortInset)}px)` }} />{reasoning.options.map((option, index) => <button key={option.value} type="button" role="radio" aria-checked={option.value === reasoning.currentValue} aria-label={choiceLabel(option.name)} title={choiceLabel(option.name)} disabled={!canConfigure || !canSetConfig} className={option.value === reasoning.currentValue ? 'is-selected' : index < selectedEffort ? 'is-before' : ''} onClick={() => void configure({ kind: 'config', id: reasoning.id, value: option.value }, close)}><span /></button>)}</div>}
          </section>}
          {busy && (!showModels || models.length > 0) && <div role="status" className="flex items-center gap-2 px-3 py-2 text-my-sm text-my-tertiary"><Loader2 size={12} className="acp-progress-spinner" aria-hidden="true" /><span>{recoveryMode || session.status === 'starting' ? '连接中…' : '更新中…'}</span></div>}
        </div>}
      </Dropdown>
      {sendAction}
    </div>
    {error && <div className="acp-composer-config-error"><ConnectionNotice message={error} /></div>}
  </div>
}
