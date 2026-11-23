import { CircleAlert, CircleDashed, Wifi, WifiOff } from 'lucide-react'
import type { JSX } from 'react'
import type { AcpAgentStatus, AcpRuntimeHealth } from '../../../shared/types'
import './runtime-panel.css'

const HEALTH_LABEL: Record<AcpRuntimeHealth, string> = {
  not_checked: '等待连接验证', executable_missing: '本机环境未就绪', adapter_missing: '尚未安装',
  launch_error: '启动失败', incompatible: '协议不兼容', auth_required: '需要登录',
  directory_unavailable: '目录不可用', ready: '启动条件满足'
}

export function runtimeHealthLabel(agent: AcpAgentStatus | undefined): string {
  if (!agent) return '执行引擎未配置'
  if (agent.launchKind === 'custom') return '不再支持'
  if (agent.id === 'opencode' && agent.health === 'incompatible') return 'OpenCode 不可用于 ACP v2'
  if (!agent.enabled) return '未启用'
  if (agent.health && !['ready', 'not_checked'].includes(agent.health)) return HEALTH_LABEL[agent.health] ?? '状态未知'
  if (agent.launchKind === 'sdk') return '不适用 ACP v2'
  if (agent.available && !agent.setupRequired) return agent.health === 'ready' ? 'ACP v2 已验证' : '已安装，待验证'
  return agent.setupRequired ? '尚未安装' : '未探测到程序'
}

export function runtimeConnectionState(agent: AcpAgentStatus | undefined): 'ready' | 'detected' | 'missing' | 'error' | 'disabled' {
  if (agent && (!agent.enabled || agent.launchKind === 'custom')) return 'disabled'
  if (agent?.health && ['launch_error', 'incompatible', 'auth_required', 'directory_unavailable'].includes(agent.health)) return 'error'
  if (!agent?.available || agent.setupRequired || agent.health && ['executable_missing', 'adapter_missing'].includes(agent.health)) return 'missing'
  return agent.health === 'ready' ? 'ready' : 'detected'
}

export function RuntimeConnectionIcon({ agent, size = 14, decorative = false }: {
  agent?: AcpAgentStatus; size?: number; decorative?: boolean
}): JSX.Element {
  const state = runtimeConnectionState(agent)
  const Icon = state === 'ready' ? Wifi : state === 'detected' ? CircleDashed : state === 'error' ? CircleAlert : WifiOff
  return <Icon size={size} className="runtime-connection-icon" data-state={state}
    aria-hidden={decorative || undefined} aria-label={decorative ? undefined : runtimeHealthLabel(agent)} />
}
