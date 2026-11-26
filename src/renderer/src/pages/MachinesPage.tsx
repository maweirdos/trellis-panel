import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { Activity, ArrowUpRight, CheckCircle2, Cpu, Globe, HardDrive, Loader2, Plug, RefreshCw, Server, Shield } from 'lucide-react'
import type { CruxRuntimeKind, CruxWorkingDirectoryMode } from '@shared/crux'
import type { DesktopTeamConnection } from '@shared/team-desktop'
import type { AcpAgentStatus } from '../../../shared/types'
import { api, hasIpc } from '../api'
import { RuntimePanel, runtimeHealthLabel } from '../acp/RuntimePanel'
import { getRuntimeInventorySnapshot } from '../acp/useRuntimeInventoryRefresh'
import { Select } from '../components/Select'
import {
  APPROVAL_OPTIONS_BY_RUNTIME,
  MACHINE_VISIBILITY_OPTIONS,
  matchDetectedRuntime,
  MODEL_PRESET_OPTIONS,
  RUNTIME_KIND_OPTIONS,
  useLocalExecutionSlot,
  WORKDIR_MODE_OPTIONS,
  type LocalApprovalPolicy,
  type MachineVisibilityScope
} from '../crux/local-execution-slot'
import { useCrux } from '../crux/store'
import { Button, EmptyState } from '../my/ui'
import { useMy } from '../my/store'
import { useApp } from '../store'
import './machines.css'

interface DaemonSummary {
  running: boolean
  pid?: number
  label: string
}

function isSupportedRuntime(agent: AcpAgentStatus): boolean {
  return agent.launchKind !== 'custom' && agent.id !== 'opencode'
}

export function MachinesPage(): JSX.Element {
  const setPage = useApp((state) => state.setPage)
  const pushToast = useApp((state) => state.pushToast)
  const snapshot = useCrux((state) => state.snapshot)
  const workspaceContext = useCrux((state) => state.workspaceContext)
  const {
    defaultSlot,
    machineVisibility,
    allowedSpaceIds,
    conflictNotice,
    setDefaultSlot,
    setMachineVisibility,
    clearConflictNotice
  } = useLocalExecutionSlot()

  const [agents, setAgents] = useState<AcpAgentStatus[]>(getRuntimeInventorySnapshot)
  const [daemon, setDaemon] = useState<DaemonSummary | null>(null)
  const [daemonBusy, setDaemonBusy] = useState(false)
  const [connections, setConnections] = useState<DesktopTeamConnection[]>([])
  const [checkingConnId, setCheckingConnId] = useState<string | null>(null)
  const liveRef = useRef(true)

  useEffect(() => {
    liveRef.current = true
    return () => { liveRef.current = false }
  }, [])

  const loadInfrastructure = useCallback(async (): Promise<void> => {
    if (!hasIpc) return
    try {
      const daemonReply = await api.daemon?.status?.()
      if (liveRef.current && daemonReply && typeof daemonReply === 'object' && 'ok' in daemonReply && daemonReply.ok && 'data' in daemonReply && daemonReply.data) {
        const info = daemonReply.data as { running?: boolean; pid?: number | null; state?: string }
        const running = info.running === true || info.state === 'running'
        setDaemon({
          running,
          pid: typeof info.pid === 'number' ? info.pid : undefined,
          label: running ? '运行中' : '未启动'
        })
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
      // 未绑定团队服务时静默保留空列表
    }
  }, [])

  useEffect(() => {
    void loadInfrastructure()
    if (!hasIpc || !api.teamDesktop?.onChanged) return
    return api.teamDesktop.onChanged(() => { void loadInfrastructure() })
  }, [loadInfrastructure])

  const handleDaemonAction = async (action: 'start' | 'restart'): Promise<void> => {
    if (!hasIpc || !api.daemon || daemonBusy) return
    setDaemonBusy(true)
    try {
      const reply = action === 'start' ? await api.daemon.start() : await api.daemon.restart()
      if (reply && typeof reply === 'object' && 'ok' in reply && !reply.ok) {
        pushToast({ kind: 'error', title: '后台服务操作失败', body: String((reply as { error?: string }).error ?? '请前往后台服务设置查看详情') })
      } else {
        pushToast({ kind: 'success', title: action === 'start' ? '后台服务已启动' : '后台服务已重启' })
      }
      await loadInfrastructure()
    } catch (error) {
      pushToast({ kind: 'error', title: '后台服务操作失败', body: error instanceof Error ? error.message : String(error) })
    } finally {
      if (liveRef.current) setDaemonBusy(false)
    }
  }

  const handleHeartbeat = async (connectionId: string): Promise<void> => {
    if (!hasIpc || !api.teamDesktop || checkingConnId) return
    setCheckingConnId(connectionId)
    try {
      const reply = await api.teamDesktop.heartbeat(connectionId)
      if (!reply.ok) pushToast({ kind: 'error', title: '设备心跳核对失败', body: reply.error })
      else pushToast({ kind: 'success', title: '设备在线状态已核对' })
      await loadInfrastructure()
    } finally {
      if (liveRef.current) setCheckingConnId(null)
    }
  }

  const supportedAgents = agents.filter(isSupportedRuntime)
  const readyAgents = supportedAgents.filter((agent) => agent.available && !agent.setupRequired)
  const activeConnections = connections.filter((item) => item.state === 'active' && !item.accessLocked)
  const availableSpaces = snapshot?.spaces.filter((space) => !space.archived) ?? []

  const runtimeOptions = RUNTIME_KIND_OPTIONS.map((option) => {
    const matched = matchDetectedRuntime(supportedAgents, option.value)
    const statusText = matched ? runtimeHealthLabel(matched) : '未探测'
    return { value: option.value, label: `${option.label} · ${statusText}` }
  })

  const toggleAllowedSpace = (spaceId: string): void => {
    const next = allowedSpaceIds.includes(spaceId)
      ? allowedSpaceIds.filter((id) => id !== spaceId)
      : [...allowedSpaceIds, spaceId]
    setMachineVisibility('spaces', next)
  }

  return (
    <div className="machines-page">
      <header className="machines-header">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Cpu size={18} className="text-my-primary" aria-hidden="true" />
            <h1>机器与 Runtime 中心</h1>
          </div>
          <p>统一管理当前电脑的后台守护进程、本地 CLI 执行引擎（Codex / Claude Code / Pi）、默认执行槽与算力可见范围。</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setPage('models')}>
            模型供应商<ArrowUpRight size={13} />
          </Button>
          <Button size="sm" variant="outline" onClick={() => setPage('gateway')}>
            <Plug size={13} />MCP 服务
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void loadInfrastructure()}>
            <RefreshCw size={13} />刷新状态
          </Button>
        </div>
      </header>

      <section className="machines-summary-grid" aria-label="本机算力总览">
        <article className="machines-stat-card">
          <div className="machines-stat-top">
            <span className="machines-stat-label"><Server size={14} aria-hidden="true" />本机后台服务</span>
            <span className={`machines-pill ${daemon?.running ? 'is-ready' : 'is-warn'}`}>
              {daemon?.label ?? (hasIpc ? '读取中…' : '浏览器预览')}
            </span>
          </div>
          <strong className="machines-stat-value">{daemon?.running ? '本地服务在线' : '按需待机'}</strong>
          <div className="machines-stat-foot">
            <span>{daemon?.pid ? `PID ${daemon.pid}` : '常驻进程负责会话与任务队列'}</span>
            {hasIpc && (
              <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" disabled={daemonBusy} onClick={() => void handleDaemonAction(daemon?.running ? 'restart' : 'start')}>
                  {daemonBusy && <Loader2 size={12} className="animate-spin" />}
                  {daemon?.running ? '重启' : '启动'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { useMy.getState().setSettingsView('daemon'); setPage('settings') }}>
                  日志
                </Button>
              </div>
            )}
          </div>
        </article>

        <article className="machines-stat-card">
          <div className="machines-stat-top">
            <span className="machines-stat-label"><HardDrive size={14} aria-hidden="true" />已就绪 Runtime</span>
            <span className={`machines-pill ${readyAgents.length > 0 ? 'is-ready' : 'is-warn'}`}>
              {readyAgents.length > 0 ? '可执行' : '待配置'}
            </span>
          </div>
          <strong className="machines-stat-value">
            {readyAgents.length} <small>/ {Math.max(supportedAgents.length, 1)}</small>
          </strong>
          <div className="machines-stat-foot">
            <span className="truncate">
              {readyAgents.length > 0
                ? readyAgents.map((item) => item.name).join(' · ')
                : '在下方探测或安装本机 Codex / Claude Code / Pi'}
            </span>
          </div>
        </article>

        <article className="machines-stat-card">
          <div className="machines-stat-top">
            <span className="machines-stat-label"><Globe size={14} aria-hidden="true" />团队组织绑定</span>
            <span className={`machines-pill ${activeConnections.length > 0 ? 'is-ready' : ''}`}>
              {workspaceContext.state === 'connected' ? '已同步' : workspaceContext.state === 'local' ? '本机模式' : '未连接'}
            </span>
          </div>
          <strong className="machines-stat-value">
            {activeConnections.length} <small>个已授权组织</small>
          </strong>
          <div className="machines-stat-foot">
            <span className="truncate">
              {workspaceContext.projectName ? `当前：${workspaceContext.projectName}` : '登录组织后自动完成本机注册'}
            </span>
          </div>
        </article>
      </section>

      <section className="machines-panel" aria-label="本机执行槽与算力可见范围">
        <header className="machines-panel-header">
          <div>
            <h2>本机默认执行槽与算力可见范围</h2>
            <p>控制本机作为执行节点时的默认引擎、模型与审批策略，以及哪些空间可以调度这台电脑。</p>
          </div>
        </header>
        <div className="machines-slot-grid">
          <label className="machines-field">
            <span>默认 Runtime 引擎</span>
            <Select
              className="w-full"
              value={defaultSlot.runtimeKind}
              onChange={(value) => setDefaultSlot({ runtimeKind: value as CruxRuntimeKind })}
              options={runtimeOptions}
            />
          </label>
          <label className="machines-field">
            <span>默认模型</span>
            <Select
              className="w-full"
              value={defaultSlot.model}
              onChange={(value) => setDefaultSlot({ model: value })}
              options={[...MODEL_PRESET_OPTIONS]}
            />
          </label>
          <label className="machines-field">
            <span>默认审批策略</span>
            <Select
              className="w-full"
              value={defaultSlot.approvalPolicy}
              onChange={(value) => setDefaultSlot({ approvalPolicy: value as LocalApprovalPolicy })}
              options={[...APPROVAL_OPTIONS_BY_RUNTIME[defaultSlot.runtimeKind]]}
            />
          </label>
          <label className="machines-field">
            <span>默认工作目录</span>
            <Select
              className="w-full"
              value={defaultSlot.workingDirectory}
              onChange={(value) => setDefaultSlot({ workingDirectory: value as CruxWorkingDirectoryMode })}
              options={[...WORKDIR_MODE_OPTIONS]}
            />
          </label>
        </div>

        {conflictNotice && (
          <div role="status" className="machines-notice">
            <span>{conflictNotice}</span>
            <Button size="sm" variant="ghost" onClick={clearConflictNotice}>知道了</Button>
          </div>
        )}

        <div className="machines-visibility-block">
          <div className="flex items-center gap-2 text-my-xs font-medium text-my-primary">
            <Shield size={14} aria-hidden="true" />
            <span>算力可见范围（谁可以调度这台电脑）</span>
          </div>
          <div className="machines-visibility-grid" role="radiogroup" aria-label="算力可见范围">
            {MACHINE_VISIBILITY_OPTIONS.map((item) => {
              const selected = machineVisibility === item.value
              return (
                <button
                  key={item.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className="machines-visibility-card"
                  data-selected={selected || undefined}
                  onClick={() => setMachineVisibility(item.value as MachineVisibilityScope)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <strong>{item.label}</strong>
                    {selected && <CheckCircle2 size={14} className="text-my-primary" aria-hidden="true" />}
                  </div>
                  <span>{item.description}</span>
                </button>
              )
            })}
          </div>
          {machineVisibility === 'spaces' && (
            <div className="machines-space-picker">
              <span className="text-my-xs text-my-secondary">允许调用的空间：</span>
              {availableSpaces.length === 0 ? (
                <span className="text-my-xs text-my-tertiary">当前尚未加入团队空间</span>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {availableSpaces.map((space) => {
                    const checked = allowedSpaceIds.includes(space.id)
                    return (
                      <label key={space.id} className="machines-space-chip">
                        <input type="checkbox" checked={checked} onChange={() => toggleAllowedSpace(space.id)} />
                        <span>{space.name}</span>
                        <code className="text-my-2xs text-my-tertiary">{space.key}</code>
                      </label>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      <section className="machines-panel" aria-label="本机已探测 Runtime 引擎">
        <RuntimePanel
          agents={agents}
          onChange={setAgents}
          isCurrent={() => liveRef.current}
          autoRefresh
          onConfigureModels={() => setPage('models')}
          onManageAgents={() => { useCrux.getState().setModule('all-agents'); setPage('crux') }}
        />
      </section>

      <section className="machines-panel" aria-label="已绑定的组织设备通道">
        <header className="machines-panel-header">
          <div>
            <h2>已绑定的组织设备通道</h2>
            <p>本机登录团队组织后自动注册的加密设备通道，用于实时拉取空间任务与同步执行回执。</p>
          </div>
        </header>
        {connections.length === 0 ? (
          <EmptyState title="尚未绑定团队组织" description="登录或创建组织后，这台电脑会自动完成安全绑定并在此显示在线状态。" />
        ) : (
          <ul className="machines-connection-list">
            {connections.map((item) => {
              const online = item.state === 'active' && !item.accessLocked && item.network !== 'offline'
              const lastSeen = item.remoteDevice?.lastSeenAt ?? item.lastCheckedAt
              return (
                <li key={item.connectionId} className="machines-connection-row">
                  <Activity size={16} className={online ? 'text-my-success-text' : 'text-my-icon-tertiary'} aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <div className="my-item-title truncate">{item.deviceName}</div>
                    <div className="my-item-description truncate">
                      {item.origin} · {online ? '通道在线' : item.accessLocked ? '访问已锁定' : item.network === 'offline' ? '离线缓存' : item.state}
                      {lastSeen ? ` · 最近核对 ${new Date(lastSeen).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : ''}
                    </div>
                  </div>
                  {item.state === 'active' && !item.accessLocked && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={checkingConnId === item.connectionId}
                      onClick={() => void handleHeartbeat(item.connectionId)}
                    >
                      {checkingConnId === item.connectionId ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                      心跳核对
                    </Button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
