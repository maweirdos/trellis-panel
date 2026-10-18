import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { Check, ChevronDown, Loader2, ShieldCheck, SlidersHorizontal, Plus, Lightbulb, ChevronRight, ArrowLeft } from 'lucide-react'
import { api } from '../api'
import { Dropdown, DropdownHeader, DropdownItem } from '../my/ui'
import { Select } from '../components/Select'
import { ConnectionNotice } from './ConnectionNotice'
import type { AcpConfigureInput, AcpSessionRecord } from '../../../shared/types'

function choiceLabel(name: string): string {
  const labels: Record<string, string> = { low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高', minimal: '最低', none: '关闭', default: '默认', plan: '计划模式', 'auto review': '自动审核', 'read only': '只读' }
  return labels[name.toLowerCase()] ?? name
}

/** All advertised current-session controls live inside the composer. */
export function ComposerModelPicker({ session, isCurrent, onUpdated, contextActions, usage, sendAction }: {
  session: AcpSessionRecord
  isCurrent: () => boolean
  onUpdated: (session: AcpSessionRecord) => void
  contextActions?: (close: () => void) => ReactNode
  usage?: ReactNode
  sendAction?: ReactNode
}): JSX.Element {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [modelView, setModelView] = useState<'settings' | 'models'>('settings')
  const lock = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const controls = session.capabilities?.controls ?? []
  const options = session.configOptions ?? []
  const modelConfigs = options.filter((option) => option.category === 'model')
  const modeConfigs = options.filter((option) => option.category === 'mode')
  const canSetConfig = controls.includes('session/set_config_option')
  const modelConfig = modelConfigs.length === 1 && canSetConfig ? modelConfigs[0] : undefined
  const modeConfig = modeConfigs.length === 1 && canSetConfig ? modeConfigs[0] : undefined
  const reasoning = options.find((option) => /reasoning|effort|thinking/i.test(`${option.id} ${option.name} ${option.category ?? ''}`) && option.category !== 'model' && option.category !== 'mode')
  const collaboration = options.find((option) => option.options.length > 0 && /collaboration/i.test(`${option.id} ${option.name}`))
  const models = modelConfig ? modelConfig.options.map((option) => ({ modelId: option.value, name: option.name })) : session.models ?? []
  const modes = modeConfig ? modeConfig.options.map((option) => ({ id: option.value, name: option.name })) : session.modes ?? []
  const currentId = modelConfig?.currentValue ?? session.currentModelId
  const currentMode = modeConfig?.currentValue ?? session.currentModeId
  const currentName = models.find((model) => model.modelId === currentId)?.name ?? currentId
  const excluded = new Set([modelConfig?.id, modeConfig?.id, reasoning?.id, collaboration?.id])
  const extraOptions = options.filter((option) => option.options.length > 0 && !excluded.has(option.id) && !(option.category === 'model' && controls.includes('session/set_model')) && !(option.category === 'mode' && controls.includes('session/set_mode')))
  const canConfigure = session.status === 'ready' && !pending
  const configure = async (input: AcpConfigureInput, close?: () => void): Promise<void> => {
    if (lock.current || !isCurrent() || !canConfigure) return
    lock.current = true; setPending(true); setError('')
    try {
      const response = await api.acpSessionConfigure(session.sessionId, input)
      if (!isCurrent()) return
      if (response.ok && response.session) { onUpdated(response.session); close?.() }
      else setError(response.error ?? '执行引擎未确认修改，保留原配置。')
    } catch (cause) { if (isCurrent()) setError(cause instanceof Error ? cause.message : '配置修改失败') }
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
      <Dropdown align="left" width={290} trigger={({ open, toggle }) => <button type="button" className="acp-composer-add" aria-label="添加与会话选项" aria-expanded={open} onClick={toggle}><Plus size={19} /></button>}>
        {(close) => <div className="acp-add-menu my-scrollbar">
          <DropdownHeader>添加</DropdownHeader>
          {contextActions?.(close)}
          {showPlan && <button type="button" className="acp-plan-toggle" aria-pressed={Boolean(planActive)} disabled={!canTogglePlan} onClick={() => {
            if (collaborationToggle && collaboration && planChoice && normalChoice) void configure({ kind: 'config', id: collaboration.id, value: planActive ? normalChoice.value : planChoice.value }, close)
            else { const next = planActive ? nativeNormal?.id : planModes[0]?.id; if (next) selectMode(next, close) }
          }}><Lightbulb size={14} /><span>计划模式</span><small>{planActive ? '已开启，点击关闭' : '开启计划模式'}</small>{planActive && <Check size={13} />}</button>}
          {advancedOptions.length > 0 && <details className="acp-add-advanced"><summary><SlidersHorizontal size={14} />其他会话参数<ChevronDown size={12} /></summary><div className="acp-model-options">{advancedOptions.map((option) => <label key={option.id}>{option.name}<Select ariaLabel={option.name} className="w-full" value={option.currentValue} disabled={!canConfigure || !canSetConfig} onChange={(value) => void configure({ kind: 'config', id: option.id, value })} options={option.options.map((value) => ({ value: value.value, label: choiceLabel(value.name) }))} /></label>)}</div></details>}
          {pending && <p role="status" className="px-3 py-2 text-my-sm text-my-tertiary">等待引擎确认…</p>}
        </div>}
      </Dropdown>
      {regularModes.length > 0 && <Dropdown align="left" width={240} trigger={({ open, toggle }) => <button type="button" className="acp-composer-context" aria-label="选择会话模式" aria-expanded={open} onClick={toggle}><ShieldCheck size={14} /><span>{choiceLabel(modes.find((mode) => mode.id === currentMode)?.name ?? '选择模式')}</span><ChevronDown size={12} /></button>}>
        {(close) => <><DropdownHeader>会话模式</DropdownHeader>{regularModes.map((mode) => <DropdownItem key={mode.id} selected={mode.id === currentMode} disabled={!canConfigure || (!modeConfig && !controls.includes('session/set_mode'))} icon={mode.id === currentMode ? <Check size={13} /> : <span />} onClick={() => selectMode(mode.id, close)}>{choiceLabel(mode.name)}</DropdownItem>)}{regularModes.length === 0 && <p className="px-3 py-2 text-my-sm text-my-tertiary">计划选项位于“＋”菜单。</p>}</>}
      </Dropdown>}
      {planActive && !(nativePlanMode && regularModes.length > 0) && <span className="acp-plan-active"><Lightbulb size={12} />计划</span>}
    </div>
    <div className="acp-composer-controls-right">
      {usage}
      <Dropdown align="right" width={modelView === 'models' ? 330 : 270} layoutKey={modelView} trigger={({ open, toggle }) => <button type="button" className="acp-composer-context acp-model-trigger" aria-label="选择模型与推理强度" aria-expanded={open} aria-haspopup="true" title={currentName} onClick={() => { if (!open) setModelView('settings'); toggle() }}>{pending && <Loader2 size={12} className="acp-progress-spinner" />}<span>{currentName?.split(' · ')[0] ?? (session.status === 'starting' ? '正在连接…' : '选择模型')}</span>{reasoning && reasoning.options.length > 0 && effortName && <small className="acp-model-effort">{choiceLabel(effortName)}</small>}<ChevronDown size={12} /></button>}>
        {(close) => <div className="acp-model-menu my-scrollbar">
          {modelView === 'models' ? <><div className="acp-model-view-header"><button type="button" aria-label="返回推理强度" onClick={() => setModelView('settings')}><ArrowLeft size={14} /></button><span>选择模型</span></div><div className="acp-model-list my-scrollbar">{models.length > 0 ? models.map((model) => <DropdownItem key={model.modelId} selected={currentId === model.modelId} disabled={!canConfigure || (!modelConfig && !controls.includes('session/set_model'))} icon={currentId === model.modelId ? <Check size={13} /> : <span />} onClick={() => { if (currentId === model.modelId) setModelView('settings'); else void configure(modelConfig ? { kind: 'config', id: modelConfig.id, value: model.modelId } : { kind: 'model', id: model.modelId }, () => setModelView('settings')) }}>{model.name}</DropdownItem>) : <p className="px-3 py-2 text-my-sm text-my-secondary">{session.status === 'starting' ? '连接后载入模型列表。' : '执行引擎未提供可切换模型。'}</p>}</div></> : <section className="acp-reasoning-menu acp-model-settings">
            <strong>{reasoning && reasoning.options.length > 0 ? choiceLabel(effortName ?? reasoning.currentValue) : '模型设置'}</strong>
            <button type="button" className="acp-model-caption" aria-label="进入模型选择" title={currentName} onClick={() => setModelView('models')}><span>{currentName?.split(' · ')[0] ?? '选择模型'}</span><ChevronRight size={12} /></button>
            {reasoning && reasoning.options.length > 0 ? <div className="acp-effort-track" role="radiogroup" aria-label="推理强度"><span className="acp-effort-fill" style={{ width: selectedEffort < 0 ? '0px' : `calc(${effortFraction * 100}% ${effortInset < 0 ? '-' : '+'} ${Math.abs(effortInset)}px)` }} />{reasoning.options.map((option, index) => <button key={option.value} type="button" role="radio" aria-checked={option.value === reasoning.currentValue} aria-label={choiceLabel(option.name)} title={choiceLabel(option.name)} disabled={!canConfigure || !canSetConfig} className={option.value === reasoning.currentValue ? 'is-selected' : index < selectedEffort ? 'is-before' : ''} onClick={() => void configure({ kind: 'config', id: reasoning.id, value: option.value }, close)}><span /></button>)}</div> : <p className="acp-no-reasoning">此引擎未提供推理强度选项</p>}
          </section>}
          {!canConfigure && <p className="px-3 py-2 text-my-sm text-my-tertiary">连接就绪且当前回复结束后可以修改。</p>}
          {pending && <p role="status" className="px-3 py-2 text-my-sm text-my-tertiary">等待引擎确认…</p>}
        </div>}
      </Dropdown>
      {sendAction}
    </div>
    {error && <div className="acp-composer-config-error"><ConnectionNotice message={error} /></div>}
  </div>
}
