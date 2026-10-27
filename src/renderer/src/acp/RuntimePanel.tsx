import { useEffect, useId, useRef, useState, type JSX } from 'react'
import { Bot, CheckCircle2, ChevronDown, CircleAlert, Download, ExternalLink, FolderOpen, Loader2, MoreHorizontal, PackageCheck, PlugZap, RefreshCw, Settings2, Terminal } from 'lucide-react'
import { api, hasIpc } from '../api'
import { ToolBrandIcon } from '../components/ToolBrandIcon'
import { Button, Dropdown, DropdownItem } from '../my/ui'
import { PreferenceSection } from '../pages/settings/PreferenceSection'
import { useApp } from '../store'
import { useInteractionActive, useInteractionGuard, useInteractionSignal } from '../utils/interaction-scope'
import { useRuntimeInventoryRefresh } from './useRuntimeInventoryRefresh'
import { RuntimeDefaultsEditor } from './RuntimeDefaultsEditor'
import { runtimeDefaultsSummary } from './runtime-config'
import type { AcpAgentStatus, AcpConnectionProbeResult, AcpRuntimeHealth } from '../../../shared/types'
import './runtime-panel.css'

const HEALTH_LABEL: Record<AcpRuntimeHealth, string> = {
  not_checked: '等待连接验证', executable_missing: '本机环境未就绪', adapter_missing: '尚未安装',
  launch_error: '启动失败', incompatible: '协议不兼容', auth_required: '需要登录',
  directory_unavailable: '目录不可用', ready: '启动条件满足'
}

export function runtimeHealthLabel(agent: AcpAgentStatus | undefined): string {
  if (!agent) return '执行引擎未配置'
  if (!agent.enabled) return '未启用'
  if (agent.health && !['ready', 'not_checked'].includes(agent.health)) return HEALTH_LABEL[agent.health]
  if (agent.available && !agent.setupRequired) {
    if (agent.launchKind === 'sdk') return '可用'
    if (agent.health === 'ready') return '连接已验证'
    return agent.launchKind === 'custom' && !agent.executable ? '已配置' : '已安装'
  }
  return agent.setupRequired ? '尚未安装' : '未探测到程序'
}

type RuntimeAction = 'refresh' | 'node' | 'setup' | 'path' | 'test' | 'migration'

function feedbackSource(agent: AcpAgentStatus | undefined): string {
  return JSON.stringify(agent && [agent.id, agent.enabled, agent.launchKind, agent.command, agent.executable, agent.args, agent.nodePath, agent.diagnostics,
    agent.adapterVersion, agent.latestVersion, agent.releaseChannel, agent.updateStatus, agent.setupBlockedReason, agent.availableMigration]) ?? ''
}

/** Shared between the page-owned Agent settings and application runtime settings. */
export function RuntimePanel({ agents, onChange, isCurrent, runtimeId, heading = true, onConfigureModels, onManageAgents, autoRefresh = false, disabled = false, onPendingChange }: {
  agents: AcpAgentStatus[]
  onChange: (agents: AcpAgentStatus[]) => void
  isCurrent: () => boolean
  runtimeId?: string
  heading?: boolean
  onConfigureModels?: () => void
  onManageAgents?: () => void
  autoRefresh?: boolean
  disabled?: boolean
  onPendingChange?: (pending: boolean) => void
}): JSX.Element {
  const sectionId = useId()
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [pending, setPending] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [rowFeedback, setRowFeedback] = useState<{ id: string; source: string; text: string } | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const [configuring, setConfiguring] = useState<{ id: string; name: string } | null>(null)
  const settings = useApp(state => state.settings)
  const pendingRef = useRef(false)
  const mounted = useRef(false)
  const active = useInteractionActive()
  const canInteract = useInteractionGuard()
  const signal = useInteractionSignal()
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const agentsRef = useRef(agents)
  agentsRef.current = agents
  const inventory = useRuntimeInventoryRefresh({
    enabled: autoRefresh && heading,
    paused: disabled || pending !== null || configuring !== null,
    agents,
    isCurrent: () => mounted.current && isCurrent() && !pendingRef.current,
    onChange
  })
  const controlsDisabled = disabled || pending !== null || !active
  const run = async (action: RuntimeAction, targetId?: string): Promise<void> => {
    if (!hasIpc || disabled || !mounted.current || !isCurrent() || !canInteract() || pendingRef.current) return
    if (targetId && agents.find((agent) => (agent.runtimeId ?? agent.id) === targetId)?.launchKind === 'sdk' && ['setup', 'path', 'test'].includes(action)) return
    pendingRef.current = true
    inventory.invalidate()
    onPendingChange?.(true)
    setPending(action === 'refresh' || action === 'node' ? action : `${action}:${targetId ?? ''}`)
    setFeedback(null)
    setRowFeedback(null)
    setAnnouncement('')
    const beforeAgent = targetId ? agents.find((item) => (item.runtimeId ?? item.id) === targetId) : undefined
    const source = feedbackSource(beforeAgent)
    const sourceCurrent = (): boolean => mounted.current && isCurrent() && canInteract() && !signal?.aborted
      && (targetId ? source === feedbackSource(agentsRef.current.find(item => (item.runtimeId ?? item.id) === targetId)) : agentsRef.current === agents)
    const report = (text: string, updatedAgents = agents): void => {
      if (targetId) setRowFeedback({ id: targetId, source: feedbackSource(updatedAgents.find(item => (item.runtimeId ?? item.id) === targetId)), text })
      else setFeedback(text)
    }
    try {
      if (action === 'migration') {
        if (beforeAgent?.availableMigration) await api.openExternal(beforeAgent.availableMigration.guideUrl)
        return
      }
      let res: { ok: boolean; error?: string; agents?: AcpAgentStatus[]; cancelled?: boolean; probe?: AcpConnectionProbeResult }
      if (action === 'setup' && targetId) res = await api.acpRuntimeSetup(targetId)
      else if (action === 'path' && targetId) res = await api.acpRuntimePathPick(targetId)
      else if (action === 'test' && targetId) res = await api.acpRuntimeTestConnection(targetId)
      else if (action === 'node') res = await api.acpRuntimeNodePick()
      else res = await api.acpRuntimeRefresh()
      if (!sourceCurrent()) return
      if ('cancelled' in res && res.cancelled) return
      if (res.ok && !res.agents) {
        const discovered = await api.acpAgents()
        if (!sourceCurrent()) return
        if (!discovered.ok || !discovered.agents) { report(`状态更新失败：${discovered.error ?? '请重新探测'}`); return }
        res.agents = discovered.agents
      }
      if (res.agents) {
        onChange(res.agents)
        if (res.ok && (action !== 'test' || res.probe?.ok)) inventory.clearError()
      }
      if (action === 'test') {
        if (!res.ok || !res.probe) { report(res.error ?? '测试连接失败，请重试。', res.agents); return }
        if (!res.probe.ok) { report(`连接失败：${res.probe.error ?? '未收到有效的 initialize 响应'}`, res.agents); return }
        setAnnouncement('连接已验证')
        return
      }
      if (!res.ok) report(res.error ?? '操作失败，请重试。', res.agents)
      else setAnnouncement(action === 'refresh' ? '状态已更新' : action === 'setup' ? '安装已完成' : '路径已保存')
    } catch (error) {
      if (sourceCurrent()) report(error instanceof Error ? error.message : '执行环境操作失败')
    } finally {
      pendingRef.current = false
      onPendingChange?.(false)
      if (mounted.current) setPending(null)
    }
  }
  const visibleAgents = agents.filter((agent) => !runtimeId || (agent.runtimeId ?? agent.id) === runtimeId)
  const actions = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {onManageAgents && <Button size="sm" variant="outline" disabled={controlsDisabled} onClick={() => { if (isCurrent() && canInteract()) onManageAgents() }}><Bot size={13} />管理 Agent</Button>}
      <Button size="sm" variant="outline" disabled={controlsDisabled || !hasIpc} onClick={() => void run('refresh')}>
        {pending === 'refresh' ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} 重新探测
      </Button>
      {runtimeId !== 'zcode' && agents.find(agent => (agent.runtimeId ?? agent.id) === runtimeId)?.launchKind !== 'sdk' && <Dropdown align="right" trigger={({ open, toggle }) => <Button size="sm" variant="ghost" aria-label="执行引擎选项" title="执行引擎选项" aria-expanded={open} onClick={toggle}><MoreHorizontal size={16} /></Button>}>
        {(close) => <DropdownItem disabled={controlsDisabled || !hasIpc} onClick={() => { close(); void run('node') }}>选择全局 Node</DropdownItem>}
      </Dropdown>}
    </div>
  )
  const content = <>
      <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
      {(feedback || inventory.error) && <p role="alert" className="mb-3 break-words text-my-sm text-my-danger-text">{feedback ?? inventory.error}</p>}
      {visibleAgents.length === 0 && <p className="runtime-engine-empty text-my-sm text-my-tertiary">{inventory.reading ? '正在检测…' : runtimeId ? '未找到此执行引擎' : '暂未取得执行引擎列表'}</p>}
      {visibleAgents.map((agent, index) => {
        const id = agent.runtimeId ?? agent.id
        const native = agent.launchKind === 'native'
        const bundled = agent.launchKind === 'bundled'
        const sdk = agent.launchKind === 'sdk'
        const zcode = bundled && id === 'zcode'
        const updatePending = native && agent.available && agent.updateStatus === 'available'
        const canSetup = !agent.setupBlockedReason && agent.updateStatus !== 'ahead'
        const open = expanded[id] ?? Boolean(runtimeId)
        const controlsId = `${sectionId}-runtime-${index}`
        const needsInstall = !sdk && (agent.setupRequired || native && !agent.available)
        const canTest = !sdk && agent.enabled && agent.available && !agent.setupRequired
        const primaryAction = (needsInstall || updatePending) && canSetup ? 'setup' : canTest ? 'test' : zcode || native ? 'path' : undefined
        const primaryLabel = primaryAction === 'setup' ? needsInstall ? '安装' : '升级' : primaryAction === 'path' ? zcode ? '选择目录' : '配置路径' : '测试连接'
        const attention = !agent.enabled || !agent.available || Boolean(agent.setupRequired) || Boolean(agent.health && !['ready', 'not_checked'].includes(agent.health))
        const StatusIcon = attention ? CircleAlert : agent.health === 'ready' || sdk ? CheckCircle2 : PackageCheck
        const diagnostics = agent.diagnostics ?? []
        const defaultsSummary = heading ? runtimeDefaultsSummary(settings?.acp?.runtimeDefaults?.[id], agent.launchKind, settings?.ai) : ''
        const actionButton = (action: RuntimeAction, label: string, variant: 'primary' | 'outline' | 'ghost' = 'outline'): JSX.Element => {
          const busy = pending === (action === 'refresh' || action === 'node' ? action : `${action}:${id}`)
          const Icon = action === 'setup' ? Download : action === 'test' ? PlugZap : action === 'refresh' ? RefreshCw : action === 'migration' ? ExternalLink : FolderOpen
          return <Button key={label} size="sm" variant={variant} aria-label={`${agent.name} · ${label}`} disabled={controlsDisabled || !hasIpc} onClick={() => void run(action, id)}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Icon size={13} />} {label}
          </Button>
        }
        return (
        <div key={agent.id} className="runtime-engine" data-expanded={open}>
          <div className="runtime-engine-heading">
            <button type="button" className="runtime-engine-toggle" aria-expanded={open} aria-controls={controlsId}
              onClick={() => setExpanded((previous) => ({ ...previous, [id]: !open }))}>
              <ToolBrandIcon brand={id} size={32} />
              <span className="runtime-engine-identity">
                <span className="runtime-engine-name">{agent.name}{agent.adapterVersion && <span className="runtime-engine-version">v{agent.adapterVersion}</span>}</span>
                <span className={`runtime-engine-status${attention ? ' is-attention' : ''}`}>
                  <StatusIcon size={12} aria-hidden="true" />
                  {runtimeHealthLabel(agent)}
                  {updatePending && <span className="runtime-engine-update">新版本 v{agent.latestVersion}</span>}
                  {agent.releaseChannel === 'v1' && agent.updateStatus === 'current' && <span className="runtime-engine-update">v1 维护版本已是最新</span>}
                </span>
                {defaultsSummary && <span className="runtime-engine-defaults">{defaultsSummary}</span>}
              </span>
              <ChevronDown size={15} className="runtime-engine-chevron" aria-hidden="true" />
            </button>
            {primaryAction && <div className="runtime-engine-primary">{actionButton(primaryAction, primaryLabel, needsInstall || updatePending || zcode && !agent.available ? 'primary' : 'outline')}</div>}
            {native && agent.availableMigration && actionButton('migration', `v${agent.availableMigration.version} 迁移指南`)}
            {heading && <Button size="sm" variant="outline" disabled={controlsDisabled || !hasIpc || !settings} aria-label={`${agent.name} · 默认配置`} onClick={() => { if (isCurrent() && canInteract()) setConfiguring({ id, name: agent.name }) }}><Settings2 size={13} />默认配置</Button>}
            {sdk && onConfigureModels && <Button size="sm" variant="outline" disabled={controlsDisabled} aria-label={`${agent.name} · 配置模型`} onClick={() => { if (isCurrent() && canInteract()) onConfigureModels() }}><Settings2 size={13} />配置模型</Button>}
          </div>
          {rowFeedback && rowFeedback.id === id && rowFeedback.source === feedbackSource(agent) && <p role="alert" className="runtime-engine-feedback text-my-sm text-my-danger-text">{rowFeedback.text}</p>}
          <div id={controlsId} className="runtime-engine-controls" hidden={!open}>
            <div className="runtime-engine-actions" role="group" aria-label={`${agent.name}操作`}>
              {runtimeId && actionButton('refresh', '重新探测')}
              {zcode && agent.setupRequired && actionButton('setup', '安装')}
              {canTest && primaryAction !== 'test' && actionButton('test', '测试连接')}
              {updatePending && canSetup && primaryAction !== 'setup' && actionButton('setup', '升级')}
              {(native || bundled) && primaryAction !== 'path' && actionButton('path', zcode ? '选择目录' : '配置路径')}
              {!heading && runtimeId && !sdk && !zcode && actionButton('node', '选择全局 Node')}
              {native && agent.available && canSetup && (agent.updateStatus === 'current' || agent.updateStatus === 'available') && actionButton('setup', '重装', 'ghost')}
            </div>
            <details className="runtime-engine-inspect">
              <summary><Terminal size={13} aria-hidden="true" /><span>运行信息</span><ChevronDown size={13} className="runtime-engine-inspect-chevron" aria-hidden="true" /></summary>
              <dl className="runtime-engine-fields">
                <div><dt>Node</dt><dd><code>{sdk ? '应用内置' : agent.nodePath ?? (zcode ? '应用内置' : '未确认 · 由引擎管理')}</code></dd></div>
                {sdk ? <>
                  <div><dt>启动方式</dt><dd>内置 SDK{agent.adapterVersion ? ` ${agent.adapterVersion}` : ''}</dd></div>
                  <div><dt>模型与凭据</dt><dd>AI 供应商</dd></div>
                </> : agent.executable ? <>
                  <div><dt>可执行文件</dt><dd><code>{agent.executable}</code></dd></div>
                  {(agent.args?.length ?? 0) > 0 && <div><dt>启动参数</dt><dd><code>{agent.args?.join(' ')}</code></dd></div>}
                </> : <div><dt>启动命令</dt><dd><code>{agent.command || '待配置'}</code></dd></div>}
                {agent.checkedAt !== undefined && <div><dt>检测时间</dt><dd>{new Date(agent.checkedAt).toLocaleString()}</dd></div>}
              </dl>
            </details>
            {diagnostics.length > 0 && <details className="runtime-engine-inspect">
              <summary><CircleAlert size={13} aria-hidden="true" /><span>检测记录</span><span className="runtime-engine-record-count">{diagnostics.length}</span><ChevronDown size={13} className="runtime-engine-inspect-chevron" aria-hidden="true" /></summary>
              <ul className="runtime-engine-diagnostics">{diagnostics.map((message, diagnosticIndex) => <li key={diagnosticIndex}>{message}</li>)}</ul>
            </details>}
          </div>
        </div>
        )
      })}
    </>
  return <section className="acp-engine-panel runtime-panel" aria-label="Agent 执行引擎">
    {heading ? <PreferenceSection id={sectionId} title="本机引擎" action={actions}>{content}</PreferenceSection>
      : <>{(!runtimeId || visibleAgents.length === 0) && <div className="mb-3">{actions}</div>}{content}</>}
    {configuring && <RuntimeDefaultsEditor key={configuring.id} runtimeId={configuring.id} launchKind={agents.find(agent => (agent.runtimeId ?? agent.id) === configuring.id)?.launchKind} name={configuring.name} initial={settings?.acp?.runtimeDefaults?.[configuring.id]} isCurrent={isCurrent} onClose={() => setConfiguring(null)} onSaved={() => { setConfiguring(null); setAnnouncement('默认配置已保存') }} />}
  </section>
}
