import { useEffect, useId, useLayoutEffect, useRef, useState, type JSX } from 'react'
import { Bot, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, CircleX, Download, ExternalLink, FolderOpen, Loader2, MoreHorizontal, PlugZap, RefreshCw, Settings2, Terminal, X } from 'lucide-react'
import { api, hasIpc } from '../api'
import { ToolBrandIcon } from '../components/ToolBrandIcon'
import { Button, Dropdown, DropdownItem } from '../my/ui'
import { PreferenceSection } from '../pages/settings/PreferenceSection'
import { useApp } from '../store'
import { useInteractionActive, useInteractionGuard, useInteractionSignal } from '../utils/interaction-scope'
import { useRuntimeInventoryRefresh } from './useRuntimeInventoryRefresh'
import { RuntimeDefaultsEditor } from './RuntimeDefaultsEditor'
import { RuntimeConnectionIcon, runtimeHealthLabel } from './runtime-status'
import type { AcpAgentStatus, AcpConnectionProbeResult, Settings } from '../../../shared/types'
import './runtime-panel.css'

export { runtimeHealthLabel } from './runtime-status'

function isUnsupportedLegacyRuntime(agent: AcpAgentStatus | undefined): boolean {
  return agent?.launchKind === 'custom' || agent?.id === 'opencode'
}

type RuntimeAction = 'refresh' | 'node' | 'setup' | 'path' | 'test' | 'migration'
type SetupIntent = 'install' | 'upgrade' | 'reinstall'
const ACTION_LABEL: Record<RuntimeAction, string> = {
  refresh: '重新探测', node: '选择全局 Node', setup: '安装或升级', path: '配置路径', test: '测试连接', migration: '迁移指南'
}
const ACTION_PENDING: Partial<Record<RuntimeAction, string>> = {
  refresh: '正在重新探测', node: '正在选择全局 Node', setup: '正在安装或升级', path: '正在配置路径', test: '正在测试连接'
}
const COMPLETION_PROGRESS_MS = 2000

function pendingActionLabel(action: RuntimeAction, setupIntent?: SetupIntent | null): string | undefined {
  if (action === 'setup' && setupIntent) return { install: '正在安装', upgrade: '正在升级', reinstall: '正在重装' }[setupIntent]
  return ACTION_PENDING[action]
}

function pendingRowAction(pending: string | null, id: string): RuntimeAction | undefined {
  return (['setup', 'path', 'test'] as const).find(action => pending === `${action}:${id}`) ?? (pending === 'refresh' ? 'refresh' : undefined)
}

function requestSource(agent: AcpAgentStatus | undefined): string {
  return JSON.stringify(agent && [agent.id, agent.enabled, agent.available, agent.setupRequired, agent.health, agent.launchKind, agent.command, agent.executable, agent.args, agent.nodePath, agent.diagnostics,
    agent.adapterVersion, agent.latestVersion, agent.releaseChannel, agent.updateStatus, agent.setupBlockedReason, agent.availableMigration]) ?? ''
}

function feedbackIdentity(agent: AcpAgentStatus | undefined, acp: Settings['acp'], action: RuntimeAction): string {
  if (!agent) return ''
  const id = agent.runtimeId ?? agent.id
  return JSON.stringify([agent.id, id, agent.enabled, agent.launchKind, agent.command, agent.executable, agent.args, acp?.nodePath, acp?.nativePaths?.[id], action === 'test' ? acp?.runtimeDefaults?.[id] : undefined])
}

function withoutCommandId(reason: string, commandId?: string): string {
  const suffix = commandId ? ` 原命令：${commandId}` : ''
  return suffix && reason.endsWith(suffix) ? reason.slice(0, -suffix.length) : reason
}

function RuntimeFeedbackDetails({ commandId }: { commandId?: string }): JSX.Element | null {
  if (!commandId) return null
  return <details className="runtime-engine-inspect">
    <summary><Terminal size={13} aria-hidden="true" /><span>诊断详情</span><ChevronDown size={13} className="runtime-engine-inspect-chevron" aria-hidden="true" /></summary>
    <dl className="runtime-engine-fields"><div><dt>命令 ID</dt><dd><code>{commandId}</code></dd></div></dl>
  </details>
}

function RuntimeActivity({ label, animating }: { label?: string; animating: boolean }): JSX.Element {
  return <span className="runtime-activity-status" data-animating={animating || undefined}>
    <span className="runtime-activity-dot" aria-hidden="true" /><span>{label}</span>
  </span>
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
  const [selectedEngine, setSelectedEngine] = useState<string | null>(null)
  const [panelWidth, setPanelWidth] = useState(0)
  const [completedProgress, setCompletedProgress] = useState<Map<string, { action: RuntimeAction; source: string; statusSource: string; expiresAt: number }>>(() => new Map())
  const [reduceMotion, setReduceMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [documentVisible, setDocumentVisible] = useState(() => document.visibilityState === 'visible')
  const [pending, setPending] = useState<string | null>(null)
  const [pendingSetupIntent, setPendingSetupIntent] = useState<SetupIntent | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [staleFeedback, setStaleFeedback] = useState<Array<{ id: number; label: string; text: string; commandId?: string }>>([])
  const staleFeedbackId = useRef(0)
  const [rowFeedback, setRowFeedback] = useState<Map<string, Array<{ source: string; text: string; action: RuntimeAction; kind: 'error' | 'not-admitted' | 'stale' | 'unknown' | 'unconfirmed'; commandId?: string }>>>(() => new Map())
  const [rowResults, setRowResults] = useState<Map<string, { source: string; statusSource: string; action: RuntimeAction; text: string; kind: 'success' | 'cancelled'; representedByHealth: boolean }>>(() => new Map())
  const [completionBeat, setCompletionBeat] = useState<{ id: string; action: RuntimeAction; source: string; statusSource: string; token: number } | null>(null)
  const completionToken = useRef(0)
  const [inspections, setInspections] = useState<Record<string, { information?: boolean; diagnostics?: boolean }>>({})
  const [announcement, setAnnouncement] = useState('')
  const [configuring, setConfiguring] = useState<{ id: string; name: string; launchKind: AcpAgentStatus['launchKind'] } | null>(null)
  const [configTargetRemoved, setConfigTargetRemoved] = useState(false)
  const panelRef = useRef<HTMLElement>(null)
  const illustrationRefs = useRef(new Map<string, HTMLButtonElement>())
  const rowRefs = useRef(new Map<string, HTMLDivElement>())
  const primaryRefs = useRef(new Map<string, HTMLDivElement>())
  const detailRefs = useRef(new Map<string, HTMLDivElement>())
  const visibleIdsRef = useRef(new Set<string>())
  const diagramIdsRef = useRef(new Set<string>())
  const recoveryFocusRef = useRef<Element | null>(null)
  const modalFocusRef = useRef<EventTarget | null>(null)
  const configTriggerRef = useRef<HTMLButtonElement | null>(null)
  const settings = useApp(state => state.settings)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const pendingRef = useRef(false)
  const mounted = useRef(false)
  const active = useInteractionActive()
  const canInteract = useInteractionGuard()
  const signal = useInteractionSignal()
  const motionEnabled = active && documentVisible && !reduceMotion
  const motionEnabledRef = useRef(motionEnabled)
  motionEnabledRef.current = motionEnabled
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useLayoutEffect(() => {
    const element = panelRef.current
    if (!element) return
    const measure = (): void => setPanelWidth(element.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!completedProgress.size) return
    const nextExpiry = Math.min(...[...completedProgress.values()].map(item => item.expiresAt))
    const timer = window.setTimeout(() => setCompletedProgress(previous => new Map([...previous].filter(([, item]) => item.expiresAt > Date.now()))), Math.max(0, nextExpiry - Date.now()))
    return () => window.clearTimeout(timer)
  }, [completedProgress])
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = (): void => { if (media.matches) setCompletionBeat(null); setReduceMotion(media.matches) }
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    const update = (): void => { if (document.visibilityState !== 'visible') setCompletionBeat(null); setDocumentVisible(document.visibilityState === 'visible') }
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  useLayoutEffect(() => {
    if (!completionBeat) return
    const agent = agents.find(item => (item.runtimeId ?? item.id) === completionBeat.id)
    if (!motionEnabled || !agent || completionBeat.source !== feedbackIdentity(agent, settings?.acp, completionBeat.action) || completionBeat.statusSource !== requestSource(agent)) setCompletionBeat(null)
  }, [agents, completionBeat, motionEnabled, settings?.acp])
  useEffect(() => {
    if (!completionBeat || !motionEnabled) return
    const timer = window.setTimeout(() => setCompletionBeat(null), 700)
    return () => window.clearTimeout(timer)
  }, [completionBeat, motionEnabled])
  const agentsRef = useRef(agents)
  agentsRef.current = agents
  const completeProgress = (agent: AcpAgentStatus, action: RuntimeAction): void => {
    const id = agent.runtimeId ?? agent.id
    setCompletedProgress(previous => new Map(previous).set(id, { action,
      source: feedbackIdentity(agent, settingsRef.current?.acp, action), statusSource: requestSource(agent), expiresAt: Date.now() + COMPLETION_PROGRESS_MS }))
  }
  const inventory = useRuntimeInventoryRefresh({
    enabled: autoRefresh && heading,
    paused: disabled || pending !== null || configuring !== null,
    agents,
    isCurrent: () => mounted.current && isCurrent() && !pendingRef.current,
    onChange,
    onVerified: agent => completeProgress(agent, 'test')
  })
  const controlsDisabled = disabled || pending !== null || !active
  const run = async (action: RuntimeAction, targetId?: string, setupIntent?: SetupIntent): Promise<void> => {
    if (!hasIpc || disabled || !mounted.current || !isCurrent() || !canInteract() || pendingRef.current) return
    const target = targetId ? agents.find((agent) => (agent.runtimeId ?? agent.id) === targetId) : undefined
    if (targetId && ((target?.launchKind === 'sdk' && ['setup', 'path', 'test'].includes(action))
      || (isUnsupportedLegacyRuntime(target) && ['setup', 'path', 'test', 'migration'].includes(action)))) return
    if (targetId) setSelectedEngine(targetId)
    pendingRef.current = true
    setCompletionBeat(null)
    setCompletedProgress(previous => {
      if (!targetId) return new Map()
      const next = new Map(previous)
      next.delete(targetId)
      return next
    })
    inventory.invalidate()
    onPendingChange?.(true)
    setPendingSetupIntent(action === 'setup' ? setupIntent ?? null : null)
    setPending(action === 'refresh' || action === 'node' ? action : `${action}:${targetId ?? ''}`)
    setFeedback(null)
    if (targetId) setRowFeedback(previous => {
      const entries = previous.get(targetId)
      if (!entries?.some(entry => entry.action === action)) return previous
      const next = new Map(previous)
      const remaining = entries.filter(entry => entry.action !== action)
      if (remaining.length) next.set(targetId, remaining)
      else next.delete(targetId)
      return next
    })
    if (targetId) setRowResults(previous => {
      if (!previous.has(targetId)) return previous
      const next = new Map(previous)
      next.delete(targetId)
      return next
    })
    const beforeAgent = targetId ? agents.find((item) => (item.runtimeId ?? item.id) === targetId) : undefined
    const pendingText = pendingActionLabel(action, setupIntent)
    setAnnouncement(pendingText ? `${beforeAgent ? `${beforeAgent.name}：` : ''}${pendingText}` : '')
    const source = requestSource(beforeAgent)
    const identity = feedbackIdentity(beforeAgent, settingsRef.current?.acp, action)
    const targetIdentity = feedbackIdentity(beforeAgent, settingsRef.current?.acp, 'setup')
    const scopeCurrent = (): boolean => mounted.current && isCurrent() && canInteract() && !signal?.aborted
    const currentAgent = (): AcpAgentStatus | undefined => agentsRef.current.find(item => (item.runtimeId ?? item.id) === targetId)
    const sourceCurrent = (): boolean => scopeCurrent()
      && (targetId ? source === requestSource(currentAgent()) && identity === feedbackIdentity(currentAgent(), settingsRef.current?.acp, action) : agentsRef.current === agents)
    const reportResult = (text: string, updatedAgents = agentsRef.current, kind: 'success' | 'cancelled' = 'success'): void => {
      if (!scopeCurrent()) return
      if (targetId) {
        const agent = updatedAgents.find(item => (item.runtimeId ?? item.id) === targetId)
        if (agent) {
          const representedByHealth = kind === 'success' && (action === 'test' && agent.health === 'ready'
            || action === 'setup' && Boolean(beforeAgent && (!beforeAgent.available || beforeAgent.setupRequired)) && ['已安装', '可用'].includes(runtimeHealthLabel(agent)))
          const resultSource = feedbackIdentity(agent, settingsRef.current?.acp, action)
          const statusSource = requestSource(agent)
          setRowResults(previous => new Map(previous).set(targetId, { source: resultSource, statusSource, action, text, kind, representedByHealth }))
          if (kind === 'success') completeProgress(agent, action)
          if (kind === 'success' && motionEnabledRef.current && document.visibilityState === 'visible' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            setCompletionBeat({ id: targetId, action, source: resultSource, statusSource, token: ++completionToken.current })
          }
        }
      }
      setAnnouncement(`${beforeAgent ? `${beforeAgent.name}：` : ''}${ACTION_LABEL[action]}：${text}`)
    }
    const appendStale = (label: string, text: string, commandId?: string): void => {
      const id = ++staleFeedbackId.current
      setStaleFeedback(previous => [...previous, { id, label, text, commandId }])
    }
    const report = (text: string, updatedAgents = agents, kind: 'error' | 'not-admitted' | 'stale' | 'unknown' | 'unconfirmed' = 'error', commandId?: string): void => {
      if (targetId) {
        setRowFeedback(previous => new Map(previous).set(targetId, [
          ...(previous.get(targetId) ?? []).filter(entry => entry.action !== action),
          { source: feedbackIdentity(updatedAgents.find(item => (item.runtimeId ?? item.id) === targetId), settingsRef.current?.acp, action), text, action, kind, commandId }
        ]))
        setAnnouncement(`${beforeAgent?.name ?? targetId}：${kind === 'unknown' ? '操作结果未知' : kind === 'unconfirmed' ? '最新状态未确认' : kind === 'stale' ? '操作结果未应用' : kind === 'not-admitted' ? '操作未准入' : '操作失败'}`)
      }
      else if (kind === 'stale' || kind === 'unknown' || kind === 'unconfirmed') appendStale(ACTION_LABEL[action], `${ACTION_LABEL[action]}：${text}`, commandId)
      else setFeedback(text)
    }
    const reportStale = (text: string, kind: 'stale' | 'unknown' | 'unconfirmed' = 'stale', commandId?: string): void => {
      if (!scopeCurrent()) return
      if (targetId && (!beforeAgent || !currentAgent() || targetIdentity !== feedbackIdentity(currentAgent(), settingsRef.current?.acp, 'setup'))) {
        const label = `${beforeAgent?.name ?? targetId}（${targetId}） · ${ACTION_LABEL[action]}`
        appendStale(label, `原引擎 ${label} 状态已变化。${text}`, commandId)
        return
      }
      report(text, agentsRef.current, kind, commandId)
    }
    const notApplied = '界面未采用此结果，请重新探测并核对。'
    const unknownResult = (reason: string): string => `操作结果未知：${reason}。请先核对原操作和引擎状态${action === 'setup' ? '，确认前不要重复安装或升级' : ''}。`
    let operationReturned = false
    try {
      if (action === 'migration') {
        if (beforeAgent?.availableMigration) await api.openExternal(beforeAgent.availableMigration.guideUrl)
        return
      }
      let res: { ok: boolean; error?: string; agents?: AcpAgentStatus[]; cancelled?: boolean; probe?: AcpConnectionProbeResult; outcome?: string; commandId?: string }
      if (action === 'setup' && targetId) res = await api.acpRuntimeSetup(targetId)
      else if (action === 'path' && targetId) res = await api.acpRuntimePathPick(targetId)
      else if (action === 'test' && targetId) res = await api.acpRuntimeTestConnection(targetId)
      else if (action === 'node') res = await api.acpRuntimeNodePick()
      else res = await api.acpRuntimeRefresh()
      operationReturned = true
      if ('cancelled' in res && res.cancelled) {
        if (sourceCurrent()) reportResult('已取消', agentsRef.current, 'cancelled')
        return
      }
      if (res.outcome === 'unknown') {
        if (!scopeCurrent()) return
        const text = unknownResult(withoutCommandId(res.error ?? '未收到确定结果', res.commandId))
        if (sourceCurrent()) report(text, agentsRef.current, 'unknown', res.commandId)
        else reportStale(`${text}${notApplied}`, 'unknown', res.commandId)
        return
      }
      if (!sourceCurrent()) {
        const failed = !res.ok || (action === 'test' && res.probe && !res.probe.ok)
        const failureLabel = res.outcome === 'not-admitted' ? '操作未准入' : '操作返回失败'
        reportStale(failed ? `${failureLabel}：${res.error ?? res.probe?.error ?? '未提供原因'}。${notApplied}` : notApplied)
        return
      }
      if (res.ok && !res.agents) {
        const discovered = await api.acpAgents()
        if (!sourceCurrent()) {
          reportStale(discovered.ok && discovered.agents ? notApplied : `状态更新失败：${discovered.error ?? '未取得引擎列表'}。${notApplied}`)
          return
        }
        if (!discovered.ok || !discovered.agents) { report(`状态更新失败：${discovered.error ?? '请重新探测'}`); return }
        res.agents = discovered.agents
      }
      if (res.agents) {
        onChange(res.agents)
        if (res.ok && (action !== 'test' || res.probe?.ok)) inventory.clearError()
      }
      if (action === 'test') {
        if (!res.ok || !res.probe) { report(res.outcome === 'not-admitted' ? `操作未准入：${res.error ?? '未提供原因'}` : res.error ?? '测试连接失败，请重试。', res.agents, res.outcome === 'not-admitted' ? 'not-admitted' : 'error'); return }
        if (!res.probe.ok) { report(`连接失败：${res.probe.error ?? '未收到有效的 initialize 响应'}`, res.agents); return }
        reportResult('连接已验证', res.agents)
        return
      }
      if (!res.ok) report(res.outcome === 'not-admitted' ? `操作未准入：${res.error ?? '未提供原因'}` : res.error ?? '操作失败，请重试。', res.agents, res.outcome === 'not-admitted' ? 'not-admitted' : 'error')
      else reportResult(action === 'refresh' ? '状态已更新' : action === 'setup' ? '已完成' : '已保存', res.agents)
    } catch (error) {
      const commandId = error && typeof error === 'object' && 'commandId' in error && typeof error.commandId === 'string' ? error.commandId : undefined
      const reason = withoutCommandId(error instanceof Error ? error.message : '执行环境操作异常', commandId)
      const kind = operationReturned ? 'unconfirmed' : 'unknown'
      const text = operationReturned ? `操作已返回，但最新状态未确认：${reason}。请核对原操作和引擎状态。` : unknownResult(reason)
      if (sourceCurrent()) report(text, agentsRef.current, kind, commandId)
      else reportStale(`${text}${notApplied}`, kind, commandId)
    } finally {
      pendingRef.current = false
      onPendingChange?.(false)
      if (mounted.current) { setPending(null); setPendingSetupIntent(null) }
    }
  }
  const visibleAgents = agents.filter((agent) => !runtimeId || (agent.runtimeId ?? agent.id) === runtimeId)
  const selectedAgent = visibleAgents.find(agent => (agent.runtimeId ?? agent.id) === selectedEngine) ?? visibleAgents[0]
  const modelRuntimeId = selectedAgent ? selectedAgent.runtimeId ?? selectedAgent.id : null
  const selectedAction = modelRuntimeId && !isUnsupportedLegacyRuntime(selectedAgent) ? pendingRowAction(pending, modelRuntimeId) : undefined
  const selectedStatus = selectedAction ? pendingActionLabel(selectedAction, pendingSetupIntent)
    : modelRuntimeId && !pending && inventory.checkingRuntimeId === modelRuntimeId ? '正在检测连接' : runtimeHealthLabel(selectedAgent)
  const selectedBusy = Boolean(selectedAction || modelRuntimeId && !pending && inventory.checkingRuntimeId === modelRuntimeId)
  const overview = heading && !runtimeId
  const columns = overview && panelWidth >= 680 ? 2 : 1
  const overviewCapacity = (panelWidth >= 960 ? 4 : panelWidth && panelWidth < 600 ? 2 : 3) * 2
  const overviewPageCount = Math.ceil(visibleAgents.length / overviewCapacity)
  const overviewPage = Math.floor(Math.max(0, selectedAgent ? visibleAgents.indexOf(selectedAgent) : 0) / overviewCapacity)
  const diagramAgents = visibleAgents.slice(overviewPage * overviewCapacity, (overviewPage + 1) * overviewCapacity)
  diagramIdsRef.current = new Set(diagramAgents.map(agent => agent.runtimeId ?? agent.id))
  const configTargetAvailable = Boolean(configuring && agents.some(agent => (agent.runtimeId ?? agent.id) === configuring.id && agent.launchKind === configuring.launchKind && !isUnsupportedLegacyRuntime(agent)))
  visibleIdsRef.current = new Set(visibleAgents.map(agent => agent.runtimeId ?? agent.id))
  useEffect(() => {
    setRowFeedback(previous => {
      const next = new Map(previous)
      let changed = false
      for (const [id, entries] of next) {
        const agent = agents.find(item => (item.runtimeId ?? item.id) === id)
        const current = agent ? entries.filter(entry => entry.source === feedbackIdentity(agent, settings?.acp, entry.action)) : []
        if (current.length === entries.length) continue
        changed = true
        if (current.length) next.set(id, current)
        else next.delete(id)
      }
      return changed ? next : previous
    })
  }, [agents, settings?.acp])
  useEffect(() => {
    setRowResults(previous => {
      const next = new Map(previous)
      for (const [id, result] of previous) {
        const agent = agents.find(item => (item.runtimeId ?? item.id) === id)
        if (!agent || result.source !== feedbackIdentity(agent, settings?.acp, result.action) || (result.kind === 'success' && result.statusSource !== requestSource(agent))) next.delete(id)
      }
      return next.size === previous.size ? previous : next
    })
  }, [agents, settings?.acp])
  const rememberRemovedFocus = (element: Element | undefined, id: string, stillVisible = visibleIdsRef.current.has(id)): void => {
    if (element && !stillVisible && element.contains(document.activeElement)) recoveryFocusRef.current = document.activeElement
  }
  useLayoutEffect(() => {
    if (configuring && !configTargetRemoved && !configTargetAvailable) setConfigTargetRemoved(true)
    const previous = recoveryFocusRef.current
    if (!previous) return
    recoveryFocusRef.current = null
    if (!previous.isConnected && document.activeElement === document.body && isCurrent() && canInteract()) {
      const fallback = modelRuntimeId ? previous.classList.contains('runtime-overview-node-control')
        ? illustrationRefs.current.get(modelRuntimeId)
        : rowRefs.current.get(modelRuntimeId)?.querySelector<HTMLButtonElement>('.runtime-engine-toggle') : null
      const target = fallback ?? panelRef.current
      target?.focus({ preventScroll: true })
    }
  })
  const closeConfiguring = (saved = false): void => {
    if (!configTriggerRef.current?.isConnected && modalFocusRef.current === document.activeElement && document.activeElement instanceof HTMLElement) recoveryFocusRef.current = document.activeElement
    setConfiguring(null)
    if (saved) setAnnouncement('默认配置已保存')
  }
  useEffect(() => {
    if (selectedEngine !== modelRuntimeId) setSelectedEngine(modelRuntimeId)
  }, [selectedEngine, modelRuntimeId])
  const selectEngine = (id: string): void => {
    setSelectedEngine(id)
    if (overview) setExpanded(previous => Object.values(previous).some(Boolean) ? { [id]: true } : previous)
  }
  const selectIllustrationEngine = (id: string): void => {
    selectEngine(id)
  }
  const illustrationWidth = 600
  const flowGradientId = `runtime-flow-${sectionId.replace(/[^a-zA-Z0-9_-]/g, '')}`
  const illustrationItems = diagramAgents.map((agent, index) => {
    const id = agent.runtimeId ?? agent.id
    const side = index % 2 === 0 ? -1 : 1
    const slot = Math.floor(index / 2)
    const rowCount = Math.ceil(diagramAgents.length / 2)
    const row = slot
    const x = illustrationWidth / 2 + side * 185
    const y = rowCount === 1 ? 100 : 36 + row * 128 / (rowCount - 1)
    const endX = illustrationWidth / 2 + side * 55
    const endY = rowCount === 1 ? 100 : 70 + row * 60 / (rowCount - 1)
    const bendX = (x + endX) / 2
    const path = `M ${x} ${y} L ${bendX} ${y} L ${endX} ${endY}`
    const unsupported = isUnsupportedLegacyRuntime(agent)
    const automaticallyChecking = inventory.checkingRuntimeId === id && !pending
    const busy = !unsupported && (pending === 'refresh' || automaticallyChecking || Boolean(pending?.endsWith(`:${id}`)))
    const rowAction = unsupported ? undefined : pendingRowAction(pending, id)
    const status = rowAction ? pendingActionLabel(rowAction, pendingSetupIntent) : automaticallyChecking ? '正在检测连接' : runtimeHealthLabel(agent)
    const error = (rowFeedback.get(id) ?? []).some(entry => entry.source === feedbackIdentity(agent, settings?.acp, entry.action))
    const state = unsupported ? 'disabled' : busy ? 'busy' : error ? 'error' : !agent.enabled ? 'disabled'
      : agent.health === 'adapter_missing' || agent.health === 'executable_missing' ? 'missing'
        : agent.health && !['ready', 'not_checked'].includes(agent.health) ? 'attention'
        : agent.available && !agent.setupRequired ? agent.health === 'ready' ? 'verified' : 'installed' : 'missing'
    return { agent, id, x, y, path, busy, error, state, status }
  })
  const actions = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {onManageAgents && <Button size="sm" variant="outline" disabled={controlsDisabled} onClick={() => { if (isCurrent() && canInteract()) onManageAgents() }}><Bot size={13} />管理 Agent</Button>}
      <Button size="sm" variant="outline" disabled={controlsDisabled || !hasIpc} onClick={() => void run('refresh')}>
        {pending === 'refresh' ? <Loader2 size={12} className={motionEnabled ? 'animate-spin' : undefined} /> : <RefreshCw size={12} />} 重新探测
      </Button>
      {runtimeId !== 'zcode' && agents.find(agent => (agent.runtimeId ?? agent.id) === runtimeId)?.launchKind !== 'sdk' && <Dropdown align="right" trigger={({ open, toggle }) => <Button size="sm" variant="ghost" aria-label="执行引擎选项" title="执行引擎选项" aria-expanded={open} onClick={toggle}><MoreHorizontal size={16} /></Button>}>
        {(close) => <DropdownItem disabled={controlsDisabled || !hasIpc} onClick={() => { close(); void run('node') }}>选择全局 Node</DropdownItem>}
      </Dropdown>}
    </div>
  )
  const completionMatches = (agent: AcpAgentStatus): boolean => Boolean(motionEnabled && completionBeat && completionBeat.id === (agent.runtimeId ?? agent.id) && completionBeat.source === feedbackIdentity(agent, settings?.acp, completionBeat.action) && completionBeat.statusSource === requestSource(agent))
  const engineEntries = visibleAgents.map((agent, index) => {
        const id = agent.runtimeId ?? agent.id
        const unsupported = isUnsupportedLegacyRuntime(agent)
        const native = agent.launchKind === 'native'
        const bundled = agent.launchKind === 'bundled'
        const sdk = agent.launchKind === 'sdk'
        const zcode = bundled && id === 'zcode'
        const updatePending = native && agent.available && agent.updateStatus === 'available'
        const canSetup = !agent.setupBlockedReason && agent.updateStatus !== 'ahead'
        const open = overview ? expanded[id] ?? false : expanded[id] ?? Boolean(runtimeId)
        const controlsId = `${sectionId}-runtime-${index}`
        const needsInstall = !sdk && (agent.setupRequired || native && !agent.available)
        const canTest = !sdk && agent.enabled && agent.available && !agent.setupRequired
        const primaryAction = unsupported ? undefined : (needsInstall || updatePending) && canSetup ? 'setup' : canTest && agent.health && !['ready', 'not_checked'].includes(agent.health) ? 'test' : !agent.available && (zcode || native) ? 'path' : undefined
        const primaryLabel = primaryAction === 'setup' ? needsInstall ? '安装' : '升级' : primaryAction === 'path' ? zcode ? '选择目录' : '配置路径' : '重试'
        const attention = unsupported || !agent.enabled || !agent.available || Boolean(agent.setupRequired) || Boolean(agent.health && !['ready', 'not_checked'].includes(agent.health))
        const automaticallyChecking = !unsupported && !pending && inventory.checkingRuntimeId === id
        const rowAction = unsupported ? undefined : pendingRowAction(pending, id) ?? (automaticallyChecking ? 'test' : undefined)
        const pendingText = automaticallyChecking ? '正在检测连接' : rowAction ? pendingActionLabel(rowAction, pendingSetupIntent) : undefined
        const diagnostics = agent.diagnostics ?? []
        const currentErrors = (rowFeedback.get(id) ?? []).filter(entry => entry.source === feedbackIdentity(agent, settings?.acp, entry.action))
        const result = rowResults.get(id)
        const completing = completionMatches(agent)
        const currentResult = result && result.source === feedbackIdentity(agent, settings?.acp, result.action) && (result.kind !== 'success' || result.statusSource === requestSource(agent)) ? result : undefined
        const progress = completedProgress.get(id)
        const progressComplete = !rowAction && Boolean(progress && progress.expiresAt > Date.now()
          && progress.source === feedbackIdentity(agent, settings?.acp, progress.action) && progress.statusSource === requestSource(agent))
        const actionButton = (action: RuntimeAction, label: string, variant: 'primary' | 'outline' | 'ghost' = 'outline', setupIntent?: SetupIntent): JSX.Element => {
          const busy = pending === (action === 'refresh' || action === 'node' ? action : `${action}:${id}`) || automaticallyChecking && action === 'test'
          const Icon = action === 'setup' ? Download : action === 'test' ? PlugZap : action === 'refresh' ? RefreshCw : action === 'migration' ? ExternalLink : FolderOpen
          const busyLabel = busy && action === 'setup' ? (setupIntent === 'upgrade' ? '升级中…' : setupIntent === 'reinstall' ? '重装中…' : '安装中…') : label
          return <Button size="sm" variant={variant} aria-busy={busy || undefined} aria-label={`${agent.name} · ${busy ? automaticallyChecking ? '正在检测连接' : pendingActionLabel(action, pendingSetupIntent) : label}`} disabled={(controlsDisabled && !busy) || !hasIpc} aria-disabled={busy || undefined} onClick={() => { if (!busy) void run(action, id, setupIntent) }}>
            {busy ? <Loader2 size={13} className={motionEnabled ? 'animate-spin' : undefined} aria-hidden="true" /> : <Icon size={13} aria-hidden="true" />} {busyLabel}
          </Button>
        }
        const controls = (
          <div key={`details:${agent.id}`} id={controlsId} className="runtime-engine-controls" hidden={!open} role="region" aria-label={`${agent.name}设置`} ref={element => {
            if (element) detailRefs.current.set(id, element)
            else { rememberRemovedFocus(detailRefs.current.get(id), id); detailRefs.current.delete(id) }
          }}>
            {overview && <div className="runtime-engine-detail-heading"><span className="my-item-title">{agent.name}</span><Button size="sm" variant="ghost" aria-label={`关闭 ${agent.name} 设置`} onClick={() => {
              if (!canInteract()) return
              setExpanded(previous => ({ ...previous, [id]: false }))
              rowRefs.current.get(id)?.querySelector<HTMLButtonElement>('.runtime-engine-toggle')?.focus()
            }}><X size={14} /></Button></div>}
            {!unsupported && <div className="runtime-engine-actions" role="group" aria-label={`${agent.name}操作`}>
              {native && agent.availableMigration && actionButton('migration', `v${agent.availableMigration.version} 迁移指南`)}
              {heading && <Button size="sm" variant="outline" disabled={controlsDisabled || !hasIpc || !settings} aria-label={`${agent.name} · 默认配置`} onClick={event => { if (isCurrent() && canInteract()) { configTriggerRef.current = event.currentTarget; setConfigTargetRemoved(false); setConfiguring({ id, name: agent.name, launchKind: agent.launchKind }) } }}><Settings2 size={13} />默认配置</Button>}
              {!overview && sdk && onConfigureModels && <Button size="sm" variant="outline" disabled={controlsDisabled} aria-label={`${agent.name} · 配置模型`} onClick={() => { if (isCurrent() && canInteract()) onConfigureModels() }}><Settings2 size={13} />配置模型</Button>}
              {runtimeId && actionButton('refresh', '重新探测')}
              {zcode && agent.setupRequired && actionButton('setup', '安装', 'outline', 'install')}
              {canTest && primaryAction !== 'test' && actionButton('test', '测试连接')}
              {updatePending && canSetup && primaryAction !== 'setup' && actionButton('setup', '升级', 'outline', 'upgrade')}
              {(native || bundled) && primaryAction !== 'path' && actionButton('path', zcode ? '选择目录' : '配置路径')}
              {!heading && runtimeId && !sdk && !zcode && actionButton('node', '选择全局 Node')}
              {native && agent.available && canSetup && (agent.updateStatus === 'current' || agent.updateStatus === 'available') && actionButton('setup', '重装', 'ghost', 'reinstall')}
            </div>}
            {unsupported && <details className="runtime-engine-inspect">
              <summary><CircleAlert size={13} aria-hidden="true" /><span>停用说明</span><ChevronDown size={13} className="runtime-engine-inspect-chevron" aria-hidden="true" /></summary>
              <p className="runtime-engine-diagnostics">{agent.setupBlockedReason || '此自定义执行引擎已停用，无法启动或恢复。'}</p>
            </details>}
            <details className="runtime-engine-inspect" open={inspections[id]?.information ?? false}>
              <summary onClick={event => { event.preventDefault(); setInspections(previous => ({ ...previous, [id]: { ...previous[id], information: !previous[id]?.information } })) }}><Terminal size={13} aria-hidden="true" /><span>运行信息</span><ChevronDown size={13} className="runtime-engine-inspect-chevron" aria-hidden="true" /></summary>
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
            {diagnostics.length > 0 && <details className="runtime-engine-inspect" open={inspections[id]?.diagnostics ?? false}>
              <summary onClick={event => { event.preventDefault(); setInspections(previous => ({ ...previous, [id]: { ...previous[id], diagnostics: !previous[id]?.diagnostics } })) }}><CircleAlert size={13} aria-hidden="true" /><span>检测记录</span><span className="runtime-engine-record-count">{diagnostics.length}</span><ChevronDown size={13} className="runtime-engine-inspect-chevron" aria-hidden="true" /></summary>
              <ul className="runtime-engine-diagnostics">{diagnostics.map((message, diagnosticIndex) => <li key={diagnosticIndex}>{message}</li>)}</ul>
            </details>}
          </div>
        )
        const entry = (
        <div key={`header:${agent.id}`} className="runtime-engine" data-column={index % columns} data-runtime-id={id} data-expanded={open} data-operating={rowAction || undefined} data-selected={overview && modelRuntimeId === id || undefined} ref={element => {
          if (element) rowRefs.current.set(id, element)
          else { rememberRemovedFocus(rowRefs.current.get(id), id); rowRefs.current.delete(id) }
        }}>
          <div className="runtime-engine-heading">
            <button type="button" className="runtime-engine-toggle" aria-expanded={open} aria-controls={controlsId}
              onClick={() => { if (overview) selectEngine(id); setExpanded((previous) => overview ? { [id]: !open } : { ...previous, [id]: !open }) }}>
              <ToolBrandIcon brand={id} size={overview ? 24 : 32} />
              <span className="runtime-engine-identity">
                <span className="runtime-engine-name my-item-title"><span className="runtime-engine-title" title={agent.name}>{agent.name}</span>{agent.adapterVersion && <span className="runtime-engine-version" title={agent.adapterVersion}>v{agent.adapterVersion}</span>}</span>
                <span className={`runtime-engine-status${attention ? ' is-attention' : ''}`} data-complete={currentResult?.representedByHealth && !rowAction && completing || undefined}>
                  {rowAction ? <RuntimeActivity label={pendingText} animating={motionEnabled} /> : <>
                    <span key={runtimeHealthLabel(agent)} className="runtime-engine-status-value">{updatePending ? `可升级至 v${agent.latestVersion}` : runtimeHealthLabel(agent)}</span>
                  </>}
                </span>
              </span>
              <RuntimeConnectionIcon agent={agent} decorative />
              <ChevronDown size={15} className="runtime-engine-chevron" aria-hidden="true" />
            </button>
            {primaryAction && <div className="runtime-engine-primary" ref={element => {
              if (element) primaryRefs.current.set(id, element)
              else { rememberRemovedFocus(primaryRefs.current.get(id), id, false); primaryRefs.current.delete(id) }
            }}>{actionButton(primaryAction, primaryLabel, needsInstall || updatePending || zcode && !agent.available ? 'primary' : 'outline', primaryAction === 'setup' ? needsInstall ? 'install' : 'upgrade' : undefined)}</div>}
            {overview && !unsupported && sdk && onConfigureModels && <Button size="sm" variant="ghost" title="配置模型" disabled={controlsDisabled} aria-label={`${agent.name} · 配置模型`} onClick={() => { if (isCurrent() && canInteract()) { selectEngine(id); onConfigureModels() } }}><Settings2 size={14} /></Button>}
          </div>
          <div className="runtime-engine-progress-slot">
            {(rowAction || progressComplete) && <div className="runtime-engine-operation" data-complete={progressComplete || undefined} data-animating={rowAction && motionEnabled || undefined}>
              <div className="runtime-engine-progress" role="progressbar" aria-label={`${agent.name}：${progressComplete ? '已完成' : pendingText}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressComplete ? 100 : undefined} aria-valuetext={progressComplete ? '已完成，100%' : '进行中，进度未知'}><span /></div>
              <span className="runtime-engine-progress-value" aria-hidden="true">{progressComplete ? '100%' : ''}</span>
            </div>}
          </div>
          {currentResult && !rowAction && !(currentResult.kind === 'success' && (currentResult.representedByHealth || currentResult.text === runtimeHealthLabel(agent))) && <div className="runtime-engine-result" data-kind={currentResult.kind} data-animate={completing && currentResult.kind === 'success' || undefined}>{currentResult.kind === 'cancelled' ? <CircleX size={13} aria-hidden="true" /> : <CheckCircle2 key={completing ? completionBeat?.token : 'idle'} size={13} aria-hidden="true" />}<span>{ACTION_LABEL[currentResult.action]}：{currentResult.text}</span></div>}
          {currentErrors.map(error => <div key={error.action} className="runtime-engine-feedback">
            <p role="alert" className={`text-my-sm ${error.kind === 'error' || error.kind === 'not-admitted' ? 'text-my-danger-text' : 'text-my-secondary'}`}>{ACTION_LABEL[error.action]}：{error.text}</p>
            <RuntimeFeedbackDetails commandId={error.commandId} />
          </div>)}

        </div>
        )
        return { header: entry, controls }
      })
  const engineRows = engineEntries.flatMap((entry, index) => {
    const nodes = [entry.header]
    if ((index + 1) % columns === 0 || index === engineEntries.length - 1) {
      nodes.push(...engineEntries.slice(Math.floor(index / columns) * columns, index + 1).map(item => item.controls))
    }
    return nodes
  })
  const content = <>
      <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
      {(feedback || inventory.error) && <p role="alert" className="mb-3 break-words text-my-sm text-my-danger-text">{feedback ?? inventory.error}</p>}
      {staleFeedback.map(item => <div key={item.id} className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p role="status" className="whitespace-pre-wrap break-words text-my-sm text-my-secondary">{item.text}</p>
          <RuntimeFeedbackDetails commandId={item.commandId} />
        </div>
        <Button size="sm" variant="ghost" aria-label={`${item.label} · 关闭提示`} onClick={event => {
          const row = event.currentTarget.parentElement
          const next = row?.nextElementSibling?.querySelector<HTMLButtonElement>('button') ?? row?.previousElementSibling?.querySelector<HTMLButtonElement>('button')
          const target = next ?? panelRef.current
          target?.focus({ preventScroll: true })
          setStaleFeedback(previous => previous.filter(entry => entry.id !== item.id))
        }}>关闭</Button>
      </div>)}
      {visibleAgents.length === 0 && <p className="runtime-engine-empty text-my-sm text-my-tertiary">{inventory.reading ? '正在检测…' : runtimeId ? '未找到此执行引擎' : '暂未取得执行引擎列表'}</p>}
      {overview && visibleAgents.length > 0 && <div className="runtime-overview" role="group" aria-label="本机执行引擎">
        {overviewPageCount > 1 && <nav className="runtime-overview-pagination" aria-label="执行引擎概览分组">
          <Button size="sm" variant="ghost" aria-label="上一组执行引擎" aria-disabled={overviewPage === 0} onClick={() => { if (canInteract() && overviewPage > 0) selectEngine(visibleAgents[(overviewPage - 1) * overviewCapacity].id) }}><ChevronLeft size={14} /></Button>
          <span aria-label={`第 ${overviewPage + 1} 组，共 ${overviewPageCount} 组`}>{overviewPage + 1} / {overviewPageCount}</span>
          <Button size="sm" variant="ghost" aria-label="下一组执行引擎" aria-disabled={overviewPage + 1 >= overviewPageCount} onClick={() => { if (canInteract() && overviewPage + 1 < overviewPageCount) selectEngine(visibleAgents[(overviewPage + 1) * overviewCapacity].id) }}><ChevronRight size={14} /></Button>
        </nav>}
        <div className="runtime-overview-illustration my-scrollbar" role="group" aria-label="选择执行引擎">
          <div className="runtime-overview-track" style={{ height: `calc(var(--my-space-64) * ${Math.min(visibleAgents.length, overviewCapacity) > 6 ? 5 : 4})` }}>
          <svg viewBox={`0 0 ${illustrationWidth} 200`} preserveAspectRatio="none" className="runtime-overview-art" aria-hidden="true">
            <defs><linearGradient id={flowGradientId}><stop stopColor="var(--my-txt-tertiary)" /><stop offset="1" stopColor="var(--my-txt-primary)" /></linearGradient></defs>
            {illustrationItems.map(({ agent, id, path, state }) => <g key={agent.id} className="runtime-overview-branch" data-runtime-id={id} data-state={state} data-selected={modelRuntimeId === id || undefined} data-emphasized={modelRuntimeId === id || state === 'busy' || undefined}>
              <path className="runtime-overview-link" d={path} />
              {state === 'verified' && completionMatches(agent) && completionBeat?.action === 'test' && <path key={`verified-${id}-${completionBeat.token}`} className="runtime-overview-complete" d={path} pathLength="1" />}
              {state === 'busy' && motionEnabled && <>
                <path className="runtime-overview-flow" d={path} stroke={`url(#${flowGradientId})`} />
                {[0, 1].map(index => <circle key={index} className="runtime-overview-particle" r="2" fill={`url(#${flowGradientId})`}><animateMotion dur="2s" begin={`${-index}s`} repeatCount="indefinite" path={path} /></circle>)}
              </>}
            </g>)}
          </svg>
          <svg viewBox="235 18 130 160" className="runtime-overview-hub" aria-hidden="true" data-motion={motionEnabled} data-working={motionEnabled && (pending === 'refresh' || Boolean(inventory.checkingRuntimeId) || Boolean(pending && /^(setup|path|test):/.test(pending))) || undefined}>
            <path className="runtime-hub-base" d="M245 127v10q0 5 7 9l39 23q9 5 18 0l39-23q7-4 7-9v-10l-46 26q-9 5-18 0z" />
            <path className="runtime-hub-surface" d="m250 117 41-24q9-5 18 0l41 24q9 5 0 10l-41 24q-9 5-18 0l-41-24q-9-5 0-10z" />
            <path className="runtime-hub-edge" d="m251 139 40 23q9 5 18 0l40-23" />
            <g className="runtime-hub-moving runtime-hub-lower">
            <path className="runtime-hub-layer" d="M245 110v10q0 5 7 9l39 23q9 5 18 0l39-23q7-4 7-9v-10l-46 26q-9 5-18 0z" />
            <path className="runtime-hub-surface" d="m250 100 41-24q9-5 18 0l41 24q9 5 0 10l-41 24q-9 5-18 0l-41-24q-9-5 0-10z" />
            </g>
            <g className="runtime-hub-moving runtime-hub-middle">
            <path className="runtime-hub-base" d="M245 91v11q0 5 7 9l39 23q9 5 18 0l39-23q7-4 7-9V91l-46 26q-9 5-18 0z" />
            <path className="runtime-hub-surface" d="m250 81 41-24q9-5 18 0l41 24q9 5 0 10l-41 24q-9 5-18 0l-41-24q-9-5 0-10z" />
            <g className="runtime-hub-lights">{[[255,105],[264,110],[273,115],[282,120],[291,125],[300,129],[309,125],[318,120],[327,115],[336,110],[345,105]].map(([x,y]) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.6" />)}</g>
            </g>
            <g className="runtime-hub-moving runtime-hub-upper">
            <path className="runtime-hub-layer" d="M245 71v10q0 5 7 9l39 23q9 5 18 0l39-23q7-4 7-9V71l-46 26q-9 5-18 0z" />
            <path className="runtime-hub-surface" d="m250 61 41-24q9-5 18 0l41 24q9 5 0 10l-41 24q-9 5-18 0l-41-24q-9-5 0-10z" />
            <path className="runtime-hub-base" d="M245 58v11q0 5 7 9l39 23q9 5 18 0l39-23q7-4 7-9V58l-46 26q-9 5-18 0z" />
            <path className="runtime-hub-tiles" d="m252 82 8-5 9 5-8 5z M266 90l8-5 9 5-8 5z M280 98l8-5 9 5-8 5z M295 106l8-5 9 5-8 5z M310 99l8-5 9 5-8 5z M325 90l8-5 9 5-8 5z M340 82l8-5 7 4-8 5z" />
            <path className="runtime-hub-surface" d="m250 48 41-24q9-5 18 0l41 24q9 5 0 10l-41 24q-9 5-18 0l-41-24q-9-5 0-10z" />
            <path className="runtime-hub-inset" d="m256 49 37-21q7-4 14 0l37 21q7 4 0 8l-37 21q-7 4-14 0l-37-21q-7-4 0-8z" />
            <path className="runtime-hub-surface" d="m276 50 21-12q3-2 6 0l21 12q3 2 0 4l-21 12q-3 2-6 0l-21-12q-3-2 0-4z" />
            <path className="runtime-hub-edge" d="m285 52 8-5 8 5-8 5z M301 44l10 6m-6-10 10 6m-16 2 10 6" />
            <g className="runtime-hub-ports"><circle cx="245" cy="63" r="2.7" /><circle cx="355" cy="84" r="2.7" /><circle cx="245" cy="108" r="2.7" /><circle cx="355" cy="128" r="2.7" /></g>
            </g>
          </svg>
          {illustrationItems.map(({ agent, id, x, y, busy, error, state, status }) => <div key={agent.id} className="runtime-overview-node-wrap" data-state={state} data-selected={modelRuntimeId === id || undefined} style={{ left: `${100 * x / illustrationWidth}%`, top: `${y / 2}%`, width: '28%' }}>
            <button type="button" className="runtime-overview-node-control" data-runtime-id={id} aria-pressed={modelRuntimeId === id} aria-label={`${agent.name}，${status}${error ? '，有操作反馈' : ''}`}
              ref={element => {
                if (element) illustrationRefs.current.set(id, element)
                else { rememberRemovedFocus(illustrationRefs.current.get(id), id, diagramIdsRef.current.has(id)); illustrationRefs.current.delete(id) }
              }}
              onClick={() => selectIllustrationEngine(id)}>
              <ToolBrandIcon brand={id} size={24} />
              {busy && <span className="runtime-overview-node-activity" data-animating={motionEnabled || undefined} aria-hidden="true"><span /></span>}
            </button>
            <span className="runtime-overview-node-label" title={agent.name}>{agent.name}</span>
          </div>)}
          </div>
        </div>
        <div className="runtime-overview-summary">
          <span className="my-item-title">{selectedAgent?.name}</span>
          <span className="my-item-description">{selectedBusy ? <RuntimeActivity label={selectedStatus} animating={motionEnabled} /> : selectedStatus}</span>
        </div>
        <div className="runtime-overview-rows" data-columns={columns}>{engineRows}</div>
        <span className="sr-only" role="status" aria-live="polite">{selectedAgent ? `已选择 ${selectedAgent.name}，${selectedStatus}` : ''}</span>
      </div>}
      {!overview && engineRows}
    </>
  return <section ref={panelRef} tabIndex={-1} className="acp-engine-panel runtime-panel" aria-label="Agent 执行引擎">
    {heading ? <PreferenceSection id={sectionId} title="本机引擎" action={actions}>{content}</PreferenceSection>
      : <>{(!runtimeId || visibleAgents.length === 0) && <div className="mb-3">{actions}</div>}{content}</>}
    {configuring && <div onFocusCapture={event => { modalFocusRef.current = event.target }}><RuntimeDefaultsEditor key={configuring.id} runtimeId={configuring.id} launchKind={configuring.launchKind} name={configuring.name} initial={settings?.acp?.runtimeDefaults?.[configuring.id]} targetAvailable={!configTargetRemoved && configTargetAvailable} isCurrent={isCurrent} onClose={() => closeConfiguring()} onSaved={() => closeConfiguring(true)} /></div>}
  </section>
}
