import { useEffect, useRef, useState, type JSX } from 'react'
import { AlertCircle, CheckCircle2, Download, FolderOpen, Loader2, RefreshCw } from 'lucide-react'
import type { AcpAgentStatus, AcpConnectionProbeResult } from '../../../shared/types'
import { api, hasIpc } from '../api'
import { ToolBrandIcon } from '../components/ToolBrandIcon'
import { Button } from '../my/ui'

export interface AgentDiscoveryStepProps {
  onInventory?: (summary: { detected: number; total: number }) => void
  onBusyChange?: (busy: boolean) => void
}

type Action = 'refresh' | 'node' | 'setup' | 'path' | 'test'
type Feedback = { id: string; message: string; error: boolean }

function agentState(agent: AcpAgentStatus): { label: string; detail: string; tone: string } {
  if (!agent.enabled) return { label: '未启用', detail: '可稍后管理此 Agent。', tone: 'text-my-secondary' }
  if (agent.health === 'auth_required') return { label: '需登录', detail: '请在本机完成该 Agent 的登录，然后重新检查连接。', tone: 'text-my-warning-text' }
  if (agent.health === 'launch_error' || agent.health === 'incompatible' || agent.health === 'directory_unavailable') {
    return { label: '检查失败', detail: '查看检测记录，处理后重新检查。', tone: 'text-my-danger-text' }
  }
  if (!agent.available || agent.setupRequired) return { label: '未就绪', detail: '本机环境尚未就绪。', tone: 'text-my-secondary' }
  if (agent.launchKind === 'sdk') return { label: '不适用', detail: 'Pi 使用原生 SDK，不在 ACP v2 provider 矩阵内。', tone: 'text-my-tertiary' }
  if (agent.health === 'ready') return { label: '握手可用', detail: '登录状态和模型请求尚未验证。', tone: 'text-my-success-text' }
  if (agent.launchKind === 'custom' && !agent.executable) return { label: '已配置', detail: '程序与登录状态尚未验证。', tone: 'text-my-secondary' }
  if (agent.launchKind === 'managed') return { label: '适配器已安装', detail: 'Agent 和登录状态尚未验证。', tone: 'text-my-secondary' }
  return { label: '已检测到', detail: '连接和登录状态尚未验证。', tone: 'text-my-secondary' }
}

/** Navigation remains owned by the wizard; this step never opens settings. */
export function AgentDiscoveryStep({ onInventory, onBusyChange }: AgentDiscoveryStepProps): JSX.Element {
  const [agents, setAgents] = useState<AcpAgentStatus[] | null>(null)
  const [pending, setPending] = useState<string | null>('inventory')
  const [error, setError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const generation = useRef(0)
  const busy = useRef(false)
  const reportedBusy = useRef(false)
  const busyCallback = useRef(onBusyChange)
  busyCallback.current = onBusyChange

  useEffect(() => { onBusyChange?.(reportedBusy.current) }, [onBusyChange])

  useEffect(() => {
    if (agents) onInventory?.({ detected: agents.filter((agent) => agent.enabled && agent.available && !agent.setupRequired).length, total: agents.length })
  }, [agents, onInventory])

  useEffect(() => {
    const request = ++generation.current
    busy.current = true
    setPending('inventory')
    if (!hasIpc || typeof api.acpAgents !== 'function') {
      setError('本机检测服务不可用，请在桌面应用中重试。')
      setPending(null)
      busy.current = false
      return () => { generation.current++; busy.current = false; reportedBusy.current = false; busyCallback.current?.(false) }
    }
    void Promise.resolve().then(() => api.acpAgents()).then(result => {
      if (request !== generation.current) return
      if (!result.ok || !result.agents) setError(result.error ?? '无法获取本机 Agent，请重试。')
      else { setAgents(result.agents); setError(null) }
    }).catch((reason: unknown) => {
      if (request === generation.current) setError(reason instanceof Error ? reason.message : '无法获取本机 Agent，请重试。')
    }).finally(() => {
      if (request === generation.current) { busy.current = false; setPending(null) }
    })
    return () => { generation.current++; busy.current = false; reportedBusy.current = false; busyCallback.current?.(false) }
  }, [])

  async function run(action: Action, agent?: AcpAgentStatus): Promise<void> {
    if (busy.current || !hasIpc) return
    const id = agent ? agent.runtimeId ?? agent.id : ''
    const request = ++generation.current
    busy.current = true
    reportedBusy.current = true
    busyCallback.current?.(true)
    setPending(action === 'refresh' || action === 'node' ? action : `${action}:${id}`)
    setError(null)
    setFeedback(null)
    try {
      let result: { ok: boolean; error?: string; agents?: AcpAgentStatus[]; cancelled?: boolean; probe?: AcpConnectionProbeResult }
      if (action === 'setup') result = await api.acpRuntimeSetup(id)
      else if (action === 'path') result = await api.acpRuntimePathPick(id)
      else if (action === 'node') result = await api.acpRuntimeNodePick()
      else if (action === 'test') result = await api.acpRuntimeTestConnection(id)
      else result = await api.acpRuntimeRefresh()
      if (request !== generation.current) return
      if (result.cancelled) {
        setFeedback({ id, message: '已取消选择，原有配置未改变。', error: false })
        return
      }
      if (result.agents) setAgents(result.agents)
      if (!result.ok) {
        const message = result.error ?? '操作失败，请重试。'
        if (id) setFeedback({ id, message, error: true }); else setError(message)
        return
      }
      if (!result.agents) {
        const discovered = await api.acpAgents()
        if (request !== generation.current) return
        if (!discovered.ok || !discovered.agents) {
          const message = `操作已结束，但状态刷新失败：${discovered.error ?? '请重新检测。'}`
          if (id) setFeedback({ id, message, error: true }); else setError(message)
          return
        }
        result.agents = discovered.agents
        setAgents(discovered.agents)
      }
      if (action === 'test') {
        if (!result.probe || !result.agents.some(item => (item.runtimeId ?? item.id) === id)) {
          setFeedback({ id, message: '未取得完整检查结果，请重新检测。', error: true })
        } else if (!result.probe.ok) {
          const needsLogin = result.agents.some(item => (item.runtimeId ?? item.id) === id && item.health === 'auth_required')
          setFeedback({ id, message: needsLogin ? '请在本机完成该 Agent 的登录，然后重新检查连接。' : result.probe.error ?? '连接检查失败，请重试。', error: !needsLogin })
        } else {
          setFeedback({ id, message: result.probe.authMethodIds?.length ? '握手成功；Agent 提供认证方式，登录状态仍需在实际使用时确认。' : '握手成功；登录状态和模型请求尚未验证。', error: false })
        }
      } else if (action !== 'refresh') {
        setFeedback({ id, message: action === 'setup' ? '安装操作已完成，请检查连接。' : '路径已保存，状态已更新。', error: false })
      }
    } catch (reason) {
      if (request !== generation.current) return
      const message = reason instanceof Error ? reason.message : '操作失败，请重试。'
      if (id) setFeedback({ id, message, error: true }); else setError(message)
    } finally {
      if (request === generation.current) { busy.current = false; reportedBusy.current = false; busyCallback.current?.(false); setPending(null) }
    }
  }

  return <section aria-label="本机 Agent 检测" className="w-full min-w-0">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-my-sm font-semibold text-my-primary">本机 Agent</h2>
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" size="sm" disabled={pending !== null || !hasIpc || typeof api.acpRuntimeNodePick !== 'function'} onClick={() => void run('node')}><FolderOpen size={14} aria-hidden="true" />选择 Node</Button>
        <Button variant="ghost" size="sm" disabled={pending !== null || !hasIpc || typeof api.acpRuntimeRefresh !== 'function'} onClick={() => void run('refresh')}><RefreshCw size={14} aria-hidden="true" />重新检测</Button>
      </div>
    </div>
    {feedback?.id === '' && <p role="status" className="mt-2 text-my-xs text-my-secondary">{feedback.message}</p>}
    <div className="mt-2 rounded-my-lg border border-my-line bg-my-layer-2">
      {(pending === 'inventory' || pending === 'refresh' || pending === 'node') && <p role="status" className="flex items-center gap-2 px-3 py-3 text-my-sm text-my-secondary"><Loader2 size={16} className="motion-safe:animate-spin" aria-hidden="true" />{pending === 'node' ? '等待选择 Node…' : '正在检查本机环境…'}</p>}
      {error && <p role="alert" className="flex items-start gap-2 break-words px-3 py-3 text-my-sm text-my-danger-text"><AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />{error}</p>}
      {agents && agents.length === 0 && pending === null && <p className="px-3 py-3 text-my-sm text-my-secondary">没有可显示的 Agent，可稍后添加。</p>}
      {agents?.map(agent => {
        const id = agent.runtimeId ?? agent.id
        const state = agentState(agent)
        const rowFeedback = feedback?.id === id ? feedback : null
        const native = agent.launchKind === 'native'
        const bundled = agent.launchKind === 'bundled'
        const canInstall = (native || agent.launchKind === 'managed' && (id === 'codex' || id === 'claude')) && (agent.setupRequired || native && !agent.available) && !agent.setupBlockedReason && agent.updateStatus !== 'ahead'
        const canPath = native || bundled && id === 'zcode'
        const canTest = agent.enabled && agent.available && !agent.setupRequired && agent.launchKind !== 'sdk'
        const rowPending = pending?.endsWith(`:${id}`) ? pending.split(':')[0] : null
        return <div key={id} className="border-t border-my-line px-3 py-3 first:border-t-0">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-my-md bg-my-layer-3"><ToolBrandIcon brand={agent.id} size={22} /></span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="my-item-title break-words">{agent.name}</span><span className={`text-my-xs ${rowFeedback?.error ? 'text-my-danger-text' : state.tone}`}>{rowPending ? '处理中' : rowFeedback?.error ? '操作失败' : state.label}</span></div>
              <p className={`my-item-description mt-1 break-words${state.tone === 'text-my-warning-text' || state.tone === 'text-my-danger-text' ? ' text-my-secondary' : ''}`}>{rowPending ? rowPending === 'setup' ? '正在安装，请等待结果…' : rowPending === 'path' ? '等待选择路径…' : '正在检查连接…' : state.detail}</p>
            </div>
            <div className="flex flex-wrap gap-2" role="group" aria-label={`${agent.name}操作`}>
              {canInstall && <Button variant="outline" size="sm" disabled={pending !== null || !hasIpc || typeof api.acpRuntimeSetup !== 'function'} onClick={() => void run('setup', agent)} aria-label={`安装 ${agent.name}`}>{rowPending === 'setup' ? <Loader2 size={14} className="motion-safe:animate-spin" /> : <Download size={14} />}安装</Button>}
              {canPath && <Button variant="outline" size="sm" disabled={pending !== null || !hasIpc || typeof api.acpRuntimePathPick !== 'function'} onClick={() => void run('path', agent)} aria-label={`${agent.name} ${bundled ? '选择目录' : '选择路径'}`}><FolderOpen size={14} />{bundled ? '选择目录' : '选择路径'}</Button>}
              {canTest && <Button variant="outline" size="sm" disabled={pending !== null || !hasIpc || typeof api.acpRuntimeTestConnection !== 'function'} onClick={() => void run('test', agent)} aria-label={`检查 ${agent.name} 连接`}>{rowPending === 'test' ? <Loader2 size={14} className="motion-safe:animate-spin" /> : <CheckCircle2 size={14} />}检查连接</Button>}
            </div>
          </div>
          {rowFeedback && <p role={rowFeedback.error ? 'alert' : 'status'} className={`mt-2 break-words text-my-xs ${rowFeedback.error ? 'text-my-danger-text' : 'text-my-secondary'}`}>{rowFeedback.message}</p>}
          {agent.setupBlockedReason && <p className="mt-2 break-words text-my-xs text-my-secondary">{agent.setupBlockedReason}</p>}
          {(agent.diagnostics?.length ?? 0) > 0 && <details className="mt-2 text-my-xs text-my-secondary"><summary>检测记录</summary><ul className="mt-1 break-words">{agent.diagnostics?.map((message, index) => <li key={index}>{message}</li>)}</ul></details>}
        </div>
      })}
    </div>
    <p className="mt-3 text-my-xs leading-relaxed text-my-secondary">安装需要 Node 和网络；原生 Agent 安装会修改本机全局 npm 环境。检查连接会启动对应 Agent。</p>
    <p className="mt-1 text-my-xs leading-relaxed text-my-secondary">登录由各 Agent 自行处理，请在本机完成登录后返回此处检查。自定义 Agent 和启用状态可稍后管理。</p>
  </section>
}
