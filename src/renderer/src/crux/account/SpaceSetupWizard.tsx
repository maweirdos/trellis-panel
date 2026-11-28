import { useState, type JSX } from 'react'
import {
  ArrowLeft, BarChart3, Briefcase, Check, ClipboardList, Code2, Cog, DollarSign,
  FolderKanban, Headphones, Layers, LoaderCircle, Megaphone, Package, Palette, Scale,
  Sparkles, TrendingUp, Users, Wrench
} from 'lucide-react'
import type { CruxInitialTaskType, CruxSpace, CruxSpaceModules, CruxSpaceTemplate } from '@shared/crux'
import {
  DEFAULT_SPACE_MODULES,
  deriveSpaceKeyFromName,
  getSpaceTemplatePreset,
  SPACE_MODULE_META,
  SPACE_TEMPLATE_PRESETS
} from '@shared/crux-space-presets'
import { api } from '../../api'
import { Button, Checkbox, Tooltip } from '../../my/ui'
import { Select } from '../ui'
import { useCrux } from '../store'

const ALL_TASK_TYPES: CruxInitialTaskType[] = ['需求', 'Bug', '任务', '内容']

function templateIcon(template: CruxSpaceTemplate): JSX.Element {
  switch (template) {
    case 'software': return <Code2 size={18} />
    case 'product': return <Package size={18} />
    case 'marketing': return <Megaphone size={18} />
    case 'design': return <Palette size={18} />
    case 'project': return <ClipboardList size={18} />
    case 'operations': return <Cog size={18} />
    case 'it': return <Wrench size={18} />
    case 'hr': return <Users size={18} />
    case 'support': return <Headphones size={18} />
    case 'legal': return <Scale size={18} />
    case 'finance': return <DollarSign size={18} />
    case 'sales': return <TrendingUp size={18} />
    case 'data': return <BarChart3 size={18} />
    case 'other': return <Layers size={18} />
  }
}

export interface SpaceSetupWizardProps {
  mode: 'initialize' | 'create'
  space?: CruxSpace
  organizationName?: string | null
  onComplete: (spaceId: string) => void
  onSkip?: () => void
  onCancel?: () => void
}

export function SpaceSetupWizard({
  mode,
  space,
  organizationName,
  onComplete,
  onSkip,
  onCancel
}: SpaceSetupWizardProps): JSX.Element {
  const run = useCrux((state) => state.run)
  const busy = useCrux((state) => state.busy)
  const [step, setStep] = useState<'template' | 'modules'>('template')
  const [template, setTemplate] = useState<CruxSpaceTemplate>(space?.template ?? 'software')
  const [name, setName] = useState(space?.name ?? (mode === 'initialize' ? '默认空间' : ''))
  const [key, setKey] = useState(space?.key ?? '')
  const [keyEdited, setKeyEdited] = useState(false)
  const [visibility, setVisibility] = useState<'public' | 'private'>(space?.visibility ?? 'public')
  const [taskTypes, setTaskTypes] = useState<CruxInitialTaskType[]>(() => getSpaceTemplatePreset(space?.template ?? 'software').defaultTaskTypes)
  const [enabledModules, setEnabledModules] = useState<CruxSpaceModules>(() => space?.enabledModules ?? getSpaceTemplatePreset(space?.template ?? 'software').defaultModules)
  const [seedStarterTask, setSeedStarterTask] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const chooseTemplate = (nextTemplate: CruxSpaceTemplate): void => {
    const preset = getSpaceTemplatePreset(nextTemplate)
    setTemplate(nextTemplate)
    setTaskTypes([...preset.defaultTaskTypes])
    setEnabledModules({ ...preset.defaultModules })
    setError(null)
    if (mode === 'initialize') setStep('modules')
  }

  const toggleTaskType = (type: CruxInitialTaskType): void => {
    setTaskTypes((current) => {
      if (current.includes(type)) {
        return current.length > 1 ? current.filter((item) => item !== type) : current
      }
      return ALL_TASK_TYPES.filter((item) => item === type || current.includes(item))
    })
  }

  const toggleModule = (moduleKey: keyof CruxSpaceModules): void => {
    setEnabledModules((current) => ({ ...current, [moduleKey]: !current[moduleKey] }))
  }

  const normalizedKey = key.trim().toUpperCase()
  const keyValid = mode === 'initialize' || /^[A-Z0-9]{2,7}$/.test(normalizedKey)
  const nameValid = name.trim().length > 0

  const handleNameChange = (value: string): void => {
    setName(value)
    if (mode === 'create' && !keyEdited) {
      setKey(deriveSpaceKeyFromName(value))
    }
    setError(null)
  }

  const submit = async (): Promise<void> => {
    if (submitting || busy) return
    if (!nameValid) {
      setError('请输入空间名称。')
      return
    }
    if (!keyValid) {
      setError('任务前缀需为 2～7 位大写字母或数字。')
      return
    }
    if (taskTypes.length === 0) {
      setError('请至少选择一种任务类型。')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      if (mode === 'initialize' && space) {
        const result = await run('初始化空间', () => api.crux.updateSpace({
          id: space.id,
          name: name.trim(),
          template,
          enabledModules,
          initialTaskTypes: taskTypes,
          initialized: true,
          seedStarterTask
        }))
        if (!result || !result.ok) {
          setError(result && !result.ok ? result.error : '空间初始化未完成，请重试。')
          return
        }
        onComplete(space.id)
      } else {
        const result = await run('创建空间', () => api.crux.createSpace({
          name: name.trim(),
          key: normalizedKey,
          visibility,
          template,
          enabledModules,
          initialTaskTypes: taskTypes,
          initialized: true,
          seedStarterTask
        }))
        if (!result || !result.ok) {
          setError(result && !result.ok ? result.error : '创建空间失败，请重试。')
          return
        }
        const created = result.data.spaces.find((item) => item.key === normalizedKey)
        if (!created) {
          setError('空间已提交但未在快照中找到，请刷新查看。')
          return
        }
        onComplete(created.id)
      }
    } finally {
      setSubmitting(false)
    }
  }

  const handleSkipInitialize = async (): Promise<void> => {
    if (!space || submitting || busy) return
    setSubmitting(true)
    setError(null)
    try {
      await run('使用默认配置', () => api.crux.updateSpace({
        id: space.id,
        template: 'software',
        enabledModules: DEFAULT_SPACE_MODULES,
        initialized: true,
        seedStarterTask: true
      }))
      if (onSkip) onSkip()
      else onComplete(space.id)
    } finally {
      setSubmitting(false)
    }
  }

  const activePreset = getSpaceTemplatePreset(template)
  const working = submitting || busy
  const nextDisabledReason = !nameValid ? '请先输入空间名称' : !keyValid ? '任务前缀需为 2～7 位大写字母或数字' : null
  const submitDisabledReason = !nameValid ? '请输入空间名称' : !keyValid ? '任务前缀需为 2～7 位大写字母或数字' : taskTypes.length === 0 ? '请至少选择一种任务类型' : null

  const nextButton = (
    <Button
      variant="primary"
      size="sm"
      disabled={working || Boolean(nextDisabledReason)}
      onClick={() => setStep('modules')}
    >
      下一步：配置模块
    </Button>
  )

  const submitButton = (
    <Button
      variant="primary"
      size="sm"
      disabled={working || Boolean(submitDisabledReason)}
      onClick={() => void submit()}
    >
      {working && <LoaderCircle size={14} className="account-spinner" aria-hidden="true" />}
      {mode === 'initialize' ? '完成并进入空间' : '创建空间'}
    </Button>
  )

  return <section className="space-wizard" aria-label={mode === 'initialize' ? '初始化默认空间' : '新建空间'}>
    <header className="space-wizard-header">
      <div className="space-wizard-eyebrow">
        <Sparkles size={14} aria-hidden="true" />
        <span>{mode === 'initialize' ? `初始化默认空间${organizationName ? ` · ${organizationName}` : ''}` : '新建团队空间'}</span>
        <span className="space-wizard-step-pill">{step === 'template' ? '1 / 2' : '2 / 2'}</span>
      </div>
      <h2>{step === 'template' ? '该空间主要做什么类型的工作？' : '设置你的空间'}</h2>
      <p>{step === 'template'
        ? '这有助于我们为你的空间推荐合适的任务类型和功能模块，后续随时可以调整。'
        : `已按「${activePreset.label}」预选常用配置，勾选你当前真正需要的模块即可。`}</p>
    </header>

    {error && <div role="alert" className="account-inline-error">{error}</div>}

    <div key={step} className="my-subview-stage flex min-h-0 flex-1 flex-col">
    {step === 'template' ? (
      <div className="space-wizard-body my-scrollbar">
        {mode === 'create' && (
          <div className="space-wizard-basics">
            <label className="space-wizard-field">
              <span>空间名称</span>
              <input
                className="my-input"
                autoFocus
                disabled={working}
                placeholder="例如：研发空间、产品规划"
                value={name}
                onChange={(event) => handleNameChange(event.target.value)}
              />
            </label>
            <label className="space-wizard-field">
              <span>任务前缀</span>
              <input
                className="my-input font-mono"
                maxLength={7}
                disabled={working}
                placeholder="ENG"
                value={key}
                onChange={(event) => { setKeyEdited(true); setKey(event.target.value.toUpperCase()); setError(null) }}
              />
            </label>
            <label className="space-wizard-field">
              <span>访问范围</span>
              <Select
                className="w-full"
                value={visibility}
                disabled={working}
                onChange={(value) => setVisibility(value === 'private' ? 'private' : 'public')}
                options={[
                  { value: 'public', label: '组织内公开' },
                  { value: 'private', label: '私有（仅成员可见）' }
                ]}
              />
            </label>
          </div>
        )}

        <div className="space-template-grid" role="radiogroup" aria-label="空间工作类型">
          {SPACE_TEMPLATE_PRESETS.map((preset) => {
            const selected = preset.id === template
            return (
              <button
                key={preset.id}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={working}
                onClick={() => chooseTemplate(preset.id)}
                className="space-template-card"
                data-selected={selected || undefined}
              >
                <span className="space-template-icon" aria-hidden="true">{templateIcon(preset.id)}</span>
                <strong className="space-template-title">{preset.label}</strong>
                <span className="space-template-desc">{preset.description}</span>
              </button>
            )
          })}
        </div>
      </div>
    ) : (
      <div className="space-wizard-body my-scrollbar">
        {mode === 'initialize' && (
          <div className="space-wizard-rename">
            <label className="space-wizard-field">
              <span>空间名称</span>
              <input
                className="my-input"
                disabled={working}
                value={name}
                onChange={(event) => { setName(event.target.value); setError(null) }}
                placeholder="默认空间"
              />
            </label>
            <div className="space-wizard-key-badge">
              <span>任务前缀</span>
              <code>{space?.key ?? 'MAIN'}</code>
            </div>
          </div>
        )}

        <section className="space-wizard-section">
          <h3>任务类型</h3>
          <div className="space-toggle-grid">
            {ALL_TASK_TYPES.map((type) => {
              const checked = taskTypes.includes(type)
              return (
                <button
                  key={type}
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  disabled={working}
                  onClick={() => toggleTaskType(type)}
                  className="space-toggle-card"
                  data-checked={checked || undefined}
                >
                  <Briefcase size={15} className="shrink-0" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{type}</span>
                  <span className="space-toggle-check" aria-hidden="true">{checked && <Check size={12} />}</span>
                </button>
              )
            })}
          </div>
        </section>

        <section className="space-wizard-section">
          <h3>功能模块</h3>
          <div className="space-toggle-grid">
            <div className="space-toggle-card is-locked" data-checked="true" aria-label="任务（核心模块常开）">
              <FolderKanban size={15} className="shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">任务（核心）</span>
              <span className="space-toggle-check" aria-hidden="true"><Check size={12} /></span>
            </div>
            {SPACE_MODULE_META.map((item) => {
              const checked = enabledModules[item.key]
              return (
                <button
                  key={item.key}
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  disabled={working}
                  title={item.description}
                  onClick={() => toggleModule(item.key)}
                  className="space-toggle-card"
                  data-checked={checked || undefined}
                >
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  <span className="space-toggle-check" aria-hidden="true">{checked && <Check size={12} />}</span>
                </button>
              )
            })}
          </div>
          <label className="space-wizard-starter-option">
            <Checkbox
              checked={seedStarterTask}
              disabled={working}
              ariaLabel="自动生成 1 条示例任务"
              onChange={setSeedStarterTask}
            />
            <span>自动生成 1 条示例任务，进入空间后可直接体验看板与派发</span>
          </label>
          <p className="space-wizard-hint">别担心，这些模块和任务类型后续随时可以在空间设置中修改。</p>
        </section>
      </div>
    )}
    </div>

    <footer className="space-wizard-footer">
      {step === 'modules' ? (
        <Button variant="ghost" size="sm" disabled={working} onClick={() => setStep('template')}>
          <ArrowLeft size={14} />返回上一步
        </Button>
      ) : onCancel ? (
        <Button variant="ghost" size="sm" disabled={working} onClick={onCancel}>取消</Button>
      ) : mode === 'initialize' ? (
        <Button variant="ghost" size="sm" disabled={working} onClick={() => void handleSkipInitialize()}>暂用默认配置跳过</Button>
      ) : <span />}

      <div className="flex items-center gap-2">
        {step === 'template' ? (
          mode === 'create' && nextDisabledReason ? <Tooltip label={nextDisabledReason}>{nextButton}</Tooltip> : nextButton
        ) : (
          submitDisabledReason ? <Tooltip label={submitDisabledReason}>{submitButton}</Tooltip> : submitButton
        )}
      </div>
    </footer>
  </section>
}
