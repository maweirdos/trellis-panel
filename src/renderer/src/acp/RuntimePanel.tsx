import { useRef, useState, type JSX } from 'react'
import { CheckCircle2, Download, FolderOpen, Loader2, Monitor, RefreshCw } from 'lucide-react'
import { api, hasIpc } from '../api'
import { Button } from '../my/ui'
import type { AcpAgentStatus, AcpRuntimeHealth } from '../../../shared/types'

const HEALTH_LABEL: Record<AcpRuntimeHealth, string> = {
  not_checked: '尚未检测', executable_missing: '缺少运行程序', adapter_missing: '待安装适配器',
  launch_error: '启动失败', incompatible: '协议不兼容', auth_required: '需要登录',
  directory_unavailable: '目录不可用', ready: '启动条件满足'
}

export function runtimeHealthLabel(agent: AcpAgentStatus | undefined): string {
  if (!agent) return 'Runtime 未配置'
  if (!agent.enabled) return '未启用'
  return agent.health ? HEALTH_LABEL[agent.health] : agent.available ? '已探测到程序' : '未探测到程序'
}

/** Shared between the page-owned Agent settings and application runtime settings. */
export function RuntimePanel({ agents, onChange, isCurrent }: {
  agents: AcpAgentStatus[]
  onChange: (agents: AcpAgentStatus[]) => void
  isCurrent: () => boolean
}): JSX.Element {
  const [pending, setPending] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null)
  const pendingRef = useRef(false)
  const run = async (action: string, runtimeId?: string): Promise<void> => {
    if (!hasIpc || !isCurrent() || pendingRef.current) return
    pendingRef.current = true
    setPending(action === 'setup' ? runtimeId ?? 'setup' : action)
    setFeedback(null)
    try {
      const res = action === 'setup' && runtimeId ? await api.acpRuntimeSetup(runtimeId)
        : action === 'node' ? await api.acpRuntimeNodePick() : await api.acpRuntimeRefresh()
      if (!isCurrent()) return
      if (res.agents) onChange(res.agents)
      if ('cancelled' in res && res.cancelled) return
      setFeedback({ error: !res.ok, text: res.ok ? action === 'setup' ? '适配器安装完成。选择 Agent 后可显式开始会话。' : action === 'node' ? 'Node 路径已验证并保存。' : '已重新探测启动条件；登录与协议以实际会话结果为准。' : res.error ?? '操作失败，请重试。' })
    } catch (error) {
      if (isCurrent()) setFeedback({ error: true, text: error instanceof Error ? error.message : 'Runtime 操作失败' })
    } finally {
      pendingRef.current = false
      if (isCurrent()) setPending(null)
    }
  }
  return (
    <section className="space-y-3" aria-label="本机 Runtime 设置">
      <div className="flex flex-wrap items-center gap-2">
        <Monitor size={14} className="text-my-secondary" />
        <span className="text-my-xs font-medium text-my-primary">本机 Runtime</span>
        <div className="flex-1" />
        <Button size="sm" variant="outline" disabled={pending !== null || !hasIpc} onClick={() => void run('refresh')}>
          {pending === 'refresh' ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} 重新探测
        </Button>
        <Button size="sm" variant="outline" disabled={pending !== null || !hasIpc} onClick={() => void run('node')}>
          <FolderOpen size={12} /> 选择 Node
        </Button>
      </div>
      <p className="text-my-2xs leading-relaxed text-my-tertiary">需要外部 Node ≥22.13。仅“安装适配器”会下载固定版本；探测和开始会话不会安装。沿用本机 CLI 的登录配置。</p>
      {feedback && <p role={feedback.error ? 'alert' : 'status'} className={feedback.error ? 'text-my-xs text-my-danger-text' : 'text-my-xs text-my-success-text'}>{feedback.text}</p>}
      {agents.length === 0 && <p className="text-my-xs text-my-tertiary">暂未取得 Runtime 列表。可重新探测。</p>}
      {agents.map((agent) => (
        <div key={agent.id} className="rounded-my-md border border-my-line p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-my-xs font-medium text-my-primary">{agent.name}</span>
            <span className={agent.available && agent.enabled ? 'text-my-2xs text-my-success-text' : 'text-my-2xs text-my-warning-text'}>{runtimeHealthLabel(agent)}</span>
            {agent.adapterVersion && <span className="text-my-2xs text-my-tertiary">v{agent.adapterVersion}</span>}
            <div className="flex-1" />
            {agent.setupRequired && <Button size="sm" variant="primary" disabled={pending !== null || !hasIpc} onClick={() => void run('setup', agent.runtimeId ?? agent.id)}>
              {pending === (agent.runtimeId ?? agent.id) ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />} 安装适配器
            </Button>}
            {agent.available && !agent.setupRequired && <CheckCircle2 size={13} className="text-my-success-text" />}
          </div>
          <dl className="mt-2 space-y-1 break-all text-my-2xs text-my-tertiary">
            <div><dt className="inline text-my-secondary">Node：</dt><dd className="inline">{agent.nodePath ?? '未确认（自定义命令自行管理）'}</dd></div>
            <div><dt className="inline text-my-secondary">启动：</dt><dd className="inline font-mono">{agent.executable ? [agent.executable, ...(agent.args ?? [])].join(' ') : agent.command || '待配置'}</dd></div>
          </dl>
          {(agent.diagnostics ?? []).map((message, index) => <p key={index} className="mt-1 break-words text-my-2xs text-my-secondary">{message}</p>)}
          {agent.checkedAt && <p className="mt-2 text-my-2xs text-my-tertiary">检测于 {new Date(agent.checkedAt).toLocaleTimeString()}</p>}
        </div>
      ))}
    </section>
  )
}
