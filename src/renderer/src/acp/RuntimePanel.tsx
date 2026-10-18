import { useRef, useState, type JSX } from 'react'
import { CheckCircle2, Download, FolderOpen, Loader2, Monitor, RefreshCw } from 'lucide-react'
import { api, hasIpc } from '../api'
import { Button } from '../my/ui'
import type { AcpAgentStatus, AcpRuntimeHealth } from '../../../shared/types'

const HEALTH_LABEL: Record<AcpRuntimeHealth, string> = {
  not_checked: '等待连接验证', executable_missing: '本机环境未就绪', adapter_missing: '尚未安装',
  launch_error: '启动失败', incompatible: '协议不兼容', auth_required: '需要登录',
  directory_unavailable: '目录不可用', ready: '启动条件满足'
}

export function runtimeHealthLabel(agent: AcpAgentStatus | undefined): string {
  if (!agent) return '执行引擎未配置'
  if (!agent.enabled) return '未启用'
  if (agent.available && !agent.setupRequired && agent.health === 'not_checked') return agent.adapterVersion ? '已安装，等待连接' : '环境就绪，等待连接'
  return agent.health ? HEALTH_LABEL[agent.health] : agent.available ? '已探测到程序' : '未探测到程序'
}

/** Shared between the page-owned Agent settings and application runtime settings. */
export function RuntimePanel({ agents, onChange, isCurrent, runtimeId, heading = true }: {
  agents: AcpAgentStatus[]
  onChange: (agents: AcpAgentStatus[]) => void
  isCurrent: () => boolean
  runtimeId?: string
  heading?: boolean
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
      if (res.ok && action === 'setup') {
        const refreshed = await api.acpRuntimeRefresh()
        if (!isCurrent()) return
        if (refreshed.agents) onChange(refreshed.agents)
        setFeedback({ error: !refreshed.ok, text: refreshed.ok ? '执行引擎已安装并更新本机状态。连接会话后再确认登录与模型；现在不会自动开始对话。' : `安装已完成，状态更新失败：${refreshed.error ?? '请重新探测'}` })
      } else setFeedback({ error: !res.ok, text: res.ok ? action === 'node' ? '本机环境路径已验证并保存。' : '本机状态已更新。登录、模型与会话能力将在实际连接时确认。' : res.error ?? '操作失败，请重试。' })
    } catch (error) {
      if (isCurrent()) setFeedback({ error: true, text: error instanceof Error ? error.message : '执行环境操作失败' })
    } finally {
      pendingRef.current = false
      if (isCurrent()) setPending(null)
    }
  }
  return (
    <section className="acp-engine-panel space-y-3" aria-label="本机执行环境">
      <div className="flex flex-wrap items-center gap-2">
        <Monitor size={14} className="text-my-secondary" />
        {heading && <span className="text-my-sm font-medium text-my-primary">本机执行引擎</span>}
        <div className="flex-1" />
        <Button size="sm" variant="outline" disabled={pending !== null || !hasIpc} onClick={() => void run('refresh')}>
          {pending === 'refresh' ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} 重新探测
        </Button>
        <Button size="sm" variant="outline" disabled={pending !== null || !hasIpc} onClick={() => void run('node')}>
          <FolderOpen size={12} /> 选择 Node
        </Button>
      </div>
      <p className="text-my-sm leading-relaxed text-my-tertiary">Codex、Claude Code 是执行引擎。角色名称和工作指令单独配置；安装引擎不会创建或启动会话。</p>
      {feedback && <p role={feedback.error ? 'alert' : 'status'} className={feedback.error ? 'text-my-sm text-my-danger-text' : 'text-my-sm text-my-success-text'}>{feedback.text}</p>}
      {agents.length === 0 && <p className="text-my-sm text-my-tertiary">暂未取得执行引擎列表，可重新探测。</p>}
      {agents.filter((agent) => !runtimeId || (agent.runtimeId ?? agent.id) === runtimeId).map((agent) => (
        <div key={agent.id} className="rounded-my-md border border-my-line p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-my-sm font-medium text-my-primary">{agent.name}</span>
            <span className={agent.available && agent.enabled ? 'text-my-sm text-my-success-text' : 'text-my-sm text-my-warning-text'}>{runtimeHealthLabel(agent)}</span>
            {agent.adapterVersion && <span className="text-my-sm text-my-tertiary">v{agent.adapterVersion}</span>}
            <div className="flex-1" />
            {agent.setupRequired && <Button size="sm" variant="primary" disabled={pending !== null || !hasIpc} onClick={() => void run('setup', agent.runtimeId ?? agent.id)}>
              {pending === (agent.runtimeId ?? agent.id) ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />} 安装执行引擎
            </Button>}
            {agent.available && !agent.setupRequired && <CheckCircle2 size={13} className="text-my-success-text" />}
          </div>
          <details className="mt-3 text-my-sm text-my-tertiary"><summary className="cursor-pointer">本机环境与连接诊断</summary><p className="mt-2">本机环境需要 Node ≥22.13。已有账号登录、工具和项目配置沿用引擎本身的设置。</p><dl className="mt-2 space-y-1 break-all text-my-sm text-my-tertiary">
            <div><dt className="inline text-my-secondary">Node：</dt><dd className="inline">{agent.nodePath ?? '未确认（自定义命令自行管理）'}</dd></div>
            <div><dt className="inline text-my-secondary">启动：</dt><dd className="inline font-mono">{agent.executable ? [agent.executable, ...(agent.args ?? [])].join(' ') : agent.command || '待配置'}</dd></div>
          </dl>
          {(agent.diagnostics ?? []).map((message, index) => <p key={index} className="mt-1 break-words text-my-sm text-my-secondary">{message}</p>)}
          {agent.checkedAt && <p className="mt-2 text-my-sm text-my-tertiary">检测于 {new Date(agent.checkedAt).toLocaleTimeString()}</p>}
          </details>
        </div>
      ))}
    </section>
  )
}
