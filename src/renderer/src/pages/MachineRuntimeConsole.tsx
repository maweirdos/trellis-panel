import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import {
  Activity, AlertTriangle, ArrowUpRight, Bot, Brain, Check, ChevronDown, ChevronRight, Coffee, Copy, Download, ExternalLink, Eye, EyeOff,
  FolderOpen, HardDrive, Loader2, Palette, Play, Plug, Plus, RefreshCw, RotateCcw, Search,
  Server, Settings2, Sparkles, Square, Terminal, Trash2, X, Zap
} from 'lucide-react'
import type { CruxRuntimeKind, CruxWorkingDirectoryMode } from '@shared/crux'
import type { DesktopTeamConnection } from '@shared/team-desktop'
import type { AcpAgentStatus, AcpConnectionProbeResult, AcpProfileArg, AcpProfileEnvVar, AcpRuntimeDefaults, AcpRuntimeSetupPhase, AcpRuntimeSetupProgress, McpInfo } from '../../../shared/types'
import { api, hasIpc } from '../api'
import { cleanRuntimeConfig, runtimeConfigError } from '../acp/runtime-config'
import { runtimeConnectionState, runtimeHealthLabel } from '../acp/runtime-status'
import { getRuntimeInventorySnapshot, subscribeRuntimeInventory, useRuntimeInventoryRefresh } from '../acp/useRuntimeInventoryRefresh'
import { confirmDialog } from '../components/Dialogs'
import { Select } from '../components/Select'
import { ToolBrandIcon } from '../components/ToolBrandIcon'
import { useConversationModelCatalog } from '../conversation-workbench/useConversationModelCatalog'
import {
  useCollaborationPlatform,
  type CustomRuntimeConfig,
  type EnvPair,
  type IsolationMode
} from '../crux/collaboration-platform-store'
import {
  APPROVAL_OPTIONS_BY_RUNTIME,
  toCruxRuntimeKind,
  useLocalExecutionSlot,
  WORKDIR_MODE_OPTIONS,
  type LocalApprovalPolicy,
  type MachineVisibilityScope
} from '../crux/local-execution-slot'
import { useCrux } from '../crux/store'
import { isActiveRunStatus, useTaskRuns } from '../crux/task-run-store'
import { EffortDetentFader, EffortStylePickerPopover } from '../components/effort/EffortDetentFader'
import { EFFORT_TRACK_TONES, findEffortStyleOption, useIsDarkTheme } from '../components/effort/effort-catalog'
import { Button, Dropdown, EmptyState, Modal, Switch } from '../my/ui'
import { useApp } from '../store'
import './machines.css'

interface DaemonSummary {
  running: boolean
  pid?: number
  activeJobs?: number
  buildState?: 'current' | 'changed' | 'unknown'
  label: string
}

interface UnifiedRuntimeItem {
  id: string
  name: string
  kind: 'builtin' | 'custom'
  protocolLabel: string
  agent?: AcpAgentStatus
  custom?: CustomRuntimeConfig
  ready: boolean
  needsAttention: boolean
  updateAvailable: boolean
  version?: string
  railStatus: string
  statusText: string
  commandDisplay: string
  binaryLabel: string
  nodeLabel: string
}

type ModelSourceKind = 'native' | 'cc-switch' | 'magpie' | 'provider' | 'routing' | 'acp' | 'custom' | 'manual'

interface ModelEffortChoice {
  value: string
  label: string
}

interface ModelCatalogCardItem {
  id: string
  displayName: string
  showRawId: boolean
  sourceKind: ModelSourceKind
  sourceLabel: string
  groupKey: string
  groupLabel: string
  isEngineDefault?: boolean
  isManual?: boolean
  contextTag?: string
  effortChoices?: readonly ModelEffortChoice[]
  defaultEffort?: string
}

const SOURCE_FILTER_META: Readonly<Record<ModelSourceKind, { label: string; order: number }>> = {
  native: { label: '原生账号', order: 1 },
  'cc-switch': { label: 'CC Switch', order: 2 },
  magpie: { label: 'Magpie', order: 3 },
  provider: { label: '聚合渠道', order: 4 },
  routing: { label: '路由组', order: 5 },
  acp: { label: '引擎目录', order: 6 },
  custom: { label: '自定义代理', order: 7 },
  manual: { label: '手动声明', order: 8 }
}

const KEEP_AWAKE_OPTIONS: Array<{ value: '30m' | '1h' | '2h' | '5h' | 'permanent'; label: string }> = [
  { value: '30m', label: '30 分钟' },
  { value: '1h', label: '1 小时' },
  { value: '2h', label: '2 小时' },
  { value: '5h', label: '5 小时' },
  { value: 'permanent', label: '持续保持唤醒' }
]

interface SetupTaskView extends AcpRuntimeSetupProgress {
  outcome?: 'unknown' | 'not-admitted'
  commandId?: string
  /** 无法读取后台实时进度时（例如旧版后台服务）标记为本地降级等待态 */
  fallbackLocal?: boolean
}

const NATIVE_SETUP_STEPS: ReadonlyArray<{ phase: AcpRuntimeSetupPhase; label: string }> = [
  { phase: 'checking_env', label: '检查环境' },
  { phase: 'reading_version', label: '核对版本' },
  { phase: 'checking_registry', label: '查询仓库' },
  { phase: 'installing', label: '安装更新' },
  { phase: 'verifying', label: '核验版本' },
  { phase: 'refreshing', label: '刷新状态' }
]

const MANAGED_SETUP_STEPS: ReadonlyArray<{ phase: AcpRuntimeSetupPhase; label: string }> = [
  { phase: 'checking_env', label: '检查环境' },
  { phase: 'installing', label: '安装适配器' },
  { phase: 'verifying', label: '核验入口' },
  { phase: 'refreshing', label: '刷新状态' }
]

const SETUP_PHASE_ORDER: Readonly<Record<AcpRuntimeSetupPhase, number>> = {
  checking_env: 0,
  reading_version: 1,
  checking_registry: 2,
  installing: 3,
  verifying: 4,
  refreshing: 5,
  succeeded: 6,
  failed: -1
}

function formatSetupElapsed(startedAt: number, finishedAt: number | undefined, now: number): string {
  const elapsedMs = Math.max(0, (finishedAt ?? now) - startedAt)
  if (finishedAt !== undefined && elapsedMs < 60_000) {
    return `${(elapsedMs / 1000).toFixed(1)}s`
  }
  const totalSec = Math.floor(elapsedMs / 1000)
  const mins = Math.floor(totalSec / 60)
  const secs = totalSec % 60
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

function resolveSetupStepState(
  task: SetupTaskView,
  stepPhase: AcpRuntimeSetupPhase,
  failedAtPhase?: AcpRuntimeSetupPhase
): 'done' | 'active' | 'error' | 'pending' {
  if (task.state === 'succeeded') return 'done'
  if (task.state === 'failed') {
    const anchor = failedAtPhase && failedAtPhase !== 'failed' ? failedAtPhase : 'installing'
    const anchorOrder = SETUP_PHASE_ORDER[anchor] ?? 0
    const stepOrder = SETUP_PHASE_ORDER[stepPhase] ?? 0
    if (stepOrder < anchorOrder) return 'done'
    if (stepOrder === anchorOrder) return 'error'
    return 'pending'
  }
  const currentOrder = SETUP_PHASE_ORDER[task.phase] ?? 0
  const stepOrder = SETUP_PHASE_ORDER[stepPhase] ?? 0
  if (stepOrder < currentOrder) return 'done'
  if (stepOrder === currentOrder) return 'active'
  return 'pending'
}

function isSupportedBuiltin(agent: AcpAgentStatus): boolean {
  return agent.launchKind !== 'custom' && agent.id !== 'opencode'
}

function middleTruncatePath(raw: string, maxLen = 46): string {
  if (!raw || raw.length <= maxLen) return raw
  const sep = raw.includes('\\') ? '\\' : '/'
  const parts = raw.split(sep)
  if (parts.length <= 2) return `${raw.slice(0, 20)}…${raw.slice(-20)}`
  return `${parts[0]}${sep}…${sep}${parts.slice(-2).join(sep)}`
}

function extractBinaryLabel(raw: string, fallback: string): string {
  const clean = raw.trim()
  if (!clean) return fallback
  const firstToken = clean.split(/\s+/)[0] ?? clean
  const segments = firstToken.split(/[\\/]/)
  return segments[segments.length - 1] || fallback
}

function protocolLabelFor(agent: AcpAgentStatus): string {
  if (agent.launchKind === 'sdk') return '内置 SDK'
  if (agent.launchKind === 'bundled') return '托管 CLI'
  if (agent.releaseChannel === 'v2') return 'ACP v2'
  return '本地 CLI'
}

function railStatusLabel(agent: AcpAgentStatus, ready: boolean, updateAvailable: boolean): string {
  if (agent.launchKind === 'sdk') return agent.enabled ? '已就绪' : '已停用'
  if (updateAvailable) return '有新版本'
  if (ready) return '已就绪'
  if (agent.setupRequired || !agent.available) return '未安装'
  const raw = runtimeHealthLabel(agent)
  if (/不兼容/.test(raw)) return '待升级'
  if (/失败|异常|错误/.test(raw)) return '启动异常'
  if (/待验证/.test(raw)) return '待测速'
  return raw
}

function heroStatusLabel(agent: AcpAgentStatus, ready: boolean, updateAvailable: boolean): string {
  if (agent.launchKind === 'sdk') return agent.enabled ? '内置直连 · 已就绪' : '已停用'
  if (updateAvailable && agent.latestVersion) return `可升级至 v${agent.latestVersion}`
  if (ready) return runtimeHealthLabel(agent)
  return runtimeHealthLabel(agent)
}

function parseModelDisplay(id: string, displayName: string): {
  cleanName: string
  contextTag?: string
  upstreamLabel?: string
  isRoutingGroup: boolean
  showRawId: boolean
} {
  let raw = (displayName || id).trim()
  const ccsCodex = /^ccs-([^/]+)\/(.+)$/i.exec(raw)
  let inferredUpstream: string | undefined
  if (ccsCodex) {
    inferredUpstream = ccsCodex[1]
    raw = ccsCodex[2]
  }
  const ccsClaude = /^ccs-claude-([^-]+)--(.+)$/i.exec(raw)
  if (ccsClaude) {
    inferredUpstream = ccsClaude[1]
    raw = ccsClaude[2]
  }
  const bracketPrefix = /^\[([^\]]+)\]\s*(.+)$/.exec(raw)
  if (bracketPrefix && !/^\d+(?:\.\d+)?[KM]$/i.test(bracketPrefix[1])) {
    inferredUpstream = inferredUpstream ?? bracketPrefix[1]
    raw = bracketPrefix[2]
  }

  let isRoutingGroup = false
  if (/\s*·\s*routing\s*group$/i.test(raw)) {
    isRoutingGroup = true
    raw = raw.replace(/\s*·\s*routing\s*group$/i, '').trim()
  }

  // 解析聚合网关常见的 "<ModelName> · <Upstream>" 格式（如 "DeepSeek-V4-Pro · DeepSeek" / "Claude Opus 5.5 · any"）
  const middleDotMatch = /^(.+?)\s*·\s*([^·]+)$/.exec(raw)
  if (middleDotMatch) {
    raw = middleDotMatch[1].trim()
    inferredUpstream = middleDotMatch[2].trim()
  }

  // 同时从显示名与原始 ID 中提取真实上下文标记（如 [1M] / [200K]）
  let contextTag: string | undefined
  const ctxMatch = /\s*\[(\d+(?:\.\d+)?[KM])\]/i.exec(raw)
  if (ctxMatch) {
    contextTag = ctxMatch[1].toUpperCase()
    raw = raw.replace(ctxMatch[0], '').trim()
  } else {
    const idCtxMatch = /\[(\d+(?:\.\d+)?[KM])\]/i.exec(id)
    if (idCtxMatch) contextTag = idCtxMatch[1].toUpperCase()
  }

  // 从 "<prefix>/<slug>" 原始 ID 中提取上游前缀
  const cleanIdForCompare = id.replace(/\[(\d+(?:\.\d+)?[KM])\]/gi, '').trim()
  const slashMatch = /^([^/]+)\/(.+)$/.exec(cleanIdForCompare)
  const idSlug = slashMatch ? slashMatch[2] : cleanIdForCompare
  if (!inferredUpstream && slashMatch && !/^ccs-/i.test(slashMatch[1])) {
    inferredUpstream = slashMatch[1]
  }

  const norm = (s: string): string => s.toLowerCase().replace(/[\s_.-]+/g, '')
  const showRawId = Boolean(id && norm(idSlug) !== norm(raw) && norm(cleanIdForCompare) !== norm(raw))
  return {
    cleanName: raw || id,
    contextTag,
    upstreamLabel: inferredUpstream,
    isRoutingGroup,
    showRawId
  }
}

const EFFORT_SHORT_LABELS: Readonly<Record<string, string>> = {
  none: '关',
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '最高',
  ultra: '极限'
}

function normalizeEffortChoices(choices: readonly { value: string; label: string }[]): ModelEffortChoice[] {
  return choices.map((choice) => ({
    value: choice.value,
    label: EFFORT_SHORT_LABELS[choice.value.toLowerCase()] ?? EFFORT_SHORT_LABELS[choice.label.toLowerCase()] ?? choice.label
  }))
}

function isDaemonOutdatedMessage(message: string | undefined): boolean {
  if (!message) return false
  return /daemon build is outdated|unverified|--trellis-role=control|daemon.*outdated/i.test(message)
}

function classifyDriverModelSource(
  model: { id: string; displayName: string; providerId?: string; group?: string },
  fallbackLabel: string,
  parsed: { isRoutingGroup: boolean; upstreamLabel?: string }
): { sourceKind: ModelSourceKind; sourceLabel: string; groupKey: string; groupLabel: string } {
  const group = (model.group ?? '').trim()
  const groupLower = group.toLowerCase()
  const providerId = (model.providerId ?? '').trim()
  const upstream = parsed.upstreamLabel?.trim()
  const ccsCodex = /^ccs-([^/]+)\//i.exec(model.id)
  const ccsClaude = /^ccs-claude-([^-]+)--/i.exec(model.id)
  const ccsKey = ccsCodex?.[1] ?? ccsClaude?.[1]
  const isMagpie = /magpie/i.test(group) || /magpie/i.test(providerId) || /magpie/i.test(ccsKey ?? '') || /magpie/i.test(upstream ?? '') || /magpie/i.test(model.id)

  if (parsed.isRoutingGroup) {
    return { sourceKind: 'routing', sourceLabel: '路由组', groupKey: 'routing:default', groupLabel: '路由组' }
  }
  if (groupLower === 'cc-switch' || ccsKey) {
    const channel = upstream || (providerId && providerId.toLowerCase() !== 'cc-switch' ? providerId : ccsKey)
    if (isMagpie) {
      return { sourceKind: 'magpie', sourceLabel: 'CC Switch · Magpie', groupKey: 'magpie:cc-switch', groupLabel: 'Magpie' }
    }
    const label = channel ? `CC Switch · ${channel}` : 'CC Switch'
    return { sourceKind: 'cc-switch', sourceLabel: label, groupKey: `cc-switch:${channel ?? 'default'}`, groupLabel: label }
  }
  if (groupLower === 'magpie' || isMagpie) {
    const label = upstream && !/magpie/i.test(upstream) ? `Magpie · ${upstream}` : 'Magpie'
    return { sourceKind: 'magpie', sourceLabel: label, groupKey: `magpie:${upstream ?? 'default'}`, groupLabel: label }
  }
  if (upstream) {
    return { sourceKind: 'provider', sourceLabel: upstream, groupKey: `provider:${upstream.toLowerCase()}`, groupLabel: upstream }
  }
  if (groupLower === 'native') {
    return { sourceKind: 'native', sourceLabel: '原生账号', groupKey: 'native:default', groupLabel: '原生账号' }
  }
  if (groupLower === 'custom') {
    const label = providerId || '自定义代理'
    return { sourceKind: 'custom', sourceLabel: label, groupKey: `custom:${label.toLowerCase()}`, groupLabel: label }
  }
  if (group) {
    return { sourceKind: 'acp', sourceLabel: group, groupKey: `acp:${group.toLowerCase()}`, groupLabel: group }
  }
  return { sourceKind: 'native', sourceLabel: fallbackLabel, groupKey: `native:${fallbackLabel}`, groupLabel: fallbackLabel }
}

function classifyAiProviderSource(provider: { name: string; baseUrl: string; id: string }): { sourceKind: ModelSourceKind; sourceLabel: string } {
  const hint = `${provider.name} ${provider.baseUrl} ${provider.id}`
  if (/magpie/i.test(hint)) {
    return { sourceKind: 'magpie', sourceLabel: provider.name || 'Magpie' }
  }
  return { sourceKind: 'provider', sourceLabel: provider.name || 'AI 供应商' }
}

function buildOscSvg(samples: number[]): { line: string; area: string; last: { x: number; y: number } } | null {
  if (samples.length === 0) return null
  const points = samples.length === 1 ? [samples[0], samples[0]] : samples
  const min = Math.min(...points)
  const max = Math.max(...points)
  const span = Math.max(12, (max - min) * 1.45)
  const base = Math.max(0, min - span * 0.22)
  const coords = points.map((value, index) => {
    const x = (index / (points.length - 1)) * 172
    const y = 30 - ((value - base) / span) * 22
    return { x: Number(x.toFixed(1)), y: Number(Math.max(4, Math.min(32, y)).toFixed(1)) }
  })
  let line = `M ${coords[0].x} ${coords[0].y}`
  for (let i = 1; i < coords.length; i++) {
    const prev = coords[i - 1]
    const curr = coords[i]
    const midX = ((prev.x + curr.x) / 2).toFixed(1)
    line += ` C ${midX} ${prev.y}, ${midX} ${curr.y}, ${curr.x} ${curr.y}`
  }
  const area = `${line} L 172 36 L 0 36 Z`
  return { line, area, last: coords[coords.length - 1] }
}

export interface MachineRuntimeConsoleProps {
  onOpenModels?: () => void
  onOpenGateway?: () => void
  onOpenDaemonLogs?: () => void
  onManageAgents?: () => void
}

export function MachineRuntimeConsole({
  onOpenModels,
  onOpenGateway,
  onOpenDaemonLogs,
  onManageAgents
}: MachineRuntimeConsoleProps): JSX.Element {
  const pushToast = useApp((s) => s.pushToast)
  const settings = useApp((s) => s.settings)
  const saveSettings = useApp((s) => s.saveSettings)
  const snapshot = useCrux((s) => s.snapshot)
  const workspaceContext = useCrux((s) => s.workspaceContext)
  const runs = useTaskRuns((s) => s.runs)

  const {
    defaultSlot,
    machineVisibility,
    allowedSpaceIds,
    conflictNotice,
    setDefaultSlot,
    setMachineVisibility,
    clearConflictNotice
  } = useLocalExecutionSlot()

  const isDarkTheme = useIsDarkTheme()
  const {
    customRuntimes,
    runtimeLaunchConfigs,
    cleanupPolicy,
    keepAwake,
    effortEmblemStyle,
    effortTrackTone,
    upsertCustomRuntime,
    archiveCustomRuntime,
    setRuntimeLaunchConfig,
    setCleanupPolicy,
    setKeepAwake,
    setEffortEmblemStyle,
    setEffortTrackTone
  } = useCollaborationPlatform()

  const [agents, setAgents] = useState<AcpAgentStatus[]>(getRuntimeInventorySnapshot)
  const [daemon, setDaemon] = useState<DaemonSummary | null>(null)
  const [daemonBusy, setDaemonBusy] = useState(false)
  const [connections, setConnections] = useState<DesktopTeamConnection[]>([])
  const [checkingConnId, setCheckingConnId] = useState<string | null>(null)
  const [mcpInfo, setMcpInfo] = useState<McpInfo | null>(null)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'attention'>('all')
  const [stageTab, setStageTab] = useState<'models' | 'env' | 'diag'>('models')
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [rowError, setRowError] = useState<Record<string, string>>({})
  const [setupTasks, setSetupTasks] = useState<Record<string, SetupTaskView>>({})
  const [setupLastPhase, setSetupLastPhase] = useState<Record<string, AcpRuntimeSetupPhase>>({})
  const [setupLogsOpen, setSetupLogsOpen] = useState<Record<string, boolean>>({})
  const [setupCopiedId, setSetupCopiedId] = useState<string | null>(null)
  const [setupNow, setSetupNow] = useState<number>(() => Date.now())
  const setupLogEndRef = useRef<HTMLDivElement | null>(null)
  const activeSetupCallRef = useRef<string | null>(null)
  const [latencyHistory, setLatencyHistory] = useState<Record<string, number[]>>({})
  const [probeInfo, setProbeInfo] = useState<Record<string, AcpConnectionProbeResult>>({})
  const [flashCmd, setFlashCmd] = useState(false)
  const [copiedCmd, setCopiedCmd] = useState(false)
  const [revealSecret, setRevealSecret] = useState(false)

  const [opsModalOpen, setOpsModalOpen] = useState(false)
  const [customModal, setCustomModal] = useState<CustomRuntimeConfig | 'new' | null>(null)
  const [manualModelDraft, setManualModelDraft] = useState('')
  const [modelSourceFilter, setModelSourceFilter] = useState<ModelSourceKind | 'all'>('all')
  const [modelSearchQuery, setModelSearchQuery] = useState('')
  const [effortPreview, setEffortPreview] = useState<{ modelId: string; label: string; isPeak: boolean } | null>(null)
  const [argDraft, setArgDraft] = useState('')
  const [envKeyDraft, setEnvKeyDraft] = useState('')
  const [envValDraft, setEnvValDraft] = useState('')
  const [workRoot, setWorkRoot] = useState('')

  const activeProjectRoot = useApp((s) => s.snapshot?.meta.root ?? '')
  useEffect(() => {
    if (!hasIpc) return
    let active = true
    void api.conversationWorkRoot?.().then((res) => {
      if (active && res.ok) setWorkRoot(res.root)
    }).catch(() => undefined)
    return () => { active = false }
  }, [])
  const catalogRoot = workRoot || activeProjectRoot
  const modelCatalog = useConversationModelCatalog(catalogRoot, hasIpc && Boolean(catalogRoot), 'runtime-console')
  useEffect(() => {
    if (hasIpc && catalogRoot) void modelCatalog.refresh()
  }, [catalogRoot, modelCatalog.refresh])

  const liveRef = useRef(true)
  useEffect(() => {
    liveRef.current = true
    const unsub = subscribeRuntimeInventory(setAgents)
    return () => {
      liveRef.current = false
      unsub()
    }
  }, [])

  const inventory = useRuntimeInventoryRefresh({
    enabled: true,
    paused: pendingAction !== null,
    agents,
    isCurrent: () => liveRef.current,
    onChange: setAgents
  })

  const loadInfrastructure = useCallback(async (): Promise<void> => {
    if (!hasIpc) return
    try {
      const reply = await api.daemon?.status?.()
      let buildState: DaemonSummary['buildState']
      try {
        const recovery = await api.daemon?.inspectRecovery?.()
        if (recovery && typeof recovery === 'object' && 'ok' in recovery && recovery.ok && 'data' in recovery && recovery.data) {
          buildState = recovery.data.build
        }
      } catch { /* 旧版 preload 不支持 inspectRecovery 时忽略 */ }

      if (liveRef.current && reply && typeof reply === 'object' && 'ok' in reply && reply.ok && 'data' in reply && reply.data) {
        const info = reply.data as { running?: boolean; pid?: number | null; owner?: { pid?: number }; activeJobs?: number; state?: string }
        const running = info.running === true || info.state === 'running'
        const pid = typeof info.pid === 'number' ? info.pid : typeof info.owner?.pid === 'number' ? info.owner.pid : undefined
        setDaemon({
          running,
          pid,
          activeJobs: typeof info.activeJobs === 'number' ? info.activeJobs : 0,
          buildState,
          label: running ? (buildState === 'changed' ? '需重启更新' : '运行中') : '未启动'
        })
      } else if (liveRef.current) {
        setDaemon({ running: false, buildState, label: '已停止' })
      }
    } catch {
      if (liveRef.current) setDaemon({ running: false, label: '状态待检' })
    }
    try {
      const connReply = await api.teamDesktop?.connections?.()
      if (liveRef.current && connReply?.ok) {
        setConnections(connReply.value.filter((item) => item.state !== 'disconnected'))
      }
    } catch {
      // 未绑定远端团队服务时保持空列表
    }
    try {
      const mcp = await api.getMcpInfo?.()
      if (liveRef.current && mcp) setMcpInfo(mcp)
    } catch {
      // 无 MCP 网关状态时保持空值
    }
  }, [])

  useEffect(() => {
    void loadInfrastructure()
    if (!hasIpc || !api.teamDesktop?.onChanged) return
    return api.teamDesktop.onChanged(() => { void loadInfrastructure() })
  }, [loadInfrastructure])

  const triggerCmdFlash = useCallback((): void => {
    setFlashCmd(true)
    window.setTimeout(() => {
      if (liveRef.current) setFlashCmd(false)
    }, 460)
  }, [])

  const unifiedRuntimes = useMemo<UnifiedRuntimeItem[]>(() => {
    const builtins: UnifiedRuntimeItem[] = agents.filter(isSupportedBuiltin).map((agent) => {
      const id = agent.runtimeId ?? agent.id
      const conn = runtimeConnectionState(agent)
      const updateAvailable = agent.launchKind === 'native' && agent.available && agent.updateStatus === 'available'
      const ready = agent.launchKind === 'sdk' ? agent.enabled : Boolean(agent.available && !agent.setupRequired && conn !== 'error')
      const needsAttention = !ready || updateAvailable || conn === 'error'
      const rawCmd = agent.launchKind === 'sdk' ? '应用内置 SDK' : (agent.executable || agent.command || id)
      return {
        id,
        name: agent.name,
        kind: 'builtin',
        protocolLabel: protocolLabelFor(agent),
        agent,
        ready,
        needsAttention,
        updateAvailable,
        version: agent.adapterVersion,
        railStatus: railStatusLabel(agent, ready, updateAvailable),
        statusText: heroStatusLabel(agent, ready, updateAvailable),
        commandDisplay: rawCmd,
        binaryLabel: agent.launchKind === 'sdk' ? 'crux-sdk' : extractBinaryLabel(rawCmd, id),
        nodeLabel: agent.launchKind === 'sdk' || id === 'zcode' ? '应用内置' : (agent.nodePath ? middleTruncatePath(agent.nodePath, 26) : '由引擎管理')
      }
    })
    const customs: UnifiedRuntimeItem[] = customRuntimes
      .filter((rt) => !rt.archived)
      .map((rt) => ({
        id: rt.id,
        name: rt.displayName,
        kind: 'custom',
        protocolLabel: `自定义 ${rt.base.toUpperCase()}`,
        custom: rt,
        ready: Boolean(rt.command.trim()),
        needsAttention: !rt.command.trim(),
        updateAvailable: false,
        railStatus: rt.command.trim() ? '已配置' : '待配置',
        statusText: rt.command.trim() ? '已配置' : '待补命令',
        commandDisplay: `${rt.command}${rt.args.length ? ` ${rt.args.join(' ')}` : ''}`,
        binaryLabel: extractBinaryLabel(rt.command, rt.displayName),
        nodeLabel: '本地命令'
      }))
    return [...builtins, ...customs]
  }, [agents, customRuntimes])

  const defaultRuntimeId = useMemo(() => {
    if (defaultSlot.runtimeId && unifiedRuntimes.some((item) => item.id === defaultSlot.runtimeId)) {
      return defaultSlot.runtimeId
    }
    const matched = unifiedRuntimes.find((item) => {
      if (defaultSlot.runtimeKind === 'codex') return item.id.toLowerCase().includes('codex')
      if (defaultSlot.runtimeKind === 'claude-code') return item.id.toLowerCase().includes('claude')
      return item.id.toLowerCase().includes('pi')
    })
    return matched?.id ?? unifiedRuntimes[0]?.id ?? null
  }, [defaultSlot.runtimeId, defaultSlot.runtimeKind, unifiedRuntimes])

  useEffect(() => {
    if (selectedId && unifiedRuntimes.some((item) => item.id === selectedId)) return
    setSelectedId(defaultRuntimeId ?? unifiedRuntimes[0]?.id ?? null)
  }, [defaultRuntimeId, selectedId, unifiedRuntimes])

  const filteredRuntimes = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    return unifiedRuntimes.filter((item) => {
      if (statusFilter === 'attention' && !item.needsAttention) return false
      if (!q) return true
      return `${item.name} ${item.id} ${item.protocolLabel} ${item.commandDisplay}`.toLowerCase().includes(q)
    })
  }, [searchQuery, statusFilter, unifiedRuntimes])

  const selected = useMemo(
    () => unifiedRuntimes.find((item) => item.id === selectedId) ?? unifiedRuntimes[0] ?? null,
    [selectedId, unifiedRuntimes]
  )

  const readyCount = unifiedRuntimes.filter((item) => item.ready).length
  const attentionCount = unifiedRuntimes.filter((item) => item.needsAttention).length
  const activeRunCount = runs.filter((run) => isActiveRunStatus(run.status)).length
  const activeConnections = connections.filter((item) => item.state === 'active' && !item.accessLocked)
  const availableSpaces = snapshot?.spaces.filter((space) => !space.archived) ?? []
  const machineTitle = activeConnections[0]?.deviceName || workspaceContext.projectName || '本机算力工作台'

  const handleGlobalRefresh = async (): Promise<void> => {
    if (pendingAction) return
    setPendingAction('refresh')
    try {
      if (hasIpc) {
        const res = await api.acpRuntimeRefresh()
        if (res.agents && liveRef.current) setAgents(res.agents)
        await loadInfrastructure()
        pushToast(res.ok ? { kind: 'success', title: '已完成本机 Runtime 重新探测' } : { kind: 'error', title: '探测未完成', body: res.error ?? '请稍后重试' })
      } else {
        pushToast({ kind: 'info', title: '当前为浏览器预览模式，无法执行本机探测' })
      }
    } finally {
      if (liveRef.current) setPendingAction(null)
    }
  }

  const handleTestConnection = async (item: UnifiedRuntimeItem): Promise<void> => {
    if (!hasIpc || pendingAction || item.kind !== 'builtin' || item.agent?.launchKind === 'sdk') return
    setPendingAction(`test:${item.id}`)
    setRowError((prev) => { const next = { ...prev }; delete next[item.id]; return next })
    const started = performance.now()
    try {
      const res = await api.acpRuntimeTestConnection(item.id)
      const elapsed = Math.max(1, Math.round(performance.now() - started))
      if (res.agents && liveRef.current) setAgents(res.agents)
      if (res.probe && liveRef.current) {
        setProbeInfo((prev) => ({ ...prev, [item.id]: res.probe! }))
      }
      if (!res.ok || (res.probe && !res.probe.ok)) {
        const msg = res.probe?.error ?? res.error ?? '握手探测失败，请检查可执行路径或登录凭据。'
        if (liveRef.current) setRowError((prev) => ({ ...prev, [item.id]: msg }))
        pushToast({ kind: 'error', title: `${item.name} 连接失败`, body: msg })
        return
      }
      if (liveRef.current) {
        setLatencyHistory((prev) => ({ ...prev, [item.id]: [...(prev[item.id] ?? []).slice(-11), elapsed] }))
      }
      pushToast({ kind: 'success', title: `${item.name} 握手验证通过（${elapsed}ms）` })
    } catch (error) {
      const msg = error instanceof Error ? error.message : '连接探测异常'
      if (liveRef.current) setRowError((prev) => ({ ...prev, [item.id]: msg }))
      pushToast({ kind: 'error', title: `${item.name} 探测异常`, body: msg })
    } finally {
      if (liveRef.current) setPendingAction(null)
    }
  }

  const syncSetupStatus = useCallback(async (targetId?: string): Promise<AcpRuntimeSetupProgress[]> => {
    if (!hasIpc || typeof api.acpRuntimeSetupStatus !== 'function') return []
    try {
      const reply = await api.acpRuntimeSetupStatus(targetId)
      if (!reply?.ok || !Array.isArray(reply.tasks)) {
        if (targetId && liveRef.current) {
          setSetupTasks((prev) => {
            const cur = prev[targetId]
            if (!cur || cur.state !== 'running' || cur.fallbackLocal) return prev
            return { ...prev, [targetId]: { ...cur, fallbackLocal: true } }
          })
        }
        return []
      }
      if (!liveRef.current) return reply.tasks
      if (reply.tasks.length > 0) {
        setSetupTasks((prev) => {
          const next = { ...prev }
          for (const task of reply.tasks!) {
            const existing = prev[task.runtimeId]
            // 保留本地已确认的终态（含 outcome/commandId），仅在后台仍在运行或更新更晚时覆盖
            if (existing && existing.state !== 'running' && task.state !== 'running' && (existing.finishedAt ?? 0) > (task.finishedAt ?? 0)) {
              continue
            }
            next[task.runtimeId] = { ...task, fallbackLocal: false }
          }
          return next
        })
        setSetupLastPhase((prev) => {
          let changed = false
          const next = { ...prev }
          for (const task of reply.tasks!) {
            if (task.phase !== 'failed' && task.phase !== 'succeeded' && next[task.runtimeId] !== task.phase) {
              next[task.runtimeId] = task.phase
              changed = true
            }
          }
          return changed ? next : prev
        })
      }
      return reply.tasks
    } catch {
      if (targetId && liveRef.current) {
        setSetupTasks((prev) => {
          const cur = prev[targetId]
          if (!cur || cur.state !== 'running' || cur.fallbackLocal) return prev
          return { ...prev, [targetId]: { ...cur, fallbackLocal: true } }
        })
      }
      return []
    }
  }, [])

  // 首次进入页面时恢复后台可能正在进行的安装/升级进度（例如切换模块或重启窗口后）
  useEffect(() => {
    if (!hasIpc || typeof api.acpRuntimeSetupStatus !== 'function') return
    let active = true
    void syncSetupStatus().then((tasks) => {
      if (!active || !liveRef.current) return
      const running = tasks.find((task) => task.state === 'running')
      if (running) {
        setPendingAction((prev) => prev ?? `setup:${running.runtimeId}`)
      }
    })
    return () => { active = false }
  }, [syncSetupStatus])

  const activeSetupRuntimeId = useMemo(() => {
    if (pendingAction?.startsWith('setup:')) return pendingAction.slice('setup:'.length)
    return Object.values(setupTasks).find((task) => task.state === 'running')?.runtimeId ?? null
  }, [pendingAction, setupTasks])

  // 仅当存在运行中的升级/安装任务时驱动等宽秒表与后台阶段轮询
  useEffect(() => {
    if (!activeSetupRuntimeId) return
    setSetupNow(Date.now())
    const clock = window.setInterval(() => {
      if (liveRef.current) setSetupNow(Date.now())
    }, 1000)
    const poll = window.setInterval(() => {
      void syncSetupStatus(activeSetupRuntimeId).then(async (tasks) => {
        const matched = tasks.find((task) => task.runtimeId === activeSetupRuntimeId)
        if (!matched || matched.state === 'running' || !liveRef.current) return
        // 如果该任务并非当前组件主动 await 的调用（例如切页或重挂恢复），结束后自动同步引擎清单并释放锁定态
        if (activeSetupCallRef.current === activeSetupRuntimeId) return
        setPendingAction((prev) => (prev === `setup:${activeSetupRuntimeId}` ? null : prev))
        const discovered = await api.acpAgents().catch(() => null)
        if (discovered?.ok && discovered.agents && liveRef.current) setAgents(discovered.agents)
      })
    }, 450)
    return () => {
      window.clearInterval(clock)
      window.clearInterval(poll)
    }
  }, [activeSetupRuntimeId, syncSetupStatus])

  const handleSetupRuntime = async (item: UnifiedRuntimeItem): Promise<void> => {
    if (!hasIpc || pendingAction || item.kind !== 'builtin') return
    const intent: 'install' | 'upgrade' = item.updateAvailable ? 'upgrade' : 'install'
    const startedAt = Date.now()
    activeSetupCallRef.current = item.id
    setPendingAction(`setup:${item.id}`)
    setSetupNow(startedAt)
    setRowError((prev) => { const next = { ...prev }; delete next[item.id]; return next })
    setSetupLastPhase((prev) => ({ ...prev, [item.id]: 'checking_env' }))
    setSetupTasks((prev) => ({
      ...prev,
      [item.id]: {
        runtimeId: item.id,
        intent,
        state: 'running',
        phase: 'checking_env',
        phaseLabel: intent === 'upgrade' ? '正在连接后台服务准备升级…' : '正在连接后台服务准备安装…',
        detail: item.agent?.latestVersion
          ? `目标版本 v${item.agent.latestVersion}`
          : '正在核验 Node.js 与 npm 运行环境',
        currentVersion: item.version,
        targetVersion: item.agent?.latestVersion,
        startedAt,
        updatedAt: startedAt,
        logs: []
      }
    }))
    try {
      const res = await api.acpRuntimeSetup(item.id)
      const latestSnapshots = await syncSetupStatus(item.id)
      const latestBackend = latestSnapshots.find((task) => task.runtimeId === item.id)
      const finishedAt = Date.now()

      if (res.outcome === 'unknown') {
        const msg = res.error ?? '后台返回了未确认结果，请先点击「探测」核对当前版本，确认前不要重复升级。'
        if (liveRef.current) {
          setSetupTasks((prev) => ({
            ...prev,
            [item.id]: {
              ...(latestBackend ?? prev[item.id]),
              runtimeId: item.id,
              intent,
              state: 'failed',
              phase: 'failed',
              phaseLabel: '操作结果未确认',
              outcome: 'unknown',
              commandId: res.commandId,
              error: msg,
              pid: undefined,
              startedAt: latestBackend?.startedAt ?? prev[item.id]?.startedAt ?? startedAt,
              updatedAt: finishedAt,
              finishedAt,
              logs: latestBackend?.logs ?? prev[item.id]?.logs ?? []
            }
          }))
        }
        pushToast({ kind: 'warn', title: `${item.name} 状态待核对`, body: msg })
        return
      }

      let nextAgents = res.agents
      if (res.ok && !nextAgents) {
        const discovered = await api.acpAgents().catch(() => null)
        if (discovered?.ok && discovered.agents) nextAgents = discovered.agents
      }
      if (nextAgents && liveRef.current) setAgents(nextAgents)

      if (!res.ok) {
        const msg = res.error ?? (intent === 'upgrade' ? '升级未完成，请检查网络或 npm 镜像配置后重试' : '安装未完成，请检查网络或运行环境后重试')
        if (liveRef.current) {
          setRowError((prev) => ({ ...prev, [item.id]: msg }))
          setSetupTasks((prev) => ({
            ...prev,
            [item.id]: {
              ...(latestBackend ?? prev[item.id]),
              runtimeId: item.id,
              intent,
              state: 'failed',
              phase: 'failed',
              phaseLabel: intent === 'upgrade' ? '升级失败' : '安装失败',
              outcome: res.outcome === 'not-admitted' ? 'not-admitted' : undefined,
              commandId: res.commandId,
              error: msg,
              pid: undefined,
              startedAt: latestBackend?.startedAt ?? prev[item.id]?.startedAt ?? startedAt,
              updatedAt: finishedAt,
              finishedAt,
              logs: latestBackend?.logs ?? prev[item.id]?.logs ?? []
            }
          }))
        }
        pushToast({ kind: 'error', title: `${item.name} ${intent === 'upgrade' ? '升级失败' : '安装失败'}`, body: msg })
        return
      }

      const updatedAgent = nextAgents?.find((agent) => (agent.runtimeId ?? agent.id) === item.id)
      const finalVersion = updatedAgent?.adapterVersion ?? latestBackend?.targetVersion ?? item.agent?.latestVersion
      const successDetail = intent === 'upgrade' && item.version && finalVersion && item.version !== finalVersion
        ? `已从 v${item.version} 升级至 v${finalVersion}`
        : finalVersion
          ? `当前版本 v${finalVersion}`
          : '已完成更新并同步引擎状态'
      if (liveRef.current) {
        setSetupTasks((prev) => ({
          ...prev,
          [item.id]: {
            ...(latestBackend ?? prev[item.id]),
            runtimeId: item.id,
            intent,
            state: 'succeeded',
            phase: 'succeeded',
            phaseLabel: intent === 'upgrade' ? '升级已完成' : '安装已完成',
            detail: successDetail,
            currentVersion: latestBackend?.currentVersion ?? item.version,
            targetVersion: finalVersion,
            error: undefined,
            pid: undefined,
            startedAt: latestBackend?.startedAt ?? prev[item.id]?.startedAt ?? startedAt,
            updatedAt: finishedAt,
            finishedAt,
            logs: latestBackend?.logs ?? prev[item.id]?.logs ?? []
          }
        }))
      }
      pushToast({
        kind: 'success',
        title: intent === 'upgrade' && finalVersion ? `${item.name} 已升级至 v${finalVersion}` : `${item.name} 已完成${intent === 'upgrade' ? '升级' : '安装'}`
      })
    } catch (error) {
      const msg = error instanceof Error ? error.message : '后台安装或升级请求异常，请查看服务日志后重试'
      const finishedAt = Date.now()
      if (liveRef.current) {
        setRowError((prev) => ({ ...prev, [item.id]: msg }))
        setSetupTasks((prev) => ({
          ...prev,
          [item.id]: {
            ...(prev[item.id] ?? { runtimeId: item.id, intent, startedAt, logs: [] }),
            runtimeId: item.id,
            intent,
            state: 'failed',
            phase: 'failed',
            phaseLabel: intent === 'upgrade' ? '升级请求异常' : '安装请求异常',
            error: msg,
            pid: undefined,
            updatedAt: finishedAt,
            finishedAt
          }
        }))
      }
      pushToast({ kind: 'error', title: `${item.name} 操作异常`, body: msg })
    } finally {
      if (activeSetupCallRef.current === item.id) activeSetupCallRef.current = null
      if (liveRef.current) setPendingAction(null)
    }
  }

  const handleCopySetupLogs = (task: SetupTaskView, itemName: string): void => {
    const lines = [
      `[${itemName}] ${task.phaseLabel}`,
      ...(task.commandSummary ? [`Command: ${task.commandSummary}`] : []),
      ...(task.error ? [`Error: ${task.error}`] : []),
      ...(task.commandId ? [`Command ID: ${task.commandId}`] : []),
      ...task.logs
    ]
    void navigator.clipboard?.writeText(lines.join('\n'))
    setSetupCopiedId(task.runtimeId)
    window.setTimeout(() => {
      if (liveRef.current) setSetupCopiedId((cur) => (cur === task.runtimeId ? null : cur))
    }, 1800)
  }

  const handleDismissSetupTask = (runtimeId: string): void => {
    setSetupTasks((prev) => {
      const cur = prev[runtimeId]
      if (!cur || cur.state === 'running') return prev
      const next = { ...prev }
      delete next[runtimeId]
      return next
    })
    setSetupLogsOpen((prev) => {
      if (!(runtimeId in prev)) return prev
      const next = { ...prev }
      delete next[runtimeId]
      return next
    })
  }

  const handlePickPath = async (item: UnifiedRuntimeItem): Promise<void> => {
    if (!hasIpc || pendingAction || item.kind !== 'builtin') return
    setPendingAction(`path:${item.id}`)
    try {
      const res = await api.acpRuntimePathPick(item.id)
      if (res.agents && liveRef.current) setAgents(res.agents)
      if (!res.cancelled && res.ok) {
        triggerCmdFlash()
        pushToast({ kind: 'success', title: `${item.name} 可执行路径已更新` })
      } else if (!res.cancelled && !res.ok) {
        pushToast({ kind: 'error', title: '路径更新失败', body: res.error ?? '请重新选择可执行文件' })
      }
    } finally {
      if (liveRef.current) setPendingAction(null)
    }
  }

  const handlePickGlobalNode = async (): Promise<void> => {
    if (!hasIpc || pendingAction) return
    setPendingAction('node')
    try {
      const res = await api.acpRuntimeNodePick()
      if (res.agents && liveRef.current) setAgents(res.agents)
      if (!res.cancelled && res.ok) pushToast({ kind: 'success', title: '全局 Node 路径已更新' })
    } finally {
      if (liveRef.current) setPendingAction(null)
    }
  }

  const handleDaemonAction = async (action: 'start' | 'restart' | 'stop'): Promise<void> => {
    if (!hasIpc || !api.daemon || daemonBusy) return
    if (action === 'stop' || (action === 'restart' && (daemon?.activeJobs ?? 0) > 0)) {
      const ok = await confirmDialog({
        title: action === 'stop' ? '停止本机后台服务？' : '重启本机后台服务？',
        message: action === 'stop'
          ? '停止后将中断本机正在运行的 Agent 会话与任务，可随时在此重新启动。'
          : `当前检测到 ${daemon?.activeJobs ?? 0} 个运行中的后台任务，重启会先安全停止旧进程再加载新版本。`,
        confirmText: action === 'stop' ? '确认停止' : '停止任务并重启',
        danger: true
      })
      if (!ok) return
    }
    setDaemonBusy(true)
    try {
      const reply = action === 'start'
        ? await api.daemon.start()
        : action === 'stop'
          ? await api.daemon.stop()
          : await api.daemon.restart()
      if (reply && typeof reply === 'object' && 'ok' in reply && !reply.ok) {
        pushToast({ kind: 'error', title: '守护进程操作失败', body: String((reply as { error?: string }).error ?? '请查看后台服务日志') })
      } else {
        setRowError({})
        pushToast({
          kind: 'success',
          title: action === 'start' ? '本机后台服务已启动' : action === 'stop' ? '本机后台服务已停止' : '本机后台服务已重启并加载最新版本'
        })
        if (action !== 'stop') {
          const refreshed = await api.acpRuntimeRefresh().catch(() => null)
          if (refreshed?.agents && liveRef.current) setAgents(refreshed.agents)
          if (catalogRoot) {
            void modelCatalog.refresh(true)
            if (selectedDriverInstanceId) void modelCatalog.ensure(selectedDriverInstanceId, true)
          }
        }
      }
      await loadInfrastructure()
    } finally {
      if (liveRef.current) setDaemonBusy(false)
    }
  }

  const handleHeartbeat = async (connectionId: string): Promise<void> => {
    if (!hasIpc || !api.teamDesktop || checkingConnId) return
    setCheckingConnId(connectionId)
    try {
      const reply = await api.teamDesktop.heartbeat(connectionId)
      pushToast(reply.ok ? { kind: 'success', title: '设备通道心跳核对通过' } : { kind: 'error', title: '心跳核对失败', body: reply.error })
      await loadInfrastructure()
    } finally {
      if (liveRef.current) setCheckingConnId(null)
    }
  }

  const persistBuiltinDefaults = async (
    item: UnifiedRuntimeItem,
    patch: Partial<AcpRuntimeDefaults>
  ): Promise<boolean> => {
    if (item.kind !== 'builtin') return false
    const current = settings?.acp?.runtimeDefaults?.[item.id] ?? {}
    const merged: AcpRuntimeDefaults = { ...current, ...patch }
    const err = runtimeConfigError(merged, item.agent?.launchKind)
    if (err) {
      pushToast({ kind: 'error', title: '配置校验未通过', body: err })
      return false
    }
    const cleaned = cleanRuntimeConfig(merged, { launchKind: item.agent?.launchKind })
    const nextDefaults: AcpRuntimeDefaults = {
      ...(cleaned.modelId ? { modelId: cleaned.modelId } : {}),
      ...(cleaned.env?.length ? { env: cleaned.env } : {}),
      ...(cleaned.args?.length ? { args: cleaned.args } : {})
    }
    if (!hasIpc) {
      triggerCmdFlash()
      pushToast({ kind: 'info', title: '预览模式下已更新当前视图状态' })
      return true
    }
    try {
      await saveSettings({ acp: { runtimeDefaults: { [item.id]: nextDefaults } } })
      triggerCmdFlash()
      return true
    } catch (cause) {
      pushToast({ kind: 'error', title: '保存配置失败', body: cause instanceof Error ? cause.message : '请稍后重试' })
      return false
    }
  }

  const handleSetPrimary = (item: UnifiedRuntimeItem): void => {
    const kind: CruxRuntimeKind = item.kind === 'custom'
      ? (item.custom?.base === 'acp' ? 'custom' : (item.custom?.base ?? 'custom'))
      : toCruxRuntimeKind(item.id)
    setDefaultSlot({ runtimeKind: kind, runtimeId: item.id })
    pushToast({ kind: 'success', title: `已将「${item.name}」设为默认主力引擎` })
  }

  const toggleAllowedSpace = (spaceId: string): void => {
    const next = allowedSpaceIds.includes(spaceId)
      ? allowedSpaceIds.filter((id) => id !== spaceId)
      : [...allowedSpaceIds, spaceId]
    setMachineVisibility('spaces', next)
  }

  const selectedBuiltinDefaults = selected?.kind === 'builtin' ? settings?.acp?.runtimeDefaults?.[selected.id] : undefined
  const selectedLaunchCfg = selected ? runtimeLaunchConfigs[selected.id] : undefined
  const selectedIsolation: IsolationMode = selectedLaunchCfg?.isolationMode ?? (selected?.agent?.launchKind === 'sdk' ? 'in_place' : 'worktree')

  const selectedModelId = useMemo(() => {
    if (!selected) return ''
    if (selected.kind === 'custom') return selected.custom?.manualModels[0] ?? ''
    return selectedBuiltinDefaults?.modelId ?? ''
  }, [selected, selectedBuiltinDefaults?.modelId])

  const selectedArgs = useMemo<AcpProfileArg[]>(() => {
    if (!selected) return []
    if (selected.kind === 'custom') {
      return (selected.custom?.args ?? []).map((token) => ({ name: token, value: '' }))
    }
    return selectedBuiltinDefaults?.args ?? []
  }, [selected, selectedBuiltinDefaults?.args])

  const selectedEnv = useMemo<AcpProfileEnvVar[]>(() => {
    if (!selected) return []
    if (selected.kind === 'custom') return selected.custom?.env ?? []
    return selectedBuiltinDefaults?.env ?? []
  }, [selected, selectedBuiltinDefaults?.env])

  const selectedDriverInstanceId = useMemo<string | null>(() => {
    if (!selected || selected.kind !== 'builtin') return null
    const idLower = selected.id.toLowerCase()
    const exact = modelCatalog.instances.find((item) => item.instanceId.toLowerCase() === idLower)
    if (exact) return exact.instanceId
    if (idLower.includes('codex')) return modelCatalog.instances.find((item) => item.driverKind === 'codex')?.instanceId ?? 'codex'
    if (idLower.includes('claude')) return modelCatalog.instances.find((item) => item.driverKind === 'claudeCode')?.instanceId ?? 'claude'
    if (idLower === 'pi' || selected.agent?.launchKind === 'sdk') {
      return modelCatalog.instances.find((item) => item.instanceId === 'pi')?.instanceId ?? 'pi'
    }
    return null
  }, [modelCatalog.instances, selected])

  useEffect(() => {
    if (hasIpc && catalogRoot && selectedDriverInstanceId) {
      void modelCatalog.ensure(selectedDriverInstanceId)
    }
  }, [catalogRoot, modelCatalog.ensure, selectedDriverInstanceId])

  useEffect(() => {
    setModelSourceFilter('all')
    setModelSearchQuery('')
  }, [selected?.id])

  const selectedDriverInstance = useMemo(
    () => selectedDriverInstanceId ? modelCatalog.instances.find((item) => item.instanceId === selectedDriverInstanceId) : undefined,
    [modelCatalog.instances, selectedDriverInstanceId]
  )
  const selectedDriverRead = selectedDriverInstance?.read
  const selectedDescriptor = selectedDriverRead?.status === 'ready' ? selectedDriverRead.descriptor : undefined
  const isModelCatalogLoading = Boolean(
    hasIpc && selectedDriverInstanceId && (
      modelCatalog.status === 'loading' ||
      modelCatalog.status === 'idle' ||
      !selectedDriverRead ||
      selectedDriverRead.status === 'loading'
    )
  )
  const isModelCatalogProvisional = Boolean(selectedDescriptor?.provisional)
  const modelCatalogError = selectedDriverRead?.status === 'failed'
    ? selectedDriverRead.error
    : (selectedDriverInstanceId && modelCatalog.status === 'failed' ? modelCatalog.error : undefined)

  const handleRefreshModelCatalog = async (): Promise<void> => {
    if (!hasIpc || !catalogRoot) return
    await modelCatalog.refresh(true)
    if (selectedDriverInstanceId) {
      await modelCatalog.ensure(selectedDriverInstanceId, true)
    }
  }

  const selectedModelCards = useMemo<ModelCatalogCardItem[]>(() => {
    if (!selected) return []
    const items: ModelCatalogCardItem[] = []
    const seen = new Set<string>()
    const effortByModel = new Map<string, { choices: ModelEffortChoice[]; defaultEffort?: string }>()
    if (selectedDescriptor) {
      for (const opt of selectedDescriptor.options) {
        if (opt.category !== 'reasoning' || opt.choices.length === 0) continue
        const normalized = normalizeEffortChoices(opt.choices)
        const def = typeof opt.current === 'string' ? opt.current : undefined
        if (opt.modelId) effortByModel.set(opt.modelId, { choices: normalized, defaultEffort: def })
        else if (opt.id.endsWith(':effort')) effortByModel.set(opt.id.slice(0, -':effort'.length), { choices: normalized, defaultEffort: def })
      }
    }

    const pushItem = (item: ModelCatalogCardItem): void => {
      const cleanId = item.id.trim()
      if (!cleanId || seen.has(cleanId)) return
      seen.add(cleanId)
      items.push({ ...item, id: cleanId })
    }

    if (selected.kind === 'builtin' && selected.agent?.launchKind === 'sdk') {
      const ai = settings?.ai
      if (ai?.providers?.length) {
        for (const provider of ai.providers) {
          if (!provider.enabled) continue
          const src = classifyAiProviderSource(provider)
          for (const model of provider.models) {
            if (!model.enabled) continue
            const id = `${provider.id}:${model.id}`
            const parsed = parseModelDisplay(model.id, model.name || model.id)
            pushItem({
              id,
              displayName: parsed.cleanName,
              showRawId: parsed.showRawId,
              sourceKind: src.sourceKind,
              sourceLabel: src.sourceLabel,
              groupKey: `${src.sourceKind}:${provider.id}`,
              groupLabel: src.sourceLabel,
              contextTag: model.contextWindow?.trim() || parsed.contextTag
            })
          }
        }
      } else if (ai?.enabled && ai.model) {
        const parsed = parseModelDisplay(ai.model, ai.model)
        const isMagpie = /magpie/i.test(ai.baseUrl ?? '')
        pushItem({
          id: `default:${ai.model}`,
          displayName: parsed.cleanName,
          showRawId: false,
          sourceKind: isMagpie ? 'magpie' : 'provider',
          sourceLabel: isMagpie ? 'Magpie' : '默认 AI 供应商',
          groupKey: isMagpie ? 'magpie:default' : 'provider:default',
          groupLabel: isMagpie ? 'Magpie' : '默认 AI 供应商',
          contextTag: parsed.contextTag
        })
      }
      if (selectedDescriptor) {
        for (const model of selectedDescriptor.models) {
          const parsed = parseModelDisplay(model.id, model.displayName)
          const src = classifyDriverModelSource(model, 'AI 供应商', parsed)
          pushItem({
            id: model.id,
            displayName: parsed.cleanName,
            showRawId: parsed.showRawId,
            sourceKind: src.sourceKind,
            sourceLabel: src.sourceLabel,
            groupKey: src.groupKey,
            groupLabel: src.groupLabel,
            isEngineDefault: model.isDefault,
            contextTag: parsed.contextTag
          })
        }
      }
    } else if (selected.kind === 'builtin') {
      if (selectedDescriptor) {
        for (const model of selectedDescriptor.models) {
          const parsed = parseModelDisplay(model.id, model.displayName)
          const src = classifyDriverModelSource(model, '原生账号', parsed)
          const effort = effortByModel.get(model.id)
          pushItem({
            id: model.id,
            displayName: parsed.cleanName,
            showRawId: parsed.showRawId,
            sourceKind: src.sourceKind,
            sourceLabel: src.sourceLabel,
            groupKey: src.groupKey,
            groupLabel: src.groupLabel,
            isEngineDefault: model.isDefault,
            contextTag: parsed.contextTag,
            effortChoices: effort?.choices,
            defaultEffort: effort?.defaultEffort
          })
        }
      }
      for (const manual of selectedLaunchCfg?.manualModels ?? []) {
        const parsed = parseModelDisplay(manual, manual)
        pushItem({
          id: manual,
          displayName: parsed.cleanName,
          showRawId: parsed.showRawId,
          sourceKind: 'manual',
          sourceLabel: '手动声明',
          groupKey: 'manual:default',
          groupLabel: '手动声明',
          isManual: true,
          contextTag: parsed.contextTag
        })
      }
    } else if (selected.custom) {
      for (const manual of selected.custom.manualModels) {
        const parsed = parseModelDisplay(manual, manual)
        pushItem({
          id: manual,
          displayName: parsed.cleanName,
          showRawId: parsed.showRawId,
          sourceKind: 'manual',
          sourceLabel: '自定义声明',
          groupKey: 'manual:custom',
          groupLabel: '自定义声明',
          isManual: true,
          contextTag: parsed.contextTag
        })
      }
    }

    if (selectedModelId && !seen.has(selectedModelId)) {
      const parsed = parseModelDisplay(selectedModelId, selectedModelId)
      const src = classifyDriverModelSource({ id: selectedModelId, displayName: selectedModelId }, '已保存模型', parsed)
      const isFallback = src.sourceKind === 'native'
      pushItem({
        id: selectedModelId,
        displayName: parsed.cleanName,
        showRawId: parsed.showRawId,
        sourceKind: isFallback ? 'manual' : src.sourceKind,
        sourceLabel: isFallback ? '已保存配置' : src.sourceLabel,
        groupKey: isFallback ? 'manual:saved' : src.groupKey,
        groupLabel: isFallback ? '已保存配置' : src.groupLabel,
        contextTag: parsed.contextTag
      })
    }
    return items
  }, [selected, selectedDescriptor, selectedLaunchCfg?.manualModels, selectedModelId, settings?.ai])

  const selectedModelCard = useMemo(
    () => selectedModelCards.find((item) => item.id === selectedModelId),
    [selectedModelCards, selectedModelId]
  )

  const resolveEffortForModel = useCallback((item: Pick<ModelCatalogCardItem, 'id' | 'effortChoices' | 'defaultEffort'>): string | undefined => {
    const saved = selectedLaunchCfg?.reasoningEffortByModel?.[item.id]
    if (saved && item.effortChoices?.some((c) => c.value === saved)) return saved
    if (item.defaultEffort && item.effortChoices?.some((c) => c.value === item.defaultEffort)) return item.defaultEffort
    return item.effortChoices?.[Math.floor((item.effortChoices.length - 1) / 2)]?.value
  }, [selectedLaunchCfg?.reasoningEffortByModel])

  const activeEffortValue = useMemo(() => {
    if (!selectedModelCard?.effortChoices?.length) return undefined
    return resolveEffortForModel(selectedModelCard)
  }, [resolveEffortForModel, selectedModelCard])

  const activeEffortLabel = useMemo(() => {
    if (!activeEffortValue || !selectedModelCard?.effortChoices?.length) return undefined
    return selectedModelCard.effortChoices.find((c) => c.value === activeEffortValue)?.label ?? activeEffortValue
  }, [activeEffortValue, selectedModelCard])

  const modelSourceSummary = useMemo(() => {
    const counts = new Map<ModelSourceKind, number>()
    for (const item of selectedModelCards) {
      counts.set(item.sourceKind, (counts.get(item.sourceKind) ?? 0) + 1)
    }
    return [...counts.entries()]
      .sort(([a], [b]) => SOURCE_FILTER_META[a].order - SOURCE_FILTER_META[b].order)
      .map(([kind, count]) => ({ kind, label: SOURCE_FILTER_META[kind].label, count }))
  }, [selectedModelCards])

  const filteredModelCards = useMemo(() => {
    const q = modelSearchQuery.trim().toLowerCase()
    return selectedModelCards.filter((item) => {
      if (modelSourceFilter !== 'all' && item.sourceKind !== modelSourceFilter) return false
      if (!q) return true
      return `${item.displayName} ${item.id} ${item.sourceLabel} ${item.groupLabel} ${item.contextTag ?? ''}`.toLowerCase().includes(q)
    })
  }, [modelSearchQuery, modelSourceFilter, selectedModelCards])

  const groupedModelSections = useMemo(() => {
    const map = new Map<string, { key: string; kind: ModelSourceKind; label: string; items: ModelCatalogCardItem[] }>()
    for (const item of filteredModelCards) {
      const existing = map.get(item.groupKey)
      if (existing) existing.items.push(item)
      else map.set(item.groupKey, { key: item.groupKey, kind: item.sourceKind, label: item.groupLabel, items: [item] })
    }
    return [...map.values()].sort((a, b) =>
      SOURCE_FILTER_META[a.kind].order - SOURCE_FILTER_META[b.kind].order || b.items.length - a.items.length
    )
  }, [filteredModelCards])

  const daemonNeedsRestart = useMemo(() => {
    if (daemon?.buildState === 'changed') return true
    if (isDaemonOutdatedMessage(modelCatalogError)) return true
    return Object.values(rowError).some((msg) => isDaemonOutdatedMessage(msg))
  }, [daemon?.buildState, modelCatalogError, rowError])

  const hasEndpointEnvOverride = useMemo(
    () => selectedEnv.some((pair) => /^(?:OPENAI|ANTHROPIC)_BASE_URL$/i.test(pair.key) && Boolean(pair.value.trim())),
    [selectedEnv]
  )

  const boundAgents = useMemo(() => {
    if (!selected || !snapshot?.agents) return []
    const rtLower = selected.id.toLowerCase()
    return snapshot.agents.filter((agent) => {
      if (agent.archived) return false
      if (selected.kind === 'custom') return agent.runtimeKind === 'custom'
      if (rtLower.includes('codex')) return agent.runtimeKind === 'codex'
      if (rtLower.includes('claude')) return agent.runtimeKind === 'claude-code'
      return agent.runtimeKind === 'custom'
    })
  }, [selected, snapshot?.agents])

  const capabilities = useMemo<Array<{ label: string; ok: boolean }>>(() => {
    if (!selected) return []
    const items: Array<{ label: string; ok: boolean }> = [{ label: selected.protocolLabel, ok: selected.ready }]
    const probeCaps = probeInfo[selected.id]?.capabilitiesSummary ?? []
    for (const label of probeCaps) items.push({ label, ok: true })
    if (probeCaps.length === 0) {
      if (selected.agent?.launchKind === 'sdk') items.push({ label: '多供应商路由', ok: true })
      items.push({ label: selectedIsolation === 'worktree' ? 'Worktree 隔离' : '原地目录执行', ok: true })
    }
    if (selected.updateAvailable && selected.agent?.latestVersion) {
      items.push({ label: `可升级 v${selected.agent.latestVersion}`, ok: false })
    }
    return items
  }, [probeInfo, selected, selectedIsolation])

  const fullCommandString = useMemo(() => {
    if (!selected) return ''
    const envPrefix = selectedEnv.map((e) => `${e.key}=${/KEY|TOKEN|SECRET/i.test(e.key) ? '***' : e.value}`).join(' ')
    const argParts = selectedArgs.map((a) => (a.value ? `${a.name} ${a.value}` : a.name)).join(' ')
    const modelFlag = selectedModelId ? `--model ${selectedModelId}` : ''
    return [envPrefix, selected.commandDisplay, argParts, modelFlag].filter(Boolean).join(' ')
  }, [selected, selectedArgs, selectedEnv, selectedModelId])

  const handleCycleActiveEffort = async (): Promise<void> => {
    if (!selectedModelCard?.effortChoices?.length) return
    const choices = selectedModelCard.effortChoices
    const idx = choices.findIndex((c) => c.value === activeEffortValue)
    const next = choices[(idx + 1) % choices.length]
    if (next) await handleSelectModelEffort(selectedModelCard.id, next.value)
  }

  const enabledProviderCount = useMemo(
    () => (settings?.ai?.providers ?? []).filter((p) => p.enabled).length,
    [settings?.ai?.providers]
  )

  const handleSelectModelEffort = async (modelId: string, effortValue: string): Promise<void> => {
    if (!selected) return
    const nextByModel = { ...(selectedLaunchCfg?.reasoningEffortByModel ?? {}), [modelId]: effortValue }
    setRuntimeLaunchConfig(selected.id, {
      defaultReasoningEffort: effortValue,
      reasoningEffortByModel: nextByModel
    })
    if (modelId !== selectedModelId) {
      await handleSelectModel(modelId)
    } else {
      triggerCmdFlash()
    }
  }

  const handleSelectModel = async (modelId: string): Promise<void> => {
    if (!selected || modelId === selectedModelId) return
    if (selected.kind === 'custom' && selected.custom) {
      const rest = selected.custom.manualModels.filter((m) => m !== modelId)
      upsertCustomRuntime({
        id: selected.custom.id,
        displayName: selected.custom.displayName,
        base: selected.custom.base,
        command: selected.custom.command,
        args: selected.custom.args,
        env: selected.custom.env,
        description: selected.custom.description,
        manualModels: modelId ? [modelId, ...rest] : rest
      })
      triggerCmdFlash()
      return
    }
    // L1 高频就地切换：行内即时勾选 + 命令总线边框脉冲，不弹出冗余 Toast
    await persistBuiltinDefaults(selected, { modelId: modelId || undefined })
  }

  const handleAddManualModel = async (): Promise<void> => {
    const clean = manualModelDraft.trim()
    if (!selected || !clean) return
    if (selected.kind === 'custom' && selected.custom) {
      const nextModels = Array.from(new Set([clean, ...selected.custom.manualModels]))
      upsertCustomRuntime({
        id: selected.custom.id,
        displayName: selected.custom.displayName,
        base: selected.custom.base,
        command: selected.custom.command,
        args: selected.custom.args,
        env: selected.custom.env,
        description: selected.custom.description,
        manualModels: nextModels
      })
      setManualModelDraft('')
      triggerCmdFlash()
      pushToast({ kind: 'success', title: `已添加模型 ${clean}` })
      return
    }
    const prevManuals = selectedLaunchCfg?.manualModels ?? []
    setRuntimeLaunchConfig(selected.id, { manualModels: Array.from(new Set([...prevManuals, clean])) })
    const ok = await persistBuiltinDefaults(selected, { modelId: clean })
    if (ok) {
      setManualModelDraft('')
      pushToast({ kind: 'success', title: `已声明并启用模型 ${clean}` })
    }
  }

  const handleRemoveManualModel = async (modelId: string): Promise<void> => {
    if (!selected) return
    if (selected.kind === 'custom' && selected.custom) {
      const nextModels = selected.custom.manualModels.filter((m) => m !== modelId)
      upsertCustomRuntime({
        id: selected.custom.id,
        displayName: selected.custom.displayName,
        base: selected.custom.base,
        command: selected.custom.command,
        args: selected.custom.args,
        env: selected.custom.env,
        description: selected.custom.description,
        manualModels: nextModels
      })
      triggerCmdFlash()
      return
    }
    const prevManuals = selectedLaunchCfg?.manualModels ?? []
    setRuntimeLaunchConfig(selected.id, { manualModels: prevManuals.filter((m) => m !== modelId) })
    if (selectedModelId === modelId) {
      await persistBuiltinDefaults(selected, { modelId: undefined })
    }
  }

  const handleAddArg = async (): Promise<void> => {
    const raw = argDraft.trim()
    if (!selected || !raw) return
    const tokens = raw.split(/\s+/)
    if (selected.kind === 'custom' && selected.custom) {
      upsertCustomRuntime({
        id: selected.custom.id,
        displayName: selected.custom.displayName,
        base: selected.custom.base,
        command: selected.custom.command,
        args: [...selected.custom.args, ...tokens],
        env: selected.custom.env,
        manualModels: selected.custom.manualModels,
        description: selected.custom.description
      })
      setArgDraft('')
      triggerCmdFlash()
      return
    }
    const nextArgs: AcpProfileArg[] = [...selectedArgs, ...tokens.map((name) => ({ name, value: '' }))]
    const ok = await persistBuiltinDefaults(selected, { args: nextArgs })
    if (ok) setArgDraft('')
  }

  const handleRemoveArg = async (index: number): Promise<void> => {
    if (!selected) return
    if (selected.kind === 'custom' && selected.custom) {
      upsertCustomRuntime({
        id: selected.custom.id,
        displayName: selected.custom.displayName,
        base: selected.custom.base,
        command: selected.custom.command,
        args: selected.custom.args.filter((_, idx) => idx !== index),
        env: selected.custom.env,
        manualModels: selected.custom.manualModels,
        description: selected.custom.description
      })
      triggerCmdFlash()
      return
    }
    await persistBuiltinDefaults(selected, { args: selectedArgs.filter((_, idx) => idx !== index) })
  }

  const handleAddEnv = async (): Promise<void> => {
    const key = envKeyDraft.trim()
    if (!selected || !key) return
    const nextEnv: AcpProfileEnvVar[] = [...selectedEnv.filter((item) => item.key !== key), { key, value: envValDraft }]
    if (selected.kind === 'custom' && selected.custom) {
      upsertCustomRuntime({
        id: selected.custom.id,
        displayName: selected.custom.displayName,
        base: selected.custom.base,
        command: selected.custom.command,
        args: selected.custom.args,
        env: nextEnv,
        manualModels: selected.custom.manualModels,
        description: selected.custom.description
      })
      setEnvKeyDraft('')
      setEnvValDraft('')
      triggerCmdFlash()
      return
    }
    const ok = await persistBuiltinDefaults(selected, { env: nextEnv })
    if (ok) {
      setEnvKeyDraft('')
      setEnvValDraft('')
    }
  }

  const handleRemoveEnv = async (index: number): Promise<void> => {
    if (!selected) return
    const nextEnv = selectedEnv.filter((_, idx) => idx !== index)
    if (selected.kind === 'custom' && selected.custom) {
      upsertCustomRuntime({
        id: selected.custom.id,
        displayName: selected.custom.displayName,
        base: selected.custom.base,
        command: selected.custom.command,
        args: selected.custom.args,
        env: nextEnv,
        manualModels: selected.custom.manualModels,
        description: selected.custom.description
      })
      triggerCmdFlash()
      return
    }
    await persistBuiltinDefaults(selected, { env: nextEnv })
  }

  const handleCopyCommand = (): void => {
    if (!fullCommandString) return
    void navigator.clipboard?.writeText(fullCommandString)
    setCopiedCmd(true)
    window.setTimeout(() => {
      if (liveRef.current) setCopiedCmd(false)
    }, 1800)
  }

  const isSelectedPrimary = Boolean(selected && selected.id === defaultRuntimeId)
  const selectedSetupTask = selected ? setupTasks[selected.id] : undefined
  const isSelectedSettingUp = Boolean(selected && (pendingAction === `setup:${selected.id}` || selectedSetupTask?.state === 'running'))
  const isSelectedTesting = Boolean(selected && (pendingAction === `test:${selected.id}` || pendingAction === 'refresh' || inventory.checkingRuntimeId === selected.id))
  const selectedSamples = selected ? (latencyHistory[selected.id] ?? []) : []
  const selectedLatestMs = selectedSamples.length ? selectedSamples[selectedSamples.length - 1] : null
  const oscGeometry = buildOscSvg(selectedSamples)
  const selectedSlotIdx = selected ? unifiedRuntimes.findIndex((item) => item.id === selected.id) + 1 : 0
  const selectedLogsVisible = Boolean(selected && setupLogsOpen[selected.id])
  const selectedLogCount = selectedSetupTask?.logs.length ?? 0

  useEffect(() => {
    if (selectedLogsVisible && selectedLogCount > 0) {
      setupLogEndRef.current?.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedLogsVisible, selectedLogCount])

  return (
    <div className="mc-page">
      <div className="mc-monolith">
        {/* 左栏：与全站对齐的顶天立地 240px Runtime 侧边栏 */}
        <aside className="mc-rack" aria-label="本机 Runtime 列表">
          <div className="mc-rack-brand">
            <div className="mc-rack-brand-left">
              <h1 className="mc-rack-title">机器与 Runtime</h1>
            </div>
            <span className={`mc-ratio-pill${readyCount === 0 ? ' is-warn' : ''}`}>
              {readyCount}/{Math.max(unifiedRuntimes.length, 1)}
            </span>
          </div>

          <div className="mc-rack-inner">
            <div className="mc-rack-tools">
              <div className="mc-search-wrap">
                <Search size={12} className="mc-search-icon" aria-hidden="true" />
                <input
                  className="mc-search-input"
                  type="search"
                  value={searchQuery}
                  aria-label="筛选 Runtime"
                  placeholder="筛选 Runtime…"
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <div className="mc-rack-head">
                <span>SLOTS</span>
                {attentionCount > 0 && (
                  <div className="mc-filter-grp">
                    <button
                      type="button"
                      className="mc-filter-btn"
                      aria-pressed={statusFilter === 'all'}
                      onClick={() => setStatusFilter('all')}
                    >
                      全部
                    </button>
                    <button
                      type="button"
                      className="mc-filter-btn is-warn"
                      aria-pressed={statusFilter === 'attention'}
                      onClick={() => setStatusFilter('attention')}
                    >
                      待修 {attentionCount}
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div className="mc-cart-rail my-scrollbar" role="listbox" aria-label="选择 Runtime 引擎">
              {filteredRuntimes.length === 0 ? (
                <div className="px-2 py-6 text-center text-my-xs text-my-tertiary">
                  {inventory.reading ? '正在探测本机引擎…' : '暂无匹配的 Runtime'}
                </div>
              ) : (
                filteredRuntimes.map((item) => {
                  const isSelected = selected?.id === item.id
                  const isPrimary = item.id === defaultRuntimeId
                  const slotNumber = unifiedRuntimes.findIndex((rt) => rt.id === item.id) + 1
                  const samples = latencyHistory[item.id]
                  const lastMs = samples?.length ? samples[samples.length - 1] : null
                  const itemSetupTask = setupTasks[item.id]
                  const isItemSettingUp = pendingAction === `setup:${item.id}` || itemSetupTask?.state === 'running'
                  const okState = item.ready && !item.updateAvailable
                  const itemRailText = isItemSettingUp
                    ? (itemSetupTask?.intent === 'install' ? '安装中…' : '升级中…')
                    : item.railStatus

                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      className="mc-cart"
                      onClick={() => setSelectedId(item.id)}
                    >
                      <span className="mc-cart-icon">
                        {item.kind === 'custom' ? <Sparkles size={15} /> : <ToolBrandIcon brand={item.id} size={18} />}
                        <span className={`mc-cart-led${isItemSettingUp ? ' is-busy' : okState ? ' is-ready' : ' is-warn'}`} aria-hidden="true" />
                      </span>
                      <span className="mc-cart-meta">
                        <span className="mc-cart-name-row">
                          <span className="mc-cart-name">{item.name}</span>
                          {isPrimary && (
                            <span className="mc-bolt" title="当前默认主力">
                              <Zap size={9} aria-hidden="true" />
                            </span>
                          )}
                        </span>
                        <span className="mc-cart-sub">
                          <span className={`mc-cart-sub-status ${isItemSettingUp ? 'is-busy' : okState ? 'is-ready' : 'is-warn'}`}>
                            {itemRailText}
                          </span>
                          <span>·</span>
                          <span>{item.protocolLabel}</span>
                        </span>
                      </span>
                      {isItemSettingUp ? (
                        <Loader2 size={12} className="mc-cart-spin motion-safe:animate-spin" aria-label={itemRailText} />
                      ) : lastMs ? (
                        <span className="mc-cart-ms-chip" title={`最近握手延迟 ${lastMs}ms`}>{lastMs}ms</span>
                      ) : (
                        <span className="mc-cart-slot-num" aria-hidden="true">
                          {String(slotNumber).padStart(2, '0')}
                        </span>
                      )}
                    </button>
                  )
                })
              )}
            </div>
          </div>

          <div className="mc-eco-dock" aria-label="关联生态">
            {onOpenModels && (
              <Dropdown
                placement="top"
                align="left"
                width={296}
                trigger={({ open, toggle }) => (
                  <button
                    type="button"
                    className="mc-eco-tile"
                    aria-expanded={open}
                    aria-haspopup="menu"
                    onClick={toggle}
                  >
                    <span className="mc-eco-tile-top">
                      <Sparkles size={12} aria-hidden="true" />
                      <ChevronDown size={11} className={`mc-eco-chev${open ? ' is-open' : ''}`} aria-hidden="true" />
                    </span>
                    <span className="mc-eco-tile-name">模型供应商</span>
                    <span className="mc-eco-tile-sub">{enabledProviderCount > 0 ? `${enabledProviderCount} 个已启用` : '尚未启用'}</span>
                  </button>
                )}
              >
                {(close) => {
                  const providers = settings?.ai?.providers ?? []
                  return (
                    <div className="mc-pop-card" role="dialog" aria-label="模型供应商概览">
                      <div className="mc-pop-head">
                        <span className="mc-pop-title">AI 模型供应商</span>
                        <span className="mc-pop-badge">{enabledProviderCount}/{providers.length} 已启用</span>
                      </div>
                      {providers.length === 0 ? (
                        <div className="mc-pop-empty">尚未配置第三方 API 供应商（Pi 原生引擎与多源模型可在此接入）。</div>
                      ) : (
                        <div className="mc-pop-list my-scrollbar">
                          {providers.map((provider) => {
                            const activeModels = provider.models.filter((m) => m.enabled).length
                            return (
                              <div key={provider.id} className="mc-pop-row">
                                <span className={`mc-pop-dot${provider.enabled ? ' is-ok' : ''}`} aria-hidden="true" />
                                <span className="mc-pop-row-main">
                                  <span className="mc-pop-row-name">{provider.name}</span>
                                  <span className="mc-pop-row-sub">{provider.apiFormat ?? 'openai'} · {activeModels} 模型</span>
                                </span>
                                <span className="mc-pop-row-tag">{provider.enabled ? '启用' : '停用'}</span>
                              </div>
                            )
                          })}
                        </div>
                      )}
                      <div className="mc-pop-foot">
                        <button
                          type="button"
                          className="mc-pop-link"
                          onClick={() => { close(); onOpenModels() }}
                        >
                          <span>前往供应商完整配置</span>
                          <ArrowUpRight size={12} />
                        </button>
                      </div>
                    </div>
                  )
                }}
              </Dropdown>
            )}
            {onOpenGateway && (
              <Dropdown
                placement="top"
                align="left"
                width={284}
                trigger={({ open, toggle }) => (
                  <button
                    type="button"
                    className="mc-eco-tile"
                    aria-expanded={open}
                    aria-haspopup="menu"
                    onClick={toggle}
                  >
                    <span className="mc-eco-tile-top">
                      <Plug size={12} aria-hidden="true" />
                      <ChevronDown size={11} className={`mc-eco-chev${open ? ' is-open' : ''}`} aria-hidden="true" />
                    </span>
                    <span className="mc-eco-tile-name">MCP 网关</span>
                    <span className="mc-eco-tile-sub">{mcpInfo?.running ? `端口 ${mcpInfo.port ?? '活跃'}` : '工具与协议桥'}</span>
                  </button>
                )}
              >
                {(close) => (
                  <div className="mc-pop-card" role="dialog" aria-label="MCP 网关状态概览">
                    <div className="mc-pop-head">
                      <span className="mc-pop-title">本机 MCP 与协议网关</span>
                      <span className={`mc-daemon-state-pill${mcpInfo?.running ? ' is-ok' : ''}`}>
                        {mcpInfo?.running ? '运行中' : '未启动'}
                      </span>
                    </div>
                    <div className="mc-pop-kv">
                      <div className="mc-pop-kv-row">
                        <span className="mc-pop-kv-k">服务端口</span>
                        <span className="font-mono text-my-xs text-my-primary">{mcpInfo?.port ? `:${mcpInfo.port}` : '—'}</span>
                      </div>
                      <div className="mc-pop-kv-row">
                        <span className="mc-pop-kv-k">看板地址</span>
                        <span className="truncate font-mono text-my-2xs text-my-secondary">{mcpInfo?.webBoardUrl ?? '未暴露外部地址'}</span>
                      </div>
                    </div>
                    <div className="mc-pop-foot">
                      <button
                        type="button"
                        className="mc-pop-link"
                        onClick={() => { close(); onOpenGateway() }}
                      >
                        <span>打开 MCP 网关管理</span>
                        <ArrowUpRight size={12} />
                      </button>
                    </div>
                  </div>
                )}
              </Dropdown>
            )}
            {!onOpenModels && !onOpenGateway && (
              <button type="button" className="mc-eco-tile" onClick={() => setOpsModalOpen(true)}>
                <span className="mc-eco-tile-top">
                  <Settings2 size={12} aria-hidden="true" />
                </span>
                <span className="mc-eco-tile-name">本机运维</span>
                <span className="mc-eco-tile-sub">服务与通道</span>
              </button>
            )}
          </div>
        </aside>

        {/* 右栏：顶天立地主工作区 */}
        <div className="mc-main-pane">
          <header className="mc-crown">
            <div className="mc-crown-left">
              <Dropdown
                align="right"
                width={256}
                trigger={({ open, toggle }) => (
                  <button
                    type="button"
                    className="mc-machine-trigger"
                    aria-expanded={open}
                    aria-haspopup="menu"
                    title="点击管理本机后台守护进程（重启 / 停止 / 日志 / 运维）"
                    onClick={toggle}
                  >
                    <span className="mc-iso-badge" aria-hidden="true">
                      <MiniIsoMachine running={Boolean(daemon?.running)} />
                    </span>
                    <span className="mc-crown-title-row">
                      <span className="mc-crown-title">{machineTitle}</span>
                      <span className="mc-crown-sub">
                        <svg className={`mc-ecg${daemon?.running ? '' : ' is-idle'}`} viewBox="0 0 34 11" aria-hidden="true">
                          <path d="M0 5.5 H6 L10 1.5 L14 9.5 L18 3.5 L21 5.5 H34" />
                        </svg>
                        <span>{daemon?.running ? `在线${daemon.pid ? ` · PID ${daemon.pid}` : ''}` : (daemon?.label ?? (hasIpc ? '检测中' : '预览模式'))}</span>
                        <span>·</span>
                        <span>{activeRunCount} 并发</span>
                        {activeConnections.length > 0 && (
                          <>
                            <span>·</span>
                            <span>{activeConnections.length} 组织</span>
                          </>
                        )}
                      </span>
                    </span>
                    <span className="mc-machine-caret" aria-hidden="true">
                      <span>服务</span>
                      <ChevronDown size={11} className={`mc-scope-chevron${open ? ' is-open' : ''}`} />
                    </span>
                  </button>
                )}
              >
                {(close) => (
                  <div className="mc-space-popover" role="menu" aria-label="本机守护进程控制">
                    <div className="mc-space-pop-head">
                      <span className="mc-space-pop-title">本机后台守护进程</span>
                      <span className={`mc-daemon-state-pill${daemon?.running ? (daemonNeedsRestart ? ' is-warn' : ' is-ok') : ''}`}>
                        {daemonNeedsRestart ? '需重启' : daemon?.running ? '运行中' : '已停止'}
                      </span>
                    </div>
                    {hasIpc && api.daemon && (
                      <>
                        <button
                          type="button"
                          role="menuitem"
                          className="mc-space-pop-item"
                          disabled={daemonBusy}
                          onClick={() => { close(); void handleDaemonAction(daemon?.running ? 'restart' : 'start') }}
                        >
                          <span className="mc-menu-row-left">
                            {daemon?.running ? <RotateCcw size={13} /> : <Play size={13} />}
                            <span>{daemon?.running ? '重启后台服务' : '启动后台服务'}</span>
                          </span>
                        </button>
                        {daemon?.running && (
                          <button
                            type="button"
                            role="menuitem"
                            className="mc-space-pop-item is-danger"
                            disabled={daemonBusy}
                            onClick={() => { close(); void handleDaemonAction('stop') }}
                          >
                            <span className="mc-menu-row-left">
                              <Square size={12} />
                              <span>停止后台服务…</span>
                            </span>
                          </button>
                        )}
                      </>
                    )}
                    {onOpenDaemonLogs && (
                      <button
                        type="button"
                        role="menuitem"
                        className="mc-space-pop-item"
                        onClick={() => { close(); onOpenDaemonLogs() }}
                      >
                        <span className="mc-menu-row-left">
                          <Terminal size={13} />
                          <span>查看服务日志</span>
                        </span>
                      </button>
                    )}
                    <div className="mc-menu-sep" role="separator" />
                    <button
                      type="button"
                      role="menuitem"
                      className="mc-space-pop-item"
                      onClick={() => { close(); setOpsModalOpen(true) }}
                    >
                      <span className="mc-menu-row-left">
                        <Settings2 size={13} />
                        <span>本机运维与设备通道…</span>
                      </span>
                    </button>
                  </div>
                )}
              </Dropdown>
            </div>

            <div className="mc-crown-right">
              <div className="mc-scope-switch" role="radiogroup" aria-label="算力可见范围">
                <button
                  type="button"
                  role="radio"
                  aria-checked={machineVisibility === 'personal'}
                  className="mc-scope-btn"
                  onClick={() => setMachineVisibility('personal' as MachineVisibilityScope)}
                >
                  独享
                </button>
                <Dropdown
                  align="right"
                  width={276}
                  trigger={({ open, toggle }) => (
                    <button
                      type="button"
                      role="radio"
                      aria-checked={machineVisibility === 'spaces'}
                      aria-expanded={open}
                      aria-haspopup="menu"
                      className="mc-scope-btn mc-scope-btn-spaces"
                      onClick={() => {
                        if (machineVisibility !== 'spaces') {
                          setMachineVisibility('spaces')
                          if (!open) toggle()
                        } else {
                          toggle()
                        }
                      }}
                    >
                      <span>指定空间</span>
                      <span className={`mc-scope-count${machineVisibility === 'spaces' ? ' is-visible' : ''}`}>
                        {allowedSpaceIds.length}
                      </span>
                      <ChevronDown size={11} className={`mc-scope-chevron${open ? ' is-open' : ''}`} aria-hidden="true" />
                    </button>
                  )}
                >
                  {() => {
                    const allChecked = availableSpaces.length > 0 && availableSpaces.every((s) => allowedSpaceIds.includes(s.id))
                    return (
                      <div className="mc-space-popover" role="group" aria-label="允许调度的空间">
                        <div className="mc-space-pop-head">
                          <span className="mc-space-pop-title">允许调度的空间</span>
                          {availableSpaces.length > 0 && (
                            <button
                              type="button"
                              className="mc-space-pop-action"
                              onClick={() => setMachineVisibility('spaces', allChecked ? [] : availableSpaces.map((s) => s.id))}
                            >
                              {allChecked ? '清空' : '全选'}
                            </button>
                          )}
                        </div>
                        {availableSpaces.length === 0 ? (
                          <div className="mc-space-pop-empty">当前尚未加入团队空间</div>
                        ) : (
                          <div className="mc-space-pop-list my-scrollbar">
                            {availableSpaces.map((space) => {
                              const checked = allowedSpaceIds.includes(space.id)
                              return (
                                <button
                                  key={space.id}
                                  type="button"
                                  role="menuitemcheckbox"
                                  aria-checked={checked}
                                  className="mc-space-pop-item"
                                  onClick={() => toggleAllowedSpace(space.id)}
                                >
                                  <span className="mc-space-pop-meta">
                                    <span className="mc-space-pop-name">{space.name}</span>
                                    <span className="mc-space-pop-key">{space.key}</span>
                                  </span>
                                  <span className={`mc-space-pop-check${checked ? ' is-checked' : ''}`} aria-hidden="true">
                                    {checked && <Check size={10} />}
                                  </span>
                                </button>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )
                  }}
                </Dropdown>
                <button
                  type="button"
                  role="radio"
                  aria-checked={machineVisibility === 'organization'}
                  className="mc-scope-btn"
                  onClick={() => setMachineVisibility('organization' as MachineVisibilityScope)}
                >
                  全员
                </button>
              </div>
              <Button size="sm" variant="outline" disabled={pendingAction !== null} onClick={() => void handleGlobalRefresh()}>
                {pendingAction === 'refresh' ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                探测
              </Button>
              <Button size="sm" variant="primary" onClick={() => setCustomModal('new')}>
                <Plus size={13} />接入
              </Button>
            </div>
          </header>

          {daemonNeedsRestart && hasIpc && api.daemon && (
            <div role="status" className="mc-daemon-banner is-warn">
              <div className="mc-daemon-banner-left">
                <span className="mc-daemon-banner-icon" aria-hidden="true">
                  <AlertTriangle size={14} />
                </span>
                <div className="min-w-0">
                  <div className="mc-daemon-banner-title">后台守护进程版本已更新，需要重启服务</div>
                  <div className="mc-daemon-banner-desc">
                    应用构建已变化，当前常驻进程仍运行旧版本，导致测速与最新多源模型识别受限。
                    {(daemon?.activeJobs ?? 0) > 0 ? ` 当前有 ${daemon?.activeJobs} 个运行中任务，重启前将再次确认。` : ''}
                  </div>
                </div>
              </div>
              <Button size="sm" variant="primary" disabled={daemonBusy} onClick={() => void handleDaemonAction('restart')}>
                {daemonBusy ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
                重启服务
              </Button>
            </div>
          )}

          {!daemonNeedsRestart && daemon && !daemon.running && hasIpc && api.daemon && (
            <div role="status" className="mc-daemon-banner">
              <div className="mc-daemon-banner-left">
                <span className="mc-daemon-banner-icon" aria-hidden="true">
                  <Server size={14} />
                </span>
                <div className="min-w-0">
                  <div className="mc-daemon-banner-title">本机后台守护进程已停止</div>
                  <div className="mc-daemon-banner-desc">启动后台服务后即可正常探测引擎连接、读取实时模型目录并调度本机任务。</div>
                </div>
              </div>
              <Button size="sm" variant="primary" disabled={daemonBusy} onClick={() => void handleDaemonAction('start')}>
                {daemonBusy ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                立即启动
              </Button>
            </div>
          )}

          {conflictNotice && (
            <div role="status" className="mc-sub-band is-notice">
              <span>{conflictNotice}</span>
              <Button size="sm" variant="ghost" onClick={clearConflictNotice}>知道了</Button>
            </div>
          )}

          <div className="mc-stage-scroll my-scrollbar">
            <section className="mc-stage" aria-label="Runtime 详情与配置">
            {!selected ? (
              <EmptyState
                title="暂未探测到本机 Runtime"
                description="点击右上角「探测」扫描本机 CLI，或点击「接入」添加自定义执行器。"
              />
            ) : (
              <>
                {/* 铭牌头 + 点阵示波屏 */}
                <div className="mc-hero">
                  <div className="mc-hero-left">
                    <div className="mc-hero-id">
                      <div className="mc-hero-wafer">
                        {selected.kind === 'custom'
                          ? <Sparkles size={22} className="text-my-icon-secondary" />
                          : <ToolBrandIcon brand={selected.id} size={24} />}
                      </div>
                      <div className="min-w-0">
                        <h2 className="mc-hero-title">
                          <span className="truncate">{selected.name}</span>
                          {selected.version && <span className="mc-hero-ver">v{selected.version}</span>}
                          {isSelectedPrimary && (
                            <span className="mc-primary-pill">
                              <Zap size={10} aria-hidden="true" />默认主力
                            </span>
                          )}
                        </h2>
                        <div className="mc-hero-sub">
                          <span>{selected.protocolLabel}</span>
                          <span>·</span>
                          <span>{boundAgents.length} Agent</span>
                          <span>·</span>
                          {isSelectedSettingUp ? (
                            <span className="mc-hero-sub-busy">
                              <Loader2 size={11} className="motion-safe:animate-spin" aria-hidden="true" />
                              <span>{selectedSetupTask?.phaseLabel ?? (selected.updateAvailable ? '正在升级…' : '正在安装…')}</span>
                            </span>
                          ) : (
                            <span className={selected.ready && !selected.updateAvailable ? 'text-my-success-text' : 'text-my-warning-text'}>
                              {selected.statusText}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="mc-hero-foot">
                      <div className="mc-hero-agents" aria-label="当前引擎承载的协作角色">
                        <span className="mc-hero-agents-k">
                          <Bot size={12} aria-hidden="true" />
                          <span>托管角色</span>
                        </span>
                        {boundAgents.length === 0 ? (
                          <span className="text-my-2xs text-my-tertiary">尚未分配角色</span>
                        ) : (
                          <div className="mc-agent-pills">
                            {boundAgents.slice(0, 4).map((agent) => (
                              <Dropdown
                                key={agent.id}
                                align="left"
                                width={284}
                                trigger={({ open, toggle }) => (
                                  <button
                                    type="button"
                                    className="mc-agent-pill"
                                    aria-expanded={open}
                                    aria-haspopup="dialog"
                                    onClick={toggle}
                                  >
                                    <span className="mc-agent-dot" aria-hidden="true">{agent.name.slice(0, 1)}</span>
                                    <span>{agent.name}</span>
                                  </button>
                                )}
                              >
                                {(close) => (
                                  <div className="mc-pop-card" role="dialog" aria-label={`角色 ${agent.name} 详情`}>
                                    <div className="mc-pop-head">
                                      <span className="flex items-center gap-2 min-w-0">
                                        <span className="mc-agent-dot" aria-hidden="true">{agent.name.slice(0, 1)}</span>
                                        <span className="mc-pop-title truncate">{agent.name}</span>
                                      </span>
                                      <span className="mc-pop-badge">{selected.name}</span>
                                    </div>
                                    <p className="mc-pop-desc">
                                      {agent.description?.trim() || agent.instructions?.trim().slice(0, 72) || '当前通过此 Runtime 在本机执行对话与协作任务。'}
                                    </p>
                                    <div className="mc-pop-kv">
                                      <div className="mc-pop-kv-row">
                                        <span className="mc-pop-kv-k">执行底座</span>
                                        <span className="font-mono text-my-xs text-my-primary">{selected.name}</span>
                                      </div>
                                      <div className="mc-pop-kv-row">
                                        <span className="mc-pop-kv-k">默认模型</span>
                                        <span className="truncate font-mono text-my-2xs text-my-secondary">
                                          {selectedModelCard?.displayName ?? (selectedModelId || '跟随引擎自动')}
                                        </span>
                                      </div>
                                    </div>
                                    {onManageAgents && (
                                      <div className="mc-pop-foot">
                                        <button
                                          type="button"
                                          className="mc-pop-link"
                                          onClick={() => { close(); onManageAgents() }}
                                        >
                                          <span>前往全部 Agent 管理</span>
                                          <ArrowUpRight size={12} />
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </Dropdown>
                            ))}
                            {boundAgents.length > 4 && (
                              <Dropdown
                                align="left"
                                width={264}
                                trigger={({ open, toggle }) => (
                                  <button
                                    type="button"
                                    className="mc-agent-more"
                                    aria-expanded={open}
                                    aria-haspopup="dialog"
                                    onClick={toggle}
                                  >
                                    +{boundAgents.length - 4}
                                  </button>
                                )}
                              >
                                {(close) => (
                                  <div className="mc-pop-card" role="dialog" aria-label="全部托管角色">
                                    <div className="mc-pop-head">
                                      <span className="mc-pop-title">由 {selected.name} 托管的角色</span>
                                      <span className="mc-pop-badge">{boundAgents.length}</span>
                                    </div>
                                    <div className="mc-pop-list my-scrollbar">
                                      {boundAgents.map((agent) => (
                                        <div key={agent.id} className="mc-pop-row">
                                          <span className="mc-agent-dot" aria-hidden="true">{agent.name.slice(0, 1)}</span>
                                          <span className="mc-pop-row-main">
                                            <span className="mc-pop-row-name">{agent.name}</span>
                                            {agent.description?.trim() && <span className="mc-pop-row-sub">{agent.description.trim()}</span>}
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                    {onManageAgents && (
                                      <div className="mc-pop-foot">
                                        <button
                                          type="button"
                                          className="mc-pop-link"
                                          onClick={() => { close(); onManageAgents() }}
                                        >
                                          <span>前往全部 Agent 管理</span>
                                          <ArrowUpRight size={12} />
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </Dropdown>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="mc-hero-ops">
                        {!isSelectedPrimary && (
                          <Button size="sm" variant="primary" onClick={() => handleSetPrimary(selected)}>
                            <Zap size={12} />设为主力
                          </Button>
                        )}
                        {selected.kind === 'builtin' && selected.agent && (selected.agent.setupRequired || selected.updateAvailable || isSelectedSettingUp) && !selected.agent.setupBlockedReason && (() => {
                          const isUpgrade = selectedSetupTask ? selectedSetupTask.intent === 'upgrade' : selected.updateAvailable
                          const setupLabel = isSelectedSettingUp
                            ? (isUpgrade ? '升级中…' : '安装中…')
                            : (isUpgrade ? '一键升级' : '安装')
                          const busyOther = !isSelectedSettingUp && pendingAction !== null
                          return (
                            <Button
                              size="sm"
                              variant="outline"
                              className={isSelectedSettingUp ? 'mc-setup-btn-busy' : undefined}
                              aria-busy={isSelectedSettingUp || undefined}
                              title={isSelectedSettingUp ? '后台正在处理更新，可在下方查看实时进度与日志' : busyOther ? '当前正在处理其他本机操作，请稍候' : undefined}
                              disabled={!hasIpc || pendingAction !== null}
                              onClick={() => void handleSetupRuntime(selected)}
                            >
                              {isSelectedSettingUp
                                ? <Loader2 size={12} className="motion-safe:animate-spin" aria-hidden="true" />
                                : <Download size={12} aria-hidden="true" />}
                              {setupLabel}
                            </Button>
                          )
                        })()}
                        {selected.kind === 'builtin' && selected.agent?.availableMigration && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void api.openExternal(selected.agent!.availableMigration!.guideUrl)}
                          >
                            <ExternalLink size={12} />v{selected.agent.availableMigration.version} 迁移指南
                          </Button>
                        )}
                        {selected.kind === 'custom' && selected.custom && (
                          <>
                            <Button size="sm" variant="outline" onClick={() => setCustomModal(selected.custom!)}>编辑</Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                archiveCustomRuntime(selected.custom!.id, true)
                                pushToast({ kind: 'info', title: `已归档自定义引擎「${selected.name}」` })
                              }}
                            >
                              归档
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* 纯净可点击点阵示波仪（点击整卡即测速，零多余内嵌按钮框） */}
                  <button
                    type="button"
                    className="mc-osc"
                    data-sweeping={isSelectedTesting || undefined}
                    disabled={!hasIpc || selected.kind !== 'builtin' || selected.agent?.launchKind === 'sdk' || !selected.agent?.available || Boolean(selected.agent?.setupRequired) || pendingAction !== null}
                    title={selected.agent?.launchKind === 'sdk' ? '内置 SDK 零外部进程延迟' : '点击示波屏发射真实握手探测波'}
                    onClick={() => void handleTestConnection(selected)}
                  >
                    <span className="mc-osc-sweep" aria-hidden="true" />
                    <div className="mc-osc-head">
                      <span className="mc-osc-label">
                        {selected.agent?.launchKind === 'sdk' ? 'IN-PROCESS' : 'HANDSHAKE'}
                      </span>
                      <div>
                        <span className={`mc-osc-num${!isSelectedSettingUp && selected.needsAttention ? ' is-warn' : ''}`}>
                          {isSelectedSettingUp ? 'UPD' : selectedLatestMs !== null ? selectedLatestMs : selected.agent?.launchKind === 'sdk' ? 'SDK' : selected.ready ? 'OK' : '—'}
                        </span>
                        <span className="mc-osc-unit">
                          {isSelectedSettingUp ? 'BUSY' : selectedLatestMs !== null ? 'ms' : selected.ready ? 'READY' : 'WAIT'}
                        </span>
                      </div>
                    </div>
                    {oscGeometry ? (
                      <svg className="mc-osc-svg" viewBox="0 0 180 34" preserveAspectRatio="none" aria-hidden="true">
                        <line x1="0" y1="17" x2="174" y2="17" stroke="var(--my-border-subtle)" strokeDasharray="2 3" strokeWidth="1" />
                        <path d={oscGeometry.area} fill="var(--my-bg-success-subtle)" />
                        <path d={oscGeometry.line} fill="none" stroke="var(--my-txt-success-primary)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                        <circle className="mc-osc-live-dot" cx={oscGeometry.last.x} cy={oscGeometry.last.y} r="3" fill="var(--my-txt-success-primary)" />
                      </svg>
                    ) : (
                      <svg className="mc-osc-svg" viewBox="0 0 180 34" preserveAspectRatio="none" aria-hidden="true">
                        <line
                          x1="0"
                          y1="19"
                          x2="174"
                          y2="19"
                          stroke={selected.ready ? 'var(--my-txt-success-primary)' : 'var(--my-border-strong)'}
                          strokeDasharray="3 4"
                          strokeWidth="1.4"
                        />
                      </svg>
                    )}
                    <div className="mc-osc-foot">
                      <span className="mc-osc-empty-hint">
                        {isSelectedSettingUp
                          ? (selectedSetupTask?.intent === 'install' ? '正在安装，完成后可测速' : '正在升级，完成后可测速')
                          : isSelectedTesting
                            ? '正在发射握手探测…'
                            : selected.agent?.launchKind === 'sdk'
                              ? '应用内置直连'
                              : selectedSamples.length > 0
                                ? `${selectedSamples.length} 次采样 · 点击重测`
                                : selected.ready
                                  ? '点击测速'
                                  : '安装或修复后可测速'}
                      </span>
                      {selected.kind === 'builtin' && selected.agent?.launchKind !== 'sdk' && (selected.ready || isSelectedSettingUp) && (
                        <span className="mc-osc-cue" aria-hidden="true">
                          {isSelectedTesting || isSelectedSettingUp ? <Loader2 size={11} className="motion-safe:animate-spin" /> : <Play size={10} />}
                        </span>
                      )}
                    </div>
                  </button>
                </div>

                {/* 就地实时安装/升级进度面板：真实阶段、耗时、子进程 PID 与按需展开的实时输出日志 */}
                {selectedSetupTask && (() => {
                  const task = selectedSetupTask
                  const isRunning = task.state === 'running'
                  const isSucceeded = task.state === 'succeeded'
                  const isFailed = task.state === 'failed'
                  const isUnknown = task.outcome === 'unknown'
                  const steps = selected.agent?.launchKind === 'managed' ? MANAGED_SETUP_STEPS : NATIVE_SETUP_STEPS
                  const failedAnchor = setupLastPhase[selected.id]
                  const elapsedLabel = formatSetupElapsed(task.startedAt, task.finishedAt, setupNow)
                  const latestLog = task.logs[task.logs.length - 1]
                  const logsOpen = Boolean(setupLogsOpen[selected.id])
                  const versionBadge = task.currentVersion && task.targetVersion && task.currentVersion !== task.targetVersion
                    ? `v${task.currentVersion} → v${task.targetVersion}`
                    : task.targetVersion
                      ? `v${task.targetVersion}`
                      : null
                  const canRetrySetup = isFailed && !isUnknown && !pendingAction && selected.kind === 'builtin' && !selected.agent?.setupBlockedReason

                  return (
                    <section
                      className="mc-setup-card"
                      data-state={task.state}
                      role={isFailed ? 'alert' : 'status'}
                      aria-live={isFailed ? 'assertive' : 'polite'}
                      aria-label={`${selected.name} ${task.intent === 'upgrade' ? '升级' : '安装'}进度`}
                    >
                      <div className="mc-setup-head">
                        <div className="mc-setup-head-left">
                          <span className={`mc-setup-ico is-${task.state}`} aria-hidden="true">
                            {isRunning
                              ? <Loader2 size={13} className="motion-safe:animate-spin" />
                              : isSucceeded
                                ? <Check size={13} />
                                : <AlertTriangle size={13} />}
                          </span>
                          <div className="mc-setup-title-wrap">
                            <span className="mc-setup-title">
                              {isRunning
                                ? `正在${task.intent === 'upgrade' ? '升级' : '安装'} ${selected.name}`
                                : isSucceeded
                                  ? `${selected.name} ${task.intent === 'upgrade' ? '升级完成' : '安装完成'}`
                                  : isUnknown
                                    ? `${selected.name} 更新状态待核对`
                                    : `${selected.name} ${task.intent === 'upgrade' ? '升级未完成' : '安装未完成'}`}
                            </span>
                            {versionBadge && <span className="mc-setup-ver">{versionBadge}</span>}
                          </div>
                        </div>

                        <div className="mc-setup-head-right">
                          {isRunning && task.pid && (
                            <span className="mc-setup-meta-chip" title="后台子进程 ID，证明当前任务正在执行">
                              PID {task.pid}
                            </span>
                          )}
                          <span className="mc-setup-elapsed" title="本次操作已耗时">
                            {elapsedLabel}
                          </span>
                          {canRetrySetup && (
                            <Button size="sm" variant="outline" onClick={() => void handleSetupRuntime(selected)}>
                              <RotateCcw size={11} aria-hidden="true" />重试
                            </Button>
                          )}
                          {isUnknown && !pendingAction && (
                            <Button size="sm" variant="outline" onClick={() => void handleGlobalRefresh()}>
                              <RefreshCw size={11} aria-hidden="true" />重新探测
                            </Button>
                          )}
                          {!isRunning && (
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label="关闭本次升级进度提示"
                              onClick={() => handleDismissSetupTask(selected.id)}
                            >
                              <X size={13} />
                            </Button>
                          )}
                        </div>
                      </div>

                      <div className="mc-setup-steps" aria-label="执行阶段">
                        {steps.map((step) => {
                          const stepState = resolveSetupStepState(task, step.phase, failedAnchor)
                          return (
                            <span key={step.phase} className={`mc-setup-step is-${stepState}`}>
                              <span className="mc-setup-step-dot" aria-hidden="true">
                                {stepState === 'done' && <Check size={9} />}
                              </span>
                              <span>{step.label}</span>
                            </span>
                          )
                        })}
                      </div>

                      <div
                        className="mc-setup-track"
                        role="progressbar"
                        aria-label={`${selected.name}：${task.phaseLabel}`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={isSucceeded ? 100 : undefined}
                        aria-valuetext={isSucceeded ? '已完成' : isFailed ? '未完成' : `${task.phaseLabel}，进行中`}
                      >
                        <span className="mc-setup-track-bar" />
                      </div>

                      <div className="mc-setup-live-row">
                        <div className="mc-setup-live-main">
                          {isFailed ? (
                            <>
                              <span className="mc-setup-phase is-error">
                                {isUnknown
                                  ? '后台结果未确认，请先核对当前状态'
                                  : `在「${steps.find((s) => s.phase === (failedAnchor && failedAnchor !== 'failed' ? failedAnchor : 'installing'))?.label ?? '执行'}」阶段中止`}
                              </span>
                              {task.error && <span className="mc-setup-error-text">{task.error}</span>}
                            </>
                          ) : isSucceeded ? (
                            <span className="mc-setup-phase is-ok">
                              {task.detail ?? task.phaseLabel}
                            </span>
                          ) : (
                            <>
                              <span className="mc-setup-phase">{task.phaseLabel}</span>
                              {latestLog ? (
                                <code className="mc-setup-latest-log" title={latestLog}>{latestLog}</code>
                              ) : task.commandSummary ? (
                                <code className="mc-setup-latest-log" title={task.commandSummary}>{task.commandSummary}</code>
                              ) : task.fallbackLocal ? (
                                <span className="mc-setup-hint">后台正在执行 npm 更新；重启后台服务后可查看分阶段实时日志</span>
                              ) : task.detail ? (
                                <span className="mc-setup-hint">{task.detail}</span>
                              ) : null}
                            </>
                          )}
                        </div>

                        {(task.logs.length > 0 || task.commandSummary || task.commandId) && (
                          <button
                            type="button"
                            className="mc-setup-log-toggle"
                            aria-expanded={logsOpen}
                            onClick={() => setSetupLogsOpen((prev) => ({ ...prev, [selected.id]: !prev[selected.id] }))}
                          >
                            <Terminal size={12} aria-hidden="true" />
                            <span>{logsOpen ? '收起日志' : `实时日志${task.logs.length > 0 ? ` (${task.logs.length})` : ''}`}</span>
                            <ChevronDown size={11} className={`mc-scope-chevron${logsOpen ? ' is-open' : ''}`} aria-hidden="true" />
                          </button>
                        )}
                      </div>

                      {logsOpen && (
                        <div className="mc-setup-console">
                          <div className="mc-setup-console-bar">
                            <span className="mc-setup-console-cmd" title={task.commandSummary ?? task.commandId ?? ''}>
                              {task.commandSummary ? `$ ${task.commandSummary}` : task.commandId ? `命令 ID：${task.commandId}` : '后台执行输出'}
                            </span>
                            <button
                              type="button"
                              className="mc-setup-copy-btn"
                              onClick={() => handleCopySetupLogs(task, selected.name)}
                            >
                              {setupCopiedId === selected.id ? <Check size={11} className="text-my-success-text" /> : <Copy size={11} />}
                              <span>{setupCopiedId === selected.id ? '已复制' : '复制日志'}</span>
                            </button>
                          </div>
                          <div className="mc-setup-console-body my-scrollbar" role="log" aria-label="后台升级实时输出">
                            {task.logs.length === 0 ? (
                              <div className="mc-setup-console-empty">
                                {isRunning ? '已提交至后台，等待 npm 输出首批进度…' : '本次操作无额外命令行输出。'}
                              </div>
                            ) : (
                              task.logs.map((line, idx) => (
                                <div
                                  key={`${idx}-${line.slice(0, 16)}`}
                                  className={`mc-setup-log-line${/npm\s+(?:ERR!|error)|^ERR!/i.test(line) ? ' is-err' : /^npm\s+warn/i.test(line) ? ' is-warn' : ''}`}
                                >
                                  {line}
                                </div>
                              ))
                            )}
                            {task.commandId && (
                              <div className="mc-setup-log-line is-meta">命令 ID：{task.commandId}</div>
                            )}
                            <div ref={setupLogEndRef} />
                          </div>
                        </div>
                      )}
                    </section>
                  )
                })()}

                {rowError[selected.id] && !isDaemonOutdatedMessage(rowError[selected.id]) && selectedSetupTask?.state !== 'failed' && (
                  <p role="alert" className="mc-error-note">{rowError[selected.id]}</p>
                )}

                {/* 互动式启动管线（Patch-Bay Pipeline：每个节点与下方配置双向实时联动，变更时流光脉冲） */}
                <div className="mc-cmd-bus" data-flash={flashCmd || undefined}>
                  <span className="mc-pipe-wave" aria-hidden="true" />
                  <div className="mc-cmd-stream" title={fullCommandString}>
                    <span className="mc-pipe-k">启动管线</span>
                    <button
                      type="button"
                      className="mc-pipe-node is-bin"
                      title="点击查看引擎完整路径与诊断"
                      onClick={() => setStageTab('diag')}
                    >
                      <span className={`mc-cmd-led${selected.needsAttention ? ' is-warn' : ''}`} aria-hidden="true" />
                      <span>{selected.binaryLabel}</span>
                    </button>

                    <ChevronRight size={11} className="mc-pipe-arrow" aria-hidden="true" />

                    {selectedModelId ? (
                      <span className="mc-pipe-node is-model">
                        <button
                          type="button"
                          className="mc-pipe-node-btn"
                          title="点击跳转到可用模型配置"
                          onClick={() => setStageTab('models')}
                        >
                          <span className="mc-pipe-node-k">model</span>
                          <span>{selectedModelCard?.displayName ?? selectedModelId}</span>
                        </button>
                        <button
                          type="button"
                          className="mc-pipe-clear"
                          title="切回自动选模"
                          aria-label="切回自动选模"
                          onClick={() => void handleSelectModel('')}
                        >
                          <X size={10} />
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="mc-pipe-node is-auto"
                        title="当前跟随引擎默认策略，点击配置模型"
                        onClick={() => setStageTab('models')}
                      >
                        <span className="mc-pipe-node-k">model</span>
                        <span>AUTO</span>
                      </button>
                    )}

                    {selectedModelId && activeEffortLabel && (
                      <>
                        <ChevronRight size={11} className="mc-pipe-arrow" aria-hidden="true" />
                        <button
                          type="button"
                          className="mc-pipe-node is-effort"
                          title="点击快速循环切换默认思考强度"
                          onClick={() => void handleCycleActiveEffort()}
                        >
                          <Brain size={11} aria-hidden="true" />
                          <span>{activeEffortLabel}</span>
                        </button>
                      </>
                    )}

                    {(selectedEnv.length > 0 || selectedArgs.length > 0) && (
                      <>
                        <ChevronRight size={11} className="mc-pipe-arrow" aria-hidden="true" />
                        <button
                          type="button"
                          className="mc-pipe-node is-env"
                          title="点击查看或编辑启动参数与环境变量"
                          onClick={() => setStageTab('env')}
                        >
                          {selectedEnv.length > 0 && <span>+{selectedEnv.length} ENV</span>}
                          {selectedEnv.length > 0 && selectedArgs.length > 0 && <span>·</span>}
                          {selectedArgs.length > 0 && <span>+{selectedArgs.length} 参数</span>}
                        </button>
                      </>
                    )}
                  </div>
                  <Button size="sm" variant="ghost" onClick={handleCopyCommand}>
                    {copiedCmd ? <Check size={12} className="text-my-success-text" /> : <Copy size={12} />}
                    {copiedCmd ? '已复制' : '复制'}
                  </Button>
                </div>

                {/* 极简下划线工作区导航（降维去冗余，不与下方模型面板打架） */}
                <div className="mc-stage-nav">
                  <div className="mc-stage-tabs" role="tablist" aria-label="Runtime 配置分类">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={stageTab === 'models'}
                      className="mc-tab-btn"
                      onClick={() => setStageTab('models')}
                    >
                      模型与思考<span className="mc-tab-cnt">{selectedModelCards.length}</span>
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={stageTab === 'env'}
                      className="mc-tab-btn"
                      onClick={() => setStageTab('env')}
                    >
                      环境与参数
                      {(selectedEnv.length + selectedArgs.length) > 0 && (
                        <span className="mc-tab-cnt">{selectedEnv.length + selectedArgs.length}</span>
                      )}
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={stageTab === 'diag'}
                      className="mc-tab-btn"
                      onClick={() => setStageTab('diag')}
                    >
                      诊断记录
                    </button>
                  </div>
                </div>

                {/* 页签内容区：单层收敛控制条 + 单列阶梯思考深度推子 */}
                {stageTab === 'models' && (
                  <div className="mc-mcat-sheet">
                    {/* 统一单层控制顶栏：来源筛选 + 自动选模开关 + 筛选与刷新 */}
                    <div className="mc-mcat-head">
                      <div className="mc-mcat-head-left">
                        {modelSourceSummary.length > 1 ? (
                          <div className="mc-mcat-tabs" role="tablist" aria-label="按模型来源筛选">
                            <button
                              type="button"
                              role="tab"
                              aria-selected={modelSourceFilter === 'all'}
                              className="mc-mcat-tab"
                              onClick={() => setModelSourceFilter('all')}
                            >
                              <span>全部</span>
                              <span className="mc-mcat-tab-num">{selectedModelCards.length}</span>
                            </button>
                            {modelSourceSummary.map((entry) => (
                              <button
                                key={entry.kind}
                                type="button"
                                role="tab"
                                aria-selected={modelSourceFilter === entry.kind}
                                className="mc-mcat-tab"
                                onClick={() => setModelSourceFilter(entry.kind)}
                              >
                                <span className={`mc-src-dot is-${entry.kind}`} aria-hidden="true" />
                                <span>{entry.label}</span>
                                <span className="mc-mcat-tab-num">{entry.count}</span>
                              </button>
                            ))}
                          </div>
                        ) : (
                          <div className="mc-mcat-single-src">
                            {modelSourceSummary[0] ? (
                              <>
                                <span className={`mc-src-dot is-${modelSourceSummary[0].kind}`} aria-hidden="true" />
                                <span className="mc-mcat-src-label">{modelSourceSummary[0].label}</span>
                                <span className="mc-mcat-tab-num">{selectedModelCards.length}</span>
                              </>
                            ) : (
                              <span className="mc-mcat-src-label">模型目录</span>
                            )}
                          </div>
                        )}
                        {hasEndpointEnvOverride && (
                          <span className="mc-env-override-tag" title="当前 Runtime 环境变量已配置自定义端点">
                            自定义端点
                          </span>
                        )}
                      </div>

                      <div className="mc-mcat-head-right">
                        <button
                          type="button"
                          className="mc-auto-toggle"
                          aria-pressed={selectedModelId === ''}
                          title={selectedModelId === '' ? '当前由引擎自动选择默认模型' : '点击取消锁定，恢复由引擎自动选择默认模型'}
                          onClick={() => void handleSelectModel('')}
                        >
                          <span className={`mc-auto-dot${selectedModelId === '' ? ' is-on' : ''}`} aria-hidden="true" />
                          <span>自动选模</span>
                        </button>
                        {selectedModelCards.length > 6 && (
                          <label className="mc-mcat-search">
                            <Search size={12} className="mc-mcat-search-ico" aria-hidden="true" />
                            <input
                              type="search"
                              className="mc-mcat-search-in"
                              value={modelSearchQuery}
                              aria-label="搜索可用模型"
                              placeholder="筛选…"
                              onChange={(e) => setModelSearchQuery(e.target.value)}
                            />
                          </label>
                        )}
                        {isModelCatalogProvisional && (
                          <span className="mc-sync-pill" role="status">
                            <Loader2 size={11} className="animate-spin" aria-hidden="true" />同步
                          </span>
                        )}
                        {hasIpc && selectedDriverInstanceId && (
                          <button
                            type="button"
                            className="mc-mcat-icon-btn"
                            disabled={isModelCatalogLoading}
                            title="重新从原生账号、CC Switch、Magpie 等途径读取实时模型目录"
                            aria-label="刷新实时模型目录"
                            onClick={() => void handleRefreshModelCatalog()}
                          >
                            <RefreshCw size={12} className={isModelCatalogLoading ? 'animate-spin' : undefined} />
                          </button>
                        )}
                      </div>
                    </div>

                    {modelCatalogError && !isDaemonOutdatedMessage(modelCatalogError) && (
                      <div className="mc-mcat-notice" role="status">
                        <span className="truncate">{modelCatalogError}</span>
                        <Button size="sm" variant="ghost" onClick={() => void handleRefreshModelCatalog()}>重试</Button>
                      </div>
                    )}

                    {/* 单列阶梯思考深度推子清单（彻底消灭中段大面积留白） */}
                    <div
                      className="mc-mcat-body my-scrollbar"
                      role="list"
                      aria-label="可用模型与思考强度推子清单"
                      style={{ '--mc-tone-accent': isDarkTheme ? (EFFORT_TRACK_TONES[effortTrackTone]?.accentDark ?? EFFORT_TRACK_TONES.obsidian.accentDark) : (EFFORT_TRACK_TONES[effortTrackTone]?.accentLight ?? EFFORT_TRACK_TONES.obsidian.accentLight) } as JSX.IntrinsicElements['div']['style']}
                    >
                      {isModelCatalogLoading && selectedModelCards.length === 0 ? (
                        <div className="mc-mcat-empty" role="status">
                          <Loader2 size={14} className="animate-spin text-my-icon-secondary" aria-hidden="true" />
                          <span>正在读取 {selected.name} 实时模型目录…</span>
                        </div>
                      ) : filteredModelCards.length === 0 ? (
                        <div className="mc-mcat-empty">
                          <span>
                            {modelSearchQuery.trim()
                              ? `未找到匹配「${modelSearchQuery.trim()}」的模型`
                              : selectedDriverInstanceId
                                ? '暂无已发现模型，可在下方直接声明模型 ID'
                                : '该引擎未接入自动模型目录，可在下方手动声明模型 ID'}
                          </span>
                          {(modelSearchQuery.trim() || modelSourceFilter !== 'all') && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => { setModelSearchQuery(''); setModelSourceFilter('all') }}
                            >
                              重置筛选
                            </Button>
                          )}
                        </div>
                      ) : (
                        groupedModelSections.map((section, sectionIndex) => (
                          <div key={section.key} className="mc-mcat-group">
                            <div className="mc-mcat-group-hdr">
                              <span className="mc-mcat-group-title">
                                <span className={`mc-src-dot is-${section.kind}`} aria-hidden="true" />
                                <span>{section.label}</span>
                                <span className="mc-mcat-group-cnt">{section.items.length}</span>
                              </span>
                              {sectionIndex === 0 && (
                                <div className="mc-mcat-group-cap">
                                  <Brain size={11} aria-hidden="true" />
                                  <span>思考深度</span>
                                  <Dropdown
                                    placement="bottom"
                                    align="right"
                                    width={316}
                                    gap={6}
                                    trigger={({ open, toggle }) => (
                                      <button
                                        type="button"
                                        className="ef-quiet-trigger"
                                        aria-expanded={open}
                                        aria-haspopup="menu"
                                        aria-label={`自定义思考深度滑块外观（当前：${findEffortStyleOption(effortEmblemStyle).name}）`}
                                        title={`切换滑块外观：${findEffortStyleOption(effortEmblemStyle).name}（也可在设置 → 外观预览）`}
                                        onClick={toggle}
                                      >
                                        <Palette size={13} aria-hidden="true" />
                                      </button>
                                    )}
                                  >
                                    {(close) => (
                                      <EffortStylePickerPopover
                                        emblemStyle={effortEmblemStyle}
                                        trackTone={effortTrackTone}
                                        isDark={isDarkTheme}
                                        onSelectStyle={setEffortEmblemStyle}
                                        onSelectTone={setEffortTrackTone}
                                        onClose={close}
                                      />
                                    )}
                                  </Dropdown>
                                </div>
                              )}
                            </div>
                            {section.items.map((item) => {
                              const active = item.id === selectedModelId
                              const choices = item.effortChoices ?? []
                              const currentEffort = resolveEffortForModel(item)
                              const chosenIdx = choices.findIndex((c) => c.value === currentEffort)
                              const safeIdx = chosenIdx >= 0 ? chosenIdx : 0

                              return (
                                <div
                                  key={item.id}
                                  role="listitem"
                                  className="mc-mcat-row-wrap"
                                  data-active={active || undefined}
                                >
                                  <div className="mc-mcat-row" data-active={active || undefined}>
                                    {/* 左段：模型身份 */}
                                    <button
                                      type="button"
                                      className="mc-mcat-pick"
                                      aria-pressed={active}
                                      title={item.id}
                                      onClick={() => void handleSelectModel(item.id)}
                                    >
                                      <span className={`mc-mcat-ind${active ? ' is-on' : ''}`} aria-hidden="true">
                                        {active ? <Check size={11} /> : <span className="mc-mcat-dot" />}
                                      </span>
                                      <span className="mc-mcat-name">{item.displayName}</span>
                                      {item.isEngineDefault && (
                                        <span className="mc-mcat-def-tag">默认</span>
                                      )}
                                      {item.contextTag && (
                                        <span className="mc-ctx-chip" title={`上下文窗口 ${item.contextTag}`}>{item.contextTag}</span>
                                      )}
                                      {item.showRawId && (
                                        <span className="mc-mcat-raw-id">{item.id}</span>
                                      )}
                                    </button>

                                    {/* 中段：v9 Crux 雕塑动能轨（无字全高轨 + 悬停定位环 + 6 款可选雕塑滑块） */}
                                    <div className="mc-seg-cell">
                                      {choices.length > 0 ? (
                                        <EffortDetentFader
                                          modelName={item.displayName}
                                          choices={choices}
                                          selectedIndex={safeIdx}
                                          active={active}
                                          emblemStyle={effortEmblemStyle}
                                          trackTone={effortTrackTone}
                                          isDark={isDarkTheme}
                                          onSelect={(value) => void handleSelectModelEffort(item.id, value)}
                                          onHoverPreview={(label, isPeak) =>
                                            setEffortPreview(label ? { modelId: item.id, label, isPeak } : null)
                                          }
                                        />
                                      ) : (
                                        <div className="mc-fader-flat" aria-hidden="true" />
                                      )}
                                    </div>

                                    {/* 右段：清晰思考深度读数 + 手动删除 */}
                                    <div className="mc-mcat-col-readout">
                                      {choices.length > 0 && (() => {
                                        const preview = effortPreview?.modelId === item.id ? effortPreview : null
                                        const readoutLabel = preview ? preview.label : (choices[safeIdx]?.label ?? '标准')
                                        const readoutPeak = preview ? preview.isPeak : (choices.length > 1 && safeIdx === choices.length - 1)
                                        return (
                                          <span className={`mc-kreadout${active ? ' is-active' : ''}${preview ? ' is-preview' : ''}${readoutPeak ? ' is-peak' : ''}`}>
                                            {readoutLabel}
                                          </span>
                                        )
                                      })()}
                                      {item.isManual && (
                                        <button
                                          type="button"
                                          className="mc-mcat-rm-inline"
                                          title={`移除手动声明模型 ${item.id}`}
                                          aria-label={`移除手动声明模型 ${item.id}`}
                                          onClick={() => void handleRemoveManualModel(item.id)}
                                        >
                                          <X size={11} />
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        ))
                      )}
                    </div>

                    {/* 底部内嵌声明行：无悬浮虚线框，一体收口 */}
                    <div className="mc-mcat-foot">
                      <Plus size={13} className="text-my-icon-tertiary flex-none" aria-hidden="true" />
                      <input
                        className="mc-mcat-foot-in"
                        value={manualModelDraft}
                        placeholder={selected.agent?.launchKind === 'sdk' ? '声明模型 ID（如 provider:model），回车启用…' : '声明引擎模型 ID（如 ccs-magpie/gpt-5.4），回车启用…'}
                        onChange={(e) => setManualModelDraft(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') void handleAddManualModel() }}
                      />
                      <Button size="sm" variant="ghost" disabled={!manualModelDraft.trim()} onClick={() => void handleAddManualModel()}>
                        声明并选用
                      </Button>
                    </div>
                  </div>
                )}

                {stageTab === 'env' && (
                  <div className="mc-patch-grid">
                    <div className="mc-patch-row">
                      <span className="mc-patch-k">可执行路径</span>
                      <span className="truncate font-mono text-my-xs text-my-primary" title={selected.commandDisplay}>
                        {middleTruncatePath(selected.commandDisplay)}
                      </span>
                      {selected.kind === 'builtin' && selected.agent?.launchKind !== 'sdk' ? (
                        <Button size="sm" variant="outline" disabled={!hasIpc || pendingAction !== null} onClick={() => void handlePickPath(selected)}>
                          <FolderOpen size={12} />配置
                        </Button>
                      ) : selected.kind === 'custom' && selected.custom ? (
                        <Button size="sm" variant="outline" onClick={() => setCustomModal(selected.custom!)}>编辑</Button>
                      ) : (
                        <span className="text-my-2xs text-my-tertiary">内置</span>
                      )}
                    </div>

                    <div className="mc-patch-row">
                      <span className="mc-patch-k">隔离与底座</span>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-my-xs text-my-primary">
                          {selectedIsolation === 'worktree' ? '独立 worktree 工作树' : '原地目录 (in_place)'}
                        </span>
                        <span className="text-my-2xs text-my-tertiary">Node · {selected.nodeLabel}</span>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          const next: IsolationMode = selectedIsolation === 'worktree' ? 'in_place' : 'worktree'
                          setRuntimeLaunchConfig(selected.id, { isolationMode: next })
                          pushToast({ kind: 'success', title: `${selected.name} 目录隔离已切换为 ${next === 'worktree' ? 'worktree' : '原地目录'}` })
                        }}
                      >
                        切换隔离
                      </Button>
                    </div>

                    {isSelectedPrimary && (
                      <div className="mc-patch-row">
                        <span className="mc-patch-k">默认策略</span>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                          <Select
                            className="w-full"
                            ariaLabel="默认审批策略"
                            value={defaultSlot.approvalPolicy}
                            onChange={(val) => setDefaultSlot({ approvalPolicy: val as LocalApprovalPolicy })}
                            options={[...APPROVAL_OPTIONS_BY_RUNTIME[defaultSlot.runtimeKind]]}
                          />
                          <Select
                            className="w-full"
                            ariaLabel="默认工作目录模式"
                            value={defaultSlot.workingDirectory}
                            onChange={(val) => setDefaultSlot({ workingDirectory: val as CruxWorkingDirectoryMode })}
                            options={[...WORKDIR_MODE_OPTIONS]}
                          />
                        </div>
                        <span className="text-my-2xs text-my-tertiary">主力槽位</span>
                      </div>
                    )}

                    {selected.agent?.launchKind !== 'sdk' && (
                      <div className="mc-patch-row">
                        <span className="mc-patch-k">附加参数</span>
                        <div className="mc-chip-flow">
                          {selectedArgs.map((arg, idx) => (
                            <span key={`${arg.name}-${idx}`} className="mc-arg-chip">
                              <span>{arg.value ? `${arg.name} ${arg.value}` : arg.name}</span>
                              <button type="button" aria-label={`移除参数 ${arg.name}`} onClick={() => void handleRemoveArg(idx)}>
                                <X size={11} />
                              </button>
                            </span>
                          ))}
                          <input
                            className="mc-inline-input font-mono w-36"
                            value={argDraft}
                            placeholder="+ 如 --full-auto"
                            onChange={(e) => setArgDraft(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') void handleAddArg() }}
                          />
                        </div>
                        <Button size="sm" variant="outline" disabled={!argDraft.trim()} onClick={() => void handleAddArg()}>
                          添加
                        </Button>
                      </div>
                    )}

                    <div className="mc-patch-row is-top">
                      <span className="mc-patch-k pt-1">环境变量</span>
                      <div className="flex flex-col gap-2 min-w-0">
                        {selectedEnv.length === 0 ? (
                          <span className="text-my-xs text-my-tertiary">未注入自定义变量（运行时继承系统环境）</span>
                        ) : (
                          selectedEnv.map((pair, idx) => {
                            const masked = /KEY|TOKEN|SECRET|PASS/i.test(pair.key) && !revealSecret
                            return (
                              <div key={`${pair.key}-${idx}`} className="flex items-center gap-2 font-mono text-my-xs">
                                <strong className="text-my-primary">{pair.key}</strong>
                                <span className="text-my-tertiary">=</span>
                                <span className="truncate text-my-secondary">{masked ? '••••••••••' : pair.value}</span>
                                <Button size="sm" variant="ghost" aria-label={`移除环境变量 ${pair.key}`} onClick={() => void handleRemoveEnv(idx)}>
                                  <Trash2 size={12} />
                                </Button>
                              </div>
                            )
                          })
                        )}
                        <div className="flex flex-wrap items-center gap-2">
                          <input
                            className="mc-inline-input font-mono w-28"
                            value={envKeyDraft}
                            placeholder="KEY"
                            onChange={(e) => setEnvKeyDraft(e.target.value)}
                          />
                          <input
                            className="mc-inline-input font-mono w-32"
                            value={envValDraft}
                            placeholder="VALUE"
                            onChange={(e) => setEnvValDraft(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') void handleAddEnv() }}
                          />
                          <Button size="sm" variant="outline" disabled={!envKeyDraft.trim()} onClick={() => void handleAddEnv()}>
                            <Plus size={12} />注入
                          </Button>
                        </div>
                      </div>
                      <Button size="sm" variant="ghost" onClick={() => setRevealSecret((v) => !v)} title={revealSecret ? '隐藏敏感值' : '显示敏感值'}>
                        {revealSecret ? <EyeOff size={13} /> : <Eye size={13} />}
                      </Button>
                    </div>
                  </div>
                )}

                {stageTab === 'diag' && (
                  <div className="mc-diag-board">
                    {/* 顶部 3 格硬件遥测指标卡 */}
                    <div className="mc-diag-kpis">
                      <div className="mc-diag-kpi">
                        <span className="mc-diag-kpi-k">协议与版本</span>
                        <span className="mc-diag-kpi-v">
                          {probeInfo[selected.id]?.protocolVersion ? `ACP v${probeInfo[selected.id].protocolVersion}` : selected.protocolLabel}
                        </span>
                        <span className="mc-diag-kpi-sub">{selected.version ? `适配版本 v${selected.version}` : selected.statusText}</span>
                      </div>
                      <div className="mc-diag-kpi">
                        <span className="mc-diag-kpi-k">运行底座与隔离</span>
                        <span className="mc-diag-kpi-v">{selected.nodeLabel}</span>
                        <span className="mc-diag-kpi-sub">{selectedIsolation === 'worktree' ? 'Worktree 独立工作树' : '原地目录执行'}</span>
                      </div>
                      <div className="mc-diag-kpi">
                        <div className="mc-diag-kpi-top">
                          <span className="mc-diag-kpi-k">最近握手核验</span>
                          {selected.kind === 'builtin' && selected.agent?.launchKind !== 'sdk' && (
                            <button
                              type="button"
                              className="mc-diag-retest"
                              disabled={!hasIpc || pendingAction !== null}
                              onClick={() => void handleTestConnection(selected)}
                            >
                              {isSelectedTesting ? '探测中…' : '重测'}
                            </button>
                          )}
                        </div>
                        <span className="mc-diag-kpi-v">
                          {selected.agent?.checkedAt ? new Date(selected.agent.checkedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '尚未记录'}
                        </span>
                        <span className="mc-diag-kpi-sub">
                          {selected.agent?.checkedAt ? new Date(selected.agent.checkedAt).toLocaleDateString('zh-CN') : '点击示波屏发起核验'}
                        </span>
                      </div>
                    </div>

                    {/* 协议能力矩阵（原页脚内容归位至此处） */}
                    <div className="mc-diag-card">
                      <div className="mc-diag-card-head">
                        <span>支持能力与运行路径</span>
                        <span className="font-mono text-my-2xs text-my-tertiary">{capabilities.length} 项特性</span>
                      </div>
                      <div className="mc-diag-card-body">
                        <div className="mc-cap-inline">
                          {capabilities.map((cap) => (
                            <span key={cap.label} className="mc-cap-mini">
                              <span className={`mc-cap-dot${cap.ok ? '' : ' is-warn'}`} aria-hidden="true" />
                              <span>{cap.label}</span>
                            </span>
                          ))}
                        </div>
                        <div className="mc-diag-path-strip">
                          <span className="mc-diag-path-k">执行入口</span>
                          <code className="truncate font-mono text-my-xs text-my-primary" title={selected.commandDisplay}>
                            {selected.commandDisplay}
                          </code>
                        </div>
                        {selected.agent?.setupBlockedReason && (
                          <div className="mc-diag-warn-strip">{selected.agent.setupBlockedReason}</div>
                        )}
                      </div>
                    </div>

                    {/* 结构化握手诊断时间线 */}
                    {(selected.agent?.diagnostics?.length ?? 0) > 0 && (
                      <div className="mc-diag-card">
                        <div className="mc-diag-card-head">
                          <span>握手与环境诊断记录</span>
                          <span className="font-mono text-my-2xs text-my-tertiary">{selected.agent!.diagnostics!.length} 条记录</span>
                        </div>
                        <ol className="mc-diag-timeline">
                          {selected.agent!.diagnostics!.map((line, idx) => {
                            const tsMatch = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s*·\s*(.+)$/.exec(line.trim())
                            const timeLabel = tsMatch ? new Date(tsMatch[1]).toLocaleTimeString('zh-CN', { hour12: false }) : undefined
                            const message = tsMatch ? tsMatch[2] : line
                            const isSuccess = /成功|已安装|就绪|通过/.test(message)
                            const isWarn = /未启用|未验证|失败|不兼容|异常/.test(message)
                            return (
                              <li key={idx} className="mc-diag-event">
                                <span className={`mc-diag-ev-dot${isWarn ? ' is-warn' : isSuccess ? ' is-ok' : ''}`} aria-hidden="true" />
                                <span className="mc-diag-ev-msg">{message}</span>
                                {timeLabel && <span className="mc-diag-ev-time">{timeLabel}</span>}
                              </li>
                            )
                          })}
                        </ol>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
            </section>
          </div>
        </div>
      </div>

      {/* 本机运维弹窗：守护进程、保持唤醒、自动清理、团队通道心跳、全局 Node */}
      {opsModalOpen && (
        <Modal open placement="center" onClose={() => setOpsModalOpen(false)} width={560} ariaLabel="本机运维与设备通道">
          <div className="mc-modal-shell">
            <header className="mc-modal-head">
              <div className="flex items-center gap-2">
                <Server size={16} className="text-my-icon-secondary" />
                <h2 className="text-my-md font-medium text-my-primary">本机运维与设备通道</h2>
              </div>
              <button type="button" className="my-icon-control" aria-label="关闭本机运维设置" onClick={() => setOpsModalOpen(false)}>
                <X size={15} />
              </button>
            </header>
            <div className="mc-modal-body my-scrollbar">
              <div className="mc-patch-grid">
                <div className="mc-patch-row">
                  <span className="mc-patch-k">守护进程</span>
                  <span className="text-my-xs text-my-primary">
                    {daemon?.running ? `在线${daemon.pid ? ` · PID ${daemon.pid}` : ''}` : (daemon?.label ?? '未启动')}
                  </span>
                  <div className="flex items-center gap-1">
                    {hasIpc && api.daemon && (
                      <>
                        <Button size="sm" variant="outline" disabled={daemonBusy} onClick={() => void handleDaemonAction(daemon?.running ? 'restart' : 'start')}>
                          {daemonBusy ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
                          {daemon?.running ? '重启' : '启动'}
                        </Button>
                        {daemon?.running && (
                          <Button size="sm" variant="ghost" disabled={daemonBusy} onClick={() => void handleDaemonAction('stop')}>
                            停止
                          </Button>
                        )}
                      </>
                    )}
                    {onOpenDaemonLogs && (
                      <Button size="sm" variant="ghost" onClick={() => { setOpsModalOpen(false); onOpenDaemonLogs() }}>
                        日志
                      </Button>
                    )}
                  </div>
                </div>
                <div className="mc-patch-row">
                  <span className="mc-patch-k">全局 Node</span>
                  <span className="truncate font-mono text-my-xs text-my-secondary">
                    {settings?.acp?.nodePath ? middleTruncatePath(settings.acp.nodePath, 38) : '自动探测系统 Node'}
                  </span>
                  <Button size="sm" variant="outline" disabled={!hasIpc || pendingAction !== null} onClick={() => void handlePickGlobalNode()}>
                    <Terminal size={12} />选择
                  </Button>
                </div>
                <div className="mc-patch-row">
                  <span className="mc-patch-k flex items-center gap-1"><Coffee size={12} />保持唤醒</span>
                  <div className="flex items-center gap-2">
                    <Switch checked={keepAwake.enabled} label="启用保持唤醒" onChange={(enabled) => setKeepAwake({ enabled })} />
                    <Select
                      className="w-40"
                      ariaLabel="保持唤醒时长"
                      disabled={!keepAwake.enabled}
                      value={keepAwake.duration}
                      onChange={(val) => setKeepAwake({ duration: val as typeof keepAwake.duration })}
                      options={KEEP_AWAKE_OPTIONS}
                    />
                  </div>
                  <span />
                </div>
                <div className="mc-patch-row">
                  <span className="mc-patch-k flex items-center gap-1"><HardDrive size={12} />自动清理</span>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="flex items-center gap-1.5 text-my-2xs text-my-secondary">
                      <span>保留(天)</span>
                      <input
                        className="mc-inline-input w-16 tabular-nums"
                        type="number"
                        min={1}
                        max={90}
                        value={cleanupPolicy.terminalRetentionDays}
                        onChange={(e) => setCleanupPolicy({ terminalRetentionDays: Math.max(1, Number(e.target.value) || 1) })}
                      />
                    </label>
                    <label className="flex items-center gap-1.5 text-my-2xs text-my-secondary">
                      <span>上限(GiB)</span>
                      <input
                        className="mc-inline-input w-16 tabular-nums"
                        type="number"
                        min={1}
                        max={500}
                        value={cleanupPolicy.maxStorageUsageGiB}
                        onChange={(e) => setCleanupPolicy({ maxStorageUsageGiB: Math.max(1, Number(e.target.value) || 1) })}
                      />
                    </label>
                  </div>
                  <span />
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <span className="my-item-title">已绑定的组织设备通道</span>
                {connections.length === 0 ? (
                  <p className="my-item-description">登录或创建团队组织后，本机将自动注册加密通道并在此显示在线状态。</p>
                ) : (
                  <div className="mc-patch-grid">
                    {connections.map((conn) => {
                      const online = conn.state === 'active' && !conn.accessLocked && conn.network !== 'offline'
                      return (
                        <div key={conn.connectionId} className="mc-patch-row">
                          <span className="flex items-center gap-1.5 text-my-xs text-my-primary truncate">
                            <Activity size={13} className={online ? 'text-my-success-text' : 'text-my-icon-tertiary'} />
                            {conn.deviceName}
                          </span>
                          <span className="truncate text-my-2xs text-my-tertiary">{conn.origin} · {online ? '在线' : conn.state}</span>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={checkingConnId === conn.connectionId}
                            onClick={() => void handleHeartbeat(conn.connectionId)}
                          >
                            {checkingConnId === conn.connectionId ? <Loader2 size={12} className="animate-spin" /> : '核对心跳'}
                          </Button>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
            <footer className="mc-modal-foot">
              <Button size="sm" variant="primary" onClick={() => setOpsModalOpen(false)}>完成</Button>
            </footer>
          </div>
        </Modal>
      )}

      {/* 新建 / 编辑自定义 Runtime 弹窗 */}
      {customModal && (
        <CustomRuntimeDialog
          existing={customModal === 'new' ? null : customModal}
          onClose={() => setCustomModal(null)}
          onSave={(data) => {
            const saved = upsertCustomRuntime(data)
            setCustomModal(null)
            setSelectedId(saved.id)
            pushToast({ kind: 'success', title: data.id ? '自定义 Runtime 已更新' : '已接入自定义 Runtime' })
          }}
        />
      )}
    </div>
  )
}

function MiniIsoMachine({ running }: { running: boolean }): JSX.Element {
  return (
    <svg width="30" height="28" viewBox="238 22 124 148" aria-hidden="true">
      <path className="mc-iso-side" d="M245 110v10q0 5 7 9l39 23q9 5 18 0l39-23q7-4 7-9v-10l-46 26q-9 5-18 0z" />
      <path className="mc-iso-top" d="m250 100 41-24q9-5 18 0l41 24q9 5 0 10l-41 24q-9 5-18 0l-41-24q-9-5 0-10z" />
      <path className="mc-iso-side" d="M245 78v11q0 5 7 9l39 23q9 5 18 0l39-23q7-4 7-9V78l-46 26q-9 5-18 0z" />
      <path className="mc-iso-top" d="m250 68 41-24q9-5 18 0l41 24q9 5 0 10l-41 24q-9 5-18 0l-41-24q-9-5 0-10z" />
      <circle cx="278" cy="101" r="3.4" fill={running ? 'var(--my-txt-success-primary)' : 'var(--my-txt-tertiary)'} />
      <circle cx="300" cy="112" r="3.6" fill="var(--my-txt-primary)" />
      <circle cx="322" cy="101" r="3.4" fill={running ? 'var(--my-txt-success-primary)' : 'var(--my-txt-tertiary)'} />
    </svg>
  )
}

const RUNTIME_CONNECT_PRESETS: ReadonlyArray<{
  id: string
  glyph: string
  name: string
  protocol: string
  base: CustomRuntimeConfig['base']
  command: string
  args: string
  models: string
  desc: string
}> = [
  { id: 'gemini', glyph: 'GM', name: 'Gemini CLI', protocol: 'ACP / CLI', base: 'acp', command: 'gemini', args: '--experimental-acp', models: 'gemini-2.5-pro\ngemini-2.5-flash', desc: 'Google 官方终端代理' },
  { id: 'opencode', glyph: 'OC', name: 'OpenCode CLI', protocol: 'ACP 协议', base: 'acp', command: 'opencode', args: 'acp', models: '', desc: '多模型开源编码代理' },
  { id: 'cursor', glyph: 'CR', name: 'Cursor CLI', protocol: '本地 CLI', base: 'custom', command: 'cursor-agent', args: '--stdio', models: '', desc: 'Cursor 命令行代理' },
  { id: 'qwen', glyph: 'QW', name: 'Qwen Code', protocol: 'ACP / CLI', base: 'acp', command: 'qwen', args: '--acp', models: 'qwen3-coder-plus', desc: '通义千问编码引擎' },
  { id: 'ollama', glyph: 'OL', name: 'Ollama 本地', protocol: '离线命令', base: 'custom', command: 'ollama', args: 'run', models: 'qwen2.5-coder:32b', desc: '内网离线大模型' },
  { id: 'blank', glyph: '+', name: '自定义命令', protocol: '完全自由', base: 'custom', command: '', args: '', models: '', desc: '接入任意本地 CLI / 脚本' }
]

function CustomRuntimeDialog({
  existing,
  onClose,
  onSave
}: {
  existing: CustomRuntimeConfig | null
  onClose: () => void
  onSave: (data: Omit<CustomRuntimeConfig, 'id' | 'archived' | 'createdAt' | 'updatedAt'> & { id?: string }) => void
}): JSX.Element {
  const [presetId, setPresetId] = useState<string>(existing ? 'blank' : '')
  const [displayName, setDisplayName] = useState(existing?.displayName ?? '')
  const [base, setBase] = useState<CustomRuntimeConfig['base']>(existing?.base ?? 'acp')
  const [command, setCommand] = useState(existing?.command ?? '')
  const [argsText, setArgsText] = useState((existing?.args ?? []).join(' '))
  const [modelsText, setModelsText] = useState((existing?.manualModels ?? []).join('\n'))
  const [description, setDescription] = useState(existing?.description ?? '')
  const [showAdvanced, setShowAdvanced] = useState(Boolean(existing?.args?.length || existing?.manualModels?.length || existing?.description))
  const [env] = useState<EnvPair[]>(existing?.env ?? [])

  const applyPreset = (preset: (typeof RUNTIME_CONNECT_PRESETS)[number]): void => {
    setPresetId(preset.id)
    if (preset.id === 'blank') {
      setDisplayName('')
      setBase('custom')
      setCommand('')
      setArgsText('')
      setModelsText('')
      setDescription('')
      return
    }
    setDisplayName(preset.name)
    setBase(preset.base)
    setCommand(preset.command)
    setArgsText(preset.args)
    setModelsText(preset.models)
    setDescription(preset.desc)
  }

  const previewLine = [command.trim() || '<executable>', argsText.trim()].filter(Boolean).join(' ')

  const submit = (): void => {
    if (!displayName.trim() || !command.trim()) return
    onSave({
      id: existing?.id,
      displayName: displayName.trim(),
      base,
      command: command.trim(),
      args: argsText.trim() ? argsText.trim().split(/\s+/) : [],
      manualModels: modelsText.split('\n').map((s) => s.trim()).filter(Boolean),
      description: description.trim(),
      env
    })
  }

  return (
    <Modal open placement="center" onClose={onClose} width={560} ariaLabel={existing ? '编辑自定义 Runtime' : '接入新 Runtime'}>
      <div className="mc-modal-shell">
        <header className="mc-modal-head">
          <div>
            <h2 className="text-my-md font-medium text-my-primary">{existing ? '编辑自定义 Runtime' : '接入新 Runtime'}</h2>
            <p className="mt-0.5 text-my-2xs text-my-tertiary">点选常见生态模板一键预填，或直接指定本机 CLI 可执行文件</p>
          </div>
          <button type="button" className="my-icon-control" aria-label="关闭" onClick={onClose}><X size={15} /></button>
        </header>
        <div className="mc-modal-body my-scrollbar">
          {!existing && (
            <div className="mc-preset-grid" role="listbox" aria-label="快速生态模板">
              {RUNTIME_CONNECT_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  role="option"
                  aria-selected={presetId === preset.id}
                  className="mc-preset-card"
                  onClick={() => applyPreset(preset)}
                >
                  <span className="mc-preset-glyph">{preset.glyph}</span>
                  <span className="mc-preset-meta">
                    <span className="mc-preset-name">{preset.name}</span>
                    <span className="mc-preset-proto">{preset.protocol}</span>
                  </span>
                </button>
              ))}
            </div>
          )}

          {/* 实况命令预览带，与主工作台管线一脉相承 */}
          <div className="mc-preset-preview">
            <span className={`mc-cmd-led${command.trim() ? '' : ' is-warn'}`} aria-hidden="true" />
            <span className="mc-pipe-k">PREVIEW</span>
            <code className="truncate font-mono text-my-xs text-my-primary">{previewLine}</code>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-my-xs text-my-secondary">
              <span>引擎名称</span>
              <input className="my-input" autoFocus value={displayName} placeholder="如：Gemini CLI / 内部研发引擎" onChange={(e) => setDisplayName(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-my-xs text-my-secondary">
              <span>协议底座</span>
              <Select
                className="w-full"
                ariaLabel="协议底座"
                value={base}
                onChange={(val) => setBase(val as CustomRuntimeConfig['base'])}
                options={[
                  { value: 'acp', label: '标准 ACP 协议' },
                  { value: 'codex', label: 'Codex 兼容' },
                  { value: 'claude-code', label: 'Claude Code 兼容' },
                  { value: 'custom', label: '自定义命令' }
                ]}
              />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-my-xs text-my-secondary">
            <span>启动命令或可执行路径</span>
            <input className="my-input font-mono text-my-xs" value={command} placeholder="例如：gemini、opencode 或 C:\tools\agent.exe" onChange={(e) => setCommand(e.target.value)} />
          </label>

          <div className="flex flex-col gap-2">
            <button
              type="button"
              className="mc-adv-toggle"
              aria-expanded={showAdvanced}
              onClick={() => setShowAdvanced((v) => !v)}
            >
              <ChevronRight size={12} className={`mc-adv-chevron${showAdvanced ? ' is-open' : ''}`} aria-hidden="true" />
              <span>高级启动参数、预声明模型与说明（选填）</span>
            </button>
            {showAdvanced && (
              <div className="flex flex-col gap-3 pt-1">
                <label className="flex flex-col gap-1 text-my-xs text-my-secondary">
                  <span>附加启动参数（空格分隔）</span>
                  <input className="my-input font-mono text-my-xs" value={argsText} placeholder="例如：--stdio --sandbox" onChange={(e) => setArgsText(e.target.value)} />
                </label>
                <label className="flex flex-col gap-1 text-my-xs text-my-secondary">
                  <span>预声明模型 ID（每行一个）</span>
                  <textarea className="my-input font-mono text-my-xs min-h-16 py-2" value={modelsText} placeholder="gemini-2.5-pro" onChange={(e) => setModelsText(e.target.value)} />
                </label>
                <label className="flex flex-col gap-1 text-my-xs text-my-secondary">
                  <span>备注说明</span>
                  <input className="my-input" value={description} placeholder="简述用途或权限边界" onChange={(e) => setDescription(e.target.value)} />
                </label>
              </div>
            )}
          </div>
        </div>
        <footer className="mc-modal-foot">
          <Button size="sm" variant="ghost" onClick={onClose}>取消</Button>
          <Button size="sm" variant="primary" disabled={!displayName.trim() || !command.trim()} onClick={submit}>
            {existing ? '保存修改' : '接入到工作台'}
          </Button>
        </footer>
      </div>
    </Modal>
  )
}
