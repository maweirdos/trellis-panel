import { useCallback, useState, type JSX } from 'react'
import { ArrowLeft, ArrowRight, Check, Laptop, Moon, ShieldCheck, Sun, Users } from 'lucide-react'
import { useApp } from '../store'
import { useCrux } from '../crux/store'
import { ConnectionPanel } from '../crux/ConnectionPanel'
import { Button } from '../my/ui'
import { OnboardingShell } from './OnboardingShell'
import { AgentDiscoveryStep } from './AgentDiscoveryStep'
import { ModelSetupStep } from './ModelSetupStep'
import './onboarding-wizard.css'

const steps = [
  { id: 'welcome', label: '欢迎', description: '选择界面外观' },
  { id: 'model', label: '连接模型', description: '可稍后设置' },
  { id: 'permissions', label: '工作方式', description: '了解操作权限' },
  { id: 'agents', label: '本机 Agent', description: '发现已有工具' },
  { id: 'account', label: '团队协作', description: '可免登录使用' },
  { id: 'ready', label: '准备就绪', description: '开始使用' }
] as const

interface Props {
  onFinish: (outcome: 'completed' | 'skipped') => Promise<void>
  onDefer: () => void
  storageUnavailable?: boolean
}

export function OnboardingWizard({ onFinish, onDefer, storageUnavailable = false }: Props): JSX.Element {
  const [step, setStep] = useState(0)
  const [accountOpen, setAccountOpen] = useState(false)
  const [footerSlot, setFooterSlot] = useState<HTMLDivElement | null>(null)
  const bindFooter = useCallback((element: HTMLDivElement | null) => setFooterSlot(element), [])
  const [skippedModel, setSkippedModel] = useState(false)
  const [childBusy, setChildBusy] = useState(false)
  const [agentSummary, setAgentSummary] = useState<{ detected: number; total: number } | null>(null)
  const [savingTheme, setSavingTheme] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const [error, setError] = useState('')
  const settings = useApp((state) => state.settings)
  const saveSettings = useApp((state) => state.saveSettings)
  const workspace = useCrux((state) => state.workspaceContext)
  const current = steps[step]
  const next = (): void => { setError(''); setStep((value) => Math.min(value + 1, steps.length - 1)) }
  const back = (): void => { setError(''); setStep((value) => Math.max(value - 1, 0)) }
  const finish = async (outcome: 'completed' | 'skipped'): Promise<void> => {
    if (finishing || savingTheme || childBusy) return
    setFinishing(true)
    setError('')
    try { await onFinish(outcome) } catch { setError('未能保存设置进度，请重试。') } finally { setFinishing(false) }
  }
  const chooseTheme = async (theme: 'light' | 'dark'): Promise<void> => {
    if (savingTheme) return
    setSavingTheme(true); setError('')
    try { await saveSettings({ theme }) } catch { setError('外观未能保存，请重试。') } finally { setSavingTheme(false) }
  }
  const descriptions = [
    '先选择喜欢的外观，其他设置以后也可以调整。',
    '添加模型服务，供应用内 AI 和 Pi 使用；也可以先跳过。',
    '不同 Agent 的操作权限由各自会话控制。',
    '发现这台电脑上的 Agent，稍后也能在设置中管理。',
    '可以先在本机使用，也可以连接团队与同事协作。',
    '检查当前选择，接下来就可以开始工作。'
  ]
  const titles = ['欢迎使用 Trellis Panel', '连接一个模型', '了解 Agent 的工作权限', '发现本机 Agent', '连接团队（可选）', '准备就绪']
  const provider = settings?.ai.providers?.find((item) => item.id === settings.ai.activeProviderId)
  const teamLabel = workspace.state === 'local' ? '本机个人使用' : workspace.state === 'connected' ? workspace.projectName ?? '已连接工作区' : workspace.state === 'offline' ? `${workspace.projectName ?? '团队工作区'} · 离线` : `${workspace.projectName ?? '团队工作区'} · 访问不可用`
  const footer = <div className="onboarding-actions">
    {step > 0 && <Button variant="ghost" disabled={finishing || savingTheme || childBusy} onClick={back}><ArrowLeft size={15} />返回</Button>}
    <span className="onboarding-actions__spacer" />
    {step !== 5 && <Button variant="ghost" disabled={finishing || savingTheme || childBusy} onClick={() => void finish('skipped')}>跳过引导</Button>}
    {step === 1 && <div ref={bindFooter} />}
    {step !== 1 && <Button variant="primary" disabled={finishing || savingTheme || childBusy} onClick={step === 5 ? () => void finish('completed') : next}>{step === 5 ? finishing ? '正在保存…' : '开始使用' : step === 4 && workspace.state === 'local' ? '暂不登录，继续' : '继续'}<ArrowRight size={15} /></Button>}
  </div>
  return <>
    <OnboardingShell steps={steps.map((item, index) => ({ ...item, description: index === 1 && skippedModel && step > 1 ? '已跳过，可稍后设置' : item.description, completed: index < step && !(index === 1 && skippedModel) }))} currentStepId={current.id}
      title={titles[step]} description={descriptions[step]} footer={footer}
      sidebarFooter={<span>你的工作从这里开始<br />本机数据由你掌握</span>}>
      {(error || storageUnavailable) && <div role="alert" className="onboarding-error"><p>{error || '暂时无法保存引导进度，完成时会重试。'}</p><Button variant="ghost" size="sm" disabled={finishing || savingTheme || childBusy} onClick={onDefer}>不保存，稍后在设置中打开</Button></div>}
      {step === 0 && <div className="onboarding-welcome">
        <span className="onboarding-section-label">界面语言</span><p>简体中文</p>
        <span className="onboarding-section-label">外观</span>
        <div className="onboarding-theme-grid">{([['light', '浅色', Sun], ['dark', '深色', Moon]] as const).map(([value, label, Icon]) => <button type="button" key={value} className="onboarding-theme-choice" aria-pressed={settings?.theme === value} disabled={savingTheme} onClick={() => void chooseTheme(value)}><span className={`onboarding-theme-preview is-${value}`}><span /><span /><span /></span><span><Icon size={16} />{label}{settings?.theme === value && <Check size={15} />}</span></button>)}</div>
      </div>}
      {step === 1 && <ModelSetupStep footerSlot={footerSlot} onBusyChange={setChildBusy} onContinue={() => { setSkippedModel(false); next() }} onSkip={() => { setSkippedModel(true); next() }} />}
      {step === 2 && <div className="onboarding-permissions"><div><ShieldCheck size={20} /><span><strong>按会话选择权限</strong><small>Pi 默认使用工作区模式；涉及写入等操作时会请求授权。</small></span></div><div><Laptop size={20} /><span><strong>外部 Agent 使用自己的权限设置</strong><small>Codex、Claude Code 等引擎的可选模式以实际会话显示为准。</small></span></div></div>}
      {step === 3 && <AgentDiscoveryStep onInventory={setAgentSummary} onBusyChange={setChildBusy} />}
      {step === 4 && <div className="onboarding-account"><div><Laptop size={20} /><span><strong>本机个人使用</strong><small>无需账号，数据保存在这台电脑。</small></span>{workspace.state === 'local' && <Check size={16} />}</div><div><Users size={20} /><span><strong>团队协作</strong><small>{workspace.state === 'local' ? '在桌面登录或注册，创建或加入工作区。' : teamLabel}</small></span><Button variant="outline" onClick={() => setAccountOpen(true)}>{workspace.state === 'local' ? '登录 / 注册' : '管理账号'}</Button></div></div>}
      {step === 5 && <div className="onboarding-summary"><div><span>外观</span><strong>{settings?.theme === 'system' ? '跟随系统' : settings?.theme === 'light' ? '浅色' : '深色'}</strong></div><div><span>模型</span><strong>{settings?.ai.enabled && settings.ai.model ? `${provider ? `${provider.name} · ` : ''}${settings.ai.model} · 连接状态以实际测试为准` : '尚未配置'}</strong></div><div><span>工作方式</span><strong>按会话控制权限</strong></div><div><span>本机 Agent</span><strong>{agentSummary ? `发现 ${agentSummary.detected} 项可启动条件，连接状态以实际检查为准` : '尚未检查'}</strong></div><div><span>团队</span><strong>{teamLabel}</strong></div></div>}
    </OnboardingShell>
    <ConnectionPanel hideTrigger open={accountOpen} returnToOnboarding initialStep={workspace.state === 'local' ? 'auth' : 'accounts'} onOpenChange={setAccountOpen} />
  </>
}
